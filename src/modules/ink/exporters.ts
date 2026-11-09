/** Browser-side glue for exports (FR-092 / FR-093 / FR-094): text resolution, rasterizing and downloads. */
import { getEntity } from '../../data/pack.ts';
import { translate, type Lang, type MessageKey } from '../../i18n/core.ts';
import { hrefFor } from '../../state/router.ts';
import { loc } from '../../state/text.ts';
import { isHidden, routeFor } from '../../ui/cardSpecs.ts';
import type { BoardContent, Card, Note } from './model.ts';
import { boardMarkdown, summaryPackMarkdown, type MdBoard, type MdContext } from './markdown.ts';
import { boardNeedsRaster, boardsToPdf, type PdfBoard } from './pdf.ts';
import { dataUriToBytes, rasterizeBoard } from './render.ts';

export interface ExportBoard {
  name: string;
  content: BoardContent;
}

export interface TextFns {
  noteText: (n: Note) => string;
  cardText: (k: Card) => string;
  entityName: (id: string) => string;
}

export function textFns(lang: Lang, audience: 'internal' | 'external'): TextFns {
  const entityName = (id: string) => {
    const e = getEntity(id);
    if (!e) return id;
    return isHidden(e, audience) ? translate(lang, 'card.restrictedName') : e.name[lang];
  };
  return {
    noteText: (n) => loc(n.text, lang),
    entityName,
    cardText: (k) => {
      const e = getEntity(k.entityId);
      return e ? `${entityName(k.entityId)} (${translate(lang, `kind.${e.kind}` as MessageKey)})` : k.entityId;
    },
  };
}

export function mdContext(lang: Lang, audience: 'internal' | 'external'): MdContext {
  const fns = textFns(lang, audience);
  return {
    t: (key, vars) => translate(lang, key, vars),
    noteText: fns.noteText,
    colorName: (c) => translate(lang, `ink.noteColor.${c}` as MessageKey),
    entity: (id) => {
      const e = getEntity(id);
      if (!e) return null;
      const hidden = isHidden(e, audience);
      const route = hidden ? null : routeFor(e);
      return {
        name: fns.entityName(id),
        kind: translate(lang, `kind.${e.kind}` as MessageKey),
        href: route ? new URL(hrefFor(route), window.location.href).href : null,
      };
    },
  };
}

export function boardPngDataUri(b: ExportBoard, fns: TextFns): string {
  return rasterizeBoard(b.content, { title: b.name, noteText: fns.noteText, cardText: fns.cardText, full: true, density: 1.5 }).toDataURL('image/png');
}

export function buildPdf(boards: ExportBoard[], fns: TextFns, title: string): Uint8Array {
  const pages: PdfBoard[] = boards.map((b) => {
    const page: PdfBoard = { title: b.name, content: b.content, noteText: fns.noteText, cardText: fns.cardText };
    if (boardNeedsRaster(page)) {
      const canvas = rasterizeBoard(b.content, { title: b.name, noteText: fns.noteText, cardText: fns.cardText, full: false });
      page.raster = { data: dataUriToBytes(canvas.toDataURL('image/jpeg', 0.88)), width: canvas.width, height: canvas.height };
    }
    return page;
  });
  return boardsToPdf(pages, title);
}

export function buildBoardMarkdown(b: ExportBoard, lang: Lang, audience: 'internal' | 'external', withImage = true): string {
  const md: MdBoard = { name: b.name, content: b.content, ...(withImage ? { imageDataUri: boardPngDataUri(b, textFns(lang, audience)) } : {}) };
  return boardMarkdown(md, mdContext(lang, audience));
}

export function buildSummaryPack(boards: ExportBoard[], lang: Lang, audience: 'internal' | 'external', project: string, withImages = true): string {
  const fns = textFns(lang, audience);
  const md = boards.map((b) => ({ name: b.name, content: b.content, ...(withImages ? { imageDataUri: boardPngDataUri(b, fns) } : {}) }));
  return summaryPackMarkdown(md, mdContext(lang, audience), { project, date: new Date().toISOString().slice(0, 10) });
}

export function download(filename: string, data: Uint8Array | string, mime: string): void {
  const blob = new Blob([typeof data === 'string' ? data : data.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'board';
}
