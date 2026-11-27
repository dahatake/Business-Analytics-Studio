import { loaded } from '../../data/pack.ts';
import { WorkflowExtension, type WorkflowStage } from '../../data/extensionSchemas.ts';
import { createScopedStore } from '../../state/projects.ts';
import { demoWorkflow } from './demo.ts';

/**
 * FR-380: the process as this project works on it. Step 1 refines the as-is and step 2 designs the to-be, so the edited
 * process belongs to the project (scoped store, exported with the project file), never written back into the pack.
 * Absent = the pack's `extensions.workflow` (or the demo process for the sample pack).
 */
export interface StoredProcess {
  workflow: unknown;
  /** The pack the edit started from; a different pack means the pack was replaced after editing. */
  basePackId: string;
  at: string;
}

export const PROCESS_STORE = 'process.workflow';
export const useProcessEdits = createScopedStore<StoredProcess | null>(PROCESS_STORE, () => null);

export type ProcessOrigin = 'edited' | 'pack' | 'demo' | 'none';

export function packWorkflow(): WorkflowExtension | null {
  const r = WorkflowExtension.safeParse(loaded.pack.extensions?.workflow);
  if (r.success) return r.data;
  return loaded.pack.isSample ? demoWorkflow : null;
}

/** The process shown: the project's edit when it still parses, else the pack's (a broken edit never breaks the screen). */
export function effectiveWorkflow(stored: StoredProcess | null): { workflow: WorkflowExtension | null; origin: ProcessOrigin; stale: boolean } {
  if (stored) {
    const r = WorkflowExtension.safeParse(stored.workflow);
    if (r.success) return { workflow: r.data, origin: 'edited', stale: stored.basePackId !== loaded.pack.packId };
  }
  const pack = packWorkflow();
  if (!pack) return { workflow: null, origin: 'none', stale: false };
  return { workflow: pack, origin: WorkflowExtension.safeParse(loaded.pack.extensions?.workflow).success ? 'pack' : 'demo', stale: false };
}

export function saveWorkflow(workflow: WorkflowExtension) {
  useProcessEdits.getState().set({ workflow, basePackId: loaded.pack.packId, at: new Date().toISOString() });
}

/* ---------- Pure edits ---------- */

export function upsertStage(w: WorkflowExtension, stage: WorkflowStage): WorkflowExtension {
  const i = w.stages.findIndex((s) => s.id === stage.id);
  return { ...w, stages: i < 0 ? [...w.stages, stage] : w.stages.map((s, j) => (j === i ? stage : s)) };
}

/** Removes a step and every reference to it, so the rest of the process stays valid. */
export function removeStage(w: WorkflowExtension, id: string): WorkflowExtension | null {
  const stages = w.stages.filter((s) => s.id !== id).map((s) => {
    const next = s.next.filter((n) => n !== id);
    const toBe = s.toBe?.into === id ? { ...s.toBe, into: undefined } : s.toBe;
    return { ...s, next, ...(toBe ? { toBe } : {}) };
  });
  if (!stages.length) return null;
  return {
    ...w, stages,
    ...(w.loops ? { loops: w.loops.filter((l) => l.from !== id && l.to !== id) } : {}),
    ...(w.kpiSpans ? { kpiSpans: w.kpiSpans.filter((k) => k.from !== id && k.to !== id) } : {}),
  };
}

/** Loops that start at this step are edited together with it. */
export function setStageLoops(w: WorkflowExtension, stageId: string, loops: NonNullable<WorkflowExtension['loops']>): WorkflowExtension {
  return { ...w, loops: [...(w.loops ?? []).filter((l) => l.from !== stageId), ...loops] };
}

export function setLaborRate(w: WorkflowExtension, rate: number | null, lang: 'ja' | 'en' = 'en'): WorkflowExtension {
  if (rate === w.laborCostPerHourJpy) return w;
  const { laborCostPerHourJpy: _drop, laborCostEvidence: _proof, ...rest } = w;
  return rate === null ? rest : { ...rest, laborCostPerHourJpy: rate, laborCostEvidence: { status: 'stated', method: lang === 'ja' ? '入力した時間単価です。実測の根拠は未確認です。' : 'User-entered hourly rate; actual measurement not verified', sourceIds: [] } };
}

/** A first process for a project whose pack has none: one internal lane and one step to start from. */
export function starterWorkflow(stepName: string, laneName: string): WorkflowExtension {
  return {
    parties: [{ id: 'party-own', name: laneName, side: 'internal', kind: 'department' }],
    stages: [{ id: 'st-1', name: stepName, partyId: 'party-own', inputs: [], activities: [], outputs: [], next: [] }],
  };
}
