import * as THREE from 'three';
import { dofActive, focusDistance } from './dof.ts';
import type { DofChain } from './postprocess.ts';
import { LodTracker, visibleAtLevel } from './lod.ts';
import { QUALITY_PRESETS, QualityController, type Quality, type QualityChange, type QualityPreset } from './quality.ts';
import { flyDurationMs, flyPose } from './flythrough.ts';
import { objectById, poseFor, type Pose, type SceneModel, type Vec3 } from './model.ts';

/** What a scene builder hands to the engine. */
export interface SceneBuild {
  root: THREE.Object3D;
  /** FR-036: nodes drawn only inside their LOD range. */
  lodNodes: { node: THREE.Object3D; min: number; max: number }[];
  /** Meshes that can be picked; `userData.tdId` is the scene object id. */
  pickables: THREE.Object3D[];
  /** Continuous animation (particles, work pieces); omitted for static scenes. */
  animate?: (timeSec: number) => void;
  setSelected: (id: string | null) => void;
  setQuality: (preset: QualityPreset, cinematic: boolean) => void;
}

export interface EngineDiagnostics {
  firstFrameMs: number | null;
  fps: number | null;
  quality: Quality;
  lod: number;
  pixelRatio: number;
  rendered: number;
  lastFlyMs: number;
  animatedFlights: number;
  frames: number;
  /** FR-067: depth of field is being drawn. */
  dof: boolean;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  model: SceneModel;
  build: (model: SceneModel) => SceneBuild;
  /** performance.now() when the view was opened (FR-147 first frame budget). */
  openedAt: number;
  reducedMotion: boolean;
  paused: boolean;
  cinematic: boolean;
  /** FR-067: the user asked for depth of field (off by default). */
  dof?: boolean;
  quality: Quality;
  autoQuality: boolean;
  onLod?: (level: number) => void;
  onQuality?: (q: Quality, change: QualityChange) => void;
  onFrame?: () => void;
}

const BG = 0x0b1322;
const POLAR_MIN = 0.12;
const POLAR_MAX = 1.48;
/** PARAM-057: one zoom step = 1.25×. */
export const ZOOM_STEP = 1.25;
export const ORBIT_STEP = Math.PI / 18;
const AUTO_ORBIT_RAD_PER_SEC = 0.05;
const FPS_WINDOW_MS = 500;

export function detectWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Minimal three.js host: camera orbit, render on demand, LOD, picking, fly-through, quality, diagnostics and disposal. */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  readonly diag: EngineDiagnostics;
  pose: Pose;
  private build: SceneBuild;
  private model: SceneModel;
  private lod: LodTracker;
  private readonly quality: QualityController;
  private raf = 0;
  private disposed = false;
  private flight: { from: Pose; to: Pose; start: number; ms: number } | null = null;
  private lastTime = 0;
  private fpsFrames = 0;
  private fpsStart = 0;
  private width = 1;
  private height = 1;
  private readonly raycaster = new THREE.Raycaster();
  private opts: EngineOptions;
  private animClock = 0;
  private selectedId: string | null = null;
  private post: DofChain | null = null;
  private postLoading = false;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.pose = { ...opts.model.home, target: [...opts.model.home.target] };
    this.quality = new QualityController(opts.quality, opts.autoQuality);
    const preset = QUALITY_PRESETS[opts.quality];
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: preset.antialias, powerPreference: 'high-performance' });
    this.renderer.setClearColor(BG, 1);
    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.Fog(BG, 90, 260);
    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x1a2230, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);
    this.lod = new LodTracker(opts.model.lodThresholds);
    this.build = opts.build(opts.model);
    this.scene.add(this.build.root);
    this.diag = { firstFrameMs: null, fps: null, quality: opts.quality, lod: 0, pixelRatio: 1, rendered: 0, lastFlyMs: 0, animatedFlights: 0, frames: 0, dof: false };
    this.applyQuality(opts.quality);
    const rect = opts.canvas.getBoundingClientRect();
    this.resize(rect.width, rect.height, false);
    this.frame(performance.now());
  }

  /** Swap the scene (e.g. AsIs ↔ ToBe) keeping the renderer and camera. */
  setModel(model: SceneModel, build: (m: SceneModel) => SceneBuild) {
    this.scene.remove(this.build.root);
    disposeTree(this.build.root);
    this.model = model;
    this.lod = new LodTracker(model.lodThresholds);
    this.build = build(model);
    this.scene.add(this.build.root);
    this.applyQuality(this.quality.current);
    this.invalidate();
  }

  setOptions(p: Partial<Pick<EngineOptions, 'reducedMotion' | 'paused' | 'cinematic' | 'dof'>>) {
    this.opts = { ...this.opts, ...p };
    if (this.opts.reducedMotion && this.flight) {
      this.pose = this.flight.to;
      this.flight = null;
    }
    this.build.setQuality(QUALITY_PRESETS[this.quality.current], this.cinematicOn());
    this.syncDof();
    this.invalidate();
  }

  setQualityPreset(q: Quality, auto: boolean) {
    this.quality.setPreset(q, auto);
    this.applyQuality(q);
  }

  private cinematicOn() {
    return this.opts.cinematic && !this.opts.reducedMotion;
  }

  private applyQuality(q: Quality) {
    const preset = QUALITY_PRESETS[q];
    this.diag.quality = q;
    const pr = Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap);
    this.renderer.setPixelRatio(pr);
    this.diag.pixelRatio = this.renderer.getPixelRatio();
    this.renderer.setSize(this.width, this.height, false);
    this.build.setQuality(preset, this.cinematicOn());
    this.syncDof();
    this.fpsFrames = 0;
    this.fpsStart = 0;
    this.invalidate();
  }

  /** FR-146: drawing buffer follows the container (CSS size is 100 % of the container). */
  resize(width: number, height: number, render = true) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.sizePost();
    if (render) this.renderNow();
  }

  private dofOn(): boolean {
    return dofActive(!!this.opts.dof, { quality: this.quality.current, cinematic: this.opts.cinematic, reducedMotion: this.opts.reducedMotion });
  }

  /**
   * FR-067: the post-process chain exists only while DOF is on (its code is loaded on first use, so the default path
   * and the first frame never pay for it); its render targets are released as soon as DOF is off.
   */
  private syncDof() {
    const on = this.dofOn();
    if (on && !this.post) void this.loadPost();
    else if (!on && this.post) this.disposePost();
    this.diag.dof = on && !!this.post;
  }

  private async loadPost() {
    if (this.postLoading) return;
    this.postLoading = true;
    try {
      const { createDofChain } = await import('./postprocess.ts');
      if (this.disposed || this.post || !this.dofOn()) return;
      this.post = createDofChain(this.renderer, this.scene, this.camera, this.pose.distance);
      this.sizePost();
      this.diag.dof = true;
      this.fpsFrames = 0;
      this.fpsStart = 0;
      this.renderNow();
    } catch {
      // DOF is optional: without it the view keeps rendering normally.
    } finally {
      this.postLoading = false;
    }
  }

  /** The composer follows the renderer's size and pixel ratio, so the canvas keeps the FR-146 1 px guarantee. */
  private sizePost() {
    this.post?.setSize(this.renderer.getPixelRatio(), this.width, this.height, this.camera.aspect);
  }

  private disposePost() {
    this.post?.dispose();
    this.post = null;
    this.diag.dof = false;
  }

  private focusPoint(): Vec3 {
    const obj = this.selectedId ? objectById(this.model, this.selectedId) : undefined;
    return obj ? obj.position : this.pose.target;
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    this.build.setSelected(id);
    this.invalidate();
  }

  /** FR-023: fly to an object (instant under reduced motion). */
  focus(id: string | null) {
    const obj = id ? objectById(this.model, id) : undefined;
    const to = obj ? poseFor(this.model, obj, this.pose) : { ...this.model.home, target: [...this.model.home.target] as Vec3 };
    this.flyTo(to);
  }

  flyTo(to: Pose) {
    const from = this.currentPose();
    const ms = flyDurationMs(from, to, this.opts.reducedMotion);
    this.diag.lastFlyMs = ms;
    if (ms === 0) {
      this.flight = null;
      this.pose = to;
      this.renderNow();
      return;
    }
    this.diag.animatedFlights++;
    this.flight = { from, to, start: performance.now(), ms };
    this.invalidate();
  }

  private currentPose(): Pose {
    return { ...this.pose, target: [...this.pose.target] };
  }

  orbit(dAzimuth: number, dPolar: number) {
    this.cancelFlight();
    this.pose = { ...this.pose, azimuth: this.pose.azimuth + dAzimuth, polar: clamp(this.pose.polar + dPolar, POLAR_MIN, POLAR_MAX) };
    this.invalidate();
  }

  zoom(factor: number) {
    this.cancelFlight();
    this.pose = { ...this.pose, distance: clamp(this.pose.distance / factor, this.model.minDistance, this.model.maxDistance) };
    this.invalidate();
  }

  pan(dx: number, dy: number) {
    this.cancelFlight();
    const s = this.pose.distance * 0.0015;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const fwd = new THREE.Vector3(Math.sin(this.pose.azimuth), 0, Math.cos(this.pose.azimuth));
    const t = new THREE.Vector3(...this.pose.target).addScaledVector(right, -dx * s).addScaledVector(fwd, -dy * s);
    this.pose = { ...this.pose, target: [t.x, t.y, t.z] };
    this.invalidate();
  }

  private cancelFlight() {
    if (this.flight) {
      this.flight = null;
    }
  }

  invalidate() {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  renderNow() {
    if (this.disposed) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.frame(performance.now());
  }

  private continuous(): boolean {
    if (this.flight) return true;
    if (this.opts.paused || this.opts.reducedMotion) return false;
    return !!this.build.animate || this.cinematicOn();
  }

  private readonly frame = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
    this.lastTime = now;
    if (this.flight) {
      const t = (now - this.flight.start) / this.flight.ms;
      this.pose = flyPose(this.flight.from, this.flight.to, t);
      if (t >= 1) this.flight = null;
    } else if (this.cinematicOn() && !this.opts.paused) {
      this.pose = { ...this.pose, azimuth: this.pose.azimuth + AUTO_ORBIT_RAD_PER_SEC * dt };
    }
    const moving = !this.opts.paused && !this.opts.reducedMotion;
    if (moving) this.animClock += dt;
    this.build.animate?.(this.animClock);
    this.applyCamera();
    this.updateLod();
    if (this.post) {
      const c = this.camera.position;
      const focus = focusDistance([c.x, c.y, c.z], this.focusPoint(), this.camera.near, this.camera.far);
      // The composer renders several times per frame: count the draw calls of all of its passes.
      this.renderer.info.autoReset = false;
      this.renderer.info.reset();
      this.post.render(focus, dt);
      this.renderer.info.autoReset = true;
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.diag.frames++;
    this.diag.rendered = this.renderer.info.render.calls;
    if (this.diag.firstFrameMs === null) this.diag.firstFrameMs = Math.round(performance.now() - this.opts.openedAt);
    const cont = this.continuous();
    this.measureFps(now, cont);
    this.opts.onFrame?.();
    if (cont) this.raf = requestAnimationFrame(this.frame);
    else this.lastTime = 0;
  };

  private measureFps(now: number, continuous: boolean) {
    if (!continuous) {
      this.fpsFrames = 0;
      this.fpsStart = 0;
      return;
    }
    if (!this.fpsStart) {
      this.fpsStart = now;
      this.fpsFrames = 0;
      return;
    }
    this.fpsFrames++;
    const elapsed = now - this.fpsStart;
    if (elapsed >= FPS_WINDOW_MS) {
      const fps = (this.fpsFrames * 1000) / elapsed;
      this.diag.fps = Math.round(fps);
      this.fpsStart = now;
      this.fpsFrames = 0;
      // A requested DOF still loading counts as on: it must be given up before the preset is lowered.
      const change = this.quality.sample(fps, now, this.dofOn());
      if (change?.reason === 'dofOff') {
        this.opts = { ...this.opts, dof: false };
        this.syncDof();
        this.fpsFrames = 0;
        this.fpsStart = 0;
        this.opts.onQuality?.(change.to, change);
      } else if (change) {
        this.applyQuality(change.to);
        this.opts.onQuality?.(change.to, change);
      }
    }
  }

  private applyCamera() {
    const { target, distance, azimuth, polar } = this.pose;
    const sp = Math.sin(polar);
    this.camera.position.set(target[0] + distance * sp * Math.sin(azimuth), target[1] + distance * Math.cos(polar), target[2] + distance * sp * Math.cos(azimuth));
    this.camera.lookAt(target[0], target[1], target[2]);
    this.camera.updateMatrixWorld();
  }

  /** FR-031/034/036: LOD follows the camera distance on every rendered frame (also when animation is stopped). */
  private updateLod() {
    const { level, changed } = this.lod.update(this.pose.distance);
    this.diag.lod = level;
    for (const { node, min, max } of this.build.lodNodes) node.visible = visibleAtLevel(level, min, max);
    if (changed) this.opts.onLod?.(level);
  }

  /** Object id under a client (CSS px) point, using the canvas's own rect (FR-146 click accuracy). */
  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.applyCamera();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.build.pickables, true);
    for (const h of hits) {
      if (!shown(h.object)) continue;
      const id = idOf(h.object);
      if (id) return id;
    }
    return null;
  }

  /** World point → client (CSS px) point; null when behind the camera. */
  projectWorld(p: Vec3 | THREE.Vector3): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = p instanceof THREE.Vector3 ? p.clone() : new THREE.Vector3(...p);
    v.project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  /** Screen point of the visible pickable mesh of an object (diagnostics for E2E click tests). */
  projectObject(id: string): { x: number; y: number } | null {
    const mesh = this.build.pickables.find((m) => idOf(m) === id && shown(m));
    if (!mesh) return null;
    const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    return this.projectWorld(center);
  }

  cameraTopDown(): { x: number; z: number; tx: number; tz: number } {
    return { x: this.camera.position.x, z: this.camera.position.z, tx: this.pose.target[0], tz: this.pose.target[2] };
  }

  dispose() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.disposePost();
    disposeTree(this.scene);
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function shown(o: THREE.Object3D): boolean {
  for (let cur: THREE.Object3D | null = o; cur; cur = cur.parent) if (!cur.visible) return false;
  return true;
}

function idOf(o: THREE.Object3D): string | null {
  for (let cur: THREE.Object3D | null = o; cur; cur = cur.parent) {
    const id = cur.userData.tdId as string | undefined;
    if (id) return id;
  }
  return null;
}

/** Release geometries, materials and textures of a subtree (GPU memory) — called on unmount. */
export function disposeTree(root: THREE.Object3D) {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => mats.add(x));
    else if (mat) mats.add(mat);
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => {
    for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
    m.dispose();
  });
}
