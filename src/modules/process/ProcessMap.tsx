import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { ArrowMaximize20Regular, ZoomIn20Regular, ZoomOut20Regular } from '@fluentui/react-icons';
import * as d3 from 'd3';
import { useI18n } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { loc } from '../../state/text.ts';
import {
  effortHours, flowEdges, GEO, leadHours, loopIn, metricsIn, phaseSummary, presentIn, stepDelta,
  type Layout, type ProcessView, type ProcState, type PStep,
} from './model.ts';
import { duration, hoursMonth, loopShort, loopText, signedPercent } from './format.ts';
import { HoverCard, type HoverTarget } from './HoverCard.tsx';

export type ZoomLevel = 'overview' | 'steps' | 'detail';
export const ZOOM_LEVELS: ZoomLevel[] = ['overview', 'steps', 'detail'];
/** Scale at which each level begins: below `steps` the map shows phase blocks; from `detail` the cards show their numbers. */
const LEVEL_SCALE = { steps: 0.62, detail: 1.3 } as const;
const TARGET_SCALE: Record<ZoomLevel, number> = { overview: 0.5, steps: 0.95, detail: 1.6 };
const MIN_SCALE = 0.12;
const MAX_SCALE = 3;
const PAN_STEP = 90;
const HIDE_DELAY = 160;

export function levelFor(k: number): ZoomLevel {
  if (k >= LEVEL_SCALE.detail) return 'detail';
  return k >= LEVEL_SCALE.steps ? 'steps' : 'overview';
}

interface Props {
  view: ProcessView;
  layout: Layout;
  state: ProcState;
  compare: boolean;
  level: ZoomLevel;
  onLevel: (level: ZoomLevel) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  criticalIds: Set<string>;
}

type Rect = { x: number; y: number; w: number; h: number };
const rectOf = (layout: Layout, id: string): Rect | null => {
  const s = layout.steps.get(id);
  return s ? { x: s.x, y: s.y, w: GEO.cardW, h: GEO.cardH } : null;
};

function flowPath(a: Rect, b: Rect): string {
  if (b.x > a.x + a.w / 2) {
    const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x, ty = b.y + b.h / 2;
    const dx = Math.max(24, (tx - sx) / 2);
    return `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
  }
  if (Math.abs(b.x - a.x) < 1) {
    const down = b.y > a.y;
    const sx = a.x + a.w / 2, sy = down ? a.y + a.h : a.y, tx = b.x + b.w / 2, ty = down ? b.y : b.y + b.h;
    return `M${sx},${sy} C${sx},${(sy + ty) / 2} ${tx},${(sy + ty) / 2} ${tx},${ty}`;
  }
  return loopPath(a, b, 0).d;
}

/** A loop runs under the cards from the later step back to the earlier one. */
function loopPath(a: Rect, b: Rect, lane: number): { d: string; mx: number; my: number } {
  const sx = a.x + a.w / 2 + 14, sy = a.y + a.h, tx = b.x + b.w / 2 - 14, ty = b.y + b.h;
  const drop = 34 + lane * 12;
  const bottom = Math.max(sy, ty) + drop;
  return { d: `M${sx},${sy} C${sx},${bottom} ${tx},${bottom} ${tx},${ty}`, mx: (sx + tx) / 2, my: bottom - drop * 0.25 };
}

/** The bar scale: square root, so a 45-day wait and a 10-minute task are both visible. */
function barScale(max: number) {
  return (h: number) => (max > 0 ? Math.sqrt(Math.max(0, h)) / Math.sqrt(max) : 0);
}

export function ProcessMap({ view, layout, state, compare, level, onLevel, selected, onSelect, criticalIds }: Props) {
  const { t, lang, fmt } = useI18n();
  const reduced = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [k, setK] = useState(TARGET_SCALE.overview);
  const [size, setSize] = useState({ w: 960, h: 560 });
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const cardId = useId();
  const helpId = useId();
  const levelRef = useRef(level);
  levelRef.current = level;
  const kRef = useRef(k);
  /** True once the user moved the view; the requested level then no longer resets it. */
  const userMoved = useRef(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(320, Math.round(e!.contentRect.width));
      setSize((s) => (s.w === w ? s : { ...s, w }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale = Math.min(size.w / layout.width, size.h / layout.height);

  const transformTo = useCallback((scale: number, cx?: number, cy?: number, animate = true) => {
    const svg = svgRef.current, zoom = zoomRef.current;
    if (!svg || !zoom) return;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const x = cx ?? layout.width / 2, y = cy ?? layout.height / 2;
    const tr = d3.zoomIdentity.translate(size.w / 2 - x * s, size.h / 2 - y * s).scale(s);
    const sel = d3.select(svg);
    if (animate && !reduced) sel.transition().duration(280).call(zoom.transform, tr);
    else sel.call(zoom.transform, tr);
  }, [layout.width, layout.height, size.w, size.h, reduced]);

  useEffect(() => {
    const svg = svgRef.current, g = gRef.current;
    if (!svg || !g) return;
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      // Wheel zooms; a drag on the background pans. Cards and buttons keep their own clicks.
      .filter((e: Event) => (e.type === 'wheel' || !(e.target as Element).closest?.('.bp-node, .bp-phase-block, .bp-loop-label')) && !(e as MouseEvent).button)
      .on('zoom', (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.setAttribute('transform', e.transform.toString());
        setK(e.transform.k);
        kRef.current = e.transform.k;
        if (e.sourceEvent) {
          userMoved.current = true;
          const next = levelFor(e.transform.k);
          if (next !== levelRef.current) onLevel(next);
        }
      });
    zoomRef.current = zoom;
    d3.select(svg).call(zoom).on('dblclick.zoom', null);
    return () => { d3.select(svg).on('.zoom', null); };
  }, [onLevel]);

  // The level buttons (and the URL) set the view; once the user moves it (wheel, drag, keys), only the level label follows.
  const applyLevel = useCallback((lv: ZoomLevel) => {
    const focus = selected ? layout.steps.get(selected) : undefined;
    const scale = lv === 'overview' ? Math.min(fitScale, TARGET_SCALE.overview) : TARGET_SCALE[lv];
    if (lv === 'overview') transformTo(scale, undefined, undefined, false);
    else if (focus) transformTo(scale, Math.max(focus.x + GEO.cardW / 2, size.w / 2 / scale), focus.y + GEO.cardH / 2, false);
    else {
      // Reading starts at the top left: the lane names and the first phase stay in view.
      const fitsHeight = layout.height * scale <= size.h;
      transformTo(scale, size.w / 2 / scale, fitsHeight ? layout.height / 2 : size.h / 2 / scale, false);
    }
  }, [selected, layout, fitScale, size.w, size.h, transformTo]);
  useEffect(() => {
    if (!userMoved.current) applyLevel(level);
    // Only a change of the requested level, of the map or of its size moves the view.
  }, [level, layout, fitScale]); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseLevel = (lv: ZoomLevel) => {
    userMoved.current = false;
    if (lv === level) applyLevel(lv);
    else onLevel(lv);
  };
  const moved = () => { userMoved.current = true; };

  /** Keyboard focus never lands on a step hidden outside the canvas (WCAG 2.4.11): the view pans to it. */
  const reveal = (el: Element) => {
    const wrap = wrapRef.current, svg = svgRef.current, zoom = zoomRef.current;
    if (!wrap || !svg || !zoom) return;
    const w = wrap.getBoundingClientRect(), r = el.getBoundingClientRect();
    const margin = 12;
    const dx = r.left < w.left + margin ? w.left + margin - r.left : r.right > w.right - margin ? w.right - margin - r.right : 0;
    const dy = r.top < w.top + margin ? w.top + margin - r.top : r.bottom > w.bottom - margin ? w.bottom - margin - r.bottom : 0;
    if (dx || dy) {
      userMoved.current = true;
      d3.select(svg).call(zoom.translateBy, dx / kRef.current, dy / kRef.current);
    }
  };

  const zoomBy = (factor: number) => {
    const svg = svgRef.current, zoom = zoomRef.current;
    if (!svg || !zoom) return;
    moved();
    const sel = d3.select(svg);
    (reduced ? sel : sel.transition().duration(200)).call(zoom.scaleBy, factor);
    const next = levelFor(Math.min(MAX_SCALE, Math.max(MIN_SCALE, k * factor)));
    if (next !== level) onLevel(next);
  };
  const panBy = (dx: number, dy: number) => {
    const svg = svgRef.current, zoom = zoomRef.current;
    moved();
    if (svg && zoom) d3.select(svg).call(zoom.translateBy, dx / kRef.current, dy / kRef.current);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('.bp-node, .bp-phase-block')) {
      if (e.key === 'Escape') setHover(null);
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(PAN_STEP, 0), ArrowRight: () => panBy(-PAN_STEP, 0), ArrowUp: () => panBy(0, PAN_STEP), ArrowDown: () => panBy(0, -PAN_STEP),
      '+': () => zoomBy(1.4), '=': () => zoomBy(1.4), '-': () => zoomBy(1 / 1.4), '0': () => chooseLevel('overview'), Escape: () => setHover(null),
    };
    const run = keys[e.key];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  /* ---------- Hover and focus cards ---------- */
  const show = (target: HoverTarget) => {
    window.clearTimeout(hideTimer.current);
    setHover(target);
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(null), HIDE_DELAY);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const hoverProps = (target: HoverTarget) => ({
    onPointerEnter: (e: React.PointerEvent) => show({ ...target, anchor: e.currentTarget as Element }),
    onPointerLeave: scheduleHide,
    onFocus: (e: React.FocusEvent) => {
      reveal(e.currentTarget);
      show({ ...target, anchor: e.currentTarget as Element });
    },
    onBlur: scheduleHide,
    'aria-describedby': hover && hover.type === target.type && hover.id === target.id ? cardId : undefined,
  });

  /* ---------- Data for drawing ---------- */
  const lane = useMemo(() => new Map(view.lanes.map((l) => [l.id, l])), [view.lanes]);
  const drawState: ProcState = compare ? 'toBe' : state;
  const visible = (s: PStep) => (drawState === 'asIs' ? presentIn(s, 'asIs') : true);
  const edges = useMemo(() => flowEdges(view, drawState), [view, drawState]);
  const ghostEdges = useMemo(() => (drawState === 'toBe'
    ? flowEdges(view, 'asIs').filter(([a, b]) => !presentIn(view.byId.get(a)!, 'toBe') || !presentIn(view.byId.get(b)!, 'toBe'))
    : []), [view, drawState]);
  const loops = view.loops.filter((l) => loopIn(l, drawState) && visible(view.byId.get(l.from)!) && visible(view.byId.get(l.to)!));
  const maxLead = useMemo(() => Math.max(0, ...view.steps.flatMap((s) => [leadHours(s.asIs) ?? 0, leadHours(s.toBe) ?? 0])), [view]);
  const bar = barScale(maxLead);
  const onPath = (a: string, b: string) => criticalIds.has(a) && criticalIds.has(b);
  const isMessage = (a: string, b: string) => lane.get(view.byId.get(a)!.laneId)?.side !== lane.get(view.byId.get(b)!.laneId)?.side;
  const overview = level === 'overview';

  const laneLabel = (id: string) => {
    const l = lane.get(id)!;
    return loc(l.name, lang) || t('bp.lane.unassigned');
  };

  return (
    <div className="bp-map" data-testid="bp-map" data-level={level} data-state={compare ? 'compare' : state}>
      <div className="bp-map-toolbar" role="toolbar" aria-label={t('bp.zoom.toolbar')}>
        <div className="bp-levels" role="radiogroup" aria-label={t('bp.zoom.levels')}>
          {ZOOM_LEVELS.map((lv) => (
            <Button key={lv} size="small" role="radio" aria-checked={level === lv} appearance={level === lv ? 'primary' : 'subtle'} onClick={() => chooseLevel(lv)} data-testid={`bp-level-${lv}`}>
              {t(`bp.zoom.${lv}`)}
            </Button>
          ))}
        </div>
        <Tooltip content={t('bp.zoom.in')} relationship="label"><Button size="small" icon={<ZoomIn20Regular />} onClick={() => zoomBy(1.4)} data-testid="bp-zoom-in" /></Tooltip>
        <Tooltip content={t('bp.zoom.out')} relationship="label"><Button size="small" icon={<ZoomOut20Regular />} onClick={() => zoomBy(1 / 1.4)} data-testid="bp-zoom-out" /></Tooltip>
        <Tooltip content={t('bp.zoom.fit')} relationship="label"><Button size="small" icon={<ArrowMaximize20Regular />} onClick={() => { moved(); transformTo(fitScale); }} data-testid="bp-zoom-fit" /></Tooltip>
        <span className="muted bp-zoom-value" aria-live="polite">{t('bp.zoom.value', { value: fmt.percent(k) })}</span>
      </div>
      <p id={helpId} className="muted bp-map-help">{t('bp.zoom.help')}</p>
      <div
        ref={wrapRef}
        className="bp-canvas"
        tabIndex={0}
        role="group"
        aria-label={t('bp.map.aria', { steps: view.steps.filter(visible).length, lanes: view.lanes.length })}
        aria-describedby={helpId}
        onKeyDown={onKey}
        data-testid="bp-canvas"
      >
        <svg ref={svgRef} width={size.w} height={size.h} className="bp-svg" role="presentation">
          <defs>
            <marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="bp-arrow-head" /></marker>
            <marker id="bp-arrow-path" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="bp-arrow-head is-path" /></marker>
            <marker id="bp-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" className="bp-arrow-open" /></marker>
            <marker id="bp-arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="bp-arrow-head is-loop" /></marker>
          </defs>
          <g ref={gRef}>
            {/* Pools: outside parties above, the company below, never mixed in one band. */}
            {layout.lanes.map((ll, i) => (
              <g key={ll.id} className={`bp-lane is-${ll.side}`}>
                <rect x={0} y={ll.y} width={layout.width} height={ll.h} className={`bp-lane-bg ${i % 2 ? 'is-alt' : ''}`} />
                <foreignObject x={0} y={ll.y} width={GEO.labelW - 8} height={ll.h}>
                  <div
                    className="bp-lane-label bp-node"
                    tabIndex={overview ? -1 : 0}
                    data-testid={`bp-lane-${ll.id}`}
                    {...hoverProps({ type: 'lane', id: ll.id })}
                  >
                    {i === 0 || layout.lanes[i - 1]!.side !== ll.side
                      ? <span className={`bp-side-tag is-${ll.side}`}>{t(`bp.side.${ll.side}`)}</span>
                      : <span className="visually-hidden">{t(`bp.side.${ll.side}`)}</span>}
                    <span className="bp-lane-name">{laneLabel(ll.id)}</span>
                  </div>
                </foreignObject>
              </g>
            ))}
            {layout.lanes.some((l) => l.side === 'external') && layout.lanes.some((l) => l.side === 'internal') && (
              <g className="bp-band-divider" aria-hidden>
                <line x1={0} x2={layout.width} y1={layout.internalTop - GEO.bandGap / 2} y2={layout.internalTop - GEO.bandGap / 2} />
                <text x={GEO.labelW} y={layout.internalTop - GEO.bandGap / 2 - 4}>{t('bp.band.boundary')}</text>
              </g>
            )}

            {/* Phases (value chain), in their stated order. */}
            {layout.phases.map((p, i) => {
              const ph = view.phases.find((x) => x.id === p.id)!;
              const name = ph.name ? loc(ph.name, lang) : t('bp.phase.all');
              const first = i === 0, last = i === layout.phases.length - 1;
              const tip = 14, y0 = 8, h = GEO.headerH - 20;
              const pts = [[p.x + 4, y0], [p.x + p.w - 4 - (last ? 0 : tip), y0], [p.x + p.w - 4, y0 + h / 2], [p.x + p.w - 4 - (last ? 0 : tip), y0 + h], [p.x + 4, y0 + h], [p.x + 4 + (first ? 0 : tip), y0 + h / 2]];
              return (
                <g key={p.id} className="bp-phase">
                  <polygon points={pts.map((q) => q.join(',')).join(' ')} className="bp-phase-chevron" />
                  <text x={p.x + 4 + (first ? 12 : tip + 10)} y={y0 + h / 2 + 5} className="bp-phase-name">{name}</text>
                  <line x1={p.x} x2={p.x} y1={GEO.headerH - 6} y2={layout.height} className="bp-phase-line" />
                </g>
              );
            })}

            {/* Flow: sequence flow inside the company, message flow (dashed) across the boundary. */}
            <g className={`bp-edges ${overview ? 'is-faint' : ''}`}>
              {ghostEdges.map(([a, b]) => {
                const ra = rectOf(layout, a), rb = rectOf(layout, b);
                return ra && rb ? <path key={`g-${a}-${b}`} d={flowPath(ra, rb)} className="bp-edge is-ghost" /> : null;
              })}
              {edges.map(([a, b]) => {
                const ra = rectOf(layout, a), rb = rectOf(layout, b);
                if (!ra || !rb) return null;
                const path = onPath(a, b);
                const message = isMessage(a, b);
                const bypass = !view.byId.get(a)!.next.includes(b);
                return (
                  <path
                    key={`${a}-${b}`}
                    d={flowPath(ra, rb)}
                    className={`bp-edge ${message ? 'is-message' : ''} ${path ? 'is-path' : ''} ${bypass ? 'is-bypass' : ''}`}
                    markerEnd={`url(#${message ? 'bp-arrow-open' : path ? 'bp-arrow-path' : 'bp-arrow'})`}
                    data-testid={`bp-edge-${a}-${b}`}
                  />
                );
              })}
            </g>

            {/* Loops: rework goes back, iterations repeat on a cadence (the process is not a waterfall). */}
            <g className={`bp-loops ${overview ? 'is-faint' : ''}`}>
              {loops.map((l, i) => {
                const ra = rectOf(layout, l.from), rb = rectOf(layout, l.to);
                if (!ra || !rb) return null;
                const p = loopPath(ra, rb, i % 3);
                return (
                  <g key={l.id} className={`bp-loop is-${l.kind}`} data-testid={`bp-loop-${l.id}`}>
                    <path d={p.d} className="bp-loop-path" markerEnd="url(#bp-arrow-loop)" />
                    {!overview && (
                      <foreignObject x={p.mx - 90} y={p.my - 12} width={180} height={24}>
                        <div className="bp-loop-label bp-node" tabIndex={0} aria-label={loopText(l, t, lang, fmt)} {...hoverProps({ type: 'loop', id: l.id })}>
                          <span aria-hidden>↻</span> {loopShort(l, t, lang, fmt)}
                        </div>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </g>

            {/* Steps. */}
            {view.steps.map((s) => {
              const r = layout.steps.get(s.id)!;
              if (!visible(s)) return null;
              const gone = drawState === 'toBe' && !presentIn(s, 'toBe');
              const m = metricsIn(s, drawState) ?? s.asIs;
              const lead = leadHours(m);
              const d = stepDelta(s);
              const changed = drawState === 'toBe' && s.change !== 'keep';
              // The bird's-eye view keeps only the shape of the steps; the phase blocks carry the text.
              if (overview) return <rect key={s.id} x={r.x} y={r.y} width={GEO.cardW} height={GEO.cardH} rx={8} className={`bp-mini is-${lane.get(s.laneId)!.side} ${gone ? 'is-gone' : ''}`} aria-hidden />;
              return (
                <foreignObject key={s.id} x={r.x} y={r.y} width={GEO.cardW} height={GEO.cardH}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected === s.id}
                    className={`bp-node bp-card is-${lane.get(s.laneId)!.side} ${changed ? `change-${s.change}` : ''} ${gone ? 'is-gone' : ''} ${selected === s.id ? 'is-selected' : ''} ${criticalIds.has(s.id) ? 'on-path' : ''}`}
                    data-testid={`bp-step-${s.id}`}
                    onClick={() => onSelect(selected === s.id ? null : s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(selected === s.id ? null : s.id);
                      }
                    }}
                    {...hoverProps({ type: 'step', id: s.id })}
                  >
                    <div className="bp-card-top">
                      {changed && <span className={`bp-tag change-${s.change}`}>{t(`bp.change.${s.change}`)}{s.change === 'improve' && d.lead !== null ? ` ${signedPercent(d.lead, fmt)}` : ''}</span>}
                      {drawState === 'toBe' && s.toBeHypothesis && s.change !== 'keep' && <span className="bp-tag is-hypo">{t('bp.basis.hypothesis')}</span>}
                      {s.hidden.length > 0 && level === 'detail' && <span className="bp-tag is-hidden">{t('bp.hidden.badge', { n: s.hidden.length })}</span>}
                    </div>
                    <div className={`bp-card-name ${level === 'detail' ? 'is-small' : ''}`}>{loc(s.name, lang)}<span className="visually-hidden">{`, ${laneLabel(s.laneId)}`}</span></div>
                    {level === 'detail' && !gone && <DetailLines step={s} state={drawState} compare={compare} />}
                    {!gone && (
                      <div className="bp-card-bars" aria-hidden>
                        {compare && <Bars m={s.asIs} scale={bar} muted />}
                        <Bars m={m} scale={bar} />
                      </div>
                    )}
                    {level !== 'detail' && !gone && <div className="bp-card-foot">{lead === null ? t('bp.unknown') : duration(lead, t, fmt)}{compare && d.lead !== null && s.change !== 'keep' ? ` (${signedPercent(d.lead, fmt)})` : ''}</div>}
                    {gone && <div className="bp-card-foot">{s.change === 'combine' && s.into ? t('bp.change.into', { name: loc(view.byId.get(s.into)!.name, lang) }) : t('bp.change.removedNote')}</div>}
                  </div>
                </foreignObject>
              );
            })}

            {/* Bird's-eye: per phase, one block for outside parties and one for the company, never merged. */}
            {overview && layout.phases.map((p) => {
              const ph = view.phases.find((x) => x.id === p.id)!;
              const name = ph.name ? loc(ph.name, lang) : t('bp.phase.all');
              const fs = Math.max(13, 15 / k);
              const bands = (['external', 'internal'] as const).map((side) => {
                const ls = layout.lanes.filter((l) => l.side === side);
                return ls.length ? { side, top: ls[0]!.y, bottom: ls[ls.length - 1]!.y + ls[ls.length - 1]!.h } : null;
              }).filter((x): x is NonNullable<typeof x> => x !== null);
              const zoomIn = () => {
                moved();
                onLevel('steps');
                requestAnimationFrame(() => transformTo(TARGET_SCALE.steps, p.x + Math.min(p.w, size.w / TARGET_SCALE.steps) / 2, (GEO.headerH + layout.height) / 2));
              };
              return bands.map((band, bi) => {
                const sum = phaseSummary(view, p.id, drawState, band.side);
                const before = compare ? phaseSummary(view, p.id, 'asIs', band.side) : null;
                const rows = (
                  <>
                    {bi === 0 && <span className="bp-pb-name">{name}</span>}
                    <span className={`bp-side-tag is-${band.side}`}>{t(`bp.side.${band.side}`)}</span>
                    <span className="bp-pb-row">{t('bp.phase.steps', { n: sum.steps })}{sum.removed ? ` · ${t('bp.phase.removed', { n: sum.removed })}` : ''}{sum.added ? ` · ${t('bp.phase.added', { n: sum.added })}` : ''}</span>
                    {(sum.leadHours !== null || before?.leadHours != null) && <span className="bp-pb-row">{t('bp.phase.lead', { value: duration(sum.leadHours, t, fmt) })}{before ? ` ← ${duration(before.leadHours, t, fmt)}` : ''}</span>}
                    {sum.effortHours !== null && <span className="bp-pb-row">{t('bp.phase.effort', { value: hoursMonth(sum.effortHours, t, fmt) })}</span>}
                    {sum.loops > 0 && <span className="bp-pb-row">↻ {t('bp.phase.loops', { n: sum.loops })}</span>}
                  </>
                );
                return (
                  <foreignObject key={`ov-${p.id}-${band.side}`} x={p.x + 6} y={band.top + 4} width={p.w - 12} height={band.bottom - band.top - 8}>
                    {band.side === 'internal' ? (
                      <button type="button" className="bp-phase-block is-internal" style={{ fontSize: `${fs}px` }} data-testid={`bp-phase-${p.id}`} onClick={zoomIn}>
                        {bi > 0 && <span className="visually-hidden">{name}</span>}
                        {rows}
                        <span className="visually-hidden">{t('bp.phase.open')}</span>
                      </button>
                    ) : (
                      <div className="bp-phase-block is-external" style={{ fontSize: `${fs}px` }} data-testid={`bp-phase-${p.id}-external`}>{rows}</div>
                    )}
                  </foreignObject>
                );
              });
            })}          </g>
        </svg>
        {hover && <HoverCard id={cardId} target={hover} view={view} state={drawState} wrap={wrapRef.current} onEnter={() => window.clearTimeout(hideTimer.current)} onLeave={scheduleHide} />}
      </div>
      <Legend compare={compare} state={drawState} />
    </div>
  );
}

function Bars({ m, scale, muted = false }: { m: ReturnType<typeof metricsIn>; scale: (h: number) => number; muted?: boolean }) {
  if (!m) return <span className="bp-bar is-empty" />;
  const touch = (m.touchMin ?? 0) / 60, wait = m.waitH ?? 0, total = touch + wait;
  const w = scale(total) * 100;
  const tw = total > 0 ? (touch / total) * w : 0;
  return (
    <span className={`bp-bar ${muted ? 'is-muted' : ''}`}>
      <span className="bp-bar-touch" style={{ width: `${tw}%` }} />
      <span className="bp-bar-wait" style={{ width: `${w - tw}%` }} />
    </span>
  );
}

function DetailLines({ step, state, compare }: { step: PStep; state: ProcState; compare: boolean }) {
  const { t, fmt } = useI18n();
  const m = metricsIn(step, state);
  if (!m) return null;
  const io = `${t('bp.io.in', { n: step.inputs.length })} · ${t('bp.io.out', { n: step.outputs.length })}`;
  return (
    <div className="bp-card-lines">
      <span>{t('bp.detail.time', { touch: m.touchMin === null ? t('bp.unknown') : duration(m.touchMin / 60, t, fmt), wait: m.waitH === null ? t('bp.unknown') : duration(m.waitH, t, fmt) })}</span>
      <span>{t('bp.detail.volume', { volume: m.volume === null ? t('bp.unknown') : fmt.integer(m.volume), effort: hoursMonth(effortHours(m), t, fmt) })}</span>
      <span>{m.firstPass === null ? io : `${t('bp.detail.firstPass', { value: fmt.integer(m.firstPass) })} · ${io}`}</span>
      {compare && step.asIs && step.change !== 'keep' && <span className="bp-card-delta">{t('bp.detail.compare', { before: duration(leadHours(step.asIs), t, fmt), after: duration(leadHours(m), t, fmt) })}</span>}
    </div>
  );
}

function Legend({ compare, state }: { compare: boolean; state: ProcState }): ReactNode {
  const { t } = useI18n();
  return (
    <ul className="bp-legend" aria-label={t('bp.legend.title')}>
      <li><span className="bp-lg-line" aria-hidden /> {t('bp.legend.flow')}</li>
      <li><span className="bp-lg-line is-path" aria-hidden /> {t('bp.legend.path')}</li>
      <li><span className="bp-lg-line is-message" aria-hidden /> {t('bp.legend.message')}</li>
      <li><span className="bp-lg-line is-loop" aria-hidden /> {t('bp.legend.loop')}</li>
      <li><span className="bp-lg-bar" aria-hidden><span className="bp-bar-touch" /><span className="bp-bar-wait" /></span> {t('bp.legend.bar')}</li>
      {compare && <li><span className="bp-lg-bar is-muted" aria-hidden><span className="bp-bar-touch" /><span className="bp-bar-wait" /></span> {t('bp.legend.barBefore')}</li>}
      {state === 'toBe' && (['improve', 'combine', 'remove', 'new'] as const).map((c) => <li key={c}><span className={`bp-tag change-${c}`}>{t(`bp.change.${c}`)}</span></li>)}
      {state === 'toBe' && <li><span className="bp-lg-line is-ghost" aria-hidden /> {t('bp.legend.ghost')}</li>}
    </ul>
  );
}
