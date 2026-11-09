import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { AI_LIMITS, C03_TABLE, PER_USE_LIMITS, isApproved, type AiUse, type UseApproval } from '../src/ai/policy.ts';
import { MAX_SECRET_LENGTH, SecretVault, isSecretName } from './vault.ts';

/** Largest request body the relay reads: 32 000 characters of prompt and context, UTF-8 and JSON-escaped. */
export const MAX_BODY_BYTES = 256 * 1024;
export const RELAY_PREFIX = '/relay/';
/**
 * Every request except POST /relay/session must carry the per-launch token in this header (Q-122 answer 2026-11-09:
 * a token per launch). A cross-origin page can neither add the header without a CORS preflight, which the relay never
 * grants, nor read /relay/session, which answers allowed origins only.
 */
export const RELAY_HEADER = 'x-bas-relay';
/** Prompt + context characters accepted by POST /relay/ai. */
export const MAX_AI_CHARS = 32_000;
/** Upper bound of the per-call timeout a client may ask for. */
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_API_VERSION = '2024-10-21';
const CONNECTION_FILE = 'connection.json';

/** A fresh random token for one relay process (one app launch). Kept in memory only: never logged or stored. */
export function newRelayToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenMatches(sent: string | undefined, expected: string): boolean {
  if (sent === undefined) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* D-5 configuration (docs/relay-config.md)                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface RelayConfig {
  /** Accept only clients on this PC (127.0.0.1). BAS_RELAY_REQUIRE_LOOPBACK=0 disables it for a server deployment. */
  requireLoopback: boolean;
  /** Also accept `::1` (BAS_RELAY_ALLOW_IPV6_LOOPBACK=1). */
  allowIpv6Loopback: boolean;
  /** Extra exact Host header values (`host:port`), besides `127.0.0.1:<listening port>`. */
  allowedHosts: string[];
  /** Extra exact Origin values, besides `http://127.0.0.1:<listening port>`. */
  allowedOrigins: string[];
  /** When set, outbound calls also need their hostname in this list (BAS_RELAY_OUTBOUND_HOSTS). */
  outboundHosts: string[] | null;
  /** Tests only (BAS_RELAY_TEST_OUTBOUND=1): also allow `http://127.0.0.1:<port>` as the provider endpoint. */
  testOutbound: boolean;
}

export const STRICT_RELAY_CONFIG: RelayConfig = {
  requireLoopback: true, allowIpv6Loopback: false, allowedHosts: [], allowedOrigins: [], outboundHosts: null, testOutbound: false,
};

export class RelayConfigError extends Error {}

const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/;
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Reads the relay protection settings. Unset variables keep the strict defaults; wildcards and malformed entries stop
 * the server at startup (no silent widening). Pure: the environment is passed in.
 */
export function relayConfigFromEnv(env: Record<string, string | undefined> = process.env): RelayConfig {
  const list = (name: string) => (env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const flag = (name: string, fallback: boolean) => {
    const v = (env[name] ?? '').trim();
    if (v === '') return fallback;
    if (v === '1') return true;
    if (v === '0') return false;
    throw new RelayConfigError(`${name} must be 0 or 1`);
  };
  const noWildcards = (name: string, items: string[]) => {
    if (items.some((i) => i.includes('*'))) throw new RelayConfigError(`${name} must not contain wildcards`);
  };

  const allowedHosts = list('BAS_RELAY_ALLOWED_HOSTS').map((h) => h.toLowerCase());
  noWildcards('BAS_RELAY_ALLOWED_HOSTS', allowedHosts);
  if (allowedHosts.some((h) => !HOST_PATTERN.test(h))) throw new RelayConfigError('BAS_RELAY_ALLOWED_HOSTS has an invalid host');

  const allowedOrigins = list('BAS_RELAY_ALLOWED_ORIGINS');
  noWildcards('BAS_RELAY_ALLOWED_ORIGINS', allowedOrigins);
  for (const o of allowedOrigins) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new RelayConfigError('BAS_RELAY_ALLOWED_ORIGINS has an invalid origin');
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== o) throw new RelayConfigError('BAS_RELAY_ALLOWED_ORIGINS has an invalid origin');
  }

  const outboundRaw = env.BAS_RELAY_OUTBOUND_HOSTS;
  const outbound = list('BAS_RELAY_OUTBOUND_HOSTS').map((h) => h.toLowerCase());
  noWildcards('BAS_RELAY_OUTBOUND_HOSTS', outbound);
  if (outbound.some((h) => !HOSTNAME_PATTERN.test(h))) throw new RelayConfigError('BAS_RELAY_OUTBOUND_HOSTS has an invalid hostname');

  return {
    requireLoopback: flag('BAS_RELAY_REQUIRE_LOOPBACK', true),
    allowIpv6Loopback: flag('BAS_RELAY_ALLOW_IPV6_LOOPBACK', false),
    allowedHosts,
    allowedOrigins,
    outboundHosts: outboundRaw !== undefined && outboundRaw.trim() !== '' ? outbound : null,
    testOutbound: flag('BAS_RELAY_TEST_OUTBOUND', false),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Inbound checks                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface RelayRequest {
  method: string;
  /** Path and query, e.g. `/relay/status`. */
  url: string;
  remoteAddress: string | undefined;
  /** The port the server accepted the connection on (`req.socket.localPort`). */
  localPort: number | undefined;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface RelayResponse {
  status: number;
  body: unknown;
}

/** C-01: only clients on this PC. IPv4 loopback (also in its IPv4-mapped form); `::1` only when configured. */
export function isLoopback(address: string | undefined, config: Pick<RelayConfig, 'allowIpv6Loopback'> = STRICT_RELAY_CONFIG): boolean {
  if (address === '127.0.0.1' || address === '::ffff:127.0.0.1') return true;
  return address === '::1' && config.allowIpv6Loopback;
}

const header = (h: RelayRequest['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** DNS-rebinding guard: the Host header must exactly equal `127.0.0.1:<port>` or a configured value. */
export function hostAllowed(host: string | undefined, localPort: number | undefined, config: RelayConfig = STRICT_RELAY_CONFIG): boolean {
  if (!host) return false;
  if (localPort !== undefined && host === `127.0.0.1:${localPort}`) return true;
  return config.allowedHosts.includes(host.toLowerCase());
}

/** The Origin must exactly equal `http://127.0.0.1:<port>` or a configured value. */
export function originAllowed(origin: string, localPort: number | undefined, config: RelayConfig = STRICT_RELAY_CONFIG): boolean {
  if (localPort !== undefined && origin === `http://127.0.0.1:${localPort}`) return true;
  return config.allowedOrigins.includes(origin);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Connection (non-secret) and outbound allowlist                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface RelayConnection {
  /** Origin of the Azure OpenAI / Foundry resource, e.g. `https://x.openai.azure.com`. */
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

export type ConnectionError = 'invalidBody' | 'invalidEndpoint' | 'hostNotAllowed' | 'invalidDeployment' | 'invalidApiVersion';

function endpointHostAllowed(u: URL, config: RelayConfig): boolean {
  return config.outboundHosts === null || config.outboundHosts.includes(u.hostname.toLowerCase());
}

/** Validates a connection: https URL without credentials, query or path; deployment `[A-Za-z0-9._-]{1,64}`. */
export function validateConnection(input: unknown, config: RelayConfig = STRICT_RELAY_CONFIG): { ok: true; value: RelayConnection } | { ok: false; error: ConnectionError } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalidBody' };
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => !['endpoint', 'deployment', 'apiVersion'].includes(k))) return { ok: false, error: 'invalidBody' };
  const { endpoint, deployment, apiVersion = DEFAULT_API_VERSION } = o;
  if (typeof endpoint !== 'string' || endpoint.length > 512) return { ok: false, error: 'invalidEndpoint' };
  let u: URL;
  try {
    u = new URL(endpoint.trim());
  } catch {
    return { ok: false, error: 'invalidEndpoint' };
  }
  const testHttp = config.testOutbound && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if ((u.protocol !== 'https:' && !testHttp) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { ok: false, error: 'invalidEndpoint' };
  }
  if (!testHttp && !endpointHostAllowed(u, config)) return { ok: false, error: 'hostNotAllowed' };
  if (typeof deployment !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(deployment)) return { ok: false, error: 'invalidDeployment' };
  if (typeof apiVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(apiVersion)) return { ok: false, error: 'invalidApiVersion' };
  return { ok: true, value: { endpoint: u.origin, deployment, apiVersion } };
}

export function loadConnection(dir: string, config: RelayConfig = STRICT_RELAY_CONFIG): RelayConnection | null {
  const path = join(dir, CONNECTION_FILE);
  if (!existsSync(path)) return null;
  try {
    const r = validateConnection(JSON.parse(readFileSync(path, 'utf8')) as unknown, config);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

function saveConnection(dir: string, c: RelayConnection) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, CONNECTION_FILE);
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Outbound allowlist (D-5, P-05 ⑦): an https URL whose hostname exactly equals the saved endpoint's hostname and, when
 * BAS_RELAY_OUTBOUND_HOSTS is set, is listed there. With BAS_RELAY_TEST_OUTBOUND=1 also `http://127.0.0.1:<port>` of
 * the saved endpoint (local stub providers in tests).
 */
export function outboundAllowed(url: string, savedEndpoint: string, config: RelayConfig = STRICT_RELAY_CONFIG): boolean {
  let u: URL;
  let saved: URL;
  try {
    u = new URL(url);
    saved = new URL(savedEndpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:' && saved.protocol === 'https:') {
    return u.hostname === saved.hostname && u.port === saved.port && endpointHostAllowed(u, config);
  }
  return config.testOutbound && u.protocol === 'http:' && saved.protocol === 'http:' && u.hostname === '127.0.0.1' && u.host === saved.host;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Handler                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export type RelayRefusal = 'c03NotApproved' | 'notConfigured';

/** Server-side C-03 re-check (defence in depth behind src/ai/gate.ts): approved rows only, and a complete connection. */
export function relayAiDecision(use: AiUse, configured: boolean, table: Record<AiUse, UseApproval> = C03_TABLE): RelayRefusal[] {
  const reasons: RelayRefusal[] = [];
  if (!isApproved(table[use])) reasons.push('c03NotApproved');
  if (!configured) reasons.push('notConfigured');
  return reasons;
}

export interface RelayContext {
  vault: SecretVault;
  token: string;
  config?: RelayConfig;
  table?: Record<AiUse, UseApproval>;
  /** Last forwarded call per use (PARAM-116 minimum interval, enforced server-side too). */
  lastCall?: Map<string, number>;
  now?: () => number;
  fetch?: typeof fetch;
}

const json = (status: number, body: unknown): RelayResponse => ({ status, body });

function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const AI_FIELDS = new Set(['use', 'lang', 'prompt', 'context', 'maxOutputTokens', 'timeoutMs']);

const SYSTEM_PROMPT = {
  ja: 'あなたは業務分析アプリの画面を説明するアシスタントです。与えられたデータだけに基づき、日本語で簡潔に答えてください。データにないことは推測しないでください。',
  en: 'You explain a business analytics app screen. Answer concisely in English using only the data provided. Do not guess beyond the data.',
} as const;

interface AiCall {
  use: AiUse;
  lang: 'ja' | 'en';
  prompt: string;
  context: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

function validateAiCall(o: Record<string, unknown>, use: AiUse): AiCall | null {
  const { lang, prompt, context = '', maxOutputTokens, timeoutMs } = o;
  if (lang !== 'ja' && lang !== 'en') return null;
  if (typeof prompt !== 'string' || typeof context !== 'string' || prompt.trim() === '') return null;
  if (prompt.length + context.length > MAX_AI_CHARS) return null;
  const outCap = PER_USE_LIMITS[use]?.maxOutputTokens ?? AI_LIMITS.maxOutputTokens;
  if (typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > outCap) return null;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return null;
  return { use, lang, prompt, context, maxOutputTokens, timeoutMs };
}

/** Azure OpenAI chat completions (Foundry). Provider bodies are never echoed and nothing is logged. */
async function forward(call: AiCall, conn: RelayConnection, apiKey: string, config: RelayConfig, doFetch: typeof fetch): Promise<RelayResponse> {
  const url = `${conn.endpoint}/openai/deployments/${encodeURIComponent(conn.deployment)}/chat/completions?api-version=${encodeURIComponent(conn.apiVersion)}`;
  if (!outboundAllowed(url, conn.endpoint, config)) return json(403, { error: 'outboundNotAllowed' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT[call.lang] },
          { role: 'user', content: `${call.prompt}\n\n${call.context}` },
        ],
        max_tokens: call.maxOutputTokens,
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return json(502, { error: 'providerError' });
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const text = data.choices?.[0]?.message?.content;
    const inputTokens = data.usage?.prompt_tokens;
    const outputTokens = data.usage?.completion_tokens;
    if (typeof text !== 'string' || typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || inputTokens < 0 || outputTokens < 0) {
      return json(502, { error: 'badProviderResponse' });
    }
    return json(200, { text, inputTokens, outputTokens });
  } catch {
    return controller.signal.aborted ? json(504, { error: 'timeout' }) : json(502, { error: 'providerError' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request handler (unit-tested without sockets). Responses never contain secret values, request and provider bodies are
 * never echoed, and nothing is logged (C-01, NFR-SEC-001/005/012).
 */
export async function handleRelay(req: RelayRequest, ctx: RelayContext): Promise<RelayResponse> {
  const config = ctx.config ?? STRICT_RELAY_CONFIG;
  const table = ctx.table ?? C03_TABLE;
  const { vault, token } = ctx;
  if (config.requireLoopback && !isLoopback(req.remoteAddress, config)) return json(403, { error: 'notLoopback' });
  if (!hostAllowed(header(req.headers, 'host'), req.localPort, config)) return json(403, { error: 'badHost' });
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const method = req.method.toUpperCase();
  const origin = header(req.headers, 'origin');
  // Browsers omit Origin only on same-origin GET/HEAD; the one route read that way is the status (still token-protected).
  if (origin === undefined) {
    if (!(method === 'GET' && path === '/relay/status')) return json(403, { error: 'noOrigin' });
  } else if (!originAllowed(origin, req.localPort, config)) {
    return json(403, { error: 'crossOrigin' });
  }
  const site = header(req.headers, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return json(403, { error: 'crossOrigin' });

  if (path === '/relay/session') {
    if (method !== 'POST') return json(405, { error: 'methodNotAllowed' });
    return json(200, { token });
  }
  if (!tokenMatches(header(req.headers, RELAY_HEADER), token)) return json(403, { error: 'badToken' });
  if ((method === 'PUT' || method === 'POST') && !(header(req.headers, 'content-type') ?? '').startsWith('application/json')) {
    return json(415, { error: 'unsupportedMediaType' });
  }

  const connection = () => loadConnection(vault.dir, config);
  const configured = () => connection() !== null && vault.status().foundryKey;

  if (path === '/relay/status') {
    if (method !== 'GET') return json(405, { error: 'methodNotAllowed' });
    return json(200, { relay: 'ok', secrets: vault.status(), connection: connection(), configured: configured(), keyProtection: vault.keyProtection() });
  }

  const secret = /^\/relay\/secrets\/([A-Za-z]+)$/.exec(path);
  if (secret) {
    const name = secret[1]!;
    if (!isSecretName(name)) return json(404, { error: 'unknownSecret' });
    if (method === 'PUT') {
      const value = parseBody(req.body)?.value;
      if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(value)) {
        return json(400, { error: 'invalidValue' });
      }
      vault.set(name, value.trim());
      return json(200, { name, configured: true });
    }
    if (method === 'DELETE') {
      vault.delete(name);
      return json(200, { name, configured: false });
    }
    return json(405, { error: 'methodNotAllowed' });
  }

  if (path === '/relay/connection') {
    if (method === 'PUT') {
      const r = validateConnection(parseBody(req.body), config);
      if (!r.ok) return json(400, { error: r.error });
      saveConnection(vault.dir, r.value);
      return json(200, { connection: r.value });
    }
    if (method === 'DELETE') {
      rmSync(join(vault.dir, CONNECTION_FILE), { force: true });
      return json(200, { connection: null });
    }
    return json(405, { error: 'methodNotAllowed' });
  }

  if (path === '/relay/ai') {
    if (method !== 'POST') return json(405, { error: 'methodNotAllowed' });
    const body = parseBody(req.body);
    if (!body) return json(400, { error: 'invalidBody' });
    if (Object.keys(body).some((k) => !AI_FIELDS.has(k))) return json(400, { error: 'unknownField' });
    const use = body.use;
    if (typeof use !== 'string' || !Object.hasOwn(table, use)) return json(400, { error: 'unknownUse' });
    const reasons = relayAiDecision(use as AiUse, configured(), table);
    if (reasons.length > 0) return json(403, { allowed: false, reasons });
    const call = validateAiCall(body, use as AiUse);
    if (!call) return json(400, { error: 'invalidRequest' });
    const now = (ctx.now ?? Date.now)();
    const minInterval = PER_USE_LIMITS[call.use]?.minIntervalMs;
    const last = ctx.lastCall?.get(call.use);
    if (minInterval !== undefined && last !== undefined && now - last < minInterval) return json(429, { error: 'tooSoon' });
    ctx.lastCall?.set(call.use, now);
    const conn = connection();
    const apiKey = vault.get('foundryKey');
    if (!conn || !apiKey) return json(403, { allowed: false, reasons: ['notConfigured'] });
    return forward(call, conn, apiKey, config, ctx.fetch ?? fetch);
  }

  return json(404, { error: 'notFound' });
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolveBody(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolveBody(null));
  });
}

function send(res: ServerResponse, r: RelayResponse) {
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(r.body));
}

export function relayMiddleware(vault: SecretVault, token: string = newRelayToken(), config: RelayConfig = STRICT_RELAY_CONFIG) {
  const lastCall = new Map<string, number>();
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url || !req.url.startsWith(RELAY_PREFIX)) return next();
    void (async () => {
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
        if (body === null) return send(res, json(413, { error: 'tooLarge' }));
        const request: RelayRequest = {
          method: req.method ?? 'GET', url: req.url!, remoteAddress: req.socket.remoteAddress, localPort: req.socket.localPort, headers: req.headers, body,
        };
        send(res, await handleRelay(request, { vault, token, config, lastCall }));
      } catch {
        // Deliberately no logging and no error details: an error could carry request content (NFR-SEC-012).
        send(res, json(500, { error: 'internal' }));
      }
    })();
  };
}

/**
 * Where the vault lives. `BAS_RELAY_DIR` overrides it; parallel E2E builds (`BAS_OUT=dist-x`) get their own folder so a
 * test run never overwrites the user's real keys in `.bas-local`.
 */
export function relayDir(root: string, env: Record<string, string | undefined> = process.env): string {
  if (env.BAS_RELAY_DIR) return resolve(root, env.BAS_RELAY_DIR);
  const out = env.BAS_OUT;
  return out && out !== 'dist' ? join(resolve(root, '.bas-local'), `e2e-${out.replace(/[^\w-]/g, '_')}`) : resolve(root, '.bas-local');
}

/** FR-011 relay process: mounted into the Vite dev and preview servers, which listen on 127.0.0.1 only. */
export function relayPlugin(opts: { dir?: string; env?: Record<string, string | undefined> } = {}): Plugin {
  // Read once at startup: invalid or wildcard settings stop the server instead of silently widening access.
  const config = relayConfigFromEnv(opts.env ?? process.env);
  const token = newRelayToken();
  let vault: SecretVault | null = null;
  const get = (root: string) => (vault ??= new SecretVault(opts.dir ?? relayDir(root)));
  return {
    name: 'bas-relay',
    configureServer(server) {
      server.middlewares.use(relayMiddleware(get(server.config.root), token, config));
    },
    configurePreviewServer(server) {
      server.middlewares.use(relayMiddleware(get(server.config.root), token, config));
    },
  };
}