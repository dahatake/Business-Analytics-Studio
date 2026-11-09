import type { EntityOf } from '../data/schema.ts';

type Kpi = EntityOf<'kpi'>;

export type KpiVisualReason = 'intervalScale' | 'noGap' | 'inconsistentTarget';
export type KpiVisual =
  | { kind: 'ring'; progress: number }
  | { kind: 'bullet'; reason: KpiVisualReason };

export type KpiStatus = 'achieved' | 'progressing' | 'regressed';

/** Share of the baseline→target gap closed so far. Negative = moved the wrong way; >1 = beyond target. */
export function kpiProgress(k: Pick<Kpi, 'baseline' | 'current' | 'target'>): number {
  const gap = k.target - k.baseline;
  if (gap === 0) return Number.NaN;
  return (k.current - k.baseline) / gap;
}

export function kpiStatus(k: Pick<Kpi, 'baseline' | 'current' | 'target'>): KpiStatus {
  const p = kpiProgress(k);
  if (Number.isNaN(p)) return 'progressing';
  if (p >= 1) return 'achieved';
  if (p < 0) return 'regressed';
  return 'progressing';
}

/**
 * F-3.3.3: a ring gauge implies "x% of a whole". Choose it only when that reading is valid;
 * otherwise use a bullet chart on the native scale and keep the reason visible to the user.
 */
export function chooseKpiVisual(k: Pick<Kpi, 'baseline' | 'current' | 'target' | 'direction' | 'scale'>): KpiVisual {
  if (k.scale === 'interval') return { kind: 'bullet', reason: 'intervalScale' };
  if (k.target === k.baseline) return { kind: 'bullet', reason: 'noGap' };
  const targetIsImprovement = k.direction === 'increase' ? k.target > k.baseline : k.target < k.baseline;
  if (!targetIsImprovement) return { kind: 'bullet', reason: 'inconsistentTarget' };
  return { kind: 'ring', progress: kpiProgress(k) };
}
