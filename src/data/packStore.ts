import type { LText } from './schema.ts';
import { appStorage as localStorage, hasDeviceStorage, readDeviceBinary, writeDeviceBinary } from './deviceStorage.ts';
import {
  composePack, isCompanyLayer, mergeCompanyLayers, referencedIn, removedIds, splitPack, type CompanyLayer, type CompanyMergePolicy,
} from './packLayers.ts';

/**
 * FR-302: imported packs use device storage; IndexedDB remains the legacy backend for migration and unit tests.
 * FR-342: the company layer of a Project pack is stored once per company (`bas.binary.company.<companyId>`) and the
 * project layer per project (`bas.binary.pack.<projectId>`); loading composes both.
 */
export interface ImportedPackMeta {
  projectId: string;
  packId: string;
  company: { name: LText; industry: LText };
  isSample: boolean;
  entities: number;
  importedAt: string;
  files: string[];
}

export const PACK_INDEX_KEY = 'bas.packs.index';
const DB_NAME = 'bas-packs';
const STORE = 'packs';

type Slot = 'pack' | 'company';

interface Backend {
  get(slot: Slot, id: string): Promise<unknown | null>;
  put(slot: Slot, id: string, value: unknown): Promise<void>;
  delete(slot: Slot, id: string): Promise<void>;
}

/** Memory and IndexedDB keep project packs under the bare project id (as before the split). */
const localKey = (slot: Slot, id: string) => (slot === 'pack' ? id : `company:${id}`);

class MemoryBackend implements Backend {
  private readonly map = new Map<string, unknown>();
  async get(slot: Slot, id: string) { const k = localKey(slot, id); return this.map.has(k) ? structuredClone(this.map.get(k)) : null; }
  async put(slot: Slot, id: string, value: unknown) { this.map.set(localKey(slot, id), structuredClone(value)); }
  async delete(slot: Slot, id: string) { this.map.delete(localKey(slot, id)); }
}

class IdbBackend implements Backend {
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return this.db;
  }
  private async tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error ?? new Error('IndexedDB transaction failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
  async get(slot: Slot, id: string) { return (await this.tx('readonly', (s) => s.get(localKey(slot, id)))) ?? null; }
  async put(slot: Slot, id: string, value: unknown) { await this.tx('readwrite', (s) => s.put(value, localKey(slot, id))); }
  async delete(slot: Slot, id: string) { await this.tx('readwrite', (s) => s.delete(localKey(slot, id))); }
}

let backend: Backend | null = null;
class DeviceBackend implements Backend {
  async get(slot: Slot, id: string) { return readDeviceBinary(`bas.binary.${slot}.${id}`); }
  async put(slot: Slot, id: string, value: unknown) { await writeDeviceBinary(`bas.binary.${slot}.${id}`, value); }
  async delete(slot: Slot, id: string) { await writeDeviceBinary(`bas.binary.${slot}.${id}`, null); }
}
const store = (): Backend => (backend ??= hasDeviceStorage() ? new DeviceBackend() : typeof indexedDB === 'undefined' ? new MemoryBackend() : new IdbBackend());

/** Tests swap in a memory backend. */
export function setMemoryPackStore() {
  backend = new MemoryBackend();
}

/** The company a project belongs to (registered by the projects store; none = the pack is stored whole, as before FR-342). */
let companyOf: (projectId: string) => string | undefined = () => undefined;
export function setPackCompanyResolver(fn: (projectId: string) => string | undefined) {
  companyOf = fn;
}

export function importedPacks(): Record<string, ImportedPackMeta> {
  try {
    const raw = localStorage.getItem(PACK_INDEX_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ImportedPackMeta>) : {};
  } catch {
    return {};
  }
}

export function importedPackMeta(projectId: string): ImportedPackMeta | null {
  return importedPacks()[projectId] ?? null;
}

function writeIndex(index: Record<string, ImportedPackMeta>) {
  localStorage.setItem(PACK_INDEX_KEY, JSON.stringify(index));
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A shared company entity cannot be removed while another project of the company still points at it. */
export class SharedDataInUseError extends Error {
  readonly uses: { projectId: string; ids: string[] }[];
  constructor(uses: { projectId: string; ids: string[] }[]) {
    super(`Shared company data is used by other projects: ${uses.map((u) => `${u.projectId} (${u.ids.join(', ')})`).join('; ')}`);
    this.name = 'SharedDataInUseError';
    this.uses = uses;
  }
}

export async function loadCompanyLayer(companyId: string): Promise<CompanyLayer | null> {
  const raw = await store().get('company', companyId);
  return isCompanyLayer(raw) ? raw : null;
}

export async function deleteCompanyLayer(companyId: string): Promise<void> {
  await store().delete('company', companyId);
}

/** Merges a company layer (e.g. from a Project pack file) into the stored one and returns the previous layer for rollback. */
export async function mergeIntoCompanyLayer(companyId: string, incoming: CompanyLayer, policy: CompanyMergePolicy): Promise<CompanyLayer | null> {
  const before = await loadCompanyLayer(companyId);
  await store().put('company', companyId, mergeCompanyLayers(before, incoming, policy));
  return before;
}

/** Puts back a layer captured before a failed import (null = there was none). */
export async function restoreCompanyLayer(companyId: string, layer: CompanyLayer | null): Promise<void> {
  if (layer) await store().put('company', companyId, layer);
  else await store().delete('company', companyId);
}

/** The project's own layer as stored (no company layer applied). */
export async function loadProjectLayer(projectId: string): Promise<unknown | null> {
  if (!importedPackMeta(projectId)) return null;
  return store().get('pack', projectId);
}

export interface SavePackOptions {
  /**
   * How the pack's company part reaches the shared layer. 'replace' (default): the pack was edited from the composed
   * view, so its company part is the new shared layer. 'keep' / 'incoming': a new pack (import, generation) is merged
   * into the shared layer; nothing is removed and the policy decides same-id conflicts.
   */
  company?: 'replace' | CompanyMergePolicy;
  /** The project's company when the project is not registered yet (importing a Project pack). */
  companyId?: string;
}

/** All or nothing (FR-302): the index is only updated after the pack itself is stored; a failure leaves both unchanged. */
export async function saveImportedPack(meta: ImportedPackMeta, pack: unknown, options: SavePackOptions = {}): Promise<void> {
  const companyId = options.companyId ?? companyOf(meta.projectId);
  if (!companyId || !isRecord(pack)) {
    await saveWhole(meta, pack);
    return;
  }
  const { company: part, project } = splitPack(pack);
  const before = await loadCompanyLayer(companyId);
  const mode = options.company ?? 'replace';
  const next = mode === 'replace' ? part : mergeCompanyLayers(before, part, mode);
  const removed = removedIds(before, next);
  if (removed.length) {
    const uses: { projectId: string; ids: string[] }[] = [];
    for (const other of Object.keys(importedPacks())) {
      if (other === meta.projectId || companyOf(other) !== companyId) continue;
      const layer = await store().get('pack', other);
      const ids = isRecord(layer) ? referencedIn(layer, removed) : [];
      if (ids.length) uses.push({ projectId: other, ids });
    }
    if (uses.length) throw new SharedDataInUseError(uses);
  }
  const previous = await store().get('pack', meta.projectId);
  await store().put('company', companyId, next);
  try {
    await store().put('pack', meta.projectId, project);
    writeIndex({ ...importedPacks(), [meta.projectId]: meta });
  } catch (err) {
    if (before === null) await store().delete('company', companyId);
    else await store().put('company', companyId, before);
    if (previous === null) await store().delete('pack', meta.projectId);
    else await store().put('pack', meta.projectId, previous);
    throw err;
  }
}

async function saveWhole(meta: ImportedPackMeta, pack: unknown) {
  const previous = await store().get('pack', meta.projectId);
  await store().put('pack', meta.projectId, pack);
  try {
    writeIndex({ ...importedPacks(), [meta.projectId]: meta });
  } catch (err) {
    if (previous === null) await store().delete('pack', meta.projectId);
    else await store().put('pack', meta.projectId, previous);
    throw err;
  }
}

/** The pack a project works on: the shared company layer composed with the project's own layer. */
export async function loadImportedPack(projectId: string): Promise<unknown | null> {
  const layer = await loadProjectLayer(projectId);
  if (!isRecord(layer)) return layer;
  const companyId = companyOf(projectId);
  return composePack(companyId ? await loadCompanyLayer(companyId) : null, layer);
}

/** Removes the project's layer only; the company layer stays for the company's other projects. */
export async function deleteImportedPack(projectId: string): Promise<void> {
  const index = importedPacks();
  if (index[projectId]) {
    delete index[projectId];
    writeIndex(index);
  }
  await store().delete('pack', projectId);
}
