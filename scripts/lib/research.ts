import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C03_TABLE, isApproved, type AiUse } from '../../src/ai/policy.ts';
import { BRAND_SOURCE_PRIORITY, DEFAULT_PRIMARY, type BrandProfile, type BrandSourceKind } from '../../src/modules/ops/brand.ts';
import { DEFAULT_PRESET_ID, findPreset } from '../../src/modules/ops/presets.ts';
import { isoWithOffset } from './timing.ts';

/** PARAM-004: research cache validity in days. */
export const CACHE_DAYS = 30;
const DAY = 86_400_000;

export type SourceStatus = 'used' | 'blocked' | 'unavailable';

export interface ResearchSource {
  id: 'workiq' | 'web' | 'llm' | 'sample';
  status: SourceStatus;
  reason: string;
  /** Integration id in docs/integration-catalog.md. */
  integration: string | null;
  checkedAt: string;
}

export interface ResearchCache {
  schemaVersion: 1;
  customer: string;
  slug: string;
  fetchedAt: string;
  expiresAt: string;
  input: { industry: string; lang: 'ja' | 'en' };
  /** FR-121: where the facts came from (in fallback order WorkIQ → Web → sample). */
  sources: ResearchSource[];
  usedSample: boolean;
  /** FR-122: brand research by source priority, falling back to the default theme. */
  brand: { priority: readonly BrandSourceKind[]; attempts: { kind: BrandSourceKind; status: SourceStatus; reason: string }[]; chosen: BrandSourceKind; profile: BrandProfile };
  /** Classification of everything in this cache (C-02: WorkIQ-derived information is internal). */
  classification: 'internal' | 'shareable';
}

/** Folder-safe customer name: keeps letters of any script and digits, replaces the rest with '-'. */
export function slugify(customer: string): string {
  const s = customer.trim().toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new Error('Customer name is empty. Pass a name, e.g. `bas research "Contoso"`, or set BAS_CUSTOMER.');
  return s;
}

const c03Reason = (use: AiUse) => {
  const row = C03_TABLE[use];
  return isApproved(row) ? null : `C-03 row "${use}" is not approved (open: ${row.openQuestions.join(', ')})`;
};

/**
 * FR-121/FR-122: research a customer. In this template every external source is BLOCKED (C-03 rows TBD, C-07: no
 * external services in this run), so the cache records each attempt with its reason and marks "sample used".
 */
export function research(customer: string, input: { industry?: string; lang?: 'ja' | 'en' }, now: Date = new Date()): ResearchCache {
  const industry = input.industry ?? DEFAULT_PRESET_ID;
  if (!findPreset(industry)) throw new Error(`Unknown industry preset "${industry}". Run \`bas presets\` for the list.`);
  const at = isoWithOffset(now);
  const c07 = 'C-07: external services are not used in this run (manual check: BLOCKED)';
  const blocked = (use: AiUse) => [c03Reason(use), c07].filter(Boolean).join('; ');
  const sources: ResearchSource[] = [
    { id: 'workiq', status: 'blocked', reason: blocked('research'), integration: 'workiq', checkedAt: at },
    { id: 'web', status: 'blocked', reason: blocked('research'), integration: 'web-research', checkedAt: at },
    { id: 'llm', status: 'blocked', reason: blocked('research'), integration: 'copilot-sdk', checkedAt: at },
    { id: 'sample', status: 'used', reason: 'Sample used: no research source was available (UC-1).', integration: null, checkedAt: at },
  ];
  const attempts = BRAND_SOURCE_PRIORITY.filter((k) => k !== 'defaultTheme').map((kind) => ({ kind, status: 'blocked' as const, reason: blocked('brandResearch') }));
  return {
    schemaVersion: 1,
    customer,
    slug: slugify(customer),
    fetchedAt: at,
    expiresAt: isoWithOffset(new Date(now.getTime() + CACHE_DAYS * DAY)),
    input: { industry, lang: input.lang ?? 'ja' },
    sources,
    usedSample: true,
    brand: {
      priority: BRAND_SOURCE_PRIORITY,
      attempts,
      chosen: 'defaultTheme',
      profile: { primary: DEFAULT_PRIMARY, tone: 'formal', source: { kind: 'defaultTheme', fetchedAt: at } },
    },
    classification: 'internal',
  };
}

/** FR-123: age of the cache and whether it passed PARAM-004 (expired strictly after 30 days). */
export function cacheAge(fetchedAt: string, now: Date = new Date(), days = CACHE_DAYS): { ageDays: number; expired: boolean } {
  const ageMs = now.getTime() - Date.parse(fetchedAt);
  return { ageDays: Math.floor(ageMs / DAY), expired: ageMs > days * DAY };
}

export function cacheFile(cacheDir: string, slug: string): string {
  return join(cacheDir, slug, 'research.json');
}

export function writeCache(cacheDir: string, cache: ResearchCache): string {
  const dir = join(cacheDir, cache.slug);
  mkdirSync(dir, { recursive: true });
  const file = cacheFile(cacheDir, cache.slug);
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
  writeFileSync(join(dir, 'customer-research.md'), researchMarkdown(cache));
  return file;
}

export function readCache(cacheDir: string, slug: string): ResearchCache | null {
  const file = cacheFile(cacheDir, slug);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ResearchCache;
}

function researchMarkdown(c: ResearchCache): string {
  const rows = c.sources.map((s) => `| ${s.id} | ${s.status} | ${s.reason} | ${s.checkedAt} |`).join('\n');
  const brand = c.brand.attempts.map((a) => `| ${a.kind} | ${a.status} | ${a.reason} |`).join('\n');
  return `# Customer research: ${c.customer}

- Fetched: ${c.fetchedAt} (expires ${c.expiresAt}, PARAM-004 = ${CACHE_DAYS} days)
- Industry preset: ${c.input.industry}; language: ${c.input.lang}
- Classification: ${c.classification} (do not commit; research-cache/ is git-ignored, C-02)
- Result: ${c.usedSample ? '**sample used** — no external source was available' : 'researched'}

## Sources (FR-121)

| source | status | reason | checked |
|---|---|---|---|
${rows}

## Brand (FR-122, priority ${c.brand.priority.join(' > ')})

| source | status | reason |
|---|---|---|
${brand}

Chosen: **${c.brand.chosen}** (primary ${c.brand.profile.primary}).
`;
}
