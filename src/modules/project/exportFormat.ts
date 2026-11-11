import { z } from 'zod';
import type { TokenSummary, TokenTotals } from '../../ai/tokenUsage.ts';
import type { Entity } from '../../data/schema.ts';
import { translate, type Lang, type MessageKey, type Vars } from '../../i18n/core.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { ALL_PERSONAS, personaLabel, type Persona } from '../../state/personas.ts';
import type { Audience } from '../../state/settings.ts';
import type { UseCase } from '../usecases/store.ts';
import { computeAnalysis } from './analysis.ts';
import { categoryKey, describeInsight, fmtScore, methodKey } from './analysisText.ts';
import { descendantIds, MIN_PER_THEME, themeCounts, treeOrder } from './discussion.ts';
import { achievementPct, okrPct, statusForPct } from './kpiOkr.ts';
import {
  AnalysisDataSchema, DiscussionDataSchema, KpiDataSchema, LocalizableSchema,
  type AnalysisData, type DiscussionData, type DiscussionRecord, type KpiData, type ProjectData, type RecordKind, type Theme,
} from './model.ts';

export type ExportFormat = 'markdown' | 'json';

export interface ExportOptions {
  lang: Lang;
  audience: Audience;
  /** null = every theme (full export); otherwise the theme and its sub-themes. */
  themeId: string | null;
  include: { kpi: boolean; analysis: boolean; useCases: boolean };
}

export interface ExportSource {
  company: string;
  project: string;
  data: ProjectData;
  useCases: UseCase[];
  byId: Map<string, Entity>;
  now: Date;
}

const UseCaseExportSchema = z.object({
  id: z.string(),
  name: LocalizableSchema,
  summary: LocalizableSchema,
  persona: z.string(),
  steps: z.array(z.object({ title: LocalizableSchema, description: LocalizableSchema })),
  effect: LocalizableSchema.optional(),
  relatedIds: z.array(z.string()),
}).passthrough();

export const ExportBundleSchema = z.object({
  format: z.literal('bas-project-export'),
  version: z.literal(1),
  exportedAt: z.string(),
  company: z.string(),
  project: z.string(),
  lang: z.enum(['ja', 'en']),
  audience: z.enum(['internal', 'external']),
  themeId: z.string().nullable(),
  discussion: DiscussionDataSchema,
  kpi: KpiDataSchema.nullable(),
  analysis: AnalysisDataSchema.nullable(),
  useCases: z.array(UseCaseExportSchema).nullable(),
  relatedIds: z.array(z.string()),
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export interface PreparedExport {
  bundle: ExportBundle;
  /** Items left out because they are internal and the audience is external (FR-054). */
  excludedInternal: number;
  /** Internal items that are in the export (internal audience): warn before sharing. */
  internalIncluded: number;
  /** FR-219: "person" entities included in the export. */
  personCount: number;
  related: Entity[];
}

/** FR-053/FR-054: choose what goes out, applying the scope and the confidentiality rule. */
export function prepareExport(src: ExportSource, opts: ExportOptions): PreparedExport {
  const { discussion } = src.data;
  let themes = discussion.themes;
  if (opts.themeId && themes.some((t) => t.id === opts.themeId)) {
    const ids = descendantIds(discussion, opts.themeId);
    themes = themes.filter((t) => ids.has(t.id));
  }
  let records = discussion.records.filter((r) => themes.some((t) => t.id === r.themeId));
  let excludedInternal = 0;
  if (opts.audience === 'external') {
    const internalRoots = themes.filter((t) => t.classification === 'internal');
    const hidden = new Set<string>();
    internalRoots.forEach((t) => descendantIds({ themes, records }, t.id).forEach((id) => hidden.add(id)));
    const keptThemes = themes.filter((t) => !hidden.has(t.id));
    const keptRecords = records.filter((r) => !hidden.has(r.themeId) && r.classification !== 'internal');
    excludedInternal += themes.length - keptThemes.length + records.length - keptRecords.length;
    themes = keptThemes;
    records = keptRecords;
  }
  const useCases = opts.include.useCases ? src.useCases : null;
  const relatedIdSet = new Set<string>([...themes.flatMap((t) => t.relatedIds), ...(useCases ?? []).flatMap((u) => u.relatedIds)]);
  let related = [...relatedIdSet].map((id) => src.byId.get(id)).filter((e): e is Entity => !!e);
  if (opts.audience === 'external') {
    // Display rule (FR-054, isHidden in src/ui/cardSpecs.ts): internal items stay hidden for an external audience.
    // This is independent of D-2, which only governs what generative AI may send.
    const kept = related.filter((e) => e.classification !== 'internal');
    excludedInternal += related.length - kept.length;
    related = kept;
  }
  // FR-219: persons in the exported scope (after the confidentiality filter for an external audience).
  const personCount = related.filter((e) => e.kind === 'person').length;
  const internalIncluded = opts.audience === 'internal'
    ? themes.filter((t) => t.classification === 'internal').length + records.filter((r) => r.classification === 'internal').length + related.filter((e) => e.classification === 'internal').length
    : 0;
  const keep = new Set(related.map((e) => e.id));
  const bundle: ExportBundle = {
    format: 'bas-project-export',
    version: 1,
    exportedAt: src.now.toISOString(),
    company: src.company,
    project: src.project,
    lang: opts.lang,
    audience: opts.audience,
    themeId: opts.themeId,
    discussion: {
      themes: themes.map((t) => ({ ...t, relatedIds: t.relatedIds.filter((id) => keep.has(id) || !src.byId.has(id)) })),
      records,
    },
    kpi: opts.include.kpi ? src.data.kpi : null,
    analysis: opts.include.analysis ? src.data.analysis : null,
    useCases: useCases ? useCases.map((u) => ({ ...u, relatedIds: u.relatedIds.filter((id) => keep.has(id) || !src.byId.has(id)) })) : null,
    relatedIds: related.map((e) => e.id),
  };
  return { bundle, excludedInternal, internalIncluded, personCount, related };
}

/* ---------- File names (FR-051) ---------- */

export function yyyymmdd(d: Date, timeZone = 'Asia/Tokyo'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');
}

const safe = (s: string) => s.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';

/** `<company>-<project>-discussion-YYYYMMDD.md` (FR-051). */
export function defaultFileName(company: string, project: string, date: Date, kind: 'discussion' | 'followup' = 'discussion', format: ExportFormat = 'markdown'): string {
  return `${safe(company)}-${safe(project)}-${kind}-${yyyymmdd(date)}.${format === 'json' ? 'json' : 'md'}`;
}

/* ---------- Markdown (FR-053) ---------- */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
const unesc = (s: string) => s.replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const cell = (s: string) => esc(s).replace(/\|/g, '\\|');

const SECTION_KINDS: RecordKind[] = ['decision', 'suggestion', 'action', 'note'];
const kindHeading = (k: RecordKind): MessageKey => `proj.kind.${k}`;

function meta(tag: 'theme' | 'record', fields: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return `<!-- bas:${tag} ${p.toString()} -->`;
}

export function toMarkdown(b: ExportBundle, aiUsage?: TokenSummary): string {
  const tr = (key: MessageKey, vars?: Vars) => translate(b.lang, key, vars);
  const L = (x: Localizable) => loc(x, b.lang);
  const out: string[] = [];
  const data = b.discussion;
  const titleOf = (id: string | null) => {
    const t = id ? data.themes.find((x) => x.id === id) : undefined;
    return t ? L(t.title) : '';
  };
  out.push(`# ${esc(tr('proj.md.title', { company: b.company, project: b.project }))}`, '');
  out.push(`- ${tr('proj.md.exportedAt')}: ${b.exportedAt}`);
  out.push(`- ${tr('proj.md.scope')}: ${b.themeId ? esc(titleOf(b.themeId)) : tr('proj.export.scope.all')}`);
  out.push(`- ${tr('proj.md.audience')}: ${tr(b.audience === 'external' ? 'proj.export.audience.external' : 'proj.export.audience.internal')}`, '');

  out.push(`## ${tr('proj.md.counts')}`, '', tr('proj.md.countsNote', { min: MIN_PER_THEME }), '');
  out.push(`| ${tr('proj.md.theme')} | ${tr('proj.goal.decisions')} | ${tr('proj.goal.actions')} | ${tr('proj.md.goal')} |`, '|---|---:|---:|---|');
  for (const c of themeCounts(data)) {
    out.push(`| ${cell(titleOf(c.themeId))} | ${c.decisions} | ${c.actions} | ${tr(c.met ? 'proj.goal.met' : 'proj.goal.unmet')} |`);
  }
  out.push('');

  out.push(`## ${tr('proj.md.themes')}`, '');
  for (const { theme } of treeOrder(data)) {
    out.push(`### ${esc(L(theme.title))} ${meta('theme', { id: theme.id, parent: theme.parentId ?? '', class: theme.classification, related: theme.relatedIds.join(',') })}`, '');
    if (theme.parentId) out.push(`${tr('proj.md.parent')}: ${esc(titleOf(theme.parentId))}`, '');
    if (theme.classification === 'internal') out.push(`**${tr('badge.internal')}**`, '');
    const recs = data.records.filter((r) => r.themeId === theme.id);
    for (const kind of SECTION_KINDS) {
      const list = recs.filter((r) => r.kind === kind);
      if (!list.length) continue;
      out.push(`#### ${tr(kindHeading(kind))}`, '');
      for (const r of list) {
        out.push(`- ${esc(L(r.text))} ${meta('record', {
          id: r.id, kind: r.kind, author: r.author, class: r.classification, at: r.createdAt,
          owner: r.owner, due: r.due, done: r.done === undefined ? undefined : r.done ? '1' : '0', mock: r.mock ? '1' : undefined,
        })}`);
        const facts = [
          r.author === 'ai' ? tr(r.mock ? 'proj.author.aiMock' : 'proj.author.ai') : tr(r.kind === 'decision' ? 'proj.author.human' : 'proj.author.person'),
          r.owner ? `${tr('proj.rec.owner')}: ${esc(r.owner)}` : '',
          r.due ? `${tr('proj.rec.due')}: ${r.due}` : '',
          r.kind === 'action' ? tr(r.done ? 'proj.rec.done' : 'proj.rec.open') : '',
          r.classification === 'internal' ? tr('badge.internal') : '',
        ].filter(Boolean);
        out.push(`  - ${facts.join(' / ')}`);
      }
      out.push('');
    }
  }

  if (b.kpi) {
    out.push(`## ${tr('proj.kpi.title')}`, '');
    out.push(`| ${tr('proj.kpi.name')} | ${tr('proj.kpi.unit')} | ${tr('proj.kpi.baseline')} | ${tr('proj.kpi.current')} | ${tr('proj.kpi.target')} | ${tr('proj.kpi.deadline')} | ${tr('proj.kpi.achievement')} | ${tr('proj.kpi.status')} |`);
    out.push('|---|---|---:|---:|---:|---|---:|---|');
    for (const k of b.kpi.kpis) {
      const pct = achievementPct(k);
      out.push(`| ${cell(L(k.name))} | ${cell(L(k.unit))} | ${k.baseline} | ${k.current} | ${k.target} | ${k.deadline} | ${pct === null ? '—' : `${Math.round(pct)}%`} | ${tr(`proj.kpiStatus.${statusForPct(pct)}`)} |`);
    }
    out.push('', `## ${tr('proj.okr.title')}`, '');
    for (const o of b.kpi.okrs) {
      const pct = okrPct(o, b.kpi.kpis);
      out.push(`- **${esc(L(o.objective))}** — ${pct === null ? '—' : `${Math.round(pct)}%`} ${tr(`proj.kpiStatus.${statusForPct(pct)}`)}`);
      for (const kr of o.keyResults) {
        const k = b.kpi.kpis.find((x) => x.id === kr.kpiId);
        out.push(`  - ${esc(L(kr.text))}${k ? ` (${esc(L(k.name))})` : ''}`);
      }
    }
    out.push('');
  }

  if (b.analysis) {
    out.push(`## ${tr('proj.md.analyses')}`, '');
    for (const a of b.analysis.analyses) {
      const r = computeAnalysis(a);
      out.push(`### ${esc(L(a.title))}`, '', `${tr('proj.an.method')}: ${tr(methodKey(a.method))}`, '', describeInsight(r, tr), '');
      out.push(`| ${tr('proj.an.category')} | ${tr('proj.an.score')} | ${tr('proj.an.weight')} | ${tr('proj.an.count')} |`, '|---|---:|---:|---:|');
      for (const c of r.categories) out.push(`| ${tr(categoryKey(c.id))} | ${fmtScore(c.score)} | ${c.weight} | ${c.count} |`);
      out.push('');
      for (const i of a.items) out.push(`- ${tr(categoryKey(i.category))}: ${esc(L(i.text))} (${tr('proj.an.score')} ${i.score}, ${tr('proj.an.weight')} ${i.weight})`);
      out.push('');
    }
  }

  if (b.useCases) {
    out.push(`## ${tr('proj.md.useCases')}`, '');
    if (!b.useCases.length) out.push(tr('proj.md.none'), '');
    for (const u of b.useCases) {
      out.push(`### ${esc(L(u.name))}`, '', esc(L(u.summary)), '');
      out.push(`- ${tr('proj.md.persona')}: ${tr(personaLabel(u.persona as Parameters<typeof personaLabel>[0]))}`);
      u.steps.forEach((s, i) => out.push(`${i + 1}. ${esc(L(s.title))}: ${esc(L(s.description))}`));
      if (u.effect) out.push('', `${tr('proj.md.effect')}: ${esc(L(u.effect))}`);
      out.push('');
    }
  }

  // Token use is internal information: never in what goes outside the company.
  if (aiUsage && b.audience === 'internal') out.push(...tokenSection(aiUsage, b.lang));

  out.push(`## ${tr('proj.md.data')}`, '', tr('proj.md.dataNote'), '', '```json bas-export', JSON.stringify(b, null, 2), '```', '');
  return out.join('\n');
}

/** Markdown table of the project's generative-AI tokens per step, the export itself (0) and the total. */
export function tokenSection(s: TokenSummary, lang: Lang): string[] {
  const tr = (key: MessageKey, vars?: Vars) => translate(lang, key, vars);
  const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const yen = (v: number | null) => (v === null ? tr('ai.cost.unavailable') : new Intl.NumberFormat(locale, { style: 'currency', currency: 'JPY', maximumFractionDigits: 2 }).format(v));
  const row = (label: string, x: TokenTotals) => `| ${cell(label)} | ${n(x.calls)} | ${n(x.inputTokens)} | ${n(x.outputTokens)} | ${n(x.totalTokens)} | ${cell(yen(x.costJpy))} |`;
  const out = [`## ${tr('proj.md.tokens')}`, '', tr('proj.md.tokensNote'), ''];
  out.push(
    `| ${tr('ai.tokens.step')} | ${tr('ai.tokens.calls')} | ${tr('ai.tokens.input')} | ${tr('ai.tokens.output')} | ${tr('ai.tokens.total')} | ${tr('ai.tokens.cost')} |`,
    '|---|---:|---:|---:|---:|---:|',
  );
  for (const l of s.lines) {
    const label = l.step ? tr(`proj.gen.step.${l.step}` as MessageKey) : tr(`ai.use.${l.use}` as MessageKey);
    out.push(row(l.estimatedCalls > 0 ? `${label} ${tr('ai.tokens.estimatedMark')}` : label, l));
  }
  out.push(row(tr('proj.export.tokens.export'), { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costJpy: 0, estimatedCalls: 0 }));
  out.push(row(`**${tr('ai.tokens.sum')}**`, s.total), '');
  return out;
}

/** FR-055: a short follow-up document (decisions, next actions, open AI suggestions) generated with the export. */
export function toFollowUp(b: ExportBundle): string {
  const tr = (key: MessageKey, vars?: Vars) => translate(b.lang, key, vars);
  const L = (x: Localizable) => loc(x, b.lang);
  const out: string[] = [`# ${esc(tr('proj.followup.title', { company: b.company, project: b.project }))}`, '', tr('proj.followup.intro'), ''];
  for (const { theme } of treeOrder(b.discussion)) {
    const recs = b.discussion.records.filter((r) => r.themeId === theme.id);
    const decisions = recs.filter((r) => r.kind === 'decision');
    const actions = recs.filter((r) => r.kind === 'action');
    if (!decisions.length && !actions.length) continue;
    out.push(`## ${esc(L(theme.title))}`, '');
    if (decisions.length) {
      out.push(`### ${tr('proj.kind.decision')}`, '');
      decisions.forEach((d) => out.push(`- ${esc(L(d.text))}`));
      out.push('');
    }
    if (actions.length) {
      out.push(`### ${tr('proj.kind.action')}`, '');
      actions.forEach((a) => out.push(`- [${a.done ? 'x' : ' '}] ${esc(L(a.text))}${a.owner ? ` — ${tr('proj.rec.owner')}: ${esc(a.owner)}` : ''}${a.due ? ` — ${tr('proj.rec.due')}: ${a.due}` : ''}`));
      out.push('');
    }
  }
  out.push(`## ${tr('proj.followup.next')}`, '', tr('proj.followup.nextBody'), '');
  return out.join('\n');
}

export const toJson = (b: ExportBundle) => JSON.stringify(b, null, 2);

/* ---------- Restore (FR-056, FR-046 import) ---------- */

export interface ImportResult {
  discussion: DiscussionData;
  kpi: KpiData | null;
  analysis: AnalysisData | null;
  company: string | null;
  project: string | null;
  /** Use cases in the file: candidates only, never written directly (I-1). */
  useCases: UseCase[] | null;
}

const isPersona = (p: string): p is Persona => (ALL_PERSONAS as readonly string[]).includes(p);

/** Use cases of a bundle as full UseCase objects; items with an unknown persona are dropped. */
function bundleUseCases(b: ExportBundle): UseCase[] | null {
  if (!b.useCases) return null;
  return b.useCases.flatMap((u): UseCase[] => {
    if (!isPersona(u.persona)) return [];
    const extra = u as Record<string, unknown>;
    return [{
      ...u,
      persona: u.persona,
      origin: extra.origin === 'derived' ? 'derived' : 'registered',
      updatedAt: typeof extra.updatedAt === 'string' ? extra.updatedAt : b.exportedAt,
      ...(typeof extra.derivedFrom === 'string' ? { derivedFrom: extra.derivedFrom } : {}),
    }];
  });
}

export type ImportOutcome = { ok: true; result: ImportResult } | { ok: false; error: 'empty' | 'invalid' };

const BLOCK = /```json bas-export\r?\n([\s\S]*?)\r?\n```/;
const THEME_LINE = /^### (.*) <!-- bas:theme (\S*) -->\s*$/;
const RECORD_LINE = /^- (.*) <!-- bas:record (\S*) -->\s*$/;

function readBlock(md: string): ExportBundle | null {
  const m = BLOCK.exec(md);
  if (!m) return null;
  try {
    const r = ExportBundleSchema.safeParse(JSON.parse(m[1]!));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function orderBy<T extends { id: string }>(items: T[], reference: { id: string }[]): T[] {
  const idx = new Map(reference.map((r, i) => [r.id, i] as const));
  return items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (idx.get(a.x.id) ?? reference.length + a.i) - (idx.get(b.x.id) ?? reference.length + b.i))
    .map((e) => e.x);
}

/**
 * Parse an exported Markdown file. The readable sections are the source of truth for themes and records
 * (so hand edits are kept); the embedded data block restores bilingual text, KPI/OKR and analyses.
 */
export function parseMarkdown(md: string): ImportOutcome {
  const block = readBlock(md);
  const lang: Lang = block?.lang ?? 'ja';
  const themes: Theme[] = [];
  const records: DiscussionRecord[] = [];
  let current: Theme | null = null;
  const blockTheme = (id: string) => block?.discussion.themes.find((t) => t.id === id);
  const blockRecord = (id: string) => block?.discussion.records.find((r) => r.id === id);
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('## ')) current = null;
    const tm = THEME_LINE.exec(line);
    if (tm) {
      const p = new URLSearchParams(tm[2]!);
      const id = p.get('id');
      if (!id) continue;
      const text = unesc(tm[1]!);
      const prev = blockTheme(id);
      current = {
        id,
        parentId: p.get('parent') || null,
        title: prev && loc(prev.title, lang) === text ? prev.title : text,
        classification: p.get('class') === 'internal' ? 'internal' : 'shareable',
        relatedIds: (p.get('related') ?? '').split(',').filter(Boolean),
      };
      themes.push(current);
      continue;
    }
    const rm = RECORD_LINE.exec(line);
    if (rm && current) {
      const p = new URLSearchParams(rm[2]!);
      const id = p.get('id');
      const kind = p.get('kind') as RecordKind | null;
      if (!id || !kind || !SECTION_KINDS.includes(kind)) continue;
      const text = unesc(rm[1]!);
      const prev = blockRecord(id);
      const owner = p.get('owner');
      const due = p.get('due');
      const done = p.get('done');
      records.push({
        id,
        themeId: current.id,
        kind,
        author: p.get('author') === 'ai' ? 'ai' : 'human',
        text: prev && loc(prev.text, lang) === text ? prev.text : text,
        classification: p.get('class') === 'internal' ? 'internal' : 'shareable',
        createdAt: p.get('at') ?? new Date().toISOString(),
        ...(owner !== null ? { owner } : {}),
        ...(due !== null ? { due } : {}),
        ...(done !== null ? { done: done === '1' } : {}),
        ...(p.get('mock') === '1' ? { mock: true } : {}),
      });
    }
  }
  if (!themes.length && !block) return { ok: false, error: md.trim() ? 'invalid' : 'empty' };
  const parsed = DiscussionDataSchema.safeParse({
    themes: block ? orderBy(themes, block.discussion.themes) : themes,
    records: block ? orderBy(records, block.discussion.records) : records,
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };
  return {
    ok: true,
    result: {
      discussion: parsed.data, kpi: block?.kpi ?? null, analysis: block?.analysis ?? null, company: block?.company ?? null, project: block?.project ?? null,
      useCases: block ? bundleUseCases(block) : null,
    },
  };
}

export function parseJson(text: string): ImportOutcome {
  try {
    const r = ExportBundleSchema.safeParse(JSON.parse(text));
    if (!r.success) return { ok: false, error: 'invalid' };
    const b = r.data;
    return { ok: true, result: { discussion: b.discussion, kpi: b.kpi, analysis: b.analysis, company: b.company, project: b.project, useCases: bundleUseCases(b) } };
  } catch {
    return { ok: false, error: text.trim() ? 'invalid' : 'empty' };
  }
}

export function parseImport(text: string): ImportOutcome {
  return text.trimStart().startsWith('{') ? parseJson(text) : parseMarkdown(text);
}
