import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { ArrowMaximize20Regular, ZoomIn20Regular, ZoomOut20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { createScopedStore } from '../../state/projects.ts';
import { wrap } from '../../ui/textWrap.ts';
import { ScrollRegion } from './common.tsx';
import type { StrategyMap, StrategyNode } from './overviewModel.ts';
import {
  COL_WIDTH, LANES, laneBundles, laneSummaries, layoutStrategy, lineage, MAP_LEVELS, MAP_WIDTH, NODE_WIDTH, OVERVIEW_THRESHOLD, TOP,
  type MapLevel, type NodeBox, type StrategyLayout,
} from './strategyLayout.ts';
import {
  emptyDestination, emptyDomId, laneDomId, laneHref, nodeDestination, nodeDomId, type Destination, type DetailRow, type Lane,
} from './strategyPortal.ts';

/** FR-349: how the map's items open their input/check places; absent on read-only previews (no duplicate ids). */
export interface Portal {
  companyId: string;
  canEditObjectives: boolean;
  /** Lanes with nowhere to go for this audience stay plain text. */
  inert: readonly Lane[];
  onObjective: (draftId?: string) => void;
  onLeave: (label: string, domId: string) => void;
}

/** FR-381: the map's view (level, magnification, opened sub-data) per project, so a return from an editor finds it as it was. */
interface StrategyView { level?: MapLevel; zoom?: number; open?: Record<string, boolean> }
export const useStrategyView = createScopedStore<StrategyView>('proj.strategyView', () => ({}));

const MIN_ZOOM = 0.3, MAX_ZOOM = 2, ZOOM_STEP = 1.25;
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(k * 100) / 100));
const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
const laneNameId = (lane: Lane) => `stg-lane-name-${lane}`;
export const rowDomId = (nodeId: string, rowId: string) => `stg-row-${nodeId}-${rowId}`;
export const toggleDomId = (nodeId: string) => `stg-toggle-${nodeId}`;
const activate = (run: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } };

/** Without `label` the name comes from the visible text (WCAG 2.5.3); `describedBy` adds the lane. */
function SvgAction({ id, describedBy, dest, portal, leaveLabel, children }: {
  id: string; describedBy?: string | undefined; dest: Destination; portal: Portal; leaveLabel: string; children: ReactNode;
}) {
  if (dest.kind === 'link') {
    return <a id={id} href={dest.href} aria-describedby={describedBy} onClick={(e) => { if (plainClick(e)) portal.onLeave(leaveLabel, id); }}>{children}</a>;
  }
  const open = () => portal.onObjective(dest.draftId);
  return (
    <g id={id} role="button" tabIndex={0} aria-describedby={describedBy} aria-haspopup="dialog" onClick={open} onKeyDown={activate(open)}>{children}</g>
  );
}

interface CanvasProps {
  map: StrategyMap;
  layout: StrategyLayout;
  portal?: Portal;
  /** Item whose chain is highlighted (hover / focus). */
  focus?: string | null;
  onFocusItem?: (id: string | null) => void;
  onToggle?: (id: string) => void;
  rowText?: (row: DetailRow) => string;
  zoom?: number;
}

function linkPath(a: NodeBox, b: NodeBox) {
  const x = a.x + NODE_WIDTH, y = a.y + Math.min(a.h, a.headH) / 2, by = b.y + b.headH / 2;
  const mid = (x + b.x) / 2;
  return `M${x},${y} C${mid},${y} ${mid},${by} ${b.x},${by}`;
}

/** Items, links and lane headings; also the static preview of a draft (no portal: nothing is interactive). */
function MapCanvas({ map, layout, portal, focus = null, onFocusItem, onToggle, rowText, zoom }: CanvasProps) {
  const { t, fmt } = useI18n();
  const related = useMemo(() => (focus ? lineage(map.links, focus) : null), [map.links, focus]);
  const live = (lane: Lane) => portal && !portal.inert.includes(lane) ? portal : undefined;
  const laneName = (lane: Lane) => t(`stg.lane.${lane}`);
  const card = (n: StrategyNode) => {
    const b = layout.boxes.get(n.id)!;
    const p = live(n.lane);
    const score = n.score === null ? t('stg.unknown') : `${t('stg.score')}: ${fmt.number(n.score)}`;
    const fullId = `stg-full-${n.id}`;
    const head = (
      <g data-node={n.id} data-lane={n.lane} data-draft={n.draft}>
        <rect width={NODE_WIDTH} height={b.headH} rx={8} className="strategy-hit strategy-head" />
        <text x={10} y={22} className="strategy-label">{b.lines.map((line, i) => <tspan key={i} x={10} dy={i ? 18 : 0}>{line}</tspan>)}</text>
        {n.draft === 'changed' && <text x={10} y={b.headH - 28} className="strategy-draft-badge">{t('stg.badge.changed')}</text>}
        {n.draft === 'new'
          ? <text x={10} y={b.headH - 10} className="strategy-draft-badge">{t('stg.badge.new')}</text>
          : <text x={10} y={b.headH - 10} className="strategy-score">{score}</text>}
        {p && <text x={NODE_WIDTH - 10} y={b.headH - 10} textAnchor="end" className="strategy-edit">{t('stg.edit')}</text>}
      </g>
    );
    const toggleText = t('stg.detail.toggle');
    return (
      <g key={n.id} transform={`translate(${b.x},${b.y})`}
        className={`strategy-card${related?.has(n.id) ? ' is-related' : ''}${focus === n.id ? ' is-focus' : ''}`}
        onPointerEnter={onFocusItem && (() => onFocusItem(n.id))} onPointerLeave={onFocusItem && (() => onFocusItem(null))}
        onFocus={onFocusItem && (() => onFocusItem(n.id))} onBlur={onFocusItem && (() => onFocusItem(null))}>
        {b.truncated && <title>{n.label}</title>}
        <rect width={NODE_WIDTH} height={b.h} rx={8} className={`strategy-node ${n.lane}${n.draft === 'new' ? ' is-draft' : ''}`} />
        {/* A clipped title is read in full as the link's description; the name stays the visible text (WCAG 2.5.3). */}
        {p && b.truncated && <text id={fullId} display="none">{n.label}</text>}
        {p
          ? <SvgAction id={nodeDomId(n.id)} describedBy={b.truncated ? `${laneNameId(n.lane)} ${fullId}` : laneNameId(n.lane)}
            dest={nodeDestination(n, p.companyId, p.canEditObjectives)} portal={p} leaveLabel={n.label}>{head}</SvgAction>
          : head}
        {b.hasRows && onToggle && (
          <g id={toggleDomId(n.id)} role="button" tabIndex={0} aria-expanded={b.open} aria-label={`${toggleText}: ${n.label}`}
            data-testid={toggleDomId(n.id)} className="strategy-toggle" transform={`translate(0,${b.headH})`}
            onClick={() => onToggle(n.id)} onKeyDown={activate(() => onToggle(n.id))}>
            <rect x={4} y={1} width={NODE_WIDTH - 8} height={24} rx={4} className="strategy-hit" />
            <path d={b.open ? 'M12,10 l5,6 l5,-6' : 'M14,7 l6,5 l-6,5'} className="strategy-chevron" />
            <text x={28} y={18} className="strategy-toggle-text">{toggleText}</text>
          </g>
        )}
        {b.open && b.rows.map(({ row, lines, y }) => {
          const full = rowText ? rowText(row) : `${t(row.label)}: ${row.text}`;
          const text = <text x={12} y={y + 13} className="strategy-row">{lines.map((line, i) => <tspan key={i} x={12} dy={i ? 16 : 0}>{line}</tspan>)}</text>;
          const id = rowDomId(n.id, row.id);
          return p && row.href
            ? <a key={row.id} id={id} href={row.href} data-row={row.id} className="strategy-row-link"
              onClick={(e) => { if (plainClick(e)) p.onLeave(full, id); }}>
              <rect x={4} y={y} width={NODE_WIDTH - 8} height={lines.length * 16 + 6} rx={4} className="strategy-hit" />{text}
            </a>
            : <g key={row.id} data-row={row.id}>{text}</g>;
        })}
      </g>
    );
  };
  const height = layout.height;
  return (
    <svg className={`strategy-map${zoom ? ' is-zoomable' : ''}${related ? ' has-focus' : ''}`} viewBox={`0 0 ${MAP_WIDTH} ${height}`}
      style={zoom ? { width: MAP_WIDTH * zoom, height: height * zoom } : undefined}
      role={portal ? 'group' : 'img'} aria-label={t('stg.map')} data-testid={portal ? 'strategy-map' : 'strategy-map-preview'}>
      <title>{t('stg.map')}</title>
      <desc>{t('stg.mapWhy')}</desc>
      {map.links.map((l) => {
        const a = layout.boxes.get(l.source)!, b = layout.boxes.get(l.target)!;
        const hot = related?.has(l.source) && related.has(l.target);
        return <path key={`${l.source}-${l.target}`} data-source={l.source} data-target={l.target} data-draft={l.draft ? 'true' : undefined}
          className={`strategy-link${l.direct ? ' direct' : ''}${l.draft ? ' draft' : ''}${hot ? ' is-related' : ''}`} d={linkPath(a, b)} />;
      })}
      {/* Each lane's heading, empty slot and items stay together so keyboard order follows the columns. */}
      {LANES.map((lane, col) => {
        const x = 12 + col * COL_WIDTH;
        const p = live(lane);
        const empty = !map.nodes.some((n) => n.lane === lane);
        return (
          <g key={lane}>
            <LaneHeader lane={lane} x={x} portal={p} />
            {empty && (p
              ? <SvgAction id={emptyDomId(lane)} describedBy={laneNameId(lane)} dest={emptyDestination(lane, p.companyId, p.canEditObjectives)} portal={p} leaveLabel={laneName(lane)}>
                <g data-empty={lane}>
                  <rect x={x} y={TOP} width={NODE_WIDTH} height={56} rx={8} className="strategy-node strategy-slot" />
                  <text x={x + 10} y={70} className="strategy-empty">{t('stg.empty')}</text>
                  <text x={x + 10} y={92} className="strategy-score">{t('stg.portal.add')}</text>
                </g>
              </SvgAction>
              : <text x={x} y={68} className="strategy-empty">{t('stg.empty')}</text>)}
            {map.nodes.filter((n) => n.lane === lane).map(card)}
          </g>
        );
      })}
    </svg>
  );
}

/** A lane heading is the link to that lane's list (FR-349), at every zoom level. */
function LaneHeader({ lane, x, portal }: { lane: Lane; x: number; portal?: Portal | undefined }) {
  const { t } = useI18n();
  const name = t(`stg.lane.${lane}`);
  const header = <text id={portal ? laneNameId(lane) : undefined} x={x} y={24} className="strategy-lane">{name}</text>;
  return portal
    ? <SvgAction id={laneDomId(lane)} dest={{ kind: 'link', href: laneHref(lane, portal.companyId) }} portal={portal} leaveLabel={name}>
      <rect x={x - 4} y={2} width={NODE_WIDTH} height={32} rx={6} className="strategy-hit" />{header}
    </SvgAction>
    : header;
}

const OV_LINE = 20;

/** FR-381 bird's-eye: one block per lane (counts, gaps, drafts, top items) and the number of links between lanes. */
function OverviewCanvas({ map, portal, zoom, onOpenLane }: { map: StrategyMap; portal?: Portal; zoom: number; onOpenLane: (lane: Lane) => void }) {
  const { t, fmt } = useI18n();
  const summaries = useMemo(() => laneSummaries(map), [map]);
  const bundles = useMemo(() => laneBundles(map), [map]);
  const rowsOf = (s: (typeof summaries)[number]) => [
    t('stg.ov.total', { n: fmt.number(s.total) }),
    ...(s.drafts ? [t('stg.ov.drafts', { n: fmt.number(s.drafts) })] : []),
    ...(s.unlinked ? [t('stg.ov.unlinked', { n: fmt.number(s.unlinked) })] : []),
  ];
  const lines = Math.max(...summaries.map((s) => rowsOf(s).length + (s.top.length ? s.top.length + 1 : 0)));
  const blockH = 64 + lines * OV_LINE;
  const height = TOP + blockH + 160;
  const x = (lane: Lane) => 12 + LANES.indexOf(lane) * COL_WIDTH;
  const mid = TOP + blockH / 2;
  return (
    <svg className="strategy-map is-zoomable is-overview" viewBox={`0 0 ${MAP_WIDTH} ${height}`} style={{ width: MAP_WIDTH * zoom, height: height * zoom }}
      role="group" aria-label={t('stg.map')} data-testid="strategy-map-overview">
      <title>{t('stg.map')}</title>
      {bundles.map((b) => {
        const adjacent = LANES.indexOf(b.to) - LANES.indexOf(b.from) === 1;
        const label = [b.count ? t('stg.ov.links', { n: fmt.number(b.count) }) : '', b.drafts ? t('stg.ov.draftLinks', { n: fmt.number(b.drafts) }) : ''].filter(Boolean).join(' ');
        if (adjacent) {
          const x1 = x(b.from) + NODE_WIDTH, x2 = x(b.to);
          return <g key={`${b.from}-${b.to}`} data-bundle={`${b.from}-${b.to}`}>
            <path d={`M${x1},${mid} L${x2},${mid}`} className={`strategy-link${b.count ? '' : ' draft'}`} />
            {/* The gap between lanes is narrower than the label, so the count sits under it. */}
            <text x={(x1 + x2) / 2} y={TOP + blockH + 18} textAnchor="middle" className="strategy-bundle">{label}</text>
          </g>;
        }
        const x1 = x(b.from) + NODE_WIDTH / 2, x2 = x(b.to) + NODE_WIDTH / 2, y = TOP + blockH;
        const depth = 44 + (LANES.indexOf(b.to) - LANES.indexOf(b.from)) * 18;
        return <g key={`${b.from}-${b.to}`} data-bundle={`${b.from}-${b.to}`}>
          <path d={`M${x1},${y} C${x1},${y + depth} ${x2},${y + depth} ${x2},${y}`} className={`strategy-link direct${b.count ? '' : ' draft'}`} />
          <text x={(x1 + x2) / 2} y={y + depth * 0.75 + 12} textAnchor="middle" className="strategy-bundle">{label}</text>
        </g>;
      })}
      {summaries.map((s) => {
        const bx = x(s.lane);
        const rows = rowsOf(s);
        const name = t(`stg.lane.${s.lane}`);
        const open = () => onOpenLane(s.lane);
        const p = portal && !portal.inert.includes(s.lane) ? portal : undefined;
        const descId = `stg-ov-desc-${s.lane}`;
        return (
          <g key={s.lane}>
            <LaneHeader lane={s.lane} x={bx} portal={p} />
            {/* Name = the visible text (WCAG 2.5.3); the lane and the unclipped top items are its description. */}
            <text id={descId} display="none">{[name, ...s.top.map((n, i) => `${i + 1}. ${n.label}`)].join(' / ')}</text>
            <g role="button" tabIndex={0} data-lane-block={s.lane} data-testid={`strategy-ov-${s.lane}`} className="strategy-ov-block"
              aria-describedby={descId} onClick={open} onKeyDown={activate(open)}>
              <rect x={bx} y={TOP} width={NODE_WIDTH} height={blockH} rx={8} className={`strategy-node ${s.lane}`} />
              {rows.map((r, i) => <text key={i} x={bx + 10} y={TOP + 24 + i * OV_LINE} className={i ? 'strategy-score' : 'strategy-ov-total'}>{r}</text>)}
              {s.top.length > 0 && <text x={bx + 10} y={TOP + 24 + rows.length * OV_LINE} className="strategy-score">{t('stg.ov.top')}</text>}
              {s.top.map((n, i) => {
                const [first = '', ...rest] = wrap(n.label, 16);
                return <text key={n.id} x={bx + 10} y={TOP + 24 + (rows.length + 1 + i) * OV_LINE} className="strategy-label">{`${i + 1}. ${first}${rest.length ? '…' : ''}`}</text>;
              })}
              <text x={bx + 10} y={TOP + blockH - 12} className="strategy-edit">{t('stg.ov.open')}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/** The read-only preview of a draft's map: full titles, no sub-data, no controls. */
export function StrategyPreview({ map }: { map: StrategyMap }) {
  const { t } = useI18n();
  const layout = useMemo(() => layoutStrategy(map, { level: 'detail' }), [map]);
  return <ScrollRegion label={t('stg.map')}><MapCanvas map={map} layout={layout} /></ScrollRegion>;
}

/**
 * FR-381: the strategy map with the same view controls as the business process map — bird's-eye / items / detail,
 * zoom in and out, fit — sub-data opened per item, and each item's chain highlighted on hover or focus.
 */
export function StrategyMapView({ map, portal, details }: { map: StrategyMap; portal: Portal; details: ReadonlyMap<string, DetailRow[]> }) {
  const { t, fmt } = useI18n();
  const view = useStrategyView((s) => s.value);
  const setView = useStrategyView((s) => s.set);
  const level: MapLevel = view.level ?? (map.nodes.length > OVERVIEW_THRESHOLD ? 'overview' : 'items');
  const zoom = clampZoom(view.zoom ?? 1);
  const [focus, setFocus] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
  const pendingLane = useRef<Lane | null>(null);
  const helpId = useId();
  const isOpen = (id: string) => view.open?.[id] ?? level === 'detail';
  const rowText = (row: DetailRow) => `${t(row.label)}: ${row.text}`;
  const layout = useMemo(() => layoutStrategy(map, { level: level === 'detail' ? 'detail' : 'items', details, isOpen, rowText }),
    // isOpen/rowText only read view.open, level and t.
    [map, level, details, view.open, t]);
  const withDetails = map.nodes.filter((n) => (details.get(n.id)?.length ?? 0) > 0);

  const chooseLevel = (lv: MapLevel) => setView((v) => ({ ...v, level: lv, open: {}, zoom: lv === 'overview' ? Math.min(clampZoom(v.zoom ?? 1), 1) : v.zoom }));
  const zoomTo = (k: number, at?: { x: number; y: number }) => {
    const el = canvasRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const px = at ? at.x - r.left : el.clientWidth / 2, py = at ? at.y - r.top : el.clientHeight / 2;
      anchor.current = { px, py, cx: (el.scrollLeft + px) / zoom, cy: (el.scrollTop + py) / zoom };
    }
    setView((v) => ({ ...v, zoom: clampZoom(k) }));
  };
  /** Semantic zoom: zooming out past the smallest size shows the bird's-eye view; zooming in from it shows the items. */
  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    if (factor < 1 && level !== 'overview' && zoom <= MIN_ZOOM * ZOOM_STEP) { chooseLevel('overview'); return; }
    if (factor > 1 && level === 'overview' && zoom >= 1) { setView((v) => ({ ...v, level: 'items', open: {}, zoom: 0.6 })); return; }
    zoomTo(zoom * factor, at);
  };
  const fit = () => {
    const el = canvasRef.current;
    if (!el) return;
    const svg = el.querySelector('svg');
    const h = svg ? Number(svg.getAttribute('viewBox')?.split(' ')[3]) : 0;
    const k = Math.min(el.clientWidth / MAP_WIDTH, h ? el.clientHeight / h : Infinity);
    anchor.current = null;
    setView((v) => ({ ...v, zoom: clampZoom(k) }));
    el.scrollTo({ left: 0, top: 0 });
  };
  useLayoutEffect(() => {
    const el = canvasRef.current, a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    el.scrollLeft = a.cx * zoom - a.px;
    el.scrollTop = a.cy * zoom - a.py;
  }, [zoom]);
  useLayoutEffect(() => {
    const lane = pendingLane.current, el = canvasRef.current;
    if (!lane || !el || level === 'overview') return;
    pendingLane.current = null;
    el.scrollTo({ left: Math.max(0, (12 + LANES.indexOf(lane) * COL_WIDTH) * zoom - 12), top: 0 });
    const target = document.getElementById(laneDomId(lane)) ?? el;
    (target as HTMLElement | SVGElement).focus({ preventScroll: true });
  }, [level, zoom]);
  // Ctrl/⌘ + wheel zooms around the pointer; the plain wheel keeps scrolling the page.
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomByRef.current(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // A drag on the background pans the map; items and buttons keep their own clicks.
  const drag = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = canvasRef.current;
    if (!el || e.button !== 0 || e.pointerType === 'touch' || (e.target as Element).closest('a, [role="button"]')) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = canvasRef.current, d = drag.current;
    if (!el || !d || d.id !== e.pointerId) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = () => { drag.current = null; };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const keys: Record<string, () => void> = { '+': () => zoomBy(ZOOM_STEP), '=': () => zoomBy(ZOOM_STEP), '-': () => zoomBy(1 / ZOOM_STEP), '0': fit };
    const run = keys[e.key];
    if (run) { e.preventDefault(); run(); }
  };
  const toggle = (id: string) => setView((v) => ({ ...v, open: { ...v.open, [id]: !(v.open?.[id] ?? level === 'detail') } }));
  const setAll = (open: boolean) => setView((v) => ({ ...v, open: Object.fromEntries(withDetails.map((n) => [n.id, open])) }));
  const openLane = (lane: Lane) => {
    pendingLane.current = lane;
    setView((v) => ({ ...v, level: 'items', open: {}, zoom: Math.max(clampZoom(v.zoom ?? 1), 0.8) }));
  };

  return (
    <div className="strategy-zoom" data-testid="strategy-zoom" data-level={level}>
      <div className="strategy-map-toolbar" role="toolbar" aria-label={t('stg.zoom.toolbar')}>
        <div className="strategy-levels" role="radiogroup" aria-label={t('stg.zoom.levels')}>
          {MAP_LEVELS.map((lv) => (
            <Button key={lv} size="small" role="radio" aria-checked={level === lv} appearance={level === lv ? 'primary' : 'subtle'}
              onClick={() => chooseLevel(lv)} data-testid={`strategy-level-${lv}`}>{t(`stg.zoom.${lv}`)}</Button>
          ))}
        </div>
        <Tooltip content={t('stg.zoom.in')} relationship="label"><Button size="small" icon={<ZoomIn20Regular />} onClick={() => zoomBy(ZOOM_STEP)} disabled={level !== 'overview' && zoom >= MAX_ZOOM} data-testid="strategy-zoom-in" /></Tooltip>
        <Tooltip content={t('stg.zoom.out')} relationship="label"><Button size="small" icon={<ZoomOut20Regular />} onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={level === 'overview' && zoom <= MIN_ZOOM} data-testid="strategy-zoom-out" /></Tooltip>
        <Tooltip content={t('stg.zoom.fit')} relationship="label"><Button size="small" icon={<ArrowMaximize20Regular />} onClick={fit} data-testid="strategy-zoom-fit" /></Tooltip>
        <span className="muted strategy-zoom-value" aria-live="polite" data-testid="strategy-zoom-value">{t('stg.zoom.value', { value: fmt.percent(zoom) })}</span>
        {level !== 'overview' && withDetails.length > 0 && <>
          <Button size="small" appearance="subtle" onClick={() => setAll(true)} data-testid="strategy-open-all">{t('stg.detail.openAll')}</Button>
          <Button size="small" appearance="subtle" onClick={() => setAll(false)} data-testid="strategy-close-all">{t('stg.detail.closeAll')}</Button>
        </>}
      </div>
      <p id={helpId} className="muted strategy-zoom-help">{t('stg.zoom.help')}</p>
      <div ref={canvasRef} className="strategy-canvas" tabIndex={0} role="region" aria-label={t('stg.map')} aria-describedby={helpId}
        onKeyDown={onKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
        data-testid="strategy-canvas">
        {level === 'overview'
          ? <OverviewCanvas map={map} portal={portal} zoom={zoom} onOpenLane={openLane} />
          : <MapCanvas map={map} layout={layout} portal={portal} focus={focus} onFocusItem={setFocus} onToggle={toggle} rowText={rowText} zoom={zoom} />}
      </div>
    </div>
  );
}
