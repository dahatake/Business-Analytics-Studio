/**
 * FR-086 / FR-095: stroke data uses device storage keyed by scope + board (scales to PARAM-010 strokes).
 * Unsaved changes are journaled under the project's scope prefix so a crash/reload restores them,
 * and the project's deletion (purgeScope) also removes the journal.
 */
import { onProjectDeleted, scopedKey } from '../../state/projects.ts';
import { appStorage as localStorage, binaryKeys, hasDeviceStorage, readDeviceBinary, writeDeviceBinary } from '../../data/deviceStorage.ts';
import { AUTOSAVE_MS, type BoardContent, type Card, type Link, type Note, type Stroke } from './model.ts';

export interface InkStorage {
  load(scope: string, boardId: string): Promise<BoardContent | null>;
  save(scope: string, boardId: string, content: BoardContent): Promise<void>;
  remove(scope: string, boardId: string): Promise<void>;
  /** Delete every board of a scope (project deletion). */
  removeScope(scope: string): Promise<void>;
}

export const contentKey = (scope: string, boardId: string) => `${scope}::${boardId}`;

export class MemoryStorage implements InkStorage {
  readonly data = new Map<string, BoardContent>();
  saves = 0;
  async load(scope: string, boardId: string) {
    return this.data.get(contentKey(scope, boardId)) ?? null;
  }
  async save(scope: string, boardId: string, content: BoardContent) {
    this.saves++;
    this.data.set(contentKey(scope, boardId), content);
  }
  async remove(scope: string, boardId: string) {
    this.data.delete(contentKey(scope, boardId));
  }
  async removeScope(scope: string) {
    for (const k of [...this.data.keys()]) if (k.startsWith(`${scope}::`)) this.data.delete(k);
  }
}

const DB = 'bas-ink';
const STORE = 'boards';

export class IdbStorage implements InkStorage {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async load(scope: string, boardId: string) {
    return ((await this.tx('readonly', (s) => s.get(contentKey(scope, boardId)))) as BoardContent | undefined) ?? null;
  }
  async save(scope: string, boardId: string, content: BoardContent) {
    await this.tx('readwrite', (s) => {
      s.put(content, contentKey(scope, boardId));
    });
  }
  async remove(scope: string, boardId: string) {
    await this.tx('readwrite', (s) => {
      s.delete(contentKey(scope, boardId));
    });
  }
  async removeScope(scope: string) {
    await this.tx('readwrite', (s) => {
      s.delete(IDBKeyRange.bound(`${scope}::`, `${scope}::\uffff`));
    });
  }
}

/** Purge a deleted project's strokes so they can never reappear (G-007). */
onProjectDeleted((id) => {
  void inkStorage().removeScope(id);
});

let shared: InkStorage | null = null;
class DeviceInkStorage implements InkStorage {
  private key(scope: string, id: string) { return `bas.binary.ink.${contentKey(scope, id)}`; }
  async load(scope: string, id: string) { return readDeviceBinary(this.key(scope, id)) as BoardContent | null; }
  async save(scope: string, id: string, content: BoardContent) { await writeDeviceBinary(this.key(scope, id), content); }
  async remove(scope: string, id: string) { await writeDeviceBinary(this.key(scope, id), null); }
  async removeScope(scope: string) {
    for (const key of binaryKeys(`bas.binary.ink.${scope}::`)) await writeDeviceBinary(key, null);
  }
}
export function inkStorage(): InkStorage {
  shared ??= hasDeviceStorage() ? new DeviceInkStorage() : typeof indexedDB === 'undefined' ? new MemoryStorage() : new IdbStorage();
  return shared;
}

/** Changes since the last save: strokes added/removed relative to the saved version, plus the (small) item lists. */
export interface Journal {
  add: Stroke[];
  remove: string[];
  notes: Note[];
  cards: Card[];
  links: Link[];
}

export const journalKey = (scope: string, boardId: string) => scopedKey(scope, `ink.journal.${boardId}`);

/** Diff `current` against the saved version. `savedIds` is the set of stroke ids in the saved version. */
export function makeJournal(saved: BoardContent, savedIds: Set<string>, current: BoardContent): Journal | null {
  const add: Stroke[] = [];
  const currentIds = new Set<string>();
  for (const s of current.strokes) {
    currentIds.add(s.id);
    if (!savedIds.has(s.id)) add.push(s);
  }
  const remove: string[] = [];
  if (currentIds.size - add.length !== savedIds.size) for (const id of savedIds) if (!currentIds.has(id)) remove.push(id);
  const same = !add.length && !remove.length && saved.notes === current.notes && saved.cards === current.cards && saved.links === current.links;
  return same ? null : { add, remove, notes: current.notes, cards: current.cards, links: current.links };
}

export function applyJournal(saved: BoardContent, j: Journal): BoardContent {
  const rm = new Set(j.remove);
  const have = new Set(saved.strokes.map((s) => s.id));
  return {
    strokes: [...saved.strokes.filter((s) => !rm.has(s.id)), ...j.add.filter((s) => !have.has(s.id))],
    notes: j.notes,
    cards: j.cards,
    links: j.links,
  };
}

/** Largest journal kept in localStorage; bigger change sets are saved to IndexedDB right away instead. */
export const JOURNAL_MAX_CHARS = 1_500_000;

export function writeJournal(scope: string, boardId: string, j: Journal | null): boolean {
  const key = journalKey(scope, boardId);
  if (!j) {
    localStorage.removeItem(key);
    return true;
  }
  const text = JSON.stringify(j);
  if (text.length > JOURNAL_MAX_CHARS) return false;
  try {
    localStorage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

export function readJournal(scope: string, boardId: string): Journal | null {
  try {
    const raw = localStorage.getItem(journalKey(scope, boardId));
    return raw ? (JSON.parse(raw) as Journal) : null;
  } catch {
    return null;
  }
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * PARAM-025 autosave: the first change after a save schedules one save `interval` ms later; further changes in the
 * window ride along (so continuous drawing saves every 2 s, not on every stroke). Changes made while a save is
 * running schedule the next one.
 */
export class Autosaver {
  private timer: unknown = null;
  private dirty = false;
  private running: Promise<void> | null = null;

  constructor(private readonly save: () => Promise<void>, private readonly interval = AUTOSAVE_MS, private readonly timers: Timers = realTimers) {}

  get pending(): boolean {
    return this.dirty;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.timer === null) this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.interval);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
    if (!this.dirty) return;
    this.dirty = false;
    this.running = this.save().catch(() => {
      this.dirty = true;
    }).finally(() => {
      this.running = null;
    });
    await this.running;
  }

  dispose(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
