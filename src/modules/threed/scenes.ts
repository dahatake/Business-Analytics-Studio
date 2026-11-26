import * as THREE from 'three';
import type { SceneBuild } from './engine.ts';
import type { QualityPreset } from './quality.ts';
import type { SceneModel } from './model.ts';
import type { ArchScene, MapScene } from './models.ts';
import { getEntity } from '../../data/pack.ts';

/** Shared plumbing for the procedural scenes (FR-066). Everything is generated in code: no external assets (FR-068). */
class Kit {
  readonly root = new THREE.Group();
  readonly lodNodes: SceneBuild['lodNodes'] = [];
  readonly pickables: THREE.Object3D[] = [];
  readonly glows: THREE.Sprite[] = [];
  private readonly byId = new Map<string, THREE.Object3D[]>();
  private readonly highlight = new THREE.Box3Helper(new THREE.Box3(), 0xffd866);
  private glowTex: THREE.Texture | null = null;
  private readonly selGlow: THREE.Sprite;
  private readonly materials = new Map<string, THREE.Material>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  particleSetters: ((factor: number) => void)[] = [];
  private cinematic = false;
  private glowEnabled = false;

  constructor() {
    this.highlight.visible = false;
    this.root.add(this.highlight);
    this.selGlow = this.sprite(0xffd866, 1);
    this.selGlow.visible = false;
    this.root.add(this.selGlow);
  }

  lambert(color: number, opts: { opacity?: number; emissive?: number } = {}): THREE.Material {
    const key = `l-${color}-${opts.opacity ?? 1}-${opts.emissive ?? 0}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({
        color, emissive: opts.emissive ?? 0x000000,
        transparent: opts.opacity !== undefined && opts.opacity < 1, opacity: opts.opacity ?? 1,
        depthWrite: !(opts.opacity !== undefined && opts.opacity < 1),
      });
      this.materials.set(key, m);
    }
    return m;
  }

  basic(color: number, opacity = 1): THREE.MeshBasicMaterial {
    const key = `b-${color}-${opacity}`;
    let m = this.materials.get(key) as THREE.MeshBasicMaterial | undefined;
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
      this.materials.set(key, m);
    }
    return m;
  }

  line(color: number, opacity = 1): THREE.LineBasicMaterial {
    const key = `ln-${color}-${opacity}`;
    let m = this.materials.get(key) as THREE.LineBasicMaterial | undefined;
    if (!m) {
      m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
      this.materials.set(key, m);
    }
    return m;
  }

  geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
    let g = this.geometries.get(key);
    if (!g) {
      g = make();
      this.geometries.set(key, g);
    }
    return g as T;
  }

  box(w: number, h: number, d: number) {
    return this.geo(`box-${w}-${h}-${d}`, () => new THREE.BoxGeometry(w, h, d));
  }

  mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    return m;
  }

  add(node: THREE.Object3D, lod: [number, number] = [0, Infinity], id?: string, parent: THREE.Object3D = this.root) {
    parent.add(node);
    if (lod[0] > 0 || Number.isFinite(lod[1])) this.lodNodes.push({ node, min: lod[0], max: lod[1] });
    if (id) {
      node.userData.tdId = id;
      this.pickables.push(node);
      const list = this.byId.get(id) ?? [];
      list.push(node);
      this.byId.set(id, list);
    }
    return node;
  }

  private texture(): THREE.Texture {
    if (this.glowTex) return this.glowTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    this.glowTex = new THREE.CanvasTexture(c);
    return this.glowTex;
  }

  /** FR-067 bloom-like glow: an additive halo sprite (cheap, no post-processing pass). */
  sprite(color: number, scale: number): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture(), color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.setScalar(scale);
    s.raycast = () => {};
    return s;
  }

  glow(color: number, scale: number, x: number, y: number, z: number, lod: [number, number] = [0, Infinity]) {
    const s = this.sprite(color, scale);
    s.position.set(x, y, z);
    const holder = new THREE.Group();
    holder.add(s);
    this.add(holder, lod);
    this.glows.push(s);
    s.visible = this.glowEnabled;
  }

  finish(animate?: (t: number) => void): SceneBuild {
    return {
      root: this.root,
      lodNodes: this.lodNodes,
      pickables: this.pickables,
      animate,
      setSelected: (id) => {
        const nodes = id ? this.byId.get(id) : undefined;
        if (!nodes || nodes.length === 0) {
          this.highlight.visible = false;
          this.selGlow.visible = false;
          return;
        }
        this.root.updateMatrixWorld(true);
        const box = new THREE.Box3();
        nodes.forEach((n) => box.expandByObject(n));
        box.expandByScalar(0.25);
        this.highlight.box.copy(box);
        this.highlight.visible = true;
        const size = box.getSize(new THREE.Vector3());
        box.getCenter(this.selGlow.position);
        this.selGlow.scale.setScalar(Math.min(14, Math.max(size.x, size.y, size.z) * 1.8));
        this.selGlow.visible = this.cinematic && this.glowEnabled;
      },
      setQuality: (preset: QualityPreset, cinematic: boolean) => {
        this.cinematic = cinematic;
        this.glowEnabled = preset.glow && cinematic;
        this.glows.forEach((g) => { g.visible = this.glowEnabled; });
        if (!this.glowEnabled) this.selGlow.visible = false;
        else if (this.highlight.visible) this.selGlow.visible = true;
        this.particleSetters.forEach((f) => f(preset.particleFactor));
      },
    };
  }
}

const hueColor = (hue: number, s = 0.55, l = 0.55) => new THREE.Color().setHSL(hue / 360, s, l).getHex();

/** FR-021 3D map: Japan, sites, suppliers, demand regions, flow arcs and particles along the flows. */
export function buildMapScene(model: SceneModel): SceneBuild {
  const m = model as MapScene;
  const k = new Kit();
  const sea = k.mesh(k.geo('sea', () => new THREE.PlaneGeometry(110, 110).rotateX(-Math.PI / 2)), k.lambert(0x0f2440), 0, -0.05, 0);
  k.add(sea);
  for (const ring of m.outline) {
    const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const land = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), k.lambert(0x2b4a6b));
    land.position.y = 0.02;
    k.add(land);
    const pts = ring.map(([x, z]) => new THREE.Vector3(x, 0.06, z));
    k.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), k.line(0x5cc8ff, 0.55)));
  }
  const ROLE_COLOR = { hq: 0xffd866, plant: 0x5cc8ff, dc: 0x8fd694, office: 0xc6a8ff } as const;
  for (const o of m.objects) {
    const [x, y, z] = o.position;
    if (o.kind === 'site') {
      const e = o.entityId ? getEntity(o.entityId) : undefined;
      const role = e?.kind === 'site' ? e.role : 'plant';
      const h = y * 2;
      const geo = role === 'hq'
        ? k.geo(`cone-${h}`, () => new THREE.ConeGeometry(1, h, 4))
        : role === 'dc' ? k.box(1.8, h, 1.8) : k.geo(`cyl-${h}`, () => new THREE.CylinderGeometry(0.9, 0.9, h, 14));
      k.add(k.mesh(geo, k.lambert(ROLE_COLOR[role]), x, h / 2, z), [0, Infinity], o.id);
      const cap = (o.value ?? 0) / 650;
      if (cap > 0) k.add(k.mesh(k.geo(`ring-${cap.toFixed(2)}`, () => new THREE.RingGeometry(1.3, 1.3 + cap * 1.6, 28).rotateX(-Math.PI / 2)), k.basic(ROLE_COLOR[role], 0.45), x, 0.08, z), [1, Infinity]);
      k.glow(ROLE_COLOR[role], 3.2, x, h + 0.3, z);
    } else if (o.kind === 'supplier') {
      k.add(k.mesh(k.geo('octa', () => new THREE.OctahedronGeometry(0.85)), k.lambert(0xe3c08d), x, y, z), [0, Infinity], o.id);
    } else if (o.kind === 'region') {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.add(k.mesh(k.geo('demand-ring', () => new THREE.RingGeometry(0.9, 1.4, 6).rotateX(-Math.PI / 2)), k.basic(0xffb86b, 0.9), 0, 0.1, 0));
      g.add(k.mesh(k.geo('demand-core', () => new THREE.CylinderGeometry(0.6, 0.6, 0.5, 6)), k.lambert(0xffb86b), 0, 0.25, 0));
      k.add(g, [0, Infinity], o.id);
    } else if (o.kind === 'product') {
      const e = o.entityId ? getEntity(o.entityId) : undefined;
      const hue = e?.kind === 'product' ? e.illustration.hue : 120;
      k.add(k.mesh(k.box(0.8, 0.8, 0.8), k.lambert(hueColor(hue, 0.6, 0.6)), x, y, z), [2, Infinity], o.id);
    }
  }
  // Flow arcs and particles (FR-021). Particles are interleaved so a lower quality keeps every flow visible.
  const curves: { curve: THREE.QuadraticBezierCurve3; n: number; color: THREE.Color }[] = [];
  const kindOf = (id: string) => (id.startsWith('sup-') ? 0xe3c08d : id.startsWith('region-') ? 0xffb86b : 0x5cc8ff);
  for (const f of m.flows) {
    const a = new THREE.Vector3(...f.fromPos);
    const b = new THREE.Vector3(...f.toPos);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 1.2 + a.distanceTo(b) * 0.28;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const color = kindOf(f.to.startsWith('region-') ? f.to : f.from);
    k.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(28)), k.line(color, 0.5)));
    curves.push({ curve, n: Math.max(3, Math.min(14, Math.round(f.valueT / 28))), color: new THREE.Color(color) });
  }
  const order: { c: number; i: number }[] = [];
  const maxN = Math.max(0, ...curves.map((c) => c.n));
  for (let i = 0; i < maxN; i++) curves.forEach((c, ci) => { if (i < c.n) order.push({ c: ci, i }); });
  const positions = new Float32Array(order.length * 3);
  const colors = new Float32Array(order.length * 3);
  order.forEach((o, j) => { const col = curves[o.c]!.color; colors.set([col.r, col.g, col.b], j * 3); });
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pgeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(pgeo, new THREE.PointsMaterial({ size: 0.55, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
  points.frustumCulled = false;
  k.add(points);
  const v = new THREE.Vector3();
  const place = (t: number) => {
    order.forEach((o, j) => {
      const c = curves[o.c]!;
      c.curve.getPoint(((o.i / c.n) + t * 0.12) % 1, v);
      positions[j * 3] = v.x;
      positions[j * 3 + 1] = v.y;
      positions[j * 3 + 2] = v.z;
    });
    pgeo.attributes.position!.needsUpdate = true;
  };
  place(0);
  k.particleSetters.push((f) => pgeo.setDrawRange(0, Math.max(curves.length, Math.round(order.length * f))));
  return k.finish(place);
}

const ROLE_COLOR = { product: 0x7ee0d2, current: 0xc0c8d0, painPoint: 0xff9e80 } as const;
const LAYER_COLOR = [0xe3c08d, 0x5cc8ff, 0xd7a7ff, 0x8fd694, 0xffd866];

/** FR-040 3D layered stack: one slab per layer, blocks on the slabs, links per solution. */
export function buildArchScene(model: SceneModel): SceneBuild {
  const m = model as ArchScene;
  const k = new Kit();
  const layers = m.objects.filter((o) => o.kind === 'layer');
  layers.forEach((l, i) => {
    const rows = Math.max(1, Math.ceil((l.value ?? 0) / 5));
    const depth = 6 + rows * 3.4;
    const slab = k.mesh(k.box(36, 0.35, depth), k.lambert(LAYER_COLOR[i % LAYER_COLOR.length]!, { opacity: 0.32 }), 0, l.position[1], 0);
    k.add(slab, [0, Infinity], l.id);
    const edge = new THREE.LineSegments(k.geo(`slab-edge-${depth}`, () => new THREE.EdgesGeometry(new THREE.BoxGeometry(36, 0.35, depth))), k.line(LAYER_COLOR[i % LAYER_COLOR.length]!, 0.8));
    edge.position.y = l.position[1];
    k.add(edge);
  });
  const pos = new Map<string, THREE.Vector3>();
  for (const b of m.blocks) {
    const [x, y, z] = b.pos;
    pos.set(b.id, new THREE.Vector3(x, y, z));
    const geo = b.role === 'painPoint'
      ? k.geo('pain', () => new THREE.CylinderGeometry(1.5, 1.5, 1.4, 6))
      : k.box(5, 1.4, 2.6);
    k.add(k.mesh(geo, k.lambert(ROLE_COLOR[b.role]), x, y, z), [0, Infinity], b.id);
    if (b.role === 'product') k.glow(ROLE_COLOR.product, 4.5, x, y + 0.2, z);
  }
  for (const l of m.arch.links) {
    const a = pos.get(l.from);
    const b = pos.get(l.to);
    if (!a || !b) continue;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.z += 2.5;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    k.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(16)), k.line(0x9db8ff, 0.7)), [1, Infinity]);
  }
  return k.finish();
}

export const SCENE_BUILDERS = {
  map: buildMapScene,
  arch: buildArchScene,
} as const;
