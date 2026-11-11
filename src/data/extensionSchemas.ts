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

const SourceIds = z.array(z.string()).optional();

/**
 * The team's own work as a chain of stages (sales and service organisations as well as plants): what comes in, what
 * the team does with it, what it hands over and to which team. Each stage cites the material it comes from.
 */
export const WorkflowExtension = z.object({
  stages: z.array(z.object({
    id: z.string().min(1),
    name: LocalizableSchema,
    team: LocalizableSchema.optional(),
    inputs: z.array(LocalizableSchema).default([]),
    activities: z.array(LocalizableSchema).default([]),
    outputs: z.array(LocalizableSchema).default([]),
    /** Reports, systems and data the stage reads or writes. */
    data: z.array(LocalizableSchema).optional(),
    /** Stage ids that take over the outputs. */
    next: z.array(z.string()).default([]),
    /** A team outside this pack that takes over (e.g. "Account team", "Partner"). */
    handoffTo: z.array(LocalizableSchema).optional(),
    sourceIds: SourceIds,
  }).passthrough()).min(1),
}).passthrough();
export type WorkflowExtension = z.infer<typeof WorkflowExtension>;

/**
 * KPI and OKR definitions as the organisation writes them ("20% of billed revenue", "NSAT ≥ 4.5"). Unlike kpi
 * entities they need no baseline, current value or owner, which internal documents rarely state together.
 */
export const OkrExtension = z.object({
  kpis: z.array(z.object({
    id: z.string().min(1),
    name: LocalizableSchema,
    definition: LocalizableSchema.optional(),
    target: z.string().optional(),
    current: z.string().optional(),
    unit: z.string().optional(),
    period: z.string().optional(),
    owner: LocalizableSchema.optional(),
    sourceIds: SourceIds,
  }).passthrough()).default([]),
  objectives: z.array(z.object({
    id: z.string().min(1),
    objective: LocalizableSchema,
    owner: LocalizableSchema.optional(),
    keyResults: z.array(z.object({
      text: LocalizableSchema,
      target: z.string().optional(),
      period: z.string().optional(),
      /** An id in extensions.okr.kpis or a kpi entity. */
      kpiId: z.string().optional(),
    }).passthrough()).default([]),
    sourceIds: SourceIds,
  }).passthrough()).default([]),
}).passthrough();
export type OkrExtension = z.infer<typeof OkrExtension>;

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
