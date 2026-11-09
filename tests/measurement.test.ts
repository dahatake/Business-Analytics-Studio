import { describe, expect, it } from 'vitest';
import { aggregateTrials, judgeFrames, summarizeKpi1, type TimingEntry } from '../src/config/measurement.ts';

describe('D-8 measurement rules', () => {
  it('uses PARAM-065 (30 fps) for move/resize and KPI-5 (60 fps) for 3D', () => {
    const at30 = Array.from({ length: 150 }, () => 33);
    expect(judgeFrames(at30, 'param065').pass).toBe(true);
    expect(judgeFrames(at30, 'kpi5').pass).toBe(false);
    const at60 = Array.from({ length: 300 }, () => 16.6);
    expect(judgeFrames(at60, 'kpi5').pass).toBe(true);
    expect(judgeFrames([...at60, 40], 'kpi5').pass).toBe(false); // one frame over 33.4 ms fails 60 fps
    expect(judgeFrames([...at30, 70], 'param065').pass).toBe(false);
    expect(judgeFrames([], 'kpi5').pass).toBe(false);
  });

  it('excludes the warm-up trial and keeps outliers (P-04 ①⑤)', () => {
    const slowWarmup = Array.from({ length: 50 }, () => 200);
    const ok = Array.from({ length: 50 }, () => 16);
    const r = aggregateTrials([slowWarmup, ok, ok, [...ok, 30]], 'kpi5');
    expect(r.trials).toBe(3);
    expect(r.maxMs).toBe(30);
    expect(r.pass).toBe(true);
  });

  it('summarizes KPI-1 per run from the pipeline timing log', () => {
    const e = (runId: string, command: string, durationMs: number): TimingEntry => ({ runId, command, customer: 'acme', step: command, durationMs, ok: true });
    const log = [e('w', 'build', 999_999), e('a', 'build', 100_000), e('a', 'launch', 20_000), e('b', 'build', 200_000), e('c', 'build', 300_000)];
    const s = summarizeKpi1(log, 'acme');
    expect(s.runs).toBe(3);
    expect(s.p50Ms).toBe(200_000);
    expect(s.maxMs).toBe(300_000);
    expect(s.pass).toBe(true);
  });
});
