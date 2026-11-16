import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, ProgressBar, Spinner } from '@fluentui/react-components';
import { AiLiveError, preflight, type Preflight } from '../../ai/client.ts';
import { PER_USE_LIMITS, type AiUse } from '../../ai/policy.ts';
import { selectOutbound } from '../../ai/redact.ts';
import { deviceStatus, flushDeviceStorage } from '../../data/deviceStorage.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { currentScope } from '../../state/projects.ts';
import { hrefFor } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { reasonKey, useLiveConfirm, yenFine } from '../ai/AiCommon.tsx';
import { useAiSettings } from '../ai/settingsStore.ts';
import { batchIntervalMs, batchJobId, batchSourceStamp, createBatchPlan, runBatchJob, saveBatchResult, waitForBatchInterval, type BatchJob } from './batchDraft.ts';
import { useCheckContext } from './deliverablesUi.tsx';
import { overviewEntities, useOverview } from './overviewModel.ts';
import { useProjTransient } from './stores.ts';

type JobStatus = 'pending' | 'working' | 'waiting' | 'done' | 'failed';
type JobStatuses = Record<string, JobStatus>;

export function BatchDraftDialog() {
  const { t, lang, fmt } = useI18n();
  const ctx = useCheckContext();
  const audience = useSettings((s) => s.audience);
  const close = useProjTransient((s) => s.closeBatchDraft);
  const openDraft = useProjTransient((s) => s.openDraft);
  const [scope] = useState(currentScope);
  const [provider] = useState(() => useAiSettings.getState().provider);
  const [jobs] = useState(() => createBatchPlan(ctx, lang, audience, scope, useOverview.getState().value));
  const [statuses, setStatuses] = useState<JobStatuses>(() => Object.fromEntries(jobs.map((job) => [batchJobId(job), 'pending'])));
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const completed = useRef(new Set<string>());
  const attempts = useRef(new Map<AiUse, number>());
  const [initialSource] = useState(batchSourceStamp);
  const source = useRef(initialSource);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const { dialog: confirmDialog, confirmLive } = useLiveConfirm();

  useEffect(() => () => controller.current?.abort(), []);

  const nameOf = (job: BatchJob): string => {
    if (job.kind === 'strategy') return t('dlv.batch.strategy');
    return t(job.kind === 'fields' ? 'dlv.batch.fields' : 'dlv.batch.brief', { step: t(`proj.step.${job.step}`) });
  };
  const setStatus = (job: BatchJob, status: JobStatus) => setStatuses((current) => ({ ...current, [batchJobId(job)]: status }));
  const counts = (job: BatchJob, check: Preflight) => {
    if (job.kind !== 'strategy') return { items: job.request.entities?.length ?? 0, internal: check.internalCount, persons: check.personCount };
    const entities = overviewEntities(job.context);
    return {
      items: entities.length + job.context.objectives.length + job.context.kpi.kpis.length + job.context.kpi.okrs.length,
      internal: selectOutbound(entities, job.context.pack.byId).internalCount,
      persons: 0,
    };
  };
  const assertCurrent = () => {
    if (batchSourceStamp() !== source.current) {
      setInvalid(true);
      throw new Error(t('dlv.batch.changed'));
    }
  };
  const errorText = (value: unknown) => {
    if (value instanceof AiLiveError) {
      return value.reasons.includes('liveFailed')
        ? t('dlv.batch.liveFailed', { detail: value.message })
        : value.reasons.map((reason) => t(reasonKey(reason))).join(' ');
    }
    return value instanceof Error ? value.message : String(value);
  };

  const prepare = (pending: BatchJob[]): Preflight[] => {
    const checks = pending.map((job) => preflight({ ...job.request, userConfirmed: true, personConfirmed: true }));
    for (let i = 0; i < pending.length; i += 1) {
      const job = pending[i]!;
      const check = checks[i]!;
      const reasons = check.reasons.filter((reason) => reason !== 'budget' || check.budget.reasons.some((item) => item !== 'tooSoon'));
      if (reasons.length) throw new Error(`${nameOf(job)}: ${reasons.map((reason) => t(reasonKey(reason))).join(' ')}`);
      if (job.request.prompt.length + check.context.length > 32_000) throw new Error(`${nameOf(job)}: ${t('dlv.draft.tooLarge')}`);
      const limit = PER_USE_LIMITS[job.request.use]?.dailyCalls;
      const needed = pending.filter((item) => item.request.use === job.request.use).length;
      if (limit !== undefined && check.budget.todayCalls + needed > limit) {
        throw new Error(t('dlv.batch.dailyLimit', { name: nameOf(job), remaining: Math.max(0, limit - check.budget.todayCalls), needed }));
      }
    }
    return checks;
  };

  const run = async () => {
    if (running.current || invalid) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setInterrupted(false);
    const abort = new AbortController();
    controller.current = abort;
    let active: BatchJob | undefined;
    try {
      assertCurrent();
      const pending = jobs.filter((job) => !completed.current.has(batchJobId(job)));
      const checks = prepare(pending);
      const settings = useAiSettings.getState();
      const preview = pending.map((job, i) => {
        const check = checks[i]!;
        const cost = check.estimatedCostJpy === null ? t('dlv.batch.unknownCost') : yenFine(fmt.locale, check.estimatedCostJpy);
        const count = counts(job, check);
        const header = t('dlv.batch.previewHeader', {
          name: nameOf(job), ...count, cost,
        });
        return `${i + 1}. ${header}\n${job.request.prompt}\n\n${check.context}`;
      }).join('\n\n--------------------\n\n');
      const costs = checks.map((check) => check.estimatedCostJpy);
      const estimatedCostJpy = costs.every((cost) => cost !== null) ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) : null;
      const decision = await confirmLive({
        use: 'dlv.batch.confirmUse',
        scope: t('dlv.batch.confirmScope', { n: pending.length }),
        itemCount: pending.reduce((sum, job, i) => sum + counts(job, checks[i]!).items, 0),
        internalCount: pending.reduce((sum, job, i) => sum + counts(job, checks[i]!).internal, 0),
        personCount: pending.reduce((sum, job, i) => sum + counts(job, checks[i]!).persons, 0),
        estimatedCostJpy, monthSpentJpy: checks[0]?.budget.monthSpentJpy ?? 0, monthBudgetJpy: settings.monthlyBudgetJpy,
        destination: settings.provider === 'foundry'
          ? `${settings.relayConnection?.endpoint ?? ''} / ${settings.relayConnection?.deployment ?? ''}`
          : `GitHub Copilot / ${settings.copilotModel ?? ''}`,
        contentPreview: preview, freeTextMayContainPersons: true, storesResponse: true,
      });
      if (!decision.ok || abort.signal.aborted) {
        setInterrupted(true);
        return;
      }
      assertCurrent();
      for (const job of pending) {
        active = job;
        assertCurrent();
        const delay = batchIntervalMs(job.request.use, attempts.current);
        if (delay > 0) setStatus(job, 'waiting');
        await waitForBatchInterval(delay, abort.signal);
        assertCurrent();
        setStatus(job, 'working');
        attempts.current.set(job.request.use, Date.now());
        const result = await runBatchJob(job, decision.personConfirmed, abort.signal);
        if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        assertCurrent();
        saveBatchResult(job, result, ctx, audience, provider);
        source.current = batchSourceStamp();
        await flushDeviceStorage();
        if (deviceStatus() !== 'saved') throw new Error(t('dlv.batch.storageError'));
        assertCurrent();
        completed.current.add(batchJobId(job));
        setStatus(job, 'done');
        active = undefined;
      }
    } catch (value) {
      if (abort.signal.aborted) {
        if (active) setStatus(active, 'pending');
        setInterrupted(true);
      } else {
        if (active) setStatus(active, 'failed');
        setError(errorText(value));
      }
    } finally {
      controller.current = null;
      running.current = false;
      setBusy(false);
    }
  };

  const done = Object.values(statuses).filter((status) => status === 'done').length;
  const strategySkipped = !jobs.some((job) => job.kind === 'strategy');
  const review = (job: BatchJob) => {
    if (job.kind !== 'fields') return;
    close();
    openDraft(job.step);
  };

  return (
      <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) close(); }}>
        <DialogSurface className="dlv-draft-surface" data-testid="dlv-batch-dialog">
          <DialogBody>
            <DialogTitle>{t('dlv.batch.title')}</DialogTitle>
            <DialogContent>
              <p>{t('dlv.batch.intro', { n: jobs.length })}</p>
              <p>{t('dlv.batch.note')}</p>
              <p className="muted">{t('dlv.batch.limits')}</p>
              {strategySkipped && <p role="status">{t('dlv.batch.strategySkipped')}</p>}
              <ProgressBar value={jobs.length ? done / jobs.length : 0} aria-label={t('dlv.batch.progress', { done, total: jobs.length })} />
              <p role="status" data-testid="dlv-batch-progress">{t('dlv.batch.progress', { done, total: jobs.length })}</p>
              {error && <p role="alert" data-testid="dlv-batch-error">{error}</p>}
              {interrupted && <p role="status">{t('dlv.batch.interrupted')}</p>}
              {done === jobs.length && !strategySkipped && <p role="status">{t('dlv.batch.complete')}</p>}
              <ol className="dlv-batch-list">
                {jobs.map((job) => {
                  const id = batchJobId(job);
                  const status = statuses[id] ?? 'pending';
                  const statusKey = `dlv.batch.${status}` as MessageKey;
                  return (
                    <li key={id} data-testid={`dlv-batch-${id}`} data-status={status}>
                      <strong>{nameOf(job)}</strong>{' — '}{t(statusKey)}
                      {(status === 'working' || status === 'waiting') && <Spinner size="tiny" />}
                      {!busy && status === 'done' && job.kind === 'fields' && <Button size="small" onClick={() => review(job)}>{t('dlv.batch.review')}</Button>}
                      {!busy && status === 'done' && job.kind === 'brief' && <a href={hrefFor('/step', { step: job.step })} onClick={close}>{t('dlv.batch.briefLink')}</a>}
                      {!busy && status === 'done' && job.kind === 'strategy' && <a href={hrefFor('/', { draft: 'shared' })} onClick={close}>{t('dlv.batch.strategyLink')}</a>}
                    </li>
                  );
                })}
              </ol>
            </DialogContent>
            <DialogActions>
              {busy
                ? <Button onClick={() => controller.current?.abort()} data-testid="dlv-batch-stop">{t('dlv.batch.stop')}</Button>
                : <Button appearance="primary" disabled={invalid || done === jobs.length} onClick={() => void run()} data-testid="dlv-batch-generate">
                  {t(done || error || interrupted ? 'dlv.batch.retry' : 'dlv.batch.start')}
                </Button>}
              <Button disabled={busy} onClick={close}>{t('dlv.batch.close')}</Button>
            </DialogActions>
            {confirmDialog}
          </DialogBody>
        </DialogSurface>
      </Dialog>
  );
}
