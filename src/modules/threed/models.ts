import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, Geometry, Position } from 'geojson';
import countriesTopo from 'world-atlas/countries-50m.json';
import { entitiesOf, loaded, type LoadedPack } from '../../data/pack.ts';
import { isLocated, type EntityOf } from '../../data/schema.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import type { Audience } from '../../state/settings.ts';
import { ARCH_LAYERS, LAYER_LABEL, type Architecture, type ArchBlock } from './architecture.ts';
import type { SceneModel, SceneObject, Vec3 } from './model.ts';

// ---------------------------------------------------------------- 3D map (FR-021)

interface GeoFrame { lat: number; lon: number; scale: number; cosLat: number; world: boolean }
const JAPAN_FRAME: GeoFrame = { lat: 36.6, lon: 137.0, scale: 2.4, cosLat: Math.cos((36.6 * Math.PI) / 180), world: false };
/** Plate carrée world: about 58 × 26 scene units, the same size as the Japan view. */
const WORLD_FRAME: GeoFrame = { lat: 15, lon: 10, scale: 0.16, cosLat: 1, world: true };

/** Sites abroad switch the 3D map from Japan to the world (a global organisation's locations). */
export function geoFrameFor(sites: { lat: number; lon: number }[]): GeoFrame {
  return sites.some((s) => !(s.lat >= 20 && s.lat <= 46.5 && s.lon >= 122 && s.lon <= 154)) ? WORLD_FRAME : JAPAN_FRAME;
}

/** Equirectangular projection around the frame centre → scene X (east) / Z (south). Default: central Japan. */
export function geoToXZ(lat: number, lon: number, f: GeoFrame = JAPAN_FRAME): [number, number] {
  return [(lon - f.lon) * f.scale * f.cosLat, -(lat - f.lat) * f.scale];
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

let worldCache: [number, number][][] | null = null;
/** Coastlines of every country (outer rings of the larger polygons, thinned), Antarctica left out. */
export function worldOutline(): [number, number][][] {
  if (worldCache) return worldCache;
  const topo = countriesTopo as unknown as Topology<{ countries: GeometryCollection }>;
  const fc = feature(topo, topo.objects.countries) as FeatureCollection<Geometry>;
  const rings: Position[][] = [];
  for (const f of fc.features) {
    if (String(f.id) === '010') continue;
    if (f.geometry.type === 'MultiPolygon') f.geometry.coordinates.forEach((poly) => poly[0] && rings.push(poly[0]));
    else if (f.geometry.type === 'Polygon' && f.geometry.coordinates[0]) rings.push(f.geometry.coordinates[0]);
  }
  worldCache = rings
    .filter((r) => r.length >= 60)
    .map((r) => r.filter((_, i) => i % 6 === 0).map((p) => geoToXZ(p[1]!, p[0]!, WORLD_FRAME)))
    .filter((r) => r.length >= 4);
  return worldCache;
}

export function buildMapModel(data: LoadedPack = loaded, audience: Audience = 'internal'): MapScene {
  const rootId = 'map-root';
  const pos = new Map<string, Vec3>();
  const sites = entitiesOf('site', data).filter((s) => !isHidden(s, audience)).filter(isLocated);
  const frame = geoFrameFor(sites);
  const objects: SceneObject[] = [{ id: rootId, kind: 'country', label: { key: frame.world ? 'td.map.rootWorld' : 'td.map.root' }, level: 0, lod: 0, position: [0, 0, 0], size: 17 }];
  const xz = (lat: number, lon: number) => geoToXZ(lat, lon, frame);
  const capMax = Math.max(1, ...sites.map((s) => s.capacityTPerMonth ?? 0));
  for (const s of sites) {
    const [x, z] = xz(s.lat, s.lon);
    const h = siteHeight(s, capMax);
    pos.set(s.id, [x, 0.2, z]);
    objects.push({ id: `map-${s.id}`, kind: 'site', label: { text: s.name }, detail: { key: `td.map.role.${s.role}` }, parentId: rootId, level: 1, lod: 0, position: [x, h / 2, z], size: frame.world ? 1.6 : 3, entityId: s.id, labelLod: frame.world ? 1 : 0, value: s.capacityTPerMonth });
  }
  for (const r of data.pack.regions) {
    const ll = REGION_LATLON[r.id];
    if (!ll) continue;
    const [x, z] = xz(ll[0], ll[1]);
    pos.set(r.id, [x, 0.2, z]);
    const inflow = data.pack.flows.filter((f) => f.target === r.id).reduce((a, f) => a + f.valueT, 0);
    objects.push({ id: `map-${r.id}`, kind: 'region', label: { text: r.name }, detail: { key: 'td.map.demand' }, parentId: rootId, level: 1, lod: 0, position: [x, 0.3, z], size: 3, labelLod: 1, value: inflow });
  }
  for (const s of entitiesOf('supplier', data).filter((e) => !isHidden(e, audience))) {
    const ll = REGION_LATLON[s.regionId];
    if (!ll) continue;
    const [x, z] = xz(ll[0], ll[1]);
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
    tab: 'map', rootId, objects, flows, outline: frame.world ? worldOutline() : japanOutline(),
    lodThresholds: [30, 11],
    levelNames: ['td.lod.country', 'td.lod.sites', 'td.lod.products'],
    home: { target: [0, 0, -1], distance: 50, azimuth: 0, polar: 0.75 },
    minDistance: 4, maxDistance: 120,
  };
}

export function siteHeight(s: EntityOf<'site'>, capMax: number): number {
  if (s.role === 'office') return 1.6;
  return s.role === 'hq' ? 2.6 : 1 + ((s.capacityTPerMonth ?? 0) / capMax) * 5;
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
