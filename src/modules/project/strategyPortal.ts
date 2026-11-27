import { CompanyAnchorSchema, CompanyAnchorVersionSchema, type CompanyAnchor } from '../../data/companyAnchor.ts';
import type { Formatters, Lang, MessageKey } from '../../i18n/index.ts';
import { hrefFor } from '../../state/router.ts';
import { loc } from '../../state/text.ts';
import type { StrategyDrafts, StrategyNode } from './overviewModel.ts';
import type { ReadinessKey } from './analysisReadiness.ts';
import type { AppCheckContext as CheckContext } from './deliverables.ts';

/** FR-347: the strategy map is a portal; every node, lane header and empty lane opens the place where that item is entered or checked. */
export type Lane = StrategyNode['lane'];
export type Destination = { kind: 'link'; href: string } | { kind: 'objective'; draftId?: string };

const kpiTab = (target: string) => hrefFor('/analysis', { tab: 'kpi', target });
const relations = (query: Record<string, string>) => hrefFor('/relations', { view: 'table', target: 'relation-table', ...query });
const anchor = (companyId: string) => companyId ? hrefFor('/projects', { target: `company-anchor-${companyId}` }) : hrefFor('/projects');

export const nodeDomId = (nodeId: string) => `stg-node-${nodeId}`;
export const laneDomId = (lane: Lane) => `stg-lane-${lane}`;
export const emptyDomId = (lane: Lane) => `stg-empty-${lane}`;

/** Lane header: the list of that lane's items. */
export function laneHref(lane: Lane, companyId: string): string {
  switch (lane) {
    case 'objective': return anchor(companyId);
    case 'okr': return kpiTab('proj-okr-panel');
    case 'kpi': return kpiTab('proj-kpi-panel');
    case 'issue':
    case 'solution': return relations({});
  }
}

/** Empty lane: the form that adds the first item. Company objectives need a company; without one, Projects is where it is added. */
export function emptyDestination(lane: Lane, companyId: string, canEditObjectives: boolean): Destination {
  switch (lane) {
    case 'objective': return canEditObjectives && companyId ? { kind: 'objective' } : { kind: 'link', href: anchor(companyId) };
    case 'okr': return { kind: 'link', href: kpiTab('proj-okr-objective') };
    case 'kpi': return { kind: 'link', href: kpiTab('proj-kpi-name') };
    case 'issue':
    case 'solution': return { kind: 'link', href: relations({ create: lane, field: 'name' }) };
  }
}

export function nodeDestination(node: Pick<StrategyNode, 'lane' | 'ref' | 'draft'>, companyId: string, canEditObjectives: boolean): Destination {
  const isNew = node.draft === 'new';
  switch (node.lane) {
    case 'objective':
      if (isNew) return canEditObjectives && companyId ? { kind: 'objective', draftId: node.ref } : { kind: 'link', href: anchor(companyId) };
      return { kind: 'link', href: anchor(companyId) };
    case 'okr': return { kind: 'link', href: kpiTab(isNew ? `proj-okr-draft-${node.ref}` : `proj-okr-${node.ref}`) };
    case 'kpi': return { kind: 'link', href: kpiTab(isNew ? `proj-kpi-draft-${node.ref}` : `proj-kpi-row-${node.ref}`) };
    case 'issue':
    case 'solution':
      return { kind: 'link', href: relations({ edit: node.ref, field: 'name' }) };
  }
}

/** FR-381: one row of an item's structured sub-data; `href` opens the exact field (or child item) where it is edited. */
export interface DetailRow {
  id: string;
  label: MessageKey;
  text: string;
  href?: string;
}

/**
 * FR-381: the structured data behind a map item, read from the same data the map is built from. Each row links to the
 * field that edits it (relations editor `field=`), or to the OKR/KPI row; a draft links to its draft.
 */
export function nodeDetails(node: StrategyNode, ctx: CheckContext, lang: Lang, fmt: Pick<Formatters, 'number' | 'yen'>, drafts: StrategyDrafts = {}): DetailRow[] {
  const sep = lang === 'ja' ? '、' : ', ';
  const kpiName = (id: string) => {
    const k = ctx.kpi.kpis.find((x) => x.id === id);
    if (k) return loc(k.name, lang);
    const e = ctx.pack.byId.get(id);
    return drafts.kpis?.find((x) => x.id === id)?.name ?? (e ? loc(e.name, lang) : id);
  };
  const entityName = (id: string) => { const e = ctx.pack.byId.get(id); return e ? loc(e.name, lang) : id; };
  const names = (ids: readonly string[], name: (id: string) => string) => ids.length ? ids.map(name).join(sep) : '';
  const none = (text: string) => text || '—';
  switch (node.lane) {
    case 'okr': {
      if (node.draft === 'new') {
        const d = drafts.okrs?.find((o) => o.id === node.ref);
        return d?.kpiIds.length ? [{ id: 'kpis', label: 'stg.detail.kr', text: names(d.kpiIds, kpiName), href: kpiTab(`proj-okr-draft-${d.id}`) }] : [];
      }
      const okr = ctx.kpi.okrs.find((o) => o.id === node.ref);
      return okr ? okr.keyResults.map((kr) => {
        const text = loc(kr.text, lang).trim();
        return { id: `kr-${kr.id}`, label: 'stg.detail.kr' as const, text: text ? `${text} → ${kpiName(kr.kpiId)}` : kpiName(kr.kpiId), href: kpiTab(`proj-okr-${okr.id}`) };
      }) : [];
    }
    case 'kpi': {
      const k = node.draft === 'new' ? undefined : ctx.kpi.kpis.find((x) => x.id === node.ref);
      if (!k) return [];
      const href = kpiTab(`proj-kpi-row-${k.id}`);
      const unit = loc(k.unit, lang);
      return [
        { id: 'values', label: 'stg.detail.values', text: `${fmt.number(k.baseline)} → ${fmt.number(k.current)} → ${fmt.number(k.target)}${unit ? ` ${unit}` : ''}`, href },
        ...(k.deadline ? [{ id: 'deadline', label: 'proj.kpi.deadline' as const, text: k.deadline, href }] : []),
      ];
    }
    case 'issue': {
      const e = ctx.pack.byId.get(node.ref);
      if (e?.kind !== 'issue') return [];
      const edit = (field: string) => relations({ edit: e.id, field });
      const sources = e.sourceIds.filter((id) => ctx.pack.byId.has(id));
      return [
        { id: 'impact', label: 'field.impact', text: `${fmt.number(e.impact)} / 5`, href: edit('impact') },
        { id: 'feasibility', label: 'field.feasibility', text: `${fmt.number(e.feasibility)} / 5`, href: edit('feasibility') },
        ...(e.causeIds.length
          ? e.causeIds.map((id) => ({ id: `cause-${id}`, label: 'field.causes' as const, text: entityName(id), href: ctx.pack.byId.get(id)?.kind === 'cause' ? relations({ edit: id, field: 'name' }) : edit('causeIds') }))
          : [{ id: 'causes', label: 'field.causes' as const, text: '—', href: edit('causeIds') }]),
        { id: 'sources', label: 'entity.sources', text: none(names(sources, entityName)), href: edit('sourceIds') },
      ];
    }
    case 'solution': {
      const e = ctx.pack.byId.get(node.ref);
      if (e?.kind !== 'solution') return [];
      const edit = (field: string) => relations({ edit: e.id, field });
      return [
        { id: 'cost', label: 'field.cost', text: fmt.yen(e.costJpy), href: edit('costJpy') },
        { id: 'benefit', label: 'field.annualBenefit', text: fmt.yen(e.annualBenefitJpy), href: edit('annualBenefitJpy') },
        { id: 'products', label: 'field.msProducts', text: none(e.msProducts.join(sep)), href: edit('msProducts') },
        { id: 'kpis', label: 'entry.field.kpis', text: none(names(e.kpiIds, kpiName)), href: edit('kpiIds') },
      ];
    }
    case 'objective': return [];
  }
}

export type ObjectiveScope = CompanyAnchor['statedObjectives'][number]['scope'];
export type ObjectiveBasis = CompanyAnchor['statedObjectives'][number]['basis'];
export interface ObjectiveInput {
  id?: string;
  text: string;
  horizon: string;
  basis: ObjectiveBasis;
  scope: ObjectiveScope;
  scopeName: string;
  source: { title: string; type: 'public' | 'internal'; url: string; locator: string; accessedDate: string; excerpt: string };
}

/** Objectives in the imported pack's company-anchor snapshot that are not yet in the company's saved anchor: drafts. */
export function packObjectiveDrafts(extensions: Record<string, unknown> | undefined, savedIds: readonly string[]): ObjectiveInput[] {
  const parsed = CompanyAnchorVersionSchema.safeParse(extensions?.companyAnchor);
  if (!parsed.success) return [];
  const { statedObjectives, sources } = parsed.data.anchor;
  return statedObjectives.filter((o) => !savedIds.includes(o.id)).map((o) => {
    const s = sources.find((x) => x.id === o.sourceIds[0]);
    return {
      id: o.id, text: o.text, horizon: o.horizon, basis: o.basis, scope: o.scope, scopeName: o.scopeName ?? '',
      source: { title: s?.title ?? '', type: s?.type ?? 'public', url: s?.url ?? '', locator: s?.locator ?? '', accessedDate: s?.accessedDate ?? '', excerpt: s?.excerpt ?? '' },
    };
  });
}

const nextId = (prefix: string, taken: Set<string>) => {
  for (let n = taken.size + 1; ; n += 1) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
};

/**
 * Appends one stated objective with its own source to the company anchor (a new version on save). Without an anchor it
 * starts a minimal one for the company. A draft keeps its id so OKRs that already cite it stay connected.
 */
export function appendObjective(latest: CompanyAnchor | null, input: ObjectiveInput, companyName: string, today: string):
  { ok: true; anchor: CompanyAnchor; id: string } | { ok: false; errors: ObjectiveField[] } {
  const base: CompanyAnchor = latest ?? {
    asOf: today, refreshTriggers: [], refreshEvents: [],
    entityScope: { legalEntity: companyName, figuresScope: [companyName] },
    statedObjectives: [], companyKpis: [], segments: [], structuralIssues: [], analystHypotheses: [], sources: [],
  };
  const objectiveIds = new Set(base.statedObjectives.map((o) => o.id));
  const sourceIds = new Set(base.sources.map((s) => s.id));
  const id = input.id && !objectiveIds.has(input.id) ? input.id : nextId('OBJ', objectiveIds);
  const sourceId = nextId('S', sourceIds);
  const src = input.source;
  const candidate = {
    ...base,
    statedObjectives: [...base.statedObjectives, {
      id, text: input.text, horizon: input.horizon, basis: input.basis, scope: input.scope,
      ...(input.scopeName.trim() ? { scopeName: input.scopeName.trim() } : {}), sourceIds: [sourceId],
    }],
    sources: [...base.sources, {
      id: sourceId, title: src.title, type: src.type, provenance: 'unknown' as const, url: src.url.trim(),
      accessedDate: src.accessedDate, locator: src.locator, ...(src.excerpt.trim() ? { excerpt: src.excerpt.trim() } : {}),
    }],
  };
  const parsed = CompanyAnchorSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i): ObjectiveField => {
      const [section, , key] = i.path;
      if (section === 'sources') return key === 'url' || key === 'locator' || key === 'accessedDate' ? key : 'title';
      return key === 'horizon' ? 'horizon' : 'text';
    });
    return { ok: false, errors: [...new Set(fields)] };
  }
  return { ok: true, anchor: parsed.data, id };
}

export type ObjectiveField = 'text' | 'horizon' | 'title' | 'url' | 'locator' | 'accessedDate';

const READINESS_KINDS: Partial<Record<ReadinessKey, string>> = { org: 'person', locations: 'site', customers: 'customer', engagements: 'initiative', issues: 'issue' };

/**
 * An unmet readiness item: the form whose AI draft proposes the missing data (with Work IQ evidence when chosen); nothing is
 * saved until the user reviews it. Workflow and data catalog are not entities with an entry form, so they have none here.
 */
export function readinessDraftHref(key: ReadinessKey): string | undefined {
  if (key === 'kpi') return kpiTab('proj-kpi-panel');
  const kind = READINESS_KINDS[key];
  return kind ? relations({ create: kind, field: 'name' }) : undefined;
}
