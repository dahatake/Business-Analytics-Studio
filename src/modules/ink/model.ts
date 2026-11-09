import type { Localizable } from '../../state/text.ts';

/** PARAM-009: target time of one ink frame (ms). */
export const FRAME_BUDGET_MS = 16;
/** PARAM-010: stroke count whose drawing performance is guaranteed. */
export const PERF_STROKES = 20000;
/** PARAM-025: ink autosave interval (ms). */
export const AUTOSAVE_MS = 2000;

export type StrokeTool = 'pen' | 'highlighter';

/** A committed stroke in world coordinates. `points` is flat: x0, y0, p0, x1, y1, p1, … (p = pressure 0..1). */
export interface Stroke {
  id: string;
  tool: StrokeTool;
  /** CSS colour, or 'ink' = the theme's foreground (black on paper/PDF). */
  color: string;
  /** Base width in world units; the drawn width follows pressure. */
  width: number;
  points: number[];
  /** Bounding box (without width), cached for culling and hit-testing. */
  box: Box;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const NOTE_COLORS = ['yellow', 'green', 'berry', 'marigold', 'orange'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/** FR-097: sticky note. Sample text is bilingual; typed text is stored as typed. */
export interface Note {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: Localizable;
  color: NoteColor;
  /** FR-099 dot voting. */
  votes: number;
}

/** FR-098: an app-data card placed on the board (any pack entity). */
export interface Card {
  id: string;
  entityId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** FR-098: a link between two items (notes or cards). */
export interface Link {
  id: string;
  from: string;
  to: string;
}

export interface BoardContent {
  strokes: Stroke[];
  notes: Note[];
  cards: Card[];
  links: Link[];
}

/** Board metadata (FR-086). `name: null` shows the localized default name. */
export interface BoardMeta {
  id: string;
  name: string | null;
  createdAt: string;
}

export const EMPTY_CONTENT: BoardContent = { strokes: [], notes: [], cards: [], links: [] };

let seq = 0;
export function newId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function boxOf(points: number[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function makeStroke(tool: StrokeTool, color: string, width: number, points: number[], id = newId('s')): Stroke {
  return { id, tool, color, width, points, box: boxOf(points) };
}

/** Drawn width of a segment for a pressure (0..1). Mouse/touch report 0.5 → base width. */
export function pressureWidth(base: number, pressure: number): number {
  const p = Math.min(1, Math.max(0, pressure));
  return base * (0.3 + 1.4 * p);
}

export function itemBox(item: { x: number; y: number; w: number; h: number }): Box {
  return { minX: item.x, minY: item.y, maxX: item.x + item.w, maxY: item.y + item.h };
}

/** Bounding box of everything on a board, or null when empty. */
export function contentBox(c: BoardContent): Box | null {
  const boxes: Box[] = [
    ...c.strokes.map((s) => ({ minX: s.box.minX - s.width, minY: s.box.minY - s.width, maxX: s.box.maxX + s.width, maxY: s.box.maxY + s.width })),
    ...c.notes.map(itemBox),
    ...c.cards.map(itemBox),
  ];
  if (boxes.length === 0) return null;
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}

export function itemCenter(c: BoardContent, id: string): { x: number; y: number } | null {
  const it = c.notes.find((n) => n.id === id) ?? c.cards.find((k) => k.id === id);
  return it ? { x: it.x + it.w / 2, y: it.y + it.h / 2 } : null;
}

/** Resize a note or card (keyboard: from its current size; dragging: from the start size). */
export function resizeItem(c: BoardContent, id: string, dw: number, dh: number, base?: { w: number; h: number }): BoardContent {
  const fit = <T extends { id: string; w: number; h: number }>(it: T): T =>
    it.id === id ? { ...it, w: Math.max(MIN_ITEM_W, (base?.w ?? it.w) + dw), h: Math.max(MIN_ITEM_H, (base?.h ?? it.h) + dh) } : it;
  return { ...c, notes: c.notes.map(fit), cards: c.cards.map(fit) };
}

export const MIN_ITEM_W = 80;
export const MIN_ITEM_H = 48;

/** Remove links whose ends no longer exist. */
export function pruneLinks(c: BoardContent): BoardContent {
  const ids = new Set([...c.notes.map((n) => n.id), ...c.cards.map((k) => k.id)]);
  const links = c.links.filter((l) => ids.has(l.from) && ids.has(l.to));
  return links.length === c.links.length ? c : { ...c, links };
}

/** FR-099 clustering: arrange notes into one column per colour, starting at the notes' top-left. */
export function clusterByColor(notes: Note[], gap = 16): Note[] {
  if (!notes.length) return notes;
  const x0 = Math.min(...notes.map((n) => n.x));
  const y0 = Math.min(...notes.map((n) => n.y));
  const groups = NOTE_COLORS.map((c) => notes.filter((n) => n.color === c).sort((a, b) => b.votes - a.votes || a.y - b.y)).filter((g) => g.length);
  const pos = new Map<string, { x: number; y: number }>();
  let x = x0;
  for (const g of groups) {
    let y = y0;
    const w = Math.max(...g.map((n) => n.w));
    for (const n of g) {
      pos.set(n.id, { x, y });
      y += n.h + gap;
    }
    x += w + gap * 2;
  }
  return notes.map((n) => ({ ...n, ...pos.get(n.id)! }));
}

/** Demo scope: the first board starts from sample content; new projects start empty. */
export function initialContent(scope: string, boardId: string): BoardContent {
  if (scope !== 'demo' || boardId !== DEMO_BOARD_ID) return EMPTY_CONTENT;
  return {
    strokes: [],
    notes: [
      { id: 'note-demo-1', x: 40, y: 40, w: 180, h: 110, color: 'yellow', votes: 2, text: { ja: '納期遅れの主因を確認する', en: 'Confirm the main cause of late delivery' } },
      { id: 'note-demo-2', x: 260, y: 40, w: 180, h: 110, color: 'green', votes: 1, text: { ja: '在庫の見える化を提案', en: 'Propose inventory visibility' } },
    ],
    cards: [
      { id: 'card-demo-1', entityId: 'cust-sakura-motors', x: 40, y: 200, w: 200, h: 80 },
      { id: 'card-demo-2', entityId: 'kpi-engagement', x: 300, y: 200, w: 200, h: 80 },
    ],
    links: [{ id: 'link-demo-1', from: 'note-demo-1', to: 'card-demo-1' }],
  };
}

export const DEMO_BOARD_ID = 'board-main';

export function initialBoards(): BoardMeta[] {
  return [{ id: DEMO_BOARD_ID, name: null, createdAt: '2026-11-01T00:00:00.000Z' }];
}

export interface StrokeStats {
  strokes: number;
  pen: number;
  highlighter: number;
  points: number;
  colors: number;
}

export function strokeStats(strokes: Stroke[]): StrokeStats {
  let pen = 0;
  let points = 0;
  const colors = new Set<string>();
  for (const s of strokes) {
    if (s.tool === 'pen') pen++;
    points += s.points.length / 3;
    colors.add(s.color);
  }
  return { strokes: strokes.length, pen, highlighter: strokes.length - pen, points, colors: colors.size };
}

/** Deterministic pseudo-random strokes for the performance diagnostics (PARAM-010). */
export function seedStrokes(n: number, area: Box = { minX: 0, minY: 0, maxX: 4000, maxY: 3000 }, seed = 1): Stroke[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const colors = ['ink', '#e5484d', '#3e8ef7', '#30a46c'];
  const out: Stroke[] = [];
  for (let i = 0; i < n; i++) {
    let x = area.minX + rnd() * (area.maxX - area.minX);
    let y = area.minY + rnd() * (area.maxY - area.minY);
    const pts: number[] = [];
    let a = rnd() * Math.PI * 2;
    for (let k = 0; k < 16; k++) {
      pts.push(x, y, 0.5);
      a += (rnd() - 0.5) * 0.8;
      x += Math.cos(a) * 6;
      y += Math.sin(a) * 6;
    }
    out.push(makeStroke('pen', colors[i % colors.length]!, 2, pts, `seed-${seed}-${i}`));
  }
  return out;
}
