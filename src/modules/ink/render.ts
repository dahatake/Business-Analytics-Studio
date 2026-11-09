/** Canvas drawing shared by the board, the screen overlay and the exports. */
import { pressureWidth, type BoardContent, type Card, type Note, type Stroke } from './model.ts';
import { NOTE_PAPER, PAGE_H, PAGE_W, MARGIN, boxForPage, pageLayout } from './pdf.ts';

export interface View {
  /** screen = world * zoom + (x, y) (CSS px). */
  x: number;
  y: number;
  zoom: number;
}

export const HIGHLIGHT_ALPHA = 0.35;

function strokeColor(s: Stroke, ink: string) {
  return s.color === 'ink' ? ink : s.color;
}

/** Draw one stroke; `ctx` must already carry the world transform. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, ink: string): void {
  const p = s.points;
  if (p.length < 3) return;
  ctx.strokeStyle = strokeColor(s, ink);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (p.length === 3) {
    ctx.beginPath();
    ctx.arc(p[0]!, p[1]!, pressureWidth(s.width, p[2]!) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = HIGHLIGHT_ALPHA;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i]!, p[i + 1]!);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  let uniform = true;
  for (let i = 5; i < p.length; i += 3) if (p[i] !== p[2]) {
    uniform = false;
    break;
  }
  if (uniform) {
    ctx.lineWidth = pressureWidth(s.width, p[2]!);
    ctx.beginPath();
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i]!, p[i + 1]!);
    ctx.stroke();
    return;
  }
  // Pressure-varying width: batch consecutive segments with the same quantized width.
  let curW = -1;
  for (let i = 0; i + 3 < p.length; i += 3) {
    const w = Math.round(pressureWidth(s.width, (p[i + 2]! + p[i + 5]!) / 2) * 4) / 4;
    if (w !== curW) {
      if (curW >= 0) ctx.stroke();
      ctx.lineWidth = Math.max(0.25, w);
      ctx.beginPath();
      ctx.moveTo(p[i]!, p[i + 1]!);
      curW = w;
    }
    ctx.lineTo(p[i + 3]!, p[i + 4]!);
  }
  ctx.stroke();
}

/** Draw only segments [from, to) of a stroke being drawn (incremental live layer). */
export function drawSegments(ctx: CanvasRenderingContext2D, s: Stroke, fromPoint: number, ink: string): void {
  const p = s.points;
  ctx.strokeStyle = strokeColor(s, ink);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = Math.max(0, (fromPoint - 1) * 3); i + 3 < p.length; i += 3) {
    ctx.lineWidth = pressureWidth(s.width, (p[i + 2]! + p[i + 5]!) / 2);
    ctx.beginPath();
    ctx.moveTo(p[i]!, p[i + 1]!);
    ctx.lineTo(p[i + 3]!, p[i + 4]!);
    ctx.stroke();
  }
}

/** Render strokes visible in the viewport (CSS w × h) with culling. */
export function renderStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], view: View, w: number, h: number, dpr: number, ink: string, hidden?: Set<string>): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
  const minX = -view.x / view.zoom;
  const minY = -view.y / view.zoom;
  const maxX = minX + w / view.zoom;
  const maxY = minY + h / view.zoom;
  for (const s of strokes) {
    const m = s.width;
    if (s.box.maxX + m < minX || s.box.minX - m > maxX || s.box.maxY + m < minY || s.box.minY - m > maxY) continue;
    if (hidden?.has(s.id)) continue;
    drawStroke(ctx, s, ink);
  }
}

/** Wrap by measured width; works for spaced and unspaced (CJK) text. */
export function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of [...para]) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        const sp = line.lastIndexOf(' ');
        if (sp > 0 && ch !== ' ') {
          lines.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
        } else {
          lines.push(line);
          line = ch === ' ' ? '' : ch;
        }
      } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}

export interface RasterOptions {
  title: string;
  noteText: (n: Note) => string;
  cardText: (k: Card) => string;
  /** Include strokes and links (PNG for Markdown) or only title/notes/cards (JPEG under PDF vectors). */
  full: boolean;
  /** Pixels per PDF point. */
  density?: number;
}

/** Rasterize a board laid out exactly like its PDF page (white paper). */
export function rasterizeBoard(content: BoardContent, opts: RasterOptions): HTMLCanvasElement {
  const d = opts.density ?? 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAGE_W * d);
  canvas.height = Math.round(PAGE_H * d);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(d, d);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  const family = 'system-ui, "Segoe UI", "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#000000';
  ctx.font = `600 14px ${family}`;
  ctx.textBaseline = 'top';
  ctx.fillText(opts.title, MARGIN, MARGIN - 2);
  const L = pageLayout(boxForPage(content));
  ctx.save();
  ctx.translate(L.ox, L.oy);
  ctx.scale(L.scale, L.scale);
  const items = [...content.notes, ...content.cards];
  if (opts.full) {
    ctx.strokeStyle = '#666666';
    ctx.lineWidth = 1 / L.scale;
    for (const l of content.links) {
      const a = items.find((i) => i.id === l.from);
      const z = items.find((i) => i.id === l.to);
      if (!a || !z) continue;
      ctx.beginPath();
      ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
      ctx.lineTo(z.x + z.w / 2, z.y + z.h / 2);
      ctx.stroke();
    }
  }
  const block = (x: number, y: number, w: number, h: number, fill: string, border: string, text: string) => {
    ctx.fillStyle = fill;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#000000';
    ctx.font = `14px ${family}`;
    const lines = wrapCanvasText(ctx, text, w - 12);
    lines.slice(0, Math.max(1, Math.floor((h - 10) / 18))).forEach((ln, i) => ctx.fillText(ln, x + 6, y + 6 + i * 18));
  };
  for (const n of content.notes) block(n.x, n.y, n.w, n.h, NOTE_PAPER[n.color], '#8c8c8c', opts.noteText(n) + (n.votes ? `\n+${n.votes}` : ''));
  for (const k of content.cards) block(k.x, k.y, k.w, k.h, '#f5f5fa', '#4d4d99', opts.cardText(k));
  if (opts.full) for (const s of content.strokes) drawStroke(ctx, s, '#000000');
  ctx.restore();
  return canvas;
}

export function dataUriToBytes(uri: string): Uint8Array {
  const b64 = uri.slice(uri.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
