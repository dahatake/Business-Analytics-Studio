import { z } from 'zod';
import { EntityKind, type CustomerPack } from './schema.ts';

export const COLLECTION_SECTIONS = [
  'company', 'regions', ...EntityKind.options, 'flows', 'optimization',
  'brand', 'dataCatalog', 'glossary', 'workflow', 'architecture', 'coreObject',
] as const;
/** Sections of older reports that are still read but no longer asked for (the relation graph was removed, FR-380). */
export const LEGACY_COLLECTION_SECTIONS = ['graph'] as const;
/** Sections added after packs were already in use: an older report without them gets a warning, not an error. */
export const LATER_COLLECTION_SECTIONS: readonly CollectionSection[] = ['workflow'];
export type CollectionSection = (typeof COLLECTION_SECTIONS)[number];
export const CollectionReport = z.object({
  asOf: z.iso.date(),
  webSearch: z.enum(['searched', 'blocked', 'notRequested']),
  webSearchReason: z.string().min(1),
  sections: z.array(z.object({
    key: z.enum([...COLLECTION_SECTIONS, ...LEGACY_COLLECTION_SECTIONS]),
    status: z.enum(['complete', 'partial', 'unavailable', 'notApplicable']),
    sourceIds: z.array(z.string()),
    missingFields: z.array(z.string()),
    reason: z.string().min(1),
    nextAction: z.string().min(1),
  })),
});

/** Presence is not completeness: completeness is a source owner's judgement, not a JSON schema check. */
export function collectionPresence(pack: CustomerPack): Record<CollectionSection, boolean> {
  const present: Record<string, boolean> = {
    company: true, regions: pack.regions.length > 0, flows: pack.flows.length > 0,
    optimization: pack.optimization !== undefined,
  };
  for (const kind of EntityKind.options) present[kind] = pack.entities.some((e) => e.kind === kind);
  for (const key of ['brand', 'dataCatalog', 'glossary', 'workflow', 'architecture', 'coreObject'] as const) {
    const value = pack.extensions?.[key];
    present[key] = value !== undefined && value !== null
      && (Array.isArray(value) ? value.length > 0 : typeof value === 'object' && Object.keys(value).length > 0);
    if (key === 'dataCatalog' && value && !Array.isArray(value) && typeof value === 'object' && 'items' in value) {
      present[key] = Array.isArray(value.items) && value.items.length > 0;
    }
    if (key === 'workflow') {
      const stages = value && typeof value === 'object' && !Array.isArray(value) ? (value as { stages?: unknown }).stages : undefined;
      present[key] = Array.isArray(stages) && stages.length > 0;
    }
    if (['architecture', 'coreObject'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      present[key] = Object.values(value).some((item) => Array.isArray(item) ? item.length > 0
        : item !== null && typeof item === 'object' ? Object.keys(item).length > 0
          : typeof item === 'string' && item.trim().length > 0);
    }
  }
  return Object.fromEntries(COLLECTION_SECTIONS.map((key) => [key, present[key] ?? false])) as Record<CollectionSection, boolean>;
}
