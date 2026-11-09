import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { Entity } from '../data/schema.ts';
import type { Edge } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion } from '../state/motion.ts';
import { attachCardTrigger } from '../ui/cardController.ts';
import { kindColor, kindShape } from '../ui/icons.ts';

interface Node extends d3.SimulationNodeDatum { id: string; e: Entity; depth: number }
interface Link extends d3.SimulationLinkDatum<Node> { edge: Edge }

const SHAPES: Record<string, d3.SymbolType> = {
  circle: d3.symbolCircle, square: d3.symbolSquare, diamond: d3.symbolDiamond, triangle: d3.symbolTriangle, hexagon: d3.symbolStar,
};

/** Ego network around `focus` (PARAM-014 hops). Click/Enter selects a node as the new focus; drill-through lives in the card. */
export function ForceGraph({ entities, edges, focus, depthOf, onSelect }: {
  entities: Entity[];
  edges: Edge[];
  focus: string;
  depthOf: Map<string, number>;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const { t, tx } = useI18n();
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    const svg = d3.select(ref.current!);
    const W = 900, H = 560;
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const root = svg.select<SVGGElement>('g.viewport');
    root.selectAll('*').remove();

    const nodes: Node[] = entities.map((e) => ({ id: e.id, e, depth: depthOf.get(e.id) ?? 0, ...(e.id === focus ? { fx: W / 2, fy: H / 2 } : {}) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((edge) => ({ source: edge.source, target: edge.target, edge }));

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink<Node, Link>(links).id((d) => d.id).distance(110).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-420))
      .force('radial', d3.forceRadial<Node>((d) => d.depth * 150, W / 2, H / 2).strength(0.5))
      .force('collide', d3.forceCollide(34));

    const linkSel = root.append('g').attr('class', 'graph-links').selectAll('g').data(links).join('g').attr('class', 'graph-link');
    linkSel.append('line');
    const linkLabel = linkSel.append('text').attr('class', 'graph-link-label').attr('text-anchor', 'middle').text((d) => t(`relation.${d.edge.type}`));

    const nodeSel = root.append('g').attr('class', 'graph-nodes').selectAll<SVGGElement, Node>('g').data(nodes, (d) => d.id).join('g')
      .attr('class', (d) => `graph-node ${d.id === focus ? 'focus' : ''}`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-pressed', (d) => String(d.id === focus))
      .attr('data-entity-ref', (d) => d.id)
      .attr('aria-label', (d) => `${t(`kind.${d.e.kind}`)}: ${tx(d.e.name)}`);
    nodeSel.append('path')
      .attr('d', (d) => d3.symbol(SHAPES[kindShape[d.e.kind]]!, d.id === focus ? 900 : 480)())
      .attr('fill', (d) => kindColor[d.e.kind]);
    nodeSel.append('text').attr('class', 'graph-node-label').attr('dy', 30).attr('text-anchor', 'middle').text((d) => tx(d.e.name));

    const detach: (() => void)[] = [];
    nodeSel.each(function (d) { detach.push(attachCardTrigger(this, d.id, () => selectRef.current(d.id))); });

    nodeSel.call(d3.drag<SVGGElement, Node>()
      .on('start', (ev, d) => { if (!ev.active && !reduced) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; if (reduced) render(); })
      .on('end', (ev, d) => { if (!ev.active) sim.alphaTarget(0); if (d.id !== focus) { d.fx = null; d.fy = null; } }));

    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.4, 3]).on('zoom', (ev) => root.attr('transform', ev.transform.toString()));
    svg.call(zoom).on('dblclick.zoom', null);

    function render() {
      linkSel.select('line')
        .attr('x1', (d) => (d.source as Node).x!).attr('y1', (d) => (d.source as Node).y!)
        .attr('x2', (d) => (d.target as Node).x!).attr('y2', (d) => (d.target as Node).y!);
      linkLabel.attr('x', (d) => ((d.source as Node).x! + (d.target as Node).x!) / 2).attr('y', (d) => ((d.source as Node).y! + (d.target as Node).y!) / 2 - 4);
      nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    }

    if (reduced) {
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      render();
    } else {
      sim.on('tick', render);
    }
    return () => {
      sim.stop();
      detach.forEach((f) => f());
    };
  }, [entities, edges, focus, depthOf, reduced, t, tx]);

  return (
    <svg ref={ref} className="force-graph" role="group" aria-label={t('relations.graphAria')}>
      <g className="viewport" />
    </svg>
  );
}
