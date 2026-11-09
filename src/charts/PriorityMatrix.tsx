import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { EntityOf } from '../data/schema.ts';
import { entitiesOf } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion, motionMs } from '../state/motion.ts';
import { hrefFor, navigate } from '../state/router.ts';
import { attachCardTrigger } from '../ui/cardController.ts';
import type { RankedIssue } from '../domain/priority.ts';

/** 2×2 impact × feasibility (§7 executive default). Bubble area = annual benefit of linked solutions. */
export function PriorityMatrix({ ranked }: { ranked: RankedIssue[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const { t, tx, fmt } = useI18n();
  const W = 420, H = 320, m = { top: 18, right: 18, bottom: 44, left: 52 };

  useEffect(() => {
    const svg = d3.select(ref.current);
    const x = d3.scaleLinear().domain([0.5, 5.5]).range([m.left, W - m.right]);
    const y = d3.scaleLinear().domain([0.5, 5.5]).range([H - m.bottom, m.top]);
    const benefit = (issue: EntityOf<'issue'>) => entitiesOf('solution').filter((s) => s.issueIds.includes(issue.id)).reduce((a, s) => a + s.annualBenefitJpy, 0);
    const r = d3.scaleSqrt().domain([0, d3.max(ranked, (d) => benefit(d.issue)) || 1]).range([8, 26]);

    svg.select<SVGGElement>('g.x').attr('transform', `translate(0,${H - m.bottom})`).call(d3.axisBottom(x).ticks(5).tickFormat(d3.format('d')));
    svg.select<SVGGElement>('g.y').attr('transform', `translate(${m.left},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d3.format('d')));
    svg.select('text.x-label').attr('x', (m.left + W - m.right) / 2).attr('y', H - 8).text(t('priority.feasibility'));
    svg.select('text.y-label').attr('transform', `translate(14,${(m.top + H - m.bottom) / 2}) rotate(-90)`).text(t('priority.impact'));
    svg.select('line.vmid').attr('x1', x(3)).attr('x2', x(3)).attr('y1', m.top).attr('y2', H - m.bottom);
    svg.select('line.hmid').attr('x1', m.left).attr('x2', W - m.right).attr('y1', y(3)).attr('y2', y(3));
    const quadrants = [
      { key: 'priority.q.quickWin', x: x(5.4), y: y(5.4), anchor: 'end' },
      { key: 'priority.q.strategic', x: x(0.6), y: y(5.4), anchor: 'start' },
      { key: 'priority.q.fillIn', x: x(5.4), y: y(0.75), anchor: 'end' },
      { key: 'priority.q.deprioritize', x: x(0.6), y: y(0.75), anchor: 'start' },
    ] as const;
    svg.select('g.quadrants').selectAll('text').data(quadrants).join('text')
      .attr('x', (d) => d.x).attr('y', (d) => d.y + 12).attr('text-anchor', (d) => d.anchor).text((d) => t(d.key));

    const detach: (() => void)[] = [];
    const g = svg.select('g.points').selectAll<SVGGElement, RankedIssue>('g.point').data(ranked, (d) => d.issue.id)
      .join((enter) => {
        const gg = enter.append('g').attr('class', 'point').attr('tabindex', 0).attr('role', 'link');
        gg.append('circle');
        gg.append('text').attr('class', 'rank').attr('text-anchor', 'middle').attr('dy', '0.35em');
        return gg;
      });
    g.attr('aria-label', (d) => t('priority.pointAria', { name: tx(d.issue.name), rank: d.rank, score: d.score, impact: d.issue.impact, feasibility: d.issue.feasibility }))
      .attr('data-entity-ref', (d) => d.issue.id)
      .transition().duration(motionMs(reduced, 600))
      .attr('transform', (d) => `translate(${x(d.issue.feasibility)},${y(d.issue.impact)})`);
    g.select('circle').attr('r', (d) => r(benefit(d.issue))).attr('class', (d) => `rank-${Math.min(d.rank, 3)}`);
    g.select('text.rank').text((d) => d.rank);
    g.each(function (d) {
      detach.push(attachCardTrigger(this, d.issue.id, () => navigate(hrefFor(`/entity/${d.issue.id}`))));
    });
    return () => detach.forEach((f) => f());
  }, [ranked, reduced, t, tx, fmt]);

  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="priority-matrix" role="group" aria-label={t('priority.matrixAria')}>
      <g className="quadrants" />
      <line className="vmid" />
      <line className="hmid" />
      <g className="x axis" />
      <g className="y axis" />
      <text className="x-label axis-label" textAnchor="middle" />
      <text className="y-label axis-label" textAnchor="middle" />
      <g className="points" />
    </svg>
  );
}
