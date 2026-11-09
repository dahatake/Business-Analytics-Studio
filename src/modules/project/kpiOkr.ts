import type { CustomerPack, EntityOf } from '../../data/schema.ts';
import type { KpiData, KpiDef, Okr } from './model.ts';

/** PARAM-044: achievement (%) at or above which a KPI reads 「達成」. */
export const ACHIEVED_MIN_PCT = 100;
/** PARAM-045: achievement (%) at or below which a KPI reads 「未着手」. */
export const NOT_STARTED_MAX_PCT = 0;

export type KpiStatusText = 'achieved' | 'inProgress' | 'notStarted' | 'unmeasurable';

/** Achievement in %: 0 at the baseline, 100 at the target. null when baseline = target (no gap to measure). */
export function achievementPct(k: Pick<KpiDef, 'baseline' | 'current' | 'target'>): number | null {
  const gap = k.target - k.baseline;
  if (gap === 0 || !Number.isFinite(gap) || !Number.isFinite(k.current)) return null;
  return ((k.current - k.baseline) / gap) * 100;
}

export function statusForPct(pct: number | null): KpiStatusText {
  if (pct === null) return 'unmeasurable';
  if (pct >= ACHIEVED_MIN_PCT) return 'achieved';
  if (pct <= NOT_STARTED_MAX_PCT) return 'notStarted';
  return 'inProgress';
}

export const kpiStatusText = (k: Pick<KpiDef, 'baseline' | 'current' | 'target'>) => statusForPct(achievementPct(k));

/** OKR progress = mean of its key results' KPI achievements, each clamped to 0–100 %. */
export function okrPct(okr: Okr, kpis: KpiDef[]): number | null {
  const values = okr.keyResults
    .map((kr) => kpis.find((k) => k.id === kr.kpiId))
    .map((k) => (k ? achievementPct(k) : null))
    .filter((p): p is number => p !== null)
    .map((p) => Math.max(0, Math.min(100, p)));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export type KpiField = 'name' | 'unit' | 'baseline' | 'current' | 'target' | 'deadline';

/** FR-153 validation. Returns the invalid fields. */
export function validateKpi(k: { name: string; unit: string; baseline: string; current: string; target: string; deadline: string }): KpiField[] {
  const bad: KpiField[] = [];
  if (!k.name.trim()) bad.push('name');
  if (!k.unit.trim()) bad.push('unit');
  for (const f of ['baseline', 'current', 'target'] as const) if (k[f].trim() === '' || !Number.isFinite(Number(k[f]))) bad.push(f);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k.deadline) || Number.isNaN(Date.parse(k.deadline))) bad.push('deadline');
  return bad;
}

/** Demo KPIs come from the pack's KPIs; the OKRs link them. New projects start empty. */
export function demoKpis(pack: CustomerPack): KpiData {
  const kpis: KpiDef[] = pack.entities
    .filter((e): e is EntityOf<'kpi'> => e.kind === 'kpi')
    .map((k) => ({ id: k.id, name: k.name, unit: k.unit, baseline: k.baseline, current: k.current, target: k.target, deadline: '2027-03-31' }));
  const has = (id: string) => kpis.some((k) => k.id === id);
  const kr = (id: string, kpiId: string, ja: string, en: string) => ({ id, kpiId, text: { ja, en } });
  const okrs: Okr[] = [
    {
      id: 'okr-demo-delivery',
      objective: { ja: '納期と品質で選ばれる工場になる', en: 'Become the plant customers choose for delivery and quality' },
      keyResults: [
        kr('kr-demo-1', 'kpi-lead-time', 'リードタイムを目標値まで短くする', 'Bring lead time down to target'),
        kr('kr-demo-2', 'kpi-otd', '納期遵守率を目標値に上げる', 'Raise on-time delivery to target'),
        kr('kr-demo-3', 'kpi-defect', '不良率を目標値に下げる', 'Cut the defect rate to target'),
      ].filter((k) => has(k.kpiId)),
    },
    {
      id: 'okr-demo-foundation',
      objective: { ja: '資金と人材の基盤を強くする', en: 'Strengthen the cash and people foundation' },
      keyResults: [
        kr('kr-demo-4', 'kpi-dso', '売掛金の回収日数を短くする', 'Shorten days sales outstanding'),
        kr('kr-demo-5', 'kpi-engagement', '従業員エンゲージメントを高める', 'Raise employee engagement'),
      ].filter((k) => has(k.kpiId)),
    },
  ].filter((o) => o.keyResults.length > 0);
  return { kpis, okrs };
}
