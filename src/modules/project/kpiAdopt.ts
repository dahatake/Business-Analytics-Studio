import type { OkrExtension } from '../../data/extensionSchemas.ts';
import type { Lang } from '../../i18n/core.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { companyObjectiveIdsOf, validateKpi, type KpiField } from './kpiOkr.ts';
import { newId, type KpiData, type KpiDef, type Okr } from './model.ts';

/**
 * FR-325: adopting the internal KPIs/OKRs that Work IQ found (extensions.okr) as this project's KPIs/OKRs.
 * Adoption never writes a KPI directly: it creates a draft whose numbers are parsed from the candidate's own wording,
 * and the user completes and saves it. Numbers never come from AI; Copilot only chooses candidates and words objectives.
 */

type Ext = Pick<OkrExtension, 'kpis' | 'objectives'>;
type ExtKpi = Ext['kpis'][number];
type ExtObjective = Ext['objectives'][number];

/** Why a draft field needs the user's attention. */
export type DraftNote = 'noTarget' | 'multipleNumbers' | 'baselineFromCurrent' | 'noCurrent' | 'noDeadline';

export interface KpiDraft {
  /** Becomes the KpiDef id when saved, so OKR drafts can link to it before then. */
  id: string;
  candidateId: string;
  name: string;
  unit: string;
  baseline: string;
  current: string;
  target: string;
  deadline: string;
  sourceIds: string[];
  /** The candidate's own wording, shown beside the fields so the user can check every number. */
  original: { target?: string; current?: string; period?: string; definition?: string };
  notes: DraftNote[];
  by: 'user' | 'copilot';
  reason?: string;
  /** Numbers in Copilot's text that appear in no candidate. */
  unverified?: string[];
}

export interface OkrDraft {
  id: string;
  candidateId: string;
  objective: string;
  keyResults: { id: string; text: string; kpiId: string }[];
  sourceIds: string[];
  companyObjectiveIds: string[];
  by: 'user' | 'copilot';
  reason?: string;
  unverified?: string[];
}

export interface KpiDrafts {
  kpis: KpiDraft[];
  okrs: OkrDraft[];
}

export const emptyDrafts = (): KpiDrafts => ({ kpis: [], okrs: [] });

export const kpiCandidateId = (id: string) => `okr.kpi:${id}`;
export const objectiveCandidateId = (id: string) => `okr.obj:${id}`;
const krCandidateId = (objectiveId: string, i: number) => `okr.kr:${objectiveId}:${i}`;

/* ---------- Parsing the candidate's wording ---------- */

const NUM = /[-+]?\d[\d,]*(?:\.\d+)?/g;
/** Periods and dates are not targets: "FY27 までに 10 倍" targets 10, not 27. */
const NOT_A_TARGET = [/\bFY\s?'?\d{2,4}\b/gi, /\d{4}\s*[年/.-]\s*\d{1,2}(?:\s*[月/.-]\s*\d{1,2}\s*日?)?/g, /\d{4}\s*年度?/g, /\b[QH][1-4]\b/gi, /第\s*\d+\s*(?:四半期|期)/g];

const normalize = (text: string) => text.normalize('NFKC');

/** All numbers in a text (NFKC: full-width digits count), periods and dates excluded. */
export function numbersIn(text: string): number[] {
  let rest = normalize(text);
  for (const re of NOT_A_TARGET) rest = rest.replace(re, ' ');
  return (rest.match(NUM) ?? []).map((n) => Number(n.replace(/,/g, ''))).filter(Number.isFinite);
}

export interface ParsedTarget {
  value: string;
  unit: string;
  multiple: boolean;
}

/**
 * "最低5件" → 5, "≥50 engagements" → 50 engagements, "20%" → 20 %. The unit is the candidate's own unit when stated,
 * else the text after the number. With several numbers ("20〜30%") the first is taken and flagged for review.
 */
export function parseTarget(text: string | undefined, unit?: string): ParsedTarget {
  const raw = normalize(text ?? '').trim();
  let masked = raw;
  for (const re of NOT_A_TARGET) masked = masked.replace(re, (m) => ' '.repeat(m.length));
  const matches = [...masked.matchAll(NUM)];
  const first = matches[0];
  const value = first ? String(Number(first[0].replace(/,/g, ''))) : '';
  const last = matches[matches.length - 1];
  let u = normalize(unit ?? '').trim();
  // A range ("20〜30%") states its unit after the last number.
  const gap = last && first !== last ? masked.slice(first!.index! + first![0].length, last.index) + (last[0].startsWith('-') ? '-' : '') : '';
  const after = /^\s*[〜~\-–ー]\s*$/.test(gap) ? last : first;
  if (!u && after) u = (raw.slice(after.index! + after[0].length).trim().split(/[\s/、,，（(]/)[0] ?? '').replace(/^(以上|以下|超|未満)$/, '');
  return { value: Number.isFinite(Number(value)) ? value : '', unit: u, multiple: matches.length > 1 };
}

/** A measured value only when the text is a single number; "未計測" or prose stays empty. */
function singleNumber(text: string | undefined): string {
  if (!text) return '';
  const nums = numbersIn(text);
  return nums.length === 1 ? String(nums[0]) : '';
}

const isoDate = (text: string | undefined) => (text && /^\d{4}-\d{2}-\d{2}$/.test(text.trim()) && !Number.isNaN(Date.parse(text.trim())) ? text.trim() : '');

interface KpiSource {
  candidateId: string;
  name: string;
  target?: string;
  unit?: string;
  current?: string;
  period?: string;
  definition?: string;
  sourceIds: string[];
}

function kpiDraft(src: KpiSource, by: KpiDraft['by'], reason?: string, unverified?: string[]): KpiDraft {
  const target = parseTarget(src.target, src.unit);
  const current = singleNumber(src.current);
  const deadline = isoDate(src.period);
  const notes: DraftNote[] = [];
  if (!target.value) notes.push('noTarget');
  if (target.multiple) notes.push('multipleNumbers');
  notes.push(current ? 'baselineFromCurrent' : 'noCurrent');
  if (!deadline) notes.push('noDeadline');
  return {
    id: newId('kpi'),
    candidateId: src.candidateId,
    name: src.name,
    unit: target.unit,
    // The baseline is the value when the project adopts the KPI: the current value if the material states one.
    baseline: current,
    current,
    target: target.value,
    deadline,
    sourceIds: src.sourceIds,
    original: {
      ...(src.target ? { target: [src.target, src.unit].filter(Boolean).join(' ') } : {}),
      ...(src.current ? { current: src.current } : {}),
      ...(src.period ? { period: src.period } : {}),
      ...(src.definition ? { definition: src.definition } : {}),
    },
    notes,
    by,
    ...(reason ? { reason } : {}),
    ...(unverified?.length ? { unverified } : {}),
  };
}

/* ---------- Candidates ---------- */

const txt = (v: Localizable | undefined, lang: Lang) => (v === undefined ? '' : loc(v, lang));

function kpiSourceOfExt(k: ExtKpi, lang: Lang): KpiSource {
  return {
    candidateId: kpiCandidateId(k.id), name: txt(k.name, lang), target: k.target, unit: k.unit, current: k.current, period: k.period,
    definition: txt(k.definition, lang) || undefined, sourceIds: k.sourceIds ?? [],
  };
}

/** The KPI a key result is measured by: an internal KPI candidate, a KPI the project already has, or the KR itself. */
type KrKpi = { kind: 'existing'; kpiId: string } | { kind: 'candidate'; source: KpiSource };

const STOP = new Set(['and', 'the', 'for', 'with', 'per', 'min', 'max', 'all', 'our', 'your', 'are', 'fy27']);
const stem = (w: string) => w.replace(/(ing|ly|ed|s)$/, '').replace(/e$/, '');
const words = (text: string) => new Set((normalize(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem));
const numbers = (text: string) => new Set((normalize(text).match(NUM) ?? []).map((n) => Number(n.replace(/,/g, ''))));
const allText = (v: Localizable | undefined) => (v === undefined ? '' : typeof v === 'string' ? v : `${v.ja} ${v.en}`);

/**
 * PARAM-174: a key result without kpiId that restates an internal KPI — every number of the KPI's target appears in the KR,
 * and they share a word or a unit other than % — is measured by that KPI instead of a duplicate KPI drafted from its text.
 * When the KR matches KPIs with different targets (it bundles several measures), nothing is linked.
 */
function matchKpi(krText: string, ext: Ext, data: KpiData, drafts: KpiDrafts | undefined): ExtKpi | undefined {
  const t = krText;
  const krNums = numbers(t);
  if (!krNums.size) return undefined;
  const krWords = words(t);
  const matches = ext.kpis.flatMap((k) => {
    const nums = numbers(k.target ?? '');
    if (!nums.size || ![...nums].every((n) => krNums.has(n))) return [];
    const shared = [...words(`${allText(k.name)} ${allText(k.definition)} ${k.target ?? ''} ${k.unit ?? ''}`)].filter((w) => krWords.has(w)).length;
    const unit = normalize(k.unit ?? '').trim();
    if (!shared && !(unit && unit !== '%' && normalize(t).includes(unit))) return [];
    return [{ k, nums, shared }];
  });
  if (!matches.length) return undefined;
  const sameMeasure = (a: Set<number>, b: Set<number>) => [...a].every((n) => b.has(n)) || [...b].every((n) => a.has(n));
  if (!matches.every((m) => sameMeasure(m.nums, matches[0]!.nums))) return undefined;
  const rank = (k: ExtKpi) => {
    const cid = kpiCandidateId(k.id);
    return kpiAdoptState(cid, data, drafts ?? { kpis: [], okrs: [] }) === 'adopted' ? 2 : drafts?.kpis.some((d) => d.candidateId === cid) ? 1 : 0;
  };
  return matches.sort((a, b) => rank(b.k) - rank(a.k) || b.shared - a.shared)[0]!.k;
}

function krKpi(o: ExtObjective, i: number, ext: Ext, data: KpiData, lang: Lang, drafts?: KpiDrafts): KrKpi {
  const kr = o.keyResults[i]!;
  const linked = kr.kpiId ? ext.kpis.find((k) => k.id === kr.kpiId) : matchKpi(`${allText(kr.text)} ${kr.target ?? ''}`, ext, data, drafts);
  if (linked) return { kind: 'candidate', source: kpiSourceOfExt(linked, lang) };
  if (kr.kpiId && data.kpis.some((k) => k.id === kr.kpiId)) return { kind: 'existing', kpiId: kr.kpiId };
  return {
    kind: 'candidate',
    source: { candidateId: krCandidateId(o.id, i), name: txt(kr.text, lang), target: kr.target ?? txt(kr.text, lang), period: kr.period, sourceIds: o.sourceIds ?? [] },
  };
}

export type AdoptState = 'adopted' | 'draft' | null;

export function kpiAdoptState(candidateId: string, data: KpiData, drafts: KpiDrafts): AdoptState {
  const imported = candidateId.startsWith('okr.kpi:') ? candidateId.slice('okr.kpi:'.length) : null;
  if (data.kpis.some((k) => k.adoptedFrom === candidateId || (imported !== null && k.id === imported))) return 'adopted';
  return drafts.kpis.some((d) => d.candidateId === candidateId) ? 'draft' : null;
}

export function okrAdoptState(candidateId: string, data: KpiData, drafts: KpiDrafts): AdoptState {
  // packKpis already turns objectives whose key results measure numeric pack KPIs into OKRs with the objective's id.
  const imported = candidateId.startsWith('okr.obj:') ? candidateId.slice('okr.obj:'.length) : null;
  if (data.okrs.some((o) => o.adoptedFrom === candidateId || (imported !== null && o.id === imported))) return 'adopted';
  return drafts.okrs.some((d) => d.candidateId === candidateId) ? 'draft' : null;
}

/** The KPI id a key result links to, creating a KPI draft when the KPI is neither saved nor drafted yet. */
function resolveKpi(target: KrKpi, data: KpiData, drafts: KpiDrafts, by: KpiDraft['by']): string {
  if (target.kind === 'existing') return target.kpiId;
  const cid = target.source.candidateId;
  const saved = data.kpis.find((k) => k.adoptedFrom === cid || kpiCandidateId(k.id) === cid);
  if (saved) return saved.id;
  const drafted = drafts.kpis.find((d) => d.candidateId === cid);
  if (drafted) return drafted.id;
  const draft = kpiDraft(target.source, by);
  drafts.kpis.push(draft);
  return draft.id;
}

export interface AddResult {
  drafts: KpiDrafts;
  added: number;
  /** Candidates already adopted or drafted. */
  skipped: number;
}

export interface AddOptions {
  by?: KpiDraft['by'];
  reasons?: ReadonlyMap<string, { reason: string; unverified: string[] }>;
}

const cloneDrafts = (d: KpiDrafts): KpiDrafts => ({ kpis: [...d.kpis], okrs: [...d.okrs] });

/**
 * [KPIに追加する]: each selected KPI becomes a KPI draft; a selected objective contributes the KPIs of its key results.
 */
export function addKpiDrafts(candidateIds: readonly string[], ext: Ext, data: KpiData, drafts: KpiDrafts, lang: Lang, opts: AddOptions = {}): AddResult {
  const next = cloneDrafts(drafts);
  const by = opts.by ?? 'user';
  let added = 0;
  let skipped = 0;
  const sources: KpiSource[] = [];
  for (const cid of candidateIds) {
    const k = ext.kpis.find((x) => kpiCandidateId(x.id) === cid);
    if (k) sources.push(kpiSourceOfExt(k, lang));
    const o = ext.objectives.find((x) => objectiveCandidateId(x.id) === cid);
    if (o) o.keyResults.forEach((_, i) => { const r = krKpi(o, i, ext, data, lang, next); if (r.kind === 'candidate') sources.push(r.source); else skipped++; });
  }
  const unique = sources.filter((s, i) => sources.findIndex((x) => x.candidateId === s.candidateId) === i);
  for (const src of unique) {
    if (kpiAdoptState(src.candidateId, data, next)) { skipped++; continue; }
    const why = opts.reasons?.get(src.candidateId);
    next.kpis.push(kpiDraft(src, by, why?.reason, why?.unverified));
    added++;
  }
  return { drafts: next, added, skipped };
}

function krText(text: string, target: string | undefined): string {
  if (!target || normalize(text).includes(normalize(target))) return text;
  return `${text} (${target})`;
}

/**
 * [OKRに追加する]: a selected objective becomes an OKR draft whose key results link to its KPIs; a selected KPI becomes
 * an OKR draft with that KPI as its key result. KPIs not in the project yet are drafted alongside.
 */
export function addOkrDrafts(candidateIds: readonly string[], ext: Ext, data: KpiData, drafts: KpiDrafts, lang: Lang, opts: AddOptions = {}): AddResult {
  const next = cloneDrafts(drafts);
  const by = opts.by ?? 'user';
  let added = 0;
  let skipped = 0;
  for (const cid of candidateIds) {
    if (okrAdoptState(cid, data, next)) { skipped++; continue; }
    const why = opts.reasons?.get(cid);
    const meta = { by, ...(why?.reason ? { reason: why.reason } : {}), ...(why?.unverified.length ? { unverified: why.unverified } : {}) };
    const o = ext.objectives.find((x) => objectiveCandidateId(x.id) === cid);
    if (o) {
      const keyResults = o.keyResults.map((kr, i) => ({ id: newId('kr'), text: krText(txt(kr.text, lang), kr.target), kpiId: resolveKpi(krKpi(o, i, ext, data, lang, next), data, next, by) }));
      next.okrs.push({
        id: newId('okr'), candidateId: cid, objective: txt(o.objective, lang),
        keyResults: keyResults.length ? keyResults : [{ id: newId('kr'), text: '', kpiId: '' }],
        sourceIds: o.sourceIds ?? [], companyObjectiveIds: companyObjectiveIdsOf(o), ...meta,
      });
      added++;
      continue;
    }
    const k = ext.kpis.find((x) => kpiCandidateId(x.id) === cid);
    if (k) {
      const src = kpiSourceOfExt(k, lang);
      next.okrs.push({
        id: newId('okr'), candidateId: cid, objective: src.definition ?? src.name,
        keyResults: [{ id: newId('kr'), text: krText(src.name, [k.target, k.unit].filter(Boolean).join(' ') || undefined), kpiId: resolveKpi({ kind: 'candidate', source: src }, data, next, by) }],
        sourceIds: k.sourceIds ?? [], companyObjectiveIds: [], ...meta,
      });
      added++;
    }
  }
  return { drafts: next, added, skipped };
}

/* ---------- Saving ---------- */

export function draftToKpi(d: KpiDraft): KpiDef {
  return {
    id: d.id, name: d.name.trim(), unit: d.unit.trim(), baseline: Number(d.baseline), current: Number(d.current), target: Number(d.target), deadline: d.deadline,
    origin: 'customerDefined', ...(d.sourceIds.length ? { sourceIds: d.sourceIds } : {}), adoptedFrom: d.candidateId,
  };
}

export type SaveError =
  | { kind: 'kpi'; draftId: string; fields: KpiField[] }
  | { kind: 'objective'; draftId: string }
  | { kind: 'keyResult'; draftId: string }
  | { kind: 'link'; draftId: string };

export type SaveResult = { ok: true; data: KpiData; drafts: KpiDrafts } | { ok: false; errors: SaveError[] };

export function saveKpiDraft(id: string, data: KpiData, drafts: KpiDrafts): SaveResult {
  const d = drafts.kpis.find((x) => x.id === id);
  if (!d) return { ok: false, errors: [] };
  const fields = validateKpi(d);
  if (fields.length) return { ok: false, errors: [{ kind: 'kpi', draftId: id, fields }] };
  return { ok: true, data: { ...data, kpis: [...data.kpis, draftToKpi(d)] }, drafts: { ...drafts, kpis: drafts.kpis.filter((x) => x.id !== id) } };
}

/** Saving an OKR also saves the KPI drafts its key results link to; nothing is saved unless all of them are valid. */
export function saveOkrDraft(id: string, data: KpiData, drafts: KpiDrafts): SaveResult {
  const o = drafts.okrs.find((x) => x.id === id);
  if (!o) return { ok: false, errors: [] };
  const errors: SaveError[] = [];
  if (!o.objective.trim()) errors.push({ kind: 'objective', draftId: id });
  const krs = o.keyResults.filter((kr) => kr.text.trim() && kr.kpiId);
  if (krs.length === 0) errors.push({ kind: 'keyResult', draftId: id });
  const linked: KpiDraft[] = [];
  for (const kr of krs) {
    if (data.kpis.some((k) => k.id === kr.kpiId)) continue;
    const d = drafts.kpis.find((x) => x.id === kr.kpiId);
    if (!d) { errors.push({ kind: 'link', draftId: id }); continue; }
    if (linked.includes(d)) continue;
    const fields = validateKpi(d);
    if (fields.length) errors.push({ kind: 'kpi', draftId: d.id, fields });
    linked.push(d);
  }
  if (errors.some((e) => e.kind === 'kpi') && !errors.some((e) => e.kind === 'link')) errors.push({ kind: 'link', draftId: id });
  if (errors.length) return { ok: false, errors };
  const okr: Okr = {
    id: o.id, objective: o.objective.trim(), keyResults: krs.map((kr) => ({ id: kr.id, text: kr.text.trim(), kpiId: kr.kpiId })),
    origin: 'customerDefined', adoptedFrom: o.candidateId,
    ...(o.companyObjectiveIds.length ? { companyObjectiveIds: o.companyObjectiveIds } : {}),
    ...(o.sourceIds.length ? { sourceIds: o.sourceIds } : {}),
  };
  return {
    ok: true,
    data: { kpis: [...data.kpis, ...linked.map(draftToKpi)], okrs: [...data.okrs, okr] },
    drafts: { kpis: drafts.kpis.filter((x) => !linked.includes(x)), okrs: drafts.okrs.filter((x) => x.id !== id) },
  };
}

/** [すべて保存]: saves every valid draft (KPIs first, so OKRs can link to them) and keeps the rest with their errors. */
export function saveAllDrafts(data: KpiData, drafts: KpiDrafts): { data: KpiData; drafts: KpiDrafts; saved: number; errors: SaveError[] } {
  let d = data;
  let rest = drafts;
  let saved = 0;
  const errors: SaveError[] = [];
  for (const k of drafts.kpis) {
    if (!rest.kpis.some((x) => x.id === k.id)) continue;
    const r = saveKpiDraft(k.id, d, rest);
    if (r.ok) { d = r.data; rest = r.drafts; saved++; } else errors.push(...r.errors);
  }
  for (const o of drafts.okrs) {
    const r = saveOkrDraft(o.id, d, rest);
    if (r.ok) { d = r.data; rest = r.drafts; saved++; continue; }
    const own = r.errors.filter((e) => e.kind !== 'kpi');
    errors.push(...(own.length ? own : [{ kind: 'link' as const, draftId: o.id }]));
  }
  return { data: d, drafts: rest, saved, errors };
}

/** Discarding a KPI draft unlinks the OKR-draft key results that pointed at it (the user picks another KPI). */
export function discardKpiDraft(id: string, drafts: KpiDrafts): KpiDrafts {
  return {
    kpis: drafts.kpis.filter((x) => x.id !== id),
    okrs: drafts.okrs.map((o) => (o.keyResults.some((kr) => kr.kpiId === id) ? { ...o, keyResults: o.keyResults.map((kr) => (kr.kpiId === id ? { ...kr, kpiId: '' } : kr)) } : o)),
  };
}

export const discardOkrDraft = (id: string, drafts: KpiDrafts): KpiDrafts => ({ ...drafts, okrs: drafts.okrs.filter((x) => x.id !== id) });

/* ---------- Copilot: choose candidates for the project (AI use kpiOkrDraft, D-28) ---------- */

export const KPI_DRAFT_MARK = '[bas-proj:kpiOkrDraft]';
/** PARAM-163: at most this many KPIs and OKRs per Copilot draft, so the user can review each one. */
export const MAX_AI_KPIS = 5;
export const MAX_AI_OKRS = 3;
/** Candidates sent per request; the relay accepts 32,000 characters. */
const MAX_PROMPT_CHARS = 30_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface DraftPromptInput {
  purpose: string;
  ext: Ext;
  data: KpiData;
  drafts: KpiDrafts;
  lang: Lang;
}

/** Candidates not yet adopted or drafted, in the order shown. */
export function openCandidates(ext: Ext, data: KpiData, drafts: KpiDrafts) {
  return {
    kpis: ext.kpis.filter((k) => !kpiAdoptState(kpiCandidateId(k.id), data, drafts)),
    objectives: ext.objectives.filter((o) => !okrAdoptState(objectiveCandidateId(o.id), data, drafts)),
  };
}

export function kpiDraftPrompt({ purpose, ext, data, drafts, lang }: DraftPromptInput): string {
  const ja = lang === 'ja';
  const open = openCandidates(ext, data, drafts);
  const kpiLine = (k: ExtKpi) => `- id: ${kpiCandidateId(k.id)} | ${clip(txt(k.name, lang), 120)}${k.definition ? ` | ${ja ? '定義' : 'definition'}: ${clip(txt(k.definition, lang), 200)}` : ''}${k.target ? ` | ${ja ? '目標' : 'target'}: ${clip([k.target, k.unit].filter(Boolean).join(' '), 80)}` : ''}${k.period ? ` | ${ja ? '期間' : 'period'}: ${clip(k.period, 40)}` : ''}${k.owner ? ` | ${ja ? '責任者' : 'owner'}: ${clip(txt(k.owner, lang), 60)}` : ''}`;
  const objLine = (o: ExtObjective) => `- id: ${objectiveCandidateId(o.id)} | ${clip(txt(o.objective, lang), 200)}${o.keyResults.map((kr) => `\n  - KR: ${clip(txt(kr.text, lang), 160)}${kr.target ? ` (${clip(kr.target, 60)})` : ''}`).join('')}`;
  // Targets let the model see that a differently named candidate measures the same thing as a KPI the project has.
  const existing = (sep: string) => data.kpis.map((k) => `${loc(k.name, lang)}${Number.isFinite(k.target) ? ` (${[k.target, loc(k.unit, lang)].filter((x) => x !== '').join(' ')})` : ''}`).join(sep);
  const head = [
    KPI_DRAFT_MARK,
    ja ? `Project の目的: ${clip(purpose.trim() || '（未記入）', 1000)}` : `Project purpose: ${clip(purpose.trim() || '(not written)', 1000)}`,
    ja ? `Project にすでにある KPI（目標）: ${existing('、') || 'なし'}` : `KPIs the project already has (target): ${existing(', ') || 'none'}`,
    ja ? `Project にすでにある OKR: ${data.okrs.map((o) => loc(o.objective, lang)).join('、') || 'なし'}` : `OKRs the project already has: ${data.okrs.map((o) => loc(o.objective, lang)).join(', ') || 'none'}`,
  ];
  const tail = ja ? [
    '',
    `指示: Project の目的の達成を測るのに最も適した候補を選んでください。KPI は最大 ${MAX_AI_KPIS} 件、OKR は最大 ${MAX_AI_OKRS} 件。目的に関係のない候補、すでにある KPI・OKR と同じ内容の候補は選ばないでください。`,
    'OKR は「社内の OKR」の id をそのまま選ぶか、選んだ KPI の id を kpiIds に並べて objective（目的の文、1 文）を書いてください。数値は書かず、候補にない数値・人物・事実を作らないでください。reason は選んだ理由を目的と結び付けて 1 文で。',
    '次の JSON だけで答えてください: {"kpis":[{"id":"okr.kpi:…","reason":"…"}],"okrs":[{"id":"okr.obj:…","reason":"…"},{"kpiIds":["okr.kpi:…"],"objective":"…","reason":"…"}]}',
  ] : [
    '',
    `Instruction: choose the candidates that best measure progress toward the project purpose: at most ${MAX_AI_KPIS} KPIs and ${MAX_AI_OKRS} OKRs. Skip candidates unrelated to the purpose or duplicating the project's existing KPIs/OKRs.`,
    'For an OKR, either pick an internal OKR id as is, or list chosen KPI ids in kpiIds and write a one-sentence objective. Write no numbers and never invent figures, people or facts not in the candidates. reason: one sentence linking the choice to the purpose.',
    'Answer with this JSON only: {"kpis":[{"id":"okr.kpi:…","reason":"…"}],"okrs":[{"id":"okr.obj:…","reason":"…"},{"kpiIds":["okr.kpi:…"],"objective":"…","reason":"…"}]}',
  ];
  const kpiLines = open.kpis.map(kpiLine);
  const objLines = open.objectives.map(objLine);
  const build = () => [...head, '', ja ? '社内の KPI の候補:' : 'Internal KPI candidates:', ...(kpiLines.length ? kpiLines : [ja ? '（なし）' : '(none)']),
    '', ja ? '社内の OKR の候補:' : 'Internal OKR candidates:', ...(objLines.length ? objLines : [ja ? '（なし）' : '(none)']), ...tail].join('\n');
  let prompt = build();
  while (prompt.length > MAX_PROMPT_CHARS && (kpiLines.length > 1 || objLines.length > 1)) {
    if (objLines.length >= kpiLines.length) objLines.pop(); else kpiLines.pop();
    prompt = build();
  }
  return prompt;
}

export interface CopilotPick {
  kpis: { candidateId: string; reason: string; unverified: string[] }[];
  okrs: CopilotOkrPick[];
  /** Ids or entries the answer named that are not open candidates. */
  rejected: string[];
}
export type CopilotOkrPick = ({ candidateId: string } | { kpiCandidateIds: string[]; objective: string }) & { reason: string; unverified: string[] };

/** Numbers the candidates and the project purpose state; any other number in Copilot's text is shown as unverified. */
function knownNumbers(ext: Ext, purpose: string): Set<number> {
  const texts: string[] = [purpose];
  for (const k of ext.kpis) texts.push(...[k.name, k.definition, k.owner].flatMap((v) => (v === undefined ? [] : typeof v === 'string' ? [v] : [v.ja, v.en])), k.target ?? '', k.current ?? '', k.unit ?? '', k.period ?? '');
  for (const o of ext.objectives) {
    texts.push(...(typeof o.objective === 'string' ? [o.objective] : [o.objective.ja, o.objective.en]));
    for (const kr of o.keyResults) texts.push(...(typeof kr.text === 'string' ? [kr.text] : [kr.text.ja, kr.text.en]), kr.target ?? '', kr.period ?? '');
  }
  return new Set(texts.flatMap((t) => (normalize(t).match(NUM) ?? []).map((n) => Number(n.replace(/,/g, '')))));
}

function unverifiedIn(text: string, known: Set<number>): string[] {
  return [...new Set((normalize(text).match(NUM) ?? []).filter((n) => !known.has(Number(n.replace(/,/g, '')))))];
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validates Copilot's answer against the open candidates: unknown or duplicate ids are dropped, counts capped. */
export function parseKpiDraftResponse(text: string, input: DraftPromptInput): CopilotPick {
  const json = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
  const raw = JSON.parse(json) as unknown;
  if (!raw || typeof raw !== 'object') throw new Error('not an object');
  const { kpis: rawKpis, okrs: rawOkrs } = raw as { kpis?: unknown; okrs?: unknown };
  const open = openCandidates(input.ext, input.data, input.drafts);
  const kpiIds = new Set(open.kpis.map((k) => kpiCandidateId(k.id)));
  const objIds = new Set(open.objectives.map((o) => objectiveCandidateId(o.id)));
  const known = knownNumbers(input.ext, input.purpose);
  const rejected: string[] = [];
  const kpis: CopilotPick['kpis'] = [];
  for (const item of Array.isArray(rawKpis) ? rawKpis : []) {
    const id = str((item as { id?: unknown })?.id, 300);
    const reason = str((item as { reason?: unknown })?.reason, 400);
    if (!kpiIds.has(id) || kpis.some((k) => k.candidateId === id)) { rejected.push(id || '?'); continue; }
    if (kpis.length >= MAX_AI_KPIS) continue;
    kpis.push({ candidateId: id, reason, unverified: unverifiedIn(reason, known) });
  }
  const okrs: CopilotOkrPick[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rawOkrs) ? rawOkrs : []) {
    const o = (item ?? {}) as { id?: unknown; kpiIds?: unknown; objective?: unknown; reason?: unknown };
    const reason = str(o.reason, 400);
    const id = str(o.id, 300);
    if (id) {
      if (!objIds.has(id) || seen.has(id)) { rejected.push(id); continue; }
      if (okrs.length >= MAX_AI_OKRS) continue;
      seen.add(id);
      okrs.push({ candidateId: id, reason, unverified: unverifiedIn(reason, known) });
      continue;
    }
    const ids = Array.isArray(o.kpiIds) ? [...new Set(o.kpiIds.map((x) => str(x, 300)))] : [];
    const valid = ids.filter((x) => input.ext.kpis.some((k) => kpiCandidateId(k.id) === x));
    rejected.push(...ids.filter((x) => !valid.includes(x)));
    const objective = str(o.objective, 300);
    const key = valid.slice().sort().join('+');
    if (!valid.length || !objective || seen.has(key)) continue;
    if (okrs.length >= MAX_AI_OKRS) continue;
    seen.add(key);
    okrs.push({ kpiCandidateIds: valid, objective, reason, unverified: unverifiedIn(`${objective} ${reason}`, known) });
  }
  return { kpis, okrs, rejected };
}

/** Turns Copilot's picks into drafts with the same deterministic mapping as the manual buttons. */
export function applyCopilotPick(pick: CopilotPick, input: DraftPromptInput): AddResult {
  const { ext, data, lang } = input;
  const reasons = new Map<string, { reason: string; unverified: string[] }>();
  for (const k of pick.kpis) reasons.set(k.candidateId, k);
  const kpiStep = addKpiDrafts(pick.kpis.map((k) => k.candidateId), ext, data, input.drafts, lang, { by: 'copilot', reasons });
  let drafts = kpiStep.drafts;
  let { added, skipped } = kpiStep;
  const objReasons = new Map<string, { reason: string; unverified: string[] }>();
  for (const o of pick.okrs) if ('candidateId' in o) objReasons.set(o.candidateId, o);
  const objStep = addOkrDrafts(pick.okrs.flatMap((o) => ('candidateId' in o ? [o.candidateId] : [])), ext, data, drafts, lang, { by: 'copilot', reasons: objReasons });
  drafts = objStep.drafts;
  added += objStep.added;
  skipped += objStep.skipped;
  for (const o of pick.okrs) {
    if (!('kpiCandidateIds' in o)) continue;
    const candidateId = `okr.set:${o.kpiCandidateIds.slice().sort().join('+')}`;
    if (okrAdoptState(candidateId, data, drafts)) { skipped++; continue; }
    const next = cloneDrafts(drafts);
    const keyResults = o.kpiCandidateIds.map((cid) => {
      const k = ext.kpis.find((x) => kpiCandidateId(x.id) === cid)!;
      const src = kpiSourceOfExt(k, lang);
      return { id: newId('kr'), text: krText(src.name, [k.target, k.unit].filter(Boolean).join(' ') || undefined), kpiId: resolveKpi({ kind: 'candidate', source: src }, data, next, 'copilot') };
    });
    const sourceIds = [...new Set(o.kpiCandidateIds.flatMap((cid) => ext.kpis.find((x) => kpiCandidateId(x.id) === cid)?.sourceIds ?? []))];
    next.okrs.push({
      id: newId('okr'), candidateId, objective: o.objective, keyResults, sourceIds, companyObjectiveIds: [], by: 'copilot',
      ...(o.reason ? { reason: o.reason } : {}), ...(o.unverified.length ? { unverified: o.unverified } : {}),
    });
    drafts = next;
    added++;
  }
  return { drafts, added, skipped };
}
