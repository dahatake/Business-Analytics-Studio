import { useEffect, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { Button, Field, Select, Slider } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import type { AppCheckContext } from './deliverables.ts';
import { dateAt, dateOf, dayOf, objectiveTrajectory, playStep, timeline } from './simulationTimeline.ts';
import { okrPct } from './kpiOkr.ts';
import { addMonths, scenarioInputs, type KpiLever } from './kpiWhatIf.ts';
import { realisedShare } from './simulate.ts';
import './cockpit.css';

export function SimulationTimeline({ ctx, visible, lever, date, setDate, children }: {
  ctx: AppCheckContext; visible: (id: string) => boolean; lever: KpiLever; date: string; setDate: (date: string) => void; children?: (date: string, share: number) => ReactNode;
}) {
  const { t, lang, fmt } = useI18n();
  const initiatives = useMemo(() => ctx.pack.pack.entities.filter(e => e.kind === 'initiative').filter(e => visible(e.id)), [ctx, visible]);
  const { moved: kpis, contrib } = useMemo(() => scenarioInputs(ctx.kpi.kpis.filter(k => visible(k.id)), ctx.strategy.contributions.filter(c => visible(c.solutionId) && visible(c.kpiId)), lever), [ctx, visible, lever]);
  const [months, setMonths] = useState(6);
  const rolloutEnd = addMonths(ctx.today, months);
  const model = useMemo(() => timeline(ctx.today, kpis, contrib, [rolloutEnd, ...initiatives.flatMap(e => [e.start, e.end])]), [ctx, kpis, contrib, initiatives, rolloutEnd]);
  const { dates, rows } = model;
  const [playing, play] = useState(false);
  // While the user holds the cursor, playback waits; on release it continues from the released date.
  const [scrubbing, scrub] = useState(false);
  const [selected, select] = useState('');
  const first = dates[0]!, end = dates.at(-1)!;
  const at = date < first ? first : date > end ? end : date;
  useEffect(() => {
    if (!playing || scrubbing) return;
    if (at >= end) { play(false); return; }
    const timer = setTimeout(() => setDate(playStep(first, end, at)), 250);
    return () => clearTimeout(timer);
  }, [playing, scrubbing, at, first, end, setDate]);
  useEffect(() => {
    if (!scrubbing) return;
    const release = () => scrub(false);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
  }, [scrubbing]);
  const pointTo = (e: PointerEvent<SVGSVGElement>) => {
    const m = e.currentTarget.getScreenCTM();
    if (!m) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    setDate(dateAt(first, end, (p.x - 8) / 584));
  };
  const jump = (label: 'ck.sim.goImproves' | 'ck.sim.goReaches' | 'ck.sim.goDeadline', target: string | null | undefined) => target && target >= first && target <= end
    ? <Button size="small" onClick={() => setDate(target)}>{t(label, { date: target })}</Button> : null;
  const row = rows.find(r => r.k.id === selected) ?? rows[0];
  const def = kpis.find(k => k.id === row?.k.id);
  const x = (date: string) => 8 + 584 * (dayOf(date) - dayOf(first)) / (dayOf(end) - dayOf(first));
  const objectives = useMemo(() => ctx.kpi.okrs.filter(o => visible(o.id) && o.keyResults.every(kr => visible(kr.kpiId))).map(o =>
    ({ o, baseline: okrPct(o, kpis), trajectory: objectiveTrajectory(o, model) })), [ctx, visible, kpis, model]);
  const active = initiatives.filter(e => at >= e.start && e.end >= at);
  const required = (date: string) => !def ? 0 : (def.target - def.current) * (def.target - def.baseline) <= 0 ? def.current : def.current + (def.target - def.current) * realisedShare(ctx.today, def.deadline, date);
  const values = row ? dates.map(row.modeled ? row.value : required) : [];
  const lo = Math.min(...values, row?.k.target ?? 0), hi = Math.max(...values, row?.k.target ?? 0);
  const y = (v: number) => hi === lo ? 50 : 92 - 84 * (v - lo) / (hi - lo);
  return <>
    <Panel title={t('ck.sim.time')} testId="sim-time" className="span-full">
      <p>{t('ck.sim.method')}</p>
      <div className="proj-form-row">
        <Button onClick={() => { if (at === end) setDate(first); play(!playing); }}>{t(playing ? 'ck.sim.pause' : 'ck.sim.play')}</Button>
        <Field className="grow" label={t('ck.sim.at', { date: at })} hint={t('ck.sim.drag')} onPointerDownCapture={() => scrub(true)}>
          <Slider min={dayOf(first)} max={dayOf(end)} step={1} value={dayOf(at)} aria-valuetext={at} data-testid="sim-date" onChange={(_, d) => setDate(dateOf(d.value))} />
        </Field>
      </div>
      <details>
        <summary>{t('ck.sim.work', { n: active.length, names: active.map(e => loc(e.name, lang)).join(' · ') || '—' })}</summary>
        <ul>{initiatives.map(e => <li key={e.id}>{loc(e.name, lang)}{' · '}{`${e.start} → ${e.end}`} {' '}
          <progress aria-label={t('ck.sim.schedule', { name: loc(e.name, lang) })} value={at >= e.end ? 1 : realisedShare(e.start, e.end, at)} max={1} />
        </li>)}</ul>
      </details>
      {def && row && <>
        <Field label={t('ck.kpi.col.kpi')}><Select value={def.id} onChange={(_, d) => select(d.value)}>
          {kpis.map(k => <option key={k.id} value={k.id}>{loc(k.name, lang)}</option>)}
        </Select></Field>
        <p><strong>{t('ck.sim.values', { base: fmt.number(def.current), value: row.modeled ? fmt.number(row.value(at)) : '—', target: fmt.number(def.target), unit: loc(def.unit, lang) })}</strong></p>
        {(row.modeled || def.deadline > ctx.today) && <>
          <svg width="100%" height="160" viewBox="-55 -8 655 130" role="img" aria-label={t(row.modeled ? 'ck.sim.legend' : 'ck.sim.required')}
            data-testid="sim-chart" className="sim-chart" data-scrubbing={scrubbing || undefined}
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); scrub(true); pointTo(e); }}
            onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) pointTo(e); }}>
            <g fill="currentColor" fontSize="11">
              <text x="4" y={y(hi) + 4} textAnchor="end">{fmt.number(hi)}</text>
              {lo !== hi && <text x="4" y={y(lo) + 4} textAnchor="end">{fmt.number(lo)}</text>}
              <text x="8" y="115">{first}</text><text x="592" y="115" textAnchor="end">{end}</text>
            </g>
            <line x1="8" x2="592" y1={y(def.current)} y2={y(def.current)} stroke="currentColor" strokeDasharray="2 5" />
            <line x1="8" x2="592" y1={y(def.target)} y2={y(def.target)} stroke="currentColor" strokeDasharray="9 5" />
            <polyline points={dates.map((date,j) => `${x(date)},${y(values[j]!)}`).join(' ')} fill="none" stroke="var(--colorBrandForeground1)" strokeWidth="3" />
            {[row.improves, row.reaches, def.deadline].filter(d => d && d >= first && d <= end).map((d, i) =>
              <path key={i} d={`M${x(d!)} 100 l-4 7 h8 z`} fill="currentColor" opacity="0.6" />)}
            <rect x="8" y="-8" width="584" height="116" fill="transparent" />
            <line x1={x(at)} x2={x(at)} y1="0" y2="100" stroke="currentColor" />
            <circle cx={x(at)} cy={y(row.modeled ? row.value(at) : required(at))} r="5" fill="var(--colorBrandForeground1)" />
            <rect className="sim-handle" x={x(at) - 6} y="-7" width="12" height="14" rx="3" fill="var(--colorBrandBackground)" stroke="var(--colorNeutralForegroundOnBrand)" />
          </svg>
          <p>{`${first} → ${end} · ${t(row.modeled ? 'ck.sim.legend' : 'ck.sim.required')}`}</p>
          <p className="proj-form-row">{jump('ck.sim.goImproves', row.improves)}{jump('ck.sim.goReaches', row.reaches)}{jump('ck.sim.goDeadline', def.deadline)}</p>
        </>}
        {row.modeled ? <p>{t('ck.sim.milestones', { improves: row.improves ?? t('ck.sim.never'), reaches: row.reaches ?? t('ck.sim.never'), deadline: def.deadline })}</p>
          : <p>{t('ck.sim.noEstimate')}{def.deadline > ctx.today && ` · ${at}: ${fmt.number(required(at))} ${loc(def.unit, lang)}`}</p>}
        {row.modeled && <details><summary>{t('ck.sim.drivers')}</summary>
          <ul>{row.effects.map(c => {
            const input = ctx.strategy.contributions.find(s => s.id === c.id)!;
            return <li key={c.id}>{input.lever}{' · '}{`${c.rampStart} → ${c.fullEffect}`} {' · '}
              {t('ck.sim.share', { pct: fmt.percent(realisedShare(c.rampStart, c.fullEffect, at)) })}</li>;
          })}</ul>
        </details>}
      </>}
      {!def && <p>{t('ck.kpi.empty')}</p>}
      {model.skipped > 0 && <p>{t('ck.sim.skipped', { n: model.skipped })}</p>}
      {objectives.map(({ o, baseline, trajectory }) => {
        const progress = trajectory?.value(at);
        return <section key={o.id}>
          <h3>{loc(o.objective, lang)}</h3>
          <p>{baseline !== null && t('ck.sim.okrBase', { pct: fmt.percent(baseline / 100) })}{' · '}
            {progress === undefined ? t('ck.sim.noEstimate') : t('ck.sim.okr', { pct: fmt.percent(progress / 100) })} {' '}
            {progress !== undefined && <progress aria-label={loc(o.objective, lang)} value={progress} max={100} />}</p>
          {trajectory && <p>{t('ck.sim.okrDates', { improves: trajectory.improves ?? t('ck.sim.never'), reaches: trajectory.reaches ?? t('ck.sim.never') })}</p>}
        </section>;
      })}
      {children && <Field label={t('ck.sim.rollout', { n: months, start: ctx.today, end: rolloutEnd })}>
        <Slider min={1} max={12} step={1} value={months} onChange={(_, d) => setMonths(d.value)} />
      </Field>}
    </Panel>
    {children?.(at, realisedShare(ctx.today, rolloutEnd, at))}
  </>;
}
