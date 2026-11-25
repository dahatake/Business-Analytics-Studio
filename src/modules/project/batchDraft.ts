import { aiLive, readLedger, type AiRequest } from '../../ai/client.ts';
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
  overviewBaseline, overviewContext, overviewPrompt, parseOverviewResponse, recommendedAxis, stepBriefContext, strategyMap, useOverview,
  type OverviewProposal, type OverviewState,
} from './overviewModel.ts';
import { buildStepBrief, requestLiveStepBrief, setStepBrief, stepBriefRequest, useStepBriefs, type GeneratedBrief, type StepBrief } from './stepBrief.ts';
import { stepDashboard } from './stepDashboard.ts';
import {
  draftableSolutions, requestLiveSolutionDraft, solutionBaseline, solutionDraftKey, solutionDraftRequest,
  type SavedSolutionDraft, type SolutionDraft, type SolutionDraftInput,
} from './solutionDraft.ts';
import { normalizeStrategy } from './strategy.ts';
import { loc } from '../../state/text.ts';
import { useAnalyses, useDeliverables, useDiscussion, useFieldDrafts, useKpis, useSolutionDrafts, useStrategy } from './stores.ts';

type FieldJob = { kind: 'fields'; step: ImprovementStep; input: DraftInput; request: AiRequest };
type BriefJob = { kind: 'brief'; step: ImprovementStep; brief: StepBrief; request: AiRequest };
type StrategyJob = { kind: 'strategy'; context: AppCheckContext; request: AiRequest };
type SolutionJob = { kind: 'solution'; solutionId: string; name: string; input: SolutionDraftInput; request: AiRequest };
export type BatchJob = FieldJob | BriefJob | StrategyJob | SolutionJob;
export type BatchResult =
  | { kind: 'fields'; fields: Record<string, string>; tasks: Record<string, string> }
  | { kind: 'brief'; brief: GeneratedBrief }
  | { kind: 'strategy'; proposal: OverviewProposal; inputTokens: number | null; outputTokens: number | null }
  | { kind: 'solution'; draft: SolutionDraft };

export function batchJobId(job: BatchJob): string {
  if (job.kind === 'solution') return `solution-${job.solutionId}`;
  return job.kind === 'strategy' ? 'strategy' : `${job.kind}-${job.step}`;
}

export function createBatchPlan(ctx: AppCheckContext, lang: Lang, audience: Audience, scope: string, overview: OverviewState): BatchJob[] {
  const jobs: BatchJob[] = [];
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
  return jobs;
}

export async function runBatchJob(job: BatchJob, signal: AbortSignal): Promise<BatchResult> {
  const request = job.request;
  if (job.kind === 'fields') {
    const result = await requestDeliverableDraft(job.input, request, signal);
    return { kind: 'fields', fields: result.fields, tasks: result.tasks };
  }
  if (job.kind === 'brief') return { kind: 'brief', brief: await requestLiveStepBrief(job.brief, request, signal) };
  if (job.kind === 'solution') return { kind: 'solution', draft: await requestLiveSolutionDraft(job.input, request, signal) };
  const live = await aiLive(request, signal);
  return { kind: 'strategy', proposal: parseOverviewResponse(live.text, job.context, request.lang), inputTokens: live.inputTokens, outputTokens: live.outputTokens };
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
    fieldDrafts: useFieldDrafts.getState().value, solutionDrafts: useSolutionDrafts.getState().value, briefs: useStepBriefs.getState().value, overview: useOverview.getState().value,
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
  if (job.kind === 'fields' && result.kind === 'fields') {
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
  } else {
    throw new Error('Batch result does not match its request');
  }
}
