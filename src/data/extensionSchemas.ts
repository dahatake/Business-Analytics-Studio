import { z } from 'zod';
import { LocalizableSchema } from '../modules/project/model.ts';

export const GlossaryEntrySchema = z.object({
  term: LocalizableSchema,
  definition: LocalizableSchema,
  it: LocalizableSchema.optional(),
});
export const GlossarySchema = z.array(GlossaryEntrySchema);

const LayerItem = z.object({
  layer: z.enum(['edge', 'data', 'intelligence', 'process', 'experience']),
  name: z.string().min(1),
});
export const ArchitectureExtension = z.object({
  asIs: z.array(LayerItem).optional(),
  toBe: z.array(LayerItem).optional(),
}).passthrough();

export const CoreObjectExtension = z.object({
  candidates: z.array(z.object({
    name: z.string().optional(),
    label: z.string().optional(),
    summary: z.string().optional(),
    scores: z.record(z.string(), z.string()).optional(),
  }).passthrough()).optional(),
  criteria: z.array(z.object({ id: z.string(), label: z.string() }).passthrough()).optional(),
  reason: z.string().optional(),
}).passthrough();
