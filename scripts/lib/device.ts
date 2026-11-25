import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEVICE_HEADER, DEVICE_ID_HEADER, DEVICE_PREFIX, DEVICE_TEST_HEADER, isDeviceKey, type DeviceChange, type DeviceLocationMode, type DeviceSnapshot,
} from './deviceProtocol.ts';
import {
  DB_FILE, LocationError, configuredDir, createFolder, currentDataDir, folderRoots, inspectTarget, listFolders, samePath, writeLocation,
} from './deviceLocation.ts';

export class DeviceConflict extends Error {}
/** The data folder changed (or this window loaded another database); the window must reload instead of writing. */
export class DeviceMoved extends Error {}

const SCHEMA = (prefix: string) => `
  CREATE TABLE IF NOT EXISTS ${prefix}metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ${prefix}records (key TEXT PRIMARY KEY, value TEXT, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS ${prefix}legacy_backups (id TEXT PRIMARY KEY, origin TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
`;

/** Opens an existing database read-only and confirms it is an intact BAS device database before switching to it. */
export function verifyDeviceDatabase(dir: string): string {
  let db: DatabaseSync;
  try { db = new DatabaseSync(join(dir, DB_FILE), { readOnly: true }); } catch { throw new LocationError('locationCorrupt'); }
  try {
    const check = db.prepare('PRAGMA integrity_check').get();
    const meta = db.prepare("SELECT value FROM metadata WHERE name = 'id'").get();
    db.prepare('SELECT count(*) FROM records').get();
    if (check?.integrity_check !== 'ok' || typeof meta?.value !== 'string') throw new LocationError('locationCorrupt');
    return meta.value;
  } catch (error) {
    throw error instanceof LocationError ? error : new LocationError('locationCorrupt');
  } finally { db.close(); }
}

/** SQLite transactions coordinate independent BAS processes, not just requests in one process. */
export class DeviceDatabase {
  private readonly db: DatabaseSync;
  private readonly guard: () => void;
  /** `guard` runs inside each write lock, so a write that waited for a folder switch cannot land in the old folder. */
  constructor(dir: string, guard: () => void = () => {}) {
    this.guard = guard;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, DB_FILE));
    try {
      this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      ${SCHEMA('')}
      `);
      this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('id', randomUUID());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  id(): string {
    const meta = this.db.prepare('SELECT value FROM metadata WHERE name = ?').get('id');
    if (typeof meta?.value !== 'string') throw new Error('Invalid device database identity');
    return meta.value;
  }
  snapshot(keys?: string[]): DeviceSnapshot {
    const id = this.id();
    const records: DeviceSnapshot['records'] = {};
    const read = this.db.prepare('SELECT key, value, revision FROM records WHERE key = ?');
    const rows = keys ? keys.flatMap((key) => { const row = read.get(key); return row ? [row] : []; }) :
      this.db.prepare('SELECT key, value, revision FROM records').all();
    for (const row of rows) {
      if (typeof row.key !== 'string' || (row.value !== null && typeof row.value !== 'string') || typeof row.revision !== 'number') {
        throw new Error('Invalid device database record');
      }
      records[row.key] = { value: row.value, revision: row.revision };
    }
    return { id, records };
  }
  commit(changes: DeviceChange[]): DeviceSnapshot {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.guard();
      const read = this.db.prepare('SELECT value, revision FROM records WHERE key = ?');
      const write = this.db.prepare(`
        INSERT INTO records VALUES (?, ?, 1)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = records.revision + 1
      `);
      for (const change of changes) {
        const row = read.get(change.key);
        // A lost response can be retried without applying a mutation twice.
        if (row && row.value === change.value) continue;
        if ((row?.revision ?? 0) !== change.expected) throw new DeviceConflict('Device data changed in another window');
        write.run(change.key, change.value);
      }
      const snapshot = this.snapshot(changes.map((change) => change.key));
      this.db.exec('COMMIT');
      // FR-370: with secure_delete the deleted text is zeroed in the main file; the checkpoint also clears it from the WAL.
      if (changes.some((change) => change.value === null)) {
        try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* another process is reading; the next checkpoint clears it */ }
      }
      return snapshot;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  archive(origin: string, records: Record<string, string>): string {
    const data = JSON.stringify(records);
    const id = createHash('sha256').update(origin).update(data).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.guard();
      this.db.prepare('INSERT OR IGNORE INTO legacy_backups VALUES (?, ?, ?, ?)').run(id, origin, new Date().toISOString(), data);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return id;
  }
  /**
   * Copies every record, revision, identity and migration backup into an empty folder while holding the write lock.
   * `publish` switches the location before the lock is released, so no other process can write to the old copy in between.
   */
  copyTo(dir: string, publish: () => () => void): void {
    const file = join(dir, DB_FILE);
    if (existsSync(file)) throw new LocationError('locationHasData');
    this.db.prepare('ATTACH DATABASE ? AS dest').run(file);
    let undo: (() => void) | null = null;
    try {
      this.db.exec(`PRAGMA dest.journal_mode = WAL; ${SCHEMA('dest.')}`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.guard();
        this.db.exec(`
          INSERT INTO dest.metadata SELECT * FROM main.metadata;
          INSERT INTO dest.records SELECT * FROM main.records;
          INSERT INTO dest.legacy_backups SELECT * FROM main.legacy_backups;
        `);
        const check = this.db.prepare('PRAGMA dest.integrity_check').get();
        const counts = this.db.prepare(`SELECT
          (SELECT count(*) FROM dest.records) = (SELECT count(*) FROM main.records) AND
          (SELECT count(*) FROM dest.legacy_backups) = (SELECT count(*) FROM main.legacy_backups) AS same`).get();
        if (check?.integrity_check !== 'ok' || counts?.same !== 1) throw new LocationError('locationCorrupt');
        undo = publish();
        this.db.exec('COMMIT');
      } catch (error) {
        undo?.();
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      try { this.db.exec('DETACH DATABASE dest'); } catch { /* already detached */ }
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true });
      throw error;
    }
    this.db.exec('DETACH DATABASE dest');
  }
  close() { this.db.close(); }
}

const MAX_BODY_BYTES = 128 * 1024 * 1024;
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(new RangeError('Device request too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new SyntaxError('Invalid device request')); }
    });
    req.on('error', reject);
  });
}

function validChanges(body: unknown): body is { changes: DeviceChange[] } {
  if (!body || typeof body !== 'object' || !('changes' in body) || !Array.isArray(body.changes) || body.changes.length > 10_000) return false;
  const keys = new Set<string>();
  return body.changes.every((c: unknown) => {
    if (!c || typeof c !== 'object' || !('key' in c) || !('value' in c) || !('expected' in c) ||
      typeof c.key !== 'string' || !isDeviceKey(c.key) || keys.has(c.key) ||
      (c.value !== null && typeof c.value !== 'string') || !Number.isSafeInteger(c.expected) || Number(c.expected) < 0) return false;
    keys.add(c.key);
    return true;
  });
}

export interface DeviceServiceOptions {
  /** Folders the hosting server exposes over HTTP; the data folder must not be inside them. */
  servedRoots?: string[];
  /** BAS_DEVICE_DIR pins the folder: Settings shows it but cannot change it. */
  fixed?: boolean;
}

const ROUTES: Record<string, string[]> = {
  state: ['GET', 'POST'], archive: ['POST'], location: ['GET', 'POST'], folders: ['POST'], 'folders/create': ['POST'],
};
const MODES: DeviceLocationMode[] = ['copy', 'open', 'default'];
const pathKey = (path: string) => process.platform === 'win32' || process.platform === 'darwin' ? resolve(path).toLowerCase() : resolve(path);

/** `dir` is the default BAS data folder; it also keeps the pointer to a folder chosen in Settings (FR-339). */
export function createDeviceService(dir: string, testMode = false, options: DeviceServiceOptions = {}) {
  const token = randomBytes(32).toString('base64url');
  const databases = new Map<string, DeviceDatabase>();
  const servedRoots = (options.servedRoots ?? []).map((root) => resolve(root));
  const fixed = options.fixed ?? false;
  const locate = (home: string) => fixed ? home : currentDataDir(home);
  const open = (home: string) => {
    const dataDir = locate(home);
    const key = `${pathKey(home)}\0${pathKey(dataDir)}`;
    let db = databases.get(key);
    if (!db) {
      db = new DeviceDatabase(dataDir, () => { if (!fixed && !samePath(currentDataDir(home), dataDir)) throw new DeviceMoved(); });
      databases.set(key, db);
    }
    return { db, dataDir };
  };
  // Requests run synchronously against SQLite, so closing here never interrupts one; the old folder can then be removed or unplugged.
  const release = (home: string) => {
    const prefix = `${pathKey(home)}\0`;
    for (const [key, db] of databases) if (key.startsWith(prefix)) { db.close(); databases.delete(key); }
  };
  const location = (home: string) => {
    if (fixed) return { path: home, defaultPath: home, isDefault: true, fixed, available: true };
    try {
      const configured = configuredDir(home);
      if (configured === null) return { path: home, defaultPath: home, isDefault: true, fixed, available: true };
      return { path: configured, defaultPath: home, isDefault: false, fixed, available: existsSync(join(configured, DB_FILE)) };
    } catch {
      return { path: null, defaultPath: home, isDefault: false, fixed, available: false };
    }
  };
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith(DEVICE_PREFIX)) return next();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return send(403, { error: 'deviceOrigin' });
    }
    if (req.url === `${DEVICE_PREFIX}session` && req.method === 'POST') {
      if (req.headers.origin !== origin) return send(403, { error: 'deviceOrigin' });
      return send(200, { token });
    }
    const sent = req.headers[DEVICE_HEADER];
    if (typeof sent !== 'string' || Buffer.byteLength(sent) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(sent), Buffer.from(token))) return send(403, { error: 'deviceToken' });
    const route = req.url.slice(DEVICE_PREFIX.length);
    const methods = Object.hasOwn(ROUTES, route) ? ROUTES[route]! : null;
    if (!methods) return send(404, { error: 'notFound' });
    if (!methods.includes(req.method ?? '')) return send(405, { error: 'methodNotAllowed' });
    if (req.method === 'POST' && (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json'))) {
      return send(403, { error: 'deviceOrigin' });
    }
    const testId = req.headers[DEVICE_TEST_HEADER];
    if (testId !== undefined && (!testMode || typeof testId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(testId))) {
      return send(403, { error: 'deviceTestNamespace' });
    }
    const expectedId = req.headers[DEVICE_ID_HEADER];
    void (async () => {
      try {
        const home = typeof testId === 'string' ? join(dir, 'device-tests', testId) : dir;
        if (route === 'location' && req.method === 'GET') return send(200, location(home));
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const field = (name: string) => body && typeof body === 'object' && name in body ? (body as Record<string, unknown>)[name] : undefined;
        if (route === 'folders') {
          const current = location(home).available ? locate(home) : home;
          const requested = field('path');
          const listing = listFolders(typeof requested === 'string' && requested ? requested : current);
          return send(200, {
            ...listing, roots: folderRoots(home, current),
            target: inspectTarget(listing.path, { home, current, servedRoots }, false),
          });
        }
        if (route === 'folders/create') {
          const parent = field('parent');
          const name = field('name');
          if (typeof parent !== 'string' || typeof name !== 'string') return send(400, { error: 'locationInvalid' });
          return send(200, { path: createFolder(parent, name) });
        }
        if (route === 'location') {
          if (fixed) throw new LocationError('locationFixed');
          const mode = field('mode');
          if (!MODES.includes(mode as DeviceLocationMode)) return send(400, { error: 'locationInvalid' });
          if (mode === 'default') {
            // Recovery only: while the folder works, switching copies or opens data so nothing is replaced silently.
            if (location(home).available) throw new LocationError('locationInvalid');
            writeLocation(home, null);
            release(home);
            return send(200, { path: home });
          }
          const path = field('path');
          if (typeof path !== 'string') return send(400, { error: 'locationInvalid' });
          const { db, dataDir } = open(home);
          const info = inspectTarget(path, { home, current: dataDir, servedRoots }, true);
          if (info.error) throw new LocationError(info.error);
          const target = resolve(path);
          if (mode === 'copy') {
            if (info.hasData) throw new LocationError('locationHasData');
            db.copyTo(target, () => writeLocation(home, target));
            const id = db.id();
            release(home);
            return send(200, { path: target, id });
          }
          if (!info.hasData) throw new LocationError('locationNoData');
          const id = verifyDeviceDatabase(target);
          writeLocation(home, target);
          release(home);
          return send(200, { path: target, id });
        }
        const { db } = open(home);
        if (typeof expectedId === 'string' && expectedId !== db.id()) throw new DeviceMoved();
        if (req.method === 'GET') return send(200, db.snapshot());
        if (route === 'archive') {
          if (!body || typeof body !== 'object' || !('records' in body) || !body.records || typeof body.records !== 'object' ||
            Array.isArray(body.records) || Object.entries(body.records).some(([key, value]) => !isDeviceKey(key) || typeof value !== 'string')) {
            return send(400, { error: 'invalidDeviceArchive' });
          }
          return send(200, { id: db.archive(origin, body.records as Record<string, string>) });
        }
        if (!validChanges(body)) return send(400, { error: 'invalidDeviceChanges' });
        send(200, db.commit(body.changes));
      } catch (error) {
        // Data and filesystem paths are deliberately excluded from logs and error responses.
        if (error instanceof LocationError) return send(error.code === 'locationUnavailable' ? 503 : 400, { error: error.code });
        const code = error instanceof DeviceConflict ? 'deviceConflict' : error instanceof DeviceMoved ? 'deviceMoved' :
          error instanceof RangeError ? 'deviceTooLarge' : error instanceof SyntaxError ? 'invalidDeviceChanges' : 'deviceUnavailable';
        if (code === 'deviceUnavailable') console.error('Device storage operation failed.');
        send(code === 'deviceConflict' || code === 'deviceMoved' ? 409 : code === 'deviceTooLarge' ? 413 : code === 'invalidDeviceChanges' ? 400 : 503, { error: code });
      }
    })();
  };
  return { handle, close: () => { for (const db of databases.values()) db.close(); databases.clear(); } };
}
