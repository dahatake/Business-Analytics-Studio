import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { sankey, sankeyLinkHorizontal, sankeyJustify, type SankeyNode, type SankeyLink } from 'd3-sankey';
import { getEntity, loaded, regionName } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion, motionMs } from '../state/motion.ts';
import { attachCardTrigger } from '../ui/cardController.ts';
import { kindColor } from '../ui/icons.ts';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { hrefFor, navigate } from '../state/router.ts';

interface N { id: string; label: string; color: string; isEntity: boolean }
interface L { source: string; target: string; value: number }

const W = 960, H = 520;

export function Flows() {
  const { t, tx, fmt } = useI18n();
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);

  const graph = useMemo(() => {
    const ids = [...new Set(loaded.pack.flows.flatMap((f) => [f.source, f.target]))];
    const nodes: N[] = ids.map((id) => {
      const e = getEntity(id);
      if (e) return { id, label: tx(e.name), color: kindColor[e.kind], isEntity: true };
      const r = regionName(id);
      return { id, label: r ? tx(r) : id, color: '#C9D1D9', isEntity: false };
    });
    const links: L[] = loaded.pack.flows.map((f) => ({ source: f.source, target: f.target, value: f.valueT }));
    return { nodes, links };
  }, [tx]);

  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    // A pack without flows (e.g. imported or generated from customer material) has nothing to lay out.
    if (graph.nodes.length === 0) return;
    const layout = sankey<N, L>().nodeId((d) => d.id).nodeAlign(sankeyJustify).nodeWidth(16).nodePadding(18).extent([[8, 28], [W - 8, H - 8]]);
    const { nodes, links } = layout({ nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) });

    const lastX = d3.max(nodes, (n) => n.x0!) ?? 0;
    const isLast = (n: SankeyNode<N, L>) => n.x0! >= lastX - 1;
    const stages = [t('flows.stage.supplier'), t('flows.stage.plant'), t('flows.stage.dc'), t('flows.stage.region')];
    const xs = [...new Set(nodes.map((n) => n.x0!))].sort((a, b) => a - b);
    svg.select('g.stages').selectAll('text').data(xs).join('text')
      .attr('x', (x, i) => (i === xs.length - 1 ? x + 16 : x)).attr('y', 16)
      .attr('text-anchor', (_, i) => (i === xs.length - 1 ? 'end' : 'start'))
      .text((_, i) => stages[i] ?? '');

    const linkSel = svg.select('g.links').selectAll<SVGPathElement, SankeyLink<N, L>>('path').data(links).join('path')
      .attr('class', 'sankey-link')
      .attr('d', sankeyLinkHorizontal())
      .attr('stroke', (d) => (d.source as SankeyNode<N, L>).color)
      .attr('stroke-width', (d) => Math.max(1, d.width ?? 1));
    linkSel.selectAll('title').data((d) => [d]).join('title')
      .text((d) => t('flows.linkTitle', { from: (d.source as N).label, to: (d.target as N).label, value: fmt.integer(d.value) }));
    linkSel.attr('stroke-dasharray', function () { const len = this.getTotalLength(); return `${len} ${len}`; })
      .attr('stroke-dashoffset', function () { return this.getTotalLength(); })
      .transition().duration(motionMs(reduced, 1200)).delay((_, i) => (reduced ? 0 : i * 40)).ease(d3.easeCubicInOut)
      .attr('stroke-dashoffset', 0);

    const nodeSel = svg.select('g.nodes').selectAll<SVGGElement, SankeyNode<N, L>>('g').data(nodes, (d) => d.id).join((enter) => {
      const g = enter.append('g');
      g.append('rect');
      g.append('text');
      return g;
    });
    nodeSel.attr('class', (d) => `sankey-node ${d.isEntity ? 'is-entity' : ''}`)
      .attr('data-entity-ref', (d) => (d.isEntity ? d.id : null))
      .attr('tabindex', (d) => (d.isEntity ? 0 : null))
      .attr('role', (d) => (d.isEntity ? 'link' : 'img'))
      .attr('aria-label', (d) => t('flows.nodeAria', { name: d.label, value: fmt.integer(d.value ?? 0) }))
      .on('pointerenter.hl', (_, d) => setHover(d.id))
      .on('pointerleave.hl', () => setHover(null))
      .on('focus.hl', (_, d) => setHover(d.id))
      .on('blur.hl', () => setHover(null));
    nodeSel.select('rect').attr('x', (d) => d.x0!).attr('y', (d) => d.y0!).attr('width', (d) => d.x1! - d.x0!).attr('height', (d) => Math.max(2, d.y1! - d.y0!)).attr('rx', 3).attr('fill', (d) => d.color);
    nodeSel.select('text')
      .attr('x', (d) => (isLast(d) ? d.x0! - 8 : d.x1! + 8)).attr('y', (d) => (d.y0! + d.y1!) / 2).attr('dy', '0.35em')
      .attr('text-anchor', (d) => (isLast(d) ? 'end' : 'start'))
      .text((d) => `${d.label} · ${fmt.integer(d.value ?? 0)} t`);
    const detach: (() => void)[] = [];
    nodeSel.filter((d) => d.isEntity).each(function (d) { detach.push(attachCardTrigger(this, d.id, () => navigate(hrefFor(`/entity/${d.id}`)))); });
    return () => detach.forEach((f) => f());
  }, [graph, reduced, t, fmt]);

  useEffect(() => {
    d3.select(svgRef.current!).select('g.links').selectAll<SVGPathElement, SankeyLink<N, L>>('path')
      .classed('dim', (d) => hover !== null && (d.source as N).id !== hover && (d.target as N).id !== hover)
      .classed('on', (d) => hover !== null && ((d.source as N).id === hover || (d.target as N).id === hover));
  }, [hover]);

  const total = d3.sum(loaded.pack.flows.filter((f) => getEntity(f.source)?.kind === 'supplier'), (f) => f.valueT);

  return (
    <div className="screen screen-flows">
      <PageHeader title={t('flows.title')} subtitle={t('flows.subtitle', { total: fmt.integer(total) })} />
      <Panel title={t('flows.panel')} rationale="visual.sankey" testId="sankey-panel">
        {graph.nodes.length === 0 && <p className="muted" data-testid="flows-empty">{t('flows.empty')}</p>}
        <div className="chart-scroll" hidden={graph.nodes.length === 0}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="sankey" role="group" aria-label={t('flows.aria')} style={{ minWidth: 760 }}>
            <g className="stages axis-label" />
            <g className="links" />
            <g className="nodes" />
          </svg>
        </div>
      </Panel>
      <Panel title={t('flows.tableTitle')} rationale="visual.flowTable">
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th scope="col">{t('relations.col.from')}</th><th scope="col">{t('relations.col.to')}</th><th scope="col" className="num">{t('flows.volume')}</th></tr></thead>
            <tbody>
              {loaded.pack.flows.map((f) => (
                <tr key={`${f.source}-${f.target}`}>
                  <td>{getEntity(f.source) ? <EntityRef id={f.source} /> : tx(regionName(f.source)!)}</td>
                  <td>{getEntity(f.target) ? <EntityRef id={f.target} /> : tx(regionName(f.target)!)}</td>
                  <td className="num">{t('unit.tPerMonth', { value: fmt.integer(f.valueT) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

