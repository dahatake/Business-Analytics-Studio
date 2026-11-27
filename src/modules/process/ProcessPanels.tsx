import { useMemo, useState } from 'react';
import { Button, Field, Input, Select } from '@fluentui/react-components';
import type { EntityOf } from '../../data/schema.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import {
  delta, effortHours, HOURS_PER_FTE_MONTH, hoursPerUnit, ioAnalysis, laneResources, leadHours, metricStatus, metricsIn, PROC_STATES, presentIn,
  RECONCILE_TOLERANCE, reconcile, stepDelta, totals, type ProcessView, type ProcState, type Totals,
} from './model.ts';
import { duration, formKey, hoursMonth, signedPercent } from './format.ts';

/* ---------- Summary tiles ---------- */

type Better = 'lower' | 'higher';
function Tile({ label, before, after, text, better, testId, note }: {
  label: string; before: number | null; after: number | null; text: (v: number | null) => string; better: Better; testId: string; note?: string;
}) {
  const { fmt } = useI18n();
  const d = delta(before, after);
  const good = d === null || d === 0 ? null : (better === 'lower') === d < 0;
  return (
    <div className="bp-tile" data-testid={testId}>
      <span className="bp-tile-label">{label}</span>
      <span className="bp-tile-values">
        <span className="bp-tile-before">{text(before)}</span>
        <span aria-hidden> → </span>
        <span className="bp-tile-after">{text(after)}</span>
      </span>
      {d !== null && <span className={`bp-tile-delta ${good === null ? '' : good ? 'is-good' : 'is-bad'}`}>{signedPercent(d, fmt)}</span>}
      {note && <span className="muted bp-tile-note">{note}</span>}
    </div>
  );
}

export function SummaryTiles({ view }: { view: ProcessView }) {
  const { t, fmt } = useI18n();
  const [a, b] = useMemo(() => [totals(view, 'asIs'), totals(view, 'toBe')] as const, [view]);
  const count = (v: number | null) => (v === null ? t('bp.unknown') : fmt.integer(v));
  const pct = (v: number | null) => (v === null ? t('bp.unknown') : fmt.percent(v));
  const unknownNote = (x: Totals, y: Totals) => (x.unknownOnPath + y.unknownOnPath > 0 ? t('bp.tile.unknownSteps', { n: Math.max(x.unknownOnPath, y.unknownOnPath) }) : undefined);
  return (
    <>
    <p data-testid="bp-numeric-status">{t('bp.status.summary', {
      before: [...new Set(view.steps.flatMap((s) => metricStatus(s.asIs)))].map((s) => t(`bp.status.${s}`)).join(' / '),
      after: [...new Set(view.steps.flatMap((s) => metricStatus(s.toBe)))].map((s) => t(`bp.status.${s}`)).join(' / '),
    })}{view.laborRate !== null ? ` · ${t('bp.tile.cost')}: ${t(`bp.status.${view.laborEvidence?.status ?? 'unknown'}`)}` : ''}</p>
    <section className="bp-tiles" aria-label={t('bp.tile.title')} data-testid="bp-tiles">
      <Tile testId="bp-tile-lead" label={t('bp.tile.lead')} before={a.leadHours} after={b.leadHours} text={(v) => duration(v, t, fmt)} better="lower"
        note={[a.externalHours ? t('bp.tile.external', { before: duration(a.externalHours, t, fmt), after: duration(b.externalHours, t, fmt) }) : '', unknownNote(a, b) ?? ''].filter(Boolean).join(' ') || undefined} />
      <Tile testId="bp-tile-efficiency" label={t('bp.tile.efficiency')} before={a.efficiency} after={b.efficiency} text={pct} better="higher" note={t('bp.tile.efficiencyNote')} />
      <Tile testId="bp-tile-effort" label={t('bp.tile.effort')} before={a.effortHours} after={b.effortHours} text={(v) => hoursMonth(v, t, fmt)} better="lower"
        note={a.fte !== null && b.fte !== null ? t('bp.tile.fte', { before: fmt.number(a.fte), after: fmt.number(b.fte), hours: HOURS_PER_FTE_MONTH }) : undefined} />
      <Tile testId="bp-tile-cost" label={t('bp.tile.cost')} before={a.costJpy} after={b.costJpy} text={(v) => (v === null ? t('bp.tile.noRate') : fmt.yen(v))} better="lower" />
      <Tile testId="bp-tile-steps" label={t('bp.tile.steps')} before={a.steps} after={b.steps} text={count} better="lower"
        note={t('bp.tile.stepsNote', { removed: view.steps.filter((s) => presentIn(s, 'asIs') && !presentIn(s, 'toBe')).length, added: view.steps.filter((s) => s.change === 'new').length })} />
      <Tile testId="bp-tile-handoffs" label={t('bp.tile.handoffs')} before={a.handoffs} after={b.handoffs} text={count} better="lower" note={t('bp.tile.externalTouches', { before: a.externalTouches, after: b.externalTouches })} />
      <Tile testId="bp-tile-manual" label={t('bp.tile.manual')} before={a.manualArtifacts + a.hiddenWork} after={b.manualArtifacts + b.hiddenWork} text={count} better="lower" note={t('bp.tile.manualNote')} />
      <Tile testId="bp-tile-yield" label={t('bp.tile.yield')} before={a.rolledYield} after={b.rolledYield} text={pct} better="higher" note={t('bp.tile.yieldNote')} />
    </section>
    </>
  );
}

/* ---------- Value stream timeline ---------- */

/** The VSM timeline ladder: hands-on time against waiting time, step by step along the longest path. */
export function TimelinePanel({ view }: { view: ProcessView }) {
  const { t, lang, fmt } = useI18n();
  const [a, b] = useMemo(() => [totals(view, 'asIs'), totals(view, 'toBe')] as const, [view]);
  const ids = view.steps.filter((s) => a.path.includes(s.id) || b.path.includes(s.id)).map((s) => s.id);
  const max = Math.max(1, ...ids.flatMap((id) => [leadHours(view.byId.get(id)!.asIs) ?? 0, leadHours(view.byId.get(id)!.toBe) ?? 0]));
  const scale = (h: number) => (Math.sqrt(h) / Math.sqrt(max)) * 100;
  const bar = (id: string, state: ProcState, onPath: boolean) => {
    const m = metricsIn(view.byId.get(id)!, state);
    if (!m || !onPath) return <span className="muted">{presentIn(view.byId.get(id)!, state) ? t('bp.timeline.offPath') : t('bp.timeline.absent')}</span>;
    const touch = (m.touchMin ?? 0) / 60, wait = m.waitH ?? 0, total = touch + wait;
    const w = scale(total), tw = total ? (touch / total) * w : 0;
    return (
      <span className="bp-tl-cell">
        <span className="bp-bar is-wide"><span className="bp-bar-touch" style={{ width: `${tw}%` }} /><span className="bp-bar-wait" style={{ width: `${w - tw}%` }} /></span>
        <span className="bp-tl-num">{duration(leadHours(m), t, fmt)}</span>
      </span>
    );
  };
  return (
    <Panel title={t('bp.timeline.title')} rationale="bp.rationale.timeline" testId="bp-timeline">
      <p className="muted">{t('bp.timeline.hint')}</p>
      <div className="table-scroll" role="region" aria-label={t('bp.timeline.title')} tabIndex={0}>
        <table className="data-table bp-timeline">
          <thead><tr><th scope="col">{t('bp.col.step')}</th><th scope="col">{t('bp.state.asIs')}</th><th scope="col">{t('bp.state.toBe')}</th><th scope="col" className="num">{t('bp.col.delta')}</th></tr></thead>
          <tbody>
            {ids.map((id) => {
              const s = view.byId.get(id)!;
              return (
                <tr key={id}>
                  <th scope="row">{loc(s.name, lang)}{s.change !== 'keep' && <span className={`bp-tag change-${s.change}`}>{t(`bp.change.${s.change}`)}</span>}</th>
                  <td>{bar(id, 'asIs', a.path.includes(id))}</td>
                  <td>{bar(id, 'toBe', b.path.includes(id))}</td>
                  <td className="num">{signedPercent(stepDelta(s).lead, fmt)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><th scope="row">{t('bp.timeline.total')}</th><td>{duration(a.leadHours, t, fmt)}</td><td>{duration(b.leadHours, t, fmt)}</td><td className="num">{signedPercent(delta(a.leadHours, b.leadHours), fmt)}</td></tr>
            <tr><th scope="row">{t('bp.timeline.touch')}</th><td>{duration(a.touchHours, t, fmt)}</td><td>{duration(b.touchHours, t, fmt)}</td><td className="num">{signedPercent(delta(a.touchHours, b.touchHours), fmt)}</td></tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

/* ---------- KPI reconciliation ---------- */

export function ReconcilePanel({ view, onSpans }: { view: ProcessView; onSpans: (spans: ProcessView['kpiSpans']) => void }) {
  const { t, lang, fmt } = useI18n();
  const rows = useMemo(() => reconcile(view, loaded.pack.entities), [view]);
  const kpis = loaded.pack.entities.filter((e): e is EntityOf<'kpi'> => e.kind === 'kpi' && hoursPerUnit(e.unit) !== null);
  const [draft, setDraft] = useState({ kpiId: '', from: '', to: '' });
  const canAdd = draft.kpiId && draft.from && draft.to && draft.from !== draft.to;
  return (
    <Panel title={t('bp.kpi.title')} rationale="bp.rationale.kpi" testId="bp-reconcile">
      <p className="muted">{t('bp.kpi.hint', { tolerance: fmt.percent(RECONCILE_TOLERANCE) })}</p>
      {rows.length === 0 ? <p className="muted" data-testid="bp-reconcile-empty">{t('bp.kpi.none')}</p> : (
        <div className="table-scroll" role="region" aria-label={t('bp.kpi.title')} tabIndex={0}>
          <table className="data-table">
            <thead><tr><th scope="col">{t('bp.kpi.col.kpi')}</th><th scope="col">{t('bp.kpi.col.span')}</th><th scope="col">{t('bp.card.state')}</th><th scope="col" className="num">{t('bp.kpi.col.steps')}</th><th scope="col" className="num">{t('bp.kpi.col.kpiValue')}</th><th scope="col">{t('bp.kpi.col.verdict')}</th></tr></thead>
            <tbody>
              {rows.flatMap((r) => r.rows.map((row, i) => {
                const ok = row.gap !== null && Math.abs(row.gap) <= RECONCILE_TOLERANCE;
                const verdict = r.unitHours === null ? t('bp.kpi.notTime') : row.gap === null ? t('bp.unknown') : ok ? t('bp.kpi.match', { gap: signedPercent(row.gap, fmt) }) : t('bp.kpi.gap', { gap: signedPercent(row.gap, fmt) });
                return (
                  <tr key={`${r.kpiId}-${row.state}`} data-testid={`bp-reconcile-${r.kpiId}-${row.state}`} data-ok={ok}>
                    {i === 0 && <td rowSpan={2}><EntityRef id={r.kpiId} /></td>}
                    {i === 0 && <td rowSpan={2}>{t('bp.kpi.span', { from: loc(view.byId.get(r.from)!.name, lang), to: loc(view.byId.get(r.to)!.name, lang) })}</td>}
                    <td>{t(row.state === 'asIs' ? 'bp.kpi.current' : 'bp.kpi.target')}</td>
                    <td className="num">{duration(row.stepsHours, t, fmt)}{row.unknown ? ` ${t('bp.kpi.unknownSteps', { n: row.unknown })}` : ''}</td>
                    <td className="num">{row.kpiHours === null ? fmt.number(row.kpiValue) : duration(row.kpiHours, t, fmt)}</td>
                    <td className={ok ? 'bp-ok' : 'bp-warn'}>{verdict}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      )}
      {view.kpiSpans.length > 0 && (
        <ul className="bp-spans">
          {view.kpiSpans.map((s, i) => (
            <li key={`--`}>
              {loc(loaded.byId.get(s.kpiId)?.name ?? s.kpiId, lang)}: {t('bp.kpi.span', { from: loc(view.byId.get(s.from)!.name, lang), to: loc(view.byId.get(s.to)!.name, lang) })}
              <Button size="small" appearance="subtle" onClick={() => onSpans(view.kpiSpans.filter((_, j) => j !== i))}>{t('bp.kpi.remove')}</Button>
            </li>
          ))}
        </ul>
      )}
      {kpis.length > 0 && (
        <div className="bp-span-form" data-testid="bp-span-form">
          <Field label={t('bp.kpi.col.kpi')}>
            <Select value={draft.kpiId} onChange={(_, d) => setDraft({ ...draft, kpiId: d.value })}>
              <option value="">{t('bp.kpi.choose')}</option>
              {kpis.map((k) => <option key={k.id} value={k.id}>{loc(k.name, lang)}</option>)}
            </Select>
          </Field>
          {(['from', 'to'] as const).map((end) => (
            <Field key={end} label={t(end === 'from' ? 'bp.kpi.from' : 'bp.kpi.to')}>
              <Select value={draft[end]} onChange={(_, d) => setDraft({ ...draft, [end]: d.value })}>
                <option value="">{t('bp.kpi.choose')}</option>
                {view.steps.map((s) => <option key={s.id} value={s.id}>{loc(s.name, lang)}</option>)}
              </Select>
            </Field>
          ))}
          <Button disabled={!canAdd} onClick={() => { onSpans([...view.kpiSpans, draft]); setDraft({ kpiId: '', from: '', to: '' }); }}>{t('bp.kpi.add')}</Button>
        </div>
      )}
    </Panel>
  );
}

/* ---------- People, things, money and time ---------- */

export function ResourcePanel({ view, onRate }: { view: ProcessView; onRate: (rate: number | null) => void }) {
  const { t, lang, fmt } = useI18n();
  const rows = useMemo(() => laneResources(view), [view]);
  const [rate, setRate] = useState(view.laborRate === null ? '' : String(view.laborRate));
  const sum = (pick: (r: (typeof rows)[number]) => number | null) => {
    const v = rows.map(pick).filter((x): x is number => x !== null);
    return v.length ? v.reduce((p, q) => p + q, 0) : null;
  };
  const pair = (before: number | null, after: number | null, text: (v: number | null) => string) => (
    <>{text(before)} → {text(after)} <span className="muted">{signedPercent(delta(before, after), fmt)}</span></>
  );
  const fte = (v: number | null) => (v === null ? t('bp.unknown') : fmt.number(v));
  const yen = (v: number | null) => (v === null ? '—' : fmt.yenCompact(v));
  const [a, b] = [totals(view, 'asIs'), totals(view, 'toBe')];
  return (
    <Panel title={t('bp.res.title')} rationale="bp.rationale.resources" testId="bp-resources">
      <p className="muted">{t('bp.res.hint', { hours: HOURS_PER_FTE_MONTH })}</p>
      <div className="bp-rate">
        <Field label={t('bp.res.rate')} hint={t('bp.res.rateHint')}>
          <Input type="number" min={0} value={rate} onChange={(_, d) => setRate(d.value)} contentAfter={t('bp.res.rateUnit')} data-testid="bp-rate" />
        </Field>
        <Button onClick={() => onRate(rate.trim() === '' ? null : Math.max(0, Number(rate)) || null)} data-testid="bp-rate-save">{t('bp.res.rateSave')}</Button>
      </div>
      <div className="table-scroll" role="region" aria-label={t('bp.res.title')} tabIndex={0}>
        <table className="data-table" data-testid="bp-resource-table">
          <thead><tr>
            <th scope="col">{t('bp.res.col.lane')}</th>
            <th scope="col">{t('bp.res.col.people')}</th>
            <th scope="col">{t('bp.res.col.fte')}</th>
            <th scope="col">{t('bp.res.col.money')}</th>
            <th scope="col">{t('bp.res.col.things')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const l = view.lanes.find((x) => x.id === r.laneId)!;
              return (
                <tr key={r.laneId}>
                  <th scope="row"><span className={`bp-side-tag is-${l.side}`}>{t(`bp.side.${l.side}`)}</span> {loc(l.name, lang) || t('bp.lane.unassigned')}</th>
                  <td>{pair(r.effortHours.asIs, r.effortHours.toBe, (v) => hoursMonth(v, t, fmt))}</td>
                  <td>{pair(r.fte.asIs, r.fte.toBe, fte)}</td>
                  <td>{pair(r.costJpy.asIs, r.costJpy.toBe, yen)}</td>
                  <td>{r.artifacts.asIs} → {r.artifacts.toBe}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('bp.res.total')}</th>
              <td>{pair(sum((r) => r.effortHours.asIs), sum((r) => r.effortHours.toBe), (v) => hoursMonth(v, t, fmt))}</td>
              <td>{pair(sum((r) => r.fte.asIs), sum((r) => r.fte.toBe), fte)}</td>
              <td>{pair(sum((r) => r.costJpy.asIs), sum((r) => r.costJpy.toBe), yen)}</td>
              <td>{sum((r) => r.artifacts.asIs) ?? 0} → {sum((r) => r.artifacts.toBe) ?? 0}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted">{t('bp.res.time', { before: duration(a.leadHours, t, fmt), after: duration(b.leadHours, t, fmt) })}</p>
      {(a.effortUnknown + b.effortUnknown > 0) && <p className="muted" data-testid="bp-res-unknown">{t('bp.res.unknown', { n: Math.max(a.effortUnknown, b.effortUnknown) })}</p>}
    </Panel>
  );
}

/* ---------- Inputs and work products ---------- */

export function IoPanel({ view, state }: { view: ProcessView; state: ProcState }) {
  const { t, lang } = useI18n();
  const rows = useMemo(() => ioAnalysis(view, state), [view, state]);
  const defined = rows.filter((r) => r.status === 'defined').length;
  return (
    <Panel title={t('bp.io.title')} rationale="bp.rationale.io" testId="bp-io">
      <p className="muted">{t('bp.io.hint')}</p>
      <p data-testid="bp-io-summary">{t('bp.io.summary', { defined, total: rows.length, hidden: rows.reduce((n, r) => n + r.hidden, 0), manual: rows.reduce((n, r) => n + r.manual, 0) })}</p>
      <div className="table-scroll" role="region" aria-label={t('bp.io.title')} tabIndex={0}>
        <table className="data-table bp-io-table">
          <thead><tr><th scope="col">{t('bp.col.step')}</th><th scope="col">{t('bp.card.inputs')}</th><th scope="col">{t('bp.card.outputs')}</th><th scope="col">{t('bp.card.hidden')}</th><th scope="col">{t('bp.io.col.status')}</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const s = view.byId.get(r.stepId)!;
              const list = (items: typeof s.inputs) => items.length
                ? <ul>{items.map((a, i) => <li key={i}>{loc(a.name, lang)}{a.form && <span className="bp-form">{t(formKey(a.form))}</span>}</li>)}</ul>
                : <span className="muted">{t('bp.card.none')}</span>;
              return (
                <tr key={r.stepId} data-testid={`bp-io-${r.stepId}`}>
                  <th scope="row">{loc(s.name, lang)}</th>
                  <td>{list(s.inputs)}</td>
                  <td>{list(s.outputs)}</td>
                  <td>{s.hidden.length ? <ul>{s.hidden.map((h, i) => <li key={i}>{loc(h.name, lang)}</li>)}</ul> : <span className="muted">{t('bp.card.none')}</span>}</td>
                  <td><span className={`bp-io-status is-${r.status}`}>{t(`bp.io.status.${r.status}`)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ---------- All numbers as a table (the accessible equivalent of the map) ---------- */

export function StepTable({ view, onSelect }: { view: ProcessView; onSelect: (id: string) => void }) {
  const { t, lang, fmt } = useI18n();
  const cell = (v: number | null, text: (n: number) => string) => (v === null ? '—' : text(v));
  return (
    <Panel title={t('bp.table.title')} rationale="bp.rationale.table" testId="bp-table">
      <div className="table-scroll" role="region" aria-label={t('bp.table.title')} tabIndex={0}>
        <table className="data-table">
          <thead><tr>
            <th scope="col">{t('bp.col.step')}</th><th scope="col">{t('bp.col.lane')}</th><th scope="col">{t('bp.col.phase')}</th>
            <th scope="col">{t('bp.col.change')}</th>
            {PROC_STATES.map((s) => <th key={s} scope="col" className="num">{t('bp.col.lead', { state: t(`bp.state.${s}`) })}</th>)}
            {PROC_STATES.map((s) => <th key={`e-${s}`} scope="col" className="num">{t('bp.col.effort', { state: t(`bp.state.${s}`) })}</th>)}
            <th scope="col" className="num">{t('bp.col.firstPass')}</th>
          </tr></thead>
          <tbody>
            {view.steps.map((s) => {
              const l = view.lanes.find((x) => x.id === s.laneId)!;
              const ph = view.phases.find((p) => p.id === s.phaseId);
              return (
                <tr key={s.id} data-testid={`bp-row-${s.id}`}>
                  <th scope="row"><Button appearance="transparent" size="small" onClick={() => onSelect(s.id)}>{loc(s.name, lang)}</Button></th>
                  <td><span className={`bp-side-tag is-${l.side}`}>{t(`bp.side.${l.side}`)}</span> {loc(l.name, lang) || t('bp.lane.unassigned')}</td>
                  <td>{ph?.name ? loc(ph.name, lang) : '—'}</td>
                  <td>{t(`bp.change.${s.change}`)}{s.toBeHypothesis && s.change !== 'keep' ? ` (${t('bp.basis.hypothesis')})` : ''}</td>
                  {PROC_STATES.map((st) => <td key={st} className="num">{presentIn(s, st) ? <>{duration(leadHours(metricsIn(s, st)), t, fmt)}<br />{metricStatus(metricsIn(s, st)).map((status) => t(`bp.status.${status}`)).join(' / ')}</> : t('bp.timeline.absent')}</td>)}
                  {PROC_STATES.map((st) => <td key={`e-${st}`} className="num">{presentIn(s, st) ? hoursMonth(effortHours(metricsIn(s, st)), t, fmt) : t('bp.timeline.absent')}</td>)}
                  <td className="num">{cell(s.asIs?.firstPass ?? null, (n) => `${fmt.integer(n)}%`)} → {cell(s.toBe?.firstPass ?? null, (n) => `${fmt.integer(n)}%`)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
