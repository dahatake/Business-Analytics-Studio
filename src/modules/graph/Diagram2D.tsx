import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useI18n } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import type { Scene, SceneEdge, SceneNode } from './scene.ts';
import { boundsOf, fitScale, layout2D, layoutForce, type Pos } from './layout.ts';
import { SEMANTIC_DASH } from './model.ts';
import { GraphNodeEl } from './GraphNodeEl.tsx';
import type { InfoCardData } from './InfoCard.tsx';

export const VB_W = 960;
export const VB_H = 600;

const SYMBOLS: Record<string, d3.SymbolType> = {
  circle: d3.symbolCircle, square: d3.symbolSquare, diamond: d3.symbolDiamond, triangle: d3.symbolTriangle, hexagon: d3.symbolStar, rect: d3.symbolSquare,
};

export interface ViewTransform {
  /** Drawing units → view-box units. */
  k: number;
  cx: number;
  cy: number;
  /** View-box units → CSS px, and letterbox offsets. */
  s: number;
  ox: number;
  oy: number;
}

/** Drawing coordinates → CSS px inside the svg element. */
export function toScreen(p: Pos, v: ViewTransform, pan: { x: number; y: number }): Pos {
  const vx = VB_W / 2 + (p.x - v.cx) * v.k;
  const vy = VB_H / 2 + (p.y - v.cy) * v.k;
  return { x: v.ox + vx * v.s + pan.x, y: v.oy + vy * v.s + pan.y };
}

export function edgeDash(e: SceneEdge): string {
  if (e.contains) return '';
  if (e.flow === 'data') return '6 3';
  if (e.flow === 'control') return '';
  if (e.twin) return '2 2';
  return e.semantic ? SEMANTIC_DASH[e.semantic] : '';
}

export function Diagram2D({ scene, format, zoom, pan, onPan, onZoomStep, highlight, centreRequest, card, onCard, onSelect, clusterAction }: {
  scene: Scene;
  format: '2d' | 'graph';
  zoom: number;
  pan: { x: number; y: number };
  onPan: (p: { x: number; y: number }) => void;
  onZoomStep: (dir: 1 | -1) => void;
  highlight: string | null;
  centreRequest: { id: string; n: number } | null;
  card: InfoCardData | null;
  onCard: (c: InfoCardData | null) => void;
  onSelect: (id: string) => void;
  clusterAction?: (node: SceneNode) => InfoCardData['action'];
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: VB_W, h: VB_H });
  const [active, setActive] = useState<string | null>(null);

  const pos = useMemo(() => (format === '2d' ? layout2D(scene) : layoutForce(scene)), [scene, format]);
  const useBoxes = format === '2d' && scene.view === 'spatial';
  const bounds = useMemo(() => boundsOf(useBoxes ? scene : { ...scene, nodes: scene.nodes.map((n) => ({ ...n, box: undefined })) }, pos), [scene, pos, useBoxes]);
  const fit = fitScale(bounds, VB_W, VB_H);
  const s = Math.min(size.w / VB_W, size.h / VB_H);
  const v: ViewTransform = { k: fit * zoom, cx: (bounds.x0 + bounds.x1) / 2, cy: (bounds.y0 + bounds.y1) / 2, s, ox: (size.w - VB_W * s) / 2, oy: (size.h - VB_H * s) / 2 };
  const u = 1 / (v.k * s); // drawing units per CSS px
  const vRef = useRef(v);
  vRef.current = v;
  const panRef = useRef(pan);
  panRef.current = pan;

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || VB_W, h: el.clientHeight || VB_H });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel zoom (non-passive so the page does not scroll).
  const zoomRef = useRef(onZoomStep);
  zoomRef.current = onZoomStep;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomRef.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  // FR-248: centre on a node requested from the table.
  const panCb = useRef(onPan);
  panCb.current = onPan;
  useEffect(() => {
    if (!centreRequest) return;
    const p = pos.get(centreRequest.id);
    if (!p) return;
    const vv = vRef.current;
    panCb.current({ x: (vv.cx - p.x) * vv.k * vv.s, y: (vv.cy - p.y) * vv.k * vv.s });
  }, [centreRequest, pos]);

  const order = useMemo(() => {
    const nodes = [...scene.nodes].sort((a, b) => a.lane - b.lane || (pos.get(a.id)?.x ?? 0) - (pos.get(b.id)?.x ?? 0) || (pos.get(a.id)?.y ?? 0) - (pos.get(b.id)?.y ?? 0)).map((n) => n.id);
    const edges = scene.edges.filter((e) => !(useBoxes && e.contains)).map((e) => e.id);
    return [...nodes, ...edges];
  }, [scene, pos, useBoxes]);
  const current = active && order.includes(active) ? active : order[0];

  const drag = useRef<{ x: number; y: number; px: number; py: number; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const target = e.target as Element;
    if (target !== svgRef.current && !target.classList.contains('graph2-bg')) return;
    drag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y, id: e.pointerId };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    onPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
  };
  const onPointerUp = () => { drag.current = null; };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const el = (e.target as Element).closest('[data-node-id],[data-edge-id]');
    if (!el) return;
    e.preventDefault();
    const id = el.getAttribute('data-node-id') ?? el.getAttribute('data-edge-id')!;
    const i = order.indexOf(id);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
    const nid = order[next]!;
    setActive(nid);
    const target = svgRef.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(nid)}"],[data-edge-id="${CSS.escape(nid)}"]`);
    target?.focus();
  };

  const screenOf = (p: Pos) => toScreen(p, v, pan);
  const nodeCard = (n: SceneNode, el: Element) => {
    if (card?.itemId === n.id) { onCard(null); return; }
    const p = screenOf(pos.get(n.id) ?? { x: 0, y: 0 });
    const sr = svgRef.current?.getBoundingClientRect();
    const stage = el.closest('.graph-stage')?.getBoundingClientRect();
    const dx = sr && stage ? sr.left - stage.left : 0, dy = sr && stage ? sr.top - stage.top : 0;
    onCard({ itemId: n.id, kind: 'node', title: n.label, rows: n.info, relations: n.relations, x: p.x + dx, y: p.y + dy, ...(clusterAction?.(n) ? { action: clusterAction(n) } : {}) });
  };
  const edgeCard = (e: SceneEdge, el: Element) => {
    if (card?.itemId === e.id) { onCard(null); return; }
    const a = pos.get(e.source), b = pos.get(e.target);
    const p = screenOf(a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 });
    const sr = svgRef.current?.getBoundingClientRect();
    const stage = el.closest('.graph-stage')?.getBoundingClientRect();
    const dx = sr && stage ? sr.left - stage.left : 0, dy = sr && stage ? sr.top - stage.top : 0;
    const rows = [{ label: t('graph.card.from'), value: scene.nodes.find((n) => n.id === e.source)?.label ?? e.source }, { label: t('graph.card.relation'), value: e.label }, { label: t('graph.card.to'), value: scene.nodes.find((n) => n.id === e.target)?.label ?? e.target }, ...e.info];
    onCard({ itemId: e.id, kind: 'edge', title: e.aria, rows, relations: e.members, x: p.x + dx, y: p.y + dy });
  };

  const transform = `translate(${VB_W / 2 + pan.x / s} ${VB_H / 2 + pan.y / s}) scale(${v.k}) translate(${-v.cx} ${-v.cy})`;
  const R = 11; // node radius in CSS px
  const labelled = (id: string) => scene.labelled.has(id) || id === highlight;

  return (
    <svg
      ref={svgRef}
      className={`graph2 graph2--${format} ${reduced ? 'graph2--still' : ''}`}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="group"
      aria-label={t('graph.diagram.aria', { nodes: scene.nodes.length, edges: scene.edges.length })}
      aria-describedby="graph-keys-help"
      data-testid="graph-svg"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <defs>
        <marker id="graph2-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M0,0 L10,5 L0,10 z" className="graph2-arrowhead" />
        </marker>
      </defs>
      <rect className="graph2-bg" x={0} y={0} width={VB_W} height={VB_H} />
      <g className="graph2-viewport" transform={transform} data-testid="graph-viewport">
        {format === '2d' && !useBoxes && scene.level !== 'overview' && <LaneCaptions scene={scene} pos={pos} u={u} />}
        <g className="graph2-edges">
          {scene.edges.filter((e) => !(useBoxes && e.contains)).map((e) => {
            const a = pos.get(e.source), b = pos.get(e.target);
            if (!a || !b) return null;
            const geo = edgeGeometry(a, b, e.parallel, R * u * 1.3);
            const sw = (e.bundled ? 2 + Math.log2(e.count) * 1.5 : e.twin || e.flow ? 2 : 1.4) * u;
            const isOpen = card?.itemId === e.id;
            return (
              <g
                key={e.id}
                className={`graph2-edge ${e.bundled ? 'is-bundle' : ''} ${e.twin ? 'is-twin' : ''} ${e.flow ? `is-flow-${e.flow}` : ''} ${e.contains ? 'is-contains' : ''} ${isOpen ? 'is-open' : ''}`}
                role="button"
                tabIndex={current === e.id ? 0 : -1}
                aria-label={e.aria}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                data-edge-id={e.id}
                onFocus={() => setActive(e.id)}
                onClick={(ev) => edgeCard(e, ev.currentTarget)}
                onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); edgeCard(e, ev.currentTarget); } if (ev.key === 'Escape' && isOpen) onCard(null); }}
              >
                <path className="graph2-edge-hit" d={geo.d} strokeWidth={14 * u} />
                <path className="graph2-edge-line" d={geo.d} strokeWidth={sw} strokeDasharray={edgeDash(e).split(' ').filter(Boolean).map((x) => Number(x) * u).join(' ')} markerEnd={e.bundled || e.contains ? undefined : 'url(#graph2-arrow)'} />
                {labelled(e.id) && (
                  <text className="graph2-edge-label" x={geo.mx} y={geo.my - 4 * u} fontSize={10 * u} textAnchor="middle">{e.label}</text>
                )}
              </g>
            );
          })}
        </g>
        <g className="graph2-nodes">
          {scene.nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const box = useBoxes ? n.box : undefined;
            const r = R * Math.min(2.2, Math.max(0.7, n.size)) * u;
            const cls = `graph2-node graph2-node--${n.role} ${n.id === highlight ? 'is-highlighted' : ''} ${n.id === scene.focusId ? 'is-focus' : ''} ${card?.itemId === n.id ? 'is-open' : ''}`;
            const transformN = box ? `translate(${box.x} ${box.y})` : `translate(${p.x} ${p.y})`;
            return (
              <GraphNodeEl
                key={n.id}
                node={n}
                transform={transformN}
                tabIndex={current === n.id ? 0 : -1}
                className={cls}
                onToggle={(el) => nodeCard(n, el)}
                onSelect={onSelect}
                onFocusItem={setActive}
              >
                {box ? (
                  <>
                    <rect className="graph2-area" width={box.w} height={box.h} rx={6 * u} strokeWidth={1.2 * u} />
                    {n.id === highlight && <rect className="graph2-halo-rect" width={box.w} height={box.h} rx={6 * u} strokeWidth={4 * u} />}
                    {n.entityId && <path d={d3.symbol(SYMBOLS[n.shape]!, Math.PI * (7 * u) ** 2)()!} transform={`translate(${10 * u} ${12 * u})`} fill={n.color} className="graph2-shape" />}
                    <clipPath id={clipId(n.id)}><rect width={box.w - 4 * u} height={box.h} /></clipPath>
                    <text className="graph2-area-label" x={(n.entityId ? 20 : 6) * u} y={16 * u} fontSize={11 * u} clipPath={`url(#${clipId(n.id)})`}>{n.label}</text>
                  </>
                ) : (
                  <>
                    {n.id === highlight && <circle className="graph2-halo" r={r + 8 * u} strokeWidth={3 * u} />}
                    <circle className="graph2-node-hit" r={Math.max(r, 13 * u)} />
                    {n.role === 'attribute' ? (
                      <rect className="graph2-attr" x={-r * 1.4} y={-r * 0.7} width={r * 2.8} height={r * 1.4} rx={3 * u} strokeWidth={1.2 * u} />
                    ) : (
                      <path className="graph2-shape" d={d3.symbol(SYMBOLS[n.shape]!, Math.PI * r * r)()!} fill={n.color} strokeWidth={(n.id === scene.focusId ? 3 : 1.5) * u} />
                    )}
                    {labelled(n.id) && !(useBoxes && n.lane === 4 && n.id !== highlight) && (
                      <text className="graph2-node-label" y={r + 13 * u} fontSize={11 * u} textAnchor="middle" strokeWidth={3 * u}>
                        {wrapLabel(n.label).map((line, i) => <tspan key={i} x={0} dy={i === 0 ? 0 : 13 * u}>{line}</tspan>)}
                      </text>
                    )}
                  </>
                )}
              </GraphNodeEl>
            );
          })}
        </g>
        {useBoxes && (
          <g className="graph2-kpis" aria-hidden="true">
            {scene.nodes.filter((n) => n.box && n.relations.length && (scene.level === 'overview' ? !!n.entityId : scene.level === 'element' && /:r\d+$/.test(n.id))).map((n) => n.relations.slice(0, 2).map((k, i) => {
              const chars = Math.max(6, Math.floor(n.box!.w / u / 5.6));
              return (
                <text key={`${n.id}-${k}`} className="graph2-kpi" x={n.box!.x + 6 * u} y={n.box!.y + n.box!.h - (6 + i * 13) * u} fontSize={9.5 * u}>{k.length > chars ? `${k.slice(0, chars - 1)}…` : k}</text>
              );
            }))}
          </g>
        )}
      </g>
    </svg>
  );
}

function LaneCaptions({ scene, pos, u }: { scene: Scene; pos: Map<string, Pos>; u: number }) {
  if (scene.level === 'detail') {
    return (
      <g className="graph2-lanes" aria-hidden="true">
        {scene.lanes.map((l) => {
          const ys = scene.nodes.filter((n) => n.lane === l.lane).map((n) => pos.get(n.id)?.y ?? 0);
          const xs = scene.nodes.filter((n) => n.lane === l.lane).map((n) => pos.get(n.id)?.x ?? 0);
          if (!ys.length) return null;
          return <text key={l.lane} className="graph2-lane-label" x={xs[0]} y={Math.min(...ys) - 28 * u} fontSize={12 * u} textAnchor="middle">{l.label}</text>;
        })}
      </g>
    );
  }
  return (
    <g className="graph2-lanes" aria-hidden="true">
      {scene.lanes.map((l) => {
        const pts = scene.nodes.filter((n) => n.lane === l.lane).map((n) => pos.get(n.id)).filter((p): p is Pos => !!p);
        if (!pts.length) return null;
        const x = Math.min(...pts.map((p) => p.x)) - 40 * u, y = Math.min(...pts.map((p) => p.y)) - 26 * u;
        return <text key={l.lane} className="graph2-lane-label" x={x} y={y} fontSize={12 * u}>{l.label}</text>;
      })}
    </g>
  );
}

/**
 * Split a long label over two lines without changing its text: an English line keeps its trailing space, so the
 * concatenated visible text still equals the accessible name (WCAG 2.5.3).
 */
export function wrapLabel(text: string, max = 20): string[] {
  if (text.length <= max) return [text];
  const mid = Math.floor(text.length / 2);
  const spaces = [...text.matchAll(/ /g)].map((m) => m.index ?? 0).filter((i) => i > 0 && i < text.length - 1);
  if (spaces.length) {
    const at = spaces.reduce((best, i) => (Math.abs(i - mid) < Math.abs(best - mid) ? i : best), spaces[0]!);
    return [text.slice(0, at + 1), text.slice(at + 1)];
  }
  const at = Math.ceil(text.length / 2);
  return [text.slice(0, at), text.slice(at)];
}

const clipId = (id: string) => `graph2-clip-${id.replace(/[^a-zA-Z0-9]/g, '-')}`;

function edgeGeometry(a: Pos, b: Pos, parallel: number, inset: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sx = a.x + ux * inset, sy = a.y + uy * inset;
  const ex = b.x - ux * inset, ey = b.y - uy * inset;
  if (parallel === 0) return { d: `M${sx},${sy} L${ex},${ey}`, mx: (sx + ex) / 2, my: (sy + ey) / 2 };
  const off = Math.ceil(parallel / 2) * 22 * (parallel % 2 ? 1 : -1);
  const cx = (sx + ex) / 2 - uy * off, cy = (sy + ey) / 2 + ux * off;
  return { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, mx: (sx + 2 * cx + ex) / 4, my: (sy + 2 * cy + ey) / 4 };
}
