import { estimateTokens } from '../../ai/budget.ts';
import { entitiesOf, getEntity } from '../../data/pack.ts';
import type { LText } from '../../data/schema.ts';
import { createScopedStore } from '../../state/projects.ts';
import { loc, type Localizable } from '../../state/text.ts';
import type { Lang } from '../../i18n/core.ts';
import type { UseCase } from '../usecases/store.ts';

/** PARAM-128: generative-AI budget per story creation (JPY). */
export const STORY_CAP_JPY = 1000;
/** PARAM-129: safety factor applied to every estimate. */
export const STORY_SAFETY_FACTOR = 1.2;
/** PARAM-131: maximum generation calls per creation, retries included. */
export const STORY_MAX_CALLS = 3;
/** Planned calls: storyboard, then animation timing. */
export const STORY_PLANNED_CALLS = 2;
/** Output tokens reserved per call for the estimate. */
export const STORY_OUTPUT_TOKENS = 2000;

/** PARAM-130: a unit price is usable only when it is a positive finite number (no defaults are substituted). */
export function parsePrice(raw: string): number | null {
  if (raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export interface StoryEstimate {
  ok: boolean;
  reason?: 'noPrice' | 'overCap';
  inputTokens: number;
  /** One call's cost before the safety factor. */
  perCallJpy: number;
  /** Planned calls × per call × PARAM-129. */
  totalJpy: number;
}

export function estimateStory(inputTokens: number, prices: { input: string; output: string }): StoryEstimate {
  const pin = parsePrice(prices.input);
  const pout = parsePrice(prices.output);
  if (pin === null || pout === null) return { ok: false, reason: 'noPrice', inputTokens, perCallJpy: 0, totalJpy: 0 };
  const perCallJpy = (inputTokens * pin + STORY_OUTPUT_TOKENS * pout) / 1_000_000;
  const totalJpy = perCallJpy * STORY_PLANNED_CALLS * STORY_SAFETY_FACTOR;
  return totalJpy > STORY_CAP_JPY
    ? { ok: false, reason: 'overCap', inputTokens, perCallJpy, totalJpy }
    : { ok: true, inputTokens, perCallJpy, totalJpy };
}

export type StoryStep = 'storyboard' | 'animation';
export type StoryAbort = 'budget' | 'maxCalls' | 'cancelled';

export interface GenerationResult {
  status: 'done' | 'aborted';
  reason?: StoryAbort;
  calls: number;
  spentJpy: number;
  outputs: Partial<Record<StoryStep, string>>;
}

/**
 * FR-292 control loop. Before every call it checks the call count (PARAM-131) and that the spend so far plus this call's
 * estimate × PARAM-129 stays within PARAM-128; otherwise it stops. A failed call (null) is retried within the call cap.
 */
export async function runStoryGeneration(
  estimate: StoryEstimate,
  call: (step: StoryStep) => Promise<{ text: string; costJpy: number } | null>,
  isCancelled: () => boolean = () => false,
): Promise<GenerationResult> {
  const r: GenerationResult = { status: 'done', calls: 0, spentJpy: 0, outputs: {} };
  const abort = (reason: StoryAbort): GenerationResult => ({ ...r, status: 'aborted', reason });
  if (!estimate.ok) return abort('budget');
  for (const step of ['storyboard', 'animation'] as StoryStep[]) {
    for (;;) {
      if (isCancelled()) return abort('cancelled');
      if (r.calls >= STORY_MAX_CALLS) return abort('maxCalls');
      if (r.spentJpy + estimate.perCallJpy * STORY_SAFETY_FACTOR > STORY_CAP_JPY) return abort('budget');
      const out = await call(step);
      r.calls++;
      r.spentJpy += out?.costJpy ?? estimate.perCallJpy;
      if (out) {
        r.outputs[step] = out.text;
        break;
      }
    }
  }
  return r;
}

/** What a story is made from: a use case, or (when the project has none) a solution of the pack. */
export interface StorySource {
  id: string;
  updatedAt: string;
  title: Localizable;
  summary: Localizable;
  steps: { title: Localizable; description: Localizable }[];
  effect?: Localizable;
}

export function sourceFromUseCase(u: UseCase): StorySource {
  return { id: u.id, updatedAt: u.updatedAt, title: u.name, summary: u.summary, steps: u.steps, effect: u.effect };
}

/** Interpretation: a solution reads as a story issue → solution → KPI when no use case exists yet. */
export function sourcesFromSolutions(allow: (id: string) => boolean): StorySource[] {
  return entitiesOf('solution').filter((s) => allow(s.id)).map((s) => {
    const issues = s.issueIds.map((id) => getEntity(id)).filter((e) => e && allow(e.id));
    const kpis = s.kpiIds.map((id) => getEntity(id)).filter((e) => e && allow(e.id));
    const steps: { title: LText; description: LText }[] = [
      ...issues.map((e) => ({ title: e!.name, description: e!.description })),
      { title: s.name, description: s.description },
      ...kpis.map((e) => ({ title: e!.name, description: e!.description })),
    ];
    return { id: s.id, updatedAt: 'pack', title: s.name, summary: s.description, steps };
  });
}

export const STORY_MARKER = '\n---source---\n';

export function storyPrompt(source: StorySource, lang: Lang, step: StoryStep): string {
  const payload = { title: loc(source.title, lang), summary: loc(source.summary, lang), steps: source.steps.map((s) => ({ title: loc(s.title, lang), description: loc(s.description, lang) })), effect: source.effect ? loc(source.effect, lang) : undefined };
  return `${step}${STORY_MARKER}${JSON.stringify(payload)}`;
}

export function storyInputTokens(source: StorySource, lang: Lang): number {
  return estimateTokens(storyPrompt(source, lang, 'storyboard'));
}

export interface StoryScene {
  title: string;
  narration: string;
  role: 'opening' | 'step' | 'closing';
  durationMs: number;
}

/** PARAM-046 caps use-case steps at 20; a story keeps at most 8 step scenes to stay watchable. */
export const MAX_STORY_STEPS = 8;

/** Mock for use 'storyVideo': the storyboard is derived scene by scene from the source; animation returns timings. */
export function storyMock(prompt: string): string {
  const [step, raw] = prompt.split(STORY_MARKER);
  let src: { title: string; summary: string; steps: { title: string; description: string }[]; effect?: string };
  try {
    src = JSON.parse(raw ?? '') as typeof src;
  } catch {
    return '[]';
  }
  const scenes: StoryScene[] = [
    { title: src.title, narration: src.summary, role: 'opening', durationMs: 3000 },
    ...src.steps.slice(0, MAX_STORY_STEPS).map((s) => ({ title: s.title, narration: s.description, role: 'step' as const, durationMs: 3500 })),
    ...(src.effect ? [{ title: src.title, narration: src.effect, role: 'closing' as const, durationMs: 3000 }] : []),
  ];
  return step === 'animation' ? JSON.stringify(scenes.map((s) => s.durationMs)) : JSON.stringify(scenes);
}

export interface StoryVideo {
  sourceId: string;
  sourceUpdatedAt: string;
  lang: Lang;
  scenes: StoryScene[];
  createdAt: string;
  calls: number;
  spentJpy: number;
  estimateJpy: number;
  status: 'latest' | 'aborted';
  abortReason?: StoryAbort;
}

/** §3.4 states: none → generating → latest / stale / aborted. */
export function storyState(video: StoryVideo | undefined, source: StorySource): 'none' | 'latest' | 'stale' | 'aborted' {
  if (!video) return 'none';
  if (video.status === 'aborted') return 'aborted';
  return video.sourceUpdatedAt === source.updatedAt ? 'latest' : 'stale';
}

/** Saved per project (FR-291, G-007). */
export const useStories = createScopedStore<Record<string, StoryVideo>>('ai.stories', () => ({}));
