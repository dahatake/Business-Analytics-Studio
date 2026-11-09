import type { Entity } from '../data/schema.ts';
import { loaded } from '../data/pack.ts';
import { AI_LIMITS, C03_TABLE, PER_USE_LIMITS, type AiUse, type Limits } from './policy.ts';
import { actualCostJpy, checkBudget, estimateCostJpy, estimateTokens, type BudgetDecision, type UnitPrices, type UsageRecord } from './budget.ts';
import { evaluateGate, type GateReason } from './gate.ts';
import { selectOutbound, toPromptContext } from './redact.ts';

export interface AiRequest {
  use: AiUse;
  lang: 'ja' | 'en';
  prompt: string;
  /** Data the feature wants to ground the answer in (D-2: internal items may be included). */
  entities?: Entity[];
  /** User consent captured by the feature's confirmation UI (content and estimated cost). */
  userConfirmed?: boolean;
  personConfirmed?: boolean;
  /** Per-use output cap (e.g. PARAM-132: 4000 for presentations). */
  maxOutputTokens?: number;
  /** Per-use timeout in ms (e.g. PARAM-121: 60 s, PARAM-127: 90 s). */
  timeoutMs?: number;
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
  costJpy?: number;
}

export interface AiRuntimeSettings {
  liveEnabled: boolean;
  configured: boolean;
  /** D-3: the user's monthly budget (default 100,000 JPY). */
  monthlyBudgetJpy?: number;
  /** User-entered unit prices (PARAM-130); null when missing or invalid → nothing is sent. */
  prices?: UnitPrices | null;
}

/** What the browser hands to the transport (the localhost relay). */
export interface LiveCall {
  use: AiUse;
  lang: 'ja' | 'en';
  prompt: string;
  context: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LiveResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type LiveTransport = (call: LiveCall) => Promise<LiveResult>;

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

/** Everything a confirmation dialog must show before sending (C-03: content and cost confirmed by the user). */
export function preflight(req: AiRequest, now = new Date()): Preflight {
  const selection = selectOutbound(req.entities ?? [], loaded.byId);
  const context = toPromptContext(selection, req.lang);
  const settings = runtime();
  const maxOutputTokens = req.maxOutputTokens ?? PER_USE_LIMITS[req.use]?.maxOutputTokens ?? AI_LIMITS.maxOutputTokens;
  const estimatedInputTokens = estimateTokens(req.prompt + context);
  const prices = settings.prices ?? null;
  const estimatedCostJpy = prices ? estimateCostJpy(estimatedInputTokens, maxOutputTokens, prices) : null;
  const limits: Limits = { ...AI_LIMITS, monthlyBudgetJpy: settings.monthlyBudgetJpy ?? AI_LIMITS.monthlyBudgetJpy };
  const budget = checkBudget(readLedger(), now, { use: req.use, estimatedInputTokens, maxOutputTokens, estimatedCostJpy: estimatedCostJpy ?? 0 }, limits);
  const gate = evaluateGate({
    use: req.use,
    liveEnabled: settings.liveEnabled,
    userConfirmed: req.userConfirmed ?? false,
    configured: settings.configured,
    hasUnitPrices: prices !== null,
    budget,
    personCount: selection.personCount,
    personConfirmed: req.personConfirmed ?? false,
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

/** Whether a use can ever go live in this build (its C-03 row is approved). UIs use it to offer the live path. */
export function isUseApproved(use: AiUse): boolean {
  return evaluateGate({
    use, liveEnabled: true, userConfirmed: true, configured: true, hasUnitPrices: true,
    budget: { allowed: true, level: 'ok', reasons: [], monthSpentJpy: 0, todayCalls: 0 }, personCount: 0, personConfirmed: true,
  }, C03_TABLE).allowed;
}

/**
 * The only entry point for generative AI. It evaluates the C-03 gate; when every condition holds it sends through the
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
  const prices = runtime().prices!;
  try {
    const result = await transport({
      use: req.use,
      lang: req.lang,
      prompt: req.prompt,
      context: pf.context,
      maxOutputTokens: pf.maxOutputTokens,
      timeoutMs: req.timeoutMs ?? 60_000,
    });
    const costJpy = actualCostJpy(result.inputTokens, result.outputTokens, prices);
    appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costJpy });
    return { mode: 'live', text: result.text, blockedReasons: [], withheldIds: [], context: pf.context, costJpy };
  } catch {
    return mockAnswer(['liveFailed']);
  }
}
