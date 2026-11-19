import { z } from 'zod';
import { LocalizableSchema, ORG_LEVELS } from '../modules/project/model.ts';

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

/**
 * The team's own work as a chain of stages (sales and service organisations as well as plants): what comes in, what
 * the team does with it, what it hands over and to which team. Each stage cites the material it comes from.
 */
export const WorkflowExtension = z.object({
  stages: z.array(z.object({
    id: z.string().min(1),
    name: LocalizableSchema,
    team: LocalizableSchema.optional(),
    inputs: z.array(LocalizableSchema).default([]),
    activities: z.array(LocalizableSchema).default([]),
    outputs: z.array(LocalizableSchema).default([]),
    /** Reports, systems and data the stage reads or writes. */
    data: z.array(LocalizableSchema).optional(),
    /** Stage ids that take over the outputs. */
    next: z.array(z.string()).default([]),
    /** A team outside this pack that takes over (e.g. "Account team", "Partner"). */
    handoffTo: z.array(LocalizableSchema).optional(),
    sourceIds: SourceIds,
  }).passthrough()).min(1),
}).passthrough();
export type WorkflowExtension = z.infer<typeof WorkflowExtension>;

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

export function hasEngagementContext(item: EngagementsExtension['items'][number]): boolean {
  return !!(item.period || item.customer || item.customerId || item.status);
}

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
