import { samplePack } from '../../src/data/sample.ts';
import { findPreset, DEFAULT_PRESET_ID } from '../../src/modules/ops/presets.ts';
import type { ResearchCache } from './research.ts';

export interface GenerateInput {
  /** FR-130: customer name as typed (the source of truth for the company name, §8). */
  customer: string;
  industry: string;
  lang: 'ja' | 'en';
  templateVersion: string;
}

export const researchSourceId = (slug: string) => `src-research-${slug.replace(/[^a-z0-9-]/g, '') || 'customer'}`;

/**
 * FR-125: deterministic draft generator (the LLM generator is BLOCKED by C-03/C-07). When research used the sample,
 * the draft keeps the sample's content labelled `author: 'sample'` and the pack stays `isSample: true` (FR-008);
 * only the customer-specific parts (name, industry, brand, preset) change. Self-correction then links sources.
 */
export function generateDraft(cache: ResearchCache, input: GenerateInput): Record<string, unknown> {
  const preset = findPreset(input.industry) ?? findPreset(DEFAULT_PRESET_ID)!;
  const draft = structuredClone(samplePack) as unknown as Record<string, unknown>;
  const author = cache.usedSample ? 'sample' : 'ai';
  draft.packId = `pack-${cache.slug}`;
  draft.company = { name: { ja: input.customer, en: input.customer }, industry: preset.industry };
  draft.isSample = cache.usedSample;
  draft.entities = (draft.entities as Record<string, unknown>[]).map((e) => ({ ...e, author }));
  draft.extensions = {
    ...(samplePack.extensions ?? {}),
    brand: cache.brand.profile,
    ops: {
      templateVersion: input.templateVersion,
      preset: preset.id,
      defaultLang: input.lang,
      research: { fetchedAt: cache.fetchedAt, usedSample: cache.usedSample, sources: cache.sources.map((s) => ({ id: s.id, status: s.status })) },
      generator: cache.usedSample ? 'deterministic-sample' : 'deterministic',
      researchSourceId: researchSourceId(cache.slug),
    },
  };
  return draft;
}
