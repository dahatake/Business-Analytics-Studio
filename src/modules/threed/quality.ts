export type Quality = 'low' | 'medium' | 'high';
export const QUALITY_ORDER: readonly Quality[] = ['low', 'medium', 'high'];

export interface QualityPreset {
  /** Upper bound of the renderer pixel ratio (also bounded by devicePixelRatio). */
  pixelRatioCap: number;
  /** Share of animated particles / work pieces drawn. */
  particleFactor: number;
  /** FR-067 bloom-like glow halos. */
  glow: boolean;
  antialias: boolean;
}

/** FR-069 quality presets. */
export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: { pixelRatioCap: 1, particleFactor: 0.35, glow: false, antialias: false },
  medium: { pixelRatioCap: 1.5, particleFactor: 0.7, glow: true, antialias: false },
  high: { pixelRatioCap: 2, particleFactor: 1, glow: true, antialias: true },
};

/** PARAM-027 / PARAM-028: downgrade when below 45 fps for 2 s. */
export const FPS_DOWNGRADE_THRESHOLD = 45;
export const FPS_DOWNGRADE_HOLD_MS = 2_000;
/** Upgrade rule (interpretation): back up one step after 5 s at ≥ 55 fps, never above the user's choice. */
export const FPS_UPGRADE_THRESHOLD = 55;
export const FPS_UPGRADE_HOLD_MS = 5_000;
/** A pause between samples longer than this (hidden tab, render-on-demand) restarts both timers. */
export const FPS_SAMPLE_GAP_MS = 1_000;
/** A level the controller had to leave this many times is not auto-upgraded to again (prevents oscillation). */
export const UPGRADE_LOCK_AFTER = 2;

const rank = (q: Quality) => QUALITY_ORDER.indexOf(q);

export type QualityChange = { from: Quality; to: Quality; reason: 'downgrade' | 'upgrade' | 'dofOff' } | null;

/** What the controller gives up next when rendering is slow. */
export type DowngradeStep = 'dof' | 'quality' | null;
/** FR-067 / FR-069: the optional depth of field goes first, then the preset steps down. */
export const DOWNGRADE_ORDER: readonly Exclude<DowngradeStep, null>[] = ['dof', 'quality'];

/**
 * Next thing to give up after 2 s below 45 fps. DOF is dropped even in manual quality mode (it is an optional effect
 * and must never cost KPI-5); the preset itself is lowered only in automatic mode.
 */
export function nextDowngrade(s: { dofActive: boolean; quality: Quality; auto: boolean }): DowngradeStep {
  for (const step of DOWNGRADE_ORDER) {
    if (step === 'dof' && s.dofActive) return 'dof';
    if (step === 'quality' && s.auto && rank(s.quality) > 0) return 'quality';
  }
  return null;
}

/**
 * FR-069: quality preset with automatic downgrade. Pure (time is passed in), so it is unit-tested.
 * - `ceiling` is the preset the user chose; `auto` lets the controller lower (and re-raise up to the ceiling) the level.
 */
export class QualityController {
  current: Quality;
  ceiling: Quality;
  auto: boolean;
  private belowSince: number | null = null;
  private aboveSince: number | null = null;
  private lastSampleAt: number | null = null;
  private readonly downgrades = new Map<Quality, number>();

  constructor(ceiling: Quality = 'high', auto = true) {
    this.ceiling = ceiling;
    this.current = ceiling;
    this.auto = auto;
  }

  /** User picks a preset: it becomes the ceiling and the current level; history is cleared. */
  setPreset(q: Quality, auto = this.auto) {
    this.ceiling = q;
    this.current = q;
    this.auto = auto;
    this.reset();
    this.downgrades.clear();
  }

  reset() {
    this.belowSince = null;
    this.aboveSince = null;
    this.lastSampleAt = null;
  }

  /**
   * Feed one FPS measurement taken at `nowMs`. Returns the change made, if any.
   * `dofActive`: depth of field is being drawn; it is turned off (reason `dofOff`) before the preset is lowered.
   */
  sample(fps: number, nowMs: number, dofActive = false): QualityChange {
    if (this.lastSampleAt !== null && nowMs - this.lastSampleAt > FPS_SAMPLE_GAP_MS) {
      this.belowSince = null;
      this.aboveSince = null;
    }
    this.lastSampleAt = nowMs;
    if ((!this.auto && !dofActive) || !Number.isFinite(fps)) return null;

    if (fps < FPS_DOWNGRADE_THRESHOLD) {
      this.aboveSince = null;
      if (this.belowSince === null) this.belowSince = nowMs;
      if (nowMs - this.belowSince < FPS_DOWNGRADE_HOLD_MS) return null;
      const step = nextDowngrade({ dofActive, quality: this.current, auto: this.auto });
      if (step === 'dof') {
        this.belowSince = null;
        return { from: this.current, to: this.current, reason: 'dofOff' };
      }
      if (step === 'quality') {
        const from = this.current;
        this.current = QUALITY_ORDER[rank(from) - 1]!;
        this.downgrades.set(from, (this.downgrades.get(from) ?? 0) + 1);
        this.belowSince = null;
        return { from, to: this.current, reason: 'downgrade' };
      }
      return null;
    }
    this.belowSince = null;
    if (this.auto && fps >= FPS_UPGRADE_THRESHOLD && rank(this.current) < rank(this.ceiling)) {
      const next = QUALITY_ORDER[rank(this.current) + 1]!;
      if ((this.downgrades.get(next) ?? 0) >= UPGRADE_LOCK_AFTER) {
        this.aboveSince = null;
        return null;
      }
      if (this.aboveSince === null) this.aboveSince = nowMs;
      if (nowMs - this.aboveSince >= FPS_UPGRADE_HOLD_MS) {
        const from = this.current;
        this.current = next;
        this.aboveSince = null;
        return { from, to: next, reason: 'upgrade' };
      }
      return null;
    }
    this.aboveSince = null;
    return null;
  }
}
