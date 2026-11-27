import { addMonths } from './kpiWhatIf.ts';
import { okrPct } from './kpiOkr.ts';
import type { Okr } from './model.ts';
import { improvementDirection, realisedShare, triangularMean, validRange, type ContributionInput, type KpiTarget } from './simulate.ts';

const DAY = 86_400_000;
export const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
export const dateOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayOf(s)) && dateOf(dayOf(s)) === s;

// Within each interval the curve is linear. Binary search gives the first qualifying calendar day.
function firstDay(knots: string[], matches: (date: string) => boolean) {
  for (let i = 0; i < knots.length; i++) {
    if (!matches(knots[i]!)) continue;
    let lo = i ? dayOf(knots[i - 1]!) + 1 : dayOf(knots[0]!), hi = dayOf(knots[i]!);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (matches(dateOf(mid))) hi = mid; else lo = mid + 1;
    }
    return dateOf(lo);
  }
  return null;
}

export function timeline(today: string, kpis: KpiTarget[], inputs: ContributionInput[], events: string[]) {
  const points = new Set([today, addMonths(today, 12), ...events.filter(validDate), ...kpis.map(k => k.deadline).filter(validDate)]);
  const usable = inputs.filter(c => validDate(c.rampStart) && validDate(c.fullEffect) && c.fullEffect >= c.rampStart && validRange(c.amount) && validRange(c.effectPerUnit));
  for (const c of usable) {
    points.add(c.rampStart);
    points.add(c.fullEffect);
    // The existing ramp has zero effect on its start day, including an instantaneous change.
    points.add(dateOf(dayOf(c.rampStart) + 1));
  }
  const knots = [...points].sort();
  const first = dayOf(knots[0]!);
  const last = dayOf(knots.at(-1)!);
  const rows = kpis.map(k => {
    const effects = usable.filter(c => c.kpiId === k.id);
    const direction = improvementDirection(k);
    const value = (date: string) => k.current + direction * effects.reduce((sum, c) =>
      sum + triangularMean(c.amount) * triangularMean(c.effectPerUnit) * realisedShare(c.rampStart, c.fullEffect, date), 0);
    const crossing = (meets: (n: number) => boolean) => {
      if (!effects.length) return null;
      const date = firstDay(knots, d => meets(value(d)));
      if (date) points.add(date);
      return date;
    };
    return { k, effects, modeled: effects.length > 0, value, improves: crossing(n => direction * (n - k.current) > 0), reaches: crossing(n => direction * (n - k.target) >= 0) };
  });
  for (let i = 0; i <= 24; i++) points.add(dateOf(Math.round(first + (last - first) * i / 24)));
  return { dates: [...points].sort(), rows, skipped: inputs.length - usable.length };
}

export function objectiveTrajectory(okr: Okr, model: ReturnType<typeof timeline>) {
  const ids = new Set(okr.keyResults.map(kr => kr.kpiId));
  const rows = model.rows.filter(r => ids.has(r.k.id));
  if (!ids.size || rows.length !== ids.size || rows.some(r => !r.modeled || r.k.target === r.k.baseline)) return null;
  const value = (date: string) => okrPct(okr, rows.map(r => ({ ...r.k, current: r.value(date) })))!;
  // A KR stops contributing to the average's slope at 0% and 100%, even between ramp boundaries.
  const breaks = new Set(model.dates);
  for (const r of rows) {
    for (let i = 1; i < model.dates.length; i++) {
      const a = model.dates[i - 1]!, b = model.dates[i]!;
      const va = r.value(a), vb = r.value(b);
      for (const threshold of [r.k.baseline, r.k.target]) {
        if (threshold <= Math.min(va, vb) || threshold >= Math.max(va, vb)) continue;
        const day = dayOf(a) + (threshold - va) / (vb - va) * (dayOf(b) - dayOf(a));
        breaks.add(dateOf(Math.floor(day)));
        breaks.add(dateOf(Math.ceil(day)));
      }
    }
  }
  const knots = [...breaks].sort();
  const base = value(knots[0]!);
  return { value, improves: firstDay(knots, d => value(d) > base), reaches: firstDay(knots, d => value(d) >= 100) };
}
