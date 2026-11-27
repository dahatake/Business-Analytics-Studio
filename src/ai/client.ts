import type { Entity } from '../data/schema.ts';
import { appStorage as localStorage } from '../data/deviceStorage.ts';
import { loaded } from '../data/pack.ts';
import { currentScope } from '../state/projects.ts';
import { AI_LIMITS, aiMaxRequestChars, PER_USE_LIMITS, type AiUse, type Provider } from './policy.ts';
import { checkBudget, estimateTokens, type BudgetDecision, type UsageRecord } from './budget.ts';
import { evaluateGate, type GateReason } from './gate.ts';
import { selectOutbound, toPromptContext } from './redact.ts';
import type { MediaPart } from './attachments.ts';
import { appendAiPromptSuffix } from './promptSuffix.ts';

/** Input tokens assumed per media file before sending (a high-detail image is roughly 1,100 tokens; PDF pages add more). */
export const MEDIA_TOKEN_ESTIMATE = 1500;

export interface AiRequest {
  use: AiUse;
  lang: 'ja' | 'en';
  prompt: string;
  /** Data the feature wants to ground the answer in (D-2: internal items may be included). */
  entities?: Entity[];
  /** Some prompts already embed the exact grounding facts; omit the duplicate entity description context. */
  sendEntityContext?: boolean;
  /** Per-use output cap (e.g. PARAM-132: 4000 for presentations). */
  maxOutputTokens?: number;
  /** Per-use timeout in ms (e.g. PARAM-121: 60 s, PARAM-127: 90 s). */
  timeoutMs?: number;
  /** Ledger attribution: the work target the tokens are spent for. Omitted = the current target; null = app-level. */
  scope?: string | null;
  /** Ledger attribution: the sub-step inside the use (e.g. pack generation stage). */
  stage?: string;
  /** Attached files the selected model reads natively (images, PDF); text files belong in the prompt. */
  media?: MediaPart[];
}

export interface TokenCount {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiResponse {
  /** 'mock' answers must be labelled as mock in the UI (FR-011, NFR-LEGAL-002). */
  mode: 'mock' | 'live';
  text: string;
  /** Why a live send did not happen (empty for live answers). */
  blockedReasons: GateReason[];
  withheldIds: string[];
  context: string;
  /** Tokens the provider reported for a live answer (mock answers send nothing and have none). */
  usage?: TokenCount;
}

export interface AiRuntimeSettings {
  /** The provider the relay sends to (D-12). Omitted = Foundry, the only provider before D-12. */
  provider?: Provider;
  liveEnabled: boolean;
  configured: boolean;
  /** One-time consent saved in AI settings for data included in AI requests. */
  sendConsent?: boolean;
}

/** What the browser hands to the transport (the localhost relay). */
export interface LiveCall {
  use: AiUse;
  provider: Provider;
  lang: 'ja' | 'en';
  prompt: string;
  context: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Files sent natively to a model that reads them (see src/ai/attachments.ts). */
  media?: MediaPart[];
  /** The sub-step (e.g. the batch job id), forwarded to the relay's diagnostics log of a failed call. */
  stage?: string;
}

export interface LiveResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type LiveTransport = (call: LiveCall, signal?: AbortSignal) => Promise<LiveResult>;

export const LEDGER_KEY = 'bas.ai.ledger';

export function readLedger(): UsageRecord[] {
  try {
    return JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]') as UsageRecord[];
  } catch {
    return [];
  }
}

export function writeLedger(ledger: UsageRecord[]) {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
}

export function appendLedger(record: UsageRecord) {
  writeLedger([...readLedger(), record]);
}

/** Moves records made under a temporary scope (e.g. a pack generation run) to the project they were spent for. */
export function rebindLedgerScope(from: string, to: string) {
  const ledger = readLedger();
  if (ledger.some((r) => r.scope === from)) writeLedger(ledger.map((r) => (r.scope === from ? { ...r, scope: to } : r)));
}

export type MockFn = (req: AiRequest, context: string) => string;
interface MockEntry {
  fn: MockFn;
  /** Optional matcher so several modules can share a use (e.g. ink's handwriting import vs. AI import). */
  when?: (req: AiRequest) => boolean;
}
const mocks = new Map<AiUse, MockEntry[]>();

/** Feature modules register deterministic mock answers per use. Matchers are tried first, then the plain fallback. */
export function registerMock(use: AiUse, fn: MockFn, when?: (req: AiRequest) => boolean) {
  const list = (mocks.get(use) ?? []).filter((m) => (when ? m.when !== when : m.when !== undefined));
  list.push(when ? { fn, when } : { fn });
  mocks.set(use, list);
}

function pickMock(req: AiRequest): MockFn | undefined {
  const list = mocks.get(req.use) ?? [];
  return (list.find((m) => m.when?.(req)) ?? list.find((m) => !m.when))?.fn;
}

let runtime: () => AiRuntimeSettings = () => ({ liveEnabled: false, configured: false });
/** The AI settings module provides the user's live switch and connection state. */
export function setRuntimeSettingsProvider(fn: () => AiRuntimeSettings) {
  runtime = fn;
}

let transport: LiveTransport | null = null;
/** The AI module provides the transport (browser → localhost relay → provider). Tests can inject a stub. */
export function setLiveTransport(fn: LiveTransport | null) {
  transport = fn;
}

export interface Preflight {
  allowed: boolean;
  reasons: GateReason[];
  budget: BudgetDecision;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  internalCount: number;
  personCount: number;
  context: string;
}

export function aiRequestLength(req: Pick<AiRequest, 'prompt'>, context = ''): number {
  return req.prompt.length + context.length;
}

export function aiRequestFits(req: Pick<AiRequest, 'use' | 'prompt'>, context = ''): boolean {
  return aiRequestLength(req, context) <= aiMaxRequestChars(req.use);
}

/** Send context prepared by callers; broad one-time permission is captured in AI settings. */
export function preflight(req: AiRequest, now = new Date()): Preflight {
  const selection = selectOutbound(req.entities ?? [], loaded.byId);
  const context = req.sendEntityContext === false ? '' : toPromptContext(selection, req.lang);
  const settings = runtime();
  const maxOutputTokens = req.maxOutputTokens ?? PER_USE_LIMITS[req.use]?.maxOutputTokens ?? AI_LIMITS.maxOutputTokens;
  const estimatedInputTokens = estimateTokens(appendAiPromptSuffix(req.prompt + context)) + (req.media?.length ?? 0) * MEDIA_TOKEN_ESTIMATE;
  const budgetInputTokens = estimateTokens(req.prompt + context) + (req.media?.length ?? 0) * MEDIA_TOKEN_ESTIMATE;
  const budget = checkBudget(readLedger(), now, { use: req.use, estimatedInputTokens: budgetInputTokens, maxOutputTokens });
  const gate = evaluateGate({
    liveEnabled: settings.liveEnabled,
    sendConsent: settings.sendConsent ?? false,
    configured: settings.configured,
    budget,
  });
  if (!aiRequestFits(req, context)) {
    gate.allowed = false;
    gate.reasons = [...gate.reasons.filter((reason) => reason !== 'inputTooLarge'), 'inputTooLarge'];
  }
  return {
    allowed: gate.allowed,
    reasons: gate.reasons,
    budget,
    estimatedInputTokens,
    maxOutputTokens,
    internalCount: selection.internalCount,
    personCount: selection.personCount,
    context,
  };
}

/**
 * The only entry point for generative AI. It evaluates the global consent gate; when every condition holds it sends through the
 * relay transport and records the reported tokens in the ledger. Otherwise (or when the live call fails) it answers with the
 * registered mock and reports why.
 */
export async function aiComplete(req: AiRequest): Promise<AiResponse> {
  const pf = preflight(req);
  const mockAnswer = (reasons: GateReason[]): AiResponse => {
    const mock = pickMock(req);
    const text = mock ? mock(req, pf.context) : `[mock] ${req.prompt.slice(0, 80)}`;
    return { mode: 'mock', text, blockedReasons: reasons, withheldIds: [], context: pf.context };
  };
  if (!pf.allowed) return mockAnswer(pf.reasons);
  if (!transport) return mockAnswer(['liveFailed']);
  try {
    const live = await sendLive(req, pf);
    return {
      mode: 'live', text: live.text, blockedReasons: [], withheldIds: [], context: pf.context,
      usage: { inputTokens: live.inputTokens, outputTokens: live.outputTokens },
    };
  } catch {
    return mockAnswer(['liveFailed']);
  }
}

/** Limit for a live call that does not set its own timeoutMs. */
export const DEFAULT_LIVE_TIMEOUT_MS = 60_000;

async function sendLive(req: AiRequest, pf: Preflight, signal?: AbortSignal): Promise<LiveResult> {
  const settings = runtime();
  const provider = settings.provider ?? 'foundry';
  const scope = req.scope === undefined ? currentScope() : req.scope;
  const attribution = { provider, ...(scope !== null ? { scope } : {}), ...(req.stage ? { stage: req.stage } : {}) };
  let result: LiveResult;
  try {
    result = await transport!({
      use: req.use,
      provider,
      lang: req.lang,
      prompt: req.prompt,
      context: pf.context,
      maxOutputTokens: pf.maxOutputTokens,
      timeoutMs: req.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS,
      ...(req.media?.length ? { media: req.media } : {}),
      ...(req.stage ? { stage: req.stage } : {}),
    }, signal);
  } catch (err) {
    const failed = failedUsage(err);
    // A failed answer the provider still billed (e.g. cut off at the output cap) is recorded with its reported tokens.
    if (failed) {
      appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: failed.inputTokens, outputTokens: failed.outputTokens, ...attribution, failed: failed.code });
    } else if (mayHaveBeenBilled(err, signal)) {
      // A cancelled or timed-out call may have consumed tokens; record the app's estimate, marked as such.
      appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: pf.estimatedInputTokens, outputTokens: 0, ...attribution, estimated: true });
    }
    throw err;
  }
  appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ...attribution });
  return result;
}

function failedUsage(err: unknown): { code: string; inputTokens: number | null; outputTokens: number | null } | null {
  const e = err as { code?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown } } | null;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const inputTokens = count(e?.usage?.inputTokens);
  const outputTokens = count(e?.usage?.outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { code: typeof e?.code === 'string' ? e.code : 'failed', inputTokens, outputTokens };
}

/** Cancelled by the user, timed out in the browser, or the relay reported a provider timeout/abort (504/499). */
function mayHaveBeenBilled(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const e = err as { name?: unknown; status?: unknown };
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.status === 504 || e?.status === 499;
}

/** Why a strict live call did not produce an answer. */
export class AiLiveError extends Error {
  readonly reasons: GateReason[];
  readonly budget?: BudgetDecision;

  constructor(reasons: GateReason[], message: string, budget?: BudgetDecision, cause?: unknown) {
    super(message, { cause });
    this.reasons = reasons;
    this.budget = budget;
  }
}

/** The relay's error code behind a failed live call (for example 'outputLimit'), if it reported one. */
export function liveErrorCode(err: unknown): string | null {
  const cause = err instanceof AiLiveError ? (err.cause as { code?: unknown } | undefined) : (err as { code?: unknown } | null);
  return typeof cause?.code === 'string' ? cause.code : null;
}

/**
 * Live only, never a mock: for features whose result is stored as real data (FR-311 Project pack generation), a mock
 * answer would be wrong data. Same gate, safety limits and usage log as aiComplete; a refusal or failure throws AiLiveError.
 */
export async function aiLive(req: AiRequest, signal?: AbortSignal): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  const pf = preflight(req);
  if (!pf.allowed) throw new AiLiveError(pf.reasons, `blocked: ${pf.reasons.join(', ')}`, pf.budget);
  if (!transport) throw new AiLiveError(['liveFailed'], 'no transport');
  try {
    const r = await sendLive(req, pf, signal);
    return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } catch (err) {
    throw new AiLiveError(['liveFailed'], signal?.aborted ? 'aborted' : (err as Error).message, undefined, err);
  }
}
