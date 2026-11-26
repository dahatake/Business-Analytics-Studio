import { z } from 'zod';
import { createScopedStore } from '../../state/projects.ts';
import { ACTION_TYPES, type ActionDef } from './actionPlan.ts';
import { baselineScenario, DEFAULT_WI_WEIGHTS, SCORE_KEYS, WEIGHT_KEYS, type CandidateKind, type Scenario } from './whatIf.ts';

/** FR-378: what-if scenarios per kind of candidate and the action plan of the last step. Project-scoped (G-007). */

/** PARAM-216: saved scenarios per kind (A, B, C), compared side by side with the baseline. */
export const MAX_SAVED_SCENARIOS = 3;

export interface WhatIfSet { current: Scenario; saved: Scenario[] }
export type WhatIfData = Record<CandidateKind, WhatIfSet>;

export interface SavedDoc { path: string; at: string; toFill: number }
export interface ActionPlanData {
  /** Solution id → actions a person confirmed or edited; absent = inferred. */
  actions: Record<string, ActionDef[]>;
  /** Solutions in the plan; null = the funded set of the current solution scenario. */
  selected: string[] | null;
  /** YYYY-MM-DD; null = today. */
  start: string | null;
  /** Solution id → the last saved requirements file. */
  saved: Record<string, SavedDoc>;
}

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const ScenarioSchema = z.object({
  name: z.string().max(60).catch(''),
  weights: z.unknown(),
  overrides: z.record(z.string(), z.record(z.string(), z.unknown())).catch({}),
  excluded: z.array(z.string()).catch([]),
  required: z.array(z.string()).catch([]),
  budgetJpy: z.number().positive().nullable().catch(null),
  maxItems: z.number().int().min(1).max(100).nullable().catch(null),
});

const parseScenario = (raw: unknown): Scenario => {
  const r = ScenarioSchema.safeParse(raw);
  if (!r.success) return baselineScenario();
  const w = r.data.weights && typeof r.data.weights === 'object' ? (r.data.weights as Record<string, unknown>) : {};
  const overrides: Scenario['overrides'] = {};
  for (const [id, o] of Object.entries(r.data.overrides)) {
    const entry: Scenario['overrides'][string] = {};
    for (const k of SCORE_KEYS) { const v = num(o[k], 1, 5); if (v !== undefined && Number.isInteger(v)) entry[k] = v as 1 | 2 | 3 | 4 | 5; }
    if (Object.keys(entry).length) overrides[id] = entry;
  }
  return {
    name: r.data.name,
    weights: Object.fromEntries(WEIGHT_KEYS.map((k) => [k, num(w[k], 0, 100) ?? DEFAULT_WI_WEIGHTS[k]])) as Scenario['weights'],
    overrides, excluded: r.data.excluded, required: r.data.required, budgetJpy: r.data.budgetJpy, maxItems: r.data.maxItems,
  };
};
const parseSet = (raw: unknown): WhatIfSet => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    current: parseScenario(r.current),
    saved: Array.isArray(r.saved) ? r.saved.slice(0, MAX_SAVED_SCENARIOS).map(parseScenario) : [],
  };
};
export const emptyWhatIf = (): WhatIfData => ({ issue: { current: baselineScenario(), saved: [] }, solution: { current: baselineScenario(), saved: [] } });
export function normalizeWhatIf(raw: unknown): WhatIfData {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { issue: parseSet(r.issue), solution: parseSet(r.solution) };
}

const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  origin: z.enum(['inferred', 'user']).catch('user'),
  reason: z.string().max(200).catch(''),
  weeks: z.number().int().min(1).max(260).optional().catch(undefined),
  owner: z.string().max(120).optional().catch(undefined),
});
export const emptyActionPlan = (): ActionPlanData => ({ actions: {}, selected: null, start: null, saved: {} });
export function normalizeActionPlan(raw: unknown): ActionPlanData {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const actions = z.record(z.string(), z.unknown()).safeParse(r.actions);
  const saved = z.record(z.string(), z.object({ path: z.string(), at: z.string(), toFill: z.number().int().min(0) })).safeParse(r.saved);
  return {
    actions: Object.fromEntries(Object.entries(actions.success ? actions.data : {}).flatMap(([k, v]) => {
      if (!Array.isArray(v)) return [];
      const list = v.flatMap((x) => { const p = ActionSchema.safeParse(x); return p.success ? [p.data as ActionDef] : []; });
      return [[k, list.filter((a, i) => list.findIndex((b) => b.type === a.type) === i)]];
    })),
    selected: Array.isArray(r.selected) && r.selected.every((x) => typeof x === 'string') ? r.selected as string[] : null,
    start: typeof r.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.start) ? r.start : null,
    saved: saved.success ? saved.data : {},
  };
}

export const useWhatIf = createScopedStore<WhatIfData>('proj.whatIf', () => emptyWhatIf());
export const useActionPlan = createScopedStore<ActionPlanData>('proj.actionPlan', () => emptyActionPlan());
