import * as d3 from 'd3';
import type { Quadrant, ScoredTarget } from './analysisTargets.ts';

/** Geometry of the priority field: x = analysis support, y = data signal (high at the top). */
export const FIELD = { width: 640, height: 400, left: 52, right: 20, top: 20, bottom: 44 } as const;
const plotW = FIELD.width - FIELD.left - FIELD.right;
const plotH = FIELD.height - FIELD.top - FIELD.bottom;
export const fieldX = (supportN: number) => FIELD.left + supportN * plotW;
export const fieldY = (data: number) => FIELD.top + (1 - data) * plotH;

export interface FieldNode {
  id: string;
  rank: number;
  quadrant: Quadrant;
  /** Where the signals put it; the drawn position (x, y) is nudged apart from overlapping bubbles. */
  tx: number;
  ty: number;
  x: number;
  y: number;
  r: number;
  evidence: number;
}

/** Bubble area grows with the number of evidence items, so heavily discussed targets carry visual weight. */
export const bubbleR = (evidence: number) => 9 + 3.2 * Math.sqrt(evidence);

/**
 * Collision-free placement with d3-force, run to rest synchronously (no random start: every node starts at its
 * true position), so the same data always gives the same picture and positions stay close to the signals.
 */
export function layoutField(targets: readonly ScoredTarget[]): FieldNode[] {
  const nodes: FieldNode[] = targets.map((t) => {
    const tx = fieldX(t.supportN);
    const ty = fieldY(t.data);
    return { id: t.id, rank: t.rank, quadrant: t.quadrant, tx, ty, x: tx, y: ty, r: bubbleR(t.evidence.length), evidence: t.evidence.length };
  });
  const sim = d3.forceSimulation(nodes)
    .randomSource(d3.randomLcg(0.338))
    .force('x', d3.forceX<FieldNode>((d) => d.tx).strength(0.6))
    .force('y', d3.forceY<FieldNode>((d) => d.ty).strength(0.6))
    .force('collide', d3.forceCollide<FieldNode>((d) => d.r + 2).iterations(3))
    .stop();
  sim.tick(180);
  for (const n of nodes) {
    n.x = Math.min(FIELD.width - FIELD.right - n.r, Math.max(FIELD.left + n.r, n.x));
    n.y = Math.min(FIELD.height - FIELD.bottom - n.r, Math.max(FIELD.top + n.r, n.y));
  }
  return nodes;
}

export type BubbleMark = 'selected' | 'linked' | 'dimmed' | null;

export interface BubblePaint {
  mark: (n: FieldNode) => BubbleMark;
  label: (n: FieldNode) => string;
  tabStop: string | null;
}

export interface BubbleEvents {
  select: (id: string) => void;
  hover: (id: string | null) => void;
}

const BUBBLE = 'g.proj-tg-bubble:not(.exiting)';

/**
 * Keyed join (object constancy across steps and edits): bubbles rise from the bottom-left origin with a stagger
 * by rank, glide when signals change, and sink out when removed. `ms` is 0 when motion is reduced.
 */
export function joinBubbles(svg: SVGSVGElement, nodes: readonly FieldNode[], ms: number, events: BubbleEvents) {
  const animate = ms > 0;
  const origin = `translate(${FIELD.left},${FIELD.height - FIELD.bottom})`;
  d3.select(svg).select('g.proj-tg-bubbles').selectAll<SVGGElement, FieldNode>(BUBBLE)
    .data(nodes, (d) => d.id)
    .join(
      (enter) => {
        const g = enter.append('g')
          .attr('class', 'proj-tg-bubble')
          .attr('role', 'button')
          .attr('data-target-id', (d) => d.id)
          .attr('data-testid', (d) => `proj-tg-bubble-${d.id}`)
          .attr('data-quadrant', (d) => d.quadrant)
          .attr('transform', animate ? origin : (d) => `translate(${d.x},${d.y})`)
          .style('opacity', animate ? 0 : 1)
          .on('click', (e: MouseEvent, d) => { e.stopPropagation(); events.select(d.id); })
          .on('pointerenter', (_, d) => events.hover(d.id))
          .on('pointerleave', () => events.hover(null))
          .on('focus', (_, d) => events.hover(d.id))
          .on('blur', () => events.hover(null));
        g.append('circle').attr('class', 'proj-tg-halo').attr('r', (d) => d.r + 7);
        g.append('circle').attr('class', 'proj-tg-core').attr('r', (d) => d.r);
        g.append('text').attr('class', 'proj-tg-rank').attr('dy', '0.35em').attr('text-anchor', 'middle').attr('aria-hidden', 'true').text((d) => d.rank);
        if (animate) {
          g.transition('move').delay((d) => Math.min((d.rank - 1) * 55, 700)).duration(ms).ease(d3.easeBackOut.overshoot(1.2))
            .attr('transform', (d) => `translate(${d.x},${d.y})`).style('opacity', 1);
        }
        return g;
      },
      (update) => {
        update.attr('data-quadrant', (d) => d.quadrant);
        update.select('text.proj-tg-rank').text((d) => d.rank);
        const u = animate ? update.transition('move').duration(ms).ease(d3.easeCubicInOut) : update.interrupt('move');
        (u as typeof update).attr('transform', (d) => `translate(${d.x},${d.y})`).style('opacity', 1);
        (animate ? update.select('circle.proj-tg-core').transition('r').duration(ms) : update.select('circle.proj-tg-core')).attr('r', (d) => d.r);
        (animate ? update.select('circle.proj-tg-halo').transition('r').duration(ms) : update.select('circle.proj-tg-halo')).attr('r', (d) => d.r + 7);
        return update;
      },
      (exit) => {
        exit.classed('exiting', true).attr('tabindex', null).attr('role', null).attr('aria-hidden', 'true');
        if (animate) exit.transition('move').duration(ms / 2).style('opacity', 0).attr('transform', origin).remove();
        else exit.remove();
        return exit;
      },
    );
  d3.select(svg).select('g.proj-tg-tethers').selectAll<SVGLineElement, FieldNode>('line')
    .data(nodes.filter((n) => Math.hypot(n.x - n.tx, n.y - n.ty) > 3), (d) => d.id)
    .join('line')
    .attr('class', 'proj-tg-tether')
    .attr('x1', (d) => d.tx).attr('y1', (d) => d.ty).attr('x2', (d) => d.x).attr('y2', (d) => d.y);
}

/** Selection state only (no geometry), so running transitions are not interrupted. */
export function paintBubbles(svg: SVGSVGElement, paint: BubblePaint) {
  d3.select(svg).selectAll<SVGGElement, FieldNode>(BUBBLE)
    .attr('class', (d) => {
      const m = paint.mark(d);
      return `proj-tg-bubble q-${d.quadrant}${m ? ` is-${m}` : ''}`;
    })
    .attr('aria-pressed', (d) => String(paint.mark(d) === 'selected'))
    .attr('aria-label', (d) => paint.label(d))
    .attr('tabindex', (d) => (d.id === paint.tabStop ? 0 : -1));
}

/** Arrow keys walk the bubbles in rank order (→/↓ next, ←/↑ previous); Home/End jump to the ends. */
export function nextBubble(nodes: readonly FieldNode[], from: string, key: string): string | null {
  const order = [...nodes].sort((a, b) => a.rank - b.rank);
  if (key === 'Home') return order[0]?.id ?? null;
  if (key === 'End') return order.at(-1)?.id ?? null;
  const i = order.findIndex((n) => n.id === from);
  if (i < 0) return order[0]?.id ?? null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return order[i + 1]?.id ?? null;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return order[i - 1]?.id ?? null;
  return null;
}
