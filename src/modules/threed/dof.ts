import type { Quality } from './quality.ts';
import type { Vec3 } from './model.ts';

/** Why depth of field (FR-067, optional) cannot be used right now; null = it can. */
export type DofBlock = 'quality' | 'cinematic' | 'reducedMotion' | null;

export interface DofConditions {
  /** The quality level in effect (after any automatic lowering). */
  quality: Quality;
  cinematic: boolean;
  reducedMotion: boolean;
}

/**
 * FR-067 enable rule. DOF is a post-process that costs extra passes, so it is offered only where it cannot hurt KPI-5:
 * the High preset, "Cinematic effects" on and reduced motion off. Reduced motion is reported first (it overrides both).
 */
export function dofBlockReason(c: DofConditions): DofBlock {
  if (c.reducedMotion) return 'reducedMotion';
  if (c.quality !== 'high') return 'quality';
  if (!c.cinematic) return 'cinematic';
  return null;
}

export const dofAllowed = (c: DofConditions): boolean => dofBlockReason(c) === null;

/** DOF is drawn only when the user asked for it (off by default) and the rule allows it. */
export const dofActive = (requested: boolean, c: DofConditions): boolean => requested && dofAllowed(c);

/** Bokeh tuning for scene distances of roughly 5–300 units. */
export const DOF_APERTURE = 0.0004;
export const DOF_MAX_BLUR = 0.008;

/**
 * Focus distance = distance from the camera to the selected object (or the orbit target when nothing is selected),
 * kept inside the camera's clip range so the shader never divides by a degenerate depth.
 */
export function focusDistance(camera: Vec3, focusPoint: Vec3, near: number, far: number): number {
  const d = Math.hypot(focusPoint[0] - camera[0], focusPoint[1] - camera[1], focusPoint[2] - camera[2]);
  if (!Number.isFinite(d)) return near;
  return Math.min(far, Math.max(near, d));
}
