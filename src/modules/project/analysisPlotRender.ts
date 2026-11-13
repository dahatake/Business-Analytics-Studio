import * as d3 from 'd3';
import type { PlotDot, PlotLayout, PlotRow } from './analysisPlot.ts';

export type DotMark = 'selected' | 'related-same' | 'related-near' | 'dimmed' | null;

export interface DotPaint {
  mark: (dot: PlotDot) => DotMark;
  label: (dot: PlotDot) => string;
  /** The dot that takes the single tab stop (roving tabindex). */
  tabStop: string | null;
}

export interface DotEvents {
  select: (itemId: string) => void;
  hover: (itemId: string | null) => void;
}

const DOT = 'circle.proj-plot-dot:not(.exiting)';
const MEAN = 'line.proj-plot-mean:not(.exiting)';

/**
 * d3 data join keyed by item id (object constancy): new items grow in, edited items glide to their new
 * score, removed items shrink out. `ms` is 0 when motion is reduced.
 */
export function joinDots(svg: SVGSVGElement, layout: PlotLayout, ms: number, events: DotEvents) {
  const root = d3.select(svg);
  const ease = d3.easeCubicOut;
  const animate = ms > 0;
  root.select('g.proj-plot-dots').selectAll<SVGCircleElement, PlotDot>(DOT)
    .data(layout.dots, (d) => d.itemId)
    .join(
      (enter) => {
        const e = enter.append('circle')
          .attr('class', 'proj-plot-dot')
          .attr('role', 'button')
          .attr('data-item-id', (d) => d.itemId)
          .attr('data-testid', (d) => `proj-plot-dot-${d.itemId}`)
          .attr('data-category', (d) => d.category)
          .attr('cx', (d) => d.x)
          .attr('cy', (d) => d.y)
          .attr('r', animate ? 0 : (d) => d.r)
          .on('click', (_, d) => events.select(d.itemId))
          .on('pointerenter', (_, d) => events.hover(d.itemId))
          .on('pointerleave', () => events.hover(null))
          .on('focus', (_, d) => events.hover(d.itemId))
          .on('blur', () => events.hover(null));
        if (animate) e.transition('move').delay((_, k) => Math.min(k * 18, 240)).duration(ms).ease(d3.easeBackOut.overshoot(1.6)).attr('r', (d) => d.r);
        return e;
      },
      (update) => {
        const u = animate ? update.transition('move').duration(ms).ease(ease) : update.interrupt('move');
        (u as typeof update).attr('cx', (d) => d.x).attr('cy', (d) => d.y).attr('r', (d) => d.r);
        return update;
      },
      (exit) => {
        exit.classed('exiting', true).attr('tabindex', null).attr('aria-hidden', 'true');
        if (animate) exit.transition('move').duration(ms).attr('r', 0).remove();
        else exit.remove();
        return exit;
      },
    )
    .attr('data-score', (d) => d.score);

  const span = (d: PlotRow) => [d.y0 + 3, d.y1 - 3] as const;
  const mid = (d: PlotRow) => (d.y0 + d.y1) / 2;
  root.select('g.proj-plot-means').selectAll<SVGLineElement, PlotRow>(MEAN)
    .data(layout.rows.filter((r) => r.meanX !== null), (d) => d.id)
    .join(
      (enter) => {
        const e = enter.append('line').attr('class', 'proj-plot-mean')
          .attr('x1', (d) => d.meanX!).attr('x2', (d) => d.meanX!)
          .attr('y1', (d) => (animate ? mid(d) : span(d)[0])).attr('y2', (d) => (animate ? mid(d) : span(d)[1]));
        if (animate) e.transition('move').duration(ms).ease(ease).attr('y1', (d) => span(d)[0]).attr('y2', (d) => span(d)[1]);
        return e;
      },
      (update) => {
        const u = animate ? update.transition('move').duration(ms).ease(ease) : update.interrupt('move');
        (u as typeof update).attr('x1', (d) => d.meanX!).attr('x2', (d) => d.meanX!).attr('y1', (d) => span(d)[0]).attr('y2', (d) => span(d)[1]);
        return update;
      },
      (exit) => {
        exit.classed('exiting', true);
        if (animate) exit.transition('move').duration(ms).attr('y1', mid).attr('y2', mid).remove();
        else exit.remove();
        return exit;
      },
    );
}

/** Selection state only: classes, pressed state, names and the tab stop. No geometry, so no transition is interrupted. */
export function paintDots(svg: SVGSVGElement, paint: DotPaint) {
  d3.select(svg).selectAll<SVGCircleElement, PlotDot>(DOT)
    .attr('class', (d) => {
      const m = paint.mark(d);
      return `proj-plot-dot${d.weight > 0 ? '' : ' is-ignored'}${m ? ` is-${m}` : ''}`;
    })
    .attr('aria-pressed', (d) => String(paint.mark(d) === 'selected'))
    .attr('aria-label', (d) => paint.label(d))
    .attr('tabindex', (d) => (d.itemId === paint.tabStop ? 0 : -1));
}

/** Arrow-key navigation over the dots: ←/→ along a row by score, ↑/↓ to the nearest dot in the next row with dots. */
export function nextDot(layout: PlotLayout, from: string, key: string): string | null {
  const rows = layout.rows.map((r) => layout.dots.filter((d) => d.category === r.id).sort((a, b) => a.x - b.x || a.y - b.y)).filter((r) => r.length);
  const flat = rows.flat();
  if (key === 'Home') return flat[0]?.itemId ?? null;
  if (key === 'End') return flat.at(-1)?.itemId ?? null;
  const ri = rows.findIndex((r) => r.some((d) => d.itemId === from));
  if (ri < 0) return flat[0]?.itemId ?? null;
  const row = rows[ri]!;
  const ci = row.findIndex((d) => d.itemId === from);
  const cur = row[ci]!;
  if (key === 'ArrowRight') return row[ci + 1]?.itemId ?? null;
  if (key === 'ArrowLeft') return row[ci - 1]?.itemId ?? null;
  const target = key === 'ArrowDown' ? rows[ri + 1] : key === 'ArrowUp' ? rows[ri - 1] : undefined;
  if (!target) return null;
  return target.reduce((best, d) => (Math.abs(d.x - cur.x) < Math.abs(best.x - cur.x) ? d : best)).itemId;
}

export interface BarTarget {
  id: string;
  /** Width of the whole-category bar. */
  w: number;
  /** Width of the cross-highlighted part (0 when nothing of the category is highlighted). */
  hlW: number;
  /** x of the value label. */
  textX: number;
}

/** Bars grow and shrink to their value with a d3 transition; the highlighted overlay follows the selection. */
export function animateBars(svg: SVGSVGElement, bars: readonly BarTarget[], ms: number) {
  const root = d3.select(svg);
  for (const b of bars) {
    const row = root.select(`[data-cat="${b.id}"]`);
    const parts = [
      [row.select<SVGElement>('rect.proj-chart-bar'), 'width', b.w],
      [row.select<SVGElement>('rect.proj-chart-hl'), 'width', b.hlW],
      [row.select<SVGElement>('text.proj-chart-value'), 'x', b.textX],
    ] as const;
    for (const [sel, attr, v] of parts) {
      if (sel.empty()) continue;
      if (sel.attr(attr) === null) sel.attr(attr, attr === 'width' ? 0 : v);
      if (ms > 0) sel.transition('bar').duration(ms).ease(d3.easeCubicOut).attr(attr, v);
      else sel.interrupt('bar').attr(attr, v);
    }
  }
}
