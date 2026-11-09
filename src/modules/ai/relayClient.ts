import type { LiveCall, LiveResult, LiveTransport } from '../../ai/client.ts';

/** Browser side of the localhost relay (FR-011). Secret values only travel in PUT bodies and are never read back. */
export type SecretName = 'foundryKey' | 'speechKey';
export type KeyProtection = 'dpapi' | 'file';

/** Non-secret connection held by the relay (endpoint origin, deployment, API version). */
export interface RelayConnectionInfo {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

export interface RelayStatus {
  reachable: boolean;
  secrets: Record<SecretName, boolean>;
  connection: RelayConnectionInfo | null;
  keyProtection: KeyProtection | null;
}

const UNREACHABLE: RelayStatus = { reachable: false, secrets: { foundryKey: false, speechKey: false }, connection: null, keyProtection: null };

/**
 * The relay's per-launch token, kept in memory only (never in browser storage). It is handed out on POST so that the
 * browser always sends an Origin header, which the relay checks exactly (D-5).
 */
let token: Promise<string | null> | null = null;
function relayToken(): Promise<string | null> {
  token ??= fetch('/relay/session', { method: 'POST', cache: 'no-store' })
    .then(async (r) => (r.ok ? ((await r.json()) as { token?: string }).token ?? null : null))
    .catch(() => null)
    .then((t) => {
      if (t === null) token = null; // retry later, e.g. after the relay restarts
      return t;
    });
  return token;
}

async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const t = await relayToken();
  return { ...(t ? { 'X-BAS-Relay': t } : {}), ...extra };
}

async function isBadToken(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    return ((await res.clone().json()) as { error?: string }).error === 'badToken';
  } catch {
    return false;
  }
}

/** A relay restart issues a new token: on 403 badToken (only), refresh the token once and retry. */
async function relayFetch(url: string, init: RequestInit & { extraHeaders?: Record<string, string> } = {}): Promise<Response> {
  const { extraHeaders, ...rest } = init;
  let res = await fetch(url, { ...rest, headers: await headers(extraHeaders), cache: 'no-store' });
  if (await isBadToken(res)) {
    token = null;
    res = await fetch(url, { ...rest, headers: await headers(extraHeaders), cache: 'no-store' });
  }
  return res;
}

function asConnection(v: unknown): RelayConnectionInfo | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<RelayConnectionInfo>;
  return typeof c.endpoint === 'string' && typeof c.deployment === 'string' && typeof c.apiVersion === 'string'
    ? { endpoint: c.endpoint, deployment: c.deployment, apiVersion: c.apiVersion }
    : null;
}

export async function fetchRelayStatus(): Promise<RelayStatus> {
  try {
    const res = await relayFetch('/relay/status');
    if (!res.ok) return UNREACHABLE;
    const body = (await res.json()) as { secrets?: Partial<Record<SecretName, boolean>>; connection?: unknown; keyProtection?: unknown };
    return {
      reachable: true,
      secrets: { foundryKey: body.secrets?.foundryKey === true, speechKey: body.secrets?.speechKey === true },
      connection: asConnection(body.connection),
      keyProtection: body.keyProtection === 'dpapi' || body.keyProtection === 'file' ? body.keyProtection : null,
    };
  } catch {
    return UNREACHABLE;
  }
}

export async function saveSecret(name: SecretName, value: string): Promise<boolean> {
  try {
    const res = await relayFetch(`/relay/secrets/${name}`, {
      method: 'PUT',
      extraHeaders: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteSecret(name: SecretName): Promise<boolean> {
  try {
    const res = await relayFetch(`/relay/secrets/${name}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

export type ConnectionSaveError = 'invalidEndpoint' | 'hostNotAllowed' | 'invalidDeployment' | 'invalidApiVersion' | 'failed';

/** Saves the non-secret connection in the relay (validated there: https, no credentials, deployment pattern). */
export async function saveRelayConnection(c: RelayConnectionInfo): Promise<{ ok: true; connection: RelayConnectionInfo } | { ok: false; error: ConnectionSaveError }> {
  try {
    const res = await relayFetch('/relay/connection', {
      method: 'PUT',
      extraHeaders: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    const body = (await res.json()) as { connection?: unknown; error?: string };
    const saved = asConnection(body.connection);
    if (res.ok && saved) return { ok: true, connection: saved };
    const known: ConnectionSaveError[] = ['invalidEndpoint', 'hostNotAllowed', 'invalidDeployment', 'invalidApiVersion'];
    return { ok: false, error: known.find((k) => k === body.error) ?? 'failed' };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

export async function deleteRelayConnection(): Promise<boolean> {
  try {
    return (await relayFetch('/relay/connection', { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

/** Asks the relay whether it would forward a call for a use (refusals list the C-03 / connection reasons). */
export async function relayAiCheck(use: string): Promise<{ allowed: boolean; reasons: string[] }> {
  try {
    const res = await relayFetch('/relay/ai', {
      method: 'POST',
      extraHeaders: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ use }),
    });
    const body = (await res.json()) as { reasons?: string[] };
    return { allowed: false, reasons: body.reasons ?? [] };
  } catch {
    return { allowed: false, reasons: ['relayUnreachable'] };
  }
}

/** Extra time the browser waits beyond the relay's own provider timeout. */
const TRANSPORT_GRACE_MS = 5_000;

/**
 * LiveTransport for src/ai/client.ts: POST /relay/ai with the LiveCall JSON and the per-launch token. Any non-200 answer,
 * malformed result or timeout throws, so aiComplete falls back to the mock with 'liveFailed'.
 */
export const relayTransport: LiveTransport = async (call: LiveCall): Promise<LiveResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs + TRANSPORT_GRACE_MS);
  try {
    const res = await relayFetch('/relay/ai', {
      method: 'POST',
      extraHeaders: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        use: call.use, lang: call.lang, prompt: call.prompt, context: call.context, maxOutputTokens: call.maxOutputTokens, timeoutMs: call.timeoutMs,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const body = (await res.json()) as Partial<LiveResult>;
    if (typeof body.text !== 'string' || typeof body.inputTokens !== 'number' || typeof body.outputTokens !== 'number') throw new Error('bad relay answer');
    return { text: body.text, inputTokens: body.inputTokens, outputTokens: body.outputTokens };
  } finally {
    clearTimeout(timer);
  }
};