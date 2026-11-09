import type { Pose, Vec3 } from './model.ts';

/** FR-023 fly-through duration bounds (ms). Reduced motion → 0 (instant). */
export const FLY_MIN_MS = 700;
export const FLY_MAX_MS = 1_400;

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Shortest signed angle from a to b. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Camera pose at progress t ∈ [0, 1] of a fly-through. Eased; the camera pulls back midway (a "fly" arc)
 * and returns exactly to the endpoints at t = 0 and t = 1.
 */
export function flyPose(from: Pose, to: Pose, t: number): Pose {
  const u = Math.min(1, Math.max(0, t));
  if (u === 0) return { ...from, target: [...from.target] };
  if (u === 1) return { ...to, target: [...to.target] };
  const e = easeInOutCubic(u);
  const travel = Math.hypot(to.target[0] - from.target[0], to.target[1] - from.target[1], to.target[2] - from.target[2]);
  const lift = Math.min(travel * 0.5, Math.max(from.distance, to.distance) * 0.6) * Math.sin(Math.PI * u);
  const target: Vec3 = [lerp(from.target[0], to.target[0], e), lerp(from.target[1], to.target[1], e), lerp(from.target[2], to.target[2], e)];
  return {
    target,
    distance: lerp(from.distance, to.distance, e) + lift,
    azimuth: from.azimuth + angleDelta(from.azimuth, to.azimuth) * e,
    polar: lerp(from.polar, to.polar, e),
  };
}

/** Duration of a fly-through; 0 under reduced motion (NFR: motion can be turned off). */
export function flyDurationMs(from: Pose, to: Pose, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const travel = Math.hypot(to.target[0] - from.target[0], to.target[1] - from.target[1], to.target[2] - from.target[2]);
  const zoom = Math.abs(Math.log(Math.max(1e-6, to.distance) / Math.max(1e-6, from.distance)));
  const ms = FLY_MIN_MS + travel * 12 + zoom * 250;
  return Math.round(Math.min(FLY_MAX_MS, Math.max(FLY_MIN_MS, ms)));
}
