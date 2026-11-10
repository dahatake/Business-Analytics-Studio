import { z } from 'zod';
import { CoreObjectExtension } from '../../data/extensionSchemas.ts';
export { CoreObjectExtension } from '../../data/extensionSchemas.ts';
import { entitiesOf, getEntity, loaded, type LoadedPack } from '../../data/pack.ts';
import type { EntityOf } from '../../data/schema.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import type { Audience } from '../../state/settings.ts';
import type { Label } from './model.ts';
import type { Localizable } from '../../state/text.ts';

export type CoreObjectExtension = z.infer<typeof CoreObjectExtension>;

export interface CoreCandidate {
  id: string;
  kind: 'product' | 'site' | 'custom';
  name: Localizable;
  summary?: Localizable;
  /** Pack entity the 3D twin is built from (custom candidates may match one by name). */
  entityId?: string;
  /** Plant the twin shows. */
  siteId?: string;
  /** Deal value (JPY) linked to the candidate: deals split evenly over their products. */
  dealValueJpy: number;
  dealCount: number;
  /** Pack-provided comparison values (criterion id → text). */
  scores?: Record<string, string>;
}

export interface CoreObjectChoice {
  candidates: CoreCandidate[];
  defaultId: string | undefined;
  reason: Label | undefined;
  criteria: { id: string; label: string }[];
  fromPack: boolean;
}

function dealValues(data: LoadedPack) {
  const value = new Map<string, number>();
  const count = new Map<string, number>();
  for (const d of entitiesOf('deal', data)) {
    const share = d.valueJpy / d.productIds.length;
    for (const p of d.productIds) {
      value.set(p, (value.get(p) ?? 0) + share);
      count.set(p, (count.get(p) ?? 0) + 1);
    }
  }
  return { value, count };
}

function matchEntity(name: string, data: LoadedPack) {
  const n = name.trim().toLowerCase();
  return data.pack.entities.find((e) => (e.kind === 'product' || e.kind === 'site') && (e.name.ja.toLowerCase() === n || e.name.en.toLowerCase() === n));
}

/**
 * FR-018: candidates for the core object (products and plants) and the reason for the default choice.
 * Default rule (interpretation): the product carrying the largest share of deal value, because the discussion is about
 * what the business sells; the twin shows the plant that makes it. A pack's own `coreObject` (§3.6) takes precedence.
 */
export function coreObjectChoice(data: LoadedPack = loaded, audience: Audience = 'internal'): CoreObjectChoice {
  const { value, count } = dealValues(data);
  const visible = <T extends EntityOf<'product'> | EntityOf<'site'>>(e: T) => !isHidden(e, audience);
  const products = entitiesOf('product', data).filter(visible);
  const plants = entitiesOf('site', data).filter((s) => s.role === 'plant').filter(visible);
  const total = [...value.values()].reduce((a, b) => a + b, 0);

  const productCandidates: CoreCandidate[] = products.map((p) => ({
    id: p.id, kind: 'product', name: p.name, summary: p.description, entityId: p.id, siteId: p.siteId,
    dealValueJpy: Math.round(value.get(p.id) ?? 0), dealCount: count.get(p.id) ?? 0,
  }));
  const siteCandidates: CoreCandidate[] = plants.map((s) => {
    const made = products.filter((p) => p.siteId === s.id);
    return {
      id: s.id, kind: 'site', name: s.name, summary: s.description, entityId: s.id, siteId: s.id,
      dealValueJpy: Math.round(made.reduce((a, p) => a + (value.get(p.id) ?? 0), 0)),
      dealCount: made.reduce((a, p) => a + (count.get(p.id) ?? 0), 0),
    };
  });

  const ext = CoreObjectExtension.safeParse(data.pack.extensions?.coreObject);
  if (ext.success && ext.data.candidates && ext.data.candidates.length > 0) {
    const custom: CoreCandidate[] = ext.data.candidates.flatMap((c, i) => {
      const name = c.name ?? c.label;
      if (!name) return [];
      const match = matchEntity(name, data);
      const siteId = match?.kind === 'product' ? match.siteId : match?.kind === 'site' ? match.id : plants[0]?.id;
      return [{
        id: `core-${i}`, kind: 'custom' as const, name, summary: c.summary, entityId: match?.id, siteId,
        dealValueJpy: match ? Math.round(value.get(match.id) ?? 0) : 0, dealCount: match ? count.get(match.id) ?? 0 : 0,
        scores: c.scores,
      }];
    });
    if (custom.length > 0) {
      return {
        candidates: custom,
        defaultId: custom[0]!.id,
        reason: ext.data.reason ? { text: ext.data.reason } : undefined,
        criteria: ext.data.criteria ?? [],
        fromPack: true,
      };
    }
  }

  const ranked = [...productCandidates].sort((a, b) => b.dealValueJpy - a.dealValueJpy);
  const best = ranked[0] ?? siteCandidates[0];
  let reason: Label | undefined;
  if (best && best.kind === 'product') {
    const site = best.siteId ? getEntity(best.siteId, data) : undefined;
    reason = {
      key: 'td.core.reason',
      vars: {
        name: best.name as Exclude<Localizable, string>,
        share: total > 0 ? Math.round((best.dealValueJpy / total) * 100) : 0,
        site: site ? site.name : '—',
      },
    };
  } else if (best) {
    reason = { key: 'td.core.reasonSite', vars: { name: best.name as Exclude<Localizable, string> } };
  }
  return {
    candidates: [...ranked, ...siteCandidates],
    defaultId: best?.id,
    reason,
    criteria: [],
    fromPack: false,
  };
}
