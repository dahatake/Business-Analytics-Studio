import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, Geometry, Position } from 'geojson';
import countriesTopo from 'world-atlas/countries-50m.json';
import { entitiesOf, getEntity, loaded, type LoadedPack } from '../../data/pack.ts';
import type { EntityOf } from '../../data/schema.ts';
import type { MessageKey } from '../../i18n/core.ts';
import { kpiProgress, kpiStatus, type KpiStatus } from '../../domain/kpi.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import type { Audience } from '../../state/settings.ts';
import type { CoreCandidate } from './coreObject.ts';
import { ARCH_LAYERS, LAYER_LABEL, type Architecture, type ArchBlock } from './architecture.ts';
import type { SceneModel, SceneObject, Vec3 } from './model.ts';

// ---------------------------------------------------------------- digital twin (FR-020)

export type TwinStep = 'receiving' | 'machining' | 'assembly' | 'inspection' | 'packing';
export const TWIN_STEPS: TwinStep[] = ['receiving', 'machining', 'assembly', 'inspection', 'packing'];
export const STEP_LABEL: Record<TwinStep, MessageKey> = {
  receiving: 'td.twin.step.receiving',
  machining: 'td.twin.step.machining',
  assembly: 'td.twin.step.assembly',
  inspection: 'td.twin.step.inspection',
  packing: 'td.twin.step.packing',
};

export interface TwinLine {
  id: string;
  z: number;
  productId?: string;
  hue: number;
  machines: { id: string; step: TwinStep; x: number }[];
}

export interface TwinScene extends SceneModel {
  floor: { width: number; depth: number };
  lines: TwinLine[];
  heroId: string | undefined;
  siteEntityId: string | undefined;
}

export const TWIN_LINE_SPACING = 7;
export const TWIN_MACHINE_X0 = -15;
export const TWIN_MACHINE_STEP = 6.5;
export const TWIN_PRODUCT_X = 17;

/** Procedural plant of the core object: site → production lines → machines and products (no external assets, FR-068). */
export function buildTwinModel(core: CoreCandidate | undefined, data: LoadedPack = loaded, audience: Audience = 'internal'): TwinScene {
  const site = core?.siteId ? getEntity(core.siteId, data) : undefined;
  const siteEntity = site?.kind === 'site' ? site : entitiesOf('site', data).find((s) => s.role === 'plant');
  const products = entitiesOf('product', data).filter((p) => p.siteId === siteEntity?.id && !isHidden(p, audience));
  const heroEntityId = core?.entityId && products.some((p) => p.id === core.entityId) ? core.entityId : products[0]?.id;
  const lineCount = Math.max(1, products.length);
  const depth = lineCount * TWIN_LINE_SPACING + 8;
  const objects: SceneObject[] = [];
  const rootId = 'twin-site';
  objects.push({
    id: rootId, kind: 'site', label: siteEntity ? { text: siteEntity.name } : { key: 'td.twin.genericSite' },
    level: 0, lod: 0, position: [0, 0, 0], size: Math.max(20, depth * 0.9), entityId: siteEntity?.id, labelLod: 0,
  });
  const lines: TwinLine[] = [];
  for (let k = 0; k < lineCount; k++) {
    const product = products[k];
    const z = (k - (lineCount - 1) / 2) * TWIN_LINE_SPACING;
    const lineId = `twin-line-${k + 1}`;
    objects.push({
      id: lineId, kind: 'line', parentId: rootId, level: 1, lod: 0, position: [-1, 0.6, z], size: 12, labelLod: 1,
      label: product ? { key: 'td.twin.line', vars: { n: k + 1, product: product.name } } : { key: 'td.twin.lineGeneric', vars: { n: k + 1 } },
    });
    const machines = TWIN_STEPS.map((step, i) => {
      const id = `twin-m-${k + 1}-${i + 1}`;
      const x = TWIN_MACHINE_X0 + i * TWIN_MACHINE_STEP;
      objects.push({
        id, kind: 'machine', parentId: lineId, level: 2, lod: 1, position: [x, 1.4, z], size: 4.5, labelLod: 2,
        label: { key: STEP_LABEL[step] }, detail: { key: 'td.twin.machineDetail', vars: { line: k + 1, n: i + 1 } },
      });
      return { id, step, x };
    });
    if (product) {
      objects.push({
        id: `twin-p-${product.id}`, kind: 'product', parentId: lineId, level: 2, lod: product.id === heroEntityId ? 0 : 1,
        position: [TWIN_PRODUCT_X, 1.8, z], size: 4.5, entityId: product.id, labelLod: product.id === heroEntityId ? 0 : 1,
        label: { text: product.name }, detail: { text: product.category },
      });
    }
    lines.push({ id: lineId, z, productId: product?.id, hue: product?.illustration.hue ?? 200, machines });
  }
  return {
    tab: 'twin', rootId, objects,
    lodThresholds: [40, 18],
    levelNames: ['td.lod.site', 'td.lod.line', 'td.lod.machine'],
    home: { target: [0, 0, 0], distance: 54, azimuth: -0.6, polar: 0.95 },
    minDistance: 4, maxDistance: 140,
    floor: { width: 44, depth },
    lines,
    heroId: heroEntityId ? `twin-p-${heroEntityId}` : undefined,
    siteEntityId: siteEntity?.id,
  };
}

// ---------------------------------------------------------------- 3D map (FR-021)

const GEO_CENTER = { lat: 36.6, lon: 137.0 };
const GEO_SCALE = 2.4;
const COS_LAT = Math.cos((GEO_CENTER.lat * Math.PI) / 180);

/** Equirectangular projection around central Japan → scene X (east) / Z (south). */
export function geoToXZ(lat: number, lon: number): [number, number] {
  return [(lon - GEO_CENTER.lon) * GEO_SCALE * COS_LAT, -(lat - GEO_CENTER.lat) * GEO_SCALE];
}

/** Approximate centres of the sample regions (pack regions carry no coordinates). */
export const REGION_LATLON: Record<string, [number, number]> = {
  'region-kanto': [36.0, 139.9],
  'region-chubu': [36.0, 137.9],
  'region-kansai': [34.6, 135.0],
  'region-kyushu': [32.6, 130.6],
  'region-tohoku': [39.4, 141.0],
};

export interface FlowArc {
  id: string;
  from: string;
  to: string;
  fromPos: Vec3;
  toPos: Vec3;
  valueT: number;
}

export interface MapScene extends SceneModel {
  flows: FlowArc[];
  /** Coastline rings in scene X/Z (main islands only). */
  outline: [number, number][][];
}

let outlineCache: [number, number][][] | null = null;
export function japanOutline(): [number, number][][] {
  if (outlineCache) return outlineCache;
  const topo = countriesTopo as unknown as Topology<{ countries: GeometryCollection }>;
  const fc = feature(topo, topo.objects.countries) as FeatureCollection<Geometry>;
  const japan = fc.features.find((f) => String(f.id) === '392');
  const rings: Position[][] = [];
  if (japan?.geometry.type === 'MultiPolygon') japan.geometry.coordinates.forEach((poly) => poly[0] && rings.push(poly[0]));
  else if (japan?.geometry.type === 'Polygon' && japan.geometry.coordinates[0]) rings.push(japan.geometry.coordinates[0]);
  outlineCache = rings
    .filter((r) => r.length >= 40)
    .map((r) => r.filter((_, i) => i % 2 === 0).map((p) => geoToXZ(p[1]!, p[0]!)));
  return outlineCache;
}

export function buildMapModel(data: LoadedPack = loaded, audience: Audience = 'internal'): MapScene {
  const rootId = 'map-root';
  const objects: SceneObject[] = [{ id: rootId, kind: 'country', label: { key: 'td.map.root' }, level: 0, lod: 0, position: [0, 0, 0], size: 17 }];
  const pos = new Map<string, Vec3>();
  const sites = entitiesOf('site', data).filter((s) => !isHidden(s, audience));
  const capMax = Math.max(1, ...sites.map((s) => s.capacityTPerMonth));
  for (const s of sites) {
    const [x, z] = geoToXZ(s.lat, s.lon);
    const h = siteHeight(s, capMax);
    pos.set(s.id, [x, 0.2, z]);
    objects.push({ id: `map-${s.id}`, kind: 'site', label: { text: s.name }, detail: { key: `td.map.role.${s.role}` }, parentId: rootId, level: 1, lod: 0, position: [x, h / 2, z], size: 3, entityId: s.id, labelLod: 0, value: s.capacityTPerMonth });
  }
  for (const r of data.pack.regions) {
    const ll = REGION_LATLON[r.id];
    if (!ll) continue;
    const [x, z] = geoToXZ(ll[0], ll[1]);
    pos.set(r.id, [x, 0.2, z]);
    const inflow = data.pack.flows.filter((f) => f.target === r.id).reduce((a, f) => a + f.valueT, 0);
    objects.push({ id: `map-${r.id}`, kind: 'region', label: { text: r.name }, detail: { key: 'td.map.demand' }, parentId: rootId, level: 1, lod: 0, position: [x, 0.3, z], size: 3, labelLod: 1, value: inflow });
  }
  for (const s of entitiesOf('supplier', data).filter((e) => !isHidden(e, audience))) {
    const ll = REGION_LATLON[s.regionId];
    if (!ll) continue;
    const [x, z] = geoToXZ(ll[0], ll[1]);
    const p: Vec3 = [x - 1.6, 0.2, z + 1.4];
    pos.set(s.id, p);
    const outflow = data.pack.flows.filter((f) => f.source === s.id).reduce((a, f) => a + f.valueT, 0);
    objects.push({ id: `map-${s.id}`, kind: 'supplier', label: { text: s.name }, detail: { key: 'td.map.supplier' }, parentId: rootId, level: 1, lod: 0, position: [p[0], 1, p[2]], size: 3, entityId: s.id, labelLod: 1, value: outflow });
  }
  for (const s of sites) {
    const made = entitiesOf('product', data).filter((p) => p.siteId === s.id && !isHidden(p, audience));
    const base = pos.get(s.id)!;
    made.forEach((p, i) => {
      const a = (i / Math.max(1, made.length)) * Math.PI * 2 + 0.6;
      objects.push({ id: `map-${p.id}`, kind: 'product', label: { text: p.name }, detail: { text: p.category }, parentId: `map-${s.id}`, level: 2, lod: 2, position: [base[0] + Math.cos(a) * 1.7, 0.6, base[2] + Math.sin(a) * 1.7], size: 1.2, entityId: p.id, labelLod: 2 });
    });
  }
  const flows: FlowArc[] = [];
  data.pack.flows.forEach((f, i) => {
    const a = pos.get(f.source);
    const b = pos.get(f.target);
    if (a && b) flows.push({ id: `flow-${i}`, from: f.source, to: f.target, fromPos: a, toPos: b, valueT: f.valueT });
  });
  return {
    tab: 'map', rootId, objects, flows, outline: japanOutline(),
    lodThresholds: [30, 11],
    levelNames: ['td.lod.country', 'td.lod.sites', 'td.lod.products'],
    home: { target: [0, 0, -1], distance: 50, azimuth: 0, polar: 0.75 },
    minDistance: 4, maxDistance: 120,
  };
}

export function siteHeight(s: EntityOf<'site'>, capMax: number): number {
  return s.role === 'hq' ? 2.6 : 1 + (s.capacityTPerMonth / capMax) * 5;
}

// ---------------------------------------------------------------- KPI towers (§7 executive view)

export interface KpiTower {
  id: string;
  kpiId: string;
  x: number;
  height: number;
  progress: number;
  status: KpiStatus;
}

export interface KpiScene extends SceneModel {
  towers: KpiTower[];
  /** Height of a tower at 100 % (target). */
  fullHeight: number;
}

export const KPI_FULL_HEIGHT = 10;
export const KPI_SPACING = 4.5;

/** Tower height for a progress value: 0 % → stub, 100 % → full height, capped at 125 % (beyond target). */
export function towerHeight(progress: number): number {
  const p = Number.isFinite(progress) ? Math.min(1.25, Math.max(0, progress)) : 0;
  return 0.3 + p * KPI_FULL_HEIGHT;
}

export function buildKpiModel(data: LoadedPack = loaded, audience: Audience = 'internal'): KpiScene {
  const kpis = entitiesOf('kpi', data).filter((k) => !isHidden(k, audience));
  const rootId = 'kpi-root';
  const objects: SceneObject[] = [{ id: rootId, kind: 'kpis', label: { key: 'td.kpi.root' }, level: 0, lod: 0, position: [0, 4, 0], size: Math.max(12, kpis.length * 2.4) }];
  const towers: KpiTower[] = kpis.map((k, i) => {
    const x = (i - (kpis.length - 1) / 2) * KPI_SPACING;
    const progress = kpiProgress(k);
    const height = towerHeight(progress);
    objects.push({ id: `kpi-${k.id}`, kind: 'kpi', label: { text: k.name }, parentId: rootId, level: 1, lod: 0, position: [x, height / 2, 0], size: 4, entityId: k.id, labelLod: 0, value: progress });
    return { id: `kpi-${k.id}`, kpiId: k.id, x, height, progress, status: kpiStatus(k) };
  });
  return {
    tab: 'kpi', rootId, objects, towers, fullHeight: KPI_FULL_HEIGHT,
    lodThresholds: [22],
    levelNames: ['td.lod.overview', 'td.lod.targets'],
    home: { target: [0, 4, 0], distance: 36, azimuth: -0.35, polar: 1.15 },
    minDistance: 4, maxDistance: 100,
  };
}

// ---------------------------------------------------------------- architecture (FR-040)

export interface ArchScene extends SceneModel {
  arch: Architecture;
  layerY: Record<string, number>;
  blocks: (ArchBlock & { pos: Vec3 })[];
}

export const ARCH_LAYER_GAP = 4.2;
export const ARCH_BLOCK_SPACING = 6.6;

export function buildArchModel(arch: Architecture): ArchScene {
  const rootId = 'arch-root';
  const objects: SceneObject[] = [{ id: rootId, kind: 'arch', label: { key: arch.mode === 'asis' ? 'td.arch.asis' : 'td.arch.tobe' }, level: 0, lod: 0, position: [0, 8, 0], size: 16 }];
  const layerY: Record<string, number> = {};
  const blocks: ArchScene['blocks'] = [];
  ARCH_LAYERS.forEach((id, i) => {
    const y = i * ARCH_LAYER_GAP;
    layerY[id] = y;
    const layer = arch.layers.find((l) => l.id === id)!;
    const layerId = `arch-layer-${id}`;
    objects.push({ id: layerId, kind: 'layer', label: { key: LAYER_LABEL[id] }, parentId: rootId, level: 1, lod: 0, position: [0, y, 0], size: 13, labelLod: 0, value: layer.blocks.length });
    const perRow = 5;
    layer.blocks.forEach((b, j) => {
      const row = Math.floor(j / perRow);
      const inRow = Math.min(perRow, layer.blocks.length - row * perRow);
      const x = ((j % perRow) - (inRow - 1) / 2) * ARCH_BLOCK_SPACING;
      const z = row * 3.4 - (Math.ceil(layer.blocks.length / perRow) - 1) * 1.7;
      const pos: Vec3 = [x, y + 0.9, z];
      blocks.push({ ...b, pos });
      objects.push({ id: b.id, kind: 'block', label: b.label, detail: { key: `td.arch.role.${b.role}` }, parentId: layerId, level: 2, lod: 0, position: pos, size: 3.2, entityId: b.entityId, labelLod: 1 });
    });
  });
  return {
    tab: 'arch', rootId, objects, arch, layerY, blocks,
    lodThresholds: [44],
    levelNames: ['td.lod.layers', 'td.lod.blocks'],
    home: { target: [0, 8, 0], distance: 38, azimuth: -0.5, polar: 1.05 },
    minDistance: 5, maxDistance: 120,
  };
}
