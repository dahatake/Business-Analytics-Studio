import { checkBudget, type UsageRecord } from '../../ai/budget.ts';
import { AI_LIMITS } from '../../ai/policy.ts';

export interface DailyUsage {
  /** Calls today on the quota shared by "explain" and chat (PARAM-113, Q-059). */
  todayCalls: number;
  dailyLimit: number;
}

/** Today's call count against the daily safety limit, computed from the per-call token log (mock answers are not recorded). */
export function dailyUsage(ledger: UsageRecord[], now: Date): DailyUsage {
  const d = checkBudget(ledger, now, { use: 'explain', estimatedInputTokens: 0, maxOutputTokens: 0 });
  return { todayCalls: d.todayCalls, dailyLimit: AI_LIMITS.dailyCalls };
}
