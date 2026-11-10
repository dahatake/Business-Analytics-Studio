import { ArchitectureExtension } from '../../data/extensionSchemas.ts';
export { ArchitectureExtension } from '../../data/extensionSchemas.ts';
import { entitiesOf, getEntity, loaded, type LoadedPack } from '../../data/pack.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import type { Audience } from '../../state/settings.ts';
import type { MessageKey } from '../../i18n/core.ts';
import type { Label } from './model.ts';

export type ArchMode = 'asis' | 'tobe';
export const ARCH_MODES: ArchMode[] = ['asis', 'tobe'];

/** C4-like container layers, bottom (devices) to top (people-facing). */
export type ArchLayerId = 'edge' | 'data' | 'intelligence' | 'process' | 'experience';
export const ARCH_LAYERS: ArchLayerId[] = ['edge', 'data', 'intelligence', 'process', 'experience'];

export interface ArchBlock {
  id: string;
  layer: ArchLayerId;
  label: Label;
  /** 'product' = a Microsoft product (ToBe); 'current' = an existing system; 'painPoint' = an issue to resolve. */
  role: 'product' | 'current' | 'painPoint';
  /** Solutions that use (ToBe) or will replace (AsIs) the block. */
  solutionIds: string[];
  entityId?: string;
  product?: string;
}

export interface ArchLayer {
  id: ArchLayerId;
  label: MessageKey;
  blocks: ArchBlock[];
}

export interface Architecture {
  mode: ArchMode;
  layers: ArchLayer[];
  /** Pairs of block ids that work together for one solution (drawn as links). */
  links: { from: string; to: string; solutionId: string }[];
}

const KNOWN_LAYER: Record<string, ArchLayerId> = {
  'power bi': 'experience',
  'microsoft 365 copilot': 'experience',
  'microsoft teams': 'experience',
  'power apps': 'experience',
  'power automate': 'process',
  'dynamics 365 finance': 'process',
  'dynamics 365 supply chain management': 'process',
  'azure machine learning': 'intelligence',
  'azure ai vision': 'intelligence',
  'azure ai search': 'intelligence',
  'microsoft foundry': 'intelligence',
  'microsoft fabric': 'data',
  'azure digital twins': 'data',
  'azure sql database': 'data',
  'azure cosmos db': 'data',
  'azure iot operations': 'edge',
  'azure iot hub': 'edge',
  'azure arc': 'edge',
};

/** Layer of a Microsoft product: known table first, then name patterns, else the business-process layer. */
export function productLayer(product: string): ArchLayerId {
  const n = product.trim().toLowerCase();
  const known = KNOWN_LAYER[n];
  if (known) return known;
  if (/power bi|copilot|teams|power apps|portal|viva/.test(n)) return 'experience';
  if (/\bai\b|openai|machine learning|cognitive|vision|speech|search/.test(n)) return 'intelligence';
  if (/fabric|sql|cosmos|data|twins|synapse|storage|lake|purview/.test(n)) return 'data';
  if (/iot|edge|arc|sphere/.test(n)) return 'edge';
  return 'process';
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

const AS_IS_GENERIC: Record<ArchLayerId, MessageKey> = {
  experience: 'td.arch.asis.experience',
  process: 'td.arch.asis.process',
  intelligence: 'td.arch.asis.intelligence',
  data: 'td.arch.asis.data',
  edge: 'td.arch.asis.edge',
};

export const LAYER_LABEL: Record<ArchLayerId, MessageKey> = {
  experience: 'td.arch.layer.experience',
  process: 'td.arch.layer.process',
  intelligence: 'td.arch.layer.intelligence',
  data: 'td.arch.layer.data',
  edge: 'td.arch.layer.edge',
};

/**
 * FR-040: AsIs / ToBe architecture from the pack.
 * ToBe = one block per Microsoft product (msProducts of the visible solutions), placed on its layer.
 * AsIs (interpretation, the pack has no AsIs inventory) = the current way of working on each layer, plus the issues the
 * solutions resolve as pain points on the layer where they will be solved. A pack can override both via extensions.
 */
export function buildArchitecture(mode: ArchMode, data: LoadedPack = loaded, audience: Audience = 'internal'): Architecture {
  const solutions = entitiesOf('solution', data).filter((s) => !isHidden(s, audience));
  const blocks = new Map<string, ArchBlock>();
  const links: Architecture['links'] = [];
  const ext = ArchitectureExtension.safeParse(data.pack.extensions?.architecture);
  const override = ext.success ? (mode === 'asis' ? ext.data.asIs : ext.data.toBe) : undefined;

  if (override && override.length > 0) {
    for (const item of override) {
      const id = `blk-${mode}-${slug(item.name)}`;
      if (!blocks.has(id)) blocks.set(id, { id, layer: item.layer, label: { text: item.name }, role: mode === 'tobe' ? 'product' : 'current', solutionIds: [] });
    }
  } else if (mode === 'tobe') {
    for (const s of solutions) {
      const ids: string[] = [];
      for (const p of s.msProducts) {
        const id = `blk-tobe-${slug(p)}`;
        const b = blocks.get(id) ?? { id, layer: productLayer(p), label: { text: p }, role: 'product' as const, solutionIds: [], product: p };
        if (!b.solutionIds.includes(s.id)) b.solutionIds.push(s.id);
        blocks.set(id, b);
        if (!ids.includes(id)) ids.push(id);
      }
      for (let i = 1; i < ids.length; i++) links.push({ from: ids[i - 1]!, to: ids[i]!, solutionId: s.id });
    }
  } else {
    const allIds = solutions.map((s) => s.id);
    for (const layer of ARCH_LAYERS) {
      const id = `blk-asis-${layer}`;
      blocks.set(id, { id, layer, label: { key: AS_IS_GENERIC[layer] }, role: 'current', solutionIds: [...allIds] });
    }
    for (const s of solutions) {
      const layer = productLayer(s.msProducts[0] ?? '');
      for (const issueId of s.issueIds) {
        const issue = getEntity(issueId, data);
        if (!issue || isHidden(issue, audience)) continue;
        const id = `blk-asis-${issueId}`;
        const b = blocks.get(id) ?? { id, layer, label: { text: issue.name }, role: 'painPoint' as const, solutionIds: [], entityId: issueId };
        if (!b.solutionIds.includes(s.id)) b.solutionIds.push(s.id);
        blocks.set(id, b);
        links.push({ from: `blk-asis-${layer}`, to: id, solutionId: s.id });
      }
    }
  }

  const layers: ArchLayer[] = ARCH_LAYERS.map((id) => ({ id, label: LAYER_LABEL[id], blocks: [...blocks.values()].filter((b) => b.layer === id) }));
  return { mode, layers, links };
}
