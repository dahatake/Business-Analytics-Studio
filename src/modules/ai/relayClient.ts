import type { LiveCall, LiveResult, LiveTransport } from '../../ai/client.ts';
import { isMediaType, type MediaCapability } from '../../ai/attachments.ts';
import { CONNECTION_INPUT_ERRORS, CONNECTION_TEST_TIMEOUT_MS, FOUNDRY_ERRORS, type ConnectionInputError, type FoundryError } from '../../ai/foundry.ts';
import { MEDIA_TEST_TIMEOUT_MS, SPEECH_INPUT_ERRORS, type MediaService, type MediaUnavailable, type SpeechRoute } from '../../ai/mediaConnection.ts';
import { DECISION_INPUT_ERRORS, DECISION_TEST_TIMEOUT_MS, DECISION_TIMEOUT_MS, type DecisionRequest, type DecisionResult } from '../../ai/decision.ts';

/** Browser side of the localhost relay (FR-011). Secret values only travel in PUT bodies and are never read back. */
export type SecretName = 'foundryKey';
export type KeyProtection = 'dpapi' | 'file';

/** Non-secret connection held by the relay (endpoint origin, deployment, API version, and how it authenticates). */
export interface RelayConnectionInfo {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  /** Absent means API key. */
  auth?: 'apiKey' | 'entraId';
  /** The tenant of the Foundry resource (Entra ID only). */
  tenantId?: string | null;
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
  /** Microsoft Entra ID sign-in for Microsoft Foundry (the token cache stays in the relay vault). */
  entra: EntraStatus | null;
  /** FR-324/FR-328: Azure AI Speech / Azure AI Vision through the Foundry connection. */
  media: MediaStatus;
  /** FR-329: whether Speech uses the Foundry connection or a separate Speech resource. */
  speechConnection: SpeechConnectionStatus;
  /** D-44: Microsoft Foundry Decision model on its own resource; `verifiedAt` is null once the key changes. */
  decision: DecisionStatus | null;
}

export interface DecisionStatus { endpoint: string; deployment: string; verifiedAt: string | null }

function asDecision(v: unknown): DecisionStatus | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const endpoint = str(d.endpoint);
  const deployment = str(d.deployment);
  return endpoint && deployment ? { endpoint, deployment, verifiedAt: str(d.verifiedAt) } : null;
}

/**
 * `eligible`: the Foundry connection and Speech on it are verified now, so the separate route may be chosen. `route` is
 * the saved choice as is; `separate.verifiedAt` is null until its test passes and again when its key or sign-in changes.
 */
export interface SpeechConnectionStatus {
  route: SpeechRoute;
  eligible: boolean;
  separate: { auth: 'apiKey' | 'entraId'; endpoint: string | null; region: string | null; verifiedAt: string | null } | null;
}
export const NO_SPEECH_CONNECTION: SpeechConnectionStatus = { route: 'foundry', eligible: false, separate: null };

/**
 * Speech / Vision use the saved Foundry connection: `endpoint` is the resource's `cognitiveservices.azure.com` host, or
 * null with the reason; a service's time is null until its test passes and again whenever the Foundry endpoint, key,
 * tenant or Entra account changes.
 */
export interface MediaStatus {
  endpoint: string | null;
  auth: 'apiKey' | 'entraId' | null;
  unavailable: MediaUnavailable | null;
  verifiedAt: Record<MediaService, string | null>;
}
export const NO_MEDIA: MediaStatus = { endpoint: null, auth: null, unavailable: 'noConnection', verifiedAt: { speech: null, vision: null } };

export interface EntraStatus {
  signedIn: boolean;
  account: string | null;
  tenantId: string | null;
  signIn: 'idle' | 'pending' | 'signedIn' | 'failed';
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

const UNREACHABLE: RelayStatus = { reachable: false, secrets: { foundryKey: false }, connection: null, connectionVerifiedAt: null, keyProtection: null, copilot: null, workiq: null, entra: null,
  media: NO_MEDIA, speechConnection: NO_SPEECH_CONNECTION, decision: null };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function asSpeechConnection(v: unknown): SpeechConnectionStatus {
  if (!v || typeof v !== 'object') return NO_SPEECH_CONNECTION;
  const o = v as Record<string, unknown>;
  const s = o.separate && typeof o.separate === 'object' ? (o.separate as Record<string, unknown>) : null;
  const separate = s && (s.auth === 'apiKey' || s.auth === 'entraId')
    ? { auth: s.auth === 'entraId' ? 'entraId' as const : 'apiKey' as const, endpoint: str(s.endpoint), region: str(s.region), verifiedAt: str(s.verifiedAt) }
    : null;
  return { route: o.route === 'separate' && separate ? 'separate' : 'foundry', eligible: o.eligible === true, separate };
}

function asMedia(v: unknown): MediaStatus {
  if (!v || typeof v !== 'object') return NO_MEDIA;
  const m = v as Record<string, unknown>;
  const endpoint = str(m.endpoint);
  if (!endpoint) return { ...NO_MEDIA, unavailable: m.unavailable === 'unsupportedHost' ? 'unsupportedHost' : 'noConnection' };
  return { endpoint, auth: m.auth === 'entraId' ? 'entraId' : 'apiKey', unavailable: null, verifiedAt: { speech: str(m.speech), vision: str(m.vision) } };
}

function asEntra(v: unknown): EntraStatus | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as { signedIn?: unknown; account?: unknown; tenantId?: unknown; signIn?: { status?: unknown } };
  const s = e.signIn?.status;
  return {
    signedIn: e.signedIn === true,
    account: typeof e.account === 'string' ? e.account : null,
    tenantId: typeof e.tenantId === 'string' ? e.tenantId : null,
    signIn: s === 'pending' || s === 'signedIn' || s === 'failed' ? s : 'idle',
  };
}

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
  if (typeof c.endpoint !== 'string' || typeof c.deployment !== 'string' || typeof c.apiVersion !== 'string') return null;
  const base = { endpoint: c.endpoint, deployment: c.deployment, apiVersion: c.apiVersion };
  return c.auth === 'entraId' && typeof c.tenantId === 'string' ? { ...base, auth: 'entraId', tenantId: c.tenantId } : base;
}

export async function fetchRelayStatus(): Promise<RelayStatus> {
  try {
    const res = await relayFetch('/relay/status');
    if (!res.ok) return UNREACHABLE;
    const body = (await res.json()) as { secrets?: Partial<Record<SecretName, boolean>>; connection?: unknown; connectionVerifiedAt?: unknown; keyProtection?: unknown; copilot?: { model?: unknown } | null; workiq?: unknown; entra?: unknown; media?: unknown; speechConnection?: unknown; decision?: unknown };
    return {
      reachable: true,
      secrets: { foundryKey: body.secrets?.foundryKey === true },
      connection: asConnection(body.connection),
      connectionVerifiedAt: typeof body.connectionVerifiedAt === 'string' ? body.connectionVerifiedAt : null,
      keyProtection: body.keyProtection === 'dpapi' || body.keyProtection === 'file' ? body.keyProtection : null,
      copilot: typeof body.copilot?.model === 'string' ? { model: body.copilot.model } : null,
      workiq: asWorkIq(body.workiq),
      entra: asEntra(body.entra),
      media: asMedia(body.media),
      speechConnection: asSpeechConnection(body.speechConnection),
      decision: asDecision(body.decision),
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

export type ConnectionSaveError = ConnectionInputError | FoundryError | 'hostNotAllowed' | 'outboundNotAllowed' | 'keyMissing' | 'keyChanged' | 'tooSoon' | 'budget'
  | 'notSignedIn' | 'interactionRequired' | 'authFailed' | 'accountChanged' | 'invalidTenant' | 'failed';
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
    const known: ConnectionSaveError[] = [...CONNECTION_INPUT_ERRORS, ...FOUNDRY_ERRORS, 'hostNotAllowed', 'outboundNotAllowed', 'keyMissing', 'keyChanged', 'tooSoon',
      'notSignedIn', 'interactionRequired', 'authFailed', 'accountChanged', 'invalidTenant'];
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

/** Asks the relay whether it would forward a call (refusals list shared consent, connection, and budget reasons). */
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
  readonly retryAfterMs?: number;

  constructor(status: number, code: string, retryAfterMs?: number) {
    super(`relay ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

async function errorDetails(res: Response): Promise<{ code: string; retryAfterMs?: number }> {
  try {
    const body = (await res.json()) as { error?: unknown; reasons?: unknown; retryAfterMs?: unknown };
    const code = typeof body.error === 'string' ? body.error
      : Array.isArray(body.reasons) && typeof body.reasons[0] === 'string' ? body.reasons[0] : 'unknown';
    const retryAfterMs = body.retryAfterMs;
    return { code, ...(code === 'providerBusy' && typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 604_800_000 ? { retryAfterMs } : {}) };
  } catch {
    return { code: 'unknown' };
  }
}

async function errorCode(res: Response): Promise<string> {
  return (await errorDetails(res)).code;
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
        ...(call.media?.length ? { media: call.media } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const { code, retryAfterMs } = await errorDetails(res);
      throw new RelayError(res.status, code, retryAfterMs);
    }
    const body = (await res.json()) as Partial<LiveResult>;
    const validTokens = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (typeof body.text !== 'string' || !validTokens(body.inputTokens) || !validTokens(body.outputTokens)) throw new RelayError(502, 'badRelayAnswer');
    return {
      text: body.text, inputTokens: body.inputTokens, outputTokens: body.outputTokens,
      ...(typeof body.costJpy === 'number' && Number.isFinite(body.costJpy) && body.costJpy >= 0 ? { costJpy: body.costJpy } : {}),
      ...(typeof body.premiumRequests === 'number' && body.premiumRequests >= 0 ? { premiumRequests: body.premiumRequests } : {}),
    };

  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

export interface StoryQuote {
  maximumJpy: number;
  remainingJpy: number;
  source: string;
  expiresAt: string;
}

export async function fetchStoryQuote(call: LiveCall, signal?: AbortSignal): Promise<StoryQuote> {
  const res = await relayFetch('/relay/story/estimate', {
    method: 'POST', extraHeaders: { 'Content-Type': 'application/json' },
    body: JSON.stringify(call), signal,
  });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const body = await res.json() as Partial<StoryQuote>;
  if (typeof body.maximumJpy !== 'number' || !Number.isFinite(body.maximumJpy) || body.maximumJpy <= 0 ||
      typeof body.remainingJpy !== 'number' || !Number.isFinite(body.remainingJpy) ||
      typeof body.source !== 'string' || typeof body.expiresAt !== 'string') throw new RelayError(502, 'badRelayAnswer');
  return { maximumJpy: body.maximumJpy, remainingJpy: body.remainingJpy, source: body.source, expiresAt: body.expiresAt };
}

/* ---------- GitHub Copilot (D-12) ---------- */

export interface CopilotModelInfo {
  id: string;
  name: string;
  multiplier: number | null;
  /** Files the model reads natively, as the Copilot runtime reports them (null: text only). */
  media?: MediaCapability | null;
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

const readMedia = (v: unknown): MediaCapability | null => {
  const m = v as Partial<MediaCapability> | null | undefined;
  if (!m || !Array.isArray(m.types) || typeof m.maxFiles !== 'number' || typeof m.maxBytes !== 'number') return null;
  const types = m.types.filter(isMediaType);
  return types.length ? { types, maxFiles: m.maxFiles, maxBytes: m.maxBytes } : null;
};

/** Starts the Copilot runtime in the relay if needed and reports the CLI sign-in and the models it offers. */
export async function fetchCopilotStatus(): Promise<CopilotStatusInfo> {
  try {
    const res = await relayFetch('/relay/copilot/status', { method: 'POST', extraHeaders: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) return { reachable: false, available: false, authenticated: false, login: null, models: [], error: await errorCode(res), model: null };
    const b = (await res.json()) as Partial<CopilotStatusInfo> & { settings?: { model?: unknown } | null };
    const models = Array.isArray(b.models)
      ? b.models.filter((m): m is CopilotModelInfo => typeof m?.id === 'string').map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, multiplier: typeof m.multiplier === 'number' ? m.multiplier : null, media: readMedia(m.media) }))
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
  /** The project-purpose terms the link to this page named. */
  purposeTerms?: string[];
}

/**
 * The relay reads the official site (SSRF-guarded, server/site.ts). `terms` (the project purpose's terms) only rank the
 * site's links in the relay; they are not sent to the site. Throws RelayError with the relay's code.
 */
export async function fetchSitePages(url: string, signal?: AbortSignal, terms: readonly string[] = []): Promise<{ pages: SitePageInfo[]; failed: { url: string; error: string }[] }> {
  const res = await relayFetch('/relay/site', { method: 'POST', extraHeaders: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, ...(terms.length ? { terms } : {}) }), signal });
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

/* ---------- Microsoft Entra ID for Microsoft Foundry ---------- */

const jsonInit = (method: string, body: unknown): RequestInit & { extraHeaders: Record<string, string> } => ({
  method, extraHeaders: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export interface FoundryInstanceInfo {
  id: string;
  name: string;
  kind: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  subscriptionName: string;
  tenantId: string;
  /** `null` when the resource has no custom subdomain, which Entra ID requires. */
  endpoint: string | null;
  keyAuthDisabled: boolean;
}
export interface FoundryTenantInfo { tenantId: string; name: string; signedIn: boolean }
export interface FoundryDeploymentDetail { name: string; model: string; version: string; sku: string }
export interface FoundryInstanceDetail { deployments: FoundryDeploymentDetail[]; access: { canCall: boolean; canAssign: boolean } }

export async function fetchEntraStatus(): Promise<EntraStatus | null> {
  try {
    const res = await relayFetch('/relay/entra');
    return res.ok ? asEntra(((await res.json()) as { entra?: unknown }).entra) : null;
  } catch {
    return null;
  }
}

/** Starts the browser sign-in in the relay; returns the Microsoft sign-in URL to open (the redirect goes to the relay). */
export async function startEntraSignIn(tenantId?: string): Promise<{ url: string | null }> {
  const res = await relayFetch('/relay/entra/signin', { ...jsonInit('POST', tenantId ? { tenantId } : {}), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const url = ((await res.json()) as { url?: unknown }).url;
  return { url: typeof url === 'string' && url.startsWith('https://login.microsoftonline.com/') ? url : null };
}

export async function signOutEntra(): Promise<boolean> {
  try {
    return (await relayFetch('/relay/entra', { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

export async function listEntraTenants(signal?: AbortSignal): Promise<FoundryTenantInfo[]> {
  const res = await relayFetch('/relay/entra/tenants', { ...jsonInit('POST', {}), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return ((await res.json()) as { tenants: FoundryTenantInfo[] }).tenants;
}

export async function listEntraInstances(tenantId: string, signal?: AbortSignal): Promise<FoundryInstanceInfo[]> {
  const res = await relayFetch('/relay/entra/instances', { ...jsonInit('POST', { tenantId }), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return ((await res.json()) as { instances: FoundryInstanceInfo[] }).instances;
}

export async function inspectEntraInstance(resourceId: string, tenantId: string, signal?: AbortSignal): Promise<FoundryInstanceDetail> {
  const res = await relayFetch('/relay/entra/inspect', { ...jsonInit('POST', { resourceId, tenantId }), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return (await res.json()) as FoundryInstanceDetail;
}

/** Grants the signed-in user Cognitive Services OpenAI User on the Foundry resource (needs Owner or User Access Administrator). */
export async function assignEntraRole(resourceId: string, tenantId: string): Promise<FoundryInstanceDetail> {
  const res = await relayFetch('/relay/entra/role', { ...jsonInit('POST', { resourceId, tenantId }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return (await res.json()) as FoundryInstanceDetail;
}

/* ---------- Azure AI Speech / Azure AI Vision through the Foundry connection (FR-324, FR-328) ---------- */

export const MEDIA_TEST_ERRORS = ['noConnection', 'unsupportedHost', 'hostNotAllowed', 'outboundNotAllowed', 'keyMissing', 'keyChanged', 'accountChanged', 'connectionChanged',
  'tooSoon', 'notSignedIn', 'interactionRequired', 'authFailed', 'unauthorized', 'forbidden', 'invalidApiRequest', 'providerBusy', 'providerError', 'badProviderResponse',
  'timeout', 'networkError', 'aborted'] as const;
export type MediaTestError = (typeof MEDIA_TEST_ERRORS)[number] | 'failed';
export type MediaTestResult = { ok: true; verifiedAt: string } | { ok: false; error: MediaTestError; providerStatus?: number };

/** The relay calls the service on the Foundry resource with the Foundry key or Entra token and seals the result. */
export async function testMediaConnection(service: MediaService): Promise<MediaTestResult> {
  try {
    const res = await relayFetch(`/relay/media/${service}`, { ...jsonInit('PUT', {}), signal: AbortSignal.timeout(MEDIA_TEST_TIMEOUT_MS + 15_000) });
    const body = (await res.json()) as { error?: string; providerStatus?: number; verifiedAt?: unknown };
    if (res.ok && typeof body.verifiedAt === 'string') return { ok: true, verifiedAt: body.verifiedAt };
    return { ok: false, error: MEDIA_TEST_ERRORS.find((k) => k === body.error) ?? 'failed', ...(typeof body.providerStatus === 'number' ? { providerStatus: body.providerStatus } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failed' };
  }
}

/** Forgets a service's check (the Foundry connection itself is untouched). */
export async function clearMediaCheck(service: MediaService): Promise<boolean> {
  try {
    return (await relayFetch(`/relay/media/${service}`, { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

/** Microsoft Entra ID: the Foundry resource behind the connection and whether the user may call this service on it. */
export interface MediaAccess { resource: { id: string; name: string; kind: string }; access: { canCall: boolean; canAssign: boolean } }

/** Checks (`access`) or grants (`role`: Cognitive Services Speech User / Cognitive Services User) the data-plane role. */
export async function mediaAccess(service: MediaService, action: 'access' | 'role'): Promise<MediaAccess> {
  const res = await relayFetch(`/relay/media/${service}/${action}`, { ...jsonInit('POST', {}), signal: AbortSignal.timeout(action === 'role' ? 60_000 : 30_000) });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  return (await res.json()) as MediaAccess;
}

/* ---------- FR-329: Speech on a separate Azure AI Speech resource ---------- */

export const SPEECH_SEPARATE_ERRORS = [...SPEECH_INPUT_ERRORS, ...MEDIA_TEST_ERRORS, 'notEligible', 'notEntra', 'separateNotVerified'] as const;
export type SpeechSeparateError = (typeof SPEECH_SEPARATE_ERRORS)[number] | 'failed';
export type SpeechSeparateResult = { ok: true; status: SpeechConnectionStatus } | { ok: false; error: SpeechSeparateError; providerStatus?: number };
export interface SeparateSpeechInput { auth: 'apiKey' | 'entraId'; endpoint?: string; region?: string; key?: string }

async function speechCall(url: string, init: RequestInit): Promise<SpeechSeparateResult> {
  try {
    const res = await relayFetch(url, init);
    const body = (await res.json()) as { error?: string; providerStatus?: number };
    if (res.ok) return { ok: true, status: asSpeechConnection(body) };
    return { ok: false, error: SPEECH_SEPARATE_ERRORS.find((k) => k === body.error) ?? 'failed', ...(typeof body.providerStatus === 'number' ? { providerStatus: body.providerStatus } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failed' };
  }
}

/** Tests the separate resource; only a passing test saves it (and its key, in the vault) and switches Speech to it. */
export function saveSeparateSpeech(input: SeparateSpeechInput): Promise<SpeechSeparateResult> {
  return speechCall('/relay/speech/separate', { ...jsonInit('PUT', input), signal: AbortSignal.timeout(MEDIA_TEST_TIMEOUT_MS + 15_000) });
}

export function setSpeechRoute(route: SpeechRoute): Promise<SpeechSeparateResult> {
  return speechCall('/relay/speech/route', { ...jsonInit('PUT', { route }), signal: AbortSignal.timeout(15_000) });
}

/** Deletes the separate connection and its key; Speech goes back to the Foundry connection. */
export function deleteSeparateSpeech(): Promise<SpeechSeparateResult> {
  return speechCall('/relay/speech/separate', { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
}

/* ---------- D-44: Microsoft Foundry Decision model ---------- */

export const DECISION_SAVE_ERRORS = [...DECISION_INPUT_ERRORS, ...FOUNDRY_ERRORS, 'hostNotAllowed', 'outboundNotAllowed', 'keyMissing', 'keyChanged', 'tooSoon'] as const;
export type DecisionSaveError = (typeof DECISION_SAVE_ERRORS)[number] | 'failed';
export type DecisionSaveResult = { ok: true; decision: DecisionStatus | null; usage?: { inputTokens: number; outputTokens: number } } | { ok: false; error: DecisionSaveError; providerStatus?: number };
export interface DecisionInput { endpoint: string; deployment: string; key?: string }

async function decisionCall(url: string, init: RequestInit): Promise<DecisionSaveResult> {
  try {
    const res = await relayFetch(url, init);
    const body = (await res.json()) as { decision?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown }; error?: string; providerStatus?: number };
    if (res.ok) {
      const u = body.usage;
      const usage = u && typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number' ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : undefined;
      return { ok: true, decision: asDecision(body.decision), ...(usage ? { usage } : {}) };
    }
    return { ok: false, error: DECISION_SAVE_ERRORS.find((k) => k === body.error) ?? 'failed', ...(typeof body.providerStatus === 'number' ? { providerStatus: body.providerStatus } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failed' };
  }
}

/** Runs a synthetic Decision question in the relay; only a passing test saves the connection (and its key, in the vault). */
export function saveDecisionConnection(input: DecisionInput): Promise<DecisionSaveResult> {
  return decisionCall('/relay/decision', { ...jsonInit('PUT', input), signal: AbortSignal.timeout(DECISION_TEST_TIMEOUT_MS + 5_000) });
}

export function deleteDecisionConnection(): Promise<DecisionSaveResult> {
  return decisionCall('/relay/decision', { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
}

/** One Decision request through the relay. Throws RelayError with the relay's code on any failure. */
export async function decisionScreen(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
  const timeout = AbortSignal.timeout(DECISION_TIMEOUT_MS + 5_000);
  const res = await relayFetch('/relay/decision/screen', { ...jsonInit('POST', req), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const body = (await res.json()) as Partial<DecisionResult>;
  if (!body.answers || typeof body.inputTokens !== 'number' || typeof body.outputTokens !== 'number') throw new RelayError(502, 'badProviderResponse');
  return { answers: body.answers, inputTokens: body.inputTokens, outputTokens: body.outputTokens };
}
/* ---------- Microsoft Work IQ (D-14: Microsoft Foundry, or GitHub Copilot by choice) ---------- */

/** The provider the Work IQ material goes to; the relay refuses any other. */
export type WorkIqProvider = 'foundry' | 'copilotSdk';

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

export async function verifyWorkIq(provider: WorkIqProvider = 'foundry'): Promise<WorkIqStatus> {
  const res = await relayFetch('/relay/workiq/verify', {
    ...jsonInit('POST', { provider }), signal: AbortSignal.timeout(330_000),
  });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const status = asWorkIq(((await res.json()) as { workiq?: unknown }).workiq);
  if (!status?.signedIn || !status.verifiedAt) throw new RelayError(502, 'badWorkiqResponse');
  return status;
}

/** The user's own acceptance of the Work IQ CLI EULA (the button sits next to the EULA link). */
export async function acceptWorkIqEula(provider: WorkIqProvider = 'foundry'): Promise<void> {
  const res = await relayFetch('/relay/workiq/eula', { ...jsonInit('POST', { provider, accept: true }), signal: AbortSignal.timeout(125_000) });
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
  /** FR-341: the business unit of a kpiUnit search. */
  unit?: string;
}

/** Sections the relay can search one by one (server/workiq.ts WORKIQ_ASPECTS). */
export const WORKIQ_ASPECTS = ['org', 'kpi', 'process', 'data', 'locations', 'people', 'engagements', 'issues', 'kpiCompany', 'kpiUnit'] as const;
export type WorkIqAspect = (typeof WORKIQ_ASPECTS)[number];

export type WorkIqSectionInfo = (WorkIqAnswerInfo & { key: string; searches?: string[]; deepRead?: { files: number; followUp?: boolean; error?: string } }) | { key: string; error: string };

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
export async function askWorkIqSections(q: WorkIqQuestionInput & { aspects?: readonly WorkIqAspect[]; topics?: readonly string[]; expand?: boolean; provider?: WorkIqProvider }, signal?: AbortSignal): Promise<WorkIqSectionInfo[]> {
  const res = await relayFetch('/relay/workiq/ask', { ...jsonInit('POST', { ...q, provider: q.provider ?? 'foundry', aspects: q.aspects ?? [], topics: q.topics ?? [] }), signal });
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
    const dr = (s as { deepRead?: { files?: unknown; followUp?: unknown; error?: unknown } }).deepRead;
    const deepRead = dr && typeof dr.files === 'number' && Number.isInteger(dr.files) && dr.files > 0
      ? { files: dr.files, ...(dr.followUp === true ? { followUp: true } : {}), ...(typeof dr.error === 'string' ? { error: dr.error.slice(0, 60) } : {}) } : null;
    return a ? [{ key, ...a, ...(listed.length ? { searches: listed } : {}), ...(deepRead ? { deepRead } : {}) }] : [{ key, error: 'badRelayAnswer' }];
  });
}

export interface WorkIqAnswerInfo {
  question: string;
  answer: string;
  citations: { title: string; url: string }[];
  sensitivity: string | null;
  fetchedAt: string;
}

/** One question to Work IQ through the relay, which refuses it unless the provider may use Work IQ (D-14). */
export async function askWorkIq(q: WorkIqQuestionInput & { provider?: WorkIqProvider }, signal?: AbortSignal): Promise<WorkIqAnswerInfo> {
  const res = await relayFetch('/relay/workiq/ask', { ...jsonInit('POST', { ...q, provider: q.provider ?? 'foundry' }), signal });
  if (!res.ok) throw new RelayError(res.status, await errorCode(res));
  const b = (await res.json()) as Partial<WorkIqAnswerInfo>;
  const a = answerInfo(b);
  if (!a) throw new RelayError(502, 'badRelayAnswer');
  return a;
}