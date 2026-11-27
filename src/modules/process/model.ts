import {
  artifactName, METRIC_FIELDS, type Artifact, type ArtifactForm, type MetricEvidence, type MetricField, type StepChange, type StepMetrics, type WorkflowExtension, type WorkflowStage,
} from '../../data/extensionSchemas.ts';
import type { Entity } from '../../data/schema.ts';
import type { Localizable } from '../../state/text.ts';

/**
 * FR-380: the business-process view model. One end-to-end process is drawn once (stable positions) and read in two
 * states: as-is (step 1) and to-be (step 2). Every figure is derived from the stated step numbers; nothing is guessed.
 */
export type ProcState = 'asIs' | 'toBe';
export const PROC_STATES: ProcState[] = ['asIs', 'toBe'];

/** Working hours in one full-time month, used only to express hours as FTE (stated with the figure). */
export const HOURS_PER_FTE_MONTH = 160;
/** A KPI and the sum of the steps agree when they differ by at most this share. */
export const RECONCILE_TOLERANCE = 0.2;
/** Media that usually hide manual work (re-typing, sending round, chasing). */
export const MANUAL_FORMS: readonly ArtifactForm[] = ['excel', 'paper', 'email', 'pdf', 'verbal', 'chat'];

export interface Metrics {
  touchMin: number | null;
  waitH: number | null;
  volume: number | null;
  firstPass: number | null;
  people: number | null;
  estimate: boolean;
  evidence?: StepMetrics['evidence'];
}

export interface PArtifact { name: Localizable; form: ArtifactForm | null; partyId: string | null }
export interface PHidden { name: Localizable; form: ArtifactForm | null; participants: number | null; minutes: number | null; minutesEvidence?: MetricEvidence; participantsEvidence?: MetricEvidence }

export interface PLane {
  id: string;
  name: Localizable;
  side: 'external' | 'internal';
  kind: string | null;
  entityId: string | null;
  /** Named only by a stage's team text (no party in the data). */
  derived: boolean;
}
export interface PPhase { id: string; name: Localizable | null }
export interface PLoop {
  id: string; from: string; to: string;
  kind: 'rework' | 'iteration' | 'feedback';
  state: 'asIs' | 'toBe' | 'both';
  label: Localizable | null; ratePct: number | null; cadence: Localizable | null;
  /** Inferred from a `next` that goes back to an earlier step (not declared in loops). */
  implicit: boolean;
  rateEvidence?: MetricEvidence;
}

export interface PStep {
  id: string;
  index: number;
  name: Localizable;
  laneId: string;
  phaseId: string;
  description: Localizable | null;
  activities: Localizable[];
  inputs: PArtifact[];
  outputs: PArtifact[];
  data: Localizable[];
  hidden: PHidden[];
  next: string[];
  handoffTo: Localizable[];
  change: StepChange;
  note: Localizable | null;
  into: string | null;
  toBeHypothesis: boolean;
  asIs: Metrics | null;
  toBe: Metrics | null;
  sourceIds: string[];
}

export interface ProcessView {
  title: Localizable | null;
  laborRate: number | null;
  laborEvidence?: MetricEvidence;
  evidenceSources?: WorkflowExtension['evidenceSources'];
  lanes: PLane[];
  phases: PPhase[];
  steps: PStep[];
  loops: PLoop[];
  kpiSpans: { kpiId: string; from: string; to: string }[];
  /** At least one step states a to-be change other than "keep" or to-be numbers. */
  hasToBe: boolean;
  byId: Map<string, PStep>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function metricsOf(m: StepMetrics | undefined): Metrics | null {
  if (!m) return null;
  return {
    touchMin: num(m.touchMinutes), waitH: num(m.waitHours), volume: num(m.volumePerMonth),
    firstPass: num(m.firstPassPct), people: num(m.people), estimate: m.basis === 'estimate',
    evidence: Object.fromEntries(METRIC_FIELDS.map((f) => [f, m.evidence?.[f] ?? {
      status: m.basis === 'estimate' ? 'estimate' : m.basis === 'stated' ? 'stated' : 'unknown',
      method: '', sourceIds: [],
    }])),
  };
}

const EMPTY: Metrics = { touchMin: null, waitH: null, volume: null, firstPass: null, people: null, estimate: false };

/** To-be numbers override the as-is ones field by field; an unchanged field keeps its current value. */
function mergeMetrics(base: Metrics | null, over: Metrics | null): Metrics {
  const b = base ?? EMPTY;
  if (!over) return b;
  const evidence = { ...b.evidence };
  const keys = { touchMinutes: 'touchMin', waitHours: 'waitH', volumePerMonth: 'volume', firstPassPct: 'firstPass', people: 'people' } as const;
  for (const f of METRIC_FIELDS) if (over[keys[f]] !== null) evidence[f] = over.evidence?.[f];
  return {
    touchMin: over.touchMin ?? b.touchMin, waitH: over.waitH ?? b.waitH, volume: over.volume ?? b.volume,
    firstPass: over.firstPass ?? b.firstPass, people: over.people ?? b.people, estimate: over.estimate || b.estimate, evidence,
  };
}

export function metricStatus(m: Metrics | null, field?: MetricField): MetricEvidence['status'][] {
  if (!m) return ['unknown'];
  if (field) return [m.evidence?.[field]?.status ?? (m.estimate ? 'estimate' : 'unknown')];
  const keys = { touchMinutes: 'touchMin', waitHours: 'waitH', volumePerMonth: 'volume', firstPassPct: 'firstPass', people: 'people' } as const;
  return [...new Set(METRIC_FIELDS.map((f) => m[keys[f]] === null ? 'unknown' : m.evidence?.[f]?.status ?? (m.estimate ? 'estimate' : 'unknown')))];
}

const artifact = (a: Artifact): PArtifact => {
  const structured = typeof a === 'object' && 'name' in a;
  return {
    name: artifactName(a),
    form: structured && typeof a.form === 'string' ? a.form : null,
    partyId: structured && typeof a.partyId === 'string' ? a.partyId : null,
  };
};

const teamKey = (team: Localizable) => `team:${typeof team === 'string' ? team : team.en || team.ja}`;
export const UNASSIGNED_LANE = 'lane-unassigned';
export const SINGLE_PHASE = 'phase-all';

/** Builds the view from a workflow extension (older packs without parties, phases or numbers included). */
export function buildProcess(w: WorkflowExtension): ProcessView {
  const lanes: PLane[] = (w.parties ?? []).map((p) => ({ id: p.id, name: p.name, side: p.side, kind: p.kind ?? null, entityId: p.entityId ?? null, derived: false }));
  const laneIds = new Set(lanes.map((l) => l.id));
  const laneFor = (s: WorkflowStage): string => {
    if (s.partyId && laneIds.has(s.partyId)) return s.partyId;
    if (s.team) {
      const id = teamKey(s.team);
      if (!laneIds.has(id)) {
        lanes.push({ id, name: s.team, side: 'internal', kind: 'team', entityId: null, derived: true });
        laneIds.add(id);
      }
      return id;
    }
    if (!laneIds.has(UNASSIGNED_LANE)) {
      lanes.push({ id: UNASSIGNED_LANE, name: '', side: 'internal', kind: null, entityId: null, derived: true });
      laneIds.add(UNASSIGNED_LANE);
    }
    return UNASSIGNED_LANE;
  };

  const phases: PPhase[] = (w.phases ?? []).map((p) => ({ id: p.id, name: p.name }));
  const phaseIds = new Set(phases.map((p) => p.id));
  let lastPhase = phases[0]?.id ?? SINGLE_PHASE;
  if (!phases.length) phases.push({ id: SINGLE_PHASE, name: w.title ?? null });

  const stageIds = new Set(w.stages.map((s) => s.id));
  // A repeated stage id keeps its step under a unique id; `next` keeps pointing at the first one.
  const seenIds = new Map<string, number>();
  const uniqueId = (id: string) => {
    const n = (seenIds.get(id) ?? 0) + 1;
    seenIds.set(id, n);
    return n === 1 ? id : `${id}~${n}`;
  };
  const steps: PStep[] = w.stages.map((s, index) => {
    // A stage without a phase stays in the phase of the stage before it, so the bird's-eye blocks stay contiguous.
    const phaseId = s.phaseId && phaseIds.has(s.phaseId) ? s.phaseId : lastPhase;
    lastPhase = phaseId;
    const change: StepChange = s.toBe?.change ?? 'keep';
    const asIs = change === 'new' ? null : metricsOf(s.asIs) ?? { ...EMPTY };
    const gone = change === 'remove' || change === 'combine';
    const toBe = gone ? null : mergeMetrics(change === 'new' ? null : asIs, metricsOf(s.toBe?.metrics));
    return {
      id: uniqueId(s.id), index, name: s.name, laneId: laneFor(s), phaseId,
      description: s.description ?? null,
      activities: s.activities, inputs: s.inputs.map(artifact), outputs: s.outputs.map(artifact), data: s.data ?? [],
      hidden: (s.hiddenWork ?? []).map((h) => ({ name: h.name, form: h.form ?? null, participants: num(h.participants), minutes: num(h.minutes), minutesEvidence: h.minutesEvidence, participantsEvidence: h.participantsEvidence })),
      next: s.next.filter((n) => stageIds.has(n) && n !== s.id),
      handoffTo: s.handoffTo ?? [],
      change, note: s.toBe?.note ?? null,
      into: s.toBe?.into && stageIds.has(s.toBe.into) ? s.toBe.into : null,
      toBeHypothesis: s.toBe?.basis === 'hypothesis' || (!!s.toBe && s.toBe.basis !== 'stated' && !s.sourceIds?.length),
      asIs, toBe, sourceIds: s.sourceIds ?? [],
    };
  });
  const byId = new Map(steps.map((s) => [s.id, s]));

  const loops: PLoop[] = (w.loops ?? []).filter((l) => byId.has(l.from) && byId.has(l.to)).map((l) => ({
    id: l.id, from: l.from, to: l.to, kind: l.kind, state: l.state ?? 'both',
    label: l.label ?? null, ratePct: num(l.ratePct), rateEvidence: l.rateEvidence, cadence: l.cadence ?? null, implicit: false,
  }));
  const declared = new Set(loops.map((l) => `${l.from}>${l.to}`));
  for (const [from, to] of backEdges(steps)) {
    if (!declared.has(`${from}>${to}`)) loops.push({ id: `loop-${from}-${to}`, from, to, kind: 'feedback', state: 'both', label: null, ratePct: null, cadence: null, implicit: true });
  }

  // Lanes in reading order: outside parties first (customers before others), then the company's own lanes.
  const sideRank = (l: PLane) => (l.side === 'external' ? (l.kind === 'customer' ? 0 : 1) : 2);
  const usedLanes = new Set(steps.map((s) => s.laneId));
  const ordered = lanes.filter((l) => usedLanes.has(l.id) || !l.derived).sort((a, b) => sideRank(a) - sideRank(b));

  const hasToBe = steps.some((s) => s.change !== 'keep') || w.stages.some((s) => !!s.toBe?.metrics);
  return {
    title: w.title ?? null, laborRate: num(w.laborCostPerHourJpy), laborEvidence: w.laborCostEvidence, evidenceSources: w.evidenceSources, lanes: ordered,
    phases: phases.filter((p) => steps.some((s) => s.phaseId === p.id)),
    steps, loops, kpiSpans: (w.kpiSpans ?? []).filter((k) => byId.has(k.from) && byId.has(k.to)), hasToBe, byId,
  };
}

/** Edges of `next` that close a cycle (found by a depth-first search in stage order): drawn as loops, not as flow. */
export function backEdges(steps: Pick<PStep, 'id' | 'next'>[]): [string, string][] {
  const out: [string, string][] = [];
  const state = new Map<string, 1 | 2>();
  const next = new Map(steps.map((s) => [s.id, s.next]));
  const visit = (id: string) => {
    state.set(id, 1);
    for (const n of next.get(id) ?? []) {
      const st = state.get(n);
      if (st === 1) out.push([id, n]);
      else if (st === undefined) visit(n);
    }
    state.set(id, 2);
  };
  for (const s of steps) if (!state.has(s.id)) visit(s.id);
  return out;
}

/* ---------- Figures per state ---------- */

export const metricsIn = (s: PStep, state: ProcState): Metrics | null => (state === 'asIs' ? s.asIs : s.toBe);
export const presentIn = (s: PStep, state: ProcState) => metricsIn(s, state) !== null;
export const loopIn = (l: PLoop, state: ProcState) => l.state === 'both' || l.state === state;

/** Calendar hours an item spends in the step: hands-on time plus waiting. Null when neither is known. */
export function leadHours(m: Metrics | null): number | null {
  if (!m || (m.touchMin === null && m.waitH === null)) return null;
  return (m.touchMin ?? 0) / 60 + (m.waitH ?? 0);
}
/** Hands-on hours per month for all items. Null without both the effort per item and the volume. */
export function effortHours(m: Metrics | null): number | null {
  return m && m.touchMin !== null && m.volume !== null ? (m.touchMin / 60) * m.volume : null;
}

/** The flow without loops, with removed and combined steps bypassed (their predecessors hand straight on). */
export function flowEdges(v: ProcessView, state: ProcState): [string, string][] {
  const back = new Set(v.loops.filter((l) => l.implicit).map((l) => `${l.from}>${l.to}`));
  const succ = (id: string, seen: Set<string>): string[] => {
    const s = v.byId.get(id);
    if (!s) return [];
    return s.next.filter((n) => !back.has(`${id}>${n}`)).flatMap((n) => {
      if (seen.has(n)) return [];
      seen.add(n);
      return presentIn(v.byId.get(n)!, state) ? [n] : succ(n, seen);
    });
  };
  const edges: [string, string][] = [];
  for (const s of v.steps) if (presentIn(s, state)) for (const n of new Set(succ(s.id, new Set()))) edges.push([s.id, n]);
  return edges;
}

export interface PathResult { ids: string[]; hours: number; touchHours: number; unknown: number }

function topoOrder(ids: string[], edges: [string, string][]): string[] {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [a, b] of edges) {
    out.get(a)?.push(b);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    seen.add(id);
    for (const n of out.get(id) ?? []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  for (const id of ids) if (!seen.has(id)) order.push(id);
  return order;
}

/** The longest path by lead time from `from` (or any start) to `to` (or any end): the time an item takes end to end. */
export function criticalPath(v: ProcessView, state: ProcState, from?: string, to?: string): PathResult | null {
  const edges = flowEdges(v, state);
  const present = v.steps.filter((s) => presentIn(s, state));
  const preds = new Map<string, string[]>(present.map((s) => [s.id, []]));
  for (const [a, b] of edges) preds.get(b)?.push(a);
  const order = topoOrder(present.map((s) => s.id), edges);
  type Best = { hours: number; touch: number; unknown: number; prev: string | null };
  const best = new Map<string, Best>();
  for (const id of order) {
    const m = metricsIn(v.byId.get(id)!, state);
    const h = leadHours(m);
    const isStart = from ? id === from : (preds.get(id) ?? []).length === 0;
    let pick: Best | null = isStart ? { hours: 0, touch: 0, unknown: 0, prev: null } : null;
    if (!isStart || !from) {
      for (const p of preds.get(id) ?? []) {
        const b = best.get(p);
        if (b && (!pick || b.hours > pick.hours)) pick = { ...b, prev: p };
      }
    }
    if (pick) best.set(id, { hours: pick.hours + (h ?? 0), touch: pick.touch + (m?.touchMin ?? 0) / 60, unknown: pick.unknown + (h === null ? 1 : 0), prev: pick.prev });
  }
  const hasSucc = new Set(edges.map(([a]) => a));
  const ends = to ? [to] : order.filter((id) => !hasSucc.has(id));
  let endId: string | null = null;
  for (const id of ends) if (best.has(id) && (endId === null || best.get(id)!.hours > best.get(endId)!.hours)) endId = id;
  if (endId === null) return null;
  const ids: string[] = [];
  for (let cur: string | null = endId; cur; cur = best.get(cur)?.prev ?? null) ids.unshift(cur);
  const b = best.get(endId)!;
  return { ids, hours: b.hours, touchHours: b.touch, unknown: b.unknown };
}

export interface Totals {
  steps: number;
  /** End-to-end lead time along the longest path (hours) and the hands-on part of it. */
  leadHours: number | null;
  touchHours: number | null;
  /** Part of the lead time spent with outside parties (e.g. a customer's payment terms), which the company does not run. */
  externalHours: number | null;
  /** Hands-on share of the company's own lead time (value stream "process efficiency", outside waiting excluded). */
  efficiency: number | null;
  /** Steps on the path whose time is not stated. */
  unknownOnPath: number;
  effortHours: number | null;
  /** Steps whose monthly effort is unknown (effort per item or volume missing). */
  effortUnknown: number;
  fte: number | null;
  costJpy: number | null;
  /** Probability an item passes every step without rework (product of first-pass yields). */
  rolledYield: number | null;
  handoffs: number;
  externalTouches: number;
  manualArtifacts: number;
  hiddenWork: number;
  estimates: number;
  path: string[];
}

const manualCount = (s: PStep) => [...s.inputs, ...s.outputs].filter((a) => a.form && MANUAL_FORMS.includes(a.form)).length;

export function totals(v: ProcessView, state: ProcState): Totals {
  const present = v.steps.filter((s) => presentIn(s, state));
  const path = criticalPath(v, state);
  const efforts = present.map((s) => effortHours(metricsIn(s, state)));
  const known = efforts.filter((e): e is number => e !== null);
  const effort = known.length ? known.reduce((a, b) => a + b, 0) : null;
  const yields = present.map((s) => metricsIn(s, state)!.firstPass).filter((y): y is number => y !== null);
  const laneOf = new Map(v.steps.map((s) => [s.id, v.lanes.find((l) => l.id === s.laneId)]));
  const crossing = flowEdges(v, state).filter(([a, b]) => laneOf.get(a)?.id !== laneOf.get(b)?.id);
  const externalOnPath = (path?.ids ?? []).filter((id) => laneOf.get(id)?.side === 'external').reduce((n, id) => n + (leadHours(metricsIn(v.byId.get(id)!, state)) ?? 0), 0);
  return {
    steps: present.length,
    leadHours: path ? path.hours : null,
    touchHours: path ? path.touchHours : null,
    externalHours: path ? externalOnPath : null,
    efficiency: path && path.hours - externalOnPath > 0 ? path.touchHours / (path.hours - externalOnPath) : null,
    unknownOnPath: path?.unknown ?? 0,
    effortHours: effort,
    effortUnknown: efforts.length - known.length,
    fte: effort === null ? null : effort / HOURS_PER_FTE_MONTH,
    costJpy: effort !== null && v.laborRate !== null ? effort * v.laborRate : null,
    rolledYield: yields.length ? yields.reduce((a, y) => a * (y / 100), 1) : null,
    handoffs: crossing.length,
    externalTouches: crossing.filter(([a, b]) => laneOf.get(a)?.side !== laneOf.get(b)?.side).length,
    manualArtifacts: present.reduce((n, s) => n + manualCount(s), 0),
    hiddenWork: present.reduce((n, s) => n + s.hidden.length, 0),
    estimates: present.filter((s) => metricsIn(s, state)!.estimate || (state === 'toBe' && s.toBeHypothesis && s.change !== 'keep')).length,
    path: path?.ids ?? [],
  };
}

/** Relative change from as-is to to-be (−0.6 = 60% less). Null when either side is unknown or the base is 0. */
export function delta(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return (after - before) / before;
}

export interface StepDelta { lead: number | null; effort: number | null }
export function stepDelta(s: PStep): StepDelta {
  if (s.change === 'remove' || s.change === 'combine') return { lead: -1, effort: -1 };
  return { lead: delta(leadHours(s.asIs), leadHours(s.toBe)), effort: delta(effortHours(s.asIs), effortHours(s.toBe)) };
}

/* ---------- People, money, things and time per lane ---------- */

export interface LaneResources {
  laneId: string;
  steps: Record<ProcState, number>;
  effortHours: Record<ProcState, number | null>;
  fte: Record<ProcState, number | null>;
  costJpy: Record<ProcState, number | null>;
  /** Manual media and hidden micro-workflows (the "things" that carry the work). */
  artifacts: Record<ProcState, number>;
}

export function laneResources(v: ProcessView): LaneResources[] {
  return v.lanes.map((l) => {
    const r: LaneResources = {
      laneId: l.id, steps: { asIs: 0, toBe: 0 }, effortHours: { asIs: null, toBe: null }, fte: { asIs: null, toBe: null },
      costJpy: { asIs: null, toBe: null }, artifacts: { asIs: 0, toBe: 0 },
    };
    for (const state of PROC_STATES) {
      const steps = v.steps.filter((s) => s.laneId === l.id && presentIn(s, state));
      r.steps[state] = steps.length;
      const e = steps.map((s) => effortHours(metricsIn(s, state))).filter((x): x is number => x !== null);
      const sum = e.length ? e.reduce((a, b) => a + b, 0) : null;
      r.effortHours[state] = sum;
      r.fte[state] = sum === null ? null : sum / HOURS_PER_FTE_MONTH;
      r.costJpy[state] = sum !== null && v.laborRate !== null ? sum * v.laborRate : null;
      r.artifacts[state] = steps.reduce((n, s) => n + manualCount(s) + s.hidden.length, 0);
    }
    return r;
  });
}

/* ---------- Inputs and work products ---------- */

export type IoStatus = 'defined' | 'partial' | 'missing';
export interface IoRow { stepId: string; status: IoStatus; manual: number; hidden: number }

/**
 * A step reads as a function when every input and output is named with its medium: the inputs it needs and the work
 * product it makes are then specified. Hidden micro-workflows and manual media are counted, not judged.
 */
export function ioAnalysis(v: ProcessView, state: ProcState): IoRow[] {
  return v.steps.filter((s) => presentIn(s, state)).map((s) => {
    const all = [...s.inputs, ...s.outputs];
    const status: IoStatus = !s.inputs.length || !s.outputs.length ? 'missing' : all.every((a) => a.form) ? 'defined' : 'partial';
    return { stepId: s.id, status, manual: manualCount(s), hidden: s.hidden.length };
  });
}

/* ---------- KPI reconciliation ---------- */

export interface Reconciliation {
  kpiId: string;
  from: string;
  to: string;
  unitHours: number | null;
  rows: { state: ProcState; stepsHours: number | null; kpiValue: number; kpiHours: number | null; gap: number | null; unknown: number }[];
}

/** Hours in one unit of a time KPI ("days", "日", "hours", "時間", "週", "weeks"); null when the unit is not a time. */
export function hoursPerUnit(unit: Localizable): number | null {
  const text = (typeof unit === 'string' ? unit : `${unit.ja} ${unit.en}`).toLowerCase();
  if (/hour|時間/.test(text)) return 1;
  if (/week|週/.test(text)) return 24 * 7;
  if (/day|日/.test(text)) return 24;
  return null;
}

/**
 * The step times summed along the measured span against the KPI: current value for the as-is, target for the to-be.
 * A large gap means the step numbers or the KPI definition need checking; neither is assumed right.
 */
export function reconcile(v: ProcessView, kpis: Entity[]): Reconciliation[] {
  return v.kpiSpans.flatMap((span) => {
    const k = kpis.find((e) => e.id === span.kpiId);
    if (!k || k.kind !== 'kpi') return [];
    const unitHours = hoursPerUnit(k.unit);
    const rows = PROC_STATES.map((state) => {
      const p = criticalPath(v, state, span.from, span.to);
      const kpiValue = state === 'asIs' ? k.current : k.target;
      const kpiHours = unitHours === null ? null : kpiValue * unitHours;
      const stepsHours = p ? p.hours : null;
      return { state, stepsHours, kpiValue, kpiHours, gap: kpiHours && stepsHours !== null ? (stepsHours - kpiHours) / kpiHours : null, unknown: p?.unknown ?? 0 };
    });
    return [{ kpiId: k.id, from: span.from, to: span.to, unitHours, rows }];
  });
}

/* ---------- Layout ---------- */

export const GEO = {
  labelW: 156,
  headerH: 64,
  colW: 212,
  cardW: 176,
  cardH: 124,
  laneH: 160,
  bandGap: 28,
  pad: 18,
} as const;

export interface LaidStep { id: string; col: number; x: number; y: number }
export interface LaidLane { id: string; y: number; h: number; side: 'external' | 'internal' }
export interface LaidPhase { id: string; col0: number; col1: number; x: number; w: number }
export interface Layout {
  steps: Map<string, LaidStep>;
  lanes: LaidLane[];
  phases: LaidPhase[];
  cols: number;
  width: number;
  height: number;
  /** y where the company's own lanes start (the line between outside parties and the company). */
  internalTop: number;
}

/**
 * Lanes are rows (outside parties above the company), phases are column groups in their stated order, and each step
 * sits one column after its latest predecessor in the same phase. The layout uses every step of both states, so a
 * step keeps its place when switching between as-is and to-be (the eye compares like with like).
 */
export function layoutProcess(v: ProcessView): Layout {
  const back = new Set(v.loops.filter((l) => l.implicit).map((l) => `${l.from}>${l.to}`));
  const preds = new Map<string, string[]>(v.steps.map((s) => [s.id, []]));
  const edges: [string, string][] = [];
  for (const s of v.steps) for (const n of s.next) if (!back.has(`${s.id}>${n}`)) {
    preds.get(n)?.push(s.id);
    edges.push([s.id, n]);
  }
  const rank = new Map(topoOrder(v.steps.map((s) => s.id), edges).map((id, i) => [id, i]));

  const col = new Map<string, number>();
  const taken = new Set<string>();
  const phases: LaidPhase[] = [];
  let start = 0;
  for (const p of v.phases) {
    const inPhase = v.steps.filter((s) => s.phaseId === p.id).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    if (!inPhase.length) continue;
    let end = start;
    for (const s of inPhase) {
      let c = start;
      for (const q of preds.get(s.id) ?? []) if (col.has(q)) c = Math.max(c, col.get(q)! + 1);
      while (taken.has(`${s.laneId}@${c}`)) c += 1;
      col.set(s.id, c);
      taken.add(`${s.laneId}@${c}`);
      end = Math.max(end, c);
    }
    phases.push({ id: p.id, col0: start, col1: end, x: GEO.labelW + start * GEO.colW, w: (end - start + 1) * GEO.colW });
    start = end + 1;
  }
  const lanes: LaidLane[] = [];
  let y = GEO.headerH;
  let internalTop = -1;
  v.lanes.forEach((l, i) => {
    if (l.side === 'internal' && internalTop < 0) {
      if (i > 0) y += GEO.bandGap;
      internalTop = y;
    }
    lanes.push({ id: l.id, y, h: GEO.laneH, side: l.side });
    y += GEO.laneH;
  });
  if (internalTop < 0) internalTop = y;
  const laneY = new Map(lanes.map((l) => [l.id, l.y]));
  const steps = new Map<string, LaidStep>();
  for (const s of v.steps) {
    const c = col.get(s.id) ?? 0;
    steps.set(s.id, { id: s.id, col: c, x: GEO.labelW + c * GEO.colW + (GEO.colW - GEO.cardW) / 2, y: (laneY.get(s.laneId) ?? GEO.headerH) + (GEO.laneH - GEO.cardH) / 2 });
  }
  const cols = Math.max(start, 1);
  return { steps, lanes, phases, cols, width: GEO.labelW + cols * GEO.colW + GEO.pad, height: y + GEO.pad, internalTop };
}

/** Aggregates for one phase block in the bird's-eye view. */
export function phaseSummary(v: ProcessView, phaseId: string, state: ProcState, side?: 'external' | 'internal') {
  const sideOf = (s: PStep) => v.lanes.find((l) => l.id === s.laneId)?.side;
  const steps = v.steps.filter((s) => s.phaseId === phaseId && (!side || sideOf(s) === side));
  const present = steps.filter((s) => presentIn(s, state));
  const hours = present.map((s) => leadHours(metricsIn(s, state))).filter((h): h is number => h !== null);
  const effort = present.map((s) => effortHours(metricsIn(s, state))).filter((h): h is number => h !== null);
  return {
    steps: present.length,
    removed: state === 'toBe' ? steps.filter((s) => !presentIn(s, 'toBe')).length : 0,
    added: state === 'toBe' ? steps.filter((s) => s.change === 'new').length : 0,
    leadHours: hours.length ? hours.reduce((a, b) => a + b, 0) : null,
    effortHours: effort.length ? effort.reduce((a, b) => a + b, 0) : null,
    external: present.filter((s) => sideOf(s) === 'external').length,
    loops: v.loops.filter((l) => loopIn(l, state) && steps.some((s) => s.id === l.from)).length,
  };
}
