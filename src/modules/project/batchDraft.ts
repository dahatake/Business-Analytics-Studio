import { liveErrorCode, readLedger, type AiRequest } from '../../ai/client.ts';
import { PER_USE_LIMITS, STEP_DRAFT_TIMEOUT_MS, type AiUse, type Provider } from '../../ai/policy.ts';
import { appStorage } from '../../data/deviceStorage.ts';
import { loaded } from '../../data/pack.ts';
import type { Lang } from '../../i18n/core.ts';
import { companyAnchorKey } from '../../state/companyAnchors.ts';
import { usePackVersion } from '../../state/packEdits.ts';
import { currentScope, IMPROVEMENT_STEPS, useProjects, type ImprovementStep } from '../../state/projects.ts';
import { useSettings, type Audience } from '../../state/settings.ts';
import { useUseCases } from '../usecases/store.ts';
import { useAiSettings } from '../ai/settingsStore.ts';
import { draftRequest, requestDeliverableDraft, type DraftInput } from './deliverableDraft.ts';
import { normalizeDeliverables, type AppCheckContext } from './deliverables.ts';
import {
  overviewBaseline, overviewContext, overviewPrompt, recommendedAxis, requestLiveOverview, stepBriefContext, strategyMap, useOverview,
  type OverviewProposal, type OverviewState,
} from './overviewModel.ts';
import { buildStepBrief, requestLiveStepBrief, setStepBrief, stepBriefRequest, useStepBriefs, type GeneratedBrief, type StepBrief } from './stepBrief.ts';
import { stepDashboard } from './stepDashboard.ts';
import {
  draftableSolutions, requestLiveSolutionDraft, solutionBaseline, solutionDraftKey, solutionDraftRequest,
  type SavedSolutionDraft, type SolutionDraft, type SolutionDraftInput,
} from './solutionDraft.ts';
import { collectObjectives, objectivePlanRequest, storeObjectives, type ObjectiveCollection, type ObjectiveSearch } from './objectiveDraft.ts';
import { normalizeStrategy } from './strategy.ts';
import { kpiOkrPlanRequest, kpiOkrTarget, runKpiOkrDraft, type KpiOkrRun } from './kpiAutoDraft.ts';
import { loc } from '../../state/text.ts';
import { translate } from '../../i18n/core.ts';
import { DELIVERABLE_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { draftAllTasks, normalizeTaskDrafts, resolutionTransport, taskDraftKey, useTaskDrafts, type TaskDraft } from './taskDrafts.ts';
import { useAnalyses, useDeliverables, useDiscussion, useFieldDrafts, useKpiDrafts, useKpis, useObjectiveDrafts, useProjUi, useSolutionDrafts, useStrategy } from './stores.ts';
import type { WorkflowExtension } from '../../data/extensionSchemas.ts';
import { generateProcess, processDraftRequest } from '../process/generate.ts';
import { saveWorkflow, useProcessEdits } from '../process/store.ts';
import {
  diagnosisBaseline, diagnosisContext, diagnosisRequest, diagnosisRules, requestLiveDiagnosis, useDiagnosisDrafts,
  type DiagnosisContext, type DiagnosisRules, type DiagnosisRun, type SavedDiagnosis,
} from './issueDiagnosis.ts';

type FieldJob = { kind: 'fields'; step: ImprovementStep; input: DraftInput; request: AiRequest };
type BriefJob = { kind: 'brief'; step: ImprovementStep; brief: StepBrief; request: AiRequest };
type StrategyJob = { kind: 'strategy'; context: AppCheckContext; request: AiRequest };
type SolutionJob = { kind: 'solution'; solutionId: string; name: string; input: SolutionDraftInput; request: AiRequest };
/** FR-367: the company and unit objectives (Work IQ is searched when the job runs; the request here is for the checks). */
type ObjectivesJob = { kind: 'objectives'; request: AiRequest };
/** D-46: the project's KPI/OKR drafts from the internal candidates, every empty field estimated (the request is the first call, for the checks). */
type KpiOkrJob = { kind: 'kpiOkr'; request: AiRequest; today: string };
/** FR-376: the last phase, a draft for every open task built on the data as it is when the job runs (the request is for the checks). */
type TasksJob = { kind: 'tasks'; request: AiRequest; ctx: AppCheckContext; audience: Audience };
type WorkflowJob = { kind: 'workflow'; request: AiRequest };
/** FR-385: the issue diagnosis (situation, crux, each issue's question and frame), drafted for a person to approve. */
type DiagnosisJob = { kind: 'diagnosis'; request: AiRequest; context: DiagnosisContext; rules: DiagnosisRules };
export type BatchJob = FieldJob | BriefJob | StrategyJob | SolutionJob | ObjectivesJob | KpiOkrJob | TasksJob | WorkflowJob | DiagnosisJob;
export type BatchResult =
  | { kind: 'fields'; fields: Record<string, string>; tasks: Record<string, string> }
  | { kind: 'brief'; brief: GeneratedBrief }
  | { kind: 'strategy'; proposal: OverviewProposal; inputTokens: number | null; outputTokens: number | null }
  | { kind: 'solution'; draft: SolutionDraft }
  | { kind: 'objectives'; collection: ObjectiveCollection }
  | { kind: 'kpiOkr'; run: KpiOkrRun }
  | { kind: 'workflow'; workflow: WorkflowExtension }
  | { kind: 'diagnosis'; run: DiagnosisRun }
  | { kind: 'tasks'; drafts: TaskDraft[]; failed: { todoId: string; message: string }[] };

export interface BatchJobProgress {
  activity: 'workiq' | 'generate' | 'fields' | 'tasks';
  part?: { current: number; total: number };
  retry?: boolean;
  objectiveSearch?: ObjectiveSearch;
}

export function batchJobId(job: BatchJob): string {
  if (job.kind === 'solution') return `solution-${job.solutionId}`;
  if (job.kind === 'objectives' || job.kind === 'kpiOkr' || job.kind === 'tasks' || job.kind === 'workflow' || job.kind === 'diagnosis') return job.kind;
  return job.kind === 'strategy' ? 'strategy' : `${job.kind}-${job.step}`;
}

export function createBatchPlan(ctx: AppCheckContext, lang: Lang, audience: Audience, scope: string, overview: OverviewState): BatchJob[] {
  const jobs: BatchJob[] = [];
  // First, so the objectives are in place before the rest is reviewed. Internal only: they are the customer's own goals.
  const objectives = audience === 'internal' ? objectivePlanRequest(ctx.pack.pack, lang, scope) : null;
  if (objectives) jobs.push({ kind: 'objectives', request: objectives });
  // After the objectives, so the OKRs can be linked to them. Internal only: the candidates are the customer's internal KPIs.
  const kpiTarget = audience === 'internal' ? kpiOkrTarget(scope) : null;
  const today = new Date().toISOString().slice(0, 10);
  const kpiOkr = kpiTarget ? kpiOkrPlanRequest(kpiTarget, ctx.pack.pack, lang, today) : null;
  if (kpiOkr) jobs.push({ kind: 'kpiOkr', request: kpiOkr, today });
  if (audience === 'internal') jobs.push({ kind: 'workflow', request: processDraftRequest(lang, scope) });
  const briefCtx = stepBriefContext(ctx, audience);
  for (const step of IMPROVEMENT_STEPS) {
    const input: DraftInput = { step, ctx, lang, audience };
    const brief = buildStepBrief(stepDashboard(step, briefCtx), briefCtx, lang, audience);
    jobs.push({ kind: 'fields', step, input, request: { ...draftRequest(input), scope } });
    jobs.push({ kind: 'brief', step, brief, request: stepBriefRequest(brief, briefCtx, lang, scope) });
  }
  const context = overviewContext(ctx, audience);
  const state = audience === 'internal' ? overview : { ...overview, objectiveIssues: [] };
  if (strategyMap(context, state, recommendedAxis(context), lang).nodes.length) {
    jobs.push({ kind: 'strategy', context, request: { use: 'strategyOverview', lang, prompt: overviewPrompt(context, state, lang, audience), scope, timeoutMs: STEP_DRAFT_TIMEOUT_MS } });
  }
  // The last phase: each solution's type and every open section of its requirements definition, specification or plan.
  for (const solution of draftableSolutions(ctx, audience)) {
    const input: SolutionDraftInput = { solutionId: solution.id, ctx, lang, audience };
    const request = solutionDraftRequest(input);
    if (request) jobs.push({ kind: 'solution', solutionId: solution.id, name: loc(solution.name, lang), input, request: { ...request, scope } });
  }
  // FR-385: internal only (the issues may be internal); after the drafts above, before the tasks.
  if (audience === 'internal') {
    const context = diagnosisContext(ctx, lang, 'internal');
    if (context.issues.length) jobs.push({ kind: 'diagnosis', context, rules: diagnosisRules(ctx, context), request: diagnosisRequest(context, scope) });
  }
  // FR-376: last, so each task is drafted after the deliverable drafts its sign-off records and fields come from.
  jobs.push({ kind: 'tasks', ctx, audience, request: { use: 'deliverableDraft', lang, prompt: '[bas-proj:task:all]', scope, timeoutMs: DELIVERABLE_DRAFT_TIMEOUT_MS } });
  return jobs;
}

export async function runBatchJob(job: BatchJob, signal: AbortSignal, onProgress?: (progress: BatchJobProgress) => void): Promise<BatchResult> {
  // The job id goes to the relay's diagnostics log, so a failure there names the job it belongs to (D-44).
  const request: AiRequest = { ...job.request, stage: batchJobId(job) };
  if (job.kind === 'workflow') return { kind: 'workflow', workflow: await generateProcess(request, signal, (activity) => onProgress?.({ activity })) };
  if (job.kind === 'diagnosis') {
    onProgress?.({ activity: 'generate' });
    return { kind: 'diagnosis', run: await requestLiveDiagnosis(job.context, job.rules, request, signal) };
  }
  if (job.kind === 'fields') {
    const result = await requestDeliverableDraft(job.input, { ...request, prompt: draftRequest(job.input).prompt }, signal, (progress) => onProgress?.({
      activity: progress.part ?? 'generate',
      ...(progress.total > 1 ? { part: { current: progress.current, total: progress.total } } : {}),
      retry: progress.retry,
    }));
    return { kind: 'fields', fields: result.fields, tasks: result.tasks };
  }
  if (job.kind === 'objectives') return {
    kind: 'objectives',
    collection: await collectObjectives(loaded.pack, request.lang, signal, undefined, (activity, objectiveSearch) => onProgress?.({
      activity, ...(objectiveSearch ? { objectiveSearch } : {}),
    })),
  };
  if (job.kind === 'kpiOkr') {
    const target = kpiOkrTarget(job.request.scope ?? '');
    if (!target) throw new Error('The Project pack of this project is no longer active');
    onProgress?.({ activity: 'generate' });
    return { kind: 'kpiOkr', run: await runKpiOkrDraft(target, loaded.pack, request.lang, job.today, signal, (step) => onProgress?.({ activity: 'generate', part: { current: step === 'pick' ? 1 : 2, total: 2 } })) };
  }
  if (job.kind === 'tasks') {
    const lang = request.lang;
    const deliverables = normalizeDeliverables(useDeliverables.getState().value);
    const ctx: AppCheckContext = { ...job.ctx, pack: loaded, deliverables, discussion: useDiscussion.getState().value };
    let current = '';
    const transport = resolutionTransport(job.request.scope ?? '', signal, (reasons) => reasons.join(' '), () => translate(lang, 'dlv.draft.tooLarge'), () => `tasks:${current}`);
    const fieldDrafts = useFieldDrafts.getState().value;
    const result = await draftAllTasks(
      { ctx, lang, audience: job.audience, editor: useProjUi.getState().editor },
      {
        recommendation: (todoId) => deliverables.recommendations?.[`${job.audience}:${todoId}`]?.draft?.text,
        fieldDraft: (step) => fieldDrafts[`${job.audience}:${step}`]?.fields,
      },
      { transport, aborted: () => signal.aborted },
      (progress) => {
        current = progress.todoId;
        onProgress?.({ activity: 'generate', part: { current: progress.current, total: progress.total } });
      },
    );
    return { kind: 'tasks', ...result };
  }
  // An answer cut off at the output cap varies with the model's reasoning, so one more attempt usually completes (D-44).
  const once = async <T>(call: () => Promise<T>): Promise<T> => {
    onProgress?.({ activity: 'generate' });
    try {
      return await call();
    } catch (err) {
      if (signal.aborted || liveErrorCode(err) !== 'outputLimit') throw err;
      onProgress?.({ activity: 'generate', retry: true });
      return call();
    }
  };
  if (job.kind === 'brief') return { kind: 'brief', brief: await once(() => requestLiveStepBrief(job.brief, request, signal)) };
  if (job.kind === 'solution') return { kind: 'solution', draft: await once(() => requestLiveSolutionDraft(job.input, request, signal)) };
  const live = await once(() => requestLiveOverview(request, job.context, request.lang, undefined, 'internal', signal));
  return { kind: 'strategy', proposal: live.proposal, inputTokens: live.inputTokens, outputTokens: live.outputTokens };
}

/** Snapshot all mutable inputs and existing drafts so another tab cannot silently overwrite them. */
export function batchSourceStamp(includePack = true): string {
  const projects = useProjects.getState();
  const scope = currentScope();
  const project = projects.projects.find((item) => item.id === scope);
  const company = projects.companies.find((item) => item.id === project?.companyId);
  const ai = useAiSettings.getState();
  return JSON.stringify({
    scope, project, company, anchor: company ? appStorage.getItem(companyAnchorKey(company.id)) : null,
    pack: includePack ? loaded.pack : null, packVersion: includePack ? usePackVersion.getState().version : null,
    discussion: useDiscussion.getState().value, kpi: useKpis.getState().value, analysis: useAnalyses.getState().value,
    useCases: useUseCases.getState().value, deliverables: useDeliverables.getState().value, strategy: useStrategy.getState().value,
    fieldDrafts: useFieldDrafts.getState().value, objectiveDrafts: useObjectiveDrafts.getState().value, kpiDrafts: useKpiDrafts.getState().value, solutionDrafts: useSolutionDrafts.getState().value, briefs: useStepBriefs.getState().value, overview: useOverview.getState().value,
    taskDrafts: useTaskDrafts.getState().value,
    diagnosisDrafts: useDiagnosisDrafts.getState().value,
    workflow: useProcessEdits.getState().value,
    audience: useSettings.getState().audience, lang: useSettings.getState().lang,
    provider: ai.provider, liveEnabled: ai.liveEnabled, model: ai.copilotModel, connection: ai.relayConnection,
    relayReachable: ai.relayReachable, foundryKeySaved: ai.foundryKeySaved,
    connectionVerifiedAt: ai.connectionVerifiedAt, authMethod: ai.authMethod,
  });
}

export function batchIntervalMs(use: AiUse, attempts: ReadonlyMap<AiUse, number>, now = Date.now()): number {
  const interval = PER_USE_LIMITS[use]?.minIntervalMs ?? 0;
  const times = readLedger().filter((entry) => entry.use === use).map((entry) => Date.parse(entry.at)).filter(Number.isFinite);
  const last = Math.max(attempts.get(use) ?? 0, ...times, 0);
  return Math.max(0, last + interval - now);
}

export function waitForBatchInterval(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function saveBatchResult(
  job: BatchJob, result: BatchResult, ctx: AppCheckContext, audience: Audience, provider: Provider,
): void {
  if (job.kind === 'workflow' && result.kind === 'workflow') {
    saveWorkflow(result.workflow);
  } else if (job.kind === 'diagnosis' && result.kind === 'diagnosis') {
    const saved: SavedDiagnosis = { ...result.run, lang: job.request.lang, at: new Date().toISOString(), baseline: diagnosisBaseline(job.context) };
    useDiagnosisDrafts.getState().set((value) => ({ ...value, [audience]: saved }));
  } else if (job.kind === 'fields' && result.kind === 'fields') {
    const at = new Date().toISOString();
    useDeliverables.getState().set((value) => {
      const data = normalizeDeliverables(value);
      const recommendations = { ...data.recommendations };
      for (const [id, text] of Object.entries(result.tasks)) {
        const key = `${audience}:${id}`;
        recommendations[key] = { ...recommendations[key], draft: { text, mock: false, at } };
      }
      return { ...data, recommendations };
    });
    useFieldDrafts.getState().set((value) => ({ ...value, [`${audience}:${job.step}`]: { fields: result.fields, lang: job.request.lang, at } }));
  } else if (job.kind === 'brief' && result.kind === 'brief') {
    setStepBrief(`${audience}:${job.step}`, result.brief);
  } else if (job.kind === 'strategy' && result.kind === 'strategy') {
    const current = { ...ctx, deliverables: normalizeDeliverables(useDeliverables.getState().value) };
    const baseline = overviewBaseline(current, useOverview.getState().value);
    useOverview.getState().set((value) => ({
      ...value,
      draft: { proposal: result.proposal, baseline, lang: job.request.lang, audience, at: new Date().toISOString(), provider, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    }));
  } else if (job.kind === 'solution' && result.kind === 'solution') {
    const draft: SavedSolutionDraft = {
      ...result.draft, lang: job.request.lang, at: new Date().toISOString(), mock: false,
      baseline: solutionBaseline(normalizeStrategy(useStrategy.getState().value), job.solutionId),
    };
    useSolutionDrafts.getState().set((value) => ({ ...value, [solutionDraftKey(audience, job.solutionId)]: draft }));
  } else if (job.kind === 'objectives' && result.kind === 'objectives') {
    storeObjectives(result.collection);
  } else if (job.kind === 'kpiOkr' && result.kind === 'kpiOkr') {
    useKpiDrafts.getState().set(result.run.drafts);
  } else if (job.kind === 'tasks' && result.kind === 'tasks') {
    // A new batch replaces this audience's task drafts; the other audience's stay.
    useTaskDrafts.getState().set((value) => ({
      ...Object.fromEntries(Object.entries(normalizeTaskDrafts(value)).filter(([key]) => !key.startsWith(`${audience}:`))),
      ...Object.fromEntries(result.drafts.map((draft) => [taskDraftKey(audience, draft.todoId), draft])),
    }));
  } else {
    throw new Error('Batch result does not match its request');
  }
}
