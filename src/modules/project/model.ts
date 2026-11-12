import { z } from 'zod';
import type { Localizable } from '../../state/text.ts';

/** Bilingual sample text or text typed by the user. */
export const LocalizableSchema = z.union([z.string(), z.object({ ja: z.string(), en: z.string() })]);
export const ClassificationSchema = z.enum(['internal', 'shareable']);
export type Classification = z.infer<typeof ClassificationSchema>;

/* ---------- Discussion (FR-042, FR-048〜FR-050) ---------- */

/** 論点 (discussion theme). `parentId` builds the discussion tree (FR-042). */
export const ThemeSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  title: LocalizableSchema,
  classification: ClassificationSchema,
  /** Customer-pack entity ids this theme concerns (issues, solutions, KPIs, people). */
  relatedIds: z.array(z.string()),
});
export type Theme = z.infer<typeof ThemeSchema>;

/** decision = the customer's decision (human); suggestion = AI proposal (FR-050); action = 次のアクション. */
export const RECORD_KINDS = ['decision', 'suggestion', 'action', 'note'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const DiscussionRecordSchema = z.object({
  id: z.string().min(1),
  themeId: z.string().min(1),
  kind: z.enum(RECORD_KINDS),
  author: z.enum(['human', 'ai']),
  text: LocalizableSchema,
  owner: z.string().optional(),
  due: z.string().optional(),
  done: z.boolean().optional(),
  /** The AI answer came from a registered mock (must be labelled as mock). */
  mock: z.boolean().optional(),
  classification: ClassificationSchema,
  createdAt: z.string(),
});
export type DiscussionRecord = z.infer<typeof DiscussionRecordSchema>;

export const DiscussionDataSchema = z.object({
  themes: z.array(ThemeSchema),
  records: z.array(DiscussionRecordSchema),
});
export type DiscussionData = z.infer<typeof DiscussionDataSchema>;

/* ---------- KPI / OKR (FR-153, FR-154) ---------- */

export const KpiDefSchema = z.object({
  id: z.string().min(1),
  name: LocalizableSchema,
  unit: LocalizableSchema,
  baseline: z.number(),
  current: z.number(),
  target: z.number(),
  deadline: z.string(),
});
export type KpiDef = z.infer<typeof KpiDefSchema>;

export const OkrSchema = z.object({
  id: z.string().min(1),
  objective: LocalizableSchema,
  keyResults: z.array(z.object({ id: z.string().min(1), text: LocalizableSchema, kpiId: z.string().min(1) })).min(1),
});
export type Okr = z.infer<typeof OkrSchema>;

export const KpiDataSchema = z.object({ kpis: z.array(KpiDefSchema), okrs: z.array(OkrSchema) });
export type KpiData = z.infer<typeof KpiDataSchema>;

/* ---------- Analyses (FR-133〜FR-135) ---------- */

export const METHODS = ['swot', 'fiveForces', 'valueChain', 'threeC', 'bsc'] as const;
export type MethodId = (typeof METHODS)[number];

export const AnalysisItemSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  text: LocalizableSchema,
  score: z.number(),
  weight: z.number(),
  author: z.enum(['human', 'ai', 'sample']),
  mock: z.boolean().optional(),
});
export type AnalysisItem = z.infer<typeof AnalysisItemSchema>;

export const AnalysisSchema = z.object({
  id: z.string().min(1),
  method: z.enum(METHODS),
  title: LocalizableSchema,
  items: z.array(AnalysisItemSchema),
  /** Category id → weight (FR-134). */
  weights: z.record(z.string(), z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const AnalysisDataSchema = z.object({ analyses: z.array(AnalysisSchema), activeId: z.string().nullable() });
export type AnalysisData = z.infer<typeof AnalysisDataSchema>;

/** Everything the project module stores per project (exported/restored together). */
export interface ProjectData {
  discussion: DiscussionData;
  kpi: KpiData;
  analysis: AnalysisData;
}

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function textEquals(a: Localizable, b: Localizable): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.ja === b.ja && a.en === b.en;
}
