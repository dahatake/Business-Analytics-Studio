import { DelayCostExtension } from '../../data/extensionSchemas.ts';
import type { DelayEstimate } from './deliverables.ts';
import { PRIORITY_WEIGHTS } from './priorityAnalysis.ts';
import type { RobustnessSummary } from './priorityRobustness.ts';
import { mulberry32, SIM_RUNS, triangular, triangularMean, type Range3 } from './simulate.ts';

/**
 * FR-365: Cost of Delay — which issue to solve first so that the least value is lost while the others wait.
 *
 * Impact × feasibility ranks issues by judgement (1–5). Once two numbers per issue are known — the value lost per month while it
 * stays unsolved (V, yen) and the months left until it is solved (D) — the order that loses the least value in total is known too:
 * a single team working through the issues one after another minimises Σ V_i × (completion month of i) by taking them in falling
 * V / D ("CD3": cost of delay divided by duration; Smith 1956 for known values, Rothkopf 1966 for uncertain ones with E[V] / E[D]).
 *
 * 1. Inputs per issue, first found wins: a person's estimate (project data) → extensions.delayCost (stated in the material, quoted)
 *    → derived from the pack (V from the solutions' annual benefit; D from the initiatives' span and progress).
 * 2. Uncertainty: derived values get a range (PARAM-195 / PARAM-196); seeded runs give P(first by CD3) and how often the CD3 order
 *    beats today's impact × feasibility order.
 * 3. EVPPI in yen per issue and input: how much less value would be lost, on average, if that one number were known exactly.
 *    Expected cost is linear in each number, so holding the others at their means is exact (inputs are independent).
 *
 * Limits: one team, one issue at a time, value starts when an issue is solved. No AI or web call; same input and seed, same result.
 */

/** PARAM-195 (provisional): half-width of the value range, as a share of the value, by how firm the value is. */
export const VALUE_SPREAD = { firm: 0.25, estimate: 0.5 } as const;
/** PARAM-196 (provisional): a planned duration becomes triangular(low × d, d, high × d): plans run late more than early (Buehler et al. 1994). */
export const DURATION_RANGE = { low: 0.9, high: 1.5 } as const;
/** The next number is worth confirming when knowing it would save at least this share of the expected delay cost. */
export const EVPPI_FLOOR_SHARE = 0.01;
/** The CD3 pick is firm when it comes first in at least this share of runs (as PARAM-194). */
export const COD_FIRM_SHARE = 0.7;
const EVPPI_SAMPLES = 400;
const DEFAULT_SEED = 19560301;
const MONTH_DAYS = 30.4375;

export type ValueOrigin = 'human' | 'pack' | 'solution';
export type DurationOrigin = 'human' | 'pack' | 'initiative';
export type DelayParam = 'value' | 'duration';
/** Where a missing number can be obtained in the app. */
export type DelayChannel = 'fill' | 'initiative' | 'solution' | 'estimate';

/** Loose entity shape: works on a raw generated pack and on a loaded one. */
export interface DelayEntity {
  kind?: unknown; id?: unknown; impact?: unknown; feasibility?: unknown;
  issueIds?: unknown; annualBenefitJpy?: unknown; solutionId?: unknown; start?: unknown; end?: unknown; progress?: unknown;
}

export interface DelayOptions {
  /** Raw extensions.delayCost (validated here; an invalid one is ignored). */
  extension?: unknown;
  /** Project data: a person's estimates by issue id. */
  estimates?: Readonly<Record<string, DelayEstimate>>;
  /** Solutions whose annual benefit is a Copilot estimate no person has approved yet. */
  unreviewed?: ReadonlySet<string>;
  /** Issues left out: qualified out, or a what-if. */
  excluded?: ReadonlySet<string>;
  runs?: number;
  seed?: number;
}

export interface DelayIssue {
  id: string;
  /** Today's impact × feasibility rank among the issues considered (1 = first). */
  ifRank: number;
  value: Range3 | null;
  valueOrigin: ValueOrigin | null;
  valueFirm: boolean;
  duration: Range3 | null;
  durationOrigin: DurationOrigin | null;
  /** Derived: the initiatives are finished, nothing left to sequence. */
  done: boolean;
  /** Where to get a missing value / duration (null when known). */
  valueVia: DelayChannel | null;
  durationVia: DelayChannel | null;
  /** The solution whose annual benefit is missing (for the fill channel). */
  fillSolutionId: string | null;
}

export interface DelayRanked extends DelayIssue {
  value: Range3;
  duration: Range3;
  meanValue: number;
  meanDuration: number;
  /** E[V] / E[D]: yen per month, per month of work. */
  cd3: number;
  cd3Rank: number;
  pFirst: number;
  evppi: Record<DelayParam, number>;
}

export interface DelayNext { id: string; param: DelayParam; evppiJpy: number }
export type DelayVerdict = 'none' | 'agree' | 'differs';

export interface CostOfDelay {
  /** Issues with both numbers, best CD3 first. */
  ranked: DelayRanked[];
  /** Issues still missing a number (not done). */
  missing: DelayIssue[];
  done: string[];
  /** Pursued issues considered (ranked + missing). */
  pursued: number;
  verdict: DelayVerdict;
  /** First by CD3, and first by impact × feasibility among the same issues. */
  pick: string | null;
  ifPick: string | null;
  /** Expected total delay cost (yen) of the impact × feasibility order and of the CD3 order, over the ranked issues. */
  costIf: number;
  costCd3: number;
  saving: number;
  /** Share of runs in which the CD3 order loses less than the impact × feasibility order (ties count half). */
  beatShare: number;
  /** 10th / 90th percentile of the saving across runs. */
  savingLow: number;
  savingHigh: number;
  firm: boolean;
  next: DelayNext | null;
  runs: number;
  seed: number;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const yen = (x: number) => Math.round(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const spread = (v: number, s: number): Range3 => ({ low: v * (1 - s), mode: v, high: v * (1 + s) });
const days = (iso: unknown) => (isStr(iso) ? Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) : NaN);
const ifScore = (impact: number, feasibility: number) =>
  ((PRIORITY_WEIGHTS.impact * (impact - 1)) / 4 + (PRIORITY_WEIGHTS.feasibility * (feasibility - 1)) / 4) / (PRIORITY_WEIGHTS.impact + PRIORITY_WEIGHTS.feasibility);

/** Expected total delay cost of doing the issues in `order` one after another: Σ V_i × (Σ D up to and including i). */
export function sequenceCost(order: readonly number[], v: ArrayLike<number>, d: ArrayLike<number>): number {
  let t = 0;
  let cost = 0;
  for (const k of order) {
    t += d[k]!;
    cost += v[k]! * t;
  }
  return cost;
}

/** The order minimising sequenceCost: falling V / D (WSPT), ties by `tie` order. */
export function wsptOrder(v: ArrayLike<number>, d: ArrayLike<number>, tie: readonly number[]): number[] {
  const pos = new Map(tie.map((k, p) => [k, p]));
  return [...tie].sort((a, b) => v[b]! / d[b]! - v[a]! / d[a]! || pos.get(a)! - pos.get(b)!);
}

/** The per-issue inputs, from the most to the least authoritative source. */
export function delayInputs(entities: readonly DelayEntity[], opts: DelayOptions = {}): DelayIssue[] {
  const excluded = opts.excluded ?? new Set<string>();
  const ext = DelayCostExtension.safeParse(opts.extension);
  const stated = new Map(ext.success ? ext.data.items.map((i) => [i.issueId, i]) : []);
  const issues = entities.filter((e) => e.kind === 'issue' && isStr(e.id) && num(e.impact) !== null && num(e.feasibility) !== null && !excluded.has(e.id))
    .map((e) => ({ id: e.id as string, score: ifScore(e.impact as number, e.feasibility as number), impact: e.impact as number }))
    .sort((a, b) => b.score - a.score || b.impact - a.impact || a.id.localeCompare(b.id));
  const solutions = entities.filter((e) => e.kind === 'solution' && isStr(e.id) && Array.isArray(e.issueIds));
  const initiatives = entities.filter((e) => e.kind === 'initiative' && isStr(e.solutionId));

  return issues.map((issue, k): DelayIssue => {
    const own = solutions.filter((s) => (s.issueIds as unknown[]).includes(issue.id));
    const human = opts.estimates?.[issue.id];
    const pack = stated.get(issue.id);

    let value: Range3 | null = null;
    let valueOrigin: ValueOrigin | null = null;
    let valueFirm = true;
    let fillSolutionId: string | null = null;
    if (human?.valuePerMonthJpy) [value, valueOrigin] = [human.valuePerMonthJpy, 'human'];
    else if (pack?.valuePerMonthJpy) [value, valueOrigin] = [pack.valuePerMonthJpy, 'pack'];
    else {
      // A solution shared by several issues splits its benefit evenly; alternatives for one issue are not added up (the best one counts).
      let best: { v: number; firm: boolean } | null = null;
      for (const s of own) {
        const benefit = num(s.annualBenefitJpy);
        if (benefit === null || benefit <= 0) {
          fillSolutionId ??= s.id as string;
          continue;
        }
        const v = benefit / 12 / (s.issueIds as unknown[]).length;
        if (!best || v > best.v) best = { v, firm: !opts.unreviewed?.has(s.id as string) };
      }
      if (best) {
        valueFirm = best.firm;
        [value, valueOrigin] = [spread(best.v, best.firm ? VALUE_SPREAD.firm : VALUE_SPREAD.estimate), 'solution'];
        fillSolutionId = null;
      }
    }

    let duration: Range3 | null = null;
    let durationOrigin: DurationOrigin | null = null;
    let done = false;
    if (human?.durationMonths) [duration, durationOrigin] = [human.durationMonths, 'human'];
    else if (pack?.durationMonths) [duration, durationOrigin] = [pack.durationMonths, 'pack'];
    else {
      const ownIds = new Set(own.map((s) => s.id));
      const work = initiatives.filter((i) => ownIds.has(i.solutionId as string))
        .map((i) => ({ start: days(i.start), end: days(i.end), progress: Math.min(1, Math.max(0, num(i.progress) ?? 0)) }))
        .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start);
      if (work.length) {
        const span = (Math.max(...work.map((w) => w.end)) - Math.min(...work.map((w) => w.start))) / 86_400_000 / MONTH_DAYS;
        const length = work.reduce((a, w) => a + (w.end - w.start), 0);
        const progress = work.reduce((a, w) => a + w.progress * (w.end - w.start), 0) / length;
        const left = span * (1 - progress);
        if (left <= 1e-9) done = true;
        else [duration, durationOrigin] = [{ low: left * DURATION_RANGE.low, mode: left, high: left * DURATION_RANGE.high }, 'initiative'];
      }
    }

    const valueVia: DelayChannel | null = value ? null : fillSolutionId ? 'fill' : own.length ? 'estimate' : 'solution';
    const durationVia: DelayChannel | null = duration || done ? null : own.length ? 'initiative' : 'solution';
    return { id: issue.id, ifRank: k + 1, value, valueOrigin, valueFirm, duration, durationOrigin, done, valueVia, durationVia, fillSolutionId };
  });
}

/** EVPPI of one number: E over its range of [cost(today's CD3 order) − cost(best order once it is known)], others at their means. */
function evppiOf(k: number, param: DelayParam, ranges: readonly Range3[], v: Float64Array, d: Float64Array, order: readonly number[]): number {
  const vv = Float64Array.from(v);
  const dd = Float64Array.from(d);
  const target = param === 'value' ? vv : dd;
  const range = ranges[k]!;
  let gain = 0;
  for (let s = 0; s < EVPPI_SAMPLES; s++) {
    target[k] = triangular(range, (s + 0.5) / EVPPI_SAMPLES);
    gain += sequenceCost(order, vv, dd) - sequenceCost(wsptOrder(vv, dd, order), vv, dd);
  }
  return Math.max(0, gain / EVPPI_SAMPLES);
}

export function analyzeCostOfDelay(entities: readonly DelayEntity[], opts: DelayOptions = {}): CostOfDelay {
  const runs = Math.max(1, Math.floor(opts.runs ?? SIM_RUNS));
  const seed = opts.seed ?? DEFAULT_SEED;
  const inputs = delayInputs(entities, opts);
  const known = inputs.filter((i): i is DelayIssue & { value: Range3; duration: Range3 } => !!i.value && !!i.duration);
  const missing = inputs.filter((i) => !i.done && (!i.value || !i.duration));
  const done = inputs.filter((i) => i.done).map((i) => i.id);
  const pursued = known.length + missing.length;
  const empty: CostOfDelay = {
    ranked: [], missing, done, pursued, verdict: 'none', pick: null, ifPick: null, costIf: 0, costCd3: 0, saving: 0,
    beatShare: 0, savingLow: 0, savingHigh: 0, firm: false, next: null, runs, seed,
  };
  if (known.length === 0) return empty;

  const n = known.length;
  const v = Float64Array.from(known, (i) => triangularMean(i.value));
  const d = Float64Array.from(known, (i) => triangularMean(i.duration));
  const ifOrder = known.map((_, k) => k); // `inputs` is already in impact × feasibility order
  const cdOrder = wsptOrder(v, d, ifOrder);
  const costIf = sequenceCost(ifOrder, v, d);
  const costCd3 = sequenceCost(cdOrder, v, d);

  const rng = mulberry32(seed);
  const sv = new Float64Array(n);
  const sd = new Float64Array(n);
  const first = new Float64Array(n);
  const savings = new Float64Array(runs);
  let beat = 0;
  for (let r = 0; r < runs; r++) {
    known.forEach((i, k) => {
      sv[k] = triangular(i.value, rng());
      sd[k] = triangular(i.duration, rng());
    });
    first[wsptOrder(sv, sd, ifOrder)[0]!]!++;
    const s = sequenceCost(ifOrder, sv, sd) - sequenceCost(cdOrder, sv, sd);
    savings[r] = s;
    beat += s > 0 ? 1 : s === 0 ? 0.5 : 0;
  }
  savings.sort();
  const q = (p: number) => savings[Math.min(runs - 1, Math.max(0, Math.round((runs - 1) * p)))]!;

  const values = known.map((i) => i.value);
  const durations = known.map((i) => i.duration);
  const ranked: DelayRanked[] = cdOrder.map((k, p) => {
    const i = known[k]!;
    return {
      ...i, meanValue: yen(v[k]!), meanDuration: round(d[k]!, 2), cd3: yen(v[k]! / d[k]!), cd3Rank: p + 1,
      pFirst: round(first[k]! / runs),
      evppi: n < 2 ? { value: 0, duration: 0 } : { value: yen(evppiOf(k, 'value', values, v, d, cdOrder)), duration: yen(evppiOf(k, 'duration', durations, v, d, cdOrder)) },
    };
  });

  let next: DelayNext | null = null;
  for (const i of ranked) {
    for (const param of ['value', 'duration'] as const) {
      const e = i.evppi[param];
      if (e > 0 && e >= EVPPI_FLOOR_SHARE * costCd3 && (!next || e > next.evppiJpy)) next = { id: i.id, param, evppiJpy: e };
    }
  }
  const pick = ranked[0]!;
  const ifPick = known[0]!.id;
  return {
    ...empty, ranked,
    verdict: n < 2 ? 'none' : pick.id === ifPick ? 'agree' : 'differs',
    pick: pick.id, ifPick, costIf: yen(costIf), costCd3: yen(costCd3), saving: yen(costIf - costCd3),
    beatShare: round(beat / runs), savingLow: yen(q(0.1)), savingHigh: yen(q(0.9)),
    firm: pick.pFirst >= COD_FIRM_SHARE, next,
  };
}

/** What a Project pack keeps (extensions.priority.costOfDelay). */
export interface CostOfDelaySummary {
  verdict: DelayVerdict;
  ranked: number;
  pursued: number;
  pick: string | null;
  pickShare: number;
  ifPick: string | null;
  costIf: number;
  costCd3: number;
  saving: number;
  beatShare: number;
  next: DelayNext | null;
  missing: { id: string; value: DelayChannel | null; duration: DelayChannel | null }[];
  top: { id: string; cd3: number; pFirst: number }[];
  runs: number;
  seed: number;
}

export function summarizeCostOfDelay(c: CostOfDelay): CostOfDelaySummary {
  return {
    verdict: c.verdict, ranked: c.ranked.length, pursued: c.pursued, pick: c.pick, pickShare: c.ranked[0]?.pFirst ?? 0, ifPick: c.ifPick,
    costIf: c.costIf, costCd3: c.costCd3, saving: c.saving, beatShare: c.beatShare, next: c.next,
    missing: c.missing.map((m) => ({ id: m.id, value: m.valueVia, duration: m.durationVia })),
    top: c.ranked.slice(0, 3).map((r) => ({ id: r.id, cd3: r.cd3, pFirst: r.pFirst })), runs: c.runs, seed: c.seed,
  };
}

/* ---------- Which prioritisation methods the current data can support ---------- */

export const READINESS_METHODS = ['impactEffort', 'robustness', 'costOfDelay', 'opportunity', 'kano', 'ahp', 'processMining'] as const;
export type ReadinessMethod = (typeof READINESS_METHODS)[number];
/**
 * - ready: the data are in the app; the result is shown
 * - partial: some issues have the data; the rest can be obtained in the app
 * - missing: the app can hold the data but has none yet
 * - notStored: the data (a customer survey, a system event log) cannot be obtained in the app
 * - notNeeded: adds nothing to what the app already does with this data
 */
export type ReadinessStatus = 'ready' | 'partial' | 'missing' | 'notStored' | 'notNeeded';
/** Whether the result of the method changes (or could change) which issue comes first. */
export type ReadinessChange = 'yes' | 'no' | 'unknown';
export interface ReadinessRow { method: ReadinessMethod; status: ReadinessStatus; have: number; need: number; changes: ReadinessChange }

/**
 * Re-run at every ingest, so the comparison of methods always reflects the data now held: a method whose data arrive moves from
 * "missing" to "ready" and reports whether it changes the first pick.
 */
export function methodReadiness(rated: number, cod: Pick<CostOfDelay, 'ranked' | 'pursued' | 'verdict'>, robustness?: Pick<RobustnessSummary, 'verdict'>): ReadinessRow[] {
  const base: ReadinessStatus = rated >= 2 ? 'ready' : rated === 1 ? 'partial' : 'missing';
  const need = Math.max(2, rated);
  const codNeed = Math.max(2, cod.pursued);
  const codStatus: ReadinessStatus = cod.ranked.length >= 2 && cod.ranked.length === cod.pursued ? 'ready' : cod.ranked.length > 0 ? 'partial' : 'missing';
  return [
    { method: 'impactEffort', status: base, have: rated, need, changes: 'no' },
    { method: 'robustness', status: base, have: rated, need, changes: rated < 2 || !robustness || robustness.verdict === 'none' ? 'unknown' : robustness.verdict === 'contested' ? 'yes' : 'no' },
    { method: 'costOfDelay', status: codStatus, have: cod.ranked.length, need: codNeed, changes: cod.verdict === 'differs' ? 'yes' : cod.verdict === 'agree' ? 'no' : 'unknown' },
    { method: 'opportunity', status: 'notStored', have: 0, need: 0, changes: 'unknown' },
    { method: 'kano', status: 'notStored', have: 0, need: 0, changes: 'unknown' },
    { method: 'ahp', status: 'notNeeded', have: 2, need: 3, changes: 'no' },
    { method: 'processMining', status: 'notStored', have: 0, need: 0, changes: 'unknown' },
  ];
}
