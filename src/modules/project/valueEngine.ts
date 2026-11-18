/**
 * FR-327: the value engine — from each solution's benefit lines to the portfolio's net present value.
 *
 * Method (docs/business-value-audit.md):
 * - Value drivers follow the ROIC/growth driver tree (Koller, Goedhart & Wessels, *Valuation*): revenue, cost, capital
 *   (one-off cash released from working capital or avoided capex), risk (expected loss avoided) and options. Dis-benefits
 *   (running costs, transition losses) are negative lines, not a footnote.
 * - Only `financial` lines (Ward & Daniel's benefit classification) carry yen. `conversion` is the share of the gross
 *   amount that becomes cash (time saved is not cash until it is redeployed or removed).
 * - Interdependencies (benefits dependency network, Ward, Daniel & Peppard 2008): `enables` (no benefit without the
 *   enabler), `synergy` (+share of benefits), `overlap` (−share: double counting), `sharedCost` (−share of the cost).
 *   A solution's marginal value in the portfolio therefore differs from its standalone value.
 * - Discounted cash flow over a horizon; benefits ramp linearly after the build period (as in `paybackYears`).
 * - Seeded Monte Carlo over triangular ranges, a one-at-a-time tornado, and Flyvbjerg & Budzier's (HBR 2011)
 *   black-swan stress test: the largest project overruns its cost by 400% and only part of the benefits arrive.
 *
 * `valueEngine` must stay self-contained (no imports, no module-level helpers): the exported HTML embeds its source
 * with `String(valueEngine)` so the file recomputes exactly what the app shows (checked in tests and E2E).
 */

export interface EngineRange {
  low: number;
  mode: number;
  high: number;
}

export type EngineLever = 'revenue' | 'cost' | 'capital' | 'risk' | 'option' | 'unclassified';
export type EngineLinkKind = 'enables' | 'synergy' | 'overlap' | 'sharedCost';

export interface EngineSolution {
  id: string;
  cost: EngineRange;
  /** Years from the start of the first initiative to the end of the last (0 = benefits start in year 1). */
  buildYears: number;
}

export interface EngineLine {
  id: string;
  solutionId: string;
  lever: EngineLever;
  /** Only monetized (financial) lines enter the NPV. */
  monetized: boolean;
  /** One-off cash (e.g. working capital released) instead of an annual amount. */
  oneOff: boolean;
  /** 1 = benefit, -1 = dis-benefit. */
  sign: 1 | -1;
  amount: EngineRange;
  /** Share of the amount that becomes cash, 0..1. */
  conversion: EngineRange;
}

export interface EngineLink {
  kind: EngineLinkKind;
  from: string;
  to: string;
  share: number;
}

export interface EngineModel {
  solutions: EngineSolution[];
  lines: EngineLine[];
  links: EngineLink[];
  selected: string[];
  discountRate: number;
  horizonYears: number;
  runs: number;
  seed: number;
  /** Tornado: ± this many points of discount rate. */
  rateSwing: number;
  /** Black-swan stress: cost multiplier of the largest selected solution and the share of benefits that arrive. */
  stress: { costFactor: number; benefitFactor: number };
  /**
   * Correlation groups (one-factor Gaussian copula per group): the amount and conversion of lines in a group share a
   * common factor, so two lines that share only group k have rank-normal correlation `rho`. A line may be in several
   * groups; their rho values are scaled down when they add up to more than 1. Absent = independent.
   */
  groups?: { id: string; rho: number; lineIds: string[] }[];
  /** Reference-class correction: multiplier on positive monetized benefits (realised ÷ planned so far). Default 1. */
  realization?: number;
}

export interface TornadoBar {
  id: string;
  kind: 'amount' | 'conversion' | 'cost' | 'rate';
  /** Line id (amount/conversion), solution id (cost) or '' (rate). */
  ref: string;
  /** NPV with the input at its low and high end, everything else at its mode. */
  atLow: number;
  atHigh: number;
  swing: number;
}

export interface EngineResult {
  runs: number;
  npv: { mean: number; p10: number; p50: number; p90: number; mode: number; pPositive: number };
  hist: { lo: number; hi: number; counts: number[] };
  /** Present value by driver at the mode; `investment` and `disbenefit` are negative. Sums to `npv.mode`. */
  levers: Record<string, number>;
  solutions: { id: string; selected: boolean; pv: number; standalone: number; marginal: number; enabled: boolean }[];
  tornado: TornadoBar[];
  stress: { solutionId: string; npv: number } | null;
  /** Discounted payback in years at the mode, null when not reached within the horizon. */
  payback: number | null;
  /** Internal rate of return of the most likely cash flows (the discount rate at which NPV = 0); null when none. */
  irr: number | null;
  /** Present value of each monetized line at the mode (dis-benefits negative); sums by driver to levers. */
  linePv: Record<string, number>;
}

export function valueEngine(m: EngineModel): EngineResult {
  const mulberry = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const tri = (r: EngineRange, u: number) => {
    const a = r.low;
    const c = r.mode;
    const b = r.high;
    if (b === a) return a;
    const f = (c - a) / (b - a);
    return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
  };
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const H = Math.max(1, Math.min(50, Math.round(m.horizonYears)));
  const sols = m.solutions;
  const solIds: Record<string, boolean> = {};
  for (const s of sols) solIds[s.id] = true;
  const lines = m.lines.filter((l) => l.monetized && solIds[l.solutionId]);
  const links = m.links.filter((k) => solIds[k.from] && solIds[k.to] && k.from !== k.to);
  const linesOf: Record<string, number[]> = {};
  lines.forEach((l, i) => { (linesOf[l.solutionId] = linesOf[l.solutionId] || []).push(i); });

  /** Ramp share in year t, discount factor, and the year a one-off amount lands (first year with any benefit). */
  const factorCache: Record<string, { annual: number; oneOff: number; first: number }> = {};
  const factors = (rate: number, build: number) => {
    const key = `${rate}|${build}`;
    const hit = factorCache[key];
    if (hit) return hit;
    let annual = 0;
    let oneOff = 0;
    let first = 0;
    for (let t = 1; t <= H; t += 1) {
      const share = clamp01(t - build);
      const d = 1 / Math.pow(1 + rate, t);
      annual += share * d;
      if (!first && share > 0) { first = t; oneOff = d; }
    }
    const out = { annual, oneOff, first };
    factorCache[key] = out;
    return out;
  };

  interface Picker { amount: (i: number) => number; conv: (i: number) => number; cost: (s: EngineSolution) => number }
  interface Detail { levers: Record<string, number>; pv: Record<string, number>; enabled: Record<string, boolean>; flows: number[]; cash: number[]; linePv: Record<string, number> }
  const realization = m.realization === undefined || !Number.isFinite(m.realization) ? 1 : Math.max(0, m.realization);

  const evaluate = (sel: Record<string, boolean>, pick: Picker, rate: number, stressId: string | null, out: Detail | null) => {
    let npv = 0;
    for (const s of sols) {
      if (!sel[s.id]) continue;
      let cost = pick.cost(s);
      if (stressId === s.id) cost *= m.stress.costFactor;
      let mult = 1;
      let enabled = true;
      for (const k of links) {
        if (k.to !== s.id) continue;
        if (!sel[k.from]) { if (k.kind === 'enables') enabled = false; continue; }
        if (k.kind === 'synergy') mult *= 1 + k.share;
        else if (k.kind === 'overlap') mult *= 1 - k.share;
        else if (k.kind === 'sharedCost') cost *= 1 - k.share;
      }
      const f = factors(rate, Math.max(0, s.buildYears));
      let pv = -cost;
      if (out) {
        out.levers.investment = (out.levers.investment || 0) - cost;
        out.flows[0] = (out.flows[0] || 0) - cost;
        out.cash[0] = (out.cash[0] || 0) - cost;
        out.enabled[s.id] = enabled;
      }
      if (enabled) {
        for (const i of linesOf[s.id] || []) {
          const l = lines[i]!;
          let v = pick.amount(i) * clamp01(pick.conv(i));
          v = l.sign > 0 ? v * mult * realization * (stressId ? m.stress.benefitFactor : 1) : -v;
          const p = v * (l.oneOff ? f.oneOff : f.annual);
          pv += p;
          if (out) {
            const key = l.sign > 0 ? l.lever : 'disbenefit';
            out.levers[key] = (out.levers[key] || 0) + p;
            out.linePv[l.id] = p;
            for (let t = 1; t <= H; t += 1) {
              const d = 1 / Math.pow(1 + rate, t);
              const share = l.oneOff ? (t === f.first ? 1 : 0) : clamp01(t - Math.max(0, s.buildYears));
              out.flows[t] = (out.flows[t] || 0) + v * share * d;
              out.cash[t] = (out.cash[t] || 0) + v * share;
            }
          }
        }
      }
      if (out) out.pv[s.id] = pv;
      npv += pv;
    }
    return npv;
  };

  const modePick: Picker = { amount: (i) => lines[i]!.amount.mode, conv: (i) => lines[i]!.conversion.mode, cost: (s) => s.cost.mode };
  const selected: Record<string, boolean> = {};
  for (const id of m.selected) if (solIds[id]) selected[id] = true;
  const rate = Math.max(0, m.discountRate);

  // Mode (most likely) evaluation with the breakdown by driver and the yearly discounted flows.
  const detail: Detail = { levers: {}, pv: {}, enabled: {}, flows: [], cash: [], linePv: {} };
  const modeNpv = evaluate(selected, modePick, rate, null, detail);
  let payback: number | null = null;
  let cum = 0;
  for (let t = 0; t <= H; t += 1) {
    const flow = detail.flows[t] || 0;
    const next = cum + flow;
    if (t > 0 && cum < 0 && next >= 0 && flow > 0) { payback = t - 1 + -cum / flow; break; }
    cum = next;
  }
  // IRR by bisection on the most likely (undiscounted) cash flows.
  const npvAt = (r: number) => {
    let s = 0;
    for (let t = 0; t <= H; t += 1) s += (detail.cash[t] || 0) / Math.pow(1 + r, t);
    return s;
  };
  let irr: number | null = null;
  {
    let a = -0.99;
    let b = 100;
    let fa = npvAt(a);
    const fb = npvAt(b);
    if (Number.isFinite(fa) && Number.isFinite(fb) && fa * fb < 0) {
      for (let k = 0; k < 200; k += 1) {
        const mid = (a + b) / 2;
        const fm = npvAt(mid);
        if (fa * fm <= 0) b = mid; else { a = mid; fa = fm; }
      }
      irr = (a + b) / 2;
    }
  }

  // Monte Carlo. Lines in correlation groups draw through a Gaussian copula; the others keep plain uniforms.
  const runs = Math.max(1, Math.round(m.runs));
  const rnd = mulberry(m.seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const phi = (x: number) => {
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    const p = 0.5 * (1 + (x < 0 ? -erf : erf));
    return Math.min(1 - 1e-12, Math.max(1e-12, p));
  };
  const groups = (m.groups || []).filter((g) => g.rho > 0 && g.lineIds.length > 0);
  const loads: { g: number; w: number }[][] = lines.map((l) => {
    const mine = groups.map((g, gi) => ({ gi, rho: Math.min(1, g.rho) })).filter((x) => groups[x.gi]!.lineIds.indexOf(l.id) >= 0);
    const total = mine.reduce((a, x) => a + x.rho, 0);
    const scale = total > 1 ? 1 / total : 1;
    return mine.map((x) => ({ g: x.gi, w: Math.sqrt(x.rho * scale) }));
  });
  const idio = loads.map((ls) => Math.sqrt(Math.max(0, 1 - ls.reduce((a, x) => a + x.w * x.w, 0))));
  const factors0 = new Array<number>(groups.length).fill(0);
  const latent = (i: number) => {
    let x = idio[i]! * normal();
    for (const k of loads[i]!) x += k.w * factors0[k.g]!;
    return phi(x);
  };
  const amounts = new Array<number>(lines.length).fill(0);
  const convs = new Array<number>(lines.length).fill(0);
  const costs: Record<string, number> = {};
  const samplePick: Picker = { amount: (i) => amounts[i]!, conv: (i) => convs[i]!, cost: (s) => costs[s.id]! };
  const values: number[] = [];
  let sum = 0;
  let positive = 0;
  for (let n = 0; n < runs; n += 1) {
    for (let g = 0; g < groups.length; g += 1) factors0[g] = normal();
    for (let i = 0; i < lines.length; i += 1) {
      if (loads[i]!.length) {
        amounts[i] = tri(lines[i]!.amount, latent(i));
        convs[i] = tri(lines[i]!.conversion, latent(i));
      } else {
        amounts[i] = tri(lines[i]!.amount, rnd());
        convs[i] = tri(lines[i]!.conversion, rnd());
      }
    }
    for (const s of sols) costs[s.id] = tri(s.cost, rnd());
    const v = evaluate(selected, samplePick, rate, null, null);
    values.push(v);
    sum += v;
    if (v > 0) positive += 1;
  }
  values.sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (values.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return values[lo]! + (values[hi]! - values[lo]!) * (i - lo);
  };
  const BINS = 20;
  const lo = values[0]!;
  const hi = values[values.length - 1]!;
  const counts = new Array<number>(hi > lo ? BINS : 1).fill(0);
  for (const v of values) {
    const b = hi > lo ? Math.min(BINS - 1, Math.floor(((v - lo) / (hi - lo)) * BINS)) : 0;
    counts[b] = counts[b]! + 1;
  }

  // Standalone and marginal value: the gap between them is what the interdependencies are worth.
  const solutions = sols.map((s) => {
    const alone: Record<string, boolean> = {};
    alone[s.id] = true;
    const standalone = evaluate(alone, modePick, rate, null, null);
    const other: Record<string, boolean> = {};
    for (const id in selected) if (id !== s.id) other[id] = true;
    if (!selected[s.id]) other[s.id] = true;
    const withOther = evaluate(other, modePick, rate, null, null);
    const marginal = selected[s.id] ? modeNpv - withOther : withOther - modeNpv;
    return { id: s.id, selected: Boolean(selected[s.id]), pv: detail.pv[s.id] ?? 0, standalone, marginal, enabled: detail.enabled[s.id] ?? true };
  });

  // Tornado: one input at a time at its low and high end.
  const tornado: TornadoBar[] = [];
  const at = (override: Partial<Picker>, r: number) => evaluate(selected, { ...modePick, ...override }, r, null, null);
  lines.forEach((l, i) => {
    if (!selected[l.solutionId]) return;
    if (l.amount.high > l.amount.low) {
      const a = at({ amount: (j) => (j === i ? l.amount.low : lines[j]!.amount.mode) }, rate);
      const b = at({ amount: (j) => (j === i ? l.amount.high : lines[j]!.amount.mode) }, rate);
      tornado.push({ id: `amount:${l.id}`, kind: 'amount', ref: l.id, atLow: a, atHigh: b, swing: Math.abs(b - a) });
    }
    if (l.conversion.high > l.conversion.low) {
      const a = at({ conv: (j) => (j === i ? l.conversion.low : lines[j]!.conversion.mode) }, rate);
      const b = at({ conv: (j) => (j === i ? l.conversion.high : lines[j]!.conversion.mode) }, rate);
      tornado.push({ id: `conversion:${l.id}`, kind: 'conversion', ref: l.id, atLow: a, atHigh: b, swing: Math.abs(b - a) });
    }
  });
  for (const s of sols) {
    if (!selected[s.id] || !(s.cost.high > s.cost.low)) continue;
    const a = at({ cost: (x) => (x.id === s.id ? s.cost.low : x.cost.mode) }, rate);
    const b = at({ cost: (x) => (x.id === s.id ? s.cost.high : x.cost.mode) }, rate);
    tornado.push({ id: `cost:${s.id}`, kind: 'cost', ref: s.id, atLow: a, atHigh: b, swing: Math.abs(b - a) });
  }
  if (m.rateSwing > 0 && sols.some((s) => selected[s.id])) {
    const a = at({}, Math.max(0, rate - m.rateSwing));
    const b = at({}, rate + m.rateSwing);
    tornado.push({ id: 'rate', kind: 'rate', ref: '', atLow: a, atHigh: b, swing: Math.abs(b - a) });
  }
  tornado.sort((x, y) => y.swing - x.swing || (x.id < y.id ? -1 : 1));

  // Black swan on the largest selected solution.
  let largest: EngineSolution | null = null;
  for (const s of sols) if (selected[s.id] && (!largest || s.cost.mode > largest.cost.mode)) largest = s;
  const stress = largest ? { solutionId: largest.id, npv: evaluate(selected, modePick, rate, largest.id, null) } : null;

  return {
    runs,
    npv: { mean: sum / runs, p10: q(0.1), p50: q(0.5), p90: q(0.9), mode: modeNpv, pPositive: positive / runs },
    hist: { lo, hi, counts },
    levers: detail.levers,
    solutions,
    tornado: tornado.filter((b) => b.swing > 0).slice(0, 12),
    stress,
    payback,
    irr,
    linePv: detail.linePv,
  };
}
