import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { appStorage as localStorage, syncDeviceStore } from '../data/deviceStorage.ts';

/** PARAM-031: projects per company. */
export const MAX_PROJECTS_PER_COMPANY = 50;
/** PARAM-030: business-improvement steps (課題定義→現状分析→KPI 測定→ユースケース作成→施策計画). */
export const IMPROVEMENT_STEPS = ['define', 'asis', 'kpi', 'usecase', 'plan'] as const;
export type ImprovementStep = (typeof IMPROVEMENT_STEPS)[number];

/** Facts about the customer that every project of the company shares (entered once, reused by each pack). */
export interface CompanyProfile {
  officialUrl?: string;
  industry?: string;
  notes?: string;
}

export interface Company extends CompanyProfile {
  id: string;
  name: string;
  createdAt: string;
}

/** What the project is about, as the user entered it; the pack generator starts from this. */
export interface ProjectBrief {
  purpose?: string;
  focus?: string;
  asOf?: string;
  researchNote?: string;
  useNews?: boolean;
  useWorkIq?: boolean;
  workIqRounds?: number;
  /** Names of the files attached at the last generation (their text lives in the pack). */
  materialNames?: string[];
}

/** A project folded into another after people agreed it is the same business issue; kept as the decision's trail. */
export interface MergeRecord {
  name: string;
  createdAt: string;
  mergedAt: string;
  brief?: ProjectBrief;
  /** The evidence shown when the merge was agreed (as displayed, in the user's language). */
  reasons: string[];
  score: number;
  hadPack: boolean;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  createdAt: string;
  step: ImprovementStep;
  brief?: ProjectBrief;
  mergedFrom?: MergeRecord[];
}

/** People judged a warned pair to be different issues; the warning returns only when the evidence grows (PARAM-153). */
export interface MergeDismissal {
  id: string;
  companyId: string;
  a: string;
  b: string;
  score: number;
  at: string;
}

/**
 * How two projects of one company relate. 'same' and 'correlated' are symmetric; 'dependsOn' reads
 * "from depends on to" (to must be solved first). Kept apart from both companies and projects (FR-137).
 */
export const RELATION_KINDS = ['same', 'dependsOn', 'correlated'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export interface ProjectRelation {
  id: string;
  companyId: string;
  from: string;
  to: string;
  kind: RelationKind;
  note?: string;
  createdAt: string;
}
export type AddRelationResult = { ok: true; id: string } | { ok: false; reason: 'self' | 'notFound' | 'otherCompany' | 'duplicate' | 'cycle' };

/** Where the user is working: the read-only demo (sample pack) or one project. */
export type WorkTarget = { kind: 'demo' } | { kind: 'project'; projectId: string };

export type AddProjectResult = { ok: true; id: string } | { ok: false; reason: 'limit' | 'noCompany' | 'emptyName' | 'duplicate' };
export type RenameResult = { ok: true } | { ok: false; reason: 'emptyName' | 'duplicate' | 'notFound' };

export type DroppedRelationReason = 'pair' | 'duplicate' | 'cycle';
export interface RelationMergePlan {
  /** Relations after the merge: the absorbed project's relations now point at the kept one. */
  relations: ProjectRelation[];
  moved: ProjectRelation[];
  dropped: { relation: ProjectRelation; reason: DroppedRelationReason }[];
}
export type MergeResult =
  | ({ ok: true } & Pick<RelationMergePlan, 'moved' | 'dropped'>)
  | { ok: false; reason: 'self' | 'notFound' | 'otherCompany' | 'emptyName' | 'duplicate' };
export interface MergeOptions {
  /** Name of the merged project (default: the kept project's name; the absorbed one's name is allowed). */
  name?: string;
  /** The merged inputs, as the user confirmed them (replaces the kept project's brief). */
  brief: ProjectBrief;
  reasons: string[];
  score: number;
  hadPack: boolean;
}

interface ProjectsState {
  companies: Company[];
  projects: Project[];
  relations: ProjectRelation[];
  mergeDismissals: MergeDismissal[];
  target: WorkTarget;
  /** The last project opened, used by the main screen title (FR-186). */
  lastProjectId: string | null;
  demoStep: ImprovementStep;
  addCompany: (name: string, profile?: CompanyProfile) => { ok: true; id: string } | { ok: false; reason: 'emptyName' | 'duplicate' };
  renameCompany: (id: string, name: string) => RenameResult;
  /** Merges the given fields into the company profile; empty strings clear a field. */
  updateCompanyProfile: (id: string, profile: CompanyProfile) => void;
  deleteCompany: (id: string) => void;
  addProject: (companyId: string, name: string, brief?: ProjectBrief) => AddProjectResult;
  renameProject: (id: string, name: string) => RenameResult;
  /** Merges the given fields into the project brief; empty strings clear a field. */
  updateProjectBrief: (id: string, brief: ProjectBrief) => void;
  deleteProject: (id: string) => void;
  addRelation: (from: string, to: string, kind: RelationKind, note?: string) => AddRelationResult;
  removeRelation: (id: string) => void;
  /** Folds `absorbId` into `keepId` (same company): inputs, relations and history move, the absorbed project's data is deleted. */
  mergeProjects: (keepId: string, absorbId: string, options: MergeOptions) => MergeResult;
  dismissMergeWarning: (a: string, b: string, score: number) => void;
  restoreMergeWarning: (id: string) => void;
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

/** Merge `patch` into `base`: strings are trimmed, and empty strings or empty arrays remove the field. */
function mergeFields<T extends object>(base: T | undefined, patch: object): T {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const value = typeof v === 'string' ? v.trim() : v;
    if (value === '' || (Array.isArray(value) && value.length === 0)) delete out[k];
    else out[k] = value;
  }
  return out as T;
}

export const isSymmetricRelation = (kind: RelationKind) => kind !== 'dependsOn';

/** True when adding from→to as a dependency would close a loop (to already depends on from, directly or not). */
export function closesCycle(relations: ProjectRelation[], from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const r of relations) if (r.kind === 'dependsOn') next.set(r.from, [...(next.get(r.from) ?? []), r.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

const samePairOf = (x: string, y: string) => (r: { from: string; to: string }) => (r.from === x && r.to === y) || (r.from === y && r.to === x);

/**
 * What merging `absorbId` into `keepId` does to the relations: the pair's own relation goes, each other relation of
 * the absorbed project is re-pointed at the kept one unless the kept one already has a relation with that project
 * (one per pair) or the re-pointed dependency would close a loop.
 */
export function planRelationMerge(relations: ProjectRelation[], keepId: string, absorbId: string): RelationMergePlan {
  const touches = (r: ProjectRelation) => r.from === absorbId || r.to === absorbId;
  const out = relations.filter((r) => !touches(r));
  const moved: ProjectRelation[] = [];
  const dropped: RelationMergePlan['dropped'] = [];
  for (const r of relations.filter(touches)) {
    const from = r.from === absorbId ? keepId : r.from;
    const to = r.to === absorbId ? keepId : r.to;
    if (from === to) dropped.push({ relation: r, reason: 'pair' });
    else if (out.some(samePairOf(from, to))) dropped.push({ relation: r, reason: 'duplicate' });
    else if (r.kind === 'dependsOn' && closesCycle(out, from, to)) dropped.push({ relation: r, reason: 'cycle' });
    else {
      const next = { ...r, from, to };
      out.push(next);
      moved.push(next);
    }
  }
  return { relations: out, moved, dropped };
}

export const useProjects = create<ProjectsState>()(
  persist(
    (set, get) => ({
      companies: [],
      projects: [],
      relations: [],
      mergeDismissals: [],
      target: { kind: 'demo' },
      lastProjectId: null,
      demoStep: 'define',
      addCompany: (raw, profile) => {
        const name = raw.trim();
        if (!name) return { ok: false, reason: 'emptyName' };
        if (get().companies.some((c) => c.name === name)) return { ok: false, reason: 'duplicate' };
        const id = newId('co');
        set((s) => ({ companies: [...s.companies, { ...mergeFields<CompanyProfile>({}, profile ?? {}), id, name, createdAt: now() }] }));
        return { ok: true, id };
      },
      renameCompany: (id, raw) => {
        const name = raw.trim();
        if (!name) return { ok: false, reason: 'emptyName' };
        if (!get().companies.some((c) => c.id === id)) return { ok: false, reason: 'notFound' };
        if (get().companies.some((c) => c.id !== id && c.name === name)) return { ok: false, reason: 'duplicate' };
        set((s) => ({ companies: s.companies.map((c) => c.id === id ? { ...c, name } : c) }));
        return { ok: true };
      },
      updateCompanyProfile: (id, profile) => {
        const { officialUrl, industry, notes } = profile;
        set((s) => ({
          companies: s.companies.map((c) => {
            if (c.id !== id) return c;
            const { id: cid, name, createdAt } = c;
            return { ...mergeFields<CompanyProfile>(c, { officialUrl, industry, notes }), id: cid, name, createdAt };
          }),
        }));
      },
      deleteCompany: (id) => {
        get().projects.filter((p) => p.companyId === id).forEach((p) => get().deleteProject(p.id));
        set((s) => ({
          companies: s.companies.filter((c) => c.id !== id),
          relations: s.relations.filter((r) => r.companyId !== id),
          mergeDismissals: s.mergeDismissals.filter((d) => d.companyId !== id),
        }));
      },
      addProject: (companyId, raw, brief) => {
        const name = raw.trim();
        if (!name) return { ok: false, reason: 'emptyName' };
        if (!get().companies.some((c) => c.id === companyId)) return { ok: false, reason: 'noCompany' };
        const siblings = get().projects.filter((p) => p.companyId === companyId);
        if (siblings.length >= MAX_PROJECTS_PER_COMPANY) return { ok: false, reason: 'limit' };
        if (siblings.some((p) => p.name === name)) return { ok: false, reason: 'duplicate' };
        const id = newId('pj');
        const cleaned = brief ? mergeFields<ProjectBrief>({}, brief) : {};
        const project: Project = { id, companyId, name, createdAt: now(), step: 'define', ...(Object.keys(cleaned).length ? { brief: cleaned } : {}) };
        set((s) => ({ projects: [...s.projects, project] }));
        return { ok: true, id };
      },
      renameProject: (id, raw) => {
        const name = raw.trim();
        if (!name) return { ok: false, reason: 'emptyName' };
        const project = get().projects.find((p) => p.id === id);
        if (!project) return { ok: false, reason: 'notFound' };
        if (get().projects.some((p) => p.id !== id && p.companyId === project.companyId && p.name === name)) return { ok: false, reason: 'duplicate' };
        set((s) => ({ projects: s.projects.map((p) => p.id === id ? { ...p, name } : p) }));
        return { ok: true };
      },
      updateProjectBrief: (id, brief) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id) return p;
            const merged = mergeFields<ProjectBrief>(p.brief, brief);
            const { brief: _old, ...rest } = p;
            return Object.keys(merged).length ? { ...rest, brief: merged } : rest;
          }),
        }));
      },
      deleteProject: (id) => {
        purgeScope(id);
        deletionListeners.forEach((fn) => fn(id));
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          relations: s.relations.filter((r) => r.from !== id && r.to !== id),
          mergeDismissals: s.mergeDismissals.filter((d) => d.a !== id && d.b !== id),
          target: s.target.kind === 'project' && s.target.projectId === id ? { kind: 'demo' } : s.target,
          lastProjectId: s.lastProjectId === id ? null : s.lastProjectId,
        }));
      },
      addRelation: (from, to, kind, note) => {
        if (from === to) return { ok: false, reason: 'self' };
        const { projects, relations } = get();
        const a = projects.find((p) => p.id === from);
        const b = projects.find((p) => p.id === to);
        if (!a || !b) return { ok: false, reason: 'notFound' };
        if (a.companyId !== b.companyId) return { ok: false, reason: 'otherCompany' };
        const samePair = (r: ProjectRelation) => (r.from === from && r.to === to) || (r.from === to && r.to === from);
        // One relation per pair (a reverse dependency would be a cycle anyway).
        if (relations.some(samePair)) return { ok: false, reason: 'duplicate' };
        if (kind === 'dependsOn' && closesCycle(relations, from, to)) return { ok: false, reason: 'cycle' };
        const id = newId('rel');
        const trimmed = note?.trim();
        set((s) => ({ relations: [...s.relations, { id, companyId: a.companyId, from, to, kind, createdAt: now(), ...(trimmed ? { note: trimmed } : {}) }] }));
        return { ok: true, id };
      },
      removeRelation: (id) => set((s) => ({ relations: s.relations.filter((r) => r.id !== id) })),
      mergeProjects: (keepId, absorbId, options) => {
        if (keepId === absorbId) return { ok: false, reason: 'self' };
        const { projects, relations, target } = get();
        const keep = projects.find((p) => p.id === keepId);
        const absorb = projects.find((p) => p.id === absorbId);
        if (!keep || !absorb) return { ok: false, reason: 'notFound' };
        if (keep.companyId !== absorb.companyId) return { ok: false, reason: 'otherCompany' };
        const name = (options.name ?? keep.name).trim();
        if (!name) return { ok: false, reason: 'emptyName' };
        if (projects.some((p) => p.id !== keepId && p.id !== absorbId && p.companyId === keep.companyId && p.name === name)) return { ok: false, reason: 'duplicate' };
        const plan = planRelationMerge(relations, keepId, absorbId);
        const record: MergeRecord = {
          name: absorb.name, createdAt: absorb.createdAt, mergedAt: now(), reasons: options.reasons, score: options.score, hadPack: options.hadPack,
          ...(absorb.brief ? { brief: absorb.brief } : {}),
        };
        const wasActive = target.kind === 'project' && target.projectId === absorbId;
        // Re-point first, so deleting the absorbed project (its scoped data, pack and listeners) leaves the moved relations.
        set({ relations: plan.relations });
        get().deleteProject(absorbId);
        const brief = mergeFields<ProjectBrief>({}, options.brief);
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== keepId) return p;
            const { brief: _old, ...rest } = p;
            return {
              ...rest, name,
              ...(Object.keys(brief).length ? { brief } : {}),
              mergedFrom: [...(p.mergedFrom ?? []), ...(absorb.mergedFrom ?? []), record],
            };
          }),
          ...(wasActive ? { target: { kind: 'project' as const, projectId: keepId }, lastProjectId: keepId } : {}),
        }));
        return { ok: true, moved: plan.moved, dropped: plan.dropped };
      },
      dismissMergeWarning: (a, b, score) => {
        const pa = get().projects.find((p) => p.id === a);
        if (!pa || !get().projects.some((p) => p.id === b)) return;
        set((s) => ({
          mergeDismissals: [
            ...s.mergeDismissals.filter((d) => !samePairOf(a, b)({ from: d.a, to: d.b })),
            { id: newId('mdis'), companyId: pa.companyId, a, b, score, at: now() },
          ],
        }));
      },
      restoreMergeWarning: (id) => set((s) => ({ mergeDismissals: s.mergeDismissals.filter((d) => d.id !== id) })),
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
      partialize: ({ companies, projects, relations, mergeDismissals, target, lastProjectId, demoStep }) => ({ companies, projects, relations, mergeDismissals, target, lastProjectId, demoStep }),
    },
  ),
);
syncDeviceStore(PROJECTS_STORAGE_KEY, () => useProjects.persist.rehydrate());

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
  if (typeof window !== 'undefined') window.addEventListener('bas-device-change', (event) => {
    if (event instanceof CustomEvent && event.detail === scopedKey(store.getState().scope, name)) {
      store.setState({ value: load(store.getState().scope) });
    }
  });
  return store;
}
