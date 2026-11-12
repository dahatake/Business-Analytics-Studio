// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C03_TABLE, isApproved, type AiUse, type UseApproval } from '../src/ai/policy.ts';
import { selectOutbound, toPromptContext } from '../src/ai/redact.ts';
import { loaded } from '../src/data/pack.ts';
import { SecretVault, protectorWorks, windowsDpapi, type KeyProtector } from '../server/vault.ts';
import { replaceFileSync } from '../server/files.ts';
import {
  STRICT_RELAY_CONFIG, handleRelay, hostAllowed, isLoopback, loadConnection, newRelayToken, originAllowed, outboundAllowed, relayAiDecision,
  relayConfigFromEnv, relayDir, validateConnection, workIqServiceFor, type RelayConfig, type RelayContext, type RelayRequest, type RelayResponse,
} from '../server/relay.ts';
import { spawn } from 'node:child_process';
import { WorkIqError, type WorkIqQuestion } from '../server/workiq.ts';
import { WORKIQ_CLI_PACKAGE, WORKIQ_EULA_URL, WorkIqCliService, mergeByItem, workIqCliCommand, type SpawnLike } from '../server/workiqCli.ts';

const FAKE_KEY = 'sk-test-0123456789abcdefFAKEKEY';
const PORT = 4188;
const TOKEN = newRelayToken();
const verifiedReply: typeof fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 30, completion_tokens: 1 },
}));
const baseHeaders = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' };
const req = (method: string, url: string, body?: unknown, extra: Partial<Omit<RelayRequest, 'headers'>> & { headers?: Record<string, string | undefined> } = {}): RelayRequest => ({
  method,
  url,
  remoteAddress: extra.remoteAddress ?? '127.0.0.1',
  localPort: PORT,
  headers: { ...baseHeaders, 'x-bas-relay': TOKEN, 'content-type': 'application/json', ...(extra.headers ?? {}) },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});

let dir: string;
let vault: SecretVault;
/** Every relay answer of a test, to prove no secret ever comes back. */
let answers: RelayResponse[];
const call = async (r: RelayRequest, ctx: Partial<RelayContext> = {}) => {
  const res = await handleRelay(r, { vault, token: TOKEN, ...ctx });
  answers.push(res);
  return res;
};

/** A reversible fake for platform-independent migration tests (not a security mechanism). */
const xorProtector = (fail = false): KeyProtector => ({
  protect: (b) => (fail ? null : Buffer.concat([Buffer.from('FAKE'), Buffer.from(b.map((x) => x ^ 0x5a))])),
  unprotect: (b) => (fail || b.subarray(0, 4).toString() !== 'FAKE' ? null : Buffer.from(b.subarray(4).map((x) => x ^ 0x5a))),
});

beforeEach(() => {
  fs.mkdirSync(join(process.cwd(), '.bas-local'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), '.bas-local', 'unit-relay-'));
  vault = new SecretVault(join(dir, '.bas-local'), { protector: null });
  answers = [];
});
afterEach(() => {
  for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(FAKE_KEY);
  rmSync(dir, { recursive: true, force: true });
});

describe('authenticated company news relay', () => {
  it('works without AI credentials and forwards only the validated search', async () => {
    const doFetch: typeof fetch = async () => new Response('<rss><channel><title>News</title></channel></rss>');
    const result = await call(req('POST', '/relay/news', { company: 'Acme', lang: 'en' }), { fetch: doFetch });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ company: 'Acme', lang: 'en', articles: [], provider: 'Google News RSS' });
  });

  it('applies token, origin, method, input and outbound restrictions before contacting the provider', async () => {
    let calls = 0;
    const doFetch: typeof fetch = async () => { calls++; throw new Error('must not fetch'); };
    const body = { company: 'Acme', lang: 'en' };
    expect((await call(req('POST', '/relay/news', body, { headers: { 'x-bas-relay': 'wrong' } }), { fetch: doFetch })).status).toBe(403);
    expect((await call(req('POST', '/relay/news', body, { headers: { origin: 'https://other.example' } }), { fetch: doFetch })).status).toBe(403);
    expect((await call(req('GET', '/relay/news', body), { fetch: doFetch })).status).toBe(405);
    expect((await call(req('POST', '/relay/news', { ...body, endpoint: 'https://example.com' }), { fetch: doFetch })).status).toBe(400);
    expect((await call(req('POST', '/relay/news', body), { fetch: doFetch, config: { ...STRICT_RELAY_CONFIG, outboundHosts: ['example.com'] } })).body).toEqual({ error: 'outboundNotAllowed' });
    expect(calls).toBe(0);
  });

  it('refuses a project topic without explicit confirmation before contacting Google News', async () => {
    const doFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('<rss><channel><title>News</title></channel></rss>'));
    const body = { company: 'Acme', lang: 'en', topic: 'logistics' };
    expect((await call(req('POST', '/relay/news', body), { fetch: doFetch })).status).toBe(400);
    expect(doFetch).not.toHaveBeenCalled();
    expect((await call(req('POST', '/relay/news', { ...body, topicConfirmed: true }), { fetch: doFetch })).status).toBe(200);
    expect(new URL(String(doFetch.mock.calls[0]![0])).searchParams.get('q')).toBe('"Acme" "logistics"');
  });

  it('returns an explicit failure, never fabricated news or provider content', async () => {
    const result = await call(req('POST', '/relay/news', { company: 'Acme', lang: 'ja' }), {
      fetch: async () => new Response('private provider error', { status: 500 }),
    });
    expect(result).toEqual({ status: 502, body: { error: 'newsUnavailable' } });
  });
});

describe('secret vault (AES-256-GCM)', () => {
  it('retries transient Windows replacement locks without removing the old file and surfaces permanent errors', () => {
    const source = join(dir, 'new.json');
    const destination = join(dir, 'saved.json');
    writeFileSync(source, 'new');
    writeFileSync(destination, 'old');
    const original = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      expect(readFileSync(destination, 'utf8')).toBe('old');
      throw Object.assign(new Error('locked'), { code: process.platform === 'win32' ? 'EPERM' : 'ENOENT' });
    });
    try {
      if (process.platform === 'win32') {
        spy.mockImplementationOnce(original);
        replaceFileSync(source, destination);
        expect(readFileSync(destination, 'utf8')).toBe('new');
        expect(spy).toHaveBeenCalledTimes(2);
      } else {
        expect(() => replaceFileSync(source, destination)).toThrow('locked');
      }
      spy.mockReset().mockImplementation(() => { throw Object.assign(new Error('permanent'), { code: 'ENOENT' }); });
      expect(() => replaceFileSync(source, destination)).toThrow('permanent');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('round-trips a secret and creates a random 32-byte master key file on first use (no DPAPI)', () => {
    expect(existsSync(vault.keyPath)).toBe(false);
    vault.set('foundryKey', FAKE_KEY);
    expect(statSync(vault.keyPath).size).toBe(32);
    expect(vault.keyProtection()).toBe('file');
    expect(vault.get('foundryKey')).toBe(FAKE_KEY);
    expect(new SecretVault(vault.dir, { protector: null }).get('foundryKey')).toBe(FAKE_KEY);
    expect(vault.status()).toEqual({ foundryKey: true, speechKey: false });
  });

  it('never writes the plaintext to disk and uses a fresh IV per write', () => {
    vault.set('foundryKey', FAKE_KEY);
    const first = JSON.parse(readFileSync(vault.filePath, 'utf8')) as { alg: string; entries: { foundryKey: { iv: string } } };
    vault.set('foundryKey', FAKE_KEY);
    const second = JSON.parse(readFileSync(vault.filePath, 'utf8')) as typeof first;
    expect(first.alg).toBe('aes-256-gcm');
    expect(first.entries.foundryKey.iv).not.toBe(second.entries.foundryKey.iv);
    for (const f of readdirSync(vault.dir)) {
      const raw = readFileSync(join(vault.dir, f));
      expect(raw.toString('utf8')).not.toContain(FAKE_KEY);
      expect(raw.toString('latin1')).not.toContain(FAKE_KEY);
    }
  });

  it('rejects tampered ciphertext and a secret moved to another name', () => {
    vault.set('foundryKey', FAKE_KEY);
    const file = JSON.parse(readFileSync(vault.filePath, 'utf8')) as { entries: Record<string, unknown> };
    file.entries.speechKey = file.entries.foundryKey;
    writeFileSync(vault.filePath, JSON.stringify(file));
    expect(() => vault.get('speechKey')).toThrow();
  });

  it('deletes secrets', () => {
    vault.set('speechKey', FAKE_KEY);
    expect(vault.delete('speechKey')).toBe(true);
    expect(vault.status().speechKey).toBe(false);
    expect(vault.get('speechKey')).toBeUndefined();
    expect(vault.delete('speechKey')).toBe(false);
  });

  it('I-6: migrates an existing plain master key to the protector once, and falls back to the file when it fails', () => {
    vault.set('foundryKey', FAKE_KEY);
    const plain = readFileSync(vault.keyPath);
    const migrated = new SecretVault(vault.dir, { protector: xorProtector() });
    expect(migrated.get('foundryKey')).toBe(FAKE_KEY);
    expect(migrated.keyProtection()).toBe('dpapi');
    expect(existsSync(vault.keyPath)).toBe(false);
    expect(existsSync(migrated.protectedKeyPath)).toBe(true);
    expect(readFileSync(migrated.protectedKeyPath, 'utf8')).not.toContain(plain.toString('base64'));
    // A second instance reads the protected key; nothing is migrated again.
    expect(new SecretVault(vault.dir, { protector: xorProtector() }).get('foundryKey')).toBe(FAKE_KEY);

    const other = new SecretVault(join(dir, 'other'), { protector: xorProtector(true) });
    expect(other.keyProtection()).toBe('file');
    other.set('foundryKey', FAKE_KEY);
    expect(existsSync(other.keyPath)).toBe(true);
    expect(existsSync(other.protectedKeyPath)).toBe(false);
    expect(other.keyProtection()).toBe('file');
  });

  it.skipIf(process.platform !== 'win32')('I-6: Windows DPAPI round-trip (CurrentUser), and the vault stores no plain key', () => {
    const data = Buffer.from('0123456789abcdef0123456789abcdef');
    const blob = windowsDpapi.protect(data);
    expect(blob).not.toBeNull();
    expect(blob!.includes(data)).toBe(false);
    expect(windowsDpapi.unprotect(blob!)?.equals(data)).toBe(true);
    expect(protectorWorks(windowsDpapi)).toBe(true);

    const dpapiVault = new SecretVault(join(dir, 'dpapi'));
    dpapiVault.set('foundryKey', FAKE_KEY);
    expect(dpapiVault.keyProtection()).toBe('dpapi');
    expect(existsSync(dpapiVault.keyPath)).toBe(false);
    expect(existsSync(dpapiVault.protectedKeyPath)).toBe(true);
    expect(new SecretVault(dpapiVault.dir).get('foundryKey')).toBe(FAKE_KEY);
  }, 30_000);
});

describe('D-5 relay configuration (relayConfigFromEnv)', () => {
  it('defaults to the strict settings', () => {
    expect(relayConfigFromEnv({})).toEqual(STRICT_RELAY_CONFIG);
    expect(STRICT_RELAY_CONFIG).toMatchObject({ requireLoopback: true, allowIpv6Loopback: false, allowedHosts: [], allowedOrigins: [], outboundHosts: null, testOutbound: false });
  });

  it('parses exact lists and flags', () => {
    const c = relayConfigFromEnv({
      BAS_RELAY_REQUIRE_LOOPBACK: '0',
      BAS_RELAY_ALLOW_IPV6_LOOPBACK: '1',
      BAS_RELAY_ALLOWED_HOSTS: 'bas.example.com, BAS.example.com:8443',
      BAS_RELAY_ALLOWED_ORIGINS: 'https://bas.example.com',
      BAS_RELAY_OUTBOUND_HOSTS: 'myres.openai.azure.com',
      BAS_RELAY_TEST_OUTBOUND: '1',
    });
    expect(c).toEqual({
      requireLoopback: false, allowIpv6Loopback: true, allowedHosts: ['bas.example.com', 'bas.example.com:8443'],
      allowedOrigins: ['https://bas.example.com'], outboundHosts: ['myres.openai.azure.com'], testOutbound: true,
    });
    expect(relayConfigFromEnv({ BAS_RELAY_OUTBOUND_HOSTS: '' }).outboundHosts).toBeNull();
  });

  it('refuses wildcards and malformed values at startup', () => {
    for (const env of [
      { BAS_RELAY_OUTBOUND_HOSTS: '*' },
      { BAS_RELAY_OUTBOUND_HOSTS: '*.openai.azure.com' },
      { BAS_RELAY_ALLOWED_HOSTS: '*' },
      { BAS_RELAY_ALLOWED_ORIGINS: 'https://*.example.com' },
      { BAS_RELAY_ALLOWED_ORIGINS: 'https://bas.example.com/' },
      { BAS_RELAY_ALLOWED_ORIGINS: 'null' },
      { BAS_RELAY_ALLOWED_HOSTS: 'bas.example.com/path' },
      { BAS_RELAY_OUTBOUND_HOSTS: 'https://x.openai.azure.com' },
      { BAS_RELAY_REQUIRE_LOOPBACK: 'no' },
      { BAS_RELAY_TEST_OUTBOUND: 'true' },
    ]) {
      expect(() => relayConfigFromEnv(env), JSON.stringify(env)).toThrow();
    }
  });
});

describe('relay inbound protection (D-5)', () => {
  it('accepts 127.0.0.1 only; ::1 only when configured; no loopback check when disabled', async () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(false);
    expect(isLoopback('::1', { allowIpv6Loopback: true })).toBe(true);
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect((await call(req('PUT', '/relay/secrets/foundryKey', { value: FAKE_KEY }, { remoteAddress: '10.0.0.5' }))).status).toBe(403);
    expect((await call(req('GET', '/relay/status', undefined, { remoteAddress: '::1' }))).body).toEqual({ error: 'notLoopback' });
    expect((await call(req('GET', '/relay/status', undefined, { remoteAddress: '::1' }), { config: { ...STRICT_RELAY_CONFIG, allowIpv6Loopback: true } })).status).toBe(200);
    expect((await call(req('GET', '/relay/status', undefined, { remoteAddress: '10.0.0.5' }), { config: { ...STRICT_RELAY_CONFIG, requireLoopback: false } })).status).toBe(200);
    expect(vault.status().foundryKey).toBe(false);
  });

  it('Host must exactly equal 127.0.0.1:<port> (no localhost, no other port) unless configured', async () => {
    expect(hostAllowed(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    for (const host of ['localhost:4188', '127.0.0.1:5173', '127.0.0.1', '[::1]:4188', 'evil.example:4188', undefined]) {
      expect(hostAllowed(host, PORT), String(host)).toBe(false);
      expect((await call(req('GET', '/relay/status', undefined, { headers: { host } }))).status, String(host)).toBe(403);
    }
    const cfg: RelayConfig = { ...STRICT_RELAY_CONFIG, allowedHosts: ['bas.example.com'] };
    expect(hostAllowed('bas.example.com', 8080, cfg)).toBe(true);
    expect(hostAllowed('bas.example.com:8080', 8080, cfg)).toBe(false);
  });

  it('Origin must exactly equal http://127.0.0.1:<port>; requests without Origin only for GET /relay/status', async () => {
    expect(originAllowed(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
    for (const origin of ['http://localhost:4188', 'http://127.0.0.1:5173', 'https://127.0.0.1:4188', 'http://evil.example', 'null']) {
      expect(originAllowed(origin, PORT), origin).toBe(false);
      expect((await call(req('PUT', '/relay/secrets/foundryKey', { value: FAKE_KEY }, { headers: { origin } }))).status, origin).toBe(403);
    }
    expect(originAllowed('https://bas.example.com', 8080, { ...STRICT_RELAY_CONFIG, allowedOrigins: ['https://bas.example.com'] })).toBe(true);
    const noOrigin = { headers: { origin: undefined } };
    expect((await call(req('GET', '/relay/status', undefined, noOrigin))).status).toBe(200);
    expect((await call(req('POST', '/relay/session', undefined, noOrigin))).body).toEqual({ error: 'noOrigin' });
    expect((await call(req('DELETE', '/relay/secrets/foundryKey', undefined, noOrigin))).body).toEqual({ error: 'noOrigin' });
    expect((await call(req('POST', '/relay/ai', { use: 'explain' }, noOrigin))).body).toEqual({ error: 'noOrigin' });
    expect((await call(req('GET', '/relay/status', undefined, { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
    expect((await call(req('PUT', '/relay/secrets/foundryKey', { value: FAKE_KEY }, { headers: { 'content-type': 'text/plain' } }))).status).toBe(415);
  });

  it('hands out the per-launch token on POST /relay/session only and requires it everywhere else (Q-122)', async () => {
    expect(await call(req('POST', '/relay/session'))).toEqual({ status: 200, body: { token: TOKEN } });
    expect((await call(req('GET', '/relay/session'))).status).toBe(405);
    expect((await call(req('POST', '/relay/session', undefined, { headers: { origin: 'http://evil.example' } }))).status).toBe(403);
    expect((await call(req('POST', '/relay/session', undefined, { remoteAddress: '10.0.0.5' }))).status).toBe(403);
    for (const t of [undefined, '1', newRelayToken(), `${TOKEN}x`]) {
      const headers = { 'x-bas-relay': t };
      expect((await call(req('GET', '/relay/status', undefined, { headers }))).body).toEqual({ error: 'badToken' });
      expect((await call(req('PUT', '/relay/secrets/foundryKey', { value: FAKE_KEY }, { headers }))).status).toBe(403);
      expect((await call(req('PUT', '/relay/connection', { endpoint: 'https://x.openai.azure.com', deployment: 'd' }, { headers }))).status).toBe(403);
    }
    expect(vault.status().foundryKey).toBe(false);
    expect(TOKEN).not.toBe(newRelayToken());
    expect(TOKEN.length).toBeGreaterThanOrEqual(43);
  });
});

describe('relay secrets and connection', () => {
  const c = { endpoint: 'https://res.services.ai.azure.com', deployment: 'gpt-test', apiVersion: '2024-10-21' };

  it('normalizes Foundry project URLs to the same resource v1 endpoint', () => {
    expect(validateConnection({ ...c, endpoint: `${c.endpoint}/openai/v1/`, apiVersion: '' })).toEqual({
      ok: true, value: { ...c, endpoint: `${c.endpoint}/openai/v1` },
    });
    for (const endpoint of [
      `${c.endpoint}/api/projects/project`,
      `  ${c.endpoint}/api/projects/GraphRecordingProject/  `,
      'https://RES.services.ai.azure.com/api/projects/project',
    ]) {
      expect(validateConnection({ ...c, endpoint, apiVersion: '' })).toEqual({
        ok: true, value: { ...c, endpoint: `${c.endpoint}/openai/v1` },
      });
    }
    expect(validateConnection({ ...c, endpoint: `${c.endpoint}/api/projects/project` }, {
      ...STRICT_RELAY_CONFIG, outboundHosts: ['other.services.ai.azure.com'],
    })).toEqual({ ok: false, error: 'hostNotAllowed' });
    expect(validateConnection({ ...c, endpoint: `${c.endpoint}:8443` }).ok).toBe(true);
    expect(validateConnection({ ...c, endpoint: `${c.endpoint}/openai/v1?key=secret` })).toEqual({ ok: false, error: 'invalidEndpoint' });
  });

  it.each([
    ['https://other.example/api/projects/project', 'projectEndpoint'],
    ['https://res.services.ai.azure.com.other.example/api/projects/project', 'projectEndpoint'],
    [`${c.endpoint}:8443/api/projects/project`, 'projectEndpoint'],
    [`${c.endpoint}/api/projects/`, 'projectEndpoint'],
    [`${c.endpoint}/api/projects/project/extra`, 'projectEndpoint'],
    [`${c.endpoint}/api/projects/project?key=secret`, 'invalidEndpoint'],
    [`${c.endpoint}/api/projects/project#fragment`, 'invalidEndpoint'],
    ['https://user:secret@res.services.ai.azure.com/api/projects/project', 'invalidEndpoint'],
    ['http://res.services.ai.azure.com/api/projects/project', 'invalidEndpoint'],
  ])('refuses ambiguous or unsafe project URL %s without sending', async (endpoint, error) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await call(req('PUT', '/relay/connection', { ...c, endpoint }), { fetch })).toEqual({
      status: 400, body: { error },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(vault.dir, 'connection.json'))).toBe(false);
  });

  it('does not send without a key; old saved settings are unverified, never configured', async () => {
    expect(await call(req('PUT', '/relay/connection', c))).toEqual({ status: 400, body: { error: 'keyMissing' } });
    vault.set('foundryKey', FAKE_KEY);
    writeFileSync(join(vault.dir, 'connection.json'), JSON.stringify(c));
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ connection: c, connectionVerifiedAt: null, configured: false });
    expect((await call(req('POST', '/relay/ai', { use: 'packBuild' }))).body).toEqual({ allowed: false, reasons: ['notConfigured'] });
  });

  it('uses the same legacy-token fallback for verification and application calls', async () => {
    vault.set('foundryKey', FAKE_KEY);
    const sent: Record<string, unknown>[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return 'max_completion_tokens' in body ? new Response('{}', { status: 400 }) : verifiedReply(url, init);
    };
    expect((await call(req('PUT', '/relay/connection', c), { fetch })).status).toBe(200);
    expect((await call(req('POST', '/relay/ai', { use: 'explain', lang: 'en', prompt: 'Synthetic test.', maxOutputTokens: 100, timeoutMs: 1000 }), { fetch })).status).toBe(200);
    expect(sent).toHaveLength(4);
    expect(sent[1]).toHaveProperty('max_tokens', 256);
    expect(sent[3]).toHaveProperty('max_tokens', 100);
  });

  it.each(['/openai/v1', '/api/projects/project'])('tests %s at the exact v1 route/model, persists proof and invalidates it on edits and key changes', async (path) => {
    vault.set('foundryKey', FAKE_KEY);
    const fetches: { url: string; body: Record<string, unknown> }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      fetches.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${FAKE_KEY}` });
      expect(init?.redirect).toBe('error');
      return verifiedReply(url, init);
    };
    const v1 = { ...c, endpoint: `${c.endpoint}/openai/v1` };
    const result = await call(req('PUT', '/relay/connection', { ...c, endpoint: c.endpoint + path }), { fetch });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ connection: v1, usage: { inputTokens: 30, outputTokens: 1 } });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe(`${v1.endpoint}/chat/completions`);
    expect(fetches[0]!.body).toMatchObject({ model: c.deployment, max_completion_tokens: 256 });
    expect(JSON.stringify(fetches[0]!.body)).not.toContain('customer pack');
    expect((await call(req('GET', '/relay/status'), { vault: new SecretVault(vault.dir, { protector: null }) })).body).toMatchObject({ configured: true });
    expect((await call(req('POST', '/relay/ai', { use: 'packBuild', lang: 'en', prompt: 'Build from synthetic data.', maxOutputTokens: 100, timeoutMs: 1000 }), { fetch })).status).toBe(200);
    expect(fetches[1]!.url).toBe(`${v1.endpoint}/chat/completions`);
    expect(fetches[1]!.body).toMatchObject({ model: c.deployment, response_format: { type: 'json_object' } });
    const disk = readFileSync(join(vault.dir, 'connection.json'), 'utf8');
    writeFileSync(join(vault.dir, 'connection.json'), disk.replace('gpt-test', 'other-model'));
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ configured: false, connectionVerifiedAt: null });
    writeFileSync(join(vault.dir, 'connection.json'), disk);
    vault.set('foundryKey', 'different-key');
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ configured: false, connectionVerifiedAt: null });
    expect(JSON.stringify(result.body)).not.toContain('verification');
  });

  it.each([
    [401, 'unauthorized'], [403, 'forbidden'], [404, 'deploymentNotFound'],
    [400, 'invalidApiRequest'], [429, 'providerBusy'], [500, 'providerError'],
  ] as const)('reports HTTP %s without provider content and keeps the previous verified connection', async (status, error) => {
    vault.set('foundryKey', FAKE_KEY);
    await call(req('PUT', '/relay/connection', c), { fetch: verifiedReply });
    const before = readFileSync(join(vault.dir, 'connection.json'), 'utf8');
    const result = await call(req('PUT', '/relay/connection', { ...c, endpoint: `${c.endpoint}/api/projects/project`, deployment: 'bad' }), {
      fetch: async () => new Response(`secret provider response ${FAKE_KEY}`, { status }),
    });
    expect(result).toEqual({ status: 502, body: { error, providerStatus: status } });
    expect(readFileSync(join(vault.dir, 'connection.json'), 'utf8')).toBe(before);
  });

  it.each([
    ['ENOTFOUND', 'dnsFailure'], ['EAI_AGAIN', 'dnsFailure'], ['ECONNREFUSED', 'networkError'],
    ['CERT_HAS_EXPIRED', 'tlsError'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tlsError'],
  ] as const)('reports transport error %s without saving', async (code, error) => {
    vault.set('foundryKey', FAKE_KEY);
    const result = await call(req('PUT', '/relay/connection', c), {
      fetch: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(FAKE_KEY), { code }) }); },
    });
    expect(result).toEqual({ status: 502, body: { error } });
    expect(existsSync(join(vault.dir, 'connection.json'))).toBe(false);
  });

  it('rejects unusable successful responses and a key changed during the test', async () => {
    vault.set('foundryKey', FAKE_KEY);
    for (const body of ['not json', 'null', '[]', '{}', '{"choices":[{"message":{"content":""}}],"usage":{"prompt_tokens":0,"completion_tokens":1}}']) {
      const result = await call(req('PUT', '/relay/connection', c), { fetch: async () => new Response(body) });
      expect(result).toEqual({ status: 502, body: { error: 'badProviderResponse' } });
      expect(existsSync(join(vault.dir, 'connection.json'))).toBe(false);
    }
    const result = await call(req('PUT', '/relay/connection', c), {
      fetch: async (...args) => { vault.set('foundryKey', 'changed'); return verifiedReply(...args); },
    });
    expect(result).toEqual({ status: 409, body: { error: 'keyChanged', usage: { inputTokens: 30, outputTokens: 1 } } });
    expect(existsSync(join(vault.dir, 'connection.json'))).toBe(false);
  });

  it('honors outbound/C-03 gates, cancellation and repeated-send limits for diagnostics', async () => {
    vault.set('foundryKey', FAKE_KEY);
    let sent = 0;
    const fetch: typeof globalThis.fetch = async (...args) => { sent++; return verifiedReply(...args); };
    const lastCall = new Map<string, number>();
    expect((await call(req('PUT', '/relay/connection', c), { fetch, config: { ...STRICT_RELAY_CONFIG, outboundHosts: ['other.example'] } })).body).toEqual({ error: 'hostNotAllowed' });
    expect((await call(req('PUT', '/relay/connection', c), { fetch, table: { ...C03_TABLE, connectionTest: C03_TABLE.chat } })).status).toBe(403);
    expect((await call(req('PUT', '/relay/connection', c), { fetch, signal: AbortSignal.abort() })).status).toBe(499);
    expect(sent).toBe(0);
    expect((await call(req('PUT', '/relay/connection', c), { fetch, lastCall })).status).toBe(200);
    expect((await call(req('PUT', '/relay/connection', c), { fetch, lastCall })).body).toEqual({ error: 'tooSoon' });
    expect(sent).toBe(1);
    expect((await call(req('POST', '/relay/ai', { use: 'connectionTest', prompt: 'arbitrary material' }), { fetch })).body).toEqual({ error: 'useConnectionSettings' });
  });

  it('times out a diagnostic after 30 seconds without saving or exposing an upstream error', async () => {
    vault.set('foundryKey', FAKE_KEY);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = call(req('PUT', '/relay/connection', c), {
        fetch: async (_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error(FAKE_KEY)), { once: true });
        }),
      });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await result).toEqual({ status: 504, body: { error: 'timeout' } });
      expect(existsSync(join(vault.dir, 'connection.json'))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('PUT stores the key and no response ever contains it', async () => {
    const put = await call(req('PUT', '/relay/secrets/foundryKey', { value: FAKE_KEY }));
    expect(put.status).toBe(200);
    const status = await call(req('GET', '/relay/status'));
    expect(status).toEqual({ status: 200, body: { relay: 'ok', secrets: { foundryKey: true, speechKey: false }, connection: null, connectionVerifiedAt: null, configured: false, keyProtection: 'file', copilot: null, workiq: null } });
    for (const m of ['GET', 'POST']) expect((await call(req(m, '/relay/secrets/foundryKey', m === 'POST' ? {} : undefined))).status).toBe(405);
    const del = await call(req('DELETE', '/relay/secrets/foundryKey'));
    expect(del.body).toEqual({ name: 'foundryKey', configured: false });
    expect(vault.status().foundryKey).toBe(false);
  });

  it('does not echo invalid bodies and rejects unknown secret names', async () => {
    const bad = await call(req('PUT', '/relay/secrets/foundryKey', { value: `${FAKE_KEY}\n` }));
    expect(bad.status).toBe(400);
    expect((await call(req('PUT', '/relay/secrets/githubToken', { value: FAKE_KEY }))).status).toBe(404);
    expect((await call(req('PUT', '/relay/secrets/foundryKey', 'x'.repeat(5000)))).status).toBe(400);
  });

  it('validates and stores the non-secret connection in connection.json (https, no credentials, deployment pattern)', async () => {
    expect(validateConnection({ endpoint: 'https://res.openai.azure.com/', deployment: 'gpt-4o.mini_1' })).toEqual({
      ok: true, value: { endpoint: 'https://res.openai.azure.com', deployment: 'gpt-4o.mini_1', apiVersion: '2024-10-21' },
    });
    const bad: [unknown, string][] = [
      [{ endpoint: 'http://res.openai.azure.com', deployment: 'd' }, 'invalidEndpoint'],
      [{ endpoint: 'https://user:pass@res.openai.azure.com', deployment: 'd' }, 'invalidEndpoint'],
      [{ endpoint: 'https://res.openai.azure.com/openai?x=1', deployment: 'd' }, 'invalidEndpoint'],
      [{ endpoint: 'https://res.openai.azure.com/path', deployment: 'd' }, 'invalidEndpoint'],
      [{ endpoint: 'http://127.0.0.1:9999', deployment: 'd' }, 'invalidEndpoint'],
      [{ endpoint: 'https://res.openai.azure.com', deployment: 'a/b' }, 'invalidDeployment'],
      [{ endpoint: 'https://res.openai.azure.com', deployment: 'x'.repeat(65) }, 'invalidDeployment'],
      [{ endpoint: 'https://res.openai.azure.com', deployment: 'd', apiVersion: 'latest' }, 'invalidApiVersion'],
      [{ endpoint: 'https://res.openai.azure.com', deployment: 'd', key: FAKE_KEY }, 'invalidBody'],
    ];
    for (const [input, error] of bad) {
      expect(validateConnection(input), JSON.stringify(input)).toEqual({ ok: false, error });
      expect((await call(req('PUT', '/relay/connection', input))).body).toEqual({ error });
    }
    expect(validateConnection({ endpoint: 'https://res.openai.azure.com', deployment: 'd' }, { ...STRICT_RELAY_CONFIG, outboundHosts: ['other.openai.azure.com'] })).toEqual({ ok: false, error: 'hostNotAllowed' });
    expect(validateConnection({ endpoint: 'http://127.0.0.1:9999', deployment: 'd' }, { ...STRICT_RELAY_CONFIG, testOutbound: true }).ok).toBe(true);

    vault.set('foundryKey', FAKE_KEY);
    const put = await call(req('PUT', '/relay/connection', { endpoint: 'https://res.openai.azure.com', deployment: 'gpt', apiVersion: '2024-10-21' }), { fetch: verifiedReply });
    expect(put.status).toBe(200);
    expect(existsSync(join(vault.dir, 'connection.json'))).toBe(true);
    const status = await call(req('GET', '/relay/status'));
    expect(status.body).toMatchObject({ connection: { endpoint: 'https://res.openai.azure.com', deployment: 'gpt', apiVersion: '2024-10-21' }, configured: true });
    expect(readFileSync(join(vault.dir, 'connection.json'), 'utf8')).not.toContain(FAKE_KEY);
    expect((await call(req('DELETE', '/relay/connection'))).body).toEqual({ connection: null });
    expect(((await call(req('GET', '/relay/status'))).body as { configured: boolean }).configured).toBe(false);
  });

  it('outbound allowlist: exact hostname of the saved endpoint, optional env list, test-only loopback http', () => {
    const saved = 'https://res.openai.azure.com';
    expect(outboundAllowed(`${saved}/openai/deployments/d/chat/completions`, saved)).toBe(true);
    expect(outboundAllowed('https://evil.example/openai', saved)).toBe(false);
    expect(outboundAllowed('https://res.openai.azure.com.evil.example/x', saved)).toBe(false);
    expect(outboundAllowed('https://user:p@res.openai.azure.com/x', saved)).toBe(false);
    expect(outboundAllowed('http://res.openai.azure.com/x', saved)).toBe(false);
    expect(outboundAllowed(`${saved}/x`, saved, { ...STRICT_RELAY_CONFIG, outboundHosts: ['other.example'] })).toBe(false);
    expect(outboundAllowed(`${saved}/x`, saved, { ...STRICT_RELAY_CONFIG, outboundHosts: ['res.openai.azure.com'] })).toBe(true);
    expect(outboundAllowed('http://127.0.0.1:9999/x', 'http://127.0.0.1:9999')).toBe(false);
    expect(outboundAllowed('http://127.0.0.1:9999/x', 'http://127.0.0.1:9999', { ...STRICT_RELAY_CONFIG, testOutbound: true })).toBe(true);
    expect(outboundAllowed('http://127.0.0.1:8888/x', 'http://127.0.0.1:9999', { ...STRICT_RELAY_CONFIG, testOutbound: true })).toBe(false);
  });

  it('isolates E2E builds from the real .bas-local folder', () => {
    expect(relayDir('/r', {})).toMatch(/[\\/]\.bas-local$/);
    expect(relayDir('/r', { BAS_OUT: 'dist-ai' })).toMatch(/[\\/]\.bas-local[\\/]e2e-dist-ai$/);
    expect(relayDir('/r', { BAS_RELAY_DIR: 'x', BAS_OUT: 'dist-ai' })).toMatch(/[\\/]r[\\/]x$/);
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Forwarding to a local stub provider (BAS_RELAY_TEST_OUTBOUND semantics via the config)                             */
/* ---------------------------------------------------------------------------------------------------------------- */

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
let stub: Server;
let stubUrl: string;
let seen: Seen[] = [];
let mode: 'ok' | 'hang' | 'error' | 'garbage' | 'noJsonMode' = 'ok';
const PROVIDER_SECRET_BODY = 'provider-internal-detail-should-not-leak';

beforeAll(async () => {
  stub = createServer((r: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => {
      seen.push({ method: r.method ?? '', url: r.url ?? '', headers: r.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (mode === 'hang') return;
      if (mode === 'noJsonMode' && Buffer.concat(chunks).toString('utf8').includes('response_format')) {
        res.statusCode = 400;
        res.end('{}');
        return;
      }
      if (mode === 'error') {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: PROVIDER_SECRET_BODY } }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(mode === 'garbage' ? '{"nope":1}' : JSON.stringify({ choices: [{ message: { content: 'stub answer' } }], usage: { prompt_tokens: 123, completion_tokens: 45 } }));
    });
  });
  await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  stub.closeAllConnections();
  await new Promise<void>((done) => stub.close(() => done()));
});

describe('POST /relay/ai forwarding (D-1: "explain" only)', () => {
  const testConfig: RelayConfig = { ...STRICT_RELAY_CONFIG, testOutbound: true };
  const internal = loaded.byId.get('issue-skills')!;
  const context = toPromptContext(selectOutbound([internal, loaded.byId.get('issue-lead-time')!], loaded.byId), 'en');
  const aiBody = (extra: Record<string, unknown> = {}) => ({ use: 'explain', lang: 'en', prompt: 'Explain this screen.', context, maxOutputTokens: 1500, timeoutMs: 5000, ...extra });
  let clock = 1_000_000;
  const ctx = (extra: Partial<RelayContext> = {}): Partial<RelayContext> => ({ config: testConfig, now: () => clock, lastCall: lastCalls, ...extra });
  let lastCalls: Map<string, number>;

  beforeEach(async () => {
    seen = [];
    mode = 'ok';
    clock += 60_000;
    lastCalls = new Map();
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', { endpoint: stubUrl, deployment: 'gpt-test' }), ctx())).status).toBe(200);
    seen = [];
  });

  it('forwards to Microsoft Foundry chat completions with the api-key header and returns text + token usage', async () => {
    expect(internal.classification).toBe('internal');
    const r = await call(req('POST', '/relay/ai', aiBody()), ctx());
    expect(r).toEqual({ status: 200, body: { text: 'stub answer', inputTokens: 123, outputTokens: 45 } });
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.method).toBe('POST');
    expect(s.url).toBe('/openai/deployments/gpt-test/chat/completions?api-version=2024-10-21');
    expect(s.headers['api-key']).toBe(FAKE_KEY);
    expect(s.headers.authorization).toBeUndefined();
    const sent = JSON.parse(s.body) as { messages: { role: string; content: string }[]; max_completion_tokens: number };
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(sent.messages[1]!.content).toContain('Transferring expert skills'); // D-2: internal items may be sent
    expect(sent.messages[1]!.content.startsWith('Explain this screen.\n\n')).toBe(true);
    expect(sent.max_completion_tokens).toBeLessThanOrEqual(1500);
    expect(Object.keys(sent).sort()).toEqual(['max_completion_tokens', 'messages']);
  });

  it('refuses every unapproved use without contacting the provider', async () => {
    for (const use of (Object.keys(C03_TABLE) as AiUse[]).filter((u) => !isApproved(C03_TABLE[u]))) {
      const r = await call(req('POST', '/relay/ai', aiBody({ use })), ctx());
      expect(r, use).toEqual({ status: 403, body: { allowed: false, reasons: ['c03NotApproved'] } });
    }
    expect((await call(req('POST', '/relay/ai', aiBody({ use: 'nope' })), ctx())).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('server-side decision: approved rows only, and only with a complete connection', () => {
    const approved: UseApproval = { provider: 'foundry', data: 'x', enableCondition: 'x', costCapJpy: 1, openQuestions: [] };
    expect(relayAiDecision('explain', true)).toEqual([]);
    expect(relayAiDecision('explain', false)).toEqual(['notConfigured']);
    expect(relayAiDecision('chat', true)).toEqual(['c03NotApproved']);
    expect(relayAiDecision('chat', true, { ...C03_TABLE, chat: approved })).toEqual([]);
  });

  it('accepts known fields and bounded sizes only', async () => {
    const bad = [
      aiBody({ extra: 1 }),
      aiBody({ maxOutputTokens: 1501 }),
      aiBody({ maxOutputTokens: 0 }),
      aiBody({ maxOutputTokens: 10.5 }),
      aiBody({ timeoutMs: 120_001 }),
      aiBody({ lang: 'fr' }),
      aiBody({ prompt: '' }),
      aiBody({ prompt: 'x'.repeat(20_000), context: 'y'.repeat(12_001) }),
    ];
    for (const b of bad) expect((await call(req('POST', '/relay/ai', b), ctx())).status, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect((await call(req('POST', '/relay/ai', 'not json'), ctx())).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await call(req('POST', '/relay/ai', aiBody({ prompt: 'x'.repeat(20_000), context: 'y'.repeat(12_000) })), ctx())).status).toBe(200);
  });

  it('enforces the PARAM-116 minimum interval per use on the server (429)', async () => {
    expect((await call(req('POST', '/relay/ai', aiBody()), ctx())).status).toBe(200);
    clock += 4_999;
    expect(await call(req('POST', '/relay/ai', aiBody()), ctx())).toEqual({ status: 429, body: { error: 'tooSoon' } });
    clock += 1;
    expect((await call(req('POST', '/relay/ai', aiBody()), ctx())).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('refuses endpoints outside the outbound allowlist (no request leaves)', async () => {
    // Without the test switch, http://127.0.0.1 is not a valid provider: the saved connection is ignored.
    const strict = await call(req('POST', '/relay/ai', aiBody()), ctx({ config: STRICT_RELAY_CONFIG }));
    expect(strict).toEqual({ status: 403, body: { allowed: false, reasons: ['notConfigured'] } });
    expect(loadConnection(vault.dir, STRICT_RELAY_CONFIG)).toBeNull();
    // A hand-edited connection.json pointing elsewhere is re-validated against BAS_RELAY_OUTBOUND_HOSTS.
    writeFileSync(join(vault.dir, 'connection.json'), JSON.stringify({ endpoint: 'https://evil.example', deployment: 'd', apiVersion: '2024-10-21' }));
    const listed = await call(req('POST', '/relay/ai', aiBody()), ctx({ config: { ...testConfig, outboundHosts: ['res.openai.azure.com'] } }));
    expect(listed.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('times out with 504 and maps provider failures to a generic 502 (no provider body)', async () => {
    mode = 'hang';
    expect(await call(req('POST', '/relay/ai', aiBody({ timeoutMs: 200 })), ctx())).toEqual({ status: 504, body: { error: 'timeout' } });
    clock += 10_000;
    mode = 'error';
    const err = await call(req('POST', '/relay/ai', aiBody()), ctx());
    expect(err).toEqual({ status: 502, body: { error: 'providerError', providerStatus: 500 } });
    expect(JSON.stringify(err.body)).not.toContain(PROVIDER_SECRET_BODY);
    clock += 10_000;
    mode = 'garbage';
    expect(await call(req('POST', '/relay/ai', aiBody()), ctx())).toEqual({ status: 502, body: { error: 'badProviderResponse' } });
    for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(FAKE_KEY);
  });
});
/* ---------------------------------------------------------------------------------------------------------------- */
/* D-12: customer pack generation (FR-311) — providers, JSON mode, Copilot, official-site reader                     */
/* ---------------------------------------------------------------------------------------------------------------- */

describe('D-12 packBuild through the relay', () => {
  const testConfig: RelayConfig = { ...STRICT_RELAY_CONFIG, testOutbound: true };
  const packBody = (extra: Record<string, unknown> = {}) => ({ use: 'packBuild', provider: 'foundry', lang: 'ja', prompt: '顧客パックを作ってください', context: '', maxOutputTokens: 16000, timeoutMs: 300000, ...extra });

  const fakeCopilot = (answer = '{"entities":[]}') => {
    const calls: { model: string; system: string; prompt: string }[] = [];
    const service = {
      status: async () => ({ available: true, authenticated: true, login: 'octocat', models: [{ id: 'gpt-5', name: 'GPT-5', multiplier: 1 }] }),
      complete: async (i: { model: string; system: string; prompt: string }) => {
        calls.push(i);
        return { text: answer, inputTokens: 10, outputTokens: 20, premiumRequests: 1 };
      },
    };
    return { calls, service: service as unknown as NonNullable<RelayContext['copilot']> };
  };

  beforeEach(() => {
    seen = [];
    mode = 'ok';
  });

  it('C-03: packBuild is approved for Foundry and Copilot; explain stays Foundry only', () => {
    expect(relayAiDecision('packBuild', true, C03_TABLE, 'foundry')).toEqual([]);
    expect(relayAiDecision('packBuild', true, C03_TABLE, 'copilotSdk')).toEqual([]);
    expect(relayAiDecision('explain', true, C03_TABLE, 'copilotSdk')).toEqual(['c03NotApproved']);
    expect(relayAiDecision('packBuild', false, C03_TABLE, 'copilotSdk')).toEqual(['notConfigured']);
  });

  it('Foundry: JSON mode with max_completion_tokens and the pack system prompt; a deployment rejecting it is retried once classically', async () => {
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', { endpoint: stubUrl, deployment: 'gpt-test' }), { config: testConfig })).status).toBe(200);
    seen = [];
    const r = await call(req('POST', '/relay/ai', packBody()), { config: testConfig });
    expect(r.status).toBe(200);
    const sent = JSON.parse(seen[0]!.body) as { messages: { content: string }[]; max_completion_tokens?: number; response_format?: { type: string } };
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.max_completion_tokens).toBe(16000);
    expect(sent.messages[0]!.content).toContain('JSON');

    seen = [];
    mode = 'noJsonMode';
    expect((await call(req('POST', '/relay/ai', packBody()), { config: testConfig })).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(Object.keys(JSON.parse(seen[1]!.body) as object).sort()).toEqual(['max_tokens', 'messages']);
  });

  it('per-use caps: packBuild may send long material and wait longer; explain keeps its own caps', async () => {
    vault.set('foundryKey', FAKE_KEY);
    await call(req('PUT', '/relay/connection', { endpoint: stubUrl, deployment: 'gpt-test' }), { config: testConfig });
    seen = [];
    expect((await call(req('POST', '/relay/ai', packBody({ prompt: 'x'.repeat(150_000) })), { config: testConfig })).status).toBe(200);
    expect((await call(req('POST', '/relay/ai', packBody({ prompt: 'x'.repeat(200_001) })), { config: testConfig })).status).toBe(400);
    expect((await call(req('POST', '/relay/ai', packBody({ timeoutMs: 600_001 })), { config: testConfig })).status).toBe(400);
    expect((await call(req('POST', '/relay/ai', packBody({ maxOutputTokens: 32_001 })), { config: testConfig })).status).toBe(400);
    expect((await call(req('POST', '/relay/ai', packBody({ provider: 'openai' })), { config: testConfig })).status).toBe(400);
  });

  it('Copilot: model saved in the relay, call goes to the Copilot service with premium requests; nothing reaches Foundry', async () => {
    const { calls, service } = fakeCopilot('{"packId":"x"}');
    expect((await call(req('POST', '/relay/ai', packBody({ provider: 'copilotSdk' })), { copilot: service })).body).toEqual({ allowed: false, reasons: ['notConfigured'] });
    expect((await call(req('PUT', '/relay/copilot', { model: 'gpt 5; rm' }))).status).toBe(400);
    expect((await call(req('PUT', '/relay/copilot', { model: 'gpt-5', token: 'x' }))).status).toBe(400);
    expect((await call(req('PUT', '/relay/copilot', { model: 'gpt-5' }))).status).toBe(200);
    expect(((await call(req('GET', '/relay/status'))).body as { copilot: unknown }).copilot).toEqual({ model: 'gpt-5' });
    const r = await call(req('POST', '/relay/ai', packBody({ provider: 'copilotSdk' })), { copilot: service });
    expect(r).toEqual({ status: 200, body: { text: '{"packId":"x"}', inputTokens: 10, outputTokens: 20, premiumRequests: 1 } });
    expect(calls[0]!.model).toBe('gpt-5');
    expect(calls[0]!.system).toContain('JSON');
    expect(seen).toHaveLength(0);
    expect((await call(req('POST', '/relay/ai', { ...packBody({ provider: 'copilotSdk' }), use: 'explain', maxOutputTokens: 100, timeoutMs: 1000 }), { copilot: service })).body)
      .toEqual({ allowed: false, reasons: ['c03NotApproved'] });
    const st = await call(req('POST', '/relay/copilot/status', {}), { copilot: service });
    expect(st.body).toMatchObject({ authenticated: true, login: 'octocat', settings: { model: 'gpt-5' } });
    expect((await call(req('DELETE', '/relay/copilot'))).body).toEqual({ copilot: null });
  });

  it('alignment proposals use the dedicated JSON instruction and C-03 gate for both providers', async () => {
    const prompt = '{"purpose":"Synthetic delivery goal","projectSources":[{"id":"source-1","facts":[]}]}';
    const body = packBody({ use: 'alignmentProposal', lang: 'en', prompt, maxOutputTokens: 3000, timeoutMs: 5000 });
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', { endpoint: stubUrl, deployment: 'gpt-test' }), { config: testConfig })).status).toBe(200);
    seen = [];
    expect((await call(req('POST', '/relay/ai', body), { config: testConfig, table: { ...C03_TABLE, alignmentProposal: C03_TABLE.chat } })).status).toBe(403);
    expect((await call(req('POST', '/relay/ai', { ...body, maxOutputTokens: 3001 }), { config: testConfig })).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await call(req('POST', '/relay/ai', body), { config: testConfig })).status).toBe(200);
    const sent = JSON.parse(seen[0]!.body) as { messages: { content: string }[]; response_format: { type: string }; max_completion_tokens: number };
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.messages[0]!.content).toContain('human review');
    expect(sent.messages[1]!.content).toBe(`${prompt}\n\n`);
    expect(sent.max_completion_tokens).toBe(3000);

    const { calls, service } = fakeCopilot('{"kind":"unaligned"}');
    expect((await call(req('PUT', '/relay/copilot', { model: 'gpt-5' }))).status).toBe(200);
    const result = await call(req('POST', '/relay/ai', { ...body, provider: 'copilotSdk' }), { copilot: service });
    expect(result).toMatchObject({ status: 200, body: { text: '{"kind":"unaligned"}' } });
    expect(calls[0]).toMatchObject({ prompt, system: expect.stringContaining('human review') });
    expect(seen).toHaveLength(1);
  });

  it('official-site reader: token-protected, URL validated, outbound list honoured, errors mapped', async () => {
    let used = 0;
    const site = (async () => { used++; return { pages: [], failed: [] }; }) as unknown as RelayContext['site'];
    expect((await call(req('POST', '/relay/site', { url: 'https://example.com' }, { headers: { 'x-bas-relay': 'bad' } }), { site })).status).toBe(403);
    expect((await call(req('POST', '/relay/site', { url: 'https://example.com' }), { site })).status).toBe(200);
    expect((await call(req('POST', '/relay/site', { url: 1 }), { site })).status).toBe(400);
    expect(used).toBe(1);
    expect((await call(req('POST', '/relay/site', { url: 'http://127.0.0.1/' }))).body).toEqual({ error: 'invalidUrl' });
    expect((await call(req('POST', '/relay/site', { url: 'https://example.com/' }), { config: { ...STRICT_RELAY_CONFIG, outboundHosts: ['contoso.com'] } })).body).toEqual({ error: 'outboundNotAllowed' });
  });
});

describe('D-12 review fixes: Copilot and the outbound allowlist', () => {
  it('a Foundry-only BAS_RELAY_OUTBOUND_HOSTS never lets material go to GitHub Copilot; listing the Copilot hosts allows it', async () => {
    let calls = 0;
    const copilot = {
      status: async () => { calls++; return { available: true, authenticated: true, login: 'u', models: [] }; },
      complete: async () => { calls++; return { text: '{}', inputTokens: 1, outputTokens: 1, premiumRequests: 1 }; },
    } as unknown as NonNullable<RelayContext['copilot']>;
    const foundryOnly: RelayConfig = { ...STRICT_RELAY_CONFIG, outboundHosts: ['res.openai.azure.com'] };
    await call(req('PUT', '/relay/copilot', { model: 'gpt-5' }), { config: foundryOnly });
    const body = { use: 'packBuild', provider: 'copilotSdk', lang: 'ja', prompt: 'x', context: '', maxOutputTokens: 100, timeoutMs: 1000 };
    expect((await call(req('POST', '/relay/ai', body), { config: foundryOnly, copilot })).body).toEqual({ error: 'outboundNotAllowed' });
    expect((await call(req('POST', '/relay/copilot/status', {}), { config: foundryOnly, copilot })).body).toEqual({ error: 'outboundNotAllowed' });
    expect(calls).toBe(0);
    const withCopilot: RelayConfig = { ...foundryOnly, outboundHosts: ['res.openai.azure.com', 'api.githubcopilot.com', 'api.github.com', 'github.com'] };
    expect((await call(req('POST', '/relay/ai', body), { config: withCopilot, copilot })).status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe('D-14 Work IQ through the relay (Microsoft Foundry only)', () => {
  const TENANT = '11111111-2222-3333-4444-555555555555';
  const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const REFRESH = 'rt-FAKE-REFRESH-0123456789';
  const ACCESS = 'at-FAKE-ACCESS-0123456789';
  const idToken = `x.${Buffer.from(JSON.stringify({ preferred_username: 'user@contoso.example' })).toString('base64url')}.y`;
  const conn = { endpoint: 'https://res.services.ai.azure.com', deployment: 'gpt-test', apiVersion: '2024-10-21' };
  const question = { provider: 'foundry', company: 'Contoso', project: 'Delivery', purpose: 'Reduce late deliveries', focus: '', asOf: '2026-11-11', lang: 'en', timeZone: 'Asia/Tokyo' };
  const chatReply = (prompt: string) => ({
    id: 'conv-1', turnCount: 1,
    messages: [
      { id: 'm1', text: prompt, attributions: [] },
      {
        id: 'm2', text: 'Contoso: on-time delivery 92% in FY26 (Ops review, 2026-10-01).',
        attributions: [
          { attributionType: 'citation', providerDisplayName: 'Ops review FY26.pptx', seeMoreWebUrl: 'https://contoso.sharepoint.com/ops.pptx' },
          { attributionType: 'citation', providerDisplayName: 'dup', seeMoreWebUrl: 'https://contoso.sharepoint.com/ops.pptx' },
          { attributionType: 'citation', providerDisplayName: 'insecure', seeMoreWebUrl: 'http://contoso.example/x' },
          { attributionType: 'annotation', providerDisplayName: '', seeMoreWebUrl: 'https://www.office.com/search?q=x' },
        ],
        sensitivityLabel: { displayName: 'Confidential' },
      },
    ],
  });

  /** Stub of Microsoft Entra and Work IQ that records every request (the documented REST contract). */
  function microsoft(opts: { pending?: number; createStatus?: number[]; chatStatus?: number; noCitations?: boolean } = {}) {
    const calls: { url: string; init: RequestInit | undefined; form?: URLSearchParams; json?: Record<string, unknown> }[] = [];
    let pending = opts.pending ?? 0;
    const createStatus = [...(opts.createStatus ?? [])];
    const doFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const entry: (typeof calls)[number] = { url, init };
      calls.push(entry);
      if (url.startsWith('https://login.microsoftonline.com/')) {
        entry.form = new URLSearchParams(String(init?.body));
        if (url.endsWith('/devicecode')) {
          return Response.json({ device_code: 'dc-SECRET', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
        }
        if (entry.form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code' && pending-- > 0) {
          return Response.json({ error: 'authorization_pending' }, { status: 400 });
        }
        return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, id_token: idToken });
      }
      entry.json = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === 'https://workiq.svc.cloud.microsoft/rest/conversations') {
        const status = createStatus.shift() ?? 201;
        return status === 201 ? Response.json({ id: 'conv-1', state: 'active', turnCount: 0 }, { status: 201 }) : new Response('', { status });
      }
      if (url === 'https://workiq.svc.cloud.microsoft/rest/conversations/conv-1/chat') {
        if (opts.chatStatus) return new Response('private service error', { status: opts.chatStatus });
        const reply = chatReply(String((entry.json.message as { text: string }).text));
        if (opts.noCitations) reply.messages.forEach((m) => { m.attributions = []; });
        return Response.json(reply);
      }
      return new Response('', { status: 404 });
    };
    return { calls, doFetch };
  }

  let clock: number;
  const ctx = (doFetch: typeof fetch, extra: Partial<RelayContext> = {}): Partial<RelayContext> => ({ fetch: doFetch, now: () => clock, ...extra });

  async function signIn(m: ReturnType<typeof microsoft>, workiq: NonNullable<RelayContext['workiq']>) {
    expect((await call(req('PUT', '/relay/workiq', { tenantId: TENANT, clientId: CLIENT }), ctx(m.doFetch, { workiq }))).status).toBe(200);
    const started = await call(req('POST', '/relay/workiq/signin', {}), ctx(m.doFetch, { workiq }));
    expect(started).toEqual({ status: 200, body: { userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 } });
    for (;;) {
      clock += 5_000;
      const r = await call(req('POST', '/relay/workiq/signin/poll', {}), ctx(m.doFetch, { workiq }));
      expect(r.status).toBe(200);
      if ((r.body as { status: string }).status === 'signedIn') return r;
    }
  }

  async function verifyFoundry() {
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply })).status).toBe(200);
  }

  beforeEach(() => { clock = Date.parse('2026-11-11T05:00:00Z'); });
  afterEach(() => {
    for (const a of answers) {
      const text = JSON.stringify(a.body);
      for (const secret of [REFRESH, ACCESS, 'dc-SECRET']) expect(text).not.toContain(secret);
    }
  });

  it('signs in by device code with the delegated WorkIQAgent.Ask scope and keeps the refresh token only in the vault', async () => {
    const m = microsoft({ pending: 1 });
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    expect((await call(req('PUT', '/relay/workiq', { tenantId: 'common', clientId: CLIENT }))).body).toEqual({ error: 'invalidSettings' });
    expect((await call(req('PUT', '/relay/workiq', { tenantId: TENANT, clientId: CLIENT, secret: 'x' }))).body).toEqual({ error: 'invalidSettings' });
    expect((await call(req('POST', '/relay/workiq/signin', {}), ctx(m.doFetch, { workiq }))).body).toEqual({ error: 'notConfigured' });

    const done = await signIn(m, workiq);
    expect(done.body).toEqual({ status: 'signedIn', account: 'user@contoso.example' });
    const [code, poll1, poll2] = m.calls;
    expect(code!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`);
    expect(code!.form!.get('client_id')).toBe(CLIENT);
    expect(code!.form!.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask', 'offline_access']));
    expect(code!.form!.has('client_secret')).toBe(false);
    expect(poll1!.form!.get('device_code')).toBe('dc-SECRET');
    expect(poll2!.form!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');

    const status = await call(req('GET', '/relay/status'), { workiq });
    expect((status.body as { workiq: unknown }).workiq).toEqual({ method: 'app', tenantId: TENANT, clientId: CLIENT, account: 'user@contoso.example', signedIn: true, verifiedAt: null });
    expect((status.body as { secrets: Record<string, boolean> }).secrets).toEqual({ foundryKey: false, speechKey: false });
    expect(readFileSync(vault.filePath, 'utf8')).not.toContain(REFRESH);
    // The browser can neither write nor delete the internal token through the secrets route.
    expect((await call(req('PUT', '/relay/secrets/workiqRefreshToken', { value: 'x' }))).status).toBe(404);

    // Another tenant or app signs the user out.
    await call(req('PUT', '/relay/workiq', { tenantId: TENANT, clientId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff' }), { workiq });
    expect(vault.get('workiqRefreshToken')).toBeUndefined();
    expect((await call(req('GET', '/relay/status'), { workiq })).body).toMatchObject({ workiq: { signedIn: false, account: null } });
  });

  it('asks with web grounding off and returns the answer, https citations and the sensitivity label', async () => {
    const m = microsoft();
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    await signIn(m, workiq);
    await verifyFoundry();
    m.calls.length = 0;
    const r = await call(req('POST', '/relay/workiq/ask', question), ctx(m.doFetch, { workiq }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      answer: 'Contoso: on-time delivery 92% in FY26 (Ops review, 2026-10-01).',
      citations: [{ title: 'Ops review FY26.pptx', url: 'https://contoso.sharepoint.com/ops.pptx' }],
      sensitivity: 'Confidential',
      fetchedAt: new Date(clock).toISOString(),
    });
    const chat = m.calls.find((c) => c.url.endsWith('/chat'))!;
    expect((chat.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS}`);
    expect(chat.json).toMatchObject({ locationHint: { timeZone: 'Asia/Tokyo' }, contextualResources: { webContext: { isWebEnabled: false } } });
    const text = (chat.json!.message as { text: string }).text;
    expect(text).toContain('"Contoso"');
    expect(text).toContain('Reduce late deliveries');
    expect((r.body as { question: string }).question).toBe(text);
    // The access token from the sign-in is reused: no Entra call for this question.
    expect(m.calls.some((c) => c.url.includes('login.microsoftonline.com'))).toBe(false);
  });

  it('is refused for GitHub Copilot, without a verified Foundry connection, with an outbound allowlist lacking its hosts, and for free-form fields', async () => {
    const m = microsoft();
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    await signIn(m, workiq);
    m.calls.length = 0;
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, provider: 'copilotSdk' }), ctx(m.doFetch, { workiq }))).body).toEqual({ error: 'foundryOnly' });
    expect((await call(req('POST', '/relay/workiq/ask', question), ctx(m.doFetch, { workiq }))).body).toEqual({ error: 'foundryNotConfigured' });
    await verifyFoundry();
    const foundryOnly: RelayConfig = { ...STRICT_RELAY_CONFIG, outboundHosts: ['res.services.ai.azure.com'] };
    expect((await call(req('POST', '/relay/workiq/ask', question), ctx(m.doFetch, { workiq, config: foundryOnly }))).body).toEqual({ error: 'outboundNotAllowed' });
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, prompt: 'anything' }), ctx(m.doFetch, { workiq }))).body).toEqual({ error: 'invalidQuestion' });
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, company: '' }), ctx(m.doFetch, { workiq }))).body).toEqual({ error: 'invalidQuestion' });
    expect(m.calls).toEqual([]);
  });

  it('refreshes an expired access token once and signs out when the refresh token is rejected', async () => {
    const m = microsoft({ createStatus: [401] });
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    await signIn(m, workiq);
    await verifyFoundry();
    m.calls.length = 0;
    expect((await call(req('POST', '/relay/workiq/ask', question), ctx(m.doFetch, { workiq }))).status).toBe(200);
    expect(m.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/rest/conversations', `/${TENANT}/oauth2/v2.0/token`, '/rest/conversations', '/rest/conversations/conv-1/chat',
    ]);
    expect(m.calls[1]!.form!.get('grant_type')).toBe('refresh_token');

    const rejecting: typeof fetch = async (input) => (String(input).includes('login.microsoftonline.com')
      ? Response.json({ error: 'invalid_grant' }, { status: 400 })
      : new Response('', { status: 401 }));
    const fresh = workIqServiceFor(vault, { fetch: rejecting, now: () => clock });
    expect(await call(req('POST', '/relay/workiq/ask', question), ctx(rejecting, { workiq: fresh }))).toEqual({ status: 401, body: { error: 'notSignedIn' } });
    expect(vault.get('workiqRefreshToken')).toBeUndefined();
  });

  it('requires a real source citation to verify retrieval and persists only credential-bound evidence', async () => {
    const m = microsoft();
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    await signIn(m, workiq);
    const result = await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), ctx(m.doFetch, { workiq }));
    expect(result).toMatchObject({ status: 200, body: { workiq: { signedIn: true, verifiedAt: new Date(clock).toISOString() } } });
    const chat = m.calls.find((c) => c.url.endsWith('/chat'))!;
    expect(chat.json).toMatchObject({ contextualResources: { webContext: { isWebEnabled: false } }, locationHint: { timeZone: 'UTC' } });
    expect((chat.json!.message as { text: string }).text).toContain('Connection diagnostic');
    const serialized = JSON.stringify(result.body) + readFileSync(join(vault.dir, 'workiq.json'), 'utf8');
    expect(serialized).not.toContain('Contoso:');
    expect(serialized).not.toContain('https://contoso.sharepoint.com/ops.pptx');
    // A restart retains evidence; a changed credential cannot inherit it.
    const fresh = workIqServiceFor(vault);
    expect((await call(req('GET', '/relay/status'), { workiq: fresh })).body).toMatchObject({ workiq: { verifiedAt: new Date(clock).toISOString() } });
    vault.delete('workiqRefreshToken');
    expect((await call(req('GET', '/relay/status'), { workiq: fresh })).body).toMatchObject({ workiq: { verifiedAt: null, signedIn: false } });
  });

  it('clears successful evidence on a failed retest and does not treat an ungrounded answer as success', async () => {
    const m = microsoft();
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    await signIn(m, workiq);
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), ctx(m.doFetch, { workiq }))).status).toBe(200);
    const denied = microsoft({ chatStatus: 403 });
    const fresh = workIqServiceFor(vault, { fetch: denied.doFetch, now: () => clock });
    expect(await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), ctx(denied.doFetch, { workiq: fresh })))
      .toEqual({ status: 403, body: { error: 'workiqForbidden' } });
    expect((await call(req('GET', '/relay/status'), { workiq: fresh })).body).toMatchObject({ workiq: { signedIn: true, verifiedAt: null } });
    const ungrounded = microsoft({ noCitations: true });
    const other = workIqServiceFor(vault, { fetch: ungrounded.doFetch, now: () => clock });
    expect(await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), ctx(ungrounded.doFetch, { workiq: other })))
      .toEqual({ status: 502, body: { error: 'workiqNoGrounding' } });
  });

  it('refuses diagnostics without sign-in, for Copilot, arbitrary prompts, and restricted outbound hosts', async () => {
    const m = microsoft();
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), { workiq })).body).toEqual({ error: 'notConfigured' });
    await call(req('PUT', '/relay/workiq', { tenantId: TENANT, clientId: CLIENT }), { workiq });
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'copilotSdk' }), { workiq })).body).toEqual({ error: 'foundryOnly' });
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'foundry', prompt: 'private' }), { workiq })).status).toBe(400);
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), { workiq, config: { ...STRICT_RELAY_CONFIG, outboundHosts: ['example.com'] } })).body).toEqual({ error: 'outboundNotAllowed' });
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), { workiq })).body).toEqual({ error: 'notSignedIn' });
    expect(m.calls).toEqual([]);
  });
});

describe('D-14 Work IQ through the Work IQ CLI (MCP stdio, Microsoft Foundry only)', () => {
  const conn = { endpoint: 'https://res.services.ai.azure.com', deployment: 'gpt-test', apiVersion: '2024-10-21' };
  const question = { provider: 'foundry', company: 'Contoso', project: 'Delivery', purpose: 'Reduce late deliveries', focus: '', asOf: '2026-11-11', lang: 'en', timeZone: 'Asia/Tokyo' };
  /** A stand-in for `workiq mcp`: newline-delimited JSON-RPC, the documented retrieve payload, and the EULA gate. */
  const FAKE = `
const [mode, log] = process.argv.slice(2);
const fs = require('node:fs');
let buf = '';
const tries = {};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') {
      process.stdout.write('not json from the CLI\\n');
      send({ id: 99, method: 'roots/list' });
      send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'WorkIQ', version: '1.0.0' } } });
    } else if (m.method === 'tools/call') {
      fs.appendFileSync(log, JSON.stringify(m.params) + '\\n');
      if (mode === 'crash') process.exit(3);
      if (mode === 'hang') return;
      const q = String(m.params.arguments && m.params.arguments.query);
      tries[q] = (tries[q] || 0) + 1;
      if (mode === 'flaky' && /KPI/.test(q) && tries[q] <= 2) {
        // Work IQ's generic failure (seen after ~30 s on 4 % of the searches, 2026-11-12), twice; the third try succeeds.
        send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: "An error occurred invoking 'retrieve'." }] } });
        continue;
      }
      if (mode === 'byquery') {
        const results = [{ markdown: 'Shared overview of the Contoso programme.', webUrl: 'https://contoso.sharepoint.com/common.docx', entityType: 'Files', resourceMetadata: { document: { title: 'Overview' } } }];
        if (/KPI|scorecard/i.test(q)) results.unshift({ markdown: 'NSAT target 4.5 (FY27).', webUrl: 'https://contoso.sharepoint.com/kpi.xlsx', entityType: 'Files', resourceMetadata: { document: { title: 'KPI scorecard' } } });
        send({ id: m.id, result: { content: [], structuredContent: { 'application/vnd.ms-workiq.retrieval': { results, resultCount: results.length, stoppedReason: 'completed' } } } });
        continue;
      }
      if (mode === 'eula' && m.params.name !== 'accept_eula') {
        send({ id: m.id, result: { content: [{ type: 'text', text: 'You must accept the EULA before using this tool. Use the accept_eula tool to continue.' }] } });
      } else if (mode === 'denied') {
        send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: '403 Forbidden: consent required' }] } });
      } else if (m.params.name === 'accept_eula') {
        send({ id: m.id, result: { content: [{ type: 'text', text: 'EULA accepted' }] } });
      } else if (mode === 'results') {
        // The shape @microsoft/workiq 1.0.x returned on 2026-11-11: per-result markdown, no top-level markdown/retrievalHits.
        const results = [
          { markdown: 'Contoso on-time delivery was 92% in FY26.', id: 'r1', webUrl: 'https://contoso.sharepoint.com/ops.pptx', entityType: 'Files', contentProtection: 'allowed',
            resourceMetadata: { document: { title: 'Ops review FY26.pptx' } }, sensitivityLabel: { displayName: 'Confidential' } },
          { markdown: 'Delivery KPI review with Contoso.', id: 'r2', webUrl: 'https://teams.microsoft.com/l/meetup-join/1', entityType: 'Meetings', contentProtection: 'allowed',
            resourceMetadata: { meeting: { title: 'Contoso KPI review', startTime: '2026-10-01T01:00:00Z' } } },
          { markdown: 'PROTECTED BODY', id: 'r3', webUrl: 'https://outlook.office.com/mail/id/2', entityType: 'Emails', contentProtection: 'blocked',
            resourceMetadata: { email: { subject: 'Contoso contract', sentTime: '2026-09-30T00:00:00Z' } } },
        ];
        send({ id: m.id, result: { content: [], isError: false, structuredContent: { 'application/vnd.ms-workiq.retrieval': {
          results, resultCount: results.length, searchMetadata: { types: ['File', 'Event', 'Message'] }, stoppedReason: 'completed' } } } });
      } else {
        const hits = mode === 'nohits' ? [] : [
          { id: 'h1', webUrl: 'https://contoso.sharepoint.com/ops.pptx', resourceMetadata: { document: { title: 'Ops review FY26.pptx' } }, sensitivityLabel: { displayName: 'Confidential' } },
          { id: 'h2', webUrl: 'https://contoso.sharepoint.com/ops.pptx' },
          { id: 'h3', webUrl: 'http://contoso.example/x' },
          { id: 'h4', webUrl: 'https://outlook.office.com/mail/id/1', resourceMetadata: { email: { subject: 'Delivery KPI' } }, sensitivityLabel: { displayName: 'General' } },
        ];
        send({ id: m.id, result: { content: [{ type: 'text', text: 'see structured content' }], structuredContent: { 'application/vnd.ms-workiq.retrieval': {
          markdown: 'Contoso: on-time delivery 92% in FY26 [^h1].', retrievalHits: hits, resultCount: hits.length, stoppedReason: 'completed' } } } });
      }
    }
  }
});
`;
  let script: string;
  let log: string;
  const cli = (mode: string, timeoutMs?: number, eulaAccepted = true) => new WorkIqCliService({
    command: () => ({ command: process.execPath, args: [script, mode, log], shell: false }), now: () => Date.parse('2026-11-11T05:00:00Z'), timeoutMs, sessionIdleMs: 0, retryDelayMs: 0,
    config: async () => ({ account: 'user@contoso.example', eulaAccepted }),
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { name: string; arguments: Record<string, unknown> }) : []);
  const verify = (workiqCli: WorkIqCliService) => call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), { workiqCli, now: () => Date.parse('2026-11-11T05:00:00Z') });

  beforeEach(() => {
    script = join(dir, 'fake-workiq.cjs');
    log = join(dir, 'calls.jsonl');
    writeFileSync(script, FAKE);
  });

  it('starts the pinned CLI as an MCP server with npm\'s npx, or the program in BAS_WORKIQ_CLI', () => {
    expect(workIqCliCommand({ BAS_WORKIQ_CLI: 'C:\\tools\\workiq.exe' }, 'node')).toEqual({ command: 'C:\\tools\\workiq.exe', args: ['mcp'], shell: false });
    expect(workIqCliCommand({ BAS_WORKIQ_CLI: '/opt/workiq/bin/workiq.js' }, '/usr/bin/node')).toEqual({ command: '/usr/bin/node', args: ['/opt/workiq/bin/workiq.js', 'mcp'], shell: false });
    expect(workIqCliCommand({}, process.execPath).args.slice(-3)).toEqual(['-y', WORKIQ_CLI_PACKAGE, 'mcp']);
    expect(workIqCliCommand({}, join(dir, 'no-node-here'), 'win32')).toEqual({ command: 'npx.cmd', args: ['-y', WORKIQ_CLI_PACKAGE, 'mcp'], shell: true });
  });

  it('verifies only with a Microsoft 365 source URL, seals the result in the vault, and saves no retrieved content', async () => {
    expect((await call(req('PUT', '/relay/workiq', { method: 'cli', tenantId: 'x' }))).body).toEqual({ error: 'invalidSettings' });
    expect((await call(req('PUT', '/relay/workiq', { method: 'cli' }))).body).toEqual({ workiq: { method: 'cli', tenantId: null, clientId: null, account: null, signedIn: false, verifiedAt: null } });
    // The CLI holds its own sign-in: no device code here.
    expect((await call(req('POST', '/relay/workiq/signin', {}))).body).toEqual({ error: 'notConfigured' });

    expect(await verify(cli('nohits'))).toEqual({ status: 502, body: { error: 'workiqNoGrounding' } });
    const ok = await verify(cli('ok'));
    expect(ok).toEqual({ status: 200, body: { workiq: { method: 'cli', tenantId: null, clientId: null, account: null, signedIn: true, verifiedAt: '2026-11-11T05:00:00.000Z' } } });
    const [first] = calls();
    expect(first).toEqual({ name: 'retrieve', arguments: { query: expect.any(String), strategy: 'grounding', timeZone: 'UTC' } });
    const saved = readFileSync(join(vault.dir, 'workiq.json'), 'utf8');
    expect(saved).not.toContain('Contoso');
    expect(saved).not.toContain('sharepoint');
    expect(JSON.stringify(ok.body)).not.toContain('sharepoint');

    // Editing workiq.json cannot forge the green check: the seal needs the relay-only key.
    writeFileSync(join(vault.dir, 'workiq.json'), JSON.stringify({ method: 'cli', verifiedAt: '2026-11-12T00:00:00.000Z', verification: 'a'.repeat(64) }));
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ workiq: { signedIn: false, verifiedAt: null } });
    expect((await call(req('PUT', '/relay/secrets/workiqCliKey', { value: 'x' }))).status).toBe(404);

    // A failed retest clears the previous success.
    expect((await verify(cli('ok'))).status).toBe(200);
    expect(await verify(cli('denied'))).toEqual({ status: 403, body: { error: 'workiqForbidden' } });
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ workiq: { verifiedAt: null } });
  });

  it('reports the EULA gate, accepts the EULA only on an explicit request, and maps a missing or failing CLI', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    expect(await verify(cli('eula'))).toEqual({ status: 412, body: { error: 'workiqEulaRequired' } });
    expect((await call(req('POST', '/relay/workiq/eula', { provider: 'foundry' }), { workiqCli: cli('eula') })).status).toBe(400);
    expect((await call(req('POST', '/relay/workiq/eula', { provider: 'copilotSdk', accept: true }), { workiqCli: cli('eula') })).body).toEqual({ error: 'foundryOnly' });
    expect(calls().map((c) => c.name)).toEqual(['retrieve']);
    expect(await call(req('POST', '/relay/workiq/eula', { provider: 'foundry', accept: true }), { workiqCli: cli('eula') })).toEqual({ status: 200, body: { accepted: true } });
    expect(calls().at(-1)).toEqual({ name: 'accept_eula', arguments: { eulaUrl: WORKIQ_EULA_URL } });
    // The tool answering is not enough: the CLI must have persisted I-accept-EULA=true.
    expect(await call(req('POST', '/relay/workiq/eula', { provider: 'foundry', accept: true }), { workiqCli: cli('eula', undefined, false) }))
      .toEqual({ status: 412, body: { error: 'workiqEulaRequired' } });

    const missing = new WorkIqCliService({ command: () => ({ command: join(dir, 'no-such-workiq.exe'), args: ['mcp'], shell: false }) });
    expect(await verify(missing)).toEqual({ status: 503, body: { error: 'workiqCliMissing' } });
    expect(await verify(cli('crash'))).toEqual({ status: 502, body: { error: 'workiqUnavailable' } });
    expect(await verify(cli('hang', 1_500))).toEqual({ status: 504, body: { error: 'workiqTimeout' } });
  });

  it('reads the per-result payload the CLI actually returns: verifies, cites each source and withholds protected text', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    expect((await verify(cli('results'))).status).toBe(200);
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply })).status).toBe(200);
    const r = await call(req('POST', '/relay/workiq/ask', question), { workiqCli: cli('results') });
    expect(r.status).toBe(200);
    const body = r.body as { answer: string; citations: { title: string; url: string }[]; sensitivity: string | null };
    expect(body.citations).toEqual([
      { title: 'Ops review FY26.pptx', url: 'https://contoso.sharepoint.com/ops.pptx' },
      { title: 'Contoso KPI review', url: 'https://teams.microsoft.com/l/meetup-join/1' },
      { title: 'Contoso contract', url: 'https://outlook.office.com/mail/id/2' },
    ]);
    expect(body.answer).toContain('[1] Ops review FY26.pptx (Files) <https://contoso.sharepoint.com/ops.pptx>\nContoso on-time delivery was 92% in FY26.');
    expect(body.answer).toContain('[2] Contoso KPI review (Meetings, 2026-10-01)');
    expect(body.answer).toContain('[3] Contoso contract (Emails, 2026-09-30)');
    expect(body.answer).not.toContain('PROTECTED BODY');
    expect(body.sensitivity).toBe('Confidential');
  });

  it('answers one section per aspect and follow-up topic in one CLI session, and rejects unknown aspects', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply })).status).toBe(200);
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, aspects: ['payroll'] }), { workiqCli: cli('ok') })).body).toEqual({ error: 'invalidQuestion' });
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, aspects: [], topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }), { workiqCli: cli('ok') })).body).toEqual({ error: 'invalidQuestion' });

    const r = await call(req('POST', '/relay/workiq/ask', { ...question, aspects: ['kpi', 'data'], topics: ['kpi: NSAT target'] }), { workiqCli: cli('ok') });
    expect(r.status).toBe(200);
    const sections = (r.body as { sections: { key: string; question: string; citations: unknown[] }[] }).sections;
    expect(sections.map((s) => s.key)).toEqual(['kpi', 'data', 'topic-1']);
    expect(sections.every((s) => s.citations.length === 2)).toBe(true);
    const asked = calls().map((c) => String(c.arguments.query));
    expect(asked).toHaveLength(3);
    expect(asked[2]).toContain('NSAT target');
    expect(new Set(asked).size).toBe(3);
  });

  it('keeps one CLI session for the searches of a generation and retries a transient failure twice', async () => {
    let spawned = 0;
    const svc = new WorkIqCliService({
      command: () => ({ command: process.execPath, args: [script, 'flaky', log], shell: false }), now: () => Date.parse('2026-11-11T05:00:00Z'), retryDelayMs: 0,
      spawn: ((c, a, o) => { spawned++; return spawn(c, a, o); }) as SpawnLike,
    });
    const q: WorkIqQuestion = { company: 'Contoso', project: 'Delivery', purpose: 'Reduce late deliveries', focus: '', asOf: '2026-11-11', lang: 'en', timeZone: 'Asia/Tokyo', aspects: ['kpi', 'data'], topics: [], expand: false };
    try {
      const first = await svc.askSections(q);
      expect(first.map((s) => ('error' in s ? s.error : s.citations.length))).toEqual([2, 2]);
      const second = await svc.askSections({ ...q, aspects: [], topics: ['kpi: NSAT target'] });
      expect(second.map((s) => s.key)).toEqual(['topic-1']);
      expect(spawned).toBe(1);
      // Two sections, two retries of the KPI search, and the follow-up.
      expect(calls()).toHaveLength(5);
    } finally {
      svc.closeSession();
    }
  });

  it('expand: plans every readiness ladder wording and answers one merged, de-duplicated section per readiness item', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply })).status).toBe(200);
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, expand: 'yes' }), { workiqCli: cli('byquery') })).body).toEqual({ error: 'invalidQuestion' });

    const r = await call(req('POST', '/relay/workiq/ask', { ...question, aspects: ['kpi'], expand: true }), { workiqCli: cli('byquery') });
    expect(r.status).toBe(200);
    const sections = (r.body as { sections: { key: string; question: string; answer: string; citations: { title: string }[]; searches: string[] }[] }).sections;
    expect(sections.map((s) => s.key)).toEqual(['org', 'locations', 'customers', 'workflow', 'dataCatalog', 'kpi', 'engagements', 'issues']);
    // 1 section search + 3 wordings × 8 items, built by the relay.
    expect(calls()).toHaveLength(25);
    const kpi = sections.find((s) => s.key === 'kpi')!;
    expect(kpi.searches).toEqual(['KPI and OKR definitions with targets and actuals', 'metrics and attainment in scorecards, QBRs and business reviews', 'fiscal-year targets, commitments and success measures']);
    expect(kpi.question.split('\n')).toHaveLength(4);
    expect(kpi.citations.map((c) => c.title).sort()).toEqual(['KPI scorecard', 'Overview']);
    // The overview every search returned is sent once, with the item that ranked it highest.
    const all = sections.map((s) => s.answer).join('\n');
    expect(all.split('Shared overview').length - 1).toBe(1);
    expect(all.split('NSAT target 4.5').length - 1).toBe(1);
    expect(sections.filter((s) => s.key !== 'kpi').every((s) => s.citations.length === 0)).toBe(true);
  });

  it('merges planned searches by fused rank: one item per source, the longest excerpt, protected text withheld, the budget, and failed items', () => {
    const res = (...results: Record<string, unknown>[]) => ({ structuredContent: { 'application/vnd.ms-workiq.retrieval': { results, stoppedReason: 'completed' } } });
    const hit = (name: string, markdown: string, extra: Record<string, unknown> = {}) => ({
      webUrl: `https://contoso.sharepoint.com/${name}`, markdown, entityType: 'Files', resourceMetadata: { document: { title: name } }, ...extra,
    });
    const items = [
      { key: 'kpi', queries: ['q1', 'q2'], wordings: ['w2'], results: [res(hit('a', 'A text'), hit('b', 'B short')), res(hit('b', 'B much longer excerpt'), hit('c', 'PROTECTED', { contentProtection: 'blocked' }))] },
      { key: 'issues', queries: ['q3'], wordings: [], results: [res(hit('b', 'B'), hit('d', 'D text', { sensitivityLabel: { displayName: 'Confidential' } }))] },
      { key: 'org', queries: ['q4'], wordings: [], results: [new WorkIqError('workiqTimeout')] },
    ];
    const out = mergeByItem(items, '2026-11-12T00:00:00.000Z');
    const [kpi, issues, org] = out as { key: string; answer: string; question: string; searches: string[]; citations: { title: string }[]; sensitivity: string | null }[];
    // b: found by both kpi searches (1/61 + 1/62) and once for issues (1/61) → kpi, first.
    expect(kpi!.citations.map((c) => c.title)).toEqual(['b', 'a', 'c']);
    expect(kpi).toMatchObject({ question: 'q1\nq2', searches: ['w2'] });
    expect(kpi!.answer).toContain('[1] b (Files) <https://contoso.sharepoint.com/b>\nB much longer excerpt');
    expect(kpi!.answer).not.toContain('B short');
    expect(kpi!.answer).not.toContain('PROTECTED');
    expect(issues!.citations.map((c) => c.title)).toEqual(['d']);
    expect(issues!.sensitivity).toBe('Confidential');
    expect(org).toEqual({ key: 'org', error: 'workiqTimeout' });

    const small = mergeByItem(items.slice(0, 1), '2026-11-12T00:00:00.000Z', 40)[0] as { answer: string; citations: unknown[] };
    expect(small.citations).toHaveLength(1);
    expect(small.answer.endsWith('…')).toBe(true);
    expect(small.answer.length).toBe(41);
  });

  it('retrieves customer evidence with citations and labels for a Foundry pack, and never for Copilot', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    expect((await call(req('POST', '/relay/workiq/ask', question), { workiqCli: cli('ok') })).body).toEqual({ error: 'foundryNotConfigured' });
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply })).status).toBe(200);
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, provider: 'copilotSdk' }), { workiqCli: cli('ok') })).body).toEqual({ error: 'foundryOnly' });
    expect(calls()).toEqual([]);

    const r = await call(req('POST', '/relay/workiq/ask', question), { workiqCli: cli('ok') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      answer: 'Contoso: on-time delivery 92% in FY26 [^h1].',
      citations: [
        { title: 'Ops review FY26.pptx', url: 'https://contoso.sharepoint.com/ops.pptx' },
        { title: 'Delivery KPI', url: 'https://outlook.office.com/mail/id/1' },
      ],
      sensitivity: 'Confidential, General',
      fetchedAt: '2026-11-11T05:00:00.000Z',
    });
    const [retrieve] = calls();
    expect(retrieve!.arguments).toMatchObject({ strategy: 'grounding', timeZone: 'Asia/Tokyo' });
    expect(String(retrieve!.arguments.query)).toContain('"Contoso"');
    expect(String(retrieve!.arguments.query)).toContain('Reduce late deliveries');
  });

  it('switching to the app registration forgets the CLI verification', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    expect((await verify(cli('ok'))).status).toBe(200);
    expect(vault.get('workiqCliKey')).toBeTruthy();
    const r = await call(req('PUT', '/relay/workiq', { method: 'app', tenantId: '11111111-2222-3333-4444-555555555555', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    expect(r.body).toMatchObject({ workiq: { method: 'app', signedIn: false, verifiedAt: null } });
    expect(vault.get('workiqCliKey')).toBeUndefined();
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ workiq: { method: 'cli', verifiedAt: null } });
  });
});
