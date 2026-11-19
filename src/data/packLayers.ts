/**
 * FR-346: a Project pack has two layers. The company layer (the customer's master data: who and where the company is)
 * is stored once per company and shared by all its projects; the project layer (transactions and the improvement
 * work) is stored per project. Screens read the composed pack, so `compose(company, project)` is what used to be the
 * whole pack. Pure functions; storage lives in packStore.ts.
 */

type Raw = Record<string, unknown>;
type RawEntity = Raw & { id: string; kind?: unknown };

/** Entity kinds that describe the company itself, independent of any project. They only reference each other and sources. */
export const COMPANY_KINDS = ['site', 'person', 'customer', 'product', 'supplier'] as const;
const companyKinds = new Set<string>(COMPANY_KINDS);

export interface CompanyLayer {
  format: 'bas-company-layer';
  company?: unknown;
  regions: Raw[];
  entities: RawEntity[];
  flows: Raw[];
  optimization?: unknown;
  brand?: unknown;
}

export type CompanyMergePolicy = 'keep' | 'incoming';

const isRecord = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const records = (v: unknown): Raw[] => arr(v).filter(isRecord);
const withId = (v: unknown): v is RawEntity => isRecord(v) && typeof v.id === 'string';
const flowKey = (f: Raw) => `${String(f.source)}->${String(f.target)}`;
const regionId = (r: Raw) => (typeof r.id === 'string' ? r.id : undefined);

export function isCompanyLayer(v: unknown): v is CompanyLayer {
  return isRecord(v) && v.format === 'bas-company-layer' && Array.isArray(v.entities);
}

/** Every id a value mentions (strings anywhere inside it, nested objects and arrays included), except `id` fields. */
function mentions(value: unknown, into: Set<string>) {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) value.forEach((x) => mentions(x, into));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) if (k !== 'id') mentions(v, into);
}

/** Splits a whole pack into its company layer and project layer. */
export function splitPack(pack: Raw): { company: CompanyLayer; project: Raw } {
  const entities = arr(pack.entities);
  const company = new Set<string>();
  const cited = new Set<string>();
  for (const e of entities) {
    if (withId(e) && companyKinds.has(String(e.kind))) {
      company.add(e.id);
      arr(e.sourceIds).forEach((s) => typeof s === 'string' && cited.add(s));
    }
  }
  const flows = records(pack.flows);
  for (const f of flows) arr(f.sourceIds).forEach((s) => typeof s === 'string' && cited.add(s));
  if (isRecord(pack.optimization)) arr(pack.optimization.sourceIds).forEach((s) => typeof s === 'string' && cited.add(s));
  // Sources cited by the company layer (and the sources those cite) belong to it, so the layer is self-contained.
  const byId = new Map(entities.filter(withId).map((e) => [e.id, e] as const));
  const queue = [...cited];
  while (queue.length) {
    const id = queue.pop()!;
    const e = byId.get(id);
    if (!e || e.kind !== 'source' || company.has(id)) continue;
    company.add(id);
    arr(e.sourceIds).forEach((s) => typeof s === 'string' && queue.push(s));
  }
  const extensions = isRecord(pack.extensions) ? pack.extensions : undefined;
  const { brand, ...otherExtensions } = extensions ?? {};
  const layer: CompanyLayer = {
    format: 'bas-company-layer',
    ...(pack.company !== undefined ? { company: pack.company } : {}),
    regions: records(pack.regions),
    entities: entities.filter((e): e is RawEntity => withId(e) && company.has(e.id)),
    flows,
    ...(pack.optimization !== undefined ? { optimization: pack.optimization } : {}),
    ...(brand !== undefined ? { brand } : {}),
  };
  const { optimization: _o, ...rest } = pack;
  const project: Raw = {
    ...rest,
    regions: [],
    entities: entities.filter((e) => !(withId(e) && company.has(e.id))),
    flows: [],
    ...(extensions ? { extensions: otherExtensions } : {}),
  };
  if (extensions && !Object.keys(otherExtensions).length) delete project.extensions;
  return { company: layer, project };
}

/**
 * The pack a project shows: the company layer plus the project layer. A project layer saved before the split may
 * still hold company data; the shared layer wins for the same id, and the rest is kept.
 */
export function composePack(company: CompanyLayer | null, project: Raw): Raw {
  if (!company) return project;
  const ids = new Set(company.entities.map((e) => e.id));
  const regionIds = new Set(company.regions.map(regionId));
  const flowKeys = new Set(company.flows.map(flowKey));
  const projectExtensions = isRecord(project.extensions) ? project.extensions : undefined;
  const brand = company.brand ?? projectExtensions?.brand;
  const extensions = projectExtensions || brand !== undefined ? { ...(projectExtensions ?? {}), ...(brand !== undefined ? { brand } : {}) } : undefined;
  const optimization = company.optimization ?? project.optimization;
  const { optimization: _o, extensions: _e, ...rest } = project;
  return {
    ...rest,
    company: company.company ?? project.company,
    regions: [...company.regions, ...records(project.regions).filter((r) => !regionIds.has(regionId(r)))],
    entities: [...company.entities, ...arr(project.entities).filter((e) => !(withId(e) && ids.has(e.id)))],
    flows: [...company.flows, ...records(project.flows).filter((f) => !flowKeys.has(flowKey(f)))],
    ...(optimization !== undefined ? { optimization } : {}),
    ...(extensions ? { extensions } : {}),
  };
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const nameOf = (e: Raw): string[] => (isRecord(e.name) ? [e.name.ja, e.name.en] : [e.name]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().toLowerCase());

export interface CompanyLayerDiff {
  /** Entities and regions only the incoming layer has (always added). */
  added: { id: string; kind: string }[];
  identical: number;
  /** Same id, different content: the merge policy decides. */
  differing: { id: string; kind: string }[];
  /** A new id whose kind and name match an existing entity: possibly the same thing under another id (never merged automatically). */
  possibleDuplicates: { id: string; existingId: string; kind: string }[];
  /** Flows, optimization input, brand or company name that differ. */
  differingOther: ('flows' | 'optimization' | 'brand' | 'company')[];
}

export function diffCompanyLayers(existing: CompanyLayer | null, incoming: CompanyLayer): CompanyLayerDiff {
  const diff: CompanyLayerDiff = { added: [], identical: 0, differing: [], possibleDuplicates: [], differingOther: [] };
  const old = new Map<string, Raw>([...(existing?.entities ?? []).map((e) => [e.id, e] as const)]);
  const oldRegions = new Map((existing?.regions ?? []).map((r) => [regionId(r), r] as const));
  for (const r of incoming.regions) {
    const id = regionId(r);
    if (!id) continue;
    const prev = oldRegions.get(id);
    if (!prev) diff.added.push({ id, kind: 'region' });
    else if (same(prev, r)) diff.identical++;
    else diff.differing.push({ id, kind: 'region' });
  }
  for (const e of incoming.entities) {
    const kind = String(e.kind);
    const prev = old.get(e.id);
    if (prev) {
      if (same(prev, e)) diff.identical++;
      else diff.differing.push({ id: e.id, kind });
      continue;
    }
    diff.added.push({ id: e.id, kind });
    const names = new Set(nameOf(e));
    const match = existing?.entities.find((x) => String(x.kind) === kind && nameOf(x).some((n) => names.has(n)));
    if (match) diff.possibleDuplicates.push({ id: e.id, existingId: match.id, kind });
  }
  if (existing) {
    const oldFlows = new Map(existing.flows.map((f) => [flowKey(f), f] as const));
    if (incoming.flows.some((f) => oldFlows.has(flowKey(f)) && !same(oldFlows.get(flowKey(f)), f))) diff.differingOther.push('flows');
    if (existing.optimization !== undefined && incoming.optimization !== undefined && !same(existing.optimization, incoming.optimization)) diff.differingOther.push('optimization');
    if (existing.brand !== undefined && incoming.brand !== undefined && !same(existing.brand, incoming.brand)) diff.differingOther.push('brand');
    if (existing.company !== undefined && incoming.company !== undefined && !same(existing.company, incoming.company)) diff.differingOther.push('company');
  }
  return diff;
}

/** Union of both layers. Nothing the existing layer has is removed (other projects may cite it); the policy decides same-id conflicts. */
export function mergeCompanyLayers(existing: CompanyLayer | null, incoming: CompanyLayer, policy: CompanyMergePolicy): CompanyLayer {
  if (!existing) return incoming;
  const pick = <T>(a: T | undefined, b: T | undefined): T | undefined => (policy === 'keep' ? a ?? b : b ?? a);
  const unionBy = <T extends Raw>(a: T[], b: T[], key: (x: T) => string | undefined): T[] => {
    const incomingByKey = new Map(b.map((x) => [key(x), x] as const));
    const out = a.map((x) => (policy === 'incoming' && incomingByKey.has(key(x)) ? incomingByKey.get(key(x))! : x));
    const have = new Set(a.map(key));
    return [...out, ...b.filter((x) => !have.has(key(x)))];
  };
  const company = pick(existing.company, incoming.company);
  const optimization = pick(existing.optimization, incoming.optimization);
  const brand = pick(existing.brand, incoming.brand);
  return {
    format: 'bas-company-layer',
    ...(company !== undefined ? { company } : {}),
    regions: unionBy(existing.regions, incoming.regions, regionId),
    entities: unionBy(existing.entities, incoming.entities, (e) => e.id),
    flows: unionBy(existing.flows, incoming.flows, flowKey),
    ...(optimization !== undefined ? { optimization } : {}),
    ...(brand !== undefined ? { brand } : {}),
  };
}

/** Ids (entities and regions) the old layer had that the new one lacks. */
export function removedIds(before: CompanyLayer | null, after: CompanyLayer): string[] {
  if (!before) return [];
  const now = new Set<string | undefined>([...after.entities.map((e) => e.id), ...after.regions.map(regionId)]);
  return [...before.entities.map((e) => e.id), ...before.regions.map(regionId)].filter((id): id is string => !!id && !now.has(id));
}

/** Which of `ids` a project layer still points at (entity fields, flows, optimization). */
export function referencedIn(project: Raw, ids: string[]): string[] {
  if (!ids.length) return [];
  const seen = new Set<string>();
  // A layer saved before the split may still hold its own copy, which then needs nothing shared.
  const own = new Set([...records(project.entities), ...records(project.regions)].map((x) => x.id));
  for (const e of records(project.entities)) mentions(e, seen);
  for (const f of records(project.flows)) mentions(f, seen);
  if (isRecord(project.optimization)) mentions(project.optimization, seen);
  if (isRecord(project.extensions)) mentions(project.extensions, seen);
  return ids.filter((id) => seen.has(id) && !own.has(id));
}
