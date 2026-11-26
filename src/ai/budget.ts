import { PER_USE_LIMITS, type AiUse, type PerCallLimits } from './policy.ts';

/** One live call in the per-call token log. Old stored records may carry extra fields (e.g. a retired cost); they are ignored. */
export interface UsageRecord {
  /** ISO timestamp (UTC). */
  at: string;
  use: string;
  /** null = the provider did not report usage (shown as unknown). */
  inputTokens: number | null;
  outputTokens: number | null;
  /** The work target the call was made for ('demo' or a project id); absent for app-level calls and old records. */
  scope?: string;
  /** Sub-step inside a use, e.g. pack generation 'foundation' | 'business' | 'fix-1'. */
  stage?: string;
  provider?: 'foundry' | 'copilotSdk';
  /** The provider did not report usage (cancelled, timed out, failed test): the token counts are the app's estimate. */
  estimated?: true;
  /** The call failed after the provider billed it (e.g. 'outputLimit'); the token counts are the provider's report. */
  failed?: string;
}

/** Safety-guard request: per-call token caps, minimum interval and the daily call count. No monetary limit exists. */
export interface BudgetRequest {
  use: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export type BudgetReason = 'dailyLimit' | 'tooSoon' | 'inputTooLarge' | 'outputTooLarge';

export interface BudgetDecision {
  allowed: boolean;
  reasons: BudgetReason[];
  todayCalls: number;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Calendar day in Japan time (the daily call count resets at JST midnight). */
export function jstDay(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Keep counting earlier chat calls against the shared "explain" quota (Q-059). */
const DAILY_SHARED = new Set(['explain', 'chat']);

export function checkBudget(ledger: UsageRecord[], now: Date, req: BudgetRequest, perUse: PerCallLimits | undefined = PER_USE_LIMITS[req.use as AiUse]): BudgetDecision {
  const reasons: BudgetReason[] = [];
  const day = jstDay(now);
  const sameQuota = (u: string) => (DAILY_SHARED.has(req.use) ? DAILY_SHARED.has(u) : u === req.use);
  const todayCalls = ledger.filter((r) => jstDay(new Date(r.at)) === day && sameQuota(r.use)).length;
  const last = ledger.filter((r) => sameQuota(r.use)).map((r) => new Date(r.at).getTime()).sort((a, b) => b - a)[0];

  if (perUse?.dailyCalls !== undefined && todayCalls >= perUse.dailyCalls) reasons.push('dailyLimit');
  if (perUse?.minIntervalMs !== undefined && last !== undefined && now.getTime() - last < perUse.minIntervalMs) reasons.push('tooSoon');
  if (perUse?.maxInputTokens !== undefined && req.estimatedInputTokens > perUse.maxInputTokens) reasons.push('inputTooLarge');
  if (perUse?.maxOutputTokens !== undefined && req.maxOutputTokens > perUse.maxOutputTokens) reasons.push('outputTooLarge');
  return { allowed: reasons.length === 0, reasons, todayCalls };
}

/** Rough token estimate used before sending: ~1 token per CJK char, ~1 per 4 other chars. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
