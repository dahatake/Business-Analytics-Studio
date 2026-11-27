import type { CustomerPack, Entity, LText, OptimizationInput } from '../data/schema.ts';
import { EngagementsExtension, OkrExtension } from '../data/extensionSchemas.ts';
import { scaledDemand } from './optimize.ts';
import { ARCHETYPE_PROFILES, type Archetype, type Lens } from './resourceIndustry.ts';

/**
 * FR-326: one resource model for every industry. Resources (pools: people or sites) supply demand (work items or regions)
 * along links. Every number says where it comes from, so the screen never presents an assumption as a pack fact.
 */
export type Provenance = 'pack' | 'derived' | 'assumption' | 'simulation';
export interface Valued { value: number; provenance: Provenance }

export type DemandKind = 'region' | 'issue' | 'deal' | 'initiative' | 'engagement' | 'objective';

export interface Pool {
  id: string;
  entityId?: string;
  name: LText;
  /** Role or site type shown under the name. */
  group?: LText;
  capacity: Valued;
  off: boolean;
  /** Cost per unit drawn from the pool (network: production + carbon). People pools cost nothing per hour. */
  unitCost: number;
  /** Network only: production cost and CO2 per tonne (pack). */
  productionCost?: number;
  co2?: number;
  /** People only: closed engagements the person owned (history, a pack fact). */
  history?: number;
}

export interface Demand {
  id: string;
  kind: DemandKind;
  entityId?: string;
  name: LText;
  need: Valued;
  /** Value per unit served (people: priority points per hour). Network demand must be served (a large penalty). */
  value: Valued;
  off: boolean;
  /** Pool ids the pack names as owner. */
  owners: string[];
}

export interface Link {
  poolId: string;
  demandId: string;
  cost: number;
  owner: boolean;
  allowed: boolean;
  /** Network only: transport cost, CO2 per tonne and lead time (pack). */
  transport?: number;
  co2?: number;
  leadDays?: number;
}

export interface PeopleParams { hoursPerPerson: number; maxUtilization: number; effortBase: number; handover: number }
export interface NetworkParams { growth: number; carbon: number }

export interface ResourceModel {
  lens: Lens;
  unit: 'hours' | 'tonnes';
  pools: Pool[];
  demands: Demand[];
  links: Link[];
  /** Today's rule: for each demand, the share each pool takes (people: owners equally; network: today's allocation). */
  beforeShares: Record<string, { poolId: string; share: number }[]>;
}

export interface Flow { poolId: string; demandId: string; qty: number }

export const linkKey = (poolId: string, demandId: string) => `${poolId}|${demandId}`;

/** PARAM-166: engagement statuses that mean the work is finished (history, not open demand). */
const CLOSED_STATUS = /完了|実施済|終了|クローズ|振り返り|共有済|close|done|complete|retro|shared|finish|ended/i;

export function defaultPeopleParams(archetype: Archetype): PeopleParams {
  const p = ARCHETYPE_PROFILES[archetype];
  return { hoursPerPerson: p.hoursPerPersonMonth, maxUtilization: p.maxUtilization, effortBase: p.effortBaseHours, handover: 2 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Builders

/** Sites → regions from pack.optimization (all values are pack facts; demand growth and carbon price are scenario inputs). */
export function buildNetworkModel(input: OptimizationInput, regions: { id: string; name: LText }[], siteName: (id: string) => LText, params: NetworkParams): ResourceModel {
  const demand = scaledDemand(input, params.growth);
  const pools: Pool[] = input.plants.map((p) => ({
    id: `pool:${p.siteId}`, entityId: p.siteId, name: siteName(p.siteId),
    capacity: { value: p.capacityT, provenance: 'pack' }, off: false,
    unitCost: p.productionCostPerT + params.carbon * p.co2PerT, productionCost: p.productionCostPerT, co2: p.co2PerT,
  }));
  const maxUnit = Math.max(1, ...input.plants.flatMap((_, i) => demand.map((_, j) => pools[i]!.unitCost + input.transportCostPerT[i]![j]! + params.carbon * input.co2TransportPerT[i]![j]!)));
  // Serving demand must always beat leaving it unmet, so the solver serves everything capacity allows, then minimises cost.
  const mustServe = Math.ceil(maxUnit * 10);
  const demands: Demand[] = demand.map((d, j) => {
    const r = regions[j];
    return {
      id: `demand:${r?.id ?? j}`, kind: 'region', name: r?.name ?? { ja: `地域 ${j + 1}`, en: `Region ${j + 1}` },
      need: { value: d, provenance: params.growth === 0 ? 'pack' : 'derived' }, value: { value: mustServe, provenance: 'derived' }, off: false, owners: [],
    };
  });
  const links: Link[] = pools.flatMap((p, i) => demands.map((d, j) => ({
    poolId: p.id, demandId: d.id, owner: false, allowed: true,
    cost: input.transportCostPerT[i]![j]! + params.carbon * input.co2TransportPerT[i]![j]!,
    transport: input.transportCostPerT[i]![j]!, co2: input.co2TransportPerT[i]![j]!, leadDays: input.leadTimeDays[i]![j]!,
  })));
  const beforeShares: ResourceModel['beforeShares'] = {};
  demands.forEach((d, j) => {
    const col = input.currentAllocation.map((row) => row[j] ?? 0);
    const total = col.reduce((a, b) => a + b, 0);
    beforeShares[d.id] = total ? col.map((q, i) => ({ poolId: pools[i]!.id, share: q / total })).filter((s) => s.share > 0) : [];
  });
  return { lens: 'network', unit: 'tonnes', pools, demands, links, beforeShares };
}

type Localizable = string | { ja: string; en: string };
const toLText = (v: Localizable, fallback: string): LText => {
  if (typeof v === 'string') return { ja: v || fallback, en: v || fallback };
  return { ja: v.ja || v.en || fallback, en: v.en || v.ja || fallback };
};
const nameKey = (s: string) => s.replace(/[\s\u3000・,.()（）]/g, '').toLowerCase();

/**
 * People → work items from pack entities. Pack facts: who the people are, which work exists, impact × feasibility, deal
 * values, progress and owners. Assumptions (PARAM-164/165): hours per person, the utilization ceiling and the hours a work
 * item needs. Nothing is written back to the pack.
 */
export function buildPeopleModel(pack: CustomerPack, archetype: Archetype, params: PeopleParams, visible: (e: Entity) => boolean, includeInternalExtensions: boolean): ResourceModel {
  const byId = new Map(pack.entities.map((e) => [e.id, e]));
  const people = pack.entities.filter((e): e is Extract<Entity, { kind: 'person' }> => e.kind === 'person' && visible(e));
  const poolOf = (personId: string | undefined) => (personId && people.some((p) => p.id === personId) ? `pool:${personId}` : null);
  const byName = new Map<string, string>();
  people.forEach((p) => { byName.set(nameKey(p.name.ja), p.id); byName.set(nameKey(p.name.en), p.id); });
  const ownerByText = (text: string | undefined): string | null => {
    if (!text) return null;
    const key = nameKey(text);
    for (const [n, id] of byName) if (n && key.includes(n)) return `pool:${id}`;
    return null;
  };

  const capacity = Math.round(params.hoursPerPerson * params.maxUtilization);
  const history = new Map<string, number>();
  const engagements = includeInternalExtensions ? EngagementsExtension.safeParse(pack.extensions?.engagements) : null;
  const engagementItems = engagements?.success ? engagements.data.items : [];
  engagementItems.filter((i) => i.status && CLOSED_STATUS.test(i.status)).forEach((i) => {
    const owner = ownerByText(i.owner);
    if (owner) history.set(owner, (history.get(owner) ?? 0) + 1);
  });

  const pools: Pool[] = people.map((p) => ({
    id: `pool:${p.id}`, entityId: p.id, name: p.name, group: p.role,
    capacity: { value: capacity, provenance: 'assumption' }, off: false, unitCost: 0,
    history: history.get(`pool:${p.id}`) ?? 0,
  }));

  const demands: Demand[] = [];
  const effort = (impact: number) => Math.max(1, Math.round(params.effortBase * impact / 3));
  const uniq = (ids: (string | null)[]) => [...new Set(ids.filter((x): x is string => !!x))];

  const issues = pack.entities.filter((e): e is Extract<Entity, { kind: 'issue' }> => e.kind === 'issue' && visible(e));
  const solutions = pack.entities.filter((e): e is Extract<Entity, { kind: 'solution' }> => e.kind === 'solution');
  const initiatives = pack.entities.filter((e): e is Extract<Entity, { kind: 'initiative' }> => e.kind === 'initiative' && visible(e));
  const issueScore = new Map(issues.map((i) => [i.id, i.impact * i.feasibility]));
  for (const issue of issues) {
    const kpiOwners = issue.kpiIds.map((k) => { const kpi = byId.get(k); return kpi?.kind === 'kpi' ? poolOf(kpi.ownerId) : null; });
    const initiativeOwners = initiatives.filter((ini) => solutions.some((s) => s.id === ini.solutionId && s.issueIds.includes(issue.id))).map((ini) => poolOf(ini.ownerId));
    demands.push({
      id: `demand:${issue.id}`, kind: 'issue', entityId: issue.id, name: issue.name,
      need: { value: effort(issue.impact), provenance: 'assumption' },
      value: { value: issue.impact * issue.feasibility, provenance: 'derived' }, off: false,
      owners: uniq([...kpiOwners, ...initiativeOwners]),
    });
  }

  const openDeals = pack.entities.filter((e): e is Extract<Entity, { kind: 'deal' }> => e.kind === 'deal' && e.stage !== 'delivered' && visible(e));
  const sortedValues = openDeals.map((d) => d.valueJpy).sort((a, b) => a - b);
  for (const deal of openDeals) {
    // Value rank → 5..25 so deals sit on the same 1–25 scale as impact × feasibility.
    const rank = sortedValues.length > 1 ? sortedValues.indexOf(deal.valueJpy) / (sortedValues.length - 1) : 0.5;
    demands.push({
      id: `demand:${deal.id}`, kind: 'deal', entityId: deal.id, name: deal.name,
      need: { value: effort(3), provenance: 'assumption' },
      value: { value: Math.round(5 + rank * 20), provenance: 'derived' }, off: false, owners: uniq([poolOf(deal.ownerId)]),
    });
  }

  for (const ini of initiatives.filter((i) => i.progress < 1)) {
    const sol = solutions.find((s) => s.id === ini.solutionId);
    const score = Math.max(0, ...(sol?.issueIds ?? []).map((id) => issueScore.get(id) ?? 0));
    demands.push({
      id: `demand:${ini.id}`, kind: 'initiative', entityId: ini.id, name: ini.name,
      need: { value: Math.max(1, Math.round(effort(3) * (1 - ini.progress))), provenance: 'assumption' },
      value: score ? { value: score, provenance: 'derived' } : { value: 9, provenance: 'assumption' }, off: false, owners: uniq([poolOf(ini.ownerId)]),
    });
  }

  for (const item of engagementItems.filter((i) => !(i.status && CLOSED_STATUS.test(i.status)))) {
    demands.push({
      id: `demand:eng:${item.id}`, kind: 'engagement', name: toLText(item.name, item.id),
      need: { value: effort(3), provenance: 'assumption' }, value: { value: 9, provenance: 'assumption' }, off: false, owners: uniq([ownerByText(item.owner)]),
    });
  }

  if (!demands.length) {
    const okr = OkrExtension.safeParse(pack.extensions?.okr);
    for (const o of okr.success ? okr.data.objectives : []) {
      const owner = o.owner ? toLText(o.owner, '') : null;
      demands.push({
        id: `demand:okr:${o.id}`, kind: 'objective', name: toLText(o.objective, o.id),
        need: { value: effort(3), provenance: 'assumption' }, value: { value: 9, provenance: 'assumption' }, off: false,
        owners: uniq([ownerByText(owner?.ja), ownerByText(owner?.en)]),
      });
    }
  }

  const links: Link[] = pools.flatMap((p) => demands.map((d) => {
    const owner = d.owners.includes(p.id);
    return { poolId: p.id, demandId: d.id, owner, allowed: true, cost: owner ? 0 : params.handover };
  }));
  const beforeShares: ResourceModel['beforeShares'] = {};
  for (const d of demands) beforeShares[d.id] = d.owners.map((poolId) => ({ poolId, share: 1 / d.owners.length }));
  void archetype;
  return { lens: 'people', unit: 'hours', pools, demands, links, beforeShares };
}

// ---------------------------------------------------------------------------------------------------------------------
// Simulation edits

export interface Overrides {
  pools: Record<string, { capacity?: number; off?: boolean }>;
  demands: Record<string, { need?: number; value?: number; off?: boolean }>;
  /** linkKey → allowed. */
  links: Record<string, boolean>;
}
export const emptyOverrides = (): Overrides => ({ pools: {}, demands: {}, links: {} });

export function applyOverrides(model: ResourceModel, ov: Overrides): ResourceModel {
  const sim = (v: number): Valued => ({ value: Math.max(0, Math.round(v)), provenance: 'simulation' });
  return {
    ...model,
    pools: model.pools.map((p) => {
      const o = ov.pools[p.id];
      return o ? { ...p, ...(o.capacity !== undefined ? { capacity: sim(o.capacity) } : {}), off: o.off ?? p.off } : p;
    }),
    demands: model.demands.map((d) => {
      const o = ov.demands[d.id];
      return o ? { ...d, ...(o.need !== undefined ? { need: sim(o.need) } : {}), ...(o.value !== undefined ? { value: { value: o.value, provenance: 'simulation' as const } } : {}), off: o.off ?? d.off } : d;
    }),
    links: model.links.map((l) => {
      const allowed = ov.links[linkKey(l.poolId, l.demandId)];
      return allowed === undefined ? l : { ...l, allowed };
    }),
  };
}

export function countOverrides(ov: Overrides): number {
  return Object.keys(ov.pools).length + Object.keys(ov.demands).length + Object.keys(ov.links).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Today's assignment and the optimum

const capOf = (p: Pool) => (p.off ? 0 : Math.max(0, Math.round(p.capacity.value)));
const needOf = (d: Demand) => (d.off ? 0 : Math.max(0, Math.round(d.need.value)));

/** Today's rule applied to the (edited) scenario. It ignores capacity on purpose: overload is what today looks like. */
export function currentFlows(model: ResourceModel): Flow[] {
  const pools = new Map(model.pools.map((p) => [p.id, p]));
  const allowed = new Set(model.links.filter((l) => l.allowed).map((l) => linkKey(l.poolId, l.demandId)));
  const flows: Flow[] = [];
  for (const d of model.demands) {
    const need = needOf(d);
    const shares = (model.beforeShares[d.id] ?? []).filter((s) => !pools.get(s.poolId)?.off && allowed.has(linkKey(s.poolId, d.id)));
    if (!need || !shares.length) continue;
    let assigned = 0;
    let largest = 0;
    const qty = shares.map((s, k) => {
      const q = Math.floor(s.share * need);
      assigned += q;
      if (s.share > shares[largest]!.share) largest = k;
      return q;
    });
    // Shares of pools that are switched off stay unserved; rounding goes to the largest remaining share.
    const activeShare = shares.reduce((a, s) => a + s.share, 0);
    const target = Math.round(need * Math.min(1, activeShare));
    qty[largest]! += Math.max(0, target - assigned);
    shares.forEach((s, k) => { if (qty[k]) flows.push({ poolId: s.poolId, demandId: d.id, qty: qty[k]! }); });
  }
  return flows;
}

/**
 * Exact optimum: min-cost flow with successive shortest paths (SPFA, negative arc costs allowed). Source → pool (capacity,
 * pool unit cost) → demand (allowed links, link cost) → sink (need, −value). Augmenting stops when no path earns more than
 * it costs, so demand that cannot be served profitably — or at all — stays unmet instead of making the problem infeasible.
 */
export function optimalFlows(model: ResourceModel, capacityBump?: { poolId: string; delta: number }): Flow[] {
  const P = model.pools.length, D = model.demands.length;
  const N = P + D + 2, S = 0, T = N - 1;
  interface Arc { to: number; cap: number; cost: number; rev: number }
  const g: Arc[][] = Array.from({ length: N }, () => []);
  const add = (u: number, v: number, cap: number, cost: number) => {
    g[u]!.push({ to: v, cap, cost, rev: g[v]!.length });
    g[v]!.push({ to: u, cap: 0, cost: -cost, rev: g[u]!.length - 1 });
  };
  const pIndex = new Map(model.pools.map((p, i) => [p.id, i]));
  const dIndex = new Map(model.demands.map((d, j) => [d.id, j]));
  model.pools.forEach((p, i) => {
    const cap = capOf(p) + (capacityBump?.poolId === p.id ? capacityBump.delta : 0);
    if (cap > 0) add(S, 1 + i, cap, p.unitCost);
  });
  const linkArcs: { i: number; j: number; arc: number }[] = [];
  for (const l of model.links) {
    if (!l.allowed) continue;
    const i = pIndex.get(l.poolId), j = dIndex.get(l.demandId);
    if (i === undefined || j === undefined) continue;
    const need = needOf(model.demands[j]!);
    if (!need) continue;
    linkArcs.push({ i, j, arc: g[1 + i]!.length });
    add(1 + i, 1 + P + j, need, l.cost);
  }
  model.demands.forEach((d, j) => { const need = needOf(d); if (need) add(1 + P + j, T, need, -d.value.value); });

  const dist = new Array<number>(N);
  const inQueue = new Array<boolean>(N);
  const prevNode = new Array<number>(N);
  const prevArc = new Array<number>(N);
  for (;;) {
    dist.fill(Infinity); inQueue.fill(false); prevNode.fill(-1);
    dist[S] = 0;
    const queue = [S];
    inQueue[S] = true;
    while (queue.length) {
      const u = queue.shift()!;
      inQueue[u] = false;
      g[u]!.forEach((a, k) => {
        if (a.cap > 0 && dist[u]! + a.cost < dist[a.to]! - 1e-9) {
          dist[a.to] = dist[u]! + a.cost;
          prevNode[a.to] = u;
          prevArc[a.to] = k;
          if (!inQueue[a.to]) { inQueue[a.to] = true; queue.push(a.to); }
        }
      });
    }
    if (!(dist[T]! < -1e-9)) break;
    let push = Infinity;
    for (let v = T; v !== S; v = prevNode[v]!) push = Math.min(push, g[prevNode[v]!]![prevArc[v]!]!.cap);
    for (let v = T; v !== S; v = prevNode[v]!) {
      const a = g[prevNode[v]!]![prevArc[v]!]!;
      a.cap -= push;
      g[v]![a.rev]!.cap += push;
    }
  }
  return linkArcs.flatMap(({ i, j, arc }) => {
    const a = g[1 + i]![arc]!;
    const qty = g[a.to]![a.rev]!.cap;
    return qty > 0 ? [{ poolId: model.pools[i]!.id, demandId: model.demands[j]!.id, qty }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Metrics

export interface ResourceMetrics {
  need: number;
  served: number;
  servedPct: number;
  /** People: share of priority-weighted need that is served (Σ served×value / Σ need×value). */
  weightedPct: number;
  load: Record<string, number>;
  served_: Record<string, number>;
  utilization: Record<string, number>;
  overloaded: number;
  avgUtilization: number;
  /** Σ flow × (pool cost + link cost) − Σ served × value. Lower is better; equals the solver's objective. */
  objective: number;
  /** Network only (pack units): production + transport cost in JPY, CO2 in t, volume-weighted lead time in days. */
  costJpy?: number;
  co2T?: number;
  avgLeadDays?: number;
}

export function measureFlows(model: ResourceModel, flows: Flow[]): ResourceMetrics {
  const load: Record<string, number> = Object.fromEntries(model.pools.map((p) => [p.id, 0]));
  const served: Record<string, number> = Object.fromEntries(model.demands.map((d) => [d.id, 0]));
  const pools = new Map(model.pools.map((p) => [p.id, p]));
  const demands = new Map(model.demands.map((d) => [d.id, d]));
  const links = new Map(model.links.map((l) => [linkKey(l.poolId, l.demandId), l]));
  let objective = 0, costJpy = 0, co2T = 0, leadWeighted = 0;
  for (const f of flows) {
    load[f.poolId] = (load[f.poolId] ?? 0) + f.qty;
    served[f.demandId] = (served[f.demandId] ?? 0) + f.qty;
    const p = pools.get(f.poolId)!, l = links.get(linkKey(f.poolId, f.demandId));
    objective += f.qty * (p.unitCost + (l?.cost ?? 0));
    if (model.lens === 'network') {
      costJpy += f.qty * ((p.productionCost ?? 0) + (l?.transport ?? 0));
      co2T += f.qty * ((p.co2 ?? 0) + (l?.co2 ?? 0));
      leadWeighted += f.qty * (l?.leadDays ?? 0);
    }
  }
  let need = 0, servedTotal = 0, weightedNeed = 0, weightedServed = 0;
  // Hours or tonnes above a pool's capacity cannot actually be delivered: today's overloaded plan counts only its
  // capacity-scaled share as served, so the current state is never shown better than it is.
  const deliverable: Record<string, number> = Object.fromEntries(model.demands.map((d) => [d.id, 0]));
  for (const f of flows) {
    const cap = capOf(pools.get(f.poolId)!);
    const l = load[f.poolId]!;
    deliverable[f.demandId]! += l > cap ? (f.qty * cap) / l : f.qty;
  }
  for (const d of model.demands) {
    const n = needOf(d);
    const s = Math.min(n, deliverable[d.id] ?? 0);
    need += n; servedTotal += s;
    weightedNeed += n * d.value.value; weightedServed += s * d.value.value;
    objective -= (served[d.id] ?? 0) * demands.get(d.id)!.value.value;
  }
  const utilization: Record<string, number> = {};
  let overloaded = 0, utilSum = 0, active = 0;
  for (const p of model.pools) {
    const cap = capOf(p);
    const u = cap ? load[p.id]! / cap : load[p.id]! > 0 ? Infinity : 0;
    utilization[p.id] = u;
    if (u > 1 + 1e-9) overloaded++;
    if (cap) { utilSum += Math.min(u, 2); active++; }
  }
  return {
    need, served: servedTotal, servedPct: need ? servedTotal / need : 1, weightedPct: weightedNeed ? weightedServed / weightedNeed : 1,
    load, served_: served, utilization, overloaded, avgUtilization: active ? utilSum / active : 0, objective,
    ...(model.lens === 'network' ? { costJpy, co2T, avgLeadDays: servedTotal ? leadWeighted / servedTotal : 0 } : {}),
  };
}

export interface Marginal { poolId: string; delta: number; servedPerUnit: number; objectivePerUnit: number }

/**
 * Shadow price per pool: re-solve with slightly more capacity (PARAM-167: 5%, at least one unit). Only pools the optimum
 * uses to the full can have a non-zero value (an unused capacity constraint has dual zero), so only those are re-solved.
 */
export function marginals(model: ResourceModel, after: ResourceMetrics): Marginal[] {
  const out: Marginal[] = [];
  for (const p of model.pools) {
    const cap = capOf(p);
    if (!cap || (after.load[p.id] ?? 0) < cap) continue;
    const delta = Math.max(1, Math.round(cap * 0.05));
    const m = measureFlows(model, optimalFlows(model, { poolId: p.id, delta }));
    // Re-measure against the bumped capacity is unnecessary: objective and served do not depend on capacity.
    const servedPerUnit = (m.served - after.served) / delta;
    const objectivePerUnit = (after.objective - m.objective) / delta;
    if (servedPerUnit > 1e-9 || objectivePerUnit > 1e-9) out.push({ poolId: p.id, delta, servedPerUnit, objectivePerUnit });
  }
  return out.sort((a, b) => b.servedPerUnit - a.servedPerUnit || b.objectivePerUnit - a.objectivePerUnit);
}

export interface Scenario {
  model: ResourceModel;
  before: Flow[];
  after: Flow[];
  beforeMetrics: ResourceMetrics;
  afterMetrics: ResourceMetrics;
  marginals: Marginal[];
}

export function transitionFlows(s: Pick<Scenario, 'before' | 'after'>, share: number): Flow[] {
  if (share === 0) return s.before;
  if (share === 1) return s.after;
  const flows = new Map<string, Flow>();
  for (const [list, weight] of [[s.before, 1 - share], [s.after, share]] as const) {
    for (const f of list) {
      const key = linkKey(f.poolId, f.demandId);
      flows.set(key, { ...f, qty: (flows.get(key)?.qty ?? 0) + f.qty * weight });
    }
  }
  return [...flows.values()];
}

export function runScenario(model: ResourceModel): Scenario {
  const before = currentFlows(model);
  const after = optimalFlows(model);
  const afterMetrics = measureFlows(model, after);
  return { model, before, after, beforeMetrics: measureFlows(model, before), afterMetrics, marginals: marginals(model, afterMetrics) };
}
