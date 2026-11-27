/**
 * FR-378: the what-if of the KPI/OKR step — is the target realistic, and what does a change of target, deadline, effect
 * or start do to it? Required pace = remaining gap ÷ months left (Viva Goals compares expected with actual progress the
 * same way); with contribution estimates, the share of Monte Carlo runs that reach the target (simulate.ts).
 */
import { simulate, type ContributionInput } from './simulate.ts';

export interface KpiLever {
  /** Change of the target as a share of the baseline→target distance (−0.5 … +0.5). */
  stretch: number;
  /** Months added to the deadline (negative = earlier). */
  deadlineMonths: number;
  /** Multiplier on the estimated effect per lever unit. */
  effect: number;
  /** Months the contributions start later. */
  delayMonths: number;
}
export const BASE_KPI_LEVER: KpiLever = { stretch: 0, deadlineMonths: 0, effect: 1, delayMonths: 0 };

export interface KpiInput { id: string; baseline: number; current: number; target: number; deadline: string }

export interface KpiWhatIfRow {
  id: string;
  target: number;
  deadline: string;
  monthsLeft: number;
  /** Remaining distance to the target, in KPI units towards the target (≤ 0 = reached). */
  gap: number;
  /** Required improvement per month; null when the deadline has passed with a gap left, 0 when reached. */
  pace: number | null;
  /** Required pace as a share of the baseline→target distance per month: comparable across KPIs with different units. */
  monthlyShare: number | null;
  /** Share of the baseline→target distance already achieved. */
  progress: number;
  /** Share of simulation runs reaching the target; undefined without contribution estimates. */
  probability?: number;
}

export function addMonths(iso: string, months: number): string {
  if (!months) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return iso;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Math.round(months));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

const monthsBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (30.4375 * 86_400_000);

export function scenarioInputs<K extends KpiInput>(kpis: K[], contributions: ContributionInput[], lever: KpiLever) {
  const moved = kpis.map((k) => ({
    ...k,
    target: k.target + lever.stretch * (k.target - k.baseline),
    deadline: addMonths(k.deadline, lever.deadlineMonths),
  }));
  const contrib = contributions.map((c) => ({
    ...c,
    effectPerUnit: { low: c.effectPerUnit.low * lever.effect, mode: c.effectPerUnit.mode * lever.effect, high: c.effectPerUnit.high * lever.effect },
    rampStart: addMonths(c.rampStart, lever.delayMonths),
    fullEffect: addMonths(c.fullEffect, lever.delayMonths),
  }));
  return { moved, contrib };
}

export function kpiWhatIf(kpis: KpiInput[], contributions: ContributionInput[], today: string, lever: KpiLever): KpiWhatIfRow[] {
  const { moved, contrib } = scenarioInputs(kpis, contributions, lever);
  const sims = new Map(simulate(moved, contrib).map((s) => [s.kpiId, s]));
  return moved.map((k) => {
    const dir = Math.sign(k.target - k.baseline) || 1;
    const gap = (k.target - k.current) * dir;
    const monthsLeft = monthsBetween(today, k.deadline);
    const span = (k.target - k.baseline) * dir;
    const pace = gap <= 0 ? 0 : monthsLeft > 0 ? gap / monthsLeft : null;
    const sim = sims.get(k.id);
    return {
      id: k.id, target: k.target, deadline: k.deadline, monthsLeft, gap, pace,
      monthlyShare: pace === null ? null : span > 0 ? pace / span : 0,
      progress: span > 0 ? ((k.current - k.baseline) * dir) / span : 1,
      ...(sim ? { probability: sim.probability } : {}),
    };
  });
}
