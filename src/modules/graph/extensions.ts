import { z } from 'zod';
import { LText } from '../../data/schema.ts';
import type { LoadedPack } from '../../data/pack.ts';

/** FR-235: the nine semantic types of a relation. */
export const SEMANTICS = [
  'influence', 'dependency', 'causality', 'ownership', 'lineage', 'membership', 'placement', 'measurement', 'control',
] as const;
export const Semantic = z.enum(SEMANTICS);
export type Semantic = z.infer<typeof Semantic>;

/** FR-214 / §3.4 ツイン関係: how a digital entity corresponds to a real one. */
export const TWIN_KINDS = ['represents', 'measures', 'records', 'displays'] as const;
export const TwinKind = z.enum(TWIN_KINDS);
export type TwinKind = z.infer<typeof TwinKind>;

/** FR-239 / §3.4 Twin の層. */
export const LAYERS = ['operations', 'experience', 'insights'] as const;
export const Layer = z.enum(LAYERS);
export type Layer = z.infer<typeof Layer>;

/** FR-239 / §3.4 Twin の流れ: data = real → digital, control = digital → real. */
export const FlowKind = z.enum(['data', 'control']);
export type FlowKind = z.infer<typeof FlowKind>;

/** FR-241 KPI stages (interpretation: logic-model stage of a KPI). */
export const KPI_STAGES = ['input', 'process', 'output', 'outcome'] as const;
export const KpiStage = z.enum(KPI_STAGES);
export type KpiStage = z.infer<typeof KpiStage>;

const SemanticOverride = z.object({ semantic: Semantic.optional(), label: LText.optional() });
const ExtraRelation = z.object({ source: z.string(), target: z.string(), semantic: Semantic, label: LText.optional() });
const TwinDecl = z.object({ digital: z.string(), real: z.string(), kind: TwinKind });
const FlowDecl = z.object({ source: z.string(), target: z.string(), kind: FlowKind, label: LText.optional() });

/**
 * `extensions.graph` of a customer pack (FR-241). Every section is optional so older packs stay valid; a section
 * that fails validation is dropped on its own (the rest still loads, like FR-102).
 */
export const GraphExtensionSchema = z.object({
  /** Customer-language labels and semantic types per relation type (keys are RelationType values). */
  semantics: z.record(z.string(), SemanticOverride).optional(),
  relations: z.array(ExtraRelation).optional(),
  twins: z.array(TwinDecl).optional(),
  flows: z.array(FlowDecl).optional(),
  layers: z.record(z.string(), Layer).optional(),
  kpiStages: z.record(z.string(), KpiStage).optional(),
});
export type GraphExtension = z.infer<typeof GraphExtensionSchema>;

export interface NormalizedGraphExtension {
  semantics: Record<string, { semantic?: Semantic; label?: LText }>;
  relations: z.infer<typeof ExtraRelation>[];
  twins: z.infer<typeof TwinDecl>[];
  flows: z.infer<typeof FlowDecl>[];
  layers: Record<string, Layer>;
  kpiStages: Record<string, KpiStage>;
}

export interface ExtensionResult {
  ext: NormalizedGraphExtension;
  /** Ignored sections / items, as `path: message`. */
  issues: string[];
  /** Whether the pack supplied the data (false = derived defaults / demo data). */
  fromPack: boolean;
}

const EMPTY: NormalizedGraphExtension = { semantics: {}, relations: [], twins: [], flows: [], layers: {}, kpiStages: {} };

/** Demo data used for the sample pack (module guide: fall back to demo data when the pack is the sample). */
export const DEMO_GRAPH_EXTENSION: GraphExtension = {
  layers: { 'kpi-engagement': 'experience', 'sol-knowledge-copilot': 'experience', 'sol-energy-twin': 'operations' },
  kpiStages: {
    'kpi-engagement': 'input', 'kpi-defect': 'process', 'kpi-lead-time': 'process',
    'kpi-otd': 'output', 'kpi-dso': 'output', 'kpi-co2': 'outcome',
  },
};

/**
 * Validate `extensions.graph` gracefully: absent → defaults, a valid object → used, invalid sections or items
 * → dropped with an issue each. References to unknown entities are dropped too. Never throws.
 */
export function parseGraphExtension(raw: unknown, knownIds?: Set<string>): ExtensionResult {
  if (raw === undefined || raw === null) return { ext: { ...EMPTY }, issues: [], fromPack: false };
  const issues: string[] = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ext: { ...EMPTY }, issues: ['graph: expected an object'], fromPack: false };
  }
  const obj = raw as Record<string, unknown>;
  const ext: NormalizedGraphExtension = { semantics: {}, relations: [], twins: [], flows: [], layers: {}, kpiStages: {} };
  const known = (id: string) => !knownIds || knownIds.has(id);

  const section = <T>(key: keyof GraphExtension, schema: z.ZodType<T>): T | undefined => {
    if (obj[key] === undefined) return undefined;
    const r = schema.safeParse(obj[key]);
    if (r.success) return r.data;
    issues.push(`graph.${key}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    return undefined;
  };
  const items = <T>(key: 'relations' | 'twins' | 'flows', schema: z.ZodType<T>, refs: (v: T) => string[]): T[] => {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      issues.push(`graph.${key}: expected an array`);
      return [];
    }
    const out: T[] = [];
    v.forEach((item, i) => {
      const r = schema.safeParse(item);
      if (!r.success) issues.push(`graph.${key}[${i}]: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
      else if (!refs(r.data).every(known)) issues.push(`graph.${key}[${i}]: unknown entity`);
      else out.push(r.data);
    });
    return out;
  };

  ext.semantics = section('semantics', GraphExtensionSchema.shape.semantics.unwrap()) ?? {};
  ext.layers = Object.fromEntries(Object.entries(section('layers', GraphExtensionSchema.shape.layers.unwrap()) ?? {}).filter(([id]) => known(id)));
  ext.kpiStages = Object.fromEntries(Object.entries(section('kpiStages', GraphExtensionSchema.shape.kpiStages.unwrap()) ?? {}).filter(([id]) => known(id)));
  ext.relations = items('relations', ExtraRelation, (r) => [r.source, r.target]);
  ext.twins = items('twins', TwinDecl, (r) => [r.digital, r.real]);
  ext.flows = items('flows', FlowDecl, (r) => [r.source, r.target]);
  return { ext, issues, fromPack: true };
}

/** The graph extension for a loaded pack: customer data when present, demo data for the sample, else defaults. */
export function graphExtensionFor(data: LoadedPack): ExtensionResult {
  const ids = new Set(data.byId.keys());
  const raw = data.pack.extensions?.graph;
  if (raw !== undefined) return parseGraphExtension(raw, ids);
  if (data.pack.isSample) return { ...parseGraphExtension(DEMO_GRAPH_EXTENSION, ids), fromPack: false };
  return parseGraphExtension(undefined);
}
