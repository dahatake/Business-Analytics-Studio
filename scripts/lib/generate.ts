import { stampKpiDefinition } from '../../src/data/kpiDefinition.ts';
import { samplePack } from '../../src/data/sample.ts';
import { findPreset, DEFAULT_PRESET_ID } from '../../src/modules/ops/presets.ts';
import type { ResearchCache } from './research.ts';
import { demoWorkflow } from '../../src/modules/process/demo.ts';
import { METRIC_FIELDS, type StepMetrics, type WorkflowExtension } from '../../src/data/extensionSchemas.ts';

function sampleProcess(lang: 'ja' | 'en'): WorkflowExtension {
  const note = lang === 'ja' ? '架空のサンプル業務プロセスです。数値は概算の初期値で、顧客の実測ではありません。社内資料から再作成・確認してください。' : 'Fictional sample process. Numbers are provisional starting assumptions, not customer measurements. Rebuild and verify from internal records.';
  const metrics = (m: StepMetrics | undefined): StepMetrics => {
    const values = { touchMinutes: 30, waitHours: 4, volumePerMonth: 20, firstPassPct: 90, people: 1, ...m };
    return { ...values, basis: 'estimate', evidence: Object.fromEntries(METRIC_FIELDS.map((field) => [field, { status: 'estimate', method: note, sourceIds: [] }])) };
  };
  return {
    ...structuredClone(demoWorkflow), draftNote: note,
    laborCostEvidence: { status: 'estimate', method: note, sourceIds: [] },
    stages: demoWorkflow.stages.map((s) => ({
      ...structuredClone(s), description: s.description ?? note, data: s.data?.length ? s.data : [note],
      activities: s.activities.length ? s.activities : [s.name],
      inputs: s.inputs.length ? s.inputs : [{ name: note, form: 'other' }],
      outputs: s.outputs.length ? s.outputs : [{ name: note, form: 'other' }],
      asIs: s.toBe?.change === 'new' ? undefined : metrics(s.asIs),
      toBe: { change: 'keep', ...s.toBe, basis: 'hypothesis', note: s.toBe?.note ?? note, metrics: s.toBe?.change === 'remove' || s.toBe?.change === 'combine' ? undefined : metrics(s.toBe?.metrics ?? s.asIs) },
    })),
  };
}

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
    workflow: sampleProcess(input.lang),
    // FR-313: public research never holds the customer's internal KPI/OKR definition; the app prompts to define it.
    okr: { ...stampKpiDefinition({}, 0, [...cache.sources.filter((s) => s.status !== 'blocked').map((s) => s.id), ...cache.webPages.map((p) => p.url)]), definitionStatus: 'notRetrieved' },
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
