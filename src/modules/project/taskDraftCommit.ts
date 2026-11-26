import { deviceStatus, flushDeviceStorage } from '../../data/deviceStorage.ts';
import { loaded } from '../../data/pack.ts';
import type { Lang } from '../../i18n/core.ts';
import { commitPackChanges } from '../../state/packEdits.ts';
import { currentScope, useProjects } from '../../state/projects.ts';
import { latestCompanyAnchor } from '../../state/companyAnchors.ts';
import { normalizeDeliverables, type CheckContext } from './deliverables.ts';
import { commitDiscussion, useAnalyses, useDeliverables, useDiscussion, useKpis, useProjUi, useStrategy } from './stores.ts';
import { useUseCases } from '../usecases/store.ts';
import { appendObjective } from './strategyPortal.ts';
import {
  allResults, applyRecordOps, applyTaskOps, approvalOrder, approvalText, doneIds, normalizeTaskDrafts, taskDraftKey, taskStatuses, useTaskDrafts, type TaskDraft,
} from './taskDrafts.ts';

type Audience = 'internal' | 'external';

export class TaskApprovalError extends Error {
  constructor(readonly code: 'nothing' | 'regress' | 'changed' | 'storage', readonly detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'TaskApprovalError';
  }
}

/**
 * Approves the drafts of `todoIds` (with the drafts they build on) as one change: the operations are replayed on the live
 * data, refused if any completed task would be undone, then saved (pack first, then deliverables and discussion). Each
 * approved task keeps an approval record listing every value with its data state. Returns the approved task ids.
 */
export async function approveTaskDrafts(todoIds: string[], ctx: CheckContext, audience: Audience, lang: Lang): Promise<string[]> {
  const scope = currentScope();
  const drafts = normalizeTaskDrafts(useTaskDrafts.getState().value);
  const order = approvalOrder(todoIds, taskStatuses(ctx, drafts, audience));
  if (!order.length) throw new TaskApprovalError('nothing');
  const chosen = order.map((id) => drafts[taskDraftKey(audience, id)]!) as TaskDraft[];
  const ops = chosen.flatMap((d) => d.ops);
  const at = new Date().toISOString();
  const by = useProjUi.getState().editor.trim();
  const { ctx: next, changes } = applyTaskOps(ctx, ops, at, by);
  const before = doneIds(allResults(ctx));
  const after = doneIds(allResults(next));
  const regressed = [...before].filter((id) => !after.has(id));
  if (regressed.length) throw new TaskApprovalError('regress', regressed.join(', '));
  const objectiveOps = ops.filter((op) => op.op === 'companyObjective');
  let objectiveCommit: { companyId: string; anchor: NonNullable<ReturnType<typeof latestCompanyAnchor>>['anchor'] } | undefined;
  if (objectiveOps.length) {
    const state = useProjects.getState();
    const project = state.projects.find((item) => item.id === scope);
    const company = state.companies.find((item) => item.id === project?.companyId);
    if (!project || !company) throw new TaskApprovalError('changed', 'The project company is no longer available');
    let anchorVersion = latestCompanyAnchor(company.id);
    let anchor = anchorVersion?.anchor ?? null;
    let changed = false;
    for (const op of objectiveOps) {
      if (op.op !== 'companyObjective') continue;
      const existing = anchor?.statedObjectives.find((item) => item.id === op.value.id);
      if (existing) {
        if (existing.text !== op.value.text || existing.horizon !== op.value.horizon) {
          throw new TaskApprovalError('changed', `Company objective ${op.value.id} changed after drafting`);
        }
        continue;
      }
      const result = appendObjective(anchor, op.value, company.name, at.slice(0, 10));
      if (!result.ok) throw new TaskApprovalError('storage', `Company objective is invalid: ${result.errors.join(', ')}`);
      anchor = result.anchor;
      changed = true;
    }
    if (changed && anchor) objectiveCommit = { companyId: company.id, anchor };
  }
  await commitPackChanges(changes, scope, ctx.pack);
  if (currentScope() !== scope) throw new TaskApprovalError('changed');
  if (objectiveCommit) {
    const saved = useProjects.getState().setCompanyAnchor(objectiveCommit.companyId, objectiveCommit.anchor);
    if (!saved.ok) throw new TaskApprovalError('changed', 'The project company is no longer available');
  }
  if (ops.some((op) => op.op === 'kpi' || op.op === 'okr')) useKpis.getState().set(next.kpi);
  if (ops.some((op) => op.op === 'analysis')) useAnalyses.getState().set(next.analysis);
  if (ops.some((op) => op.op === 'useCase')) useUseCases.getState().set(next.useCases);
  if (ops.some((op) => op.op === 'solutionType' || op.op === 'contribution' || op.op === 'section')) useStrategy.getState().set(next.strategy!);
  const records = applyRecordOps(
    { deliverables: normalizeDeliverables(useDeliverables.getState().value), discussion: useDiscussion.getState().value }, ops, at, by,
    (ids) => (ids.some((id) => loaded.byId.get(id)?.classification === 'internal') ? 'internal' : 'shareable'),
  );
  const recommendations = { ...records.deliverables.recommendations };
  for (const draft of chosen) {
    recommendations[taskDraftKey(audience, draft.todoId)] = { approved: { text: approvalText(draft, next, lang), mock: false, at, by } };
  }
  useDeliverables.getState().set({ ...records.deliverables, recommendations });
  if (records.discussion !== useDiscussion.getState().value) {
    commitDiscussion(records.discussion, 'adopt', 'record', lang === 'ja' ? 'Copilot のドラフトを承認' : 'Approved Copilot draft');
  }
  useTaskDrafts.getState().set((value) => {
    const rest = { ...normalizeTaskDrafts(value) };
    for (const id of order) delete rest[taskDraftKey(audience, id)];
    return rest;
  });
  await flushDeviceStorage();
  if (deviceStatus() !== 'saved') throw new TaskApprovalError('storage');
  return order;
}

export function discardTaskDraft(todoId: string, audience: Audience) {
  useTaskDrafts.getState().set((value) => {
    const rest = { ...normalizeTaskDrafts(value) };
    delete rest[taskDraftKey(audience, todoId)];
    return rest;
  });
}

export function saveTaskDraft(draft: TaskDraft, audience: Audience) {
  useTaskDrafts.getState().set((value) => ({ ...normalizeTaskDrafts(value), [taskDraftKey(audience, draft.todoId)]: draft }));
}
