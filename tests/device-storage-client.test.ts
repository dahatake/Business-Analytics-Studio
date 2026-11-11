import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceChange, DeviceSnapshot } from '../scripts/lib/deviceProtocol.ts';

let server: DeviceSnapshot;
let post: ((changes: DeviceChange[]) => Promise<Response>) | null;
let get: (() => Promise<Response>) | null;
const addEventListener = window.addEventListener.bind(window);
const registered: { type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function commit(changes: DeviceChange[]) {
  const records: DeviceSnapshot['records'] = {};
  for (const change of changes) {
    const revision = server.records[change.key]?.revision ?? 0;
    if (revision !== change.expected) return response({ error: 'deviceConflict' }, 409);
    records[change.key] = { value: change.value, revision: revision + 1 };
  }
  Object.assign(server.records, records);
  return response({ id: server.id, records });
}
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  server = { id: 'test-device', records: { 'bas.scope.demo.test': { value: '"original"', revision: 1 } } };
  localStorage.setItem('bas.device.migrated.test-device', '1');
  post = null;
  get = null;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    registered.push({ type, listener, options });
    addEventListener(type, listener, options);
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session')) return response({ token: 'test-token' });
    if (init?.method !== 'POST') return get ? get() : response(server);
    if (typeof init.body !== 'string') throw new Error('Expected encoded body');
    const body = JSON.parse(init.body) as { changes: DeviceChange[] };
    return post ? post(body.changes) : commit(body.changes);
  }));
});
afterEach(() => {
  for (const { type, listener, options } of registered.splice(0)) window.removeEventListener(type, listener, options);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('device client save guarantees', () => {
  it.each([0, 1, 2, 3])('preserves AI settings version %i for the existing middleware migration', async (version) => {
    server.records['bas.ai.settings'] = { value: JSON.stringify({ state: { liveEnabled: false }, version }), revision: 1 };
    const client = await import('../src/data/deviceStorage.ts');
    await client.initializeDeviceStorage();
    expect(JSON.parse(client.appStorage.getItem('bas.ai.settings')!).version).toBe(version);
  });

  it('retains failed changes in a durable outbox and replays them on the original revision after reload', async () => {
    const client = await import('../src/data/deviceStorage.ts');
    await client.initializeDeviceStorage();
    post = async () => response({ error: 'deviceUnavailable' }, 503);
    client.appStorage.setItem('bas.scope.demo.test', '"recover me"');
    await expect(client.flushDeviceStorage()).rejects.toThrow('deviceUnavailable');
    expect(client.deviceStatus()).toBe('error');
    expect(client.appStorage.getItem('bas.scope.demo.test')).toBe('"recover me"');
    expect(Object.keys(localStorage).some((key) => key.startsWith('bas.device.pending.'))).toBe(true);
    expect(server.records['bas.scope.demo.test']?.value).toBe('"original"');
    post = null;
    vi.resetModules();
    const reloaded = await import('../src/data/deviceStorage.ts');
    await reloaded.initializeDeviceStorage();
    expect(reloaded.appStorage.getItem('bas.scope.demo.test')).toBe('"recover me"');
    expect(server.records['bas.scope.demo.test']?.revision).toBe(2);
    expect(Object.keys(localStorage).some((key) => key.startsWith('bas.device.pending.'))).toBe(false);
  });

  it('does not hide a failed binary save when an overlapping small save succeeds later', async () => {
    const client = await import('../src/data/deviceStorage.ts');
    await client.initializeDeviceStorage();
    let rejectBinary: (() => void) | undefined;
    let finishSmall: (() => void) | undefined;
    post = (changes) => new Promise((resolve) => {
      if (changes[0]?.key.startsWith('bas.binary.')) rejectBinary = () => resolve(response({ error: 'deviceUnavailable' }, 503));
      else finishSmall = () => resolve(commit(changes));
    });
    const binary = client.writeDeviceBinary('bas.binary.ink.demo::board', { strokes: [] });
    const failed = expect(binary).rejects.toThrow('deviceUnavailable');
    await vi.waitFor(() => expect(rejectBinary).toBeDefined());
    client.appStorage.setItem('bas.scope.demo.test', '"small change"');
    await vi.waitFor(() => expect(finishSmall).toBeDefined());
    rejectBinary!();
    await failed;
    finishSmall!();
    await vi.waitFor(() => expect(server.records['bas.scope.demo.test']?.value).toBe('"small change"'));
    expect(client.deviceStatus()).toBe('error');
    expect(() => client.appStorage.setItem('bas.scope.demo.test', '"must stay blocked"')).toThrow();
  });

  it('waits for binary saves before an internal navigation is allowed to reload', async () => {
    const client = await import('../src/data/deviceStorage.ts');
    await client.initializeDeviceStorage();
    let finish: (() => void) | undefined;
    post = (changes) => new Promise((resolve) => { finish = () => resolve(commit(changes)); });
    const binary = client.writeDeviceBinary('bas.binary.ink.demo::board', { strokes: [] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    let drained = false;
    const flushing = client.flushDeviceStorage().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    finish!();
    await Promise.all([binary, flushing]);
    expect(drained).toBe(true);
    expect(client.deviceStatus()).toBe('saved');
  });

  it('never applies a delayed remote refresh over a new local edit', async () => {
    const client = await import('../src/data/deviceStorage.ts');
    await client.initializeDeviceStorage();
    const old = structuredClone(server);
    let finishRead: (() => void) | undefined;
    let finishWrite: (() => void) | undefined;
    get = () => new Promise((resolve) => { finishRead = () => resolve(response(old)); });
    window.dispatchEvent(new StorageEvent('storage', { key: 'bas.device.saved', storageArea: localStorage }));
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    post = (changes) => new Promise((resolve) => { finishWrite = () => resolve(commit(changes)); });
    client.appStorage.setItem('bas.scope.demo.test', '"new local edit"');
    const saved = client.flushDeviceStorage();
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    finishRead!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.appStorage.getItem('bas.scope.demo.test')).toBe('"new local edit"');
    finishWrite!();
    await saved;
    expect(client.deviceStatus()).toBe('saved');
  });
});
