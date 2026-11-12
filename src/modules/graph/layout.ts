import * as d3 from 'd3';
import type { Scene, SceneNode } from './scene.ts';

export type Format = '2d' | '3d' | 'graph';
export const FORMATS: Format[] = ['2d', '3d', 'graph'];

export interface Pos { x: number; y: number }
export interface Pos3 { x: number; y: number; z: number }

export const CELL_W = 140;
export const CELL_H = 70;

/** Structured 2D layout: lanes (rows) → groups (columns) → mini-grid. Spatial nodes use their nesting boxes. */
export function layout2D(scene: Scene): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  if (scene.view === 'spatial') {
    for (const n of scene.nodes) if (n.box) pos.set(n.id, { x: n.box.x + n.box.w / 2, y: n.box.y + 14 });
    const byRoom = new Map<string, SceneNode[]>();
    scene.nodes.filter((n) => !n.box).forEach((n) => byRoom.set(n.group, [...(byRoom.get(n.group) ?? []), n]));
    for (const [roomId, items] of byRoom) {
      const room = scene.nodes.find((n) => n.id === roomId)?.box;
      if (!room) continue;
      const cols = Math.max(1, Math.floor((room.w - 8) / 26));
      items.forEach((n, i) => pos.set(n.id, { x: room.x + 16 + (i % cols) * 26, y: room.y + 40 + Math.floor(i / cols) * 26 }));
    }
    return pos;
  }
  if (scene.level === 'detail') {
    const cols: Record<number, SceneNode[]> = {};
    scene.nodes.forEach((n) => { (cols[n.lane] ??= []).push(n); });
    for (const [lane, nodes] of Object.entries(cols)) {
      const x = Number(lane) * 280;
      nodes.forEach((n, i) => pos.set(n.id, { x, y: (i - (nodes.length - 1) / 2) * CELL_H }));
    }
    return pos;
  }
  const lanes = [...new Set(scene.nodes.map((n) => n.lane))].sort((a, b) => a - b);
  // Shelf packing: each group is a block (mini-grid); blocks wrap within a target width so the whole layout keeps
  // roughly the view's aspect ratio and nodes do not get squeezed together by the fit.
  const cellsWide = Math.max(8, Math.ceil(Math.sqrt(scene.nodes.length * (16 / 10) * (CELL_H / CELL_W)) * 1.4));
  const maxW = cellsWide * CELL_W;
  let y = 0;
  for (const lane of lanes) {
    const inLane = scene.nodes.filter((n) => n.lane === lane);
    const groups = [...new Set(inLane.map((n) => n.group))].sort();
    let x = 0;
    let shelfH = 0;
    const placed: { id: string; x: number; y: number }[] = [];
    let rowStart = 0;
    const centreRow = (from: number, width: number) => { for (let i = from; i < placed.length; i++) placed[i]!.x -= width / 2; };
    for (const g of groups) {
      const members = inLane.filter((n) => n.group === g).sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
      const cols = Math.min(cellsWide, members.length, Math.max(1, Math.ceil(Math.sqrt(members.length * 1.6))));
      const rows = Math.ceil(members.length / cols);
      const bw = cols * CELL_W;
      if (x > 0 && x + bw > maxW) {
        centreRow(rowStart, x - CELL_W * 1.5);
        rowStart = placed.length;
        y += shelfH + CELL_H * 0.6;
        x = 0;
        shelfH = 0;
      }
      members.forEach((n, i) => placed.push({ id: n.id, x: x + (i % cols) * CELL_W, y: y + Math.floor(i / cols) * CELL_H }));
      shelfH = Math.max(shelfH, rows * CELL_H);
      x += bw + CELL_W * 0.5;
    }
    centreRow(rowStart, x - CELL_W * 1.5);
    placed.forEach((p) => pos.set(p.id, { x: p.x, y: p.y }));
    y += shelfH + CELL_H * 2;
  }
  return pos;
}

interface FNode extends d3.SimulationNodeDatum { id: string; lane: number }

const FORCE_CACHE_SIZE = 8;
const forceCache = new Map<string, Map<string, Pos>>();

/** Node-link "Graph" format: a static force layout (computed synchronously, never animated). */
export function layoutForce(scene: Scene): Map<string, Pos> {
  // d3-force is deterministic (seeded random source), so the same input always settles to the same layout.
  // Switching Graph ⇄ 3D or revisiting the screen reuses it instead of re-running a few hundred ticks.
  const key = `${scene.level}|${scene.nodes.map((n) => `${n.id}:${n.lane}`).join(',')}|${scene.edges.map((e) => `${e.source}>${e.target}`).join(',')}`;
  let cached = forceCache.get(key);
  if (cached) {
    forceCache.delete(key);
  } else {
    cached = computeForceLayout(scene);
    if (forceCache.size >= FORCE_CACHE_SIZE) forceCache.delete(forceCache.keys().next().value!);
  }
  forceCache.set(key, cached);
  return new Map([...cached].map(([id, p]) => [id, { ...p }]));
}

function computeForceLayout(scene: Scene): Map<string, Pos> {
  const nodes: FNode[] = scene.nodes.map((n) => ({ id: n.id, lane: n.lane }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = scene.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target).map((e) => ({ source: e.source, target: e.target }));
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink<FNode, d3.SimulationLinkDatum<FNode>>(links).id((d) => d.id).distance(scene.level === 'overview' ? 160 : 90).strength(0.5))
    .force('charge', d3.forceManyBody().strength(scene.level === 'overview' ? -900 : -340))
    .force('x', d3.forceX(0).strength(0.04))
    .force('y', d3.forceY(0).strength(0.06))
    .force('collide', d3.forceCollide(scene.level === 'overview' ? 60 : 38))
    .stop();
  const ticks = Math.min(300, 60 + Math.ceil(30000 / Math.max(1, nodes.length)));
  for (let i = 0; i < ticks; i++) sim.tick();
  return new Map(nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

/**
 * 3D format: a simple force layout in three dimensions. Starts from the graph layout on the x/z plane with lanes
 * (world / Twin layer / spatial level) stacked on y, then relaxes with springs, repulsion and a pull toward the lane.
 */
export function layout3D(scene: Scene, iterations = 80): Map<string, Pos3> {
  const base = scene.view === 'spatial' ? layout2D(scene) : layoutForce(scene);
  const lanes = [...new Set(scene.nodes.map((n) => n.lane))].sort((a, b) => a - b);
  const laneY = (lane: number) => (lanes.length - 1 - lanes.indexOf(lane)) * 3 - (lanes.length - 1) * 1.5;
  const bx = d3.mean([...base.values()], (p) => p.x) ?? 0, by = d3.mean([...base.values()], (p) => p.y) ?? 0;
  const spread = Math.max(1, ...[...base.values()].map((p) => Math.hypot(p.x - bx, p.y - by)));
  const unit = 7 / spread;
  const pts = scene.nodes.map((n) => {
    const p = base.get(n.id) ?? { x: bx, y: by };
    return { id: n.id, x: (p.x - bx) * unit, y: laneY(n.lane), z: (scene.view === 'spatial' ? 0 : (p.y - by) * unit), ty: laneY(n.lane), vx: 0, vy: 0, vz: 0 };
  });
  if (scene.view === 'spatial') return new Map(pts.map((p) => [p.id, { x: p.x, y: p.y, z: p.z }]));
  const index = new Map(pts.map((p, i) => [p.id, i]));
  const links = scene.edges.map((e) => [index.get(e.source), index.get(e.target)] as const).filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined);
  for (let it = 0; it < iterations; it++) {
    const alpha = 1 - it / iterations;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]!, b = pts[j]!;
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        const d2 = dx * dx + dy * dy + dz * dz + 0.01;
        const f = (0.08 * alpha) / d2;
        a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
        b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
      }
    }
    for (const [i, j] of links) {
      const a = pts[i]!, b = pts[j]!;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      const f = ((d - 1.6) / d) * 0.05 * alpha;
      a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
      b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
    }
    for (const p of pts) {
      p.vy += (p.ty - p.y) * 0.2;
      p.x += Math.max(-0.25, Math.min(0.25, p.vx)); p.y += Math.max(-0.25, Math.min(0.25, p.vy)); p.z += Math.max(-0.25, Math.min(0.25, p.vz));
      p.vx *= 0.5; p.vy *= 0.5; p.vz *= 0.5;
    }
  }
  const cx = d3.mean(pts, (p) => p.x) ?? 0, cz = d3.mean(pts, (p) => p.z) ?? 0;
  const radii = pts.map((p) => Math.hypot(p.x - cx, p.z - cz)).sort((a, b) => a - b);
  const k = 6 / Math.max(0.01, radii[Math.floor(radii.length * 0.85)] ?? 1);
  return new Map(pts.map((p) => [p.id, { x: (p.x - cx) * k, y: p.y, z: (p.z - cz) * k }]));
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export function boundsOf(scene: Scene, pos: Map<string, Pos>): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of scene.nodes) {
    if (n.box) {
      x0 = Math.min(x0, n.box.x); y0 = Math.min(y0, n.box.y); x1 = Math.max(x1, n.box.x + n.box.w); y1 = Math.max(y1, n.box.y + n.box.h);
      continue;
    }
    const p = pos.get(n.id);
    if (!p) continue;
    x0 = Math.min(x0, p.x - 60); y0 = Math.min(y0, p.y - 30); x1 = Math.max(x1, p.x + 60); y1 = Math.max(y1, p.y + 40);
  }
  if (!Number.isFinite(x0)) return { x0: -100, y0: -100, x1: 100, y1: 100 };
  return { x0, y0, x1, y1 };
}

/** Scale that fits the bounds into the view box (zoom 1 = this fit, PARAM-087). */
export function fitScale(b: Bounds, w: number, h: number, margin = 24): number {
  const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
  return Math.min((w - margin * 2) / bw, (h - margin * 2) / bh, 2.5);
}
