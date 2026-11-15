export interface ImpactInputs {
  baselineBenefit: string;
  baselineCost: string;
  benefit: string;
  cost: string;
  investment: string;
  years: string;
}

export type ImpactResult =
  | { ok: false }
  | { ok: true; baselineAnnual: number; scenarioAnnual: number; annualChange: number; totalChange: number; paybackYears: number | null };

const MAX_YEN = 10_000_000_000_000;

/** Constant annual amounts; no inflation, discounting, tax, ramp-up or causal attribution is assumed. */
export function simulateTaskImpact(input: ImpactInputs): ImpactResult {
  const amount = (s: string) => {
    if (!/^\d+$/.test(s.trim())) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n <= MAX_YEN ? n : null;
  };
  const baselineBenefit = amount(input.baselineBenefit);
  const baselineCost = amount(input.baselineCost);
  const benefit = amount(input.benefit);
  const cost = amount(input.cost);
  const investment = amount(input.investment);
  const years = amount(input.years);
  if (baselineBenefit === null || baselineCost === null || benefit === null || cost === null || investment === null || years === null || years < 1 || years > 50) return { ok: false };
  const baselineAnnual = baselineBenefit - baselineCost;
  const scenarioAnnual = benefit - cost;
  const annualChange = scenarioAnnual - baselineAnnual;
  return {
    ok: true, baselineAnnual, scenarioAnnual, annualChange, totalChange: annualChange * years - investment,
    paybackYears: annualChange > 0 ? investment / annualChange : null,
  };
}
