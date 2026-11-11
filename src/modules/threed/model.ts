import type { MessageKey } from '../../i18n/core.ts';
import type { Lang } from '../../i18n/core.ts';
import type { LText } from '../../data/schema.ts';
import { loc, type Localizable } from '../../state/text.ts';

export type Vec3 = [number, number, number];

export type TabKey = 'twin' | 'map' | 'kpi' | 'arch';
export const TABS: TabKey[] = ['twin', 'map', 'kpi', 'arch'];

/** Text of a scene object: a dictionary key (with vars) or data text. Resolved in the UI language. */
export type Label =
  | { key: MessageKey; vars?: Record<string, string | number | LText> }
  | { text: Localizable };

export type ObjectKind =
  | 'site' | 'line' | 'machine' | 'product' | 'country' | 'supplier' | 'region'
  | 'team' | 'stage'
  | 'kpis' | 'kpi' | 'arch' | 'layer' | 'block';

/**
 * One selectable object of a scene with its hierarchy/LOD metadata (FR-030).
 * `level` = depth in the hierarchy (breadcrumb); `lod` = the coarsest camera LOD level at which it is drawn.
 */
export interface SceneObject {
  id: string;
  kind: ObjectKind;
  label: Label;
  detail?: Label;
  parentId?: string;
  level: number;
  lod: number;
  /** Focus point in world space (camera target when selected). */
  position: Vec3;
  /** Rough radius, used to frame the camera on the object. */
  size: number;
  /** Pack entity behind the object (detail card, drill-through). */
  entityId?: string;
  /** LOD level from which an overlay label is shown; undefined = no overlay label. */
  labelLod?: number;
  /** Numeric value for the text alternative (e.g. KPI progress, flow tonnes). */
  value?: number;
}

/** Camera pose around a target (spherical coordinates, radians). */
export interface Pose {
  target: Vec3;
  distance: number;
  azimuth: number;
  polar: number;
}

export interface SceneModel {
  tab: TabKey;
  rootId: string;
  objects: SceneObject[];
  /** Descending camera distances: index i is the boundary between LOD i and LOD i+1 (FR-031). */
  lodThresholds: number[];
  /** Name of each LOD level (length = thresholds + 1). */
  levelNames: MessageKey[];
  home: Pose;
  minDistance: number;
  maxDistance: number;
}

export function labelText(label: Label, t: (key: MessageKey, vars?: Record<string, string | number>) => string, lang: Lang): string {
  if ('text' in label) return loc(label.text, lang);
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(label.vars ?? {})) vars[k] = typeof v === 'object' ? loc(v, lang) : v;
  return t(label.key, vars);
}

export function objectById(model: SceneModel, id: string | null | undefined): SceneObject | undefined {
  return id ? model.objects.find((o) => o.id === id) : undefined;
}

/** Root → … → object (FR-033 breadcrumb). */
export function ancestry(model: SceneModel, id: string | null | undefined): SceneObject[] {
  const out: SceneObject[] = [];
  const seen = new Set<string>();
  let cur = objectById(model, id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = objectById(model, cur.parentId);
  }
  return out;
}

/** Camera pose that frames an object (keeps the current angles). */
export function poseFor(model: SceneModel, obj: SceneObject, current: Pose): Pose {
  const distance = Math.min(model.maxDistance, Math.max(model.minDistance, obj.size * 2.6));
  return { target: [...obj.position], distance, azimuth: current.azimuth, polar: current.polar };
}
