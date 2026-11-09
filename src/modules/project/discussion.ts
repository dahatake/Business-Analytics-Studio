import { z } from 'zod';
import { UndoStack } from '../../state/history.ts';
import { loc, type Localizable } from '../../state/text.ts';
import type { Lang } from '../../i18n/core.ts';
import { LocalizableSchema, newId, type Classification, type DiscussionData, type DiscussionRecord, type RecordKind, type Theme } from './model.ts';

/** PARAM-063: decisions and next actions per discussed theme (each), G-001. */
export const MIN_PER_THEME = 1;
export const MAX_TITLE = 200;
export const MAX_TEXT = 2000;
export const MAX_HISTORY = 500;

/* ---------- Tree (FR-042) ---------- */

export function childrenOf(data: DiscussionData, parentId: string | null): Theme[] {
  return data.themes.filter((t) => t.parentId === parentId || (parentId === null && t.parentId !== null && !data.themes.some((p) => p.id === t.parentId)));
}

export function descendantIds(data: DiscussionData, id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of data.themes) {
      if (t.parentId && out.has(t.parentId) && !out.has(t.id)) {
        out.add(t.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Depth-first order with depth, for the tree view and the export. */
export function treeOrder(data: DiscussionData): { theme: Theme; depth: number }[] {
  const out: { theme: Theme; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const t of childrenOf(data, parentId)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ theme: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/* ---------- Validation (FR-046) ---------- */

export type FieldError = 'required' | 'tooLong' | 'cycle' | 'dueFormat' | 'parentMissing';

export function validateTheme(data: DiscussionData, input: { title: string; parentId: string | null }, editingId?: string): { title?: FieldError; parent?: FieldError } {
  const out: { title?: FieldError; parent?: FieldError } = {};
  const title = input.title.trim();
  if (!title) out.title = 'required';
  else if (title.length > MAX_TITLE) out.title = 'tooLong';
  if (input.parentId) {
    if (!data.themes.some((t) => t.id === input.parentId)) out.parent = 'parentMissing';
    else if (editingId && descendantIds(data, editingId).has(input.parentId)) out.parent = 'cycle';
  }
  return out;
}

export function validateRecord(input: { text: string; due?: string }): { text?: FieldError; due?: FieldError } {
  const out: { text?: FieldError; due?: FieldError } = {};
  const text = input.text.trim();
  if (!text) out.text = 'required';
  else if (text.length > MAX_TEXT) out.text = 'tooLong';
  if (input.due && (!/^\d{4}-\d{2}-\d{2}$/.test(input.due) || Number.isNaN(Date.parse(input.due)))) out.due = 'dueFormat';
  return out;
}

/* ---------- Pure edits (FR-044) ---------- */

export function addTheme(data: DiscussionData, input: { title: string; parentId: string | null; classification: Classification }, id = newId('th')): DiscussionData {
  const theme: Theme = { id, parentId: input.parentId, title: input.title.trim(), classification: input.classification, relatedIds: [] };
  return { ...data, themes: [...data.themes, theme] };
}

export function updateTheme(data: DiscussionData, id: string, patch: Partial<Omit<Theme, 'id'>>): DiscussionData {
  return { ...data, themes: data.themes.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** Deleting a theme deletes its sub-themes and their records. */
export function deleteTheme(data: DiscussionData, id: string): DiscussionData {
  const gone = descendantIds(data, id);
  return { themes: data.themes.filter((t) => !gone.has(t.id)), records: data.records.filter((r) => !gone.has(r.themeId)) };
}

export function addRecord(
  data: DiscussionData,
  input: { themeId: string; kind: RecordKind; text: Localizable; author?: 'human' | 'ai'; owner?: string; due?: string; classification?: Classification; mock?: boolean },
  id = newId('rec'),
  at = new Date().toISOString(),
): DiscussionData {
  const record: DiscussionRecord = {
    id,
    themeId: input.themeId,
    kind: input.kind,
    author: input.author ?? (input.kind === 'suggestion' ? 'ai' : 'human'),
    text: typeof input.text === 'string' ? input.text.trim() : input.text,
    classification: input.classification ?? 'shareable',
    createdAt: at,
    ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
    ...(input.due ? { due: input.due } : {}),
    ...(input.kind === 'action' ? { done: false } : {}),
    ...(input.mock ? { mock: true } : {}),
  };
  return { ...data, records: [...data.records, record] };
}

export function updateRecord(data: DiscussionData, id: string, patch: Partial<Omit<DiscussionRecord, 'id'>>): DiscussionData {
  return { ...data, records: data.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

export function deleteRecord(data: DiscussionData, id: string): DiscussionData {
  return { ...data, records: data.records.filter((r) => r.id !== id) };
}

/** FR-050: the customer adopts an AI suggestion; it becomes a human decision (the suggestion stays as the trace). */
export function adoptSuggestion(data: DiscussionData, suggestionId: string, id = newId('rec'), at = new Date().toISOString()): DiscussionData {
  const s = data.records.find((r) => r.id === suggestionId);
  if (!s || s.kind !== 'suggestion') return data;
  return addRecord(data, { themeId: s.themeId, kind: 'decision', author: 'human', text: s.text, classification: s.classification }, id, at);
}

/* ---------- G-001 counts ---------- */

export interface ThemeCount {
  themeId: string;
  decisions: number;
  actions: number;
  /** Both counts reach PARAM-063. */
  met: boolean;
}

export function themeCounts(data: DiscussionData): ThemeCount[] {
  return data.themes.map((t) => {
    const recs = data.records.filter((r) => r.themeId === t.id);
    const decisions = recs.filter((r) => r.kind === 'decision').length;
    const actions = recs.filter((r) => r.kind === 'action').length;
    return { themeId: t.id, decisions, actions, met: decisions >= MIN_PER_THEME && actions >= MIN_PER_THEME };
  });
}

/* ---------- Undo/redo and change history (FR-046) ---------- */

export type ChangeOp = 'add' | 'update' | 'delete' | 'import' | 'undo' | 'redo' | 'adopt';
export type ChangeTarget = 'theme' | 'record' | 'all';

export const ChangeEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  who: z.string(),
  op: z.enum(['add', 'update', 'delete', 'import', 'undo', 'redo', 'adopt']),
  target: z.enum(['theme', 'record', 'all']),
  label: LocalizableSchema,
});
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

/**
 * Applies edits through one UndoStack (PARAM-024: 100) and appends who/when/what to the change history.
 * The history is append-only: undo and redo are themselves recorded.
 */
export class DiscussionEditor {
  readonly stack: UndoStack<DiscussionData>;
  history: ChangeEntry[];

  constructor(initial: DiscussionData, history: ChangeEntry[] = [], private readonly now = () => new Date().toISOString()) {
    this.stack = new UndoStack(initial);
    this.history = history;
  }

  get value(): DiscussionData {
    return this.stack.value;
  }

  private log(who: string, op: ChangeOp, target: ChangeTarget, label: Localizable) {
    this.history = [...this.history, { id: newId('chg'), at: this.now(), who, op, target, label }].slice(-MAX_HISTORY);
  }

  apply(next: DiscussionData, who: string, op: ChangeOp, target: ChangeTarget, label: Localizable): DiscussionData {
    if (next === this.stack.value) return next;
    this.stack.push(next);
    this.log(who, op, target, label);
    return next;
  }

  undo(who: string): DiscussionData {
    if (!this.stack.canUndo) return this.stack.value;
    const last = [...this.history].reverse().find((h) => h.op !== 'undo' && h.op !== 'redo');
    const v = this.stack.undo();
    this.log(who, 'undo', 'all', last?.label ?? '');
    return v;
  }

  redo(who: string): DiscussionData {
    if (!this.stack.canRedo) return this.stack.value;
    const v = this.stack.redo();
    this.log(who, 'redo', 'all', '');
    return v;
  }

  /** Swap to another project's data without history (G-007). */
  reset(value: DiscussionData, history: ChangeEntry[]) {
    this.stack.reset(value);
    this.history = history;
  }
}

/* ---------- Lens: Business ⇔ IT (FR-019) ---------- */

export type Lens = 'business' | 'it';

export const GlossaryEntrySchema = z.object({
  term: LocalizableSchema,
  definition: LocalizableSchema,
  /** The IT-lens label of the term (optional). */
  it: LocalizableSchema.optional(),
});
export const GlossarySchema = z.array(GlossaryEntrySchema);
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

/** Validate `extensions.glossary`; invalid entries are skipped (FR-102 style), not fatal. */
export function parseGlossary(raw: unknown): GlossaryEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: GlossaryEntry[] = [];
  for (const e of raw) {
    const r = GlossaryEntrySchema.safeParse(e);
    if (r.success) out.push(r.data);
  }
  return out.length ? out : null;
}

/** Replace business terms with their IT labels (longest term first). Business lens returns the text unchanged. */
export function applyLens(text: string, glossary: GlossaryEntry[], lang: Lang, lens: Lens): string {
  if (lens === 'business') return text;
  const pairs = glossary
    .filter((g) => g.it)
    .flatMap((g) => {
      const its = loc(g.it as Localizable, lang);
      const terms = typeof g.term === 'string' ? [g.term] : [g.term[lang], g.term.ja, g.term.en];
      return [...new Set(terms)].filter(Boolean).map((term) => ({ term, it: its }));
    })
    .sort((a, b) => b.term.length - a.term.length);
  if (!pairs.length) return text;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(pairs.map((p) => escape(p.term)).join('|'), 'gi');
  return text.replace(re, (m) => pairs.find((p) => p.term.toLowerCase() === m.toLowerCase())?.it ?? m);
}

export const DEMO_GLOSSARY: GlossaryEntry[] = [
  { term: { ja: '需要予測', en: 'demand forecasting' }, it: { ja: '時系列予測モデル', en: 'time-series forecasting model' }, definition: { ja: '過去の受注から将来の需要を見積もること。', en: 'Estimating future demand from past orders.' } },
  { term: { ja: '外観検査', en: 'visual inspection' }, it: { ja: '画像分類モデル', en: 'image classification model' }, definition: { ja: '製品の傷や欠けを目で確かめる検査。', en: 'Checking products for scratches and chips by eye.' } },
  { term: { ja: 'リードタイム', en: 'lead time' }, it: { ja: '処理時間メトリクス', en: 'cycle-time metric' }, definition: { ja: '受注から出荷までにかかる日数。', en: 'Days from order to shipment.' } },
  { term: { ja: '請求書', en: 'invoice' }, it: { ja: '請求データ（ERP）', en: 'billing records (ERP)' }, definition: { ja: '取引先へ代金を求める書類。', en: 'The document that asks a customer for payment.' } },
  { term: { ja: '生産計画', en: 'production planning' }, it: { ja: 'スケジューリング API', en: 'scheduling API' }, definition: { ja: 'いつ何をどれだけ作るかを決めること。', en: 'Deciding what to make, when and how much.' } },
];

/* ---------- Demo data (bilingual; new projects start empty) ---------- */

const DEMO_AT = '2026-11-09T10:00:00+09:00';

export function demoDiscussion(): DiscussionData {
  const themes: Theme[] = [
    { id: 'th-demo-leadtime', parentId: null, title: { ja: '受注から出荷までのリードタイムを短くする', en: 'Shorten the lead time from order to shipment' }, classification: 'shareable', relatedIds: ['issue-lead-time', 'kpi-lead-time', 'person-sato-yui'] },
    { id: 'th-demo-forecast', parentId: 'th-demo-leadtime', title: { ja: '需要予測で生産計画を前倒しする', en: 'Bring production planning forward with demand forecasting' }, classification: 'shareable', relatedIds: ['sol-demand-planning'] },
    { id: 'th-demo-quality', parentId: null, title: { ja: '外観検査の品質を安定させる', en: 'Stabilize the quality of visual inspection' }, classification: 'shareable', relatedIds: ['issue-quality', 'sol-vision-inspection', 'person-tanaka-ren'] },
    { id: 'th-demo-cash', parentId: null, title: { ja: '請求書の電子化で入金を早める', en: 'Collect cash sooner by digitizing the invoice' }, classification: 'internal', relatedIds: ['issue-cash', 'sol-e-invoice'] },
  ];
  const r = (id: string, themeId: string, kind: RecordKind, ja: string, en: string, extra: Partial<DiscussionRecord> = {}): DiscussionRecord => ({
    id, themeId, kind, author: kind === 'suggestion' ? 'ai' : 'human', text: { ja, en }, classification: 'shareable', createdAt: DEMO_AT,
    ...(kind === 'action' ? { done: false } : {}), ...extra,
  });
  const records: DiscussionRecord[] = [
    r('rec-demo-1', 'th-demo-leadtime', 'note', '現状は受注から出荷まで平均 16 日（2026 年度の月次平均）。繁忙期に遅れが集中する。', 'Today order to shipment takes 16 days on average (FY2026 monthly average); delays cluster in peak season.'),
    r('rec-demo-2', 'th-demo-leadtime', 'decision', 'リードタイムを 2027 年 3 月までに 10 日以下にする。', 'Cut lead time to 10 days or less by March 2027.'),
    r('rec-demo-3', 'th-demo-leadtime', 'suggestion', '繁忙期の 2 か月前から需要予測で生産計画を見直す。', 'Revisit production planning with demand forecasting two months before peak season.', { mock: true }),
    r('rec-demo-4', 'th-demo-leadtime', 'action', '過去 3 年分の受注データを分析用に用意する。', 'Prepare three years of order data for analysis.', { owner: 'Sato', due: '2026-11-30' }),
    r('rec-demo-5', 'th-demo-forecast', 'note', '予測の粒度は品目別・週次から始める。', 'Start forecasting per item, weekly.'),
    r('rec-demo-6', 'th-demo-quality', 'decision', '第 1 工場のラインで画像検査を試行する。', 'Pilot image-based inspection on the Plant 1 line.'),
    r('rec-demo-7', 'th-demo-quality', 'action', '不良品の画像を 500 枚集める。', 'Collect 500 images of defective parts.', { owner: 'Tanaka', due: '2026-12-15' }),
    r('rec-demo-8', 'th-demo-cash', 'note', '請求の 6 割がまだ紙で送られている。', 'Six in ten invoices are still sent on paper.', { classification: 'internal' }),
  ];
  return { themes, records };
}
