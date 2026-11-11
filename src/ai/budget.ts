import { AI_LIMITS, PER_USE_LIMITS, type AiUse, type PerCallLimits } from './policy.ts';

export interface UsageRecord {
  /** ISO timestamp (UTC). */
  at: string;
  use: string;
  inputTokens: number;
  outputTokens: number;
  /** null means pricing is unavailable, not a free call. */
  costJpy: number | null;
  /** The work target the call was made for ('demo' or a project id); absent for app-level calls and old records. */
  scope?: string;
  /** Sub-step inside a use, e.g. pack generation 'foundation' | 'business' | 'fix-1'. */
  stage?: string;
  provider?: 'foundry' | 'copilotSdk';
  /** The provider did not report usage (cancelled, timed out, failed test): the token counts are the app's estimate. */
  estimated?: true;
}

export interface BudgetRequest {
  use: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedCostJpy: number | null;
}

export type BudgetReason = 'dailyLimit' | 'tooSoon' | 'inputTooLarge' | 'outputTooLarge' | 'monthlyStop';

export interface BudgetDecision {
  allowed: boolean;
  level: 'ok' | 'warn' | 'stop';
  reasons: BudgetReason[];
  monthSpentJpy: number;
  monthUnpricedCalls?: number;
  todayCalls: number;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Calendar day / month in Japan time (Q-051: budgets use the JST calendar month). */
export function jstDay(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}
export function jstMonth(d: Date): string {
  return jstDay(d).slice(0, 7);
}

/** Uses sharing the daily-call quota (Q-059: chat counts against the "explain" quota). */
const DAILY_SHARED = new Set(['explain', 'chat']);

export function checkBudget(ledger: UsageRecord[], now: Date, req: BudgetRequest, limits = AI_LIMITS, perUse: PerCallLimits | undefined = PER_USE_LIMITS[req.use as AiUse]): BudgetDecision {
  const reasons: BudgetReason[] = [];
  const month = jstMonth(now);
  const day = jstDay(now);
  const monthRecords = ledger.filter((r) => jstMonth(new Date(r.at)) === month);
  const monthSpentJpy = monthRecords.reduce((a, r) => a + (r.costJpy ?? 0), 0);
  const monthUnpricedCalls = monthRecords.filter((r) => r.costJpy === null).length;
  const sameQuota = (u: string) => (DAILY_SHARED.has(req.use) ? DAILY_SHARED.has(u) : u === req.use);
  const todayCalls = ledger.filter((r) => jstDay(new Date(r.at)) === day && sameQuota(r.use)).length;
  const last = ledger.filter((r) => sameQuota(r.use)).map((r) => new Date(r.at).getTime()).sort((a, b) => b - a)[0];

  if (perUse?.dailyCalls !== undefined && todayCalls >= perUse.dailyCalls) reasons.push('dailyLimit');
  if (perUse?.minIntervalMs !== undefined && last !== undefined && now.getTime() - last < perUse.minIntervalMs) reasons.push('tooSoon');
  if (perUse?.maxInputTokens !== undefined && req.estimatedInputTokens > perUse.maxInputTokens) reasons.push('inputTooLarge');
  if (perUse?.maxOutputTokens !== undefined && req.maxOutputTokens > perUse.maxOutputTokens) reasons.push('outputTooLarge');
  const after = monthSpentJpy + (req.estimatedCostJpy ?? 0);
  if (limits.monthlyBudgetJpy <= 0 || after > limits.monthlyBudgetJpy * limits.stopRatio) reasons.push('monthlyStop');

  const level = reasons.includes('monthlyStop') ? 'stop' : after >= limits.monthlyBudgetJpy * limits.warnRatio ? 'warn' : 'ok';
  return { allowed: reasons.length === 0, level, reasons, monthSpentJpy, todayCalls, ...(monthUnpricedCalls ? { monthUnpricedCalls } : {}) };
}

/** Rough token estimate used before sending: ~1 token per CJK char, ~1 per 4 other chars. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export interface UnitPrices {
  /** JPY per 1,000,000 input tokens (user-entered, PARAM-130). */
  inputPerM: number;
  /** JPY per 1,000,000 output tokens. */
  outputPerM: number;
  /**
   * GitHub Copilot bills premium requests, not tokens (D-12): JPY per premium request (user-entered). When set, cost is
   * requests × the model's multiplier × this price and the token prices are not used.
   */
  perRequestJpy?: number;
  /** The selected Copilot model's premium-request multiplier (1 when unknown). */
  requestMultiplier?: number;
}

/** Valid only when both prices are finite and > 0 (D-3: no price → no send). */
export function parseUnitPrices(input: string | number | undefined, output: string | number | undefined): UnitPrices | null {
  const i = Number(input);
  const o = Number(output);
  return Number.isFinite(i) && i > 0 && Number.isFinite(o) && o > 0 ? { inputPerM: i, outputPerM: o } : null;
}

/** Copilot price: JPY per premium request, finite and > 0; the multiplier defaults to 1 and may be 0 (included models). */
export function parseRequestPrice(perRequest: string | number | undefined, multiplier = 1): UnitPrices | null {
  const p = Number(perRequest);
  const m = Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
  return Number.isFinite(p) && p > 0 ? { inputPerM: 0, outputPerM: 0, perRequestJpy: p, requestMultiplier: m } : null;
}

/** Worst-case cost before sending: all input + the full output cap, times the safety factor (PARAM-129). */
export function estimateCostJpy(inputTokens: number, maxOutputTokens: number, prices: UnitPrices, safety = AI_LIMITS.estimateSafetyFactor): number {
  if (prices.perRequestJpy !== undefined) return prices.perRequestJpy * (prices.requestMultiplier ?? 1) * safety;
  return ((inputTokens * prices.inputPerM + maxOutputTokens * prices.outputPerM) / 1_000_000) * safety;
}

/** Actual cost after the call, from the provider's reported token usage (or premium requests for Copilot). */
export function actualCostJpy(inputTokens: number, outputTokens: number, prices: UnitPrices, premiumRequests?: number): number {
  if (prices.perRequestJpy !== undefined) return prices.perRequestJpy * (premiumRequests ?? prices.requestMultiplier ?? 1);
  return (inputTokens * prices.inputPerM + outputTokens * prices.outputPerM) / 1_000_000;
}

/** D-7 (P-03): the usage ledger keeps 13 JST months. Pruning runs only on an explicit user action. */
export const LEDGER_RETENTION_MONTHS = 13;

export function ledgerCutoffMonth(now: Date, months = LEDGER_RETENTION_MONTHS): string {
  const [y, m] = jstMonth(now).split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) - (months - 1);
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** Records older than the retention window (kept months: the current JST month and the 12 before it). */
export function partitionLedger(ledger: UsageRecord[], now: Date, months = LEDGER_RETENTION_MONTHS): { keep: UsageRecord[]; expired: UsageRecord[] } {
  const cutoff = ledgerCutoffMonth(now, months);
  const keep: UsageRecord[] = [];
  const expired: UsageRecord[] = [];
  for (const r of ledger) (jstMonth(new Date(r.at)) >= cutoff ? keep : expired).push(r);
  return { keep, expired };
}
