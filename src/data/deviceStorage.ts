import {
  BINARY_PREFIX, DEVICE_HEADER, DEVICE_PREFIX, DEVICE_TEST_HEADER, isDeviceKey,
  type DeviceChange, type DeviceSnapshot,
} from '../../scripts/lib/deviceProtocol.ts';

export type StorageStatus = 'saved' | 'saving' | 'error' | 'conflict';
let active: DeviceStorage | null = null;
let status: StorageStatus = 'saved';
const listeners = new Set<() => void>();
export const deviceStatus = () => status;
export function subscribeDeviceStatus(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function report(next: StorageStatus) { status = next; listeners.forEach((fn) => fn()); }
const MARKER = 'bas.device.migrated.';
const OUTBOX = 'bas.device.pending.';
const SAVED = 'bas.device.saved';

export class DeviceStorageError extends Error {
  constructor(readonly conflict: boolean, readonly migration = false) { super(conflict ? 'deviceConflict' : 'deviceUnavailable'); }
}

async function request(path: string, token: string | null, body?: unknown): Promise<unknown> {
  const testId = localStorage.getItem('bas.device.test');
  const response = await fetch(`${DEVICE_PREFIX}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { [DEVICE_HEADER]: token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(testId ? { [DEVICE_TEST_HEADER]: testId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new DeviceStorageError(response.status === 409);
  return response.json();
}

function snapshot(value: unknown): DeviceSnapshot {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
    !('records' in value) || !value.records || typeof value.records !== 'object') throw new DeviceStorageError(false);
  for (const [key, record] of Object.entries(value.records)) {
    if (!isDeviceKey(key) || !record || typeof record !== 'object' ||
      !('value' in record) || (record.value !== null && typeof record.value !== 'string') ||
      !('revision' in record) || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
      throw new DeviceStorageError(false);
    }
  }
  return value as DeviceSnapshot;
}

/** Read the old databases without creating or changing them. Original records remain available for recovery. */
async function legacyDatabase(name: string, store: string, prefix: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    let absent = false;
    req.onupgradeneeded = () => { absent = true; req.transaction?.abort(); };
    req.onerror = () => absent ? resolve({}) : reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error('Legacy store missing')); return; }
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const keys = s.getAllKeys();
      const values = s.getAll();
      tx.oncomplete = () => {
        db.close();
        resolve(Object.fromEntries(keys.result.map((key, index) => [`${prefix}${String(key)}`, JSON.stringify(values.result[index])])));
      };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

export async function legacyDeviceData(): Promise<Record<string, string>> {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isDeviceKey(key)) {
      const value = localStorage.getItem(key);
      if (value !== null) data[key] = value;
    }
  }
  return Object.assign(data,
    await legacyDatabase('bas-packs', 'packs', `${BINARY_PREFIX}pack.`),
    await legacyDatabase('bas-ink', 'boards', `${BINARY_PREFIX}ink.`));
}

class DeviceStorage implements Storage {
  private readonly values = new Map<string, string>();
  private pending = new Map<string, DeviceChange>();
  private running: Promise<void> | null = null;
  private readonly outbox: string;
  private stopped = false;
  private readonly failedBinary = new Map<string, unknown>();
  private binaryWrites = 0;
  constructor(private state: DeviceSnapshot, private readonly token: string) {
    for (const [key, record] of Object.entries(state.records)) if (record.value !== null) this.values.set(key, record.value);
    this.outbox = `${OUTBOX}${state.id}.${crypto.randomUUID()}`;
  }
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  clear() { for (const key of [...this.values.keys()]) this.removeItem(key); }
  setItem(key: string, value: string) { this.change(key, value); }
  removeItem(key: string) { this.change(key, null); }
  private fail(error: unknown): never {
    this.stopped = true;
    report(error instanceof DeviceStorageError && error.conflict ? 'conflict' : 'error');
    throw error;
  }
  private persistPending() {
    if (this.pending.size) localStorage.setItem(this.outbox, JSON.stringify([...this.pending.values()]));
    else localStorage.removeItem(this.outbox);
  }
  private change(key: string, value: string | null) {
    if (!isDeviceKey(key) || key.startsWith(BINARY_PREFIX)) throw new Error('Invalid application storage key');
    if (this.stopped) throw new DeviceStorageError(status === 'conflict');
    if (this.getItem(key) === value) return;
    const previous = this.pending.get(key);
    this.pending.set(key, { key, value, expected: previous?.expected ?? this.state.records[key]?.revision ?? 0 });
    try {
      this.persistPending();
      if (value === null) { localStorage.removeItem(key); this.values.delete(key); }
      else { localStorage.setItem(key, value); this.values.set(key, value); }
    } catch (error) { this.fail(error); }
    report('saving');
    // Synchronous stores keep their API; the durable browser outbox survives an interrupted save.
    queueMicrotask(() => { void this.flush().catch(() => { /* fail() already exposes the error and keeps the outbox. */ }); });
  }
  async flush(): Promise<void> {
    if (this.running) { await this.running; return this.pending.size ? this.flush() : undefined; }
    if (this.stopped) throw new DeviceStorageError(status === 'conflict');
    this.running = (async () => {
      try {
        while (this.pending.size) {
          const batch = [...this.pending.values()];
          const next = snapshot(await request('state', this.token, { changes: batch }));
          for (const change of batch) {
            const record = next.records[change.key];
            if (!record) throw new DeviceStorageError(false);
            this.state.records[change.key] = record;
            const pending = this.pending.get(change.key);
            if (pending?.value === change.value) this.pending.delete(change.key);
            else if (pending) this.pending.set(change.key, { ...pending, expected: record.revision });
          }
          this.persistPending();
        }
        localStorage.setItem(SAVED, crypto.randomUUID());
        report(this.binaryWrites ? 'saving' : 'saved');
      } catch (error) { this.fail(error); }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  async putBinary(key: string, value: unknown | null): Promise<void> {
    if (this.stopped) throw new DeviceStorageError(status === 'conflict');
    await this.flush();
    const encoded = value === null ? null : JSON.stringify(value);
    this.binaryWrites++;
    report('saving');
    try {
      const next = snapshot(await request('state', this.token, {
        changes: [{ key, value: encoded, expected: this.state.records[key]?.revision ?? 0 }],
      }));
      const record = next.records[key];
      if (!record) throw new DeviceStorageError(false);
      this.state.records[key] = record;
      if (encoded === null) this.values.delete(key); else this.values.set(key, encoded);
      this.failedBinary.delete(key);
      report(this.pending.size || this.binaryWrites > 1 ? 'saving' : 'saved');
    } catch (error) {
      this.failedBinary.set(key, value);
      this.fail(error);
    } finally { this.binaryWrites--; }
  }
  recovery() { return { current: Object.fromEntries(this.values), failedBinary: Object.fromEntries(this.failedBinary) }; }
  async refresh(): Promise<void> {
    if (this.stopped || this.pending.size || this.running) return;
    try {
      const next = snapshot(await request('state', this.token));
      for (const [key, record] of Object.entries(next.records)) {
        if (record.revision === this.state.records[key]?.revision) continue;
        this.state.records[key] = record;
        if (record.value === null) this.values.delete(key); else this.values.set(key, record.value);
        window.dispatchEvent(new CustomEvent('bas-device-change', { detail: key }));
      }
    } catch (error) { this.fail(error); }
  }
}

/** Native storage remains the unit-test backend; production initializes the device adapter before importing stores. */
export const appStorage: Storage = {
  get length() { return (active ?? localStorage).length; },
  key: (index) => (active ?? localStorage).key(index),
  getItem: (key) => (active ?? localStorage).getItem(key),
  setItem: (key, value) => (active ?? localStorage).setItem(key, value),
  removeItem: (key) => (active ?? localStorage).removeItem(key),
  clear: () => (active ?? localStorage).clear(),
};

export const hasDeviceStorage = () => active !== null;
export const flushDeviceStorage = () => active?.flush() ?? Promise.resolve();
export function reloadAfterDeviceSave() {
  queueMicrotask(() => {
    void flushDeviceStorage().then(() => window.location.reload()).catch(() => {
      // The storage guard retains the current page and offers a recovery copy.
    });
  });
}
export async function recoveryDeviceData() {
  const pending = Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter((key): key is string => key !== null && key.startsWith(OUTBOX))
    .map((key) => [key, localStorage.getItem(key)]));
  return { format: 'bas-device-recovery', version: 1, legacy: await legacyDeviceData(), pending, ...active?.recovery() };
}
export function binaryKeys(prefix: string): string[] {
  return Array.from({ length: appStorage.length }, (_, i) => appStorage.key(i)).filter((key): key is string => key !== null && key.startsWith(prefix));
}
export async function writeDeviceBinary(key: string, value: unknown | null) {
  if (!active) throw new DeviceStorageError(false);
  return active.putBinary(key, value);
}
export function readDeviceBinary(key: string): unknown | null {
  const raw = appStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

export function syncDeviceStore(key: string, rehydrate: () => unknown) {
  if (typeof window === 'undefined') return;
  window.addEventListener('bas-device-change', (event) => {
    if (event instanceof CustomEvent && event.detail === key) rehydrate();
  });
}

export async function initializeDeviceStorage(useDeviceCopy = false): Promise<void> {
  const session = await request('session', null, {});
  if (!session || typeof session !== 'object' || !('token' in session) || typeof session.token !== 'string') throw new DeviceStorageError(false);
  let state = snapshot(await request('state', session.token));
  // Replay only against the original revisions. A conflict never overwrites newer device data.
  const outboxes = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter((key): key is string => key !== null && key.startsWith(`${OUTBOX}${state.id}.`));
  for (const key of outboxes) {
    const changes: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!Array.isArray(changes)) throw new DeviceStorageError(false);
    state = snapshot(await request('state', session.token, { changes }));
    localStorage.removeItem(key);
  }
  if (localStorage.getItem(`${MARKER}${state.id}`) !== '1') {
    if (!useDeviceCopy) {
      const legacy = await legacyDeviceData();
      const changes: DeviceChange[] = [];
      for (const [key, value] of Object.entries(legacy)) {
        const record = state.records[key];
        if (record && record.value !== value) throw new DeviceStorageError(true, true);
        if (!record) changes.push({ key, value, expected: 0 });
      }
      if (changes.length) state = snapshot(await request('state', session.token, { changes }));
    }
    localStorage.setItem(`${MARKER}${state.id}`, '1');
  }
  active = new DeviceStorage(state, session.token);
  window.addEventListener('beforeunload', (event) => {
    if (status === 'saving' || status === 'error' || status === 'conflict') { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === SAVED) void active?.refresh().catch(() => { /* Status is visible in the storage guard. */ });
  });
  report('saved');
}
