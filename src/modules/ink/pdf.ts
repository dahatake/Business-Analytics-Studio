/**
 * FR-092: a minimal PDF 1.4 writer without dependencies.
 * Pages = boards. Strokes are vector paths (m / l / S) with their colours and widths; sticky-note and card text is
 * Helvetica when ASCII. When a board has non-ASCII text (e.g. Japanese, which the standard 14 fonts cannot show),
 * the notes/cards layer is embedded as a rasterized JPEG (DCTDecode image XObject) and strokes stay vector on top.
 */
import { pressureWidth, type BoardContent, type Box, type Card, type Note, type NoteColor, type Stroke } from './model.ts';

export interface PdfImage {
  /** JPEG bytes (baseline, RGB). */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PdfPageSpec {
  width: number;
  height: number;
  /** Content stream operators (ASCII only). */
  content: string;
  image?: PdfImage;
}

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** PDF text string as UTF-16BE hex (valid for any language in the document info). */
export function pdfTextString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/** Escape a literal string for the content stream (ASCII text only). */
export function pdfLiteral(s: string): string {
  return `(${s.replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

export function isAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

export function writePdf(pages: PdfPageSpec[], title = 'Board'): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const offsets: number[] = [0];
  const push = (b: Uint8Array) => {
    chunks.push(b);
    length += b.length;
  };
  const obj = (n: number, body: (Uint8Array | string)[]) => {
    offsets[n] = length;
    push(enc(`${n} 0 obj\n`));
    for (const b of body) push(typeof b === 'string' ? enc(b) : b);
    push(enc('\nendobj\n'));
  };

  push(enc('%PDF-1.4\n'));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Fixed objects: 1 catalog, 2 pages, 3 font, 4 highlighter alpha, 5 info. Pages start at 6.
  const pageNums: number[] = [];
  let next = 6;
  const plan = pages.map((p) => {
    const page = next++;
    const content = next++;
    const image = p.image ? next++ : 0;
    pageNums.push(page);
    return { p, page, content, image };
  });

  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`]);
  obj(3, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
  obj(4, ['<< /Type /ExtGState /CA 0.35 /ca 0.35 >>']);
  obj(5, [`<< /Title ${pdfTextString(title)} /Producer (Business Analytics Studio) >>`]);
  for (const { p, page, content, image } of plan) {
    const xobj = image ? ` /XObject << /Im1 ${image} 0 R >>` : '';
    obj(page, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] `
      + `/Resources << /Font << /F1 3 0 R >> /ExtGState << /GSH 4 0 R >>${xobj} >> /Contents ${content} 0 R >>`,
    ]);
    const stream = enc(p.content);
    obj(content, [`<< /Length ${stream.length} >>\nstream\n`, stream, '\nendstream']);
    if (image && p.image) {
      const im = p.image;
      obj(image, [
        `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`,
        im.data,
        '\nendstream',
      ]);
    }
  }

  const size = next;
  const xref = length;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) table += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  push(enc(table));
  push(enc(`trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Paper colours of notes for PDF/raster (the screen uses theme tokens). */
export const NOTE_PAPER: Record<NoteColor, string> = {
  yellow: '#fff1a8',
  green: '#c9f2d0',
  berry: '#f6d0ea',
  marigold: '#fde3b0',
  orange: '#ffd3bf',
};

export function rgb(color: string): [number, number, number] {
  if (color === 'ink') return [0, 0, 0];
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const rgbOp = (c: string, op: 'RG' | 'rg') => `${rgb(c).map((v) => num(Math.round(v * 1000) / 1000)).join(' ')} ${op}`;

export const PAGE_W = 842;
export const PAGE_H = 595;
export const MARGIN = 36;
export const HEADER = 28;

export interface PageLayout {
  scale: number;
  /** page X (top-down) = ox + world x * scale; page Y (top-down) = oy + world y * scale. */
  ox: number;
  oy: number;
}

/** Fit the board's content box into the page below the title. */
export function pageLayout(box: Box | null, pageW = PAGE_W, pageH = PAGE_H): PageLayout {
  const aw = pageW - MARGIN * 2;
  const ah = pageH - MARGIN * 2 - HEADER;
  if (!box) return { scale: 1, ox: MARGIN, oy: MARGIN + HEADER };
  const bw = Math.max(1, box.maxX - box.minX);
  const bh = Math.max(1, box.maxY - box.minY);
  const scale = Math.min(aw / bw, ah / bh, 2);
  return {
    scale,
    ox: MARGIN + (aw - bw * scale) / 2 - box.minX * scale,
    oy: MARGIN + HEADER + (ah - bh * scale) / 2 - box.minY * scale,
  };
}

/** Wrap text to lines of at most `max` characters (word-aware for spaced text). */
export function wrapText(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if ((line + word).length > max && line.trim()) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
      while (line.length > max) {
        lines.push(line.slice(0, max));
        line = line.slice(max);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export interface PdfBoard {
  title: string;
  content: BoardContent;
  noteText: (n: Note) => string;
  cardText: (k: Card) => string;
  /** Rasterized title + notes + cards (JPEG) used when the board has non-ASCII text. */
  raster?: PdfImage;
}

export function boardNeedsRaster(b: Omit<PdfBoard, 'raster'>): boolean {
  return !isAscii(b.title) || b.content.notes.some((n) => !isAscii(b.noteText(n).replace(/\n/g, ' '))) || b.content.cards.some((k) => !isAscii(b.cardText(k)));
}

function strokeOps(s: Stroke, L: PageLayout, pageH: number): string {
  const tx = (x: number) => num(Math.round((L.ox + x * L.scale) * 100) / 100);
  const ty = (y: number) => num(Math.round((pageH - (L.oy + y * L.scale)) * 100) / 100);
  const p = s.points;
  const ops: string[] = ['q'];
  if (s.tool === 'highlighter') ops.push('/GSH gs');
  ops.push(rgbOp(s.color, 'RG'), '1 J 1 j');
  if (p.length === 3) {
    ops.push(`${num(Math.max(0.2, pressureWidth(s.width, p[2]!) * L.scale))} w`, `${tx(p[0]!)} ${ty(p[1]!)} m ${tx(p[0]!)} ${ty(p[1]!)} l S`);
  } else {
    // Group consecutive segments with the same (quantized) width into one path.
    let curW = -1;
    let path = '';
    for (let i = 0; i + 3 < p.length; i += 3) {
      const w = s.tool === 'highlighter' ? s.width : pressureWidth(s.width, (p[i + 2]! + p[i + 5]!) / 2);
      const q = Math.max(0.2, Math.round(w * L.scale * 4) / 4);
      if (q !== curW) {
        if (path) ops.push(`${path} S`);
        ops.push(`${num(q)} w`);
        curW = q;
        path = `${tx(p[i]!)} ${ty(p[i + 1]!)} m`;
      }
      path += ` ${tx(p[i + 3]!)} ${ty(p[i + 4]!)} l`;
    }
    if (path) ops.push(`${path} S`);
  }
  ops.push('Q');
  return ops.join('\n');
}

/** Build one page for a board. */
export function boardPage(b: PdfBoard, pageW = PAGE_W, pageH = PAGE_H): PdfPageSpec {
  const box = boxForPage(b.content);
  const L = pageLayout(box, pageW, pageH);
  const ops: string[] = [];
  const X = (x: number) => L.ox + x * L.scale;
  const Y = (y: number) => pageH - (L.oy + y * L.scale);
  const raster = b.raster && boardNeedsRaster(b) ? b.raster : undefined;
  if (raster) {
    ops.push(`q ${num(pageW)} 0 0 ${num(pageH)} 0 0 cm /Im1 Do Q`);
  } else {
    ops.push(`BT /F1 14 Tf ${MARGIN} ${num(pageH - MARGIN - 14)} Td ${pdfLiteral(b.title)} Tj ET`);
  }
  // Links (vector).
  for (const l of b.content.links) {
    const a = [...b.content.notes, ...b.content.cards].find((i) => i.id === l.from);
    const z = [...b.content.notes, ...b.content.cards].find((i) => i.id === l.to);
    if (!a || !z) continue;
    ops.push(`q 0.4 0.4 0.4 RG 1 w ${num(X(a.x + a.w / 2))} ${num(Y(a.y + a.h / 2))} m ${num(X(z.x + z.w / 2))} ${num(Y(z.y + z.h / 2))} l S Q`);
  }
  if (!raster) {
    const fs = Math.max(5, Math.min(12, 11 * L.scale));
    const lead = fs * 1.25;
    const textBlock = (x: number, y: number, w: number, h: number, text: string) => {
      const max = Math.max(4, Math.floor((w * L.scale - 8) / (fs * 0.52)));
      const lines = wrapText(text, max).slice(0, Math.max(1, Math.floor((h * L.scale - 8) / lead)));
      ops.push(`BT /F1 ${num(fs)} Tf ${num(lead)} TL ${num(X(x) + 4)} ${num(Y(y) - 4 - fs)} Td`);
      lines.forEach((ln, i) => ops.push(`${i ? 'T* ' : ''}${pdfLiteral(ln)} Tj`));
      ops.push('ET');
    };
    for (const n of b.content.notes) {
      ops.push(`q ${rgbOp(NOTE_PAPER[n.color], 'rg')} 0.55 0.55 0.55 RG 0.5 w ${num(X(n.x))} ${num(Y(n.y + n.h))} ${num(n.w * L.scale)} ${num(n.h * L.scale)} re B Q`);
      ops.push('0 0 0 rg');
      textBlock(n.x, n.y, n.w, n.h, b.noteText(n) + (n.votes ? `\n+${n.votes}` : ''));
    }
    for (const k of b.content.cards) {
      ops.push(`q 0.96 0.96 0.98 rg 0.3 0.3 0.6 RG 1 w ${num(X(k.x))} ${num(Y(k.y + k.h))} ${num(k.w * L.scale)} ${num(k.h * L.scale)} re B Q`);
      ops.push('0 0 0 rg');
      textBlock(k.x, k.y, k.w, k.h, b.cardText(k));
    }
  }
  for (const s of b.content.strokes) ops.push(strokeOps(s, L, pageH));
  return { width: pageW, height: pageH, content: ops.join('\n'), ...(raster ? { image: raster } : {}) };
}

/** The box the page fits: board content, or a default area for an empty board. */
export function boxForPage(c: BoardContent): Box | null {
  const boxes: Box[] = [
    ...c.strokes.map((s) => ({ minX: s.box.minX - s.width, minY: s.box.minY - s.width, maxX: s.box.maxX + s.width, maxY: s.box.maxY + s.width })),
    ...[...c.notes, ...c.cards].map((i) => ({ minX: i.x, minY: i.y, maxX: i.x + i.w, maxY: i.y + i.h })),
  ];
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}

export function boardsToPdf(boards: PdfBoard[], title: string): Uint8Array {
  return writePdf(boards.map((b) => boardPage(b)), title);
}
