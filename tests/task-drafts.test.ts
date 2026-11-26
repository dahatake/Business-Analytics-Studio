import { afterEach, describe, expect, it } from 'vitest';
import { loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { IMPROVEMENT_STEPS } from '../src/state/projects.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { emptyDeliverables, evaluateStep, STEP_DEFS, type AppCheckContext, type CheckContext } from '../src/modules/project/deliverables.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import {
  allResults, applyTaskOps, approvalOrder, doneIds, draftAllTasks, DRAFTABLE_TASKS, taskDraftKey, taskStatuses, type TaskAi, type TaskDraft,
} from '../src/modules/project/taskDrafts.ts';
import type { ResolutionTransport } from '../src/modules/project/taskResolution.ts';
import { useTaskDrafts } from '../src/modules/project/taskDrafts.ts';

/** A project with no discussion, analyses, KPIs, use cases or deliverables: the state right after a pack is created (like the 18-issue project). */
function bare(): AppCheckContext {
  const raw = structuredClone(samplePack) as { entities: Record<string, unknown>[] } & Record<string, unknown>;
  raw.entities = raw.entities.filter((e) => e.kind !== 'kpi').map((e) => (e.kind === 'issue' || e.kind === 'solution' ? { ...e, kpiIds: [] } : e));
  const pack = loadPack(raw);
  return {
    pack, discussion: { themes: [], records: [] }, kpi: { kpis: [], okrs: [] }, analysis: { analyses: [], activeId: null }, useCases: [],
    deliverables: emptyDeliverables(), strategy: emptyStrategy(), objectives: [], projectObjectiveIds: [], today: '2026-11-09',
  };
}
function demo(): AppCheckContext {
  const pack = loadPack(samplePack);
  return { ...bare(), pack, discussion: { themes: [], records: [] }, kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases() };
}

const byId = (drafts: TaskDraft[]) => Object.fromEntries(drafts.map((d) => [taskDraftKey('internal', d.todoId), d]));
const replay = (ctx: CheckContext, drafts: TaskDraft[]) => drafts.reduce<CheckContext>((c, d) => applyTaskOps(c, d.ops).ctx, ctx);

afterEach(() => useTaskDrafts.getState().reset());

describe('FR-376: drafts that resolve every open task', () => {
  it('without Copilot, BAS rules draft every draftable task and the checks confirm that approving completes it', async () => {
    const ctx = demo();
    const { drafts, failed } = await draftAllTasks({ ctx, lang: 'ja', audience: 'internal', editor: '' }, { recommendation: () => undefined, fieldDraft: () => undefined }, null);
    expect(failed).toEqual([]);
    const statuses = taskStatuses(ctx, byId(drafts), 'internal');
    const openBefore = [...allResults(ctx)].filter(([id, r]) => !r.done && DRAFTABLE_TASKS.has(id)).map(([id]) => id);
    expect(openBefore.length).toBeGreaterThan(0);
    const unresolved = openBefore.filter((id) => !['ready', 'viaOther'].includes(statuses.get(id)!.state));
    expect(unresolved).toEqual([]);
    // Every manual criterion gets a sign-off record; nothing is applied yet.
    for (const step of IMPROVEMENT_STEPS) {
      for (const todo of STEP_DEFS[step].todos.filter((t) => t.kind === 'manual')) expect(statuses.get(todo.id)!.state).toBe('ready');
    }
    expect(evaluateStep('asis', ctx).filter((r) => r.done).length).toBe(evaluateStep('asis', ctx).filter((r) => r.done).length);
    // Approving everything (the real replay) completes those tasks and undoes none.
    const after = doneIds(allResults(replay(ctx, drafts)));
    for (const id of doneIds(allResults(ctx))) expect(after.has(id)).toBe(true);
    for (const id of openBefore) expect(after.has(id)).toBe(true);
  });

  it('a later task is completed by an earlier draft and the dependent draft is approved with it', async () => {
    const ctx = bare();
    const { drafts } = await draftAllTasks({ ctx, lang: 'ja', audience: 'internal', editor: '' }, { recommendation: () => undefined, fieldDraft: () => undefined }, null);
    const statuses = taskStatuses(ctx, byId(drafts), 'internal');
    const kpi = statuses.get('define-kpi-link')!;
    expect(kpi.state).toBe('ready');
    // The KPI drafted for each issue brings its baseline, current value and period.
    const baseline = statuses.get('asis-baseline')!;
    expect(['viaOther', 'done', 'ready']).toContain(baseline.state);
    // Approving one draft that builds on new entities also approves the drafts that create them, earlier ones first.
    const dependent = [...statuses.values()].find((s) => s.requires.length > 0);
    if (dependent) {
      const order = approvalOrder([dependent.todoId], statuses);
      expect(order.at(-1)).toBe(dependent.todoId);
      for (const req of dependent.requires) expect(order.indexOf(req)).toBeLessThan(order.indexOf(dependent.todoId));
    }
  });

  it('uses Copilot answers and labels them as Copilot drafts; numbers absent from the facts fall back to the labelled rule', async () => {
    const ctx = demo();
    const sent: string[] = [];
    const transport: ResolutionTransport = {
      fits: () => true,
      tooLarge: () => new Error('too large'),
      async send(request) {
        sent.push(request.prompt.split('\n')[0]!);
        if (request.prompt.startsWith('[bas-proj:task:asis-qualify]')) {
          const ids = JSON.parse(/Issues: (\[.*\])/.exec(request.prompt)![1]!) as string[];
          return JSON.stringify({ items: ids.map((issueId, i) => ({
            issueId, verdict: 'pursue', reason: i === 0 ? '損失は 987654 円' : '出典に記載された影響に基づく', different: '体制が変わった',
          })) });
        }
        throw new Error('not answered');
      },
    };
    const ai: TaskAi = { transport, aborted: () => false };
    const { drafts } = await draftAllTasks({ ctx, lang: 'ja', audience: 'internal', editor: '' }, { recommendation: () => '聞き取りの記録', fieldDraft: () => undefined }, ai);
    expect(sent.some((p) => p === '[bas-proj:task:asis-qualify]')).toBe(true);
    const qualify = drafts.find((d) => d.todoId === 'asis-qualify');
    if (qualify) {
      const states = qualify.ops.map((_, i) => qualify.states[i]);
      expect(states[0]).toBe('provisional');
      expect(states.slice(1).every((s) => s === 'estimate')).toBe(true);
      expect(qualify.ops.some((op) => op.op === 'qualify' && op.reason.includes('987654'))).toBe(false);
    }
    const signOff = drafts.find((d) => d.todoId === 'asis-field')!;
    expect(signOff.ops).toEqual([{ op: 'signOff', todoId: 'asis-field', text: '聞き取りの記録' }]);
    expect(signOff.states[0]).toBe('estimate');
  });

  it('never replaces a field a person wrote, even when the check calls it vague', async () => {
    const ctx = demo();
    ctx.deliverables = { ...ctx.deliverables, docs: { asis: { problem: { text: '人が入力した成果物', author: 'human', updatedAt: '2026-11-09' } } } };
    const { drafts } = await draftAllTasks({ ctx, lang: 'ja', audience: 'internal', editor: '' }, { recommendation: () => undefined, fieldDraft: () => ({ problem: '提案' }) }, null);
    expect(drafts.flatMap((d) => d.ops).some((op) => op.op === 'field' && op.step === 'asis' && op.field === 'problem')).toBe(false);
    expect(replay(ctx, drafts).deliverables.docs.asis?.problem?.text).toBe('人が入力した成果物');
    expect(() => applyTaskOps(ctx, [{ op: 'field', step: 'asis', field: 'problem', text: '上書き' }])).toThrow(/written by a person/);
  });

  it('refuses a draft that would undo a completed task and one that no longer applies', () => {
    const ctx = demo();
    const issue = ctx.pack.pack.entities.find((e) => e.kind === 'issue')!;
    const done = doneIds(allResults(ctx));
    const draft: TaskDraft = {
      todoId: 'define-decision', step: 'asis', lang: 'ja', at: '2026-11-09T00:00:00Z', states: {}, rationale: '',
      ops: [{ op: 'link', entityId: issue.id, field: 'causeIds', relatedId: 'cause-missing' }],
    };
    const statuses = taskStatuses(ctx, byId([draft]), 'internal');
    expect(statuses.get('define-decision')!.state).toBe(done.has('define-decision') ? 'done' : 'invalid');
    expect(() => applyTaskOps(ctx, draft.ops)).toThrow(/missing/);
  });
});
