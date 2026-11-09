import type { LoadedPack } from '../../data/pack.ts';
import type { Entity, EntityKind, LText } from '../../data/schema.ts';
import type { MessageKey, Vars } from '../../i18n/index.ts';
import { kindColor, kindShape } from '../../ui/icons.ts';
import { kpiProgress } from '../../domain/kpi.ts';
import type { ExtensionResult, FlowKind, Layer, Semantic, TwinKind } from './extensions.ts';
import { LAYERS } from './extensions.ts';
import {
  aggregateNodes, allocateLabels, bundleEdges, classify, customLabelOf, degrees, deriveFlows, deriveSpatial, deriveTwins,
  kpiStageOf, matchesWorld, RELATION_SEMANTICS, semanticOf, type Level, type SimpleEdge, type WorldFilter,
} from './model.ts';

export type GraphView = 'relations' | 'twin' | 'spatial';
export type NodeShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon' | 'rect';

export interface InfoRow { label: string; value: string }

export interface SceneNode {
  id: string;
  label: string;
  /** Accessible name: kind + name (+ value). */
  aria: string;
  /** Entity behind the node → the shared entity detail card. Otherwise the module's own card. */
  entityId?: string;
  role: 'entity' | 'cluster' | 'attribute' | 'area';
  shape: NodeShape;
  color: string;
  size: number;
  /** Row / lane used by the 2D and 3D layouts. */
  lane: number;
  /** Column group within the lane (2D). */
  group: string;
  info: InfoRow[];
  /** Relations listed in the card (PARAM-105 limits how many are shown). */
  relations: string[];
  /** Spatial nesting box (2D spatial layout), in drawing units. */
  box?: { x: number; y: number; w: number; h: number };
  degree: number;
}

export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  aria: string;
  semantic?: Semantic;
  flow?: FlowKind;
  twin?: TwinKind;
  count: number;
  bundled: boolean;
  info: InfoRow[];
  members: string[];
  /** Index among parallel edges between the same pair (for curvature). */
  parallel: number;
  /** Containment edge (spatial graph format). */
  contains?: boolean;
}

export interface Scene {
  view: GraphView;
  level: Level;
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Ids (node or edge) whose label is drawn (PARAM-078). */
  labelled: Set<string>;
  /** Lane captions for 2D/3D layouts. */
  lanes: { lane: number; label: string }[];
  /** Entities aggregated into clusters because of PARAM-077. */
  aggregated: number;
  focusId?: string;
}

export interface SceneInput {
  data: LoadedPack;
  ext: ExtensionResult;
  view: GraphView;
  level: Level;
  world: WorldFilter;
  showTwins: boolean;
  selected?: string | null;
  pinned?: string[];
  visible: (e: Entity) => boolean;
  t: (key: MessageKey, vars?: Vars) => string;
  tx: (text: LText) => string;
  fmtNumber: (n: number) => string;
}

const SHAPE_CLUSTER: Record<string, NodeShape> = { real: 'hexagon', digital: 'diamond' };

const kindShapeOf = (k: EntityKind): NodeShape => kindShape[k];

function entityNode(e: Entity, inp: SceneInput, lane: number, group: string, degree: number, extraLabel?: string): SceneNode {
  const { t, tx } = inp;
  const name = tx(e.name);
  const label = extraLabel ? `${name} ${extraLabel}` : name;
  const c = classify(e, inp.ext.ext);
  const info: InfoRow[] = [
    { label: t('graph.attr.world'), value: t(`world.${e.world}`) },
    { label: t('graph.attr.type'), value: t(`graph.type.${e.type}`) },
  ];
  if (c.layer) info.push({ label: t('graph.attr.layer'), value: t(`graph.layer.${c.layer}`) });
  return {
    id: e.id, label, aria: `${t(`kind.${e.kind}`)}: ${label}`, entityId: e.id, role: 'entity', shape: kindShapeOf(e.kind),
    color: kindColor[e.kind], size: 1, lane, group, info, relations: [], degree,
  };
}

function relationLabel(edge: SimpleEdge, inp: SceneInput): string {
  const custom = customLabelOf(edge.type, inp.ext.ext);
  if (custom) return inp.tx(custom);
  if (edge.type in RELATION_SEMANTICS) return inp.t(`relation.${edge.type as keyof typeof RELATION_SEMANTICS}`);
  return inp.t(`graph.sem.${semanticOf(edge.type, inp.ext.ext)}`);
}

interface RelEdge extends SimpleEdge { semantic: Semantic; label: string; twin?: TwinKind; flow?: FlowKind }

/** All semantic-labelled relations between visible entities (pack edges + pack extra relations). */
function relationEdges(inp: SceneInput, keep: (id: string) => boolean): RelEdge[] {
  const out: RelEdge[] = [];
  for (const e of inp.data.edges) {
    if (!keep(e.source) || !keep(e.target)) continue;
    out.push({ ...e, semantic: semanticOf(e.type, inp.ext.ext), label: relationLabel(e, inp) });
  }
  inp.ext.ext.relations.forEach((r, i) => {
    if (!keep(r.source) || !keep(r.target)) return;
    const type = `x${i}`;
    out.push({ source: r.source, target: r.target, type, semantic: r.semantic, label: r.label ? inp.tx(r.label) : inp.t(`graph.sem.${r.semantic}`) });
  });
  return out;
}

function nameOf(id: string, inp: SceneInput): string {
  const e = inp.data.byId.get(id);
  return e ? inp.tx(e.name) : id;
}

function edgeText(from: string, label: string, to: string) {
  return `${from} → ${label} → ${to}`;
}

function finish(scene: Omit<Scene, 'labelled'>, inp: SceneInput): Scene {
  // Parallel index for curvature.
  const seen = new Map<string, number>();
  for (const e of scene.edges) {
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    const n = seen.get(key) ?? 0;
    e.parallel = n;
    seen.set(key, n + 1);
  }
  const deg = degrees(scene.edges);
  scene.nodes.forEach((n) => { n.degree = Math.max(n.degree, deg.get(n.id) ?? 0); });
  const nodeOrder = [...scene.nodes].sort((a, b) => (b.role === 'cluster' ? 1 : 0) - (a.role === 'cluster' ? 1 : 0) || b.degree - a.degree || a.id.localeCompare(b.id)).map((n) => n.id);
  const pinned = [...(inp.pinned ?? []), ...(scene.focusId ? [scene.focusId] : [])];
  const edgeOrder = [...scene.edges].sort((a, b) => Number(pinned.includes(b.source) || pinned.includes(b.target)) - Number(pinned.includes(a.source) || pinned.includes(a.target)) || b.count - a.count).map((e) => e.id);
  return { ...scene, labelled: allocateLabels(nodeOrder, edgeOrder, pinned) };
}

/* ------------------------------------------------------------- relations */

function relationsScene(inp: SceneInput): Scene {
  const { t, data } = inp;
  const ents = data.pack.entities.filter((e) => inp.visible(e) && matchesWorld(e, inp.world));
  const keepIds = new Set(ents.map((e) => e.id));
  const rels = relationEdges(inp, (id) => keepIds.has(id));
  const twins = inp.showTwins ? deriveTwins(data, inp.ext.ext).filter((tw) => keepIds.has(tw.digital) && keepIds.has(tw.real)) : [];
  const deg = degrees(rels);
  const clusterOrder = [...new Set(ents.map((e) => classify(e).cluster))].sort();
  const laneOfCluster = (cl: string) => (cl.startsWith('cl:real') ? 0 : 1);

  if (inp.level === 'overview') {
    const groups = new Map<string, Entity[]>();
    ents.forEach((e) => { const c = classify(e).cluster; groups.set(c, [...(groups.get(c) ?? []), e]); });
    const nodes: SceneNode[] = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cl, members]) => {
      const [, world, type] = cl.split(':') as [string, Entity['world'], Entity['type']];
      const label = t('graph.cluster.label', { world: t(`world.${world}`), type: t(`graph.type.${type}`), count: members.length });
      return {
        id: cl, label, aria: label, role: 'cluster', shape: SHAPE_CLUSTER[world]!, color: kindColor[members[0]!.kind], size: Math.min(2.4, 1 + Math.sqrt(members.length) / 3),
        lane: laneOfCluster(cl), group: cl, degree: 0,
        info: [
          { label: t('graph.attr.world'), value: t(`world.${world}`) },
          { label: t('graph.attr.type'), value: t(`graph.type.${type}`) },
          { label: t('graph.attr.members'), value: inp.fmtNumber(members.length) },
        ],
        relations: members.map((m) => inp.tx(m.name)),
      };
    });
    const clusterOf = (id: string) => classify(data.byId.get(id)!).cluster;
    const { bundles, loose } = bundleEdges(rels, clusterOf);
    const edges: SceneEdge[] = [];
    for (const b of bundles) {
      const sems = [...new Set(b.edges.map((e) => semanticOf(e.type, inp.ext.ext)))];
      const label = t('graph.edge.bundle', { count: b.edges.length });
      const members = b.edges.map((e) => edgeText(nameOf(e.source, inp), relationLabel(e, inp), nameOf(e.target, inp)));
      edges.push({
        id: `b:${b.a}|${b.b}`, source: b.a, target: b.b, label, count: b.edges.length, bundled: true, parallel: 0,
        aria: `${nodes.find((n) => n.id === b.a)?.label ?? b.a} ↔ ${nodes.find((n) => n.id === b.b)?.label ?? b.b}: ${label}`,
        info: [{ label: t('graph.attr.semantics'), value: sems.map((s) => t(`graph.sem.${s}`)).join(', ') }],
        members,
      });
    }
    const looseGroups = new Map<string, RelEdge[]>();
    for (const e of loose) {
      const rel = rels.find((r) => r.source === e.source && r.target === e.target && r.type === e.type)!;
      const key = `${e.from}|${e.type}|${e.to}`;
      looseGroups.set(key, [...(looseGroups.get(key) ?? []), rel]);
    }
    for (const [key, list] of looseGroups) {
      const [from, , to] = key.split('|') as [string, string, string];
      const first = list[0]!;
      const label = list.length > 1 ? t('graph.edge.counted', { label: first.label, count: list.length }) : first.label;
      edges.push({
        id: `l:${key}`, source: from, target: to, label, count: list.length, bundled: false, semantic: first.semantic, parallel: 0,
        aria: edgeText(nodes.find((n) => n.id === from)?.label ?? from, label, nodes.find((n) => n.id === to)?.label ?? to),
        info: [{ label: t('graph.attr.semantic'), value: t(`graph.sem.${first.semantic}`) }],
        members: list.map((e) => edgeText(nameOf(e.source, inp), e.label, nameOf(e.target, inp))),
      });
    }
    return finish({ view: 'relations', level: 'overview', nodes, edges, lanes: laneCaptions(inp, nodes), aggregated: 0 }, inp);
  }

  if (inp.level === 'detail') return detailScene(inp, ents, rels, twins.map((tw) => ({ source: tw.digital, target: tw.real, type: `twin:${tw.kind}`, semantic: 'measurement' as Semantic, label: t(`graph.twin.${tw.kind}`), twin: tw.kind })), 'relations');

  // element level
  const agg = aggregateNodes(ents.map((e) => e.id), (id) => classify(data.byId.get(id)!).cluster);
  const nodes: SceneNode[] = agg.nodes.map((id) => {
    const e = data.byId.get(id)!;
    const cl = classify(e).cluster;
    return entityNode(e, inp, laneOfCluster(cl), cl, deg.get(id) ?? 0);
  });
  for (const [cl, members] of agg.clusters) {
    const [, world, type] = cl.split(':') as [string, Entity['world'], Entity['type']];
    const label = t('graph.cluster.label', { world: t(`world.${world}`), type: t(`graph.type.${type}`), count: members.length });
    nodes.push({ id: cl, label, aria: label, role: 'cluster', shape: SHAPE_CLUSTER[world]!, color: kindColor[data.byId.get(members[0]!)!.kind], size: 2, lane: laneOfCluster(cl), group: cl, degree: 0, info: [{ label: t('graph.attr.members'), value: inp.fmtNumber(members.length) }], relations: members.map((m) => nameOf(m, inp)) });
  }
  const drawn = (id: string) => agg.drawnAs.get(id) ?? id;
  const { bundles, loose } = bundleEdges(rels, drawn);
  const edges: SceneEdge[] = [];
  for (const e of loose) {
    const rel = e as unknown as RelEdge & { from: string; to: string };
    edges.push({
      id: `e:${e.source}|${e.type}|${e.target}`, source: e.from, target: e.to, label: rel.label, count: 1, bundled: false, semantic: rel.semantic, parallel: 0,
      aria: edgeText(nameOf(e.source, inp), rel.label, nameOf(e.target, inp)),
      info: [
        { label: t('graph.attr.semantic'), value: t(`graph.sem.${rel.semantic}`) },
        { label: t('graph.attr.direction'), value: t(RELATION_SEMANTICS[e.type as keyof typeof RELATION_SEMANTICS]?.reversed ? 'graph.dir.reverse' : 'graph.dir.forward') },
      ],
      members: [],
    });
  }
  for (const b of bundles) {
    const label = t('graph.edge.bundle', { count: b.edges.length });
    edges.push({ id: `b:${b.a}|${b.b}`, source: b.a, target: b.b, label, count: b.edges.length, bundled: true, parallel: 0, aria: `${nameOf(b.a, inp)} ↔ ${nameOf(b.b, inp)}: ${label}`, info: [], members: b.edges.map((e) => edgeText(nameOf(e.source, inp), relationLabel(e, inp), nameOf(e.target, inp))) });
  }
  for (const tw of twins) {
    const label = t(`graph.twin.${tw.kind}`);
    edges.push({
      id: `t:${tw.digital}|${tw.kind}|${tw.real}`, source: drawn(tw.digital), target: drawn(tw.real), label, twin: tw.kind, count: 1, bundled: false, parallel: 0,
      aria: edgeText(nameOf(tw.digital, inp), label, nameOf(tw.real, inp)),
      info: [{ label: t('graph.attr.twin'), value: label }, { label: t('graph.attr.origin'), value: t(`graph.origin.${tw.origin}`) }],
      members: [],
    });
  }
  void clusterOrder;
  return finish({ view: 'relations', level: 'element', nodes, edges, lanes: laneCaptions(inp, nodes), aggregated: [...agg.clusters.values()].flat().length }, inp);
}

function laneCaptions(inp: SceneInput, nodes: SceneNode[]) {
  const lanes = [...new Set(nodes.map((n) => n.lane))].sort();
  return lanes.map((lane) => ({ lane, label: lane === 0 ? inp.t('world.real') : inp.t('world.digital') }));
}

/** Detail level: the focused element with its attributes (and KPI values) and its direct relations. */
function detailScene(inp: SceneInput, ents: Entity[], rels: RelEdge[], extra: RelEdge[], view: GraphView): Scene {
  const { t, data } = inp;
  const deg = degrees(rels);
  const keep = new Set(ents.map((e) => e.id));
  const fallback = [...keep].sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0) || a.localeCompare(b))[0];
  const focusId = inp.selected && keep.has(inp.selected) ? inp.selected : fallback;
  if (!focusId) return finish({ view, level: 'detail', nodes: [], edges: [], lanes: [], aggregated: 0 }, inp);
  const focus = data.byId.get(focusId)!;
  const all = [...rels, ...extra].filter((r) => r.source === focusId || r.target === focusId);
  const nodes: SceneNode[] = [{ ...entityNode(focus, inp, 1, 'focus', deg.get(focusId) ?? 0), size: 2 }];
  const edges: SceneEdge[] = [];
  // Attributes of the focus.
  const attrs = attributesOf(focus, inp);
  attrs.forEach((a, i) => {
    const id = `a:${focusId}:${i}`;
    const label = `${a.label}: ${a.value}`;
    nodes.push({ id, label, aria: label, role: 'attribute', shape: 'rect', color: 'var(--colorNeutralBackground3)', size: 0.8, lane: 0, group: 'attr', degree: 0, info: [a], relations: [] });
    edges.push({ id: `ae:${id}`, source: focusId, target: id, label: a.label, aria: label, count: 1, bundled: false, info: [a], members: [], parallel: 0 });
  });
  for (const r of all) {
    const other = r.source === focusId ? r.target : r.source;
    if (!nodes.some((n) => n.id === other)) {
      const oe = data.byId.get(other)!;
      nodes.push(entityNode(oe, inp, 2, oe.world, deg.get(other) ?? 0, oe.kind === 'kpi' ? kpiValue(oe, inp) : undefined));
    }
    edges.push({
      id: `e:${r.source}|${r.type}|${r.target}`, source: r.source, target: r.target, label: r.label, semantic: r.twin ? undefined : r.semantic, twin: r.twin, flow: r.flow, count: 1, bundled: false, parallel: 0,
      aria: edgeText(nameOf(r.source, inp), r.label, nameOf(r.target, inp)),
      info: r.twin ? [{ label: t('graph.attr.twin'), value: r.label }] : [{ label: t('graph.attr.semantic'), value: t(`graph.sem.${r.semantic}`) }],
      members: [],
    });
  }
  return finish({ view, level: 'detail', nodes, edges, lanes: [{ lane: 0, label: t('graph.lane.attributes') }, { lane: 1, label: t('graph.lane.focus') }, { lane: 2, label: t('graph.lane.related') }], aggregated: 0, focusId }, inp);
}

function kpiValue(e: Entity, inp: SceneInput): string {
  if (e.kind !== 'kpi') return '';
  return inp.t('graph.kpi.value', { current: inp.fmtNumber(e.current), target: inp.fmtNumber(e.target), unit: inp.tx(e.unit) });
}

function attributesOf(e: Entity, inp: SceneInput): InfoRow[] {
  const { t } = inp;
  const c = classify(e, inp.ext.ext);
  const rows: InfoRow[] = [
    { label: t('graph.attr.world'), value: t(`world.${e.world}`) },
    { label: t('graph.attr.type'), value: t(`graph.type.${e.type}`) },
  ];
  if (c.layer) rows.push({ label: t('graph.attr.layer'), value: t(`graph.layer.${c.layer}`) });
  if (e.kind === 'kpi') {
    rows.push({ label: t('graph.attr.kpi'), value: kpiValue(e, inp) });
    const p = kpiProgress(e);
    if (Number.isFinite(p)) rows.push({ label: t('graph.attr.progress'), value: t('graph.percent', { value: inp.fmtNumber(Math.round(p * 100)) }) });
    const stage = kpiStageOf(e.id, inp.ext.ext);
    rows.push({ label: t('graph.attr.stage'), value: stage ? t(`graph.stage.${stage}`) : t('graph.stage.unset') });
  }
  rows.push({ label: t('graph.attr.relations'), value: inp.fmtNumber(inp.data.edges.filter((x) => x.source === e.id || x.target === e.id).length) });
  return rows;
}

/* ------------------------------------------------------------------- twin */

const TWIN_LANES: Record<Layer | 'real', number> = { insights: 0, experience: 1, operations: 2, real: 3 };

function twinScene(inp: SceneInput): Scene {
  const { t, data } = inp;
  const twins = deriveTwins(data, inp.ext.ext).filter((tw) => {
    const d = data.byId.get(tw.digital), r = data.byId.get(tw.real);
    return d && r && inp.visible(d) && inp.visible(r);
  });
  const flows = deriveFlows(twins, inp.ext.ext).filter((f) => {
    const s = data.byId.get(f.source), g = data.byId.get(f.target);
    return s && g && inp.visible(s) && inp.visible(g);
  });
  const ids = new Set(flows.flatMap((f) => [f.source, f.target]));
  const ents = [...ids].map((id) => data.byId.get(id)!).filter((e) => matchesWorld(e, inp.world)).sort((a, b) => a.id.localeCompare(b.id));
  const keep = new Set(ents.map((e) => e.id));
  const laneOf = (e: Entity) => (e.world === 'real' ? TWIN_LANES.real : TWIN_LANES[classify(e, inp.ext.ext).layer!]);
  const groupOf = (e: Entity) => (e.world === 'real' ? `real:${e.type}` : `layer:${classify(e, inp.ext.ext).layer}`);
  const lanes = [
    ...(inp.world !== 'real' ? LAYERS.map((l) => ({ lane: TWIN_LANES[l], label: t(`graph.layer.${l}`) })) : []),
    ...(inp.world !== 'digital' ? [{ lane: TWIN_LANES.real, label: t('graph.lane.real') }] : []),
  ].sort((a, b) => a.lane - b.lane);
  const flowLabel = (k: FlowKind) => t(`graph.flow.${k}`);
  const visibleFlows = flows.filter((f) => keep.has(f.source) && keep.has(f.target));

  if (inp.level === 'overview') {
    const groups = new Map<string, Entity[]>();
    ents.forEach((e) => groups.set(groupOf(e), [...(groups.get(groupOf(e)) ?? []), e]));
    const nodes: SceneNode[] = [...groups.entries()].map(([g, members]) => {
      const first = members[0]!;
      const name = first.world === 'real' ? t(`graph.type.${first.type}`) : t(`graph.layer.${classify(first, inp.ext.ext).layer!}`);
      const label = t('graph.group.label', { name, count: members.length });
      return {
        id: g, label, aria: label, role: 'cluster', shape: first.world === 'real' ? 'hexagon' : 'diamond', color: kindColor[first.kind], size: Math.min(2.4, 1 + Math.sqrt(members.length) / 3),
        lane: laneOf(first), group: g, degree: 0, info: [{ label: t('graph.attr.members'), value: inp.fmtNumber(members.length) }], relations: members.map((m) => inp.tx(m.name)),
      };
    });
    const pairs = new Map<string, typeof visibleFlows>();
    for (const f of visibleFlows) {
      const key = `${groupOf(data.byId.get(f.source)!)}|${f.kind}|${groupOf(data.byId.get(f.target)!)}`;
      pairs.set(key, [...(pairs.get(key) ?? []), f]);
    }
    const edges: SceneEdge[] = [...pairs.entries()].map(([key, list]) => {
      const [from, kind, to] = key.split('|') as [string, FlowKind, string];
      const label = t('graph.edge.counted', { label: flowLabel(kind), count: list.length });
      return {
        id: `f:${key}`, source: from, target: to, label, flow: kind, count: list.length, bundled: list.length > 1, parallel: 0,
        aria: edgeText(nodes.find((n) => n.id === from)!.label, label, nodes.find((n) => n.id === to)!.label),
        info: [{ label: t('graph.attr.flow'), value: flowLabel(kind) }],
        members: list.map((f) => edgeText(nameOf(f.source, inp), f.twin ? t(`graph.twin.${f.twin}`) : flowLabel(f.kind), nameOf(f.target, inp))),
      };
    });
    return finish({ view: 'twin', level: 'overview', nodes, edges, lanes, aggregated: 0 }, inp);
  }

  const asRel = (f: (typeof flows)[number]): RelEdge => ({ source: f.source, target: f.target, type: `flow:${f.kind}:${f.twin ?? 'x'}`, semantic: f.kind === 'data' ? 'lineage' : 'control', label: f.label ? inp.tx(f.label) : f.twin ? t(`graph.twin.${f.twin}`) : flowLabel(f.kind), flow: f.kind, ...(f.twin ? { twin: f.twin } : {}) });
  if (inp.level === 'detail') {
    const rels = visibleFlows.map(asRel);
    const scene = detailScene(inp, ents, rels, [], 'twin');
    scene.edges.forEach((e) => { const r = rels.find((x) => e.id === `e:${x.source}|${x.type}|${x.target}`); if (r) { e.flow = r.flow; e.semantic = undefined; e.info = [{ label: t('graph.attr.flow'), value: flowLabel(r.flow!) }]; } });
    return scene;
  }
  const deg = degrees(visibleFlows);
  const nodes = ents.map((e) => entityNode(e, inp, laneOf(e), groupOf(e), deg.get(e.id) ?? 0, e.kind === 'kpi' ? kpiValue(e, inp) : undefined));
  const edges: SceneEdge[] = visibleFlows.map((f) => {
    const r = asRel(f);
    return {
      id: `e:${r.source}|${r.type}|${r.target}`, source: f.source, target: f.target, label: r.label, flow: f.kind, twin: f.twin, count: 1, bundled: false, parallel: 0,
      aria: edgeText(nameOf(f.source, inp), r.label, nameOf(f.target, inp)),
      info: [{ label: t('graph.attr.flow'), value: flowLabel(f.kind) }, ...(f.twin ? [{ label: t('graph.attr.twin'), value: t(`graph.twin.${f.twin}`) }] : [])],
      members: [],
    };
  });
  return finish({ view: 'twin', level: 'element', nodes, edges, lanes, aggregated: 0 }, inp);
}

/* ---------------------------------------------------------------- spatial */

export const SPATIAL_W = 960;
export const SPATIAL_H = 600;

function spatialScene(inp: SceneInput): Scene {
  const { t, data } = inp;
  const visibleIds = (id: string) => { const e = data.byId.get(id); return !!e && inp.visible(e); };
  const tree = deriveSpatial(data, visibleIds);
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const kpiOverlay = (ids: string[]) => ids.map((k) => { const e = data.byId.get(k)!; return `${inp.tx(e.name)} ${kpiValue(e, inp)}`; });
  const contain = (parent: string, child: string, label: string) => edges.push({ id: `c:${parent}|${child}`, source: parent, target: child, label: t('graph.sp.contains'), aria: `${label}`, count: 1, bundled: false, info: [], members: [], parallel: 0, contains: true });
  const allKpis = tree.flatMap((s) => s.kpis);
  const wholeLabel = t('graph.sp.whole');
  nodes.push({ id: 'sp:whole', label: wholeLabel, aria: wholeLabel, role: 'area', shape: 'rect', color: 'var(--colorNeutralBackground2)', size: 2, lane: 0, group: 'whole', degree: 0, box: { x: 10, y: 10, w: SPATIAL_W - 20, h: SPATIAL_H - 20 }, info: [{ label: t('graph.attr.sites'), value: inp.fmtNumber(tree.length) }, { label: t('graph.attr.kpis'), value: inp.fmtNumber(allKpis.length) }], relations: kpiOverlay(allKpis) });
  const colW = (SPATIAL_W - 40) / Math.max(1, tree.length);
  tree.forEach((s, si) => {
    const site = data.byId.get(s.siteId)!;
    const sx = 20 + si * colW;
    const kpiText = s.kpis.length ? ` · ${t('graph.sp.kpiCount', { count: s.kpis.length })}` : '';
    const siteNode = entityNode(site, inp, 1, site.id, 0, kpiText ? kpiText.slice(3) : undefined);
    siteNode.box = { x: sx + 4, y: 50, w: colW - 8, h: SPATIAL_H - 70 };
    siteNode.relations = kpiOverlay(s.kpis);
    siteNode.info.push({ label: t('graph.attr.floors'), value: inp.fmtNumber(s.floors.length) });
    nodes.push(siteNode);
    contain('sp:whole', site.id, edgeText(wholeLabel, t('graph.sp.contains'), inp.tx(site.name)));
    if (inp.level === 'overview') return;
    const floorH = (SPATIAL_H - 120) / Math.max(1, s.floors.length);
    [...s.floors].reverse().forEach((f, fi) => {
      const fy = 90 + fi * floorH;
      const floorLabel = t('graph.sp.floor', { level: f.level });
      nodes.push({ id: f.id, label: floorLabel, aria: `${inp.tx(site.name)} ${floorLabel}`, role: 'area', shape: 'rect', color: 'var(--colorNeutralBackground3)', size: 1, lane: 2, group: site.id, degree: 0, box: { x: sx + 10, y: fy, w: colW - 20, h: floorH - 8 }, info: [{ label: t('graph.attr.rooms'), value: inp.fmtNumber(f.rooms.length) }], relations: kpiOverlay(f.rooms.flatMap((r) => r.kpis)) });
      contain(site.id, f.id, edgeText(inp.tx(site.name), t('graph.sp.contains'), floorLabel));
      f.rooms.forEach((r) => {
        const roomLabel = t(`graph.sp.room.${r.purpose}`);
        const kpis = r.kpis.length ? ` · ${t('graph.sp.kpiCount', { count: r.kpis.length })}` : '';
        nodes.push({
          id: r.id, label: `${roomLabel}${kpis}`, aria: `${inp.tx(site.name)} ${floorLabel} ${roomLabel}${kpis}`, role: 'area', shape: 'rect', color: 'var(--colorNeutralBackground4)', size: 1, lane: 3, group: site.id, degree: 0,
          box: { x: sx + 16, y: fy + 22, w: colW - 32, h: floorH - 36 },
          info: [{ label: t('graph.attr.people'), value: inp.fmtNumber(r.people.length) }, { label: t('graph.attr.equipment'), value: inp.fmtNumber(r.equipment.length) }],
          relations: kpiOverlay(r.kpis),
        });
        contain(f.id, r.id, edgeText(floorLabel, t('graph.sp.contains'), roomLabel));
        if (inp.level !== 'detail') return;
        const items = [...r.equipment, ...r.people, ...r.kpis];
        items.forEach((id) => {
          const e = data.byId.get(id)!;
          const n = entityNode(e, inp, 4, r.id, 0, e.kind === 'kpi' ? kpiValue(e, inp) : undefined);
          n.size = 0.7;
          nodes.push(n);
          contain(r.id, id, edgeText(roomLabel, t('graph.sp.contains'), inp.tx(e.name)));
        });
      });
    });
  });
  const lanes = [
    { lane: 0, label: wholeLabel }, { lane: 1, label: t('kind.site') },
    ...(inp.level !== 'overview' ? [{ lane: 2, label: t('graph.lane.floor') }, { lane: 3, label: t('graph.lane.room') }] : []),
    ...(inp.level === 'detail' ? [{ lane: 4, label: t('graph.lane.items') }] : []),
  ];
  return finish({ view: 'spatial', level: inp.level, nodes, edges, lanes, aggregated: 0 }, inp);
}

export function buildScene(inp: SceneInput): Scene {
  if (inp.view === 'twin') return twinScene(inp);
  if (inp.view === 'spatial') return spatialScene(inp);
  return relationsScene(inp);
}
