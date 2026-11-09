import { z } from 'zod';
import { loaded } from '../../data/pack.ts';
import { createScopedStore } from '../../state/projects.ts';
import { locAll } from '../../state/text.ts';
import type { DataEntity } from './catalogModel.ts';
import { normalizeId, normalizeName } from './normalize.ts';

/** PARAM-050 / PARAM-051: company data catalog import limits. */
export const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
export const MAX_CATALOG_ITEMS = 5000;

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), text(max).optional());

/** One item of a company data catalog. URLs are recorded as sources only; the app never fetches them. */
export const CatalogItem = z.object({
  id: optionalText(200),
  name: text(200).min(1),
  description: optionalText(2000),
  columns: z.preprocess(
    (v) => (Array.isArray(v) ? v.map((c) => (c && typeof c === 'object' && 'name' in c ? (c as { name: unknown }).name : c)) : v),
    z.array(text(200).min(1)).max(1000).optional(),
  ),
  domain: optionalText(200),
  url: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v), z.url({ protocol: /^https?$/ }).max(2000).optional()),
});
export type CatalogItem = z.infer<typeof CatalogItem>;

export interface ImportedCatalog {
  fileName: string;
  importedAt: string;
  items: CatalogItem[];
}

export interface RowError {
  /** 1-based item number (CSV: data row number, header excluded). */
  row: number;
  field: string;
}

export type ImportError = 'tooLarge' | 'tooMany' | 'format' | 'empty' | 'noName';
export type ImportResult =
  | { ok: true; catalog: ImportedCatalog; rowErrors: RowError[] }
  | { ok: false; error: ImportError; rowErrors: RowError[] };

/** RFC 4180-style CSV parsing (quotes, escaped quotes, CRLF, BOM). */
export function parseCsv(input: string): string[][] {
  const s = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const FIELDS = ['id', 'name', 'description', 'columns', 'domain', 'url'] as const;

function csvToRecords(textIn: string): { records: Record<string, unknown>[] } | { error: ImportError } {
  const rows = parseCsv(textIn);
  if (rows.length === 0) return { error: 'empty' };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  if (!header.includes('name')) return { error: 'noName' };
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, unknown> = {};
    header.forEach((h, i) => {
      if (!(FIELDS as readonly string[]).includes(h)) return;
      const v = r[i] ?? '';
      rec[h] = h === 'columns' ? v.split(/[;|]/).map((c) => c.trim()).filter(Boolean) : v;
    });
    return rec;
  });
  return { records };
}

function jsonToRecords(textIn: string): { records: unknown[] } | { error: ImportError } {
  let raw: unknown;
  try {
    raw = JSON.parse(textIn.replace(/^\uFEFF/, ''));
  } catch {
    return { error: 'format' };
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null;
  if (!list) return { error: 'format' };
  return { records: list };
}

/**
 * FR-161: validate a company data catalog file (JSON array / {items: []} or CSV with a header row).
 * File-level problems reject the whole file (the existing import stays); invalid rows are skipped and reported.
 */
export function parseCatalogFile(fileName: string, content: string, sizeBytes: number, now = new Date()): ImportResult {
  if (sizeBytes > MAX_CATALOG_BYTES) return { ok: false, error: 'tooLarge', rowErrors: [] };
  const isJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(content.replace(/^\uFEFF/, ''));
  const parsed = isJson ? jsonToRecords(content) : csvToRecords(content);
  if ('error' in parsed) return { ok: false, error: parsed.error, rowErrors: [] };
  if (parsed.records.length === 0) return { ok: false, error: 'empty', rowErrors: [] };
  if (parsed.records.length > MAX_CATALOG_ITEMS) return { ok: false, error: 'tooMany', rowErrors: [] };
  const items: CatalogItem[] = [];
  const rowErrors: RowError[] = [];
  parsed.records.forEach((rec, i) => {
    const r = CatalogItem.safeParse(rec);
    if (r.success) items.push(r.data);
    else rowErrors.push({ row: i + 1, field: r.error.issues.map((x) => String(x.path[0] ?? 'row')).filter((v, k, a) => a.indexOf(v) === k).join(', ') });
  });
  if (items.length === 0) return { ok: false, error: 'empty', rowErrors };
  return { ok: true, catalog: { fileName, importedAt: now.toISOString(), items }, rowErrors };
}

const PackCatalog = z.object({ items: z.array(CatalogItem).max(MAX_CATALOG_ITEMS) });

/** A customer pack may carry its company catalog in extensions.dataCatalog; validated with our own schema. */
function packCatalog(): ImportedCatalog | null {
  const raw = loaded.pack.extensions?.dataCatalog;
  const r = PackCatalog.safeParse(Array.isArray(raw) ? { items: raw } : raw);
  return r.success && r.data.items.length > 0 ? { fileName: 'pack', importedAt: '1970-01-01T00:00:00.000Z', items: r.data.items } : null;
}

/** Imported company catalog, per project (G-007). Re-import replaces it. */
export const useCatalogImport = createScopedStore<ImportedCatalog | null>('catalog.import', (scope) => (scope === 'demo' ? packCatalog() : null));

export type ReconCategory = 'match' | 'difference' | 'basOnly' | 'catalogOnly';
export const RECON_CATEGORIES: ReconCategory[] = ['match', 'difference', 'basOnly', 'catalogOnly'];
export type DiffReason = 'name' | 'columns';

export interface ReconRow {
  category: ReconCategory;
  entity?: DataEntity;
  item?: CatalogItem;
  /** How the pair was matched (FR-161: by normalized name and by id). */
  by?: 'id' | 'name';
  reasons: DiffReason[];
}

const sameColumns = (a: string[], b: string[]) => {
  const na = new Set(a.map(normalizeName));
  const nb = new Set(b.map(normalizeName));
  return na.size === nb.size && [...na].every((x) => nb.has(x));
};

/**
 * FR-161: reconcile BAS data entities with company catalog items.
 * match = same normalized id or name (and the same columns when both list them);
 * difference = matched by id but the name differs, or matched but the columns differ;
 * basOnly / catalogOnly = no counterpart.
 */
export function reconcile(entities: DataEntity[], items: CatalogItem[]): ReconRow[] {
  const byId = new Map<string, DataEntity>();
  const byName = new Map<string, DataEntity>();
  for (const e of entities) {
    byId.set(normalizeId(e.id), e);
    for (const n of locAll(e.name)) byName.set(normalizeName(n), e);
    for (const k of e.keys) if (!byName.has(k)) byName.set(k, e);
  }
  const claimed = new Set<string>();
  const rows: ReconRow[] = [];
  for (const item of items) {
    const idHit = item.id ? byId.get(normalizeId(item.id)) : undefined;
    const nameHit = byName.get(normalizeName(item.name));
    const entity = idHit && !claimed.has(idHit.id) ? idHit : nameHit && !claimed.has(nameHit.id) ? nameHit : undefined;
    if (!entity) {
      rows.push({ category: 'catalogOnly', item, reasons: [] });
      continue;
    }
    claimed.add(entity.id);
    const by = entity === idHit ? 'id' : 'name';
    const reasons: DiffReason[] = [];
    if (by === 'id' && nameHit !== entity) reasons.push('name');
    const packCols = entity.columns.filter((c) => c.source === 'pack').map((c) => c.name);
    if (item.columns && item.columns.length > 0 && packCols.length > 0 && !sameColumns(packCols, item.columns)) reasons.push('columns');
    rows.push({ category: reasons.length > 0 ? 'difference' : 'match', entity, item, by, reasons });
  }
  for (const e of entities) if (!claimed.has(e.id)) rows.push({ category: 'basOnly', entity: e, reasons: [] });
  return rows;
}

/** FR-172: columns and domain of matched catalog items enrich the entities (pack columns first). */
export function enrichEntities(entities: DataEntity[], rows: ReconRow[]): DataEntity[] {
  const extra = new Map<string, { columns: string[]; domain?: string }>();
  for (const r of rows) if (r.entity && r.item) extra.set(r.entity.id, { columns: r.item.columns ?? [], domain: r.item.domain });
  return entities.map((e) => {
    const x = extra.get(e.id);
    if (!x) return e;
    const have = new Set(e.columns.map((c) => normalizeName(c.name)));
    const added = x.columns.filter((c) => !have.has(normalizeName(c))).map((name) => ({ name, source: 'catalog' as const }));
    return { ...e, columns: [...e.columns, ...added], domain: x.domain ?? e.domain };
  });
}

export function countByCategory(rows: ReconRow[]): Record<ReconCategory, number> {
  const out: Record<ReconCategory, number> = { match: 0, difference: 0, basOnly: 0, catalogOnly: 0 };
  rows.forEach((r) => out[r.category]++);
  return out;
}
