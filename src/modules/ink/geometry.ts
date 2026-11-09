import { boxOf, itemBox, type Box, type BoardContent, type Stroke } from './model.ts';

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function inflate(b: Box, r: number): Box {
  return { minX: b.minX - r, minY: b.minY - r, maxX: b.maxX + r, maxY: b.maxY + r };
}

/** True when a circle (x, y, r) touches the stroke (its half width included). */
export function strokeHitsCircle(s: Stroke, x: number, y: number, r: number): boolean {
  const reach = r + s.width / 2;
  if (x < s.box.minX - reach || x > s.box.maxX + reach || y < s.box.minY - reach || y > s.box.maxY + reach) return false;
  const p = s.points;
  if (p.length === 3) return Math.hypot(p[0]! - x, p[1]! - y) <= reach;
  for (let i = 0; i + 3 < p.length; i += 3) {
    if (distToSegment(x, y, p[i]!, p[i + 1]!, p[i + 3]!, p[i + 4]!) <= reach) return true;
  }
  return false;
}

/** Insert samples so consecutive eraser samples are at most `step` apart (fast pointer moves skip ahead). */
export function densifyPath(path: number[], step: number): number[] {
  if (path.length <= 2) return path;
  const out: number[] = [path[0]!, path[1]!];
  for (let i = 2; i < path.length; i += 2) {
    const ax = path[i - 2]!;
    const ay = path[i - 1]!;
    const bx = path[i]!;
    const by = path[i + 1]!;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let k = 1; k < n; k++) out.push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
    out.push(bx, by);
  }
  return out;
}

/** Stroke eraser: ids of strokes touched by the eraser path (flat x, y list). */
export function strokesHitByPath(strokes: Stroke[], rawPath: number[], r: number): string[] {
  if (rawPath.length < 2) return [];
  const path = densifyPath(rawPath, Math.max(0.5, r / 2));
  const pb = inflate(boxOf2(path), r);
  const out: string[] = [];
  for (const s of strokes) {
    if (!boxesIntersect(inflate(s.box, s.width / 2), pb)) continue;
    for (let i = 0; i < path.length; i += 2) {
      if (strokeHitsCircle(s, path[i]!, path[i + 1]!, r)) {
        out.push(s.id);
        break;
      }
    }
  }
  return out;
}

function boxOf2(path: number[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < path.length; i += 2) {
    minX = Math.min(minX, path[i]!);
    maxX = Math.max(maxX, path[i]!);
    minY = Math.min(minY, path[i + 1]!);
    maxY = Math.max(maxY, path[i + 1]!);
  }
  return { minX, minY, maxX, maxY };
}

/** Insert points so that no segment is longer than `step` (needed before partial erasing of sparse shapes). */
export function resample(points: number[], step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 3) {
    if (i > 0) {
      const ax = points[i - 3]!;
      const ay = points[i - 2]!;
      const ap = points[i - 1]!;
      const bx = points[i]!;
      const by = points[i + 1]!;
      const bp = points[i + 2]!;
      const n = Math.floor(Math.hypot(bx - ax, by - ay) / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t);
      }
    }
    out.push(points[i]!, points[i + 1]!, points[i + 2]!);
  }
  return out;
}

export interface EraseResult {
  /** Ids of strokes that changed (removed or split). */
  remove: string[];
  /** Remaining pieces of split strokes. */
  add: Stroke[];
}

/**
 * Partial eraser: removes the parts of strokes within `r` of the eraser path and splits them into pieces.
 * `makeId` gives ids to the pieces.
 */
export function eraseCircles(strokes: Stroke[], rawPath: number[], r: number, makeId: (base: string, i: number) => string): EraseResult {
  const path = densifyPath(rawPath, Math.max(0.5, r / 2));
  const hit = new Set(strokesHitByPath(strokes, path, r));
  const result: EraseResult = { remove: [], add: [] };
  for (const s of strokes) {
    if (!hit.has(s.id)) continue;
    result.remove.push(s.id);
    const reach = r + s.width / 2;
    const pts = resample(s.points, Math.max(1, reach / 2));
    let piece: number[] = [];
    let n = 0;
    const flush = () => {
      if (piece.length >= 6) result.add.push({ ...s, id: makeId(s.id, n++), points: piece, box: boxOf(piece) });
      piece = [];
    };
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      let erased = false;
      for (let k = 0; k < path.length; k += 2) {
        if (Math.hypot(path[k]! - x, path[k + 1]! - y) <= reach) {
          erased = true;
          break;
        }
      }
      if (erased) flush();
      else piece.push(x, y, pts[i + 2]!);
    }
    flush();
  }
  return result;
}

/** Ray-casting point-in-polygon; `poly` is flat x, y. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!;
    const yi = poly[i * 2 + 1]!;
    const xj = poly[j * 2]!;
    const yj = poly[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Selection {
  strokes: string[];
  items: string[];
}

export const EMPTY_SELECTION: Selection = { strokes: [], items: [] };

/**
 * Lasso: a stroke is selected when more than half of its points are inside the loop;
 * notes and cards are selected when their centre is inside.
 */
export function lassoSelect(c: BoardContent, poly: number[]): Selection {
  if (poly.length < 6) return EMPTY_SELECTION;
  const pb = boxOf2(poly);
  const strokes: string[] = [];
  for (const s of c.strokes) {
    if (!boxesIntersect(s.box, pb)) continue;
    let inside = 0;
    const total = s.points.length / 3;
    for (let i = 0; i < s.points.length; i += 3) if (pointInPolygon(s.points[i]!, s.points[i + 1]!, poly)) inside++;
    if (inside * 2 > total) strokes.push(s.id);
  }
  const items = [...c.notes, ...c.cards].filter((it) => pointInPolygon(it.x + it.w / 2, it.y + it.h / 2, poly)).map((it) => it.id);
  return { strokes, items };
}

export function translateStroke(s: Stroke, dx: number, dy: number): Stroke {
  const points = s.points.slice();
  for (let i = 0; i < points.length; i += 3) {
    points[i] = points[i]! + dx;
    points[i + 1] = points[i + 1]! + dy;
  }
  return { ...s, points, box: { minX: s.box.minX + dx, minY: s.box.minY + dy, maxX: s.box.maxX + dx, maxY: s.box.maxY + dy } };
}

/** Move the selection; returns new content (unchanged parts keep identity). */
export function moveSelection(c: BoardContent, sel: Selection, dx: number, dy: number): BoardContent {
  if (dx === 0 && dy === 0) return c;
  const ss = new Set(sel.strokes);
  const is = new Set(sel.items);
  return {
    ...c,
    strokes: ss.size ? c.strokes.map((s) => (ss.has(s.id) ? translateStroke(s, dx, dy) : s)) : c.strokes,
    notes: c.notes.map((n) => (is.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
    cards: c.cards.map((k) => (is.has(k.id) ? { ...k, x: k.x + dx, y: k.y + dy } : k)),
  };
}

export function deleteSelection(c: BoardContent, sel: Selection): BoardContent {
  const ss = new Set(sel.strokes);
  const is = new Set(sel.items);
  return {
    strokes: ss.size ? c.strokes.filter((s) => !ss.has(s.id)) : c.strokes,
    notes: c.notes.filter((n) => !is.has(n.id)),
    cards: c.cards.filter((k) => !is.has(k.id)),
    links: c.links.filter((l) => !is.has(l.from) && !is.has(l.to) && !is.has(l.id)),
  };
}

export function selectionBox(c: BoardContent, sel: Selection): Box | null {
  const ss = new Set(sel.strokes);
  const is = new Set(sel.items);
  const boxes = [
    ...c.strokes.filter((s) => ss.has(s.id)).map((s) => inflate(s.box, s.width / 2)),
    ...[...c.notes, ...c.cards].filter((i) => is.has(i.id)).map(itemBox),
  ];
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}

/** Apply an eraser result to content. */
export function applyErase(c: BoardContent, r: EraseResult): BoardContent {
  if (!r.remove.length) return c;
  const rm = new Set(r.remove);
  return { ...c, strokes: [...c.strokes.filter((s) => !rm.has(s.id)), ...r.add] };
}
