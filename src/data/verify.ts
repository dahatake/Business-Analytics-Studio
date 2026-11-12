import { z } from 'zod';
import { CustomerPack, Entity, type EntityKind } from './schema.ts';
import { parseBrand } from '../modules/ops/brand.ts';
import { CONTRAST_TEXT, contrastRatio, ensureContrast, isHex, LIGHT_BG, normalizeHex } from '../modules/ops/color.ts';
import { CollectionReport, COLLECTION_SECTIONS, collectionPresence } from './collection.ts';
import { ArchitectureExtension, CoreObjectExtension, EngagementsExtension, GlossarySchema, hasEngagementContext, OkrExtension, WorkflowExtension } from './extensionSchemas.ts';
import { GraphExtensionSchema, parseGraphExtension } from '../modules/graph/extensions.ts';
import { PackCatalog } from '../modules/usecases/catalogSchema.ts';
import { CompanyAnchorVersionSchema, anchorEvidenceChecks, anchorFreshness } from './companyAnchor.ts';
import { CompanyAlignmentSnapshotSchema, assessAlignment } from '../modules/project/companyAlignment.ts';

/**
 * FR-127 / FR-303 verify: acceptance check of a customer pack. Pure (no file access) so the CLI, build's self-correction
 * and the in-app import (FR-302) run the same rules.
 * Every problem carries a cause and the next action. FR-102 partial disabling itself lives in src/data/pack.ts.
 */
export type ProblemCode =
  | 'PARSE' | 'SCHEMA' | 'ENTITY_SCHEMA' | 'DUPLICATE_ID' | 'DANGLING_REF' | 'MISSING_SOURCE' | 'SOURCE_KIND'
  | 'BRAND_SCHEMA' | 'BRAND_CONTRAST' | 'INTERNAL' | 'EXTENSION_SCHEMA' | 'COLLECTION' | 'OPTIMIZATION';

export interface Problem {
  severity: 'error' | 'warning';
  code: ProblemCode;
  /** JSON path, e.g. entities[3].sourceIds */
  path: string;
  /** Entity id when the problem belongs to one entity. */
  entityId?: string;
  /** Set when the problem disappears once another (disabled) item is fixed. */
  dependsOn?: string;
  cause: string;
  action: string;
}

export interface VerifyResult {
  ok: boolean;
  problems: Problem[];
  stats: { entities: number; validEntities: number; internal: number; elapsedMs: number };
}

/** FR-115: fields holding numeric facts that need a source. Scores and coordinates of a site are included. */
export const NUMERIC_FACTS: Partial<Record<EntityKind, string[]>> = {
  site: ['capacityTPerMonth', 'lat', 'lon'],
  product: ['unitPriceJpy'],
  deal: ['valueJpy'],
  invoice: ['amountJpy'],
  issue: ['impact', 'feasibility'],
  solution: ['costJpy', 'annualBenefitJpy'],
  kpi: ['baseline', 'current', 'target'],
  initiative: ['progress'],
};

/** FR-114: reference fields and the kinds they must point to. */
export const REFERENCES: Partial<Record<EntityKind, Record<string, EntityKind[]>>> = {
  person: { siteId: ['site'] },
  product: { siteId: ['site'] },
  deal: { customerId: ['customer'], productIds: ['product'], ownerId: ['person'] },
  deliverable: { dealId: ['deal'] },
  invoice: { deliverableId: ['deliverable'] },
  issue: { causeIds: ['cause'], kpiIds: ['kpi'] },
  solution: { issueIds: ['issue'], kpiIds: ['kpi'] },
  kpi: { ownerId: ['person'] },
  initiative: { solutionId: ['solution'], dependsOn: ['initiative'], ownerId: ['person'] },
};

const zodIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

export function verifyPack(raw: unknown): VerifyResult {
  const t0 = performance.now();
  const problems: Problem[] = [];
  const add = (p: Problem) => problems.push(p);
  const done = (entities = 0, validEntities = 0, internal = 0): VerifyResult => ({
    ok: !problems.some((p) => p.severity === 'error'),
    problems,
    stats: { entities, validEntities, internal, elapsedMs: Math.round(performance.now() - t0) },
  });

  const shell = CustomerPack.omit({ entities: true }).extend({ entities: z.array(z.unknown()) }).safeParse(raw);
  if (!shell.success) {
    for (const i of shell.error.issues) {
      add({
        severity: 'error', code: 'SCHEMA', path: i.path.join('.') || '(root)', cause: i.message,
        action: 'Fix this top-level field (see docs/pack.schema.json). The app cannot load this pack and starts with the built-in sample.',
      });
    }
    return done();
  }
  const pack = shell.data;
  const valid: Entity[] = [];
  const indexOf = new Map<string, number>();
  const disabled = new Map<string, number>();
  pack.entities.forEach((candidate, index) => {
    const r = Entity.safeParse(candidate);
    const id = typeof (candidate as { id?: unknown })?.id === 'string' ? (candidate as { id: string }).id : undefined;
    if (!r.success) {
      if (id) disabled.set(id, index);
      add({
        severity: 'error', code: 'ENTITY_SCHEMA', path: `entities[${index}]`, ...(id ? { entityId: id } : {}), cause: zodIssues(r.error),
        action: 'Fix the listed fields. Until then the app disables only this item (FR-102); `bas build` self-correction can fill missing languages, ids and labels.',
      });
      return;
    }
    if (indexOf.has(r.data.id)) {
      add({
        severity: 'error', code: 'DUPLICATE_ID', path: `entities[${index}].id`, entityId: r.data.id,
        cause: `id "${r.data.id}" is already used by entities[${indexOf.get(r.data.id)}] (FR-114: ids must be unique).`,
        action: 'Give this item a unique id and update the references that mean it.',
      });
      return;
    }
    indexOf.set(r.data.id, index);
    valid.push(r.data);
  });
  const byId = new Map(valid.map((e) => [e.id, e] as const));
  const regionIds = new Set(pack.regions.map((r) => r.id));
  const checkSources = (ids: string[] | undefined, path: string) => {
    if (!ids?.length) {
      add({ severity: 'warning', code: 'MISSING_SOURCE', path, cause: 'Numeric pack data has no sourceIds (legacy packs remain supported).', action: 'Collect the source ids for these numeric facts; do not invent them.' });
    }
    ids?.forEach((id, i) => {
      if (byId.get(id)?.kind !== 'source') add({ severity: 'error', code: 'SOURCE_KIND', path: `${path}[${i}]`, cause: `"${id}" is not an existing source.`, action: 'Use an existing source entity id.' });
    });
  };
  const seenRegions = new Set<string>();
  pack.regions.forEach((r, i) => {
    if (seenRegions.has(r.id) || byId.has(r.id)) add({ severity: 'error', code: 'DUPLICATE_ID', path: `regions[${i}].id`, cause: `Region id "${r.id}" is not unique across regions and entities.`, action: 'Give each region a unique id and update references.' });
    seenRegions.add(r.id);
  });

  for (const e of valid) {
    const i = indexOf.get(e.id)!;
    if (e.kind === 'source' && e.origin !== undefined) {
      if (!e.accessedDate || (e.origin === 'web' ? !e.url : !e.locator)) add({
        severity: 'error', code: 'ENTITY_SCHEMA', path: `entities[${i}]`, entityId: e.id,
        cause: 'A collected source needs accessedDate and a web URL or M365 locator.',
        action: 'Keep the actual source URL/location and access date. Do not invent a publication date.',
      });
    }
    const rec = e as unknown as Record<string, unknown>;
    for (const [field, kinds] of Object.entries(REFERENCES[e.kind] ?? {})) {
      const value = rec[field];
      const ids = Array.isArray(value) ? (value as string[]) : [value as string];
      ids.forEach((ref, j) => {
        const target = byId.get(ref);
        const path = Array.isArray(value) ? `entities[${i}].${field}[${j}]` : `entities[${i}].${field}`;
        if (!target) {
          add({ severity: 'error', code: 'DANGLING_REF', path, entityId: e.id, ...(disabled.has(ref) ? { dependsOn: `entities[${disabled.get(ref)}]` } : {}), cause: disabled.has(ref) ? `"${ref}" is entities[${disabled.get(ref)}], which is disabled by its own error.` : `"${ref}" does not exist in this pack.`, action: disabled.has(ref) ? `Fix entities[${disabled.get(ref)}] first; this reference then resolves.` : `Point ${field} to an existing ${kinds.join('/')} id, or remove the reference.` });
        } else if (!kinds.includes(target.kind)) {
          add({ severity: 'error', code: 'DANGLING_REF', path, entityId: e.id, cause: `"${ref}" is a ${target.kind}, but ${field} needs a ${kinds.join('/')}.`, action: `Point ${field} to a ${kinds.join('/')} id.` });
        }
      });
    }
    if ((e.kind === 'customer' || e.kind === 'supplier') && !regionIds.has(e.regionId)) {
      add({ severity: 'error', code: 'DANGLING_REF', path: `entities[${i}].regionId`, entityId: e.id, cause: `region "${e.regionId}" is not in regions.`, action: 'Add the region to regions or use an existing region id.' });
    }
    e.sourceIds.forEach((s, j) => {
      const src = byId.get(s);
      if (!src) add({ severity: 'error', code: 'DANGLING_REF', path: `entities[${i}].sourceIds[${j}]`, entityId: e.id, cause: `source "${s}" does not exist.`, action: 'Add the source entity or remove the id.' });
      else if (src.kind !== 'source') add({ severity: 'error', code: 'SOURCE_KIND', path: `entities[${i}].sourceIds[${j}]`, entityId: e.id, cause: `"${s}" is a ${src.kind}, not a source.`, action: 'sourceIds may only point to entities of kind "source".' });
    });
    const facts = NUMERIC_FACTS[e.kind];
    if (facts && e.sourceIds.length === 0) {
      add({
        severity: 'error', code: 'MISSING_SOURCE', path: `entities[${i}].sourceIds`, entityId: e.id,
        cause: `numeric values (${facts.join(', ')}) have no source (FR-115).`,
        action: 'Add the id of the source entity the numbers come from (research cache, report, or "sample").',
      });
    }
    if (e.classification === 'internal') {
      add({
        severity: 'warning', code: 'INTERNAL', path: `entities[${i}]`, entityId: e.id,
        cause: 'classified internal (FR-117).',
        action: 'Hidden for an external audience and never sent to Foundry (C-03). Change to shareable only if the customer may see it.',
      });
    }
  }
  pack.flows.forEach((f, j) => {
    checkSources(f.sourceIds, `flows[${j}].sourceIds`);
    for (const end of ['source', 'target'] as const) {
      const entity = byId.get(f[end]);
      if (!regionIds.has(f[end]) && (!entity || !['supplier', 'site', 'customer'].includes(entity.kind))) add({ severity: 'error', code: 'DANGLING_REF', path: `flows[${j}].${end}`, cause: `"${f[end]}" is not a supplier/site/customer/region.`, action: 'Use an existing supplier/site/customer/region id or remove the flow.' });
    }
  });
  const opt = pack.optimization;
  if (opt) {
    checkSources(opt.sourceIds, 'optimization.sourceIds');
    const plants = new Set<string>();
    opt.plants.forEach((p, j) => {
      const site = byId.get(p.siteId);
      if (site?.kind !== 'site' || site.role !== 'plant') add({ severity: 'error', code: 'DANGLING_REF', path: `optimization.plants[${j}].siteId`, cause: `"${p.siteId}" is not a plant site.`, action: 'Use the id of an existing plant site.' });
      if (plants.has(p.siteId)) add({ severity: 'error', code: 'OPTIMIZATION', path: `optimization.plants[${j}]`, cause: 'Duplicate plant.', action: 'List each plant once.' });
      plants.add(p.siteId);
    });
    if (opt.regionDemandT.length !== pack.regions.length) add({ severity: 'error', code: 'OPTIMIZATION', path: 'optimization.regionDemandT', cause: 'Demand length differs from regions length.', action: 'Use exactly one demand per region, in regions order.' });
    for (const key of ['transportCostPerT', 'leadTimeDays', 'co2TransportPerT', 'currentAllocation'] as const) {
      if (opt[key].length !== opt.plants.length || opt[key].some((row) => row.length !== pack.regions.length)) add({ severity: 'error', code: 'OPTIMIZATION', path: `optimization.${key}`, cause: 'Matrix dimensions differ from plants × regions.', action: 'Supply one row per plant and one column per region in the same order.' });
    }
  }

  const extensionSchemas = {
    glossary: GlossarySchema, dataCatalog: PackCatalog, graph: GraphExtensionSchema,
    architecture: ArchitectureExtension, coreObject: CoreObjectExtension, collection: CollectionReport,
    workflow: WorkflowExtension, okr: OkrExtension, engagements: EngagementsExtension,
    companyAnchor: CompanyAnchorVersionSchema,
    companyAlignment: CompanyAlignmentSnapshotSchema,
  };
  for (const [key, schema] of Object.entries(extensionSchemas)) {
    const raw = pack.extensions?.[key];
    if (raw === undefined) continue;
    const result = schema.safeParse(raw);
    if (!result.success) add({ severity: 'error', code: 'EXTENSION_SCHEMA', path: `extensions.${key}`, cause: zodIssues(result.error), action: 'Fix this extension using its documented structure; the screen would otherwise ignore invalid data.' });
  }
  const sourceRefs = (ids: string[] | undefined, path: string) => ids?.forEach((id, i) => {
    if (byId.get(id)?.kind !== 'source') add({ severity: 'error', code: 'SOURCE_KIND', path: `${path}[${i}]`, cause: `"${id}" is not an existing source.`, action: 'Use an existing source entity id.' });
  });
  const companyAnchor = CompanyAnchorVersionSchema.safeParse(pack.extensions?.companyAnchor);
  const alignment = CompanyAlignmentSnapshotSchema.safeParse(pack.extensions?.companyAlignment);
  if (alignment.success && !companyAnchor.success) add({
    severity: 'error', code: 'EXTENSION_SCHEMA', path: 'extensions.companyAlignment',
    cause: 'An alignment snapshot needs its company anchor snapshot.',
    action: 'Include the company anchor used for the assessment.',
  });
  if (companyAnchor.success) {
    const checks = anchorEvidenceChecks(companyAnchor.data.anchor);
    for (const result of checks.filter((entry) => entry.missing.length)) add({
      severity: 'warning', code: 'MISSING_SOURCE', path: `extensions.companyAnchor.anchor.${result.path}`,
      cause: `The supplied excerpt does not contain: ${result.missing.join(', ')}.`,
      action: 'Compare the value, metric, period, unit and scope against the original source; an excerpt match alone is not proof.',
    });
    const freshness = anchorFreshness(companyAnchor.data.anchor, new Date());
    if (freshness.stale || freshness.future) add({
      severity: 'warning', code: 'EXTENSION_SCHEMA', path: 'extensions.companyAnchor.anchor.asOf',
      cause: 'The company analysis is in the future, older than 30 days, or has a later refresh event.',
      action: 'Review the company analysis before relying on it.',
    });
    add({
      severity: 'warning', code: 'INTERNAL', path: 'extensions.companyAnchor',
      cause: 'The company analysis snapshot can contain internal sources, hypotheses and project records.',
      action: 'Do not share this raw pack without reviewing the snapshot and obtaining the data owner’s permission.',
    });
  }
  if (alignment.success && companyAnchor.success) {
    const sourceIds = valid.filter((entity) => entity.kind === 'source').map((entity) => entity.id);
    if (!alignment.data.alignments.length) add({
      severity: 'warning', code: 'EXTENSION_SCHEMA', path: 'extensions.companyAlignment.alignments',
      cause: 'The project has no alignment assessment.',
      action: 'Ask the customer sponsor how the project supports an objective or obligation; generation is not blocked.',
    });
    alignment.data.alignments.forEach((item, index) => {
      const result = assessAlignment(alignment.data.projectPurpose, companyAnchor.data, item, sourceIds);
      if (result.issues.length || result.outdated || item.status === 'draft' || result.kind === 'unaligned') add({
        severity: 'warning', code: 'EXTENSION_SCHEMA', path: `extensions.companyAlignment.alignments[${index}]`,
        cause: `Alignment needs review: ${[...result.issues, ...(result.outdated ? ['outdated'] : []), ...(item.status === 'draft' ? ['draft'] : []), ...(result.kind === 'unaligned' ? ['unaligned'] : [])].join(', ')}.`,
        action: 'Review the evidence and company version with the customer; this warning does not block the pack.',
      });
    });
  }
  const workflow = WorkflowExtension.safeParse(pack.extensions?.workflow);
  if (workflow.success) {
    const stageIds = new Set(workflow.data.stages.map((s) => s.id));
    workflow.data.stages.forEach((s, i) => {
      s.next.forEach((n, j) => {
        if (!stageIds.has(n)) add({ severity: 'error', code: 'DANGLING_REF', path: `extensions.workflow.stages[${i}].next[${j}]`, cause: `"${n}" is not a stage id.`, action: 'Point next at an existing stage id, or name the team in handoffTo.' });
      });
      sourceRefs(s.sourceIds, `extensions.workflow.stages[${i}].sourceIds`);
    });
  }
  const okr = OkrExtension.safeParse(pack.extensions?.okr);
  if (okr.success) {
    okr.data.kpis.forEach((k, i) => sourceRefs(k.sourceIds, `extensions.okr.kpis[${i}].sourceIds`));
    okr.data.objectives.forEach((o, i) => sourceRefs(o.sourceIds, `extensions.okr.objectives[${i}].sourceIds`));
  }
  const engagements = EngagementsExtension.safeParse(pack.extensions?.engagements);
  if (engagements.success) {
    const ids = new Set<string>();
    const names = valid.filter((e) => ['deal', 'deliverable', 'initiative'].includes(e.kind))
      .flatMap((e) => [e.name.ja.trim().toLowerCase(), e.name.en.trim().toLowerCase()]);
    engagements.data.items.forEach((item, i) => {
      const path = `extensions.engagements.items[${i}]`;
      if (ids.has(item.id) || byId.has(item.id)) add({ severity: 'error', code: 'DUPLICATE_ID', path: `${path}.id`, cause: `Engagement id "${item.id}" is not unique.`, action: 'Use a unique engagement id.' });
      ids.add(item.id);
      if (!hasEngagementContext(item)) add({ severity: 'error', code: 'EXTENSION_SCHEMA', path, cause: 'An engagement needs a period, customer or status as well as its name.', action: 'Use context stated in the material, or remove only this item. Do not invent values.' });
      if (item.customerId && byId.get(item.customerId)?.kind !== 'customer') add({ severity: 'error', code: 'DANGLING_REF', path: `${path}.customerId`, cause: `"${item.customerId}" is not an existing customer.`, action: 'Use an existing customer id, or omit customerId and keep the customer text from the material.' });
      sourceRefs(item.sourceIds, `${path}.sourceIds`);
      const itemNames = typeof item.name === 'string' ? [item.name] : [item.name.ja, item.name.en];
      if (itemNames.some((name) => names.includes(name.trim().toLowerCase()))) add({ severity: 'warning', code: 'EXTENSION_SCHEMA', path, cause: 'An engagement has the same name as a deal, deliverable or initiative.', action: 'Check the source and keep the same work in only one representation.' });
    });
    if (engagements.data.items.length) add({ severity: 'warning', code: 'INTERNAL', path: 'extensions.engagements', cause: 'Engagement records are internal.', action: 'Hidden for an external audience. Review sources before sharing the pack.' });
  }
  for (const issue of parseGraphExtension(pack.extensions?.graph, new Set(byId.keys())).issues) {
    add({ severity: 'error', code: 'EXTENSION_SCHEMA', path: 'extensions.graph', cause: issue, action: 'Fix the graph section and reference existing entities.' });
  }
  const report = CollectionReport.safeParse(pack.extensions?.collection);
  if (report.success) {
    const presence = collectionPresence({ ...pack, entities: valid });
    const seen = new Set<string>();
    report.data.sections.forEach((section, i) => {
      const path = `extensions.collection.sections[${i}]`;
      if (seen.has(section.key)) add({ severity: 'error', code: 'COLLECTION', path, cause: 'Duplicate collection section.', action: 'Report each section exactly once.' });
      seen.add(section.key);
      if (section.status === 'complete' && (!presence[section.key] || section.missingFields.length > 0 || section.sourceIds.length === 0)) add({ severity: 'error', code: 'COLLECTION', path, cause: 'A complete section needs data, sources and no missingFields.', action: 'Use partial/unavailable and list missing fields instead of claiming completeness.' });
      section.sourceIds.forEach((id) => {
        if (byId.get(id)?.kind !== 'source') add({ severity: 'error', code: 'SOURCE_KIND', path: `${path}.sourceIds`, cause: `"${id}" is not an existing source.`, action: 'Use an existing source entity id.' });
      });
    });
    for (const key of COLLECTION_SECTIONS) {
      if (!seen.has(key)) add({ severity: 'error', code: 'COLLECTION', path: 'extensions.collection.sections', cause: `Collection section "${key}" is missing.`, action: 'Report every section, including unavailable and notApplicable sections.' });
    }
  }

  const brand = parseBrand(pack.extensions);
  if (!brand.ok) {
    add({ severity: 'error', code: 'BRAND_SCHEMA', path: 'extensions.brand', cause: brand.issues.join('; '), action: 'Fix the brand profile, or remove it to use the default theme (FR-122). The app uses the default theme meanwhile.' });
  } else if (brand.profile) {
    const p = normalizeHex(brand.profile.primary);
    const ratio = contrastRatio(p, LIGHT_BG);
    const fg = brand.profile.foreground && isHex(brand.profile.foreground) ? normalizeHex(brand.profile.foreground) : null;
    const fgOk = fg !== null && contrastRatio(fg, LIGHT_BG) >= CONTRAST_TEXT;
    if (ratio < CONTRAST_TEXT && !fgOk) {
      add({
        severity: 'error', code: 'BRAND_CONTRAST', path: 'extensions.brand.primary',
        cause: `primary ${p} has ${ratio.toFixed(2)}:1 against ${LIGHT_BG} (needs ${CONTRAST_TEXT}:1, PARAM-018)${fg ? `; foreground ${fg} also fails` : ''}.`,
        action: `Set extensions.brand.foreground to a darker brand colour such as ${ensureContrast(p, LIGHT_BG, CONTRAST_TEXT)} (the app applies this correction automatically, FR-060).`,
      });
    }
  }
  return done(pack.entities.length, valid.length, valid.filter((e) => e.classification === 'internal').length);
}

export function formatProblem(p: Problem): string {
  const tag = p.severity === 'error' ? 'ERROR' : 'WARN ';
  return `[${tag}] ${p.code} at ${p.path}${p.entityId ? ` (${p.entityId})` : ''}\n        cause:  ${p.cause}\n        action: ${p.action}`;
}
