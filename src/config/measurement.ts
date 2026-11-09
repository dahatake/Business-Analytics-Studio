/**
 * D-8 (user approved the recommended plan, 2026-11-09): measurement rules of proposal P-04 with the two additions
 * from docs/decision-guide.md: (a) the frame criterion depends on the operation, (b) nothing else runs during a measurement.
 *
 * - Move / resize / screen switch: PARAM-065 (≥ 30 fps). Pass = p50 frame interval ≤ 33.4 ms and no interval > 66.7 ms.
 * - 3D display and effects: KPI-5 / PARAM-007 (60 fps). Pass = p50 ≤ 16.7 ms and no interval > 33.4 ms (P-04 ⑥).
 * - Trials: 10 per condition, the first one is a warm-up and is excluded (P-04 ①). Aggregate p50 and max, no outlier removal (⑤).
 * - Results from stubs, mocks or headless software rendering are never evidence of achievement (Q-121 answer).
 */
export type FrameCriterion = 'param065' | 'kpi5';

export const FRAME_CRITERIA: Record<FrameCriterion, { targetFps: number; p50MaxMs: number; worstMaxMs: number }> = {
  param065: { targetFps: 30, p50MaxMs: 33.4, worstMaxMs: 66.7 },
  kpi5: { targetFps: 60, p50MaxMs: 16.7, worstMaxMs: 33.4 },
};

export const TRIALS_PER_CONDITION = 10;
export const WARMUP_TRIALS = 1;
export const MIN_SAMPLE_SECONDS = 5;

/** Nearest-rank percentile, the same definition as the live feed (src/state/feed.ts). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export interface FrameJudgement {
  criterion: FrameCriterion;
  frames: number;
  p50Ms: number;
  maxMs: number;
  pass: boolean;
}

export function judgeFrames(intervalsMs: readonly number[], criterion: FrameCriterion): FrameJudgement {
  const c = FRAME_CRITERIA[criterion];
  const p50Ms = percentile(intervalsMs, 50);
  const maxMs = intervalsMs.length ? Math.max(...intervalsMs) : Number.NaN;
  return { criterion, frames: intervalsMs.length, p50Ms, maxMs, pass: intervalsMs.length > 0 && p50Ms <= c.p50MaxMs && maxMs <= c.worstMaxMs };
}

/** Drops the warm-up trials and pools the remaining intervals (P-04 ①⑤). */
export function aggregateTrials(trials: readonly (readonly number[])[], criterion: FrameCriterion, warmup = WARMUP_TRIALS): FrameJudgement & { trials: number } {
  const counted = trials.slice(warmup);
  return { ...judgeFrames(counted.flat(), criterion), trials: counted.length };
}

/** KPI-1 / NFR-PERF-001: duration per run from logs/timing.json (PARAM-001 limit 6 min, PARAM-002 median 4 min). */
export interface TimingEntry {
  runId: string;
  command: string;
  customer: string | null;
  step: string;
  durationMs: number;
  ok: boolean;
}

export const KPI1_LIMIT_MS = 6 * 60_000;
export const KPI1_MEDIAN_TARGET_MS = 4 * 60_000;

export function summarizeKpi1(entries: readonly TimingEntry[], customer: string, warmup = WARMUP_TRIALS) {
  const runs = new Map<string, number>();
  for (const e of entries) {
    if (e.customer !== customer || !e.ok || !['build', 'launch'].includes(e.command)) continue;
    runs.set(e.runId, (runs.get(e.runId) ?? 0) + e.durationMs);
  }
  const durations = [...runs.values()].slice(warmup);
  const p50Ms = percentile(durations, 50);
  const maxMs = durations.length ? Math.max(...durations) : Number.NaN;
  return { runs: durations.length, p50Ms, maxMs, pass: durations.length > 0 && maxMs <= KPI1_LIMIT_MS && p50Ms <= KPI1_MEDIAN_TARGET_MS };
}
