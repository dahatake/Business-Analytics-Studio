import { z } from 'zod';
import { appStorage as localStorage } from '../../data/deviceStorage.ts';
import { CompanyAnchorDocumentSchema } from '../../data/companyAnchor.ts';
import { companyAnchorKey, readCompanyAnchorDocument, restoreCompanyAnchorDocument } from '../../state/companyAnchors.ts';
import { AlignmentSchema } from './companyAlignment.ts';
import {
  MAX_PROJECTS_PER_COMPANY, RELATION_KINDS, SCOPE_PREFIX, scopedKey, useProjects, IMPROVEMENT_STEPS, type Company, type Project, type ProjectRelation,
} from '../../state/projects.ts';

const Brief = z.object({
  purpose: z.string().optional(),
  focus: z.string().optional(),
  asOf: z.string().optional(),
  researchNote: z.string().optional(),
  useNews: z.boolean().optional(),
  publicWebTopic: z.string().optional(),
  useWorkIq: z.boolean().optional(),
  workIqRounds: z.number().int().optional(),
  materialNames: z.array(z.string()).optional(),
});

/** FR-139 (MAY): a project file keeps the system-assigned ids of the company and the project, plus every scoped store. */
export const ProjectFileSchema = z.object({
  format: z.literal('bas-project'),
  version: z.literal(1),
  company: z.object({
    id: z.string().min(1), name: z.string().min(1), createdAt: z.string(),
    officialUrl: z.string().optional(), industry: z.string().optional(), notes: z.string().optional(),
    anchorRef: z.object({ key: z.string(), version: z.number().int().positive(), asOf: z.iso.date() }).optional(),
  }),
  project: z.object({
    id: z.string().min(1), companyId: z.string().min(1), name: z.string().min(1), createdAt: z.string(), step: z.enum(IMPROVEMENT_STEPS), brief: Brief.optional(),
    alignments: z.array(AlignmentSchema).optional(),
    mergedFrom: z.array(z.object({
      name: z.string(), createdAt: z.string(), mergedAt: z.string(), brief: Brief.optional(), reasons: z.array(z.string()), score: z.number(), hadPack: z.boolean(),
      alignments: z.array(AlignmentSchema).optional(),
    })).optional(),
  }),
  /** Relations of this project to other projects of the company; restored only where the other project exists. */
  relations: z.array(z.object({
    id: z.string().min(1), companyId: z.string().min(1), from: z.string().min(1), to: z.string().min(1), kind: z.enum(RELATION_KINDS), note: z.string().optional(), createdAt: z.string(),
  })).optional(),
  /** Scoped store name → stored value (all modules' project data). */
  data: z.record(z.string(), z.unknown()),
  companyAnchor: CompanyAnchorDocumentSchema.optional(),
}).superRefine((file, ctx) => {
  if (file.project.companyId !== file.company.id) ctx.addIssue({ code: 'custom', path: ['project', 'companyId'], message: 'Company id does not match' });
  if (file.companyAnchor && file.companyAnchor.companyId !== file.company.id) ctx.addIssue({ code: 'custom', path: ['companyAnchor', 'companyId'], message: 'Company id does not match' });
  if (file.companyAnchor && !file.company.anchorRef) ctx.addIssue({ code: 'custom', path: ['company', 'anchorRef'], message: 'Company anchor reference is missing' });
  if (file.company.anchorRef && (!file.companyAnchor || file.company.anchorRef.key !== companyAnchorKey(file.company.id)
    || file.company.anchorRef.version !== file.companyAnchor.versions.at(-1)?.version
    || file.company.anchorRef.asOf !== file.companyAnchor.versions.at(-1)?.anchor.asOf)) {
    ctx.addIssue({ code: 'custom', path: ['company', 'anchorRef'], message: 'Company anchor reference does not match its document' });
  }
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export function exportProject(projectId: string): ProjectFile | null {
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
  const companyAnchor = readCompanyAnchorDocument(company.id);
  return { format: 'bas-project', version: 1, company, project, ...(relations.length ? { relations } : {}), data, ...(companyAnchor ? { companyAnchor } : {}) };
}

export type ProjectImportOutcome = { ok: true; name: string; projectId: string; anchorSkipped?: boolean } | { ok: false; error: 'invalid' | 'exists' | 'limit' };

export function importProject(text: string): ProjectImportOutcome {
  let file: ProjectFile;
  try {
    const r = ProjectFileSchema.safeParse(JSON.parse(text));
    if (!r.success) return { ok: false, error: 'invalid' };
    file = r.data;
  } catch {
    return { ok: false, error: 'invalid' };
  }
  const s = useProjects.getState();
  if (s.projects.some((p) => p.id === file.project.id)) return { ok: false, error: 'exists' };
  const company: Company = s.companies.find((c) => c.id === file.company.id) ?? s.companies.find((c) => c.name === file.company.name) ?? file.company;
  if (s.projects.filter((p) => p.companyId === company.id).length >= MAX_PROJECTS_PER_COMPANY) return { ok: false, error: 'limit' };
  const existingAnchor = readCompanyAnchorDocument(company.id);
  const anchorSkipped = !!file.companyAnchor && (company.id !== file.company.id || !!existingAnchor);
  const project: Project = {
    ...file.project,
    companyId: company.id,
    ...(anchorSkipped && file.project.alignments ? {
      alignments: file.project.alignments.map((entry) => ({ ...entry, status: 'draft' as const, confirmedBy: '', confirmedAt: '', anchorVersion: undefined })),
    } : {}),
  };
  if (file.companyAnchor && !anchorSkipped) restoreCompanyAnchorDocument(file.companyAnchor);
  for (const [name, value] of Object.entries(file.data)) localStorage.setItem(scopedKey(project.id, name), JSON.stringify(value));
  const known = new Set(s.projects.filter((p) => p.companyId === company.id).map((p) => p.id));
  const relations = (file.relations ?? [])
    .filter((r) => (r.from === project.id && known.has(r.to)) || (r.to === project.id && known.has(r.from)))
    .filter((r) => !s.relations.some((x) => x.id === r.id))
    .map((r) => ({ ...r, companyId: company.id }) as ProjectRelation);
  useProjects.setState((st) => ({
    companies: st.companies.some((c) => c.id === company.id)
      ? st.companies.map((c) => c.id === company.id && file.companyAnchor && !anchorSkipped ? { ...c, anchorRef: file.company.anchorRef } : c)
      : [...st.companies, company as Company],
    projects: [...st.projects, project],
    relations: [...st.relations, ...relations],
  }));
  return { ok: true, name: `${company.name}-${project.name}`, projectId: project.id, ...(anchorSkipped ? { anchorSkipped: true } : {}) };
}
