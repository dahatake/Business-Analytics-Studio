import { z } from 'zod';
import { LocalizableSchema, ORG_LEVELS } from '../modules/project/model.ts';
import type { Localizable } from '../state/text.ts';

export const GlossaryEntrySchema = z.object({
  term: LocalizableSchema,
  definition: LocalizableSchema,
  it: LocalizableSchema.optional(),
});
export const GlossarySchema = z.array(GlossaryEntrySchema);

const LayerItem = z.object({
  layer: z.enum(['edge', 'data', 'intelligence', 'process', 'experience']),
  name: z.string().min(1),
});
export const ArchitectureExtension = z.object({
  asIs: z.array(LayerItem).optional(),
  toBe: z.array(LayerItem).optional(),
}).passthrough();

const SourceIds = z.array(z.string()).optional();

export const MetricEvidenceSchema = z.object({
  status: z.enum(['measured', 'recordEstimate', 'estimate', 'stated', 'unknown']),
  method: z.string().min(1),
  sourceIds: z.array(z.string()).default([]),
  quote: z.string().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
});
export type MetricEvidence = z.infer<typeof MetricEvidenceSchema>;
export const METRIC_FIELDS = ['touchMinutes', 'waitHours', 'volumePerMonth', 'firstPassPct', 'people'] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

/** How an input or a work product travels: the medium tells where a hidden manual step is likely (FR-380). */
export const ARTIFACT_FORMS = ['excel', 'email', 'paper', 'pdf', 'document', 'system', 'chat', 'meeting', 'verbal', 'other'] as const;
export type ArtifactForm = (typeof ARTIFACT_FORMS)[number];
/** An input or output named on its own (plain text), or with its medium and the party it comes from or goes to. */
export const ArtifactSchema = z.union([LocalizableSchema, z.object({
  name: LocalizableSchema,
  form: z.enum(ARTIFACT_FORMS).optional(),
  /** A party id (extensions.workflow.parties) the item comes from (inputs) or goes to (outputs). */
  partyId: z.string().optional(),
}).passthrough()]);
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * FR-380: the numbers a value stream map puts in a step's data box. All optional: only stated or measured values,
 * `basis` says which (an estimate is labelled as one, never shown as a fact).
 * touchMinutes = hands-on effort per item (all people together); waitHours = calendar time the item waits before the
 * step finishes; volumePerMonth = items per month; firstPassPct = items that need no rework (%C&A).
 */
export const StepMetricsSchema = z.object({
  touchMinutes: z.number().nonnegative().optional(),
  waitHours: z.number().nonnegative().optional(),
  volumePerMonth: z.number().nonnegative().optional(),
  firstPassPct: z.number().min(0).max(100).optional(),
  /** People who take part in the step (headcount, not FTE). */
  people: z.number().int().nonnegative().optional(),
  basis: z.enum(['stated', 'estimate']).optional(),
  evidence: z.object({
    touchMinutes: MetricEvidenceSchema.optional(),
    waitHours: MetricEvidenceSchema.optional(),
    volumePerMonth: MetricEvidenceSchema.optional(),
    firstPassPct: MetricEvidenceSchema.optional(),
    people: MetricEvidenceSchema.optional(),
  }).optional(),
}).passthrough();
export type StepMetrics = z.infer<typeof StepMetricsSchema>;

/** ECRS-style change of a step in the to-be process (step 2). `remove` = the step disappears; `new` = to-be only. */
export const STEP_CHANGES = ['keep', 'improve', 'combine', 'remove', 'new'] as const;
export type StepChange = (typeof STEP_CHANGES)[number];

export const PARTY_SIDES = ['external', 'internal'] as const;
export const PARTY_KINDS = ['customer', 'supplier', 'partner', 'regulator', 'department', 'team', 'other'] as const;
export const LOOP_KINDS = ['rework', 'iteration', 'feedback'] as const;
export const LOOP_STATES = ['asIs', 'toBe', 'both'] as const;

/**
 * The team's own work as a chain of stages (sales and service organisations as well as plants): what comes in, what
 * the team does with it, what it hands over and to which team. Each stage cites the material it comes from.
 * FR-380 adds, all optional so older packs stay valid: the parties (external customers and suppliers are kept apart
 * from the company's own departments), phases for the bird's-eye view, the as-is numbers of each step (step 1), its
 * to-be change and numbers (step 2), hidden micro-workflows, loops (rework, iteration) and the KPI a span is measured by.
 */
export const WorkflowExtension = z.object({
  title: LocalizableSchema.optional(),
  /** Labour cost per hour used to turn hours into money; omitted = money is not shown. */
  laborCostPerHourJpy: z.number().positive().optional(),
  laborCostEvidence: MetricEvidenceSchema.optional(),
  draftNote: LocalizableSchema.optional(),
  evidenceSources: z.array(z.object({
    ref: z.string(), text: z.string(), title: z.string(), url: z.string(),
  })).optional(),
  measurement: z.object({
    worker: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    fetchedAt: z.string(),
    timeZone: z.string(),
    coverage: z.literal('partial'),
    warnings: z.array(z.string()),
    categories: z.array(z.object({
      name: z.string(),
      description: z.string(),
      stageId: z.string().optional(),
      measuredMinutes: z.number().nonnegative(),
      estimatedMinutes: z.number().nonnegative(),
      calendarMinutes: z.number().nonnegative(),
      emailCount: z.number().int().nonnegative(),
      chatCount: z.number().int().nonnegative(),
      sharePct: z.number().min(0).max(100),
    })),
    records: z.array(z.object({
      id: z.string(), kind: z.enum(['calendar', 'email', 'chat', 'worklog']),
      category: z.string(), description: z.string(), stageId: z.string().optional(),
      start: z.string(), end: z.string().optional(),
      ref: z.string(), quote: z.string(),
    })),
    sources: z.array(z.object({ ref: z.string(), title: z.string(), url: z.string(), text: z.string() })),
  }).optional(),
  parties: z.array(z.object({
    id: z.string().min(1),
    name: LocalizableSchema,
    side: z.enum(PARTY_SIDES),
    kind: z.enum(PARTY_KINDS).optional(),
    /** A customer, supplier, person or site entity this party stands for. */
    entityId: z.string().optional(),
    sourceIds: SourceIds,
  }).passthrough()).optional(),
  phases: z.array(z.object({ id: z.string().min(1), name: LocalizableSchema }).passthrough()).optional(),
  stages: z.array(z.object({
    id: z.string().min(1),
    name: LocalizableSchema,
    team: LocalizableSchema.optional(),
    /** The lane: a party id. Absent = the lane is named by `team`. */
    partyId: z.string().optional(),
    phaseId: z.string().optional(),
    description: LocalizableSchema.optional(),
    inputs: z.array(ArtifactSchema).default([]),
    activities: z.array(LocalizableSchema).default([]),
    outputs: z.array(ArtifactSchema).default([]),
    /** Reports, systems and data the stage reads or writes. */
    data: z.array(LocalizableSchema).optional(),
    /** Small workflows inside the step that the process map hides (e.g. an Excel sheet sent round for others to fill in). */
    hiddenWork: z.array(z.object({
      name: LocalizableSchema,
      form: z.enum(ARTIFACT_FORMS).optional(),
      /** People asked to contribute each time. */
      participants: z.number().int().nonnegative().optional(),
      /** Effort per item, all participants together (part of the step's touchMinutes). */
      minutes: z.number().nonnegative().optional(),
      minutesEvidence: MetricEvidenceSchema.optional(),
      participantsEvidence: MetricEvidenceSchema.optional(),
    }).passthrough()).optional(),
    /** Stage ids that take over the outputs. */
    next: z.array(z.string()).default([]),
    /** A team outside this pack that takes over (e.g. "Account team", "Partner"). */
    handoffTo: z.array(LocalizableSchema).optional(),
    /** Step 1: the measured or stated current state. */
    asIs: StepMetricsSchema.optional(),
    /** Step 2: what becomes of the step. Values without a source are hypotheses until measured. */
    toBe: z.object({
      change: z.enum(STEP_CHANGES),
      metrics: StepMetricsSchema.optional(),
      note: LocalizableSchema.optional(),
      /** For `combine`: the stage that absorbs this one. */
      into: z.string().optional(),
      basis: z.enum(['stated', 'hypothesis']).optional(),
    }).passthrough().optional(),
    sourceIds: SourceIds,
  }).passthrough()).min(1),
  /** Work that goes round: rework back to an earlier step, a planned iteration (e.g. a weekly re-plan) or feedback. */
  loops: z.array(z.object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    kind: z.enum(LOOP_KINDS),
    state: z.enum(LOOP_STATES).optional(),
    label: LocalizableSchema.optional(),
    /** Share of items that go round (rework), in percent. */
    ratePct: z.number().min(0).max(100).optional(),
    rateEvidence: MetricEvidenceSchema.optional(),
    /** How often an iteration repeats (e.g. "weekly"). */
    cadence: LocalizableSchema.optional(),
    sourceIds: SourceIds,
  }).passthrough()).optional(),
  /** A KPI that measures the time from one stage to another; the app compares it with the sum of the steps. */
  kpiSpans: z.array(z.object({
    kpiId: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  }).passthrough()).optional(),
}).passthrough();
export type WorkflowExtension = z.infer<typeof WorkflowExtension>;
export type WorkflowStage = WorkflowExtension['stages'][number];

/** The display name of an input or output, plain or structured. */
export const artifactName = (a: Artifact): Localizable => (typeof a === 'object' && 'name' in a ? a.name as Localizable : a as Localizable);

/**
 * KPI and OKR definitions as the organisation writes them ("20% of billed revenue", "NSAT ≥ 4.5"). Unlike kpi
 * entities they need no baseline, current value or owner, which internal documents rarely state together.
 */
export const OkrExtension = z.object({
  kpis: z.array(z.object({
    id: z.string().min(1),
    name: LocalizableSchema,
    definition: LocalizableSchema.optional(),
    target: z.string().optional(),
    current: z.string().optional(),
    unit: z.string().optional(),
    period: z.string().optional(),
    owner: LocalizableSchema.optional(),
    /** FR-341: an id in orgUnits — the organisation this KPI belongs to. */
    orgUnitId: z.string().optional(),
    sourceIds: SourceIds,
  }).passthrough()).default([]),
  objectives: z.array(z.object({
    id: z.string().min(1),
    objective: LocalizableSchema,
    owner: LocalizableSchema.optional(),
    orgUnitId: z.string().optional(),
    keyResults: z.array(z.object({
      text: LocalizableSchema,
      target: z.string().optional(),
      period: z.string().optional(),
      /** An id in extensions.okr.kpis or a kpi entity. */
      kpiId: z.string().optional(),
    }).passthrough()).default([]),
    sourceIds: SourceIds,
  }).passthrough()).default([]),
  /**
   * FR-313: whether the customer has its own KPI/OKR definition. defined = found and recorded; partial = some found
   * (e.g. KPIs without objectives); undefined = the material says there is none; notRetrieved = could not be checked.
   */
  definitionStatus: z.enum(['defined', 'partial', 'undefined', 'notRetrieved']).optional(),
  /** What was searched to decide the status (document names, meetings), so the claim can be checked. */
  checkedSources: z.array(z.string()).optional(),
  /**
   * FR-341: the organisations the KPI/OKR belong to — the company itself and the business unit the purpose concerns.
   * basis: userInput = typed when generating; stated = named in the material; inferred = estimated from the purpose
   * and Work IQ material (reason and sourceIds say why).
   */
  orgUnits: z.array(z.object({
    id: z.string().min(1),
    level: z.enum(ORG_LEVELS),
    name: z.string().min(1),
    basis: z.enum(['userInput', 'stated', 'inferred']),
    reason: z.string().optional(),
    sourceIds: SourceIds,
  }).passthrough()).optional(),
}).passthrough();
export type OkrExtension = z.infer<typeof OkrExtension>;

/** Sourced work records whose material need not state deal amounts or initiative progress. Always internal. */
export const EngagementsExtension = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    name: LocalizableSchema,
    type: z.enum(['workshop', 'briefing', 'poc', 'programme', 'deliverable', 'deal', 'other']).optional(),
    period: z.string().trim().min(1).optional(),
    customer: z.string().trim().min(1).optional(),
    customerId: z.string().min(1).optional(),
    status: z.string().trim().min(1).optional(),
    owner: z.string().optional(),
    count: z.string().optional(),
    outcome: z.string().optional(),
    sourceIds: z.array(z.string().min(1)).min(1),
  }).passthrough()),
}).passthrough();
export type EngagementsExtension = z.infer<typeof EngagementsExtension>;

/** low ≤ mode ≤ high, all positive. */
export const PositiveRangeSchema = z.object({ low: z.number().positive(), mode: z.number().positive(), high: z.number().positive() })
  .refine((r) => r.low <= r.mode && r.mode <= r.high, { message: 'low ≤ mode ≤ high' });
/** low ≤ mode ≤ high, all zero or more. */
export const NonNegativeRangeSchema = z.object({ low: z.number().nonnegative(), mode: z.number().nonnegative(), high: z.number().nonnegative() })
  .refine((r) => r.low <= r.mode && r.mode <= r.high, { message: 'low ≤ mode ≤ high' });

/**
 * FR-365: the two numbers a Cost of Delay ranking needs per issue, as stated in the material: the value lost per month
 * while the issue stays unsolved, and the months left until it is solved. Only stated figures, each with its quote.
 * FR-383: also the months until the issue's impact arrives (0 = already), compared with the time to respond for urgency.
 */
export const DelayCostExtension = z.object({
  items: z.array(z.object({
    issueId: z.string().min(1),
    valuePerMonthJpy: PositiveRangeSchema.optional(),
    durationMonths: PositiveRangeSchema.optional(),
    impactMonths: NonNegativeRangeSchema.optional(),
    quote: z.string().trim().min(1),
    sourceIds: z.array(z.string().min(1)).min(1),
  }).passthrough().refine((i) => i.valuePerMonthJpy !== undefined || i.durationMonths !== undefined || i.impactMonths !== undefined, { message: 'valuePerMonthJpy, durationMonths or impactMonths is required' })),
}).passthrough();
export type DelayCostExtension = z.infer<typeof DelayCostExtension>;

/**
 * FR-386 (AI First Analytics): the customer's AI platform as a set of capabilities in eight layers, and the business
 * areas that climb it. A level is 0 none, 1 pilot, 2 standard in a unit, 3 enterprise-wide. `basis` keeps a judgement
 * backed by evidence (a document, a report, telemetry) apart from a self-report, so the screen never shows a claim as
 * a measured fact. Every list is optional: an absent capability means "not assessed", not "none".
 */
export const AI_LAYERS = ['business', 'experience', 'workflow', 'model', 'context', 'data', 'trust', 'evaluate'] as const;
export type AiLayer = (typeof AI_LAYERS)[number];
export const AI_CAPABILITIES = [
  'outcomes', 'coe', 'identity', 'oversharing', 'evals', 'copilot', 'devGuardrails', 'registry', 'vibeCoding',
  'dataProducts', 'grounding', 'agentIdentity', 'modelRouting', 'delegation',
] as const;
export type AiCapabilityId = (typeof AI_CAPABILITIES)[number];
/** Area checks: the exit criteria a business area meets itself (the platform capabilities are judged separately). */
export const AI_AREA_CHECKS = ['baseline', 'rubric', 'sponsor', 'adoption', 'kpiLink', 'built', 'dataProduct', 'grounded', 'delegated', 'hitl'] as const;
export type AiAreaCheckId = (typeof AI_AREA_CHECKS)[number];
export const AI_BASES = ['evidence', 'selfReport'] as const;
export type AiBasis = (typeof AI_BASES)[number];

const AiJudgement = {
  basis: z.enum(AI_BASES),
  note: LocalizableSchema.optional(),
  sourceIds: z.array(z.string()).optional(),
  at: z.string().optional(),
  by: z.string().optional(),
};
export const AiCapabilityStateSchema = z.object({ id: z.enum(AI_CAPABILITIES), level: z.number().int().min(0).max(3), ...AiJudgement }).passthrough();
export type AiCapabilityState = z.infer<typeof AiCapabilityStateSchema>;
export const AiAreaCheckSchema = z.object({ id: z.enum(AI_AREA_CHECKS), met: z.boolean(), ...AiJudgement }).passthrough();
export type AiAreaCheck = z.infer<typeof AiAreaCheckSchema>;
/** One turn of the loop: an evaluation against the area's own rubric (0–100, higher is better). */
export const AiEvaluationSchema = z.object({
  date: z.iso.date(),
  score: z.number().min(0).max(100),
  metric: LocalizableSchema,
  note: LocalizableSchema.optional(),
  sourceIds: z.array(z.string()).optional(),
}).passthrough();
export type AiEvaluation = z.infer<typeof AiEvaluationSchema>;
export const AiAreaSchema = z.object({
  id: z.string().min(1),
  name: LocalizableSchema,
  /** The solutions (pack solution ids) this area puts to work. */
  solutionIds: z.array(z.string()).default([]),
  approach: z.enum(['adoption', 'first']).optional(),
  checks: z.array(AiAreaCheckSchema).default([]),
  evaluations: z.array(AiEvaluationSchema).default([]),
}).passthrough();
export type AiArea = z.infer<typeof AiAreaSchema>;
export const AiPlatformExtension = z.object({
  capabilities: z.array(AiCapabilityStateSchema).default([]),
  areas: z.array(AiAreaSchema).default([]),
}).passthrough();
export type AiPlatformExtension = z.infer<typeof AiPlatformExtension>;

export function hasEngagementContext(item: EngagementsExtension['items'][number]): boolean {
  return !!(item.period || item.customer || item.customerId || item.status);
}

/**
 * Material a requirements definition needs and a pack rarely holds: the rules a solution must obey (laws, standards,
 * internal policies, security, privacy, SLAs, AI use policy, operating rules), the voices of users (inquiries,
 * complaints, incidents, audit findings, feedback) and the data an AI is evaluated on. Each item cites its sources
 * (IPA requirements handbook 8.1, 12, 13). Always internal.
 */
export const EVIDENCE_KINDS = ['law', 'standard', 'policy', 'security', 'privacy', 'sla', 'aiPolicy', 'operations', 'system', 'inquiry', 'complaint', 'incident', 'audit', 'feedback', 'evalData'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
/** What a solution must obey or live with: rules, and the current systems and how they are run. */
export const RULE_KINDS = ['law', 'standard', 'policy', 'security', 'privacy', 'sla', 'aiPolicy', 'operations', 'system'] as const;
export const VOICE_KINDS = ['inquiry', 'complaint', 'incident', 'audit', 'feedback'] as const;
export const isRuleKind = (k: EvidenceKind): boolean => (RULE_KINDS as readonly string[]).includes(k);
export const isVoiceKind = (k: EvidenceKind): boolean => (VOICE_KINDS as readonly string[]).includes(k);

export const RequirementEvidenceExtension = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(EVIDENCE_KINDS),
    title: LocalizableSchema,
    summary: LocalizableSchema,
    /** Voices: how many records the summary stands for. */
    count: z.number().int().nonnegative().optional(),
    /** Voices: 1 (minor) to 5 (severe), independent of how often it happens. */
    severity: z.number().int().min(1).max(5).optional(),
    sourceIds: z.array(z.string().min(1)).min(1),
  }).passthrough()),
}).passthrough();
export type RequirementEvidenceExtension = z.infer<typeof RequirementEvidenceExtension>;

/**
 * FR-321: evidence labels a Microsoft 365 Copilot business report puts on its statements
 * (【事実】 fact, 【外部】 external, 【仮説】 hypothesis, 【解釈】 interpretation, 【要確認】 toConfirm, 【提案目標】 proposedTarget).
 */
export const REPORT_EVIDENCE = ['fact', 'external', 'interpretation', 'hypothesis', 'proposedTarget', 'toConfirm'] as const;
export type ReportEvidence = (typeof REPORT_EVIDENCE)[number];
/** The improvement step a report section informs; overview and appendix inform every step. */
export const REPORT_STEPS = ['overview', 'asis', 'tobe', 'kpi', 'solution', 'deliverable', 'appendix'] as const;
export type ReportStep = (typeof REPORT_STEPS)[number];

/** Every item keeps the 1-based line of the report it came from, so a reader can check it against the original. */
const Located = { id: z.string().regex(/^[a-z0-9-]+$/), line: z.number().int().positive() };
/** The report's own ordinal rating: 1 low, 2 medium, 3 high; ranges such as "low to medium" become 1.5. */
const Ordinal = z.number().min(1).max(3);

/**
 * FR-321: a decision report (Microsoft 365 Copilot business analysis) imported without loss. Text stays in the
 * report's language; nothing is translated, scored or estimated on import. Every paragraph is kept with its line
 * (`paragraphs`), and the structured lists point back to those lines.
 */
export const DecisionReportExtension = z.object({
  format: z.literal('m365-copilot-report/1'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  asOf: z.iso.date().optional(),
  target: z.string().optional(),
  positioning: z.string().optional(),
  lang: z.enum(['ja', 'en']),
  /** The source entity for the report file. */
  sourceId: z.string().min(1),
  sections: z.array(z.object({
    ...Located,
    title: z.string().min(1),
    level: z.number().int().min(1).max(6),
    step: z.enum(REPORT_STEPS),
    purpose: z.string().optional(),
    /** Sentences in the section, labelled or not (the denominator of the evidence profile). */
    sentences: z.number().int().nonnegative(),
  }).passthrough()),
  paragraphs: z.array(z.object({ line: z.number().int().positive(), sectionId: z.string(), text: z.string().min(1) }).passthrough()),
  claims: z.array(z.object({ ...Located, sectionId: z.string(), evidence: z.enum(REPORT_EVIDENCE), text: z.string().min(1) }).passthrough()),
  issues: z.array(z.object({
    ...Located,
    title: z.string().min(1),
    priority: Ordinal.optional(),
    phenomenon: z.string().optional(),
    rootCause: z.string().optional(),
    impact: z.string().optional(),
    falsifier: z.string().optional(),
    evidence: z.array(z.enum(REPORT_EVIDENCE)),
    text: z.string(),
  }).passthrough()),
  gaps: z.array(z.object({
    ...Located,
    area: z.string().min(1),
    asIs: z.string().optional(),
    toBe: z.string().optional(),
    gap: z.string().optional(),
    action: z.string().optional(),
    priority: Ordinal.optional(),
  }).passthrough()),
  options: z.array(z.object({
    ...Located,
    label: z.string().min(1),
    title: z.string().min(1),
    priority: Ordinal.optional(),
    effect: z.string().optional(),
    difficulty: Ordinal.optional(),
    investment: Ordinal.optional(),
    risk: z.string().optional(),
    text: z.string(),
  }).passthrough()),
  roadmap: z.array(z.object({
    ...Located,
    title: z.string().min(1),
    actions: z.string().optional(),
    purpose: z.string().optional(),
    owners: z.string().optional(),
    deliverables: z.string().optional(),
    kpis: z.string().optional(),
  }).passthrough()),
  kpis: z.array(z.object({ ...Located, category: z.string().optional(), name: z.string().min(1), definition: z.string().optional() }).passthrough()),
  risks: z.array(z.object({ ...Located, name: z.string().min(1), description: z.string().optional(), mitigation: z.string().optional() }).passthrough()),
  openQuestions: z.array(z.object({ ...Located, text: z.string().min(1) }).passthrough()),
  assumptions: z.array(z.object({ ...Located, text: z.string().min(1) }).passthrough()),
  swot: z.object({
    strengths: z.array(z.string()), weaknesses: z.array(z.string()), opportunities: z.array(z.string()), threats: z.array(z.string()),
  }).optional(),
}).passthrough();
export type DecisionReport = z.infer<typeof DecisionReportExtension>;

export const CoreObjectExtension = z.object({
  candidates: z.array(z.object({
    name: z.string().optional(),
    label: z.string().optional(),
    summary: z.string().optional(),
    scores: z.record(z.string(), z.string()).optional(),
  }).passthrough()).optional(),
  criteria: z.array(z.object({ id: z.string(), label: z.string() }).passthrough()).optional(),
  reason: z.string().optional(),
}).passthrough();
