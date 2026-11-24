import { entitiesOf, getEntity } from '../../data/pack.ts';
import type { LText } from '../../data/schema.ts';
import { createScopedStore } from '../../state/projects.ts';
import { loc, type Localizable } from '../../state/text.ts';
import type { Lang } from '../../i18n/core.ts';
import type { UseCase } from '../usecases/store.ts';
export type { StoryScene } from '../../ai/storyOutput.ts';
import type { StoryScene } from '../../ai/storyOutput.ts';
export { STORY_OUTPUT_TOKENS } from '../../ai/storyOutput.ts';
type StoryStep = 'storyboard' | 'animation';
export type StoryAbort = 'limits' | 'maxCalls' | 'cancelled';

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

export function liveStoryPrompt(source: StorySource, lang: Lang): string {
  return `Language: ${lang}. Generate the complete storyboard with scene durations in one JSON response. Source data:${STORY_MARKER}${storyPrompt(source, lang, 'storyboard').split(STORY_MARKER).slice(1).join(STORY_MARKER)}`;
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
  /** Legacy stories were local mocks. */
  mode?: 'mock' | 'live';
  sourceId: string;
  sourceUpdatedAt: string;
  lang: Lang;
  scenes: StoryScene[];
  createdAt: string;
  calls: number;
  /** Tokens the provider reported for the generating call; null = unknown. Absent on older and mock stories. */
  inputTokens?: number | null;
  outputTokens?: number | null;
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
