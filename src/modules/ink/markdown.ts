/** FR-093 / FR-094: Markdown export of boards and the Engagement summary pack. Pure (no DOM). */
import type { MessageKey, Vars } from '../../i18n/core.ts';
import { strokeStats, type BoardContent, type Note } from './model.ts';

export interface MdEntity {
  name: string;
  kind: string;
  /** Absolute or hash link to the app entity; null when it must not be linked (restricted). */
  href: string | null;
}

export interface MdContext {
  t: (key: MessageKey, vars?: Vars) => string;
  noteText: (n: Note) => string;
  entity: (id: string) => MdEntity | null;
  colorName: (c: string) => string;
}

export interface MdBoard {
  name: string;
  content: BoardContent;
  /** PNG image of the board as a data URI. */
  imageDataUri?: string;
}

export function mdEscape(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/([\\`*_[\]#|<>])/g, '\\$1').trim();
}

function itemLabel(c: BoardContent, id: string, ctx: MdContext): string {
  const n = c.notes.find((x) => x.id === id);
  if (n) return mdEscape(ctx.noteText(n)) || ctx.t('ink.md.emptyNote');
  const k = c.cards.find((x) => x.id === id);
  if (k) return mdEscape(ctx.entity(k.entityId)?.name ?? k.entityId);
  return id;
}

export function boardMarkdown(b: MdBoard, ctx: MdContext, level = 1): string {
  const h = (n: number) => '#'.repeat(Math.min(6, level + n));
  const { t } = ctx;
  const c = b.content;
  const st = strokeStats(c.strokes);
  const out: string[] = [];
  out.push(`${h(0)} ${mdEscape(b.name)}`, '');
  out.push(`${h(1)} ${t('ink.md.stats')}`, '');
  out.push(`- ${t('ink.md.strokes', { count: st.strokes, pen: st.pen, highlighter: st.highlighter })}`);
  out.push(`- ${t('ink.md.points', { count: st.points, colors: st.colors })}`);
  out.push(`- ${t('ink.md.items', { notes: c.notes.length, cards: c.cards.length, links: c.links.length })}`, '');
  out.push(`${h(1)} ${t('ink.md.notes')}`, '');
  if (!c.notes.length) out.push(`- ${t('ink.md.none')}`);
  for (const n of [...c.notes].sort((a, z) => z.votes - a.votes || a.y - z.y || a.x - z.x)) {
    const votes = n.votes ? ` (${t('ink.md.votes', { count: n.votes })})` : '';
    out.push(`- [${ctx.colorName(n.color)}] ${mdEscape(ctx.noteText(n)) || t('ink.md.emptyNote')}${votes}`);
  }
  out.push('');
  out.push(`${h(1)} ${t('ink.md.cards')}`, '');
  if (!c.cards.length) out.push(`- ${t('ink.md.none')}`);
  for (const k of c.cards) {
    const e = ctx.entity(k.entityId);
    if (!e) out.push(`- ${k.entityId}`);
    else out.push(`- ${e.href ? `[${mdEscape(e.name)}](${e.href})` : mdEscape(e.name)} — ${mdEscape(e.kind)}`);
  }
  out.push('');
  if (c.links.length) {
    out.push(`${h(1)} ${t('ink.md.links')}`, '');
    for (const l of c.links) out.push(`- ${itemLabel(c, l.from, ctx)} → ${itemLabel(c, l.to, ctx)}`);
    out.push('');
  }
  if (b.imageDataUri) {
    out.push(`${h(1)} ${t('ink.md.image')}`, '', `![${mdEscape(b.name)}](${b.imageDataUri})`, '');
  }
  return out.join('\n');
}

export interface SummaryMeta {
  project: string;
  date: string;
}

/** FR-094: one Markdown bundling every board, with totals, a table of contents and all referenced app data. */
export function summaryPackMarkdown(boards: MdBoard[], ctx: MdContext, meta: SummaryMeta): string {
  const { t } = ctx;
  const out: string[] = [];
  out.push(`# ${t('ink.md.packTitle', { project: mdEscape(meta.project) })}`, '');
  out.push(`- ${t('ink.md.packDate', { date: meta.date })}`);
  out.push(`- ${t('ink.md.packBoards', { count: boards.length })}`);
  const all = boards.map((b) => b.content);
  out.push(`- ${t('ink.md.strokes', { count: all.reduce((s, c) => s + c.strokes.length, 0), pen: all.reduce((s, c) => s + strokeStats(c.strokes).pen, 0), highlighter: all.reduce((s, c) => s + strokeStats(c.strokes).highlighter, 0) })}`);
  out.push(`- ${t('ink.md.items', { notes: all.reduce((s, c) => s + c.notes.length, 0), cards: all.reduce((s, c) => s + c.cards.length, 0), links: all.reduce((s, c) => s + c.links.length, 0) })}`, '');
  out.push(`## ${t('ink.md.toc')}`, '');
  boards.forEach((b, i) => out.push(`${i + 1}. ${mdEscape(b.name)}`));
  out.push('');
  const ids = [...new Set(all.flatMap((c) => c.cards.map((k) => k.entityId)))];
  out.push(`## ${t('ink.md.allCards')}`, '');
  if (!ids.length) out.push(`- ${t('ink.md.none')}`);
  for (const id of ids) {
    const e = ctx.entity(id);
    out.push(`- ${e ? (e.href ? `[${mdEscape(e.name)}](${e.href})` : mdEscape(e.name)) : id}`);
  }
  out.push('');
  for (const b of boards) out.push(boardMarkdown(b, ctx, 2));
  return out.join('\n');
}
