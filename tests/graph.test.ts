import { describe, expect, it } from 'vitest';
import { loadPack, loaded, type RelationType } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { translate } from '../src/i18n/index.ts';
import type { LText } from '../src/data/schema.ts';
import { graphExtensionFor, parseGraphExtension, SEMANTICS } from '../src/modules/graph/extensions.ts';
import {
  aggregateNodes, allocateLabels, assessSuitability, bundleEdges, centreOn, clampZoom, classify, deriveFlows, deriveSpatial,
  deriveTwins, MAX_LABELS, MAX_NODES, MIN_BUNDLE, PAN_STEP_PX, panBy, QUESTIONS, RELATION_SEMANTICS, RELATION_TYPES, selectLevel,
  semanticOf, topN, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomBy, defaultLayer,
} from '../src/modules/graph/model.ts';
import { buildScene, type SceneInput } from '../src/modules/graph/scene.ts';

const ALL_RELATION_TYPES: RelationType[] = [
  'places', 'includes', 'produces', 'billedAs', 'owns', 'causedBy', 'resolves', 'improves', 'measuredBy', 'implements',
  'madeAt', 'worksAt', 'accountableFor', 'supplies', 'citedFrom',
];

describe('FR-236 semantic mapping', () => {
  it('maps every RelationType to one of the nine semantic types', () => {
    expect([...RELATION_TYPES].sort()).toEqual([...ALL_RELATION_TYPES].sort());
    for (const r of ALL_RELATION_TYPES) expect(SEMANTICS).toContain(RELATION_SEMANTICS[r].semantic);
  });
  it('uses all nine semantic types', () => {
    expect(new Set(ALL_RELATION_TYPES.map((r) => RELATION_SEMANTICS[r].semantic))).toEqual(new Set(SEMANTICS));
  });
  it('maps representative relations as expected', () => {
    expect(semanticOf('causedBy')).toBe('causality');
    expect(RELATION_SEMANTICS.causedBy.reversed).toBe(true);
    expect(semanticOf('measuredBy')).toBe('measurement');
    expect(semanticOf('madeAt')).toBe('placement');
    expect(semanticOf('accountableFor')).toBe('control');
    expect(semanticOf('billedAs')).toBe('lineage');
    expect(semanticOf('worksAt')).toBe('membership');
  });
  it('customer pack can override the semantic type', () => {
    const { ext } = parseGraphExtension({ semantics: { worksAt: { semantic: 'placement', label: { ja: '所属拠点', en: 'Based at' } } } });
    expect(semanticOf('worksAt', ext)).toBe('placement');
  });
});

describe('FR-212/213/214 world classification and twin relations', () => {
  it('classifies every sample entity into real or digital with a cluster', () => {
    for (const e of loaded.pack.entities) {
      const c = classify(e);
      expect(['real', 'digital']).toContain(c.world);
      expect(c.cluster).toBe(`cl:${e.world}:${e.type}`);
      if (e.world === 'digital') expect(c).toHaveProperty('layer');
    }
  });
  it('assigns default Twin layers by type', () => {
    const kpi = loaded.byId.get('kpi-defect')!;
    const sol = loaded.byId.get('sol-vision-inspection')!;
    const inv = loaded.byId.get('inv-2026-064')!;
    expect(defaultLayer(kpi)).toBe('insights');
    expect(defaultLayer(sol)).toBe('operations');
    expect(defaultLayer(inv)).toBe('operations');
  });
  const twins = deriveTwins(loaded);
  it('derives KPI measures issue, invoice records deliverable, solution represents operation', () => {
    expect(twins).toContainEqual(expect.objectContaining({ digital: 'kpi-defect', real: 'issue-quality', kind: 'measures' }));
    const inv = loaded.pack.entities.find((e) => e.kind === 'invoice')!;
    expect(inv.kind === 'invoice' && twins.some((t) => t.digital === inv.id && t.real === inv.deliverableId && t.kind === 'records')).toBe(true);
    expect(twins).toContainEqual(expect.objectContaining({ digital: 'sol-demand-planning', real: 'init-dp-pilot', kind: 'represents' }));
  });
  it('derives KPI measures the site of its owner', () => {
    const kpi = loaded.byId.get('kpi-defect')!;
    const owner = kpi.kind === 'kpi' ? loaded.byId.get(kpi.ownerId) : undefined;
    expect(owner?.kind).toBe('person');
    expect(twins).toContainEqual(expect.objectContaining({ digital: 'kpi-defect', real: owner?.kind === 'person' ? owner.siteId : '', kind: 'measures', origin: 'derived' }));
  });
  it('twin relations always link a digital entity to a real one', () => {
    expect(twins.length).toBeGreaterThan(10);
    for (const t of twins) {
      expect(loaded.byId.get(t.digital)?.world).toBe('digital');
      expect(loaded.byId.get(t.real)?.world).toBe('real');
    }
  });
  it('flows: measures/records are Data (real → digital), represents is Control (digital → real)', () => {
    const flows = deriveFlows(twins);
    const data = flows.find((f) => f.twin === 'measures')!;
    expect(data.kind).toBe('data');
    expect(loaded.byId.get(data.source)?.world).toBe('real');
    const control = flows.find((f) => f.twin === 'represents')!;
    expect(control.kind).toBe('control');
    expect(loaded.byId.get(control.source)?.world).toBe('digital');
  });
  it('pack twins and flows are added', () => {
    const { ext } = parseGraphExtension({ twins: [{ digital: 'kpi-co2', real: 'site-nagoya', kind: 'displays' }], flows: [{ source: 'sol-energy-twin', target: 'site-nagoya', kind: 'control' }] }, new Set(loaded.byId.keys()));
    const tw = deriveTwins(loaded, ext);
    expect(tw).toContainEqual({ digital: 'kpi-co2', real: 'site-nagoya', kind: 'displays', origin: 'pack' });
    expect(deriveFlows(tw, ext)).toContainEqual(expect.objectContaining({ source: 'sol-energy-twin', target: 'site-nagoya', kind: 'control' }));
  });
});

describe('FR-235 graph suitability', () => {
  it('chain needs a transitive meaning and a direction', () => {
    expect(assessSuitability('causality', true, 'chain')).toMatchObject({ suitable: true, reason: 'transitive', recommend: 'graph' });
    expect(assessSuitability('causality', false, 'chain')).toMatchObject({ suitable: false, reason: 'needsDirection' });
    expect(assessSuitability('membership', true, 'chain')).toMatchObject({ suitable: false, reason: 'notTransitive' });
    expect(assessSuitability('placement', true, 'chain')).toMatchObject({ suitable: false, recommend: 'tree' });
  });
  it('many-to-many suits a graph except for strict hierarchies', () => {
    expect(assessSuitability('membership', false, 'manyToMany').suitable).toBe(true);
    expect(assessSuitability('ownership', true, 'manyToMany')).toMatchObject({ suitable: false, reason: 'hierarchy', recommend: 'tree' });
  });
  it('reachability is meaningless through metrics', () => {
    expect(assessSuitability('measurement', true, 'reachability')).toMatchObject({ suitable: false, reason: 'metricEndpoint' });
    expect(assessSuitability('lineage', true, 'reachability').suitable).toBe(true);
    expect(assessSuitability('dependency', false, 'reachability').suitable).toBe(false);
  });
  it('centrality suits influence but not placement', () => {
    expect(assessSuitability('influence', true, 'centrality').suitable).toBe(true);
    expect(assessSuitability('placement', true, 'centrality')).toMatchObject({ suitable: false, reason: 'treePosition' });
  });
  it('returns a verdict and reason for every combination', () => {
    for (const s of SEMANTICS) for (const d of [true, false]) for (const q of QUESTIONS) {
      const r = assessSuitability(s, d, q);
      expect(typeof r.suitable).toBe('boolean');
      expect(r.reason).toBeTruthy();
    }
  });
});

describe('FR-236 clustering, labels and bundling thresholds', () => {
  it('PARAMs are 200 / 60 / 8', () => {
    expect([MAX_NODES, MAX_LABELS, MIN_BUNDLE]).toEqual([200, 60, 8]);
  });
  it('keeps up to 200 nodes individual and aggregates above that', () => {
    const ids200 = Array.from({ length: 200 }, (_, i) => `n-${i}`);
    expect(aggregateNodes(ids200, (id) => `g${Number(id.slice(2)) % 5}`).clusters.size).toBe(0);
    const ids201 = [...ids200, 'n-200'];
    const agg = aggregateNodes(ids201, (id) => `g${Number(id.slice(2)) % 5}`);
    expect(agg.clusters.size).toBeGreaterThan(0);
    expect(agg.nodes.length + agg.clusters.size).toBeLessThanOrEqual(200);
    for (const id of ids201) expect(agg.drawnAs.has(id)).toBe(true);
  });
  it('bundles 8 or more edges between the same two clusters, keeps 7 apart', () => {
    const group = (id: string) => id.split('-')[0]!;
    const mk = (n: number, a: string, b: string) => Array.from({ length: n }, (_, i) => ({ source: `${a}-${i}`, target: `${b}-${i}`, type: 'includes' }));
    const r8 = bundleEdges(mk(8, 'a', 'b'), group);
    expect(r8.bundles).toHaveLength(1);
    expect(r8.bundles[0]!.edges).toHaveLength(8);
    expect(r8.loose).toHaveLength(0);
    const r7 = bundleEdges(mk(7, 'a', 'b'), group);
    expect(r7.bundles).toHaveLength(0);
    expect(r7.loose).toHaveLength(7);
    // direction does not matter for the pair; self-loops inside a cluster are dropped
    const mixed = bundleEdges([...mk(4, 'a', 'b'), ...mk(4, 'b', 'a'), ...mk(3, 'a', 'a')], group);
    expect(mixed.bundles).toHaveLength(1);
    expect(mixed.loose).toHaveLength(0);
  });
  it('shows at most 60 labels, pinned first', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => `n${i}`);
    const edges = Array.from({ length: 100 }, (_, i) => `e${i}`);
    const labels = allocateLabels(nodes, edges, ['n99']);
    expect(labels.size).toBe(60);
    expect(labels.has('n99')).toBe(true);
    expect([...labels].some((l) => l.startsWith('e'))).toBe(true);
    expect(allocateLabels(nodes.slice(0, 10), edges.slice(0, 5)).size).toBe(15);
    expect(allocateLabels(nodes, []).size).toBe(60);
  });
});

describe('FR-237 semantic zoom', () => {
  it('goes deeper past 2× (+10 % hysteresis) and up below 0.5× (−10 %)', () => {
    expect(selectLevel('overview', 2.1, false)).toBe('overview');
    expect(selectLevel('overview', 2.2, false)).toBe('element');
    expect(selectLevel('element', 2.5, false)).toBe('element');
    expect(selectLevel('element', 2.5, true)).toBe('detail');
    expect(selectLevel('detail', 4, true)).toBe('detail');
    expect(selectLevel('detail', 0.46, true)).toBe('detail');
    expect(selectLevel('detail', 0.45, true)).toBe('element');
    expect(selectLevel('element', 0.4, false)).toBe('overview');
    expect(selectLevel('overview', 0.25, false)).toBe('overview');
  });
  it('four zoom-in steps from fit reach the next level', () => {
    let z = 1;
    let level = selectLevel('overview', z, false);
    for (let i = 0; i < 4; i++) { z = zoomBy(z, 1); level = selectLevel(level, z, false); }
    expect(level).toBe('element');
  });
  const inp = (level: SceneInput['level'], view: SceneInput['view'] = 'relations'): SceneInput => ({
    data: loaded, ext: graphExtensionFor(loaded), view, level, world: 'both', showTwins: false, selected: 'kpi-defect', visible: () => true,
    t: (k, v) => translate('en', k, v), tx: (x: LText) => x.en, fmtNumber: (n) => String(n),
  });
  it('changes representation per level: clusters → entities → attributes', () => {
    const overview = buildScene(inp('overview'));
    expect(overview.nodes.every((n) => n.role === 'cluster')).toBe(true);
    const element = buildScene(inp('element'));
    expect(element.nodes.every((n) => n.role === 'entity')).toBe(true);
    expect(element.nodes.length).toBe(loaded.pack.entities.length);
    const detail = buildScene(inp('detail'));
    expect(detail.focusId).toBe('kpi-defect');
    expect(detail.nodes.some((n) => n.role === 'attribute')).toBe(true);
    expect(detail.nodes.some((n) => n.role === 'attribute' && n.label.includes('Current / target'))).toBe(true);
  });
  it('overview bundles cluster pairs with 8+ edges and keeps labels ≤ 60', () => {
    const overview = buildScene(inp('overview'));
    expect(overview.edges.some((e) => e.bundled && e.count >= 8)).toBe(true);
    expect(overview.edges.filter((e) => !e.bundled).every((e) => e.count < 8)).toBe(true);
    expect(buildScene(inp('element')).labelled.size).toBeLessThanOrEqual(60);
  });
  it('world filter keeps only the chosen world', () => {
    const real = buildScene({ ...inp('element'), world: 'real' });
    expect(real.nodes.every((n) => loaded.byId.get(n.entityId!)?.world === 'real')).toBe(true);
    const twins = buildScene({ ...inp('element'), showTwins: true });
    expect(twins.edges.some((e) => e.twin)).toBe(true);
  });
  it('twin and spatial views build all three levels', () => {
    for (const view of ['twin', 'spatial'] as const) {
      const sizes = (['overview', 'element', 'detail'] as const).map((l) => buildScene(inp(l, view)).nodes.length);
      expect(sizes.every((s) => s > 0)).toBe(true);
    }
    const twinEl = buildScene(inp('element', 'twin'));
    expect(twinEl.edges.some((e) => e.flow === 'data')).toBe(true);
    expect(twinEl.edges.some((e) => e.flow === 'control')).toBe(true);
    expect(twinEl.lanes.map((l) => l.label)).toContain('Insights (analytics, KPIs, forecasts)');
  });
});

describe('FR-245 zoom clamp and pan step', () => {
  it('clamps zoom to 0.25–4 of fit with 1.25× steps', () => {
    expect([ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, PAN_STEP_PX]).toEqual([0.25, 4, 1.25, 40]);
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomBy(1, 1)).toBeCloseTo(1.25);
    expect(zoomBy(1, -1)).toBeCloseTo(0.8);
    expect(zoomBy(3.9, 1)).toBe(4);
    expect(zoomBy(0.26, -1)).toBe(0.25);
  });
  it('Shift+arrow pans 40 px', () => {
    expect(panBy({ x: 0, y: 0 }, 'ArrowRight')).toEqual({ x: -40, y: 0 });
    expect(panBy({ x: 0, y: 0 }, 'ArrowLeft')).toEqual({ x: 40, y: 0 });
    expect(panBy({ x: 5, y: 5 }, 'ArrowUp')).toEqual({ x: 5, y: 45 });
    expect(panBy({ x: 5, y: 5 }, 'ArrowDown')).toEqual({ x: 5, y: -35 });
  });
  it('centres a point', () => {
    expect(centreOn({ x: 10, y: 20 }, { x: 0, y: 0 }, 2)).toEqual({ x: -20, y: -40 });
  });
  it('cards list at most 5 relations (PARAM-105)', () => {
    expect(topN([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
    expect(topN([1, 2])).toEqual({ shown: [1, 2], more: 0 });
  });
});

describe('FR-240 spatial hierarchy', () => {
  it('derives site → floor → room deterministically with KPIs placed in owner rooms', () => {
    const a = deriveSpatial(loaded), b = deriveSpatial(loaded);
    expect(a).toEqual(b);
    const sites = loaded.pack.entities.filter((e) => e.kind === 'site');
    expect(a).toHaveLength(sites.length);
    const hq = a.find((s) => s.siteId === 'site-tokyo-hq')!;
    expect(hq.floors).toHaveLength(3);
    const plant = a.find((s) => s.siteId === 'site-nagoya')!;
    expect(plant.floors[0]!.rooms[0]!.purpose).toBe('production');
    const kpis = a.flatMap((s) => s.kpis);
    expect(kpis.length).toBe(loaded.pack.entities.filter((e) => e.kind === 'kpi').length);
    const people = a.flatMap((s) => s.floors.flatMap((f) => f.rooms.flatMap((r) => r.people)));
    expect(new Set(people).size).toBe(loaded.pack.entities.filter((e) => e.kind === 'person').length);
  });
});

describe('FR-241 extensions.graph schema (backward compatible)', () => {
  it('absent → derived defaults without issues', () => {
    const r = parseGraphExtension(undefined);
    expect(r.issues).toEqual([]);
    expect(r.fromPack).toBe(false);
    expect(r.ext.twins).toEqual([]);
  });
  it('a pack without extensions still loads and uses defaults', () => {
    const { extensions: _drop, ...rest } = samplePack as typeof samplePack & { extensions?: unknown };
    const pack = loadPack({ ...rest, isSample: false });
    const r = graphExtensionFor(pack);
    expect(r.fromPack).toBe(false);
    expect(r.issues).toEqual([]);
  });
  it('the sample pack gets demo layers and KPI stages', () => {
    const r = graphExtensionFor(loaded);
    expect(r.ext.layers['kpi-engagement']).toBe('experience');
    expect(r.ext.kpiStages['kpi-co2']).toBe('outcome');
  });
  it('valid data is accepted', () => {
    const ids = new Set(loaded.byId.keys());
    const r = parseGraphExtension({
      semantics: { supplies: { label: { ja: '納入', en: 'Delivers to' } } },
      relations: [{ source: 'sol-energy-twin', target: 'site-nagoya', semantic: 'control' }],
      twins: [{ digital: 'kpi-co2', real: 'site-nagoya', kind: 'measures' }],
      flows: [{ source: 'site-nagoya', target: 'kpi-co2', kind: 'data' }],
      layers: { 'kpi-co2': 'operations' },
      kpiStages: { 'kpi-co2': 'process' },
    }, ids);
    expect(r.issues).toEqual([]);
    expect(r.fromPack).toBe(true);
    expect(r.ext.relations).toHaveLength(1);
    expect(r.ext.layers['kpi-co2']).toBe('operations');
    expect(classify(loaded.byId.get('kpi-co2')!, r.ext).layer).toBe('operations');
  });
  it('invalid data is rejected gracefully: bad items dropped, valid ones kept, never throws', () => {
    const ids = new Set(loaded.byId.keys());
    const r = parseGraphExtension({
      semantics: { supplies: { semantic: 'teleport' } },
      twins: [{ digital: 'kpi-co2', real: 'site-nagoya', kind: 'measures' }, { digital: 'kpi-co2', real: 'site-nagoya', kind: 'owns' }, { digital: 'nope-x', real: 'site-nagoya', kind: 'measures' }],
      flows: 'not-an-array',
      layers: { 'kpi-co2': 'basement' },
    }, ids);
    expect(r.ext.twins).toHaveLength(1);
    expect(r.ext.semantics).toEqual({});
    expect(r.ext.flows).toEqual([]);
    expect(r.ext.layers).toEqual({});
    expect(r.issues.length).toBe(5);
    expect(() => parseGraphExtension('garbage')).not.toThrow();
    expect(parseGraphExtension(42).issues).toHaveLength(1);
    expect(parseGraphExtension([1, 2]).ext.twins).toEqual([]);
  });
  it('a pack with an invalid extensions.graph still loads', () => {
    const pack = loadPack({ ...samplePack, extensions: { graph: { twins: 5 } } });
    const r = graphExtensionFor(pack);
    expect(r.fromPack).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(deriveTwins(pack, r.ext).length).toBeGreaterThan(0);
  });
});
