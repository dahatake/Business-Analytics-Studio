import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { aiLive, AiLiveError, preflight, type AiRequest } from '../../ai/client.ts';
import { DELIVERABLE_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { flushDeviceStorage } from '../../data/deviceStorage.ts';
import { loaded } from '../../data/pack.ts';
import type { WorkflowExtension } from '../../data/extensionSchemas.ts';
import { useI18n } from '../../i18n/index.ts';
import { currentScope } from '../../state/projects.ts';
import { hrefFor } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { reasonKey } from '../ai/AiCommon.tsx';
import { askWorkIqSections, type WorkIqProvider } from '../ai/relayClient.ts';
import { useAiSettings, workIqReady } from '../ai/settingsStore.ts';
import { objectiveTarget } from '../project/objectiveDraft.ts';
import { Panel } from '../../ui/Panel.tsx';
import { generateProcess, processDraftRequest } from './generate.ts';
import { buildMeasurement, measurementPeriod, measurementPrompt, measurementQuery, type MeasurementPeriod, type RecordSource } from './measurement.ts';
import { saveWorkflow, useProcessEdits } from './store.ts';

type ProcessResult = Promise<WorkflowExtension>;
type ProcessOperation = (signal: AbortSignal) => ProcessResult;

export function ProcessAiPanel({ workflow }: { workflow: WorkflowExtension | null }) {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ period: MeasurementPeriod; worker: string; timeZone: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (audience !== 'internal') return null;
  const check = (request: AiRequest) => {
    const pf = preflight(request);
    if (!pf.allowed) throw new AiLiveError(pf.reasons, pf.reasons.map((r) => t(reasonKey(r))).join(' '), pf.budget);
  };
  const perform = async (operation: ProcessOperation) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    const scope = currentScope(), before = useProcessEdits.getState().value, pack = loaded.pack;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await operation(controller.signal);
      if (controller.signal.aborted) return;
      if (currentScope() !== scope || loaded.pack !== pack || useProcessEdits.getState().value !== before || useSettings.getState().audience !== 'internal' || useSettings.getState().lang !== lang) throw new Error(t('bp.ai.changed'));
      saveWorkflow(result);
      await flushDeviceStorage();
      setNotice(t('bp.ai.saved'));
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof AiLiveError ? e.reasons.map((r) => t(reasonKey(r))).join(' ') || e.message : e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === controller) { abort.current = null; setBusy(false); }
    }
  };
  const prepareMeasurement = () => {
    setError(null);
    try {
      if (!workflow) throw new Error(t('bp.measure.needProcess'));
      const s = useSettings.getState();
      setConfirm({ period: measurementPeriod(s, new Date(), lang), worker: s.processWorker.trim() || t('bp.settings.me'), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const measure = () => {
    const targetPeriod = confirm;
    if (!targetPeriod || !workflow) return;
    setConfirm(null);
    void perform(async (signal) => {
      const target = objectiveTarget();
      const ai = useAiSettings.getState();
      if (!target || !workIqReady(ai)) throw new Error(t('bp.measure.notReady'));
      const request: AiRequest = { use: 'deliverableDraft', lang, scope: currentScope(), stage: 'process-measurement', prompt: measurementPrompt([], targetPeriod.period, workflow, lang), timeoutMs: DELIVERABLE_DRAFT_TIMEOUT_MS };
      check(request);
      const sections = await askWorkIqSections({
        company: target.companyName, project: target.projectName, purpose: target.purpose || target.projectName, focus: target.focus,
        asOf: targetPeriod.period.end.slice(0, 10), lang, timeZone: targetPeriod.timeZone, provider: ai.provider as WorkIqProvider,
        aspects: [], topics: [measurementQuery(targetPeriod.worker, targetPeriod.period, lang)],
      }, signal);
      const warnings: string[] = [];
      const sources: RecordSource[] = [];
      for (const s of sections) {
        if ('error' in s) warnings.push(`${s.key}: ${s.error}`);
        else {
          if (s.withheld) warnings.push(t('workiq.excludedMaterial'));
          sources.push({ ref: `wiq:${s.key}`, title: s.question, text: s.answer, url: s.citations.find((c) => /^https:\/\//i.test(c.url))?.url ?? '' });
        }
      }
      if (!sources.some((s) => s.text.trim())) throw new Error(`${t('bp.measure.noRecords')} ${warnings.join('; ')}`);
      const answer = await aiLive({ ...request, prompt: measurementPrompt(sources, targetPeriod.period, workflow, lang) }, signal);
      const measurement = buildMeasurement(JSON.parse(answer.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')), sources, targetPeriod.period, targetPeriod.worker, targetPeriod.timeZone, workflow, lang);
      return { ...workflow, measurement: { ...measurement, warnings: [...measurement.warnings, ...warnings] } };
    });
  };
  const m = workflow?.measurement;
  return (
    <Panel title={t('bp.ai.title')} testId="bp-ai">
      <p>{t('bp.ai.note')}</p>
      <div className="bp-actions">
        <Button disabled={busy} data-testid="bp-ai-draft" onClick={() => void perform((signal) => {
          const request = processDraftRequest(lang); check(request); return generateProcess(request, signal);
        })}>{t('bp.ai.draft')}</Button>
        <Button disabled={busy || !workflow} data-testid="bp-measure" onClick={prepareMeasurement}>{t('bp.measure.action')}</Button>
        <a href={hrefFor('/settings')}>{t('bp.settings.title')}</a>
        {busy && <Button onClick={() => { abort.current?.abort(); }}>{t('bp.ed.cancel')}</Button>}
      </div>
      {busy && <p role="status">{t('bp.ai.busy')}</p>}
      {error && <MessageBar intent="error" data-testid="bp-ai-error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {notice && <p role="status">{notice}</p>}
      {m && (
        <section data-testid="bp-measurement">
          <h3>{t('bp.measure.title')}</h3>
          <p>{m.worker} · {m.periodStart} — {m.periodEnd} · {m.timeZone}</p>
          <p>{t('bp.measure.scope')}</p>
          <ul>{m.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          <div className="table-scroll" tabIndex={0} role="region" aria-label={t('bp.measure.title')}>
            <table className="data-table">
              <thead><tr>
                <th scope="col">{t('bp.measure.category')}</th><th scope="col">{t('bp.status.measured')}</th>
                <th scope="col">{t('bp.status.recordEstimate')}</th><th scope="col">{t('bp.measure.share')}</th>
                <th scope="col">{t('bp.measure.description')}</th>
              </tr></thead>
              <tbody>{m.categories.map((c) => <tr key={c.name}>
                <th scope="row">{c.name}</th><td>{m.records.some((r) => r.category === c.name && r.kind === 'worklog') ? t('bp.unit.min', { n: fmt.number(c.measuredMinutes) }) : t('bp.status.unknown')}</td>
                <td>{t('bp.unit.min', { n: fmt.number(c.estimatedMinutes) })} ({t('bp.measure.counts', { email: c.emailCount, chat: c.chatCount, calendar: fmt.number(c.calendarMinutes) })})</td>
                <td>{fmt.percent(c.sharePct / 100)}</td><td>{c.description}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <details><summary>{t('bp.measure.evidence')}</summary>
            <ul>{m.records.map((r) => <li key={`${r.kind}:${r.id}`}>
              {r.id} · {r.category} · {r.start}{r.end ? ` — ${r.end}` : ''}<blockquote>{r.quote}</blockquote>
              {m.sources.find((s) => s.ref === r.ref)?.url && <a href={m.sources.find((s) => s.ref === r.ref)!.url} target="_blank" rel="noreferrer">{t('bp.measure.source')}</a>}
            </li>)}</ul>
          </details>
        </section>
      )}
      {confirm && <Dialog open onOpenChange={(_, d) => { if (!d.open) setConfirm(null); }}>
        <DialogSurface><DialogBody>
          <DialogTitle>{t('bp.measure.confirm')}</DialogTitle>
          <DialogContent><p>{confirm.worker} · {confirm.period.start} — {confirm.period.end}</p><p>{t('bp.measure.consent')}</p></DialogContent>
          <DialogActions><Button onClick={() => setConfirm(null)}>{t('bp.ed.cancel')}</Button><Button appearance="primary" onClick={measure} data-testid="bp-measure-confirm">{t('bp.measure.action')}</Button></DialogActions>
        </DialogBody></DialogSurface>
      </Dialog>}
    </Panel>
  );
}
