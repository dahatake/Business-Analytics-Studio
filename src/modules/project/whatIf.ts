/**
 * FR-378: the what-if prioritisation behind each step's decision view. Pure functions; nothing here invents a value —
 * every default score is read from the project data (origin `data`), derived from it by a stated rule (`rule`), or is
 * the neutral midpoint 3 marked `unrated`; a person's override in a scenario is `user` (docs/step-cockpit-study.md).
 *
 * Criteria (MECE: benefit, time, certainty, deliverability, optionality, against size):
 * - value — size of the benefit if delivered (Cooper, Edgett & Kleinschmidt 1999; RICE "impact").
 * - alignment — traces to the project's KPIs and OKRs (Kaplan & Norton, HBR 2008; Nieto-Rodriguez, HBR 2016).
 * - confidence — strength of the evidence (RICE "confidence"; Kahneman et al., "Noise", HBR 2016).
 * - execution — ability to deliver: sponsor, team, change load (Sirkin, Keenan & Jackson's DICE, HBR 2005, inverted).
 * - option — reversible, cheap to try, opens later moves (Luehrman, HBR 1998; Bezos' two-way doors).
 * - urgency — time criticality: a multiplier on the benefit, not one more additive term (Reinertsen's Cost of Delay;
 *   SAFe WSJF = cost of delay ÷ job size).
 * - size — relative job size: the divisor.
 *
 *   benefit  B = Σ wᵢ·(sᵢ − 1)/4 / Σ wᵢ                 (swing weights over the five benefit criteria, 0–1)
 *   time     T = 1 + (u/100)·(s_urgency − 1)/4           (u = urgency strength, 0–100: up to ×2)
 *   size     S = s_size / 3                               (neutral size 3 → 1)
 *   priority P = 100·B·T / S                              (WSJF form: value × time ÷ size)
 *
 * Budget and the number of items a team can start are constraints, not scores: the funded set maximises Σ B·T under
 * them (0/1 knapsack, dynamic programming; Salo, Keisler & Morton, *Portfolio Decision Analysis*, 2011).
 */
import type { EntityOf } from '../../data/schema.ts';
import { priorityScore } from '../../domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../../domain/summary.ts';
import type { CheckContext } from './deliverables.ts';
import { pursuedIssues } from './deliverables.ts';
import { solutionType } from './strategy.ts';
import { mulberry32, triangular } from './simulate.ts';

export const BENEFIT_CRITERIA = ['value', 'alignment', 'confidence', 'execution', 'option'] as const;
export type BenefitCriterion = (typeof BENEFIT_CRITERIA)[number];
export const SCORE_KEYS = [...BENEFIT_CRITERIA, 'urgency', 'size'] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type WeightKey = BenefitCriterion | 'urgency';
export const WEIGHT_KEYS: readonly WeightKey[] = [...BENEFIT_CRITERIA, 'urgency'];

export type ScoreOrigin = 'data' | 'rule' | 'unrated' | 'user';
export type Score = 1 | 2 | 3 | 4 | 5;
/** `basis` names the rule or field the default came from (a dictionary key suffix, `ck.basis.<basis>`). */
export interface Scored { value: Score; origin: ScoreOrigin; basis: string }

export type CandidateKind = 'issue' | 'solution';
export interface Candidate {
  id: string;
  kind: CandidateKind;
  scores: Record<ScoreKey, Scored>;
  /** Known cost in yen (a solution's own, or the sum of an issue's solutions); undefined while unknown. */
  costJpy?: number;
}

export type Weights = Record<WeightKey, number>;

/**
 * PARAM-211: default swing weights. Rank-order-centroid weights for five ranked swings (Edwards & Barron's SMARTER,
 * 1994: 0.46/0.26/0.16/0.09/0.04) flattened and rounded so that no criterion is silently ignored; urgency strength 50
 * (a full-urgency item counts up to 1.5×). AI proposal (provisional) until the decision-makers agree their own.
 */
export const DEFAULT_WI_WEIGHTS: Weights = { value: 30, alignment: 25, confidence: 20, execution: 15, option: 10, urgency: 50 };

export const PRESETS = ['balanced', 'value', 'certainty', 'speed'] as const;
export type Preset = (typeof PRESETS)[number];
/** Named weight sets the decision-maker can start from (each still editable). */
export const PRESET_WEIGHTS: Record<Preset, Weights> = {
  balanced: DEFAULT_WI_WEIGHTS,
  value: { value: 45, alignment: 25, confidence: 10, execution: 10, option: 10, urgency: 50 },
  certainty: { value: 20, alignment: 20, confidence: 30, execution: 25, option: 5, urgency: 30 },
  speed: { value: 25, alignment: 15, confidence: 15, execution: 25, option: 20, urgency: 100 },
};

export interface Scenario {
  name: string;
  weights: Weights;
  /** Item id → scores the person set for this scenario. */
  overrides: Record<string, Partial<Record<ScoreKey, Score>>>;
  excluded: string[];
  /** Must-do items (regulation, commitments): always funded, outside the ranking trade-off. */
  required: string[];
  /** Budget cap in yen; null = no cap. */
  budgetJpy: number | null;
  /** How many items the team can start; null = no cap. */
  maxItems: number | null;
}

export const baselineScenario = (name = ''): Scenario => ({
  name, weights: { ...DEFAULT_WI_WEIGHTS }, overrides: {}, excluded: [], required: [], budgetJpy: null, maxItems: null,
});

const n01 = (s: number) => (s - 1) / 4;
const clampScore = (x: number): Score => Math.min(5, Math.max(1, Math.round(x))) as Score;
const scored = (value: number, origin: ScoreOrigin, basis: string): Scored => ({ value: clampScore(value), origin, basis });
const UNRATED = (basis = 'unrated'): Scored => ({ value: 3, origin: 'unrated', basis });

/* ---------- Default scores from the project data ---------- */

/** 1–5 by rank among the known values (ties share the lower rank); a single value is the midpoint. */
export function quintile(values: number[], x: number): Score {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length <= 1) return 3;
  const below = sorted.filter((v) => v < x).length;
  return clampScore(1 + (4 * below) / (sorted.length - 1));
}

const monthsBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / (30.4375 * 86_400_000);

/** PARAM-212: months to the nearest linked KPI deadline → urgency (≤3 → 5, ≤6 → 4, ≤12 → 3, ≤24 → 2, later → 1). */
export function urgencyOf(deadlines: string[], today: string): Scored {
  const months = deadlines.map((d) => monthsBetween(today, d)).filter(Number.isFinite);
  if (months.length === 0) return UNRATED('noDeadline');
  const m = Math.min(...months);
  return scored(m <= 3 ? 5 : m <= 6 ? 4 : m <= 12 ? 3 : m <= 24 ? 2 : 1, 'rule', 'deadline');
}

type Ctx = Pick<CheckContext, 'pack' | 'kpi' | 'deliverables' | 'today' | 'strategy'>;

/** How far the linked KPIs trace to the project's OKRs (strategy map linkage). */
function alignmentOf(kpiIds: string[], c: Ctx): Scored {
  if (kpiIds.length === 0) return scored(1, 'data', 'noKpi');
  const okrKpis = new Set(c.kpi.okrs.flatMap((o) => o.keyResults.map((k) => k.kpiId)));
  const projectKpis = new Set(c.kpi.kpis.map((k) => k.id));
  if (kpiIds.some((id) => okrKpis.has(id))) return scored(5, 'rule', 'okr');
  if (kpiIds.some((id) => projectKpis.has(id))) return scored(4, 'rule', 'projectKpi');
  return scored(3, 'rule', 'packKpi');
}

const deadlinesOf = (kpiIds: string[], c: Ctx) => [
  ...c.kpi.kpis.filter((k) => kpiIds.includes(k.id)).map((k) => k.deadline),
];

const measured = (kpiIds: string[], c: Ctx) => kpiIds.some((id) => {
  const k = c.pack.byId.get(id);
  return k?.kind === 'kpi' && Number.isFinite(k.baseline) && Number.isFinite(k.current) && k.target !== k.baseline;
});

/** PARAM-192 tiers: a source and a measured KPI → 5, one of them → 3, neither → 1. */
function evidenceOf(sourced: boolean, isMeasured: boolean): Scored {
  return sourced && isMeasured ? scored(5, 'rule', 'sourcedMeasured') : sourced || isMeasured ? scored(3, 'rule', sourced ? 'sourced' : 'measured') : scored(1, 'rule', 'noEvidence');
}

const PILOT = /poc|pilot|trial|試行|パイロット|実証|検証/i;
const textOf = (e: { name: unknown; description?: unknown }) => JSON.stringify([e.name, e.description ?? '']);

export function issueCandidates(c: Ctx, visible: (id: string) => boolean = () => true): Candidate[] {
  const issues = pursuedIssues(c).filter((i) => visible(i.id));
  const solutions = c.pack.pack.entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution');
  const costs = new Map(issues.map((i) => {
    const known = solutions.filter((s) => s.issueIds.includes(i.id) && s.costJpy !== undefined);
    return [i.id, known.length ? known.reduce((a, s) => a + (s.costJpy ?? 0), 0) : undefined] as const;
  }));
  const knownCosts = [...costs.values()].filter((x): x is number => x !== undefined);
  return issues.map((i) => {
    const cost = costs.get(i.id);
    return {
      id: i.id,
      kind: 'issue',
      ...(cost !== undefined ? { costJpy: cost } : {}),
      scores: {
        value: scored(i.impact, 'data', 'impact'),
        alignment: alignmentOf(i.kpiIds, c),
        confidence: evidenceOf(i.sourceIds.length > 0, measured(i.kpiIds, c)),
        execution: scored(i.feasibility, 'data', 'feasibility'),
        option: UNRATED(),
        urgency: urgencyOf(deadlinesOf(i.kpiIds, c), c.today),
        size: cost !== undefined && knownCosts.length > 1 ? scored(quintile(knownCosts, cost), 'rule', 'cost') : UNRATED('noCost'),
      },
    };
  });
}

const BASIS_SCORE = { measured: 5, benchmark: 4, expert: 3, assumption: 2 } as const;

export function solutionCandidates(c: Ctx, visible: (id: string) => boolean = () => true): Candidate[] {
  const all = c.pack.pack.entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution' && visible(e.id));
  const inits = c.pack.pack.entities.filter((e): e is EntityOf<'initiative'> => e.kind === 'initiative');
  const benefits = all.map((s) => s.annualBenefitJpy).filter((x): x is number => x !== undefined);
  const costs = all.map((s) => s.costJpy).filter((x): x is number => x !== undefined);
  const contributions = c.strategy?.contributions ?? [];
  return all.map((s) => {
    const issues = s.issueIds.map((id) => c.pack.byId.get(id)).filter((e): e is EntityOf<'issue'> => e?.kind === 'issue');
    const own = contributions.filter((x) => x.solutionId === s.id);
    const best = own.length ? Math.max(...own.map((x) => BASIS_SCORE[x.basis])) : 0;
    const sourced = issues.some((i) => i.sourceIds.length > 0);
    const mine = inits.filter((i) => i.solutionId === s.id);
    const months = mine.length ? monthsBetween(mine.reduce((a, i) => (i.start < a ? i.start : a), mine[0]!.start), mine.reduce((a, i) => (i.end > a ? i.end : a), mine[0]!.end)) : null;
    const type = c.strategy ? solutionType(s, c.strategy).type : null;
    const option: Scored = mine.some((i) => PILOT.test(textOf(i))) ? scored(4, 'rule', 'pilot')
      : type === 'prompt' ? scored(5, 'rule', 'promptType') : UNRATED();
    return {
      id: s.id,
      kind: 'solution',
      ...(s.costJpy !== undefined ? { costJpy: s.costJpy } : {}),
      scores: {
        value: s.annualBenefitJpy !== undefined && benefits.length > 1 ? scored(quintile(benefits, s.annualBenefitJpy), 'rule', 'benefit')
          : issues.length ? scored(Math.max(...issues.map((i) => i.impact)), 'rule', 'issueImpact') : UNRATED(),
        alignment: alignmentOf(s.kpiIds, c),
        confidence: best ? scored(best, 'rule', 'contribution') : evidenceOf(sourced, measured(s.kpiIds, c)),
        execution: issues.length ? scored(issues.reduce((a, i) => a + i.feasibility, 0) / issues.length, 'rule', 'issueFeasibility') : UNRATED(),
        option,
        urgency: urgencyOf(deadlinesOf(s.kpiIds, c), c.today),
        size: s.costJpy !== undefined && costs.length > 1 ? scored(quintile(costs, s.costJpy), 'rule', 'cost')
          : months !== null ? scored(months <= 3 ? 1 : months <= 6 ? 2 : months <= 9 ? 3 : months <= 12 ? 4 : 5, 'rule', 'duration') : UNRATED('noCost'),
      },
    };
  });
}

/* ---------- Scoring and ranking ---------- */

export function effectiveScores(cand: Candidate, scenario: Pick<Scenario, 'overrides'>): Record<ScoreKey, Scored> {
  const o = scenario.overrides[cand.id] ?? {};
  return Object.fromEntries(SCORE_KEYS.map((k) => [k, o[k] !== undefined ? { value: o[k]!, origin: 'user' as const, basis: 'user' } : cand.scores[k]])) as Record<ScoreKey, Scored>;
}

export interface Parts { benefit: number; time: number; size: number; priority: number; value: number }

/** The formula of the header comment on raw numbers (scores may be off the 1–5 grid in the Monte Carlo). */
export function partsOf(s: Record<ScoreKey, number>, w: Weights): Parts {
  const sum = BENEFIT_CRITERIA.reduce((a, k) => a + Math.max(0, w[k]), 0);
  const benefit = sum > 0 ? BENEFIT_CRITERIA.reduce((a, k) => a + Math.max(0, w[k]) * n01(s[k]), 0) / sum : 0;
  const time = 1 + (Math.max(0, Math.min(100, w.urgency)) / 100) * n01(s.urgency);
  const size = Math.max(1, s.size) / 3;
  return { benefit, time, size, value: benefit * time, priority: (100 * benefit * time) / size };
}

const valuesOf = (s: Record<ScoreKey, Scored>) => Object.fromEntries(SCORE_KEYS.map((k) => [k, s[k].value])) as Record<ScoreKey, number>;

export interface RankedRow extends Parts {
  id: string;
  rank: number;
  scores: Record<ScoreKey, Scored>;
  costJpy?: number;
  excluded: boolean;
  required: boolean;
  funded: boolean;
}

export interface Ranking {
  rows: RankedRow[];
  /** Ids in the funded set, in rank order. */
  funded: string[];
  fundedValue: number;
  fundedCost: number;
  /** Funded items whose cost is unknown (not checked against the budget). */
  unknownCost: number;
  /** Required items alone exceed the budget or the item cap. */
  overCommitted: boolean;
}

const order = (a: { priority: number; benefit: number; id: string }, b: typeof a) =>
  b.priority - a.priority || b.benefit - a.benefit || a.id.localeCompare(b.id);

export function rank(cands: Candidate[], scenario: Scenario): Ranking {
  const excluded = new Set(scenario.excluded);
  const required = new Set(scenario.required.filter((id) => !excluded.has(id)));
  const scoredRows = cands.map((c) => {
    const scores = effectiveScores(c, scenario);
    return { id: c.id, scores, ...(c.costJpy !== undefined ? { costJpy: c.costJpy } : {}), ...partsOf(valuesOf(scores), scenario.weights), excluded: excluded.has(c.id), required: required.has(c.id) };
  });
  const active = scoredRows.filter((r) => !r.excluded).sort(order);
  const rest = scoredRows.filter((r) => r.excluded).sort(order);
  const sel = selectFunded(active, scenario.budgetJpy, scenario.maxItems);
  const funded = new Set(sel.ids);
  const rows: RankedRow[] = [...active, ...rest].map((r, i) => ({ ...r, rank: r.excluded ? 0 : i + 1, funded: funded.has(r.id) }));
  const fundedRows = rows.filter((r) => r.funded);
  return {
    rows,
    funded: fundedRows.map((r) => r.id),
    fundedValue: fundedRows.reduce((a, r) => a + r.value, 0),
    fundedCost: fundedRows.reduce((a, r) => a + (r.costJpy ?? 0), 0),
    unknownCost: scenario.budgetJpy !== null ? fundedRows.filter((r) => r.costJpy === undefined).length : 0,
    overCommitted: sel.overCommitted,
  };
}

/* ---------- Funded set under budget and capacity (0/1 knapsack) ---------- */

/** PARAM-213: the budget is split into this many units; costs are rounded up, so the funded set never exceeds the budget. */
export const BUDGET_UNITS = 400;

interface Item { id: string; value: number; costJpy?: number; required: boolean; priority: number; benefit: number }

/**
 * Maximises the summed value of the funded items under the budget and the item cap. Required items are taken first;
 * items with unknown cost cannot be checked against the budget and compete only for the item cap.
 */
export function selectFunded(items: Item[], budgetJpy: number | null, maxItems: number | null): { ids: string[]; overCommitted: boolean } {
  const req = items.filter((i) => i.required);
  const free = items.filter((i) => !i.required);
  const reqCost = req.reduce((a, i) => a + (i.costJpy ?? 0), 0);
  const cap = maxItems === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(maxItems));
  const overCommitted = req.length > cap || (budgetJpy !== null && reqCost > budgetJpy);
  const slots = Math.max(0, Math.min(cap, items.length) - req.length);
  if (budgetJpy === null) {
    const chosen = [...free].sort(order).slice(0, slots);
    return { ids: [...req, ...chosen].map((i) => i.id), overCommitted };
  }
  const left = Math.max(0, budgetJpy - reqCost);
  const unit = left / BUDGET_UNITS;
  const units = (c: number) => (unit > 0 ? Math.ceil(c / unit - 1e-9) : c > 0 ? BUDGET_UNITS + 1 : 0);
  const costed = free.filter((i) => i.costJpy !== undefined && units(i.costJpy) <= BUDGET_UNITS);
  const unknown = [...free.filter((i) => i.costJpy === undefined)].sort(order);
  const k = Math.min(slots, costed.length + unknown.length);
  // best[b][m]: max value using budget units ≤ b and exactly ≤ m items; keep choice bits per item for the trace-back.
  const B = BUDGET_UNITS;
  const width = k + 1;
  let best = new Float64Array((B + 1) * width);
  const take: Uint8Array[] = [];
  for (const it of costed) {
    const w = units(it.costJpy!);
    const next = best.slice();
    const bits = new Uint8Array((B + 1) * width);
    for (let b = w; b <= B; b += 1) {
      for (let m = 1; m <= k; m += 1) {
        const cand = best[(b - w) * width + (m - 1)]! + it.value;
        if (cand > next[b * width + m]! + 1e-12) { next[b * width + m] = cand; bits[b * width + m] = 1; }
      }
    }
    take.push(bits);
    best = next;
  }
  // Unknown-cost items fill the remaining item slots greedily by value; pick the split that maximises the total.
  const unknownPrefix = [0];
  for (const u of unknown) unknownPrefix.push(unknownPrefix[unknownPrefix.length - 1]! + u.value);
  let bestTotal = -1; let bestM = 0; let bestU = 0;
  for (let m = 0; m <= k; m += 1) {
    const uCount = Math.min(unknown.length, k - m);
    const total = best[B * width + m]! + unknownPrefix[uCount]!;
    if (total > bestTotal + 1e-12) { bestTotal = total; bestM = m; bestU = uCount; }
  }
  const chosen: Item[] = [];
  let b = B; let m = bestM;
  for (let i = costed.length - 1; i >= 0 && m > 0; i -= 1) {
    if (take[i]![b * width + m]) { chosen.push(costed[i]!); b -= units(costed[i]!.costJpy!); m -= 1; }
  }
  return { ids: [...req, ...chosen, ...unknown.slice(0, bestU)].sort(order).map((i) => i.id), overCommitted };
}

/** Portfolio value at budgets from 0 to the total known cost (efficient frontier, PARAM-213 resolution). */
export function frontier(cands: Candidate[], scenario: Scenario, points = 10): { budgetJpy: number; value: number; count: number }[] {
  const total = cands.filter((c) => !scenario.excluded.includes(c.id)).reduce((a, c) => a + (c.costJpy ?? 0), 0);
  if (total <= 0) return [];
  return Array.from({ length: points + 1 }, (_, j) => {
    const budget = (total * j) / points;
    const r = rank(cands.filter((c) => c.costJpy !== undefined), { ...scenario, budgetJpy: budget });
    return { budgetJpy: budget, value: r.fundedValue, count: r.funded.length };
  });
}

/* ---------- Sensitivity: where the first place changes ---------- */

export interface Sensitivity {
  key: WeightKey;
  /** Smallest multiplier below 1 that keeps the current first place (null = it holds down to 0). */
  holdsFrom: number;
  /** Largest multiplier above 1 that keeps it (null = it holds up to the scan limit). */
  holdsTo: number;
  /** Who becomes first just outside the range. */
  lowLeader: string | null;
  highLeader: string | null;
}

/** PARAM-214: each weight is scanned one at a time from ×0 to ×3 in steps of 0.05 (urgency strength capped at 100). */
export const SENS_MAX = 3;
const SENS_STEP = 0.05;

function leaderOf(cands: Candidate[], s: Scenario): string | null {
  let best: { id: string; priority: number; benefit: number } | null = null;
  for (const c of cands) {
    if (s.excluded.includes(c.id)) continue;
    const p = partsOf(valuesOf(effectiveScores(c, s)), s.weights);
    const row = { id: c.id, priority: p.priority, benefit: p.benefit };
    if (!best || order(row, best) < 0) best = row;
  }
  return best?.id ?? null;
}

export function sensitivity(cands: Candidate[], scenario: Scenario): Sensitivity[] {
  const top = leaderOf(cands, scenario);
  if (!top) return [];
  // Multipliers are i / STEPS so that 1.5, 0.7 … are exact and the thresholds can be checked against closed forms.
  const STEPS = Math.round(1 / SENS_STEP);
  return WEIGHT_KEYS.map((key) => {
    const at = (m: number) => leaderOf(cands, { ...scenario, weights: { ...scenario.weights, [key]: scenario.weights[key] * m } });
    let holdsFrom = 1; let lowLeader: string | null = null;
    for (let i = STEPS - 1; i >= 0; i -= 1) {
      const l = at(i / STEPS);
      if (l !== top) { lowLeader = l; break; }
      holdsFrom = i / STEPS;
    }
    let holdsTo = 1; let highLeader: string | null = null;
    const limit = key === 'urgency' && scenario.weights.urgency > 0 ? Math.min(SENS_MAX, 100 / scenario.weights.urgency) : SENS_MAX;
    for (let i = STEPS + 1; i / STEPS <= limit + 1e-9; i += 1) {
      const l = at(i / STEPS);
      if (l !== top) { highLeader = l; break; }
      holdsTo = i / STEPS;
    }
    return { key, holdsFrom, holdsTo, lowLeader, highLeader };
  });
}

/* ---------- Stability: how often each item is first under uncertainty (SMAA) ---------- */

export const WI_RUNS = 1000;
export const WI_SEED = 20261126;
/** PARAM-193: each weight is varied by ×(1 ± 0.5·U). */
const WEIGHT_SPREAD = 0.5;
/** PARAM-192: score error by evidence tier (confidence 5 → ±0.5, 3–4 → ±1, 1–2 → ±1.5); a person's score counts as ±0.5. */
const spreadOf = (conf: number, origin: ScoreOrigin) => (origin === 'user' ? 0.5 : conf >= 5 ? 0.5 : conf >= 3 ? 1 : 1.5);

export function stability(cands: Candidate[], scenario: Scenario, runs = WI_RUNS, seed = WI_SEED): { id: string; first: number; top3: number }[] {
  const excluded = new Set(scenario.excluded);
  const active = cands.filter((c) => !excluded.has(c.id));
  if (active.length === 0) return [];
  const base = active.map((c) => effectiveScores(c, scenario));
  const rnd = mulberry32(seed);
  const first = new Float64Array(active.length);
  const top3 = new Float64Array(active.length);
  for (let r = 0; r < runs; r += 1) {
    const w = Object.fromEntries(WEIGHT_KEYS.map((k) => [k, scenario.weights[k] * (1 + WEIGHT_SPREAD * (2 * rnd() - 1))])) as Weights;
    const pri = base.map((s) => {
      const spread = spreadOf(s.confidence.value, s.confidence.origin);
      const v = Object.fromEntries(SCORE_KEYS.map((k) => {
        const x = s[k].value;
        const d = s[k].origin === 'user' ? 0.5 : spread;
        return [k, triangular({ low: x - d, mode: x, high: x + d }, rnd())];
      })) as Record<ScoreKey, number>;
      return partsOf(v, w).priority + rnd() * 1e-9;
    });
    const idx = pri.map((_, i) => i).sort((a, b) => pri[b]! - pri[a]!);
    const lead = idx[0]!;
    first[lead] = first[lead]! + 1;
    for (const i of idx.slice(0, 3)) top3[i] = top3[i]! + 1;
  }
  return active.map((c, i) => ({ id: c.id, first: first[i]! / runs, top3: top3[i]! / runs })).sort((a, b) => b.first - a.first || b.top3 - a.top3);
}

/* ---------- Scenario comparison ---------- */

/**
 * First place by the app's established issue score (impact × feasibility, priority.ts) on the data defaults, so the
 * decision view can say when the WSJF baseline disagrees with it and why.
 */
export function legacyLeader(cands: Candidate[], excluded: string[] = []): string | null {
  let best: { id: string; s: number; v: number } | null = null;
  for (const c of cands) {
    if (excluded.includes(c.id)) continue;
    const s = priorityScore({ impact: c.scores.value.value, feasibility: c.scores.execution.value }, DEFAULT_WEIGHTS);
    const v = c.scores.value.value;
    if (!best || s > best.s || (s === best.s && (v > best.v || (v === best.v && c.id < best.id)))) best = { id: c.id, s, v };
  }
  return best?.id ?? null;
}

export interface RankDelta { id: string; base: number; now: number; delta: number }

/** Positive delta = moved up. Excluded items have rank 0 and no delta. */
export function rankDeltas(base: Ranking, now: Ranking): Map<string, RankDelta> {
  const b = new Map(base.rows.map((r) => [r.id, r.rank]));
  return new Map(now.rows.map((r) => {
    const was = b.get(r.id) ?? 0;
    return [r.id, { id: r.id, base: was, now: r.rank, delta: was && r.rank ? was - r.rank : 0 }];
  }));
}

/** Whether the scenario differs from the data-derived baseline (drives "Changed" badges and "Reset"). */
export function changedKeys(scenario: Scenario): { weights: WeightKey[]; items: string[]; constraints: boolean } {
  return {
    weights: WEIGHT_KEYS.filter((k) => scenario.weights[k] !== DEFAULT_WI_WEIGHTS[k]),
    items: [...new Set([...Object.keys(scenario.overrides).filter((id) => Object.keys(scenario.overrides[id] ?? {}).length > 0), ...scenario.excluded, ...scenario.required])],
    constraints: scenario.budgetJpy !== null || scenario.maxItems !== null,
  };
}
