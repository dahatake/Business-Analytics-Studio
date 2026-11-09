import { useEffect, useRef, useState } from 'react';
import type * as THREE_NS from 'three';
import type { Detail, EntityRelation } from './catalogModel.ts';
import type { ViewerLayout } from './viewerLayout.ts';

type Three = typeof THREE_NS;

interface Ctx {
  THREE: Three;
  renderer: THREE_NS.WebGLRenderer;
  scene: THREE_NS.Scene;
  camera: THREE_NS.PerspectiveCamera;
  controls: { target: THREE_NS.Vector3; update: () => void; getAzimuthalAngle: () => number; dispose: () => void; addEventListener: (t: 'change', f: () => void) => void };
  group: THREE_NS.Group;
  render: () => void;
}

const HUES = [210, 32, 140, 280, 350, 180, 60, 250, 100, 320];

/**
 * FR-169 / FR-170: 3D data viewer (three.js). Clusters → entities → columns by zoom, relations as lines,
 * the selected entity enlarged and ringed (non-colour cue). Drag rotates; the parent offers buttons and keys
 * for every operation (NFR-A11Y-004 / NFR-A11Y-007). Calls onFail when WebGL cannot start.
 */
export function Viewer3D({ layout, relations, detail, selectedId, columnsOf, zoom, rotateBy, simplified, onSelect, onFail }: {
  layout: ViewerLayout;
  relations: EntityRelation[];
  detail: Detail;
  selectedId: string | null;
  columnsOf: (id: string) => number;
  zoom: number;
  /** Incremented by the rotate buttons: radians to add to the azimuth. */
  rotateBy: { n: number; rad: number };
  simplified: boolean;
  onSelect: (entityId: string) => void;
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const [ready, setReady] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const el = host.current;
      if (disposed || !el) return;
      let renderer: THREE_NS.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        onFail();
        return;
      }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      const w = el.clientWidth || 600;
      const h = el.clientHeight || 400;
      renderer.setSize(w, h);
      renderer.domElement.setAttribute('aria-hidden', 'true');
      renderer.domElement.dataset.testid = 'uc-viewer-canvas';
      el.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, w / h, 1, 5000);
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1);
      sun.position.set(300, 600, 400);
      scene.add(sun);
      const group = new THREE.Group();
      scene.add(group);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableZoom = false;
      controls.enablePan = false;
      const render = () => renderer.render(scene, camera);
      controls.addEventListener('change', render);
      ctx.current = { THREE, renderer, scene, camera, controls, group, render };

      const ray = new THREE.Raycaster();
      let down: { x: number; y: number } | null = null;
      const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
      const onUp = (e: PointerEvent) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(p, camera);
        const hit = ray.intersectObjects(group.children, false).find((i) => i.object.userData.entityId);
        if (hit) onSelectRef.current(hit.object.userData.entityId as string);
      };
      renderer.domElement.addEventListener('pointerdown', onDown);
      renderer.domElement.addEventListener('pointerup', onUp);
      const ro = new ResizeObserver(() => {
        const cw = el.clientWidth;
        const ch = el.clientHeight;
        if (cw === 0 || ch === 0) return;
        renderer.setSize(cw, ch);
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        render();
      });
      ro.observe(el);
      setReady(true);
      cleanup = () => {
        ro.disconnect();
        controls.dispose();
        renderer.domElement.removeEventListener('pointerdown', onDown);
        renderer.domElement.removeEventListener('pointerup', onUp);
        group.traverse((o) => {
          const m = o as THREE_NS.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE_NS.Material | THREE_NS.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
        });
        renderer.dispose();
        renderer.domElement.remove();
        ctx.current = null;
      };
    })().catch(() => onFail());
    return () => {
      disposed = true;
      cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebuild the scene for the current level of detail and selection.
  useEffect(() => {
    const c = ctx.current;
    if (!ready || !c) return;
    const { THREE, group } = c;
    group.traverse((o) => {
      const m = o as THREE_NS.Mesh;
      if (m !== (group as unknown)) {
        m.geometry?.dispose();
        const mat = m.material as THREE_NS.Material | undefined;
        mat?.dispose?.();
      }
    });
    group.clear();
    const clusterIds = [...layout.clusters.keys()];
    const colorOf = (clusterId: string) => new THREE.Color(`hsl(${HUES[clusterIds.indexOf(clusterId) % HUES.length]}, 65%, 58%)`);
    const selCluster = selectedId ? layout.clusterOf.get(selectedId) : undefined;

    for (const [id, p] of layout.clusters) {
      const count = [...layout.clusterOf.values()].filter((x) => x === id).length;
      if (detail === 'clusters') {
        const r = 14 + 7 * Math.sqrt(count);
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshStandardMaterial({ color: colorOf(id), roughness: 0.5, emissive: id === selCluster ? 0x333333 : 0x000000 }));
        mesh.position.set(p.x, r, p.y);
        group.add(mesh);
      } else {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry((layout.clusterRadius.get(id) ?? 30) - 2, layout.clusterRadius.get(id) ?? 30, 48),
          new THREE.MeshBasicMaterial({ color: colorOf(id), side: THREE.DoubleSide, transparent: true, opacity: 0.45 }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(p.x, 0, p.y);
        group.add(ring);
      }
    }
    if (detail !== 'clusters') {
      for (const [id, p] of layout.entities) {
        const sel = id === selectedId;
        const size = sel ? 22 : 13;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size, size, size),
          new THREE.MeshStandardMaterial({ color: colorOf(layout.clusterOf.get(id) ?? ''), emissive: sel ? 0x666666 : 0x000000, roughness: 0.4 }),
        );
        mesh.position.set(p.x, size / 2 + 2, p.y);
        mesh.userData.entityId = id;
        group.add(mesh);
        if (sel) {
          const halo = new THREE.Mesh(new THREE.TorusGeometry(22, 2.5, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffffff }));
          halo.rotation.x = -Math.PI / 2;
          halo.position.set(p.x, 1, p.y);
          group.add(halo);
        }
        if (detail === 'columns' && !simplified) {
          const n = Math.min(columnsOf(id), 24);
          for (let k = 0; k < n; k++) {
            const col = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
            col.position.set(p.x + 10 * Math.cos(k * 0.9), size + 6 + k * 5, p.y + 10 * Math.sin(k * 0.9));
            col.userData.entityId = id;
            group.add(col);
          }
        }
      }
      const pts: number[] = [];
      for (const r of relations) {
        const a = layout.entities.get(r.a);
        const b = layout.entities.get(r.b);
        if (!a || !b) continue;
        pts.push(a.x, 6, a.y, b.x, 6, b.y);
      }
      if (pts.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.6 })));
      }
    }

    const focus = selectedId && detail !== 'clusters' ? layout.entities.get(selectedId) : undefined;
    const target = new THREE.Vector3(focus?.x ?? 0, 0, focus?.y ?? 0);
    const azimuth = c.controls.getAzimuthalAngle();
    const dist = 1100 / zoom;
    const polar = (55 * Math.PI) / 180;
    c.controls.target.copy(target);
    c.camera.position.set(
      target.x + dist * Math.sin(polar) * Math.sin(azimuth),
      target.y + dist * Math.cos(polar),
      target.z + dist * Math.sin(polar) * Math.cos(azimuth),
    );
    c.camera.lookAt(target);
    c.controls.update();
    c.render();
  }, [ready, layout, relations, detail, selectedId, zoom, simplified, columnsOf]);

  // Rotate buttons (non-drag alternative).
  useEffect(() => {
    const c = ctx.current;
    if (!ready || !c || rotateBy.n === 0) return;
    const off = c.camera.position.clone().sub(c.controls.target);
    off.applyAxisAngle(new c.THREE.Vector3(0, 1, 0), rotateBy.rad);
    c.camera.position.copy(c.controls.target).add(off);
    c.camera.lookAt(c.controls.target);
    c.controls.update();
    c.render();
  }, [ready, rotateBy]);

  return <div ref={host} className="uc-viewer-3d" data-ready={ready ? 'true' : 'false'} />;
}
