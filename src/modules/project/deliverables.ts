import { z } from 'zod';
import type { LoadedPack } from '../../data/pack.ts';
import type { Entity, EntityOf } from '../../data/schema.ts';
import { chooseKpiVisual } from '../../domain/kpi.ts';
import { rankIssues } from '../../domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../../domain/summary.ts';
import type { MessageKey } from '../../i18n/core.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import type { Localizable } from '../../state/text.ts';
import type { UseCase } from '../usecases/store.ts';
import { categoriesOf } from './analysis.ts';
import { validateKpi } from './kpiOkr.ts';
import type { AnalysisData, DiscussionData, KpiData, KpiDef } from './model.ts';

/**
 * Deliverables of the five improvement steps (FR-136 / PARAM-030): what each step must have finished (exit criteria)
 * and what the project adds on top of the customer pack and the existing project data (the deliverable's fields).
 * Every exit criterion is either judged here deterministically from the data ('auto') or signed off by a person ('manual').
 */

/**
 * Default hurdle for the plan check: the longest payback a solution may have, counted from the start of its first
 * initiative (build period + investment ÷ annual benefit). It is an assumption until the project records its own
 * investment criterion (`criteria.paybackMaxYears`), because the right value is the customer's, not the app's.
 */
export const PAYBACK_MAX_YEARS = 3;
/** Range a project may set for its payback hurdle (years). */
export const PAYBACK_LIMIT_RANGE = { min: 0.5, max: 10 } as const;
/** How far (share of the planned duration) an initiative may lag before the plan draft lists it as a risk. */
export const SCHEDULE_LAG_MAX = 0.2;

/* ---------- Stored data (project-scoped) ---------- */

export const FieldValueSchema = z.object({
  text: z.string(),
  author: z.enum(['human', 'ai']),
  /** The AI text came from the registered mock (must be labelled as mock). */
  mock: z.boolean().optional(),
  updatedAt: z.string(),
});
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const SignOffSchema = z.object({ at: z.string(), by: z.string() });
export type SignOff = z.infer<typeof SignOffSchema>;

/** A judging criterion the project decided itself, with who set it and when. */
export const CriterionSchema = z.object({ value: z.number().min(PAYBACK_LIMIT_RANGE.min).max(PAYBACK_LIMIT_RANGE.max), at: z.string(), by: z.string() });
export type Criterion = z.infer<typeof CriterionSchema>;

export const DeliverableDataSchema = z.object({
  /** step → field id → value. */
  docs: z.record(z.string(), z.record(z.string(), FieldValueSchema)),
  /** manual todo id → sign-off. Absent = not signed off. */
  signOffs: z.record(z.string(), SignOffSchema),
  /** Project-specific judging criteria. Absent = the app's defaults. A broken value falls back to the default. */
  criteria: z.object({ paybackMaxYears: CriterionSchema.optional().catch(undefined) }).optional().catch(undefined),
});
export type DeliverableData = z.infer<typeof DeliverableDataSchema>;

export const emptyDeliverables = (): DeliverableData => ({ docs: {}, signOffs: {} });

/** Stored values are read back defensively: a broken value never breaks the screen. */
export function normalizeDeliverables(raw: unknown): DeliverableData {
  const r = DeliverableDataSchema.safeParse(raw);
  return r.success ? r.data : emptyDeliverables();
}

/* ---------- Definitions ---------- */

export interface FieldDef {
  id: string;
  /** Must contain a number (a measurable statement), e.g. "16 → 10 days". */
  quantified?: boolean;
  /** Must also contain a date or period (SMART: time-bound). */
  timeBound?: boolean;
}

export interface CheckContext {
  pack: LoadedPack;
  discussion: DiscussionData;
  kpi: KpiData;
  analysis: AnalysisData;
  useCases: UseCase[];
  deliverables: DeliverableData;
  /** YYYY-MM-DD in the app's time zone. */
  today: string;
}

/** Something a check result points at, so the user can see exactly what to fix. */
export type CheckRef =
  | { type: 'entity'; id: string }
  | { type: 'field'; step: ImprovementStep; id: string }
  | { type: 'text'; text: Localizable };

export interface CheckOutcome {
  ok: boolean;
  /** Message key suffix: `dlv.r.<code>`. */
  code: string;
  vars?: Record<string, string | number>;
  refs?: CheckRef[];
}

export interface TodoDef {
  id: string;
  kind: 'auto' | 'manual';
  /** Where the user does the work (hash path). */
  href: string;
  check?: (c: CheckContext) => CheckOutcome;
}

export interface StepDef {
  step: ImprovementStep;
  /** Existing data this step reads (message key suffixes `dlv.input.<id>`). */
  inputs: string[];
  fields: FieldDef[];
  todos: TodoDef[];
}

/* ---------- Helpers ---------- */

const NUMBER = /\d/;
/** A year, a month/date or a fiscal period, in either language. */
const DATE = /(?:19|20)\d{2}|\d{1,2}\s*月|\d{1,2}\/\d{1,2}|FY\s?\d{2}|Q[1-4]|四半期|週|weekly|monthly|quarter/i;

export const hasNumber = (s: string) => NUMBER.test(s);
export const hasDate = (s: string) => DATE.test(s);

const kindOf = <K extends Entity['kind']>(pack: LoadedPack, kind: K) => pack.pack.entities.filter((e): e is EntityOf<K> => e.kind === kind);
const pass = (code: string, vars?: CheckOutcome['vars']): CheckOutcome => ({ ok: true, code, ...(vars ? { vars } : {}) });
const fail = (code: string, refs: CheckRef[] = [], vars?: CheckOutcome['vars']): CheckOutcome => ({ ok: false, code, refs, ...(vars ? { vars } : {}) });
const entityRefs = (es: { id: string }[]): CheckRef[] => es.map((e) => ({ type: 'entity', id: e.id }));
const textOf = (t: Localizable) => (typeof t === 'string' ? [t] : [t.ja, t.en]);

/** Issues ranked by the overview's default weights (impact 60 / feasibility 40). */
export const rankedIssues = (pack: LoadedPack) => rankIssues(kindOf(pack, 'issue'), DEFAULT_WEIGHTS).map((r) => r.issue);

/** A pack KPI is covered when the project registered it (same id) or a KPI of the same name. */
export function projectHasKpi(kpis: KpiDef[], k: EntityOf<'kpi'>): boolean {
  return kpis.some((p) => p.id === k.id || textOf(p.name).some((n) => n.trim() !== '' && (n === k.name.ja || n === k.name.en)));
}

function docCheck(step: ImprovementStep, fields: FieldDef[]) {
  return (c: CheckContext): CheckOutcome => {
    const doc = c.deliverables.docs[step] ?? {};
    const refs: CheckRef[] = [];
    let empty = 0;
    let vague = 0;
    for (const f of fields) {
      const text = doc[f.id]?.text.trim() ?? '';
      if (!text) {
        empty += 1;
        refs.push({ type: 'field', step, id: f.id });
      } else if ((f.quantified && !hasNumber(text)) || (f.timeBound && !hasDate(text))) {
        vague += 1;
        refs.push({ type: 'field', step, id: f.id });
      }
    }
    if (empty === 0 && vague === 0) return pass('docComplete', { n: fields.length });
    return fail(empty > 0 ? 'docMissing' : 'docVague', refs, { empty, vague });
  };
}

/* ---------- The five steps ---------- */

const DEFINE_FIELDS: FieldDef[] = [
  { id: 'problem', quantified: true },
  { id: 'impact', quantified: true },
  { id: 'scopeIn' },
  { id: 'scopeOut' },
  { id: 'sponsor' },
  { id: 'hypotheses' },
  { id: 'success', quantified: true, timeBound: true },
];

const ASIS_FIELDS: FieldDef[] = [
  { id: 'currentProcess' },
  { id: 'evidence', quantified: true },
  { id: 'rootCause' },
  { id: 'dataGaps' },
  { id: 'constraints' },
];

const KPI_FIELDS: FieldDef[] = [
  { id: 'kpiTree' },
  { id: 'formula' },
  { id: 'dataSource' },
  { id: 'frequency' },
  { id: 'owner' },
];

const USECASE_FIELDS: FieldDef[] = [
  { id: 'actors' },
  { id: 'scenario' },
  { id: 'acceptance', quantified: true },
  { id: 'dataNeeds' },
  { id: 'risks' },
];

const PLAN_FIELDS: FieldDef[] = [
  { id: 'roadmap', timeBound: true },
  { id: 'businessCase', quantified: true },
  { id: 'raci' },
  { id: 'risks' },
  { id: 'ask' },
];

const docHref = (step: ImprovementStep) => `/deliverables?step=${step}`;

/** i18n keys by convention (checked by the i18n test through the typed dictionaries). */
export const fieldKey = (step: ImprovementStep, id: string) => `dlv.f.${step}.${id}` as MessageKey;
export const fieldHintKey = (step: ImprovementStep, id: string) => `dlv.f.${step}.${id}.hint` as MessageKey;
export const todoKey = (id: string) => `dlv.todo.${id}` as MessageKey;
export const todoWhyKey = (id: string) => `dlv.todo.${id}.why` as MessageKey;
export const resultKey = (code: string) => `dlv.r.${code}` as MessageKey;
export const inputKey = (id: string) => `dlv.input.${id}` as MessageKey;

/** Issues → their KPI entities (pack). */
const issueKpis = (c: CheckContext, issue: EntityOf<'issue'>) => issue.kpiIds.map((id) => c.pack.byId.get(id)).filter((e): e is EntityOf<'kpi'> => e?.kind === 'kpi');

/** The payback hurdle in force for the project (its own criterion, else the default). */
export const paybackLimit = (d: DeliverableData): number => d.criteria?.paybackMaxYears?.value ?? PAYBACK_MAX_YEARS;

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Payback counted from the start of the solution's first initiative: the benefit is assumed to begin only when its
 * last initiative ends (conservative), so the build period is added to investment ÷ annual benefit.
 */
export function paybackYears(s: EntityOf<'solution'>, inits: EntityOf<'initiative'>[]): number {
  const own = inits.filter((i) => i.solutionId === s.id);
  const build = own.length ? Math.max(0, (Math.max(...own.map((i) => dayMs(i.end))) - Math.min(...own.map((i) => dayMs(i.start)))) / YEAR_MS) : 0;
  return build + (s.annualBenefitJpy > 0 ? s.costJpy / s.annualBenefitJpy : Infinity);
}

export function setPaybackLimit(data: DeliverableData, value: Criterion | null): DeliverableData {
  const criteria = { ...(data.criteria ?? {}) };
  if (value === null) delete criteria.paybackMaxYears;
  else criteria.paybackMaxYears = value;
  return { ...data, criteria };
}

/* ---------- Reconciliation: numbers written in text vs the KPI values ---------- */

/** Words right after "<n><unit>" that make the number a change, not a level ("5 日短縮", "3 days shorter"). */
const DELTA_AFTER = /^\s*(?:の)?(?:短縮|削減|改善|増|減|短く|長く|早く|遅く|早め|遅れ|短い|長い|shorter|longer|less|more|fewer|faster|slower|earlier|later|reduction|increase|decrease|improvement)/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Numbers stated with `unit` as a level (dates such as "3 月 31 日" and changes such as "5 日短縮" are skipped). */
export function statedValues(text: string, unit: string): number[] {
  const u = unit.trim();
  if (!u) return [];
  const re = new RegExp(`(-?\\d{1,3}(?:,\\d{3})+|-?\\d+(?:\\.\\d+)?)\\s*${escapeRe(u)}`, 'g');
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (/(?:月|\d\s*[/-])\s*$/.test(before)) continue;
    if (DELTA_AFTER.test(after)) continue;
    if (/^[A-Za-z]/.test(u) && /^[A-Za-z]/.test(after)) continue;
    out.push(Number(m[1]!.replace(/,/g, '')));
  }
  return out;
}

const sameValue = (n: number, v: number) => Math.abs(n - v) <= Math.max(1e-9, Math.abs(v) * 0.005) || Math.round(v) === n;

export interface ValueMismatch {
  /** Where the number is written. */
  where: { type: 'issue'; id: string } | { type: 'record'; id: string };
  label: Localizable;
  stated: number;
  unit: Localizable;
  kpis: { name: Localizable; baseline: number; current: number; target: number }[];
}

/**
 * Finds numbers in issue descriptions and discussion records that contradict every recorded value (baseline,
 * current, target) of the KPIs the text is about. The KPI is the record of truth: it has an owner, a source and a period.
 */
export function valueMismatches(c: CheckContext): { checked: number; mismatches: ValueMismatch[] } {
  const project = new Map(c.kpi.kpis.map((k) => [k.id, k]));
  const valuesOf = (k: EntityOf<'kpi'>) => {
    const p = project.get(k.id);
    return [k.baseline, k.current, k.target, ...(p ? [p.baseline, p.current, p.target] : [])].filter(Number.isFinite);
  };
  const kpisAbout = (ids: string[]): EntityOf<'kpi'>[] => {
    const out = new Map<string, EntityOf<'kpi'>>();
    for (const id of ids) {
      const e = c.pack.byId.get(id);
      if (e?.kind === 'kpi') out.set(e.id, e);
      if (e?.kind === 'issue') issueKpis(c, e).forEach((k) => out.set(k.id, k));
      if (e?.kind === 'solution') e.kpiIds.map((k) => c.pack.byId.get(k)).forEach((k) => { if (k?.kind === 'kpi') out.set(k.id, k); });
    }
    return [...out.values()];
  };
  let checked = 0;
  const mismatches: ValueMismatch[] = [];
  const scan = (where: ValueMismatch['where'], label: Localizable, text: Localizable, kpis: EntityOf<'kpi'>[]) => {
    const seen = new Set<string>();
    for (const lang of ['ja', 'en'] as const) {
      const body = typeof text === 'string' ? text : text[lang];
      const byUnit = new Map<string, EntityOf<'kpi'>[]>();
      kpis.forEach((k) => byUnit.set(k.unit[lang], [...(byUnit.get(k.unit[lang]) ?? []), k]));
      for (const [unit, group] of byUnit) {
        for (const n of statedValues(body, unit)) {
          const key = `${n}|${group.map((k) => k.id).join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          checked += 1;
          if (group.some((k) => valuesOf(k).some((v) => sameValue(n, v)))) continue;
          mismatches.push({ where, label, stated: n, unit: group[0]!.unit, kpis: group.map((k) => ({ name: k.name, baseline: k.baseline, current: k.current, target: k.target })) });
        }
      }
    }
  };
  for (const issue of kindOf(c.pack, 'issue')) scan({ type: 'issue', id: issue.id }, issue.name, issue.description, issueKpis(c, issue));
  const themes = new Map(c.discussion.themes.map((t) => [t.id, t]));
  for (const r of c.discussion.records) {
    const theme = themes.get(r.themeId);
    if (theme) scan({ type: 'record', id: r.id }, theme.title, r.text, kpisAbout(theme.relatedIds));
  }
  return { checked, mismatches };
}

const mismatchRef = (m: ValueMismatch): CheckRef => {
  const side = (lang: 'ja' | 'en') => {
    const txt = (v: Localizable) => (typeof v === 'string' ? v : v[lang]);
    const lbl = txt(m.label);
    const unit = txt(m.unit);
    const kpis = m.kpis.map((k) => (lang === 'ja'
      ? `${txt(k.name)}（基準 ${k.baseline}・現状 ${k.current}・目標 ${k.target}）`
      : `${txt(k.name)} (baseline ${k.baseline}, current ${k.current}, target ${k.target})`)).join(lang === 'ja' ? '、' : '; ');
    return lang === 'ja' ? `${lbl}: 「${m.stated} ${unit}」が ${kpis} と合いません` : `${lbl}: "${m.stated} ${unit}" does not match ${kpis}`;
  };
  return { type: 'text', text: { ja: side('ja'), en: side('en') } };
};

/** Initiatives whose dependency chain loops back on itself. */
export function cyclicInitiatives(inits: EntityOf<'initiative'>[]): string[] {
  const byId = new Map(inits.map((i) => [i.id, i]));
  const state = new Map<string, 1 | 2>();
  const bad = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      path.slice(path.indexOf(id)).forEach((p) => bad.add(p));
      return;
    }
    state.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) visit(d, [...path, id]);
    state.set(id, 2);
  };
  inits.forEach((i) => visit(i.id, []));
  return [...bad];
}

export const STEP_DEFS: Record<ImprovementStep, StepDef> = {
  define: {
    step: 'define',
    inputs: ['issues', 'causes', 'sources', 'discussion'],
    fields: DEFINE_FIELDS,
    todos: [
      {
        id: 'define-sources', kind: 'auto', href: '/relations',
        check: (c) => {
          const issues = kindOf(c.pack, 'issue');
          if (issues.length === 0) return fail('noIssues');
          const bad = issues.filter((i) => !i.sourceIds.some((s) => c.pack.byId.get(s)?.kind === 'source'));
          return bad.length ? fail('issuesWithoutSource', entityRefs(bad), { n: bad.length }) : pass('allIssuesSourced', { n: issues.length });
        },
      },
      {
        id: 'define-causes', kind: 'auto', href: '/relations',
        check: (c) => {
          const issues = kindOf(c.pack, 'issue');
          if (issues.length === 0) return fail('noIssues');
          const bad = issues.filter((i) => !i.causeIds.some((id) => c.pack.byId.get(id)?.kind === 'cause'));
          return bad.length ? fail('issuesWithoutCause', entityRefs(bad), { n: bad.length }) : pass('allIssuesCaused', { n: issues.length });
        },
      },
      {
        id: 'define-kpi-link', kind: 'auto', href: '/relations',
        check: (c) => {
          const issues = kindOf(c.pack, 'issue');
          if (issues.length === 0) return fail('noIssues');
          const bad = issues.filter((i) => issueKpis(c, i).length === 0);
          return bad.length ? fail('issuesWithoutKpi', entityRefs(bad), { n: bad.length }) : pass('allIssuesMeasured', { n: issues.length });
        },
      },
      {
        id: 'define-decision', kind: 'auto', href: '/discussion',
        check: (c) => {
          const themes = c.discussion.themes.length;
          const decisions = c.discussion.records.filter((r) => r.kind === 'decision').length;
          if (themes === 0) return fail('noThemes');
          return decisions > 0 ? pass('decisionsRecorded', { themes, decisions }) : fail('noDecision', [], { themes });
        },
      },
      { id: 'define-doc', kind: 'auto', href: docHref('define'), check: docCheck('define', DEFINE_FIELDS) },
      { id: 'define-agree', kind: 'manual', href: docHref('define') },
    ],
  },
  asis: {
    step: 'asis',
    inputs: ['analyses', 'causes', 'kpis', 'flows'],
    fields: ASIS_FIELDS,
    todos: [
      {
        id: 'asis-framework', kind: 'auto', href: '/analysis',
        check: (c) => {
          if (c.analysis.analyses.length === 0) return fail('noAnalysis');
          const full = c.analysis.analyses.filter((a) => categoriesOf(a.method).every((cat) => a.items.some((i) => i.category === cat && textOf(i.text).some((s) => s.trim() !== ''))));
          return full.length ? pass('analysisComplete', { n: full.length }) : fail('analysisIncomplete', c.analysis.analyses.map((a) => ({ type: 'text' as const, text: a.title })));
        },
      },
      {
        id: 'asis-cause-evidence', kind: 'auto', href: '/relations',
        check: (c) => {
          const ids = new Set(kindOf(c.pack, 'issue').flatMap((i) => i.causeIds));
          const causes = kindOf(c.pack, 'cause').filter((x) => ids.has(x.id));
          if (causes.length === 0) return fail('noCauses');
          const bad = causes.filter((x) => !x.sourceIds.some((s) => c.pack.byId.get(s)?.kind === 'source'));
          return bad.length ? fail('causesWithoutSource', entityRefs(bad), { n: bad.length }) : pass('allCausesSourced', { n: causes.length });
        },
      },
      {
        id: 'asis-baseline', kind: 'auto', href: '/analysis?tab=kpi',
        check: (c) => {
          const kpis = [...new Map(kindOf(c.pack, 'issue').flatMap((i) => issueKpis(c, i)).map((k) => [k.id, k])).values()];
          if (kpis.length === 0) return fail('noKpis');
          const bad = kpis.filter((k) => !Number.isFinite(k.baseline) || !Number.isFinite(k.current) || !k.period.ja.trim() || !k.period.en.trim());
          return bad.length ? fail('kpisWithoutBaseline', entityRefs(bad), { n: bad.length }) : pass('baselinesMeasured', { n: kpis.length });
        },
      },
      {
        id: 'asis-reconcile', kind: 'auto', href: '/discussion',
        check: (c) => {
          const { checked, mismatches } = valueMismatches(c);
          if (mismatches.length) {
            const refs: CheckRef[] = mismatches.flatMap((m) => (m.where.type === 'issue' ? [{ type: 'entity' as const, id: m.where.id }, mismatchRef(m)] : [mismatchRef(m)]));
            return fail('valuesMismatch', refs, { n: mismatches.length });
          }
          return pass(checked ? 'valuesReconciled' : 'noStatedValues', { n: checked });
        },
      },
      { id: 'asis-doc', kind: 'auto', href: docHref('asis'), check: docCheck('asis', ASIS_FIELDS) },
      { id: 'asis-field', kind: 'manual', href: docHref('asis') },
    ],
  },
  kpi: {
    step: 'kpi',
    inputs: ['kpis', 'projectKpis', 'okrs'],
    fields: KPI_FIELDS,
    todos: [
      {
        id: 'kpi-valid', kind: 'auto', href: '/analysis?tab=kpi',
        check: (c) => {
          const kpis = c.kpi.kpis;
          if (kpis.length === 0) return fail('noProjectKpis');
          const str = (v: Localizable) => (typeof v === 'string' ? v : v.ja || v.en);
          const bad = kpis.filter((k) => validateKpi({ name: str(k.name), unit: str(k.unit), baseline: String(k.baseline), current: String(k.current), target: String(k.target), deadline: k.deadline }).length > 0 || k.target === k.baseline);
          return bad.length ? fail('kpisInvalid', bad.map((k) => ({ type: 'text' as const, text: k.name })), { n: bad.length }) : pass('kpisValid', { n: kpis.length });
        },
      },
      {
        id: 'kpi-deadline', kind: 'auto', href: '/analysis?tab=kpi',
        check: (c) => {
          if (c.kpi.kpis.length === 0) return fail('noProjectKpis');
          const bad = c.kpi.kpis.filter((k) => !(k.deadline >= c.today));
          return bad.length ? fail('kpisPastDeadline', bad.map((k) => ({ type: 'text' as const, text: k.name })), { n: bad.length, today: c.today }) : pass('deadlinesAhead', { today: c.today });
        },
      },
      {
        id: 'kpi-direction', kind: 'auto', href: '/analysis?tab=kpi',
        check: (c) => {
          const kpis = kindOf(c.pack, 'kpi');
          if (kpis.length === 0) return fail('noKpis');
          const bad = kpis.filter((k) => {
            const v = chooseKpiVisual(k);
            return v.kind === 'bullet' && (v.reason === 'inconsistentTarget' || v.reason === 'noGap');
          });
          return bad.length ? fail('kpiTargetWrongWay', entityRefs(bad), { n: bad.length }) : pass('kpiTargetsConsistent', { n: kpis.length });
        },
      },
      {
        id: 'kpi-coverage', kind: 'auto', href: '/analysis?tab=kpi',
        check: (c) => {
          const issues = kindOf(c.pack, 'issue');
          if (issues.length === 0) return fail('noIssues');
          const bad = issues.filter((i) => !issueKpis(c, i).some((k) => projectHasKpi(c.kpi.kpis, k)));
          return bad.length ? fail('issuesNotMeasured', entityRefs(bad), { n: bad.length }) : pass('allIssuesTracked', { n: issues.length });
        },
      },
      {
        id: 'kpi-okr', kind: 'auto', href: '/analysis?tab=kpi',
        check: (c) => {
          if (c.kpi.okrs.length === 0) return fail('noOkr');
          const ids = new Set(c.kpi.kpis.map((k) => k.id));
          const bad = c.kpi.okrs.filter((o) => o.keyResults.some((kr) => !ids.has(kr.kpiId)));
          return bad.length ? fail('okrDangling', bad.map((o) => ({ type: 'text' as const, text: o.objective })), { n: bad.length }) : pass('okrLinked', { n: c.kpi.okrs.length });
        },
      },
      { id: 'kpi-doc', kind: 'auto', href: docHref('kpi'), check: docCheck('kpi', KPI_FIELDS) },
      { id: 'kpi-measure', kind: 'manual', href: docHref('kpi') },
    ],
  },
  usecase: {
    step: 'usecase',
    inputs: ['useCases', 'solutions', 'personas'],
    fields: USECASE_FIELDS,
    todos: [
      {
        id: 'uc-registered', kind: 'auto', href: '/usecases',
        check: (c) => {
          const n = c.useCases.filter((u) => u.origin === 'registered').length;
          return n > 0 ? pass('useCasesRegistered', { n }) : fail('noUseCases');
        },
      },
      {
        id: 'uc-complete', kind: 'auto', href: '/usecases',
        check: (c) => {
          const ucs = c.useCases.filter((u) => u.origin === 'registered');
          if (ucs.length === 0) return fail('noUseCases');
          const bad = ucs.filter((u) => u.steps.length < 3 || !u.effect || textOf(u.effect).every((s) => !s.trim()));
          return bad.length ? fail('useCasesThin', bad.map((u) => ({ type: 'text' as const, text: u.name })), { n: bad.length }) : pass('useCasesComplete', { n: ucs.length });
        },
      },
      {
        id: 'uc-trace', kind: 'auto', href: '/usecases',
        check: (c) => {
          const ucs = c.useCases.filter((u) => u.origin === 'registered');
          if (ucs.length === 0) return fail('noUseCases');
          const projectKpis = new Set(c.kpi.kpis.map((k) => k.id));
          const linked = (id: string) => projectKpis.has(id) || ['issue', 'kpi', 'solution'].includes(c.pack.byId.get(id)?.kind ?? '');
          const bad = ucs.filter((u) => !u.relatedIds.some(linked));
          return bad.length ? fail('useCasesUnlinked', bad.map((u) => ({ type: 'text' as const, text: u.name })), { n: bad.length }) : pass('useCasesLinked', { n: ucs.length });
        },
      },
      {
        id: 'uc-top-issue', kind: 'auto', href: '/usecases',
        check: (c) => {
          const top = rankedIssues(c.pack)[0];
          if (!top) return fail('noIssues');
          const solutions = kindOf(c.pack, 'solution').filter((s) => s.issueIds.includes(top.id)).map((s) => s.id);
          const covered = c.useCases.some((u) => u.origin === 'registered' && u.relatedIds.some((id) => id === top.id || solutions.includes(id)));
          return covered ? pass('topIssueCovered', { issue: top.id }) : fail('topIssueUncovered', [{ type: 'entity', id: top.id }]);
        },
      },
      { id: 'uc-doc', kind: 'auto', href: docHref('usecase'), check: docCheck('usecase', USECASE_FIELDS) },
      { id: 'uc-review', kind: 'manual', href: docHref('usecase') },
    ],
  },
  plan: {
    step: 'plan',
    inputs: ['initiatives', 'solutions', 'people', 'discussion'],
    fields: PLAN_FIELDS,
    todos: [
      {
        id: 'plan-coverage', kind: 'auto', href: '/plan',
        check: (c) => {
          const solutions = kindOf(c.pack, 'solution');
          if (solutions.length === 0) return fail('noSolutions');
          const inits = kindOf(c.pack, 'initiative');
          const bad = solutions.filter((s) => !inits.some((i) => i.solutionId === s.id));
          return bad.length ? fail('solutionsWithoutInitiative', entityRefs(bad), { n: bad.length }) : pass('allSolutionsPlanned', { n: solutions.length });
        },
      },
      {
        id: 'plan-schedule', kind: 'auto', href: '/plan',
        check: (c) => {
          const inits = kindOf(c.pack, 'initiative');
          if (inits.length === 0) return fail('noInitiatives');
          const byId = new Map(inits.map((i) => [i.id, i]));
          const cyclic = new Set(cyclicInitiatives(inits));
          const bad = inits.filter((i) => i.start > i.end || cyclic.has(i.id) || i.dependsOn.some((d) => {
            const dep = byId.get(d);
            return !dep || dep.end >= i.start;
          }));
          return bad.length ? fail('scheduleConflicts', entityRefs(bad), { n: bad.length }) : pass('scheduleConsistent', { n: inits.length });
        },
      },
      {
        id: 'plan-owner', kind: 'auto', href: '/plan',
        check: (c) => {
          const inits = kindOf(c.pack, 'initiative');
          if (inits.length === 0) return fail('noInitiatives');
          const bad = inits.filter((i) => c.pack.byId.get(i.ownerId)?.kind !== 'person');
          return bad.length ? fail('initiativesWithoutOwner', entityRefs(bad), { n: bad.length }) : pass('allInitiativesOwned', { n: inits.length });
        },
      },
      {
        id: 'plan-payback', kind: 'auto', href: '/plan',
        check: (c) => {
          const solutions = kindOf(c.pack, 'solution');
          if (solutions.length === 0) return fail('noSolutions');
          const inits = kindOf(c.pack, 'initiative');
          const max = paybackLimit(c.deliverables);
          const years = solutions.map((s) => paybackYears(s, inits));
          const bad = solutions.filter((_, i) => years[i]! > max);
          const worst = Math.max(...years);
          const shown = Number.isFinite(worst) ? worst.toFixed(1) : '∞';
          return bad.length ? fail('paybackTooLong', entityRefs(bad), { n: bad.length, max, worst: shown }) : pass('paybackOk', { n: solutions.length, max, worst: shown });
        },
      },
      {
        id: 'plan-decision', kind: 'auto', href: '/discussion',
        check: (c) => {
          const planIds = new Set([...kindOf(c.pack, 'solution'), ...kindOf(c.pack, 'initiative')].map((e) => e.id));
          const themes = new Set(c.discussion.themes.filter((t) => t.relatedIds.some((id) => planIds.has(id))).map((t) => t.id));
          const n = c.discussion.records.filter((r) => r.kind === 'decision' && themes.has(r.themeId)).length;
          return n > 0 ? pass('planDecided', { n }) : fail('noPlanDecision');
        },
      },
      { id: 'plan-doc', kind: 'auto', href: docHref('plan'), check: docCheck('plan', PLAN_FIELDS) },
      { id: 'plan-approve', kind: 'manual', href: docHref('plan') },
    ],
  },
};

/* ---------- Evaluation ---------- */

export interface TodoResult {
  todo: TodoDef;
  done: boolean;
  /** Auto checks: the verdict and its evidence. Manual: undefined. */
  outcome?: CheckOutcome;
  signOff?: SignOff;
}

export function evaluateStep(step: ImprovementStep, c: CheckContext): TodoResult[] {
  return STEP_DEFS[step].todos.map((todo) => {
    if (todo.kind === 'manual') {
      const signOff = c.deliverables.signOffs[todo.id];
      return signOff ? { todo, done: true, signOff } : { todo, done: false };
    }
    const outcome = todo.check!(c);
    return { todo, done: outcome.ok, outcome };
  });
}

export function progressOf(results: TodoResult[]): { done: number; total: number; complete: boolean } {
  const done = results.filter((r) => r.done).length;
  return { done, total: results.length, complete: results.length > 0 && done === results.length };
}

/** Set (or clear) one field; the author becomes `human` when a person edits (A-71). */
export function setField(data: DeliverableData, step: ImprovementStep, id: string, value: FieldValue | null): DeliverableData {
  const doc = { ...(data.docs[step] ?? {}) };
  if (value === null) delete doc[id];
  else doc[id] = value;
  return { ...data, docs: { ...data.docs, [step]: doc } };
}

export function setSignOff(data: DeliverableData, todoId: string, signOff: SignOff | null): DeliverableData {
  const signOffs = { ...data.signOffs };
  if (signOff === null) delete signOffs[todoId];
  else signOffs[todoId] = signOff;
  return { ...data, signOffs };
}

/** Apply a draft: by default only empty fields are filled, so nothing the user wrote is lost. */
export function applyDraft(data: DeliverableData, step: ImprovementStep, draft: Record<string, string>, opts: { overwrite: boolean; mock: boolean; at: string }): { data: DeliverableData; applied: string[] } {
  const known = new Set(STEP_DEFS[step].fields.map((f) => f.id));
  const applied: string[] = [];
  let next = data;
  for (const [id, text] of Object.entries(draft)) {
    if (!known.has(id) || !text.trim()) continue;
    const current = next.docs[step]?.[id]?.text.trim();
    if (current && !opts.overwrite) continue;
    next = setField(next, step, id, { text: text.trim(), author: 'ai', ...(opts.mock ? { mock: true } : {}), updatedAt: opts.at });
    applied.push(id);
  }
  return { data: next, applied };
}
