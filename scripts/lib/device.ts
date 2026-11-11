import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEVICE_HEADER, DEVICE_PREFIX, DEVICE_TEST_HEADER, isDeviceKey, type DeviceChange, type DeviceSnapshot } from './deviceProtocol.ts';

export class DeviceConflict extends Error {}

/** SQLite transactions coordinate independent BAS processes, not just requests in one process. */
export class DeviceDatabase {
  private readonly db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'device.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT, revision INTEGER NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('id', randomUUID());
  }
  snapshot(): DeviceSnapshot {
    const meta = this.db.prepare('SELECT value FROM metadata WHERE name = ?').get('id');
    if (typeof meta?.value !== 'string') throw new Error('Invalid device database identity');
    const records: DeviceSnapshot['records'] = {};
    for (const row of this.db.prepare('SELECT key, value, revision FROM records').all()) {
      if (typeof row.key !== 'string' || (row.value !== null && typeof row.value !== 'string') || typeof row.revision !== 'number') {
        throw new Error('Invalid device database record');
      }
      records[row.key] = { value: row.value, revision: row.revision };
    }
    return { id: meta.value, records };
  }
  commit(changes: DeviceChange[]): DeviceSnapshot {
    this.db.exec('BEGIN IMMEDIATE');
    try {
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
      const snapshot = this.snapshot();
      this.db.exec('COMMIT');
      return snapshot;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

export function createDeviceService(dir: string, testMode = false) {
  const token = randomBytes(32).toString('base64url');
  const databases = new Map<string, DeviceDatabase>();
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
    if (req.url !== `${DEVICE_PREFIX}state`) return send(404, { error: 'notFound' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, { error: 'methodNotAllowed' });
    if (req.method === 'POST' && (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json'))) {
      return send(403, { error: 'deviceOrigin' });
    }
    const testId = req.headers[DEVICE_TEST_HEADER];
    if (testId !== undefined && (!testMode || typeof testId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(testId))) {
      return send(403, { error: 'deviceTestNamespace' });
    }
    void (async () => {
      try {
        const key = typeof testId === 'string' ? testId : '';
        let db = databases.get(key);
        if (!db) {
          db = new DeviceDatabase(key ? join(dir, 'device-tests', key) : dir);
          databases.set(key, db);
        }
        if (req.method === 'GET') return send(200, db.snapshot());
        const body = await readBody(req);
        if (!validChanges(body)) return send(400, { error: 'invalidDeviceChanges' });
        send(200, db.commit(body.changes));
      } catch (error) {
        // Data and filesystem paths are deliberately excluded from logs and responses.
        const code = error instanceof DeviceConflict ? 'deviceConflict' :
          error instanceof RangeError ? 'deviceTooLarge' : error instanceof SyntaxError ? 'invalidDeviceChanges' : 'deviceUnavailable';
        if (code === 'deviceUnavailable') console.error('Device storage operation failed.');
        send(code === 'deviceConflict' ? 409 : code === 'deviceTooLarge' ? 413 : code === 'invalidDeviceChanges' ? 400 : 503, { error: code });
      }
    })();
  };
  return { handle, close: () => { for (const db of databases.values()) db.close(); databases.clear(); } };
}
