import type { LoadedPack } from '../../data/pack.ts';
import type { Entity } from '../../data/schema.ts';
import { isNewsDerived } from '../../data/pack.ts';
import { locAll, type Localizable } from '../../state/text.ts';
import type { Analysis, AnalysisItem } from './model.ts';

/**
 * Cross-highlighting between analyses (BI-style linked views).
 * Items carry no entity ids, so the link is derived from what their text names in the Project pack:
 * - same: both items name the same entity, or have the same text;
 * - near: an item names an entity one relation away (e.g. an issue and the KPI it is measured by).
 */
export type LinkKind = 'same' | 'near';

export interface Link {
  kind: LinkKind;
  /** The entity both sides name (same) or the related entity this item names (near); absent for identical text. */
  entityId?: string;
}

/** What the user picked: some items of one analysis (one item, or every item of a category). */
export interface LinkSelection {
  analysisId: string;
  itemIds: readonly string[];
}

export const itemKey = (analysisId: string, itemId: string) => `${analysisId}:${itemId}`;

/** Kinds whose names are too generic or not business objects to link on. */
const SKIP_KINDS = new Set<Entity['kind']>(['source']);
/** Provenance edges would link everything cited from the same document. */
const SKIP_EDGES = new Set(['citedFrom']);
const ASCII = /^[\x20-\x7e]+$/;

interface Matcher { id: string; tests: ((text: string) => boolean)[] }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Tests that find a name inside lower-cased item text. Short Latin names ("IT", "EU") would match inside unrelated
 * words, so Latin names need 4+ characters and word boundaries; other scripts need 2+ characters.
 */
export function nameTests(name: Localizable): ((text: string) => boolean)[] {
  return [...new Set(locAll(name).map((n) => n.trim().toLowerCase()))]
    .filter((n) => (ASCII.test(n) ? n.length >= 4 : n.length >= 2))
    .map((n) => {
      if (!ASCII.test(n)) return (tx: string) => tx.includes(n);
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(n)}($|[^a-z0-9])`);
      return (tx: string) => re.test(tx);
    });
}

const matchers = new WeakMap<LoadedPack, Matcher[]>();
function matchersOf(data: LoadedPack): Matcher[] {
  let list = matchers.get(data);
  if (!list) {
    list = data.pack.entities.filter((e) => !SKIP_KINDS.has(e.kind) && !isNewsDerived(e, data.byId))
      .map((e) => ({ id: e.id, tests: nameTests(e.name) }))
      .filter((m) => m.tests.length > 0);
    matchers.set(data, list);
  }
  return list;
}

/** Lower-cased texts of an item in every language. */
export const normText = (item: AnalysisItem) => locAll(item.text).map((s) => s.trim().toLowerCase()).filter(Boolean);

const entityCache = new WeakMap<LoadedPack, WeakMap<AnalysisItem, Set<string>>>();
/** Entity ids an item names in its text (any language). Items are immutable in the store, so the result is cached per object. */
export function itemEntities(item: AnalysisItem, data: LoadedPack): Set<string> {
  let cache = entityCache.get(data);
  if (!cache) entityCache.set(data, (cache = new WeakMap()));
  const hit = cache.get(item);
  if (hit) return hit;
  const texts = normText(item);
  const out = new Set<string>();
  for (const m of matchersOf(data)) {
    if (m.tests.some((test) => texts.some(test))) out.add(m.id);
  }
  cache.set(item, out);
  return out;
}

export function neighborsOf(ids: Iterable<string>, data: LoadedPack): Set<string> {
  const set = new Set(ids);
  const out = new Set<string>();
  for (const e of data.edges) {
    if (SKIP_EDGES.has(e.type)) continue;
    if (isNewsDerived(data.byId.get(e.source), data.byId) || isNewsDerived(data.byId.get(e.target), data.byId)) continue;
    if (set.has(e.source) && !set.has(e.target)) out.add(e.target);
    if (set.has(e.target) && !set.has(e.source)) out.add(e.source);
  }
  return out;
}

/**
 * Items related to the selection, keyed by itemKey(). Selected items themselves are not included.
 * A "same" link wins over a "near" one.
 */
export function relatedItems(sel: LinkSelection, analyses: readonly Analysis[], data: LoadedPack): Map<string, Link> {
  const out = new Map<string, Link>();
  const source = analyses.find((a) => a.id === sel.analysisId);
  if (!source) return out;
  const picked = source.items.filter((i) => sel.itemIds.includes(i.id));
  if (!picked.length) return out;
  const selectedKeys = new Set(picked.map((i) => itemKey(source.id, i.id)));
  const sameEntities = new Set<string>();
  const texts = new Set<string>();
  for (const i of picked) {
    itemEntities(i, data).forEach((id) => sameEntities.add(id));
    normText(i).forEach((tx) => texts.add(tx));
  }
  const nearEntities = neighborsOf(sameEntities, data);
  for (const a of analyses) {
    for (const i of a.items) {
      const key = itemKey(a.id, i.id);
      if (selectedKeys.has(key)) continue;
      const ents = itemEntities(i, data);
      const same = [...ents].find((id) => sameEntities.has(id));
      if (same) { out.set(key, { kind: 'same', entityId: same }); continue; }
      if (normText(i).some((tx) => texts.has(tx))) { out.set(key, { kind: 'same' }); continue; }
      const near = [...ents].find((id) => nearEntities.has(id));
      if (near) out.set(key, { kind: 'near', entityId: near });
    }
  }
  return out;
}
