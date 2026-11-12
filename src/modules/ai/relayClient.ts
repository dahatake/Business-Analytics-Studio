import type { LiveCall, LiveResult, LiveTransport } from '../../ai/client.ts';
import { CONNECTION_INPUT_ERRORS, CONNECTION_TEST_TIMEOUT_MS, FOUNDRY_ERRORS, type ConnectionInputError, type FoundryError } from '../../ai/foundry.ts';

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
  connectionVerifiedAt: string | null;
  keyProtection: KeyProtection | null;
  /** GitHub Copilot model saved in the relay (D-12). */
  copilot: { model: string } | null;
  /** D-14: Work IQ tenant and app saved in the relay, and whether the user is signed in (never the token). */
  workiq: WorkIqStatus | null;
}

export interface WorkIqStatus {
  /** `cli`: Microsoft's Work IQ CLI on this PC holds the sign-in; `app`: the user's app registration and device code. */
  method: 'app' | 'cli';
  tenantId: string | null;
  clientId: string | null;
  account: string | null;
  signedIn: boolean;
  verifiedAt: string | null;
}

const UNREACHABLE: RelayStatus = { reachable: false, secrets: { foundryKey: false, speechKey: false }, connection: null, connectionVerifiedAt: null, keyProtection: null, copilot: null, workiq: null };

function asWorkIq(v: unknown): WorkIqStatus | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Partial<WorkIqStatus>;
  const common = { account: typeof w.account === 'string' ? w.account : null, signedIn: w.signedIn === true, verifiedAt: typeof w.verifiedAt === 'string' ? w.verifiedAt : null };
  if (w.method === 'cli') return { method: 'cli', tenantId: null, clientId: null, ...common };
  return typeof w.tenantId === 'string' && typeof w.clientId === 'string' ? { method: 'app', tenantId: w.tenantId, clientId: w.clientId, ...common } : null;
}

/**
 * The relay's per-launch token, kept in memory only (never in browser storage). It is handed out on POST so that the
 * browser always sends an Origin header, which the relay checks exactly (D-5).
 */
let token: Promise<string | null> | null = null;
function relayToken(): Promise<string | null> {
  token ??= fetch('/relay/session', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
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
export async function relayFetch(url: string, init: RequestInit & { extraHeaders?: Record<string, string> } = {}): Promise<Response> {
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
    const body = (await res.json()) as { secrets?: Partial<Record<SecretName, boolean>>; connection?: unknown; connectionVerifiedAt?: unknown; keyProtection?: unknown; copilot?: { model?: unknown } | null; workiq?: unknown };
    return {
      reachable: true,
      secrets: { foundryKey: body.secrets?.foundryKey === true, speechKey: body.secrets?.speechKey === true },
      connection: asConnection(body.connection),
      connectionVerifiedAt: typeof body.connectionVerifiedAt === 'string' ? body.connectionVerifiedAt : null,
      keyProtection: body.keyProtection === 'dpapi' || body.keyProtection === 'file' ? body.keyProtection : null,
      copilot: typeof body.copilot?.model === 'string' ? { model: body.copilot.model } : null,
      workiq: asWorkIq(body.workiq),
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

export type ConnectionSaveError = ConnectionInputError | FoundryError | 'hostNotAllowed' | 'outboundNotAllowed' | 'keyMissing' | 'keyChanged' | 'tooSoon' | 'c03NotApproved' | 'budget' | 'failed';
export interface ConnectionUsage { inputTokens: number; outputTokens: number }
export type ConnectionSaveResult =
  | { ok: true; connection: RelayConnectionInfo; connectionVerifiedAt: string; usage: ConnectionUsage }
  | { ok: false; error: ConnectionSaveError; providerStatus?: number; usage?: ConnectionUsage };

/** Saves the non-secret connection in the relay (validated there: https, no credentials, deployment pattern). */
export async function saveRelayConnection(c: RelayConnectionInfo): Promise<ConnectionSaveResult> {
  try {
    const res = await relayFetch('/relay/connection', {
      method: 'PUT',
      extraHeaders: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
      signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS + 5_000),
    });
    const body = (await res.json()) as { connection?: unknown; connectionVerifiedAt?: unknown; usage?: ConnectionUsage; error?: string; providerStatus?: number };
    const saved = asConnection(body.connection);
    const usage = body.usage && Number.isFinite(body.usage.inputTokens) && body.usage.inputTokens >= 0 &&
      Number.isFinite(body.usage.outputTokens) && body.usage.outputTokens >= 0 ? body.usage : undefined;
    if (res.ok && saved && usage && typeof body.connectionVerifiedAt === 'string') {
      return { ok: true, connection: saved, connectionVerifiedAt: body.connectionVerifiedAt, usage };
    }
    const known: ConnectionSaveError[] = [...CONNECTION_INPUT_ERRORS, ...FOUNDRY_ERRORS, 'hostNotAllowed', 'outboundNotAllowed', 'keyMissing', 'keyChanged', 'tooSoon', 'c03NotApproved'];
    return { ok: false, error: known.find((k) => k === body.error) ?? 'failed', providerStatus: body.providerStatus, usage };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failed' };
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

/** A relay refusal or provider failure, with the relay's error code (never provider content). */
export class RelayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`relay ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; reasons?: unknown };
    if (typeof body.error === 'string') return body.error;
    if (Array.isArray(body.reasons) && typeof body.reasons[0] === 'string') return body.reasons[0];
  } catch {
    // not JSON
  }
  return 'unknown';
}

/**
 * LiveTransport for src/ai/client.ts: POST /relay/ai with the LiveCall JSON and the per-launch token. Any non-200 answer,
 * malformed result or timeout throws (RelayError carries the relay's code), so aiComplete falls back to the mock with
 * 'liveFailed'. Cancelling closes the request, which also stops the relay's upstream call.
 */
export const relayTransport: LiveTransport = async (call: LiveCall, signal?: AbortSignal): Promise<LiveResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs + TRANSPORT_GRACE_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await relayFetch('/relay/ai', {
      method: 'POST',
      extraHeaders: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        use: call.use, provider: call.provider, lang: call.lang, prompt: call.prompt, context: call.context, maxOutputTokens: call.maxOutputTokens, timeoutMs: call.timeoutMs,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new RelayError(res.status, await errorCode(res));
    const body = (await res.json()) as Partial<LiveResult>;
    if (typeof body.text !== 'string' || typeof body.inputTokens !== 'number' || typeof body.outputTokens !== 'number') throw new RelayError(502, 'badRelayAnswer');
    return {
      text: body.text, inputTokens: body.inputTokens, outputTokens: body.outputTokens,
      ...(typeof body.premiumRequests === 'number' && body.premiumRequests >= 0 ? { premiumRequests: body.premiumRequests } : {}),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

/* ---------- GitHub Copilot (D-12) ---------- */

export interface CopilotModelInfo {
  id: string;
  name: string;
  multiplier: number | null;
}

export interface CopilotStatusInfo {
  reachable: boolean;
  available: boolean;
  authenticated: boolean;
  login: string | null;
  models: CopilotModelInfo[];
  error: string | null;
  model: string | null;
}

/** Starts the Copilot runtime in the relay if needed and reports the CLI sign-in and the models it offers. */
export async function fetchCopilotStatus(): Promise<CopilotStatusInfo> {
  try {
    const res = await relayFetch('/relay/copilot/status', { method: 'POST', extraHeaders: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) return { reachable: false, available: false, authenticated: false, login: null, models: [], error: await errorCode(res), model: null };
    const b = (await res.json()) as Partial<CopilotStatusInfo> & { settings?: { model?: unknown } | null };
    const models = Array.isArray(b.models)
      ? b.models.filter((m): m is CopilotModelInfo => typeof m?.id === 'string').map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, multiplier: typeof m.multiplier === 'number' ? m.multiplier : null }))
      : [];
    return {
      reachable: true,
      available: b.available === true,
      authenticated: b.authenticated === true,
      login: typeof b.login === 'string' ? b.login : null,
      models,
      error: typeof b.error === 'string' ? b.error : null,
      model: typeof b.settings?.model === 'string' ? b.settings.model : null,
    };
  } catch {
    return { reachable: false, available: false, authenticated: false, login: null, models: [], error: 'relayUnreachable', model: null };
  }
}

export async function saveCopilotModel(model: string): Promise<boolean> {
  try {
    const res = await relayFetch('/relay/copilot', { method: 'PUT', extraHeaders: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteCopilotSettings(): Promise<boolean> {
  try {
    return (await relayFetch('/relay/copilot', { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

/* ---------- Public material for pack generation (FR-311) ---------- */

export interface SitePageInfo {
  url: string;
  title: string;
  description: string;
  themeColor: string | null;
  text: string;
  fetchedAt: string;
}

/** The relay reads the official site (SSRF-guarded, server/site.ts). Throws RelayError with the relay's code. */
export async function fetchSitePages(url: string, signal?: AbortSignal): Promise<{ pages: SitePageInfo[]; failed: { url: string; error: string }[] }> {
  const res = await relayFetch('/relay/site', { method: 'POST', extraHeaders: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return (await res.json()) as { pages: SitePageInfo[]; failed: { url: string; error: string }[] };
}

export interface NewsHeadline {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

/** Company news headlines (metadata only) through the relay's news route. */
export async function fetchNewsHeadlines(company: string, lang: 'ja' | 'en', signal?: AbortSignal, topic?: string): Promise<{ provider: string; fetchedAt: string; articles: NewsHeadline[] }> {
  const res = await relayFetch('/relay/news', { method: 'POST', extraHeaders: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company, lang, ...(topic ? { topic, topicConfirmed: true } : {}) }), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return (await res.json()) as { provider: string; fetchedAt: string; articles: NewsHeadline[] };
}

/* ---------- Microsoft Work IQ (D-14, Microsoft Foundry only) ---------- */

const jsonInit = (method: string, body: unknown): RequestInit & { extraHeaders: Record<string, string> } => ({
  method, extraHeaders: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export type WorkIqSettingsInput = { method: 'cli' } | { method: 'app'; tenantId: string; clientId: string };

/** Saves the route: the Work IQ CLI, or the tenant and public-client app (client) ID. A change signs the user out in the relay. */
export async function saveWorkIqSettings(input: WorkIqSettingsInput): Promise<{ ok: true; workiq: WorkIqStatus } | { ok: false; error: string }> {
  try {
    const res = await relayFetch('/relay/workiq', jsonInit('PUT', input));
    if (!res.ok) return { ok: false, error: await errorCode(res) };
    const workiq = asWorkIq(((await res.json()) as { workiq?: unknown }).workiq);
    return workiq ? { ok: true, workiq } : { ok: false, error: 'failed' };
  } catch {
    return { ok: false, error: 'relayUnreachable' };
  }
}

export async function deleteWorkIqSettings(): Promise<boolean> {
  try {
    return (await relayFetch('/relay/workiq', { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

export interface WorkIqDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Starts the Microsoft Entra device-code sign-in in the relay (the device code itself stays there). */
export async function startWorkIqSignIn(): Promise<WorkIqDeviceCode> {
  const res = await relayFetch('/relay/workiq/signin', jsonInit('POST', {}));
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return (await res.json()) as WorkIqDeviceCode;
}

export async function pollWorkIqSignIn(): Promise<{ status: 'pending'; interval: number } | { status: 'signedIn'; account: string | null }> {
  const res = await relayFetch('/relay/workiq/signin/poll', jsonInit('POST', {}));
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return (await res.json()) as { status: 'pending'; interval: number } | { status: 'signedIn'; account: string | null };
}

export async function verifyWorkIq(): Promise<WorkIqStatus> {
  const res = await relayFetch('/relay/workiq/verify', {
    ...jsonInit('POST', { provider: 'foundry' }), signal: AbortSignal.timeout(125_000),
  });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const status = asWorkIq(((await res.json()) as { workiq?: unknown }).workiq);
  if (!status?.signedIn || !status.verifiedAt) throw new RelayError(502, 'badWorkiqResponse');
  return status;
}

/** The user's own acceptance of the Work IQ CLI EULA (the button sits next to the EULA link). */
export async function acceptWorkIqEula(): Promise<void> {
  const res = await relayFetch('/relay/workiq/eula', { ...jsonInit('POST', { provider: 'foundry', accept: true }), signal: AbortSignal.timeout(125_000) });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
}

export interface WorkIqQuestionInput {
  company: string;
  project: string;
  purpose: string;
  focus: string;
  asOf: string;
  lang: 'ja' | 'en';
  timeZone: string;
}

/** Sections the relay can search one by one (server/workiq.ts WORKIQ_ASPECTS). */
export const WORKIQ_ASPECTS = ['org', 'kpi', 'process', 'data', 'locations', 'people', 'engagements', 'issues'] as const;
export type WorkIqAspect = (typeof WORKIQ_ASPECTS)[number];

export type WorkIqSectionInfo = (WorkIqAnswerInfo & { key: string; searches?: string[] }) | { key: string; error: string };

function answerInfo(b: Partial<WorkIqAnswerInfo>): WorkIqAnswerInfo | null {
  if (typeof b.answer !== 'string' || typeof b.question !== 'string' || typeof b.fetchedAt !== 'string' || !Array.isArray(b.citations)) return null;
  return {
    question: b.question, answer: b.answer, fetchedAt: b.fetchedAt, sensitivity: typeof b.sensitivity === 'string' ? b.sensitivity : null,
    citations: b.citations.filter((c): c is { title: string; url: string } => typeof c?.title === 'string' && typeof c?.url === 'string'),
  };
}

/**
 * One Work IQ search per section and per follow-up topic. With `expand` the relay (Work IQ CLI route) also searches
 * every readiness ladder wording and answers one merged section per readiness item, listing those wordings in
 * `searches`. A failed section comes back as `{ key, error }`; the call itself fails only when none could run (sign-in,
 * permission, EULA, CLI missing).
 */
export async function askWorkIqSections(q: WorkIqQuestionInput & { aspects?: readonly WorkIqAspect[]; topics?: readonly string[]; expand?: boolean }, signal?: AbortSignal): Promise<WorkIqSectionInfo[]> {
  const res = await relayFetch('/relay/workiq/ask', { ...jsonInit('POST', { provider: 'foundry', ...q, aspects: q.aspects ?? [], topics: q.topics ?? [] }), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const b = (await res.json()) as { sections?: unknown };
  if (!Array.isArray(b.sections)) throw new RelayError(502, 'badRelayAnswer');
  return b.sections.flatMap((s): WorkIqSectionInfo[] => {
    if (!s || typeof s !== 'object' || typeof (s as { key?: unknown }).key !== 'string') return [];
    const key = (s as { key: string }).key;
    if (typeof (s as { error?: unknown }).error === 'string') return [{ key, error: (s as { error: string }).error }];
    const a = answerInfo(s as Partial<WorkIqAnswerInfo>);
    const searches = (s as { searches?: unknown }).searches;
    const listed = Array.isArray(searches) ? searches.filter((w): w is string => typeof w === 'string') : [];
    return a ? [{ key, ...a, ...(listed.length ? { searches: listed } : {}) }] : [{ key, error: 'badRelayAnswer' }];
  });
}

export interface WorkIqAnswerInfo {
  question: string;
  answer: string;
  citations: { title: string; url: string }[];
  sensitivity: string | null;
  fetchedAt: string;
}

/** One question to Work IQ through the relay, which refuses it unless the provider is Microsoft Foundry. */
export async function askWorkIq(q: WorkIqQuestionInput, signal?: AbortSignal): Promise<WorkIqAnswerInfo> {
  const res = await relayFetch('/relay/workiq/ask', { ...jsonInit('POST', { provider: 'foundry', ...q }), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const b = (await res.json()) as Partial<WorkIqAnswerInfo>;
  const a = answerInfo(b);
  if (!a) throw new RelayError(502, 'badRelayAnswer');
  return a;
}