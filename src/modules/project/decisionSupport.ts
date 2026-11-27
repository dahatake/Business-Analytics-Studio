/**
 * FR-321: decision support computed from an imported decision report (extensions.decisionReport) and the
 * user's own ratings. Pure functions; nothing here invents a value — every default is either read from the
 * report (and marked as such) or is the neutral midpoint 3 marked as "not rated".
 *
 * Methods:
 * - Weighted additive scoring with rank-acceptability analysis (SMAA; Lahdelma, Hokkanen & Salminen 1998)
 *   to show whether the top option survives weight and score uncertainty.
 * - Discovery-driven planning (McGrath & MacMillan, HBR 1995): the trial gate is checked by simulating
 *   the measurement itself (false pass / false fail), not only the expected effect.
 * - Value of information (Howard 1966; Hubbard, "How to Measure Anything"): ask first the questions whose
 *   answer could change the decision most per unit of effort.
 * - Decision quality checklist after Kahneman, Lovallo & Sibony, "Before You Make That Big Decision…"
 *   (HBR 2011) and the premortem (Klein, HBR 2007).
 */
import type { DecisionReport, ReportEvidence, ReportStep } from '../../data/extensionSchemas.ts';
import { REPORT_EVIDENCE } from '../../data/extensionSchemas.ts';
import { mulberry32, triangular, validRange, type Range3 } from './simulate.ts';

export type Rating = 1 | 2 | 3 | 4 | 5;
/** A rated value and whether it came from the user, from the report, or is the unrated midpoint. */
export interface Rated { value: number; origin: 'user' | 'report' | 'unrated' }

export const ISSUE_CRITERIA = ['impact', 'urgency', 'confidence'] as const;
export type IssueCriterion = (typeof ISSUE_CRITERIA)[number];
export const OPTION_CRITERIA = ['effect', 'ease', 'affordability', 'safety', 'evidence'] as const;
export type OptionCriterion = (typeof OPTION_CRITERIA)[number];
export const VOI_CRITERIA = ['impact', 'uncertainty', 'effort'] as const;
export type VoiCriterion = (typeof VOI_CRITERIA)[number];

export interface GateInputs {
  /** Pass threshold: observed median reduction (0–1). */
  gate: number;
  /** True reduction of the targeted hours (0–1): low / most likely / high. */
  effect: Range3;
  /** Coefficient of variation of hours per engagement. */
  cv: number;
  /** Engagements per arm (before and during the trial). */
  n: number;
  /** New overhead as a share of the baseline hours (0–1). */
  overhead: number;
}

export interface DecisionInputs {
  issues: Record<string, Partial<Record<IssueCriterion, number>>>;
  issueWeights: Record<IssueCriterion, number>;
  options: Record<string, Partial<Record<OptionCriterion, number>>>;
  optionWeights: Record<OptionCriterion, number>;
  questions: Record<string, Partial<Record<VoiCriterion, number>>>;
  gaps: Record<string, { current?: number; target?: number }>;
  risks: Record<string, { likelihood?: number; impact?: number }>;
  kpiBaseline: Record<string, BaselineStatus>;
  gate: Partial<GateInputs>;
  checks: Record<string, boolean>;
  /** FR-322: the option the user chose for each drafted decision (absent: the recommendation applies, marked as inferred). */
  choices: Record<string, string>;
}

export const BASELINE_STATUS = ['none', 'partial', 'measured'] as const;
export type BaselineStatus = (typeof BASELINE_STATUS)[number];

export const emptyDecisionInputs = (): DecisionInputs => ({
  issues: {}, issueWeights: { impact: 3, urgency: 2, confidence: 1 },
  options: {}, optionWeights: { effect: 3, ease: 2, affordability: 2, safety: 2, evidence: 1 },
  questions: {}, gaps: {}, risks: {}, kpiBaseline: {}, gate: {}, checks: {}, choices: {},
});

const clamp = (x: number, lo = 1, hi = 5) => Math.min(hi, Math.max(lo, x));
/** The report's 3-level ordinal (低=1, 中=2, 高=3; ranges average) on the 1–5 scale: 1→1, 2→3, 3→5. */
export const ordinalTo5 = (o: number | undefined): number | undefined => (o === undefined ? undefined : clamp(o * 2 - 1));

/* ---------- Evidence profile ---------- */

export interface EvidenceProfile {
  counts: Record<ReportEvidence, number>;
  /** Sentences in the step's sections that carry no evidence label. */
  unlabelled: number;
  sentences: number;
  /** Share of labelled claims that are hypotheses or still to be confirmed. */
  uncertainShare: number;
}

export function evidenceProfile(r: DecisionReport, step: ReportStep | 'all'): EvidenceProfile {
  const sections = new Set(r.sections.filter((s) => step === 'all' || s.step === step).map((s) => s.id));
  const counts = Object.fromEntries(REPORT_EVIDENCE.map((e) => [e, 0])) as Record<ReportEvidence, number>;
  const claims = r.claims.filter((c) => sections.has(c.sectionId));
  for (const c of claims) counts[c.evidence]++;
  const sentences = r.sections.filter((s) => sections.has(s.id)).reduce((n, s) => n + s.sentences, 0);
  const uncertain = counts.hypothesis + counts.toConfirm;
  return { counts, sentences, unlabelled: Math.max(0, sentences - claims.length), uncertainShare: claims.length ? uncertain / claims.length : 0 };
}

/* ---------- Issues: weighted priority ---------- */

export interface IssueRow {
  id: string;
  title: string;
  ratings: Record<IssueCriterion, Rated>;
  score: number;
  rank: number;
  hypothesis: boolean;
  falsifier: boolean;
}

function rated(user: number | undefined, report: number | undefined): Rated {
  if (user !== undefined) return { value: clamp(user), origin: 'user' };
  if (report !== undefined) return { value: report, origin: 'report' };
  return { value: 3, origin: 'unrated' };
}

const weighted = <K extends string>(ratings: Record<K, Rated>, weights: Record<K, number>, keys: readonly K[]) => {
  const total = keys.reduce((s, k) => s + Math.max(0, weights[k]), 0);
  return total ? keys.reduce((s, k) => s + Math.max(0, weights[k]) * ratings[k].value, 0) / total : 0;
};

const rankBy = <T extends { score: number; rank: number }>(rows: T[]): T[] => {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  sorted.forEach((r, i) => { r.rank = i > 0 && Math.abs(sorted[i - 1]!.score - r.score) < 1e-9 ? sorted[i - 1]!.rank : i + 1; });
  return sorted;
};

/** Evidence of an issue on the 1–5 confidence scale: a stated fact is firmer than a hypothesis. */
const CONFIDENCE: Partial<Record<ReportEvidence, number>> = { fact: 4, external: 4, interpretation: 3, hypothesis: 2, toConfirm: 2 };

export function rankIssues(r: DecisionReport, inputs: DecisionInputs): IssueRow[] {
  return rankBy(r.issues.map((issue) => {
    const u = inputs.issues[issue.id] ?? {};
    const confidence = issue.evidence.length ? Math.min(...issue.evidence.map((e) => CONFIDENCE[e] ?? 3)) : undefined;
    const ratings = {
      impact: rated(u.impact, ordinalTo5(issue.priority)),
      // FR-383: the report states one priority, not a timing. Copying it into urgency counted it twice (5/6 of the score) and
      // labelled the copy as the report's; urgency stays unrated until a person rates it.
      urgency: rated(u.urgency, undefined),
      confidence: rated(u.confidence, confidence),
    };
    return {
      id: issue.id, title: issue.title, ratings, rank: 0,
      score: weighted(ratings, inputs.issueWeights, ISSUE_CRITERIA),
      hypothesis: issue.evidence.some((e) => e === 'hypothesis' || e === 'toConfirm'),
      falsifier: Boolean(issue.falsifier),
    };
  }));
}

/* ---------- Options: issue coverage, weighted score and SMAA ---------- */

/** Issue numbers an option says it addresses ("課題1・2・5", "Issues 1, 2 and 5"). */
export function linkedIssues(r: DecisionReport, optionId: string): string[] {
  const option = r.options.find((o) => o.id === optionId);
  if (!option) return [];
  const ids = new Set<string>();
  for (const m of option.text.matchAll(/(?:課題|[Ii]ssues?)\s*((?:\d+\s*(?:[・、,，]|and|&)?\s*)+)/g)) {
    for (const n of m[1]!.match(/\d+/g) ?? []) ids.add(`issue-${n}`);
  }
  return r.issues.filter((i) => ids.has(i.id)).map((i) => i.id);
}

export interface OptionRow {
  id: string;
  label: string;
  title: string;
  ratings: Record<OptionCriterion, Rated>;
  score: number;
  rank: number;
  issues: string[];
  /** True when the issue links are drafted (FR-322) rather than stated by the report. */
  inferredIssues: boolean;
  /** Share of the total issue priority score the option addresses (0–1). */
  coverage: number;
}

/**
 * `links` supplies drafted option → issue links (FR-322) for options whose text names no issue; the report's
 * own links always win.
 */
export function rankOptions(r: DecisionReport, inputs: DecisionInputs, issueRows: IssueRow[] = rankIssues(r, inputs), links?: ReadonlyMap<string, readonly string[]>): OptionRow[] {
  const issueScore = new Map(issueRows.map((i) => [i.id, i.score]));
  const totalIssue = issueRows.reduce((s, i) => s + i.score, 0);
  return rankBy(r.options.map((o) => {
    const u = inputs.options[o.id] ?? {};
    const stated = linkedIssues(r, o.id);
    const inferredIssues = !stated.length && Boolean(links?.get(o.id)?.length);
    const issues = inferredIssues ? [...links!.get(o.id)!] : stated;
    const coverage = totalIssue ? issues.reduce((s, id) => s + (issueScore.get(id) ?? 0), 0) / totalIssue : 0;
    const invert = (x: number | undefined) => (x === undefined ? undefined : 6 - x);
    // Effect: the report's own priority, else issue coverage (addressing half the weighted issues already rates 5).
    const effectFromReport = ordinalTo5(o.priority) ?? (issues.length ? clamp(1 + coverage * 8) : undefined);
    const ratings = {
      effect: rated(u.effect, effectFromReport),
      ease: rated(u.ease, invert(ordinalTo5(o.difficulty))),
      affordability: rated(u.affordability, invert(ordinalTo5(o.investment))),
      safety: rated(u.safety, undefined),
      evidence: rated(u.evidence, undefined),
    };
    return { id: o.id, label: o.label, title: o.title, ratings, rank: 0, issues, inferredIssues, coverage, score: weighted(ratings, inputs.optionWeights, OPTION_CRITERIA) };
  }));
}

export interface Acceptability { id: string; first: number; meanRank: number }

/**
 * SMAA-style robustness: each run perturbs every weight by ±weightJitter (relative) and every rating by
 * ±scoreJitter (absolute, unrated values by twice that), then ranks. Seeded, so the result is reproducible.
 */
export function rankAcceptability(rows: OptionRow[], weights: Record<OptionCriterion, number>, opts: { runs?: number; seed?: number; weightJitter?: number; scoreJitter?: number } = {}): Acceptability[] {
  const { runs = 2000, seed = 7, weightJitter = 0.5, scoreJitter = 0.5 } = opts;
  if (!rows.length) return [];
  const rand = mulberry32(seed);
  const first = new Array<number>(rows.length).fill(0);
  const rankSum = new Array<number>(rows.length).fill(0);
  for (let run = 0; run < runs; run++) {
    const w = OPTION_CRITERIA.map((k) => Math.max(0, weights[k]) * (1 + (rand() * 2 - 1) * weightJitter));
    const total = w.reduce((a, b) => a + b, 0) || 1;
    const scores = rows.map((row) => OPTION_CRITERIA.reduce((s, k, i) => {
      const r = row.ratings[k];
      const spread = r.origin === 'unrated' ? scoreJitter * 2 : scoreJitter;
      return s + w[i]! * clamp(r.value + (rand() * 2 - 1) * spread);
    }, 0) / total);
    const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
    order.forEach(([, i], pos) => { rankSum[i] = rankSum[i]! + pos + 1; });
    const top = order[0]![1];
    first[top] = first[top]! + 1;
  }
  return rows.map((row, i) => ({ id: row.id, first: first[i]! / runs, meanRank: rankSum[i]! / runs }));
}

/* ---------- Trial gate: does the measurement decide correctly? ---------- */

/** The proposed gate in the report ("中央値20%削減"), as a share; null when the report states none. */
export function reportGate(r: DecisionReport): number | null {
  for (const c of r.claims.filter((x) => x.evidence === 'proposedTarget')) {
    const m = c.text.match(/(\d+(?:\.\d+)?)\s*[%％]/);
    if (m) return Number(m[1]) / 100;
  }
  return null;
}

export const GATE_N = [5, 10, 15, 20, 30, 40, 60, 80] as const;
/** Placeholder trial inputs shown (and flagged) until the user enters an effect estimate. */
export const GATE_PLACEHOLDER: Omit<GateInputs, 'gate'> = { effect: { low: 0.05, mode: 0.2, high: 0.4 }, cv: 0.6, n: 20, overhead: 0.05 };

export interface GateResult {
  /** Probability that the trial passes the gate. */
  pass: number;
  /** P(pass | true net reduction < gate): scaling something that does not work. */
  falsePass: number;
  /** P(fail | true net reduction ≥ gate): stopping something that works. */
  falseFail: number;
  /** Share of runs where the trial verdict matches the truth. */
  correct: number;
  /** P(true net reduction ≥ gate) under the effect range. */
  trulyMeets: number;
  /** Probability of a correct decision for each sample size in GATE_N. */
  curve: { n: number; correct: number }[];
}

function median(xs: number[]): number {
  const s = xs.sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function normal(rand: () => number): number {
  const u = rand() || 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function validGate(g: GateInputs): boolean {
  return validRange(g.effect) && g.effect.low >= 0 && g.effect.high < 1 && g.gate > 0 && g.gate < 1
    && g.cv >= 0 && g.cv <= 3 && Number.isInteger(g.n) && g.n >= 3 && g.n <= 500 && g.overhead >= 0 && g.overhead < 1;
}

/**
 * Before/after trial on lognormal hours per engagement. Each run draws a true reduction from the effect range,
 * samples n engagements per arm, and compares the observed median reduction with the gate.
 */
export function simulateGate(g: GateInputs, opts: { runs?: number; seed?: number } = {}): GateResult | null {
  if (!validGate(g)) return null;
  const { runs = 2000, seed = 11 } = opts;
  const sigma = Math.sqrt(Math.log(1 + g.cv * g.cv));
  const one = (n: number, rand: () => number) => {
    const effect = triangular(g.effect, rand());
    const net = 1 - (1 - effect) * (1 + g.overhead);
    const before: number[] = [];
    const after: number[] = [];
    for (let i = 0; i < n; i++) {
      before.push(Math.exp(sigma * normal(rand)));
      after.push(Math.exp(sigma * normal(rand)) * (1 - net));
    }
    const observed = 1 - median(after) / median(before);
    return { meets: net >= g.gate, pass: observed >= g.gate };
  };
  // Common random numbers: run i uses the same stream at every n, so the curve differences come from n, not noise.
  const run = (n: number, i: number) => one(n, mulberry32(seed * 100_003 + i));
  let pass = 0, meets = 0, falsePass = 0, falseFail = 0;
  for (let i = 0; i < runs; i++) {
    const r = run(g.n, i);
    if (r.pass) pass++;
    if (r.meets) { meets++; if (!r.pass) falseFail++; } else if (r.pass) falsePass++;
  }
  const correct = (runs - falsePass - falseFail) / runs;
  const curve = GATE_N.map((n) => {
    if (n === g.n) return { n, correct };
    let ok = 0;
    for (let i = 0; i < runs; i++) { const r = run(n, i); if (r.meets === r.pass) ok++; }
    return { n, correct: ok / runs };
  });
  return {
    pass: pass / runs, trulyMeets: meets / runs, correct,
    falsePass: runs - meets ? falsePass / (runs - meets) : 0,
    falseFail: meets ? falseFail / meets : 0,
    curve,
  };
}

/* ---------- Open questions: value of information ---------- */

export interface QuestionRow { id: string; text: string; ratings: Record<VoiCriterion, Rated>; score: number; rank: number }

/** Decision impact × current uncertainty ÷ effort to answer (each 1–5), normalized to 0–5. */
export function rankQuestions(r: DecisionReport, inputs: DecisionInputs): QuestionRow[] {
  return rankBy(r.openQuestions.map((q) => {
    const u = inputs.questions[q.id] ?? {};
    const ratings = { impact: rated(u.impact, undefined), uncertainty: rated(u.uncertainty, undefined), effort: rated(u.effort, undefined) };
    return { id: q.id, text: q.text, ratings, rank: 0, score: (ratings.impact.value * ratings.uncertainty.value) / ratings.effort.value / 5 };
  }));
}

/* ---------- Gaps and risks ---------- */

export interface GapRow { id: string; area: string; priority?: number; current?: number; target?: number; size?: number; weighted?: number }

export function gapRows(r: DecisionReport, inputs: DecisionInputs): GapRow[] {
  return r.gaps.map((g) => {
    const u = inputs.gaps[g.id] ?? {};
    const size = u.current !== undefined && u.target !== undefined ? Math.max(0, u.target - u.current) : undefined;
    const p = ordinalTo5(g.priority);
    return { id: g.id, area: g.area, priority: g.priority, current: u.current, target: u.target, size, weighted: size !== undefined ? size * (p ?? 3) / 5 : undefined };
  }).sort((a, b) => (b.weighted ?? -1) - (a.weighted ?? -1) || (b.priority ?? 0) - (a.priority ?? 0));
}

export interface RiskCell { likelihood: number; impact: number; ids: string[] }

export function riskMatrix(r: DecisionReport, inputs: DecisionInputs): { cells: RiskCell[]; unrated: string[] } {
  const cells: RiskCell[] = [];
  for (let l = 5; l >= 1; l--) for (let i = 1; i <= 5; i++) cells.push({ likelihood: l, impact: i, ids: [] });
  const unrated: string[] = [];
  for (const risk of r.risks) {
    const u = inputs.risks[risk.id];
    if (u?.likelihood === undefined || u.impact === undefined) { unrated.push(risk.id); continue; }
    cells.find((c) => c.likelihood === u.likelihood && c.impact === u.impact)!.ids.push(risk.id);
  }
  return { cells, unrated };
}

/* ---------- Decision checklist ---------- */

export const AUTO_CHECKS = ['alternatives', 'evidence', 'falsifiers', 'mitigations', 'questions', 'robust'] as const;
export type AutoCheck = (typeof AUTO_CHECKS)[number];
export const MANUAL_CHECKS = ['premortem', 'baseRate', 'dissent', 'sunkCost', 'owner'] as const;
export type ManualCheck = (typeof MANUAL_CHECKS)[number];

export interface CheckResult { id: AutoCheck; ok: boolean; value: number; total: number }

export function autoChecks(r: DecisionReport, inputs: DecisionInputs, links?: ReadonlyMap<string, readonly string[]>): CheckResult[] {
  const profile = evidenceProfile(r, 'all');
  const rows = rankOptions(r, inputs, undefined, links);
  const top = rankAcceptability(rows, inputs.optionWeights, { runs: 500 }).sort((a, b) => b.first - a.first)[0];
  const answered = r.openQuestions.length;
  return [
    { id: 'alternatives', ok: r.options.length >= 3, value: r.options.length, total: 3 },
    { id: 'evidence', ok: profile.uncertainShare <= 0.5, value: Math.round(profile.uncertainShare * 100), total: 50 },
    { id: 'falsifiers', ok: r.issues.length > 0 && r.issues.every((i) => i.falsifier), value: r.issues.filter((i) => i.falsifier).length, total: r.issues.length },
    { id: 'mitigations', ok: r.risks.length > 0 && r.risks.every((x) => x.mitigation), value: r.risks.filter((x) => x.mitigation).length, total: r.risks.length },
    { id: 'questions', ok: answered === 0, value: answered, total: 0 },
    { id: 'robust', ok: (top?.first ?? 0) >= 0.7, value: Math.round((top?.first ?? 0) * 100), total: 70 },
  ];
}
