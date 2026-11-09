import { createScopedStore } from '../../state/projects.ts';
import type { Localizable } from '../../state/text.ts';
import type { Persona } from '../../state/personas.ts';
import { demoUseCases } from './seed.ts';

/** PARAM-046: steps per use case. */
export const MAX_USECASE_STEPS = 20;

export interface UseCaseStep {
  title: Localizable;
  description: Localizable;
}

/** FR-158: a use case of the project. Shared contract: show, ai and catalog modules read it. */
export interface UseCase {
  id: string;
  name: Localizable;
  summary: Localizable;
  persona: Persona;
  steps: UseCaseStep[];
  effect?: Localizable;
  /** Pack ids this use case relates to (issues, solutions, KPIs, data entities). */
  relatedIds: string[];
  /** 'derived' = candidate generated from the pack, 'registered' = saved in the project. */
  origin: 'derived' | 'registered';
  updatedAt: string;
  /** Pack id (solution) a registered use case was created from, so its candidate is not offered twice. */
  derivedFrom?: string;
}

/** Demo seeds come from seed.ts (FR-180: at least PARAM-060 per persona); new projects start empty. */
export const useUseCases = createScopedStore<UseCase[]>('usecases', (scope) => (scope === 'demo' ? demoUseCases() : []));

/** FR-163 / FR-166: storyboard styles. */
export const STORY_STYLES = ['cinematic', 'minimal', 'bold'] as const;
export type StoryStyle = (typeof STORY_STYLES)[number];

/** When an animation / storyboard was created; it becomes stale when the use case is edited later (FR-155, FR-163). */
export interface MadeRecord {
  createdAt: string;
  style?: StoryStyle;
}

export const useAnimations = createScopedStore<Record<string, MadeRecord>>('usecases.animations', () => ({}));
export const useStoryboards = createScopedStore<Record<string, MadeRecord>>('usecases.storyboards', () => ({}));

export type MadeState = 'none' | 'latest' | 'stale';

export function madeState(uc: UseCase, rec: MadeRecord | undefined): MadeState {
  if (!rec) return 'none';
  return uc.updatedAt > rec.createdAt ? 'stale' : 'latest';
}

export const newUseCaseId = () => `uc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

