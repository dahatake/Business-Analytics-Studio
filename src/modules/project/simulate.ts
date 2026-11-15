/**
 * Contribution simulation (FR-314): "doing how much of what moves a KPI by how much, by its deadline".
 *
 * Method (docs/strategy-linkage-study.md):
 * - Each contribution is a lever (e.g. "share of orders entered on the new screen", in %) with a 3-point estimate of
 *   how much of it is done and of the KPI effect per lever unit (calibrated ranges, Hubbard). A single number hides the
 *   uncertainty that the decision depends on (Lovallo & Kahneman, "Delusions of Success", HBR 2003).
 * - The effect ramps up linearly from `rampStart` to `fullEffect` (time to benefit); only the share realised by the
 *   KPI deadline counts.
 * - Effects are entered as improvements (positive = towards the target) and applied in the KPI's direction.
 * - Contributions of several solutions to one KPI are added. That is only right when they act on different drivers,
 *   so the result flags the overlap instead of hiding it (double counting).
 * - Monte Carlo with a seeded PRNG: the same inputs always give the same P10/P50/P90 (reproducible, testable).
 */

export interface Range3 {
  low: number;
  mode: number;
  high: number;
}

export const EVIDENCE_BASES = ['measured', 'benchmark', 'expert', 'assumption'] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

export interface ContributionInput {
  id: string;
  solutionId: string;
  kpiId: string;
  amount: Range3;
  effectPerUnit: Range3;
  /** YYYY-MM-DD. */
  rampStart: string;
  /** YYYY-MM-DD: the date the full effect is reached. */
  fullEffect: string;
  basis: EvidenceBasis;
}

export interface KpiTarget {
  id: string;
  current: number;
  target: number;
  baseline: number;
  /** YYYY-MM-DD. */
  deadline: string;
}

/** PARAM-155: Monte Carlo runs per KPI. */
export const SIM_RUNS = 2000;
/** PARAM-156: coverage of the KPI gap (P50) above which the estimate is flagged as likely over-claimed. */
export const OVERCLAIM_RATIO = 1.5;

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Low ≤ mode ≤ high, all finite. */
export function validRange(r: Range3): boolean {
  return [r.low, r.mode, r.high].every(Number.isFinite) && r.low <= r.mode && r.mode <= r.high;
}

/** Inverse-CDF sample of a triangular distribution; a degenerate range returns its value. */
export function triangular(r: Range3, u: number): number {
  const { low: a, mode: c, high: b } = r;
  if (b === a) return a;
  const f = (c - a) / (b - a);
  return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

export const triangularMean = (r: Range3) => (r.low + r.mode + r.high) / 3;

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Share of the full effect realised at `at` (linear ramp; 0 before the start, 1 after full effect). */
export function realisedShare(rampStart: string, fullEffect: string, at: string): number {
  const s = day(rampStart);
  const f = day(fullEffect);
  const t = day(at);
  if (![s, f, t].every(Number.isFinite)) return 0;
  if (t <= s) return 0;
  if (f <= s || t >= f) return 1;
  return (t - s) / (f - s);
}

const direction = (k: KpiTarget) => Math.sign(k.target - k.current) || Math.sign(k.target - k.baseline) || 1;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export interface KpiSimulation {
  kpiId: string;
  contributions: number;
  solutions: string[];
  /** Expected improvement (mean of the triangular products × realised share), in KPI units, towards the target. */
  expected: number;
  /** KPI value at the deadline: P10 / P50 / P90 (P10 = the pessimistic side, in the KPI's direction). */
  p10: number;
  p50: number;
  p90: number;
  /** Share of runs reaching the target by the deadline. */
  probability: number;
  /** P50 improvement ÷ remaining gap (1 = exactly closes it). null when there is no gap. */
  coverage: number | null;
  warnings: ('overlap' | 'overclaim' | 'assumptionOnly' | 'afterDeadline' | 'invalidRange')[];
}

/**
 * Simulates every KPI that has at least one contribution. The seed makes the result reproducible; contributions with
 * an invalid range are skipped and reported.
 */
export function simulate(kpis: KpiTarget[], contributions: ContributionInput[], opts: { runs?: number; seed?: number } = {}): KpiSimulation[] {
  const runs = opts.runs ?? SIM_RUNS;
  const out: KpiSimulation[] = [];
  for (const k of kpis) {
    const all = contributions.filter((c) => c.kpiId === k.id);
    if (all.length === 0) continue;
    const valid = all.filter((c) => validRange(c.amount) && validRange(c.effectPerUnit));
    const dir = direction(k);
    const shares = valid.map((c) => realisedShare(c.rampStart, c.fullEffect, k.deadline));
    const rnd = mulberry32((opts.seed ?? 1) ^ hash(k.id));
    const values: number[] = [];
    let hit = 0;
    for (let n = 0; n < runs; n += 1) {
      let gain = 0;
      valid.forEach((c, i) => { gain += triangular(c.amount, rnd()) * triangular(c.effectPerUnit, rnd()) * shares[i]!; });
      const v = k.current + dir * gain;
      values.push(v);
      if (dir > 0 ? v >= k.target : v <= k.target) hit += 1;
    }
    values.sort((a, b) => a - b);
    const lo = quantile(values, 0.1);
    const hi = quantile(values, 0.9);
    const p50 = quantile(values, 0.5);
    const gap = (k.target - k.current) * dir;
    const coverage = gap > 0 ? ((p50 - k.current) * dir) / gap : null;
    const expected = valid.reduce((a, c, i) => a + triangularMean(c.amount) * triangularMean(c.effectPerUnit) * shares[i]!, 0);
    const solutions = [...new Set(valid.map((c) => c.solutionId))];
    const warnings: KpiSimulation['warnings'] = [];
    if (all.length > valid.length) warnings.push('invalidRange');
    if (solutions.length > 1) warnings.push('overlap');
    if (coverage !== null && coverage > OVERCLAIM_RATIO) warnings.push('overclaim');
    if (valid.length > 0 && valid.every((c) => c.basis === 'assumption')) warnings.push('assumptionOnly');
    if (shares.some((s) => s === 0)) warnings.push('afterDeadline');
    out.push({
      kpiId: k.id,
      contributions: valid.length,
      solutions,
      expected,
      p10: dir > 0 ? lo : hi,
      p50,
      p90: dir > 0 ? hi : lo,
      probability: runs > 0 ? hit / runs : 0,
      coverage,
      warnings,
    });
  }
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
