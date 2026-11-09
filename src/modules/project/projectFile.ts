import { z } from 'zod';
import { MAX_PROJECTS_PER_COMPANY, SCOPE_PREFIX, scopedKey, useProjects, IMPROVEMENT_STEPS, type Company, type Project } from '../../state/projects.ts';

/** FR-139 (MAY): a project file keeps the system-assigned ids of the company and the project, plus every scoped store. */
export const ProjectFileSchema = z.object({
  format: z.literal('bas-project'),
  version: z.literal(1),
  company: z.object({ id: z.string().min(1), name: z.string().min(1), createdAt: z.string() }),
  project: z.object({ id: z.string().min(1), companyId: z.string().min(1), name: z.string().min(1), createdAt: z.string(), step: z.enum(IMPROVEMENT_STEPS) }),
  /** Scoped store name → stored value (all modules' project data). */
  data: z.record(z.string(), z.unknown()),
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
  return { format: 'bas-project', version: 1, company, project, data };
}

export type ProjectImportOutcome = { ok: true; name: string; projectId: string } | { ok: false; error: 'invalid' | 'exists' | 'limit' };

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
  const project: Project = { ...file.project, companyId: company.id };
  for (const [name, value] of Object.entries(file.data)) localStorage.setItem(scopedKey(project.id, name), JSON.stringify(value));
  useProjects.setState((st) => ({
    companies: st.companies.some((c) => c.id === company.id) ? st.companies : [...st.companies, company],
    projects: [...st.projects, project],
  }));
  return { ok: true, name: `${company.name}-${project.name}`, projectId: project.id };
}
