import { DEFAULT_PRIMARY } from '../../src/modules/ops/brand.ts';
import { CONTRAST_TEXT, ensureContrast, isHex, LIGHT_BG, normalizeHex } from '../../src/modules/ops/color.ts';
import { REFERENCES, verifyPack, type Problem, type VerifyResult } from './verify.ts';

/** PARAM-006: maximum self-correction rounds. */
export const MAX_ROUNDS = 3;

type Json = Record<string, unknown>;

export interface Fix {
  round: number;
  code: Problem['code'];
  path: string;
  note: string;
}

export interface SelfCorrectResult {
  pack: Json;
  rounds: number;
  fixes: Fix[];
  final: VerifyResult;
}

const clone = <T>(v: T): T => structuredClone(v);
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const ID_PREFIX: Record<string, string> = {
  site: 'site', person: 'person', customer: 'cust', product: 'prod', deal: 'deal', deliverable: 'dlv', invoice: 'inv',
  issue: 'issue', cause: 'cause', solution: 'sol', kpi: 'kpi', initiative: 'init', supplier: 'sup', source: 'src',
};

/** Fill what can be derived without guessing facts: the other language, a well-formed id, safe labels. */
function repairEntity(e: Json, index: number): string[] {
  const notes: string[] = [];
  for (const key of ['name', 'description', 'role', 'industry', 'category', 'unit', 'period', 'publisher']) {
    const v = e[key];
    if (isObj(v)) {
      const ja = typeof v.ja === 'string' && v.ja.trim() ? v.ja : '';
      const en = typeof v.en === 'string' && v.en.trim() ? v.en : '';
      if (ja && !en) { v.en = ja; notes.push(`${key}.en copied from ja`); }
      if (en && !ja) { v.ja = en; notes.push(`${key}.ja copied from en`); }
    }
  }
  if (typeof e.id === 'string' && !/^[a-z]+-[a-z0-9-]+$/.test(e.id)) {
    const prefix = ID_PREFIX[String(e.kind)] ?? 'item';
    const body = slug(e.id).replace(new RegExp(`^${prefix}-`), '') || `item-${index}`;
    const next = `${prefix}-${body}`;
    notes.push(`id "${e.id}" → "${next}"`);
    e.id = next;
  }
  if (!Array.isArray(e.sourceIds)) { e.sourceIds = []; notes.push('sourceIds set to []'); }
  if (e.classification === undefined) { e.classification = 'internal'; notes.push('classification set to internal (safe default)'); }
  if (e.author === undefined) { e.author = 'ai'; notes.push('author set to ai'); }
  return notes;
}

/** The source every generated number points to when research was unavailable (FR-115 + FR-121 "sample used"). */
export function researchSource(sourceId: string, publishedDate: string): Json {
  return {
    id: sourceId, kind: 'source', world: 'digital', type: 'data', classification: 'shareable', author: 'sample', sourceIds: [],
    name: { ja: '調査キャッシュ（サンプル使用）', en: 'Research cache (sample used)' },
    description: { ja: '事前調査が使えなかったため、お手本パックの数値を使った。', en: 'Research was unavailable, so the numbers come from the sample pack.' },
    publisher: { ja: '生成パイプライン', en: 'Generation pipeline' },
    publishedDate,
  };
}

/** Parse `entities[3].productIds[1]` style paths. */
function parsePath(path: string): { index: number; field?: string; item?: number } | null {
  const m = /^entities\[(\d+)\](?:\.(\w+)(?:\[(\d+)\])?)?$/.exec(path);
  if (!m) return null;
  return { index: Number(m[1]), ...(m[2] ? { field: m[2] } : {}), ...(m[3] !== undefined ? { item: Number(m[3]) } : {}) };
}

const MIN_ONE = new Set(['productIds', 'issueIds']);

/**
 * FR-126: fix ONLY the items verify reports as invalid, up to PARAM-006 rounds. Valid items are never touched.
 * Facts are never invented: a missing source is linked to the research-cache source, which says "sample used".
 */
export function selfCorrect(raw: unknown, opts: { defaultSourceId: string; today?: string; maxRounds?: number }): SelfCorrectResult {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  let pack = clone(raw) as Json;
  const fixes: Fix[] = [];
  let rounds = 0;
  let result = verifyPack(pack);
  while (!result.ok && rounds < maxRounds) {
    rounds++;
    const next = clone(pack);
    const entities = Array.isArray(next.entities) ? (next.entities as Json[]) : [];
    const removals: { index: number; field: string; item: number }[] = [];
    let changed = false;
    const fix = (p: Problem, note: string) => { fixes.push({ round: rounds, code: p.code, path: p.path, note }); changed = true; };
    for (const p of result.problems) {
      if (p.severity !== 'error') continue;
      const loc = parsePath(p.path);
      const e = loc ? entities[loc.index] : undefined;
      switch (p.code) {
        case 'ENTITY_SCHEMA': {
          if (!isObj(e)) break;
          const notes = repairEntity(e, loc!.index);
          if (notes.length) fix(p, notes.join('; '));
          break;
        }
        case 'DUPLICATE_ID': {
          if (!isObj(e)) break;
          const ids = new Set(entities.map((x) => (isObj(x) ? x.id : undefined)));
          let n = 2;
          while (ids.has(`${String(e.id)}-${n}`)) n++;
          fix(p, `id "${String(e.id)}" → "${String(e.id)}-${n}"`);
          e.id = `${String(e.id)}-${n}`;
          break;
        }
        case 'MISSING_SOURCE': {
          if (!isObj(e)) break;
          if (!entities.some((x) => isObj(x) && x.id === opts.defaultSourceId)) entities.push(researchSource(opts.defaultSourceId, today));
          e.sourceIds = [opts.defaultSourceId];
          fix(p, `sourceIds → [${opts.defaultSourceId}]`);
          break;
        }
        case 'SOURCE_KIND':
        case 'DANGLING_REF': {
          if (!isObj(e) || !loc?.field || loc.item === undefined || p.dependsOn) break;
          const arr = e[loc.field];
          const allowed = loc.field === 'sourceIds' || Object.keys(REFERENCES[e.kind as keyof typeof REFERENCES] ?? {}).includes(loc.field);
          if (!Array.isArray(arr) || !allowed) break;
          if (MIN_ONE.has(loc.field) && arr.length - removals.filter((r) => r.index === loc.index && r.field === loc.field).length <= 1) break;
          removals.push({ index: loc.index, field: loc.field, item: loc.item });
          fix(p, `removed ${loc.field}[${loc.item}] "${String(arr[loc.item])}"`);
          break;
        }
        case 'BRAND_CONTRAST': {
          const brand = (next.extensions as Json).brand as Json;
          const fg = ensureContrast(String(brand.primary), LIGHT_BG, CONTRAST_TEXT);
          brand.foreground = fg;
          fix(p, `extensions.brand.foreground → ${fg}`);
          break;
        }
        case 'BRAND_SCHEMA': {
          const ext = next.extensions as Json;
          const old = isObj(ext.brand) ? ext.brand : {};
          const primary = typeof old.primary === 'string' && isHex(old.primary) ? normalizeHex(old.primary) : DEFAULT_PRIMARY;
          ext.brand = { primary, source: { kind: 'defaultTheme' } };
          fix(p, `extensions.brand reset to { primary: ${primary}, source: defaultTheme } (FR-122)`);
          break;
        }
        default:
          break;
      }
    }
    // Remove array items from the end so indices stay valid.
    removals.sort((a, b) => b.item - a.item);
    for (const r of removals) (entities[r.index]![r.field] as unknown[]).splice(r.item, 1);
    if (!changed) { rounds--; break; }
    pack = next;
    result = verifyPack(pack);
  }
  return { pack, rounds, fixes, final: result };
}
