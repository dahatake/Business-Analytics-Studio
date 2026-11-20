import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLiveTransport, setRuntimeSettingsProvider, writeLedger, type LiveCall } from '../src/ai/client.ts';
import { PER_USE_LIMITS, type Provider } from '../src/ai/policy.ts';
import { selectOutbound, toPromptContext } from '../src/ai/redact.ts';
import { loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../src/state/projects.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { batchIntervalMs, batchSourceStamp, createBatchPlan, runBatchJob, saveBatchResult, waitForBatchInterval } from '../src/modules/project/batchDraft.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { emptyDeliverables, setField, setSignOff, STEP_DEFS, type AppCheckContext } from '../src/modules/project/deliverables.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { overviewBaseline, stepBriefContext, useOverview } from '../src/modules/project/overviewModel.ts';
import { buildStepBrief, useStepBriefs } from '../src/modules/project/stepBrief.ts';
import { stepDashboard } from '../src/modules/project/stepDashboard.ts';
import { useDeliverables, useFieldDrafts, useSolutionDrafts, useStrategy } from '../src/modules/project/stores.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import { mockSolutionDraft } from '../src/modules/project/solutionDraft.ts';

function context(data = samplePack): AppCheckContext {
  const pack = loadPack(data);
  return {
    pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(),
    deliverables: useDeliverables.getState().value, strategy: emptyStrategy(), objectives: [], projectObjectiveIds: [], today: '2026-11-09',
  };
}

const taskText = [
  '事実・根拠: 事実', '不足情報: 要確認', '仮説: 仮説', '選択肢: 比較',
  '推奨: 検証', '理由: 根拠', '検証: 照合', '影響: 評価',
].join('\n');

function response(call: LiveCall, ctx: AppCheckContext): string {
  if (call.prompt.startsWith('[bas-proj:solution:')) {
    return JSON.stringify(mockSolutionDraft(JSON.parse(call.prompt.slice(call.prompt.indexOf('CONTEXT: ') + 9)), 'ja'));
  }
  if (call.use === 'deliverableDraft') {
    const step = /\[bas-proj:deliverable:([a-z]+)\]/.exec(call.prompt)?.[1] as ImprovementStep;
    return [
      ...STEP_DEFS[step].fields.map((field) => `### ${field.id}\n提案`),
      ...STEP_DEFS[step].todos.map((todo) => `### task-${todo.id}\n${taskText}`),
    ].join('\n');
  }
  if (call.use === 'stepBrief') {
    return ['answer', 'situation', 'complication', 'question', 'findings', 'actions', 'caveats']
      .map((section) => `### ${section}\n提案`).join('\n');
  }
  const issue = ctx.pack.pack.entities.find((entity) => entity.kind === 'issue')!;
  return JSON.stringify({
    answer: '確認する', findings: [{ text: '根拠を確認', refs: [issue.id] }],
    actions: [{ text: '検証する', refs: [issue.id] }], caveats: ['仮説'], axis: 'impact',
    axisReason: '影響を評価', objectiveIssues: [], patches: [],
  });
}

afterEach(() => {
  setLiveTransport(null);
  setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
  writeLedger([]);
  useDeliverables.getState().reset();
  useFieldDrafts.getState().reset();
  useSolutionDrafts.getState().reset();
  useStepBriefs.getState().reset();
  useOverview.getState().reset();
});

describe('all-step drafts', () => {
  it.each<Provider>(['foundry', 'copilotSdk'])('generates and saves all jobs via %s without applying them', async (provider) => {
    const field = { text: '人が入力した成果物', author: 'human' as const, updatedAt: '2026-11-09T00:00:00Z' };
    const signOff = { at: '2026-11-09T00:00:00Z', by: '担当者' };
    const approved = { text: '承認済み', mock: false, at: signOff.at, by: signOff.by };
    const firstTodo = STEP_DEFS.asis.todos[0]!.id;
    const data = setSignOff(setField(emptyDeliverables(), 'asis', 'problem', field), 'asis-field', signOff);
    data.recommendations = { [`internal:${firstTodo}`]: { approved } };
    useDeliverables.getState().set(data);
    const ctx = context();
    const jobs = createBatchPlan(ctx, 'ja', 'internal', 'demo', useOverview.getState().value);
    const solutions = ctx.pack.pack.entities.filter((e) => e.kind === 'solution').map((e) => e.id);
    expect(jobs).toHaveLength(11 + solutions.length);
    expect(jobs.filter((job) => job.kind === 'fields').map((job) => job.step)).toEqual(IMPROVEMENT_STEPS);
    expect(jobs.filter((job) => job.kind === 'brief').map((job) => job.step)).toEqual(IMPROVEMENT_STEPS);
    expect(jobs.at(10)?.kind).toBe('strategy');
    expect(jobs.slice(11).map((job) => (job.kind === 'solution' ? job.solutionId : job.kind))).toEqual(solutions);

    setRuntimeSettingsProvider(() => ({ provider, liveEnabled: true, sendConsent: true, configured: true }));
    const calls: LiveCall[] = [];
    setLiveTransport(async (call) => {
      calls.push(call);
      return { text: response(call, ctx), inputTokens: 10, outputTokens: 10 };
    });
    const signal = new AbortController().signal;
    for (const job of jobs) {
      writeLedger([]);
      const result = await runBatchJob(job, signal);
      saveBatchResult(job, result, ctx, 'internal', provider);
    }

    expect(calls.map((call) => call.provider)).toEqual(Array(11 + solutions.length).fill(provider));
    const solutionDrafts = useSolutionDrafts.getState().value;
    for (const id of solutions) expect(solutionDrafts[`internal:${id}`]).toMatchObject({ mock: false, lang: 'ja' });
    expect(useStrategy.getState().value).toEqual(emptyStrategy()); // drafts only: the type and the documents wait for approval
    const saved = useDeliverables.getState().value;
    expect(saved.docs.asis?.problem).toEqual(field);
    expect(saved.signOffs['asis-field']).toEqual(signOff);
    expect(saved.recommendations?.[`internal:${firstTodo}`]?.approved).toEqual(approved);
    expect(saved.recommendations?.[`internal:${firstTodo}`]?.draft?.text).toContain('推奨: 検証');
    for (const step of IMPROVEMENT_STEPS) {
      expect(Object.keys(useFieldDrafts.getState().value[`internal:${step}`]!.fields)).toHaveLength(STEP_DEFS[step].fields.length);
      expect(useStepBriefs.getState().value[`internal:${step}`]).toMatchObject({ mode: 'live', lang: 'ja' });
    }
    const overview = useOverview.getState().value;
    expect(overview.draft).toMatchObject({ provider, audience: 'internal' });
    expect(overview.draft?.baseline).toBe(overviewBaseline({ ...ctx, deliverables: saved }, overview));
  });

  it('filters confidential names and numbers from every external request and uses the same brief as the screen', () => {
    const pack = structuredClone(samplePack);
    const privateKpi = pack.entities.find((entity) => entity.id === 'kpi-engagement');
    if (!privateKpi || privateKpi.kind !== 'kpi') throw new Error('Missing fixture KPI');
    privateKpi.classification = 'internal';
    privateKpi.name = { ja: '秘密指標名', en: 'private metric name' };
    privateKpi.current = 987654321;
    const sourcePrivateKpi = pack.entities.find((entity) => entity.id === 'kpi-dso');
    if (!sourcePrivateKpi || sourcePrivateKpi.kind !== 'kpi') throw new Error('Missing fixture KPI');
    sourcePrivateKpi.name = { ja: '非公開資料由来の指標', en: 'private-source metric' };
    sourcePrivateKpi.current = 876543219;
    const publicIssue = pack.entities.find((entity) => entity.id === 'issue-quality');
    if (!publicIssue || publicIssue.kind !== 'issue') throw new Error('Missing fixture issue');
    publicIssue.causeIds.push('cause-tacit-knowledge');
    const ctx = context(pack);
    ctx.objectives = [{ id: 'private-objective', text: '秘密目標' }];
    ctx.deliverables = setField(ctx.deliverables, 'asis', 'problem', { text: '秘密の文章', author: 'human', updatedAt: '2026-11-09' });
    const jobs = createBatchPlan(ctx, 'ja', 'external', 'demo', { objectiveIssues: [] });
    expect(jobs.some((job) => job.kind === 'solution' && job.solutionId === 'sol-knowledge-copilot')).toBe(false);
    const sent = jobs.map((job) => `${job.request.prompt}\n${toPromptContext(selectOutbound(job.request.entities ?? [], ctx.pack.byId), 'ja')}`).join('\n');
    for (const secret of ['秘密指標名', 'private metric name', '987654321', '非公開資料由来の指標', 'private-source metric', '876543219', '秘密目標', '秘密の文章', 'src-interview', 'cause-tacit-knowledge', 'person-suzuki-fumiko']) {
      expect(sent).not.toContain(secret);
    }
    for (const job of jobs) {
      if (job.kind !== 'brief') continue;
      const safe = stepBriefContext(ctx, 'external');
      expect(job.brief.hash).toBe(buildStepBrief(stepDashboard(job.step, safe), safe, 'ja', 'external').hash);
    }
  });

  it('omits strategy only when no relevant source data exists', () => {
    const ctx = context({ ...samplePack, entities: [] });
    ctx.kpi = { kpis: [], okrs: [] };
    ctx.objectives = [];
    expect(createBatchPlan(ctx, 'ja', 'internal', 'demo', { objectiveIssues: [] }).map((job) => job.kind))
      .toEqual(Array(5).fill(['fields', 'brief']).flat());
  });

  it('surfaces failures and incomplete live results without saving a mock', async () => {
    const ctx = context();
    const jobs = createBatchPlan(ctx, 'ja', 'internal', 'demo', { objectiveIssues: [] });
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    setLiveTransport(vi.fn().mockRejectedValue(new Error('offline')));
    await expect(runBatchJob(jobs[0]!, new AbortController().signal)).rejects.toThrow('offline');
    expect(useFieldDrafts.getState().value).toEqual({});
    writeLedger([]);
    setLiveTransport(async () => ({ text: '### answer\n不完全', inputTokens: 10, outputTokens: 10 }));
    await expect(runBatchJob(jobs[1]!, new AbortController().signal)).rejects.toThrow('必要な項目がありません');
    expect(useStepBriefs.getState().value).toEqual({});
  });

  it('waits for the latest ledger or attempt and cancels waiting', async () => {
    const now = Date.now();
    const interval = PER_USE_LIMITS.deliverableDraft?.minIntervalMs;
    if (interval === undefined) throw new Error('Missing fixture interval');
    writeLedger([{ at: new Date(now - 2000).toISOString(), use: 'deliverableDraft', inputTokens: 1, outputTokens: 1, costJpy: null }]);
    expect(batchIntervalMs('deliverableDraft', new Map(), now)).toBe(interval - 2000);
    expect(batchIntervalMs('deliverableDraft', new Map([['deliverableDraft', now - 1000]]), now)).toBe(interval - 1000);
    const abort = new AbortController();
    const waiting = waitForBatchInterval(interval, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('detects an independently changed saved draft', () => {
    const before = batchSourceStamp();
    useFieldDrafts.getState().set({ 'internal:asis': { fields: { problem: '他の作業' }, lang: 'ja', at: '2026-11-09' } });
    expect(batchSourceStamp()).not.toBe(before);
  });
});
