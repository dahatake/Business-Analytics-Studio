/**
 * C-03 per-use table (docs/requirements-definition.md §3.1 "C-03 用途別の基準表").
 *
 * Decisions recorded in docs/decision-guide.md (user, 2026-11-09):
 * - D-1 (chosen as the logical option under "complete the rest"): staged approval. Row 1 = "explain" (FR-274) via
 *   Microsoft Foundry. Every other row stays TBD until "explain" has been measured live (D-8) and reviewed.
 * - D-2: internal information MAY be sent externally (this amends Q-055). Person data still needs FR-219 confirmation.
 * - D-3: one monthly budget of 100,000 JPY for the whole app (user-changeable in settings).
 * - D-4: contracts/rights are settled before the app is started; the UI shows that assumption as a warning.
 * - D-9 (proposal, not approved): deliverable drafts get their own row instead of borrowing "structure"; it stays
 *   blocked until "explain" is measured (D-8), §3.1 has the row and the user approves it.
 * - D-12 (user, 2026-11-10): "packBuild" (FR-311, customer pack generated in the app) is approved for the configured
 *   provider, Microsoft Foundry or GitHub Copilot SDK, within the single monthly budget of 100,000 JPY.
 */
export type AiUse =
  | 'structure' | 'summarize' | 'recommend' | 'chat' | 'executiveSummary'
  | 'explain' | 'presentation' | 'aiUsageAnalysis' | 'review' | 'import' | 'storyVideo' | 'connectionTest'
  | 'research' | 'brandResearch' | 'packBuild' | 'deliverableDraft';

export type Provider = 'foundry' | 'copilotSdk';

export interface UseApproval {
  /** The approved provider; a list when the user may choose any of them (D-10). */
  provider: Provider | readonly Provider[] | 'TBD';
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
  packBuild: {
    provider: ['foundry', 'copilotSdk'],
    data: 'Company and project names, purpose, as-of date, the official site URL, pages the relay fetched from that site, news headlines, and the work material and research note the user attached (internal allowed, D-2); nothing else from the app',
    enableCondition: 'Live switch on (FR-132) + the chosen provider configured in the relay (Foundry endpoint, deployment and key, or a signed-in GitHub Copilot CLI and a model) + unit prices entered + the user confirms content, data-owner approval and estimated cost before the run',
    costCapJpy: DEFAULT_MONTHLY_BUDGET_JPY,
    openQuestions: [],
    decidedBy: 'docs/decision-guide.md D-12 (2026-11-10)',
  },
  deliverableDraft: TBD_ROW(['§3.1 has no row for deliverable drafts yet (FR-136; rd-author adds it)', 'D-9 proposal awaiting user approval (docs/decision-guide.md)']),
};

export function isApproved(row: UseApproval): boolean {
  return row.provider !== 'TBD' && row.data !== 'TBD' && row.enableCondition !== 'TBD' && row.costCapJpy !== 'TBD' && row.openQuestions.length === 0;
}

/** Providers a row approves (empty for TBD). */
export function approvedProviders(row: UseApproval): readonly Provider[] {
  if (row.provider === 'TBD') return [];
  return typeof row.provider === 'string' ? [row.provider] : row.provider;
}

/** An approved row that also approves this provider. Without a provider, any approved provider is enough. */
export function isApprovedFor(row: UseApproval, provider?: Provider): boolean {
  return isApproved(row) && (provider === undefined || approvedProviders(row).includes(provider));
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
  // PARAM-145〜147 (D-12): one run makes at most PACK_BUILD_MAX_CALLS calls; 8 runs a day fit the daily cap.
  packBuild: { dailyCalls: 48, maxInputTokens: 100_000, maxOutputTokens: 16_000 },
};

/** PARAM-148: calls one pack generation may make (2 generation stages + up to 3 fix rounds = 5, plus 1 spare). */
export const PACK_BUILD_MAX_CALLS = 6;
/** PARAM-149: per-call timeout for pack generation (long JSON output). */
export const PACK_BUILD_TIMEOUT_MS = 300_000;
