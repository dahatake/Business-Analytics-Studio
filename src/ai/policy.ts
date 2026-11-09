/**
 * C-03 per-use table (docs/requirements-definition.md §3.1 "C-03 用途別の基準表").
 *
 * Decisions recorded in docs/decision-guide.md (user, 2026-11-09):
 * - D-1 (chosen as the logical option under "complete the rest"): staged approval. Row 1 = "explain" (FR-274) via
 *   Microsoft Foundry. Every other row stays TBD until "explain" has been measured live (D-8) and reviewed.
 * - D-2: internal information MAY be sent externally (this amends Q-055). Person data still needs FR-219 confirmation.
 * - D-3: one monthly budget of 100,000 JPY for the whole app (user-changeable in settings).
 * - D-4: contracts/rights are settled before the app is started; the UI shows that assumption as a warning.
 */
export type AiUse =
  | 'structure' | 'summarize' | 'recommend' | 'chat' | 'executiveSummary'
  | 'explain' | 'presentation' | 'aiUsageAnalysis' | 'review' | 'import' | 'storyVideo' | 'connectionTest'
  | 'research' | 'brandResearch' | 'packBuild';

export type Provider = 'foundry' | 'copilotSdk';

export interface UseApproval {
  provider: Provider | 'TBD';
  /** What may be sent, as approved. */
  data: string | 'TBD';
  enableCondition: string | 'TBD';
  /** Cost cap in JPY for this use, or TBD. */
  costCapJpy: number | 'TBD';
  /** Open questions in the requirements that block this row. */
  openQuestions: string[];
  /** Where the approval is recorded. */
  decidedBy?: string;
}

const TBD_ROW = (extra: string[] = []): UseApproval => ({
  provider: 'TBD', data: 'TBD', enableCondition: 'TBD', costCapJpy: 'TBD', openQuestions: ['D-1 staged: after "explain" is measured (D-8)', ...extra],
});

/** D-3: the single monthly budget (PARAM-117), default value. The user can change it in /ai-settings. */
export const DEFAULT_MONTHLY_BUDGET_JPY = 100_000;

export const C03_TABLE: Record<AiUse, UseApproval> = {
  structure: TBD_ROW(),
  summarize: TBD_ROW(),
  recommend: TBD_ROW(),
  chat: TBD_ROW(),
  executiveSummary: TBD_ROW(),
  explain: {
    provider: 'foundry',
    data: 'The current screen\'s entities (shareable and internal, D-2) and the user\'s request; person entities only after FR-219 confirmation',
    enableCondition: 'Live switch on (FR-132) + Foundry endpoint, deployment and key saved in the relay + unit prices entered + per-send confirmation of content and estimated cost',
    costCapJpy: DEFAULT_MONTHLY_BUDGET_JPY,
    openQuestions: [],
    decidedBy: 'docs/decision-guide.md D-1 (2026-11-09)',
  },
  presentation: TBD_ROW(),
  aiUsageAnalysis: TBD_ROW(),
  review: TBD_ROW(),
  import: TBD_ROW(),
  storyVideo: TBD_ROW(),
  connectionTest: TBD_ROW(),
  research: TBD_ROW(),
  brandResearch: TBD_ROW(),
  packBuild: TBD_ROW(),
};

export function isApproved(row: UseApproval): boolean {
  return row.provider !== 'TBD' && row.data !== 'TBD' && row.enableCondition !== 'TBD' && row.costCapJpy !== 'TBD' && row.openQuestions.length === 0;
}

/** Approved numeric limits (§3.3 PARAM-113〜119, Q-050/Q-051, D-3). */
export const AI_LIMITS = {
  dailyCalls: 30, // PARAM-113 (shared by "explain" and chat, Q-059)
  maxInputTokens: 8000, // PARAM-114
  maxOutputTokens: 1500, // PARAM-115
  minIntervalMs: 5000, // PARAM-116
  monthlyBudgetJpy: DEFAULT_MONTHLY_BUDGET_JPY, // PARAM-117 (JST calendar month, all projects; D-3: one budget for the app)
  warnRatio: 0.8, // PARAM-118
  stopRatio: 1.0, // PARAM-119
  /** PARAM-129: safety factor applied to pre-send cost estimates. */
  estimateSafetyFactor: 1.2,
};

export type Limits = typeof AI_LIMITS;

export interface PerCallLimits {
  dailyCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  minIntervalMs?: number;
}

/**
 * Per-call limits by use. §3.1 says PARAM-113〜116 are decided for "explain" (Q-050) and must NOT be assumed for
 * every use; chat shares only the daily count (Q-059). Other uses have their own PARAMs where decided
 * (PARAM-132: presentation output). A use without an entry has no per-call limit yet (its C-03 row decides it);
 * the monthly budget still applies to every use (Q-051, D-3).
 */
export const PER_USE_LIMITS: Partial<Record<AiUse, PerCallLimits>> = {
  explain: {
    dailyCalls: AI_LIMITS.dailyCalls,
    maxInputTokens: AI_LIMITS.maxInputTokens,
    maxOutputTokens: AI_LIMITS.maxOutputTokens,
    minIntervalMs: AI_LIMITS.minIntervalMs,
  },
  chat: { dailyCalls: AI_LIMITS.dailyCalls },
  presentation: { maxOutputTokens: 4000 }, // PARAM-132
};
