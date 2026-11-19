import { z } from 'zod';
import type { LoadedPack } from '../../data/pack.ts';
import type { EntityOf } from '../../data/schema.ts';
import type { UseCase } from '../usecases/store.ts';
import { DEFINITION_STATUSES } from './kpiOkr.ts';
import type { KpiData, KpiOrigin } from './model.ts';
import {
  clearSectionStamp, normalizeRequirementExtras, stampSection,
  type RequirementExtras,
} from './requirementsModel.ts';
import { EVIDENCE_BASES, simulate, type KpiSimulation } from './simulate.ts';

/**
 * Strategy linkage (FR-312〜FR-316): company objective → OKR objective → key result / KPI → solution → use case /
 * initiative → deliverable. The chain follows the strategy map (Kaplan & Norton, HBR 2000) and the benefits dependency
 * network (Ward, Daniel & Peppard, MISQE 2008): every solution is a change that must reach a measured benefit, and
 * every benefit must serve an objective. Project-scoped data that the Project pack does not hold lives here.
 */

/**
 * What kind of change a solution is. Business problems are not solved by IT alone: process, people/organisation and
 * policy, assets and partners are first-class changes with their own deliverable (Ward & Daniel: business changes and
 * enabling changes; Kotter, HBR 1995, for changes in people and organisation).
 */
export const SOLUTION_TYPES = ['digital', 'prompt', 'agent', 'process', 'people', 'asset', 'partner'] as const;
export type SolutionType = (typeof SOLUTION_TYPES)[number];

/**
 * "digital" is an application (a system with fixed behaviour); "prompt" is an instruction to a generative AI that people
 * run themselves; "agent" is an AI that acts or decides within limits. They share the system's deliverables but differ in
 * what must be specified (IPA requirements handbook 5.3, 5.4, 8.5).
 */
export const isSystemType = (t: SolutionType): boolean => t === 'digital' || t === 'prompt' || t === 'agent';

/** The final deliverable that fits each type. */
export const DELIVERABLE_OF: Record<SolutionType, 'requirements' | 'promptSpec' | 'agentSpec' | 'processPlan' | 'changePlan' | 'investmentPlan' | 'sourcingPlan'> = {
  digital: 'requirements',
  prompt: 'promptSpec',
  agent: 'agentSpec',
  process: 'processPlan',
  people: 'changePlan',
  asset: 'investmentPlan',
  partner: 'sourcingPlan',
};
export type DeliverableKind = (typeof DELIVERABLE_OF)[SolutionType];

const Range3Schema = z.object({ low: z.number(), mode: z.number(), high: z.number() });

export const ContributionSchema = z.object({
  id: z.string().min(1),
  solutionId: z.string().min(1),
  kpiId: z.string().min(1),
  /** What is done (e.g. "orders entered on the new screen"). */
  lever: z.string(),
  /** Unit of the lever amount (e.g. "%", "people", "sites"). */
  leverUnit: z.string(),
  amount: Range3Schema,
  /** KPI change per lever unit, towards the target (positive = improvement). */
  effectPerUnit: Range3Schema,
  rampStart: z.string(),
  fullEffect: z.string(),
  basis: z.enum(EVIDENCE_BASES),
  /** Where the numbers come from (pilot, benchmark, interview…). */
  evidence: z.string(),
});
export type Contribution = z.infer<typeof ContributionSchema>;

const ByWhom = z.object({ at: z.string(), by: z.string() });
const TypeEntrySchema = z.object({ type: z.enum(SOLUTION_TYPES), at: z.string(), by: z.string() });

export const StrategyDataSchema = z.object({
  /** Solution id → its type, set by a person. Absent = inferred (not confirmed). */
  types: z.record(z.string(), TypeEntrySchema),
  contributions: z.array(ContributionSchema),
  /** Solution id → section id → text written by a person (overrides the generated text). */
  sections: z.record(z.string(), z.record(z.string(), z.string())),
  /** The definition status confirmed in the app (e.g. the customer said there is none). Overrides the pack's. */
  definition: z.object({ status: z.enum(DEFINITION_STATUSES), note: z.string() }).extend(ByWhom.shape).optional().catch(undefined),
});
/** The strategy data and the requirement management parts (ledger, evidence, signals, change records) next to it. */
export type StrategyData = z.infer<typeof StrategyDataSchema> & RequirementExtras;

export const emptyStrategy = (): StrategyData => ({ types: {}, contributions: [], sections: {} });

export function normalizeStrategy(raw: unknown): StrategyData {
  if (!raw || typeof raw !== 'object') return emptyStrategy();
  const r = raw as Record<string, unknown>;
  const types = z.record(z.string(), z.unknown()).safeParse(r.types);
  const okTypes = Object.fromEntries(Object.entries(types.success ? types.data : {}).flatMap(([k, v]) => {
    const p = TypeEntrySchema.safeParse(v);
    return p.success ? [[k, p.data]] : [];
  }));
  const contributions = Array.isArray(r.contributions) ? r.contributions.flatMap((c) => {
    const p = ContributionSchema.safeParse(c);
    return p.success ? [p.data] : [];
  }) : [];
  const sections = StrategyDataSchema.shape.sections.safeParse(r.sections);
  const definition = StrategyDataSchema.shape.definition.safeParse(r.definition);
  return {
    types: okTypes, contributions, sections: sections.success ? sections.data : {},
    ...(definition.success && definition.data ? { definition: definition.data } : {}),
    ...normalizeRequirementExtras(r),
  };
}

/** Type of a solution: the confirmed one, else inferred (Microsoft products named → digital, else process). */
export function solutionType(s: EntityOf<'solution'>, data: StrategyData): { type: SolutionType; confirmed: boolean } {
  const set = data.types[s.id];
  if (set) return { type: set.type, confirmed: true };
  return { type: s.msProducts.length ? 'digital' : 'process', confirmed: false };
}

export interface CompanyObjective {
  id: string;
  text: string;
}

export interface StrategyContext {
  pack: LoadedPack;
  kpi: KpiData;
  useCases: UseCase[];
  strategy: StrategyData;
  /** Objectives of the company anchor (empty when the company has none). */
  objectives: CompanyObjective[];
  /** Objectives the project itself is aligned to (Project.alignments). */
  projectObjectiveIds: string[];
}

export interface ThreadSolution {
  id: string;
  type: SolutionType;
  typeConfirmed: boolean;
  deliverable: DeliverableKind;
  kpiIds: string[];
  contributionKpiIds: string[];
  useCaseIds: string[];
  initiativeIds: string[];
}

export interface StrategyThread {
  objectives: { id: string; text: string; okrIds: string[]; viaProject: boolean }[];
  okrs: { id: string; objectiveIds: string[]; inherited: boolean; kpiIds: string[]; origin?: KpiOrigin }[];
  kpis: { id: string; okrIds: string[]; solutionIds: string[]; origin?: KpiOrigin }[];
  solutions: ThreadSolution[];
  sims: KpiSimulation[];
  gaps: {
    okrsWithoutObjective: string[];
    kpisWithoutOkr: string[];
    kpisWithoutSolution: string[];
    solutionsWithoutKpi: string[];
    solutionsWithoutContribution: string[];
    digitalWithoutUseCase: string[];
  };
}

/** The whole chain and its breaks, computed deterministically from the project data. */
export function strategyThread(c: StrategyContext): StrategyThread {
  const solutions = c.pack.pack.entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution');
  const inits = c.pack.pack.entities.filter((e): e is EntityOf<'initiative'> => e.kind === 'initiative');
  const kpiIds = new Set(c.kpi.kpis.map((k) => k.id));
  const known = new Set(c.objectives.map((o) => o.id));
  const projectObj = c.projectObjectiveIds.filter((id) => known.has(id));
  const okrs = c.kpi.okrs.map((o) => {
    const own = (o.companyObjectiveIds ?? []).filter((id) => known.has(id));
    const objectiveIds = own.length ? own : projectObj;
    return { id: o.id, objectiveIds, inherited: own.length === 0 && objectiveIds.length > 0, kpiIds: o.keyResults.map((kr) => kr.kpiId), ...(o.origin ? { origin: o.origin } : {}) };
  });
  const threadSolutions: ThreadSolution[] = solutions.map((s) => {
    const t = solutionType(s, c.strategy);
    const contributionKpiIds = [...new Set(c.strategy.contributions.filter((x) => x.solutionId === s.id).map((x) => x.kpiId))];
    return {
      id: s.id,
      type: t.type,
      typeConfirmed: t.confirmed,
      deliverable: DELIVERABLE_OF[t.type],
      kpiIds: [...new Set([...s.kpiIds.filter((id) => kpiIds.has(id)), ...contributionKpiIds.filter((id) => kpiIds.has(id))])],
      contributionKpiIds,
      useCaseIds: c.useCases.filter((u) => u.origin === 'registered' && u.relatedIds.includes(s.id)).map((u) => u.id),
      initiativeIds: inits.filter((i) => i.solutionId === s.id).map((i) => i.id),
    };
  });
  const kpis = c.kpi.kpis.map((k) => ({
    id: k.id,
    okrIds: okrs.filter((o) => o.kpiIds.includes(k.id)).map((o) => o.id),
    solutionIds: threadSolutions.filter((s) => s.kpiIds.includes(k.id)).map((s) => s.id),
    ...(k.origin ? { origin: k.origin } : {}),
  }));
  const objectives = c.objectives.map((o) => ({
    id: o.id,
    text: o.text,
    okrIds: okrs.filter((x) => x.objectiveIds.includes(o.id)).map((x) => x.id),
    viaProject: projectObj.includes(o.id),
  }));
  const sims = simulate(c.kpi.kpis.map((k) => ({ id: k.id, baseline: k.baseline, current: k.current, target: k.target, deadline: k.deadline })), c.strategy.contributions);
  return {
    objectives,
    okrs,
    kpis,
    solutions: threadSolutions,
    sims,
    gaps: {
      okrsWithoutObjective: c.objectives.length ? okrs.filter((o) => o.objectiveIds.length === 0).map((o) => o.id) : [],
      kpisWithoutOkr: kpis.filter((k) => k.okrIds.length === 0).map((k) => k.id),
      kpisWithoutSolution: kpis.filter((k) => k.solutionIds.length === 0).map((k) => k.id),
      solutionsWithoutKpi: threadSolutions.filter((s) => s.kpiIds.length === 0).map((s) => s.id),
      solutionsWithoutContribution: threadSolutions.filter((s) => s.contributionKpiIds.length === 0).map((s) => s.id),
      digitalWithoutUseCase: threadSolutions.filter((s) => isSystemType(s.type) && s.useCaseIds.length === 0).map((s) => s.id),
    },
  };
}

/** Number of breaks in the chain (0 = every item is linked up to the company). */
export const gapCount = (t: StrategyThread) => Object.values(t.gaps).reduce((a, g) => a + g.length, 0);

export function setSolutionType(data: StrategyData, solutionId: string, type: SolutionType | null, by: string, at: string): StrategyData {
  const types = { ...data.types };
  if (type === null) delete types[solutionId];
  else types[solutionId] = { type, by, at };
  return { ...data, types };
}

export function upsertContribution(data: StrategyData, c: Contribution): StrategyData {
  const i = data.contributions.findIndex((x) => x.id === c.id);
  const contributions = i < 0 ? [...data.contributions, c] : data.contributions.map((x, n) => (n === i ? c : x));
  return { ...data, contributions };
}

export const removeContribution = (data: StrategyData, id: string): StrategyData => ({ ...data, contributions: data.contributions.filter((c) => c.id !== id) });

/** Writes a section (or clears it with null). With `meta` the author and time are recorded next to the text. */
export function setSection(data: StrategyData, solutionId: string, sectionId: string, text: string | null, meta?: { by: string; at: string }): StrategyData {
  const own = { ...(data.sections[solutionId] ?? {}) };
  const cleared = text === null || !text.trim();
  if (cleared) delete own[sectionId];
  else own[sectionId] = text;
  const next: StrategyData = { ...data, sections: { ...data.sections, [solutionId]: own } };
  if (cleared) return data.sectionMeta?.[solutionId]?.[sectionId] ? clearSectionStamp(next, solutionId, sectionId) : next;
  return meta ? stampSection(next, solutionId, sectionId, meta.by, meta.at) : next;
}
