// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C03_TABLE, type AiUse, type UseApproval } from '../src/ai/policy.ts';
import { selectOutbound, toPromptContext } from '../src/ai/redact.ts';
import { loaded } from '../src/data/pack.ts';
import { SecretVault, protectorWorks, windowsDpapi, type KeyProtector } from '../server/vault.ts';
import {
  STRICT_RELAY_CONFIG, handleRelay, hostAllowed, isLoopback, loadConnection, newRelayToken, originAllowed, outboundAllowed, relayAiDecision,
  relayConfigFromEnv, relayDir, validateConnection, type RelayConfig, type RelayContext, type RelayRequest, type RelayResponse,
} from '../server/relay.ts';

const FAKE_KEY = 'sk-test-0123456789abcdefFAKEKEY';
const PORT = 4188;
const TOKEN = newRelayToken();
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

describe('secret vault (AES-256-GCM)', () => {
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
  it('PUT stores the key and no response ever contains it', async () => {
    const put = await call(req('PUT', '/relay/secrets/foundryKey', { value: FAKE_KEY }));
    expect(put.status).toBe(200);
    const status = await call(req('GET', '/relay/status'));
    expect(status).toEqual({ status: 200, body: { relay: 'ok', secrets: { foundryKey: true, speechKey: false }, connection: null, configured: false, keyProtection: 'file' } });
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

    const put = await call(req('PUT', '/relay/connection', { endpoint: 'https://res.openai.azure.com', deployment: 'gpt', apiVersion: '2024-10-21' }));
    expect(put.status).toBe(200);
    expect(existsSync(join(vault.dir, 'connection.json'))).toBe(true);
    vault.set('foundryKey', FAKE_KEY);
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
let mode: 'ok' | 'hang' | 'error' | 'garbage' = 'ok';
const PROVIDER_SECRET_BODY = 'provider-internal-detail-should-not-leak';

beforeAll(async () => {
  stub = createServer((r: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => {
      seen.push({ method: r.method ?? '', url: r.url ?? '', headers: r.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (mode === 'hang') return;
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
  });

  it('forwards to Azure OpenAI chat completions with the api-key header and returns text + token usage', async () => {
    expect(internal.classification).toBe('internal');
    const r = await call(req('POST', '/relay/ai', aiBody()), ctx());
    expect(r).toEqual({ status: 200, body: { text: 'stub answer', inputTokens: 123, outputTokens: 45 } });
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.method).toBe('POST');
    expect(s.url).toBe('/openai/deployments/gpt-test/chat/completions?api-version=2024-10-21');
    expect(s.headers['api-key']).toBe(FAKE_KEY);
    expect(s.headers.authorization).toBeUndefined();
    const sent = JSON.parse(s.body) as { messages: { role: string; content: string }[]; max_tokens: number };
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(sent.messages[1]!.content).toContain('Transferring expert skills'); // D-2: internal items may be sent
    expect(sent.messages[1]!.content.startsWith('Explain this screen.\n\n')).toBe(true);
    expect(sent.max_tokens).toBeLessThanOrEqual(1500);
    expect(Object.keys(sent).sort()).toEqual(['max_tokens', 'messages']);
  });

  it('refuses every unapproved use without contacting the provider', async () => {
    for (const use of (Object.keys(C03_TABLE) as AiUse[]).filter((u) => u !== 'explain')) {
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
    expect(err).toEqual({ status: 502, body: { error: 'providerError' } });
    expect(JSON.stringify(err.body)).not.toContain(PROVIDER_SECRET_BODY);
    clock += 10_000;
    mode = 'garbage';
    expect(await call(req('POST', '/relay/ai', aiBody()), ctx())).toEqual({ status: 502, body: { error: 'badProviderResponse' } });
    for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(FAKE_KEY);
  });
});