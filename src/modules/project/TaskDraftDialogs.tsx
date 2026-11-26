import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Textarea,
} from '@fluentui/react-components';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { IMPROVEMENT_STEPS } from '../../state/projects.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { PAYBACK_MAX_YEARS, QUALIFY_VERDICTS, resultKey, STEP_DEFS, todoKey, type QualifyVerdict } from './deliverables.ts';
import { useCheckContext } from './deliverablesUi.tsx';
import { useProjTransient } from './stores.ts';
import { approveTaskDrafts, discardTaskDraft, saveTaskDraft } from './taskDraftCommit.ts';
import {
  applyTaskOps, approvalOrder, draftLines, editDraft, isSignOffDraft, taskDraftKey, TaskOpSchema, taskStatuses, type TaskDraft, type TaskOp,
} from './taskDrafts.ts';
import { approvalError, DataStateBadge, DataStateLegend, DraftStateCounts, useTaskStatuses } from './taskDraftsUi.tsx';

type T = (k: MessageKey, v?: Record<string, string | number>) => string;
interface Job { (): Promise<void> }
const label = (t: T, id: string) => t(todoKey(id), { max: PAYBACK_MAX_YEARS });

/** The reviewer's editor for one operation: every value Copilot or BAS drafted can be changed before approval. */
function OpEditor({ op, index, onChange }: { op: TaskOp; index: number; onChange: (op: TaskOp, keys: string[]) => void }) {
  const { t, lang } = useI18n();
  const [raw, setRaw] = useState(() => JSON.stringify(op, null, 2));
  useEffect(() => setRaw(JSON.stringify(op, null, 2)), [op]);
  const k = String(index);
  const id = `dlv-td-edit-${index}`;
  if (op.op === 'field' || op.op === 'signOff') {
    return <Field label={t('dlv.td.edit.text')}><Textarea resize="vertical" value={op.text} onChange={(_, d) => onChange({ ...op, text: d.value }, [k])} data-testid={`${id}-text`} /></Field>;
  }
  if (op.op === 'decision') {
    return (
      <>
        <Field label={t('dlv.td.edit.title')}><Input value={op.title} onChange={(_, d) => onChange({ ...op, title: d.value }, [k])} data-testid={`${id}-title`} /></Field>
        <Field label={t('dlv.td.edit.decision')}><Textarea resize="vertical" value={op.text} onChange={(_, d) => onChange({ ...op, text: d.value }, [k])} data-testid={`${id}-text`} /></Field>
      </>
    );
  }
  if (op.op === 'qualify') {
    return (
      <>
        <Field label={t('dlv.td.edit.verdict')}>
          <Select value={op.verdict} onChange={(_, d) => onChange({ ...op, verdict: d.value as QualifyVerdict }, [k])} data-testid={`${id}-verdict`}>
            {QUALIFY_VERDICTS.map((v) => <option key={v} value={v}>{t(`dlv.td.verdict.${v}` as MessageKey)}</option>)}
          </Select>
        </Field>
        <Field label={t('dlv.td.edit.reason')}><Textarea resize="vertical" value={op.reason} onChange={(_, d) => onChange({ ...op, reason: d.value }, [k])} data-testid={`${id}-reason`} /></Field>
        {op.verdict === 'pursue' && <Field label={t('dlv.td.edit.different')}><Textarea resize="vertical" value={op.different ?? ''} onChange={(_, d) => onChange({ ...op, different: d.value }, [k])} data-testid={`${id}-different`} /></Field>}
      </>
    );
  }
  if (op.op === 'create') {
    const e = op.entity;
    const setText = (field: 'name' | 'description', value: string) => onChange({ ...op, entity: { ...e, [field]: { ...e[field], [lang]: value } } as typeof e }, [k]);
    return (
      <>
        <Field label={t('dlv.td.edit.name')}><Input value={loc(e.name, lang)} onChange={(_, d) => setText('name', d.value)} data-testid={`${id}-name`} /></Field>
        <Field label={t('dlv.td.edit.description')}><Textarea resize="vertical" value={loc(e.description, lang)} onChange={(_, d) => setText('description', d.value)} data-testid={`${id}-description`} /></Field>
        {e.kind === 'kpi' && (['baseline', 'current', 'target'] as const).map((f) => (
          <Field key={f} label={t(`dlv.resolve.human.${f}` as MessageKey)}>
            <Input type="number" value={String(e[f])} onChange={(_, d) => onChange({ ...op, entity: { ...e, [f]: Number(d.value) } }, [`${k}.${f}`])} data-testid={`${id}-${f}`} />
          </Field>
        ))}
        {e.kind === 'initiative' && (['start', 'end'] as const).map((f) => (
          <Field key={f} label={t(`dlv.td.edit.${f}` as MessageKey)}>
            <Input type="date" value={e[f]} onChange={(_, d) => onChange({ ...op, entity: { ...e, [f]: d.value } }, [`${k}.start`])} data-testid={`${id}-${f}`} />
          </Field>
        ))}
        {(e.kind === 'kpi' || e.kind === 'initiative') && !e.ownerId && (
          <Field label={t('dlv.resolve.human.ownerRole')}>
            <Input value={e.ownerRole ? loc(e.ownerRole, lang) : ''} onChange={(_, d) => onChange({ ...op, entity: { ...e, ownerRole: { ...(e.ownerRole ?? { ja: d.value, en: d.value }), [lang]: d.value } } }, [`${k}.owner`])} data-testid={`${id}-owner`} />
          </Field>
        )}
      </>
    );
  }
  if (op.op === 'set') {
    return (
      <>
        {Object.entries(op.values).map(([f, v]) => (
          <Field key={f} label={f}>
            <Input type={typeof v === 'number' ? 'number' : 'text'} value={typeof v === 'object' && v ? loc(v as { ja: string; en: string }, lang) : String(v ?? '')}
              onChange={(_, d) => onChange({ ...op, values: { ...op.values, [f]: typeof v === 'number' ? Number(d.value) : typeof v === 'object' && v ? { ...(v as object), [lang]: d.value } : d.value } }, [k, `${k}.${f}`])}
              data-testid={`${id}-${f}`} />
          </Field>
        ))}
      </>
    );
  }
  if (['kpi', 'okr', 'useCase', 'solutionType', 'contribution', 'section', 'fill', 'companyObjective', 'analysis'].includes(op.op)) {
    return (
      <Field label={t('dlv.td.edit.structured')}>
        <Textarea
          resize="vertical"
          value={raw}
          onChange={(_, d) => {
            setRaw(d.value);
            try {
              const parsed: unknown = JSON.parse(d.value);
              const valid = TaskOpSchema.safeParse(parsed);
              if (valid.success) onChange(valid.data, [k]);
            } catch { /* Keep incomplete JSON in the editor until it parses. */ }
          }}
          data-testid={`${id}-structured`}
        />
      </Field>
    );
  }
  return null;
}

/** FR-376: review one task's saved draft: what approving it does (judged by the checks), every value with its state, edit, approve. */
export function TaskDraftDialog({ todoId }: { todoId: string }) {
  const { t, lang } = useI18n();
  const ctx = useCheckContext();
  const audience = useSettings((s) => s.audience);
  const close = useProjTransient((s) => s.closeTaskDraft);
  const { drafts, statuses } = useTaskStatuses(ctx);
  const saved = drafts[taskDraftKey(audience, todoId)];
  const [edit, setEdit] = useState<TaskDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  // The approved draft is removed from the store; the dialog keeps showing it with the result.
  const last = useRef(saved);
  if (saved) last.current = saved;
  const draft = edit ?? saved ?? last.current;
  // The edited draft is judged by the same checks, replayed with every other draft, before it can be saved or approved.
  const check = useMemo(() => {
    if (!edit) return null;
    const bad = edit.ops.map((op) => TaskOpSchema.safeParse(op)).find((r) => !r.success);
    if (bad && !bad.success) return { ok: false as const, message: bad.error.issues.map((i) => i.message).join('; ') };
    try {
      applyTaskOps(ctx, edit.ops);
      return { ok: true as const, status: taskStatuses(ctx, { ...drafts, [taskDraftKey(audience, todoId)]: edit }, audience).get(todoId) };
    } catch (value) {
      return { ok: false as const, message: value instanceof Error ? value.message : String(value) };
    }
  }, [edit, ctx, drafts, audience, todoId]);
  useEffect(() => {
    if (!saved && !done && !busy) close();
  }, [saved, done, busy, close]);
  const status = (check?.ok ? check.status : undefined) ?? statuses.get(todoId);
  if (!draft || !status) return null;
  const together = status.requires.filter((id) => id !== todoId);
  const lines = draftLines(draft, ctx, lang);
  const run = async (fn: Job) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (value) {
      setError(approvalError(t, value));
    } finally {
      setBusy(false);
    }
  };
  const approve = () => run(async () => {
    if (edit) saveTaskDraft(edit, audience);
    setDone(await approveTaskDrafts([todoId], ctx, audience, lang));
  });
  const verdict = status.state === 'ready' ? t('dlv.td.verify.ready')
    : status.state === 'open' ? t('dlv.td.verify.open', { reason: status.outcome ? t(resultKey(status.outcome.code), status.outcome.vars) : '' })
      : status.state === 'invalid' ? t('dlv.td.verify.invalid', { detail: status.regresses?.length ? status.regresses.map((id) => label(t, id)).join(', ') : status.error ?? '' })
        : '';
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) close(); }}>
      <DialogSurface className="dlv-draft-surface" data-testid="dlv-td-dialog">
        <DialogBody>
          <DialogTitle>{t('dlv.td.title', { todo: label(t, todoId) })}</DialogTitle>
          <DialogContent tabIndex={0}>
            {done ? (
              <p role="status" data-testid="dlv-td-done">{t('dlv.td.approved', { n: done.length })}</p>
            ) : (
              <>
                <p role="status" className={`dlv-td-verdict dlv-td-verdict-${status.state}`} data-testid="dlv-td-verdict">{verdict}</p>
                {together.length > 0 && <p data-testid="dlv-td-together">{t('dlv.td.together', { todos: together.map((id) => label(t, id)).join(lang === 'ja' ? '、' : ', ') })}</p>}
                {isSignOffDraft(draft) && <p className="dlv-td-note" data-testid="dlv-td-signoff-note">{t('dlv.td.signOffNote')}</p>}
                {draft.notice && <p className="dlv-td-note" data-testid="dlv-td-notice">{draft.notice}</p>}
                {draft.rationale && <p className="proj-prewrap muted" data-testid="dlv-td-rationale">{draft.rationale}</p>}
                <DataStateLegend />
                <ol className="dlv-td-lines" data-testid="dlv-td-lines">
                  {lines.map((line) => (
                    <li key={line.key} data-state={line.state}>
                      <DataStateBadge state={line.state} />
                      <span className="proj-prewrap">{line.text}</span>
                    </li>
                  ))}
                </ol>
                {edit && (
                  <section aria-label={t('dlv.td.editing')} className="dlv-td-edit" data-testid="dlv-td-edit">
                    {edit.ops.map((op, i) => (
                      <fieldset key={i}>
                        <legend>{lines.find((l) => l.key === String(i))?.text.split('\n')[0]}</legend>
                        <OpEditor op={op} index={i} onChange={(next, keys) => setEdit(editDraft(edit, i, next, keys))} />
                      </fieldset>
                    ))}
                    {check && !check.ok && <p role="alert" data-testid="dlv-td-edit-error">{t('dlv.td.edit.invalid', { detail: check.message })}</p>}
                  </section>
                )}
              </>
            )}
            {error && <p role="alert" data-testid="dlv-td-error">{error}</p>}
          </DialogContent>
          <DialogActions>
            {!done && (
              <>
                <Button appearance="primary" disabled={busy || (status.state !== 'ready' && status.state !== 'open') || (check !== null && !check.ok)} onClick={() => void approve()} data-testid="dlv-td-approve">
                  {t(edit ? 'dlv.td.saveApprove' : isSignOffDraft(draft) ? 'dlv.td.approveSignOff' : 'dlv.td.approve')}
                </Button>
                {edit
                  ? <Button disabled={busy || (check !== null && !check.ok)} onClick={() => { saveTaskDraft(edit, audience); setEdit(null); }} data-testid="dlv-td-save">{t('dlv.td.saveEdit')}</Button>
                  : <Button disabled={busy} onClick={() => setEdit(saved ?? null)} data-testid="dlv-td-edit-start">{t('dlv.td.edit')}</Button>}
                {edit && <Button disabled={busy} onClick={() => setEdit(null)} data-testid="dlv-td-edit-cancel">{t('dlv.td.editCancel')}</Button>}
                <Button disabled={busy} onClick={() => { discardTaskDraft(todoId, audience); close(); }} data-testid="dlv-td-discard">{t('dlv.td.discard')}</Button>
              </>
            )}
            <Button disabled={busy} onClick={close} data-testid="dlv-td-close">{t('dlv.td.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** FR-376: every task of every step with its draft state; approve one step's drafts or all of them at once. */
export function TaskReviewDialog() {
  const { t, lang } = useI18n();
  const ctx = useCheckContext();
  const audience = useSettings((s) => s.audience);
  const close = useProjTransient((s) => s.closeTaskReview);
  const openTaskDraft = useProjTransient((s) => s.openTaskDraft);
  const { drafts, statuses } = useTaskStatuses(ctx);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const all = [...statuses.values()];
  const pendingOf = (ids: string[]) => approvalOrder(ids, statuses);
  const everything = pendingOf(all.map((s) => s.todoId));
  const counts = {
    done: all.filter((s) => s.state === 'done').length,
    ready: all.filter((s) => s.state === 'ready' || s.state === 'viaOther').length,
    open: all.filter((s) => s.state === 'open' || s.state === 'invalid').length,
    none: all.filter((s) => s.state === 'none').length,
  };
  const approve = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const approved = await approveTaskDrafts(ids, ctx, audience, lang);
      setMessage(t('dlv.td.approved', { n: approved.length }));
    } catch (value) {
      setError(approvalError(t, value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) close(); }}>
      <DialogSurface className="dlv-draft-surface dlv-batch-surface" data-testid="dlv-td-review">
        <DialogBody>
          <DialogTitle>{t('dlv.td.reviewTitle')}</DialogTitle>
          <DialogContent tabIndex={0}>
            <p>{t('dlv.td.reviewIntro')}</p>
            <p role="status" data-testid="dlv-td-review-counts">{t('dlv.td.reviewCounts', counts)}</p>
            <DataStateLegend />
            {message && <p role="status" data-testid="dlv-td-review-message">{message}</p>}
            {error && <p role="alert" data-testid="dlv-td-review-error">{error}</p>}
            {IMPROVEMENT_STEPS.map((step) => {
              const ids = STEP_DEFS[step].todos.map((x) => x.id);
              const pending = pendingOf(ids.filter((id) => statuses.get(id)?.step === step));
              return (
                <section key={step} aria-labelledby={`dlv-td-step-${step}`} className="dlv-td-step" data-testid={`dlv-td-step-${step}`}>
                  <h3 id={`dlv-td-step-${step}`}>{t(`proj.step.${step}` as MessageKey)}</h3>
                  <ul className="dlv-td-list">
                    {ids.map((id) => {
                      const s = statuses.get(id)!;
                      const draft = drafts[taskDraftKey(audience, id)];
                      const caption = s.state === 'done' ? t('dlv.td.state.done')
                        : s.state === 'ready' ? t('dlv.td.ready')
                          : s.state === 'viaOther' ? t('dlv.td.viaOther', { todo: label(t, s.by!) })
                            : s.state === 'invalid' ? t('dlv.td.invalid')
                              : s.state === 'open' ? t('dlv.td.open', { reason: s.outcome ? t(resultKey(s.outcome.code), s.outcome.vars) : '' })
                                : t('dlv.td.none');
                      return (
                        <li key={id} data-testid={`dlv-td-row-${id}`} data-state={s.state}>
                          {s.state === 'done' && <DataStateBadge state="confirmed" />}
                          {s.state !== 'done' && draft && <DraftStateCounts draft={draft} ctx={ctx} />}
                          <strong>{label(t, id)}</strong>
                          <span className="muted">{caption}</span>
                          {draft && s.state !== 'done' && <Button size="small" onClick={() => openTaskDraft(id)} data-testid={`dlv-td-row-review-${id}`}>{t('dlv.td.review')}</Button>}
                        </li>
                      );
                    })}
                  </ul>
                  <Button disabled={busy || !pending.length} onClick={() => void approve(pending)} data-testid={`dlv-td-approve-step-${step}`}>
                    {t('dlv.td.approveStep', { n: pending.length })}
                  </Button>
                </section>
              );
            })}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy || !everything.length} onClick={() => void approve(everything)} data-testid="dlv-td-approve-all">{t('dlv.td.approveAll', { n: everything.length })}</Button>
            <Button disabled={busy} onClick={close} data-testid="dlv-td-review-close">{t('dlv.td.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
