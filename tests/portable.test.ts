import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ID, DEFAULT_PORTS, LaunchError, applyNetworkFile, defaultDataDir, parseArgs, startApp, type Running } from '../server/main.ts';
import { lockClosure, writeZip } from '../scripts/portable.ts';

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bas-portable-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FR-373: portable launcher options', () => {
  it('keeps data outside the package in the per-user folder of each OS', () => {
    expect(defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a')).toBe(join('C:\\Users\\a\\AppData\\Local', 'BusinessAnalyticsStudio'));
    expect(defaultDataDir({}, 'darwin', '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'BusinessAnalyticsStudio'));
    expect(defaultDataDir({ XDG_DATA_HOME: '/x' }, 'linux', '/home/a')).toBe(join('/x', 'BusinessAnalyticsStudio'));
  });

  it('resolves the app next to server/ and pins only an explicit data folder', () => {
    const pkg = join(tmpdir(), 'pkg');
    const defaults = parseArgs([], { LOCALAPPDATA: join(tmpdir(), 'local') }, join(pkg, 'server'));
    expect(defaults).toMatchObject({ appDir: join(pkg, 'app'), dataDirFixed: false, ports: DEFAULT_PORTS, open: true });
    if (defaults === 'help') throw new Error('unexpected');
    expect(defaults.networkFiles[0]).toBe(join(pkg, 'network.json'));
    const explicit = parseArgs(['--data-dir', join(tmpdir(), 'd'), '--port', '0', '--no-open'], {}, join(pkg, 'server'));
    expect(explicit).toMatchObject({ dataDir: join(tmpdir(), 'd'), dataDirFixed: true, ports: [0], open: false });
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(() => parseArgs(['--port', 'x'], {})).toThrow(LaunchError);
    expect(() => parseArgs(['--data-dir'], {})).toThrow(LaunchError);
    expect(() => parseArgs(['--unknown'], {})).toThrow(LaunchError);
  });

  it('reads network.json into BAS_* settings without overriding variables already set', () => {
    const dir = temp();
    const file = join(dir, 'network.json');
    writeFileSync(file, '\uFEFF{ "$comment": "x", "proxy": "http://proxy:8080", "noProxy": ["*.corp", "10.0.0.0/8"], "systemCa": false }');
    const env: Record<string, string | undefined> = { BAS_PROXY: 'direct' };
    expect(applyNetworkFile([join(dir, 'missing.json'), file], env)).toBe(file);
    expect(env).toEqual({ BAS_PROXY: 'direct', BAS_NO_PROXY: '*.corp,10.0.0.0/8', BAS_SYSTEM_CA: '0' });
    expect(applyNetworkFile([join(dir, 'missing.json')], {})).toBeNull();
    writeFileSync(file, '{ "proxi": "x" }');
    expect(() => applyNetworkFile([file], {})).toThrow(/unknown key "proxi"/);
    writeFileSync(file, '{ "systemCa": "yes" }');
    expect(() => applyNetworkFile([file], {})).toThrow(/true or false/);
    writeFileSync(file, '{ broken');
    expect(() => applyNetworkFile([file], {})).toThrow(/not valid JSON/);
  });
});

describe('FR-373: portable server', () => {
  it('serves the app with security headers, answers /healthz, reuses a running instance and cleans up', async () => {
    const app = temp();
    const data = temp();
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>BAS</title>');
    const env = { BAS_PROXY: 'direct', BAS_SYSTEM_CA: '0' };
    const opts = { appDir: app, dataDir: data, dataDirFixed: true, ports: [0], open: false, networkFiles: [] };
    const lines: string[] = [];
    const started = await startApp(opts, env, (l) => lines.push(l));
    if ('reused' in started) throw new Error('unexpected reuse');
    const running: Running = started;
    try {
      const page = await fetch(running.url);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await page.text()).toContain('<title>BAS</title>');
      expect((await fetch(`${running.url}missing.js`)).status).toBe(404);
      expect((await fetch(`${running.url}api/v1/none`)).headers.get('content-type')).toContain('application/json');
      const health = await (await fetch(`${running.url}healthz`)).json() as { app: string };
      expect(health.app).toBe(APP_ID);
      // The relay is mounted: a session request from the page's own origin gets a token.
      const session = await fetch(`${running.url}relay/session`, { method: 'POST', headers: { origin: running.url.slice(0, -1), 'content-type': 'application/json' }, body: '{}' });
      expect(session.status).toBe(200);
      expect(lines.join('\n')).toContain(running.url);
      expect(lines.join('\n')).toContain('direct');
      // A second start for the same data folder points at the first one instead of opening a second writer.
      expect(await startApp(opts, env, () => undefined)).toEqual({ reused: running.url });
    } finally {
      await running.close();
    }
    expect(existsSync(join(data, 'instance.json'))).toBe(false);
  });

  it('ignores a stale instance file and refuses a folder without the app', async () => {
    const app = temp();
    const data = temp();
    writeFileSync(join(data, 'instance.json'), JSON.stringify({ pid: 1, port: 9, id: 'gone' }));
    await expect(startApp({ appDir: join(app, 'none'), dataDir: data, dataDirFixed: true, ports: [0], open: false, networkFiles: [] }, {}, () => undefined)).rejects.toThrow(/app not found/);
    writeFileSync(join(app, 'index.html'), '<!doctype html>');
    const started = await startApp({ appDir: app, dataDir: data, dataDirFixed: true, ports: [0], open: false, networkFiles: [] }, { BAS_PROXY: 'direct', BAS_SYSTEM_CA: '0' }, () => undefined);
    expect('reused' in started).toBe(false);
    if (!('reused' in started)) await started.close();
  });
});

describe('FR-373: packager', () => {
  it('ships only the lockfile closure of the server packages, resolving nested copies like Node', () => {
    const lock = {
      name: 'x', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { dependencies: { a: '1' } },
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^2' }, optionalDependencies: { 'a-win': '1', 'a-gone': '1' } },
        'node_modules/a/node_modules/b': { version: '2.0.0' },
        'node_modules/a-win': { version: '1.0.0', optional: true },
        'node_modules/b': { version: '1.0.0' },
        'node_modules/react': { version: '19.0.0' },
      },
    };
    expect(Object.keys(lockClosure(lock, ['a'])).sort()).toEqual(['node_modules/a', 'node_modules/a-win', 'node_modules/a/node_modules/b']);
    expect(() => lockClosure(lock, ['missing'])).toThrow(/not in package-lock/);
    expect(() => lockClosure({ ...lock, packages: { 'node_modules/c': { dependencies: { d: '1' } } } }, ['c'])).toThrow(/d \(needed by node_modules\/c\)/);
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('writes a zip that the OS tar extracts byte for byte, keeping UTF-8 names', () => {
    const dir = temp();
    const big = Buffer.from('BAS '.repeat(10_000));
    const zip = writeZip([
      { name: 'top/start.cmd', data: Buffer.from('@echo off\r\n'), mode: 0o755 },
      { name: 'top/データ/説明.txt', data: big, mode: 0o644 },
      { name: 'top/empty.txt', data: Buffer.alloc(0), mode: 0o644 },
    ], new Date(Date.UTC(2026, 10, 26, 12, 0, 0)));
    writeFileSync(join(dir, 'a.zip'), zip);
    mkdirSync(join(dir, 'out'));
    execFileSync('tar', ['-xf', join(dir, 'a.zip'), '-C', join(dir, 'out')]);
    expect(readFileSync(join(dir, 'out', 'top', 'start.cmd'), 'utf8')).toBe('@echo off\r\n');
    expect(readFileSync(join(dir, 'out', 'top', 'データ', '説明.txt')).equals(big)).toBe(true);
    expect(readFileSync(join(dir, 'out', 'top', 'empty.txt')).length).toBe(0);
    expect(zip.length).toBeLessThan(big.length / 10);
  });
});
