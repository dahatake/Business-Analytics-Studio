import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { Engine, ORBIT_STEP, ZOOM_STEP, type SceneBuild } from './engine.ts';
import type { Quality, QualityChange } from './quality.ts';
import type { SceneModel, Vec3 } from './model.ts';

export interface SceneApi {
  orbit: (dAz: number, dPolar: number) => void;
  zoom: (factor: number) => void;
  home: () => void;
}

export interface OverlayLabel {
  id: string;
  text: string;
  lod: number;
  pos: Vec3;
}

interface Props {
  model: SceneModel;
  build: (m: SceneModel) => SceneBuild;
  selected: string | null;
  onPick: (id: string | null, anchor: HTMLElement) => void;
  labels: OverlayLabel[];
  reducedMotion: boolean;
  paused: boolean;
  cinematic: boolean;
  /** FR-067: depth of field requested (the engine still applies the enable rule). */
  dof: boolean;
  quality: Quality;
  autoQuality: boolean;
  onLod: (level: number) => void;
  onQuality: (q: Quality, change: QualityChange) => void;
  onError: () => void;
  apiRef: MutableRefObject<SceneApi | null>;
  label: string;
  describedBy: string;
  minimapLabel: string;
}

declare global {
  interface Window {
    /** E2E diagnostics hook (FR-146 click accuracy, FR-147 first frame). */
    __basTd?: {
      project: (id: string) => { x: number; y: number } | null;
      pick: (x: number, y: number) => string | null;
      diag: () => Engine['diag'];
      pose: () => Engine['pose'];
    };
  }
}

const DRAG_PX = 5;

/** The three.js viewport: canvas sized by its container, overlay labels, minimap, pointer/keyboard camera control. */
export function SceneView(props: Props) {
  const { model, build, selected, onPick, labels, reducedMotion, paused, cinematic, dof, quality, autoQuality, apiRef } = props;
  const [openedAt] = useState(() => performance.now());
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const camRef = useRef<SVGGElement>(null);
  const cb = useRef(props);
  cb.current = props;
  const firstModel = useRef(true);

  const bounds = minimapBounds(model);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const miniObjects = model.objects.filter((o) => o.lod === 0);

  useLayoutEffect(() => {
    // A fresh canvas per engine: a disposed renderer loses its context, so a canvas is never reused.
    const canvas = document.createElement('canvas');
    canvas.className = 'td-canvas';
    canvas.dataset.testid = 'td-canvas';
    wrapRef.current!.prepend(canvas);
    canvasRef.current = canvas;
    let engine: Engine;
    try {
      engine = new Engine({
        canvas, model, build, openedAt, reducedMotion, paused, cinematic, dof, quality, autoQuality,
        onLod: (l) => cb.current.onLod(l),
        onQuality: (q, c) => cb.current.onQuality(q, c),
        onFrame: () => onFrame(),
      });
    } catch {
      canvas.remove();
      cb.current.onError();
      return;
    }
    engineRef.current = engine;
    engine.setSelected(selected);
    if (selected) engine.focus(selected);
    onFrame();
    apiRef.current = {
      orbit: (a, p) => engine.orbit(a, p),
      zoom: (f) => engine.zoom(f),
      home: () => engine.focus(null),
    };
    const hook = {
      project: (id: string) => engine.projectObject(id),
      pick: (x: number, y: number) => engine.pick(x, y),
      diag: () => ({ ...engine.diag }),
      pose: () => ({ ...engine.pose }),
    };
    window.__basTd = hook;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) engine.resize(r.width, r.height);
    });
    ro.observe(wrapRef.current!);
    return () => {
      ro.disconnect();
      engine.dispose();
      canvas.remove();
      engineRef.current = null;
      canvasRef.current = null;
      apiRef.current = null;
      if (window.__basTd === hook) delete window.__basTd;
    };
    // The engine lives as long as the view; later prop changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (firstModel.current) {
      firstModel.current = false;
      return;
    }
    const e = engineRef.current;
    if (!e) return;
    e.setModel(model, build);
    e.setSelected(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, build]);

  const lastSelected = useRef(selected);
  useEffect(() => {
    const e = engineRef.current;
    if (!e || lastSelected.current === selected) return;
    lastSelected.current = selected;
    e.setSelected(selected);
    e.focus(selected);
  }, [selected]);

  useEffect(() => {
    engineRef.current?.setOptions({ reducedMotion, paused, cinematic, dof });
  }, [reducedMotion, paused, cinematic, dof]);

  useEffect(() => {
    engineRef.current?.setQualityPreset(quality, autoQuality);
  }, [quality, autoQuality]);

  useEffect(() => {
    engineRef.current?.invalidate();
  }, [labels]);

  function onFrame() {
    const e = engineRef.current;
    const canvas = canvasRef.current;
    if (!e || !canvas) return;
    const d = e.diag;
    setAttr(canvas, 'data-first-frame-ms', d.firstFrameMs);
    setAttr(canvas, 'data-fps', d.fps);
    setAttr(canvas, 'data-quality', d.quality);
    setAttr(canvas, 'data-lod', d.lod);
    setAttr(canvas, 'data-pixel-ratio', d.pixelRatio);
    setAttr(canvas, 'data-rendered', d.rendered);
    setAttr(canvas, 'data-fly-ms', d.lastFlyMs);
    setAttr(canvas, 'data-animated-flights', d.animatedFlights);
    setAttr(canvas, 'data-frames', d.frames);
    setAttr(canvas, 'data-dof', d.dof ? 'on' : 'off');
    const wrap = wrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      for (const l of labelsRef.current) {
        const el = labelEls.current.get(l.id);
        if (!el) continue;
        const p = d.lod >= l.lod ? e.projectWorld(l.pos) : null;
        if (!p) {
          if (el.style.display !== 'none') el.style.display = 'none';
          continue;
        }
        const x = p.x - rect.left;
        const y = p.y - rect.top;
        const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
        el.style.display = inside ? '' : 'none';
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    const cam = camRef.current;
    if (cam) {
      const c = e.cameraTopDown();
      const [mx, my] = toMini(boundsRef.current, c.tx, c.tz);
      const angle = (Math.atan2(c.tx - c.x, c.tz - c.z) * 180) / Math.PI;
      cam.setAttribute('transform', `translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${(-angle + 180).toFixed(1)})`);
    }
  }

  // Pointer: drag to orbit (shift / right button pans), click to pick (FR-146: hit test uses the canvas rect).
  const press = useRef<{ x: number; y: number; moved: boolean; pan: boolean; id: number } | null>(null);
  const onPointerDown = (ev: React.PointerEvent) => {
    press.current = { x: ev.clientX, y: ev.clientY, moved: false, pan: ev.shiftKey || ev.button === 2, id: ev.pointerId };
  };
  const onPointerMove = (ev: React.PointerEvent) => {
    const p = press.current;
    const e = engineRef.current;
    if (!p || !e || p.id !== ev.pointerId) return;
    const dx = ev.clientX - p.x;
    const dy = ev.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!p.moved) {
      p.moved = true;
      (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    }
    if (p.pan) e.pan(dx, dy);
    else e.orbit(-dx * 0.008, -dy * 0.006);
    p.x = ev.clientX;
    p.y = ev.clientY;
  };
  const onPointerUp = (ev: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    const e = engineRef.current;
    if (!p || !e || p.moved || ev.button === 2) return;
    const id = e.pick(ev.clientX, ev.clientY);
    const anchor = anchorRef.current;
    const wrap = wrapRef.current;
    if (anchor && wrap) {
      const r = wrap.getBoundingClientRect();
      anchor.style.left = `${ev.clientX - r.left}px`;
      anchor.style.top = `${ev.clientY - r.top}px`;
      onPick(id, anchor);
    }
  };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      engineRef.current?.zoom(ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const e = engineRef.current;
    if (!e) return;
    const handled = (() => {
      switch (ev.key) {
        case 'ArrowLeft': e.orbit(-ORBIT_STEP, 0); return true;
        case 'ArrowRight': e.orbit(ORBIT_STEP, 0); return true;
        case 'ArrowUp': e.orbit(0, -ORBIT_STEP / 2); return true;
        case 'ArrowDown': e.orbit(0, ORBIT_STEP / 2); return true;
        case '+': case '=': case 'Add': e.zoom(ZOOM_STEP); return true;
        case '-': case '_': case 'Subtract': e.zoom(1 / ZOOM_STEP); return true;
        case 'Home': e.focus(null); return true;
        default: return false;
      }
    })();
    if (handled) ev.preventDefault();
  };

  return (
    <div
      ref={wrapRef}
      className="td-viewport"
      tabIndex={0}
      role="application"
      aria-label={props.label}
      aria-describedby={props.describedBy}
      data-testid="td-viewport"
      data-selected={selected ?? ''}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { press.current = null; }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <div className="td-labels" aria-hidden="true">
        {labels.map((l) => (
          <div
            key={l.id}
            className={`td-label${l.id === selected ? ' selected' : ''}`}
            style={{ display: 'none' }}
            ref={(el) => { if (el) labelEls.current.set(l.id, el); else labelEls.current.delete(l.id); }}
          >
            {l.text}
          </div>
        ))}
      </div>
      <span ref={anchorRef} className="td-anchor" aria-hidden="true" />
      <svg className="td-minimap" viewBox="0 0 120 90" role="img" aria-label={props.minimapLabel}>
        <rect x="0" y="0" width="120" height="90" rx="6" className="td-minimap-bg" />
        {miniObjects.map((o) => {
          const [x, y] = toMini(bounds, o.position[0], o.position[2]);
          return <circle key={o.id} cx={x} cy={y} r={o.id === selected ? 3.2 : o.level === 0 ? 0 : 2} className={o.id === selected ? 'td-mini-sel' : 'td-mini-dot'} />;
        })}
        <g ref={camRef}>
          <path d="M0 -7 L5 5 L0 2 L-5 5 Z" className="td-mini-cam" />
        </g>
      </svg>
    </div>
  );
}

function setAttr(el: Element, name: string, v: string | number | null) {
  const s = v === null ? '' : String(v);
  if (el.getAttribute(name) !== s) el.setAttribute(name, s);
}

interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

function minimapBounds(model: SceneModel): Bounds {
  const xs = model.objects.map((o) => o.position[0]);
  const zs = model.objects.map((o) => o.position[2]);
  const pad = 4;
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
}

function toMini(b: Bounds, x: number, z: number): [number, number] {
  const sx = 110 / Math.max(1, b.maxX - b.minX);
  const sz = 80 / Math.max(1, b.maxZ - b.minZ);
  const s = Math.min(sx, sz);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const px = 60 + (x - cx) * s;
  const pz = 45 + (z - cz) * s;
  return [Math.min(116, Math.max(4, px)), Math.min(86, Math.max(4, pz))];
}
