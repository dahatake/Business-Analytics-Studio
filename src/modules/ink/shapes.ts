/** FR-089 (MAY): recognize a freehand stroke as a line, rectangle, ellipse or arrow and return the clean shape. */

export type ShapeKind = 'line' | 'rectangle' | 'ellipse' | 'arrow';

export interface RecognizedShape {
  kind: ShapeKind;
  /** Clean shape as flat x, y, p points (one polyline). */
  points: number[];
}

interface P {
  x: number;
  y: number;
}

function toXY(points: number[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < points.length; i += 3) out.push({ x: points[i]!, y: points[i + 1]! });
  return out;
}

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(ps: P[]): number {
  let l = 0;
  for (let i = 1; i < ps.length; i++) l += dist(ps[i - 1]!, ps[i]!);
  return l;
}

function maxDeviation(ps: P[], a: P, b: P): number {
  const len = dist(a, b) || 1;
  let m = 0;
  for (const p of ps) m = Math.max(m, Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len);
  return m;
}

function isStraight(ps: P[]): boolean {
  const a = ps[0]!;
  const b = ps[ps.length - 1]!;
  const chord = dist(a, b);
  if (chord < 1) return false;
  return maxDeviation(ps, a, b) <= Math.max(3, chord * 0.07) && pathLength(ps) <= chord * 1.12;
}

function flat(ps: P[], pressure: number): number[] {
  return ps.flatMap((p) => [p.x, p.y, pressure]);
}

function avgPressure(points: number[]): number {
  let s = 0;
  let n = 0;
  for (let i = 2; i < points.length; i += 3) {
    s += points[i]!;
    n++;
  }
  return n ? s / n : 0.5;
}

/** Arrow head: two barbs at ±28° from the shaft's end, with the polyline tip → barb1 → tip → barb2. */
export function arrowPoints(a: P, b: P, headLen: number, pressure: number): number[] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = (28 * Math.PI) / 180;
  const b1 = { x: b.x - headLen * Math.cos(ang - spread), y: b.y - headLen * Math.sin(ang - spread) };
  const b2 = { x: b.x - headLen * Math.cos(ang + spread), y: b.y - headLen * Math.sin(ang + spread) };
  return flat([a, b, b1, b, b2], pressure);
}

export function rectanglePoints(minX: number, minY: number, maxX: number, maxY: number, pressure: number): number[] {
  return flat([{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }, { x: minX, y: minY }], pressure);
}

export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, pressure: number, segments = 48): number[] {
  const ps: P[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ps.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return flat(ps, pressure);
}

export function recognizeShape(points: number[]): RecognizedShape | null {
  const ps = toXY(points);
  if (ps.length < 2) return null;
  const pressure = avgPressure(points);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ps) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 12) return null;
  const length = pathLength(ps);
  const first = ps[0]!;
  const last = ps[ps.length - 1]!;

  // Line: open and straight.
  if (isStraight(ps)) return { kind: 'line', points: flat([first, last], pressure) };

  const closed = dist(first, last) <= Math.max(10, diag * 0.2) && length > diag * 1.6;
  if (!closed) {
    // Arrow: a straight shaft to the farthest point, then a short head stroke that stays near the tip.
    let k = 0;
    let far = 0;
    ps.forEach((p, i) => {
      const d = dist(first, p);
      if (d > far) {
        far = d;
        k = i;
      }
    });
    const tip = ps[k]!;
    const shaft = ps.slice(0, k + 1);
    const tail = ps.slice(k);
    const tailLen = pathLength(tail);
    if (k > 0 && isStraight(shaft) && tail.length >= 2 && tailLen >= far * 0.08 && tailLen <= far * 0.9) {
      const ux = (tip.x - first.x) / far;
      const uy = (tip.y - first.y) / far;
      const behind = tail.every((p) => (p.x - tip.x) * ux + (p.y - tip.y) * uy <= 2);
      const near = tail.every((p) => dist(p, tip) <= far * 0.45);
      if (behind && near) {
        const head = Math.min(far * 0.3, Math.max(...tail.map((p) => dist(p, tip))));
        return { kind: 'arrow', points: arrowPoints(first, tip, Math.max(8, head), pressure) };
      }
    }
    return null;
  }

  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 8 || h < 8) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = w / 2;
  const ry = h / 2;
  // Rectangle: every bbox corner has a stroke point near it, and points hug the bbox border.
  const corners: P[] = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  const cornerTol = diag * 0.09;
  const cornersHit = corners.every((c) => ps.some((p) => dist(p, c) <= cornerTol));
  const borderErr = ps.reduce((s, p) => s + Math.min(p.x - minX, maxX - p.x, p.y - minY, maxY - p.y), 0) / ps.length / diag;
  if (cornersHit && borderErr < 0.04) return { kind: 'rectangle', points: rectanglePoints(minX, minY, maxX, maxY, pressure) };
  // Ellipse: normalized radius stays close to 1.
  const ellErr = ps.reduce((s, p) => s + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) / ps.length;
  if (ellErr < 0.12) return { kind: 'ellipse', points: ellipsePoints(cx, cy, rx, ry, pressure) };
  return null;
}
