import { z } from 'zod';
import { appStorage as localStorage } from '../../data/deviceStorage.ts';
import { attachmentHashesIn, readAttachment, restoreAttachment, type StoredAttachment } from '../../state/attachments.ts';
import { MEDIA_TYPES, TEXT_TYPES } from '../../ai/attachments.ts';
import { CompanyAnchorDocumentSchema } from '../../data/companyAnchor.ts';
import { companyAnchorKey, readCompanyAnchorDocument, restoreCompanyAnchorDocument } from '../../state/companyAnchors.ts';
import { AlignmentSchema } from './companyAlignment.ts';
import { LText } from '../../data/schema.ts';
import { loadPack } from '../../data/pack.ts';
import { composePack, diffCompanyLayers, type CompanyLayer, type CompanyLayerDiff, type CompanyMergePolicy } from '../../data/packLayers.ts';
import {
  deleteImportedPack, importedPackMeta, loadCompanyLayer, loadProjectLayer, mergeIntoCompanyLayer, restoreCompanyLayer, saveImportedPack,
} from '../../data/packStore.ts';
import {
  MAX_PROJECTS_PER_COMPANY, RELATION_KINDS, SCOPE_PREFIX, scopedKey, useProjects, IMPROVEMENT_STEPS, migrateStep, type Company, type Project, type ProjectRelation,
} from '../../state/projects.ts';

const Brief = z.object({
  purpose: z.string().optional(),
  focus: z.string().optional(),
  orgUnit: z.string().optional(),
  asOf: z.string().optional(),
  researchNote: z.string().optional(),
  useNews: z.boolean().optional(),
  publicWebTopic: z.string().optional(),
  useWorkIq: z.boolean().optional(),
  workIqRounds: z.number().int().optional(),
  materialNames: z.array(z.string()).optional(),
});

const CompanyFields = z.object({
  id: z.string().min(1), name: z.string().min(1), createdAt: z.string(),
  officialUrl: z.string().optional(), industry: z.string().optional(), notes: z.string().optional(),
  anchorRef: z.object({ key: z.string(), version: z.number().int().positive(), asOf: z.iso.date() }).optional(),
});
const ProjectFields = z.object({
  id: z.string().min(1), companyId: z.string().min(1), name: z.string().min(1), createdAt: z.string(), step: z.preprocess(migrateStep, z.enum(IMPROVEMENT_STEPS)), brief: Brief.optional(),
  alignments: z.array(AlignmentSchema).optional(),
  mergedFrom: z.array(z.object({
    name: z.string(), createdAt: z.string(), mergedAt: z.string(), brief: Brief.optional(), reasons: z.array(z.string()), score: z.number(), hadPack: z.boolean(),
    alignments: z.array(AlignmentSchema).optional(),
  })).optional(),
});
/** Relations of this project to other projects of the company; restored only where the other project exists. */
const Relations = z.array(z.object({
  id: z.string().min(1), companyId: z.string().min(1), from: z.string().min(1), to: z.string().min(1), kind: z.enum(RELATION_KINDS), note: z.string().optional(), createdAt: z.string(),
}));
/** Scoped store name → stored value (all modules' project data). */
const ScopedData = z.record(z.string(), z.unknown());
/** Attached files the data cites (`attachment:sha256:<hash>`), keyed by hash; verified again on import. */
const Attachments = z.record(z.string().regex(/^[0-9a-f]{64}$/), z.object({
  name: z.string().min(1), mimeType: z.enum([...MEDIA_TYPES, ...TEXT_TYPES]), size: z.number().int().positive(), data: z.string(), addedAt: z.string(),
}));
const RawRecord = z.record(z.string(), z.unknown());
/** The project's own pack layer; list fields must be lists, or composing would silently drop them. */
const ProjectLayerSchema = z.looseObject({
  entities: z.array(z.unknown()).optional(), regions: z.array(z.unknown()).optional(), flows: z.array(z.unknown()).optional(),
});
const CompanyLayerSchema = z.object({
  format: z.literal('bas-company-layer'),
  company: z.unknown().optional(),
  regions: z.array(RawRecord),
  entities: z.array(z.looseObject({ id: z.string().min(1) })),
  flows: z.array(RawRecord),
  optimization: z.unknown().optional(),
  brand: z.unknown().optional(),
});

function checkAnchor(company: z.infer<typeof CompanyFields>, anchor: z.infer<typeof CompanyAnchorDocumentSchema> | undefined, anchorPath: string[], ctx: z.RefinementCtx) {
  if (anchor && anchor.companyId !== company.id) ctx.addIssue({ code: 'custom', path: [...anchorPath, 'companyId'], message: 'Company id does not match' });
  if (anchor && !company.anchorRef) ctx.addIssue({ code: 'custom', path: ['company', 'anchorRef'], message: 'Company anchor reference is missing' });
  if (company.anchorRef && (!anchor || company.anchorRef.key !== companyAnchorKey(company.id)
    || company.anchorRef.version !== anchor.versions.at(-1)?.version
    || company.anchorRef.asOf !== anchor.versions.at(-1)?.anchor.asOf)) {
    ctx.addIssue({ code: 'custom', path: ['company', 'anchorRef'], message: 'Company anchor reference does not match its document' });
  }
}

/** FR-139 (MAY), superseded by the Project pack (FR-342): still accepted on import. */
export const ProjectFileSchema = z.object({
  format: z.literal('bas-project'),
  version: z.literal(1),
  company: CompanyFields,
  project: ProjectFields,
  relations: Relations.optional(),
  data: ScopedData,
  attachments: Attachments.optional(),
  companyAnchor: CompanyAnchorDocumentSchema.optional(),
}).superRefine((file, ctx) => {
  if (file.project.companyId !== file.company.id) ctx.addIssue({ code: 'custom', path: ['project', 'companyId'], message: 'Company id does not match' });
  checkAnchor(file.company, file.companyAnchor, ['companyAnchor'], ctx);
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/**
 * FR-342: a Project pack file. The hierarchy is explicit: the company (with its anchor and the company layer shared by
 * all its projects) contains the project (inputs, scoped data, relations and the project's own pack layer). The
 * project's pack is `composePack(company.shared, project.pack.layer)`.
 */
export const ProjectPackFileSchema = z.object({
  format: z.literal('bas-project-pack'),
  version: z.literal(1),
  exportedAt: z.string(),
  company: CompanyFields.extend({
    anchor: CompanyAnchorDocumentSchema.optional(),
    shared: CompanyLayerSchema.optional(),
  }),
  project: ProjectFields.extend({
    relations: Relations.optional(),
    data: ScopedData,
    pack: z.object({
      packId: z.string().min(1), company: z.object({ name: LText, industry: LText }), isSample: z.boolean(),
      entities: z.number().int().nonnegative(), importedAt: z.string(), files: z.array(z.string()),
      layer: ProjectLayerSchema,
    }).optional(),
  }),
  attachments: Attachments.optional(),
}).superRefine((file, ctx) => {
  if (file.project.companyId !== file.company.id) ctx.addIssue({ code: 'custom', path: ['project', 'companyId'], message: 'Company id does not match' });
  checkAnchor(file.company, file.company.anchor, ['company', 'anchor'], ctx);
});
export type ProjectPackFile = z.infer<typeof ProjectPackFileSchema>;

const companyOnly = ({ id, name, createdAt, officialUrl, industry, notes, anchorRef }: Company) => ({
  id, name, createdAt, ...(officialUrl ? { officialUrl } : {}), ...(industry ? { industry } : {}), ...(notes ? { notes } : {}), ...(anchorRef ? { anchorRef } : {}),
});

/** FR-342: the project with its company — both layers of the pack, every scoped store, the company anchor and cited files. */
export async function exportProjectPack(projectId: string): Promise<ProjectPackFile | null> {
  const s = useProjects.getState();
  const project = s.projects.find((p) => p.id === projectId);
  const company = project ? s.companies.find((c) => c.id === project.companyId) : undefined;
  if (!project || !company) return null;
  const prefix = `${SCOPE_PREFIX}${projectId}.`;
  const data: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(prefix)) continue;
    try {
      data[k.slice(prefix.length)] = JSON.parse(localStorage.getItem(k) ?? 'null');
    } catch {
      // Unreadable values are skipped rather than exported broken.
    }
  }
  const relations = s.relations.filter((r) => r.from === projectId || r.to === projectId);
  const anchor = readCompanyAnchorDocument(company.id);
  const shared = await loadCompanyLayer(company.id);
  const meta = importedPackMeta(projectId);
  const layer = meta ? await loadProjectLayer(projectId) : null;
  const pack = meta && layer && typeof layer === 'object' && !Array.isArray(layer)
    ? { packId: meta.packId, company: meta.company, isSample: meta.isSample, entities: meta.entities, importedAt: meta.importedAt, files: meta.files, layer: layer as Record<string, unknown> }
    : undefined;
  const attachments = exportedAttachments([data, shared, layer]);
  return {
    format: 'bas-project-pack',
    version: 1,
    exportedAt: new Date().toISOString(),
    company: { ...companyOnly(company), ...(anchor ? { anchor } : {}), ...(shared ? { shared } : {}) },
    project: { ...project, ...(relations.length ? { relations } : {}), data, ...(pack ? { pack } : {}) },
    ...(Object.keys(attachments).length ? { attachments } : {}),
  };
}

/** Files cited by the project's stores and by both pack layers (the bytes live in the device binary store). */
function exportedAttachments(values: unknown[]): Record<string, StoredAttachment> {
  const out: Record<string, StoredAttachment> = {};
  for (const hash of attachmentHashesIn(values)) {
    const stored = readAttachment(hash);
    if (stored) out[hash] = stored;
  }
  return out;
}

/** A `bas-project` v1 file (no pack inside) read as a Project pack. */
function fromV1(file: ProjectFile): ProjectPackFile {
  return {
    format: 'bas-project-pack',
    version: 1,
    exportedAt: '',
    company: { ...file.company, ...(file.companyAnchor ? { anchor: file.companyAnchor } : {}) },
    project: { ...file.project, ...(file.relations ? { relations: file.relations } : {}), data: file.data },
    ...(file.attachments ? { attachments: file.attachments } : {}),
  };
}

export type ProjectImportError = 'invalid' | 'exists' | 'limit' | 'storage';
export type ProjectImportOutcome = { ok: true; name: string; projectId: string; anchorSkipped?: boolean } | { ok: false; error: ProjectImportError };

/** What importing a Project pack file will do, shown before anything is written. */
export interface ProjectPackPreview {
  file: ProjectPackFile;
  /** `bas-project` v1: no pack data inside. */
  legacy: boolean;
  /** How the file's company is matched to a registered one (id first, then name). */
  companyMatch: 'id' | 'name' | 'new';
  companyId: string;
  companyName: string;
  projectName: string;
  /** Difference between the company's stored shared layer and the file's (null when nothing is stored yet). */
  sharedDiff: CompanyLayerDiff | null;
  /** The file's company anchor is not restored (another company anchor exists or the company matched by name only). */
  anchorSkipped: boolean;
  counts: { shared: number; project: number; internal: number; people: number; attachments: number };
}

function parseFile(text: string): ProjectPackFile | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const next = ProjectPackFileSchema.safeParse(json);
  if (next.success) return next.data;
  const v1 = ProjectFileSchema.safeParse(json);
  return v1.success ? fromV1(v1.data) : null;
}

const entitiesOf = (v: unknown): Record<string, unknown>[] =>
  (v && typeof v === 'object' && Array.isArray((v as { entities?: unknown }).entities) ? (v as { entities: unknown[] }).entities : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');

export async function previewProjectPack(text: string): Promise<{ ok: true; preview: ProjectPackPreview } | { ok: false; error: ProjectImportError }> {
  const file = parseFile(text);
  if (!file) return { ok: false, error: 'invalid' };
  const shared = file.company.shared as CompanyLayer | undefined;
  if (file.project.pack) {
    try {
      loadPack(composePack(shared ?? null, file.project.pack.layer));
    } catch {
      return { ok: false, error: 'invalid' };
    }
  }
  const s = useProjects.getState();
  if (s.projects.some((p) => p.id === file.project.id)) return { ok: false, error: 'exists' };
  const byId = s.companies.find((c) => c.id === file.company.id);
  const byName = byId ? undefined : s.companies.find((c) => c.name === file.company.name);
  const companyId = (byId ?? byName)?.id ?? file.company.id;
  if (s.projects.filter((p) => p.companyId === companyId).length >= MAX_PROJECTS_PER_COMPANY) return { ok: false, error: 'limit' };
  const stored = byId || byName ? await loadCompanyLayer(companyId) : null;
  const all = [...(shared?.entities ?? []), ...entitiesOf(file.project.pack?.layer)];
  return {
    ok: true,
    preview: {
      file,
      legacy: file.exportedAt === '',
      companyMatch: byId ? 'id' : byName ? 'name' : 'new',
      companyId,
      companyName: (byId ?? byName)?.name ?? file.company.name,
      projectName: file.project.name,
      sharedDiff: stored && shared ? diffCompanyLayers(stored, shared) : null,
      anchorSkipped: !!file.company.anchor && (companyId !== file.company.id || !!readCompanyAnchorDocument(companyId)),
      counts: {
        shared: shared?.entities.length ?? 0,
        project: entitiesOf(file.project.pack?.layer).length,
        internal: all.filter((e) => e.classification === 'internal').length,
        people: all.filter((e) => e.kind === 'person').length,
        attachments: Object.keys(file.attachments ?? {}).length,
      },
    },
  };
}

/**
 * Imports a Project pack (or a `bas-project` v1 file) all or nothing: the pack layers first (the company layer is
 * merged by `policy`, never reduced), then the project's stores, the anchor and the registry. A failure undoes them.
 */
export async function importProject(text: string, options: { policy?: CompanyMergePolicy } = {}): Promise<ProjectImportOutcome> {
  const previewed = await previewProjectPack(text);
  if (!previewed.ok) return previewed;
  const { file, companyId, anchorSkipped } = previewed.preview;
  const policy = options.policy ?? 'keep';
  const s = useProjects.getState();
  const company: Company = s.companies.find((c) => c.id === companyId) ?? companyOnly(file.company as Company);
  const { relations: fileRelations, data, pack, ...projectFields } = file.project;
  const project: Project = {
    ...projectFields,
    companyId,
    ...(anchorSkipped && projectFields.alignments ? {
      alignments: projectFields.alignments.map((entry) => ({ ...entry, status: 'draft' as const, confirmedBy: '', confirmedAt: '', anchorVersion: undefined })),
    } : {}),
  };
  const shared = file.company.shared as CompanyLayer | undefined;
  const sharedBefore = await loadCompanyLayer(companyId);
  const written: string[] = [];
  try {
    if (pack) {
      const { layer, ...meta } = pack;
      await saveImportedPack({ ...meta, projectId: project.id }, composePack(shared ?? null, layer), { company: policy, companyId });
    } else if (shared) {
      await mergeIntoCompanyLayer(companyId, shared, policy);
    }
    for (const [name, value] of Object.entries(data)) {
      const key = scopedKey(project.id, name);
      written.push(key);
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    for (const key of written) localStorage.removeItem(key);
    await deleteImportedPack(project.id).catch(() => undefined);
    await restoreCompanyLayer(companyId, sharedBefore).catch(() => undefined);
    return { ok: false, error: 'storage' };
  }
  if (file.company.anchor && !anchorSkipped) restoreCompanyAnchorDocument(file.company.anchor);
  await Promise.all(Object.entries(file.attachments ?? {}).map(([hash, stored]) => restoreAttachment(hash, stored).catch(() => undefined)));
  const known = new Set(s.projects.filter((p) => p.companyId === companyId).map((p) => p.id));
  const relations = (fileRelations ?? [])
    .filter((r) => (r.from === project.id && known.has(r.to)) || (r.to === project.id && known.has(r.from)))
    .filter((r) => !s.relations.some((x) => x.id === r.id))
    .map((r) => ({ ...r, companyId }) as ProjectRelation);
  useProjects.setState((st) => ({
    companies: st.companies.some((c) => c.id === companyId)
      ? st.companies.map((c) => c.id === companyId && file.company.anchor && !anchorSkipped ? { ...c, anchorRef: file.company.anchorRef } : c)
      : [...st.companies, company],
    projects: [...st.projects, project],
    relations: [...st.relations, ...relations],
  }));
  return { ok: true, name: `${company.name}-${project.name}`, projectId: project.id, ...(anchorSkipped ? { anchorSkipped: true } : {}) };
}
