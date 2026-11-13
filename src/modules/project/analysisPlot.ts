import { forceCollide, forceSimulation, forceX, forceY, scaleLinear, scaleSqrt, type SimulationNodeDatum } from 'd3';
import { categoriesOf, categoryScore, SCORE_MAX, SCORE_MIN, WEIGHT_MAX, type CategoryId } from './analysis.ts';
import type { Analysis, AnalysisItem } from './model.ts';

/** One item of an analysis as a dot: x = score, row = category, area = weight. */
export interface PlotDot {
  itemId: string;
  category: string;
  score: number;
  weight: number;
  x: number;
  y: number;
  r: number;
}

export interface PlotRow {
  id: CategoryId;
  /** Top and bottom of the band. */
  y0: number;
  y1: number;
  /** Weighted mean score of the category (null when nothing is weighted). */
  mean: number | null;
  meanX: number | null;
}

export interface PlotLayout {
  width: number;
  height: number;
  /** Left edge of the plotting area (category labels sit before it). */
  left: number;
  right: number;
  dots: PlotDot[];
  rows: PlotRow[];
  ticks: { value: number; x: number }[];
}

export const PLOT_WIDTH = 520;
const LABEL_W = 150;
const PAD_R = 18;
const ROW_MIN = 30;
const ROW_PAD = 6;
const AXIS_H = 24;
const R_MIN = 4;
const R_MAX = 11;
const GAP = 1.5;

const clampScore = (s: number) => Math.min(SCORE_MAX, Math.max(SCORE_MIN, Number.isFinite(s) ? s : SCORE_MIN));

interface SimNode extends SimulationNodeDatum { item: AnalysisItem; tx: number; r: number }

/**
 * Beeswarm layout of the items, one band per category.
 * The force simulation is ticked synchronously, so the layout is deterministic (same input → same positions)
 * and never jitters; animation is left to the renderer.
 */
export function layoutPlot(analysis: Pick<Analysis, 'method' | 'items'>, width = PLOT_WIDTH): PlotLayout {
  const left = LABEL_W;
  const right = width - PAD_R;
  const x = scaleLinear().domain([SCORE_MIN, SCORE_MAX]).range([left + R_MAX, right - R_MAX]);
  const r = scaleSqrt().domain([0, WEIGHT_MAX]).range([R_MIN, R_MAX]).clamp(true);
  const dots: PlotDot[] = [];
  const rows: PlotRow[] = [];
  let top = 4;
  for (const cat of categoriesOf(analysis.method)) {
    const items = analysis.items.filter((i) => i.category === cat);
    // Stable order: by score then id, so ties keep their place across renders.
    const nodes: SimNode[] = items
      .map((item) => ({ item, tx: x(clampScore(item.score)), r: r(Math.max(0, item.weight)) }))
      .sort((a, b) => a.tx - b.tx || a.item.id.localeCompare(b.item.id))
      .map((n, k) => ({ ...n, x: n.tx, y: (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2 }));
    if (nodes.length > 1) {
      const sim = forceSimulation(nodes)
        .force('x', forceX<SimNode>((d) => d.tx).strength(1))
        .force('y', forceY<SimNode>(0).strength(0.08))
        .force('collide', forceCollide<SimNode>((d) => d.r + GAP).iterations(4))
        .stop();
      for (let k = 0; k < 220; k++) sim.tick();
      // Keep dots inside the plotting area; the collide force then has nothing left to fix horizontally.
      for (const n of nodes) n.x = Math.min(right - n.r, Math.max(left + n.r, n.x ?? n.tx));
    }
    const extent = nodes.reduce((m, n) => Math.max(m, Math.abs(n.y ?? 0) + n.r), 0);
    const h = Math.max(ROW_MIN, extent * 2 + ROW_PAD * 2);
    const mid = top + h / 2;
    for (const n of nodes) {
      dots.push({ itemId: n.item.id, category: cat, score: n.item.score, weight: n.item.weight, x: n.x ?? n.tx, y: mid + (n.y ?? 0), r: n.r });
    }
    const mean = categoryScore(analysis.items, cat);
    rows.push({ id: cat, y0: top, y1: top + h, mean, meanX: mean === null ? null : x(clampScore(mean)) });
    top += h;
  }
  const ticks = x.ticks(SCORE_MAX - SCORE_MIN).map((value) => ({ value, x: x(value) }));
  return { width, height: top + AXIS_H, left, right, dots, rows, ticks };
}

/**
 * Power BI-style cross-highlight value: the weighted mean of only the highlighted items of a category.
 * Null when none of them is weighted.
 */
export function highlightedScore(items: readonly AnalysisItem[], category: string, highlighted: (item: AnalysisItem) => boolean): number | null {
  return categoryScore(items.filter(highlighted), category);
}
