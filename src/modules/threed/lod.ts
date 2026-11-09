/** PARAM-023: LOD hysteresis width as a share of each threshold (10 %). */
export const LOD_HYSTERESIS = 0.1;

/**
 * FR-031 / FR-032: LOD level for a camera distance.
 * `thresholds` are descending distances; thresholds[i] is the boundary between level i (farther) and level i+1 (closer).
 * Without a previous level the raw level is returned. With one, a level change needs the distance to leave the
 * band [T, T × (1 + hysteresis)] around the boundary, so hovering at a boundary never flickers.
 * Going closer switches at d ≤ T; going farther switches only at d > T × (1 + hysteresis).
 */
export function lodForDistance(distance: number, thresholds: readonly number[], previous?: number, hysteresis = LOD_HYSTERESIS): number {
  if (!Number.isFinite(distance)) return 0;
  if (previous === undefined) {
    let level = 0;
    while (level < thresholds.length && distance <= thresholds[level]!) level++;
    return level;
  }
  let level = Math.max(0, Math.min(thresholds.length, Math.round(previous)));
  while (level < thresholds.length && distance <= thresholds[level]!) level++;
  while (level > 0 && distance > thresholds[level - 1]! * (1 + hysteresis)) level--;
  return level;
}

/** FR-036: an object is drawn only when the current level is inside its [min, max] range. */
export function visibleAtLevel(level: number, min: number, max = Number.POSITIVE_INFINITY): boolean {
  return level >= min && level <= max;
}

/** Stateful wrapper used by the renderer: feeds distances and reports level changes. */
export class LodTracker {
  level: number | undefined;
  constructor(private readonly thresholds: readonly number[], private readonly hysteresis = LOD_HYSTERESIS) {}
  update(distance: number): { level: number; changed: boolean } {
    const next = lodForDistance(distance, this.thresholds, this.level, this.hysteresis);
    const changed = next !== this.level;
    this.level = next;
    return { level: next, changed };
  }
}
