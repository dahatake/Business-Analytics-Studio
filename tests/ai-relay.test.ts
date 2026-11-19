// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_USES } from '../src/ai/policy.ts';
import { selectOutbound, toPromptContext } from '../src/ai/redact.ts';
import { loaded } from '../src/data/pack.ts';
import { SecretVault, protectorWorks, windowsDpapi, type KeyProtector } from '../server/vault.ts';
import { replaceFileSync } from '../server/files.ts';
import { reserveStory, storyQuote } from '../server/storyBudget.ts';
import {
  STRICT_RELAY_CONFIG, handleRelay, hostAllowed, isLoopback, loadConnection, newRelayToken, originAllowed, outboundAllowed, relayAiDecision,
  relayConfigFromEnv, relayDir, validateConnection, workIqServiceFor, type RelayConfig, type RelayContext, type RelayRequest, type RelayResponse,
} from '../server/relay.ts';
import { spawn } from 'node:child_process';
import { MAX_PURPOSE_SEARCHES, WORKIQ_OUTBOUND_HOSTS, WorkIqError, purposeTopics, workIqAspectKeywords, workIqAspectQuery, workIqPlan, workIqTopicQuery, type WorkIqQuestion } from '../server/workiq.ts';
import { WORKIQ_CLI_PACKAGE, WORKIQ_EULA_URL, AdaptiveLimit, WorkIqCliService, askAsRetrieval, deepReadPlan, deepReadText, inAdaptivePool, isM365FileUrl, mergeByItem, queryTerms, termCoverage, withAnswer, withDeepRead, workIqCliCommand, type SpawnLike } from '../server/workiqCli.ts';
import { EntraError, type EntraTokens } from '../server/entra.ts';
import { blankTestImage } from '../server/media.ts';
import { foundryMediaEndpoint, separateSpeechTestUrl, validateSeparateSpeech } from '../src/ai/mediaConnection.ts';

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

describe('HTML story cost reservations', () => {
  const conn = { endpoint: 'https://res.openai.azure.com', deployment: 'model-router', apiVersion: '2024-10-21' };
  const now = Date.parse('2026-11-17T00:00:00Z');
  const pricing = { ...conn, model: 'model-router', inputPerM: 300, outputPerM: 1200, source: 'https://azure.microsoft.com/pricing/details/ai-foundry-models/model-router/', expiresAt: '2026-12-01T00:00:00Z' };
  const body = { use: 'storyVideo', provider: 'foundry', lang: 'en', prompt: 'Generate a source-grounded story.', context: '', maxOutputTokens: 2000, timeoutMs: 90_000 };
  const prepare = async () => {
    vault.set('foundryKey', FAKE_KEY);
    await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply });
    const { apiVersion: _, ...rates } = pricing;
    writeFileSync(join(vault.dir, 'story-pricing.json'), JSON.stringify(rates));
  };
  it('refuses missing, expired, malformed, or destination-mismatched prices before any send', async () => {
    await prepare();
    const send = vi.fn<typeof fetch>();
    for (const patch of [{ expiresAt: '2020-01-01T00:00:00Z' }, { deployment: 'different' }, { endpoint: 'https://other.openai.azure.com' }, { inputPerM: 0 }, { source: 'https://unverified.example' }]) {
      const { apiVersion: _, ...rates } = pricing;
      writeFileSync(join(vault.dir, 'story-pricing.json'), JSON.stringify({ ...rates, ...patch }));
      expect((await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now })).body).toEqual({ error: 'storyPricing' });
    }
    rmSync(join(vault.dir, 'story-pricing.json'));
    expect((await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now })).body).toEqual({ error: 'storyPricing' });
    expect(send).not.toHaveBeenCalled();
  });
  it('binds prices to the resource origin, whether or not the endpoint includes /openai/v1', async () => {
    await prepare();
    const { apiVersion: _, ...rates } = pricing;
    writeFileSync(join(vault.dir, 'story-pricing.json'), JSON.stringify({ ...rates, endpoint: 'https://RES.openai.azure.com/openai/v1' }));
    expect(storyQuote(vault.dir, conn, body.prompt, '', 2000, now).maximumJpy).toBeGreaterThan(0);
  });
  it('reserves before forwarding, validates structured output, and persists costs across requests', async () => {
    await prepare();
    const before = storyQuote(vault.dir, conn, body.prompt, '', 2000, now);
    const result = await call(req('POST', '/relay/story/estimate', body), { now: () => now });
    expect(result.body).toMatchObject({ maximumJpy: before.maximumJpy, remainingJpy: 10_000 });
    expect(existsSync(join(vault.dir, 'story-budget.json'))).toBe(false);
    const send = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(JSON.parse(readFileSync(join(vault.dir, 'story-budget.json'), 'utf8'))['2026-11']).toBe(before.maximumJpy);
      expect(JSON.parse(String(init?.body)).max_completion_tokens).toBe(2000);
      expect(JSON.parse(String(init?.body)).response_format).toEqual({ type: 'json_object' });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ scenes: [{ title: 'Source', narration: 'Only supplied evidence.', role: 'opening', durationMs: 3000 }] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 80 },
      }));
    });
    const live = await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now });
    expect(live).toMatchObject({ status: 200, body: { costJpy: 0.126, reservedJpy: before.maximumJpy } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(storyQuote(vault.dir, conn, body.prompt, '', 2000, now).allocatedJpy).toBe(before.maximumJpy);
  });
  it('rejects per-story and monthly overages, including concurrent sends, without contacting Foundry', async () => {
    await prepare();
    const quote = storyQuote(vault.dir, conn, body.prompt, '', 2000, now);
    writeFileSync(join(vault.dir, 'story-budget.json'), JSON.stringify({ '2026-11': 10_000 - quote.maximumJpy }));
    reserveStory(vault.dir, conn, body.prompt, '', 2000, now);
    const send = vi.fn<typeof fetch>();
    expect((await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now })).body).toEqual({ error: 'storyMonthlyCap' });
    expect(send).not.toHaveBeenCalled();
    writeFileSync(join(vault.dir, 'story-budget.json'), '{}');
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    writeFileSync(join(vault.dir, 'story-budget.json'), JSON.stringify({ '2026-11': 10_000 - quote.maximumJpy }));
    const first = call(req('POST', '/relay/ai', body), { fetch: () => pending, now: () => now });
    expect((await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now })).body).toEqual({ error: 'storyMonthlyCap' });
    finish(new Response('{}', { status: 500 }));
    await first;
    expect(send).not.toHaveBeenCalled();
    const { apiVersion: _, ...rates } = pricing;
    writeFileSync(join(vault.dir, 'story-pricing.json'), JSON.stringify({ ...rates, outputPerM: 1_000_000 }));
    expect((await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now })).body).toEqual({ error: 'storyCap' });
  });
  it('accepts a rounded 1,000 JPY reservation but rejects the next cent', async () => {
    await prepare();
    const { apiVersion: _, ...rates } = pricing;
    const inputTokens = storyQuote(vault.dir, conn, body.prompt, '', 2000, now).inputTokens;
    const inputPerM = 0.000001;
    const outputPerM = ((999.995 / 1.2) * 1_000_000 - inputTokens * inputPerM) / 2000;
    writeFileSync(join(vault.dir, 'story-pricing.json'), JSON.stringify({ ...rates, inputPerM, outputPerM }));
    expect(storyQuote(vault.dir, conn, body.prompt, '', 2000, now).maximumJpy).toBe(1000);
    writeFileSync(join(vault.dir, 'story-pricing.json'), JSON.stringify({ ...rates, inputPerM, outputPerM: outputPerM + 10 }));
    expect(() => storyQuote(vault.dir, conn, body.prompt, '', 2000, now)).toThrow('storyCap');
  });
  it('retains failed-call reservations, fails closed on corrupt accounting, and uses the JST month boundary', async () => {
    await prepare();
    const send: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"scenes":[]}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    expect((await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now })).body).toEqual({ error: 'badProviderResponse' });
    expect(storyQuote(vault.dir, conn, body.prompt, '', 2000, now).allocatedJpy).toBeGreaterThan(0);
    writeFileSync(join(vault.dir, 'story-budget.json'), JSON.stringify({ '2026-10': 10_000 }));
    expect(storyQuote(vault.dir, conn, body.prompt, '', 2000, Date.parse('2026-10-31T15:00:00Z')).month).toBe('2026-11');
    writeFileSync(join(vault.dir, 'story-budget.json'), 'corrupt');
    expect((await call(req('POST', '/relay/ai', body), { fetch: send, now: () => now })).body).toEqual({ error: 'storyBudgetUnavailable' });
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
    expect(vault.status()).toEqual({ foundryKey: true });
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
    file.entries.foundryEntraKey = file.entries.foundryKey;
    writeFileSync(vault.filePath, JSON.stringify(file));
    expect(() => vault.get('foundryEntraKey')).toThrow();
  });

  it('deletes secrets', () => {
    vault.set('foundryKey', FAKE_KEY);
    expect(vault.delete('foundryKey')).toBe(true);
    expect(vault.status().foundryKey).toBe(false);
    expect(vault.get('foundryKey')).toBeUndefined();
    expect(vault.delete('foundryKey')).toBe(false);
  });

  it('purges the retired Speech / Vision keys and keeps the others (FR-328)', () => {
    vault.set('foundryKey', FAKE_KEY);
    const file = JSON.parse(readFileSync(vault.filePath, 'utf8')) as { entries: Record<string, unknown> };
    file.entries.speechKey = file.entries.foundryKey;
    file.entries.visionKey = file.entries.foundryKey;
    writeFileSync(vault.filePath, JSON.stringify(file));
    expect(vault.purgeLegacy()).toBe(true);
    expect(Object.keys((JSON.parse(readFileSync(vault.filePath, 'utf8')) as typeof file).entries)).toEqual(['foundryKey']);
    expect(vault.get('foundryKey')).toBe(FAKE_KEY);
    expect(vault.purgeLegacy()).toBe(false);
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

  it('reports an Azure content-filter refusal as contentFiltered without retrying or passing provider content', async () => {
    vault.set('foundryKey', FAKE_KEY);
    await call(req('PUT', '/relay/connection', c), { fetch: verifiedReply });
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return Response.json({ error: { code: 'content_filter', message: `secret ${FAKE_KEY}`, innererror: { code: 'ResponsibleAIPolicyViolation', content_filter_result: { jailbreak: { filtered: true, detected: true } } } } }, { status: 400 });
    };
    const result = await call(req('POST', '/relay/ai', { use: 'kpiOkrDraft', lang: 'ja', prompt: 'Synthetic.', maxOutputTokens: 100, timeoutMs: 1000 }), { fetch });
    expect(result).toEqual({ status: 502, body: { error: 'contentFiltered', providerStatus: 400 } });
    expect(calls).toBe(1);
  });

  it('passes only the sanitized longest Foundry retry delay on HTTP 429', async () => {
    vault.set('foundryKey', FAKE_KEY);
    await call(req('PUT', '/relay/connection', c), { fetch: verifiedReply });
    const fetch: typeof globalThis.fetch = async () => new Response(`secret ${FAKE_KEY}`, {
      status: 429, headers: { 'retry-after': '45', 'retry-after-ms': '12000', 'x-ms-retry-after-ms': 'invalid' },
    });
    const result = await call(req('POST', '/relay/ai', {
      use: 'packBuild', lang: 'en', prompt: 'Synthetic.', maxOutputTokens: 100, timeoutMs: 1000,
    }), { fetch });
    expect(result).toEqual({ status: 502, body: { error: 'providerBusy', providerStatus: 429, retryAfterMs: 45000 } });
  });

  it('accepts a retry date and ignores invalid retry headers', async () => {
    vault.set('foundryKey', FAKE_KEY);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
      const result = await call(req('PUT', '/relay/connection', c), {
        fetch: async () => new Response('', { status: 429, headers: { 'retry-after': 'Wed, 18 Nov 2026 12:01:00 GMT' } }),
      });
      expect(result.body).toEqual({ error: 'providerBusy', providerStatus: 429, retryAfterMs: 60000 });
      const invalid = await call(req('PUT', '/relay/connection', c), {
        fetch: async () => new Response('', { status: 429, headers: { 'retry-after': 'bad', 'retry-after-ms': '-5' } }),
      });
      expect(invalid.body).toEqual({ error: 'providerBusy', providerStatus: 429 });
      const huge = await call(req('PUT', '/relay/connection', c), {
        fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '9'.repeat(400) } }),
      });
      expect(huge.body).toEqual({ error: 'providerBusy', providerStatus: 429, retryAfterMs: 604800000 });
    } finally {
      vi.useRealTimers();
    }
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

  it('honors outbound, cancellation and repeated-send limits for diagnostics', async () => {
    vault.set('foundryKey', FAKE_KEY);
    let sent = 0;
    const fetch: typeof globalThis.fetch = async (...args) => { sent++; return verifiedReply(...args); };
    const lastCall = new Map<string, number>();
    expect((await call(req('PUT', '/relay/connection', c), { fetch, config: { ...STRICT_RELAY_CONFIG, outboundHosts: ['other.example'] } })).body).toEqual({ error: 'hostNotAllowed' });
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
    expect(status).toEqual({ status: 200, body: { relay: 'ok', secrets: { foundryKey: true }, connection: null, connectionVerifiedAt: null, configured: false, keyProtection: 'file', copilot: null, workiq: null, entra: { signedIn: false, account: null, tenantId: null, signIn: { status: 'idle' } }, media: { endpoint: null, auth: null, unavailable: 'noConnection', speech: null, vision: null }, speechConnection: { route: 'foundry', eligible: false, separate: null }, decision: null } });
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

  it('accepts every declared AI use and rejects unknown uses without contacting the provider', async () => {
    for (const use of AI_USES.filter((value) => value !== 'connectionTest' && value !== 'storyVideo')) {
      expect((await call(req('POST', '/relay/ai', aiBody({ use })), ctx())).status, use).toBe(200);
    }
    expect((await call(req('POST', '/relay/ai', aiBody({ use: 'nope' })), ctx())).status).toBe(400);
    expect(seen).toHaveLength(AI_USES.length - 2);
  });

  it('server-side decision: only requires a complete connection', () => {
    expect(relayAiDecision(true)).toEqual([]);
    expect(relayAiDecision(false)).toEqual(['notConfigured']);
    expect(relayAiDecision(false)).toEqual(['notConfigured']);
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

  it('attachments: images go to Foundry as image_url parts; PDF, a spoofed type or media on a connection test never leave', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString('base64');
    const pdf = Buffer.from('%PDF-1.7\n%xx\n').toString('base64');
    const image = { name: 'chart.png', mimeType: 'image/png', data: png };
    for (const media of [[{ name: 'r.pdf', mimeType: 'application/pdf', data: pdf }], [{ ...image, mimeType: 'image/jpeg' }], [{ ...image, data: pdf }], []]) {
      expect((await call(req('POST', '/relay/ai', aiBody({ media })), ctx())).status, JSON.stringify(media).slice(0, 60)).toBe(400);
    }
    expect((await call(req('POST', '/relay/ai', { use: 'connectionTest', media: [image] }), ctx())).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await call(req('POST', '/relay/ai', aiBody({ media: [image] })), ctx())).status).toBe(200);
    const sent = JSON.parse(seen[0]!.body) as { messages: { content: unknown }[] };
    expect(sent.messages[1]!.content).toEqual([
      { type: 'text', text: expect.stringContaining('Explain this screen.') },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ]);
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
    const calls: { model: string; system: string; prompt: string; timeoutMs: number }[] = [];
    const service = {
      status: async () => ({ available: true, authenticated: true, login: 'octocat', models: [{ id: 'gpt-5', name: 'GPT-5', multiplier: 1 }] }),
      complete: async (i: { model: string; system: string; prompt: string; timeoutMs: number }) => {
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

  it('allows each AI use when the provider is configured', () => {
    expect(relayAiDecision(true)).toEqual([]);
    expect(relayAiDecision(false)).toEqual(['notConfigured']);
  });

  it('D-20 recommend: suggestion instructions for both providers; prompt + context capped at 32,000 characters', async () => {
    const body = (extra: Record<string, unknown> = {}) => ({ use: 'recommend', provider: 'foundry', lang: 'ja', prompt: '[bas-proj:recommend] 在庫', context: '', maxOutputTokens: 4000, timeoutMs: 90_000, ...extra });
    vault.set('foundryKey', FAKE_KEY);
    await call(req('PUT', '/relay/connection', { endpoint: stubUrl, deployment: 'gpt-test' }), { config: testConfig });
    seen = [];
    expect((await call(req('POST', '/relay/ai', body()), { config: testConfig })).status).toBe(200);
    const sent = JSON.parse(seen[0]!.body) as { messages: { content: string }[]; response_format?: unknown };
    expect(sent.messages[0]!.content).toContain('1 行に 1 件');
    expect(sent.response_format).toBeUndefined();
    expect((await call(req('POST', '/relay/ai', body({ prompt: 'x'.repeat(31_000), context: 'y'.repeat(1_001) })), { config: testConfig })).status).toBe(400);
    expect((await call(req('POST', '/relay/ai', body({ maxOutputTokens: 4001 })), { config: testConfig })).status).toBe(400);

    const { calls, service } = fakeCopilot('提案');
    expect((await call(req('PUT', '/relay/copilot', { model: 'gpt-5' }))).status).toBe(200);
    expect((await call(req('POST', '/relay/ai', body({ provider: 'copilotSdk', lang: 'en' })), { copilot: service })).status).toBe(200);
    expect(calls[0]!.system).toContain('One per line');
    await call(req('DELETE', '/relay/copilot'));
  });

  it('D-23 deliverable drafts use hypothesis-safe instructions for both providers', async () => {
    const body = { use: 'deliverableDraft', provider: 'foundry', lang: 'ja', prompt: 'synthetic', context: '', maxOutputTokens: 8000, timeoutMs: 300_000 };
    vault.set('foundryKey', FAKE_KEY);
    await call(req('PUT', '/relay/connection', { endpoint: stubUrl, deployment: 'gpt-test' }), { config: testConfig });
    seen = [];
    expect((await call(req('POST', '/relay/ai', body), { config: testConfig })).status).toBe(200);
    const sent = JSON.parse(seen[0]!.body) as { messages: { content: string }[] };
    expect(sent.messages[0]!.content).toContain('仮説');
    expect(sent.messages[0]!.content).toContain('検証方法');
    expect((await call(req('POST', '/relay/ai', { ...body, maxOutputTokens: 8001 }), { config: testConfig })).status).toBe(400);
    expect((await call(req('POST', '/relay/ai', { ...body, timeoutMs: 300_001 }), { config: testConfig })).status).toBe(400);
    expect((await call(req('POST', '/relay/ai', { ...body, use: 'explain', maxOutputTokens: 100 }), { config: testConfig })).status).toBe(400);

    const { calls, service } = fakeCopilot('synthetic');
    expect((await call(req('PUT', '/relay/copilot', { model: 'gpt-5' }))).status).toBe(200);
    expect((await call(req('POST', '/relay/ai', { ...body, provider: 'copilotSdk', lang: 'en' }), { copilot: service })).status).toBe(200);
    expect(calls[0]!.system).toContain('hypotheses');
    expect(calls[0]!.system).toContain('Never invent');
    expect(calls[0]!.timeoutMs).toBe(300_000);
    await call(req('DELETE', '/relay/copilot'));
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
    expect((await call(req('POST', '/relay/ai', { ...packBody({ provider: 'copilotSdk' }), use: 'explain', maxOutputTokens: 100, timeoutMs: 1000 }), { copilot: service })).status).toBe(200);
    const st = await call(req('POST', '/relay/copilot/status', {}), { copilot: service });
    expect(st.body).toMatchObject({ authenticated: true, login: 'octocat', settings: { model: 'gpt-5' } });
    expect((await call(req('DELETE', '/relay/copilot'))).body).toEqual({ copilot: null });
  });

  it('Copilot: PDF and image attachments are passed to the service, which checks the model capability', async () => {
    const { calls, service } = fakeCopilot('{"packId":"x"}');
    expect((await call(req('PUT', '/relay/copilot', { model: 'gpt-5' }))).status).toBe(200);
    const media = [{ name: 'r.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7\n').toString('base64') }];
    expect((await call(req('POST', '/relay/ai', packBody({ provider: 'copilotSdk', media })), { copilot: service })).status).toBe(200);
    expect((calls[0] as unknown as { media: unknown }).media).toEqual(media);
    expect((await call(req('POST', '/relay/ai', packBody({ provider: 'copilotSdk', media: [{ ...media[0], mimeType: 'image/png' }] })), { copilot: service })).status).toBe(400);
    expect(calls).toHaveLength(1);
    await call(req('DELETE', '/relay/copilot'));
  });

  it('alignment proposals use the dedicated JSON instruction and C-03 gate for both providers', async () => {
    const prompt = '{"purpose":"Synthetic delivery goal","projectSources":[{"id":"source-1","facts":[]}]}';
    const body = packBody({ use: 'alignmentProposal', lang: 'en', prompt, maxOutputTokens: 3000, timeoutMs: 5000 });
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', { endpoint: stubUrl, deployment: 'gpt-test' }), { config: testConfig })).status).toBe(200);
    seen = [];
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
    const termsSeen: unknown[] = [];
    const site = (async (_u: string, _d: unknown, terms: unknown) => { used++; termsSeen.push(terms); return { pages: [], failed: [] }; }) as unknown as RelayContext['site'];
    expect((await call(req('POST', '/relay/site', { url: 'https://example.com' }, { headers: { 'x-bas-relay': 'bad' } }), { site })).status).toBe(403);
    expect((await call(req('POST', '/relay/site', { url: 'https://example.com' }), { site })).status).toBe(200);
    expect((await call(req('POST', '/relay/site', { url: 1 }), { site })).status).toBe(400);
    expect(used).toBe(1);
    // Purpose terms reach the reader cleaned (strings of 2-40 characters, lower case); they only rank the site's links.
    await call(req('POST', '/relay/site', { url: 'https://example.com', terms: ['Viva', 1, 'x', '情報共有', 'a'.repeat(41)] }), { site });
    expect(termsSeen).toEqual([[], ['viva', '情報共有']]);
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
    expect((status.body as { secrets: Record<string, boolean> }).secrets).toEqual({ foundryKey: false });
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

  it('is refused for other providers, without a ready provider, with an outbound allowlist lacking its hosts, and for free-form fields', async () => {
    const m = microsoft();
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    await signIn(m, workiq);
    m.calls.length = 0;
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, provider: 'other' }), ctx(m.doFetch, { workiq }))).body).toEqual({ error: 'providerNotAllowed' });
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, provider: 'copilotSdk' }), ctx(m.doFetch, { workiq }))).body).toEqual({ error: 'copilotNotConfigured' });
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

  it('refuses diagnostics without sign-in, for other providers, arbitrary prompts, and restricted outbound hosts', async () => {
    const m = microsoft();
    const workiq = workIqServiceFor(vault, { fetch: m.doFetch, now: () => clock });
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'foundry' }), { workiq })).body).toEqual({ error: 'notConfigured' });
    await call(req('PUT', '/relay/workiq', { tenantId: TENANT, clientId: CLIENT }), { workiq });
    expect((await call(req('POST', '/relay/workiq/verify', { provider: 'other' }), { workiq })).body).toEqual({ error: 'providerNotAllowed' });
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
    } else if (m.method === 'tools/list') {
      // The remote tools (retrieve) appear only in some CLI processes; 'restart' lacks them in the first process.
      const starts = mode === 'restart' ? (fs.existsSync(log + '.starts') ? Number(fs.readFileSync(log + '.starts', 'utf8')) : 0) + 1 : 0;
      if (mode === 'restart') fs.writeFileSync(log + '.starts', String(starts));
      const local = ['accept_eula', 'ask', 'list_agents', 'get_debug_link'];
      const remote = mode === 'askonly' || mode === 'askfail' || starts === 1 ? [] : ['retrieve'];
      send({ id: m.id, result: { tools: [...local, ...remote].map((name) => ({ name, inputSchema: { type: 'object' } })) } });
    } else if (m.method === 'tools/call') {
      fs.appendFileSync(log, JSON.stringify(m.params) + '\\n');
      if (mode === 'crash') process.exit(3);
      if (mode === 'hang') return;
      if (m.params.name === 'ask' && mode !== 'eula') {
        if (mode === 'askfail') { send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: 'Network error: the request failed.' }] } }); continue; }
        if (m.params.arguments.conversationId) {
          // The follow-up turn of a deep read that found nothing in its files (2026-11-13: it then found facts elsewhere).
          const more = 'FY27 NSAT actual 4.3 per the Oct QBR mail [QBR notes](https://contoso.sharepoint.com/qbr.docx).';
          send({ id: m.id, result: { content: [{ type: 'text', text: more }], structuredContent: { answer: more, conversationId: m.params.arguments.conversationId } } });
          continue;
        }
        if (m.params.arguments.fileUrls) {
          const read = mode === 'deepfail' ? null : mode === 'deepnone' ? '「not found」' : 'FY27 NSAT actual 4.2 in Q1 (KPI scorecard.xlsx). Owner: [Plan](https://contoso.sharepoint.com/plan.docx).';
          send({ id: m.id, result: read ? { content: [{ type: 'text', text: read }], structuredContent: { answer: read, conversationId: 'c2' } } : { isError: true, content: [{ type: 'text', text: 'Network error: the request failed.' }] } });
          continue;
        }
        const answer = 'NSAT target 4.5 (FY27) [KPI scorecard](https://contoso.sharepoint.com/kpi.xlsx). See also https://teams.microsoft.com/l/meetup-join/9 .';
        send({ id: m.id, result: { content: [{ type: 'text', text: answer }], structuredContent: { answer, conversationId: 'c1' } } });
        continue;
      }
      const q = String(m.params.arguments && m.params.arguments.query);
      tries[q] = (tries[q] || 0) + 1;
      if (mode === 'flaky' && /KPI/.test(q) && tries[q] <= 2) {
        // Work IQ's generic failure (seen after ~30 s on 4 % of the searches, 2026-11-12), twice; the third try succeeds.
        send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: "An error occurred invoking 'retrieve'." }] } });
        continue;
      }
      if (mode === 'byquery' || mode === 'deepnone') {
        // Files come only from OneDriveAndSharePoint when the search is limited to sources (as the live service does).
        const caps = m.params.arguments.capabilities;
        if (caps && !caps.some((c) => c.name === 'OneDriveAndSharePoint')) {
          send({ id: m.id, result: { content: [], structuredContent: { 'application/vnd.ms-workiq.retrieval': { results: [], resultCount: 0, stoppedReason: 'completed' } } } });
          continue;
        }
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
    expect((await call(req('POST', '/relay/workiq/eula', { provider: 'other', accept: true }), { workiqCli: cli('eula') })).body).toEqual({ error: 'providerNotAllowed' });
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
    expect(sections.map((s) => s.key)).toEqual(['org', 'locations', 'customers', 'workflow', 'dataCatalog', 'kpi', 'engagements', 'issues', 'purpose']);
    // 1 section question + its English keywords + 3 wordings × 8 items + 1 search built from the purpose, then that purpose search once per source.
    const searches = calls().filter((c) => c.name === 'retrieve');
    expect(searches).toHaveLength(31);
    expect(searches.map((c) => String(c.arguments.query))).toContain('Contoso Delivery KPI OKR targets scorecard');
    expect(searches.some((c) => String(c.arguments.query).includes('Reduce late deliveries'))).toBe(true);
    const bySource = searches.filter((c) => c.arguments.capabilities);
    expect(bySource.map((c) => c.arguments.capabilities)).toEqual([[{ name: 'OneDriveAndSharePoint' }], [{ name: 'Email' }], [{ name: 'Meetings' }], [{ name: 'TeamsMessages' }]]);
    expect(new Set(bySource.map((c) => c.arguments.query)).size).toBe(1);
    // The KPI section also gets Microsoft 365 Copilot's synthesized answer to the short question, with the project as background.
    const answers = calls().filter((c) => c.name === 'ask' && !c.arguments.fileUrls);
    expect(answers).toHaveLength(1);
    expect(String(answers[0]!.arguments.question)).toMatch(/Subject: What are the KPIs\/OKRs of Contoso Delivery\?\nBackground [\s\S]*Reduce late deliveries/);
    // Then the top files are read in full, each once (here both are the KPI item's: it found the overview in all four of its searches).
    const reads = calls().filter((c) => c.name === 'ask' && c.arguments.fileUrls);
    expect(reads.map((c) => c.arguments.fileUrls)).toEqual([['https://contoso.sharepoint.com/common.docx', 'https://contoso.sharepoint.com/kpi.xlsx']]);
    expect(String(reads[0]!.arguments.question)).toMatch(/Read only the attached files[\s\S]*KPI and OKR definitions[\s\S]*Reduce late deliveries/);
    const kpi = sections.find((s) => s.key === 'kpi')!;
    expect(kpi.answer).toMatch(/^Microsoft 365 Copilot answer \(Work IQ ask; the links behind it are in the citations\):\nNSAT target 4\.5 \(FY27\) KPI scorecard\. See[^\n]*\n\nDeep read \(facts Work IQ ask extracted from the top 2 files\):\n- Overview <https:\/\/contoso\.sharepoint\.com\/common\.docx>\n- KPI scorecard <https:\/\/contoso\.sharepoint\.com\/kpi\.xlsx>\nFY27 NSAT actual 4\.2/);
    expect((kpi as unknown as { deepRead: unknown }).deepRead).toEqual({ files: 2 });
    expect(kpi.searches).toEqual(['KPI and OKR definitions with targets and actuals', 'metrics and attainment in scorecards, QBRs and business reviews', 'fiscal-year targets, commitments and success measures']);
    expect(kpi.question.split('\n')).toHaveLength(5);
    expect(kpi.citations.map((c) => c.title).sort()).toEqual(['KPI scorecard', 'Overview', 'Plan', 'teams.microsoft.com']);
    // The overview every search returned is sent once, with the item that ranked it highest.
    const all = sections.map((s) => s.answer).join('\n');
    expect(all.split('Shared overview').length - 1).toBe(1);
    expect(all.split('NSAT target 4.5 (FY27).').length - 1).toBe(1);
    expect(sections.filter((s) => s.key !== 'kpi').every((s) => s.citations.length === 0)).toBe(true);
  });

  it('FR-341: company-wide and business-unit KPI/OKR are searched by organisation and answered as their own sections', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply })).status).toBe(200);
    // A unit search needs the unit's name; the name is checked like the other free text.
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, aspects: ['kpiUnit'], expand: true }), { workiqCli: cli('byquery') })).body).toEqual({ error: 'invalidQuestion' });

    const r = await call(req('POST', '/relay/workiq/ask', { ...question, aspects: ['kpi', 'kpiCompany', 'kpiUnit'], unit: 'Logistics Division', expand: true }), { workiqCli: cli('byquery') });
    expect(r.status).toBe(200);
    const sections = (r.body as { sections: { key: string }[] }).sections;
    expect(sections.map((s) => s.key)).toEqual(expect.arrayContaining(['kpi', 'kpiCompany', 'kpiUnit']));
    const queries = calls().filter((c) => c.name === 'retrieve').map((c) => String(c.arguments.query));
    // Searched by the organisation, not by the project: the project name narrows the search to one team's files.
    expect(queries).toContain('What are the company-wide KPIs/OKRs of Contoso?');
    expect(queries).toContain('Contoso company-wide KPI OKR targets mid-term plan');
    expect(queries).toContain('What are the KPIs/OKRs of Contoso Logistics Division?');
    expect(queries).toContain('Contoso Logistics Division division KPI OKR targets scorecard');
  });

  it('words each section as the short question a person asks Copilot, plus English keywords, and synthesizes the figure sections', () => {
    // 2026-11-19 (study §13): the long compound request kept only microsoft/innovation/hub/fy27 as search terms; this question kept kpi and okr.
    const hub: WorkIqQuestion = { company: 'Microsoft', project: 'Microsoft Innovation Hub FY27', purpose: 'Hub の価値を高める', focus: '', asOf: '2026-11-19', lang: 'ja', timeZone: 'Asia/Tokyo', aspects: ['kpi', 'org', 'process'], topics: [], expand: true };
    expect(workIqAspectQuery(hub, 'kpi')).toBe('Microsoft Innovation Hub FY27のKPI/OKRは何ですか?');
    expect(workIqAspectKeywords(hub, 'kpi')).toBe('Microsoft Innovation Hub FY27 KPI OKR targets scorecard');
    // A project that does not name the company gets it in front; no quotes or brackets.
    const other = { ...hub, company: 'Contoso', project: 'Delivery', lang: 'en' as const };
    expect(workIqAspectQuery(other, 'kpi')).toBe('What are the KPIs/OKRs of Contoso Delivery?');
    expect(workIqTopicQuery(other, 'NSAT target')).toBe('Contoso Delivery NSAT target');
    // FR-341: a unit that already names the company is not prefixed twice.
    expect(workIqAspectQuery({ ...hub, unit: 'Microsoft 日本法人 営業本部' }, 'kpiUnit')).toBe('Microsoft 日本法人 営業本部のKPI/OKRは何ですか?');
    expect(workIqAspectQuery(hub, 'kpiCompany')).toBe('Microsoftの全社のKPI/OKRは何ですか?');
    const plan = workIqPlan(hub, { sources: true, answers: true });
    expect(plan.filter((p) => p.kind === 'answer').map((p) => [p.key, p.items])).toEqual([['kpi-answer', ['kpi']], ['process-answer', ['workflow']]]);
    expect(plan.filter((p) => p.key.endsWith('-en')).map((p) => p.key)).toEqual(['kpi-en', 'org-en', 'process-en']);
    // The ask-only route (no ladder) adds neither: every search there is already an ask.
    expect(workIqPlan(hub, { ladder: false }).some((p) => p.kind === 'answer' || p.key.endsWith('-en'))).toBe(false);

    const ask = (answer: string) => askAsRetrieval({ content: [{ type: 'text', text: answer }], structuredContent: { answer } }, 'ja');
    const sec = { key: 'kpi', question: 'q', answer: 'search text', citations: [{ title: 'a', url: 'https://contoso.sharepoint.com/a.docx' }], sensitivity: null, fetchedAt: 't' };
    const out = withAnswer(sec, ask('End-to-end Platform Wins: SE 1 人あたり 5 件 [戦略](https://contoso.sharepoint.com/s.pptx) [1](https://contoso.sharepoint.com/s.pptx)'), 'ja', 't') as typeof sec;
    // The links are kept as citations, not as text: a live answer was 18,172 characters, mostly SharePoint links.
    expect(out.answer).toMatch(/^Microsoft 365 Copilot の回答[^\n]*\nEnd-to-end Platform Wins: SE 1 人あたり 5 件 戦略\n\nsearch text$/);
    expect(out.answer).not.toContain('要約回答');
    expect(out.citations.map((c) => c.url)).toEqual(['https://contoso.sharepoint.com/a.docx', 'https://contoso.sharepoint.com/s.pptx']);
    // Live answers began with a link's tail and repeated paragraphs that differed only in their citation markers.
    const messy = withAnswer(sec, ask('://aka.ms/hub/x)\n\n- 5 wins [1](https://contoso.sharepoint.com/s.pptx)\n\n- 5 wins\n\n- 20%'), 'ja', 't') as typeof sec;
    expect(messy.answer).toMatch(/^Microsoft 365 Copilot の回答[^\n]*\n- 5 wins\n\n- 20%\n\nsearch text$/);
    expect(withAnswer(sec, ask('見つからない'), 'ja', 't')).toBe(sec);
    expect(withAnswer(sec, new WorkIqError('workiqTimeout'), 'ja', 't')).toBe(sec);
    // A section whose searches all failed is kept from the answer alone.
    expect(withAnswer({ key: 'kpi', error: 'workiqTimeout' }, ask('KPI 5 件'), 'ja', 't')).toMatchObject({ key: 'kpi', answer: expect.stringContaining('KPI 5 件'), fetchedAt: 't' });
  });

  it('plans the purpose concepts: named things first, then each purpose clause and the focus, capped', () => {
    const base = { company: 'Contoso', project: 'Innovation Hub', focus: '', lang: 'ja' as const };
    const topics = purposeTopics({ ...base, purpose: 'Viva Engage の「Hubらじお」動画の視聴者が少ない。アカウントチームへの情報共有を強化したい。Contoso と Innovation Hub は対象外' });
    expect(topics.slice(0, 2)).toEqual(['Hubらじお の内容・利用状況・関係者・数値・課題', 'Viva Engage の内容・利用状況・関係者・数値・課題']);
    expect(topics).toContain('アカウントチームへの情報共有を強化したい');
    // The company and project are no named topics of their own (every search is already about them).
    expect(topics.filter((t) => t.endsWith('課題')).some((t) => /^(Contoso|Innovation Hub) /.test(t))).toBe(false);
    expect(purposeTopics({ ...base, lang: 'en', purpose: 'Reduce late deliveries. Ok.', focus: 'Kansai' })).toEqual(['Reduce late deliveries', 'focus "Kansai": initiatives, examples and figures']);
    expect(purposeTopics({ ...base, purpose: Array.from({ length: 12 }, (_, i) => `目的の文その${i}について`).join('。') })).toHaveLength(MAX_PURPOSE_SEARCHES);
  });

  it('plans deep reads of files only, purpose first, each file once, and keeps the search text when the read finds nothing or fails', () => {
    const sp = (n: string) => `https://contoso.sharepoint.com/sites/x/${n}`;
    expect([sp('a.docx'), sp(':x:/r/b'), sp('_layouts/15/Doc.aspx'), 'https://1drv.ms/w/s!abc'].every(isM365FileUrl)).toBe(true);
    // Work IQ ask answered "cannot read" for PDF and viewer.aspx files (2026-11-15), so they are left to the search text.
    expect([sp('SitePages/Home.aspx'), sp('r.pdf'), sp(':b:/r/x'), sp('_layouts/15/viewer.aspx?sourcedoc=1'), 'https://outlook.office.com/mail/id/1', 'https://teams.microsoft.com/l/meetup-join/9', 'http://contoso.sharepoint.com/a.docx', 'https://evil.com/a.docx'].some(isM365FileUrl)).toBe(false);

    const sec = (key: string, urls: string[]) => ({ key, question: 'q', answer: 'search text', citations: urls.map((url) => ({ title: url.split('/').pop()!, url })), sensitivity: null, fetchedAt: 't' });
    const plan = deepReadPlan([
      sec('kpi', [sp('k1.xlsx'), sp('shared.docx'), 'https://outlook.office.com/mail/id/1']),
      sec('purpose', [sp('shared.docx'), sp('p.pptx')]),
      sec('org', ['https://teams.microsoft.com/l/chat/1']),
      { key: 'issues', error: 'workiqTimeout' },
      sec('engagements', [sp('e1.docx')]), sec('workflow', [sp('w.docx')]), sec('customers', [sp('c.docx')]),
    ] as never);
    expect(plan).toEqual([
      { key: 'purpose', files: [sp('shared.docx'), sp('p.pptx')] },
      { key: 'kpi', files: [sp('k1.xlsx')] },
      { key: 'engagements', files: [sp('e1.docx')] },
      { key: 'workflow', files: [sp('w.docx')] },
    ]);

    const s = sec('kpi', [sp('k1.xlsx')]);
    const ask = (answer: string) => askAsRetrieval({ content: [{ type: 'text', text: answer }], structuredContent: { answer } }, 'ja');
    expect(withDeepRead(s, [sp('k1.xlsx')], ask('「見つからない」'), 'ja')).toEqual({ ...s, deepRead: { files: 1 } });
    expect(withDeepRead(s, [sp('k1.xlsx')], new WorkIqError('workiqTimeout'), 'ja')).toEqual({ ...s, deepRead: { files: 1, error: 'workiqTimeout' } });
    const read = withDeepRead(s, [sp('k1.xlsx')], ask('NSAT 4.2（k1.xlsx）'), 'ja', 200) as typeof s;
    expect(read.answer).toMatch(/^重点資料の精読（[^\n]*1 件[^\n]*\n- k1\.xlsx <[^>]+>\nNSAT 4\.2（k1\.xlsx）\n\nsearch text$/);
    expect(read.answer).not.toContain('Copilot');
    expect((withDeepRead(s, [sp('k1.xlsx')], ask('x'.repeat(5000)), 'ja', 3_000) as typeof s).answer.length).toBeLessThanOrEqual(3_000);
    expect([ask('「見つからない」'), ask('Not found.'), new WorkIqError('workiqTimeout')].map(deepReadText)).toEqual(['', '', '']);
    expect(deepReadText(ask('NSAT 4.2'))).toBe('NSAT 4.2');
    const more = withDeepRead(s, [sp('k1.xlsx')], ask('NSAT 4.3（QBR メール）'), 'ja', 200, true) as typeof s & { deepRead: unknown };
    expect(more.answer).toMatch(/^重点資料の精読（上位のファイル 1 件に無かったため、同じ会話で Microsoft 365 全体から探した事実）:\n/);
    expect(more.deepRead).toEqual({ files: 1, followUp: true });
  });

  it('reranks the sources of an item by the share of its Work IQ search terms they contain', () => {
    expect(queryTerms('FY27 の NSAT 目標とアカウントチーム')).toEqual(['fy27', 'nsat', '目標', 'アカウントチーム']);
    expect(termCoverage('NSAT target', ['nsat', 'fy27'], () => 1)).toBe(0.5);
    expect(termCoverage('NSAT target', ['nsat', 'fy27'], (t) => (t === 'nsat' ? 3 : 1))).toBe(0.75);
    const found = (title: string, markdown: string, terms?: string[]) => ({ content: [], structuredContent: { 'application/vnd.ms-workiq.retrieval': {
      results: [{ markdown, webUrl: `https://contoso.sharepoint.com/${title}`, entityType: 'Files', resourceMetadata: { document: { title } } }],
      ...(terms ? { searchMetadata: { searchTerms: terms } } : {}), stoppedReason: 'completed' } } });
    // Each source is first in its own search (an RRF tie, as when mail and files are searched apart); the one with the terms wins.
    const [kpi] = mergeByItem([{ key: 'kpi', queries: ['q1', 'q2'], wordings: [], results: [found('a.docx', 'Team offsite agenda.', ['NSAT']), found('b.docx', 'NSAT 4.2 in Q1.')] }], 't');
    expect((kpi as { citations: { title: string }[] }).citations.map((c) => c.title)).toEqual(['b.docx', 'a.docx']);
    // Without searchTerms the item's own query words are used.
    const [org] = mergeByItem([{ key: 'org', queries: ['org chart'], wordings: [], results: [found('x.docx', 'Lunch menu.'), found('y.docx', 'The org chart of sales.')] }], 't');
    expect((org as { citations: { title: string }[] }).citations.map((c) => c.title)).toEqual(['y.docx', 'x.docx']);
  });

  it('adapts the searches in flight: up after fast successes, halved after a failure, within its bounds', async () => {
    const lim = new AdaptiveLimit(4, 2, 6, 15_000);
    for (let n = 0; n < 4; n++) lim.record(true, 9_000);
    expect(lim.limit).toBe(5);
    lim.record(true, 20_000);
    for (let n = 0; n < 4; n++) lim.record(true, 9_000);
    expect(lim.limit).toBe(5);
    for (let n = 0; n < 5 + 6; n++) lim.record(true, 9_000);
    expect(lim.limit).toBe(6);
    for (let n = 0; n < 6; n++) lim.record(true, 9_000);
    expect(lim.limit).toBe(6);
    lim.record(false, 30_000);
    expect(lim.limit).toBe(3);
    lim.record(false, 30_000);
    expect(lim.limit).toBe(2);

    const pool = new AdaptiveLimit(3, 1, 6);
    let running = 0;
    let peak = 0;
    const out = await inAdaptivePool([1, 2, 3, 4, 5, 6, 7], pool, async (x, i) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      if (i === 0) pool.record(false, 0);
      running--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
    expect(pool.limit).toBe(1);
  });

  it('asks again in the same conversation, over all of Microsoft 365, when the top files do not answer', async () => {
    const q: WorkIqQuestion = { company: 'Contoso', project: 'Delivery', purpose: 'Reduce late deliveries', focus: '', asOf: '2026-11-11', lang: 'en', timeZone: 'Asia/Tokyo', aspects: ['kpi'], topics: [], expand: true };
    const svc = cli('deepnone');
    try {
      const sections = await svc.askSections(q);
      const asks = calls().filter((c) => c.name === 'ask' && (c.arguments.fileUrls || c.arguments.conversationId));
      expect(asks.map((c) => Object.keys(c.arguments).sort())).toEqual([['fileUrls', 'question'], ['conversationId', 'question']]);
      expect(asks[1]!.arguments.conversationId).toBe('c2');
      expect(String(asks[1]!.arguments.question)).toMatch(/other Microsoft 365 information/);
      const kpi = sections.find((s) => s.key === 'kpi') as { answer: string; citations: { url: string }[]; deepRead: unknown };
      expect(kpi.answer).toMatch(/\n\nDeep read \(not in the top 2 files, so asked again over all of Microsoft 365 in the same conversation\):\n[\s\S]*FY27 NSAT actual 4\.3/);
      expect(kpi.deepRead).toEqual({ files: 2, followUp: true });
      expect(kpi.citations.map((c) => c.url)).toContain('https://contoso.sharepoint.com/qbr.docx');
    } finally {
      svc.closeSession();
    }
  });

  it('restarts a CLI process that lacks retrieve, and searches through ask when no process offers it', async () => {
    const q: WorkIqQuestion = { company: 'Contoso', project: 'Delivery', purpose: 'Reduce late deliveries', focus: '', asOf: '2026-11-11', lang: 'en', timeZone: 'Asia/Tokyo', aspects: ['kpi'], topics: [], expand: true };
    const restarted = cli('restart');
    try {
      await restarted.askSections(q);
      expect(Number(readFileSync(`${log}.starts`, 'utf8'))).toBe(2);
      // Searches go through retrieve; ask is used only for the KPI section's synthesized answer and the deep read.
      expect(calls().filter((c) => c.name === 'ask' && !c.arguments.fileUrls).map((c) => String(c.arguments.question))).toEqual([expect.stringMatching(/Subject: What are the KPIs\/OKRs of Contoso Delivery\?/)]);
      expect(calls().some((c) => c.name === 'retrieve')).toBe(true);
    } finally {
      restarted.closeSession();
    }

    rmSync(log, { force: true });
    const askOnly = cli('askonly');
    try {
      const sections = await askOnly.askSections(q);
      // Without retrieve: no ladder wordings (one ask per section search and purpose concept), each a Copilot summary with its links,
      // read with the project purpose and date as background; then the top file is read in full.
      expect(calls().map((c) => c.name)).toEqual(['ask', 'ask', 'ask']);
      expect(String(calls()[0]!.arguments.question)).toMatch(/Microsoft 365[\s\S]*Subject: [\s\S]*\nBackground [\s\S]*purpose: Reduce late deliveries\. As of 2026-11-11/);
      expect(calls()[2]!.arguments.fileUrls).toEqual(['https://contoso.sharepoint.com/kpi.xlsx']);
      const kpi = sections.find((s) => s.key === 'kpi') as { answer: string; citations: { title: string; url: string }[] };
      expect(kpi.answer).toMatch(/^Deep read[\s\S]*FY27 NSAT actual 4\.2[\s\S]*Microsoft 365 Copilot summary/);
      expect(kpi.citations.map((c) => c.url).sort()).toEqual(['https://contoso.sharepoint.com/kpi.xlsx', 'https://contoso.sharepoint.com/plan.docx', 'https://teams.microsoft.com/l/meetup-join/9']);
      expect(kpi.citations.find((c) => c.url.endsWith('kpi.xlsx'))?.title).toBe('KPI scorecard');
      expect(sections.map((s) => s.key)).toContain('purpose');
    } finally {
      askOnly.closeSession();
    }

    rmSync(log, { force: true });
    const failing = cli('askfail');
    await expect(failing.askSections(q)).rejects.toBeInstanceOf(WorkIqError);
    failing.closeSession();
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

  it('retrieves customer evidence with citations and labels for a Foundry pack; Copilot needs its own saved model', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    expect((await call(req('POST', '/relay/workiq/ask', question), { workiqCli: cli('ok') })).body).toEqual({ error: 'foundryNotConfigured' });
    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', conn), { fetch: verifiedReply })).status).toBe(200);
    // A verified Foundry connection does not make Copilot ready: Work IQ material goes only to the provider the user set up.
    expect((await call(req('POST', '/relay/workiq/ask', { ...question, provider: 'copilotSdk' }), { workiqCli: cli('ok') })).body).toEqual({ error: 'copilotNotConfigured' });
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

  it('retrieves for a GitHub Copilot pack once a Copilot model is saved, unless the outbound list lacks the Copilot hosts', async () => {
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    await call(req('PUT', '/relay/copilot', { model: 'gpt-5' }));
    const copilot = { ...question, provider: 'copilotSdk' };
    const noCopilotHosts: RelayConfig = { ...STRICT_RELAY_CONFIG, outboundHosts: ['res.openai.azure.com', ...WORKIQ_OUTBOUND_HOSTS] };
    expect((await call(req('POST', '/relay/workiq/ask', copilot), { workiqCli: cli('ok'), config: noCopilotHosts })).body).toEqual({ error: 'outboundNotAllowed' });
    expect(calls()).toEqual([]);
    const r = await call(req('POST', '/relay/workiq/ask', copilot), { workiqCli: cli('ok') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answer: 'Contoso: on-time delivery 92% in FY26 [^h1].', sensitivity: 'Confidential, General' });
    expect(calls().map((c) => c.name)).toEqual(['retrieve']);
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

describe('Microsoft Entra ID for Microsoft Foundry', () => {
  const TENANT = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
  const OTHER = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const OID = '11111111-2222-3333-4444-555555555555';
  const SUB = 'd8352616-ed51-492b-929b-5e266d38aedd';
  const RES = `/subscriptions/${SUB}/resourceGroups/rg-bas/providers/Microsoft.CognitiveServices/accounts/bas-foundry`;
  const testConfig: RelayConfig = { ...STRICT_RELAY_CONFIG, testOutbound: true };
  let clock = 5_000_000;
  let account: { username: string; tenantId: string } | null;
  let tokenCalls: { scope: string; tenantId?: string }[];
  let refuseTenant: string | null;
  const entra: EntraTokens = {
    account: () => account,
    startSignIn: async () => ({ url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1' }),
    signInState: () => ({ status: account ? 'signedIn' : 'idle' }),
    signOut: async () => { account = null; },
    token: async (scope, tenantId) => {
      if (!account) throw new EntraError('notSignedIn');
      if (tenantId && tenantId === refuseTenant) throw new EntraError('interactionRequired');
      tokenCalls.push({ scope, tenantId });
      return { token: `entra-token-${scope.includes('cognitive') ? 'foundry' : 'arm'}`, objectId: OID, tenantId: tenantId ?? account.tenantId };
    },
  };
  const ctx = (extra: Partial<RelayContext> = {}): Partial<RelayContext> => ({ config: testConfig, now: () => (clock += 10_000), entra, ...extra });

  beforeEach(() => {
    account = { username: 'user@contoso.example', tenantId: TENANT };
    tokenCalls = [];
    refuseTenant = null;
  });

  it('tests and sends with a Microsoft Entra token (no API key), binds the check to the account, and drops it on sign-out', async () => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return verifiedReply(url, init);
    };
    const conn = { endpoint: 'https://bas-foundry.openai.azure.com/openai/v1', deployment: 'model-router', auth: 'entraId', tenantId: TENANT };
    account = null;
    expect(await call(req('PUT', '/relay/connection', conn), ctx({ fetch }))).toEqual({ status: 400, body: { error: 'notSignedIn' } });
    expect(sent).toHaveLength(0);
    account = { username: 'user@contoso.example', tenantId: TENANT };
    expect(await call(req('PUT', '/relay/connection', { ...conn, tenantId: 'not-a-tenant' }), ctx({ fetch }))).toEqual({ status: 400, body: { error: 'invalidTenant' } });

    const saved = await call(req('PUT', '/relay/connection', conn), ctx({ fetch }));
    expect(saved.status).toBe(200);
    expect(vault.get('foundryKey')).toBeUndefined();
    expect(sent[0]!.url).toBe('https://bas-foundry.openai.azure.com/openai/v1/chat/completions');
    expect(sent[0]!.headers).toMatchObject({ Authorization: 'Bearer entra-token-foundry' });
    expect(sent[0]!.headers).not.toHaveProperty('api-key');
    expect(tokenCalls).toContainEqual({ scope: 'https://cognitiveservices.azure.com/.default', tenantId: TENANT });
    expect((await call(req('GET', '/relay/status'), ctx())).body).toMatchObject({
      configured: true, connection: { auth: 'entraId', tenantId: TENANT, deployment: 'model-router' }, entra: { signedIn: true, account: 'user@contoso.example' },
    });

    const ai = await call(req('POST', '/relay/ai', { use: 'explain', lang: 'en', prompt: 'Synthetic test.', maxOutputTokens: 100, timeoutMs: 1000 }), ctx({ fetch }));
    expect(ai.status).toBe(200);
    expect(sent[1]!.headers).toMatchObject({ Authorization: 'Bearer entra-token-foundry' });
    for (const a of answers) expect(JSON.stringify(a.body)).not.toContain('entra-token');

    // Another account in the same relay never inherits the check.
    account = { username: 'someone-else@contoso.example', tenantId: TENANT };
    expect((await call(req('GET', '/relay/status'), ctx())).body).toMatchObject({ configured: false, connectionVerifiedAt: null });
    account = { username: 'user@contoso.example', tenantId: TENANT };
    // Editing the saved tenant breaks the seal.
    const path = join(vault.dir, 'connection.json');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace(TENANT, OTHER));
    expect((await call(req('GET', '/relay/status'), ctx())).body).toMatchObject({ configured: false });
    writeFileSync(path, original);
    expect((await call(req('GET', '/relay/status'), ctx())).body).toMatchObject({ configured: true });

    expect((await call(req('DELETE', '/relay/entra'), ctx())).status).toBe(200);
    expect(vault.get('foundryEntraKey')).toBeUndefined();
    expect((await call(req('GET', '/relay/status'), ctx())).body).toMatchObject({ configured: false, entra: { signedIn: false } });
    expect((await call(req('POST', '/relay/ai', { use: 'explain', lang: 'en', prompt: 'x', maxOutputTokens: 100, timeoutMs: 1000 }), ctx({ fetch }))).body)
      .toEqual({ allowed: false, reasons: ['notConfigured'] });
  });

  it('lists the Foundry resources the account can read in every tenant, marking tenants that need another sign-in', async () => {
    refuseTenant = OTHER;
    const graph: { tenantId?: string; query: string }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const u = String(url);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer entra-token-arm' });
      if (u.startsWith('https://management.azure.com/tenants')) {
        return new Response(JSON.stringify({ value: [{ tenantId: TENANT, displayName: 'Contoso' }, { tenantId: OTHER, displayName: 'Fabrikam' }] }));
      }
      if (u.startsWith('https://management.azure.com/providers/Microsoft.ResourceGraph/resources')) {
        graph.push({ query: String(JSON.parse(String(init?.body)).query) });
        return new Response(JSON.stringify({ data: [
          { id: RES, name: 'bas-foundry', kind: 'AIServices', location: 'eastus2', resourceGroup: 'rg-bas', subscriptionId: SUB, subscriptionName: 'BAS', tenantId: TENANT, customSubDomain: 'bas-foundry', disableLocalAuth: true },
          { id: RES.replace('bas-foundry', 'legacy'), name: 'legacy', kind: 'OpenAI', location: 'japaneast', resourceGroup: 'rg-bas', subscriptionId: SUB, subscriptionName: 'BAS', tenantId: TENANT, customSubDomain: '' },
          { id: RES.replace('bas-foundry', 'no-subdomain'), name: 'no-subdomain', kind: 'aiservices', location: 'japaneast', resourceGroup: 'rg-bas', subscriptionId: SUB, subscriptionName: 'BAS', tenantId: TENANT, customSubDomain: '' },
        ] }));
      }
      return new Response('{}', { status: 404 });
    });
    const r = await call(req('POST', '/relay/entra/instances', {}), ctx({ fetch }));
    expect(r.status).toBe(200);
    const body = r.body as { instances: { name: string; endpoint: string | null; keyAuthDisabled: boolean; tenantId: string }[]; tenants: { tenantId: string; signedIn: boolean }[] };
    expect(body.instances).toEqual([
      expect.objectContaining({ name: 'bas-foundry', endpoint: 'https://bas-foundry.openai.azure.com/openai/v1', keyAuthDisabled: true, tenantId: TENANT }),
      expect.objectContaining({ name: 'no-subdomain', endpoint: null }),
    ]);
    expect(body.tenants).toEqual([{ tenantId: TENANT, name: 'Contoso', signedIn: true }, { tenantId: OTHER, name: 'Fabrikam', signedIn: false }]);
    expect(graph).toHaveLength(1);
    expect(graph[0]!.query).toContain("microsoft.cognitiveservices/accounts");
    expect(graph[0]!.query).toContain("kind =~ 'AIServices'");
  });

  it('lists all directory pages and reads resources using only the selected tenant token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const u = String(url);
      if (u.includes('/tenants?') && !u.includes('page=2')) {
        return new Response(JSON.stringify({ value: [{ tenantId: TENANT, displayName: 'Home' }],
          nextLink: 'https://management.azure.com/tenants?api-version=2022-12-01&page=2' }));
      }
      if (u.includes('/tenants?')) return new Response(JSON.stringify({ value: [{ tenantId: OTHER, displayName: 'Guest' }] }));
      const body = JSON.parse(String(init?.body)) as { options: { $skipToken?: string } };
      return new Response(JSON.stringify(body.options.$skipToken
        ? { data: [{ id: RES.replace('bas-foundry', 'second'), name: 'second', kind: 'AIServices', tenantId: OTHER, customSubDomain: 'second' }] }
        : { data: [{ id: RES, name: 'first', kind: 'AIServices', tenantId: OTHER, customSubDomain: 'first' }], $skipToken: 'next', resultTruncated: 'true' }));
    });
    const directories = await call(req('POST', '/relay/entra/tenants', {}), ctx({ fetch }));
    expect(directories.body).toMatchObject({ tenants: [{ tenantId: TENANT, name: 'Home' }, { tenantId: OTHER, name: 'Guest' }] });
    tokenCalls = [];
    const result = await call(req('POST', '/relay/entra/instances', { tenantId: OTHER }), ctx({ fetch }));
    expect(result.body).toMatchObject({ instances: [{ name: 'first', tenantId: OTHER }, { name: 'second', tenantId: OTHER }] });
    expect(tokenCalls).toEqual([{ scope: 'https://management.azure.com/.default', tenantId: OTHER }, { scope: 'https://management.azure.com/.default', tenantId: OTHER }]);
  });

  it('reports selected-tenant failures rather than showing an empty list', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 403 }));
    expect(await call(req('POST', '/relay/entra/instances', { tenantId: OTHER }), ctx({ fetch }))).toEqual({ status: 403, body: { error: 'armForbidden' } });
    refuseTenant = OTHER;
    expect(await call(req('POST', '/relay/entra/instances', { tenantId: OTHER }), ctx({ fetch }))).toMatchObject({ body: { error: 'interactionRequired' } });
    expect(await call(req('POST', '/relay/entra/instances', { tenantId: 'invalid' }), ctx({ fetch }))).toEqual({ status: 400, body: { error: 'invalidTenant' } });
    refuseTenant = null;
    const truncated = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [], resultTruncated: 'true' })));
    expect(await call(req('POST', '/relay/entra/instances', { tenantId: OTHER }), ctx({ fetch: truncated }))).toMatchObject({ body: { error: 'armError' } });
    const wrongTenant: EntraTokens = { ...entra, token: async () => ({ token: 'wrong', objectId: OID, tenantId: TENANT }) };
    const notCalled = vi.fn<typeof globalThis.fetch>();
    expect(await call(req('POST', '/relay/entra/instances', { tenantId: OTHER }), ctx({ fetch: notCalled, entra: wrongTenant }))).toMatchObject({ body: { error: 'authFailed' } });
    expect(notCalled).not.toHaveBeenCalled();
  });

  it('does not follow tenant pagination links to an untrusted host', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ value: [], nextLink: 'https://evil.example/tenants?page=2' })));
    expect(await call(req('POST', '/relay/entra/tenants', {}), ctx({ fetch }))).toMatchObject({ body: { error: 'armError' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports chat deployments and data-plane access, and assigns the OpenAI User role only on request', async () => {
    let assigned = false;
    const puts: { url: string; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (init?.method === 'PUT') {
        puts.push({ url: u, body: JSON.parse(String(init.body)) });
        assigned = true;
        return new Response('{}', { status: 201 });
      }
      if (u.includes('/deployments?')) {
        return new Response(JSON.stringify({ value: [
          { name: 'model-router', sku: { name: 'GlobalStandard' }, properties: { provisioningState: 'Succeeded', model: { name: 'model-router', version: '2025-11-18' }, capabilities: { chatCompletion: 'true' } } },
          { name: 'embed', sku: { name: 'Standard' }, properties: { provisioningState: 'Succeeded', model: { name: 'text-embedding-3-small' }, capabilities: { embeddings: 'true' } } },
          { name: 'creating', sku: { name: 'Standard' }, properties: { provisioningState: 'Creating', model: { name: 'gpt-5' } } },
        ] }));
      }
      if (u.includes('/permissions?')) {
        return new Response(JSON.stringify({ value: assigned
          ? [{ actions: ['*'], notActions: [] }, { dataActions: ['Microsoft.CognitiveServices/accounts/OpenAI/*'], notDataActions: [] }]
          : [{ actions: ['*'], notActions: [], dataActions: [], notDataActions: [] }] }));
      }
      return new Response('{}', { status: 404 });
    };
    const inspect = await call(req('POST', '/relay/entra/inspect', { resourceId: RES, tenantId: TENANT }), ctx({ fetch }));
    expect(inspect).toEqual({ status: 200, body: {
      deployments: [{ name: 'model-router', model: 'model-router', version: '2025-11-18', sku: 'GlobalStandard' }],
      access: { canCall: false, canAssign: true },
    } });
    expect(puts).toHaveLength(0);
    const role = await call(req('POST', '/relay/entra/role', { resourceId: RES, tenantId: TENANT }), ctx({ fetch }));
    expect(role.body).toMatchObject({ access: { canCall: true } });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toMatch(new RegExp(`^https://management\\.azure\\.com${RES.replace(/[.]/g, '\\.')}/providers/Microsoft\\.Authorization/roleAssignments/[0-9a-f-]{36}\\?`));
    expect(puts[0]!.body).toEqual({ properties: {
      roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`, principalId: OID, principalType: 'User',
    } });
  });

  it('refuses malformed resource IDs, signed-out calls and an allowlist without Entra hosts before contacting Azure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const resourceId of [`${RES}/../../other`, '/subscriptions/x/resourceGroups/a/providers/Microsoft.Storage/storageAccounts/b', 'https://evil.example']) {
      expect(await call(req('POST', '/relay/entra/inspect', { resourceId, tenantId: TENANT }), ctx({ fetch }))).toEqual({ status: 400, body: { error: 'invalidResource' } });
    }
    account = null;
    expect(await call(req('POST', '/relay/entra/instances', {}), ctx({ fetch }))).toEqual({ status: 401, body: { error: 'notSignedIn' } });
    account = { username: 'user@contoso.example', tenantId: TENANT };
    expect(await call(req('POST', '/relay/entra/instances', {}), ctx({ fetch, config: { ...testConfig, outboundHosts: ['bas-foundry.openai.azure.com'] } })))
      .toEqual({ status: 403, body: { error: 'outboundNotAllowed' } });
    expect(await call(req('POST', '/relay/entra/signin', { tenantId: 'bad' }), ctx({ fetch }))).toEqual({ status: 400, body: { error: 'invalidTenant' } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('FR-328 Azure AI Speech and Azure AI Vision through the Microsoft Foundry connection', () => {
  const TENANT = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
  const OID = '11111111-2222-3333-4444-555555555555';
  const SUB = 'd8352616-ed51-492b-929b-5e266d38aedd';
  const RES = `/subscriptions/${SUB}/resourceGroups/rg-bas/providers/Microsoft.CognitiveServices/accounts/bas-foundry`;
  const FOUNDRY = 'https://bas-foundry.openai.azure.com/openai/v1';
  const MEDIA_HOST = 'https://bas-foundry.cognitiveservices.azure.com';
  const testConfig: RelayConfig = { ...STRICT_RELAY_CONFIG, testOutbound: true };
  let clock = 9_000_000;
  let account: { username: string; tenantId: string } | null;
  const entra: EntraTokens = {
    account: () => account,
    startSignIn: async () => ({ url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1' }),
    signInState: () => ({ status: account ? 'signedIn' : 'idle' }),
    signOut: async () => { account = null; },
    token: async (scope, tenantId) => {
      if (!account) throw new EntraError('notSignedIn');
      return { token: `entra-token-${scope.includes('cognitive') ? 'data' : 'arm'}`, objectId: OID, tenantId: tenantId ?? account.tenantId };
    },
  };
  const ctx = (extra: Partial<RelayContext> = {}): Partial<RelayContext> => ({ config: testConfig, now: () => (clock += 10_000), entra, ...extra });
  type Sent = { url: string; method?: string; headers: Record<string, string>; body?: unknown };
  const recorder = (reply: () => Response) => {
    const sent: Sent[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body });
      return reply();
    };
    return { sent, fetch };
  };
  type Media = { endpoint: string | null; auth: string | null; unavailable: string | null; speech: string | null; vision: string | null };
  const status = async () => ((await call(req('GET', '/relay/status'), ctx())).body as { media: Media }).media;
  const connect = async (auth: 'apiKey' | 'entraId', endpoint = FOUNDRY) => {
    const body = { endpoint, deployment: 'model-router', ...(auth === 'entraId' ? { auth, tenantId: TENANT } : {}) };
    expect((await call(req('PUT', '/relay/connection', body), ctx({ fetch: verifiedReply }))).status).toBe(200);
  };
  const test = (service: string, extra: Partial<RelayContext> = {}, body: unknown = {}) => call(req('PUT', `/relay/media/${service}`, body), ctx(extra));

  beforeEach(() => { account = { username: 'user@contoso.example', tenantId: TENANT }; });
  afterEach(() => { for (const a of answers) expect(JSON.stringify(a.body)).not.toMatch(/FAKE|entra-token/); });

  it('derives the Speech / Vision host from the Foundry resource and has nothing of its own to save', async () => {
    expect(foundryMediaEndpoint('https://bas-foundry.openai.azure.com/openai/v1')).toBe(MEDIA_HOST);
    expect(foundryMediaEndpoint('https://BAS-Foundry.services.ai.azure.com/api/projects/p')).toBe(MEDIA_HOST);
    expect(foundryMediaEndpoint('https://bas-foundry.cognitiveservices.azure.com/openai/deployments/x')).toBe(MEDIA_HOST);
    for (const other of ['http://bas-foundry.openai.azure.com', 'https://bas-apim.azure-api.net/openai', 'https://127.0.0.1:9/openai/v1', 'https://evil.example/openai.azure.com', 'https://a.b.openai.azure.com']) {
      expect(foundryMediaEndpoint(other), other).toBeNull();
    }

    expect(await status()).toEqual({ endpoint: null, auth: null, unavailable: 'noConnection', speech: null, vision: null });
    expect(await test('speech')).toEqual({ status: 400, body: { error: 'noConnection' } });
    expect((await call(req('PUT', '/relay/secrets/speechKey', { value: 'speech-FAKE-KEY-0123456789' }))).status).toBe(404);
    vault.set('foundryKey', FAKE_KEY);
    writeFileSync(join(vault.dir, 'connection.json'), JSON.stringify({ endpoint: 'https://bas-apim.azure-api.net/openai/v1', deployment: 'd', apiVersion: '2024-10-21' }));
    expect(await status()).toMatchObject({ endpoint: null, unavailable: 'unsupportedHost' });
    expect(await test('vision')).toEqual({ status: 400, body: { error: 'unsupportedHost' } });
  });

  it('tests Speech with the Foundry API key, stores only a sealed check, and drops it when the key or the Foundry resource changes', async () => {
    vault.set('foundryKey', FAKE_KEY);
    await connect('apiKey');
    expect(await status()).toEqual({ endpoint: MEDIA_HOST, auth: 'apiKey', unavailable: null, speech: null, vision: null });
    const failing = recorder(() => new Response('{}', { status: 401 }));
    expect(await test('speech', { fetch: failing.fetch })).toEqual({ status: 502, body: { error: 'unauthorized', providerStatus: 401 } });
    expect((await status()).speech).toBeNull();

    const ok = recorder(() => new Response('[]'));
    const saved = await test('speech', { fetch: ok.fetch });
    expect(saved).toMatchObject({ status: 200, body: { endpoint: MEDIA_HOST, auth: 'apiKey', verifiedAt: expect.any(String) } });
    expect(ok.sent).toEqual([expect.objectContaining({ url: `${MEDIA_HOST}/tts/cognitiveservices/voices/list`, method: 'GET', headers: { 'Ocp-Apim-Subscription-Key': FAKE_KEY } })]);
    expect(readFileSync(join(vault.dir, 'media.json'), 'utf8')).not.toContain(FAKE_KEY);
    expect(await status()).toMatchObject({ speech: (saved.body as { verifiedAt: string }).verifiedAt, vision: null });

    vault.set('foundryKey', `${FAKE_KEY}-replaced`);
    expect((await status()).speech).toBeNull();
    vault.set('foundryKey', FAKE_KEY);
    expect((await status()).speech).toEqual(expect.any(String));
    const path = join(vault.dir, 'connection.json');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('bas-foundry', 'other-foundry'));
    expect(await status()).toMatchObject({ endpoint: 'https://other-foundry.cognitiveservices.azure.com', speech: null });
    writeFileSync(path, original);
    expect(await call(req('DELETE', '/relay/media/speech'), ctx())).toEqual({ status: 200, body: { verifiedAt: null } });
    expect((await status()).speech).toBeNull();
  });

  it('tests Speech and Vision with the Foundry Microsoft Entra sign-in on the custom subdomain and binds the check to the account', async () => {
    await connect('entraId');
    account = null;
    expect(await test('speech')).toEqual({ status: 400, body: { error: 'notSignedIn' } });
    account = { username: 'user@contoso.example', tenantId: TENANT };
    const speech = recorder(() => new Response('[]'));
    expect((await test('speech', { fetch: speech.fetch })).status).toBe(200);
    expect(speech.sent[0]).toMatchObject({ url: `${MEDIA_HOST}/tts/cognitiveservices/voices/list`, headers: { Authorization: 'Bearer entra-token-data' } });
    expect(speech.sent[0]!.headers).not.toHaveProperty('Ocp-Apim-Subscription-Key');

    const vision = recorder(() => new Response(JSON.stringify({ modelVersion: '2023-10-01', metadata: { width: 64, height: 64 } })));
    expect((await test('vision', { fetch: vision.fetch })).status).toBe(200);
    expect(vision.sent[0]).toMatchObject({
      url: `${MEDIA_HOST}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`,
      method: 'POST', headers: { Authorization: 'Bearer entra-token-data', 'Content-Type': 'application/octet-stream' },
    });
    expect(Buffer.from(vision.sent[0]!.body as Uint8Array).equals(blankTestImage())).toBe(true);
    expect(await status()).toMatchObject({ auth: 'entraId', speech: expect.any(String), vision: expect.any(String) });

    account = { username: 'someone-else@contoso.example', tenantId: TENANT };
    expect(await status()).toMatchObject({ speech: null, vision: null });
    account = { username: 'user@contoso.example', tenantId: TENANT };
    expect((await call(req('DELETE', '/relay/entra'), ctx())).status).toBe(200);
    account = { username: 'user@contoso.example', tenantId: TENANT };
    expect((await status()).vision).toBeNull();
  });

  it('checks and grants the service role on the connected Foundry resource found by its subdomain (Entra ID only)', async () => {
    const graph: string[] = [];
    const roles: string[] = [];
    let assigned = false;
    let rows = [{ id: RES, name: 'bas-foundry', kind: 'AIServices', location: 'japaneast', tenantId: TENANT, customSubDomain: 'bas-foundry' }];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('ResourceGraph')) {
        graph.push(String(JSON.parse(String(init?.body)).query));
        return new Response(JSON.stringify({ data: rows }));
      }
      if (init?.method === 'PUT') {
        roles.push((JSON.parse(String(init.body)) as { properties: { roleDefinitionId: string } }).properties.roleDefinitionId);
        assigned = true;
        return new Response('{}', { status: 201 });
      }
      if (u.includes('/permissions?')) {
        return new Response(JSON.stringify({ value: [{ actions: ['*'], notActions: [], dataActions: assigned ? ['Microsoft.CognitiveServices/accounts/SpeechServices/*'] : [], notDataActions: [] }] }));
      }
      return new Response('{}', { status: 404 });
    };
    vault.set('foundryKey', FAKE_KEY);
    await connect('apiKey');
    expect(await call(req('POST', '/relay/media/speech/access', {}), ctx({ fetch }))).toEqual({ status: 400, body: { error: 'notEntra' } });

    await connect('entraId');
    const checked = await call(req('POST', '/relay/media/speech/access', {}), ctx({ fetch }));
    expect(checked).toEqual({ status: 200, body: { resource: { id: RES, name: 'bas-foundry', kind: 'AIServices' }, access: { canCall: false, canAssign: true } } });
    expect(graph[0]).toContain("kind =~ 'AIServices'");
    const role = await call(req('POST', '/relay/media/speech/role', {}), ctx({ fetch }));
    expect(role.body).toMatchObject({ access: { canCall: true } });
    expect(roles).toEqual([`/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/f2dc8367-1007-4938-bd23-fe263f013447`]);
    await call(req('POST', '/relay/media/vision/role', {}), ctx({ fetch }));
    expect(roles[1]).toBe(`/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/a97b65f3-24c7-4388-baec-2e87135dc908`);

    rows = [{ ...rows[0]!, customSubDomain: 'someone-else' }];
    expect(await call(req('POST', '/relay/media/speech/access', {}), ctx({ fetch }))).toEqual({ status: 404, body: { error: 'resourceNotFound' } });
    expect(await call(req('GET', '/relay/media/speech/access'), ctx({ fetch }))).toEqual({ status: 405, body: { error: 'methodNotAllowed' } });
  });

  it('refuses a disallowed outbound host, a non-empty body and repeated tests within five seconds', async () => {
    vault.set('foundryKey', FAKE_KEY);
    await connect('apiKey');
    const ok = recorder(() => new Response('[]'));
    expect(await test('speech', { fetch: ok.fetch, config: { ...testConfig, outboundHosts: ['bas-foundry.openai.azure.com'] } })).toEqual({ status: 400, body: { error: 'hostNotAllowed' } });
    expect(await test('speech', {}, { endpoint: 'https://evil.example' })).toEqual({ status: 400, body: { error: 'invalidBody' } });
    expect(await test('audio')).toEqual({ status: 404, body: { error: 'notFound' } });
    const lastCall = new Map<string, number>();
    const fixed = { now: () => clock, lastCall };
    expect((await test('speech', { fetch: ok.fetch, ...fixed })).status).toBe(200);
    expect(await test('speech', { fetch: ok.fetch, ...fixed })).toEqual({ status: 429, body: { error: 'tooSoon' } });
    expect((await test('vision', { fetch: recorder(() => new Response(JSON.stringify({ modelVersion: 'x', metadata: {} }))).fetch, ...fixed })).status).toBe(200);
    expect(ok.sent).toHaveLength(1);
  });
});
describe('FR-329 Speech on a separate Azure AI Speech resource, offered once Speech on Foundry is verified', () => {
  const TENANT = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
  const FOUNDRY = 'https://bas-foundry.openai.azure.com/openai/v1';
  const SEPARATE_KEY = 'speech-FAKE-SEPARATE-KEY-0123456789';
  const SEPARATE_HOST = 'https://bas-speech.cognitiveservices.azure.com';
  const testConfig: RelayConfig = { ...STRICT_RELAY_CONFIG, testOutbound: true };
  let clock = 19_000_000;
  let account: { username: string; tenantId: string } | null;
  const entra: EntraTokens = {
    account: () => account,
    startSignIn: async () => ({ url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1' }),
    signInState: () => ({ status: account ? 'signedIn' : 'idle' }),
    signOut: async () => { account = null; },
    token: async (_scope, tenantId) => {
      if (!account) throw new EntraError('notSignedIn');
      return { token: 'entra-token-data', objectId: 'oid', tenantId: tenantId ?? account.tenantId };
    },
  };
  const ctx = (extra: Partial<RelayContext> = {}): Partial<RelayContext> => ({ config: testConfig, now: () => (clock += 10_000), entra, ...extra });
  type Sent = { url: string; headers: Record<string, string> };
  const recorder = (reply: () => Response) => {
    const sent: Sent[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return reply();
    };
    return { sent, fetch };
  };
  type SpeechConnection = { route: string; eligible: boolean; separate: { auth: string; endpoint: string | null; region: string | null; verifiedAt: string | null } | null };
  const status = async () => ((await call(req('GET', '/relay/status'), ctx())).body as { speechConnection: SpeechConnection }).speechConnection;
  const verifyFoundrySpeech = async (auth: 'apiKey' | 'entraId') => {
    if (auth === 'apiKey') vault.set('foundryKey', FAKE_KEY);
    const body = { endpoint: FOUNDRY, deployment: 'model-router', ...(auth === 'entraId' ? { auth, tenantId: TENANT } : {}) };
    expect((await call(req('PUT', '/relay/connection', body), ctx({ fetch: verifiedReply }))).status).toBe(200);
    expect((await call(req('PUT', '/relay/media/speech', {}), ctx({ fetch: recorder(() => new Response('[]')).fetch }))).status).toBe(200);
  };
  const separate = (body: unknown, extra: Partial<RelayContext> = {}) => call(req('PUT', '/relay/speech/separate', body), ctx(extra));
  const route = (r: string) => call(req('PUT', '/relay/speech/route', { route: r }), ctx());

  beforeEach(() => { account = { username: 'user@contoso.example', tenantId: TENANT }; });
  afterEach(() => { for (const a of answers) expect(JSON.stringify(a.body)).not.toMatch(/FAKE|entra-token/); });

  it('validates the separate connection the same way in the relay and the settings screen', () => {
    expect(validateSeparateSpeech({ auth: 'apiKey', region: 'JapanEast', key: ' k ' })).toEqual({ ok: true, value: { auth: 'apiKey', endpoint: null, region: 'japaneast' }, key: 'k' });
    expect(validateSeparateSpeech({ auth: 'apiKey', endpoint: 'https://japaneast.api.cognitive.microsoft.com/' })).toMatchObject({ ok: true, value: { endpoint: 'https://japaneast.api.cognitive.microsoft.com', region: 'japaneast' } });
    expect(validateSeparateSpeech({ auth: 'apiKey', endpoint: 'https://japaneast.api.cognitive.microsoft.com', region: 'eastus' })).toEqual({ ok: false, error: 'regionMismatch' });
    expect(validateSeparateSpeech({ auth: 'apiKey', endpoint: `${SEPARATE_HOST}/tts` })).toEqual({ ok: false, error: 'invalidEndpoint' });
    expect(validateSeparateSpeech({ auth: 'apiKey', endpoint: 'https://evil.example' })).toEqual({ ok: false, error: 'invalidEndpoint' });
    expect(validateSeparateSpeech({ auth: 'apiKey' })).toEqual({ ok: false, error: 'invalidRegion' });
    expect(validateSeparateSpeech({ auth: 'apiKey', region: 'japaneast', key: 'a\nb' })).toEqual({ ok: false, error: 'invalidKey' });
    expect(validateSeparateSpeech({ auth: 'entraId', endpoint: 'https://japaneast.api.cognitive.microsoft.com' })).toEqual({ ok: false, error: 'customDomainRequired' });
    expect(validateSeparateSpeech({ auth: 'entraId', endpoint: SEPARATE_HOST, key: 'k' })).toEqual({ ok: false, error: 'invalidBody' });
    expect(validateSeparateSpeech({ auth: 'apiKey', region: 'japaneast', extra: 1 })).toEqual({ ok: false, error: 'invalidBody' });
    expect(separateSpeechTestUrl({ auth: 'apiKey', endpoint: SEPARATE_HOST, region: null })).toBe(`${SEPARATE_HOST}/tts/cognitiveservices/voices/list`);
    expect(separateSpeechTestUrl({ auth: 'apiKey', endpoint: 'https://japaneast.api.cognitive.microsoft.com', region: 'japaneast' })).toBe('https://japaneast.tts.speech.microsoft.com/cognitiveservices/voices/list');
  });

  it('refuses the separate route until the Foundry connection and Speech on it are verified, without calling out', async () => {
    const never = recorder(() => new Response('[]'));
    expect(await status()).toEqual({ route: 'foundry', eligible: false, separate: null });
    expect(await separate({ auth: 'apiKey', region: 'japaneast', key: SEPARATE_KEY }, { fetch: never.fetch })).toEqual({ status: 409, body: { error: 'notEligible' } });
    expect(await route('separate')).toEqual({ status: 409, body: { error: 'notEligible' } });
    expect((await route('foundry')).status).toBe(200);
    expect((await call(req('PUT', '/relay/secrets/speechSeparateKey', { value: SEPARATE_KEY }))).status).toBe(404);

    vault.set('foundryKey', FAKE_KEY);
    expect((await call(req('PUT', '/relay/connection', { endpoint: FOUNDRY, deployment: 'model-router' }), ctx({ fetch: verifiedReply }))).status).toBe(200);
    expect((await status()).eligible).toBe(false); // Foundry verified, Speech on it not yet
    expect(await separate({ auth: 'apiKey', region: 'japaneast', key: SEPARATE_KEY }, { fetch: never.fetch })).toEqual({ status: 409, body: { error: 'notEligible' } });
    expect(never.sent).toEqual([]);
    expect(vault.get('speechSeparateKey')).toBeUndefined();
  });

  it('saves the separate API-key connection only after its test passes, keeps the key in the vault, and goes back to Foundry at any time', async () => {
    await verifyFoundrySpeech('apiKey');
    expect(await status()).toEqual({ route: 'foundry', eligible: true, separate: null });

    const failing = recorder(() => new Response('{}', { status: 401 }));
    expect(await separate({ auth: 'apiKey', region: 'japaneast', key: SEPARATE_KEY }, { fetch: failing.fetch })).toEqual({ status: 502, body: { error: 'unauthorized', providerStatus: 401 } });
    expect(failing.sent).toEqual([{ url: 'https://japaneast.tts.speech.microsoft.com/cognitiveservices/voices/list', headers: { 'Ocp-Apim-Subscription-Key': SEPARATE_KEY } }]);
    expect(await status()).toEqual({ route: 'foundry', eligible: true, separate: null });
    expect(vault.get('speechSeparateKey')).toBeUndefined();

    const ok = recorder(() => new Response('[]'));
    const saved = await separate({ auth: 'apiKey', region: 'japaneast', key: SEPARATE_KEY }, { fetch: ok.fetch });
    expect(saved).toEqual({ status: 200, body: { route: 'separate', eligible: true, separate: { auth: 'apiKey', endpoint: null, region: 'japaneast', verifiedAt: expect.any(String) } } });
    expect(vault.get('speechSeparateKey')).toBe(SEPARATE_KEY);
    expect(readFileSync(join(vault.dir, 'speech.json'), 'utf8')).not.toContain(SEPARATE_KEY);
    expect(vault.status()).toEqual({ foundryKey: true });

    // A retest without a key reuses the saved one; a failed retest leaves the saved connection and route as they were.
    const custom = recorder(() => new Response('{}', { status: 500 }));
    expect((await separate({ auth: 'apiKey', endpoint: SEPARATE_HOST }, { fetch: custom.fetch })).status).toBe(502);
    expect(custom.sent[0]).toEqual({ url: `${SEPARATE_HOST}/tts/cognitiveservices/voices/list`, headers: { 'Ocp-Apim-Subscription-Key': SEPARATE_KEY } });
    expect(await status()).toMatchObject({ route: 'separate', separate: { region: 'japaneast', endpoint: null } });

    expect(await route('foundry')).toMatchObject({ status: 200, body: { route: 'foundry', separate: { verifiedAt: expect.any(String) } } });
    expect(await route('separate')).toMatchObject({ status: 200, body: { route: 'separate' } });

    // Another key on the separate resource drops its check; the saved route is reported as is, never silently changed.
    vault.set('speechSeparateKey', `${SEPARATE_KEY}-replaced`);
    expect(await status()).toMatchObject({ route: 'separate', separate: { verifiedAt: null } });
    expect((await route('foundry')).status).toBe(200);
    expect(await route('separate')).toEqual({ status: 409, body: { error: 'separateNotVerified' } });

    expect(await call(req('DELETE', '/relay/speech/separate'), ctx())).toEqual({ status: 200, body: { route: 'foundry', eligible: true, separate: null } });
    expect(vault.get('speechSeparateKey')).toBeUndefined();
    expect(await call(req('PUT', '/relay/speech/route', { route: 'cloud' }), ctx())).toEqual({ status: 400, body: { error: 'invalidBody' } });
  });

  it('lets an existing separate route go back to Foundry, but not be re-chosen, once Speech on Foundry is no longer verified', async () => {
    await verifyFoundrySpeech('apiKey');
    expect((await separate({ auth: 'apiKey', region: 'japaneast', key: SEPARATE_KEY }, { fetch: recorder(() => new Response('[]')).fetch })).status).toBe(200);
    vault.set('foundryKey', `${FAKE_KEY}-replaced`);
    expect(await status()).toMatchObject({ route: 'separate', eligible: false, separate: { verifiedAt: expect.any(String) } });
    expect((await route('foundry')).status).toBe(200);
    expect(await route('separate')).toEqual({ status: 409, body: { error: 'notEligible' } });
  });

  it('uses the Foundry Microsoft Entra sign-in and tenant on a custom subdomain and binds the check to the account', async () => {
    await verifyFoundrySpeech('apiKey');
    expect(await separate({ auth: 'entraId', endpoint: SEPARATE_HOST })).toEqual({ status: 400, body: { error: 'notEntra' } });

    await verifyFoundrySpeech('entraId');
    expect(await separate({ auth: 'entraId', endpoint: 'https://japaneast.api.cognitive.microsoft.com' })).toEqual({ status: 400, body: { error: 'customDomainRequired' } });
    const ok = recorder(() => new Response('[]'));
    expect(await separate({ auth: 'entraId', endpoint: SEPARATE_HOST }, { fetch: ok.fetch })).toMatchObject({ status: 200, body: { route: 'separate', separate: { auth: 'entraId', endpoint: SEPARATE_HOST, verifiedAt: expect.any(String) } } });
    expect(ok.sent).toEqual([{ url: `${SEPARATE_HOST}/tts/cognitiveservices/voices/list`, headers: { Authorization: 'Bearer entra-token-data' } }]);

    account = { username: 'someone-else@contoso.example', tenantId: TENANT };
    expect(await status()).toMatchObject({ route: 'separate', separate: { verifiedAt: null } });
    account = { username: 'user@contoso.example', tenantId: TENANT };
    expect(await status()).toMatchObject({ separate: { verifiedAt: expect.any(String) } });
  });

  it('refuses a disallowed outbound host and repeated tests within five seconds', async () => {
    await verifyFoundrySpeech('apiKey');
    const ok = recorder(() => new Response('[]'));
    const body = { auth: 'apiKey', region: 'japaneast', key: SEPARATE_KEY };
    expect(await separate(body, { fetch: ok.fetch, config: { ...testConfig, outboundHosts: ['bas-foundry.openai.azure.com'] } })).toEqual({ status: 400, body: { error: 'hostNotAllowed' } });
    const lastCall = new Map<string, number>();
    const fixed = { now: () => clock, lastCall };
    expect((await separate(body, { fetch: ok.fetch, ...fixed })).status).toBe(200);
    expect(await separate(body, { fetch: ok.fetch, ...fixed })).toEqual({ status: 429, body: { error: 'tooSoon' } });
    expect(ok.sent).toHaveLength(1);
  });
});

describe('D-37 Microsoft Foundry Decision through the relay (FR-325 candidate pre-screen)', () => {
  const DECISION_KEY = 'decision-FAKE-KEY-0123456789abcdef';
  const ENDPOINT = 'http://127.0.0.1:9999';
  const testConfig: RelayConfig = { ...STRICT_RELAY_CONFIG, testOutbound: true };
  let clock = 29_000_000;
  const ctx = (extra: Partial<RelayContext> = {}): Partial<RelayContext> => ({ config: testConfig, now: () => (clock += 10_000), ...extra });
  type Sent = { url: string; headers: Record<string, string>; body: { model: string; state: unknown; questions: Record<string, unknown> } };
  const decisionReply = (answers: Record<string, unknown>, status = 200) => {
    const sent: Sent[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 545, output_tokens: 4 } }), { status });
    };
    return { sent, fetch };
  };
  const noul = (p: number) => ({ type: 'noul', noul: p });
  const save = (body: unknown, extra: Partial<RelayContext> = {}) => call(req('PUT', '/relay/decision', body), ctx(extra));
  const screenBody = {
    use: 'kpiOkrScreen', state: { projectPurpose: 'p', candidates: [{ key: 'c1', name: 'n' }] },
    questions: { r_c1: { type: 'noul', instructions: 'Relevant?' }, d_c1: { type: 'noul', instructions: 'Duplicate?' } },
  };
  const screen = (extra: Partial<RelayContext> = {}, body: unknown = screenBody) => call(req('POST', '/relay/decision/screen', body), ctx(extra));
  const status = async () => ((await call(req('GET', '/relay/status'), ctx())).body as { decision: unknown }).decision;

  afterEach(() => { for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(DECISION_KEY); });

  it('saves the connection only after the synthetic test passes, keeps the key in the vault, and seals it to that key', async () => {
    expect(await status()).toBeNull();
    expect((await save({ endpoint: 'https://evil.example', deployment: 'decision-1-1', key: DECISION_KEY })).body).toEqual({ error: 'invalidEndpoint' });
    expect((await save({ endpoint: ENDPOINT, deployment: 'decision-1-1' })).body).toEqual({ error: 'keyMissing' });

    const failing = decisionReply({}, 401);
    expect(await save({ endpoint: ENDPOINT, deployment: 'decision-1-1', key: DECISION_KEY }, { fetch: failing.fetch })).toEqual({ status: 502, body: { error: 'unauthorized', providerStatus: 401 } });
    expect(vault.get('decisionKey')).toBeUndefined();
    expect(await status()).toBeNull();

    const ok = decisionReply({ test: noul(0.97) });
    const saved = await save({ endpoint: ENDPOINT, deployment: 'decision-1-1', key: DECISION_KEY }, { fetch: ok.fetch });
    expect(saved).toEqual({ status: 200, body: { decision: { endpoint: ENDPOINT, deployment: 'decision-1-1', verifiedAt: expect.any(String) }, usage: { inputTokens: 545, outputTokens: 4 } } });
    expect(ok.sent[0]).toMatchObject({ url: `${ENDPOINT}/providers/microsoft/v1/systemone`, headers: { 'api-key': DECISION_KEY }, body: { model: 'decision-1-1' } });
    expect(JSON.stringify(ok.sent[0]!.body.state)).toContain('No business data');
    expect(readFileSync(join(vault.dir, 'decision.json'), 'utf8')).not.toContain(DECISION_KEY);
    expect((await call(req('PUT', '/relay/secrets/decisionKey', { value: 'x'.repeat(20) }))).status).toBe(404);

    // Changing the key behind the seal invalidates the connection until it is tested again.
    vault.set('decisionKey', `${DECISION_KEY}-other`);
    expect(await status()).toMatchObject({ verifiedAt: null });
    expect(await screen({ fetch: decisionReply({}).fetch })).toEqual({ status: 403, body: { allowed: false, reasons: ['notConfigured'] } });

    expect(await call(req('DELETE', '/relay/decision'), ctx())).toEqual({ status: 200, body: { decision: null } });
    expect(vault.get('decisionKey')).toBeUndefined();
  });

  it('screens with noul questions only and returns probabilities only when every answer is valid', async () => {
    expect((await save({ endpoint: ENDPOINT, deployment: 'decision-1-1', key: DECISION_KEY }, { fetch: decisionReply({ test: noul(0.9) }).fetch })).status).toBe(200);

    const good = decisionReply({ r_c1: noul(0.8), d_c1: noul(0.1) });
    expect(await screen({ fetch: good.fetch })).toEqual({ status: 200, body: { answers: { r_c1: 0.8, d_c1: 0.1 }, inputTokens: 545, outputTokens: 4 } });
    expect(good.sent[0]!.body).toEqual({ model: 'decision-1-1', state: screenBody.state, questions: screenBody.questions });

    expect((await screen({ fetch: decisionReply({ r_c1: noul(0.8) }).fetch })).body).toEqual({ error: 'badProviderResponse' });
    expect((await screen({ fetch: decisionReply({ r_c1: noul(1.4), d_c1: noul(0.1) }).fetch })).body).toEqual({ error: 'badProviderResponse' });
    expect((await screen({ fetch: decisionReply({}, 422).fetch })).body).toEqual({ error: 'invalidApiRequest', providerStatus: 422 });

    const never = decisionReply({});
    const bad = [
      { ...screenBody, use: 'kpiOkrDraft' },
      { ...screenBody, questions: { r_c1: { type: 'choice', instructions: 'x', choices: ['a'] } } },
      { ...screenBody, questions: { 'R-1': { type: 'noul', instructions: 'x' } } },
      { ...screenBody, questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])) },
      { ...screenBody, extra: 1 },
    ];
    for (const body of bad) expect((await screen({ fetch: never.fetch }, body)).body).toEqual({ error: 'invalidBody' });
    expect(never.sent).toEqual([]);

    const strict: RelayConfig = { ...testConfig, testOutbound: false };
    expect((await call(req('POST', '/relay/decision/screen', screenBody), { config: strict, now: () => (clock += 10_000), fetch: never.fetch })).status).toBe(403);
    expect(never.sent).toEqual([]);
  });
});
