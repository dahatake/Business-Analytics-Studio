import type { LText } from './schema.ts';
import { appStorage as localStorage, hasDeviceStorage, readDeviceBinary, writeDeviceBinary } from './deviceStorage.ts';

/**
 * FR-302: imported packs use device storage; IndexedDB remains the legacy backend for migration and unit tests.
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

interface Backend {
  get(projectId: string): Promise<unknown | null>;
  put(projectId: string, pack: unknown): Promise<void>;
  delete(projectId: string): Promise<void>;
}

class MemoryBackend implements Backend {
  private readonly map = new Map<string, unknown>();
  async get(id: string) { return this.map.has(id) ? structuredClone(this.map.get(id)) : null; }
  async put(id: string, pack: unknown) { this.map.set(id, structuredClone(pack)); }
  async delete(id: string) { this.map.delete(id); }
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
  async get(id: string) { return (await this.tx('readonly', (s) => s.get(id))) ?? null; }
  async put(id: string, pack: unknown) { await this.tx('readwrite', (s) => s.put(pack, id)); }
  async delete(id: string) { await this.tx('readwrite', (s) => s.delete(id)); }
}

let backend: Backend | null = null;
class DeviceBackend implements Backend {
  async get(id: string) { return readDeviceBinary(`bas.binary.pack.${id}`); }
  async put(id: string, pack: unknown) { await writeDeviceBinary(`bas.binary.pack.${id}`, pack); }
  async delete(id: string) { await writeDeviceBinary(`bas.binary.pack.${id}`, null); }
}
const store = (): Backend => (backend ??= hasDeviceStorage() ? new DeviceBackend() : typeof indexedDB === 'undefined' ? new MemoryBackend() : new IdbBackend());

/** Tests swap in a memory backend. */
export function setMemoryPackStore() {
  backend = new MemoryBackend();
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

/** All or nothing (FR-302): the index is only updated after the pack itself is stored; a failure leaves both unchanged. */
export async function saveImportedPack(meta: ImportedPackMeta, pack: unknown): Promise<void> {
  const previous = await store().get(meta.projectId);
  await store().put(meta.projectId, pack);
  try {
    writeIndex({ ...importedPacks(), [meta.projectId]: meta });
  } catch (err) {
    if (previous === null) await store().delete(meta.projectId);
    else await store().put(meta.projectId, previous);
    throw err;
  }
}

export async function loadImportedPack(projectId: string): Promise<unknown | null> {
  if (!importedPackMeta(projectId)) return null;
  return store().get(projectId);
}

export async function deleteImportedPack(projectId: string): Promise<void> {
  const index = importedPacks();
  if (index[projectId]) {
    delete index[projectId];
    writeIndex(index);
  }
  await store().delete(projectId);
}
