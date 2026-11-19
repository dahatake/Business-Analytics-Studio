import type { Lang } from '../../i18n/core.ts';
import { isVoiceKind, type EvidenceKind } from '../../data/extensionSchemas.ts';
import { parseCsv } from '../usecases/catalog.ts';
import type { Evidence } from './requirementsModel.ts';

/**
 * Turns a file the user drops (a policy text, a complaint log, an evaluation set) into evidence. Only what the
 * requirements need is kept: a short excerpt, the number of records, the columns and the label distribution. The
 * rows themselves are never stored, so a personal-data file does not end up in the project.
 */

export const EVIDENCE_FILE_MAX_BYTES = 2_000_000;
export const EXCERPT_CHARS = 800;
const LABEL_COLUMNS = /^(label|class|category|type|ラベル|分類|カテゴリ|区分|正解)$/i;
const MAX_LABELS = 12;

export type ParsedEvidence = Pick<Evidence, 'title' | 'summary' | 'count' | 'data'>;

export type EvidenceFileError = 'tooLarge' | 'empty' | 'format';

function rowsOf(name: string, text: string): string[][] | null {
  if (/\.tsv$/i.test(name)) return text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'));
  if (/\.csv$/i.test(name)) return parseCsv(text);
  if (/\.jsonl$/i.test(name) || /\.ndjson$/i.test(name)) {
    const objects = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    });
    if (objects.some((o) => !o || typeof o !== 'object' || Array.isArray(o))) return null;
    const columns = [...new Set(objects.flatMap((o) => Object.keys(o as object)))];
    return [columns, ...objects.map((o) => columns.map((c) => String((o as Record<string, unknown>)[c] ?? '')))];
  }
  if (/\.json$/i.test(name)) {
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null;
    if (!list || list.some((o) => !o || typeof o !== 'object' || Array.isArray(o))) return null;
    const columns = [...new Set(list.flatMap((o) => Object.keys(o as object)))];
    return [columns, ...list.map((o) => columns.map((c) => String((o as Record<string, unknown>)[c] ?? '')))];
  }
  return null;
}

/** Table kinds keep counts and columns; everything else keeps an excerpt of the text. */
export function parseEvidenceFile(name: string, text: string, kind: EvidenceKind, size: number, lang: Lang = 'ja'): { ok: true; value: ParsedEvidence } | { ok: false; error: EvidenceFileError } {
  if (size > EVIDENCE_FILE_MAX_BYTES) return { ok: false, error: 'tooLarge' };
  if (!text.trim()) return { ok: false, error: 'empty' };
  const title = name.replace(/\.[^.]+$/, '');
  const table = kind === 'evalData' || isVoiceKind(kind) ? rowsOf(name, text) : null;
  if (!table) {
    if (kind === 'evalData') return { ok: false, error: 'format' };
    return { ok: true, value: { title, summary: text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS) } };
  }
  const [header, ...rows] = table;
  if (!header || rows.length === 0) return { ok: false, error: 'empty' };
  const columns = header.map((h) => h.trim()).filter(Boolean);
  const labelAt = header.findIndex((h) => LABEL_COLUMNS.test(h.trim()));
  let labels: Record<string, number> | undefined;
  if (labelAt >= 0) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = (r[labelAt] ?? '').trim();
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LABELS);
    if (top.length) labels = Object.fromEntries(top);
  }
  const data = { rows: rows.length, columns, ...(labels ? { labels } : {}) };
  const summary = kind === 'evalData'
    ? (lang === 'ja' ? `${rows.length} 件、列: ${columns.slice(0, 8).join('、')}` : `${rows.length} rows, columns: ${columns.slice(0, 8).join(', ')}`)
    : (lang === 'ja' ? `${rows.length} 件の記録（列: ${columns.slice(0, 8).join('、')}）` : `${rows.length} records (columns: ${columns.slice(0, 8).join(', ')})`);
  return { ok: true, value: { title, summary, count: rows.length, data } };
}
