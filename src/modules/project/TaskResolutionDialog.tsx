import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Radio, RadioGroup, Select, Textarea } from '@fluentui/react-components';
import { CheckmarkCircle48Filled } from '@fluentui/react-icons';
import { AiLiveError, type AiRequest } from '../../ai/client.ts';
import { DELIVERABLE_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { deviceStatus, flushDeviceStorage } from '../../data/deviceStorage.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { commitPackChanges } from '../../state/packEdits.ts';
import { currentScope, useCurrentScope } from '../../state/projects.ts';
import { focusRouteTarget, hrefFor, parseHash } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { reasonKey } from '../ai/AiCommon.tsx';
import { AiProgress, type AiStage } from '../ai/AiProgress.tsx';
import { batchSourceStamp } from './batchDraft.ts';
import { evaluateStep, normalizeDeliverables, resultKey, STEP_DEFS, todoKey } from './deliverables.ts';
import { Refs, todoHref, useCheckContext } from './deliverablesUi.tsx';
import { useDeliverables, useProjTransient, useProjUi } from './stores.ts';
import {
  CHOICE_FIELDS, CHOICE_VALUES, choiceBasis, chosenValue, completeResolution, generateResolution, humanDescription, ownerRoleBasis, NUMBER_FIELDS, previewResolution, repairDescription, repairOptions, resolutionRequest, resolutionTodo, suggestOwner, valueBasis,
  RESOLUTION_GUIDANCE_MAX, ResolutionResponseError, type HumanField, type HumanValues, type OwnerSuggestion, type RepairOption,
  type CompletedProposal, type ResolutionInput, type ResolutionProposal,
} from './taskResolution.ts';
import { resolutionTransport } from './taskDrafts.ts';
import { discardTaskDraft } from './taskDraftCommit.ts';

type ReadyResolution = { input: ResolutionInput; options: RepairOption[]; proposal: CompletedProposal; stamp: string };
/** What the reviewer typed for a KPI draft, kept as text so partial input such as "1." survives re-rendering. */
type HumanInput = Partial<Record<HumanField, string>>;
const OTHER = '__other';

/**
 * An emptied field is NaN (still missing) rather than undefined, so it never silently falls back to the AI value; an owner,
 * scale or direction the reviewer cleared stays '' instead of falling back to the preselected or proposed one.
 */
type HumanByOption = Record<string, HumanValues>;
type RawByOption = Record<string, HumanInput>;
type OwnerByOption = Record<string, OwnerSuggestion>;
function humanValues(raw: RawByOption, owners: OwnerByOption): HumanByOption {
  const ids = new Set([...Object.keys(raw), ...Object.keys(owners)]);
  return Object.fromEntries([...ids].map((id) => {
    const values = raw[id] ?? {};
    const ownerId = values.ownerId ?? owners[id]?.id;
    return [id, {
      ...Object.fromEntries(NUMBER_FIELDS.flatMap((f) => values[f] === undefined ? [] : [[f, values[f]!.trim() ? Number(values[f]!.normalize('NFKC').trim()) : Number.NaN]])),
      ...Object.fromEntries(CHOICE_FIELDS.flatMap((f) => values[f] === undefined ? [] : [[f, values[f]]])),
      ...(ownerId !== undefined ? { ownerId } : {}),
    }];
  }));
}

export function TaskResolutionDialog({ todoId }: { todoId: string }) {
  const { t, lang } = useI18n();
  const ctx = useCheckContext();
  const scope = useCurrentScope();
  const audience = useSettings((s) => s.audience);
  const close = useProjTransient((s) => s.closeResolution);
  const uid = useId();
  const [initialTarget] = useState(() => ({ scope, audience, lang }));
  const [ready, setReady] = useState<ReadyResolution | null>(null);
  const [choiceId, setChoiceId] = useState('');
  const [otherText, setOtherText] = useState('');
  const [humanRaw, setHumanRaw] = useState<Record<string, HumanInput>>({});
  const [progress, setProgress] = useState<{ stage: AiStage; startedAt?: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<{ inputHref: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const step = Object.values(STEP_DEFS).find((def) => def.todos.some((todo) => todo.id === todoId))!.step;
  const input: ResolutionInput = { step, ctx, lang, audience, todoId };
  const result = resolutionTodo(input);
  // Without a grounded draft there is nothing to approve, so Copilot is not called at all.
  const draftable = useMemo(() => repairOptions({ step, ctx, lang, audience, todoId }).length > 0, [step, ctx, lang, audience, todoId]);
  // Owners are chosen locally and never sent to Copilot; an external audience only sees shareable people.
  const people = useMemo(() => ctx.pack.pack.entities.filter((e) => e.kind === 'person' && (audience === 'internal' || e.classification === 'shareable')), [ctx, audience]);
  const editor = useProjUi((s) => s.editor);
  const owners = useMemo(() => Object.fromEntries((ready?.options ?? []).flatMap((option) => {
    const owner = suggestOwner(ready!.input, option, editor);
    return owner ? [[option.id, owner]] : [];
  })), [ready, editor]);
  const human = humanValues(humanRaw, owners);
  const busy = progress !== null || applying;
  const success = result.done ? applied : null;
  const stale = !!ready && !applied && batchSourceStamp() !== ready.stamp;
  const other = choiceId === OTHER;
  const choice = ready?.proposal.choices.find((c) => c.id === choiceId);
  const recommended = ready?.proposal.choices.find((c) => c.id === ready.proposal.recommendedId);
  let preview: ReturnType<typeof previewResolution> | null = null;
  let previewError: string | null = null;
  if (ready && choice && !stale && !applied) {
    try {
      preview = previewResolution(ready.input, { ...choice, human }, ready.options, new Date().toISOString());
    } catch (value) {
      previewError = value instanceof Error ? value.message : String(value);
    }
  }
  // Only a complete, validated data draft can be approved; Other is a direction for regenerating drafts.
  const canApply = !busy && !stale && !applied && !!ready && !other && !!preview && !preview.missing.length;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (scope !== initialTarget.scope || audience !== initialTarget.audience || lang !== initialTarget.lang) {
      controller.current?.abort();
      close();
    }
  }, [scope, audience, lang, initialTarget, close]);
  useEffect(() => {
    if (success) successRef.current?.focus();
  }, [success]);

  const errorText = (value: unknown) => value instanceof AiLiveError
    ? value.reasons.includes('liveFailed') ? t('dlv.batch.liveFailed', { detail: value.message }) : value.reasons.map((reason) => t(reasonKey(reason))).join(' ')
    : value instanceof ResolutionResponseError
      ? value.kind === 'json' ? t('dlv.resolve.invalidJson') : t('dlv.resolve.invalidSchema', { detail: value.detail })
    : value instanceof Error ? value.message : String(value);
  const assertStamp = (stamp: string, includePack = true) => {
    if (batchSourceStamp(includePack) !== stamp) throw new Error(t('dlv.resolve.changed'));
  };

  const generate = async (guidance = '') => {
    if (running.current || result.done || !draftable) return;
    running.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    setCancelled(false);
    // Keep the current choices (and the reviewer's own text) until a new proposal actually replaces them.
    setProgress({ stage: 'generate', startedAt: Date.now() });
    try {
      const stamp = batchSourceStamp();
      const options = repairOptions(input);
      const transport = resolutionTransport(scope, abort.signal, (reasons) => reasons.map((reason) => t(reasonKey(reason as Parameters<typeof reasonKey>[0]))).join(' '), () => t('dlv.draft.tooLarge'));
      transport.fits(resolutionRequest(input, options, guidance));
      assertStamp(stamp);
      // For unusually large task sets, bounded option chunks are generated and merged into a small set of distinct drafts.
      const proposal: ResolutionProposal = await generateResolution(input, options, guidance, transport);
      if (abort.signal.aborted) {
        setCancelled(true);
        return;
      }
      assertStamp(stamp);
      // D-49: every choice is completed so that approving it leaves no missing information.
      const ask = async (request: AiRequest) => {
        if (!transport.fits(request)) throw transport.tooLarge();
        return transport.send(request);
      };
      const completed = await completeResolution(input, options, proposal, {
        owner: (option) => suggestOwner(input, option, useProjUi.getState().editor), ask, aborted: () => abort.signal.aborted,
      });
      if (abort.signal.aborted) {
        setCancelled(true);
        return;
      }
      assertStamp(stamp);
      setReady({ input, options, proposal: completed, stamp });
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
      const inputHref = todoHref(resolutionTodo(ready.input));
      const at = new Date().toISOString();
      if (other || !choice) throw new Error(t('dlv.resolve.selectRequired'));
      const plan = previewResolution(ready.input, { ...choice, human }, ready.options, at);
      if (plan.missing.length) throw new Error(missingText(plan.missing));
      let data = normalizeDeliverables(useDeliverables.getState().value);
      const nonPackStamp = batchSourceStamp(false);
      await commitPackChanges(plan.changes, scope, ready.input.ctx.pack);
      assertStamp(nonPackStamp, false);
      if (currentScope() !== scope) throw new Error(t('dlv.resolve.changed'));
      data = plan.changes.length ? normalizeDeliverables(useDeliverables.getState().value) : plan.deliverables;
      const checked = evaluateStep(step, { ...ready.input.ctx, pack: loaded, deliverables: data }).find((r) => r.todo.id === todoId)!;
      const missing = ready.proposal.missingInformation.length ? [t('dlv.resolve.missing'), ...ready.proposal.missingInformation].join('\n') : '';
      const comparison = choice.id === recommended.id ? t('dlv.resolve.recordIsRecommended') : t('dlv.resolve.recordRecommended', { label: recommended.label });
      const values = plan.selected.map((option) => humanDescription(option, ready.input, plan.drafts[option.id], human[option.id], owners[option.id])).filter(Boolean);
      const text = [
        t('dlv.resolve.recordChoice', { label: choice.label }),
        comparison,
        choice.rationale,
        choice.tradeoffs ?? '',
        `${t('dlv.resolve.why')}\n${ready.proposal.reasoning}`,
        ...plan.selected.map((option) => repairDescription(option, ready.input, plan.drafts[option.id])),
        values.length ? [t('dlv.resolve.recordValues'), ...values].join('\n') : '',
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
      // The saved batch draft of this task is superseded by what the reviewer just approved here.
      discardTaskDraft(todoId, audience);
      setApplied({ inputHref });
    } catch (value) {
      setError(errorText(value));
    } finally {
      running.current = false;
      setApplying(false);
    }
  };

  // After an approval that left the task open, the next round drafts the rest from the data as it is now.
  const continueResolution = () => {
    setApplied(null);
    setReady(null);
    setChoiceId('');
    setHumanRaw({});
    void generate();
  };

  function missingText(missing: { field: HumanField }[]) {
    return t('dlv.resolve.human.missing', { fields: [...new Set(missing.map((m) => t(`dlv.resolve.human.${m.field}`)))].join(lang === 'ja' ? '、' : ', ') });
  }
  const setHuman = (optionId: string, field: HumanField, value: string) =>
    setHumanRaw((prev) => ({ ...prev, [optionId]: { ...prev[optionId], [field]: value } }));

  const openInput = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const href = event.currentTarget.getAttribute('href');
    const target = href === window.location.hash ? parseHash(href).query.get('target') : null;
    if (target) {
      event.preventDefault();
      requestAnimationFrame(() => focusRouteTarget(target));
    }
    close();
  };

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) close(); }}>
      <DialogSurface className={success ? 'dlv-resolve-success-surface' : 'dlv-draft-surface'} data-testid="dlv-resolve-dialog">
        <DialogBody>
          <DialogTitle className={success ? 'dlv-resolve-success-title' : undefined}>
            {success ? t('dlv.resolve.successTitle') : t('dlv.resolve.title', { todo: t(todoKey(todoId)) })}
          </DialogTitle>
          <DialogContent>
            {success ? (
              <div className="dlv-resolve-success" data-testid="dlv-resolve-success">
                <div className="dlv-resolve-success-message" role="status" tabIndex={-1} ref={successRef} data-testid="dlv-resolve-result">
                  <CheckmarkCircle48Filled className="dlv-resolve-success-icon" aria-hidden data-testid="dlv-resolve-success-icon" />
                  <p className="dlv-resolve-success-task">{t(todoKey(todoId))}</p>
                  <p>{t(resultKey(result.outcome!.code), result.outcome!.vars)}</p>
                  <p>{t('dlv.resolve.resolved')}</p>
                </div>
                <p>{t('dlv.resolve.successNote')}</p>
                <div className="dlv-resolve-success-links">
                  <Button as="a" appearance="primary" href={hrefFor('/deliverables', { step, target: 'dlv-fields' })}
                    onClick={openInput} data-testid="dlv-resolve-input-link">
                    {t('dlv.resolve.openInputs')}
                  </Button>
                  <a href={success.inputHref} onClick={openInput} data-testid="dlv-resolve-task-link">{t('dlv.task.openAction')}</a>
                </div>
              </div>
            ) : (
              <>
            <p>{t('dlv.resolve.note')}</p>
            <p>{t(resultKey(result.outcome!.code), result.outcome!.vars)}</p>
            <Refs refs={result.outcome?.refs ?? []} />
            {progress && <AiProgress stage={progress.stage} startedAt={progress.startedAt} limitMs={DELIVERABLE_DRAFT_TIMEOUT_MS} result="process" testId="dlv-resolve-progress" />}
            {error && <p role="alert" data-testid="dlv-resolve-error">{error}</p>}
            {cancelled && <p role="status">{t('dlv.batch.interrupted')}</p>}
            {stale && <p role="alert">{t('dlv.resolve.changed')}</p>}
            {!draftable && !result.done && <p role="status" data-testid="dlv-resolve-no-draftable">{t('dlv.resolve.noDraftable')}</p>}
            {ready && recommended && !applied && (
              <>
                <div className="dlv-resolve-recommendation" data-testid="dlv-resolve-recommendation">
                  <strong>{t('dlv.resolve.recommendation', { label: recommended.label })}</strong>
                  <p className="proj-prewrap" data-testid="dlv-resolve-reasoning">{ready.proposal.reasoning}</p>
                </div>
                {ready.proposal.completion.rounds > 0 && <p role="status" data-testid="dlv-resolve-rounds">{t('dlv.resolve.rounds', { n: String(ready.proposal.completion.rounds) })}</p>}
                {ready.proposal.completion.error && <p role="status" data-testid="dlv-resolve-completion-error">{t('dlv.resolve.completionError', { detail: ready.proposal.completion.error })}</p>}
                {ready.proposal.unreachable.length > 0 && (
                  <div role="status" data-testid="dlv-resolve-unreachable">
                    <p>{t('dlv.resolve.unreachable')}</p>
                    <Refs refs={ready.proposal.unreachable} />
                  </div>
                )}
                {ready.proposal.uncovered.length > 0 && (
                  <div role="status" data-testid="dlv-resolve-uncovered">
                    <p>{t('dlv.resolve.uncovered')}</p>
                    <Refs refs={ready.proposal.uncovered} />
                  </div>
                )}
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
                      return text && option.kind === 'field' ? { ...option, text } : option;
                    });
                    return (
                      <div key={item.id} className="dlv-resolve-choice" data-testid={`dlv-resolve-choice-${item.id}`} data-recommended={item.id === recommended.id}>
                        <Radio value={item.id} label={item.label} data-testid={`dlv-resolve-radio-${item.id}`} />
                        {item.id === recommended.id && <Badge appearance="tint" color="brand">{t('dlv.resolve.recommended')}</Badge>}
                        <div className="dlv-resolve-choice-body">
                          <p className="proj-prewrap">{item.rationale}</p>
                          {item.tradeoffs && <p className="proj-prewrap"><strong>{t('dlv.resolve.tradeoffs')}</strong>{' '}{item.tradeoffs}</p>}
                          {!!item.added?.length && <p data-testid={`dlv-resolve-added-${item.id}`}>{t('dlv.resolve.added', { n: String(item.added.length) })}</p>}
                          <ol data-testid={`dlv-resolve-edits-${item.id}`}>
                            {edits.map((option) => (
                              <li key={option.id}>
                                <p className="proj-prewrap">{repairDescription(option, ready.input, item.drafts?.[option.id])}</p>
                                <Refs refs={option.evidenceIds.map((evidenceId) => ({ type: 'entity', id: evidenceId }))} />
                                {item.id === choiceId && option.kind === 'create' && option.entityKind === 'kpi' && (() => {
                                  const draft = item.drafts?.[option.id];
                                  const owner = owners[option.id];
                                  const ownerId = human[option.id]?.ownerId ?? '';
                                  return (
                                  <fieldset className="dlv-resolve-human" data-testid={`dlv-resolve-human-${option.newId}`}>
                                    <legend>{t('dlv.resolve.human.title', { name: draft?.name[lang] ?? option.newId })}</legend>
                                    <p>{t('dlv.resolve.human.note')}</p>
                                    {draft?.estimateNote && (
                                      <p className="proj-prewrap" data-testid={`dlv-resolve-human-${option.newId}-note`}>
                                        {t('dlv.resolve.human.estimateNote', { note: draft.estimateNote[lang] })}
                                      </p>
                                    )}
                                    {CHOICE_FIELDS.map((field) => {
                                      const value = humanRaw[option.id]?.[field] ?? draft?.[field] ?? '';
                                      const chosen = chosenValue(draft, human[option.id], field);
                                      const raw = draft?.unrecognized?.[field];
                                      const basis = !chosen ? undefined : value !== (draft?.[field] ?? '') ? 'human' : choiceBasis(draft, field);
                                      return (
                                        <Field key={field} label={t(`dlv.resolve.human.${field}`)} required
                                          validationState={raw !== undefined && !chosen ? 'warning' : 'none'}
                                          validationMessage={raw !== undefined && !chosen ? t('dlv.resolve.human.unrecognized', { field: t(`dlv.resolve.human.${field}`), value: raw }) : undefined}
                                          hint={basis ? t(`dlv.resolve.human.basis.${basis}`) : undefined} data-basis={basis ?? ''}
                                          data-testid={`dlv-resolve-human-${option.newId}-${field}-field`}>
                                          <Select disabled={busy} value={value} onChange={(_, d) => setHuman(option.id, field, d.value)}
                                            data-testid={`dlv-resolve-human-${option.newId}-${field}`}>
                                            <option value="">{t('dlv.resolve.human.noOwner')}</option>
                                            {field === 'scale'
                                              ? CHOICE_VALUES.scale.map((v) => <option key={v} value={v}>{t(`entry.scale.${v}`)}</option>)
                                              : CHOICE_VALUES.direction.map((v) => <option key={v} value={v}>{t(`dlv.resolve.new.${v}`)}</option>)}
                                          </Select>
                                        </Field>
                                      );
                                    })}
                                    {NUMBER_FIELDS.map((field) => {
                                      const basis = valueBasis(ready.input, option, draft, human[option.id], field);
                                      const basisText = basis ? t(`dlv.resolve.human.basis.${basis}`) : undefined;
                                      const warn = basis === 'estimate' || basis === 'provisional';
                                      return (
                                        <Field key={field} label={t(`dlv.resolve.human.${field}`)} required
                                          validationState={warn ? 'warning' : 'none'} validationMessage={warn ? basisText : undefined}
                                          hint={warn ? undefined : basisText} data-basis={basis ?? ''} data-testid={`dlv-resolve-human-${option.newId}-${field}-field`}>
                                          <Input inputMode="decimal" disabled={busy} value={humanRaw[option.id]?.[field] ?? String(draft?.[field] ?? '')}
                                            onChange={(_, d) => setHuman(option.id, field, d.value)} data-testid={`dlv-resolve-human-${option.newId}-${field}`} />
                                        </Field>
                                      );
                                    })}
                                    <Field label={t('dlv.resolve.human.ownerId')} required data-testid={`dlv-resolve-human-${option.newId}-ownerId-field`}
                                      hint={ownerId ? t(`dlv.resolve.human.basis.${owner && ownerId === owner.id ? owner.basis : 'human'}`)
                                        : draft?.ownerRole ? t(`dlv.resolve.human.basis.${ownerRoleBasis(draft)}`) : undefined}>
                                      <Select disabled={busy} value={ownerId} onChange={(_, d) => setHuman(option.id, 'ownerId', d.value)}
                                        data-testid={`dlv-resolve-human-${option.newId}-ownerId`}>
                                        <option value="">{draft?.ownerRole ? t('dlv.resolve.human.byRole', { role: draft.ownerRole[lang] }) : t('dlv.resolve.human.noOwner')}</option>
                                        {people.map((person) => <option key={person.id} value={person.id}>{loc(person.name, lang)}</option>)}
                                      </Select>
                                    </Field>
                                  </fieldset>
                                  );
                                })()}
                              </li>
                            ))}
                          </ol>
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
                {preview && (preview.result ? (
                  <p role="status" data-testid="dlv-resolve-preview">
                    {t('dlv.resolve.preview', { result: t(resultKey(preview.result.outcome!.code), preview.result.outcome!.vars) })}
                  </p>
                ) : <p role="status" data-testid="dlv-resolve-preview">{missingText(preview.missing)}</p>)}
                {other && <p role="status" data-testid="dlv-resolve-preview">{t('dlv.resolve.previewOther')}</p>}
              </>
            )}
            {applied && (
              <p role="status" data-testid="dlv-resolve-result">
                {t(result.done ? 'dlv.resolve.resolved' : 'dlv.resolve.remaining')}
              </p>
            )}
            <p><a href={todoHref(result)} onClick={() => { if (!busy) close(); }}>{t('dlv.task.openAction')}</a></p>
              </>
            )}
          </DialogContent>
          <DialogActions>
            {!applied && <Button disabled={busy || result.done || !draftable} onClick={() => void generate()} data-testid="dlv-resolve-generate">{t('dlv.resolve.generate')}</Button>}
            {applied && !result.done && draftable && <Button appearance="primary" disabled={busy} onClick={continueResolution} data-testid="dlv-resolve-continue">{t('dlv.resolve.continue')}</Button>}
            {!applied && ready && other && (
              <Button disabled={busy || result.done || !otherText.trim()} onClick={() => void generate(otherText)} data-testid="dlv-resolve-regenerate">{t('dlv.resolve.regenerate')}</Button>
            )}
            {!applied && <Button appearance="primary" disabled={!canApply} onClick={() => void apply()} data-testid="dlv-resolve-apply">{t('dlv.resolve.apply')}</Button>}
            {progress?.stage === 'generate' && <Button onClick={() => controller.current?.abort()}>{t('dlv.batch.stop')}</Button>}
            <Button disabled={busy} onClick={close}>{t('dlv.batch.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
