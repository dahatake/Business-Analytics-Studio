import type { OptimizationInput } from '../data/schema.ts';

export interface OptimizationOptions {
  /** Demand growth applied to every region, e.g. 0.05 = +5%. */
  demandGrowth: number;
  /** Internal carbon price, JPY per t-CO2, added to the objective. */
  carbonPriceJpyPerT: number;
}

export type Allocation = number[][];

export interface AllocationMetrics {
  productionCostJpy: number;
  transportCostJpy: number;
  totalCostJpy: number;
  co2T: number;
  avgLeadTimeDays: number;
  shippedT: number;
  plantLoadT: number[];
  utilization: number[];
}

export type OptimizationResult =
  | {
    feasible: true;
    demandT: number[];
    before: Allocation;
    after: Allocation;
    beforeMetrics: AllocationMetrics;
    afterMetrics: AllocationMetrics;
    beforeOverCapacity: boolean;
  }
  | { feasible: false; demandT: number[]; totalDemandT: number; totalCapacityT: number };

export function scaledDemand(input: OptimizationInput, growth: number): number[] {
  return input.regionDemandT.map((d) => Math.round(d * (1 + growth)));
}

export function unitCost(input: OptimizationInput, i: number, j: number, carbonPrice: number): number {
  const plant = input.plants[i]!;
  const co2 = plant.co2PerT + input.co2TransportPerT[i]![j]!;
  return plant.productionCostPerT + input.transportCostPerT[i]![j]! + carbonPrice * co2;
}

export function measure(input: OptimizationInput, x: Allocation): AllocationMetrics {
  let production = 0, transport = 0, co2 = 0, leadWeighted = 0, shipped = 0;
  const plantLoadT = input.plants.map(() => 0);
  x.forEach((row, i) => row.forEach((q, j) => {
    const plant = input.plants[i]!;
    production += q * plant.productionCostPerT;
    transport += q * input.transportCostPerT[i]![j]!;
    co2 += q * (plant.co2PerT + input.co2TransportPerT[i]![j]!);
    leadWeighted += q * input.leadTimeDays[i]![j]!;
    shipped += q;
    plantLoadT[i]! += q;
  }));
  return {
    productionCostJpy: production,
    transportCostJpy: transport,
    totalCostJpy: production + transport,
    co2T: co2,
    avgLeadTimeDays: shipped ? leadWeighted / shipped : 0,
    shippedT: shipped,
    plantLoadT,
    utilization: plantLoadT.map((load, i) => load / input.plants[i]!.capacityT),
  };
}

/** Today's policy applied to the scaled demand: keep each region's plant shares, fix rounding on the largest share. */
export function scaleCurrentPolicy(input: OptimizationInput, demand: number[]): Allocation {
  const x = input.currentAllocation.map((row) => row.map(() => 0));
  demand.forEach((d, j) => {
    const base = input.regionDemandT[j]!;
    const shares = input.currentAllocation.map((row) => row[j]!);
    if (base === 0) return;
    let assigned = 0;
    let largest = 0;
    shares.forEach((s, i) => {
      const q = Math.floor((s * d) / base);
      x[i]![j] = q;
      assigned += q;
      if (s > shares[largest]!) largest = i;
    });
    x[largest]![j]! += d - assigned;
  });
  return x;
}

/**
 * Exact transportation problem via successive shortest paths (Bellman–Ford) on integer tonnes.
 * Nodes: 0 = source, 1..P = plants, P+1..P+R = regions, P+R+1 = sink.
 */
export function solveTransportation(input: OptimizationInput, demand: number[], carbonPrice: number): Allocation | null {
  const P = input.plants.length;
  const R = demand.length;
  const totalDemand = demand.reduce((a, b) => a + b, 0);
  const totalCap = input.plants.reduce((a, p) => a + p.capacityT, 0);
  if (totalDemand > totalCap) return null;

  const N = P + R + 2;
  const S = 0, T = N - 1;
  interface Arc { to: number; cap: number; cost: number; rev: number }
  const graph: Arc[][] = Array.from({ length: N }, () => []);
  const addArc = (u: number, v: number, cap: number, cost: number) => {
    graph[u]!.push({ to: v, cap, cost, rev: graph[v]!.length });
    graph[v]!.push({ to: u, cap: 0, cost: -cost, rev: graph[u]!.length - 1 });
  };
  input.plants.forEach((p, i) => addArc(S, 1 + i, p.capacityT, 0));
  for (let i = 0; i < P; i++) for (let j = 0; j < R; j++) addArc(1 + i, 1 + P + j, totalDemand, unitCost(input, i, j, carbonPrice));
  demand.forEach((d, j) => addArc(1 + P + j, T, d, 0));

  let flow = 0;
  while (flow < totalDemand) {
    const dist = new Array<number>(N).fill(Infinity);
    const prevNode = new Array<number>(N).fill(-1);
    const prevArc = new Array<number>(N).fill(-1);
    dist[S] = 0;
    for (let iter = 0; iter < N - 1; iter++) {
      let changed = false;
      for (let u = 0; u < N; u++) {
        if (dist[u] === Infinity) continue;
        graph[u]!.forEach((a, k) => {
          if (a.cap > 0 && dist[u]! + a.cost < dist[a.to]! - 1e-9) {
            dist[a.to] = dist[u]! + a.cost;
            prevNode[a.to] = u;
            prevArc[a.to] = k;
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
    if (dist[T] === Infinity) return null;
    let push = totalDemand - flow;
    for (let v = T; v !== S; v = prevNode[v]!) push = Math.min(push, graph[prevNode[v]!]![prevArc[v]!]!.cap);
    for (let v = T; v !== S; v = prevNode[v]!) {
      const a = graph[prevNode[v]!]![prevArc[v]!]!;
      a.cap -= push;
      graph[v]![a.rev]!.cap += push;
    }
    flow += push;
  }

  const x: Allocation = Array.from({ length: P }, () => new Array<number>(R).fill(0));
  for (let i = 0; i < P; i++) {
    for (const a of graph[1 + i]!) {
      if (a.to > P && a.to <= P + R) {
        const reverse = graph[a.to]![a.rev]!;
        x[i]![a.to - 1 - P] = reverse.cap;
      }
    }
  }
  return x;
}

export function objective(input: OptimizationInput, x: Allocation, carbonPrice: number): number {
  let total = 0;
  x.forEach((row, i) => row.forEach((q, j) => { total += q * unitCost(input, i, j, carbonPrice); }));
  return total;
}

export function optimize(input: OptimizationInput, options: OptimizationOptions): OptimizationResult {
  const demandT = scaledDemand(input, options.demandGrowth);
  const after = solveTransportation(input, demandT, options.carbonPriceJpyPerT);
  if (!after) {
    return {
      feasible: false,
      demandT,
      totalDemandT: demandT.reduce((a, b) => a + b, 0),
      totalCapacityT: input.plants.reduce((a, p) => a + p.capacityT, 0),
    };
  }
  const before = scaleCurrentPolicy(input, demandT);
  const beforeMetrics = measure(input, before);
  return {
    feasible: true,
    demandT,
    before,
    after,
    beforeMetrics,
    afterMetrics: measure(input, after),
    beforeOverCapacity: beforeMetrics.utilization.some((u) => u > 1 + 1e-9),
  };
}
