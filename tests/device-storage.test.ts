// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DeviceConflict, DeviceDatabase, createDeviceService } from '../scripts/lib/device.ts';
import { startServer } from '../scripts/lib/serve.ts';

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
function temporary() {
  mkdirSync(resolve('.bas-local'), { recursive: true });
  const dir = mkdtempSync(resolve('.bas-local', 'test-device-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function database(dir = temporary()) {
  const db = new DeviceDatabase(dir);
  cleanups.push(() => db.close());
  return db;
}
async function service(dir = temporary(), testMode = false) {
  const device = createDeviceService(dir, testMode);
  const server = createServer((req, res) => device.handle(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => { device.close(); resolve(); })));
  const origin = `http://127.0.0.1:${address.port}`;
  const session = await fetch(`${origin}/device/session`, { method: 'POST', headers: { origin } });
  const { token } = await session.json() as { token: string };
  const headers = { origin, 'content-type': 'application/json', 'x-bas-device': token };
  return { origin, headers, token };
}

describe('device transactions and durability', () => {
  it('keeps migration originals as a durable backup even when the working data changes', () => {
    const dir = temporary();
    const db = database(dir);
    const original = { 'bas.projects': JSON.stringify({ state: { companies: ['legacy'], projects: [] }, version: 1 }) };
    const id = db.archive('http://127.0.0.1:4173', original);
    expect(db.archive('http://127.0.0.1:4173', original)).toBe(id);
    db.commit([{ key: 'bas.projects', value: 'later working copy', expected: 0 }]);
    const check = new DatabaseSync(join(dir, 'device.sqlite'));
    try {
      expect(check.prepare('SELECT data FROM legacy_backups WHERE id = ?').get(id)?.data).toBe(JSON.stringify(original));
      expect(check.prepare('SELECT count(*) AS total FROM legacy_backups').get()?.total).toBe(1);
    } finally { check.close(); }
  });

  it('shares data with another process, survives reopen and never overwrites stale writes', () => {
    const dir = temporary();
    const db = database(dir);
    const initial = db.commit([{ key: 'bas.projects', value: 'original', expected: 0 }]);
    const processResult = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DeviceDatabase } from ${JSON.stringify(new URL('../scripts/lib/device.ts', import.meta.url).href)};
      const db = new DeviceDatabase(${JSON.stringify(dir)});
      db.commit([{key:'bas.projects',value:'other process',expected:1}]);
      db.close();
    `], { encoding: 'utf8', timeout: 15_000 });
    expect(processResult.status, processResult.stderr).toBe(0);
    expect(() => db.commit([
      { key: 'bas.settings', value: 'must roll back', expected: 0 },
      { key: 'bas.projects', value: 'stale edit', expected: 1 },
    ])).toThrow(DeviceConflict);
    expect(db.snapshot().records['bas.settings']).toBeUndefined();
    const reopened = database(dir).snapshot();
    expect(reopened.id).toBe(initial.id);
    expect(reopened.records['bas.projects']).toEqual({ value: 'other process', revision: 2 });
  });

  it('retains deletion revisions and permits safe retries after a lost response', () => {
    const db = database();
    const first = [{ key: 'bas.scope.pj.note', value: 'data', expected: 0 }];
    db.commit(first);
    expect(db.commit(first).records['bas.scope.pj.note']?.revision).toBe(1);
    db.commit([{ key: 'bas.scope.pj.note', value: null, expected: 1 }]);
    expect(() => db.commit(first)).toThrow(DeviceConflict);
    expect(db.snapshot().records['bas.scope.pj.note']).toEqual({ value: null, revision: 2 });
  });
});

describe('device endpoint access and errors', () => {
  it('also exposes shared persistence on the dependency-free static/offline server', async () => {
    const dir = temporary();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Offline app</title>');
    const previous = process.env.BAS_DEVICE_DIR;
    process.env.BAS_DEVICE_DIR = join(dir, 'data');
    let first: Awaited<ReturnType<typeof startServer>>;
    let second: Awaited<ReturnType<typeof startServer>>;
    try {
      first = await startServer(dir, 0);
      cleanups.push(first.close);
      second = await startServer(dir, 0);
      cleanups.push(second.close);
    } finally {
      if (previous === undefined) delete process.env.BAS_DEVICE_DIR; else process.env.BAS_DEVICE_DIR = previous;
    }
    const headers = async (url: string) => {
      const origin = new URL(url).origin;
      const session = await (await fetch(`${origin}/device/session`, { method: 'POST', headers: { origin } })).json() as { token: string };
      return { origin, 'content-type': 'application/json', 'x-bas-device': session.token };
    };
    expect((await fetch(first.url)).status).toBe(200);
    const write = await fetch(`${first.url}device/state`, {
      method: 'POST', headers: await headers(first.url),
      body: JSON.stringify({ changes: [{ key: 'bas.scope.demo.test', value: JSON.stringify({ note: 'offline' }), expected: 0 }] }),
    });
    expect(write.status).toBe(200);
    const read = await fetch(`${second.url}device/state`, { headers: await headers(second.url) });
    expect(await read.json()).toMatchObject({ records: { 'bas.scope.demo.test': { value: JSON.stringify({ note: 'offline' }), revision: 1 } } });
  });

  it('requires same-origin session acquisition and tokens, with no CORS permission', async () => {
    const { origin, headers } = await service();
    for (const attack of [
      { method: 'POST', headers: { origin: 'https://other.example' } },
      { method: 'POST' },
    ]) {
      const response = await fetch(`${origin}/device/session`, attack);
      expect(response.status).toBe(403);
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
    }
    expect((await fetch(`${origin}/device/state`)).status).toBe(403);
    expect((await fetch(`${origin}/device/state`, { headers: { ...headers, 'x-bas-device': 'wrong' } })).status).toBe(403);
    expect((await fetch(`${origin}/device/state`, { headers: { ...headers, origin: 'http://127.0.0.1:9999' } })).status).toBe(403);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${origin}/device/state`, { headers: { ...headers, host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(rebound).toBe(403);
    expect((await fetch(`${origin}/device/state`, { headers: { ...headers, 'x-bas-device-test': 'unexpected' } })).status).toBe(403);
    expect((await fetch(`${origin}/device/state`, { headers })).status).toBe(200);
  });

  it('rejects invalid changes, conflicts and corrupt storage explicitly', async () => {
    const { origin, headers } = await service();
    const post = (changes: unknown) => fetch(`${origin}/device/state`, { method: 'POST', headers, body: JSON.stringify({ changes }) });
    expect((await post([{ key: '../../secret', value: 'bad', expected: 0 }])).status).toBe(400);
    expect((await post([{ key: 'bas.projects', value: 'good', expected: 0 }])).status).toBe(200);
    expect((await post([{ key: 'bas.projects', value: 'stale', expected: 0 }])).status).toBe(409);
    const corrupt = temporary();
    writeFileSync(join(corrupt, 'device.sqlite'), 'not a database');
    const broken = await service(corrupt);
    const failure = await fetch(`${broken.origin}/device/state`, { headers: broken.headers });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: 'deviceUnavailable' });
  });
});
