import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflight, readLedger, setLiveTransport, setRuntimeSettingsProvider, writeLedger, type LiveCall } from '../src/ai/client.ts';
import { PER_USE_LIMITS, STEP_DRAFT_TIMEOUT_MS, type Provider } from '../src/ai/policy.ts';
import { selectOutbound, toPromptContext } from '../src/ai/redact.ts';
import { activatePack, loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { IMPROVEMENT_STEPS, useProjects, type ImprovementStep } from '../src/state/projects.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { batchIntervalMs, batchSourceStamp, createBatchPlan, runBatchJob, saveBatchResult, waitForBatchInterval, type BatchJobProgress } from '../src/modules/project/batchDraft.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { emptyDeliverables, setField, setSignOff, STEP_DEFS, type AppCheckContext } from '../src/modules/project/deliverables.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { overviewBaseline, stepBriefContext, useOverview } from '../src/modules/project/overviewModel.ts';
import { buildStepBrief, useStepBriefs } from '../src/modules/project/stepBrief.ts';
import { stepDashboard } from '../src/modules/project/stepDashboard.ts';
import { useDeliverables, useFieldDrafts, useKpiDrafts, useSolutionDrafts, useStrategy } from '../src/modules/project/stores.ts';
import { emptyKpiFields } from '../src/modules/project/kpiAdopt.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import { mockSolutionDraft } from '../src/modules/project/solutionDraft.ts';
import { useTaskDrafts } from '../src/modules/project/taskDrafts.ts';
import { workflowAnswer } from './fixtures/workflow.ts';
import { useProcessEdits } from '../src/modules/process/store.ts';
import { DIAGNOSIS_MARK, diagnosisContext, diagnosisMockAnswer, useDiagnosisDrafts } from '../src/modules/project/issueDiagnosis.ts';
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
  if (call.prompt.startsWith('[bas-proj:workflowDraft]')) return JSON.stringify(workflowAnswer(call.prompt));
  if (call.prompt.startsWith(DIAGNOSIS_MARK)) return diagnosisMockAnswer(call.prompt);
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
  useProcessEdits.getState().reset();
  useDiagnosisDrafts.getState().reset();
});

describe('all-step drafts', () => {
  it('repairs an invalid workflow response during the workflow batch job', async () => {
    const ctx = context();
    const job = createBatchPlan(ctx, 'ja', 'internal', 'demo', useOverview.getState().value).find((item) => item.kind === 'workflow')!;
    setRuntimeSettingsProvider(() => ({ provider: 'copilotSdk', liveEnabled: true, sendConsent: true, configured: true }));
    const stages: string[] = [];
    setLiveTransport(async (call) => {
      stages.push(call.stage ?? '');
      if (call.stage === 'workflow') {
        const answer = workflowAnswer(call.prompt);
        const workflow = { ...answer.workflow, parties: [{ ...answer.workflow.parties![0], kind: 'employee' }, ...answer.workflow.parties!.slice(1)] };
        return { text: JSON.stringify({ workflow }), inputTokens: 10, outputTokens: 10 };
      }
      if (call.stage === 'workflow-repair-1') return { text: 'not JSON', inputTokens: 10, outputTokens: 10 };
      expect(call.prompt).toContain('previousCorrectionError');
      return { text: JSON.stringify({ fixes: [{ path: ['parties', 0, 'kind'], value: 'customer' }] }), inputTokens: 10, outputTokens: 10 };
    });
    const result = await runBatchJob(job, new AbortController().signal);
    expect(result.kind).toBe('workflow');
    expect(stages).toEqual(['workflow', 'workflow-repair-1', 'workflow-repair-2']);
  });

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
    expect(jobs).toHaveLength(14 + solutions.length);
    expect(jobs.filter((job) => job.kind === 'fields').map((job) => job.step)).toEqual(IMPROVEMENT_STEPS);
    expect(jobs.filter((job) => job.kind === 'brief').map((job) => job.step)).toEqual(IMPROVEMENT_STEPS);
    expect(jobs.at(0)?.kind).toBe('workflow');
    expect(jobs.at(11)?.kind).toBe('strategy');
    expect(jobs.slice(12, -2).map((job) => (job.kind === 'solution' ? job.solutionId : job.kind))).toEqual(solutions);
    expect(jobs.at(-2)?.kind).toBe('diagnosis'); // FR-385: after the drafts, before the tasks
    expect(jobs.at(-1)?.kind).toBe('tasks'); // FR-376: last, after the drafts its sign-off records and fields come from

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

    // D-44: asis (22 sections) is drafted as separate fields and tasks calls, so there is one call more than jobs.
    // FR-376: the task phase's calls are tagged tasks:<todo> and counted separately.
    const before = calls.filter((call) => !call.stage?.startsWith('tasks:'));
    expect(before.map((call) => call.provider)).toEqual(Array(14 + solutions.length).fill(provider));
    expect(calls.every((call) => call.provider === provider)).toBe(true);
    expect(before.filter((call) => call.use === 'deliverableDraft').map((call) => call.stage))
      .toEqual(['workflow', 'fields-asis:fields', 'fields-asis:tasks', 'fields-tobe', 'fields-kpi', 'fields-solution', 'fields-deliverable', 'diagnosis']);
    // FR-385: the diagnosis is a draft covering every candidate issue, not confirmed data.
    const diagnosis = useDiagnosisDrafts.getState().value.internal;
    expect(diagnosis).toMatchObject({ mock: false, lang: 'ja', placeholders: [] });
    expect(Object.keys(diagnosis!.issues).sort()).toEqual(diagnosisContext(ctx, 'ja').issues.map((i) => i.id).sort());
    expect(useDeliverables.getState().value.framings).toBeUndefined();
    expect(useProcessEdits.getState().value?.workflow).toBeDefined();
    expect(calls.filter((call) => call.use === 'solutionDraft')).toHaveLength(solutions.length);
    const solutionDrafts = useSolutionDrafts.getState().value;
    for (const id of solutions) expect(solutionDrafts[`internal:${id}`]).toMatchObject({ mock: false, lang: 'ja' });
    expect(useStrategy.getState().value).toEqual(emptyStrategy()); // drafts only: the type and the documents wait for approval
    const taskDrafts = useTaskDrafts.getState().value;
    expect(Object.keys(taskDrafts).length).toBeGreaterThan(0);
    expect(taskDrafts['internal:asis-field']).toBeUndefined(); // already signed off
    expect(taskDrafts['internal:define-agree']?.ops[0]).toMatchObject({ op: 'signOff', todoId: 'define-agree' });
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
      .toEqual(['workflow', ...Array(5).fill(['fields', 'brief']).flat(), 'tasks']);
  });

  it('surfaces failures and incomplete live results without saving a mock', async () => {
    const ctx = context();
    const jobs = createBatchPlan(ctx, 'ja', 'internal', 'demo', { objectiveIssues: [] });
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    setLiveTransport(vi.fn().mockRejectedValue(new Error('offline')));
    await expect(runBatchJob(jobs.find((j) => j.kind === 'fields')!, new AbortController().signal)).rejects.toThrow('offline');
    expect(useFieldDrafts.getState().value).toEqual({});
    writeLedger([]);
    setLiveTransport(async () => ({ text: '### answer\n不完全', inputTokens: 10, outputTokens: 10 }));
    await expect(runBatchJob(jobs.find((j) => j.kind === 'brief')!, new AbortController().signal)).rejects.toThrow('必要な項目がありません');
    expect(useStepBriefs.getState().value).toEqual({});
  });

  it('D-44: an answer cut off at the output cap is retried — a deliverable as separate fields and tasks calls', async () => {
    const ctx = context();
    const jobs = createBatchPlan(ctx, 'ja', 'internal', 'demo', { objectiveIssues: [] });
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    const cutOff = () => Object.assign(new Error('relay 502 outputLimit'), { status: 502, code: 'outputLimit', usage: { inputTokens: 900, outputTokens: 32_000, reasoningTokens: 32_000 } });
    const calls: LiveCall[] = [];
    let failNext = true;
    setLiveTransport(async (call) => {
      calls.push(call);
      if (failNext) { failNext = false; throw cutOff(); }
      return { text: response(call, ctx), inputTokens: 10, outputTokens: 10 };
    });
    const tobe = jobs.find((job) => job.kind === 'fields' && job.step === 'tobe')!;
    const result = await runBatchJob(tobe, new AbortController().signal);
    expect(result.kind === 'fields' && Object.keys(result.fields)).toHaveLength(STEP_DEFS.tobe.fields.length);
    expect(calls.map((call) => call.stage)).toEqual(['fields-tobe', 'fields-tobe:fields', 'fields-tobe:tasks']);
    expect(calls[1]!.prompt).toContain('This call covers only the fields');
    expect(calls[2]!.prompt).toContain('This call covers only the tasks');
    // The cut-off answer is billed, so the ledger keeps its reported tokens.
    expect(readLedger().find((entry) => entry.failed)).toMatchObject({ use: 'deliverableDraft', failed: 'outputLimit', inputTokens: 900, outputTokens: 32_000, stage: 'fields-tobe' });

    writeLedger([]);
    calls.length = 0;
    failNext = true;
    const brief = jobs.find((job) => job.kind === 'brief' && job.step === 'tobe')!;
    await expect(runBatchJob(brief, new AbortController().signal)).resolves.toMatchObject({ kind: 'brief' });
    expect(calls).toHaveLength(2);

    writeLedger([]);
    calls.length = 0;
    setLiveTransport(async (call) => { calls.push(call); throw cutOff(); });
    await expect(runBatchJob(brief, new AbortController().signal)).rejects.toThrow('outputLimit');
    expect(calls).toHaveLength(2);
    writeLedger([]);
    calls.length = 0;
    setLiveTransport(async (call) => { calls.push(call); throw Object.assign(new Error('relay 502 providerError'), { status: 502, code: 'providerError' }); });
    await expect(runBatchJob(brief, new AbortController().signal)).rejects.toThrow('providerError');
    expect(calls).toHaveLength(1);
  });

  it('reports the actual split calls and the output-limit retry in order', async () => {
    const ctx = context();
    const jobs = createBatchPlan(ctx, 'ja', 'internal', 'demo', { objectiveIssues: [] });
    const asis = jobs.find((job) => job.kind === 'fields' && job.step === 'asis')!;
    const tobe = jobs.find((job) => job.kind === 'fields' && job.step === 'tobe')!;
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    let failNext = false;
    setLiveTransport(async (call) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('outputLimit'), { code: 'outputLimit' });
      }
      return { text: response(call, ctx), inputTokens: 10, outputTokens: 10 };
    });
    const signal = new AbortController().signal;
    const progress: BatchJobProgress[] = [];
    await runBatchJob(asis, signal, (phase) => progress.push(phase));
    expect(progress).toEqual([
      { activity: 'fields', part: { current: 1, total: 2 }, retry: false },
      { activity: 'tasks', part: { current: 2, total: 2 }, retry: false },
    ]);

    progress.length = 0;
    failNext = true;
    await runBatchJob(tobe, signal, (phase) => progress.push(phase));
    expect(progress).toEqual([
      { activity: 'generate', retry: false },
      { activity: 'fields', part: { current: 1, total: 2 }, retry: true },
      { activity: 'tasks', part: { current: 2, total: 2 }, retry: true },
    ]);
  });

  it('waits for the latest ledger or attempt and cancels waiting', async () => {
    const now = Date.now();
    const interval = PER_USE_LIMITS.explain?.minIntervalMs;
    if (interval === undefined) throw new Error('Missing fixture interval');
    writeLedger([{ at: new Date(now - 2000).toISOString(), use: 'explain', inputTokens: 1, outputTokens: 1 }]);
    expect(batchIntervalMs('explain', new Map(), now)).toBe(interval - 2000);
    expect(batchIntervalMs('explain', new Map([['explain', now - 1000]]), now)).toBe(interval - 1000);
    const abort = new AbortController();
    const waiting = waitForBatchInterval(interval, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('D-41: runs at any time — no daily count, interval or input-size limit on any batch job', async () => {
    const ctx = context();
    const jobs = createBatchPlan(ctx, 'ja', 'internal', 'demo', useOverview.getState().value);
    const uses = [...new Set(jobs.map((job) => job.request.use))];
    expect(uses.sort()).toEqual(['deliverableDraft', 'solutionDraft', 'stepBrief', 'strategyOverview']);
    // 100 calls of every use today, the last one a moment ago.
    const now = Date.now();
    writeLedger(uses.flatMap((use) => Array.from({ length: 100 }, (_, i) => ({ at: new Date(now - i * 10).toISOString(), use, inputTokens: 1, outputTokens: 1 }))));
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    const huge = 'あ'.repeat(300_000);
    for (const job of jobs) {
      expect(batchIntervalMs(job.request.use, new Map([[job.request.use, now]]), now)).toBe(0);
      expect(preflight(job.request).allowed).toBe(true);
      expect(preflight({ ...job.request, prompt: `${job.request.prompt}${huge}` }).reasons).toContain('inputTooLarge');
    }
    for (const job of jobs.filter((item) => item.request.use !== 'deliverableDraft' && item.request.use !== 'solutionDraft')) expect(job.request.timeoutMs).toBe(STEP_DRAFT_TIMEOUT_MS);
    setLiveTransport(async (call) => ({ text: response(call, ctx), inputTokens: 10, outputTokens: 10 }));
    const signal = new AbortController().signal;
    for (const job of jobs) saveBatchResult(job, await runBatchJob(job, signal), ctx, 'internal', 'foundry');
    expect(Object.keys(useFieldDrafts.getState().value)).toHaveLength(IMPROVEMENT_STEPS.length);
  });

  it('detects an independently changed saved draft', () => {
    const before = batchSourceStamp();
    useFieldDrafts.getState().set({ 'internal:asis': { fields: { problem: '他の作業' }, lang: 'ja', at: '2026-11-09' } });
    expect(batchSourceStamp()).not.toBe(before);
  });
});

describe('D-46: KPI/OKR drafts in the all-step batch', () => {
  const okr = {
    kpis: [
      { id: 'k-reach', name: 'Customer Reach', definition: 'FY27の顧客リーチ拡大', target: '10倍', unit: '倍', current: '未計測', period: 'FY27', sourceIds: [] },
      { id: 'k-wins', name: 'Platform Wins', definition: '最低5件', period: 'FY27', sourceIds: [] },
    ],
    objectives: [],
  };
  const savedProjects = useProjects.getState().projects;
  afterEach(() => {
    activatePack(samplePack, { kind: 'sample' });
    useProjects.setState({ projects: savedProjects });
    useKpiDrafts.getState().reset();
  });

  it('runs for the project\'s own pack: picks candidates, then estimates every empty field, and stores only drafts', async () => {
    const packData = { ...samplePack, extensions: { ...samplePack.extensions, okr } } as typeof samplePack;
    activatePack(packData, { kind: 'imported', projectId: 'pj-kpi' });
    useProjects.setState({ projects: [{ id: 'pj-kpi', companyId: '', brief: { purpose: '顧客接点の拡大' } } as never] });
    const ctx = context(packData);
    const jobs = createBatchPlan(ctx, 'ja', 'internal', 'pj-kpi', useOverview.getState().value);
    const job = jobs.find((j) => j.kind === 'kpiOkr');
    expect(job).toBeDefined();
    expect(createBatchPlan(ctx, 'ja', 'external', 'pj-kpi', useOverview.getState().value).some((j) => j.kind === 'kpiOkr')).toBe(false);

    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    const calls: LiveCall[] = [];
    setLiveTransport(async (call) => {
      calls.push(call);
      if (call.prompt.includes('Mode: fill')) {
        const data = JSON.parse(call.prompt.split('\n')[2]!) as { kpis: { id: string; missing: string[] }[] };
        const value: Record<string, string> = { unit: '件', baseline: '0', current: '0', target: '5', deadline: '2027-06-30' };
        return { text: JSON.stringify({ kpis: data.kpis.map((k) => ({ id: k.id, fields: Object.fromEntries(k.missing.map((f) => [f, { value: value[f], why: '推定' }])) })), okrs: [] }), inputTokens: 1, outputTokens: 1 };
      }
      return { text: JSON.stringify({ kpis: [{ id: 'okr.kpi:k-reach', reason: '目的に合う' }, { id: 'okr.kpi:k-wins', reason: '目的に合う' }], okrs: [] }), inputTokens: 1, outputTokens: 1 };
    });
    const result = await runBatchJob(job!, new AbortController().signal);
    expect(calls.map((c) => c.use)).toEqual(['kpiOkrDraft', 'kpiOkrDraft']);
    expect(useKpiDrafts.getState().value.kpis).toHaveLength(0);
    saveBatchResult(job!, result, ctx, 'internal', 'foundry');
    const drafts = useKpiDrafts.getState().value.kpis;
    expect(drafts.map((d) => d.name)).toEqual(['Customer Reach', 'Platform Wins']);
    for (const d of drafts) expect(emptyKpiFields(d)).toEqual([]);
    expect(drafts[1]!.estimated).toMatchObject({ target: '推定', deadline: '推定' });
  });

  it('asks again while an answer leaves fields empty, then sets the rest provisionally so no field stays blank', async () => {
    const packData = { ...samplePack, extensions: { ...samplePack.extensions, okr } } as typeof samplePack;
    activatePack(packData, { kind: 'imported', projectId: 'pj-kpi' });
    useProjects.setState({ projects: [{ id: 'pj-kpi', companyId: '', brief: { purpose: '顧客接点の拡大' } } as never] });
    const ctx = context(packData);
    const job = createBatchPlan(ctx, 'ja', 'internal', 'pj-kpi', useOverview.getState().value).find((j) => j.kind === 'kpiOkr')!;
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    const fills: string[][] = [];
    setLiveTransport(async (call) => {
      if (!call.prompt.includes('Mode: fill')) {
        return { text: JSON.stringify({ kpis: [{ id: 'okr.kpi:k-reach', reason: '目的に合う' }, { id: 'okr.kpi:k-wins', reason: '目的に合う' }], okrs: [] }), inputTokens: 1, outputTokens: 1 };
      }
      const data = JSON.parse(call.prompt.split('\n')[2]!) as { kpis: { id: string; name: string; missing: string[] }[] };
      fills.push(data.kpis.flatMap((k) => k.missing.map((f) => `${k.name}.${f}`)));
      // Round 1 completes Customer Reach but answers Platform Wins with a period instead of a date; round 2 adds nothing.
      const answer = fills.length > 1 ? [] : data.kpis.map((k) => ({
        id: k.id,
        fields: k.name === 'Customer Reach'
          ? { baseline: { value: '1', why: '推定' }, current: { value: '1', why: '推定' }, deadline: { value: '2027-06-30', why: 'FY27 の期末' } }
          : { unit: { value: '件', why: '推定' }, deadline: { value: 'FY27', why: '日付でない' } },
      }));
      return { text: JSON.stringify({ kpis: answer, okrs: [] }), inputTokens: 1, outputTokens: 1 };
    });
    const result = await runBatchJob(job, new AbortController().signal);
    expect(fills).toEqual([
      ['Customer Reach.baseline', 'Customer Reach.current', 'Customer Reach.deadline', 'Platform Wins.unit', 'Platform Wins.baseline', 'Platform Wins.current', 'Platform Wins.target', 'Platform Wins.deadline'],
      ['Platform Wins.baseline', 'Platform Wins.current', 'Platform Wins.target', 'Platform Wins.deadline'],
    ]);
    expect(result).toMatchObject({ kind: 'kpiOkr', run: { fill: { rounds: 2, fields: 4, provisional: 4, remaining: 0 } } });
    saveBatchResult(job, result, ctx, 'internal', 'foundry');
    const wins = useKpiDrafts.getState().value.kpis.find((d) => d.name === 'Platform Wins')!;
    expect(emptyKpiFields(wins)).toEqual([]);
    expect(wins).toMatchObject({ unit: '件', baseline: '0', current: '0', target: '0', deadline: '2027-06-30' });
    expect(wins.estimated).toEqual({ unit: '推定' });
    expect(wins.provisional).toEqual({ baseline: 'baselineZero', current: 'currentBaseline', target: 'targetBaseline', deadline: 'deadlineSamePeriod' });
  });
});
