export const AI_USES = [
  'structure', 'summarize', 'recommend', 'chat', 'executiveSummary',
  'explain', 'presentation', 'aiUsageAnalysis', 'review', 'import', 'storyVideo', 'connectionTest',
  'research', 'brandResearch', 'packBuild', 'alignmentProposal', 'deliverableDraft', 'stepBrief', 'strategyOverview', 'kpiOkrDraft',
  'valueDraft', 'valueExplain', 'objectiveDraft', 'solutionDraft',
] as const;

export type AiUse = (typeof AI_USES)[number];
export type Provider = 'foundry' | 'copilotSdk';

export function isAiUse(value: unknown): value is AiUse {
  return typeof value === 'string' && AI_USES.some((use) => use === value);
}

export const AI_LIMITS = {
  dailyCalls: 30,
  maxInputTokens: 8000,
  maxOutputTokens: 1500,
  minIntervalMs: 5000,
};

export interface PerCallLimits {
  dailyCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  minIntervalMs?: number;
}

/**
 * D-44: reasoning effort sent with every model call (Foundry `reasoning_effort`, Copilot `reasoningEffort` when the model
 * supports it). A deployment that rejects the parameter is retried once without it.
 */
export const AI_REASONING_EFFORT = 'medium';

/** D-44: reasoning models spend output tokens on hidden reasoning first, so the all-step batch caps leave room for it. */
export const DRAFT_MAX_OUTPUT_TOKENS = 32_000;
export const BRIEF_MAX_OUTPUT_TOKENS = 16_000;

export const PER_USE_LIMITS: Partial<Record<AiUse, PerCallLimits>> = {
  // D-41: the all-step batch uses (strategyOverview, deliverableDraft, solutionDraft, stepBrief) have no daily count, interval or input cap.
  strategyOverview: { maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS },
  connectionTest: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 200, maxOutputTokens: 256 },
  explain: {
    dailyCalls: AI_LIMITS.dailyCalls,
    maxInputTokens: AI_LIMITS.maxInputTokens,
    maxOutputTokens: AI_LIMITS.maxOutputTokens,
    minIntervalMs: AI_LIMITS.minIntervalMs,
  },
  chat: { dailyCalls: AI_LIMITS.dailyCalls },
  presentation: { maxOutputTokens: 4000 },
  storyVideo: { maxOutputTokens: 2000 },
  packBuild: { dailyCalls: 64, maxInputTokens: 100_000, maxOutputTokens: 32_000 },
  alignmentProposal: { maxInputTokens: 8_000, maxOutputTokens: 3_000 },
  deliverableDraft: { maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS },
  solutionDraft: { maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS },
  recommend: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 48_000, maxOutputTokens: 4000 },
  stepBrief: { maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS },
  // D-42: business objectives are drafted in the all-step batch too, so like D-41 only the output size is fixed.
  objectiveDraft: { maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS },
  kpiOkrDraft: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 16_000, maxOutputTokens: 4000 },
  valueDraft: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 16_000, maxOutputTokens: 8000 },
  valueExplain: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 16_000, maxOutputTokens: 4000 },
};

export const RECOMMEND_MAX_PROMPT_CHARS = 32_000;
export const RECOMMEND_TIMEOUT_MS = 90_000;
export const DELIVERABLE_DRAFT_TIMEOUT_MS = 300_000;
export const PACK_BUILD_MAX_CALLS = 16;
export const PACK_BUILD_TIMEOUT_MS = 600_000;
export const PACK_BUILD_MAX_PROMPT_CHARS = 200_000;
/** D-41: the all-step batch uses accept the same prompt size as pack generation (only the relay's 1 MiB body bounds it). */
export const DRAFT_MAX_PROMPT_CHARS = PACK_BUILD_MAX_PROMPT_CHARS;
/** D-41: summaries and strategy optimization get the deliverable-draft time so large projects do not time out. */
export const STEP_DRAFT_TIMEOUT_MS = DELIVERABLE_DRAFT_TIMEOUT_MS;

export const WORKIQ_SOURCE = {
  use: 'packBuild' as const,
  providers: ['foundry', 'copilotSdk'] as readonly Provider[],
  /** A verified Work IQ retrieval is required before a Project pack is built only with these providers. */
  requiredFor: ['foundry'] as readonly Provider[],
  data: 'To Work IQ: company and project names, purpose, focus and as-of date in the questions the relay builds, and, for a deep read, the links of the OneDrive or SharePoint files Work IQ itself cited (and, when they do not answer, one follow-up turn in that ask conversation). Some searches name the Microsoft 365 source to search. The answer and citation titles are internal and go to the selected provider (Microsoft Foundry or GitHub Copilot) as packBuild material. Through the Microsoft Foundry route, each search and its raw result also pass through the saved Foundry project (Responses API, the saved deployment relays the tool call)',
  enableCondition: 'Microsoft Foundry or GitHub Copilot selected and ready + the Work IQ CLI (or a tenant and app (client) ID signed in by device code, delegated WorkIQAgent.Ask, or a Microsoft Foundry project connection to the Work IQ MCP server, which replaces the others once verified) saved and verified in the relay + opt-in per run in the pack dialog. Required for Foundry, optional for GitHub Copilot',
  cost: 'Billed by Microsoft as Copilot Credits or within the Microsoft 365 Copilot licence; unknown to the app and not included in the per-job token summary',
  decidedBy: 'docs/decision-guide.md D-14 (2026-11-11; GitHub Copilot added 2026-11-19)',
};

export function workIqAllowedFor(provider: Provider): boolean {
  return WORKIQ_SOURCE.providers.includes(provider);
}

export function workIqRequiredFor(provider: Provider): boolean {
  return WORKIQ_SOURCE.requiredFor.includes(provider);
}

export const WORKIQ_MAX_ANSWER_CHARS = 12_000;
export const WORKIQ_SECTION_MAX_CHARS = 6_000;
export const WORKIQ_ITEM_MAX_CHARS = 9_000;
