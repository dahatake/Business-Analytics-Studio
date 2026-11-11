import { describe, expect, it } from 'vitest';
import { lodForDistance, LodTracker, LOD_HYSTERESIS, visibleAtLevel } from '../src/modules/threed/lod.ts';
import {
  FPS_DOWNGRADE_HOLD_MS, FPS_DOWNGRADE_THRESHOLD, FPS_UPGRADE_HOLD_MS, QualityController,
} from '../src/modules/threed/quality.ts';
import { angleDelta, flyDurationMs, flyPose } from '../src/modules/threed/flythrough.ts';
import { buildArchitecture, productLayer } from '../src/modules/threed/architecture.ts';
import { coreObjectChoice } from '../src/modules/threed/coreObject.ts';
import { buildArchModel, buildKpiModel, buildMapModel, buildTwinModel, towerHeight, KPI_FULL_HEIGHT } from '../src/modules/threed/models.ts';
import { ancestry, poseFor, type Pose } from '../src/modules/threed/model.ts';
import { entitiesOf, loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';

const data = loadPack(samplePack);

describe('FR-031/032 LOD with hysteresis (PARAM-023)', () => {
  const T = [40, 18];

  it('uses 10 % hysteresis', () => expect(LOD_HYSTERESIS).toBe(0.1));

  it('raw levels without history', () => {
    expect(lodForDistance(100, T)).toBe(0);
    expect(lodForDistance(40, T)).toBe(1);
    expect(lodForDistance(30, T)).toBe(1);
    expect(lodForDistance(18, T)).toBe(2);
    expect(lodForDistance(5, T)).toBe(2);
  });

  it('switches closer at the threshold, farther only beyond threshold × 1.1', () => {
    expect(lodForDistance(40.01, T, 0)).toBe(0);
    expect(lodForDistance(40, T, 0)).toBe(1);
    expect(lodForDistance(43.9, T, 1)).toBe(1);
    expect(lodForDistance(44, T, 1)).toBe(1);
    expect(lodForDistance(44.01, T, 1)).toBe(0);
    expect(lodForDistance(19.5, T, 2)).toBe(2);
    expect(lodForDistance(19.81, T, 2)).toBe(1);
  });

  it('does not flicker when the distance jitters around a boundary', () => {
    const tracker = new LodTracker(T);
    tracker.update(60);
    const levels: number[] = [];
    // Zoom in to just past the boundary, then jitter ±3 % around it.
    for (const d of [45, 41, 39.9, 40.5, 39.5, 41.2, 40.1, 42, 39.8, 43.5]) levels.push(tracker.update(d).level);
    expect(levels).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
    let changes = 0;
    for (let i = 0; i < 200; i++) if (tracker.update(40 + Math.sin(i) * 1.5).changed) changes++;
    expect(changes).toBe(0);
  });

  it('jumps several levels at once when the camera moves far', () => {
    expect(lodForDistance(5, T, 0)).toBe(2);
    expect(lodForDistance(500, T, 2)).toBe(0);
  });

  it('FR-036 visibility range', () => {
    expect(visibleAtLevel(0, 0, 0)).toBe(true);
    expect(visibleAtLevel(1, 0, 0)).toBe(false);
    expect(visibleAtLevel(1, 1)).toBe(true);
    expect(visibleAtLevel(0, 1)).toBe(false);
  });
});

describe('FR-069 quality controller (PARAM-027 45 fps, PARAM-028 2 s)', () => {
  it('downgrades only after 2 s continuously below 45 fps', () => {
    const q = new QualityController('high', true);
    expect(FPS_DOWNGRADE_THRESHOLD).toBe(45);
    expect(FPS_DOWNGRADE_HOLD_MS).toBe(2000);
    for (let t = 0; t < 2000; t += 500) expect(q.sample(30, t)).toBeNull();
    expect(q.current).toBe('high');
    expect(q.sample(30, 2000)).toEqual({ from: 'high', to: 'medium', reason: 'downgrade' });
    expect(q.current).toBe('medium');
  });

  it('a single good sample restarts the timer; exactly 45 fps is not "below"', () => {
    const q = new QualityController('high', true);
    for (let t = 0; t <= 1500; t += 500) q.sample(30, t);
    q.sample(50, 1900);
    for (let t = 2400; t < 4400; t += 500) expect(q.sample(30, t)).toBeNull();
    expect(q.current).toBe('high');
    expect(q.sample(30, 4400)?.to).toBe('medium');
    const r = new QualityController('high', true);
    for (let t = 0; t <= 5000; t += 500) r.sample(45, t);
    expect(r.current).toBe('high');
  });

  it('needs another 2 s for each further step and never goes below low', () => {
    const q = new QualityController('high', true);
    for (let t = 0; t <= 10_000; t += 500) q.sample(10, t);
    expect(q.current).toBe('low');
    expect(q.sample(10, 10_500)).toBeNull();
  });

  it('a pause between samples (render on demand) restarts the timer', () => {
    const q = new QualityController('high', true);
    q.sample(30, 0);
    q.sample(30, 1500);
    expect(q.sample(30, 5000)).toBeNull();
    expect(q.current).toBe('high');
  });

  it('upgrades back after 5 s at ≥ 55 fps, never above the chosen preset', () => {
    const q = new QualityController('medium', true);
    for (let t = 0; t <= 2000; t += 500) q.sample(20, t);
    expect(q.current).toBe('low');
    let t = 2500;
    for (; t < 2500 + FPS_UPGRADE_HOLD_MS; t += 500) expect(q.sample(60, t)).toBeNull();
    expect(q.sample(60, t)?.to).toBe('medium');
    for (let u = t + 500; u < t + 20_000; u += 500) q.sample(60, u);
    expect(q.current).toBe('medium');
  });

  it('values between 45 and 55 fps hold the level (no oscillation)', () => {
    const q = new QualityController('high', true);
    for (let t = 0; t <= 2000; t += 500) q.sample(20, t);
    for (let t = 2500; t < 30_000; t += 500) q.sample(50, t);
    expect(q.current).toBe('medium');
  });

  it('stops re-upgrading to a level it had to leave twice', () => {
    const q = new QualityController('high', true);
    let t = 0;
    const slow = () => { for (let i = 0; i <= 4; i++, t += 500) q.sample(20, t); };
    const fast = () => { for (let i = 0; i <= 11; i++, t += 500) q.sample(60, t); };
    slow(); expect(q.current).toBe('medium');
    fast(); expect(q.current).toBe('high');
    slow(); expect(q.current).toBe('medium');
    fast(); expect(q.current).toBe('medium');
  });

  it('manual mode never changes the level; choosing a preset resets the history', () => {
    const q = new QualityController('high', false);
    for (let t = 0; t <= 10_000; t += 500) q.sample(5, t);
    expect(q.current).toBe('high');
    q.setPreset('medium', true);
    expect(q.current).toBe('medium');
    expect(q.ceiling).toBe('medium');
  });
});

describe('FR-023 fly-through', () => {
  const a: Pose = { target: [0, 0, 0], distance: 50, azimuth: 3, polar: 1 };
  const b: Pose = { target: [10, 2, -4], distance: 8, azimuth: -3, polar: 0.6 };

  it('starts and ends exactly at the endpoints', () => {
    expect(flyPose(a, b, 0)).toEqual(a);
    expect(flyPose(a, b, 1)).toEqual(b);
    expect(flyPose(a, b, -1)).toEqual(a);
    expect(flyPose(a, b, 2)).toEqual(b);
  });

  it('pulls back midway and turns the short way round', () => {
    const mid = flyPose(a, b, 0.5);
    expect(mid.distance).toBeGreaterThan((a.distance + b.distance) / 2);
    expect(Math.abs(angleDelta(a.azimuth, b.azimuth))).toBeLessThan(Math.PI);
    expect(mid.azimuth).toBeGreaterThan(a.azimuth);
  });

  it('is instant under reduced motion and bounded otherwise', () => {
    expect(flyDurationMs(a, b, true)).toBe(0);
    const ms = flyDurationMs(a, b, false);
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(ms).toBeLessThanOrEqual(1400);
  });
});

describe('FR-040 architecture from the pack', () => {
  const products = new Set(entitiesOf('solution', data).flatMap((s) => s.msProducts));

  it('ToBe has one block per Microsoft product on its layer', () => {
    const tobe = buildArchitecture('tobe', data);
    const blocks = tobe.layers.flatMap((l) => l.blocks);
    expect(new Set(blocks.map((b) => b.product))).toEqual(products);
    expect(blocks.length).toBe(products.size);
    expect(blocks.every((b) => b.role === 'product')).toBe(true);
    const fabric = blocks.find((b) => b.product === 'Microsoft Fabric')!;
    expect(fabric.layer).toBe('data');
    expect(fabric.solutionIds.sort()).toEqual(['sol-demand-planning', 'sol-energy-twin']);
    expect(tobe.links.length).toBeGreaterThan(0);
  });

  it('AsIs has no Microsoft products: current systems per layer plus the pain points', () => {
    const asis = buildArchitecture('asis', data);
    const blocks = asis.layers.flatMap((l) => l.blocks);
    expect(blocks.some((b) => b.product)).toBe(false);
    expect(blocks.filter((b) => b.role === 'current')).toHaveLength(5);
    const issueIds = new Set(entitiesOf('solution', data).flatMap((s) => s.issueIds));
    expect(new Set(blocks.filter((b) => b.role === 'painPoint').map((b) => b.entityId))).toEqual(issueIds);
  });

  it('hides internal solutions for an external audience', () => {
    const internal = buildArchitecture('tobe', data, 'internal').layers.flatMap((l) => l.blocks).map((b) => b.product);
    const external = buildArchitecture('tobe', data, 'external').layers.flatMap((l) => l.blocks).map((b) => b.product);
    expect(internal).toContain('Microsoft 365 Copilot');
    expect(external).not.toContain('Microsoft 365 Copilot');
  });

  it('classifies unknown products by name', () => {
    expect(productLayer('Azure AI Foundry')).toBe('intelligence');
    expect(productLayer('Azure Data Explorer')).toBe('data');
    expect(productLayer('Something Else')).toBe('process');
  });

  it('classifies Microsoft Foundry on the intelligence layer', () => {
    expect(productLayer('Microsoft Foundry')).toBe('intelligence');
    expect(productLayer('  MICROSOFT FOUNDRY  ')).toBe('intelligence');
  });

  it('a pack can override the derived blocks', () => {
    const pack = loadPack({ ...samplePack, extensions: { architecture: { asIs: [{ layer: 'data', name: 'Legacy DB' }] } } });
    const blocks = buildArchitecture('asis', pack).layers.flatMap((l) => l.blocks);
    expect(blocks.map((b) => b.label)).toEqual([{ text: 'Legacy DB' }]);
  });

  it('the 3D model stacks the layers and keeps every block', () => {
    const m = buildArchModel(buildArchitecture('tobe', data));
    expect(m.objects.filter((o) => o.kind === 'layer')).toHaveLength(5);
    expect(m.objects.filter((o) => o.kind === 'block')).toHaveLength(products.size);
  });
});

describe('FR-018 core object candidates', () => {
  it('lists products and plants and picks the product with the largest deal value', () => {
    const c = coreObjectChoice(data);
    const kinds = new Set(c.candidates.map((x) => x.kind));
    expect(kinds).toEqual(new Set(['product', 'site']));
    expect(c.candidates.filter((x) => x.kind === 'site').every((x) => data.byId.get(x.id)?.kind === 'site')).toBe(true);
    const products = c.candidates.filter((x) => x.kind === 'product');
    const max = Math.max(...products.map((p) => p.dealValueJpy));
    expect(c.candidates.find((x) => x.id === c.defaultId)!.dealValueJpy).toBe(max);
    expect(c.reason && 'key' in c.reason && c.reason.key).toBe('td.core.reason');
    expect(c.fromPack).toBe(false);
  });

  it('uses the pack coreObject (§3.6) with name ?? label and the pack reason', () => {
    const pack = loadPack({ ...samplePack, extensions: { coreObject: { candidates: [{ label: 'GX Precision Gearbox', summary: 's' }, { name: 'Robot' }], reason: 'Because.', criteria: [{ id: 'c1', label: 'Value' }] } } });
    const c = coreObjectChoice(pack);
    expect(c.fromPack).toBe(true);
    expect(c.candidates.map((x) => x.name)).toEqual(['GX Precision Gearbox', 'Robot']);
    expect(c.candidates[0]!.entityId).toBe('prod-gearbox');
    expect(c.candidates[0]!.siteId).toBe('site-nagoya');
    expect(c.reason).toEqual({ text: 'Because.' });
  });

  it('the twin shows the plant of the core object with the product as hero', () => {
    const c = coreObjectChoice(data);
    const best = c.candidates.find((x) => x.id === c.defaultId)!;
    const twin = buildTwinModel(best, data);
    expect(twin.siteEntityId).toBe(best.siteId);
    expect(twin.heroId).toBe(`twin-p-${best.entityId}`);
    const machine = twin.objects.find((o) => o.kind === 'machine')!;
    expect(ancestry(twin, machine.id).map((o) => o.kind)).toEqual(['site', 'line', 'machine']);
    const sendai = buildTwinModel(c.candidates.find((x) => x.id === 'site-sendai'), data);
    expect(sendai.siteEntityId).toBe('site-sendai');
  });

  it('an organisation without a plant gets an office twin: team lanes holding its work stages, not machines', () => {
    const raw = structuredClone(samplePack);
    for (const e of raw.entities) if (e.kind === 'site' && e.role === 'plant') e.role = 'office';
    raw.extensions = { ...raw.extensions, workflow: { stages: [
      { id: 'st-in', name: '案件の受付', team: '営業', outputs: ['案件リスト'], next: ['st-plan'] },
      { id: 'st-plan', name: '提案', team: '営業', next: ['st-dev'] },
      { id: 'st-dev', name: '技術検証', team: 'エンジニアリング' },
    ] } };
    const office = loadPack(raw);
    const twin = buildTwinModel(coreObjectChoice(office).candidates[0], office);
    expect(twin.office).toBe(true);
    expect(twin.objects.some((o) => o.kind === 'machine' || o.kind === 'product')).toBe(false);
    expect(twin.objects.filter((o) => o.kind === 'team').map((o) => o.label)).toEqual([{ text: '営業' }, { text: 'エンジニアリング' }]);
    const stage = twin.objects.find((o) => o.kind === 'stage' && JSON.stringify(o.label) === JSON.stringify({ text: '技術検証' }))!;
    expect(ancestry(twin, stage.id).map((o) => o.kind)).toEqual(['site', 'team', 'stage']);
  });
});

describe('scene models', () => {
  it('map: every site and flow with both ends resolved, products at LOD 2', () => {
    const m = buildMapModel(data);
    expect(m.objects.filter((o) => o.kind === 'site')).toHaveLength(entitiesOf('site', data).length);
    expect(m.flows).toHaveLength(samplePack.flows.length);
    expect(m.objects.filter((o) => o.kind === 'product').every((o) => o.lod === 2)).toBe(true);
    expect(m.outline.length).toBeGreaterThan(0);
  });

  it('KPI towers: height grows with progress, capped beyond target', () => {
    const m = buildKpiModel(data);
    expect(m.towers).toHaveLength(entitiesOf('kpi', data).length);
    expect(towerHeight(0)).toBeLessThan(towerHeight(0.5));
    expect(towerHeight(1)).toBeCloseTo(0.3 + KPI_FULL_HEIGHT);
    expect(towerHeight(5)).toBe(towerHeight(1.25));
    expect(towerHeight(-1)).toBe(towerHeight(0));
    expect(towerHeight(Number.NaN)).toBe(towerHeight(0));
  });

  it('framing a deep object reaches the deepest LOD; the root stays at LOD 0', () => {
    const twin = buildTwinModel(coreObjectChoice(data).candidates[0], data);
    const machine = twin.objects.find((o) => o.kind === 'machine')!;
    expect(lodForDistance(poseFor(twin, machine, twin.home).distance, twin.lodThresholds)).toBe(2);
    expect(lodForDistance(twin.home.distance, twin.lodThresholds)).toBe(0);
  });
});
