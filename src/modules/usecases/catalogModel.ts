import { loaded, type LoadedPack } from '../../data/pack.ts';
import type { Entity, EntityKind, LText } from '../../data/schema.ts';
import { locAll, type Localizable } from '../../state/text.ts';
import { normalizeId, normalizeName } from './normalize.ts';
import type { UseCase } from './store.ts';

/** PARAM-055 / PARAM-056: the data viewer guarantees normal detail up to these sizes. */
export const VIEWER_MAX_ENTITIES = 300;
export const VIEWER_MAX_COLUMNS = 3000;

export interface DataColumn {
  name: string;
  source: 'pack' | 'catalog';
}

/** FR-159: a kind of data the project's business handles. Derived, never saved. */
export interface DataEntity {
  id: string;
  name: Localizable;
  description: Localizable;
  /** Normalized names / ids used to merge spelling variants and to reconcile with a company catalog. */
  keys: string[];
  /** Pack ids that reference this data (records of the kind, issues, solutions, causes). */
  sourceIds: string[];
  columns: DataColumn[];
  /** Domain from a matched company-catalog item (used for clusters). */
  domain?: string;
}

export interface EntityRelation {
  a: string;
  b: string;
}

const l = (ja: string, en: string): LText => ({ ja, en });

/** Pack kinds whose records are business data (deal = order, KPI = measurement records, …). */
const KIND_ENTITIES: Partial<Record<EntityKind, { slug: string; name: LText; description: LText; always: boolean }>> = {
  customer: { slug: 'customer', name: l('顧客', 'Customer'), description: l('取引先の企業の情報。', 'Companies that buy from us.'), always: true },
  product: { slug: 'product', name: l('製品', 'Product'), description: l('製品の仕様と価格。', 'Product specifications and prices.'), always: true },
  deal: { slug: 'order', name: l('受注', 'Order'), description: l('商談と受注の記録。', 'Records of deals and orders.'), always: true },
  deliverable: { slug: 'deliverable', name: l('納品物', 'Deliverable'), description: l('受注に対する納品の記録。', 'Deliveries against orders.'), always: true },
  invoice: { slug: 'invoice', name: l('請求書', 'Invoice'), description: l('納品に対する請求の記録。', 'Invoices for deliveries.'), always: true },
  kpi: { slug: 'kpi-record', name: l('KPI 実績', 'KPI record'), description: l('KPI の基準値・現在値・目標値。', 'Baseline, current and target of each KPI.'), always: true },
  site: { slug: 'site', name: l('拠点', 'Site'), description: l('工場と物流拠点。', 'Plants and distribution centers.'), always: false },
  supplier: { slug: 'supplier', name: l('仕入先', 'Supplier'), description: l('原材料の仕入先。', 'Suppliers of materials.'), always: false },
};

interface Term {
  slug: string;
  name: LText;
  description: LText;
  patterns: RegExp[];
}

/** Data names that issues, causes, solutions and use cases refer to in their text. */
const TERMS: Term[] = [
  { slug: 'order', name: l('受注', 'Order'), description: l('商談と受注の記録。', 'Records of deals and orders.'), patterns: [/受注/, /\borders?\b/i] },
  { slug: 'inventory', name: l('在庫', 'Inventory'), description: l('拠点ごとの在庫数。', 'Stock on hand per site.'), patterns: [/在庫/, /\binventory\b/i, /\bstock\b/i] },
  { slug: 'production-plan', name: l('生産計画', 'Production plan'), description: l('工場ごとの生産の予定。', 'What each plant will make and when.'), patterns: [/生産計画/, /生産枠/, /\bproduction plans?\b/i, /\bscheduling\b/i] },
  { slug: 'demand-forecast', name: l('需要予測', 'Demand forecast'), description: l('製品ごとの需要の見込み。', 'Expected demand per product.'), patterns: [/需要予測/, /\bforecast(ing)?\b/i] },
  { slug: 'inspection-image', name: l('検査画像', 'Inspection image'), description: l('外観検査で撮影した画像と判定。', 'Images and judgments from visual inspection.'), patterns: [/検査/, /\binspect(ion|ors?)?\b/i] },
  { slug: 'power-usage', name: l('電力使用量', 'Power usage'), description: l('設備ごとの電力の計測値。', 'Metered power per machine.'), patterns: [/電力/, /\bpower\b/i] },
  { slug: 'invoice', name: l('請求書', 'Invoice'), description: l('納品に対する請求の記録。', 'Invoices for deliveries.'), patterns: [/請求/, /\binvoic(e|es|ing)\b/i] },
  { slug: 'payment', name: l('入金', 'Payment'), description: l('顧客からの入金と消込の記録。', 'Incoming payments and their matching.'), patterns: [/入金/, /消込/, /\bpayments?\b/i, /\bcollections?\b/i] },
  { slug: 'receivable', name: l('売掛金', 'Accounts receivable'), description: l('未回収の売上。', 'Sales not yet collected.'), patterns: [/売掛/, /\breceivables?\b/i] },
  { slug: 'work-log', name: l('作業記録', 'Work log'), description: l('作業の手順と記録。', 'Procedures and records of work.'), patterns: [/作業記録/, /\blogs?\b/i] },
  { slug: 'equipment', name: l('設備', 'Equipment'), description: l('工場の設備の台帳。', 'Register of plant machines.'), patterns: [/設備/, /\bmachines?\b/i] },
];

const META_KEYS = new Set(['kind', 'world', 'type', 'classification', 'author', 'sourceIds', 'illustration', 'portrait']);

function keysOf(name: Localizable, id: string): string[] {
  return [...new Set([...locAll(name).map(normalizeName), normalizeId(id)])].filter(Boolean);
}

function textOf(e: { name: Localizable; description?: Localizable }): string[] {
  return [...locAll(e.name), ...(e.description ? locAll(e.description) : [])];
}

function useCaseText(uc: UseCase): string[] {
  return [...locAll(uc.name), ...locAll(uc.summary), ...(uc.effect ? locAll(uc.effect) : []), ...uc.steps.flatMap((s) => [...locAll(s.title), ...locAll(s.description)])];
}

const matches = (term: Term, texts: string[]) => texts.some((t) => term.patterns.some((p) => p.test(t)));

/** Expand a use case's related ids along the pack: solutions → issues → causes / KPIs. */
export function expandRelated(uc: UseCase, data: LoadedPack = loaded): Set<string> {
  const out = new Set(uc.relatedIds);
  for (const id of uc.relatedIds) {
    const e = data.byId.get(id);
    if (e?.kind === 'solution') {
      e.issueIds.forEach((i) => out.add(i));
      e.kpiIds.forEach((k) => out.add(k));
    }
  }
  for (const id of [...out]) {
    const e = data.byId.get(id);
    if (e?.kind === 'issue') {
      e.causeIds.forEach((c) => out.add(c));
      e.kpiIds.forEach((k) => out.add(k));
    }
  }
  return out;
}

export interface DataModel {
  entities: DataEntity[];
  relations: EntityRelation[];
  /** Derived entity × use case links as `${entityId}|${useCaseId}` (cannot be removed; FR-160). */
  derivedLinks: Set<string>;
}

export const linkKey = (entityId: string, useCaseId: string) => `${entityId}|${useCaseId}`;

/**
 * FR-159 / FR-172: derive data entities from the pack (business-record kinds, entities typed 'data', and data
 * names referenced by issues / causes / solutions / flows) and from use cases; merge spelling variants by
 * normalized name; collect columns from the records' attributes.
 */
export function deriveDataModel(useCases: UseCase[], data: LoadedPack = loaded): DataModel {
  const entities: DataEntity[] = [];
  const byKey = new Map<string, DataEntity>();
  const add = (cand: DataEntity): DataEntity => {
    const existing = cand.keys.map((k) => byKey.get(k)).find(Boolean);
    if (existing) {
      existing.sourceIds = [...new Set([...existing.sourceIds, ...cand.sourceIds])];
      for (const c of cand.columns) if (!existing.columns.some((x) => x.name === c.name)) existing.columns.push(c);
      for (const k of cand.keys) if (!existing.keys.includes(k)) existing.keys.push(k);
      cand.keys.forEach((k) => byKey.set(k, existing));
      return existing;
    }
    entities.push(cand);
    cand.keys.forEach((k) => byKey.set(k, cand));
    return cand;
  };

  const records = data.pack.entities;
  const kindOf = new Map<EntityKind, DataEntity>();
  const kinds = new Set(records.map((e) => e.kind));
  const dataTyped = new Set(records.filter((e) => e.type === 'data').map((e) => e.kind));
  const flowKinds = new Set(data.pack.flows.flatMap((f) => [data.byId.get(f.source)?.kind, data.byId.get(f.target)?.kind]).filter(Boolean));
  for (const kind of kinds) {
    const spec = KIND_ENTITIES[kind];
    if (!spec && !dataTyped.has(kind)) continue;
    if (spec && !spec.always && !flowKinds.has(kind) && !dataTyped.has(kind)) continue;
    const ofKind = records.filter((e) => e.kind === kind);
    const columns = [...new Set(ofKind.flatMap((e) => Object.keys(e)))].filter((k) => !META_KEYS.has(k)).map((name) => ({ name, source: 'pack' as const }));
    const id = `de-${spec?.slug ?? kind}`;
    const name = spec?.name ?? l(kind, kind);
    const entity = add({ id, name, description: spec?.description ?? name, keys: keysOf(name, id), sourceIds: ofKind.map((e) => e.id), columns });
    kindOf.set(kind, entity);
  }

  const referrers = records.filter((e): e is Extract<Entity, { kind: 'issue' | 'cause' | 'solution' }> => e.kind === 'issue' || e.kind === 'cause' || e.kind === 'solution');
  const termEntity = new Map<string, DataEntity>();
  const coOccur: string[][] = [];
  const ensureTerm = (term: Term) => {
    let e = termEntity.get(term.slug);
    if (!e) {
      const id = `de-${term.slug}`;
      e = add({ id, name: term.name, description: term.description, keys: keysOf(term.name, id), sourceIds: [], columns: [] });
      termEntity.set(term.slug, e);
    }
    return e;
  };
  for (const r of referrers) {
    const found = TERMS.filter((t) => matches(t, textOf(r))).map(ensureTerm);
    found.forEach((e) => { if (!e.sourceIds.includes(r.id)) e.sourceIds.push(r.id); });
    coOccur.push(found.map((e) => e.id));
  }

  const derivedLinks = new Set<string>();
  for (const uc of useCases) {
    const texts = useCaseText(uc);
    const found = TERMS.filter((t) => matches(t, texts)).map(ensureTerm);
    coOccur.push(found.map((e) => e.id));
    found.forEach((e) => derivedLinks.add(linkKey(e.id, uc.id)));
    const related = expandRelated(uc, data);
    for (const e of entities) if (e.sourceIds.some((s) => related.has(s))) derivedLinks.add(linkKey(e.id, uc.id));
  }

  const rel = new Set<string>();
  const addRel = (a: string, b: string) => {
    if (a === b) return;
    rel.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  };
  for (const edge of data.edges) {
    const a = kindOf.get(data.byId.get(edge.source)?.kind as EntityKind);
    const b = kindOf.get(data.byId.get(edge.target)?.kind as EntityKind);
    if (a && b) addRel(a.id, b.id);
  }
  for (const group of coOccur) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) addRel(group[i]!, group[j]!);
  const relations = [...rel].map((k) => {
    const [a, b] = k.split('|') as [string, string];
    return { a, b };
  });
  return { entities, relations, derivedLinks };
}

export function totalColumns(entities: DataEntity[]): number {
  return entities.reduce((n, e) => n + e.columns.length, 0);
}

/** FR-171: beyond PARAM-055 entities or PARAM-056 columns, the viewer switches to the simplified display. */
export function isSimplified(entityCount: number, columnCount: number): boolean {
  return entityCount > VIEWER_MAX_ENTITIES || columnCount > VIEWER_MAX_COLUMNS;
}

export type Detail = 'clusters' | 'entities' | 'columns';
export const DETAILS: Detail[] = ['clusters', 'entities', 'columns'];
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 5;

/** Zoom → level of detail with hysteresis so the view does not flicker at a threshold (FR-169). */
export function detailFor(zoom: number, prev: Detail, simplified = false): Detail {
  const up = { entities: 1.5, columns: 3 };
  const down = { entities: 1.3, columns: 2.6 };
  let d: Detail;
  if (prev === 'columns') d = zoom >= down.columns ? 'columns' : zoom >= down.entities ? 'entities' : 'clusters';
  else if (prev === 'entities') d = zoom >= up.columns ? 'columns' : zoom >= down.entities ? 'entities' : 'clusters';
  else d = zoom >= up.columns ? 'columns' : zoom >= up.entities ? 'entities' : 'clusters';
  return simplified && d === 'columns' ? 'entities' : d;
}

/** A zoom that shows a given level (used by the level buttons and by persona defaults). */
export const ZOOM_FOR: Record<Detail, number> = { clusters: 1, entities: 2, columns: 3.5 };

export interface Cluster {
  id: string;
  /** null = entities without a use case / domain. */
  label: Localizable | null;
  entityIds: string[];
}

/** FR-169: clusters by use case (first linked use case) or by catalog domain. */
export function buildClusters(entities: DataEntity[], links: Set<string>, useCases: UseCase[], by: 'usecase' | 'domain'): Cluster[] {
  const clusters = new Map<string, Cluster>();
  const put = (id: string, label: Localizable | null, entityId: string) => {
    const c = clusters.get(id) ?? { id, label, entityIds: [] };
    c.entityIds.push(entityId);
    clusters.set(id, c);
  };
  for (const e of entities) {
    if (by === 'domain') {
      if (e.domain) put(`domain:${normalizeName(e.domain)}`, e.domain, e.id);
      else put('none', null, e.id);
      continue;
    }
    const uc = useCases.find((u) => links.has(linkKey(e.id, u.id)));
    if (uc) put(`uc:${uc.id}`, uc.name, e.id);
    else put('none', null, e.id);
  }
  return [...clusters.values()].sort((a, b) => (a.id === 'none' ? 1 : b.id === 'none' ? -1 : 0));
}
