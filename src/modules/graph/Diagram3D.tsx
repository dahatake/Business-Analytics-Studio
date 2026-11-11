import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useI18n } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import type { Scene, SceneNode } from './scene.ts';
import { layout3D, type Pos3 } from './layout.ts';
import { toggleEntityCard } from './GraphNodeEl.tsx';
import type { InfoCardData } from './InfoCard.tsx';

const FALLBACK_COLOR = '#8A94A6';

function geometryFor(shape: SceneNode['shape'], r: number): THREE.BufferGeometry {
  switch (shape) {
    case 'square':
    case 'rect': return new THREE.BoxGeometry(r * 1.6, r * 1.6, r * 1.6);
    case 'diamond': return new THREE.OctahedronGeometry(r * 1.2);
    case 'triangle': return new THREE.ConeGeometry(r, r * 1.8, 3);
    case 'hexagon': return new THREE.CylinderGeometry(r, r, r * 1.2, 6);
    default: return new THREE.SphereGeometry(r, 20, 14);
  }
}

function labelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '28px "Segoe UI", system-ui, sans-serif';
  let w = 256;
  if (ctx) {
    ctx.font = font;
    w = Math.min(1024, Math.ceil(ctx.measureText(text).width) + 24);
  }
  canvas.width = w;
  canvas.height = 44;
  if (ctx) {
    ctx.font = font;
    ctx.fillStyle = 'rgba(20,20,20,0.72)';
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, 23);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((w / 44) * 0.42, 0.42, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** FR-238 3D format (three.js): nodes in a 3D force layout, lanes stacked on y, orbit by drag or arrow keys. */
export function Diagram3D({ scene, zoom, pan, onZoomStep, highlight, centreRequest, onCard, onSelect }: {
  scene: Scene;
  zoom: number;
  pan: { x: number; y: number };
  onZoomStep: (dir: 1 | -1) => void;
  highlight: string | null;
  centreRequest: { id: string; n: number } | null;
  onCard: (c: InfoCardData | null) => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const pos = useMemo(() => layout3D(scene), [scene]);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; controls: OrbitControls; root: THREE.Scene;
    meshes: Map<string, THREE.Mesh>; radius: number; render: () => void; target: THREE.Vector3;
  } | null>(null);
  const cbs = useRef({ onZoomStep, onCard, onSelect });
  cbs.current = { onZoomStep, onCard, onSelect };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    const root = new THREE.Scene();
    root.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(5, 10, 7);
    root.add(sun);
    const camera = new THREE.PerspectiveCamera(50, 16 / 10, 0.1, 500);
    const controls = new OrbitControls(camera, canvas);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = false;
    const render = () => renderer.render(root, camera);
    controls.addEventListener('change', render);
    const resize = () => {
      const w = canvas.clientWidth || 800, h = canvas.clientHeight || 500;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    ctx.current = { renderer, camera, controls, root, meshes: new Map(), radius: 8, render, target: new THREE.Vector3() };
    resize();
    const wheel = (e: WheelEvent) => { e.preventDefault(); cbs.current.onZoomStep(e.deltaY < 0 ? 1 : -1); };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', wheel);
      ro.disconnect();
      controls.dispose();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Sprite) {
          o.geometry.dispose();
          const m = o.material as THREE.Material & { map?: THREE.Texture };
          m.map?.dispose();
          m.dispose();
        }
      });
      renderer.dispose();
      ctx.current = null;
    };
  }, []);

  // Build the scene graph whenever the data changes.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const group = new THREE.Group();
    group.name = 'graph';
    const old = c.root.getObjectByName('graph');
    if (old) {
      c.root.remove(old);
      old.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Sprite) {
          o.geometry.dispose();
          const m = o.material as THREE.Material & { map?: THREE.Texture };
          m.map?.dispose();
          m.dispose();
        }
      });
    }
    c.meshes = new Map();
    let radius = 1;
    const lanesY = new Map<number, number>();
    for (const n of scene.nodes) {
      const p = pos.get(n.id) ?? { x: 0, y: 0, z: 0 };
      radius = Math.max(radius, Math.hypot(p.x, p.y, p.z));
      lanesY.set(n.lane, p.y);
      const color = n.color.startsWith('#') ? n.color : FALLBACK_COLOR;
      const mesh = new THREE.Mesh(geometryFor(n.shape, 0.3 * Math.min(2.2, Math.max(0.7, n.size))), new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, transparent: !!n.peripheral, opacity: n.peripheral ? 0.4 : 1 }));
      mesh.position.set(p.x, p.y, p.z);
      mesh.userData = { nodeId: n.id };
      group.add(mesh);
      c.meshes.set(n.id, mesh);
      if (scene.labelled.has(n.id)) {
        const s = labelSprite(n.label);
        s.position.set(p.x, p.y + 0.6, p.z);
        group.add(s);
      }
    }
    // Lane planes and captions.
    const span = radius * 1.6 + 2;
    for (const l of scene.lanes) {
      const y = lanesY.get(l.lane);
      if (y === undefined) continue;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(span, span), new THREE.MeshBasicMaterial({ color: 0x5c7cfa, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = y - 0.3;
      group.add(plane);
      const cap = labelSprite(l.label);
      cap.position.set(-span / 2, y, -span / 2);
      group.add(cap);
    }
    for (const e of scene.edges) {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z)]);
      const dashed = !!(e.flow === 'data' || e.twin || (e.semantic && e.semantic !== 'influence'));
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color: e.flow === 'control' ? 0xffb86b : 0xb0b8c8, dashSize: 0.18, gapSize: 0.1, transparent: true, opacity: 0.85 })
        : new THREE.LineBasicMaterial({ color: e.flow === 'control' ? 0xffb86b : 0xb0b8c8, transparent: true, opacity: 0.85 });
      const line = new THREE.Line(geo, mat);
      if (dashed) line.computeLineDistances();
      line.userData = { edgeId: e.id };
      group.add(line);
    }
    c.root.add(group);
    c.radius = radius;
    setReady(true);
  }, [scene, pos]);

  // Camera from the shared zoom / pan state (PARAM-087 range applies to the camera distance).
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const dist = (c.radius * 1.9 + 3) / zoom;
    const worldPerPx = (2 * dist * Math.tan((c.camera.fov * Math.PI) / 360)) / (canvasRef.current?.clientHeight || 500);
    const dir = c.camera.position.clone().sub(c.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.55, 1);
    dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().negate();
    const up = new THREE.Vector3(0, 1, 0);
    const target = c.target.clone().add(right.multiplyScalar(-pan.x * worldPerPx)).add(up.multiplyScalar(pan.y * worldPerPx));
    c.controls.target.copy(target);
    c.camera.position.copy(target.clone().add(dir.multiplyScalar(dist)));
    c.camera.lookAt(target);
    c.controls.update();
    c.render();
  }, [zoom, pan, ready, scene]);

  // FR-248 highlight and centre in 3D.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.meshes.forEach((m, id) => {
      const on = id === highlight;
      m.scale.setScalar(on ? 1.9 : 1);
      (m.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(on ? 0xffffff : 0x000000);
      (m.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 0.45 : 0;
    });
    c.render();
  }, [highlight, ready, scene]);
  useEffect(() => {
    const c = ctx.current;
    if (!c || !centreRequest) return;
    const p = pos.get(centreRequest.id);
    if (!p) return;
    const delta = new THREE.Vector3(p.x, p.y, p.z).sub(c.controls.target);
    c.target.add(delta);
    c.controls.target.add(delta);
    c.camera.position.add(delta);
    c.controls.update();
    c.render();
  }, [centreRequest, pos]);

  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => { down.current = { x: e.clientX, y: e.clientY }; };
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = ctx.current, d = down.current;
    if (!c || (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.params.Line = { threshold: 0.08 };
    ray.setFromCamera(ndc, c.camera);
    const hit = ray.intersectObjects([...c.meshes.values()], false)[0];
    const stage = e.currentTarget.closest('.graph-stage')?.getBoundingClientRect();
    const x = e.clientX - (stage?.left ?? 0), y = e.clientY - (stage?.top ?? 0);
    if (hit) {
      const node = scene.nodes.find((n) => n.id === hit.object.userData.nodeId);
      if (!node) return;
      if (node.entityId) {
        toggleEntityCard(e.currentTarget, node.entityId);
        cbs.current.onSelect(node.entityId);
      } else {
        cbs.current.onCard({ itemId: node.id, kind: 'node', title: node.label, rows: node.info, relations: node.relations, x, y });
      }
      return;
    }
    const lines: THREE.Object3D[] = [];
    c.root.getObjectByName('graph')?.traverse((o) => { if (o instanceof THREE.Line) lines.push(o); });
    const lh = ray.intersectObjects(lines, false)[0];
    const edge = lh ? scene.edges.find((x) => x.id === lh.object.userData.edgeId) : undefined;
    if (edge) cbs.current.onCard({ itemId: edge.id, kind: 'edge', title: edge.aria, rows: [{ label: t('graph.card.relation'), value: edge.label }, ...edge.info], relations: edge.members, x, y });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const c = ctx.current;
    if (!c || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = Math.PI / 12;
    const offset = c.camera.position.clone().sub(c.controls.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    if (e.key === 'ArrowLeft') sph.theta -= step;
    else if (e.key === 'ArrowRight') sph.theta += step;
    else if (e.key === 'ArrowUp') sph.phi = Math.max(0.15, sph.phi - step);
    else if (e.key === 'ArrowDown') sph.phi = Math.min(Math.PI - 0.15, sph.phi + step);
    else return;
    e.preventDefault();
    c.camera.position.copy(c.controls.target.clone().add(new THREE.Vector3().setFromSpherical(sph)));
    c.camera.lookAt(c.controls.target);
    c.render();
  };

  if (failed) return <p className="graph-3d-fallback" role="status">{t('graph.3d.unsupported')}</p>;
  return (
    <canvas
      ref={canvasRef}
      className={`graph3d ${reduced ? 'graph3d--still' : ''}`}
      tabIndex={0}
      role="img"
      aria-label={t('graph.3d.aria', { nodes: scene.nodes.length, edges: scene.edges.length })}
      aria-describedby="graph-keys-help"
      data-testid="graph-canvas"
      data-ready={ready ? 'true' : 'false'}
      data-highlight={highlight ?? undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
    />
  );
}

export type { Pos3 };
