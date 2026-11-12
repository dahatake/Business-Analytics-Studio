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
 * - D-13 (2026-11-11): fixed synthetic Foundry connection tests are approved through the settings route only.
 * - D-14 (user, 2026-11-11): "packBuild" may use Microsoft Work IQ as a material source, only when the provider is
 *   Microsoft Foundry (WORKIQ_SOURCE). With GitHub Copilot SDK the app neither shows nor calls Work IQ.
 * - D-18 (user, 2026-11-12): "packBuild" also generates all five analysis methods from the verified pack and its
 *   materials before saving; the call is included in the existing approval, cost estimate and per-run limit.
 * - D-20 (user, 2026-11-12): "recommend" (FR-050, "Ask AI for suggestions" on a discussion theme) is approved for the
 *   configured provider, with the theme's related items and attached files, after a per-send confirmation.
 */
export type AiUse =
  | 'structure' | 'summarize' | 'recommend' | 'chat' | 'executiveSummary'
  | 'explain' | 'presentation' | 'aiUsageAnalysis' | 'review' | 'import' | 'storyVideo' | 'connectionTest'
  | 'research' | 'brandResearch' | 'packBuild' | 'alignmentProposal' | 'deliverableDraft';

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
  recommend: {
    provider: ['foundry', 'copilotSdk'],
    data: 'The discussion theme title, the theme\'s related items (internal allowed, D-2; person items only after FR-219 confirmation) and its attached files: text files as text in the prompt (shortened to fit), images and PDF as files only when the selected model reads that type. No other themes, records or app data',
    enableCondition: 'Live switch on (FR-132) + the chosen provider configured in the relay + Copilot premium-request price when using Copilot + per-send confirmation of the items, attached files, person data and cost (Foundry charges unknown, not capped by the app budget)',
    costCapJpy: DEFAULT_MONTHLY_BUDGET_JPY,
    openQuestions: [],
    decidedBy: 'docs/decision-guide.md D-20 (2026-11-12)',
  },
  chat: TBD_ROW(),
  executiveSummary: TBD_ROW(),
  explain: {
    provider: 'foundry',
    data: 'The current screen\'s entities (shareable and internal, D-2) and the user\'s request; person entities only after FR-219 confirmation',
    enableCondition: 'Live switch on (FR-132) + verified Foundry connection and saved API key + per-send confirmation of content and unknown-charge notice; Foundry billing is not capped by the app budget',
    costCapJpy: DEFAULT_MONTHLY_BUDGET_JPY,
    openQuestions: [],
    decidedBy: 'docs/decision-guide.md D-1 (2026-11-09)',
  },
  presentation: TBD_ROW(),
  aiUsageAnalysis: TBD_ROW(),
  review: TBD_ROW(),
  import: TBD_ROW(),
  storyVideo: TBD_ROW(),
  connectionTest: {
    provider: 'foundry',
    data: 'Fixed synthetic connection-test prompt only; no customer, project, material or person data',
    enableCondition: 'Explicit test-and-save action, saved API key and confirmation of unknown charges; daily/interval/token limits and known-cost budget checks apply; only /relay/connection may run the fixed test',
    costCapJpy: DEFAULT_MONTHLY_BUDGET_JPY,
    openQuestions: [],
    decidedBy: 'docs/decision-guide.md D-13 (2026-11-11)',
  },
  research: TBD_ROW(),
  brandResearch: TBD_ROW(),
  packBuild: {
    provider: ['foundry', 'copilotSdk'],
    data: 'Company and project names, purpose, as-of date, official site URL, fetched pages and news headlines, attached work material and research note, optional company anchor scope, stated objectives, KPIs, segments, issues, source metadata and supplied excerpts (internal allowed, D-2), the verified customer pack and its retrieved materials for all five analysis methods (D-18), and with Microsoft Foundry only the Work IQ answers and citation titles (D-14); no analyst hypotheses or unrelated app data',
    enableCondition: 'Live switch on (FR-132) + the chosen provider configured in the relay + Copilot premium-request price when using Copilot + confirmation of content, data-owner approval and cost information (Foundry charges unknown, not capped by the app budget)',
    costCapJpy: DEFAULT_MONTHLY_BUDGET_JPY,
    openQuestions: [],
    decidedBy: 'docs/decision-guide.md D-12 and D-18 (2026-11-12)',
  },
  alignmentProposal: {
    provider: ['foundry', 'copilotSdk'],
    data: 'Project purpose and user-entered project KPI, company-stated objectives and KPIs, company source metadata, and selected project source metadata and up to eight source-linked issue, cause, solution, initiative, KPI or OKR summaries per source; summaries can be AI-generated, not original evidence. No source excerpts, person entities, analyst hypotheses, full pack or other app data; free text can still contain personal information',
    enableCondition: 'Live switch on + configured provider + Copilot premium-request price when applicable + separate per-send confirmation of the displayed content, data-owner and personal-data approval, and cost information (Foundry charges unknown and not capped by the app budget)',
    costCapJpy: DEFAULT_MONTHLY_BUDGET_JPY,
    openQuestions: [],
    decidedBy: 'docs/company-project-alignment-study.md §9 (2026-11-12)',
  },
  deliverableDraft: TBD_ROW(['§3.1 has no row for deliverable drafts yet (FR-136)', 'D-9 proposal awaiting user approval (docs/decision-guide.md)']),
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
  connectionTest: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 200, maxOutputTokens: 256 },
  explain: {
    dailyCalls: AI_LIMITS.dailyCalls,
    maxInputTokens: AI_LIMITS.maxInputTokens,
    maxOutputTokens: AI_LIMITS.maxOutputTokens,
    minIntervalMs: AI_LIMITS.minIntervalMs,
  },
  chat: { dailyCalls: AI_LIMITS.dailyCalls },
  presentation: { maxOutputTokens: 4000 }, // PARAM-132
  // PARAM-145〜147 (D-12, D-15): one run makes at most PACK_BUILD_MAX_CALLS calls; about 4 full-depth runs a day fit the cap.
  // D-15 (2026-11-12): output 16,000 → 32,000 tokens (stage answers used up to 15,525 of 16,000; a cut-off answer has no
  // JSON and stops the run). The Foundry deployment accepted max_completion_tokens up to 128,000.
  packBuild: { dailyCalls: 64, maxInputTokens: 100_000, maxOutputTokens: 32_000 },
  alignmentProposal: { maxInputTokens: 8_000, maxOutputTokens: 3_000 },
  // D-20: a prompt of RECOMMEND_MAX_PROMPT_CHARS (at most that many tokens) plus up to 10 files at MEDIA_TOKEN_ESTIMATE each.
  // Output 4,000: the reported output includes reasoning; 5 short Japanese lines measured 1,494 tokens (claude-haiku-4.5),
  // so 1,500 would cut off a reasoning deployment on Foundry (max_completion_tokens) before any answer.
  recommend: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 48_000, maxOutputTokens: 4000 },
};

/** D-20: characters of one recommend prompt + context (server/relay.ts); attached text is shortened to fit below it. */
export const RECOMMEND_MAX_PROMPT_CHARS = 32_000;
/** D-20: per-call timeout for suggestions; a model reading attached PDFs answers slower than a plain prompt. */
export const RECOMMEND_TIMEOUT_MS = 90_000;

/**
 * PARAM-148: calls one pack generation may make (2 generation stages + 1 five-method analysis + up to 2×4 re-runs
 * after Work IQ follow-up rounds + up to 3 fix rounds + up to 2 retries of a failed or unreadable answer = 16).
 * The dialog shows the run's own bound (maxCallsFor) before it starts.
 */
export const PACK_BUILD_MAX_CALLS = 16;
/** PARAM-149: per-call timeout for pack generation (long JSON output; D-15: 300 → 600 s for 32,000 output tokens at ~210 tokens/s). */
export const PACK_BUILD_TIMEOUT_MS = 600_000;
/** Characters of one packBuild prompt the relay accepts (server/relay.ts); the generator fits its material below it. */
export const PACK_BUILD_MAX_PROMPT_CHARS = 200_000;

/**
 * D-14 (user, 2026-11-11): Work IQ (Microsoft 365 work data) as material for "packBuild". Not a C-03 LLM row of its
 * own: Work IQ answers with the user's delegated Microsoft 365 permissions and the answer then travels as packBuild
 * material. The relay enforces the provider (server/relay.ts /relay/workiq/ask) and the dialog only offers it then.
 */
export const WORKIQ_SOURCE = {
  use: 'packBuild' as const,
  providers: ['foundry'] as readonly Provider[],
  data: 'To Work IQ: company and project names, purpose, focus and as-of date in one fixed question the relay builds. The answer and citation titles are internal and go to Foundry as packBuild material',
  enableCondition: 'Microsoft Foundry selected and verified + Work IQ tenant and app (client) ID saved in the relay + the user signed in by device code (delegated WorkIQAgent.Ask) + opt-in per run in the pack dialog',
  cost: 'Billed by Microsoft as Copilot Credits or within the Microsoft 365 Copilot licence; unknown to the app and not counted in the app budget',
  decidedBy: 'docs/decision-guide.md D-14 (2026-11-11)',
};

export function workIqAllowedFor(provider: Provider): boolean {
  return WORKIQ_SOURCE.providers.includes(provider) && isApprovedFor(C03_TABLE[WORKIQ_SOURCE.use], provider);
}

/** D-14: characters of one Work IQ answer handed to the pack generator (the relay truncates longer answers). */
export const WORKIQ_MAX_ANSWER_CHARS = 12_000;
/** D-14: characters of one section search (org, KPI, process, data …); eight sections stay within the input budget. */
export const WORKIQ_SECTION_MAX_CHARS = 6_000;
/**
 * D-15: characters of one merged readiness item (Work IQ CLI `expand`). Measured 2026-11-12: at 9,000 characters 7 of 8
 * items had enough relevant sources against 6 of 8 at 6,000 (docs/workiq-agentic-retrieval-study.md §5.6).
 */
export const WORKIQ_ITEM_MAX_CHARS = 9_000;
