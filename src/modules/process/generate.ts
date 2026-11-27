import { aiLive, AiLiveError, preflight, type AiRequest } from '../../ai/client.ts';
import { DELIVERABLE_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { loaded } from '../../data/pack.ts';
import type { Lang } from '../../i18n/core.ts';
import { currentScope } from '../../state/projects.ts';
import { loc } from '../../state/text.ts';
import { askWorkIqSections, RelayError, type WorkIqProvider, type WorkIqSectionInfo } from '../ai/relayClient.ts';
import { useAiSettings, workIqReady } from '../ai/settingsStore.ts';
import { objectiveTarget } from '../project/objectiveDraft.ts';
import { effectiveWorkflow, useProcessEdits } from './store.ts';
import { completeWorkflowWithRepair, workflowPrompt, type WorkflowEvidence } from './workflowDraft.ts';

export function processContext(lang: Lang): { purpose: string; evidence: WorkflowEvidence[] } {
  const target = objectiveTarget();
  const { workflow } = effectiveWorkflow(useProcessEdits.getState().value);
  const evidence = loaded.pack.entities.filter((e) => e.kind === 'source').map((e) => ({
    ref: e.id, title: loc(e.name, lang), url: e.url, text: `${loc(e.name, lang)}\n${loc(e.description, lang)}`,
  }));
  return {
    purpose: target ? `${target.companyName}: ${target.projectName}\n${target.purpose}\n${target.focus}` : loc(loaded.pack.company.name, lang),
    evidence: [...evidence, ...(workflow?.evidenceSources ?? []).filter((s) => !evidence.some((e) => e.ref === s.ref))],
  };
}

export function processDraftRequest(lang: Lang, scope = currentScope()): AiRequest {
  const { purpose, evidence } = processContext(lang);
  const { workflow } = effectiveWorkflow(useProcessEdits.getState().value);
  return { use: 'deliverableDraft', lang, scope, stage: 'workflow', prompt: workflowPrompt(workflow, purpose, lang, evidence), timeoutMs: DELIVERABLE_DRAFT_TIMEOUT_MS };
}

export async function generateProcess(request: AiRequest, signal: AbortSignal, progress?: (activity: 'workiq' | 'generate') => void) {
  const check = preflight(request);
  if (!check.allowed) throw new AiLiveError(check.reasons, check.reasons.join(', '), check.budget);
  const { workflow } = effectiveWorkflow(useProcessEdits.getState().value);
  const { purpose, evidence } = processContext(request.lang);
  const ai = useAiSettings.getState();
  const target = objectiveTarget();
  const notices: string[] = [];
  if (target && workIqReady(ai)) {
    progress?.('workiq');
    let sections: WorkIqSectionInfo[] = [];
    try {
      sections = await askWorkIqSections({
        company: target.companyName, project: target.projectName, purpose: target.purpose || target.projectName, focus: target.focus,
        asOf: new Date().toISOString().slice(0, 10), lang: request.lang, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        aspects: ['process'], provider: ai.provider as WorkIqProvider,
      }, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      notices.push(e instanceof RelayError ? e.code : e instanceof Error ? e.message : String(e));
    }
    for (const s of sections) {
      if ('error' in s) notices.push(`${s.key}: ${s.error}`);
      else {
        evidence.push({ ref: `wiq:${s.key}`, title: s.question, url: s.citations.find((c) => /^https:\/\//i.test(c.url))?.url, text: s.answer });
        if (s.withheld) notices.push(`${s.key}: ${s.withheld} confidential sources withheld`);
      }
    }
  }
  progress?.('generate');
  const response = await aiLive({ ...request, prompt: workflowPrompt(workflow, purpose, request.lang, evidence) }, signal);
  const parsed: unknown = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!parsed || typeof parsed !== 'object' || !('workflow' in parsed)) throw new Error('Missing workflow in AI response');
  const completed = await completeWorkflowWithRepair(workflow, parsed.workflow, request.lang, evidence, async (prompt, round) => {
    const correction = await aiLive({ ...request, prompt, stage: `workflow-repair-${round}` }, signal);
    try {
      return JSON.parse(correction.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  });
  const note = notices.length ? `${request.lang === 'ja' ? '社内情報の取得が不完全です' : 'Internal retrieval is incomplete'}: ${notices.join('; ')}` : '';
  return {
    ...completed,
    ...(note ? { draftNote: `${loc(completed.draftNote ?? '', request.lang)}\n${note}` } : {}),
  };
}
