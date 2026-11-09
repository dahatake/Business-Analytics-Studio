import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

/** PARAM-031: projects per company. */
export const MAX_PROJECTS_PER_COMPANY = 50;
/** PARAM-030: business-improvement steps (課題定義→現状分析→KPI 測定→ユースケース作成→施策計画). */
export const IMPROVEMENT_STEPS = ['define', 'asis', 'kpi', 'usecase', 'plan'] as const;
export type ImprovementStep = (typeof IMPROVEMENT_STEPS)[number];

export interface Company {
  id: string;
  name: string;
  createdAt: string;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  createdAt: string;
  step: ImprovementStep;
}

/** Where the user is working: the read-only demo (sample pack) or one project. */
export type WorkTarget = { kind: 'demo' } | { kind: 'project'; projectId: string };

export type AddProjectResult = { ok: true; id: string } | { ok: false; reason: 'limit' | 'noCompany' | 'emptyName' | 'duplicate' };

interface ProjectsState {
  companies: Company[];
  projects: Project[];
  target: WorkTarget;
  /** The last project opened, used by the main screen title (FR-186). */
  lastProjectId: string | null;
  demoStep: ImprovementStep;
  addCompany: (name: string) => { ok: true; id: string } | { ok: false; reason: 'emptyName' | 'duplicate' };
  renameCompany: (id: string, name: string) => void;
  deleteCompany: (id: string) => void;
  addProject: (companyId: string, name: string) => AddProjectResult;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  setTarget: (target: WorkTarget) => void;
  setStep: (step: ImprovementStep) => void;
}

export const PROJECTS_STORAGE_KEY = 'bas.projects';
export const SCOPE_PREFIX = 'bas.scope.';

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();

type DeletionListener = (projectId: string) => void;
const deletionListeners = new Set<DeletionListener>();

/** Modules that keep project data outside localStorage (e.g. IndexedDB) purge it here. Returns an unsubscribe. */
export function onProjectDeleted(fn: DeletionListener): () => void {
  deletionListeners.add(fn);
  return () => deletionListeners.delete(fn);
}

/** Remove every scoped key of a project, so deleted data cannot reappear in another project. */
function purgeScope(scope: string) {
  const prefix = `${SCOPE_PREFIX}${scope}.`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(prefix)) localStorage.removeItem(k);
  }
}

export const useProjects = create<ProjectsState>()(
  persist(
    (set, get) => ({
      companies: [],
      projects: [],
      target: { kind: 'demo' },
      lastProjectId: null,
      demoStep: 'define',
      addCompany: (raw) => {
        const name = raw.trim();
        if (!name) return { ok: false, reason: 'emptyName' };
        if (get().companies.some((c) => c.name === name)) return { ok: false, reason: 'duplicate' };
        const id = newId('co');
        set((s) => ({ companies: [...s.companies, { id, name, createdAt: now() }] }));
        return { ok: true, id };
      },
      renameCompany: (id, name) => set((s) => ({ companies: s.companies.map((c) => (c.id === id && name.trim() ? { ...c, name: name.trim() } : c)) })),
      deleteCompany: (id) => {
        get().projects.filter((p) => p.companyId === id).forEach((p) => get().deleteProject(p.id));
        set((s) => ({ companies: s.companies.filter((c) => c.id !== id) }));
      },
      addProject: (companyId, raw) => {
        const name = raw.trim();
        if (!name) return { ok: false, reason: 'emptyName' };
        if (!get().companies.some((c) => c.id === companyId)) return { ok: false, reason: 'noCompany' };
        const siblings = get().projects.filter((p) => p.companyId === companyId);
        if (siblings.length >= MAX_PROJECTS_PER_COMPANY) return { ok: false, reason: 'limit' };
        if (siblings.some((p) => p.name === name)) return { ok: false, reason: 'duplicate' };
        const id = newId('pj');
        set((s) => ({ projects: [...s.projects, { id, companyId, name, createdAt: now(), step: 'define' }] }));
        return { ok: true, id };
      },
      renameProject: (id, name) => set((s) => ({ projects: s.projects.map((p) => (p.id === id && name.trim() ? { ...p, name: name.trim() } : p)) })),
      deleteProject: (id) => {
        purgeScope(id);
        deletionListeners.forEach((fn) => fn(id));
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          target: s.target.kind === 'project' && s.target.projectId === id ? { kind: 'demo' } : s.target,
          lastProjectId: s.lastProjectId === id ? null : s.lastProjectId,
        }));
      },
      setTarget: (target) => set(target.kind === 'project' ? { target, lastProjectId: target.projectId } : { target }),
      setStep: (step) => {
        const t = get().target;
        if (t.kind === 'demo') set({ demoStep: step });
        else set((s) => ({ projects: s.projects.map((p) => (p.id === t.projectId ? { ...p, step } : p)) }));
      },
    }),
    {
      name: PROJECTS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ companies, projects, target, lastProjectId, demoStep }) => ({ companies, projects, target, lastProjectId, demoStep }),
    },
  ),
);

/** 'demo' or the active project id. Every scoped store keys its data by this (G-007: no cross-project mixing). */
export function scopeOf(target: WorkTarget): string {
  return target.kind === 'demo' ? 'demo' : target.projectId;
}

export function currentScope(): string {
  return scopeOf(useProjects.getState().target);
}

export function useCurrentScope(): string {
  return useProjects((s) => scopeOf(s.target));
}

export function useActiveProject(): { project: Project | null; company: Company | null; step: ImprovementStep } {
  return useProjects(useShallow((s: ProjectsState) => {
    if (s.target.kind === 'demo') return { project: null, company: null, step: s.demoStep };
    const projectId = s.target.projectId;
    const project = s.projects.find((p) => p.id === projectId) ?? null;
    const company = project ? s.companies.find((c) => c.id === project.companyId) ?? null : null;
    return { project, company, step: project?.step ?? 'define' };
  }));
}

export interface ScopedState<T> {
  scope: string;
  value: T;
  set: (update: T | ((prev: T) => T)) => void;
  reset: () => void;
}

export function scopedKey(scope: string, name: string): string {
  return `${SCOPE_PREFIX}${scope}.${name}`;
}

/**
 * A store whose value lives under `bas.scope.<scope>.<name>` and is swapped when the work target changes.
 * `initial(scope)` lets the demo scope start from sample data while new projects start empty.
 */
export function createScopedStore<T>(name: string, initial: (scope: string) => T): UseBoundStore<StoreApi<ScopedState<T>>> {
  const load = (scope: string): T => {
    try {
      const raw = localStorage.getItem(scopedKey(scope, name));
      return raw === null ? initial(scope) : (JSON.parse(raw) as T);
    } catch {
      return initial(scope);
    }
  };
  const save = (scope: string, value: T) => localStorage.setItem(scopedKey(scope, name), JSON.stringify(value));
  const scope0 = currentScope();
  const store = create<ScopedState<T>>()((set, get) => ({
    scope: scope0,
    value: load(scope0),
    set: (update) => {
      const next = typeof update === 'function' ? (update as (p: T) => T)(get().value) : update;
      save(get().scope, next);
      set({ value: next });
    },
    reset: () => {
      localStorage.removeItem(scopedKey(get().scope, name));
      set({ value: initial(get().scope) });
    },
  }));
  useProjects.subscribe((s) => {
    const scope = scopeOf(s.target);
    if (scope !== store.getState().scope) store.setState({ scope, value: load(scope) });
  });
  return store;
}

