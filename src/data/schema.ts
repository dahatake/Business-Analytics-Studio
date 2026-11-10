import { z } from 'zod';

/** Bilingual text. Every user-visible sample string must provide both languages (F-3.5.1). */
export const LText = z.object({ ja: z.string().min(1), en: z.string().min(1) });
export type LText = z.infer<typeof LText>;

/** §3.7 world / type identifiers as written in a customer pack. */
export const World = z.enum(['real', 'digital']);
export const EntityType = z.enum([
  'site', 'equipment', 'person', 'organization', 'operation', 'thing', 'event',
  'data', 'model', 'system', 'ui-component', 'metric',
]);
/** FR-117 / FR-002: confidentiality. `internal` must not be shown to an external audience. */
export const Classification = z.enum(['internal', 'shareable']);
/** FR-116: who authored the value. */
export const Author = z.enum(['ai', 'human', 'sample']);

/** App-level entity kinds (each maps to a §3.7 world/type). */
export const EntityKind = z.enum([
  'site', 'person', 'customer', 'product', 'deal', 'deliverable', 'invoice',
  'issue', 'cause', 'solution', 'kpi', 'initiative', 'supplier', 'source',
]);
export type EntityKind = z.infer<typeof EntityKind>;

const base = {
  id: z.string().regex(/^[a-z]+-[a-z0-9-]+$/),
  name: LText,
  description: LText,
  world: World,
  type: EntityType,
  classification: Classification,
  author: Author,
  sourceIds: z.array(z.string()),
};

export const IllustrationSpec = z.object({
  motif: z.string(),
  hue: z.number().min(0).max(360),
});
export type IllustrationSpec = z.infer<typeof IllustrationSpec>;

export const PortraitSpec = z.object({
  skin: z.enum(['light', 'medium', 'tan', 'deep']),
  hair: z.enum(['short', 'crop', 'bob', 'long', 'bun', 'receding']),
  hairColor: z.enum(['black', 'brown', 'gray', 'white', 'auburn']),
  glasses: z.boolean(),
  beard: z.boolean(),
  outfitHue: z.number().min(0).max(360),
});
export type PortraitSpec = z.infer<typeof PortraitSpec>;

export const Site = z.object({
  ...base, kind: z.literal('site'),
  role: z.enum(['hq', 'plant', 'dc']),
  lat: z.number(), lon: z.number(),
  capacityTPerMonth: z.number().nonnegative(),
});
export const Person = z.object({
  ...base, kind: z.literal('person'),
  role: LText,
  /** Optional (FR-241): real people imported from customer files keep these personal attributes out unless the source states them. */
  ageBand: z.enum(['20s', '30s', '40s', '50s', '60s']).optional(),
  gender: z.enum(['female', 'male']).optional(),
  siteId: z.string(),
  portrait: PortraitSpec.optional(),
});
export const Customer = z.object({
  ...base, kind: z.literal('customer'),
  industry: LText,
  regionId: z.string(),
  illustration: IllustrationSpec,
});
export const Product = z.object({
  ...base, kind: z.literal('product'),
  category: LText,
  siteId: z.string(),
  unitPriceJpy: z.number().positive(),
  illustration: IllustrationSpec,
});
export const Deal = z.object({
  ...base, kind: z.literal('deal'),
  customerId: z.string(),
  productIds: z.array(z.string()).min(1),
  ownerId: z.string(),
  stage: z.enum(['lead', 'proposal', 'negotiation', 'won', 'delivered']),
  valueJpy: z.number().positive(),
  closeDate: z.iso.date(),
});
export const Deliverable = z.object({
  ...base, kind: z.literal('deliverable'),
  dealId: z.string(),
  dueDate: z.iso.date(),
  status: z.enum(['planned', 'inProgress', 'done']),
});
export const Invoice = z.object({
  ...base, kind: z.literal('invoice'),
  deliverableId: z.string(),
  amountJpy: z.number().positive(),
  issuedDate: z.iso.date(),
  status: z.enum(['draft', 'sent', 'paid', 'overdue']),
});
export const Issue = z.object({
  ...base, kind: z.literal('issue'),
  impact: z.number().min(1).max(5),
  feasibility: z.number().min(1).max(5),
  causeIds: z.array(z.string()),
  kpiIds: z.array(z.string()),
});
export const Cause = z.object({ ...base, kind: z.literal('cause') });
export const Solution = z.object({
  ...base, kind: z.literal('solution'),
  issueIds: z.array(z.string()).min(1),
  kpiIds: z.array(z.string()),
  msProducts: z.array(z.string()),
  costJpy: z.number().positive(),
  annualBenefitJpy: z.number().positive(),
});
export const Kpi = z.object({
  ...base, kind: z.literal('kpi'),
  unit: LText,
  baseline: z.number(),
  current: z.number(),
  target: z.number(),
  direction: z.enum(['increase', 'decrease']),
  /** ratio: a true zero exists and "x% of the way to target" is meaningful. interval: arbitrary zero / signed scale. */
  scale: z.enum(['ratio', 'interval']),
  period: LText,
  ownerId: z.string(),
});
export const Initiative = z.object({
  ...base, kind: z.literal('initiative'),
  solutionId: z.string(),
  start: z.iso.date(),
  end: z.iso.date(),
  progress: z.number().min(0).max(1),
  dependsOn: z.array(z.string()),
  ownerId: z.string(),
});
export const Supplier = z.object({ ...base, kind: z.literal('supplier'), regionId: z.string() });
export const Source = z.object({
  ...base, kind: z.literal('source'),
  publisher: LText,
  publishedDate: z.iso.date().optional(),
  url: z.url({ protocol: /^https?$/ }).optional(),
  accessedDate: z.iso.date().optional(),
  locator: z.string().min(1).optional(),
  origin: z.enum(['web', 'm365']).optional(),
});

export const Entity = z.discriminatedUnion('kind', [
  Site, Person, Customer, Product, Deal, Deliverable, Invoice, Issue, Cause,
  Solution, Kpi, Initiative, Supplier, Source,
]);
export type Entity = z.infer<typeof Entity>;
export type EntityOf<K extends EntityKind> = Extract<Entity, { kind: K }>;

export const Region = z.object({ id: z.string(), name: LText });
export type Region = z.infer<typeof Region>;

/** Material flow for the Sankey (supplier → plant → DC → customer). Values are tonnes per month. */
export const Flow = z.object({
  source: z.string(),
  target: z.string(),
  valueT: z.number().positive(),
  sourceIds: z.array(z.string()).optional(),
});
export type Flow = z.infer<typeof Flow>;

/** Optimization input: plants supply regions (a transportation problem). */
export const OptimizationInput = z.object({
  period: LText,
  sourceIds: z.array(z.string()).optional(),
  plants: z.array(z.object({
    siteId: z.string(),
    capacityT: z.number().int().positive(),
    productionCostPerT: z.number().nonnegative(),
    co2PerT: z.number().nonnegative(),
  })).min(1),
  regionDemandT: z.array(z.number().int().nonnegative()).min(1),
  /** transportCostPerT[plantIndex][regionIndex] (JPY). */
  transportCostPerT: z.array(z.array(z.number().nonnegative())),
  leadTimeDays: z.array(z.array(z.number().nonnegative())),
  co2TransportPerT: z.array(z.array(z.number().nonnegative())),
  /** Current (before) allocation in tonnes, same shape as transport. */
  currentAllocation: z.array(z.array(z.number().int().nonnegative())),
});
export type OptimizationInput = z.infer<typeof OptimizationInput>;

export const CustomerPack = z.object({
  packId: z.string(),
  company: z.object({ name: LText, industry: LText }),
  /** FR-008: sample packs are labelled as sample everywhere. */
  isSample: z.boolean(),
  regions: z.array(Region),
  entities: z.array(Entity),
  flows: z.array(Flow),
  /** Optional (FR-241): packs built from customer files often have no capacity/cost data; the optimize screen then says so. */
  optimization: OptimizationInput.optional(),
  /**
   * Optional module data (FR-241: optional items stay backward compatible). Each feature module validates
   * its own key with its own schema, e.g. extensions.brand, extensions.glossary, extensions.dataCatalog.
   */
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type CustomerPack = z.infer<typeof CustomerPack>;
