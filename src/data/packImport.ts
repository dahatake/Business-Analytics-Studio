import { z } from 'zod';
import { Entity, LText, type EntityKind } from './schema.ts';
import { samplePack } from './sample.ts';
import { verifyPack, type Problem, type VerifyResult } from './verify.ts';
import { DEFAULT_PRIMARY, parseBrand } from '../modules/ops/brand.ts';

/**
 * FR-302〜FR-304: turn files or a pasted Microsoft 365 Copilot answer into one customer pack.
 * extract (```json blocks) → merge parts → normalize the shape (never the facts) → verify with the CLI's own rules.
 * Pure: no storage, no network. The screen (PackDataScreen) and the tests drive it.
 */

/** PARAM-142: upper size of one uploaded file. */
export const MAX_PACK_FILE_BYTES = 5 * 1024 * 1024;
/** Fix prompts list at most this many problems so the prompt stays within the chat input limit. */
export const FIX_PROMPT_MAX_PROBLEMS = 50;

export interface InputDoc {
  name: string;
  text: string;
}

export type FileStatus = 'used' | 'unrecognized' | 'parseError' | 'tooLarge' | 'unsupported';

export interface FileReport {
  name: string;
  status: FileStatus;
  fragments: number;
  /** Parser message (English, technical) for parseError. */
  detail?: string;
}

export type NoteCode =
  | 'langFilled' | 'sourceIdsAdded' | 'classificationDefaulted' | 'authorDefaulted' | 'worldTypeFilled'
  | 'illustrationFilled' | 'numberParsed' | 'packIdGenerated' | 'isSampleDefaulted' | 'regionsDefaulted'
  | 'flowsDefaulted' | 'duplicateDropped' | 'partMissing' | 'conflict';

/** A change made to the shape (not the facts) of the input, shown to the user before import. */
export interface Note {
  code: NoteCode;
  count: number;
  /** Paths, part labels or field names (technical). */
  detail?: string;
}

export interface PackSummary {
  company: { name: z.infer<typeof LText> | null; industry: z.infer<typeof LText> | null };
  isSample: boolean;
  byKind: Partial<Record<EntityKind, number>>;
  entities: number;
  internal: number;
  shareable: number;
  people: number;
  regions: number;
  flows: number;
  hasOptimization: boolean;
  hasBrand: boolean;
  /** The input contains a logo declaration (the image still requires permission). */
  hasLogo: boolean;
}

/** Strip logo data before persistence unless the user has explicitly approved its use. */
export function withoutPackLogo(pack: Record<string, unknown>): Record<string, unknown> {
  const extensions = pack.extensions;
  if (!isRecord(extensions) || !isRecord(extensions.brand)) return pack;
  const { logo: _logo, ...brand } = extensions.brand;
  return { ...pack, extensions: { ...extensions, brand } };
}

/** Prepare a portable logo without loading network resources or trusting a file extension. */
export function preparePackLogo(pack: Record<string, unknown>, approved: boolean, bytes?: Uint8Array): Record<string, unknown> {
  if (!approved) return withoutPackLogo(pack);
  const parsed = parseBrand(isRecord(pack.extensions) ? pack.extensions : undefined);
  if (!parsed.ok) throw new Error(parsed.issues.join('; '));
  const logo = parsed.profile?.logo;
  if (!bytes && logo?.image) {
    const encoded = logo.image.slice(logo.image.indexOf(',') + 1);
    try { bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)); }
    catch { throw new Error('invalid logo encoding'); }
  }
  if (!bytes) {
    if (logo) throw new Error('logo image file not found');
    return pack;
  }
  if (bytes.length > MAX_PACK_FILE_BYTES) throw new Error('logo is too large');
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes![i] === v);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('logo must be a PNG, JPEG or WebP image');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const image = `data:image/${png ? 'png' : jpeg ? 'jpeg' : 'webp'};base64,${btoa(binary)}`;
  const extensions = isRecord(pack.extensions) ? pack.extensions : {};
  const company = isRecord(pack.company) ? pack.company : {};
  const name = LText.safeParse(company.name);
  const brand = parsed.profile ?? { primary: DEFAULT_PRIMARY, source: { kind: 'defaultTheme' as const } };
  return {
    ...pack,
    extensions: { ...extensions, brand: { ...brand, logo: { ...logo, src: logo?.src ?? 'brand/logo', alt: logo?.alt ?? (name.success ? name.data : { ja: 'ロゴ', en: 'Logo' }), image } } },
  };
}

export interface ImportAnalysis {
  files: FileReport[];
  notes: Note[];
  /** The normalized pack that would be stored (null when nothing usable was found). */
  pack: Record<string, unknown> | null;
  verify: VerifyResult | null;
  summary: PackSummary | null;
  /** FR-302: all or nothing — only a pack without errors can be imported. */
  canImport: boolean;
}

/* ---------- 1. Extract JSON from files or a pasted answer ---------- */

const FENCE = /```[ \t]*([A-Za-z]*)[^\n]*\n([\s\S]*?)```/g;

export interface ExtractResult {
  values: unknown[];
  errors: string[];
}

/** ```json blocks first (a Copilot answer mixes prose and code); otherwise the whole text, then the outermost {...}. */
export function extractJson(text: string): ExtractResult {
  const clean = text.replace(/^\uFEFF/, '');
  const values: unknown[] = [];
  const errors: string[] = [];
  const blocks = [...clean.matchAll(FENCE)];
  const tryParse = (s: string, label: string, required: boolean) => {
    try {
      values.push(JSON.parse(s));
    } catch (err) {
      if (required) errors.push(`${label}: ${(err as Error).message}`);
    }
  };
  if (blocks.length) {
    blocks.forEach((m, i) => {
      const lang = (m[1] ?? '').toLowerCase();
      const body = (m[2] ?? '').trim();
      const looksJson = body.startsWith('{') || body.startsWith('[');
      if (lang && !lang.startsWith('json')) return;
      if (!looksJson) return;
      tryParse(body, `block ${i + 1}`, true);
    });
    return { values, errors };
  }
  const trimmed = clean.trim();
  if (!trimmed) return { values, errors };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    tryParse(trimmed, 'text', true);
    return { values, errors };
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) tryParse(trimmed.slice(first, last + 1), 'text', true);
  return { values, errors };
}

/* ---------- 2. Classify and merge parts ---------- */

const PACK_KEYS = ['packId', 'company', 'isSample', 'regions', 'entities', 'flows', 'optimization', 'extensions'] as const;
const SCALAR_KEYS = ['packId', 'company', 'isSample', 'optimization'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEntityLike = (v: unknown) => isRecord(v) && typeof v.kind === 'string';

type Part = { order: number; total: number | null; label: string | null; value: Record<string, unknown> };

/** A pack part, a bare entity array or a single entity become pack parts; anything else is unrecognized. */
export function toPart(value: unknown, fallbackOrder: number): Part | null {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isEntityLike) ? { order: fallbackOrder, total: null, label: null, value: { entities: value } } : null;
  }
  if (!isRecord(value)) return null;
  if (PACK_KEYS.some((k) => k in value)) {
    const m = typeof value.part === 'string' ? /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value.part) : null;
    return { order: m ? Number(m[1]) : fallbackOrder, total: m ? Number(m[2]) : null, label: m ? `${m[1]}/${m[2]}` : null, value };
  }
  if (isEntityLike(value) && typeof value.id === 'string') return { order: fallbackOrder, total: null, label: null, value: { entities: [value] } };
  return null;
}

const stable = (v: unknown) => JSON.stringify(v);

export function mergeParts(parts: Part[]): { raw: Record<string, unknown>; notes: Note[] } {
  const notes: Note[] = [];
  const conflicts: string[] = [];
  const sorted = [...parts].sort((a, b) => a.order - b.order);
  const totals = new Set(sorted.map((p) => p.total).filter((t): t is number => t !== null));
  if (totals.size) {
    if (totals.size > 1 || sorted.some((p) => p.total !== null && (!Number.isSafeInteger(p.order) || !Number.isSafeInteger(p.total) || p.order < 1 || p.order > p.total || p.total > 10000))) {
      conflicts.push('PART numbering');
    }
    const total = Math.max(...totals);
    const seen = new Set(sorted.filter((p) => p.label).map((p) => p.order));
    const missing = Array.from({ length: Math.min(total, 10000) }, (_, i) => i + 1).filter((n) => !seen.has(n));
    if (missing.length) notes.push({ code: 'partMissing', count: missing.length, detail: missing.map((n) => `PART ${n}/${total}`).join(', ') });
  }
  const raw: Record<string, unknown> = {};
  const numberedParts = new Map<string, string>();
  for (const p of sorted) {
    if ('part' in p.value && p.label === null) conflicts.push('PART numbering');
    if (p.label) {
      const previous = numberedParts.get(p.label);
      if (previous !== undefined && previous !== stable(p.value)) conflicts.push(`PART ${p.label}`);
      numberedParts.set(p.label, stable(p.value));
    }
    for (const key of ['entities', 'regions', 'flows'] as const) {
      if (key in p.value && !Array.isArray(p.value[key])) conflicts.push(`${key}: expected an array`);
    }
    for (const key of SCALAR_KEYS) {
      if (!(key in p.value)) continue;
      if (!(key in raw)) raw[key] = p.value[key];
      else if (stable(raw[key]) !== stable(p.value[key])) conflicts.push(key);
    }
  }
  const mergeExtension = (previous: unknown, next: unknown, path: string): unknown => {
    if (previous === undefined || stable(previous) === stable(next)) return next;
    if (Array.isArray(previous) && Array.isArray(next)) {
      return [...new Map([...previous, ...next].map((item) => [stable(item), item])).values()];
    }
    if (isRecord(previous) && isRecord(next)) {
      const merged = { ...previous };
      for (const [key, value] of Object.entries(next)) {
        const old = Object.hasOwn(merged, key) ? merged[key] : undefined;
        Object.defineProperty(merged, key, { value: mergeExtension(old, value, `${path}.${key}`), enumerable: true, writable: true, configurable: true });
      }
      return merged;
    }
    conflicts.push(path);
    return previous;
  };
  for (const p of sorted) {
    if ('extensions' in p.value) raw.extensions = mergeExtension(raw.extensions, p.value.extensions, 'extensions');
  }

  let dropped = 0;
  const concat = (key: 'entities' | 'flows') => {
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const p of sorted) {
      const list = p.value[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const s = stable(item);
        if (seen.has(s)) {
          dropped++;
          continue;
        }
        seen.add(s);
        out.push(item);
      }
    }
    return out;
  };
  if (sorted.some((p) => Array.isArray(p.value.entities))) raw.entities = concat('entities');
  if (sorted.some((p) => Array.isArray(p.value.flows))) raw.flows = concat('flows');
  if (sorted.some((p) => Array.isArray(p.value.regions))) {
    const regions = new Map<string, unknown>();
    for (const p of sorted) {
      const list = p.value.regions;
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const id = isRecord(r) && typeof r.id === 'string' ? r.id : stable(r);
        if (!regions.has(id)) regions.set(id, r);
        else if (stable(regions.get(id)) === stable(r)) dropped++;
        else conflicts.push(`regions.${id}`);
      }
    }
    raw.regions = [...regions.values()];
  }
  if (dropped) notes.push({ code: 'duplicateDropped', count: dropped });
  if (conflicts.length) notes.push({ code: 'conflict', count: conflicts.length, detail: [...new Set(conflicts)].join(', ') });
  return { raw, notes };
}

/* ---------- 3. Normalize the shape (never invent facts) ---------- */

type Shape = Record<string, z.ZodType>;
const optionShapes: Map<string, Shape> = new Map(
  Entity.options.map((o) => [String((o.shape.kind as z.ZodLiteral<string>).value), o.shape as unknown as Shape]),
);
/** Bilingual fields per kind, read from the schema so this never drifts from src/data/schema.ts. */
const LTEXT_FIELDS: Map<string, string[]> = new Map(
  [...optionShapes].map(([kind, shape]) => [kind, Object.keys(shape).filter((k) => shape[k] === LText)]),
);
const NUMBER_FIELDS: Map<string, string[]> = new Map(
  [...optionShapes].map(([kind, shape]) => [kind, Object.keys(shape).filter((k) => shape[k] instanceof z.ZodNumber)]),
);
/** §3.7 world/type per kind, as used by the built-in sample. */
const WORLD_TYPE: Map<string, { world: string; type: string }> = new Map(
  samplePack.entities.map((e) => [e.kind, { world: e.world, type: e.type }] as const).reverse(),
);
const ILLUSTRATED = new Set(['customer', 'product']);

/** "x" → {ja:"x", en:"x"}; {ja} → {ja, en: ja}. Returns the value unchanged when it is not fixable. */
function toLText(v: unknown): { value: unknown; fixed: boolean } {
  if (typeof v === 'string' && v.trim()) return { value: { ja: v, en: v }, fixed: true };
  if (isRecord(v)) {
    const ja = typeof v.ja === 'string' && v.ja.trim() ? v.ja : null;
    const en = typeof v.en === 'string' && v.en.trim() ? v.en : null;
    if (ja && !en) return { value: { ja, en: ja }, fixed: true };
    if (en && !ja) return { value: { ja: en, en }, fixed: true };
  }
  return { value: v, fixed: false };
}

const NUMERIC_TEXT = /^\s*-?[\d,]+(\.\d+)?\s*$/;
const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function normalizePack(input: Record<string, unknown>, now: Date = new Date()): { pack: Record<string, unknown>; notes: Note[] } {
  const pack: Record<string, unknown> = structuredClone(input);
  const counts = new Map<NoteCode, number>();
  const bump = (code: NoteCode, n = 1) => counts.set(code, (counts.get(code) ?? 0) + n);
  const fixLText = (obj: Record<string, unknown>, key: string) => {
    if (!(key in obj)) return;
    const r = toLText(obj[key]);
    if (r.fixed) {
      obj[key] = r.value;
      bump('langFilled');
    }
  };

  if (isRecord(pack.company)) {
    fixLText(pack.company, 'name');
    fixLText(pack.company, 'industry');
  }
  if (!('isSample' in pack)) {
    pack.isSample = false;
    bump('isSampleDefaulted');
  }
  if (!Array.isArray(pack.regions)) {
    pack.regions = [];
    bump('regionsDefaulted');
  }
  if (!Array.isArray(pack.flows)) {
    pack.flows = [];
    bump('flowsDefaulted');
  }
  if (!Array.isArray(pack.entities)) pack.entities = [];
  if (typeof pack.packId !== 'string' || !pack.packId.trim()) {
    const company = isRecord(pack.company) && isRecord(pack.company.name) ? String(pack.company.name.en ?? '') : '';
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    pack.packId = ['import', slug(company), date].filter(Boolean).join('-');
    bump('packIdGenerated');
  }
  for (const r of pack.regions as unknown[]) if (isRecord(r)) fixLText(r, 'name');
  if (isRecord(pack.optimization)) fixLText(pack.optimization, 'period');

  for (const e of pack.entities as unknown[]) {
    if (!isRecord(e) || typeof e.kind !== 'string') continue;
    const kind = e.kind;
    const wt = WORLD_TYPE.get(kind);
    if (wt && (e.world === undefined || e.type === undefined)) {
      e.world ??= wt.world;
      e.type ??= wt.type;
      bump('worldTypeFilled');
    }
    for (const key of LTEXT_FIELDS.get(kind) ?? []) fixLText(e, key);
    for (const key of NUMBER_FIELDS.get(kind) ?? []) {
      const v = e[key];
      if (typeof v === 'string' && NUMERIC_TEXT.test(v)) {
        e[key] = Number(v.replace(/,/g, ''));
        bump('numberParsed');
      }
    }
    if (!Array.isArray(e.sourceIds)) {
      e.sourceIds = [];
      bump('sourceIdsAdded');
    }
    if (e.classification === undefined) {
      e.classification = 'internal';
      bump('classificationDefaulted');
    }
    if (e.author === undefined) {
      e.author = 'ai';
      bump('authorDefaulted');
    }
    if (ILLUSTRATED.has(kind) && e.illustration === undefined && typeof e.id === 'string') {
      e.illustration = { motif: 'generic', hue: hueOf(e.id) };
      bump('illustrationFilled');
    }
  }
  for (const f of pack.flows as unknown[]) {
    if (isRecord(f) && typeof f.valueT === 'string' && NUMERIC_TEXT.test(f.valueT)) {
      f.valueT = Number(f.valueT.replace(/,/g, ''));
      bump('numberParsed');
    }
  }
  // Keys of the pack only; the part marker is not part of the schema.
  delete pack.part;
  const order: NoteCode[] = ['packIdGenerated', 'isSampleDefaulted', 'regionsDefaulted', 'flowsDefaulted', 'langFilled', 'numberParsed', 'worldTypeFilled', 'sourceIdsAdded', 'classificationDefaulted', 'authorDefaulted', 'illustrationFilled'];
  return { pack, notes: order.filter((c) => counts.has(c)).map((code) => ({ code, count: counts.get(code)! })) };
}

/* ---------- 4. Summary for the human check (FR-304) ---------- */

export function summarize(pack: Record<string, unknown>): PackSummary {
  const entities = (Array.isArray(pack.entities) ? pack.entities : []).filter(isRecord);
  const byKind: Partial<Record<EntityKind, number>> = {};
  for (const e of entities) {
    if (typeof e.kind === 'string') byKind[e.kind as EntityKind] = (byKind[e.kind as EntityKind] ?? 0) + 1;
  }
  const company = isRecord(pack.company) ? pack.company : {};
  const ltext = (v: unknown) => (LText.safeParse(v).success ? (v as z.infer<typeof LText>) : null);
  const brand = isRecord(pack.extensions) && isRecord(pack.extensions.brand) ? pack.extensions.brand : null;
  return {
    company: { name: ltext(company.name), industry: ltext(company.industry) },
    isSample: pack.isSample === true,
    byKind,
    entities: entities.length,
    internal: entities.filter((e) => e.classification === 'internal').length,
    shareable: entities.filter((e) => e.classification === 'shareable').length,
    people: byKind.person ?? 0,
    regions: Array.isArray(pack.regions) ? pack.regions.length : 0,
    flows: Array.isArray(pack.flows) ? pack.flows.length : 0,
    hasOptimization: isRecord(pack.optimization),
    hasBrand: brand !== null,
    hasLogo: brand !== null && isRecord(brand.logo),
  };
}

/* ---------- 5. The whole pipeline ---------- */

const TEXT_EXT = /\.(json|txt|md|markdown)$/i;

/** Files the import can read: JSON or text (a saved Copilot answer). Office/PDF files go to Copilot, not here. */
export function isReadableFile(name: string, type: string): boolean {
  return TEXT_EXT.test(name) || type.startsWith('text/') || type === 'application/json';
}

export function analyzeImport(docs: InputDoc[], rejected: FileReport[] = [], now: Date = new Date()): ImportAnalysis {
  const files: FileReport[] = [...rejected];
  const parts: Part[] = [];
  let order = 1000;
  for (const doc of docs) {
    const { values, errors } = extractJson(doc.text);
    const docParts = values.map((v) => toPart(v, order++)).filter((p): p is Part => p !== null);
    parts.push(...docParts);
    if (errors.length && !docParts.length) files.push({ name: doc.name, status: 'parseError', fragments: 0, detail: errors.join('\n') });
    else if (!docParts.length) files.push({ name: doc.name, status: 'unrecognized', fragments: 0 });
    else files.push({ name: doc.name, status: 'used', fragments: docParts.length, ...(errors.length ? { detail: errors.join('\n') } : {}) });
  }
  if (!parts.length) return { files, notes: [], pack: null, verify: null, summary: null, canImport: false };
  const merged = mergeParts(parts);
  const normalized = normalizePack(merged.raw, now);
  const verify = verifyPack(normalized.pack);
  const importErrors: Problem[] = [
    ...merged.notes.filter((n) => n.code === 'partMissing' || n.code === 'conflict').map((n): Problem => ({
      severity: 'error', code: 'PARSE', path: 'parts', cause: `${n.code}: ${n.detail}`,
      action: 'Provide every PART with consistent numbering and values. Do not import an incomplete or conflicting answer.',
    })),
    ...files.filter((f) => f.status === 'used' && f.detail).map((f): Problem => ({
      severity: 'error', code: 'PARSE', path: f.name, cause: f.detail!,
      action: 'Correct the malformed JSON block; valid blocks alone may omit required data.',
    })),
  ];
  verify.problems.push(...importErrors);
  if (importErrors.length) verify.ok = false;
  return {
    files,
    notes: [...merged.notes, ...normalized.notes],
    pack: normalized.pack,
    verify,
    summary: summarize(normalized.pack),
    canImport: verify.ok,
  };
}

/* ---------- 6. Prompt back to Copilot with the problems (closing the loop) ---------- */

const FIX_INTRO = {
  ja: [
    'Business Analytics Studio（BAS）で、あなたが出力した顧客パックを検査したところ、次の問題が見つかりました。',
    '直し方のルール:',
    '- 問題のある項目だけを直し、それ以外の項目は変えないでください。',
    '- 承認済みの資料・公開Webの出典だけを使い、根拠のない値は作らないでください。必須の値や参照先が見つからない場合は、そのエンティティと、それに依存して成立しないエンティティも除外し、extensions.collection に不足と次の取得方法を記録してください。必須の参照を空にしてはいけません。',
    '- 修正後の顧客パック全体を前回と同じ方法で出し直してください（pack.json を含む zip。ファイルを作れない場合は ```json のコードブロックで、40 エンティティを超えるときは PART k/N に分割）。',
    '- 最後に、何を直したかを 1 行ずつ箇条書きで示してください。',
  ],
  en: [
    'Business Analytics Studio (BAS) checked the customer pack you produced and found the problems below.',
    'Rules for the fix:',
    '- Change only the items with a problem; leave every other item as it is.',
    '- Use only approved material and public web sources; never invent values. If a required value or reference cannot be sourced, omit that entity and dependent entities that can no longer be valid. Record the gaps and next actions in extensions.collection; never leave required references empty.',
    '- Output the whole corrected pack again the same way as before (a zip with pack.json; if you cannot create files, ```json code blocks split into PART k/N above 40 entities).',
    '- Finish with a bullet list of what you changed, one line per fix.',
  ],
} as const;

export function buildFixPrompt(problems: Problem[], lang: 'ja' | 'en'): string {
  const errors = problems.filter((p) => p.severity === 'error' && !p.dependsOn);
  const shown = errors.slice(0, FIX_PROMPT_MAX_PROBLEMS);
  const head = lang === 'ja'
    ? `問題（${errors.length} 件${errors.length > shown.length ? `。先頭の ${shown.length} 件` : ''}）:`
    : `Problems (${errors.length}${errors.length > shown.length ? `; the first ${shown.length}` : ''}):`;
  const lines = shown.map((p, i) => [
    `${i + 1}. [${p.code}] ${p.path}${p.entityId ? ` (${p.entityId})` : ''}`,
    `   cause: ${p.cause}`,
    `   action: ${p.action}`,
  ].join('\n'));
  return [...FIX_INTRO[lang], '', head, ...lines].join('\n');
}
