import { wrap } from '../../ui/textWrap.ts';
import type { StrategyLink, StrategyMap, StrategyNode } from './overviewModel.ts';
import type { DetailRow } from './strategyPortal.ts';

/**
 * FR-381: semantic zoom of the strategy map. overview = one summary block per lane (bird's-eye), items = cards with
 * two-line titles and sub-data on request, detail = full titles with every item's sub-data open.
 */
export const MAP_LEVELS = ['overview', 'items', 'detail'] as const;
export type MapLevel = (typeof MAP_LEVELS)[number];
export const LANES = ['objective', 'okr', 'kpi', 'issue', 'solution'] as const satisfies readonly StrategyNode['lane'][];
export const COL_WIDTH = 250;
export const NODE_WIDTH = 216;
export const MAP_WIDTH = COL_WIDTH * LANES.length;
export const TOP = 48;
const GAP = 20;
const TITLE_EM = 17;
const ROW_EM = 19;
const LINE = 18;
const ROW_LINE = 16;
export const TOGGLE_H = 28;
/** Above this many items the map opens on the bird's-eye view. */
export const OVERVIEW_THRESHOLD = 30;

export interface RowBox { row: DetailRow; lines: string[]; y: number; h: number }
export interface NodeBox {
  x: number; y: number; h: number;
  /** Height of the card head (title, badges, score): the part that is the item's link. */
  headH: number;
  lines: string[];
  truncated: boolean;
  rows: RowBox[];
  hasRows: boolean;
  open: boolean;
}
export interface StrategyLayout { boxes: Map<string, NodeBox>; height: number }

function clip(lines: string[], max: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false };
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1]!.trimEnd().slice(0, -1)}…`;
  return { lines: kept, truncated: true };
}

export function layoutStrategy(map: StrategyMap, opts: {
  level: Exclude<MapLevel, 'overview'>;
  details?: ReadonlyMap<string, DetailRow[]>;
  isOpen?: (id: string) => boolean;
  rowText?: (row: DetailRow) => string;
}): StrategyLayout {
  const boxes = new Map<string, NodeBox>();
  const full = opts.level === 'detail';
  let height = 130;
  LANES.forEach((lane, col) => {
    let y = TOP;
    map.nodes.filter((n) => n.lane === lane).forEach((n) => {
      const { lines, truncated } = full ? { lines: wrap(n.label, TITLE_EM), truncated: false } : clip(wrap(n.label, TITLE_EM), 2);
      const headH = Math.max(70, lines.length * LINE + 36 + (n.draft === 'changed' ? 18 : 0));
      const details = opts.details?.get(n.id) ?? [];
      const hasRows = details.length > 0;
      const open = hasRows && !!opts.isOpen?.(n.id);
      let h = headH + (hasRows ? TOGGLE_H : 0);
      const rows: RowBox[] = [];
      if (open) {
        for (const row of details) {
          const text = opts.rowText ? opts.rowText(row) : row.text;
          // Rows are never clipped: each is a link whose name is its visible text.
          const rl = wrap(text, ROW_EM);
          const rh = Math.max(1, rl.length) * ROW_LINE + 8;
          rows.push({ row, lines: rl, y: h, h: rh });
          h += rh;
        }
        h += 6;
      }
      boxes.set(n.id, { x: 12 + col * COL_WIDTH, y, h, headH, lines, truncated, rows, hasRows, open });
      y += h + GAP;
    });
    height = Math.max(height, y);
  });
  return { boxes, height };
}

/**
 * FR-381: the items on the chains through `id` — everything upstream and downstream of it, not its siblings — so
 * one item's path from objective to solution can be read on its own.
 */
export function lineage(links: readonly StrategyLink[], id: string): Set<string> {
  const out = new Set<string>([id]);
  const walk = (from: string, upstream: boolean) => {
    for (const l of links) {
      const [a, b] = upstream ? [l.target, l.source] : [l.source, l.target];
      if (a === from && !out.has(b)) { out.add(b); walk(b, upstream); }
    }
  };
  walk(id, true);
  walk(id, false);
  return out;
}

export interface LaneSummary {
  lane: StrategyNode['lane'];
  total: number;
  drafts: number;
  /** Saved items with no link at all (drafts are not counted, as in the map's own gap count). */
  unlinked: number;
  /** The first saved items in the map's priority order. */
  top: StrategyNode[];
}

export function laneSummaries(map: StrategyMap, topN = 3): LaneSummary[] {
  const linked = new Set(map.links.flatMap((l) => [l.source, l.target]));
  return LANES.map((lane) => {
    const nodes = map.nodes.filter((n) => n.lane === lane);
    const saved = nodes.filter((n) => n.draft !== 'new');
    return { lane, total: nodes.length, drafts: nodes.length - saved.length, unlinked: saved.filter((n) => !linked.has(n.id)).length, top: saved.slice(0, topN) };
  });
}

/** Number of links between each pair of lanes (left lane first), for the bird's-eye bundles. */
export function laneBundles(map: StrategyMap): { from: StrategyNode['lane']; to: StrategyNode['lane']; count: number; drafts: number }[] {
  const laneOf = new Map(map.nodes.map((n) => [n.id, n.lane]));
  const counts = new Map<string, { count: number; drafts: number }>();
  for (const l of map.links) {
    const a = laneOf.get(l.source), b = laneOf.get(l.target);
    if (!a || !b || a === b) continue;
    const [from, to] = LANES.indexOf(a) < LANES.indexOf(b) ? [a, b] : [b, a];
    const c = counts.get(`${from}>${to}`) ?? { count: 0, drafts: 0 };
    if (l.draft) c.drafts += 1; else c.count += 1;
    counts.set(`${from}>${to}`, c);
  }
  return [...counts].map(([key, c]) => {
    const [from, to] = key.split('>') as [StrategyNode['lane'], StrategyNode['lane']];
    return { from, to, ...c };
  }).sort((x, y) => LANES.indexOf(x.from) - LANES.indexOf(y.from) || LANES.indexOf(x.to) - LANES.indexOf(y.to));
}
