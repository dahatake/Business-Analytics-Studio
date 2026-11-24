import type { LoadedPack } from '../../data/pack.ts';
import { solutionMoney, type Entity, type EntityOf } from '../../data/schema.ts';
import { kpiProgress } from '../../domain/kpi.ts';
import { priorityScore } from '../../domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../../domain/summary.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../../state/projects.ts';
import { locAll, type Localizable } from '../../state/text.ts';
import type { UseCase } from '../usecases/store.ts';
import { categoryWeight, SCORE_MAX } from './analysis.ts';
import { itemEntities, itemKey, nameTests, neighborsOf, normText, type Link } from './analysisLinks.ts';
import type { Analysis, KpiDef, MethodId } from './model.ts';

/**
 * FR-340: what each improvement step analyses, and two independent signals for prioritising it.
 * - data: the step's own measure from the pack/project (stated formula per kind), normalised to 0..1;
 * - support: how strongly the analyses on the dashboard point at it (Σ score × item weight × category weight;
 *   an item naming a directly related entity counts half).
 * Comparing the two exposes blind spots (important in the data, absent from the analyses) and claims without data.
 */

export type TargetKind = 'issue' | 'cause' | 'useCase' | 'kpi' | 'projectKpi' | 'solution' | 'initiative';

/** How the data signal was computed; message key `proj.tg.basis.<kind>`. */
export type Basis =
  | { kind: 'issue'; impact: number; feasibility: number; score: number }
  | { kind: 'cause'; issues: number; score: number }
  | { kind: 'useCase'; issues: number; score: number }
  | { kind: 'kpi'; progress: number | null }
  | { kind: 'solution'; roi: number }
  | { kind: 'initiative'; progress: number; dependents: number };

export interface StepTarget {
  /** Pack entity id, or `uc:<id>` / `pkpi:<id>` for project data. */
  id: string;
  step: ImprovementStep;
  kind: TargetKind;
  name: Localizable;
  /** The pack entity this target is (analysis items naming it are direct evidence). */
  entityId?: string;
  /** Pack entities one relation away (items naming them are indirect evidence). */
  nearIds: readonly string[];
  /** 0..1, higher = more urgent or more valuable according to the data. */
  data: number;
  basis: Basis;
}

export interface Evidence {
  analysisId: string;
  itemId: string;
  method: MethodId;
  category: string;
  score: number;
  link: 'direct' | 'near';
  /** Pack entity the item names on the way to the target (absent for a name match of project data). */
  via?: string;
  /** score × item weight × category weight (× 0.5 for near). */
  value: number;
}

/** focus = both signals high; underexamined = data high, analyses quiet; unbacked = analyses loud, data low. */
export type Quadrant = 'focus' | 'underexamined' | 'unbacked' | 'later';
export const QUADRANTS: readonly Quadrant[] = ['focus', 'underexamined', 'unbacked', 'later'];

export interface ScoredTarget extends StepTarget {
  evidence: Evidence[];
  support: number;
  /** support ÷ max(SUPPORT_REF, the highest support in the step). */
  supportN: number;
  quadrant: Quadrant;
  /** Reference rank within the step: mean of data and supportN, ties by data. */
  rank: number;
}

export const HIGH = 0.5;
export const NEAR_FACTOR = 0.5;
/** Support of one direct mention at the top score with weight 1: the floor of the support scale, so a step whose analyses only touch it faintly is not stretched to "high". */
export const SUPPORT_REF = SCORE_MAX;

export interface TargetInput {
  pack: LoadedPack;
  useCases: readonly UseCase[];
  kpis: readonly KpiDef[];
  /** The analyses shown on the dashboard. */
  analyses: readonly Analysis[];
}

const kindOf = <K extends Entity['kind']>(pack: LoadedPack, kind: K) => pack.pack.entities.filter((e): e is EntityOf<K> => e.kind === kind);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function kpiBasis(k: Pick<KpiDef, 'baseline' | 'current' | 'target'>): { data: number; basis: Basis } {
  const p = kpiProgress(k);
  if (!Number.isFinite(p)) return { data: 0, basis: { kind: 'kpi', progress: null } };
  return { data: round(1 - clamp01(p)), basis: { kind: 'kpi', progress: round(p) } };
}

/** Every initiative that waits on `id`, directly or through others. */
function dependentsOf(id: string, inits: EntityOf<'initiative'>[]): number {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const i of inits) {
      if (i.dependsOn.includes(cur) && !seen.has(i.id) && i.id !== id) {
        seen.add(i.id);
        queue.push(i.id);
      }
    }
  }
  return seen.size;
}

/** The analysis targets of each step, with their data signal (no analysis involved yet). */
export function stepTargets(input: Pick<TargetInput, 'pack' | 'useCases' | 'kpis'>): Record<ImprovementStep, StepTarget[]> {
  const { pack } = input;
  const near = (id: string) => [...neighborsOf([id], pack)].filter((n) => pack.byId.get(n)?.kind !== 'source');
  const issues = kindOf(pack, 'issue');
  const issueScore = new Map(issues.map((i) => [i.id, priorityScore(i, DEFAULT_WEIGHTS) / 100]));
  const entity = (step: ImprovementStep, e: Entity, data: number, basis: Basis): StepTarget => ({
    id: e.id, step, kind: e.kind as TargetKind, name: e.name, entityId: e.id, nearIds: near(e.id), data: round(data), basis,
  });

  const asis: StepTarget[] = issues.map((i) => entity('asis', i, issueScore.get(i.id)!, { kind: 'issue', impact: i.impact, feasibility: i.feasibility, score: Math.round(issueScore.get(i.id)! * 100) }));
  const causedBy = new Map<string, number[]>();
  for (const i of issues) for (const c of i.causeIds) causedBy.set(c, [...(causedBy.get(c) ?? []), issueScore.get(i.id)!]);
  for (const c of kindOf(pack, 'cause')) {
    const scores = causedBy.get(c.id) ?? [];
    const top = scores.length ? Math.max(...scores) : 0;
    asis.push(entity('asis', c, top, { kind: 'cause', issues: scores.length, score: Math.round(top * 100) }));
  }

  const tobe: StepTarget[] = input.useCases.map((u) => {
    const scores = u.relatedIds.map((id) => issueScore.get(id)).filter((v): v is number => v !== undefined);
    const top = scores.length ? Math.max(...scores) : 0;
    return { id: `uc:${u.id}`, step: 'tobe', kind: 'useCase', name: u.name, nearIds: u.relatedIds.filter((id) => pack.byId.has(id)), data: round(top), basis: { kind: 'useCase', issues: scores.length, score: Math.round(top * 100) } };
  });

  const packKpis = kindOf(pack, 'kpi');
  const kpi: StepTarget[] = packKpis.map((k) => { const b = kpiBasis(k); return entity('kpi', k, b.data, b.basis); });
  const names = new Set(packKpis.flatMap((k) => locAll(k.name)));
  for (const k of input.kpis) {
    if (packKpis.some((p) => p.id === k.id) || locAll(k.name).some((n) => names.has(n))) continue;
    const b = kpiBasis(k);
    kpi.push({ id: `pkpi:${k.id}`, step: 'kpi', kind: 'projectKpi', name: k.name, nearIds: [], data: b.data, basis: b.basis });
  }

  const sols = kindOf(pack, 'solution');
  const roiOf = (s: EntityOf<'solution'>) => { const m = solutionMoney(s); return m ? m.benefit / m.cost : 0; };
  const maxRoi = Math.max(0, ...sols.map(roiOf));
  const solution = sols.map((s) => entity('solution', s, maxRoi > 0 ? roiOf(s) / maxRoi : 0, { kind: 'solution', roi: round(roiOf(s)) }));

  const inits = kindOf(pack, 'initiative');
  const deps = new Map(inits.map((i) => [i.id, dependentsOf(i.id, inits)]));
  const maxDeps = Math.max(0, ...deps.values());
  const deliverable = inits.map((i) => entity('deliverable', i, (1 - clamp01(i.progress)) * ((1 + deps.get(i.id)!) / (1 + maxDeps)), { kind: 'initiative', progress: i.progress, dependents: deps.get(i.id)! }));

  return { asis, tobe, kpi, solution, deliverable };
}

/** Analysis items that point at each target (direct name match or a name one relation away). */
export function evidenceFor(target: StepTarget, analyses: readonly Analysis[], pack: LoadedPack): Evidence[] {
  const tests = target.entityId ? [] : nameTests(target.name);
  const out: Evidence[] = [];
  for (const a of analyses) {
    for (const i of a.items) {
      const w = i.weight * categoryWeight(a, i.category);
      if (!(w > 0)) continue;
      const ents = itemEntities(i, pack);
      const direct = target.entityId ? ents.has(target.entityId) : normText(i).some((tx) => tests.some((test) => test(tx)));
      const nearId = direct ? undefined : target.nearIds.find((id) => ents.has(id));
      if (!direct && !nearId) continue;
      out.push({
        analysisId: a.id, itemId: i.id, method: a.method, category: i.category, score: i.score,
        link: direct ? 'direct' : 'near', via: direct ? target.entityId : nearId, value: round(i.score * w * (direct ? 1 : NEAR_FACTOR)),
      });
    }
  }
  return out.sort((x, y) => y.value - x.value);
}

export function quadrantOf(data: number, supportN: number): Quadrant {
  if (data >= HIGH) return supportN >= HIGH ? 'focus' : 'underexamined';
  return supportN >= HIGH ? 'unbacked' : 'later';
}

export function scoreTargets(targets: readonly StepTarget[], analyses: readonly Analysis[], pack: LoadedPack): ScoredTarget[] {
  const withEv = targets.map((t) => {
    const evidence = evidenceFor(t, analyses, pack);
    return { ...t, evidence, support: round(evidence.reduce((s, e) => s + e.value, 0)) };
  });
  const max = Math.max(SUPPORT_REF, ...withEv.map((t) => t.support));
  const scored = withEv.map((t) => {
    const supportN = round(t.support / max);
    return { ...t, supportN, quadrant: quadrantOf(t.data, supportN), rank: 0 };
  });
  const key = (t: ScoredTarget) => (t.data + t.supportN) / 2;
  const name = (t: ScoredTarget) => locAll(t.name)[0] ?? t.id;
  return [...scored]
    .sort((a, b) => key(b) - key(a) || b.data - a.data || name(a).localeCompare(name(b)))
    .map((t, k) => ({ ...t, rank: k + 1 }));
}

export function scoreAllSteps(input: TargetInput): Record<ImprovementStep, ScoredTarget[]> {
  const base = stepTargets(input);
  return Object.fromEntries(IMPROVEMENT_STEPS.map((s) => [s, scoreTargets(base[s], input.analyses, input.pack)])) as Record<ImprovementStep, ScoredTarget[]>;
}

/** The evidence of a target as cross-highlight links of the dashboard (direct = same target, near = one relation away). */
export function evidenceLinks(t: ScoredTarget): Map<string, Link> {
  return new Map(t.evidence.map((e) => [itemKey(e.analysisId, e.itemId), { kind: e.link === 'direct' ? 'same' : 'near', entityId: e.via ?? t.id }]));
}

/** Targets an analysis item is evidence for (reverse of the evidence lists). */
export function targetsOfItem(targets: readonly ScoredTarget[], key: string): Set<string> {
  return new Set(targets.filter((t) => t.evidence.some((e) => itemKey(e.analysisId, e.itemId) === key)).map((t) => t.id));
}

export interface OverviewFacts {
  analyses: number;
  items: number;
  targets: number;
  step: ImprovementStep;
  stepTargets: number;
  /** Best-ranked target of the step in the focus quadrant. */
  top: ScoredTarget | null;
  underexamined: ScoredTarget[];
  unbacked: ScoredTarget[];
  /** The target (any step) named directly by the most distinct analyses. */
  mostCited: { target: ScoredTarget; analyses: number } | null;
  /** Targets of every step without any evidence. */
  uncovered: number;
}

/** Facts the dynamic overview is written from (FR-340); recomputed on every parameter change. */
export function overviewFacts(all: Record<ImprovementStep, ScoredTarget[]>, analyses: readonly Analysis[], step: ImprovementStep): OverviewFacts {
  const flat = IMPROVEMENT_STEPS.flatMap((s) => all[s]);
  const list = all[step];
  let mostCited: OverviewFacts['mostCited'] = null;
  for (const t of flat) {
    const n = new Set(t.evidence.filter((e) => e.link === 'direct').map((e) => e.analysisId)).size;
    if (n > 0 && (!mostCited || n > mostCited.analyses || (n === mostCited.analyses && t.support > mostCited.target.support))) mostCited = { target: t, analyses: n };
  }
  return {
    analyses: analyses.length,
    items: analyses.reduce((s, a) => s + a.items.length, 0),
    targets: flat.length,
    step,
    stepTargets: list.length,
    top: list.find((t) => t.quadrant === 'focus') ?? null,
    underexamined: list.filter((t) => t.quadrant === 'underexamined'),
    unbacked: list.filter((t) => t.quadrant === 'unbacked'),
    mostCited,
    uncovered: flat.filter((t) => t.evidence.length === 0).length,
  };
}
