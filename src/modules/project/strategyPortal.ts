import { CompanyAnchorSchema, CompanyAnchorVersionSchema, type CompanyAnchor } from '../../data/companyAnchor.ts';
import { hrefFor } from '../../state/router.ts';
import type { StrategyNode } from './overviewModel.ts';

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
