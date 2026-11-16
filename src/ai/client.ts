import type { Entity } from '../data/schema.ts';
import { appStorage as localStorage } from '../data/deviceStorage.ts';
import { loaded } from '../data/pack.ts';
import { currentScope } from '../state/projects.ts';
import { AI_LIMITS, PER_USE_LIMITS, type AiUse, type Limits, type Provider } from './policy.ts';
import { actualCostJpy, checkBudget, estimateCostJpy, estimateTokens, type BudgetDecision, type UnitPrices, type UsageRecord } from './budget.ts';
import { evaluateGate, type GateReason } from './gate.ts';
import { selectOutbound, toPromptContext } from './redact.ts';
import type { MediaPart } from './attachments.ts';

/** Input tokens assumed per media file before sending (a high-detail image is roughly 1,100 tokens; PDF pages add more). */
export const MEDIA_TOKEN_ESTIMATE = 1500;

export interface AiRequest {
  use: AiUse;
  lang: 'ja' | 'en';
  prompt: string;
  /** Data the feature wants to ground the answer in (D-2: internal items may be included). */
  entities?: Entity[];
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
  /** Recorded cost of a live answer (JPY). */
  costJpy?: number | null;
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
  /** D-3: the user's monthly budget (default 100,000 JPY). */
  monthlyBudgetJpy?: number;
  /** Optional pricing for integrations that can calculate costs. */
  prices?: UnitPrices | null;
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
}

export interface LiveResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** GitHub Copilot: premium requests the call consumed (model multiplier included). */
  premiumRequests?: number;
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
/** The AI settings module provides the user's live switch, connection state, budget and prices. */
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
  /** null when unit prices are missing. */
  estimatedCostJpy: number | null;
  internalCount: number;
  personCount: number;
  context: string;
}

/** Send context prepared by callers; broad one-time permission is captured in AI settings. */
export function preflight(req: AiRequest, now = new Date()): Preflight {
  const selection = selectOutbound(req.entities ?? [], loaded.byId);
  const context = toPromptContext(selection, req.lang);
  const settings = runtime();
  const maxOutputTokens = req.maxOutputTokens ?? PER_USE_LIMITS[req.use]?.maxOutputTokens ?? AI_LIMITS.maxOutputTokens;
  const estimatedInputTokens = estimateTokens(req.prompt + context) + (req.media?.length ?? 0) * MEDIA_TOKEN_ESTIMATE;
  const prices = settings.prices ?? null;
  const estimatedCostJpy = prices ? estimateCostJpy(estimatedInputTokens, maxOutputTokens, prices) : null;
  const limits: Limits = { ...AI_LIMITS, monthlyBudgetJpy: settings.monthlyBudgetJpy ?? AI_LIMITS.monthlyBudgetJpy };
  const ledger = readLedger();
  const budgetRequest = { use: req.use, estimatedInputTokens, maxOutputTokens, estimatedCostJpy };
  let budget = checkBudget(ledger, now, budgetRequest, limits);
  if (req.use === 'strategyOverview') {
    const providerBudget = checkBudget(ledger.filter((r) => !r.provider || r.provider === (settings.provider ?? 'foundry')), now, budgetRequest,
      { ...limits, monthlyBudgetJpy: Math.min(limits.monthlyBudgetJpy, 10_000) });
    if (!providerBudget.allowed) budget = { ...budget, allowed: false, level: 'stop', reasons: [...new Set([...budget.reasons, ...providerBudget.reasons])] };
  }
  const gate = evaluateGate({
    liveEnabled: settings.liveEnabled,
    sendConsent: settings.sendConsent ?? false,
    configured: settings.configured,
    budget,
  });
  return {
    allowed: gate.allowed,
    reasons: gate.reasons,
    budget,
    estimatedInputTokens,
    maxOutputTokens,
    estimatedCostJpy,
    internalCount: selection.internalCount,
    personCount: selection.personCount,
    context,
  };
}

/**
 * The only entry point for generative AI. It evaluates the global consent gate; when every condition holds it sends through the
 * relay transport and records the actual cost in the ledger. Otherwise (or when the live call fails) it answers with the
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
      mode: 'live', text: live.text, blockedReasons: [], withheldIds: [], context: pf.context, costJpy: live.costJpy,
      usage: { inputTokens: live.inputTokens, outputTokens: live.outputTokens },
    };
  } catch {
    return mockAnswer(['liveFailed']);
  }
}

/** Limit for a live call that does not set its own timeoutMs. */
export const DEFAULT_LIVE_TIMEOUT_MS = 60_000;

async function sendLive(req: AiRequest, pf: Preflight, signal?: AbortSignal): Promise<LiveResult & { costJpy: number | null }> {
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
    }, signal);
  } catch (err) {
    // A cancelled or timed-out call may be billed; retain unknown costs as null, never free.
    if (mayHaveBeenBilled(err, signal)) {
      appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: pf.estimatedInputTokens, outputTokens: 0, costJpy: pf.estimatedCostJpy, ...attribution, estimated: true });
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { recordedCostJpy: pf.estimatedCostJpy });
    }
    throw err;
  }
  const costJpy = settings.prices && result.inputTokens !== null && result.outputTokens !== null ? actualCostJpy(result.inputTokens, result.outputTokens, settings.prices) : null;
  appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costJpy, ...attribution });
  return { ...result, costJpy };
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
  /** Cost written to the ledger for a call that may have been billed although it produced no answer. */
  readonly recordedCostJpy: number | null;

  constructor(reasons: GateReason[], message: string, budget?: BudgetDecision, recordedCostJpy: number | null = 0) {
    super(message);
    this.reasons = reasons;
    this.budget = budget;
    this.recordedCostJpy = recordedCostJpy;
  }
}

/**
 * Live only, never a mock: for features whose result is stored as real data (FR-311 customer pack generation), a mock
 * answer would be wrong data. Same gate, budget and ledger as aiComplete; a refusal or failure throws AiLiveError.
 */
export async function aiLive(req: AiRequest, signal?: AbortSignal): Promise<{ text: string; costJpy: number | null; inputTokens: number | null; outputTokens: number | null }> {
  const pf = preflight(req);
  if (!pf.allowed) throw new AiLiveError(pf.reasons, `blocked: ${pf.reasons.join(', ')}`, pf.budget);
  if (!transport) throw new AiLiveError(['liveFailed'], 'no transport');
  try {
    const r = await sendLive(req, pf, signal);
    return { text: r.text, costJpy: r.costJpy, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } catch (err) {
    const recorded = (err as { recordedCostJpy?: number | null }).recordedCostJpy;
    throw new AiLiveError(['liveFailed'], signal?.aborted ? 'aborted' : (err as Error).message, undefined, recorded === undefined ? 0 : recorded);
  }
}
