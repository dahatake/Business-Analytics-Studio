import { useMemo, useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Textarea,
} from '@fluentui/react-components';
import { ArrowReset20Regular, Edit20Regular } from '@fluentui/react-icons';
import { PARAMS } from '../../config/params.ts';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import type { Range3 } from './simulate.ts';
import {
  analyzeCostOfDelay, methodReadiness, type CostOfDelaySummary, type DelayChannel, type DelayIssue, type DelayOptions,
} from './costOfDelay.ts';
import {
  isQualifiedOut, normalizeDeliverables, setDelayEstimate, unreviewedEstimate, type CheckContext, type DelayEstimate,
} from './deliverables.ts';
import { todayIn } from './deliverablesUi.tsx';
import { priorityInputs } from './priorityBrief.ts';
import { projectTriage } from './issueTriage.ts';
import { analyzeRobustness, packEntityName, summarizeRobustness } from './priorityRobustness.ts';
import { ChartFigure, LegendItem } from './stepCharts.tsx';
import { useDeliverables, useProjUi } from './stores.ts';

const pct = (x: number) => `${Math.max(0, Math.min(100, x * 100))}%`;
const CHART_ROWS = 8;
type IdSet = ReadonlySet<string>;

function Bar({ value, brand }: { value: number; brand: boolean }) {
  return (
    <span className="step-chart-track">
      <span className={`step-chart-bar ${brand ? 'is-brand' : 'is-neutral'}`} style={{ width: pct(value) }} />
    </span>
  );
}

/** The project's inputs: its issues (less the ones qualified out or set aside by the triage), its estimates and its unapproved Copilot benefit estimates. */
export function projectDelayOptions(ctx: CheckContext, excluded: IdSet = new Set()): DelayOptions & { entities: ReturnType<typeof entitiesOf> } {
  const entities = entitiesOf(ctx);
  const unreviewed = new Set(entities.filter((e) => e.kind === 'solution' && unreviewedEstimate(ctx.deliverables, e, 'annualBenefitJpy')).map((e) => e.id));
  const out = new Set([...excluded, ...projectTriage(ctx).gated, ...entities.filter((e) => e.kind === 'issue' && isQualifiedOut(ctx.deliverables, e.id)).map((e) => e.id)]);
  return { entities, extension: ctx.pack.pack.extensions?.delayCost, estimates: ctx.deliverables.delayEstimates, unreviewed, excluded: out };
}
const entitiesOf = (ctx: CheckContext) => [...ctx.pack.byId.values()];

/** The Cost of Delay line of an ingest summary (pack generation, pack import). */
export function DelayCostSummary({ summary, pack, testId }: { summary: CostOfDelaySummary; pack: Record<string, unknown>; testId: string }) {
  const { t, fmt, lang } = useI18n();
  const name = (id: string | null) => (id ? packEntityName(pack, id, lang) : '');
  return (
    <>
      <dt>{t('proj.gen.sum.cod')}</dt>
      <dd data-testid={testId} data-verdict={summary.verdict}>
        {summary.verdict === 'none'
          ? t('proj.gen.sum.codNone', { have: summary.ranked, pursued: summary.pursued })
          : t('proj.gen.sum.codValue', { name: name(summary.pick), share: fmt.percent(summary.pickShare) })}
        {summary.verdict === 'differs' && <><br />{t('proj.gen.sum.codDiffers', { name: name(summary.ifPick), saving: fmt.yen(summary.saving) })}</>}
        {summary.verdict === 'agree' && <><br />{t('proj.gen.sum.codAgree')}</>}
        {summary.next && <><br />{t('proj.gen.sum.codNext', { name: name(summary.next.id), param: t(`proj.cod.param.${summary.next.param}`), value: fmt.yen(summary.next.evppiJpy) })}</>}
        {summary.missing.length > 0 && <><br />{t('proj.gen.sum.codMissing', { n: summary.missing.length })}</>}
      </dd>
    </>
  );
}

/**
 * FR-365: Cost of Delay (CD3) — the order that loses the least value while issues wait, how firm it is, the one number worth
 * confirming next, the numbers still missing and where to get them, a what-if, and which prioritisation methods the data now
 * support. Recomputed whenever the project's data change (Copilot fill, pack import, estimates); the what-if is not saved.
 */
export function CostOfDelayPanel({ step, ctx }: { step: ImprovementStep; ctx: CheckContext }) {
  const { t, fmt, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [excluded, setExcluded] = useState<IdSet>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const opts = useMemo(() => projectDelayOptions(ctx, excluded), [ctx, excluded]);
  const c = useMemo(() => analyzeCostOfDelay(opts.entities, opts), [opts]);
  const all = useMemo(() => {
    const base = projectDelayOptions(ctx);
    return analyzeCostOfDelay(base.entities, { ...base, runs: 1 });
  }, [ctx]);
  const readiness = useMemo(() => {
    const inputs = priorityInputs(ctx);
    return methodReadiness(inputs.length, all, summarizeRobustness(analyzeRobustness(inputs, { runs: 400 })));
  }, [ctx, all]);
  const listed = useMemo(() => [...all.ranked, ...all.missing].sort((a, b) => a.ifRank - b.ifRank), [all]);
  const nameOf = (id: string) => {
    const e = ctx.pack.byId.get(id);
    if (!e) return id;
    return isHidden(e, audience) ? t('proj.dash.chart.hidden') : loc(e.name, lang);
  };
  const toggle = (id: string, on: boolean) => setExcluded((s) => {
    const next = new Set(s);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const rangeText = (r: Range3 | null, unit: 'yen' | 'months') => {
    if (!r) return t('proj.cod.unknown');
    const f = (x: number) => (unit === 'yen' ? fmt.yen(Math.round(x)) : t('proj.cod.months', { n: fmt.number(Math.round(x * 10) / 10) }));
    return r.low === r.high ? f(r.mode) : t('proj.cod.range', { mode: f(r.mode), low: f(r.low), high: f(r.high) });
  };
  const channelText = (i: DelayIssue, ch: DelayChannel | null) => {
    if (!ch) return '';
    return ch === 'fill' && i.fillSolutionId ? t('proj.cod.via.fill', { solution: nameOf(i.fillSolutionId) }) : t(`proj.cod.via.${ch}`);
  };
  const maxCd3 = Math.max(...c.ranked.map((r) => r.cd3), 0);
  const maxCost = Math.max(c.costIf, c.costCd3, 0);
  const byEvppi = c.ranked.flatMap((r) => (['value', 'duration'] as const).map((param) => ({ id: r.id, param, v: r.evppi[param] }))).filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 6);
  const maxEvppi = Math.max(...byEvppi.map((x) => x.v), 0);
  const id = `prio-cod-${step}`;
  const editIssue = editing ? ctx.pack.byId.get(editing) : undefined;

  return (
    <Panel title={t('proj.cod.title')} rationale="proj.cod.rationale" testId="step-cod" className="span-full">
      <p className="muted">{t('proj.cod.lead', { runs: c.runs })}</p>
      <section className="prio-block" aria-labelledby={`${id}-pick`} data-testid="step-cod-verdict" data-verdict={c.verdict} data-pick={c.pick ?? undefined}>
        <h4 id={`${id}-pick`} className="prio-label">{t('proj.cod.pickLabel')}</h4>
        {c.pick && c.verdict !== 'none' ? (
          <>
            <p className="prio-summary">
              <EntityRef id={c.pick} />{' '}
              <Badge size="small" appearance="tint" color={c.verdict === 'agree' ? 'success' : 'warning'}>{t(`proj.cod.badge.${c.verdict}`)}</Badge>
            </p>
            <p data-testid="step-cod-verdict-text">
              <strong>
                {c.verdict === 'agree'
                  ? t('proj.cod.verdict.agree', { share: fmt.percent(c.ranked[0]!.pFirst) })
                  : t('proj.cod.verdict.differs', { share: fmt.percent(c.ranked[0]!.pFirst), saving: fmt.yen(c.saving), beat: fmt.percent(c.beatShare) })}
              </strong>
            </p>
            {c.verdict === 'differs' && c.ifPick && <p data-testid="step-cod-ifpick">{t('proj.cod.ifPick')}{' '}<EntityRef id={c.ifPick} /></p>}
            {!c.firm && <p data-testid="step-cod-unfirm">{t('proj.cod.unfirm')}</p>}
          </>
        ) : <p data-testid="step-cod-verdict-text">{t('proj.cod.verdict.none', { have: c.ranked.length, pursued: c.pursued })}</p>}
      </section>
      {c.verdict !== 'none' && (
        <section className="prio-block" aria-labelledby={`${id}-next`} data-testid="step-cod-next">
          <h4 id={`${id}-next`} className="prio-label">{t('proj.cod.nextLabel')}</h4>
          {c.next ? (
            <p data-testid="step-cod-next-check" data-issue={c.next.id} data-param={c.next.param}>
              <EntityRef id={c.next.id} />{' '}
              {t('proj.cod.next.check', { param: t(`proj.cod.param.${c.next.param}`), value: fmt.yen(c.next.evppiJpy) })}
            </p>
          ) : <p data-testid="step-cod-next-none">{t('proj.cod.next.none')}</p>}
        </section>
      )}
      {c.ranked.length > 0 && (
        <ChartFigure
          id="prio-cod"
          title={t('proj.cod.chart.cd3.title')}
          read={t('proj.cod.chart.cd3.read')}
          legend={<LegendItem kind="is-brand" label={t('proj.cod.col.cd3')} />}
          visual={(
            <div className="step-chart-rows">
              {c.ranked.slice(0, CHART_ROWS).map((r) => (
                <div key={r.id} className="step-chart-row" data-testid={`step-cod-row-${r.id}`} data-cd3={r.cd3}>
                  <span className="step-chart-label">{nameOf(r.id)}</span>
                  <Bar value={maxCd3 > 0 ? r.cd3 / maxCd3 : 0} brand />
                  <span className="step-chart-value">{fmt.yen(r.cd3)}</span>
                </div>
              ))}
            </div>
          )}
          table={(
            <table className="data-table compact">
              <thead><tr>
                <th scope="col" className="num">{t('proj.cod.col.cd3Rank')}</th><th scope="col">{t('proj.rob.col.issue')}</th>
                <th scope="col">{t('proj.cod.col.value')}</th><th scope="col">{t('proj.cod.col.duration')}</th>
                <th scope="col" className="num">{t('proj.cod.col.cd3')}</th><th scope="col" className="num">{t('proj.cod.col.first')}</th>
                <th scope="col" className="num">{t('proj.cod.col.ifRank')}</th>
              </tr></thead>
              <tbody>
                {c.ranked.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{r.cd3Rank}</td><th scope="row">{nameOf(r.id)}</th>
                    <td>{rangeText(r.value, 'yen')}</td><td>{rangeText(r.duration, 'months')}</td>
                    <td className="num">{fmt.yen(r.cd3)}</td><td className="num">{fmt.percent(r.pFirst)}</td><td className="num">{r.ifRank}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
      )}
      {c.verdict !== 'none' && (
        <ChartFigure
          id="prio-cod-seq"
          title={t('proj.cod.chart.seq.title')}
          read={t('proj.cod.chart.seq.read', { low: fmt.yen(c.savingLow), high: fmt.yen(c.savingHigh) })}
          legend={<><LegendItem kind="is-neutral" label={t('proj.cod.seq.if')} /><LegendItem kind="is-brand" label={t('proj.cod.seq.cd3')} /></>}
          visual={(
            <div className="step-chart-rows" data-testid="step-cod-seq">
              <div className="step-chart-row">
                <span className="step-chart-label">{t('proj.cod.seq.if')}</span>
                <Bar value={maxCost > 0 ? c.costIf / maxCost : 0} brand={false} />
                <span className="step-chart-value">{fmt.yen(c.costIf)}</span>
              </div>
              <div className="step-chart-row">
                <span className="step-chart-label">{t('proj.cod.seq.cd3')}</span>
                <Bar value={maxCost > 0 ? c.costCd3 / maxCost : 0} brand />
                <span className="step-chart-value">{fmt.yen(c.costCd3)}</span>
              </div>
            </div>
          )}
          table={(
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.cod.col.order')}</th><th scope="col" className="num">{t('proj.cod.col.cost')}</th><th scope="col">{t('proj.cod.col.sequence')}</th>
              </tr></thead>
              <tbody>
                <tr><th scope="row">{t('proj.cod.seq.if')}</th><td className="num">{fmt.yen(c.costIf)}</td><td>{[...c.ranked].sort((a, b) => a.ifRank - b.ifRank).map((r) => nameOf(r.id)).join(' → ')}</td></tr>
                <tr><th scope="row">{t('proj.cod.seq.cd3')}</th><td className="num">{fmt.yen(c.costCd3)}</td><td>{c.ranked.map((r) => nameOf(r.id)).join(' → ')}</td></tr>
                <tr><th scope="row">{t('proj.cod.seq.saving')}</th><td className="num" data-testid="step-cod-saving">{fmt.yen(c.saving)}</td><td>{t('proj.cod.seq.beat', { beat: fmt.percent(c.beatShare) })}</td></tr>
              </tbody>
            </table>
          )}
        />
      )}
      {c.verdict !== 'none' && byEvppi.length > 0 && (
        <ChartFigure
          id="prio-cod-voi"
          title={t('proj.cod.chart.voi.title')}
          read={t('proj.cod.chart.voi.read')}
          legend={<LegendItem kind="is-brand" label={t('proj.cod.col.evppi')} />}
          visual={(
            <div className="step-chart-rows">
              {byEvppi.map((x) => (
                <div key={`${x.id}-${x.param}`} className="step-chart-row" data-testid={`step-cod-voi-${x.id}-${x.param}`}>
                  <span className="step-chart-label">{`${nameOf(x.id)} · ${t(`proj.cod.param.${x.param}`)}`}</span>
                  <Bar value={maxEvppi > 0 ? x.v / maxEvppi : 0} brand />
                  <span className="step-chart-value">{fmt.yen(x.v)}</span>
                </div>
              ))}
            </div>
          )}
          table={(
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.rob.col.issue')}</th><th scope="col" className="num">{t('proj.cod.col.evppiValue')}</th><th scope="col" className="num">{t('proj.cod.col.evppiDuration')}</th>
              </tr></thead>
              <tbody>
                {c.ranked.map((r) => (
                  <tr key={r.id}><th scope="row">{nameOf(r.id)}</th><td className="num">{fmt.yen(r.evppi.value)}</td><td className="num">{fmt.yen(r.evppi.duration)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        />
      )}
      {listed.length > 0 && (
        <section className="prio-block" aria-labelledby={`${id}-inputs`} data-testid="step-cod-inputs">
          <h4 id={`${id}-inputs`} className="prio-label">{t('proj.cod.inputsLabel')}</h4>
          <p className="muted">{t('proj.cod.inputsLead')}</p>
          <table className="data-table compact">
            <thead><tr>
              <th scope="col">{t('proj.rob.col.issue')}</th><th scope="col">{t('proj.cod.col.value')}</th><th scope="col">{t('proj.cod.col.origin')}</th>
              <th scope="col">{t('proj.cod.col.duration')}</th><th scope="col">{t('proj.cod.col.origin')}</th><th scope="col">{t('proj.cod.col.action')}</th>
            </tr></thead>
            <tbody>
              {listed.map((i) => (
                <tr key={i.id} data-testid={`step-cod-input-${i.id}`} data-missing={!i.value || !i.duration}>
                  <th scope="row">{nameOf(i.id)}</th>
                  <td>{rangeText(i.value, 'yen')}</td>
                  <td>{i.valueOrigin ? t(`proj.cod.origin.${i.valueOrigin}`) + (i.valueOrigin === 'solution' && !i.valueFirm ? t('proj.cod.unapproved') : '') : channelText(i, i.valueVia)}</td>
                  <td>{rangeText(i.duration, 'months')}</td>
                  <td>{i.durationOrigin ? t(`proj.cod.origin.${i.durationOrigin}`) : channelText(i, i.durationVia)}</td>
                  <td>
                    <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setEditing(i.id)} aria-label={`${t('proj.cod.estimate')}: ${nameOf(i.id)}`} data-testid={`step-cod-estimate-${i.id}`}>
                      {t('proj.cod.estimate')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {all.done.length > 0 && <p className="muted" data-testid="step-cod-done">{t('proj.cod.done', { names: all.done.map(nameOf).join(lang === 'ja' ? '、' : ', ') })}</p>}
        </section>
      )}
      {editIssue?.kind === 'issue' && <DelayEstimateDialog ctx={ctx} issueId={editIssue.id} name={nameOf(editIssue.id)} onClose={() => setEditing(null)} />}
      {listed.length > 1 && (
        <details className="dec-edit" data-testid="step-cod-sim">
          <summary>{t('proj.rob.sim.label')}</summary>
          <p className="muted">{t('proj.cod.sim.lead')}</p>
          <table className="data-table compact">
            <thead><tr><th scope="col">{t('proj.rob.col.issue')}</th><th scope="col">{t('proj.rob.sim.exclude')}</th></tr></thead>
            <tbody>
              {listed.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{nameOf(i.id)}</th>
                  <td><Checkbox checked={excluded.has(i.id)} onChange={(_, d) => toggle(i.id, d.checked === true)} aria-label={`${nameOf(i.id)} ${t('proj.rob.sim.exclude')}`} data-testid={`step-cod-exclude-${i.id}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button appearance="subtle" icon={<ArrowReset20Regular />} disabled={excluded.size === 0} onClick={() => setExcluded(new Set())} data-testid="step-cod-reset">{t('proj.rob.sim.reset')}</Button>
        </details>
      )}
      <section className="prio-block" aria-labelledby={`${id}-ready`} data-testid="step-cod-readiness">
        <h4 id={`${id}-ready`} className="prio-label">{t('proj.cod.readyLabel')}</h4>
        <p className="muted">{t('proj.cod.readyLead')}</p>
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.cod.col.method')}</th><th scope="col">{t('proj.cod.col.data')}</th><th scope="col">{t('proj.cod.col.status')}</th>
            <th scope="col">{t('proj.cod.col.changes')}</th>
          </tr></thead>
          <tbody>
            {readiness.map((r) => (
              <tr key={r.method} data-testid={`step-cod-ready-${r.method}`} data-status={r.status} data-changes={r.changes}>
                <th scope="row">{t(`proj.cod.method.${r.method}`)}</th>
                <td>{t(`proj.cod.methodData.${r.method}`)}</td>
                <td>{t(`proj.cod.status.${r.status}`, { have: r.have, need: r.need })}</td>
                <td>{t(`proj.cod.changes.${r.changes}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Panel>
  );
}

const NUM_FIELDS = ['low', 'mode', 'high'] as const;
type Draft = Record<(typeof NUM_FIELDS)[number], string>;
const draftOf = (r: Range3 | undefined): Draft => ({ low: r ? String(r.low) : '', mode: r ? String(r.mode) : '', high: r ? String(r.high) : '' });
/** null = left blank (not given); undefined = invalid. `zero` allows 0 (months until an impact that has arrived already). */
function rangeOf(d: Draft, zero = false): Range3 | null | undefined {
  if (NUM_FIELDS.every((k) => d[k].trim() === '')) return null;
  const [low, mode, high] = NUM_FIELDS.map((k) => Number(d[k]));
  const r = { low: low!, mode: mode!, high: high! };
  return [r.low, r.mode, r.high].every((x) => Number.isFinite(x) && (zero ? x >= 0 : x > 0)) && r.low <= r.mode && r.mode <= r.high ? r : undefined;
}

/**
 * A person's estimate of one issue's value per month, months left (= time to respond) and months until its impact arrives (FR-383);
 * overrides the pack and the derived values.
 */
export function DelayEstimateDialog({ ctx, issueId, name, onClose }: { ctx: CheckContext; issueId: string; name: string; onClose: () => void }) {
  const { t, fmt } = useI18n();
  const saved: DelayEstimate | undefined = ctx.deliverables.delayEstimates?.[issueId];
  const [value, setValue] = useState<Draft>(draftOf(saved?.valuePerMonthJpy));
  const [duration, setDuration] = useState<Draft>(draftOf(saved?.durationMonths));
  const [impact, setImpact] = useState<Draft>(draftOf(saved?.impactMonths));
  const [note, setNote] = useState(saved?.note ?? '');
  const [tried, setTried] = useState(false);
  const v = rangeOf(value);
  const d = rangeOf(duration);
  const im = rangeOf(impact, true);
  const noteMissing = note.trim() === '';
  const nothing = v === null && d === null && im === null;
  const write = (next: DelayEstimate | null) => {
    useDeliverables.getState().set((raw) => setDelayEstimate(normalizeDeliverables(raw), issueId, next));
    onClose();
  };
  const save = () => {
    setTried(true);
    if (v === undefined || d === undefined || im === undefined || nothing || noteMissing) return;
    write({
      ...(v ? { valuePerMonthJpy: v } : {}), ...(d ? { durationMonths: d } : {}), ...(im ? { impactMonths: im } : {}),
      note: note.trim(), at: new Date().toISOString(), by: useProjUi.getState().editor.trim(),
    });
  };
  const rangeFields = (kind: 'value' | 'duration' | 'impact', draft: Draft, set: (d: Draft) => void, invalid: boolean) => (
    <fieldset className="dec-weights" data-testid={`cod-est-${kind}`}>
      <legend>{t(`proj.cod.est.${kind}`)}</legend>
      {kind === 'impact' && <p className="muted">{t('proj.cod.est.impactHint')}</p>}
      {NUM_FIELDS.map((k) => (
        <Field key={k} label={t(`proj.cod.est.${k}`)} size="small" validationState={tried && invalid ? 'error' : 'none'}>
          <Input type="number" min={0} inputMode="decimal" value={draft[k]} onChange={(_, x) => set({ ...draft, [k]: x.value })} data-testid={`cod-est-${kind}-${k}`} />
        </Field>
      ))}
      {tried && invalid && <MessageBar intent="error"><MessageBarBody>{t(kind === 'impact' ? 'proj.cod.est.invalidImpact' : 'proj.cod.est.invalid')}</MessageBarBody></MessageBar>}
    </fieldset>
  );
  const savedDate = saved ? fmt.date(todayIn(PARAMS.timeZone, new Date(saved.at))) : '';
  return (
    <Dialog open onOpenChange={(_, x) => { if (!x.open) onClose(); }}>
      <DialogSurface className="form-surface" data-testid="cod-est-dialog">
        <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
          <DialogBody>
            <DialogTitle>{t('proj.cod.est.title', { issue: name })}</DialogTitle>
            <DialogContent className="proj-edit-form">
              <p className="muted">{t('proj.cod.est.lead')}</p>
              {rangeFields('value', value, setValue, v === undefined)}
              {rangeFields('duration', duration, setDuration, d === undefined)}
              {rangeFields('impact', impact, setImpact, im === undefined)}
              {tried && nothing && <MessageBar intent="error"><MessageBarBody>{t('proj.cod.est.nothing')}</MessageBarBody></MessageBar>}
              <Field label={t('proj.cod.est.note')} hint={t('proj.cod.est.noteHint')} required validationState={tried && noteMissing ? 'error' : 'none'} validationMessage={tried && noteMissing ? t('proj.qualify.required') : undefined}>
                <Textarea value={note} onChange={(_, x) => setNote(x.value)} resize="vertical" rows={3} data-testid="cod-est-note" />
              </Field>
              {saved && (
                <p className="muted" data-testid="cod-est-saved">
                  {saved.by ? t('proj.qualify.savedBy', { date: savedDate, by: saved.by }) : t('proj.qualify.savedAnon', { date: savedDate })}
                </p>
              )}
            </DialogContent>
            <DialogActions>
              <Button type="submit" appearance="primary" data-testid="cod-est-save">{t('proj.save')}</Button>
              {saved && <Button type="button" onClick={() => write(null)} data-testid="cod-est-clear">{t('proj.cod.est.clear')}</Button>}
              <Button type="button" onClick={onClose}>{t('proj.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
