import type { Entity, EntityKind, EntityOf } from '../../data/schema.ts';
import { loaded } from '../../data/pack.ts';
import { kpiProgress } from '../../domain/kpi.ts';
import { selectOutbound } from '../../ai/redact.ts';
import { translate, type Lang, type MessageKey } from '../../i18n/core.ts';
import { createScopedStore } from '../../state/projects.ts';
import { UNDO_LIMIT } from '../../state/history.ts';
import type { ScreenComponent } from './explain.ts';

/** Marker between the instruction and the machine-readable component list in a review prompt. */
export const REVIEW_MARKER = '\n---components---\n';

export interface ProposalSeed {
  componentId: string;
  text: string;
}

/** FR-279 "Copilot の案" lifecycle (§3.4: 提示中→編集中→反映済み／破棄). */
export type ProposalStatus = 'proposed' | 'editing' | 'applied' | 'discarded';

export interface Proposal {
  componentId: string;
  label: MessageKey;
  text: string;
  original: string;
  status: ProposalStatus;
}

export function reviewPrompt(lang: Lang, route: string, components: ScreenComponent[]): string {
  return `${translate(lang, 'ai.review.instruction', { route })}${REVIEW_MARKER}${JSON.stringify(components.map((c) => ({ id: c.id, entityIds: c.entityIds })))}`;
}

function parseComponents(prompt: string): { id: string; entityIds: string[] }[] {
  const i = prompt.indexOf(REVIEW_MARKER);
  if (i < 0) return [];
  try {
    const v = JSON.parse(prompt.slice(i + REVIEW_MARKER.length)) as unknown;
    return Array.isArray(v) ? (v as { id: string; entityIds: string[] }[]) : [];
  } catch {
    return [];
  }
}

const by = <T,>(f: (x: T) => number) => (a: T, b: T) => f(a) - f(b);

/** Deterministic proposal for one component, from shareable data only (what a real model would have received). */
export function proposalFor(lang: Lang, entities: Entity[]): string {
  const name = (e: Entity) => e.name[lang];
  const ofKind = <K extends EntityKind>(k: K) => entities.filter((e): e is EntityOf<K> => e.kind === k);
  const kpis = ofKind('kpi');
  const issues = ofKind('issue');
  const solutions = ofKind('solution');
  const initiatives = ofKind('initiative');
  if (kpis.length > 0) {
    const worst = [...kpis].sort(by((k) => kpiProgress(k)))[0]!;
    return translate(lang, 'ai.review.kpi', { name: name(worst), progress: Math.round(kpiProgress(worst) * 100), count: kpis.length });
  }
  if (issues.length > 0) {
    const top = [...issues].sort(by((i) => -(i.impact * 10 + i.feasibility)))[0]!;
    return translate(lang, 'ai.review.issue', { name: name(top), impact: top.impact, feasibility: top.feasibility });
  }
  if (solutions.length > 0) {
    const best = [...solutions].sort(by((s) => -(s.annualBenefitJpy / s.costJpy)))[0]!;
    return translate(lang, 'ai.review.solution', { name: name(best), ratio: (best.annualBenefitJpy / best.costJpy).toFixed(1) });
  }
  if (initiatives.length > 0) {
    const slow = [...initiatives].sort(by((i) => i.progress))[0]!;
    return translate(lang, 'ai.review.initiative', { name: name(slow), progress: Math.round(slow.progress * 100) });
  }
  if (entities.length > 0) return translate(lang, 'ai.review.generic', { count: entities.length, name: name(entities[0]!) });
  return translate(lang, 'ai.review.noData');
}

/** Mock for use 'review': JSON array of {componentId, text}. */
export function reviewMock(lang: Lang, prompt: string): string {
  const seeds: ProposalSeed[] = parseComponents(prompt).map((c) => {
    const ents = c.entityIds.map((id) => loaded.byId.get(id)).filter((e): e is Entity => Boolean(e));
    return { componentId: c.id, text: proposalFor(lang, selectOutbound(ents, loaded.byId).included) };
  });
  return JSON.stringify(seeds);
}

/** Parses a review answer. Returns null when the answer is malformed (FR-281 failure path). */
export function parseProposals(text: string, components: ScreenComponent[]): Proposal[] | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) return null;
    const out: Proposal[] = [];
    for (const c of components) {
      const seed = raw.find((r): r is ProposalSeed => typeof r === 'object' && r !== null && (r as ProposalSeed).componentId === c.id && typeof (r as ProposalSeed).text === 'string');
      if (seed) out.push({ componentId: c.id, label: c.label, text: seed.text, original: seed.text, status: 'proposed' });
    }
    return out;
  } catch {
    return null;
  }
}

/** Applied proposals per screen component: `<route>#<componentId>` → text. Pack files are never changed (Q-052 A). */
export interface OverrideEntry {
  text: string;
  appliedAt: string;
}
export type Overrides = Record<string, OverrideEntry>;

export const overrideKey = (route: string, componentId: string) => `${route}#${componentId}`;

export type ApplyResult =
  | { ok: true; next: Overrides; appliedIds: string[] }
  | { ok: false; reason: 'nothing' | 'empty'; componentIds: string[] };

/**
 * FR-280 apply, all-or-nothing (FR-281): if any kept proposal is empty, nothing is applied and the failing components are
 * reported. Discarded proposals are skipped.
 */
export function applyProposals(current: Overrides, route: string, proposals: Proposal[], now: Date): ApplyResult {
  const kept = proposals.filter((p) => p.status !== 'discarded' && p.status !== 'applied');
  if (kept.length === 0) return { ok: false, reason: 'nothing', componentIds: [] };
  const empty = kept.filter((p) => p.text.trim() === '').map((p) => p.componentId);
  if (empty.length > 0) return { ok: false, reason: 'empty', componentIds: empty };
  const next = { ...current };
  for (const p of kept) next[overrideKey(route, p.componentId)] = { text: p.text.trim(), appliedAt: now.toISOString() };
  return { ok: true, next, appliedIds: kept.map((p) => p.componentId) };
}

export interface OverridesState {
  overrides: Overrides;
  /** Snapshots taken right before each apply (Q-052 A: kept on this PC so an apply can be undone). */
  undo: Overrides[];
}

/** Per project (G-007). Other modules may read `useAiOverrides` to show applied proposals on their components. */
export const useAiOverrides = createScopedStore<OverridesState>('ai.overrides', () => ({ overrides: {}, undo: [] }));

export function commitApply(route: string, proposals: Proposal[], now = new Date()): ApplyResult {
  const store = useAiOverrides.getState();
  const result = applyProposals(store.value.overrides, route, proposals, now);
  if (result.ok) {
    store.set((prev) => ({ overrides: result.next, undo: [...prev.undo, prev.overrides].slice(-UNDO_LIMIT) }));
  }
  return result;
}

export interface AppliedDiff {
  componentId: string;
  /** The text this proposal replaced: an earlier applied proposal, or null when the screen showed only pack values. */
  before: string | null;
  after: string;
  appliedAt: string;
}

/**
 * I-2: what is applied on one route, with a before → after diff. The "before" is found in the undo snapshots: the newest
 * snapshot whose value differs from the current one is the state right before the apply that set it.
 */
export function appliedForRoute(state: OverridesState, route: string): AppliedDiff[] {
  const prefix = `${route}#`;
  return Object.entries(state.overrides)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, entry]) => {
      const prev = [...state.undo].reverse().find((snap) => snap[key]?.text !== entry.text);
      return { componentId: key.slice(prefix.length), before: prev?.[key]?.text ?? null, after: entry.text, appliedAt: entry.appliedAt };
    });
}

/** FR-281: undo the last apply. Returns false when there is nothing to undo. */
export function undoLastApply(): boolean {
  const store = useAiOverrides.getState();
  const prev = store.value.undo.at(-1);
  if (!prev) return false;
  store.set((s) => ({ overrides: prev, undo: s.undo.slice(0, -1) }));
  return true;
}
