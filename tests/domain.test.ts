import { describe, expect, it } from 'vitest';
import { chooseKpiVisual, kpiProgress, kpiStatus } from '../src/domain/kpi.ts';
import { measure, objective, optimize, scaleCurrentPolicy, scaledDemand, solveTransportation } from '../src/domain/optimize.ts';
import { priorityScore, rankIssues } from '../src/domain/priority.ts';
import { executiveSummary } from '../src/domain/summary.ts';
import { entitiesOf } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import type { OptimizationInput } from '../src/data/schema.ts';
import { PARAMS } from '../src/config/params.ts';

describe('F-3.3.3 KPI visual choice', () => {
  it('uses a ring when attainment ratio is meaningful', () => {
    expect(chooseKpiVisual({ baseline: 21, current: 16, target: 10, direction: 'decrease', scale: 'ratio' })).toEqual({ kind: 'ring', progress: 5 / 11 });
  });
  it('uses a bullet chart with a reason for interval scales, no-gap and inconsistent targets', () => {
    expect(chooseKpiVisual({ baseline: -12, current: -4, target: 10, direction: 'increase', scale: 'interval' })).toEqual({ kind: 'bullet', reason: 'intervalScale' });
    expect(chooseKpiVisual({ baseline: 5, current: 5, target: 5, direction: 'increase', scale: 'ratio' })).toEqual({ kind: 'bullet', reason: 'noGap' });
    expect(chooseKpiVisual({ baseline: 5, current: 5, target: 3, direction: 'increase', scale: 'ratio' })).toEqual({ kind: 'bullet', reason: 'inconsistentTarget' });
  });
  it('status handles regression and overshoot', () => {
    expect(kpiStatus({ baseline: 10, current: 8, target: 20 })).toBe('regressed');
    expect(kpiStatus({ baseline: 10, current: 25, target: 20 })).toBe('achieved');
    expect(kpiProgress({ baseline: 850, current: 610, target: 300 })).toBeCloseTo(240 / 550);
  });
  it('every sample KPI resolves to a visual, and the eNPS sample is the bullet example', () => {
    const visuals = entitiesOf('kpi').map((k) => [k.id, chooseKpiVisual(k).kind] as const);
    expect(visuals.find(([id]) => id === 'kpi-engagement')?.[1]).toBe('bullet');
    expect(visuals.filter(([, v]) => v === 'ring').length).toBe(5);
  });
});

/** Brute force over all integer allocations (tiny instances only) — an independent oracle for the solver. */
function bruteForce(input: OptimizationInput, demand: number[], carbon: number): number {
  const P = input.plants.length, R = demand.length;
  let best = Infinity;
  const x = Array.from({ length: P }, () => new Array<number>(R).fill(0));
  const rec = (j: number) => {
    if (j === R) {
      if (x.every((row, i) => row.reduce((a, b) => a + b, 0) <= input.plants[i]!.capacityT)) best = Math.min(best, objective(input, x, carbon));
      return;
    }
    const split = (i: number, left: number) => {
      if (i === P - 1) { x[i]![j] = left; rec(j + 1); return; }
      for (let q = 0; q <= left; q++) { x[i]![j] = q; split(i + 1, left - q); }
    };
    split(0, demand[j]!);
  };
  rec(0);
  return best;
}

const tiny: OptimizationInput = {
  period: { ja: '試験', en: 'test' },
  plants: [
    { siteId: 'a', capacityT: 5, productionCostPerT: 10, co2PerT: 1 },
    { siteId: 'b', capacityT: 4, productionCostPerT: 7, co2PerT: 3 },
    { siteId: 'c', capacityT: 3, productionCostPerT: 12, co2PerT: 0.5 },
  ],
  regionDemandT: [3, 4, 2],
  transportCostPerT: [[1, 6, 3], [5, 1, 8], [2, 2, 1]],
  leadTimeDays: [[1, 2, 1], [3, 1, 4], [1, 1, 1]],
  co2TransportPerT: [[0.1, 0.4, 0.2], [0.3, 0.1, 0.5], [0.1, 0.1, 0.1]],
  currentAllocation: [[3, 0, 2], [0, 4, 0], [0, 0, 0]],
};

describe('F-3.3.4 optimization correctness', () => {
  it.each([0, 1, 4])('min-cost flow equals brute force on a tiny instance (carbon price %i)', (carbon) => {
    const x = solveTransportation(tiny, tiny.regionDemandT, carbon)!;
    expect(objective(tiny, x, carbon)).toBeCloseTo(bruteForce(tiny, tiny.regionDemandT, carbon), 9);
  });

  it('after-allocation meets demand exactly and respects capacity', () => {
    const r = optimize(samplePack.optimization, { demandGrowth: 0.05, carbonPriceJpyPerT: 10_000 });
    if (!r.feasible) throw new Error('expected feasible');
    r.demandT.forEach((d, j) => expect(r.after.reduce((a, row) => a + row[j]!, 0)).toBe(d));
    samplePack.optimization.plants.forEach((p, i) => expect(r.afterMetrics.plantLoadT[i]).toBeLessThanOrEqual(p.capacityT));
  });

  it('before and after are measured on the same population (same total demand)', () => {
    const r = optimize(samplePack.optimization, { demandGrowth: 0.08, carbonPriceJpyPerT: 0 });
    if (!r.feasible) throw new Error('expected feasible');
    expect(r.beforeMetrics.shippedT).toBe(r.afterMetrics.shippedT);
    expect(r.afterMetrics.totalCostJpy).toBeLessThanOrEqual(r.beforeMetrics.totalCostJpy);
  });

  it('reports infeasibility when demand exceeds capacity', () => {
    const r = optimize(samplePack.optimization, { demandGrowth: 0.3, carbonPriceJpyPerT: 0 });
    expect(r.feasible).toBe(false);
  });

  it('scaling today\'s policy preserves demand exactly', () => {
    const d = scaledDemand(samplePack.optimization, 0.07);
    const x = scaleCurrentPolicy(samplePack.optimization, d);
    d.forEach((dj, j) => expect(x.reduce((a, row) => a + row[j]!, 0)).toBe(dj));
    expect(measure(samplePack.optimization, x).shippedT).toBe(d.reduce((a, b) => a + b, 0));
  });
});

describe('priority and summary', () => {
  it('scores are 0–100 and weights change the ranking', () => {
    const issues = entitiesOf('issue');
    expect(priorityScore({ impact: 5, feasibility: 5 }, { impact: 1, feasibility: 1 })).toBe(100);
    expect(priorityScore({ impact: 1, feasibility: 1 }, { impact: 1, feasibility: 1 })).toBe(0);
    const byImpact = rankIssues(issues, { impact: 100, feasibility: 0 })[0]!.issue.id;
    const byFeas = rankIssues(issues, { impact: 0, feasibility: 100 })[0]!.issue.id;
    expect(byImpact).toBe('issue-lead-time');
    expect(byFeas).toBe('issue-cash');
  });

  it.each(['ja', 'en'] as const)('executive summary has PARAM-015 sentences (%s) and hides internal values externally', (lang) => {
    const internal = executiveSummary(lang, 'internal');
    const external = executiveSummary(lang, 'external');
    for (const s of [internal, external]) {
      expect(s.length).toBeGreaterThanOrEqual(PARAMS.summarySentencesMin);
      expect(s.length).toBeLessThanOrEqual(PARAMS.summarySentencesMax);
    }
    expect(external.join(' ')).not.toMatch(/28/);
  });
});

