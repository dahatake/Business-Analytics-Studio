export const AI_USES = [
  'structure', 'summarize', 'recommend', 'chat', 'executiveSummary',
  'explain', 'presentation', 'aiUsageAnalysis', 'review', 'import', 'storyVideo', 'connectionTest',
  'research', 'brandResearch', 'packBuild', 'alignmentProposal', 'deliverableDraft', 'stepBrief', 'strategyOverview',
] as const;

export type AiUse = (typeof AI_USES)[number];
export type Provider = 'foundry' | 'copilotSdk';

export function isAiUse(value: unknown): value is AiUse {
  return typeof value === 'string' && AI_USES.some((use) => use === value);
}

export const DEFAULT_MONTHLY_BUDGET_JPY = 100_000;

export const AI_LIMITS = {
  dailyCalls: 30,
  maxInputTokens: 8000,
  maxOutputTokens: 1500,
  minIntervalMs: 5000,
  monthlyBudgetJpy: DEFAULT_MONTHLY_BUDGET_JPY,
  warnRatio: 0.8,
  stopRatio: 1.0,
  estimateSafetyFactor: 1.2,
};

export type Limits = typeof AI_LIMITS;

export interface PerCallLimits {
  dailyCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  minIntervalMs?: number;
}

export const PER_USE_LIMITS: Partial<Record<AiUse, PerCallLimits>> = {
  strategyOverview: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 16_000, maxOutputTokens: 8000 },
  connectionTest: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 200, maxOutputTokens: 256 },
  explain: {
    dailyCalls: AI_LIMITS.dailyCalls,
    maxInputTokens: AI_LIMITS.maxInputTokens,
    maxOutputTokens: AI_LIMITS.maxOutputTokens,
    minIntervalMs: AI_LIMITS.minIntervalMs,
  },
  chat: { dailyCalls: AI_LIMITS.dailyCalls },
  presentation: { maxOutputTokens: 4000 },
  packBuild: { dailyCalls: 64, maxInputTokens: 100_000, maxOutputTokens: 32_000 },
  alignmentProposal: { maxInputTokens: 8_000, maxOutputTokens: 3_000 },
  deliverableDraft: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 16_000, maxOutputTokens: 8000 },
  recommend: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 48_000, maxOutputTokens: 4000 },
  stepBrief: { dailyCalls: 30, minIntervalMs: 5000, maxInputTokens: 16_000, maxOutputTokens: 4000 },
};

export const RECOMMEND_MAX_PROMPT_CHARS = 32_000;
export const RECOMMEND_TIMEOUT_MS = 90_000;
export const DELIVERABLE_DRAFT_TIMEOUT_MS = 300_000;
export const PACK_BUILD_MAX_CALLS = 16;
export const PACK_BUILD_TIMEOUT_MS = 600_000;
export const PACK_BUILD_MAX_PROMPT_CHARS = 200_000;

export const WORKIQ_SOURCE = {
  use: 'packBuild' as const,
  providers: ['foundry'] as readonly Provider[],
  data: 'To Work IQ: company and project names, purpose, focus and as-of date in the questions the relay builds, and, for a deep read, the links of the OneDrive or SharePoint files Work IQ itself cited (and, when they do not answer, one follow-up turn in that ask conversation). Some searches name the Microsoft 365 source to search. The answer and citation titles are internal and go to Foundry as packBuild material',
  enableCondition: 'Microsoft Foundry selected and verified + Work IQ tenant and app (client) ID saved in the relay + the user signed in by device code (delegated WorkIQAgent.Ask) + opt-in per run in the pack dialog',
  cost: 'Billed by Microsoft as Copilot Credits or within the Microsoft 365 Copilot licence; unknown to the app and not counted in the app budget',
  decidedBy: 'docs/decision-guide.md D-14 (2026-11-11)',
};

export function workIqAllowedFor(provider: Provider): boolean {
  return WORKIQ_SOURCE.providers.includes(provider);
}

export const WORKIQ_MAX_ANSWER_CHARS = 12_000;
export const WORKIQ_SECTION_MAX_CHARS = 6_000;
export const WORKIQ_ITEM_MAX_CHARS = 9_000;
