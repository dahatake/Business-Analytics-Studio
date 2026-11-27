import { AiPlatformExtension } from '../../data/extensionSchemas.ts';
import { loaded } from '../../data/pack.ts';
import type { EntityOf } from '../../data/schema.ts';
import { createScopedStore } from '../../state/projects.ts';
import { normalizeStrategy, solutionType, type StrategyData } from '../project/strategy.ts';
import { demoAiPlatform } from './demo.ts';
import { sanitizePlatform, type SolutionInfo } from './model.ts';

/**
 * FR-386: the AI platform as this project assesses it. Assessments are the project's work (who judged what, on which
 * evidence), so they live in a scoped store exported with the project file and never overwrite the pack.
 * Absent = the pack's `extensions.aiPlatform` (or the demo platform for the sample pack).
 */
export interface StoredPlatform {
  platform: unknown;
  /** The pack the edit started from; a different pack means the pack was replaced after editing. */
  basePackId: string;
  at: string;
}

export const AIFIRST_STORE = 'aifirst.platform';
export const usePlatformEdits = createScopedStore<StoredPlatform | null>(AIFIRST_STORE, () => null);

export type PlatformOrigin = 'edited' | 'pack' | 'demo' | 'none';

function known() {
  const entities = loaded.pack.entities;
  return {
    sourceIds: new Set(entities.filter((e) => e.kind === 'source').map((e) => e.id)),
    solutionIds: new Set(entities.filter((e) => e.kind === 'solution').map((e) => e.id)),
  };
}

export function packPlatform(): AiPlatformExtension | null {
  const raw = loaded.pack.extensions?.aiPlatform;
  if (raw !== undefined) {
    const p = AiPlatformExtension.safeParse(raw);
    if (p.success) return sanitizePlatform(p.data, known());
  }
  return loaded.pack.isSample ? demoAiPlatform : null;
}

/** The platform shown: the project's edit when it still reads, else the pack's (a broken edit never breaks the screen). */
export function effectivePlatform(stored: StoredPlatform | null): { platform: AiPlatformExtension; origin: PlatformOrigin; stale: boolean } {
  if (stored) {
    const p = sanitizePlatform(stored.platform, known());
    if (p) return { platform: p, origin: 'edited', stale: stored.basePackId !== loaded.pack.packId };
  }
  const pack = packPlatform();
  if (!pack) return { platform: { capabilities: [], areas: [] }, origin: 'none', stale: false };
  return { platform: pack, origin: loaded.pack.extensions?.aiPlatform !== undefined ? 'pack' : 'demo', stale: false };
}

export function savePlatform(platform: AiPlatformExtension) {
  usePlatformEdits.getState().set({ platform, basePackId: loaded.pack.packId, at: new Date().toISOString() });
}

/** The pack's solutions with the type and AI approach a person confirmed (FR-384) and the KPIs that have a baseline. */
export function solutionInfos(strategyRaw: unknown): SolutionInfo[] {
  const strategy: StrategyData = normalizeStrategy(strategyRaw);
  const entities = loaded.pack.entities;
  const baselined = new Set(entities.filter((e): e is EntityOf<'kpi'> => e.kind === 'kpi' && typeof e.baseline === 'number').map((e) => e.id));
  return entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution').map((s) => ({
    id: s.id,
    name: s.name,
    type: solutionType(s, strategy).type,
    approach: strategy.approaches?.[s.id]?.approach ?? null,
    ...(typeof s.annualBenefitJpy === 'number' ? { annualBenefitJpy: s.annualBenefitJpy } : {}),
    baselineKpis: s.kpiIds.filter((id) => baselined.has(id)),
  }));
}
