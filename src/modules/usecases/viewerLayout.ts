import type { Cluster, DataEntity } from './catalogModel.ts';

export interface Pt {
  x: number;
  y: number;
}

export interface ViewerLayout {
  clusters: Map<string, Pt>;
  clusterRadius: Map<string, number>;
  entities: Map<string, Pt>;
  clusterOf: Map<string, string>;
}

/** Shared 2D / 3D layout: clusters on a ring, entities on a small ring around their cluster (FR-169). */
export function layoutViewer(clusters: Cluster[]): ViewerLayout {
  const out: ViewerLayout = { clusters: new Map(), clusterRadius: new Map(), entities: new Map(), clusterOf: new Map() };
  const k = clusters.length;
  const ringR = k <= 1 ? 0 : Math.max(220, 40 * k);
  clusters.forEach((c, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, k) - Math.PI / 2;
    const center = { x: ringR * Math.cos(a), y: ringR * Math.sin(a) };
    out.clusters.set(c.id, center);
    const n = c.entityIds.length;
    const r = n <= 1 ? 0 : Math.min(160, 26 + 9 * n);
    out.clusterRadius.set(c.id, r + 22);
    c.entityIds.forEach((id, j) => {
      const b = (2 * Math.PI * j) / Math.max(1, n) - Math.PI / 2;
      out.entities.set(id, { x: center.x + r * Math.cos(b), y: center.y + r * Math.sin(b) });
      out.clusterOf.set(id, c.id);
    });
  });
  return out;
}

/** Order used by keyboard navigation (cluster by cluster). */
export function navOrder(clusters: Cluster[], entities: DataEntity[]): string[] {
  const known = new Set(entities.map((e) => e.id));
  return clusters.flatMap((c) => c.entityIds).filter((id) => known.has(id));
}

export function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}
