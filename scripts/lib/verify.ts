import { z } from 'zod';
import { CustomerPack, Entity, type EntityKind } from '../../src/data/schema.ts';
import { parseBrand } from '../../src/modules/ops/brand.ts';
import { CONTRAST_TEXT, contrastRatio, ensureContrast, isHex, LIGHT_BG, normalizeHex } from '../../src/modules/ops/color.ts';

/**
 * FR-127 verify: acceptance check of a customer pack. Pure (no file access) so build's self-correction can reuse it.
 * Every problem carries a cause and the next action. FR-102 partial disabling itself lives in src/data/pack.ts.
 */
export type ProblemCode =
  | 'PARSE' | 'SCHEMA' | 'ENTITY_SCHEMA' | 'DUPLICATE_ID' | 'DANGLING_REF' | 'MISSING_SOURCE' | 'SOURCE_KIND'
  | 'BRAND_SCHEMA' | 'BRAND_CONTRAST' | 'INTERNAL';

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

  for (const e of valid) {
    const i = indexOf.get(e.id)!;
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
    for (const end of ['source', 'target'] as const) {
      if (!byId.has(f[end]) && !regionIds.has(f[end])) add({ severity: 'error', code: 'DANGLING_REF', path: `flows[${j}].${end}`, cause: `"${f[end]}" does not exist.`, action: 'Use an existing supplier/site/customer/region id or remove the flow.' });
    }
  });
  pack.optimization.plants.forEach((p, j) => {
    if (byId.get(p.siteId)?.kind !== 'site') add({ severity: 'error', code: 'DANGLING_REF', path: `optimization.plants[${j}].siteId`, cause: `"${p.siteId}" is not a site.`, action: 'Use the id of an existing plant site.' });
  });

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
