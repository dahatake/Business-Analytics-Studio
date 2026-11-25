import { mulberry32, SIM_RUNS, triangular } from './simulate.ts';
import { PRIORITY_WEIGHTS, type PriorityInput } from './priorityAnalysis.ts';

/**
 * FR-364: how firm the "which issue first" ranking is, and which single rating is worth checking next.
 *
 * Every impact / feasibility rating (1–5) is a judgement, and judgements made by different people vary (noise; Kahneman et al. 2016).
 * Each rating is treated as its value plus symmetric triangular error whose half-width depends on the evidence behind the issue
 * (PARAM-192). The error is not clipped to 1–5, so the expected score equals today's score and the most likely pick is today's pick.
 *
 * 1. Rank acceptability (SMAA; Lahdelma, Hokkanen and Salminen 1998): share of seeded runs in which each issue ranks first / in the top 3,
 *    with the impact weight also varied (PARAM-193).
 * 2. Expected value of partial perfect information (EVPPI): how many score points (0–100) the choice would gain, on average,
 *    if one issue's ratings were known exactly. The highest one is "the next thing to check".
 *
 * No AI or web call; the same input and seed give the same result.
 */

export type EvidenceLevel = 'strong' | 'partial' | 'none';
export type RatingKind = 'impact' | 'feasibility';

/** PARAM-192 (provisional): half-width, in rating points, of the error assumed for a rating with this evidence. */
export const RATING_SPREAD: Record<EvidenceLevel, number> = { strong: 0.5, partial: 1, none: 1.5 };
/** PARAM-193 (provisional): each weight varies by up to ±50% of itself between runs (as PARAM-157 for decision options). */
export const WEIGHT_JITTER = 0.5;
/** PARAM-194: the pick is "firm" when it ranks first in at least this share of runs (the same bar as decision options). */
export const ROBUST_SHARE = 0.7;
/** Below this many score points, checking a rating is not worth suggesting. */
export const VOI_FLOOR = 0.05;
export const TOP_N = 3;

export function evidenceLevel(i: Pick<PriorityInput, 'sourced' | 'measured'>): EvidenceLevel {
  return i.sourced && i.measured ? 'strong' : i.sourced || i.measured ? 'partial' : 'none';
}

export interface RobustnessOptions {
  /** Impact weight in % (the rest is feasibility). Default 60 (PRIORITY_WEIGHTS). */
  impactWeight?: number;
  /** What-if: treat these issues' ratings as checked (strong evidence). */
  confirmed?: ReadonlySet<string>;
  /** What-if: leave these issues out (solved, or not pursued). */
  excluded?: ReadonlySet<string>;
  runs?: number;
  seed?: number;
}

export interface IssueRobustness {
  id: string;
  impact: number;
  feasibility: number;
  /** Today's score (0–100) with the chosen weights; the order of `issues`. */
  score: number;
  rank: number;
  evidence: EvidenceLevel;
  confirmed: boolean;
  pFirst: number;
  pTop: number;
  meanRank: number;
  /** 10th and 90th percentile of the rank across runs. */
  rankLow: number;
  rankHigh: number;
  /** EVPPI in score points when both ratings / only one rating of this issue would be known. */
  voi: { both: number; impact: number; feasibility: number };
  /** Probability that knowing this issue's ratings (both / one) would change which issue comes first. */
  flip: { both: number; impact: number; feasibility: number };
}

export interface NextCheck {
  id: string;
  rating: RatingKind;
  voi: number;
  flip: number;
}

export type RobustVerdict = 'robust' | 'contested' | 'none';

export interface Robustness {
  n: number;
  runs: number;
  seed: number;
  impactWeight: number;
  issues: IssueRobustness[];
  pick: string | null;
  pickShare: number;
  /** The pick's share of first places when only the ratings vary (weights held at their chosen values). */
  pickShareFixedWeights: number;
  /** The issue that ranks first most often, when it is not today's pick. */
  rival: string | null;
  verdict: RobustVerdict;
  /** Contested only because the impact / feasibility weighting is not agreed: settle the weights before checking ratings. */
  weightDriven: boolean;
  next: NextCheck | null;
}

const DEFAULT_SEED = 20161001;

const clampWeight = (w: number) => (Number.isFinite(w) ? Math.min(100, Math.max(0, w)) : PRIORITY_WEIGHTS.impact);
const score = (impact: number, feasibility: number, wI: number, wF: number) =>
  ((wI * (impact - 1) / 4 + wF * (feasibility - 1) / 4) / (wI + wF)) * 100;
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Linear-interpolated quantile of an ascending array. */
function quantile(sorted: Float64Array, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

interface Sampled { spread: number; impact: number; feasibility: number }

/** Run-major draws of one simulation. `dI[k * runs + r]` is the impact error of issue k in run r. */
interface Draws { dI: Float64Array; dF: Float64Array; ranks: Int32Array; first: Float64Array; top: Float64Array }

/** Seeded runs: each rating gets triangular error of its spread; with `jitter`, each weight varies by up to ±jitter of itself. */
function simulateRanks(base: readonly Sampled[], wI: number, wF: number, runs: number, seed: number, jitter: number): Draws {
  const n = base.length;
  const rng = mulberry32(seed);
  const dI = new Float64Array(n * runs);
  const dF = new Float64Array(n * runs);
  const ranks = new Int32Array(n * runs);
  const first = new Float64Array(n);
  const top = new Float64Array(n);
  const s = new Float64Array(n);
  const tie = new Float64Array(n);
  const order = base.map((_, k) => k);
  for (let r = 0; r < runs; r++) {
    // Both weight factors are always drawn, so runs with and without jitter see the same rating errors.
    const ri = wI * (1 + jitter * (2 * rng() - 1));
    const rf = wF * (1 + jitter * (2 * rng() - 1));
    base.forEach((b, k) => {
      const ei = triangular({ low: -b.spread, mode: 0, high: b.spread }, rng());
      const ef = triangular({ low: -b.spread, mode: 0, high: b.spread }, rng());
      dI[k * runs + r] = ei;
      dF[k * runs + r] = ef;
      s[k] = score(b.impact + ei, b.feasibility + ef, ri, rf);
      tie[k] = rng();
    });
    order.sort((a, b) => s[b]! - s[a]! || tie[a]! - tie[b]!);
    order.forEach((k, p) => {
      ranks[k * runs + r] = p + 1;
      if (p === 0) first[k]!++;
      if (p < TOP_N) top[k]!++;
    });
  }
  return { dI, dF, ranks, first, top };
}

/**
 * EVPPI of one issue: E[max(s_j, M)] − max(E[s_j], M), M = best expected score among the others.
 * `err[r]` is the score error of issue j in run r; it is centred so the baseline is exactly today's score.
 */
function evppi(mean: number, others: number, isPick: boolean, err: Float64Array): { voi: number; flip: number } {
  if (others === -Infinity || err.length === 0) return { voi: 0, flip: 0 };
  let centre = 0;
  for (const e of err) centre += e;
  centre /= err.length;
  let gain = 0;
  let flips = 0;
  for (const e of err) {
    const sj = mean + e - centre;
    if (isPick ? sj < others : sj > others) flips++;
    gain += Math.max(sj, others);
  }
  return { voi: Math.max(0, gain / err.length - Math.max(mean, others)), flip: flips / err.length };
}

export function analyzeRobustness(inputs: readonly PriorityInput[], opts: RobustnessOptions = {}): Robustness {
  const runs = Math.max(1, Math.floor(opts.runs ?? SIM_RUNS));
  const seed = opts.seed ?? DEFAULT_SEED;
  const impactWeight = clampWeight(opts.impactWeight ?? PRIORITY_WEIGHTS.impact);
  const wI = impactWeight;
  const wF = 100 - impactWeight;
  const confirmed = opts.confirmed ?? new Set<string>();
  const excluded = opts.excluded ?? new Set<string>();

  const base = inputs
    .filter((i) => !excluded.has(i.id))
    .map((i) => {
      const evidence: EvidenceLevel = confirmed.has(i.id) ? 'strong' : evidenceLevel(i);
      return { ...i, evidence, confirmed: confirmed.has(i.id), spread: RATING_SPREAD[evidence], score: score(i.impact, i.feasibility, wI, wF) };
    })
    // Same tie-break as rankIssues: score, then impact, then id.
    .sort((a, b) => b.score - a.score || b.impact - a.impact || a.id.localeCompare(b.id));
  const n = base.length;
  const empty = { n, runs, seed, impactWeight, pickShareFixedWeights: 0, rival: null, weightDriven: false, next: null };
  if (n === 0) return { ...empty, issues: [], pick: null, pickShare: 0, verdict: 'none' };

  const { dI, dF, ranks, first, top } = simulateRanks(base, wI, wF, runs, seed, WEIGHT_JITTER);

  // EVPPI uses the chosen weights: the score is linear in the ratings, so learning issue j only moves s_j around today's score.
  const unitI = (wI / 100) * 25;
  const unitF = (wF / 100) * 25;
  const issues: IssueRobustness[] = base.map((b, k) => {
    const slice = (a: Float64Array) => a.subarray(k * runs, (k + 1) * runs);
    const ei = slice(dI);
    const ef = slice(dF);
    const others = base.reduce((m, o, x) => (x === k ? m : Math.max(m, o.score)), -Infinity);
    const isPick = k === 0;
    const scaled = (f: (r: number) => number) => Float64Array.from({ length: runs }, (_, r) => f(r));
    const both = evppi(b.score, others, isPick, scaled((r) => unitI * ei[r]! + unitF * ef[r]!));
    const onlyI = evppi(b.score, others, isPick, scaled((r) => unitI * ei[r]!));
    const onlyF = evppi(b.score, others, isPick, scaled((r) => unitF * ef[r]!));
    const sorted = Float64Array.from(ranks.subarray(k * runs, (k + 1) * runs)).sort();
    const mean = sorted.reduce((a, x) => a + x, 0) / runs;
    return {
      id: b.id, impact: b.impact, feasibility: b.feasibility, score: round(b.score, 1), rank: k + 1,
      evidence: b.evidence, confirmed: b.confirmed,
      pFirst: round(first[k]! / runs), pTop: round(top[k]! / runs),
      meanRank: round(mean, 2), rankLow: Math.round(quantile(sorted, 0.1)), rankHigh: Math.round(quantile(sorted, 0.9)),
      voi: { both: round(both.voi), impact: round(onlyI.voi), feasibility: round(onlyF.voi) },
      flip: { both: round(both.flip), impact: round(onlyI.flip), feasibility: round(onlyF.flip) },
    };
  });

  const pick = issues[0]!;
  const best = issues.reduce((m, i) => (i.pFirst > m.pFirst ? i : m), pick);
  const verdict: RobustVerdict = n === 1 || (pick.pFirst >= ROBUST_SHARE && best === pick) ? 'robust' : 'contested';
  // Same draws with the weights held: if the pick is then firm, it is the weighting, not any one rating, that is in doubt.
  const fixed = verdict === 'contested' ? simulateRanks(base, wI, wF, runs, seed, 0).first[0]! / runs : pick.pFirst;
  const weightDriven = verdict === 'contested' && fixed >= ROBUST_SHARE;

  let next: NextCheck | null = null;
  for (const i of issues) {
    for (const rating of ['impact', 'feasibility'] as const) {
      const v = i.voi[rating];
      if (v >= VOI_FLOOR && (!next || v > next.voi)) next = { id: i.id, rating, voi: v, flip: i.flip[rating] };
    }
  }
  return {
    ...empty, issues, pick: pick.id, pickShare: pick.pFirst, pickShareFixedWeights: round(fixed),
    rival: best === pick ? null : best.id, verdict, weightDriven, next,
  };
}

/** What a Project pack keeps (extensions.priority.robustness): enough to explain the result without re-running it. */
export interface RobustnessSummary {
  verdict: RobustVerdict;
  weightDriven: boolean;
  pick: string | null;
  pickShare: number;
  rival: string | null;
  next: NextCheck | null;
  runs: number;
  seed: number;
  top: { id: string; pFirst: number; pTop: number }[];
}

export function summarizeRobustness(r: Robustness): RobustnessSummary {
  return {
    verdict: r.verdict, weightDriven: r.weightDriven, pick: r.pick, pickShare: r.pickShare, rival: r.rival, next: r.next, runs: r.runs, seed: r.seed,
    top: r.issues.slice(0, TOP_N).map((i) => ({ id: i.id, pFirst: i.pFirst, pTop: i.pTop })),
  };
}
/** Display name of an entity in a raw (not yet imported) pack; falls back to the id. */
export function packEntityName(pack: Record<string, unknown>, id: string, lang: 'ja' | 'en'): string {
  const entities = Array.isArray(pack.entities) ? (pack.entities as { id?: unknown; name?: { ja?: unknown; en?: unknown } }[]) : [];
  const name = entities.find((e) => e.id === id)?.name?.[lang];
  return typeof name === 'string' && name ? name : id;
}
