/**
 * FR-087 / FR-095: the interactive ink surface.
 * - Pointer Events for pen, touch and mouse: pressure-sensitive width, the pen's eraser button, palm rejection
 *   (touch is ignored while a pen is in contact), two-finger pan/zoom, Space/middle-button drag, wheel and Ctrl+wheel.
 * - Committed strokes are rendered once into the base bitmap; a new stroke is drawn incrementally on a separate live
 *   layer, so the per-frame cost does not depend on the number of strokes (PARAM-009 / PARAM-010).
 *   Panning reuses a snapshot of the base bitmap and re-renders once the view settles.
 */
import { makeStroke, newId, type Box, type Stroke } from './model.ts';
import { drawSegments, drawStroke, renderStrokes, type View } from './render.ts';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'eraserPartial' | 'lasso' | 'link';

export interface ToolState {
  tool: Tool;
  color: string;
  width: number;
  highlighterColor: string;
  highlighterWidth: number;
  /** Eraser radius in CSS px. */
  eraserRadius: number;
}

export interface SurfaceHost {
  strokes(): Stroke[];
  tool(): ToolState;
  commitStroke(s: Stroke): void;
  erase(path: number[], radius: number, partial: boolean): void;
  lasso(poly: number[]): void;
  /** Bounding box of the current selection (world), or null. */
  selectionBox(): Box | null;
  selectedStrokes(): Stroke[];
  moveSelection(dx: number, dy: number, final: boolean): void;
  onView?(v: View): void;
  /** Any pointer down on the surface (focus, deselect items, …). */
  onPointerDown?(): void;
}

export interface FrameStats {
  /** Work per animation frame while drawing (pointer handling + rendering), ms. */
  cost: number[];
  /** Interval between animation frames while drawing, ms. */
  interval: number[];
}

type Gesture =
  | { kind: 'draw'; id: number; type: string; stroke: Stroke; drawn: number }
  | { kind: 'erase'; id: number; path: number[]; partial: boolean }
  | { kind: 'lasso'; id: number; poly: number[] }
  | { kind: 'move'; id: number; sx: number; sy: number; dx: number; dy: number; strokes: Stroke[] }
  | { kind: 'pan'; id: number; lx: number; ly: number }
  | { kind: 'pinch'; a: number; b: number; dist: number; cx: number; cy: number; view: View };

/** Touch arriving this soon after the pen lifts is treated as the palm. */
export const PALM_GRACE_MS = 300;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export class InkSurface {
  view: View = { x: 0, y: 0, zoom: 1 };
  readonly stats: FrameStats = { cost: [], interval: [] };
  private renderedView: View = { x: 0, y: 0, zoom: 1 };
  private snapshot: HTMLCanvasElement | null = null;
  private settleTimer = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private rejected = new Set<number>();
  private penDown = false;
  private penUpAt = -Infinity;
  private spaceDown = false;
  private gesture: Gesture | null = null;
  private raf = 0;
  private lastFrameAt = 0;
  private pendingWork = 0;
  private hidden: Set<string> | null = null;
  private needsFull = true;
  private inkColor = '#000';
  private ro: ResizeObserver | null = null;
  private cleanup: (() => void)[] = [];
  /** Duration of the last full re-render of committed strokes (ms). */
  lastFullRenderMs = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly base: HTMLCanvasElement,
    private readonly live: HTMLCanvasElement,
    private readonly host: SurfaceHost,
    private readonly opts: { fixedView?: boolean } = {},
  ) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      root.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => root.removeEventListener(type, fn as EventListener, o));
    };
    on('pointerdown', (e) => this.down(e));
    on('pointermove', (e) => this.move(e));
    on('pointerup', (e) => this.up(e, false));
    on('pointercancel', (e) => this.up(e, true));
    on('lostpointercapture', (e) => {
      if (this.gesture && 'id' in this.gesture && this.gesture.id === e.pointerId) this.up(e, false);
    });
    on('wheel', (e) => this.wheel(e), { passive: false });
    on('keydown', (e) => {
      if (e.code === 'Space' && e.target === root) {
        this.spaceDown = true;
        e.preventDefault();
      }
    });
    on('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
    on('contextmenu', (e) => {
      if (this.gesture) e.preventDefault();
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.settleTimer);
    this.ro?.disconnect();
    this.cleanup.forEach((f) => f());
  }

  get drawing(): boolean {
    return this.gesture?.kind === 'draw';
  }

  // ---------- coordinates & view ----------

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.view.x) / this.view.zoom, y: (sy - this.view.y) / this.view.zoom };
  }

  get size(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  /** World point at the centre of the viewport. */
  center(): { x: number; y: number } {
    return this.toWorld(this.w / 2, this.h / 2);
  }

  setView(v: View): void {
    if (this.opts.fixedView) return;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
    this.view = { x: v.x, y: v.y, zoom };
    this.host.onView?.(this.view);
    this.viewChanged();
  }

  panBy(dx: number, dy: number): void {
    this.setView({ ...this.view, x: this.view.x + dx, y: this.view.y + dy });
  }

  zoomAt(factor: number, sx = this.w / 2, sy = this.h / 2): void {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.zoom * factor));
    const k = zoom / this.view.zoom;
    this.setView({ zoom, x: sx - (sx - this.view.x) * k, y: sy - (sy - this.view.y) * k });
  }

  /** Fit a world box into the viewport. */
  fit(box: Box | null): void {
    if (!box || !this.w || !this.h) {
      this.setView({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const pad = 40;
    const bw = Math.max(1, box.maxX - box.minX);
    const bh = Math.max(1, box.maxY - box.minY);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh, 1.5)));
    this.setView({ zoom, x: (this.w - bw * zoom) / 2 - box.minX * zoom, y: (this.h - bh * zoom) / 2 - box.minY * zoom });
  }

  private viewChanged(): void {
    if (!this.snapshot && !this.needsFull) {
      const snap = document.createElement('canvas');
      snap.width = this.base.width;
      snap.height = this.base.height;
      snap.getContext('2d')!.drawImage(this.base, 0, 0);
      this.snapshot = snap;
    }
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.needsFull = true;
      this.schedule();
    }, 140);
    this.schedule();
  }

  private resize(): void {
    const r = this.root.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    for (const c of [this.base, this.live]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
      c.style.width = `${this.w}px`;
      c.style.height = `${this.h}px`;
    }
    this.invalidate();
  }

  // ---------- content updates ----------

  /** Content changed in a way that needs a full re-render (undo, erase, move, load). */
  invalidate(): void {
    this.needsFull = true;
    this.schedule();
  }

  /** A stroke was appended: draw just that stroke on the base bitmap. */
  appendStroke(s: Stroke): void {
    if (this.needsFull || this.snapshot) {
      this.invalidate();
      return;
    }
    const ctx = this.base.getContext('2d')!;
    const v = this.renderedView;
    ctx.setTransform(this.dpr * v.zoom, 0, 0, this.dpr * v.zoom, this.dpr * v.x, this.dpr * v.y);
    drawStroke(ctx, s, this.inkColor);
    this.schedule();
  }

  setHidden(ids: Set<string> | null): void {
    this.hidden = ids;
    this.invalidate();
  }

  /** Redraw the live layer (selection box changes). */
  refreshOverlay(): void {
    this.schedule();
  }

  // ---------- frames ----------

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    const t0 = performance.now();
    if (this.needsFull) {
      this.inkColor = getComputedStyle(this.root).color || '#000';
      const r0 = performance.now();
      renderStrokes(this.base.getContext('2d')!, this.host.strokes(), this.view, this.w, this.h, this.dpr, this.inkColor, this.hidden ?? undefined);
      this.lastFullRenderMs = performance.now() - r0;
      this.renderedView = this.view;
      this.snapshot = null;
      this.needsFull = false;
    } else if (this.snapshot) {
      const ctx = this.base.getContext('2d')!;
      const r = this.renderedView;
      const k = this.view.zoom / r.zoom;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.base.width, this.base.height);
      ctx.setTransform(k, 0, 0, k, this.dpr * (this.view.x - r.x * k), this.dpr * (this.view.y - r.y * k));
      ctx.drawImage(this.snapshot, 0, 0);
    }
    this.renderLive();
    const g = this.gesture;
    if (g?.kind === 'draw') {
      this.stats.cost.push(this.pendingWork + (performance.now() - t0));
      if (this.lastFrameAt) this.stats.interval.push(now - this.lastFrameAt);
      this.lastFrameAt = now;
    } else this.lastFrameAt = 0;
    this.pendingWork = 0;
  }

  private liveCtx(clear: boolean): CanvasRenderingContext2D {
    const ctx = this.live.getContext('2d')!;
    if (clear) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
    }
    const v = this.view;
    ctx.setTransform(this.dpr * v.zoom, 0, 0, this.dpr * v.zoom, this.dpr * v.x, this.dpr * v.y);
    return ctx;
  }

  private renderLive(): void {
    const g = this.gesture;
    if (g?.kind === 'draw') {
      if (g.stroke.tool === 'highlighter') {
        drawStroke(this.liveCtx(true), g.stroke, this.inkColor);
      } else {
        const ctx = this.liveCtx(g.drawn === 0);
        const n = g.stroke.points.length / 3;
        if (n === 1 && g.drawn === 0) drawStroke(ctx, g.stroke, this.inkColor);
        else drawSegments(ctx, g.stroke, Math.max(1, g.drawn), this.inkColor);
        g.drawn = n;
      }
      return;
    }
    const ctx = this.liveCtx(true);
    const z = this.view.zoom;
    if (g?.kind === 'erase' && g.path.length >= 2) {
      ctx.strokeStyle = 'rgba(128,128,128,0.45)';
      ctx.lineWidth = (this.host.tool().eraserRadius * 2) / z;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(g.path[0]!, g.path[1]!);
      for (let i = 2; i < g.path.length; i += 2) ctx.lineTo(g.path[i]!, g.path[i + 1]!);
      if (g.path.length === 2) ctx.lineTo(g.path[0]! + 0.01, g.path[1]!);
      ctx.stroke();
    }
    if (g?.kind === 'lasso' && g.poly.length >= 4) {
      ctx.strokeStyle = this.inkColor;
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.beginPath();
      ctx.moveTo(g.poly[0]!, g.poly[1]!);
      for (let i = 2; i < g.poly.length; i += 2) ctx.lineTo(g.poly[i]!, g.poly[i + 1]!);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (g?.kind === 'move') {
      ctx.translate(g.dx, g.dy);
      for (const s of g.strokes) drawStroke(ctx, s, this.inkColor);
      ctx.translate(-g.dx, -g.dy);
    }
    const box = this.host.selectionBox();
    if (box && g?.kind !== 'lasso') {
      const dx = g?.kind === 'move' ? g.dx : 0;
      const dy = g?.kind === 'move' ? g.dy : 0;
      ctx.strokeStyle = '#3e8ef7';
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([5 / z, 3 / z]);
      ctx.strokeRect(box.minX - 4 / z + dx, box.minY - 4 / z + dy, box.maxX - box.minX + 8 / z, box.maxY - box.minY + 8 / z);
      ctx.setLineDash([]);
    }
  }

  // ---------- input ----------

  private isPenEraser(e: PointerEvent): boolean {
    return e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) === 32);
  }

  private down(e: PointerEvent): void {
    const target = e.target as Element | null;
    if (target?.closest('[data-ink-item]')) return;
    const t0 = performance.now();
    if (e.pointerType === 'touch' && (this.penDown || t0 - this.penUpAt < PALM_GRACE_MS)) {
      this.rejected.add(e.pointerId);
      return;
    }
    if (e.pointerType === 'pen') {
      this.penDown = true;
      // The palm may have touched first: drop any touch gesture in progress.
      if (this.gesture && 'id' in this.gesture && this.pointers.get(this.gesture.id)?.type === 'touch') this.cancelGesture();
      if (this.gesture?.kind === 'pinch') this.gesture = null;
    }
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, type: e.pointerType });
    this.host.onPointerDown?.();
    if (document.activeElement !== this.root && !this.root.contains(document.activeElement)) this.root.focus({ preventScroll: true });
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }

    const touches = [...this.pointers.entries()].filter(([, v]) => v.type === 'touch');
    if (e.pointerType === 'touch' && touches.length >= 2 && !this.opts.fixedView) {
      this.cancelGesture();
      const [a, b] = touches;
      this.gesture = {
        kind: 'pinch', a: a![0], b: b![0],
        dist: Math.hypot(a![1].x - b![1].x, a![1].y - b![1].y) || 1,
        cx: (a![1].x + b![1].x) / 2, cy: (a![1].y + b![1].y) / 2, view: this.view,
      };
      return;
    }
    if (this.gesture) return;
    const w = this.toWorld(p.x, p.y);
    const ts = this.host.tool();
    if (!this.opts.fixedView && (e.button === 1 || (this.spaceDown && e.button === 0))) {
      this.gesture = { kind: 'pan', id: e.pointerId, lx: p.x, ly: p.y };
    } else if (this.isPenEraser(e) || ts.tool === 'eraser' || ts.tool === 'eraserPartial') {
      if (e.button !== 0 && !this.isPenEraser(e)) return;
      this.gesture = { kind: 'erase', id: e.pointerId, path: [w.x, w.y], partial: ts.tool === 'eraserPartial' && !this.isPenEraser(e) };
    } else if (e.button !== 0) {
      return;
    } else if (ts.tool === 'lasso') {
      const box = this.host.selectionBox();
      if (box && w.x >= box.minX - 6 && w.x <= box.maxX + 6 && w.y >= box.minY - 6 && w.y <= box.maxY + 6) {
        const strokes = this.host.selectedStrokes();
        this.gesture = { kind: 'move', id: e.pointerId, sx: w.x, sy: w.y, dx: 0, dy: 0, strokes };
        this.setHidden(new Set(strokes.map((s) => s.id)));
      } else this.gesture = { kind: 'lasso', id: e.pointerId, poly: [w.x, w.y] };
    } else if (ts.tool === 'pen' || ts.tool === 'highlighter') {
      const hl = ts.tool === 'highlighter';
      const pressure = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      const stroke = makeStroke(hl ? 'highlighter' : 'pen', hl ? ts.highlighterColor : ts.color, hl ? ts.highlighterWidth : ts.width, [w.x, w.y, pressure], newId('s'));
      this.gesture = { kind: 'draw', id: e.pointerId, type: e.pointerType, stroke, drawn: 0 };
      this.lastFrameAt = 0;
    }
    this.pendingWork += performance.now() - t0;
    this.schedule();
  }

  private move(e: PointerEvent): void {
    if (this.rejected.has(e.pointerId)) return;
    const t0 = performance.now();
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    const p = this.local(e);
    ptr.x = p.x;
    ptr.y = p.y;
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      const a = this.pointers.get(g.a);
      const b = this.pointers.get(g.b);
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.view.zoom * (dist / g.dist)));
      const k = zoom / g.view.zoom;
      this.setView({ zoom, x: cx - (g.cx - g.view.x) * k, y: cy - (g.cy - g.view.y) * k });
      return;
    }
    if (g.id !== e.pointerId) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    if (g.kind === 'pan') {
      this.panBy(p.x - g.lx, p.y - g.ly);
      g.lx = p.x;
      g.ly = p.y;
      return;
    }
    for (const ev of list) {
      const lp = ev === e ? p : this.local(ev);
      const w = this.toWorld(lp.x, lp.y);
      if (g.kind === 'draw') {
        const pts = g.stroke.points;
        const lx = pts[pts.length - 3]!;
        const ly = pts[pts.length - 2]!;
        if (Math.hypot(w.x - lx, w.y - ly) * this.view.zoom < 0.75) continue;
        const pressure = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5;
        pts.push(w.x, w.y, pressure);
      } else if (g.kind === 'erase') g.path.push(w.x, w.y);
      else if (g.kind === 'lasso') g.poly.push(w.x, w.y);
      else if (g.kind === 'move') {
        g.dx = w.x - g.sx;
        g.dy = w.y - g.sy;
      }
    }
    if (g.kind === 'move') this.host.moveSelection(g.dx, g.dy, false);
    this.pendingWork += performance.now() - t0;
    this.schedule();
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    if (this.rejected.delete(e.pointerId)) return;
    if (e.pointerType === 'pen') {
      this.penDown = false;
      this.penUpAt = performance.now();
    }
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (g.a === e.pointerId || g.b === e.pointerId) this.gesture = null;
      return;
    }
    if (g.id !== e.pointerId) return;
    this.gesture = null;
    if (cancelled && g.kind !== 'pan') {
      if (g.kind === 'move') {
        this.host.moveSelection(0, 0, false);
        this.setHidden(null);
      }
      this.schedule();
      return;
    }
    if (g.kind === 'draw') {
      const s = g.stroke;
      this.host.commitStroke(makeStroke(s.tool, s.color, s.width, s.points, s.id));
    } else if (g.kind === 'erase') {
      this.host.erase(g.path, this.host.tool().eraserRadius / this.view.zoom, g.partial);
    } else if (g.kind === 'lasso') {
      this.host.lasso(g.poly);
    } else if (g.kind === 'move') {
      this.hidden = null;
      this.host.moveSelection(g.dx, g.dy, true);
      this.invalidate();
    }
    this.schedule();
  }

  private cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (g?.kind === 'move') {
      this.host.moveSelection(0, 0, false);
      this.setHidden(null);
    }
    this.schedule();
  }

  private wheel(e: WheelEvent): void {
    if (this.opts.fixedView) return;
    e.preventDefault();
    const p = this.local(e);
    if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * 0.0025), p.x, p.y);
    else this.panBy(-e.deltaX, -e.deltaY);
  }

  /** Diagnostics: frame statistics while drawing. */
  frameStats() {
    return {
      samples: this.stats.cost.length,
      p95: percentile(this.stats.cost, 95),
      avg: this.stats.cost.reduce((a, b) => a + b, 0) / Math.max(1, this.stats.cost.length),
      max: Math.max(0, ...this.stats.cost),
      intervalP95: percentile(this.stats.interval, 95),
      fullRenderMs: this.lastFullRenderMs,
    };
  }

  resetStats(): void {
    this.stats.cost.length = 0;
    this.stats.interval.length = 0;
  }
}
