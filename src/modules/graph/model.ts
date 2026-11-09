import type { Edge, LoadedPack, RelationType } from '../../data/pack.ts';
import type { Entity, EntityKind, LText } from '../../data/schema.ts';
import type { FlowKind, KpiStage, Layer, NormalizedGraphExtension, Semantic, TwinKind } from './extensions.ts';

/* ------------------------------------------------------------------ PARAMs */

/** PARAM-077: nodes drawn at once in the business relationship graph (more → aggregated into clusters). */
export const MAX_NODES = 200;
/** PARAM-078: labels shown at once. */
export const MAX_LABELS = 60;
/** PARAM-079: edges between the same two clusters that are bundled into one line. */
export const MIN_BUNDLE = 8;
/** PARAM-080: upper bound for switching the display format (ms). */
export const FORMAT_SWITCH_MS = 2000;
/** PARAM-087: zoom range relative to the fitted view. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** PARAM-088: Shift+arrow pan step in CSS px. */
export const PAN_STEP_PX = 40;
/** PARAM-057: zoom factor per button press / key press. */
export const ZOOM_STEP = 1.25;
/** PARAM-089: highlight duration after a table-row click (ms). */
export const HIGHLIGHT_MS = 2000;
/** PARAM-105: main relations listed in a detail card. */
export const CARD_MAX_RELATIONS = 5;
/** PARAM-023: LOD hysteresis (share of the threshold). */
export const LOD_HYSTERESIS = 0.1;

/* ---------------------------------------------------- FR-235 / FR-236 semantics */

export interface SemanticInfo {
  semantic: Semantic;
  /** true when the meaning flows target → source (e.g. "issue causedBy cause": the cause drives the issue). */
  reversed: boolean;
}

/** Every existing RelationType mapped to one of the nine semantic types (FR-236). */
export const RELATION_SEMANTICS: Record<RelationType, SemanticInfo> = {
  places: { semantic: 'ownership', reversed: false },
  includes: { semantic: 'membership', reversed: false },
  produces: { semantic: 'causality', reversed: false },
  billedAs: { semantic: 'lineage', reversed: false },
  owns: { semantic: 'ownership', reversed: false },
  causedBy: { semantic: 'causality', reversed: true },
  resolves: { semantic: 'influence', reversed: false },
  improves: { semantic: 'influence', reversed: false },
  measuredBy: { semantic: 'measurement', reversed: true },
  implements: { semantic: 'dependency', reversed: false },
  madeAt: { semantic: 'placement', reversed: false },
  worksAt: { semantic: 'membership', reversed: false },
  accountableFor: { semantic: 'control', reversed: false },
  supplies: { semantic: 'dependency', reversed: false },
  citedFrom: { semantic: 'lineage', reversed: true },
};

export const RELATION_TYPES = Object.keys(RELATION_SEMANTICS) as RelationType[];

/** Dash pattern per semantic type so edges are distinguishable without colour (NFR-A11Y-010). */
export const SEMANTIC_DASH: Record<Semantic, string> = {
  influence: '',
  dependency: '8 4',
  causality: '2 3',
  ownership: '10 3 2 3',
  lineage: '4 4',
  membership: '1 4',
  placement: '12 4',
  measurement: '6 2 2 2',
  control: '3 6',
};

export function semanticOf(type: string, ext?: NormalizedGraphExtension): Semantic {
  return ext?.semantics[type]?.semantic ?? RELATION_SEMANTICS[type as RelationType]?.semantic ?? 'influence';
}

/** Customer-language label override from the pack (FR-236 / FR-241), if any. */
export function customLabelOf(type: string, ext?: NormalizedGraphExtension): LText | undefined {
  return ext?.semantics[type]?.label;
}

/* ------------------------------------------------------------ FR-235 suitability */

export const QUESTIONS = ['chain', 'manyToMany', 'reachability', 'centrality'] as const;
export type Question = (typeof QUESTIONS)[number];
export type Recommendation = 'graph' | 'tree' | 'table';

export interface Suitability {
  suitable: boolean;
  /** Reason key suffix (graph.suit.reason.<reason>). */
  reason: 'transitive' | 'notTransitive' | 'needsDirection' | 'hierarchy' | 'manyToMany' | 'reachable' | 'metricEndpoint' | 'centralHub' | 'treePosition';
  recommend: Recommendation;
}

/** Semantics whose chains are meaningful (A→B→C means A affects C). */
const TRANSITIVE: Semantic[] = ['influence', 'dependency', 'causality', 'lineage', 'control'];
/** Strict hierarchies: each child has one parent, so a tree or table reads better than a graph. */
const HIERARCHICAL: Semantic[] = ['ownership', 'placement'];

/**
 * FR-235 graph-suitability criteria: decide from the semantic type, the direction and the user's question whether a
 * node-link graph is the right representation, with a reason.
 */
export function assessSuitability(semantic: Semantic, directed: boolean, question: Question): Suitability {
  switch (question) {
    case 'chain':
      if (!directed) return { suitable: false, reason: 'needsDirection', recommend: 'table' };
      if (!TRANSITIVE.includes(semantic)) return { suitable: false, reason: 'notTransitive', recommend: HIERARCHICAL.includes(semantic) ? 'tree' : 'table' };
      return { suitable: true, reason: 'transitive', recommend: 'graph' };
    case 'manyToMany':
      if (HIERARCHICAL.includes(semantic)) return { suitable: false, reason: 'hierarchy', recommend: 'tree' };
      return { suitable: true, reason: 'manyToMany', recommend: 'graph' };
    case 'reachability':
      if (semantic === 'measurement') return { suitable: false, reason: 'metricEndpoint', recommend: 'table' };
      if (!directed && TRANSITIVE.includes(semantic)) return { suitable: false, reason: 'needsDirection', recommend: 'table' };
      return { suitable: true, reason: 'reachable', recommend: 'graph' };
    case 'centrality':
      if (HIERARCHICAL.includes(semantic) || semantic === 'measurement') return { suitable: false, reason: 'treePosition', recommend: semantic === 'measurement' ? 'table' : 'tree' };
      return { suitable: true, reason: 'centralHub', recommend: 'graph' };
  }
}

/* --------------------------------------------- FR-212/213/214 world & twin */

export type WorldFilter = 'real' | 'digital' | 'both';

export interface Classified {
  id: string;
  world: Entity['world'];
  type: Entity['type'];
  kind: EntityKind;
  /** Cluster key used at the overview level (world/type). */
  cluster: string;
  layer?: Layer;
}

export const clusterKey = (e: Pick<Entity, 'world' | 'type'>) => `cl:${e.world}:${e.type}`;

/** Default Twin layer of a digital entity (FR-239), overridable by the pack. */
export function defaultLayer(e: Entity): Layer {
  if (e.world !== 'digital') return 'operations';
  if (e.kind === 'invoice') return 'operations';
  switch (e.type) {
    case 'system': return 'operations';
    case 'ui-component': return 'experience';
    default: return 'insights';
  }
}

export function classify(e: Entity, ext?: NormalizedGraphExtension): Classified {
  return {
    id: e.id,
    world: e.world,
    type: e.type,
    kind: e.kind,
    cluster: clusterKey(e),
    ...(e.world === 'digital' ? { layer: ext?.layers[e.id] ?? defaultLayer(e) } : {}),
  };
}

export function matchesWorld(e: Pick<Entity, 'world'>, filter: WorldFilter): boolean {
  return filter === 'both' || e.world === filter;
}

export interface TwinRelation {
  digital: string;
  real: string;
  kind: TwinKind;
  /** Where it came from: an existing edge, a derived rule, or the customer pack. */
  origin: 'edge' | 'derived' | 'pack';
}

/** Twin kind implied by the digital entity's §3.7 type. */
export function twinKindForType(type: Entity['type']): TwinKind {
  switch (type) {
    case 'metric': return 'measures';
    case 'data': return 'records';
    case 'ui-component': return 'displays';
    default: return 'represents';
  }
}

/** Relation types that express a real↔digital correspondence (others, e.g. solution resolves issue, do not). */
const TWIN_EDGE_TYPES: RelationType[] = ['billedAs', 'measuredBy', 'implements', 'citedFrom'];

/**
 * FR-214: derive twin relations between real-world and digital entities:
 * - from existing edges (invoice records deliverable, KPI measures issue, solution represents operation, source records);
 * - KPI measures the site of its owner;
 * - plus explicit twins from the customer pack.
 */
export function deriveTwins(data: LoadedPack, ext?: NormalizedGraphExtension): TwinRelation[] {
  const out: TwinRelation[] = [];
  const seen = new Set<string>();
  const add = (digital: string, real: string, kind: TwinKind, origin: TwinRelation['origin']) => {
    const key = `${digital}|${real}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ digital, real, kind, origin });
  };
  for (const edge of data.edges) {
    if (!TWIN_EDGE_TYPES.includes(edge.type)) continue;
    const s = data.byId.get(edge.source), t = data.byId.get(edge.target);
    if (!s || !t || s.world === t.world) continue;
    const digital = s.world === 'digital' ? s : t;
    const real = digital === s ? t : s;
    add(digital.id, real.id, twinKindForType(digital.type), 'edge');
  }
  for (const e of data.pack.entities) {
    if (e.kind !== 'kpi') continue;
    const owner = data.byId.get(e.ownerId);
    if (owner?.kind === 'person' && data.byId.has(owner.siteId)) add(e.id, owner.siteId, 'measures', 'derived');
  }
  for (const tw of ext?.twins ?? []) {
    const d = data.byId.get(tw.digital), r = data.byId.get(tw.real);
    if (d?.world === 'digital' && r?.world === 'real') add(d.id, r.id, tw.kind, 'pack');
  }
  return out;
}

export interface TwinFlow {
  source: string;
  target: string;
  kind: FlowKind;
  label?: LText;
  twin?: TwinKind;
}

/** FR-239: measures/records → Data (real → digital); represents/displays → Control (digital → real); plus pack flows. */
export function deriveFlows(twins: TwinRelation[], ext?: NormalizedGraphExtension): TwinFlow[] {
  const flows: TwinFlow[] = twins.map((tw) => (tw.kind === 'measures' || tw.kind === 'records'
    ? { source: tw.real, target: tw.digital, kind: 'data' as const, twin: tw.kind }
    : { source: tw.digital, target: tw.real, kind: 'control' as const, twin: tw.kind }));
  for (const f of ext?.flows ?? []) flows.push({ source: f.source, target: f.target, kind: f.kind, ...(f.label ? { label: f.label } : {}) });
  return flows;
}

export function kpiStageOf(id: string, ext?: NormalizedGraphExtension): KpiStage | undefined {
  return ext?.kpiStages[id];
}

/* --------------------------------------- FR-236 clustering, bundling, labels */

export interface SimpleEdge { source: string; target: string; type: string }

export interface Aggregation {
  /** Node ids that stay individual. */
  nodes: string[];
  /** Clusters replacing their members: cluster id → member ids. */
  clusters: Map<string, string[]>;
  /** Maps an entity id to the id it is drawn as (itself or its cluster). */
  drawnAs: Map<string, string>;
}

/**
 * PARAM-077: when more than `limit` nodes would be drawn, collapse the largest groups into one cluster node each
 * until the drawn count fits.
 */
export function aggregateNodes(ids: string[], groupOf: (id: string) => string, limit = MAX_NODES): Aggregation {
  const drawnAs = new Map(ids.map((id) => [id, id] as const));
  const clusters = new Map<string, string[]>();
  if (ids.length <= limit) return { nodes: [...ids], clusters, drawnAs };
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const g = groupOf(id);
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  let count = ids.length;
  for (const [g, members] of order) {
    if (count <= limit) break;
    if (members.length < 2) continue;
    clusters.set(g, members);
    members.forEach((m) => drawnAs.set(m, g));
    count -= members.length - 1;
  }
  const collapsed = new Set([...clusters.values()].flat());
  return { nodes: ids.filter((id) => !collapsed.has(id)), clusters, drawnAs };
}

export interface Bundle { a: string; b: string; edges: SimpleEdge[] }

/**
 * PARAM-079: edges whose endpoints map to the same unordered pair of drawn nodes are bundled into one line when
 * there are at least `min` of them; otherwise they stay individual (self-loops inside a cluster are dropped).
 */
export function bundleEdges(edges: SimpleEdge[], drawnAs: (id: string) => string, min = MIN_BUNDLE): { bundles: Bundle[]; loose: (SimpleEdge & { from: string; to: string })[] } {
  const pairs = new Map<string, Bundle>();
  for (const e of edges) {
    const a = drawnAs(e.source), b = drawnAs(e.target);
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const p = pairs.get(key) ?? { a: a < b ? a : b, b: a < b ? b : a, edges: [] };
    p.edges.push(e);
    pairs.set(key, p);
  }
  const bundles: Bundle[] = [];
  const loose: (SimpleEdge & { from: string; to: string })[] = [];
  for (const p of pairs.values()) {
    if (p.edges.length >= min) bundles.push(p);
    else p.edges.forEach((e) => loose.push({ ...e, from: drawnAs(e.source), to: drawnAs(e.target) }));
  }
  return { bundles, loose };
}

/**
 * PARAM-078: choose which labels are visible. Pinned ids (selection / highlight) come first, then nodes by priority
 * (up to 60 % of the budget), then edges; budget left over by one group is given to the other.
 */
export function allocateLabels(nodeIds: string[], edgeIds: string[], pinned: string[] = [], max = MAX_LABELS): Set<string> {
  const out = new Set<string>();
  for (const id of pinned) if (out.size < max && (nodeIds.includes(id) || edgeIds.includes(id))) out.add(id);
  const nodeBudget = Math.max(0, Math.ceil(max * 0.6) - out.size);
  const nodesLeft = nodeIds.filter((id) => !out.has(id));
  const edgesLeft = edgeIds.filter((id) => !out.has(id));
  const nodeTake = Math.min(nodesLeft.length, Math.max(nodeBudget, max - out.size - edgesLeft.length));
  nodesLeft.slice(0, nodeTake).forEach((id) => out.add(id));
  for (const id of edgesLeft) { if (out.size >= max) break; out.add(id); }
  for (const id of nodesLeft.slice(nodeTake)) { if (out.size >= max) break; out.add(id); }
  return out;
}

export function degrees(edges: { source: string; target: string }[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of edges) {
    d.set(e.source, (d.get(e.source) ?? 0) + 1);
    d.set(e.target, (d.get(e.target) ?? 0) + 1);
  }
  return d;
}

/* -------------------------------------------- FR-237 semantic zoom, FR-245 */

export const LEVELS = ['overview', 'element', 'detail'] as const;
export type Level = (typeof LEVELS)[number];

/** Zoom factor (relative to fit) at which the next level is entered / the previous one left. */
export const LEVEL_IN = 2;
export const LEVEL_OUT = 0.5;

/**
 * FR-237: pick the semantic level from the zoom factor and the selection, with PARAM-023 hysteresis. Zooming in past
 * LEVEL_IN×(1+h) goes one level deeper (detail needs a selected element); zooming out below LEVEL_OUT×(1−h) goes up.
 * Returns the same level when no threshold is crossed.
 */
export function selectLevel(current: Level, zoom: number, hasSelection: boolean): Level {
  const i = LEVELS.indexOf(current);
  if (zoom >= LEVEL_IN * (1 + LOD_HYSTERESIS)) {
    if (current === 'overview') return 'element';
    if (current === 'element' && hasSelection) return 'detail';
    return current;
  }
  if (zoom <= LEVEL_OUT * (1 - LOD_HYSTERESIS) && i > 0) return LEVELS[i - 1]!;
  return current;
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export function zoomBy(z: number, direction: 1 | -1): number {
  return clampZoom(direction > 0 ? z * ZOOM_STEP : z / ZOOM_STEP);
}

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/** FR-245: Shift+arrow pans the view by PARAM-088 px; content moves opposite to the "camera". */
export function panBy(pan: { x: number; y: number }, key: ArrowKey, step = PAN_STEP_PX): { x: number; y: number } {
  switch (key) {
    case 'ArrowLeft': return { x: pan.x + step, y: pan.y };
    case 'ArrowRight': return { x: pan.x - step, y: pan.y };
    case 'ArrowUp': return { x: pan.x, y: pan.y + step };
    case 'ArrowDown': return { x: pan.x, y: pan.y - step };
  }
}

/** Pan offset (in drawing units) that puts point p at the centre for the given scale. */
export function centreOn(p: { x: number; y: number }, centre: { x: number; y: number }, scale: number): { x: number; y: number } {
  return { x: (centre.x - p.x) * scale, y: (centre.y - p.y) * scale };
}

/** "Show at most N, then 'and M more'" (PARAM-105). */
export function topN<T>(items: T[], n = CARD_MAX_RELATIONS): { shown: T[]; more: number } {
  return { shown: items.slice(0, n), more: Math.max(0, items.length - n) };
}

/* ----------------------------------------------------------- FR-240 spatial */

export interface SpatialRoom { id: string; floorId: string; index: number; purpose: 'office' | 'production' | 'warehouse' | 'meeting'; people: string[]; equipment: string[]; kpis: string[] }
export interface SpatialFloor { id: string; siteId: string; level: number; rooms: SpatialRoom[] }
export interface SpatialSite { siteId: string; floors: SpatialFloor[]; kpis: string[] }

const FLOORS_BY_ROLE: Record<string, number> = { hq: 3, plant: 2, dc: 1 };

/**
 * FR-240: deterministic spatial hierarchy for packs without floor plans: whole → site → floor → room/equipment.
 * Floors per site role (HQ 3, plant 2, DC 1). Plants: floor 1 = production (products as equipment lines), upper floors
 * = office. DCs: warehouse. People are spread over office rooms in id order. KPIs sit in their owner's room.
 */
export function deriveSpatial(data: LoadedPack, visible: (id: string) => boolean = () => true): SpatialSite[] {
  const sites = data.pack.entities.filter((e): e is Extract<Entity, { kind: 'site' }> => e.kind === 'site' && visible(e.id));
  const people = data.pack.entities.filter((e): e is Extract<Entity, { kind: 'person' }> => e.kind === 'person' && visible(e.id)).sort((a, b) => a.id.localeCompare(b.id));
  const products = data.pack.entities.filter((e): e is Extract<Entity, { kind: 'product' }> => e.kind === 'product' && visible(e.id));
  const kpis = data.pack.entities.filter((e): e is Extract<Entity, { kind: 'kpi' }> => e.kind === 'kpi' && visible(e.id));
  return sites.map((site) => {
    const floorCount = FLOORS_BY_ROLE[site.role] ?? 1;
    const floors: SpatialFloor[] = [];
    for (let level = 1; level <= floorCount; level++) {
      const floorId = `sp:${site.id}:f${level}`;
      const purpose: SpatialRoom['purpose'] = site.role === 'dc' ? 'warehouse' : site.role === 'plant' && level === 1 ? 'production' : level === floorCount && site.role === 'hq' ? 'meeting' : 'office';
      floors.push({ id: floorId, siteId: site.id, level, rooms: [{ id: `${floorId}:r1`, floorId, index: 1, purpose, people: [], equipment: [], kpis: [] }] });
    }
    const productionRoom = floors[0]!.rooms[0]!;
    products.filter((p) => p.siteId === site.id).forEach((p) => productionRoom.equipment.push(p.id));
    const officeRooms = floors.flatMap((f) => f.rooms).filter((r) => r.purpose === 'office' || r.purpose === 'meeting' || site.role === 'dc');
    const rooms = officeRooms.length ? officeRooms : floors.flatMap((f) => f.rooms);
    const here = people.filter((p) => p.siteId === site.id);
    here.forEach((p, i) => rooms[i % rooms.length]!.people.push(p.id));
    const siteKpis: string[] = [];
    for (const k of kpis) {
      const room = rooms.find((r) => r.people.includes(k.ownerId));
      if (room) {
        room.kpis.push(k.id);
        siteKpis.push(k.id);
      }
    }
    return { siteId: site.id, floors, kpis: siteKpis };
  });
}

export type { Edge };
