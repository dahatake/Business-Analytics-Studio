import type { Lang, MessageKey } from '../../i18n/core.ts';
import { Entity, type EntityKind, type LText } from '../../data/schema.ts';

/** Kinds that can be entered in the app. Causes, initiatives, suppliers and sources come from pack generation only. */
export const EDITABLE_KINDS = ['issue', 'kpi', 'solution', 'customer', 'deal', 'deliverable', 'invoice', 'person', 'product', 'site'] as const satisfies readonly EntityKind[];
export type EditableKind = (typeof EDITABLE_KINDS)[number];
export const isEditableKind = (k: string): k is EditableKind => (EDITABLE_KINDS as readonly string[]).includes(k);

interface Option { value: string; label: MessageKey }

export type FieldSpec =
  | { key: string; type: 'ltext'; label: MessageKey; required?: boolean }
  | { key: string; type: 'number'; label: MessageKey; min?: number; max?: number; step?: number }
  | { key: string; type: 'date'; label: MessageKey }
  | { key: string; type: 'enum'; label: MessageKey; options: Option[]; numeric?: boolean }
  | { key: string; type: 'ref'; label: MessageKey; kind: EditableKind }
  | { key: string; type: 'refs'; label: MessageKey; kind: EditableKind; min?: number }
  | { key: string; type: 'region'; label: MessageKey }
  | { key: string; type: 'list'; label: MessageKey };

const opts = (prefix: string, values: string[]): Option[] => values.map((value) => ({ value, label: `${prefix}.${value}` as MessageKey }));
const SCORE: Option[] = [
  { value: '1', label: 'entry.score.1' }, { value: '2', label: 'entry.score.2' }, { value: '3', label: 'entry.score.3' },
  { value: '4', label: 'entry.score.4' }, { value: '5', label: 'entry.score.5' },
];
const SCALE: Option[] = [{ value: 'ratio', label: 'entry.scale.ratio' }, { value: 'interval', label: 'entry.scale.interval' }];

/** Kind-specific fields (name, description and classification are common to every kind). */
export const FIELDS: Record<EditableKind, FieldSpec[]> = {
  issue: [
    { key: 'impact', type: 'enum', label: 'field.impact', options: SCORE, numeric: true },
    { key: 'feasibility', type: 'enum', label: 'field.feasibility', options: SCORE, numeric: true },
    { key: 'kpiIds', type: 'refs', label: 'entry.field.kpis', kind: 'kpi' },
  ],
  kpi: [
    { key: 'unit', type: 'ltext', label: 'entry.field.unit', required: true },
    { key: 'baseline', type: 'number', label: 'field.baseline' },
    { key: 'current', type: 'number', label: 'field.actual' },
    { key: 'target', type: 'number', label: 'field.target' },
    { key: 'direction', type: 'enum', label: 'field.direction', options: opts('direction', ['increase', 'decrease']) },
    { key: 'scale', type: 'enum', label: 'entry.field.scale', options: SCALE },
    { key: 'period', type: 'ltext', label: 'field.period', required: true },
    { key: 'ownerId', type: 'ref', label: 'field.owner', kind: 'person' },
  ],
  solution: [
    { key: 'issueIds', type: 'refs', label: 'field.issues', kind: 'issue', min: 1 },
    { key: 'kpiIds', type: 'refs', label: 'entry.field.kpis', kind: 'kpi' },
    { key: 'msProducts', type: 'list', label: 'field.msProducts' },
    { key: 'costJpy', type: 'number', label: 'field.cost', min: 1 },
    { key: 'annualBenefitJpy', type: 'number', label: 'field.annualBenefit', min: 1 },
  ],
  customer: [
    { key: 'industry', type: 'ltext', label: 'field.industry', required: true },
    { key: 'regionId', type: 'region', label: 'field.region' },
  ],
  deal: [
    { key: 'customerId', type: 'ref', label: 'field.customer', kind: 'customer' },
    { key: 'productIds', type: 'refs', label: 'entry.field.products', kind: 'product', min: 1 },
    { key: 'ownerId', type: 'ref', label: 'field.owner', kind: 'person' },
    { key: 'stage', type: 'enum', label: 'field.stage', options: opts('stage', ['lead', 'proposal', 'negotiation', 'won', 'delivered']) },
    { key: 'valueJpy', type: 'number', label: 'field.value', min: 1 },
    { key: 'closeDate', type: 'date', label: 'field.closeDate' },
  ],
  deliverable: [
    { key: 'dealId', type: 'ref', label: 'field.deal', kind: 'deal' },
    { key: 'dueDate', type: 'date', label: 'field.dueDate' },
    { key: 'status', type: 'enum', label: 'field.status', options: opts('deliverableStatus', ['planned', 'inProgress', 'done']) },
  ],
  invoice: [
    { key: 'deliverableId', type: 'ref', label: 'field.deliverable', kind: 'deliverable' },
    { key: 'amountJpy', type: 'number', label: 'field.amount', min: 1 },
    { key: 'issuedDate', type: 'date', label: 'field.issuedDate' },
    { key: 'status', type: 'enum', label: 'field.status', options: opts('invoiceStatus', ['draft', 'sent', 'paid', 'overdue']) },
  ],
  person: [
    { key: 'role', type: 'ltext', label: 'field.role', required: true },
    { key: 'siteId', type: 'ref', label: 'field.site', kind: 'site' },
  ],
  product: [
    { key: 'category', type: 'ltext', label: 'field.category', required: true },
    { key: 'siteId', type: 'ref', label: 'field.madeAt', kind: 'site' },
    { key: 'unitPriceJpy', type: 'number', label: 'field.unitPrice', min: 1 },
  ],
  site: [
    { key: 'role', type: 'enum', label: 'field.siteRole', options: opts('siteRole', ['hq', 'plant', 'dc', 'office']) },
    { key: 'lat', type: 'number', label: 'entry.field.lat', min: -90, max: 90, step: 0.0001 },
    { key: 'lon', type: 'number', label: 'entry.field.lon', min: -180, max: 180, step: 0.0001 },
    { key: 'capacityTPerMonth', type: 'number', label: 'field.capacity', min: 0 },
  ],
};

const today = () => new Date().toISOString().slice(0, 10);
const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** §3.7 world/type of entries made in the app, matching the sample pack. */
const META: Record<EditableKind, { world: 'real' | 'digital'; type: string }> = {
  issue: { world: 'real', type: 'event' },
  kpi: { world: 'digital', type: 'metric' },
  solution: { world: 'digital', type: 'system' },
  customer: { world: 'real', type: 'organization' },
  deal: { world: 'real', type: 'event' },
  deliverable: { world: 'real', type: 'thing' },
  invoice: { world: 'digital', type: 'data' },
  person: { world: 'real', type: 'person' },
  product: { world: 'real', type: 'thing' },
  site: { world: 'real', type: 'site' },
};

const defaults = (kind: EditableKind): Record<string, unknown> => {
  switch (kind) {
    case 'issue': return { impact: 3, feasibility: 3, causeIds: [], kpiIds: [] };
    case 'kpi': return { baseline: 0, current: 0, target: 100, direction: 'increase', scale: 'ratio', ownerId: '' };
    case 'solution': return { issueIds: [], kpiIds: [], msProducts: [] };
    case 'customer': return { regionId: '' };
    case 'deal': return { customerId: '', productIds: [], ownerId: '', stage: 'lead', closeDate: today() };
    case 'deliverable': return { dealId: '', dueDate: today(), status: 'planned' };
    case 'invoice': return { deliverableId: '', issuedDate: today(), status: 'draft' };
    case 'person': return { siteId: '' };
    case 'product': return { siteId: '' };
    case 'site': return { role: 'office', lat: 35.6812, lon: 139.7671, capacityTPerMonth: 0 };
  }
};

/** A new raw entity of `kind`; validation runs when it is saved. Entries made by a person are author 'human' (FR-116). */
export function blankEntity(kind: EditableKind, id: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id, kind, ...META[kind], classification: 'internal', author: 'human', sourceIds: [], ...defaults(kind),
  };
  if (kind === 'customer' || kind === 'product') raw.illustration = { motif: 'generic', hue: hueOf(id) };
  return raw;
}

/**
 * Bilingual text from one input: a new or still-monolingual text gets the value in both languages;
 * otherwise only the current language changes and the other translation is kept.
 */
export function setLText(prev: unknown, value: string, lang: Lang): LText {
  const p = prev as Partial<LText> | undefined;
  if (!p || !p.ja || !p.en || p.ja === p.en) return { ja: value, en: value };
  return { ja: p.ja, en: p.en, [lang]: value };
}

export type FormValue = string | string[];
export type FormState = Record<string, FormValue>;

const textIn = (v: unknown, lang: Lang) => (v as Partial<LText> | undefined)?.[lang] ?? '';

/** Form values shown for an entity (text in the current language, numbers as strings). */
export function toForm(kind: EditableKind, raw: Record<string, unknown>, lang: Lang): FormState {
  const name = textIn(raw.name, lang);
  const description = textIn(raw.description, lang);
  const form: FormState = {
    name,
    description: description === name ? '' : description,
    shareable: raw.classification === 'shareable' ? 'true' : '',
  };
  for (const f of FIELDS[kind]) {
    const v = raw[f.key];
    if (f.type === 'ltext') form[f.key] = textIn(v, lang);
    else if (f.type === 'refs') form[f.key] = Array.isArray(v) ? (v as string[]) : [];
    else if (f.type === 'list') form[f.key] = Array.isArray(v) ? (v as string[]).join(', ') : '';
    else form[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return form;
}

export type FieldErrorKind = 'required' | 'invalid' | 'pick' | 'pickOne';
export type FieldErrors = Record<string, FieldErrorKind>;

/** The entity built from the form, or per-field errors. Validated against the pack schema so the pack always stays loadable. */
export function fromForm(kind: EditableKind, base: Record<string, unknown>, form: FormState, lang: Lang): { entity: Entity | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
  const raw: Record<string, unknown> = { ...structuredClone(base), author: 'human' };
  if (!str('name')) errors.name = 'required';
  raw.name = setLText(base.name, str('name'), lang);
  raw.description = setLText(base.description, str('description') || str('name'), lang);
  raw.classification = form.shareable === 'true' ? 'shareable' : 'internal';
  for (const f of FIELDS[kind]) {
    const v = str(f.key);
    switch (f.type) {
      case 'ltext':
        if (f.required && !v) errors[f.key] = 'required';
        raw[f.key] = setLText(base[f.key], v, lang);
        break;
      case 'number': {
        const n = Number(v);
        if (!v) errors[f.key] = 'required';
        else if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) errors[f.key] = 'invalid';
        raw[f.key] = n;
        break;
      }
      case 'enum':
        raw[f.key] = f.numeric ? Number(v) : v;
        break;
      case 'date':
        if (!v) errors[f.key] = 'required';
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.key] = 'invalid';
        raw[f.key] = v;
        break;
      case 'ref':
      case 'region':
        if (!v) errors[f.key] = 'pick';
        raw[f.key] = v;
        break;
      case 'refs': {
        const ids = Array.isArray(form[f.key]) ? (form[f.key] as string[]) : [];
        if (f.min && ids.length < f.min) errors[f.key] = 'pickOne';
        raw[f.key] = ids;
        break;
      }
      case 'list':
        raw[f.key] = v.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean);
        break;
    }
  }
  if (Object.keys(errors).length) return { entity: null, errors };
  const parsed = Entity.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[String(issue.path[0] ?? 'name')] ??= 'invalid';
    return { entity: null, errors };
  }
  return { entity: parsed.data, errors };
}
