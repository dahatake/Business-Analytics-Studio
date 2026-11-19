import type { Entity, EntityOf } from '../../data/schema.ts';
import { chooseKpiVisual, kpiProgress, kpiStatus } from '../../domain/kpi.ts';
import { priorityScore } from '../../domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../../domain/summary.ts';
import type { Persona } from '../../state/personas.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import type { Localizable } from '../../state/text.ts';
import {
  cyclicInitiatives, evaluateStep, fieldIsVague, isQualifiedOut, nextTodo, paybackLimit, paybackYears, progressOf, projectHasKpi, pursuedIssues, qualificationOf, rankedIssues, STEP_DEFS, threadOf, valueMismatches,
  type CheckContext, type QualifyVerdict, type TodoResult, type ValueMismatch,
} from './deliverables.ts';
import { kpiDefinitionState, validateKpi, type DefinitionStatus } from './kpiOkr.ts';
import type { KpiOrigin } from './model.ts';
import { realisedShare, triangularMean, validRange, type KpiSimulation } from './simulate.ts';
import { isSystemType, type SolutionType } from './strategy.ts';

/**
 * FR-317: the step dashboard. Everything is computed from the Project pack and the project's saved data, and every
 * tile that stands for an exit criterion shows the same verdict as that criterion (the stepper's check mark and the
 * to-do band read `evaluateStep` too), so the dashboard can never say "all done" while the step is still open.
 */

/**
 * ratio: `value` of `total` are in order. problems: `value` problems among `total` checked (0 = in order).
 * count: `value` items exist among `total` candidates (at least one is needed).
 * `total` 0 means there is no data to judge, which the screen shows as "no data", never as 0 % or 100 %.
 */
export type TileKind = 'ratio' | 'problems' | 'count';

export interface DashTile {
  /** Message key suffix `proj.dash.tile.<id>`. */
  id: string;
  kind: TileKind;
  value: number;
  total: number;
  /** The exit criterion this tile stands for; its verdict decides the tile's state. */
  todoId?: string;
  /** Where the user looks at or fixes the data (hash path). */
  href: string;
}

export type TileTone = 'ok' | 'open' | 'empty' | 'info';

export function tileTone(tile: DashTile, results: TodoResult[]): TileTone {
  const r = tile.todoId ? results.find((x) => x.todo.id === tile.todoId) : undefined;
  if (r?.done) return 'ok';
  if (tile.total === 0) return 'empty';
  return r ? 'open' : 'info';
}

export interface DocStatus {
  total: number;
  /** Written and, where the field asks for it, with a number or a date. */
  complete: number;
  /** Written but missing the required number or date. */
  vague: number;
  /** Written by the AI draft and not yet edited by a person. */
  byAi: number;
}

export interface InputCount {
  id: string;
  count: number;
  href: string;
}

export interface IssueRow {
  id: string;
  rank: number;
  impact: number;
  feasibility: number;
  /** Weighted priority on 0–100 (impact 60 / feasibility 40): the evaluation axis the rank comes from. */
  score: number;
  sourced: boolean;
  caused: boolean;
  measured: boolean;
  /** The linked KPI furthest from its target: `remaining` = 1 − progress (1 = no progress yet). Absent without a comparable KPI. */
  gap?: { kpiId: string; remaining: number };
  /** One of its KPIs is a project KPI, so the issue is tracked by the project's KPI/OKR. */
  inProject: boolean;
  solutionIds: string[];
  /** FR-347: the person's verdict; absent = not qualified yet (a yellow light). */
  verdict?: QualifyVerdict;
}

/** A registered use case of the to-be state and what it is traced to. */
export interface UseCaseRow {
  id: string;
  name: Localizable;
  persona: Persona;
  steps: number;
  hasEffect: boolean;
  /** Issues it addresses directly or through a solution, in priority order. */
  issueIds: string[];
  kpis: number;
}

/** A ranked issue and the use cases and solutions that address it. */
export interface IssueCoverage {
  id: string;
  rank: number;
  score: number;
  useCaseIds: string[];
  solutionIds: string[];
}

/** One line of the traceability matrix: issue → KPI → use case → solution → initiative → owner. */
export interface TraceRow {
  solutionId: string;
  type: SolutionType;
  issueIds: string[];
  kpiIds: string[];
  useCaseIds: string[];
  initiativeIds: string[];
  /** Initiatives with a registered owner. */
  owned: number;
  /** Every link the solution's type needs is present (a use case only for digital solutions). */
  complete: boolean;
}

export interface KpiRow {
  id: string;
  name: Localizable;
  unit: Localizable;
  baseline: number;
  current: number;
  target: number;
  deadline: string;
  origin?: KpiOrigin;
  valid: boolean;
  ahead: boolean;
  inOkr: boolean;
}

export interface OkrRow {
  id: string;
  objective: Localizable;
  keyResults: number;
  linked: boolean;
  aligned: boolean;
}

export interface SolutionRow {
  id: string;
  type: SolutionType;
  confirmed: boolean;
  contributions: number;
  costJpy: number;
  annualBenefitJpy: number;
  /** Payback years from the start of the first initiative; Infinity when there is no benefit. */
  payback: number;
}

export interface CoverageRow {
  kpiId: string;
  name: Localizable;
  /** P50 improvement ÷ remaining gap; null when there is no gap; undefined when nothing is estimated yet. */
  coverage?: number | null;
  probability?: number;
}

export interface InitiativeRow {
  id: string;
  solutionId: string;
  start: string;
  end: string;
  progress: number;
  ownerId?: string;
  conflict: boolean;
}

/** Pareto input: a root cause weighted by the impact (1–5) of the issues it causes. */
export interface CauseBar {
  id: string;
  /** Sum of the impact of the issues linked to the cause. */
  weight: number;
  issues: number;
  /** Cumulative share of all weight up to and including this cause (sorted by weight, descending). */
  cumulative: number;
}

/** One solution's expected move of a KPI towards its target (KPI units, positive = towards the target). */
export interface BridgeStep {
  solutionId: string;
  expected: number;
}

/** The "vital few" of a Pareto: the causes up to and including the first one whose cumulative share reaches 80%. */
export function vitalCount(causes: CauseBar[]): number {
  const i = causes.findIndex((c) => c.cumulative >= 0.8 - 1e-9);
  return i >= 0 ? i + 1 : causes.length;
}

/** The P10–P90 range of a project KPI at its deadline, and how each solution builds the expected value. */
export interface SimRow {
  kpiId: string;
  name: Localizable;
  unit: Localizable;
  current: number;
  target: number;
  p10: number;
  p50: number;
  p90: number;
  /** current + direction × Σ bridge — the mean of the simulation's inputs (not the median). */
  expected: number;
  probability: number;
  bridge: BridgeStep[];
  warnings: KpiSimulation['warnings'];
}

export type StepDetail =
  | { step: 'asis'; issues: IssueRow[]; mismatches: ValueMismatch[]; checkedValues: number; themes: number; decisions: number; causes: CauseBar[]; kpis: EntityOf<'kpi'>[] }
  | {
    step: 'tobe';
    objectives: { id: string; text: string; linked: boolean }[];
    useCases: UseCaseRow[];
    /** The top pursued issues by priority and the use cases that describe their solved state. */
    topIssues: IssueCoverage[];
    /** Issues qualified out in the As-Is (FR-347): not counted here. */
    qualifiedOut: number;
    /** KPIs and OKRs this project added (origin 'proposed'): hypotheses until the sponsor agrees. */
    proposed: { kpis: KpiRow[]; okrs: OkrRow[] };
  }
  | { step: 'kpi'; definition: DefinitionStatus; kpis: KpiRow[]; okrs: OkrRow[] }
  | { step: 'solution'; solutions: SolutionRow[]; coverage: CoverageRow[]; sims: SimRow[]; issues: IssueCoverage[]; qualifiedOut: number }
  | { step: 'deliverable'; initiatives: InitiativeRow[]; paybackLimit: number; solutions: SolutionRow[]; gaps: number; trace: TraceRow[] };

/** The detail of one step. */
export type DetailOf<S extends ImprovementStep> = Extract<StepDetail, { step: S }>;

export interface StepDashboard {
  step: ImprovementStep;
  results: TodoResult[];
  progress: { done: number; total: number; complete: boolean };
  next?: TodoResult;
  tiles: DashTile[];
  doc: DocStatus;
  inputs: InputCount[];
  detail: StepDetail;
}

const entities = <K extends Entity['kind']>(c: CheckContext, kind: K) => c.pack.pack.entities.filter((e): e is EntityOf<K> => e.kind === kind);

const isKind = (c: CheckContext, id: string, kind: string) => c.pack.byId.get(id)?.kind === kind;
const issueKpis = (c: CheckContext, issue: EntityOf<'issue'>) =>
  issue.kpiIds.map((id) => c.pack.byId.get(id)).filter((e): e is EntityOf<'kpi'> => e?.kind === 'kpi');
const str = (v: Localizable) => (typeof v === 'string' ? v : v.ja || v.en);
const docTodo: Record<ImprovementStep, string> = { asis: 'asis-doc', tobe: 'tobe-doc', kpi: 'kpi-doc', solution: 'uc-doc', deliverable: 'plan-doc' };
const docHref = (step: ImprovementStep) => `/deliverables?step=${step}`;

const comparableKpi = (k: EntityOf<'kpi'>) => Number.isFinite(k.baseline) && Number.isFinite(k.current) && Number.isFinite(k.target) && k.target !== k.baseline;

/** The KPI furthest from its target among an issue's KPIs (the gap the To-Be has to close). */
function worstGap(kpis: EntityOf<'kpi'>[]): IssueRow['gap'] {
  let worst: IssueRow['gap'];
  for (const k of kpis.filter(comparableKpi)) {
    const remaining = 1 - kpiProgress(k);
    if (!worst || remaining > worst.remaining) worst = { kpiId: k.id, remaining };
  }
  return worst;
}

/** The registered use cases (the To-Be) with the issues they address, directly or through a solution. */
function useCaseRows(c: CheckContext): UseCaseRow[] {
  const ranked = rankedIssues(c.pack).map((i) => i.id);
  const solutions = entities(c, 'solution');
  const projectKpis = new Set(c.kpi.kpis.map((k) => k.id));
  return c.useCases.filter((u) => u.origin === 'registered').map((u) => {
    const issueIds = new Set(u.relatedIds.filter((id) => isKind(c, id, 'issue')));
    for (const s of solutions) if (u.relatedIds.includes(s.id)) s.issueIds.forEach((id) => issueIds.add(id));
    return {
      id: u.id,
      name: u.name,
      persona: u.persona,
      steps: u.steps.length,
      hasEffect: !!u.effect && (typeof u.effect === 'string' ? u.effect.trim() !== '' : [u.effect.ja, u.effect.en].some((s) => s.trim() !== '')),
      issueIds: ranked.filter((id) => issueIds.has(id)),
      kpis: new Set(u.relatedIds.filter((id) => projectKpis.has(id) || isKind(c, id, 'kpi'))).size,
    };
  });
}

/** Every pursued issue (FR-347: issues qualified out are left out) with the use cases and solutions that address it. */
function issueCoverage(c: CheckContext, useCases: UseCaseRow[]): IssueCoverage[] {
  const solutions = entities(c, 'solution');
  return pursuedIssues(c).map((i, n) => ({
    id: i.id,
    rank: n + 1,
    score: priorityScore(i, DEFAULT_WEIGHTS),
    useCaseIds: useCases.filter((u) => u.issueIds.includes(i.id)).map((u) => u.id),
    solutionIds: solutions.filter((s) => s.issueIds.includes(i.id)).map((s) => s.id),
  }));
}

/** How many top issues the To-Be must describe (the vital few). */
export const TOP_ISSUES = 3;

const qualifiedOutCount = (c: CheckContext) => entities(c, 'issue').filter((i) => isQualifiedOut(c.deliverables, i.id)).length;

/** How much of each existing input a step can use. */
export function inputCount(id: string, c: CheckContext): number {
  const n = (kind: string) => c.pack.pack.entities.filter((e) => e.kind === kind).length;
  switch (id) {
    case 'issues': return n('issue');
    case 'causes': return n('cause');
    case 'sources': return n('source');
    case 'discussion': return c.discussion.themes.length + c.discussion.records.length;
    case 'analyses': return c.analysis.analyses.length;
    case 'kpis': return n('kpi');
    case 'flows': return n('deal') + n('deliverable') + n('invoice');
    case 'projectKpis': return c.kpi.kpis.length;
    case 'okrs': return c.kpi.okrs.length;
    case 'objectives': return c.objectives?.length ?? 0;
    case 'useCases': return c.useCases.filter((u) => u.origin === 'registered').length;
    case 'solutions': return n('solution');
    case 'personas': return new Set(c.useCases.map((u) => u.persona)).size;
    case 'initiatives': return n('initiative');
    case 'people': return n('person');
    default: return 0;
  }
}

/** The screen where each input is kept. */
const INPUT_HREF: Record<string, string> = {
  issues: '/relations', causes: '/relations', sources: '/data', discussion: '/discussion', analyses: '/analysis', kpis: '/analysis?tab=kpi',
  flows: '/flows', projectKpis: '/analysis?tab=kpi', okrs: '/analysis?tab=kpi', objectives: '/projects', useCases: '/usecases',
  solutions: '/deliverables?step=solution', personas: '/usecases', initiatives: '/plan', people: '/directory',
};

export function docStatus(step: ImprovementStep, c: CheckContext): DocStatus {
  const doc = c.deliverables.docs[step] ?? {};
  const fields = STEP_DEFS[step].fields;
  let complete = 0;
  let vague = 0;
  let byAi = 0;
  for (const f of fields) {
    const v = doc[f.id];
    const text = v?.text.trim() ?? '';
    if (!text) continue;
    if (v?.author === 'ai') byAi += 1;
    if (fieldIsVague(f, text)) vague += 1;
    else complete += 1;
  }
  return { total: fields.length, complete, vague, byAi };
}

function asis(c: CheckContext): { tiles: DashTile[]; detail: StepDetail } {
  const ranked = rankedIssues(c.pack);
  const solutions = entities(c, 'solution');
  const issues: IssueRow[] = ranked.map((i, n) => {
    const linked = issueKpis(c, i);
    const gap = worstGap(linked);
    const verdict = qualificationOf(c.deliverables, i.id)?.verdict;
    return {
      id: i.id,
      rank: n + 1,
      impact: i.impact,
      feasibility: i.feasibility,
      score: priorityScore(i, DEFAULT_WEIGHTS),
      sourced: i.sourceIds.some((s) => isKind(c, s, 'source')),
      caused: i.causeIds.some((s) => isKind(c, s, 'cause')),
      measured: linked.length > 0,
      ...(gap ? { gap } : {}),
      inProject: linked.some((k) => projectHasKpi(c.kpi.kpis, k)),
      solutionIds: solutions.filter((s) => s.issueIds.includes(i.id)).map((s) => s.id),
      ...(verdict ? { verdict } : {}),
    };
  });
  const kpis = [...new Map(ranked.flatMap((i) => issueKpis(c, i)).map((k) => [k.id, k])).values()];
  const comparable = kpis.filter((k) => k.target !== k.baseline);
  const baselined = kpis.filter((k) => Number.isFinite(k.baseline) && Number.isFinite(k.current) && k.period.ja.trim() !== '' && k.period.en.trim() !== '');
  const { checked, mismatches } = valueMismatches(c);
  const decisions = c.discussion.records.filter((r) => r.kind === 'decision').length;
  const causeIds = new Set(ranked.flatMap((i) => i.causeIds));
  const causes = entities(c, 'cause').filter((x) => causeIds.has(x.id));
  const weighted = causes.map((x) => {
    const linked = ranked.filter((i) => i.causeIds.includes(x.id));
    return { id: x.id, weight: linked.reduce((a, i) => a + i.impact, 0), issues: linked.length };
  }).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const totalWeight = weighted.reduce((a, x) => a + x.weight, 0);
  let run = 0;
  const causeBars: CauseBar[] = weighted.map((x) => ({ ...x, cumulative: totalWeight ? (run += x.weight) / totalWeight : 0 }));
  return {
    tiles: [
      { id: 'issuesSourced', kind: 'ratio', value: issues.filter((i) => i.sourced).length, total: issues.length, todoId: 'define-sources', href: '/relations?view=table' },
      { id: 'issuesCaused', kind: 'ratio', value: issues.filter((i) => i.caused).length, total: issues.length, todoId: 'define-causes', href: '/relations?view=table' },
      { id: 'causesSourced', kind: 'ratio', value: causes.filter((x) => x.sourceIds.some((s) => isKind(c, s, 'source'))).length, total: causes.length, todoId: 'asis-cause-evidence', href: '/relations?view=table' },
      { id: 'issuesMeasured', kind: 'ratio', value: issues.filter((i) => i.measured).length, total: issues.length, todoId: 'define-kpi-link', href: '/relations?view=table' },
      { id: 'baselines', kind: 'ratio', value: baselined.length, total: kpis.length, todoId: 'asis-baseline', href: '/analysis?tab=kpi' },
      { id: 'kpisAchieved', kind: 'ratio', value: comparable.filter((k) => kpiStatus(k) === 'achieved').length, total: comparable.length, href: '/analysis?tab=kpi' },
      { id: 'kpisRegressed', kind: 'problems', value: comparable.filter((k) => kpiStatus(k) === 'regressed').length, total: comparable.length, href: '/analysis?tab=kpi' },
      { id: 'mismatches', kind: 'problems', value: mismatches.length, total: checked, todoId: 'asis-reconcile', href: '/discussion' },
      { id: 'issuesQualified', kind: 'ratio', value: issues.filter((i) => i.verdict).length, total: issues.length, todoId: 'asis-qualify', href: '/step?step=asis' },
      { id: 'decisions', kind: 'count', value: decisions, total: c.discussion.themes.length, todoId: 'define-decision', href: '/discussion' },
    ],
    detail: { step: 'asis', issues, mismatches, checkedValues: checked, themes: c.discussion.themes.length, decisions, causes: causeBars, kpis },
  };
}

function tobe(c: CheckContext): { tiles: DashTile[]; detail: StepDetail } {
  const objectives = c.objectives ?? [];
  const known = new Set(objectives.map((o) => o.id));
  const linkedIds = new Set([...(c.projectObjectiveIds ?? []), ...c.kpi.okrs.flatMap((o) => o.companyObjectiveIds ?? [])].filter((id) => known.has(id)));
  const useCases = useCaseRows(c);
  const topIssues = issueCoverage(c, useCases).slice(0, TOP_ISSUES);
  const { kpis, okrs } = kpiOkrRows(c);
  const proposedOkrIds = new Set(c.kpi.okrs.filter((o) => o.origin === 'proposed').map((o) => o.id));
  const complete = useCases.filter((u) => u.steps >= 3 && u.hasEffect).length;
  const projectKpis = new Set(c.kpi.kpis.map((k) => k.id));
  const traced = c.useCases.filter((u) => u.origin === 'registered' && u.relatedIds.some((id) => projectKpis.has(id) || ['issue', 'kpi', 'solution'].includes(c.pack.byId.get(id)?.kind ?? ''))).length;
  return {
    tiles: [
      { id: 'objectivesLinked', kind: 'count', value: linkedIds.size, total: objectives.length, todoId: 'tobe-link', href: '/projects' },
      { id: 'useCases', kind: 'count', value: useCases.length, total: useCases.length, todoId: 'uc-registered', href: '/usecases' },
      { id: 'useCasesComplete', kind: 'ratio', value: complete, total: useCases.length, todoId: 'uc-complete', href: '/usecases' },
      { id: 'useCasesLinked', kind: 'ratio', value: traced, total: useCases.length, todoId: 'uc-trace', href: '/usecases' },
      { id: 'topIssuesCovered', kind: 'ratio', value: topIssues.filter((i) => i.useCaseIds.length > 0).length, total: topIssues.length, href: '/usecases' },
      { id: 'proposedKpis', kind: 'count', value: kpis.filter((k) => k.origin === 'proposed').length + proposedOkrIds.size, total: kpis.length + okrs.length, href: '/analysis?tab=kpi' },
    ],
    detail: {
      step: 'tobe',
      objectives: objectives.map((o) => ({ ...o, linked: linkedIds.has(o.id) })),
      useCases,
      topIssues,
      qualifiedOut: qualifiedOutCount(c),
      proposed: { kpis: kpis.filter((k) => k.origin === 'proposed'), okrs: okrs.filter((o) => proposedOkrIds.has(o.id)) },
    },
  };
}

function kpiOkrRows(c: CheckContext): { kpis: KpiRow[]; okrs: OkrRow[] } {
  const thread = threadOf(c);
  const inOkr = new Set(c.kpi.okrs.flatMap((o) => o.keyResults.map((kr) => kr.kpiId)));
  const ids = new Set(c.kpi.kpis.map((k) => k.id));
  const kpis: KpiRow[] = c.kpi.kpis.map((k) => ({
    id: k.id, name: k.name, unit: k.unit, baseline: k.baseline, current: k.current, target: k.target, deadline: k.deadline,
    ...(k.origin ? { origin: k.origin } : {}),
    valid: validateKpi({ name: str(k.name), unit: str(k.unit), baseline: String(k.baseline), current: String(k.current), target: String(k.target), deadline: k.deadline }).length === 0 && k.target !== k.baseline,
    ahead: k.deadline >= c.today,
    inOkr: inOkr.has(k.id),
  }));
  const okrs: OkrRow[] = c.kpi.okrs.map((o) => ({
    id: o.id,
    objective: o.objective,
    keyResults: o.keyResults.length,
    linked: o.keyResults.every((kr) => ids.has(kr.kpiId)),
    aligned: !thread.gaps.okrsWithoutObjective.includes(o.id) && (c.objectives ?? []).length > 0,
  }));
  return { kpis, okrs };
}

function kpi(c: CheckContext): { tiles: DashTile[]; detail: StepDetail } {
  const { kpis: rows, okrs } = kpiOkrRows(c);
  const issues = entities(c, 'issue').filter((i) => !isQualifiedOut(c.deliverables, i.id));
  const packKpis = entities(c, 'kpi');
  const consistent = packKpis.filter((k) => {
    const v = chooseKpiVisual(k);
    return !(v.kind === 'bullet' && (v.reason === 'inconsistentTarget' || v.reason === 'noGap'));
  });
  return {
    tiles: [
      { id: 'kpisValid', kind: 'ratio', value: rows.filter((r) => r.valid).length, total: rows.length, todoId: 'kpi-valid', href: '/analysis?tab=kpi' },
      { id: 'deadlinesAhead', kind: 'ratio', value: rows.filter((r) => r.ahead).length, total: rows.length, todoId: 'kpi-deadline', href: '/analysis?tab=kpi' },
      { id: 'targetsConsistent', kind: 'ratio', value: consistent.length, total: packKpis.length, todoId: 'kpi-direction', href: '/analysis?tab=kpi' },
      { id: 'issuesTracked', kind: 'ratio', value: issues.filter((i) => issueKpis(c, i).some((k) => projectHasKpi(c.kpi.kpis, k))).length, total: issues.length, todoId: 'kpi-coverage', href: '/analysis?tab=kpi' },
      { id: 'okrsLinked', kind: 'ratio', value: okrs.filter((o) => o.linked).length, total: okrs.length, todoId: 'kpi-okr', href: '/analysis?tab=kpi' },
      { id: 'okrsAligned', kind: 'ratio', value: okrs.filter((o) => o.aligned).length, total: okrs.length, todoId: 'kpi-company', href: '/deliverables?step=kpi' },
    ],
    detail: { step: 'kpi', definition: c.strategy?.definition?.status ?? kpiDefinitionState(c.pack.pack).status, kpis: rows, okrs },
  };
}

function solutionRows(c: CheckContext): SolutionRow[] {
  const thread = threadOf(c);
  const inits = entities(c, 'initiative');
  return entities(c, 'solution').map((s) => {
    const t = thread.solutions.find((x) => x.id === s.id);
    return {
      id: s.id,
      type: t?.type ?? 'process',
      confirmed: t?.typeConfirmed ?? false,
      contributions: (c.strategy?.contributions ?? []).filter((x) => x.solutionId === s.id).length,
      costJpy: s.costJpy,
      annualBenefitJpy: s.annualBenefitJpy,
      payback: paybackYears(s, inits),
    };
  });
}

function solution(c: CheckContext): { tiles: DashTile[]; detail: StepDetail } {
  const thread = threadOf(c);
  const solutions = solutionRows(c);
  const coverage: CoverageRow[] = c.kpi.kpis.map((k) => {
    const sim = thread.sims.find((x) => x.kpiId === k.id);
    return { kpiId: k.id, name: k.name, ...(sim ? { coverage: sim.coverage, probability: sim.probability } : {}) };
  });
  const closed = coverage.filter((r) => r.coverage !== undefined && (r.coverage === null || r.coverage >= 1));
  const issues = issueCoverage(c, useCaseRows(c));
  const contributions = c.strategy?.contributions ?? [];
  const sims: SimRow[] = c.kpi.kpis.flatMap((k) => {
    const sim = thread.sims.find((x) => x.kpiId === k.id);
    if (!sim) return [];
    // Same terms as simulate()'s `expected`, split by solution so the bridge adds up to it.
    const share = new Map<string, number>();
    for (const x of contributions) {
      if (x.kpiId !== k.id || !validRange(x.amount) || !validRange(x.effectPerUnit)) continue;
      const v = triangularMean(x.amount) * triangularMean(x.effectPerUnit) * realisedShare(x.rampStart, x.fullEffect, k.deadline);
      share.set(x.solutionId, (share.get(x.solutionId) ?? 0) + v);
    }
    const dir = Math.sign(k.target - k.current) || Math.sign(k.target - k.baseline) || 1;
    return [{
      kpiId: k.id, name: k.name, unit: k.unit, current: k.current, target: k.target,
      p10: sim.p10, p50: sim.p50, p90: sim.p90, expected: k.current + dir * sim.expected, probability: sim.probability,
      bridge: [...share].map(([solutionId, expected]) => ({ solutionId, expected })).sort((a, b) => b.expected - a.expected || a.solutionId.localeCompare(b.solutionId)),
      warnings: sim.warnings,
    }];
  });
  return {
    tiles: [
      { id: 'issuesSolved', kind: 'ratio', value: issues.filter((i) => i.solutionIds.length > 0).length, total: issues.length, todoId: 'sol-issues', href: '/relations?view=table' },
      { id: 'typesConfirmed', kind: 'ratio', value: solutions.filter((s) => s.confirmed).length, total: solutions.length, todoId: 'sol-type', href: '/deliverables?step=solution&target=sol-types' },
      { id: 'solutionsEstimated', kind: 'ratio', value: solutions.filter((s) => !thread.gaps.solutionsWithoutContribution.includes(s.id)).length, total: solutions.length, todoId: 'sol-contribution', href: '/deliverables?step=solution&target=sol-types' },
      { id: 'gapsClosed', kind: 'ratio', value: closed.length, total: coverage.length, todoId: 'sol-target', href: '/deliverables?step=solution&target=sol-sim' },
    ],
    detail: { step: 'solution', solutions, coverage, sims, issues, qualifiedOut: qualifiedOutCount(c) },
  };
}

function deliverable(c: CheckContext): { tiles: DashTile[]; detail: StepDetail } {
  const thread = threadOf(c);
  const inits = entities(c, 'initiative');
  const byId = new Map(inits.map((i) => [i.id, i]));
  const solutions = solutionRows(c);
  const limit = paybackLimit(c.deliverables);
  // Same rule as the `plan-schedule` criterion: reversed dates, a dependency loop, or a dependency that ends too late.
  const cyclic = new Set(cyclicInitiatives(inits));
  const rows: InitiativeRow[] = inits.map((i) => {
    const owner = c.pack.byId.get(i.ownerId);
    return {
      id: i.id, solutionId: i.solutionId, start: i.start, end: i.end, progress: i.progress,
      ...(owner?.kind === 'person' ? { ownerId: owner.id } : {}),
      conflict: i.start > i.end || cyclic.has(i.id) || i.dependsOn.some((d) => { const dep = byId.get(d); return !dep || dep.end >= i.start; }),
    };
  }).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const g = thread.gaps;
  const breaks = g.solutionsWithoutKpi.length + g.digitalWithoutUseCase.length + g.kpisWithoutOkr.length + g.kpisWithoutSolution.length;
  const planIds = new Set([...solutions.map((s) => s.id), ...inits.map((i) => i.id)]);
  const themes = new Set(c.discussion.themes.filter((t) => t.relatedIds.some((id) => planIds.has(id))).map((t) => t.id));
  const decisions = c.discussion.records.filter((r) => r.kind === 'decision' && themes.has(r.themeId)).length;
  const packSolutions = new Map(entities(c, 'solution').map((s) => [s.id, s]));
  const trace: TraceRow[] = thread.solutions.map((s) => {
    const issueIds = (packSolutions.get(s.id)?.issueIds ?? []).filter((id) => isKind(c, id, 'issue'));
    const owned = rows.filter((r) => r.solutionId === s.id && r.ownerId).length;
    return {
      solutionId: s.id, type: s.type, issueIds, kpiIds: s.kpiIds, useCaseIds: s.useCaseIds, initiativeIds: s.initiativeIds, owned,
      complete: issueIds.length > 0 && s.kpiIds.length > 0 && (!isSystemType(s.type) || s.useCaseIds.length > 0)
        && s.initiativeIds.length > 0 && owned === s.initiativeIds.length,
    };
  });
  return {
    tiles: [
      { id: 'solutionsPlanned', kind: 'ratio', value: solutions.filter((s) => inits.some((i) => i.solutionId === s.id)).length, total: solutions.length, todoId: 'plan-coverage', href: '/plan' },
      { id: 'initiativesOwned', kind: 'ratio', value: rows.filter((r) => r.ownerId).length, total: rows.length, todoId: 'plan-owner', href: '/plan' },
      { id: 'scheduleConflicts', kind: 'problems', value: rows.filter((r) => r.conflict).length, total: rows.length, todoId: 'plan-schedule', href: '/plan' },
      { id: 'paybackOk', kind: 'ratio', value: solutions.filter((s) => s.payback <= limit).length, total: solutions.length, todoId: 'plan-payback', href: '/plan' },
      { id: 'chainBreaks', kind: 'problems', value: breaks, total: thread.solutions.length, todoId: 'dlv-trace', href: '/deliverables?step=deliverable&target=sol-thread' },
      { id: 'planDecisions', kind: 'count', value: decisions, total: decisions, todoId: 'plan-decision', href: '/discussion' },
    ],
    detail: { step: 'deliverable', initiatives: rows, paybackLimit: limit, solutions, gaps: breaks, trace },
  };
}

const BUILDERS: Record<ImprovementStep, (c: CheckContext) => { tiles: DashTile[]; detail: StepDetail }> = { asis, tobe, kpi, solution, deliverable };

export function stepDashboard(step: ImprovementStep, c: CheckContext): StepDashboard {
  const results = evaluateStep(step, c);
  const { tiles, detail } = BUILDERS[step](c);
  const doc = docStatus(step, c);
  const docTile: DashTile = { id: 'doc', kind: 'ratio', value: doc.complete, total: doc.total, todoId: docTodo[step], href: docHref(step) };
  const next = nextTodo(results);
  return {
    step,
    results,
    progress: progressOf(results),
    ...(next ? { next } : {}),
    tiles: [...tiles, docTile],
    doc,
    inputs: STEP_DEFS[step].inputs.map((id) => ({ id, count: inputCount(id, c), href: INPUT_HREF[id] ?? '/' })),
    detail,
  };
}
