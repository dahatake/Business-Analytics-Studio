import { describe, expect, it } from 'vitest';
import { classifyIndustry } from '../src/domain/resourceIndustry.ts';
import {
  applyOverrides, buildNetworkModel, buildPeopleModel, currentFlows, defaultPeopleParams, emptyOverrides, linkKey, measureFlows,
  optimalFlows, runScenario, type ResourceModel,
} from '../src/domain/resourceModel.ts';
import { objective, scaledDemand, solveTransportation } from '../src/domain/optimize.ts';
import { narrativeMock, narrativePrompt, RESOURCE_STAGE } from '../src/modules/resource/facts.ts';
import { samplePack } from '../src/data/sample.ts';
import type { CustomerPack, Entity } from '../src/data/schema.ts';

describe('FR-326 industry classification', () => {
  it.each([
    ['IT・クラウド・AI・ソフトウェア', 'itServices'],
    ['精密機械・部品', 'manufacturing'],
    ['医療機器', 'manufacturing'],
    ['病院・介護', 'healthcare'],
    ['総合物流・倉庫', 'logistics'],
    ['Retail and e-commerce', 'retail'],
    ['Regional bank', 'finance'],
    ['', 'generic'],
    ['芸能プロダクション', 'generic'],
  ])('%s → %s', (text, archetype) => {
    expect(classifyIndustry(text).archetype).toBe(archetype);
  });

  it('reports the keywords that decided it', () => {
    expect(classifyIndustry('IT・クラウド・AI・ソフトウェア').matched.length).toBeGreaterThanOrEqual(3);
    expect(classifyIndustry(undefined).matched).toEqual([]);
  });
});

/** A hand-made people model, so the expected optimum can be enumerated. */
function tinyPeople(capA: number, capB: number): ResourceModel {
  const valued = (value: number) => ({ value, provenance: 'assumption' as const });
  return {
    lens: 'people', unit: 'hours',
    pools: [
      { id: 'a', name: { ja: 'A', en: 'A' }, capacity: valued(capA), off: false, unitCost: 0 },
      { id: 'b', name: { ja: 'B', en: 'B' }, capacity: valued(capB), off: false, unitCost: 0 },
    ],
    demands: [
      { id: 'x', kind: 'issue', name: { ja: 'X', en: 'X' }, need: valued(4), value: valued(10), off: false, owners: ['a'] },
      { id: 'y', kind: 'issue', name: { ja: 'Y', en: 'Y' }, need: valued(3), value: valued(6), off: false, owners: ['a'] },
      { id: 'z', kind: 'issue', name: { ja: 'Z', en: 'Z' }, need: valued(2), value: valued(1), off: false, owners: [] },
    ],
    links: ['a', 'b'].flatMap((p) => ['x', 'y', 'z'].map((d) => ({ poolId: p, demandId: d, owner: d !== 'z' && p === 'a', allowed: true, cost: d !== 'z' && p === 'a' ? 0 : 2 }))),
    beforeShares: { x: [{ poolId: 'a', share: 1 }], y: [{ poolId: 'a', share: 1 }], z: [] },
  };
}

/** Brute force over integer flows (tiny sizes only). */
function bruteForce(model: ResourceModel): number {
  const links = model.links.filter((l) => l.allowed);
  let best = 0;
  const qty = new Array<number>(links.length).fill(0);
  const rec = (k: number) => {
    if (k === links.length) {
      const flows = links.map((l, i) => ({ poolId: l.poolId, demandId: l.demandId, qty: qty[i]! })).filter((f) => f.qty);
      const load = new Map<string, number>(), served = new Map<string, number>();
      flows.forEach((f) => { load.set(f.poolId, (load.get(f.poolId) ?? 0) + f.qty); served.set(f.demandId, (served.get(f.demandId) ?? 0) + f.qty); });
      if (model.pools.some((p) => (load.get(p.id) ?? 0) > p.capacity.value)) return;
      if (model.demands.some((d) => (served.get(d.id) ?? 0) > d.need.value)) return;
      best = Math.min(best, measureFlows(model, flows).objective);
      return;
    }
    const need = model.demands.find((d) => d.id === links[k]!.demandId)!.need.value;
    for (let q = 0; q <= need; q++) { qty[k] = q; rec(k + 1); }
    qty[k] = 0;
  };
  rec(0);
  return best;
}

describe('FR-326 resource optimum', () => {
  it.each([[9, 0], [5, 2], [3, 3], [0, 0]])('people: matches brute force (capacity %i/%i)', (a, b) => {
    const model = tinyPeople(a, b);
    expect(measureFlows(model, optimalFlows(model)).objective).toBeCloseTo(bruteForce(model), 9);
  });

  it('leaves the lowest-value work unmet when capacity is short, and keeps owners where it is free', () => {
    const model = tinyPeople(5, 0);
    const m = measureFlows(model, optimalFlows(model));
    expect(m.served_['x']).toBe(4);
    expect(m.served_['y']).toBe(1);
    expect(m.served_['z']).toBe(0);
    expect(m.served).toBeLessThan(m.need);
  });

  it('today ignores capacity (overload shows) and the optimum never exceeds it', () => {
    const s = runScenario(tinyPeople(5, 4));
    expect(s.beforeMetrics.overloaded).toBe(1);
    expect(s.afterMetrics.overloaded).toBe(0);
    expect(s.afterMetrics.weightedPct).toBeGreaterThan(s.beforeMetrics.weightedPct);
  });

  it('reports a bottleneck only for a pool whose extra capacity is worth something', () => {
    const constrained = runScenario(tinyPeople(5, 0));
    expect(constrained.marginals.map((m) => m.poolId)).toEqual(['a']);
    expect(runScenario(tinyPeople(20, 20)).marginals).toEqual([]);
  });

  it('simulation edits are marked and a disallowed link carries no flow', () => {
    const base = tinyPeople(9, 9);
    const ov = emptyOverrides();
    ov.pools['a'] = { capacity: 2 };
    ov.demands['z'] = { value: 50 };
    ov.links[linkKey('b', 'x')] = false;
    const edited = applyOverrides(base, ov);
    expect(edited.pools[0]!.capacity).toEqual({ value: 2, provenance: 'simulation' });
    expect(edited.demands[2]!.value.provenance).toBe('simulation');
    const flows = optimalFlows(edited);
    expect(flows.some((f) => f.poolId === 'b' && f.demandId === 'x')).toBe(false);
    expect(measureFlows(edited, flows).served_['z']).toBe(2);
  });

  it('network: equals the transportation solver on the sample pack', () => {
    const input = samplePack.optimization!;
    for (const [growth, carbon] of [[0, 0], [0, 10_000], [0.1, 30_000]] as const) {
      const model = buildNetworkModel(input, samplePack.regions, (id) => ({ ja: id, en: id }), { growth, carbon });
      const m = measureFlows(model, optimalFlows(model));
      const demand = scaledDemand(input, growth);
      const x = solveTransportation(input, demand, carbon);
      if (!x) {
        expect(m.served).toBeLessThan(m.need);
        continue;
      }
      expect(m.served).toBe(m.need);
      const mustServe = model.demands[0]!.value.value;
      expect(m.objective + m.need * mustServe).toBeCloseTo(objective(input, x, carbon), 3);
    }
  });

  it('network: today is the pack allocation', () => {
    const input = samplePack.optimization!;
    const model = buildNetworkModel(input, samplePack.regions, (id) => ({ ja: id, en: id }), { growth: 0, carbon: 0 });
    const flows = currentFlows(model);
    input.currentAllocation.forEach((row, i) => row.forEach((q, j) => {
      const f = flows.find((fl) => fl.poolId === model.pools[i]!.id && fl.demandId === model.demands[j]!.id);
      expect(f?.qty ?? 0).toBeCloseTo(q, 0);
    }));
  });
});

describe('FR-326 people model from a pack', () => {
  const person = (id: string, ja: string): Entity => ({ ...samplePack.entities.find((e) => e.kind === 'person')!, id, name: { ja, en: ja } } as Entity);
  const issue = (id: string, impact: number, kpiIds: string[] = []): Entity => ({ ...samplePack.entities.find((e) => e.kind === 'issue')!, id, impact, feasibility: 3, kpiIds } as Entity);
  const kpi = (id: string, ownerId: string): Entity => ({ ...samplePack.entities.find((e) => e.kind === 'kpi')!, id, ownerId } as Entity);
  const pack: CustomerPack = {
    ...samplePack,
    optimization: undefined,
    entities: [person('p1', '山田 太郎'), person('p2', '佐藤 花子'), issue('i1', 5, ['k1']), issue('i2', 2), kpi('k1', 'p1')],
    extensions: {
      engagements: { items: [
        { id: 'e1', name: '振り返り会', owner: '山田太郎', status: '完了', sourceIds: ['s1'] },
        { id: 'e2', name: '次の提案', owner: '佐藤 花子', status: '準備中', sourceIds: ['s1'] },
      ] },
    },
  };
  const params = defaultPeopleParams('itServices');

  it('takes people and work from the pack, and marks the assumed numbers', () => {
    const model = buildPeopleModel(pack, 'itServices', params, () => true, true);
    expect(model.pools.map((p) => p.id)).toEqual(['pool:p1', 'pool:p2']);
    expect(model.pools.every((p) => p.capacity.provenance === 'assumption')).toBe(true);
    expect(model.pools[0]!.capacity.value).toBe(Math.round(params.hoursPerPerson * params.maxUtilization));
    const i1 = model.demands.find((d) => d.id === 'demand:i1')!;
    expect(i1.owners).toEqual(['pool:p1']);
    expect(i1.need.provenance).toBe('assumption');
    expect(i1.value).toEqual({ value: 15, provenance: 'derived' });
    expect(model.demands.find((d) => d.id === 'demand:i2')!.owners).toEqual([]);
  });

  it('closed engagements are history, open ones are demand owned by name', () => {
    const model = buildPeopleModel(pack, 'itServices', params, () => true, true);
    expect(model.pools[0]!.history).toBe(1);
    expect(model.demands.find((d) => d.id === 'demand:eng:e2')!.owners).toEqual(['pool:p2']);
    expect(model.demands.some((d) => d.id === 'demand:eng:e1')).toBe(false);
  });

  it('external audience: no internal extensions', () => {
    const model = buildPeopleModel(pack, 'itServices', params, () => true, false);
    expect(model.demands.some((d) => d.kind === 'engagement')).toBe(false);
    expect(model.pools[0]!.history).toBe(0);
  });

  it('today: unowned work is not served; the optimum serves it within capacity', () => {
    const s = runScenario(buildPeopleModel(pack, 'itServices', params, () => true, false));
    expect(s.beforeMetrics.served_['demand:i2']).toBe(0);
    expect(s.afterMetrics.served).toBe(s.afterMetrics.need);
    expect(s.afterMetrics.overloaded).toBe(0);
  });
});

describe('FR-326 offline narrative', () => {
  it('returns exactly the facts', () => {
    const prompt = narrativePrompt('Explain.', ['Fact one.', 'Fact two.']);
    expect(narrativeMock({ use: 'explain', lang: 'en', prompt, stage: RESOURCE_STAGE } as never)).toBe('Fact one. Fact two.');
    expect(narrativeMock({ use: 'explain', lang: 'ja', prompt: 'no marker' } as never)).toBe('');
  });
});
