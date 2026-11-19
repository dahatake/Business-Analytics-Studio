import { appendLedger, readLedger } from '../../ai/client.ts';
import { checkBudget, estimateTokens, type BudgetReason } from '../../ai/budget.ts';
import { AI_LIMITS } from '../../ai/policy.ts';
import { decisionCostJpy, type DecisionRequest, type DecisionResult } from '../../ai/decision.ts';
import { currentScope } from '../../state/projects.ts';
import { decisionScreen } from './relayClient.ts';
import { isDecisionReady, useAiSettings } from './settingsStore.ts';

/** D-44 / PARAM-191: per-use limits of the Decision pre-screen (one request per screening, tiny output). */
export const DECISION_LIMITS = { dailyCalls: 30, minIntervalMs: AI_LIMITS.minIntervalMs, maxInputTokens: 30_000, maxOutputTokens: 256 } as const;

export class DecisionUnavailable extends Error {
  readonly reason: 'notReady' | BudgetReason | 'failed';
  constructor(reason: DecisionUnavailable['reason'], cause?: unknown) {
    super(reason, { cause });
    this.reason = reason;
  }
}

/**
 * One Decision request under the same send consent, live switch and monthly budget as chat; the call is recorded in the
 * usage ledger at the Decision 1.1 Global rate. Throws DecisionUnavailable so callers can fall back to the chat-only flow.
 */
export async function decisionLive(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
  const s = useAiSettings.getState();
  if (!isDecisionReady(s)) throw new DecisionUnavailable('notReady');
  const estimatedInputTokens = estimateTokens(JSON.stringify({ state: req.state, questions: req.questions }));
  const outputTokens = Object.keys(req.questions).length;
  const estimatedCostJpy = decisionCostJpy(estimatedInputTokens, outputTokens);
  const budget = checkBudget(readLedger(), new Date(), { use: req.use, estimatedInputTokens, maxOutputTokens: outputTokens, estimatedCostJpy },
    { ...AI_LIMITS, monthlyBudgetJpy: s.monthlyBudgetJpy }, DECISION_LIMITS);
  if (!budget.allowed) throw new DecisionUnavailable(budget.reasons[0]);
  const scope = currentScope();
  const attribution = { provider: 'foundry' as const, stage: 'decision', ...(scope !== null ? { scope } : {}) };
  try {
    const r = await decisionScreen(req, signal);
    appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costJpy: decisionCostJpy(r.inputTokens, r.outputTokens), ...attribution });
    return r;
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    const name = (err as { name?: unknown }).name;
    if (signal?.aborted || name === 'AbortError' || name === 'TimeoutError' || status === 504 || status === 499) {
      appendLedger({ at: new Date().toISOString(), use: req.use, inputTokens: estimatedInputTokens, outputTokens: 0, costJpy: estimatedCostJpy, ...attribution, estimated: true });
    }
    if (signal?.aborted) throw err;
    throw new DecisionUnavailable('failed', err);
  }
}
