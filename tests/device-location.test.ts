// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DeviceDatabase, createDeviceService, type DeviceServiceOptions } from '../scripts/lib/device.ts';
import { DB_FILE, LOCATION_FILE, isSyncedFolder, writeLocation } from '../scripts/lib/deviceLocation.ts';

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
function temporary() {
  mkdirSync(resolve('.bas-local'), { recursive: true });
  const dir = mkdtempSync(resolve('.bas-local', 'test-location-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function service(home: string, options: DeviceServiceOptions = {}) {
  const device = createDeviceService(home, false, options);
  const server = createServer((req, res) => device.handle(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  cleanups.push(() => new Promise<void>((done) => server.close(() => { device.close(); done(); })));
  const origin = `http://127.0.0.1:${address.port}`;
  const { token } = await (await fetch(`${origin}/device/session`, { method: 'POST', headers: { origin } })).json() as { token: string };
  const headers: Record<string, string> = { origin, 'content-type': 'application/json', 'x-bas-device': token };
  const call = async (route: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/device/${route}`, body === undefined
      ? { headers: { ...headers, ...extra } }
      : { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { call };
}

const pointer = (home: string) => existsSync(join(home, LOCATION_FILE)) ? JSON.parse(readFileSync(join(home, LOCATION_FILE), 'utf8')) as unknown : null;

describe('FR-339 choosing the device data folder', () => {
  it('copies all data into an empty folder, keeps the identity and revisions, and leaves the old folder intact', async () => {
    const home = temporary();
    const target = temporary();
    const { call } = await service(home);
    const saved = await call('state', { changes: [{ key: 'bas.projects', value: 'projects', expected: 0 }, { key: 'bas.binary.p1', value: 'pack', expected: 0 }] });
    expect(saved.status).toBe(200);
    const before = await call('state');

    const moved = await call('location', { path: target, mode: 'copy' });
    expect(moved).toMatchObject({ status: 200, body: { path: target, id: before.body.id } });
    expect(existsSync(join(target, DB_FILE))).toBe(true);
    expect(existsSync(join(home, DB_FILE))).toBe(true);
    expect(await call('location')).toMatchObject({ body: { path: target, defaultPath: home, isDefault: false, available: true } });

    const after = await call('state');
    expect(after.body).toEqual(before.body);
    // Writes now land in the new folder and keep optimistic revisions working.
    expect((await call('state', { changes: [{ key: 'bas.projects', value: 'next', expected: 1 }] }, { 'x-bas-device-id': String(before.body.id) })).status).toBe(200);
    const check = new DeviceDatabase(target);
    try { expect(check.snapshot().records['bas.projects']).toEqual({ value: 'next', revision: 2 }); } finally { check.close(); }
    const old = new DeviceDatabase(home);
    try { expect(old.snapshot().records['bas.projects']).toEqual({ value: 'projects', revision: 1 }); } finally { old.close(); }
  });

  it('opens existing data in another folder and rejects writes from windows that loaded the old database', async () => {
    const home = temporary();
    const other = temporary();
    const seeded = new DeviceDatabase(other);
    seeded.commit([{ key: 'bas.settings', value: 'other folder', expected: 0 }]);
    const otherId = seeded.id();
    seeded.close();
    const { call } = await service(home);
    const oldId = String((await call('state')).body.id);
    expect(oldId).not.toBe(otherId);

    expect(await call('location', { path: other, mode: 'open' })).toMatchObject({ status: 200, body: { id: otherId } });
    expect((await call('state')).body).toMatchObject({ id: otherId, records: { 'bas.settings': { value: 'other folder', revision: 1 } } });
    const stale = await call('state', { changes: [{ key: 'bas.projects', value: 'from old window', expected: 0 }] }, { 'x-bas-device-id': oldId });
    expect(stale).toEqual({ status: 409, body: { error: 'deviceMoved' } });
    expect((await call('state')).body.records).not.toHaveProperty('bas.projects');
    // The server let go of the old folder, so it can be removed or unplugged while BAS keeps running.
    expect(() => rmSync(join(home, DB_FILE))).not.toThrow();
  });

  it('refuses unsafe targets without changing the folder or touching existing data', async () => {
    const home = temporary();
    const served = temporary();
    const withData = temporary();
    new DeviceDatabase(withData).close();
    const empty = temporary();
    const corrupt = temporary();
    writeFileSync(join(corrupt, DB_FILE), 'not a database');
    const { call } = await service(home, { servedRoots: [served] });
    await call('state', { changes: [{ key: 'bas.projects', value: 'keep', expected: 0 }] });

    const cases: [unknown, string][] = [
      [{ path: withData, mode: 'copy' }, 'locationHasData'],
      [{ path: empty, mode: 'open' }, 'locationNoData'],
      [{ path: corrupt, mode: 'open' }, 'locationCorrupt'],
      [{ path: home, mode: 'copy' }, 'locationSame'],
      [{ path: 'relative/folder', mode: 'copy' }, 'locationInvalid'],
      [{ path: join(empty, 'missing'), mode: 'copy' }, 'locationInvalid'],
      [{ path: '\\\\server\\share\\bas', mode: 'copy' }, 'locationNetwork'],
      [{ path: served, mode: 'copy' }, 'locationServed'],
      [{ path: empty, mode: 'move' }, 'locationInvalid'],
      [{ mode: 'default' }, 'locationInvalid'],
    ];
    for (const [body, error] of cases) expect(await call('location', body), JSON.stringify(body)).toEqual({ status: 400, body: { error } });
    expect(pointer(home)).toBeNull();
    expect(existsSync(join(empty, DB_FILE))).toBe(false);
    expect(readFileSync(join(corrupt, DB_FILE), 'utf8')).toBe('not a database');
    expect((await call('state')).body.records).toMatchObject({ 'bas.projects': { value: 'keep' } });
  });

  it('stops with locationUnavailable instead of creating empty data when the chosen folder is missing, and can go back to the default', async () => {
    const home = temporary();
    const original = new DeviceDatabase(home);
    original.commit([{ key: 'bas.projects', value: 'default data', expected: 0 }]);
    original.close();
    const missing = join(temporary(), 'unplugged-drive');
    writeLocation(home, missing);
    const { call } = await service(home);

    expect(await call('state')).toEqual({ status: 503, body: { error: 'locationUnavailable' } });
    expect(existsSync(missing)).toBe(false);
    expect(await call('location')).toMatchObject({ body: { path: missing, available: false, isDefault: false } });

    expect((await call('location', { mode: 'default' })).status).toBe(200);
    expect(pointer(home)).toBeNull();
    expect((await call('state')).body.records).toMatchObject({ 'bas.projects': { value: 'default data' } });
  });

  it('treats an unreadable pointer as unavailable rather than silently using the default folder', async () => {
    const home = temporary();
    writeFileSync(join(home, LOCATION_FILE), '{broken');
    const { call } = await service(home);
    expect(await call('state')).toEqual({ status: 503, body: { error: 'locationUnavailable' } });
    expect(await call('location')).toMatchObject({ body: { path: null, available: false } });
  });

  it('cannot be changed while BAS_DEVICE_DIR pins the folder', async () => {
    const home = temporary();
    const { call } = await service(home, { fixed: true });
    expect(await call('location')).toMatchObject({ body: { path: home, fixed: true } });
    expect(await call('location', { path: temporary(), mode: 'copy' })).toEqual({ status: 400, body: { error: 'locationFixed' } });
  });

  it('lists and creates folders for the picker, marking folders that already hold data', async () => {
    const home = temporary();
    const base = temporary();
    mkdirSync(join(base, 'Beta'));
    mkdirSync(join(base, '.hidden'));
    new DeviceDatabase(join(base, 'Beta')).close();
    const { call } = await service(home);

    const listing = await call('folders', { path: base });
    expect(listing.body).toMatchObject({ path: base, folders: ['Beta'], target: { hasData: false } });
    expect((listing.body.roots as { kind: string }[]).map((r) => r.kind)).toEqual(expect.arrayContaining(['current', 'home']));
    expect((await call('folders', { path: join(base, 'Beta') })).body).toMatchObject({ target: { hasData: true } });
    expect((await call('folders', { path: join(base, 'nope') })).body).toEqual({ error: 'locationInvalid' });

    expect(await call('folders/create', { parent: base, name: 'Alpha' })).toEqual({ status: 200, body: { path: join(base, 'Alpha') } });
    for (const name of ['Alpha', 'a/b', '..', 'CON', 'trailing.']) {
      expect(await call('folders/create', { parent: base, name }), name).toEqual({ status: 400, body: { error: 'locationNameInvalid' } });
    }
    expect((await call('folders', { path: base })).body.folders).toEqual(['Alpha', 'Beta']);
  });

  it('warns about cloud-synced folders', () => {
    expect(isSyncedFolder('C:\\Users\\me\\OneDrive\\BAS', {})).toBe(true);
    expect(isSyncedFolder('D:\\BAS-data', {})).toBe(false);
  });
});
