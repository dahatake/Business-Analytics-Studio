import { describe, expect, it, vi } from 'vitest';
import { translate } from '../src/i18n/core.ts';
import { boardsToPdf, boardPage, isAscii, writePdf, wrapText, type PdfBoard } from '../src/modules/ink/pdf.ts';
import { recognizeShape } from '../src/modules/ink/shapes.ts';
import {
  applyErase, deleteSelection, eraseCircles, lassoSelect, moveSelection, pointInPolygon, strokeHitsCircle, strokesHitByPath,
} from '../src/modules/ink/geometry.ts';
import { clusterByColor, makeStroke, seedStrokes, strokeStats, EMPTY_CONTENT, type BoardContent, type Note } from '../src/modules/ink/model.ts';
import { Autosaver, MemoryStorage, applyJournal, makeJournal, readJournal, type Timers } from '../src/modules/ink/storage.ts';
import { BoardDoc } from '../src/modules/ink/doc.ts';
import { boardMarkdown, summaryPackMarkdown, type MdContext } from '../src/modules/ink/markdown.ts';
import { recognizeHandwriting } from '../src/modules/ink/handwriting.ts';
import { percentile } from '../src/modules/ink/surface.ts';

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');
const line = (pts: [number, number][], p = 0.5) => pts.flatMap(([x, y]) => [x, y, p]);

function polyline(points: [number, number][], step = 4): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(points[points.length - 1]!);
  return out;
}

const note = (id: string, x: number, y: number, text: string, color: Note['color'] = 'yellow', votes = 0): Note => ({ id, x, y, w: 160, h: 100, text, color, votes });

/** Parse the PDF structure: verify xref offsets point at "n 0 obj" and return trailer facts. */
function parsePdf(bytes: Uint8Array) {
  const s = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)?.[1]);
  expect(s.slice(startxref, startxref + 4)).toBe('xref');
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(startxref))!;
  const size = Number(head[1]);
  const entriesStart = startxref + head[0].length;
  const offsets: number[] = [];
  for (let i = 0; i < size; i++) {
    const entry = s.slice(entriesStart + i * 20, entriesStart + (i + 1) * 20);
    expect(entry).toMatch(/^\d{10} \d{5} [nf] \n$/);
    offsets.push(Number(entry.slice(0, 10)));
  }
  for (let i = 1; i < size; i++) expect(s.slice(offsets[i], offsets[i]! + `${i} 0 obj`.length), `object ${i}`).toBe(`${i} 0 obj`);
  const trailer = s.slice(entriesStart + size * 20);
  expect(trailer.startsWith('trailer\n<<')).toBe(true);
  expect(trailer).toContain(`/Size ${size}`);
  expect(trailer).toContain('/Root 1 0 R');
  const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)?.[1]);
  const pages = (s.match(/\/Type \/Page /g) ?? []).length;
  return { s, size, count, pages, offsets };
}

describe('FR-092 PDF writer', () => {
  const board = (title: string, c: BoardContent): PdfBoard => ({ title, content: c, noteText: (n) => (typeof n.text === 'string' ? n.text : n.text.en), cardText: (k) => k.entityId });

  it('writes a valid PDF 1.4 with correct xref offsets, trailer and one page per board', () => {
    const c1: BoardContent = { ...EMPTY_CONTENT, strokes: [makeStroke('pen', '#e5484d', 3, line([[0, 0], [50, 40], [100, 10]])), makeStroke('highlighter', '#ffe629', 18, line([[0, 60], [120, 60]]))], notes: [note('n1', 0, 100, 'Check (lead time) \\ now')] };
    const c2: BoardContent = { ...EMPTY_CONTENT, strokes: [makeStroke('pen', 'ink', 2, line([[5, 5]], 0.8))] };
    const c3 = EMPTY_CONTENT;
    const bytes = boardsToPdf([board('One', c1), board('Two', c2), board('Three', c3)], 'Test');
    expect(latin1(bytes.slice(0, 9))).toBe('%PDF-1.4\n');
    const { s, count, pages } = parsePdf(bytes);
    expect(count).toBe(3);
    expect(pages).toBe(3);
    // Vector paths with colour and width; highlighter uses the alpha graphics state; text is escaped Helvetica.
    expect(s).toMatch(/0\.898 0\.282 0\.302 RG/);
    expect(s).toMatch(/ m [\d. ]+ l/);
    expect(s).toContain(' S\n');
    expect(s).toContain('/GSH gs');
    expect(s).toContain('/BaseFont /Helvetica');
    expect(s).toContain('(Check \\(lead time\\) \\\\ now) Tj');
    // Content stream /Length equals the bytes between "stream\n" and "\nendstream".
    for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = m.index! + m[0].length;
      expect(s.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream');
    }
  });

  it('embeds a JPEG (DCTDecode) for boards with non-ASCII text, keeping strokes as vectors', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const c: BoardContent = { ...EMPTY_CONTENT, notes: [note('n1', 0, 0, '納期の確認')], strokes: [makeStroke('pen', '#3e8ef7', 2, line([[0, 0], [10, 10]]))] };
    const b = { ...board('ボード 1', c), raster: { data: jpeg, width: 4, height: 3 } };
    const bytes = writePdf([boardPage(b), boardPage(board('ASCII', EMPTY_CONTENT))], 'ボード');
    const { s, count } = parsePdf(bytes);
    expect(count).toBe(2);
    expect(s).toContain('/Subtype /Image /Width 4 /Height 3 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 9');
    expect(s).toContain('/XObject << /Im1 ');
    expect(s).toContain('/Im1 Do');
    expect(s).toContain('0.243 0.557 0.969 RG');
    expect(s).not.toContain('納');
    expect(/^[\n\x20-\x7e]*$/.test(s.slice(15, s.indexOf('/Subtype /Image')))).toBe(true);
    expect(isAscii('abc (x)')).toBe(true);
    expect(isAscii('在庫')).toBe(false);
    // Title in the info dictionary is UTF-16BE hex.
    expect(s).toContain('/Title <FEFF30DC30FC30C9>');
  });

  it('writes a valid single empty page document and wraps text', () => {
    const { count, size } = parsePdf(writePdf([{ width: 100, height: 100, content: '' }]));
    expect(count).toBe(1);
    expect(size).toBe(8);
    expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

describe('FR-089 shape recognizer', () => {
  it('recognizes a wobbly line', () => {
    const r = recognizeShape(line(polyline([[0, 0], [50, 3], [100, -2], [150, 1]])));
    expect(r?.kind).toBe('line');
    expect(r!.points).toHaveLength(6);
  });

  it('recognizes a rectangle', () => {
    const pts = polyline([[0, 0], [120, 2], [121, 80], [1, 79], [2, 3]]);
    const r = recognizeShape(line(pts));
    expect(r?.kind).toBe('rectangle');
    expect(r!.points.length / 3).toBe(5);
  });

  it('recognizes an ellipse', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push([100 + 80 * Math.cos(a) + (i % 3) - 1, 60 + 40 * Math.sin(a)]);
    }
    expect(recognizeShape(line(pts))?.kind).toBe('ellipse');
  });

  it('recognizes an arrow (shaft plus head)', () => {
    const pts = polyline([[0, 0], [150, 0], [130, -15], [150, 0], [130, 15]]);
    const r = recognizeShape(line(pts));
    expect(r?.kind).toBe('arrow');
    expect(r!.points.length / 3).toBe(5);
    expect(r!.points[3]).toBeCloseTo(150, 0);
  });

  it('rejects scribbles and tiny strokes', () => {
    expect(recognizeShape(line([[0, 0], [3, 3]]))).toBeNull();
    const zig = polyline([[0, 0], [30, 40], [60, 0], [90, 40], [120, 0], [150, 40]]);
    expect(recognizeShape(line(zig))).toBeNull();
  });
});

describe('FR-088 eraser and lasso', () => {
  const a = makeStroke('pen', 'ink', 2, line(polyline([[0, 0], [100, 0]])), 'a');
  const b = makeStroke('pen', 'ink', 2, line(polyline([[0, 50], [100, 50]])), 'b');
  const dot = makeStroke('pen', 'ink', 4, line([[200, 200]]), 'dot');

  it('hit-tests strokes against a circle including the stroke half width', () => {
    expect(strokeHitsCircle(a, 50, 5, 4)).toBe(true);
    expect(strokeHitsCircle(a, 50, 6, 4)).toBe(false);
    expect(strokeHitsCircle(dot, 205, 200, 4)).toBe(true);
    expect(strokesHitByPath([a, b, dot], [50, -20, 50, 20], 3)).toEqual(['a']);
    expect(strokesHitByPath([a, b, dot], [150, -20, 150, 100], 3)).toEqual([]);
    expect(strokesHitByPath([a, b, dot], [50, -20, 50, 0, 50, 50], 3)).toEqual(['a', 'b']);
  });

  it('partial eraser splits a stroke into the parts outside the eraser', () => {
    const sparse = makeStroke('pen', 'ink', 2, line([[0, 0], [100, 0]]), 's');
    const r = eraseCircles([sparse, b], [50, 0], 5, (base, i) => `${base}.${i}`);
    expect(r.remove).toEqual(['s']);
    expect(r.add.map((x) => x.id)).toEqual(['s.0', 's.1']);
    expect(r.add[0]!.box.maxX).toBeLessThan(45);
    expect(r.add[1]!.box.minX).toBeGreaterThan(55);
    const c = applyErase({ ...EMPTY_CONTENT, strokes: [sparse, b] }, r);
    expect(c.strokes.map((x) => x.id)).toEqual(['b', 's.0', 's.1']);
  });

  it('lasso selects strokes mostly inside and items whose centre is inside; move and delete follow', () => {
    const c: BoardContent = { ...EMPTY_CONTENT, strokes: [a, b], notes: [note('n1', -20, -20, 'x')], links: [{ id: 'l1', from: 'n1', to: 'n1' }] };
    const poly = [-30, -30, 110, -30, 110, 20, -30, 20];
    expect(pointInPolygon(0, 0, poly)).toBe(true);
    expect(pointInPolygon(0, 50, poly)).toBe(false);
    const sel = lassoSelect(c, poly);
    expect(sel.strokes).toEqual(['a']);
    expect(sel.items).toEqual([]);
    const sel2 = lassoSelect(c, [-40, -40, 200, -40, 200, 100, -40, 100]);
    expect(sel2.strokes).toEqual(['a', 'b']);
    expect(sel2.items).toEqual(['n1']);
    const moved = moveSelection(c, sel, 10, 5);
    expect(moved.strokes[0]!.box.minX).toBe(10);
    expect(moved.strokes[1]).toBe(b);
    const del = deleteSelection(c, sel2);
    expect(del.strokes).toEqual([]);
    expect(del.notes).toEqual([]);
    expect(del.links).toEqual([]);
  });
});

describe('FR-095 autosave and crash journal', () => {
  function fakeTimers() {
    let now = 0;
    const queue: { at: number; fn: () => void; id: number }[] = [];
    let seq = 0;
    const timers: Timers = {
      setTimeout: (fn, ms) => {
        const id = ++seq;
        queue.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (h) => {
        const i = queue.findIndex((q) => q.id === h);
        if (i >= 0) queue.splice(i, 1);
      },
    };
    const advance = async (ms: number) => {
      now += ms;
      for (;;) {
        queue.sort((x, y) => x.at - y.at);
        const q = queue[0];
        if (!q || q.at > now) break;
        queue.shift();
        q.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    return { timers, advance };
  }

  it('saves once per 2 s window however many changes happen (PARAM-025)', async () => {
    const save = vi.fn(async () => {});
    const { timers, advance } = fakeTimers();
    const a = new Autosaver(save, 2000, timers);
    a.markDirty();
    await advance(500);
    a.markDirty();
    await advance(1000);
    a.markDirty();
    expect(save).not.toHaveBeenCalled();
    await advance(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.pending).toBe(false);
    await advance(5000);
    expect(save).toHaveBeenCalledTimes(1);
    a.markDirty();
    await advance(1999);
    expect(save).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('flush saves immediately and a failed save stays dirty', async () => {
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error('quota');
    });
    const { timers } = fakeTimers();
    const a = new Autosaver(save, 2000, timers);
    a.markDirty();
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.pending).toBe(true);
    fail = false;
    await a.flush();
    expect(a.pending).toBe(false);
  });

  it('journals unsaved strokes and restores them after a "crash"', async () => {
    const storage = new MemoryStorage();
    const { timers } = fakeTimers();
    const scope = 'pj-test';
    const s1 = makeStroke('pen', 'ink', 2, line([[0, 0], [10, 10]]), 's1');
    const s2 = makeStroke('pen', 'ink', 2, line([[0, 5], [10, 15]]), 's2');
    const { doc } = await BoardDoc.open(storage, scope, 'b1', EMPTY_CONTENT, { timers });
    doc.commit({ ...doc.content, strokes: [s1] });
    await doc.autosaver.flush();
    expect(storage.saves).toBe(1);
    expect(readJournal(scope, 'b1')).toBeNull();
    doc.commit({ ...doc.content, strokes: [s1, s2], notes: [note('n', 0, 0, 'hi')] });
    const j = readJournal(scope, 'b1')!;
    expect(j.add.map((s) => s.id)).toEqual(['s2']);
    expect(j.remove).toEqual([]);
    // The page dies before the 2 s autosave: reopening applies the journal.
    const reopened = await BoardDoc.open(storage, scope, 'b1', EMPTY_CONTENT, { timers });
    expect(reopened.recovered).toBe(true);
    expect(reopened.doc.content.strokes.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(reopened.doc.content.notes).toHaveLength(1);
    expect(reopened.doc.autosaver.pending).toBe(true);
    await reopened.doc.close();
    expect(readJournal(scope, 'b1')).toBeNull();
    localStorage.clear();
  });

  it('journal diff covers removals', () => {
    const s1 = makeStroke('pen', 'ink', 2, line([[0, 0]]), 's1');
    const s2 = makeStroke('pen', 'ink', 2, line([[1, 1]]), 's2');
    const saved: BoardContent = { ...EMPTY_CONTENT, strokes: [s1, s2] };
    const j = makeJournal(saved, new Set(['s1', 's2']), { ...saved, strokes: [s2] })!;
    expect(j.remove).toEqual(['s1']);
    expect(applyJournal(saved, j).strokes.map((s) => s.id)).toEqual(['s2']);
    expect(makeJournal(saved, new Set(['s1', 's2']), saved)).toBeNull();
  });
});

describe('FR-088 undo / redo (PARAM-024)', () => {
  it('undoes and redoes commits, ignores previews and keeps at most 100 steps', async () => {
    const { doc } = await BoardDoc.open(new MemoryStorage(), 'pj-undo', 'b', EMPTY_CONTENT, { journal: false, interval: 60_000 });
    const strokes = seedStrokes(105, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    for (const s of strokes) doc.commit({ ...doc.content, strokes: [...doc.content.strokes, s] });
    expect(doc.content.strokes).toHaveLength(105);
    let undone = 0;
    while (doc.canUndo) {
      doc.undo();
      undone++;
    }
    expect(undone).toBe(100);
    expect(doc.content.strokes).toHaveLength(5);
    doc.redo();
    doc.redo();
    expect(doc.content.strokes).toHaveLength(7);
    const before = doc.content;
    doc.preview({ ...before, notes: [note('n', 0, 0, 'drag')] });
    doc.cancelPreview();
    expect(doc.content).toBe(before);
    doc.preview({ ...before, notes: [note('n', 5, 5, 'drag')] });
    doc.commit(doc.content);
    doc.undo();
    expect(doc.content).toBe(before);
    expect(doc.canRedo).toBe(true);
    doc.commit({ ...doc.content, strokes: [] });
    expect(doc.canRedo).toBe(false);
    await doc.close();
  });
});

describe('FR-093 / FR-094 Markdown export', () => {
  const ctx = (lang: 'ja' | 'en'): MdContext => ({
    t: (k, v) => translate(lang, k, v),
    noteText: (n) => (typeof n.text === 'string' ? n.text : n.text[lang]),
    colorName: (c) => translate(lang, `ink.noteColor.${c}` as never),
    entity: (id) => (id === 'cust-a' ? { name: 'Sakura Motors', kind: 'Customer', href: 'http://127.0.0.1/#/entity/cust-a' } : id === 'secret' ? { name: 'Restricted item', kind: 'Deal', href: null } : null),
  });
  const content: BoardContent = {
    strokes: [makeStroke('pen', 'ink', 2, line([[0, 0], [5, 5], [9, 9]])), makeStroke('highlighter', '#ffe629', 12, line([[0, 0], [9, 0]]))],
    notes: [note('n1', 0, 0, 'Low votes', 'green', 1), note('n2', 0, 200, 'Top *priority*', 'yellow', 3), { ...note('n3', 0, 300, ''), text: { ja: '在庫', en: 'Stock' } }],
    cards: [{ id: 'c1', entityId: 'cust-a', x: 0, y: 0, w: 100, h: 50 }, { id: 'c2', entityId: 'secret', x: 0, y: 0, w: 100, h: 50 }],
    links: [{ id: 'l1', from: 'n2', to: 'c1' }],
  };

  it('lists stats, notes (by votes), entity links, connections and the PNG image', () => {
    const md = boardMarkdown({ name: 'Kick-off', content, imageDataUri: 'data:image/png;base64,AAAA' }, ctx('en'));
    expect(md.startsWith('# Kick-off\n')).toBe(true);
    expect(md).toContain('- Strokes: 2 (pen 1, highlighter 1)');
    expect(md).toContain('- Points: 5, colours: 2');
    expect(md).toContain('- Sticky notes: 3, cards: 2, connections: 1');
    const top = md.indexOf('Top \\*priority\\*');
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(md.indexOf('Low votes'));
    expect(md).toContain('- [Yellow] Top \\*priority\\* (votes: 3)');
    expect(md).toContain('- [Yellow] Stock');
    expect(md).toContain('- [Sakura Motors](http://127.0.0.1/#/entity/cust-a) — Customer');
    expect(md).toContain('- Restricted item — Deal');
    expect(md).toContain('- Top \\*priority\\* → Sakura Motors');
    expect(md).toContain('![Kick-off](data:image/png;base64,AAAA)');
    expect(/[\u3040-\u30ff\u3400-\u9fff]/.test(md)).toBe(false);
    expect(boardMarkdown({ name: 'B', content }, ctx('ja'))).toContain('- [黄] 在庫');
  });

  it('bundles every board into one Engagement summary pack', () => {
    const md = summaryPackMarkdown([{ name: 'One', content }, { name: 'Two', content: EMPTY_CONTENT }], ctx('en'), { project: 'Acme', date: '2026-11-09' });
    expect(md.startsWith('# Engagement summary pack: Acme\n')).toBe(true);
    expect(md).toContain('- Boards: 2');
    expect(md).toContain('1. One\n2. Two');
    expect(md).toContain('## App data referenced (all boards)');
    expect(md).toContain('\n## One\n');
    expect(md).toContain('\n## Two\n');
    expect(md).toContain('### Sticky notes');
    expect(md.match(/Sakura Motors\]\(/g)?.length).toBe(2);
  });
});

describe('FR-090 / FR-099 / diagnostics helpers', () => {
  it('handwriting recognition answers with a labelled mock through aiComplete', async () => {
    const strokes = seedStrokes(3);
    const en = await recognizeHandwriting(strokes, 'en');
    expect(en.mode).toBe('mock');
    expect(en.text).toBe('[mock] Simulated text recognized from 3 strokes');
    expect((await recognizeHandwriting(strokes, 'ja')).text).toContain('[モック]');
  });

  it('clusters notes by colour into columns and keeps stats', () => {
    const notes = [note('a', 500, 500, 'a', 'green'), note('b', 0, 0, 'b', 'yellow'), note('c', 300, 10, 'c', 'green', 2)];
    const out = clusterByColor(notes);
    const by = Object.fromEntries(out.map((n) => [n.id, n]));
    expect(by.b!.x).toBe(0);
    expect(by.c!.x).toBe(by.a!.x);
    expect(by.c!.y).toBeLessThan(by.a!.y);
    expect(strokeStats(seedStrokes(10)).points).toBe(160);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });
});
