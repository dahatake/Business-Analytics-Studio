import { create } from 'zustand';
import { activatePack, loaded, packOrigin, type LoadedPack } from '../data/pack.ts';
import { importedPackMeta, loadImportedPack, saveImportedPack } from '../data/packStore.ts';
import { samplePack } from '../data/sample.ts';
import type { Entity, EntityKind, Region } from '../data/schema.ts';
import { createScopedStore, currentScope, scopedKey } from './projects.ts';
import { appStorage as localStorage } from '../data/deviceStorage.ts';

/**
 * Entities entered in the app (workspace, discussion).
 * - A project with an imported customer pack: written into that pack (it is the project's own data).
 * - Every other target shares the base pack, so edits are kept per scope as an overlay
 *   (`bas.scope.<scope>.pack.edits`) and applied on top of the base pack. Exported with the project file.
 */
export interface PackEdits {
  /** Whole entities, added or replacing a base entity with the same id. */
  upserts: Entity[];
  /** Base entity ids removed in this scope. */
  deleted: string[];
  /** Regions added for new customers. */
  regions: Region[];
}

export type PackChange =
  | { op: 'upsert'; entity: Entity; region?: Region }
  | { op: 'delete'; id: string };

export const emptyEdits = (): PackEdits => ({ upserts: [], deleted: [], regions: [] });

export const PACK_EDITS = 'pack.edits';
export const usePackEdits = createScopedStore<PackEdits>(PACK_EDITS, () => emptyEdits());

/** Bumped after every change so views that read the live `loaded` binding re-render. */
export const usePackVersion = create<{ version: number }>()(() => ({ version: 0 }));

type RawPack = { regions?: unknown[]; entities?: unknown[] } & Record<string, unknown>;

const idOf = (x: unknown): string | undefined =>
  (x !== null && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? (x as { id: string }).id : undefined);

/** Pure: the raw pack with the overlay applied. Replaced entities keep their position; new ones are appended. */
export function applyPackEdits(raw: unknown, edits: PackEdits): unknown {
  const pack = raw as RawPack;
  const upserts = new Map(edits.upserts.map((e) => [e.id, e] as const));
  const deleted = new Set(edits.deleted);
  const seen = new Set<string>();
  const entities: unknown[] = [];
  for (const e of pack.entities ?? []) {
    const id = idOf(e);
    if (id !== undefined && deleted.has(id)) continue;
    if (id !== undefined && upserts.has(id)) {
      entities.push(upserts.get(id));
      seen.add(id);
    } else entities.push(e);
  }
  for (const e of edits.upserts) if (!seen.has(e.id) && !deleted.has(e.id)) entities.push(e);
  const regionIds = new Set((pack.regions ?? []).map(idOf));
  const regions = [...(pack.regions ?? []), ...edits.regions.filter((r) => !regionIds.has(r.id))];
  return { ...pack, regions, entities };
}

/** Pure: record one change in the overlay. */
export function mergeEdit(edits: PackEdits, change: PackChange): PackEdits {
  if (change.op === 'delete') {
    const wasAdded = edits.upserts.some((e) => e.id === change.id);
    return {
      ...edits,
      upserts: edits.upserts.filter((e) => e.id !== change.id),
      deleted: wasAdded || edits.deleted.includes(change.id) ? edits.deleted : [...edits.deleted, change.id],
    };
  }
  const i = edits.upserts.findIndex((e) => e.id === change.entity.id);
  const upserts = i < 0 ? [...edits.upserts, change.entity] : edits.upserts.map((e, j) => (j === i ? change.entity : e));
  const regions = change.region && !edits.regions.some((r) => r.id === change.region!.id) ? [...edits.regions, change.region] : edits.regions;
  return { upserts, deleted: edits.deleted.filter((id) => id !== change.entity.id), regions };
}

/** Pure: apply one change directly to a raw pack (imported packs are edited in place). */
export function applyChange(raw: unknown, change: PackChange): unknown {
  return applyPackEdits(raw, mergeEdit(emptyEdits(), change));
}

/** Entities (and flows) that point at `id`. A referenced entity cannot be deleted without breaking them. */
export function referencesTo(id: string, data: LoadedPack = loaded): string[] {
  const refs: string[] = [];
  for (const e of data.pack.entities) {
    if (e.id === id) continue;
    const hit = Object.entries(e).some(([k, v]) => k !== 'id' && (v === id || (Array.isArray(v) && v.includes(id))));
    if (hit) refs.push(e.id);
  }
  for (const f of data.pack.flows) if (f.source === id || f.target === id) refs.push(`${f.source}->${f.target}`);
  if (data.pack.optimization?.plants.some((p) => p.siteId === id)) refs.push('optimization');
  return refs;
}

const PREFIX: Partial<Record<EntityKind, string>> = {
  customer: 'cust', product: 'prod', person: 'person', site: 'site', deal: 'deal', deliverable: 'dlv',
  invoice: 'inv', issue: 'issue', solution: 'sol', kpi: 'kpi',
};

/** A fresh id that matches the schema (`^[a-z]+-[a-z0-9-]+$`) and is unique in the active pack. */
export function newEntityId(kind: EntityKind | 'region', taken: (id: string) => boolean = (id) => loaded.byId.has(id) || loaded.pack.regions.some((r) => r.id === id)): string {
  const prefix = (kind === 'region' ? 'region' : PREFIX[kind]) ?? kind;
  for (;;) {
    const id = `${prefix}-u${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
    if (!taken(id)) return id;
  }
}

/** The pack every non-imported target starts from (public/data/pack.json or the built-in sample). */
let baseRaw: unknown = samplePack;
export function setBasePackRaw(raw: unknown) {
  baseRaw = raw;
}

export function hasPackEdits(scope: string): boolean {
  const raw = localStorage.getItem(scopedKey(scope, PACK_EDITS));
  if (!raw) return false;
  try {
    const e = JSON.parse(raw) as PackEdits;
    return e.upserts.length + e.deleted.length + e.regions.length > 0;
  } catch {
    return false;
  }
}

/** At boot (and whenever the base pack is active): show the base pack with this scope's overlay. */
export function activateBaseWithEdits(scope: string = currentScope()): LoadedPack {
  const origin = packOrigin.kind === 'imported' ? { kind: 'file' as const } : packOrigin;
  const raw = localStorage.getItem(scopedKey(scope, PACK_EDITS));
  const edits = raw ? (JSON.parse(raw) as PackEdits) : emptyEdits();
  return activatePack(applyPackEdits(baseRaw, edits), origin);
}

/** Save one entity change where it belongs and refresh the active pack. */
export async function commitPackChange(change: PackChange): Promise<void> {
  if (packOrigin.kind === 'imported') {
    const { projectId } = packOrigin;
    const meta = importedPackMeta(projectId);
    const raw = await loadImportedPack(projectId);
    if (!meta || raw === null) throw new Error('Imported customer pack is missing from device storage');
    const next = applyChange(raw, change) as RawPack;
    await saveImportedPack({ ...meta, entities: next.entities?.length ?? meta.entities }, next);
    activatePack(next, packOrigin);
  } else {
    const store = usePackEdits.getState();
    store.set(mergeEdit(store.value, change));
    activatePack(applyPackEdits(baseRaw, usePackEdits.getState().value), packOrigin);
  }
  usePackVersion.setState((s) => ({ version: s.version + 1 }));
}
