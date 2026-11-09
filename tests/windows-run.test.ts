import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const root = resolve('.bas-local', `test-windows-run-${process.pid}`);
const app = join(root, 'app with spaces');
const caller = join(root, 'caller');
const bin = join(root, 'bin');

describe.skipIf(process.platform !== 'win32')('Windows run.cmd', () => {
  beforeAll(() => {
    mkdirSync(join(app, 'dist'), { recursive: true });
    mkdirSync(join(app, 'node_modules', 'vite', 'bin'), { recursive: true });
    mkdirSync(caller, { recursive: true });
    mkdirSync(bin, { recursive: true });
    copyFileSync(resolve('run.cmd'), join(app, 'run.cmd'));
    mkdirSync(join(app, 'scripts'), { recursive: true });
    copyFileSync(resolve('scripts', 'check-build.mjs'), join(app, 'scripts', 'check-build.mjs'));
    writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html>');
    writeFileSync(join(app, 'node_modules', 'vite', 'bin', 'vite.js'), '');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function launch(npmExit: number) {
    writeFileSync(join(bin, 'npm.cmd'), `@echo off\r\necho cwd=%CD%\r\necho args=%*\r\nexit /b ${npmExit}\r\n`);
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${join(app, 'run.cmd')}" --port 4187"`], {
      cwd: caller,
      env: { ...process.env, PATH: `${bin};${dirname(process.execPath)};${process.env.SystemRoot}\\System32` },
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      timeout: 15_000,
    });
  }

  it('starts from another directory, handles spaces and forwards preview arguments', () => {
    const result = launch(0);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`cwd=${app}`);
    expect(result.stdout).toContain('args=run preview -- --port 4187');
  });

  it('preserves startup failure exit codes and reports the failure', () => {
    const result = launch(7);
    expect(result.status, result.stdout + result.stderr).toBe(7);
    expect(result.stdout).toContain('Startup failed.');
  });

  it('reports a missing build without starting npm', () => {
    rmSync(join(app, 'dist', 'index.html'));
    try {
      const result = launch(0);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('The app is not built.');
      expect(result.stdout).not.toContain('args=');
    } finally {
      writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html>');
    }
  });

  it('refuses a build older than the source instead of silently showing an old version', () => {
    const src = join(app, 'src');
    mkdirSync(src, { recursive: true });
    const built = join(app, 'dist', 'index.html');
    utimesSync(built, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    writeFileSync(join(src, 'App.tsx'), 'export {};');
    try {
      const stale = launch(0);
      expect(stale.status, stale.stdout + stale.stderr).toBe(1);
      expect(stale.stdout).toContain('older than the source');
      expect(stale.stdout).toContain(join('src', 'App.tsx'));
      expect(stale.stdout).toContain('Run npm.cmd run build');
      expect(stale.stdout).not.toContain('args=');

      writeFileSync(built, '<!doctype html>');
      const fresh = launch(0);
      expect(fresh.status, fresh.stdout + fresh.stderr).toBe(0);
      expect(fresh.stdout).toContain('args=run preview');
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('reports missing dependencies without starting npm', () => {
    rmSync(join(app, 'node_modules', 'vite', 'bin', 'vite.js'));
    try {
      const result = launch(0);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('Dependencies are missing.');
      expect(result.stdout).not.toContain('args=');
    } finally {
      writeFileSync(join(app, 'node_modules', 'vite', 'bin', 'vite.js'), '');
    }
  });
});
