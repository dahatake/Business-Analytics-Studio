import { checkBudget, partitionLedger, type UsageRecord } from '../../ai/budget.ts';
import { readLedger, writeLedger } from '../../ai/client.ts';
import { AI_LIMITS } from '../../ai/policy.ts';

export type BudgetLevel = 'ok' | 'warn' | 'stop';

export function levelOf(spent: number, budget: number): BudgetLevel {
  if (budget <= 0 || spent >= budget * AI_LIMITS.stopRatio) return 'stop';
  return spent >= budget * AI_LIMITS.warnRatio ? 'warn' : 'ok';
}

export interface UsageSummary {
  /** Calls today on the quota shared by "explain" and chat (PARAM-113, Q-059). */
  todayCalls: number;
  dailyLimit: number;
  /** Spend this JST month across every use and project (D-3: one budget). */
  monthSpentJpy: number;
  monthUnpricedCalls?: number;
  monthBudgetJpy: number;
  monthLevel: BudgetLevel;
}

/** FR-276 / NFR-COST-001 display, computed from the usage ledger (mock answers are free and are not recorded). */
export function usageSummary(ledger: UsageRecord[], now: Date, monthlyBudgetJpy: number): UsageSummary {
  const d = checkBudget(ledger, now, { use: 'explain', estimatedInputTokens: 0, maxOutputTokens: 0, estimatedCostJpy: 0 });
  return {
    todayCalls: d.todayCalls,
    dailyLimit: AI_LIMITS.dailyCalls,
    monthSpentJpy: d.monthSpentJpy,
    ...(d.monthUnpricedCalls ? { monthUnpricedCalls: d.monthUnpricedCalls } : {}),
    monthBudgetJpy: monthlyBudgetJpy,
    monthLevel: levelOf(d.monthSpentJpy, monthlyBudgetJpy),
  };
}

/** D-7: how many usage records are older than the 13-month retention window (nothing is deleted here). */
export function expiredUsageCount(now = new Date()): number {
  return partitionLedger(readLedger(), now).expired.length;
}

/** D-7: deletes records older than 13 months. Runs only on the user's explicit, confirmed action. Returns the count. */
export function deleteExpiredUsage(now = new Date()): number {
  const { keep, expired } = partitionLedger(readLedger(), now);
  if (expired.length > 0) writeLedger(keep);
  return expired.length;
}