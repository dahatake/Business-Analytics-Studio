import { z } from 'zod';
import type { LoadedPack } from '../../data/pack.ts';
import { solutionMoney, type Entity, type EntityOf } from '../../data/schema.ts';
import { chooseKpiVisual } from '../../domain/kpi.ts';
import { rankIssues } from '../../domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../../domain/summary.ts';
import type { MessageKey } from '../../i18n/core.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import type { Localizable } from '../../state/text.ts';
import type { UseCase } from '../usecases/store.ts';
import type { CatalogItem } from '../usecases/catalogSchema.ts';
import { categoriesOf } from './analysis.ts';
import { validateKpi, kpiBasis, kpiDefinitionState, needsReview } from './kpiOkr.ts';
import type { AnalysisData, DiscussionData, KpiData, KpiDef } from './model.ts';
import { checkAnyLanguage } from './requirementQuality.ts';
import { buildSolutionDoc } from './solutionDocs.ts';
import { emptyStrategy, strategyThread, type CompanyObjective, type StrategyData, type StrategyThread } from './strategy.ts';

/**
 * Deliverables of the five improvement steps (FR-136 / PARAM-030): what each step must have finished (exit criteria)
 * and what the project adds on top of the Project pack and the existing project data (the deliverable's fields).
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
  /** A person approved the AI suggestion as it was (FR-338); `mock` tells whether it was the mock text. Editing drops it. */
  approved: z.object({ at: z.string(), by: z.string(), mock: z.boolean() }).optional(),
});
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const SignOffSchema = z.object({ at: z.string(), by: z.string() });
export type SignOff = z.infer<typeof SignOffSchema>;

/** One output item of a step as it was when the step was confirmed: its content hash detects later changes. */
export const HandoffItemSchema = z.object({ id: z.string(), kind: z.string(), label: z.string(), hash: z.string() });
export type HandoffItem = z.infer<typeof HandoffItemSchema>;
/** A confirmed step: who confirmed it, the items it hands to the next step and the upstream items it was built on. */
export const HandoffSchema = z.object({ at: z.string(), by: z.string(), items: z.array(HandoffItemSchema), upstream: z.string() });
export type Handoff = z.infer<typeof HandoffSchema>;

/** A judging criterion the project decided itself, with who set it and when. */
export const CriterionSchema = z.object({ value: z.number().min(PAYBACK_LIMIT_RANGE.min).max(PAYBACK_LIMIT_RANGE.max), at: z.string(), by: z.string() });
export type Criterion = z.infer<typeof CriterionSchema>;

/**
 * FR-347: qualifying an issue (Khalsa & Illig, "Let's Get Real or Let's Not Play": "Should they do it?"). Until a
 * person turns the yellow light green (pursue) or red (not now / no), the app does not assume the issue must be
 * solved. A "no" is a result too: it needs the same evidence as a "yes" and ends the issue's path at the As-Is.
 */
export const QUALIFY_VERDICTS = ['pursue', 'notNow', 'no'] as const;
export type QualifyVerdict = (typeof QUALIFY_VERDICTS)[number];
export const QualificationSchema = z.object({
  verdict: z.enum(QUALIFY_VERDICTS),
  /** The evidence and impact the verdict rests on (how it is measured, now, wanted, what the difference is worth). */
  reason: z.string().trim().min(1),
  /** Pursue only: what stopped it being solved before and what is different this time. */
  different: z.string().trim().min(1).optional(),
  at: z.string(),
  by: z.string(),
}).refine((q) => q.verdict !== 'pursue' || q.different !== undefined, { path: ['different'] });
export type Qualification = z.infer<typeof QualificationSchema>;

/**
 * FR-365: a person's estimate of the two Cost of Delay inputs for one issue: value lost per month while it stays unsolved (yen)
 * and months left until it is solved. Each is a low / most likely / high range; a person's estimate overrides the pack's.
 */
const EstimateRangeSchema = z.object({ low: z.number().positive(), mode: z.number().positive(), high: z.number().positive() })
  .refine((r) => r.low <= r.mode && r.mode <= r.high);
export const DelayEstimateSchema = z.object({
  valuePerMonthJpy: EstimateRangeSchema.optional(),
  durationMonths: EstimateRangeSchema.optional(),
  /** How the numbers were reached (who said it, which document). */
  note: z.string().trim().min(1),
  at: z.string(),
  by: z.string(),
}).refine((e) => e.valuePerMonthJpy !== undefined || e.durationMonths !== undefined);
export type DelayEstimate = z.infer<typeof DelayEstimateSchema>;

/**
 * Missing-data fill: a value Copilot (or a person) put into a field that the Project pack left empty, with its label.
 * - evidence: a cited source states the value (verified locally: the quote is in the source and states the value)
 * - estimate: Copilot's estimate; it counts toward the exit criteria only after a person approves it
 * - unacquired: no value could be given; the note says where to get it
 * - human: a person typed the value while reviewing
 */
export const FILL_FIELDS = ['costJpy', 'annualBenefitJpy', 'ownerRole', 'unitPriceJpy', 'siteId', 'capacityTPerMonth', 'lat', 'lon'] as const;
export type FillField = (typeof FILL_FIELDS)[number];
/** The form of a filled value: yen, tonnes per month, degrees, a role text or the id of a site. */
export type FillValueType = 'yen' | 'tonnes' | 'lat' | 'lon' | 'role' | 'site';
export const FILL_VALUE_TYPE: Record<FillField, FillValueType> = {
  costJpy: 'yen', annualBenefitJpy: 'yen', unitPriceJpy: 'yen', ownerRole: 'role', siteId: 'site', capacityTPerMonth: 'tonnes', lat: 'lat', lon: 'lon',
};
/** Which entity kinds each field is filled for (a person's site is never sent to Copilot, so it is not filled). */
export const FILL_TARGETS: Record<FillField, readonly Entity['kind'][]> = {
  costJpy: ['solution'], annualBenefitJpy: ['solution'], ownerRole: ['kpi', 'initiative'], unitPriceJpy: ['product'], siteId: ['product'],
  capacityTPerMonth: ['site'], lat: ['site'], lon: ['site'],
};
/** Upper bounds: a larger yen amount or capacity is treated as unusable. */
export const FILL_MAX_YEN = 1e15;
export const FILL_MAX_TONNES = 1e9;
/** Whether a value has the form its field needs (references are checked against the pack separately). */
export function validFillValue(field: FillField, value: unknown): boolean {
  const type = FILL_VALUE_TYPE[field];
  if (type === 'role') {
    const v = value as { ja?: unknown; en?: unknown } | null;
    return typeof v === 'object' && v !== null && typeof v.ja === 'string' && typeof v.en === 'string' && !!v.ja.trim() && !!v.en.trim();
  }
  if (type === 'site') return typeof value === 'string' && value.trim().length > 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (type === 'yen') return value > 0 && value <= FILL_MAX_YEN;
  if (type === 'tonnes') return value > 0 && value <= FILL_MAX_TONNES;
  return type === 'lat' ? value >= -90 && value <= 90 : value >= -180 && value <= 180;
}
export const FILL_BASES = ['evidence', 'estimate', 'unacquired', 'human'] as const;
export type FillBasis = (typeof FILL_BASES)[number];
export const FILL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type FillStatus = (typeof FILL_STATUSES)[number];
const FillText = z.object({ ja: z.string().min(1), en: z.string().min(1) });
export const FillRecordSchema = z.object({
  entityId: z.string().min(1),
  field: z.enum(FILL_FIELDS),
  basis: z.enum(FILL_BASES),
  /** The value written into the pack. Absent only for `unacquired`. */
  value: z.union([z.number(), FillText, z.string().min(1)]).optional(),
  /** How the value was derived, or where to obtain it. */
  note: FillText,
  /** Evidence only: the exact text of the cited source that states the value. */
  quote: z.string().optional(),
  sourceIds: z.array(z.string()),
  status: z.enum(FILL_STATUSES),
  at: z.string(),
  reviewed: z.object({ at: z.string(), by: z.string() }).optional(),
}).refine((r) => (r.basis === 'unacquired') === (r.value === undefined), { path: ['value'] })
  .refine((r) => r.value === undefined || validFillValue(r.field, r.value), { path: ['value'] });
export type FillRecord = z.infer<typeof FillRecordSchema>;
export const fillKey = (entityId: string, field: FillField) => `${entityId}:${field}`;

export const DeliverableDataSchema = z.object({
  /** step → field id → value. */
  docs: z.record(z.string(), z.record(z.string(), FieldValueSchema)),
  /** manual todo id → sign-off. Absent = not signed off. */
  signOffs: z.record(z.string(), SignOffSchema),
  recommendations: z.record(z.string(), z.object({
    draft: z.object({ text: z.string(), mock: z.boolean(), at: z.string() }).optional(),
    approved: z.object({ text: z.string(), mock: z.boolean(), at: z.string(), by: z.string() }).optional(),
  })).optional(),
  /** Project-specific judging criteria. Absent = the app's defaults. A broken value falls back to the default. */
  criteria: z.object({ paybackMaxYears: CriterionSchema.optional().catch(undefined) }).optional().catch(undefined),
  /** step → the person's confirmation that the step is finished and its items go to the next step (handoff.ts). */
  handoffs: z.record(z.string(), HandoffSchema).optional().catch(undefined),
  /** FR-347: issue id → the person's verdict on whether the issue is worth solving now. Absent = not qualified yet. A broken entry is dropped alone. */
  qualifications: z.record(z.string(), z.unknown())
    .transform((r): Record<string, Qualification> => Object.fromEntries(Object.entries(r).flatMap(([id, v]) => {
      const q = QualificationSchema.safeParse(v);
      return q.success ? [[id, q.data]] : [];
    })))
    .optional().catch(undefined),
  /** FR-365: issue id → a person's Cost of Delay estimate. A broken entry is dropped alone. */
  delayEstimates: z.record(z.string(), z.unknown())
    .transform((r): Record<string, DelayEstimate> => Object.fromEntries(Object.entries(r).flatMap(([id, v]) => {
      const e = DelayEstimateSchema.safeParse(v);
      return e.success ? [[id, e.data]] : [];
    })))
    .optional().catch(undefined),
  /** `entityId:field` → how a missing pack value was filled and whether a person reviewed it. A broken entry is dropped alone. */
  fills: z.record(z.string(), z.unknown())
    .transform((r): Record<string, FillRecord> => Object.fromEntries(Object.entries(r).flatMap(([key, v]) => {
      const f = FillRecordSchema.safeParse(v);
      return f.success && key === fillKey(f.data.entityId, f.data.field) ? [[key, f.data]] : [];
    })))
    .optional().catch(undefined),
});
export type DeliverableData = z.infer<typeof DeliverableDataSchema>;

const sameFillValue = (a: FillRecord['value'], b: unknown) =>
  typeof a === 'number' || typeof a === 'string' ? a === b : !!a && typeof b === 'object' && b !== null && (b as { ja?: unknown }).ja === a.ja && (b as { en?: unknown }).en === a.en;

/**
 * The fill label that still describes the entity's current value: a value later changed elsewhere is no longer the filled one.
 * An `unacquired` record applies while the field is still empty.
 */
export function activeFill(data: DeliverableData, entity: Entity, field: FillField): FillRecord | undefined {
  const r = data.fills?.[fillKey(entity.id, field)];
  if (!r || r.status === 'rejected') return undefined;
  const current = (entity as Partial<Record<FillField, unknown>>)[field];
  return r.value === undefined ? (current === undefined ? r : undefined) : sameFillValue(r.value, current) ? r : undefined;
}

/** A Copilot estimate no person has approved yet: shown and used, but not counted as a finished exit criterion. */
export const unreviewedEstimate = (data: DeliverableData, entity: Entity, field: FillField) => {
  const r = activeFill(data, entity, field);
  return r?.basis === 'estimate' && r.status === 'pending';
};

export const emptyDeliverables = (): DeliverableData => ({ docs: {}, signOffs: {} });

/** Stored values are read back defensively: a broken value never breaks the screen. */
const normalized = new WeakMap<object, DeliverableData>();

/** Validated and migrated deliverables; the same stored value is validated once (each keystroke used to parse it twice). */
export function normalizeDeliverables(raw: unknown): DeliverableData {
  if (typeof raw !== 'object' || raw === null) return parseDeliverables(raw);
  let found = normalized.get(raw);
  if (!found) normalized.set(raw, (found = parseDeliverables(raw)));
  return found;
}

function parseDeliverables(raw: unknown): DeliverableData {
  const r = DeliverableDataSchema.safeParse(raw);
  return r.success ? migrateDocs(r.data) : emptyDeliverables();
}

/** Where each field of the old steps (define / usecase / plan) lives now. */
const LEGACY_FIELDS: Record<string, Record<string, ImprovementStep>> = {
  define: { problem: 'asis', impact: 'asis', scopeIn: 'asis', scopeOut: 'asis', sponsor: 'asis', hypotheses: 'tobe', success: 'tobe' },
  usecase: { actors: 'solution', scenario: 'solution', acceptance: 'solution', dataNeeds: 'solution', risks: 'solution' },
  plan: { roadmap: 'deliverable', businessCase: 'deliverable', raci: 'deliverable', risks: 'deliverable', ask: 'deliverable' },
};

/** Moves fields written under the old step ids to the new steps; a field already written in the new step wins. */
export function migrateDocs(data: DeliverableData): DeliverableData {
  if (!Object.keys(LEGACY_FIELDS).some((s) => data.docs[s])) return data;
  const docs: DeliverableData['docs'] = {};
  for (const [step, fields] of Object.entries(data.docs)) if (!LEGACY_FIELDS[step]) docs[step] = { ...fields };
  for (const [old, map] of Object.entries(LEGACY_FIELDS)) {
    for (const [id, value] of Object.entries(data.docs[old] ?? {})) {
      const to = map[id];
      if (!to) continue;
      docs[to] = { ...(docs[to] ?? {}) };
      if (!docs[to][id]) docs[to][id] = value;
    }
  }
  return { ...data, docs };
}

/* ---------- Definitions ---------- */

export interface FieldDef {
  id: string;
  /** Must contain a number (a measurable statement), e.g. "16 → 10 days". */
  quantified?: boolean;
  /** Must also contain a date or period (SMART: time-bound). */
  timeBound?: boolean;
  /** Must be verifiable: wording such as "easy to use" needs a measurable bound (ISO/IEC/IEEE 29148). */
  specific?: boolean;
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
  /** Project strategy data (solution types, contributions, deliverable sections). Absent = empty. */
  strategy?: StrategyData;
  /** Company-anchor objectives of the project's company. Absent = none registered. */
  objectives?: CompanyObjective[];
  /** Company objectives the project is aligned to (Project.alignments). */
  projectObjectiveIds?: string[];
  /** The data dictionary imported for this project (the pack's own dictionary is used when absent). */
  catalog?: CatalogItem[];
}

/** The context the app builds: every strategy field resolved. */
export type AppCheckContext = CheckContext & Required<Pick<CheckContext, 'strategy' | 'objectives' | 'projectObjectiveIds'>>;

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

/** True when the field's text fails its own rule: no number, no date, or wording that cannot be verified. */
export function fieldIsVague(f: FieldDef, text: string): boolean {
  return (!!f.quantified && !hasNumber(text)) || (!!f.timeBound && !hasDate(text)) || (!!f.specific && checkAnyLanguage(text).some((i) => i.code === 'vague'));
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
      } else if (fieldIsVague(f, text)) {
        vague += 1;
        refs.push({ type: 'field', step, id: f.id });
      }
    }
    if (empty === 0 && vague === 0) return pass('docComplete', { n: fields.length });
    return fail(empty > 0 ? 'docMissing' : 'docVague', refs, { empty, vague });
  };
}

/* ---------- The five steps ---------- */

const ASIS_FIELDS: FieldDef[] = [
  { id: 'problem', quantified: true },
  { id: 'impact', quantified: true },
  { id: 'scopeIn' },
  { id: 'scopeOut' },
  { id: 'sponsor' },
  { id: 'currentProcess' },
  { id: 'evidence', quantified: true },
  { id: 'rootCause' },
  { id: 'dataGaps' },
  { id: 'constraints' },
];

/** The to-be picture: where the company wants to be, by when, and the measured gap from today. */
const TOBE_FIELDS: FieldDef[] = [
  { id: 'vision', timeBound: true },
  { id: 'toBeProcess' },
  { id: 'gap', quantified: true },
  { id: 'hypotheses' },
  { id: 'success', quantified: true, timeBound: true, specific: true },
];

const KPI_FIELDS: FieldDef[] = [
  { id: 'kpiTree' },
  { id: 'formula' },
  { id: 'dataSource' },
  { id: 'frequency' },
  { id: 'owner' },
];

const SOLUTION_FIELDS: FieldDef[] = [
  { id: 'options' },
  { id: 'actors' },
  { id: 'scenario' },
  { id: 'acceptance', quantified: true, specific: true },
  { id: 'dataNeeds' },
  { id: 'risks' },
];

const DELIVERABLE_FIELDS: FieldDef[] = [
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
export function paybackYears(s: EntityOf<'solution'>, inits: EntityOf<'initiative'>[]): number | null {
  const m = solutionMoney(s);
  if (!m) return null;
  return buildYears(s.id, inits) + (m.benefit > 0 ? m.cost / m.benefit : Infinity);
}

/** Years from the start of the solution's first initiative to the end of its last (0 without initiatives). */
export function buildYears(solutionId: string, inits: EntityOf<'initiative'>[]): number {
  const own = inits.filter((i) => i.solutionId === solutionId);
  return own.length ? Math.max(0, (Math.max(...own.map((i) => dayMs(i.end))) - Math.min(...own.map((i) => dayMs(i.start)))) / YEAR_MS) : 0;
}

export function setPaybackLimit(data: DeliverableData, value: Criterion | null): DeliverableData {
  const criteria = { ...(data.criteria ?? {}) };
  if (value === null) delete criteria.paybackMaxYears;
  else criteria.paybackMaxYears = value;
  return { ...data, criteria };
}

/* ---------- Qualification (FR-347) ---------- */

export const qualificationOf = (d: DeliverableData, issueId: string): Qualification | undefined => d.qualifications?.[issueId];

/** The person decided not to solve the issue now ("not now" or "no"): it leaves the path to a solution. */
export function isQualifiedOut(d: DeliverableData, issueId: string): boolean {
  const v = qualificationOf(d, issueId)?.verdict;
  return v === 'notNow' || v === 'no';
}

/** Record (or clear) a verdict. Invalid input (an empty reason, a pursue without "what is different") throws. */
export function setQualification(data: DeliverableData, issueId: string, value: Qualification | null): DeliverableData {
  const qualifications = { ...(data.qualifications ?? {}) };
  if (value === null) delete qualifications[issueId];
  else qualifications[issueId] = QualificationSchema.parse(value);
  return { ...data, qualifications };
}

/** FR-365: store (or with null remove) a person's Cost of Delay estimate for one issue. */
export function setDelayEstimate(data: DeliverableData, issueId: string, value: DelayEstimate | null): DeliverableData {
  const delayEstimates = { ...(data.delayEstimates ?? {}) };
  if (value === null) delete delayEstimates[issueId];
  else delayEstimates[issueId] = DelayEstimateSchema.parse(value);
  return { ...data, delayEstimates };
}

/** Issues still on the path to a solution, in priority order: every issue except those qualified out. */
export const pursuedIssues = (c: Pick<CheckContext, 'pack' | 'deliverables'>) => rankedIssues(c.pack).filter((i) => !isQualifiedOut(c.deliverables, i.id));

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

const mismatchCache = new WeakMap<CheckContext, { checked: number; mismatches: ValueMismatch[] }>();

/**
 * Finds numbers in issue descriptions and discussion records that contradict every recorded value (baseline,
 * current, target) of the KPIs the text is about. The KPI is the record of truth: it has an owner, a source and a period.
 */
export function valueMismatches(c: CheckContext): { checked: number; mismatches: ValueMismatch[] } {
  let found = mismatchCache.get(c);
  if (!found) mismatchCache.set(c, (found = findValueMismatches(c)));
  return found;
}

function findValueMismatches(c: CheckContext): { checked: number; mismatches: ValueMismatch[] } {
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

const threads = new WeakMap<CheckContext, StrategyThread>();

/** The strategy thread of the context (computed once per context: several checks read it). */
export function threadOf(c: CheckContext): StrategyThread {
  let t = threads.get(c);
  if (!t) {
    t = strategyThread({ pack: c.pack, kpi: c.kpi, useCases: c.useCases, strategy: c.strategy ?? emptyStrategy(), objectives: c.objectives ?? [], projectObjectiveIds: c.projectObjectiveIds ?? [] });
    threads.set(c, t);
  }
  return t;
}

export const STEP_DEFS: Record<ImprovementStep, StepDef> = {
  asis: {
    step: 'asis',
    inputs: ['issues', 'causes', 'sources', 'discussion', 'analyses', 'kpis', 'flows'],
    fields: ASIS_FIELDS,
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
          if (causes.length === 0) return fail('noCauses', entityRefs(kindOf(c.pack, 'issue')));
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
      {
        // After the evidence checks: a verdict rests on sources, causes, the KPI and its baseline (no guessing).
        id: 'asis-qualify', kind: 'auto', href: '/step?step=asis',
        check: (c) => {
          const issues = rankedIssues(c.pack);
          if (issues.length === 0) return fail('noIssues');
          const open = issues.filter((i) => !qualificationOf(c.deliverables, i.id));
          if (open.length) return fail('issuesUnqualified', entityRefs(open), { n: open.length });
          const out = issues.filter((i) => isQualifiedOut(c.deliverables, i.id)).length;
          return pass('issuesQualified', { pursue: issues.length - out, out });
        },
      },
      { id: 'asis-doc', kind: 'auto', href: docHref('asis'), check: docCheck('asis', ASIS_FIELDS) },
      { id: 'asis-field', kind: 'manual', href: docHref('asis') },
      { id: 'define-agree', kind: 'manual', href: docHref('asis') },
    ],
  },
  tobe: {
    step: 'tobe',
    inputs: ['objectives', 'issues', 'kpis', 'useCases', 'personas', 'projectKpis', 'okrs'],
    fields: TOBE_FIELDS,
    todos: [
      {
        id: 'tobe-link', kind: 'auto', href: '/projects',
        check: (c) => {
          const objectives = c.objectives ?? [];
          if (objectives.length === 0) return fail('noCompanyObjectives');
          const linked = (c.projectObjectiveIds ?? []).filter((id) => objectives.some((o) => o.id === id));
          const viaOkr = c.kpi.okrs.flatMap((o) => o.companyObjectiveIds ?? []).filter((id) => objectives.some((o) => o.id === id));
          const n = new Set([...linked, ...viaOkr]).size;
          return n > 0 ? pass('projectAligned', { n }) : fail('projectUnaligned');
        },
      },
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
          if (kindOf(c.pack, 'issue').length === 0) return fail('noIssues');
          const top = pursuedIssues(c)[0];
          if (!top) return fail('noPursuedIssues');
          const solutions = kindOf(c.pack, 'solution').filter((s) => s.issueIds.includes(top.id)).map((s) => s.id);
          const covered = c.useCases.some((u) => u.origin === 'registered' && u.relatedIds.some((id) => id === top.id || solutions.includes(id)));
          return covered ? pass('topIssueCovered', { issue: top.id }) : fail('topIssueUncovered', [{ type: 'entity', id: top.id }]);
        },
      },
      { id: 'tobe-doc', kind: 'auto', href: docHref('tobe'), check: docCheck('tobe', TOBE_FIELDS) },
      { id: 'uc-review', kind: 'manual', href: docHref('tobe') },
      { id: 'tobe-agree', kind: 'manual', href: docHref('tobe') },
    ],
  },
  kpi: {
    step: 'kpi',
    inputs: ['kpis', 'projectKpis', 'okrs', 'objectives'],
    fields: KPI_FIELDS,
    todos: [
      {
        id: 'kpi-definition', kind: 'auto', href: '/deliverables?step=kpi',
        check: (c) => {
          const status = c.strategy?.definition?.status ?? kpiDefinitionState(c.pack.pack).status;
          // FR-368: a customer KPI or a customer OKR is enough; AI drafts are placeholders checked by `kpi-review`.
          const basis = kpiBasis(c.kpi);
          if (basis.sourced > 0) return pass('definitionImported', { n: basis.sourced, status });
          if (status === 'defined' || status === 'partial') return fail('definitionNotImported', [], { status });
          return basis.provisional > 0 ? pass('definitionProvisional', { n: basis.provisional, status }) : fail('definitionMissing', [], { status });
        },
      },
      {
        id: 'kpi-review', kind: 'auto', href: '/analysis?tab=kpi',
        check: (c) => {
          if (c.kpi.kpis.length + c.kpi.okrs.length === 0) return fail('noProjectKpis');
          const open: CheckRef[] = [
            ...c.kpi.kpis.filter(needsReview).map((k) => ({ type: 'text' as const, text: k.name })),
            ...c.kpi.okrs.filter(needsReview).map((o) => ({ type: 'text' as const, text: o.objective })),
          ];
          if (open.length > 0) return fail('provisionalUnreviewed', open, { n: open.length });
          const basis = kpiBasis(c.kpi);
          return basis.provisional > 0 ? pass('provisionalReviewed', { n: basis.provisional }) : pass('reviewNotNeeded');
        },
      },
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
          const all = kindOf(c.pack, 'issue');
          if (all.length === 0) return fail('noIssues');
          const issues = all.filter((i) => !isQualifiedOut(c.deliverables, i.id));
          if (issues.length === 0) return fail('noPursuedIssues');
          const out = all.length - issues.length;
          const bad = issues.filter((i) => !issueKpis(c, i).some((k) => projectHasKpi(c.kpi.kpis, k)));
          return bad.length ? fail('issuesNotMeasured', entityRefs(bad), { n: bad.length }) : pass(out ? 'pursuedIssuesTracked' : 'allIssuesTracked', { n: issues.length, out });
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
      {
        id: 'kpi-company', kind: 'auto', href: '/deliverables?step=kpi',
        check: (c) => {
          if ((c.objectives ?? []).length === 0) return fail('noCompanyObjectives');
          if (c.kpi.okrs.length === 0) return fail('noOkr');
          const t = threadOf(c);
          const bad = c.kpi.okrs.filter((o) => t.gaps.okrsWithoutObjective.includes(o.id));
          return bad.length ? fail('okrsUnaligned', bad.map((o) => ({ type: 'text' as const, text: o.objective })), { n: bad.length }) : pass('okrsAligned', { n: c.kpi.okrs.length });
        },
      },
      { id: 'kpi-doc', kind: 'auto', href: docHref('kpi'), check: docCheck('kpi', KPI_FIELDS) },
      { id: 'kpi-measure', kind: 'manual', href: docHref('kpi') },
    ],
  },
  solution: {
    step: 'solution',
    inputs: ['issues', 'solutions', 'projectKpis', 'useCases'],
    fields: SOLUTION_FIELDS,
    todos: [
      {
        id: 'sol-issues', kind: 'auto', href: '/relations',
        check: (c) => {
          const issues = kindOf(c.pack, 'issue');
          if (issues.length === 0) return fail('noIssues');
          const pursued = pursuedIssues(c);
          if (pursued.length === 0) return fail('noPursuedIssues');
          const out = issues.length - pursued.length;
          const solutions = kindOf(c.pack, 'solution');
          const bad = pursued.filter((i) => !solutions.some((s) => s.issueIds.includes(i.id)));
          return bad.length ? fail('issuesWithoutSolution', entityRefs(bad), { n: bad.length }) : pass(out ? 'pursuedIssuesSolved' : 'allIssuesSolved', { n: pursued.length, out });
        },
      },
      {
        id: 'sol-type', kind: 'auto', href: '/deliverables?step=solution',
        check: (c) => {
          const solutions = kindOf(c.pack, 'solution');
          if (solutions.length === 0) return fail('noSolutions');
          const t = threadOf(c);
          const bad = solutions.filter((s) => !t.solutions.find((x) => x.id === s.id)?.typeConfirmed);
          return bad.length ? fail('typesUnconfirmed', entityRefs(bad), { n: bad.length }) : pass('typesConfirmed', { n: solutions.length });
        },
      },
      {
        id: 'sol-contribution', kind: 'auto', href: '/deliverables?step=solution',
        check: (c) => {
          const solutions = kindOf(c.pack, 'solution');
          if (solutions.length === 0) return fail('noSolutions');
          const t = threadOf(c);
          const bad = solutions.filter((s) => t.gaps.solutionsWithoutContribution.includes(s.id));
          return bad.length ? fail('solutionsWithoutContribution', entityRefs(bad), { n: bad.length }) : pass('allSolutionsEstimated', { n: solutions.length });
        },
      },
      {
        id: 'sol-target', kind: 'auto', href: '/deliverables?step=solution',
        check: (c) => {
          if (c.kpi.kpis.length === 0) return fail('noProjectKpis');
          const t = threadOf(c);
          const open = c.kpi.kpis.filter((k) => {
            const r = t.sims.find((x) => x.kpiId === k.id);
            if (!r) return true;
            return r.coverage !== null && r.coverage < 1;
          });
          return open.length ? fail('kpiGapOpen', open.map((k) => ({ type: 'text' as const, text: k.name })), { n: open.length }) : pass('kpiGapsClosed', { n: c.kpi.kpis.length });
        },
      },
      { id: 'uc-doc', kind: 'auto', href: docHref('solution'), check: docCheck('solution', SOLUTION_FIELDS) },
      { id: 'sol-review', kind: 'manual', href: docHref('solution') },
    ],
  },
  deliverable: {
    step: 'deliverable',
    inputs: ['solutions', 'initiatives', 'people', 'discussion'],
    fields: DELIVERABLE_FIELDS,
    todos: [
      {
        id: 'dlv-trace', kind: 'auto', href: '/deliverables?step=deliverable',
        check: (c) => {
          const t = threadOf(c);
          if (t.solutions.length === 0) return fail('noSolutions');
          const g = t.gaps;
          const refs: CheckRef[] = [
            ...g.solutionsWithoutKpi.map((id) => ({ type: 'entity' as const, id })),
            ...g.digitalWithoutUseCase.map((id) => ({ type: 'entity' as const, id })),
            ...c.kpi.kpis.filter((k) => g.kpisWithoutOkr.includes(k.id) || g.kpisWithoutSolution.includes(k.id)).map((k) => ({ type: 'text' as const, text: k.name })),
          ];
          const n = g.solutionsWithoutKpi.length + g.digitalWithoutUseCase.length + g.kpisWithoutOkr.length + g.kpisWithoutSolution.length;
          return n ? fail('traceBroken', refs, { n }) : pass('traceComplete', { n: t.solutions.length });
        },
      },
      {
        id: 'dlv-docs', kind: 'auto', href: '/deliverables?step=deliverable',
        check: (c) => {
          const t = threadOf(c);
          const solutions = kindOf(c.pack, 'solution');
          if (solutions.length === 0) return fail('noSolutions');
          const doc = { ...c, strategy: c.strategy ?? emptyStrategy(), objectives: c.objectives ?? [], projectObjectiveIds: c.projectObjectiveIds ?? [] };
          const bad = solutions.filter((s) => !buildSolutionDoc(s, t.solutions.find((x) => x.id === s.id)!, t, doc, 'ja').complete);
          return bad.length ? fail('docsOpen', entityRefs(bad), { n: bad.length }) : pass('docsComplete', { n: solutions.length });
        },
      },
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
          const bad = inits.filter((i) => !(i.ownerId && c.pack.byId.get(i.ownerId)?.kind === 'person') && !i.ownerRole);
          if (bad.length) return fail('initiativesWithoutOwner', entityRefs(bad), { n: bad.length });
          const estimated = inits.filter((i) => !(i.ownerId && c.pack.byId.get(i.ownerId)?.kind === 'person') && unreviewedEstimate(c.deliverables, i, 'ownerRole'));
          return estimated.length ? fail('ownersUnreviewed', entityRefs(estimated), { n: estimated.length }) : pass('allInitiativesOwned', { n: inits.length });
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
          const unknown = solutions.filter((_, i) => years[i] === null);
          if (unknown.length) return fail('paybackUnknown', entityRefs(unknown), { n: unknown.length });
          const estimated = solutions.filter((s) => unreviewedEstimate(c.deliverables, s, 'costJpy') || unreviewedEstimate(c.deliverables, s, 'annualBenefitJpy'));
          if (estimated.length) return fail('paybackUnreviewed', entityRefs(estimated), { n: estimated.length });
          const known = years as number[];
          const bad = solutions.filter((_, i) => known[i]! > max);
          const worst = Math.max(...known);
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
      { id: 'plan-doc', kind: 'auto', href: docHref('deliverable'), check: docCheck('deliverable', DELIVERABLE_FIELDS) },
      { id: 'plan-approve', kind: 'manual', href: docHref('deliverable') },
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

const stepResults = new WeakMap<CheckContext, Partial<Record<ImprovementStep, TodoResult[]>>>();

/** The step's criteria judged on the context (computed once per context and step: many views read the same results). */
export function evaluateStep(step: ImprovementStep, c: CheckContext): TodoResult[] {
  let byStep = stepResults.get(c);
  if (!byStep) stepResults.set(c, (byStep = {}));
  return (byStep[step] ??= STEP_DEFS[step].todos.map((todo) => {
    if (todo.kind === 'manual') {
      const signOff = c.deliverables.signOffs[todo.id];
      return signOff ? { todo, done: true, signOff } : { todo, done: false };
    }
    const outcome = todo.check!(c);
    return { todo, done: outcome.ok, outcome };
  }));
}

/** The first open exit criterion in the step's working order: what the user should do next. */
export const nextTodo = (results: TodoResult[]): TodoResult | undefined => results.find((r) => !r.done);

/** Open criteria first (stable within each group), so a narrow band shows what still needs doing. */
export const openFirst = (results: TodoResult[]): TodoResult[] => [...results.filter((r) => !r.done), ...results.filter((r) => r.done)];

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

/**
 * Approve an AI suggestion as it was shown (FR-338): the field becomes the person's (`human`) with who and when.
 * Nothing changes when the field is no longer an AI suggestion or its text changed after it was shown.
 */
export function approveField(data: DeliverableData, step: ImprovementStep, id: string, shown: string, by: string, at: string): DeliverableData {
  const current = data.docs[step]?.[id];
  if (!current || current.author !== 'ai' || current.text !== shown || !current.text.trim()) return data;
  return setField(data, step, id, { text: current.text, author: 'human', updatedAt: at, approved: { at, by, mock: current.mock ?? false } });
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
