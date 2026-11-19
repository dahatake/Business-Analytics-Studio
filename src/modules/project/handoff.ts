import type { Lang } from '../../i18n/core.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../../state/projects.ts';
import { loc } from '../../state/text.ts';
import {
  evaluateStep, progressOf, pursuedIssues, qualificationOf,
  type CheckContext, type DeliverableData, type Handoff, type HandoffItem,
} from './deliverables.ts';

/**
 * Step handoff: the person's formal confirmation that a step is finished. It is allowed only when every ToDo of the
 * step is done and the previous step's confirmation is still current. It records a content hash of every item the
 * step hands on, so the next step sees exactly which inherited items changed after the confirmation and a changed
 * upstream step makes the downstream confirmation stale (re-confirmation required). Browsing steps stays free.
 */

export type HandoffKind = 'issue' | 'usecase' | 'kpi' | 'okr' | 'solution' | 'contribution' | 'initiative' | 'section' | 'field';
export type HandoffStatus = 'none' | 'current' | 'stale';
export type ItemChange = 'same' | 'changed' | 'removed' | 'added';
export type HandoffBlocker = 'todos' | 'upstream' | null;

export interface HandoffView {
  step: ImprovementStep;
  record?: Handoff;
  status: HandoffStatus;
  /** Items whose content differs from the confirmed snapshot (only when a record exists). */
  changes: (HandoffItem & { change: Exclude<ItemChange, 'same'> })[];
  /** The previous step was re-confirmed with other items, or is no longer confirmed. */
  upstreamChanged: boolean;
  todos: { done: number; total: number; complete: boolean };
  blocker: HandoffBlocker;
}

function hashOf(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const item = (kind: HandoffKind, id: string, label: string, content: unknown): HandoffItem => ({ id: `${kind}:${id}`, kind, label, hash: hashOf(JSON.stringify(content)) });

/** The items a step produces: what the next step works on. Document fields of the step are items too. */
export function stepItems(step: ImprovementStep, ctx: CheckContext, lang: Lang): HandoffItem[] {
  const entities = ctx.pack.pack.entities;
  const fields = Object.entries(ctx.deliverables.docs[step] ?? {})
    .filter(([, v]) => v.text.trim())
    .map(([id, v]) => item('field', `${step}.${id}`, id, v.text));
  switch (step) {
    case 'asis':
      // FR-347: issues qualified out end at the As-Is; a verdict is part of what the To-Be is built on.
      return [...pursuedIssues(ctx).map((e) => {
        const q = qualificationOf(ctx.deliverables, e.id);
        return item('issue', e.id, loc(e.name, lang), q ? [e, q.verdict, q.reason, q.different ?? null] : e);
      }), ...fields];
    case 'tobe':
      return [
        ...ctx.useCases.filter((u) => u.origin === 'registered').map((u) => {
          const { updatedAt: _at, ...content } = u;
          return item('usecase', u.id, loc(u.name, lang), content);
        }),
        ...fields,
      ];
    case 'kpi':
      return [
        ...ctx.kpi.kpis.map((k) => item('kpi', k.id, loc(k.name, lang), k)),
        ...ctx.kpi.okrs.map((o) => item('okr', o.id, loc(o.objective, lang), o)),
        ...fields,
      ];
    case 'solution': {
      const types = ctx.strategy?.types ?? {};
      const contributions = ctx.strategy?.contributions ?? [];
      return [
        ...entities.filter((e) => e.kind === 'solution').map((e) => item('solution', e.id, loc(e.name, lang), [e, types[e.id]?.type ?? null])),
        ...contributions.map((c) => item('contribution', c.id, c.lever, c)),
        ...fields,
      ];
    }
    case 'deliverable': {
      const sections = ctx.strategy?.sections ?? {};
      return [
        ...entities.filter((e) => e.kind === 'initiative').map((e) => item('initiative', e.id, loc(e.name, lang), e)),
        ...Object.entries(sections).flatMap(([solutionId, s]) => Object.entries(s).map(([id, text]) => item('section', `${solutionId}.${id}`, id, text))),
        ...fields,
      ];
    }
  }
}

/** Signature of a confirmed step's items: what the next step's confirmation was built on. */
const signature = (h: Handoff | undefined) => (h ? hashOf(h.items.map((i) => `${i.id}=${i.hash}`).join('|')) : '');

export function compareItems(confirmed: HandoffItem[], current: HandoffItem[]): (HandoffItem & { change: ItemChange })[] {
  const now = new Map(current.map((i) => [i.id, i]));
  const before = new Set(confirmed.map((i) => i.id));
  return [
    ...confirmed.map((i) => {
      const c = now.get(i.id);
      return { ...(c ?? i), change: (!c ? 'removed' : c.hash === i.hash ? 'same' : 'changed') as ItemChange };
    }),
    ...current.filter((i) => !before.has(i.id)).map((i) => ({ ...i, change: 'added' as ItemChange })),
  ];
}

/** The handoff state of every step, in order (each step depends on the previous one). */
export function handoffViews(ctx: CheckContext, lang: Lang): HandoffView[] {
  const records = ctx.deliverables.handoffs ?? {};
  const views: HandoffView[] = [];
  IMPROVEMENT_STEPS.forEach((step, i) => {
    const prev = i > 0 ? views[i - 1] : undefined;
    const record = records[step];
    const todos = progressOf(evaluateStep(step, ctx));
    const upstreamChanged = !!record && !!prev && (prev.status !== 'current' || record.upstream !== signature(prev.record));
    const changes = record
      ? compareItems(record.items, stepItems(step, ctx, lang)).filter((c): c is HandoffView['changes'][number] => c.change !== 'same')
      : [];
    const status: HandoffStatus = !record ? 'none' : (changes.length || upstreamChanged || !todos.complete) ? 'stale' : 'current';
    const blocker: HandoffBlocker = !todos.complete ? 'todos' : prev && prev.status !== 'current' ? 'upstream' : null;
    views.push({ step, record, status, changes, upstreamChanged, todos, blocker });
  });
  return views;
}

export const handoffView = (step: ImprovementStep, ctx: CheckContext, lang: Lang): HandoffView =>
  handoffViews(ctx, lang)[IMPROVEMENT_STEPS.indexOf(step)]!;

/** The previous step's confirmed items, each marked with whether it still matches what was handed over. */
export function inheritedItems(step: ImprovementStep, ctx: CheckContext, lang: Lang): { from: ImprovementStep | null; record?: Handoff; items: (HandoffItem & { change: ItemChange })[] } {
  const i = IMPROVEMENT_STEPS.indexOf(step);
  if (i <= 0) return { from: null, items: [] };
  const from = IMPROVEMENT_STEPS[i - 1]!;
  const record = ctx.deliverables.handoffs?.[from];
  if (!record) return { from, items: [] };
  return { from, record, items: compareItems(record.items, stepItems(from, ctx, lang)) };
}

/**
 * Labels of a kind of item a step hands on, as the input of a draft in the next step: the confirmed items in their
 * confirmed order when the step is confirmed (removed ones dropped), otherwise the step's current items.
 */
export function inputLabels(from: ImprovementStep, kind: HandoffKind, ctx: CheckContext, lang: Lang): string[] {
  const current = stepItems(from, ctx, lang).filter((i) => i.kind === kind);
  const record = ctx.deliverables.handoffs?.[from];
  if (!record) return current.map((i) => i.label);
  const now = new Map(current.map((i) => [i.id, i.label]));
  return record.items.filter((i) => i.kind === kind && now.has(i.id)).map((i) => now.get(i.id)!);
}

export class HandoffError extends Error {
  constructor(readonly code: Exclude<HandoffBlocker, null>) {
    super(code);
  }
}

/** Record the confirmation. Refuses while a ToDo is open or the previous step is not confirmed as it is now. */
export function confirmHandoff(data: DeliverableData, step: ImprovementStep, ctx: CheckContext, lang: Lang, by: string, at: string): DeliverableData {
  const c = { ...ctx, deliverables: data };
  const views = handoffViews(c, lang);
  const i = IMPROVEMENT_STEPS.indexOf(step);
  const view = views[i]!;
  if (view.blocker) throw new HandoffError(view.blocker);
  const record: Handoff = { at, by, items: stepItems(step, c, lang), upstream: signature(views[i - 1]?.record) };
  return { ...data, handoffs: { ...(data.handoffs ?? {}), [step]: record } };
}

export function clearHandoff(data: DeliverableData, step: ImprovementStep): DeliverableData {
  const { [step]: _drop, ...rest } = data.handoffs ?? {};
  return { ...data, handoffs: rest };
}
