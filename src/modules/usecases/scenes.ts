import type { LText } from '../../data/schema.ts';
import { translate } from '../../i18n/core.ts';
import { personaLabel } from '../../state/personas.ts';
import type { Localizable } from '../../state/text.ts';
import { both, isBlank, mapLoc } from './bitext.ts';
import { truncateChars } from './normalize.ts';
import type { StoryStyle, UseCase } from './store.ts';

/** PARAM-047: default seconds per animation scene. */
export const SCENE_MS = 5000;
/** PARAM-048: the animation must be playable within this time after the create action. */
export const ANIMATION_READY_MS = 2000;
/** PARAM-052 / PARAM-053: storyboard playback about 30 s, ±5 s. */
export const STORYBOARD_TARGET_MS = 30_000;
export const STORYBOARD_TOLERANCE_MS = 5_000;
/** PARAM-054: emphasis telop length. */
export const MAX_TELOP_CHARS = 20;
/** Shortest storyboard scene, so captions stay readable even with many steps. */
const MIN_STORY_SCENE_MS = 700;

export interface AnimScene {
  kind: 'intro' | 'step' | 'effect';
  heading: Localizable;
  body: Localizable;
  stepNo?: number;
  startMs: number;
  durationMs: number;
}

export interface Timeline<S> {
  scenes: S[];
  totalMs: number;
}

/** FR-155: intro → one scene per step → effect (the effect scene only when an effect is given). */
export function buildAnimation(uc: UseCase, sceneMs = SCENE_MS): Timeline<AnimScene> {
  const raw: Omit<AnimScene, 'startMs' | 'durationMs'>[] = [
    { kind: 'intro', heading: uc.name, body: uc.summary },
    ...uc.steps.map((s, i) => ({ kind: 'step' as const, heading: s.title, body: s.description, stepNo: i + 1 })),
    ...(uc.effect && !isBlank(uc.effect) ? [{ kind: 'effect' as const, heading: uc.effect, body: uc.name }] : []),
  ];
  let t = 0;
  const scenes = raw.map((s) => {
    const scene = { ...s, startMs: t, durationMs: sceneMs };
    t += sceneMs;
    return scene;
  });
  return { scenes, totalMs: t };
}

/** Which scene is showing at `ms` (clamped to the timeline). */
export function sceneIndexAt(scenes: { startMs: number; durationMs: number }[], ms: number): number {
  if (scenes.length === 0) return -1;
  for (let i = scenes.length - 1; i >= 0; i--) if (ms >= scenes[i]!.startMs) return i;
  return 0;
}

/**
 * FR-164: scale scene weights so the total is the target (≈30 s); every scene gets at least `minMs`.
 * The result sums exactly to the target whenever the minimums fit, which keeps it within ±PARAM-053.
 */
export function fitDurations(weights: number[], targetMs = STORYBOARD_TARGET_MS, minMs = MIN_STORY_SCENE_MS): number[] {
  if (weights.length === 0) return [];
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 1));
  const floor = Math.min(minMs, targetMs / w.length);
  const spare = targetMs - floor * w.length;
  const sum = w.reduce((a, b) => a + b, 0);
  const out = w.map((x) => Math.round(floor + (spare * x) / sum));
  const diff = targetMs - out.reduce((a, b) => a + b, 0);
  out[out.length - 1]! += diff;
  return out;
}

export function telop(text: Localizable): Localizable {
  return mapLoc(text, (s) => truncateChars(s, MAX_TELOP_CHARS));
}

export type MotionKind = 'persona' | 'data' | 'arrow' | 'spark' | 'kpi' | 'check';
export type Motion = 'slide' | 'zoom' | 'pulse' | 'rise';
export interface MotionElement {
  kind: MotionKind;
  motion: Motion;
}

export interface StoryScene {
  kind: 'hook' | 'story' | 'step' | 'payoff';
  heading: Localizable;
  subtitle: Localizable;
  telop: Localizable;
  elements: MotionElement[];
  stepNo?: number;
  startMs: number;
  durationMs: number;
}

const STYLE_MOTION: Record<StoryStyle, Motion[]> = {
  cinematic: ['slide', 'zoom', 'rise'],
  minimal: ['rise'],
  bold: ['zoom', 'pulse', 'slide'],
};

function elementsFor(kind: StoryScene['kind'], style: StoryStyle, i: number): MotionElement[] {
  const motions = STYLE_MOTION[style];
  const m = (k: number) => motions[(i + k) % motions.length]!;
  const kinds: MotionKind[] =
    kind === 'hook' ? ['spark', 'data'] : kind === 'story' ? ['persona', 'arrow'] : kind === 'payoff' ? ['kpi', 'check'] : ['data', 'arrow', 'check'];
  const els = kinds.map((k, n) => ({ kind: k, motion: m(n) }));
  return style === 'minimal' ? els.slice(0, 1) : els;
}

function textWeight(text: Localizable): number {
  const s = typeof text === 'string' ? text : text.en.length > text.ja.length * 2 ? text.en : text.ja;
  return Math.min(3, 1 + s.length / 60);
}

/**
 * FR-163: a storyboard centred on the user story: hook → "As <persona>, I want … so that …" → one scene per step →
 * payoff. Each scene has a heading, a subtitle (caption), an emphasis telop ≤ PARAM-054 characters and moving elements.
 */
export function buildStoryboard(uc: UseCase, style: StoryStyle, targetMs = STORYBOARD_TARGET_MS): Timeline<StoryScene> {
  const persona: LText = { ja: translate('ja', personaLabel(uc.persona)), en: translate('en', personaLabel(uc.persona)) };
  const effect = uc.effect && !isBlank(uc.effect) ? uc.effect : uc.summary;
  const raw: Omit<StoryScene, 'startMs' | 'durationMs' | 'elements'>[] = [
    { kind: 'hook', heading: uc.name, subtitle: uc.summary, telop: telop(effect) },
    { kind: 'story', heading: both('uc.sb.storyHeading', { persona }), subtitle: both('uc.sb.story', { persona, goal: uc.name, benefit: effect }), telop: telop(uc.name) },
    ...uc.steps.map((s, i) => ({ kind: 'step' as const, heading: s.title, subtitle: s.description, telop: telop(s.title), stepNo: i + 1 })),
    { kind: 'payoff', heading: effect, subtitle: both('uc.sb.payoff', { goal: uc.name }), telop: telop(effect) },
  ];
  const weights = raw.map((s) => (s.kind === 'hook' || s.kind === 'payoff' ? 1.3 : 1) * textWeight(s.subtitle));
  const durations = fitDurations(weights, targetMs);
  let t = 0;
  const scenes = raw.map((s, i) => {
    const scene: StoryScene = { ...s, elements: elementsFor(s.kind, style, i), startMs: t, durationMs: durations[i]! };
    t += durations[i]!;
    return scene;
  });
  return { scenes, totalMs: t };
}
