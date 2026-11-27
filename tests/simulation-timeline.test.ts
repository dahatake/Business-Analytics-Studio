import { expect, it } from 'vitest';
import { dateAt, objectiveTrajectory, playStep, timeline } from '../src/modules/project/simulationTimeline.ts';
import { transitionFlows } from '../src/domain/resourceModel.ts';
import type { ContributionInput } from '../src/modules/project/simulate.ts';
import { simulate } from '../src/modules/project/simulate.ts';

const kpi = { id: 'days', baseline: 20, current: 18, target: 14, deadline: '2026-01-09' };
const unit = { low: 1, mode: 1, high: 1 };
const gain: ContributionInput = { id: 'a', kpiId: 'days', solutionId: 's', basis: 'measured', amount: { low: 10, mode: 10, high: 10 }, effectPerUnit: unit, rampStart: '2026-01-03', fullEffect: '2026-01-13' };

it('moves a lower-is-better KPI only after rollout and locates the exact crossing between samples', () => {
  const { dates, rows: [r] } = timeline('2026-01-01', [kpi], [gain], []);
  expect(r!.value('2026-01-03')).toBe(18);
  expect(r!.improves).toBe('2026-01-04');
  expect(r!.reaches).toBe('2026-01-07');
  expect(dates).toContain(r!.reaches);
  expect(r!.value(kpi.deadline)).toBe(12);
  expect(r!.value('2026-01-31')).toBe(8);
});

it('distinguishes a modeled miss from an unknown or invalid estimate', () => {
  const { rows: [miss, unknown], skipped } = timeline('2026-01-01', [{ ...kpi, target: 7 }, { ...kpi, id: 'other' }], [gain, { ...gain, kpiId: 'other', rampStart: '2026-02-30' }], []);
  expect(miss!.modeled).toBe(true);
  expect(miss!.reaches).toBeNull();
  expect(unknown!.modeled).toBe(false);
  expect(skipped).toBe(1);
});

it('does not reverse improvement after the KPI has already beaten the target', () => {
  const ahead = { ...kpi, current: 12 };
  const { rows: [r] } = timeline('2026-01-01', [ahead], [gain], []);
  expect(r!.reaches).toBe('2026-01-01');
  expect(r!.value(kpi.deadline)).toBe(6);
  expect(simulate([ahead], [gain])[0]!.p50).toBe(6);
});

it('moves allocation between pools without inventing volume half way through rollout', () => {
  const before = [{ poolId: 'a', demandId: 'work', qty: 80 }];
  const after = [{ poolId: 'a', demandId: 'work', qty: 20 }, { poolId: 'b', demandId: 'work', qty: 60 }];
  expect(transitionFlows({ before, after }, 0.5).map(f => f.qty)).toEqual([50, 30]);
  expect(transitionFlows({ before, after }, 0)).toEqual(before);
  expect(transitionFlows({ before, after }, 1)).toEqual(after);
});

it('dates OKR improvement after a below-baseline KR starts making measurable progress and waits for all targets', () => {
  const rows = [{ ...kpi, baseline: 16 }, { ...kpi, id: 'second', target: 9 }];
  const okr = { id: 'objective', objective: 'Reduce time', keyResults: rows.map(k => ({ id: k.id, text: k.id, kpiId: k.id })) };
  const model = timeline('2026-01-01', rows, [gain, { ...gain, kpiId: 'second', rampStart: '2026-02-01', fullEffect: '2026-02-11' }], []);
  const curve = objectiveTrajectory(okr, model)!;
  expect(curve.improves).toBe('2026-01-06');
  expect(curve.reaches).toBe('2026-02-10');
  expect(curve.value(curve.reaches!)).toBe(100);
  expect(objectiveTrajectory(okr, timeline('2026-01-01', rows, [gain], []))).toBeNull();
});

it('maps a dragged position to a calendar day, clamping outside the axis, and plays at an even pace to the end', () => {
  expect(dateAt('2026-01-01', '2026-12-31', 0.5)).toBe('2026-07-02');
  expect(dateAt('2026-01-01', '2026-12-31', -0.3)).toBe('2026-01-01');
  expect(dateAt('2026-01-01', '2026-12-31', 1.7)).toBe('2026-12-31');
  expect(playStep('2026-01-01', '2027-01-01', '2026-01-01')).toBe('2026-01-09');
  expect(playStep('2026-01-01', '2027-01-01', '2026-12-30')).toBe('2027-01-01');
  expect(playStep('2026-01-01', '2026-01-03', '2026-01-01')).toBe('2026-01-02');
});
