import {
  AI_AREA_CHECKS, AI_CAPABILITIES, AI_LAYERS, AiAreaCheckSchema, AiAreaSchema, AiCapabilityStateSchema, AiEvaluationSchema,
  type AiArea, type AiAreaCheckId, type AiBasis, type AiCapabilityId, type AiEvaluation, type AiLayer, type AiPlatformExtension,
} from '../../data/extensionSchemas.ts';
import type { Localizable } from '../../state/text.ts';
import { isSystemType, type AiApproach, type SolutionType } from '../project/strategy.ts';

/**
 * FR-386 AI First Analytics. The AI platform is climbed in stages (P0 choose the hill → P1 personal productivity → P2 build
 * → P3 context → P4 delegate and climb) with three tracks that run throughout (trust, evaluation, people). It is not a
 * straight road: each business area sits at its own height, the layers mature unevenly, and the climb itself is a loop
 * (run → observe → evaluate → improve) that turns at every height. Everything here is a pure function of the data, so the
 * position on the screen can be recounted by anyone from the same capability table (third-party check).
 */

export const STAGES = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;
export type Stage = (typeof STAGES)[number];
export const TRACKS = ['trust', 'evaluate', 'people'] as const;
export type Track = (typeof TRACKS)[number];
/** 0 none, 1 pilot, 2 standard in a unit, 3 enterprise-wide. Null = not assessed (never read as "none"). */
export type Level = 0 | 1 | 2 | 3;
export const LEVELS: readonly Level[] = [0, 1, 2, 3];
export const LOOP_STEPS = ['run', 'observe', 'evaluate', 'improve'] as const;
export type LoopStep = (typeof LOOP_STEPS)[number];

export interface CapabilityDef {
  layer: AiLayer;
  /** The stage in which the capability must first be in place (at least a pilot). */
  stage: Stage;
  track?: Track;
  requires: AiCapabilityId[];
  /** Relative effort (1 small, 2 medium, 3 large): an assumption used only to order the roadmap within a wave. */
  effort: 1 | 2 | 3;
  /** Phase in the common straight four-phase order (Copilot → vibe coding → data/search → security/ID); null = absent. */
  linear: 1 | 2 | 3 | 4 | null;
}

/** The capability dependency table (the report's DSM, chapter 5, plus the model layer and the AI-CoE). */
export const CAPABILITY: Record<AiCapabilityId, CapabilityDef> = {
  outcomes: { layer: 'business', stage: 'p0', track: 'evaluate', requires: [], effort: 1, linear: null },
  coe: { layer: 'business', stage: 'p0', track: 'people', requires: [], effort: 2, linear: null },
  identity: { layer: 'trust', stage: 'p0', track: 'trust', requires: [], effort: 2, linear: 4 },
  oversharing: { layer: 'trust', stage: 'p0', track: 'trust', requires: ['identity'], effort: 2, linear: 4 },
  evals: { layer: 'evaluate', stage: 'p0', track: 'evaluate', requires: ['outcomes'], effort: 2, linear: 4 },
  copilot: { layer: 'experience', stage: 'p1', requires: ['identity', 'oversharing', 'outcomes'], effort: 1, linear: 1 },
  devGuardrails: { layer: 'trust', stage: 'p2', track: 'trust', requires: ['identity'], effort: 2, linear: 4 },
  registry: { layer: 'trust', stage: 'p2', track: 'trust', requires: ['identity'], effort: 1, linear: 4 },
  vibeCoding: { layer: 'workflow', stage: 'p2', requires: ['identity', 'devGuardrails', 'registry', 'outcomes'], effort: 1, linear: 2 },
  dataProducts: { layer: 'data', stage: 'p3', requires: ['oversharing', 'outcomes'], effort: 3, linear: 3 },
  grounding: { layer: 'context', stage: 'p3', requires: ['oversharing', 'dataProducts'], effort: 2, linear: 3 },
  agentIdentity: { layer: 'trust', stage: 'p4', track: 'trust', requires: ['identity'], effort: 1, linear: 4 },
  modelRouting: { layer: 'model', stage: 'p4', requires: ['evals'], effort: 2, linear: null },
  delegation: { layer: 'workflow', stage: 'p4', requires: ['vibeCoding', 'registry', 'grounding', 'evals', 'agentIdentity', 'coe', 'modelRouting'], effort: 3, linear: null },
};

/** What an area must have to have passed a stage: its own checks and the platform capabilities it needs (level ≥ 1). */
export const STAGE_GATE: Record<Stage, { checks: AiAreaCheckId[]; capabilities: AiCapabilityId[]; approach?: true }> = {
  p0: { checks: ['baseline', 'rubric', 'sponsor'], capabilities: ['outcomes', 'identity', 'oversharing'], approach: true },
  p1: { checks: ['adoption', 'kpiLink'], capabilities: ['copilot'] },
  p2: { checks: ['built'], capabilities: ['devGuardrails', 'registry', 'vibeCoding'] },
  p3: { checks: ['dataProduct', 'grounded'], capabilities: ['dataProducts', 'grounding', 'evals'] },
  p4: { checks: ['delegated', 'hitl'], capabilities: ['agentIdentity', 'modelRouting', 'delegation'] },
};
export const checkStage = (id: AiAreaCheckId): Stage => STAGES.find((s) => STAGE_GATE[s].checks.includes(id))!;

export const stageIndex = (s: Stage) => STAGES.indexOf(s);

/** Adds every prerequisite (transitively), so a requirement never skips what it stands on. */
export function closeOver(ids: Iterable<AiCapabilityId>): Set<AiCapabilityId> {
  const out = new Set<AiCapabilityId>();
  const visit = (id: AiCapabilityId) => {
    if (out.has(id)) return;
    out.add(id);
    CAPABILITY[id].requires.forEach(visit);
  };
  for (const id of ids) visit(id);
  return out;
}

/**
 * The platform a solution needs: the same parts for every approach, but AI First goes deeper into data, evaluation and
 * the operating model, while AI Adoption needs the inventory that keeps many local tools from sprawling (report H6).
 */
export function requiredCapabilities(type: SolutionType, approach: AiApproach | null): Set<AiCapabilityId> {
  const ids: AiCapabilityId[] = ['outcomes', 'identity', 'oversharing'];
  if (type === 'prompt') ids.push('copilot');
  if (type === 'digital') ids.push('devGuardrails', 'vibeCoding', 'registry', 'dataProducts');
  if (type === 'agent') ids.push('vibeCoding', 'grounding', 'dataProducts', 'evals', 'agentIdentity', 'modelRouting', 'delegation');
  if (approach === 'first') ids.push('dataProducts', 'evals', 'coe');
  if (approach === 'adoption') ids.push('registry');
  return closeOver(ids);
}

/** The stage a solution aims at: an agent works a process (P4), software needs its data (P3), a prompt is personal (P1). */
export function targetStage(types: SolutionType[], approach: AiApproach | null): Stage {
  const by: Partial<Record<SolutionType, Stage>> = { agent: 'p4', digital: 'p3', prompt: 'p1' };
  const stages: Stage[] = types.map((t) => by[t] ?? 'p0');
  if (approach === 'first') stages.push('p4');
  if (!types.length) stages.push(approach === 'first' ? 'p4' : 'p1');
  return stages.reduce<Stage>((a, b) => (stageIndex(b) > stageIndex(a) ? b : a), 'p0');
}

/* ---------- Order check (DSM) ---------- */

export interface OrderCheck { backward: [AiCapabilityId, AiCapabilityId][]; missing: [AiCapabilityId, AiCapabilityId][] }

/**
 * Counts dependencies that run against an order: `backward` = a capability placed earlier than something it needs,
 * `missing` = it needs something the order does not contain at all. Capabilities outside the order are not checked.
 */
export function orderCheck(position: (id: AiCapabilityId) => number | null): OrderCheck {
  const backward: OrderCheck['backward'] = [];
  const missing: OrderCheck['missing'] = [];
  for (const id of AI_CAPABILITIES) {
    const at = position(id);
    if (at === null) continue;
    for (const req of CAPABILITY[id].requires) {
      const r = position(req);
      if (r === null) missing.push([id, req]);
      else if (r > at) backward.push([id, req]);
    }
  }
  return { backward, missing };
}
export const linearOrder = (id: AiCapabilityId): number | null => CAPABILITY[id].linear;
export const stageOrder = (id: AiCapabilityId): number => stageIndex(CAPABILITY[id].stage);

/* ---------- Views ---------- */

export interface SolutionInfo {
  id: string;
  name: Localizable;
  type: SolutionType;
  approach: AiApproach | null;
  annualBenefitJpy?: number;
  /** KPI ids with a measured baseline in the pack (the area's KPI baseline is then evidence from the pack). */
  baselineKpis: string[];
}

export interface CapabilityView {
  id: AiCapabilityId;
  def: CapabilityDef;
  level: Level | null;
  basis: AiBasis | null;
  note?: Localizable;
  sourceIds: string[];
}

export type ItemSource = 'area' | 'pack' | 'strategy' | 'platform';
export interface GateItem {
  kind: 'check' | 'capability' | 'approach';
  id: string;
  met: boolean;
  basis: AiBasis | null;
  source: ItemSource;
  note?: Localizable;
}
export interface StageProgress { stage: Stage; items: GateItem[]; met: number; total: number; done: boolean }

export interface LoopView {
  steps: Record<LoopStep, boolean>;
  iterations: number;
  trend: 'up' | 'flat' | 'down' | 'none';
  closed: boolean;
  evaluations: AiEvaluation[];
}

export interface AreaView {
  id: string;
  name: Localizable;
  solutionIds: string[];
  approach: AiApproach | null;
  approachSource: 'area' | 'strategy' | null;
  derived: boolean;
  target: Stage;
  progress: StageProgress[];
  /** The lowest stage not yet passed (where the work is); `summit` when every stage has passed. */
  position: Stage;
  summit: boolean;
  /** Share of the position stage's gate already met (0–1). */
  fraction: number;
  /** Later stages where the area already met some of its own checks: progress ahead of the position (non-linear). */
  ahead: Stage[];
  basis: 'evidence' | 'mixed' | 'none';
  loop: LoopView;
  required: Set<AiCapabilityId>;
  value: number;
}

export interface Violation {
  kind: 'capability' | 'area';
  /** The capability or area that claims progress. */
  id: string;
  needs: AiCapabilityId;
  /** contradiction = the prerequisite is assessed as none; unverified = the prerequisite is not assessed. */
  severity: 'contradiction' | 'unverified';
  stage?: Stage;
}

export interface RoadmapItem {
  id: AiCapabilityId;
  wave: number;
  value: number;
  solutionIds: string[];
  areaIds: string[];
  /** Prerequisites that are themselves still gaps (built in an earlier wave). */
  missing: AiCapabilityId[];
  unassessed: boolean;
  score: number;
}

export interface LayerView { layer: AiLayer; caps: CapabilityView[]; assessed: number; mean: number | null; min: Level | null }

export interface AiFirstView {
  capabilities: Record<AiCapabilityId, CapabilityView>;
  layers: LayerView[];
  areas: AreaView[];
  derivedAreas: boolean;
  violations: Violation[];
  roadmap: RoadmapItem[];
  /** Gaps no current solution needs (kept apart so the roadmap stays tied to business problems). */
  notNeeded: AiCapabilityId[];
  /** Solutions that change no software and therefore need no AI platform part. */
  nonAiSolutions: string[];
}

const met1 = (c: CapabilityView | undefined) => (c?.level ?? 0) >= 1;

function loopOf(area: AiArea, checks: Map<AiAreaCheckId, GateItem>): LoopView {
  const evaluations = [...area.evaluations].sort((a, b) => a.date.localeCompare(b.date));
  const n = evaluations.length;
  const last = evaluations[n - 1];
  const prev = evaluations[n - 2];
  const trend: LoopView['trend'] = !last || !prev ? 'none' : last.score > prev.score ? 'up' : last.score < prev.score ? 'down' : 'flat';
  const has = (id: AiAreaCheckId) => !!checks.get(id)?.met;
  const steps: Record<LoopStep, boolean> = {
    run: has('adoption') || has('built') || has('delegated'),
    observe: has('kpiLink'),
    evaluate: has('rubric') && n >= 1,
    improve: trend === 'up',
  };
  return { steps, iterations: n, trend, closed: LOOP_STEPS.every((s) => steps[s]), evaluations };
}

/** The areas to show: the stored ones, or one per AI-related solution when none are stored. */
export function areasOf(platform: AiPlatformExtension, solutions: SolutionInfo[]): { areas: AiArea[]; derived: boolean } {
  if (platform.areas.length) return { areas: platform.areas, derived: false };
  const ai = solutions.filter((s) => isSystemType(s.type));
  return {
    areas: ai.map((s) => ({ id: `area-${s.id}`, name: s.name, solutionIds: [s.id], checks: [], evaluations: [] })),
    derived: true,
  };
}

export function buildAiFirst(platform: AiPlatformExtension, solutions: SolutionInfo[]): AiFirstView {
  const stored = new Map(platform.capabilities.map((c) => [c.id, c]));
  const capabilities = Object.fromEntries(AI_CAPABILITIES.map((id) => {
    const s = stored.get(id);
    const view: CapabilityView = {
      id, def: CAPABILITY[id], level: s ? (s.level as Level) : null, basis: s?.basis ?? null,
      ...(s?.note ? { note: s.note } : {}), sourceIds: s?.sourceIds ?? [],
    };
    return [id, view];
  })) as Record<AiCapabilityId, CapabilityView>;

  const layers: LayerView[] = AI_LAYERS.map((layer) => {
    const caps = AI_CAPABILITIES.filter((id) => CAPABILITY[id].layer === layer).map((id) => capabilities[id]);
    const levels = caps.map((c) => c.level).filter((l): l is Level => l !== null);
    return {
      layer, caps, assessed: levels.length,
      mean: levels.length ? levels.reduce<number>((a, b) => a + b, 0) / levels.length : null,
      min: levels.length ? (Math.min(...levels) as Level) : null,
    };
  });

  const solById = new Map(solutions.map((s) => [s.id, s]));
  const { areas: rawAreas, derived } = areasOf(platform, solutions);
  const areas: AreaView[] = rawAreas.map((area) => {
    const sols = area.solutionIds.map((id) => solById.get(id)).filter((s): s is SolutionInfo => !!s);
    const fromStrategy = sols.find((s) => s.approach)?.approach ?? null;
    const approach = area.approach ?? fromStrategy;
    const approachSource: AreaView['approachSource'] = area.approach ? 'area' : fromStrategy ? 'strategy' : null;
    const aiSols = sols.filter((s) => isSystemType(s.type));
    const required = aiSols.length
      ? new Set(aiSols.flatMap((s) => [...requiredCapabilities(s.type, approach)]))
      : closeOver(AI_CAPABILITIES);
    const own = new Map(area.checks.map((c) => [c.id, c]));
    const checks = new Map<AiAreaCheckId, GateItem>();
    for (const id of AI_AREA_CHECKS) {
      const c = own.get(id);
      if (c) checks.set(id, { kind: 'check', id, met: c.met, basis: c.basis, source: 'area', ...(c.note ? { note: c.note } : {}) });
      else if (id === 'baseline' && sols.some((s) => s.baselineKpis.length)) {
        // The pack holds a measured KPI baseline for this area's solution: evidence from the pack itself.
        checks.set(id, { kind: 'check', id, met: true, basis: 'evidence', source: 'pack', note: [...new Set(sols.flatMap((s) => s.baselineKpis))].join(', ') });
      } else checks.set(id, { kind: 'check', id, met: false, basis: null, source: 'area' });
    }
    const progress: StageProgress[] = STAGES.map((stage) => {
      const gate = STAGE_GATE[stage];
      const items: GateItem[] = [
        ...(gate.approach ? [{ kind: 'approach' as const, id: 'approach', met: approach !== null, basis: approach ? ('evidence' as const) : null, source: approachSource ?? ('area' as const) }] : []),
        ...gate.checks.map((id) => checks.get(id)!),
        ...gate.capabilities.filter((id) => required.has(id)).map((id): GateItem => ({
          kind: 'capability', id, met: met1(capabilities[id]), basis: capabilities[id].basis, source: 'platform',
        })),
      ];
      const met = items.filter((i) => i.met).length;
      return { stage, items, met, total: items.length, done: met === items.length };
    });
    const firstOpen = progress.findIndex((p) => !p.done);
    const summit = firstOpen < 0;
    const position: Stage = summit ? 'p4' : STAGES[firstOpen]!;
    const at = progress[stageIndex(position)]!;
    const ahead = summit ? [] : progress.slice(firstOpen + 1).filter((p) => p.items.some((i) => i.kind === 'check' && i.met)).map((p) => p.stage);
    const used = progress.flatMap((p) => p.items).filter((i) => i.met);
    const basis: AreaView['basis'] = !used.length ? 'none' : used.every((i) => i.basis === 'evidence') ? 'evidence' : 'mixed';
    return {
      id: area.id, name: area.name, solutionIds: area.solutionIds, approach, approachSource, derived,
      target: targetStage(aiSols.map((s) => s.type), approach),
      progress, position, summit, fraction: summit ? 1 : at.total ? at.met / at.total : 0, ahead, basis,
      loop: loopOf(area, checks), required,
      value: sols.reduce((a, s) => a + (s.annualBenefitJpy ?? 0), 0),
    };
  });

  const violations: Violation[] = [];
  for (const id of AI_CAPABILITIES) {
    if (!met1(capabilities[id])) continue;
    for (const req of CAPABILITY[id].requires) {
      const r = capabilities[req].level;
      if (r === 0) violations.push({ kind: 'capability', id, needs: req, severity: 'contradiction' });
      else if (r === null) violations.push({ kind: 'capability', id, needs: req, severity: 'unverified' });
    }
  }
  for (const a of areas) {
    for (const p of a.progress) {
      if (!p.items.some((i) => i.kind === 'check' && i.met && i.source === 'area')) continue;
      for (const i of p.items.filter((x) => x.kind === 'capability' && !x.met)) {
        const level = capabilities[i.id as AiCapabilityId].level;
        violations.push({ kind: 'area', id: a.id, needs: i.id as AiCapabilityId, severity: level === null ? 'unverified' : 'contradiction', stage: p.stage });
      }
    }
  }

  // Roadmap: the capabilities the AI solutions need that are not yet in place, in dependency waves weighted by value.
  const demand = new Map<AiCapabilityId, { value: number; solutionIds: Set<string>; areaIds: Set<string> }>();
  const nonAiSolutions: string[] = [];
  for (const s of solutions) {
    if (!isSystemType(s.type)) {
      nonAiSolutions.push(s.id);
      continue;
    }
    const inAreas = areas.filter((a) => a.solutionIds.includes(s.id));
    const approach = inAreas.find((a) => a.approach)?.approach ?? s.approach;
    for (const id of requiredCapabilities(s.type, approach)) {
      const d = demand.get(id) ?? { value: 0, solutionIds: new Set<string>(), areaIds: new Set<string>() };
      d.value += s.annualBenefitJpy ?? 0;
      d.solutionIds.add(s.id);
      inAreas.forEach((a) => d.areaIds.add(a.id));
      demand.set(id, d);
    }
  }
  const gap = (id: AiCapabilityId) => !met1(capabilities[id]);
  const needed = AI_CAPABILITIES.filter((id) => gap(id) && demand.has(id));
  const wave = new Map<AiCapabilityId, number>();
  for (let w = 1; wave.size < needed.length; w++) {
    const ready = needed.filter((id) => !wave.has(id) && CAPABILITY[id].requires.every((r) => !gap(r) || (wave.get(r) ?? Infinity) < w));
    if (!ready.length) break;
    ready.forEach((id) => wave.set(id, w));
  }
  const roadmap = needed.filter((id) => wave.has(id)).map((id): RoadmapItem => {
    const d = demand.get(id)!;
    return {
      id, wave: wave.get(id)!, value: d.value, solutionIds: [...d.solutionIds], areaIds: [...d.areaIds],
      missing: CAPABILITY[id].requires.filter(gap), unassessed: capabilities[id].level === null,
      score: (d.value || d.solutionIds.size) / CAPABILITY[id].effort,
    };
  }).sort((a, b) => a.wave - b.wave || b.score - a.score || AI_CAPABILITIES.indexOf(a.id) - AI_CAPABILITIES.indexOf(b.id));
  const notNeeded = AI_CAPABILITIES.filter((id) => gap(id) && !demand.has(id));

  return { capabilities, layers, areas, derivedAreas: derived, violations, roadmap, notNeeded, nonAiSolutions };
}

/* ---------- Pure edits ---------- */

export const emptyPlatform = (): AiPlatformExtension => ({ capabilities: [], areas: [] });

export function setCapability(p: AiPlatformExtension, id: AiCapabilityId, state: { level: Level; basis: AiBasis; note?: string; by?: string; at?: string } | null): AiPlatformExtension {
  const rest = p.capabilities.filter((c) => c.id !== id);
  if (!state) return { ...p, capabilities: rest };
  const prev = p.capabilities.find((c) => c.id === id);
  const note = state.note?.trim();
  return {
    ...p,
    capabilities: [...rest, {
      ...(prev?.sourceIds?.length ? { sourceIds: prev.sourceIds } : {}),
      id, level: state.level, basis: state.basis, ...(note ? { note } : {}),
      ...(state.by ? { by: state.by } : {}), ...(state.at ? { at: state.at } : {}),
    }].sort((a, b) => AI_CAPABILITIES.indexOf(a.id) - AI_CAPABILITIES.indexOf(b.id)),
  };
}

/** Saving an area turns derived areas into stored ones, so the other areas are kept, not lost. */
export function withAreas(p: AiPlatformExtension, current: AiArea[], fn: (areas: AiArea[]) => AiArea[]): AiPlatformExtension {
  return { ...p, areas: fn(p.areas.length ? p.areas : current) };
}

export function setCheck(area: AiArea, id: AiAreaCheckId, state: { met: boolean; basis: AiBasis; note?: string; by?: string; at?: string } | null): AiArea {
  const rest = area.checks.filter((c) => c.id !== id);
  if (!state) return { ...area, checks: rest };
  const prev = area.checks.find((c) => c.id === id);
  const note = state.note?.trim();
  return {
    ...area,
    checks: [...rest, {
      ...(prev?.sourceIds?.length ? { sourceIds: prev.sourceIds } : {}),
      id, met: state.met, basis: state.basis, ...(note ? { note } : {}),
      ...(state.by ? { by: state.by } : {}), ...(state.at ? { at: state.at } : {}),
    }].sort((a, b) => AI_AREA_CHECKS.indexOf(a.id) - AI_AREA_CHECKS.indexOf(b.id)),
  };
}

export function addEvaluation(area: AiArea, e: AiEvaluation): AiArea {
  return { ...area, evaluations: [...area.evaluations, e].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const removeEvaluation = (area: AiArea, index: number): AiArea => ({ ...area, evaluations: area.evaluations.filter((_, i) => i !== index) });

/** Reads stored or generated data defensively: unknown ids, broken items and dangling references are dropped. */
export function sanitizePlatform(raw: unknown, known: { sourceIds?: Set<string>; solutionIds?: Set<string> } = {}): AiPlatformExtension | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keepSources = (ids: unknown) => (Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && (!known.sourceIds || known.sourceIds.has(x))) : undefined);
  const items = <T,>(list: unknown, parse: (x: Record<string, unknown>) => T | null): T[] => (Array.isArray(list) ? list : []).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const x = { ...(item as Record<string, unknown>) };
    if (x.sourceIds !== undefined) x.sourceIds = keepSources(x.sourceIds);
    const v = parse(x);
    return v === null ? [] : [v];
  });
  const capabilities = items(r.capabilities, (x) => {
    if (typeof x.level === 'number') x.level = Math.max(0, Math.min(3, Math.round(x.level)));
    const p = AiCapabilityStateSchema.safeParse(x);
    return p.success ? p.data : null;
  });
  const used = new Set<string>();
  const areas = items(r.areas, (x) => {
    if (typeof x.id !== 'string' || !x.id || used.has(x.id)) {
      let n = used.size + 1;
      while (used.has(`area-${n}`)) n++;
      x.id = `area-${n}`;
    }
    if (Array.isArray(x.solutionIds)) x.solutionIds = x.solutionIds.filter((s): s is string => typeof s === 'string' && (!known.solutionIds || known.solutionIds.has(s)));
    x.checks = items(x.checks, (y) => { const p = AiAreaCheckSchema.safeParse(y); return p.success ? p.data : null; });
    x.evaluations = items(x.evaluations, (y) => { const p = AiEvaluationSchema.safeParse(y); return p.success ? p.data : null; });
    const p = AiAreaSchema.safeParse(x);
    if (!p.success) return null;
    used.add(p.data.id);
    return p.data;
  });
  return { capabilities: [...new Map(capabilities.map((c) => [c.id, c])).values()], areas };
}
