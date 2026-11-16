import { useEffect, useId, useRef, useState } from 'react';
import { Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Radio, RadioGroup, Textarea } from '@fluentui/react-components';
import { AiLiveError, preflight } from '../../ai/client.ts';
import { DELIVERABLE_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { deviceStatus, flushDeviceStorage } from '../../data/deviceStorage.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { commitPackChanges } from '../../state/packEdits.ts';
import { currentScope, useCurrentScope } from '../../state/projects.ts';
import { useSettings } from '../../state/settings.ts';
import { reasonKey, useLiveConfirm } from '../ai/AiCommon.tsx';
import { AiProgress, type AiStage } from '../ai/AiProgress.tsx';
import { useAiSettings } from '../ai/settingsStore.ts';
import { batchSourceStamp } from './batchDraft.ts';
import { evaluateStep, normalizeDeliverables, resultKey, STEP_DEFS, todoKey } from './deliverables.ts';
import { Refs, todoHref, useCheckContext } from './deliverablesUi.tsx';
import { useDeliverables, useProjTransient, useProjUi } from './stores.ts';
import {
  previewResolution, repairDescription, repairOptions, requestResolution, resolutionRequest, resolutionTodo, RESOLUTION_GUIDANCE_MAX,
  type RepairOption, type ResolutionInput, type ResolutionProposal,
} from './taskResolution.ts';

type ReadyResolution = { input: ResolutionInput; options: RepairOption[]; proposal: ResolutionProposal; stamp: string };
type Applied = 'repaired' | 'decided';
const OTHER = '__other';

export function TaskResolutionDialog({ todoId }: { todoId: string }) {
  const { t, lang } = useI18n();
  const ctx = useCheckContext();
  const scope = useCurrentScope();
  const audience = useSettings((s) => s.audience);
  const settings = useAiSettings();
  const close = useProjTransient((s) => s.closeResolution);
  const uid = useId();
  const [initialTarget] = useState(() => ({ scope, audience, lang }));
  const [ready, setReady] = useState<ReadyResolution | null>(null);
  const [choiceId, setChoiceId] = useState('');
  const [otherText, setOtherText] = useState('');
  const [progress, setProgress] = useState<{ stage: AiStage; startedAt?: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const { dialog: confirmDialog, confirmLive } = useLiveConfirm();
  const step = Object.values(STEP_DEFS).find((def) => def.todos.some((todo) => todo.id === todoId))!.step;
  const input: ResolutionInput = { step, ctx, lang, audience, todoId };
  const result = resolutionTodo(input);
  const busy = progress !== null || applying;
  const stale = !!ready && !applied && batchSourceStamp() !== ready.stamp;
  const other = choiceId === OTHER;
  const choice = ready?.proposal.choices.find((c) => c.id === choiceId);
  const recommended = ready?.proposal.choices.find((c) => c.id === ready.proposal.recommendedId);
  let preview: ReturnType<typeof previewResolution> | null = null;
  let previewError: string | null = null;
  if (ready && choice && !stale && !applied) {
    try {
      preview = previewResolution(ready.input, choice, ready.options, new Date().toISOString());
    } catch (value) {
      previewError = value instanceof Error ? value.message : String(value);
    }
  }
  const canApply = !busy && !stale && !applied && !!ready && (other ? !!otherText.trim() : !!preview);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (scope !== initialTarget.scope || audience !== initialTarget.audience || lang !== initialTarget.lang) {
      controller.current?.abort();
      close();
    }
  }, [scope, audience, lang, initialTarget, close]);

  const errorText = (value: unknown) => value instanceof AiLiveError
    ? value.reasons.includes('liveFailed') ? t('dlv.batch.liveFailed', { detail: value.message }) : value.reasons.map((reason) => t(reasonKey(reason))).join(' ')
    : value instanceof Error ? value.message : String(value);
  const assertStamp = (stamp: string, includePack = true) => {
    if (batchSourceStamp(includePack) !== stamp) throw new Error(t('dlv.resolve.changed'));
  };

  const generate = async (guidance = '') => {
    if (running.current || result.done) return;
    running.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    setCancelled(false);
    // Keep the current choices (and the reviewer's own text) until a new proposal actually replaces them.
    setProgress({ stage: 'confirm' });
    try {
      const stamp = batchSourceStamp();
      const options = repairOptions(input);
      const request = { ...resolutionRequest(input, options, guidance), scope };
      const check = preflight({ ...request, userConfirmed: true, personConfirmed: true });
      if (!check.allowed) throw new AiLiveError(check.reasons, check.reasons.map((reason) => t(reasonKey(reason))).join(' '), check.budget);
      if (request.prompt.length + check.context.length > 32_000) throw new Error(t('dlv.draft.tooLarge'));
      const decision = await confirmLive({
        use: 'ai.use.deliverableDraft', scope: t(todoKey(todoId)), itemCount: request.entities?.length ?? 0,
        internalCount: check.internalCount, personCount: check.personCount, estimatedCostJpy: check.estimatedCostJpy,
        monthSpentJpy: check.budget.monthSpentJpy, monthBudgetJpy: settings.monthlyBudgetJpy,
        destination: settings.provider === 'foundry'
          ? `${settings.relayConnection?.endpoint ?? ''} / ${settings.relayConnection?.deployment ?? ''}`
          : `GitHub Copilot / ${settings.copilotModel ?? ''}`,
        contentPreview: `${request.prompt}\n\n${check.context}`, freeTextMayContainPersons: true, storesResponse: true,
      });
      if (!decision.ok || abort.signal.aborted) {
        setCancelled(true);
        return;
      }
      assertStamp(stamp);
      setProgress({ stage: 'generate', startedAt: Date.now() });
      const proposal = await requestResolution({ ...request, userConfirmed: true, personConfirmed: decision.personConfirmed }, options, abort.signal);
      if (abort.signal.aborted) {
        setCancelled(true);
        return;
      }
      assertStamp(stamp);
      // Every choice must be applicable as shown; one invalid choice rejects the whole proposal.
      for (const item of proposal.choices) previewResolution(input, item, options, new Date().toISOString());
      setReady({ input, options, proposal, stamp });
      setChoiceId(proposal.recommendedId);
    } catch (value) {
      if (abort.signal.aborted) setCancelled(true);
      else setError(errorText(value));
    } finally {
      running.current = false;
      controller.current = null;
      setProgress(null);
    }
  };

  const apply = async () => {
    if (!ready || !recommended || running.current || applied) return;
    running.current = true;
    setApplying(true);
    setError(null);
    try {
      assertStamp(ready.stamp);
      const at = new Date().toISOString();
      const own = otherText.trim();
      if (other && !own) throw new Error(t('dlv.resolve.otherRequired'));
      if (!other && !choice) throw new Error(t('dlv.resolve.selectRequired'));
      const plan = choice && !other ? previewResolution(ready.input, choice, ready.options, at) : null;
      let data = normalizeDeliverables(useDeliverables.getState().value);
      if (plan?.selected.length) {
        const nonPackStamp = batchSourceStamp(false);
        await commitPackChanges(plan.changes, scope, ready.input.ctx.pack);
        assertStamp(nonPackStamp, false);
        if (currentScope() !== scope) throw new Error(t('dlv.resolve.changed'));
        data = plan.changes.length ? normalizeDeliverables(useDeliverables.getState().value) : plan.deliverables;
      }
      const checked = evaluateStep(step, { ...ready.input.ctx, pack: loaded, deliverables: data }).find((r) => r.todo.id === todoId)!;
      const missing = ready.proposal.missingInformation.length ? [t('dlv.resolve.missing'), ...ready.proposal.missingInformation].join('\n') : '';
      const comparison = choice?.id === recommended.id && !other ? t('dlv.resolve.recordIsRecommended') : t('dlv.resolve.recordRecommended', { label: recommended.label });
      const text = [
        other ? `${t('dlv.resolve.recordOther')}\n${own}` : t('dlv.resolve.recordChoice', { label: choice!.label }),
        comparison,
        other ? '' : choice!.rationale,
        other ? '' : choice!.tradeoffs ?? '',
        `${t('dlv.resolve.why')}\n${ready.proposal.reasoning}`,
        ...(plan?.selected ?? []).map((option) => repairDescription(option, ready.input)),
        missing,
        t(resultKey(checked.outcome!.code), checked.outcome!.vars),
      ].filter((part) => part.trim()).join('\n\n');
      const key = `${audience}:${todoId}`;
      useDeliverables.getState().set({
        ...data,
        recommendations: { ...data.recommendations, [key]: {
          ...data.recommendations?.[key], approved: { text, mock: false, at, by: useProjUi.getState().editor.trim() },
        } },
      });
      await flushDeviceStorage();
      if (deviceStatus() !== 'saved') throw new Error(t('dlv.batch.storageError'));
      setApplied(plan?.selected.length ? 'repaired' : 'decided');
    } catch (value) {
      setError(errorText(value));
    } finally {
      running.current = false;
      setApplying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) close(); }}>
      <DialogSurface className="dlv-draft-surface" data-testid="dlv-resolve-dialog">
        <DialogBody>
          <DialogTitle>{t('dlv.resolve.title', { todo: t(todoKey(todoId)) })}</DialogTitle>
          <DialogContent>
            <p>{t('dlv.resolve.note')}</p>
            <p>{t(resultKey(result.outcome!.code), result.outcome!.vars)}</p>
            <Refs refs={result.outcome?.refs ?? []} />
            {progress && <AiProgress stage={progress.stage} startedAt={progress.startedAt} limitMs={DELIVERABLE_DRAFT_TIMEOUT_MS} testId="dlv-resolve-progress" />}
            {error && <p role="alert" data-testid="dlv-resolve-error">{error}</p>}
            {cancelled && <p role="status">{t('dlv.batch.interrupted')}</p>}
            {stale && <p role="alert">{t('dlv.resolve.changed')}</p>}
            {ready && recommended && !applied && (
              <>
                <div className="dlv-resolve-recommendation" data-testid="dlv-resolve-recommendation">
                  <strong>{t('dlv.resolve.recommendation', { label: recommended.label })}</strong>
                  <p className="proj-prewrap" data-testid="dlv-resolve-reasoning">{ready.proposal.reasoning}</p>
                </div>
                {ready.proposal.missingInformation.length > 0 && (
                  <>
                    <strong>{t('dlv.resolve.missing')}</strong>
                    <ul>{ready.proposal.missingInformation.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  </>
                )}
                <p id={`${uid}-choices`}><strong>{t('dlv.resolve.choices')}</strong></p>
                <RadioGroup value={choiceId} onChange={(_, d) => setChoiceId(d.value)} aria-labelledby={`${uid}-choices`} disabled={busy} data-testid="dlv-resolve-choices">
                  {ready.proposal.choices.map((item) => {
                    const edits = item.optionIds.map((id) => {
                      const option = ready.options.find((o) => o.id === id)!;
                      const text = item.texts?.[id];
                      return { option: text && option.kind === 'field' ? { ...option, text } : option };
                    });
                    return (
                      <div key={item.id} className="dlv-resolve-choice" data-testid={`dlv-resolve-choice-${item.id}`} data-recommended={item.id === recommended.id}>
                        <Radio value={item.id} label={item.label} data-testid={`dlv-resolve-radio-${item.id}`} />
                        {item.id === recommended.id && <Badge appearance="tint" color="brand">{t('dlv.resolve.recommended')}</Badge>}
                        <div className="dlv-resolve-choice-body">
                          <p className="proj-prewrap">{item.rationale}</p>
                          {item.tradeoffs && <p className="proj-prewrap"><strong>{t('dlv.resolve.tradeoffs')}</strong>{' '}{item.tradeoffs}</p>}
                          {edits.length ? (
                            <ol data-testid={`dlv-resolve-edits-${item.id}`}>
                              {edits.map(({ option }) => (
                                <li key={option.id}><p className="proj-prewrap">{repairDescription(option, ready.input)}</p><Refs refs={option.evidenceIds.map((evidenceId) => ({ type: 'entity', id: evidenceId }))} /></li>
                              ))}
                            </ol>
                          ) : <p>{t('dlv.resolve.noEdits')}</p>}
                        </div>
                      </div>
                    );
                  })}
                  <div className="dlv-resolve-choice" data-testid="dlv-resolve-choice-other">
                    <Radio value={OTHER} label={t('dlv.resolve.other')} data-testid="dlv-resolve-radio-other" />
                    <div className="dlv-resolve-choice-body">
                      <Field label={t('dlv.resolve.otherLabel')} hint={t('dlv.resolve.otherHint')}>
                        <Textarea value={otherText} maxLength={RESOLUTION_GUIDANCE_MAX} resize="vertical" rows={3} disabled={busy}
                          onFocus={() => setChoiceId(OTHER)} onChange={(_, d) => { setOtherText(d.value); setChoiceId(OTHER); }} data-testid="dlv-resolve-other-text" />
                      </Field>
                    </div>
                  </div>
                </RadioGroup>
                {previewError && <p role="alert" data-testid="dlv-resolve-preview-error">{previewError}</p>}
                {preview && (
                  <p role="status" data-testid="dlv-resolve-preview">
                    {t(preview.selected.length ? 'dlv.resolve.preview' : 'dlv.resolve.previewDecision', { result: t(resultKey(preview.result.outcome!.code), preview.result.outcome!.vars) })}
                  </p>
                )}
                {other && <p role="status" data-testid="dlv-resolve-preview">{t('dlv.resolve.previewOther')}</p>}
              </>
            )}
            {applied && (
              <p role="status" data-testid="dlv-resolve-result">
                {t(applied === 'decided' ? 'dlv.resolve.decided' : result.done ? 'dlv.resolve.resolved' : 'dlv.resolve.remaining')}
              </p>
            )}
            <p><a href={todoHref(result)} onClick={() => { if (!busy) close(); }}>{t('dlv.task.openAction')}</a></p>
          </DialogContent>
          <DialogActions>
            {!applied && <Button disabled={busy || result.done} onClick={() => void generate()} data-testid="dlv-resolve-generate">{t('dlv.resolve.generate')}</Button>}
            {!applied && ready && other && (
              <Button disabled={busy || result.done || !otherText.trim()} onClick={() => void generate(otherText)} data-testid="dlv-resolve-regenerate">{t('dlv.resolve.regenerate')}</Button>
            )}
            {!applied && <Button appearance="primary" disabled={!canApply} onClick={() => void apply()} data-testid="dlv-resolve-apply">{t('dlv.resolve.apply')}</Button>}
            {progress?.stage === 'generate' && <Button onClick={() => controller.current?.abort()}>{t('dlv.batch.stop')}</Button>}
            <Button disabled={busy} onClick={close}>{t('dlv.batch.close')}</Button>
          </DialogActions>
          {confirmDialog}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
