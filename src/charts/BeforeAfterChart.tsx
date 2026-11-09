import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion, motionMs } from '../state/motion.ts';

export interface Comparison {
  id: string;
  label: string;
  unit: string;
  before: number;
  after: number;
  /** true when a lower value is better. */
  lowerIsBetter: boolean;
  format: (v: number) => string;
}

/**
 * F-3.3.4: one panel per metric; before and after share the same zero-based axis and unit,
 * so bar length is directly comparable. Exact values are printed on the bars and in the table.
 */
export function BeforeAfterChart({ metric }: { metric: Comparison }) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const { t, fmt } = useI18n();
  const width = 300, height = 190, m = { top: 16, right: 12, bottom: 34, left: 56 };

  useEffect(() => {
    const svg = d3.select(ref.current);
    const data = [
      { key: 'before', label: t('compare.before'), value: metric.before },
      { key: 'after', label: t('compare.after'), value: metric.after },
    ];
    const x = d3.scaleBand().domain(data.map((d) => d.key)).range([m.left, width - m.right]).padding(0.35);
    const y = d3.scaleLinear().domain([0, (d3.max(data, (d) => d.value) ?? 1) * 1.15]).nice().range([height - m.bottom, m.top]);
    svg.select<SVGGElement>('g.y').attr('transform', `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat((v) => metric.format(Number(v))));
    svg.select<SVGGElement>('g.x').attr('transform', `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).tickFormat((k) => data.find((d) => d.key === k)!.label).tickSizeOuter(0));
    const improved = metric.lowerIsBetter ? metric.after < metric.before : metric.after > metric.before;
    const bars = svg.select('g.bars').selectAll<SVGRectElement, (typeof data)[number]>('rect').data(data, (d) => d.key);
    bars.join('rect')
      .attr('class', (d) => `bar bar-${d.key} ${d.key === 'after' ? (improved ? 'better' : 'worse') : ''}`)
      .attr('x', (d) => x(d.key)!)
      .attr('width', x.bandwidth())
      .attr('rx', 4)
      .transition().duration(motionMs(reduced, 800)).ease(d3.easeCubicOut)
      .attr('y', (d) => y(d.value))
      .attr('height', (d) => y(0) - y(d.value));
    svg.select('g.values').selectAll<SVGTextElement, (typeof data)[number]>('text').data(data, (d) => d.key)
      .join('text')
      .attr('x', (d) => x(d.key)! + x.bandwidth() / 2)
      .attr('y', (d) => y(d.value) - 6)
      .attr('text-anchor', 'middle')
      .text((d) => metric.format(d.value));
  }, [metric, reduced, t]);

  const delta = metric.after - metric.before;
  const deltaPct = metric.before === 0 ? 0 : delta / metric.before;
  return (
    <figure className="compare-figure" data-metric={metric.id}>
      <figcaption>
        <span className="compare-title">{metric.label}</span>
        <span className="compare-unit">{t('compare.unit', { unit: metric.unit })}</span>
      </figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('compare.aria', { metric: metric.label, before: metric.format(metric.before), after: metric.format(metric.after), unit: metric.unit })}
      >
        <g className="y axis" />
        <g className="x axis" />
        <g className="bars" />
        <g className="values" />
      </svg>
      <p className="compare-delta">
        {t('compare.delta', { delta: `${delta > 0 ? '+' : ''}${metric.format(delta)}`, pct: `${deltaPct > 0 ? '+' : ''}${fmt.percent(deltaPct)}` })}
        {' · '}
        {metric.lowerIsBetter ? t('direction.decrease') : t('direction.increase')}
      </p>
    </figure>
  );
}
