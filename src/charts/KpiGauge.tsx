import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { ArrowDown16Regular, ArrowUp16Regular, Info16Regular } from '@fluentui/react-icons';
import type { EntityOf } from '../data/schema.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion, motionMs } from '../state/motion.ts';
import { chooseKpiVisual, kpiProgress, kpiStatus } from '../domain/kpi.ts';
import { EntityRef } from '../ui/EntityRef.tsx';

type Kpi = EntityOf<'kpi'>;

const STATUS_COLOR = { achieved: '#6CCB5F', progressing: '#62ABF5', regressed: '#F87C7C' } as const;

function Ring({ kpi, label }: { kpi: Kpi; label: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const progress = kpiProgress(kpi);
  const status = kpiStatus(kpi);
  useEffect(() => {
    const svg = d3.select(ref.current);
    const arc = d3.arc<{ end: number }>().innerRadius(38).outerRadius(48).cornerRadius(5).startAngle(0).endAngle((d) => d.end);
    const clamped = Math.max(0, Math.min(1, progress));
    const path = svg.select<SVGPathElement>('path.value');
    const previous = (path.datum() as { end: number } | undefined)?.end ?? 0;
    path.datum({ end: clamped * Math.PI * 2 })
      .transition().duration(motionMs(reduced, 1100)).ease(d3.easeCubicOut)
      .attrTween('d', (d) => {
        const i = d3.interpolate(previous, d.end);
        return (t) => arc({ end: i(t) }) ?? '';
      });
  }, [progress, reduced]);
  return (
    <svg ref={ref} viewBox="-55 -55 110 110" className="kpi-ring" role="img" aria-label={label}>
      <circle r="43" fill="none" className="kpi-ring-track" strokeWidth="10" />
      <path className="value" fill={STATUS_COLOR[status]} />
      <text className="kpi-ring-value" textAnchor="middle" dy="2">{Number.isNaN(progress) ? '—' : `${Math.round(progress * 100)}%`}</text>
    </svg>
  );
}

function Bullet({ kpi, label }: { kpi: Kpi; label: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const { fmt } = useI18n();
  const status = kpiStatus(kpi);
  useEffect(() => {
    const svg = d3.select(ref.current);
    const values = [kpi.baseline, kpi.current, kpi.target, 0];
    const pad = (d3.max(values)! - d3.min(values)!) * 0.15 || 1;
    const x = d3.scaleLinear().domain([d3.min(values)! - pad, d3.max(values)! + pad]).range([8, 212]);
    svg.select<SVGGElement>('g.axis').attr('transform', 'translate(0,46)')
      .call(d3.axisBottom(x).ticks(5).tickFormat((v) => fmt.number(Number(v))).tickSizeOuter(0));
    svg.select('line.zero').attr('x1', x(0)).attr('x2', x(0));
    svg.select('line.target').attr('x1', x(kpi.target)).attr('x2', x(kpi.target));
    svg.select('line.baseline').attr('x1', x(kpi.baseline)).attr('x2', x(kpi.baseline));
    const lo = Math.min(kpi.baseline, kpi.current);
    const bar = svg.select<SVGRectElement>('rect.value');
    bar.attr('x', x(kpi.baseline)).attr('width', 0)
      .transition().duration(motionMs(reduced, 900)).ease(d3.easeCubicOut)
      .attr('x', x(lo)).attr('width', Math.abs(x(kpi.current) - x(kpi.baseline)));
  }, [kpi, reduced, fmt]);
  return (
    <svg ref={ref} viewBox="0 0 220 70" className="kpi-bullet" role="img" aria-label={label}>
      <rect x="8" y="16" width="204" height="22" rx="4" className="kpi-bullet-track" />
      <rect className="value" y="20" height="14" rx="3" fill={STATUS_COLOR[status]} />
      <line className="zero" y1="12" y2="42" />
      <line className="baseline" y1="14" y2="40" strokeDasharray="3 2" />
      <line className="target" y1="10" y2="44" />
      <g className="axis" />
    </svg>
  );
}

/** F-3.3.3: name, actual, target, unit and desired direction always shown next to the visual. */
export function KpiGauge({ kpi }: { kpi: Kpi }) {
  const { t, tx, fmt } = useI18n();
  const visual = chooseKpiVisual(kpi);
  const unit = tx(kpi.unit);
  const progress = kpiProgress(kpi);
  const status = kpiStatus(kpi);
  const label = t('kpi.aria', {
    name: tx(kpi.name),
    current: `${fmt.number(kpi.current)} ${unit}`,
    target: `${fmt.number(kpi.target)} ${unit}`,
    baseline: `${fmt.number(kpi.baseline)} ${unit}`,
    direction: t(`direction.${kpi.direction}`),
    progress: Number.isNaN(progress) ? '—' : fmt.percent(progress),
  });
  const DirIcon = kpi.direction === 'increase' ? ArrowUp16Regular : ArrowDown16Regular;
  return (
    <article className={`kpi-card kpi-card--${visual.kind}`} data-kpi-id={kpi.id} data-visual={visual.kind} data-status={status}>
      <div className="kpi-name"><EntityRef id={kpi.id} /></div>
      <div className="kpi-visual">{visual.kind === 'ring' ? <Ring kpi={kpi} label={label} /> : <Bullet kpi={kpi} label={label} />}</div>
      <dl className="kpi-facts">
        <div><dt>{t('field.actual')}</dt><dd className="kpi-actual">{fmt.number(kpi.current)} <span className="kpi-unit">{unit}</span></dd></div>
        <div><dt>{t('field.target')}</dt><dd>{fmt.number(kpi.target)} <span className="kpi-unit">{unit}</span></dd></div>
        <div><dt>{t('field.baseline')}</dt><dd>{fmt.number(kpi.baseline)} <span className="kpi-unit">{unit}</span></dd></div>
        <div><dt>{t('field.direction')}</dt><dd className="kpi-direction"><DirIcon aria-hidden /> {t(`direction.${kpi.direction}`)}</dd></div>
      </dl>
      <p className="kpi-status">
        <span className={`status-dot status-${status}`} aria-hidden />
        {t(`kpiStatus.${status}`)} · {t('kpi.progressNote', { progress: Number.isNaN(progress) ? '—' : fmt.percent(progress) })}
      </p>
      {visual.kind === 'bullet' && (
        <p className="kpi-reason" data-testid="kpi-reason"><Info16Regular aria-hidden /> {t(`kpi.reason.${visual.reason}`)}</p>
      )}
      <p className="kpi-period">{tx(kpi.period)}</p>
    </article>
  );
}

