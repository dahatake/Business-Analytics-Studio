// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
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
    writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html>');
    writeFileSync(join(app, 'node_modules', 'vite', 'bin', 'vite.js'), '');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function launch({ buildExit = 0, previewExit = 0, writeBuild = true } = {}) {
    writeFileSync(join(bin, 'npm.cmd'), [
      '@echo off',
      'echo cwd=%CD%',
      'echo args=%*',
      'if "%*"=="run build" (',
      `  if not "${buildExit}"=="0" exit /b ${buildExit}`,
      ...(writeBuild ? ['  if not exist "dist" mkdir "dist"', '  >"dist\\index.html" echo current-build'] : []),
      '  exit /b 0',
      ')',
      `exit /b ${previewExit}`,
      '',
    ].join('\r\n'));
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${join(app, 'run.cmd')}" --port 4187"`], {
      cwd: caller,
      env: { ...process.env, PATH: `${bin};${dirname(process.execPath)};${process.env.SystemRoot}\\System32` },
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      timeout: 15_000,
    });
  }

  it('starts from another directory, handles spaces and requests a browser with the forwarded preview arguments', () => {
    const result = launch();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`cwd=${app}`);
    expect(result.stdout).toContain('args=run build');
    expect(result.stdout).toContain('args=run preview -- --strictPort false --open --port 4187');
    expect(result.stdout.indexOf('args=run build')).toBeLessThan(result.stdout.indexOf('args=run preview'));
  });

  it('preserves startup failure exit codes and reports the failure', () => {
    const result = launch({ previewExit: 7 });
    expect(result.status, result.stdout + result.stderr).toBe(7);
    expect(result.stdout).toContain('Startup failed.');
  });

  it('builds before every launch even when an existing build is already current', () => {
    for (let i = 0; i < 2; i++) {
      const result = launch();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.match(/args=run build\r?\n/g)).toHaveLength(1);
      expect(result.stdout.indexOf('args=run build')).toBeLessThan(result.stdout.indexOf('args=run preview'));
      expect(readFileSync(join(app, 'dist', 'index.html'), 'utf8').trim()).toBe('current-build');
    }
  });

  it('creates a missing build before starting the application', () => {
    const dist = join(app, 'dist');
    rmSync(dist, { recursive: true, force: true });
    const result = launch();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('args=run build');
    expect(result.stdout).toContain('args=run preview');
    expect(readFileSync(join(dist, 'index.html'), 'utf8').trim()).toBe('current-build');
  });

  it('does not start preview if a successful build produces no index.html', () => {
    rmSync(join(app, 'dist', 'index.html'));
    try {
      const result = launch({ writeBuild: false });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('Build output dist\\index.html is missing.');
      expect(result.stdout).not.toContain('args=run preview');
    } finally {
      writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html>');
    }
  });

  it('rebuilds old output from the current source before starting preview', () => {
    const src = join(app, 'src');
    mkdirSync(src, { recursive: true });
    const built = join(app, 'dist', 'index.html');
    utimesSync(built, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    writeFileSync(join(src, 'App.tsx'), 'export {};');
    try {
      const result = launch();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('args=run build');
      expect(result.stdout).toContain('args=run preview');
      expect(readFileSync(built, 'utf8').trim()).toBe('current-build');
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('preserves build failure exit codes and never serves the previous build', () => {
    const built = join(app, 'dist', 'index.html');
    writeFileSync(built, 'previous-build');
    const result = launch({ buildExit: 9 });
    expect(result.status, result.stdout + result.stderr).toBe(9);
    expect(result.stdout).toContain('Build failed. The application was not started.');
    expect(result.stdout).not.toContain('args=run preview');
    expect(readFileSync(built, 'utf8')).toBe('previous-build');
  });

  it('reports missing dependencies without starting npm', () => {
    rmSync(join(app, 'node_modules', 'vite', 'bin', 'vite.js'));
    try {
      const result = launch();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('Dependencies are missing.');
      expect(result.stdout).not.toContain('args=');
    } finally {
      writeFileSync(join(app, 'node_modules', 'vite', 'bin', 'vite.js'), '');
    }
  });

  it.each(['free', 'occupied', 'strict'] as const)('runs the real preview CLI with a %s port', async (mode) => {
    writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>Launcher test</title>');
    const blocker = createServer((_req, res) => res.end('existing server'));
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
    const port = address.port;
    if (mode === 'free') await new Promise<void>((resolve) => blocker.close(() => resolve()));

    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: { preview: string } };
    const launcher = readFileSync(resolve('run.cmd'), 'utf8');
    const forwarded = /call npm\.cmd run preview -- (.+) %\*/.exec(launcher)?.[1];
    if (!forwarded) throw new Error('Preview command missing from run.cmd');
    const child = spawn(process.execPath, [
      resolve('node_modules', 'vite', 'bin', 'vite.js'),
      ...pkg.scripts.preview.split(' ').slice(1),
      ...forwarded.split(' '),
      '--port', String(port), '--outDir', join(app, 'dist'),
      ...(mode === 'strict' ? ['--strictPort'] : []),
    ], {
      cwd: resolve('.'),
      env: { ...process.env, BROWSER: 'none', NO_COLOR: '1', BAS_RELAY_DIR: join(root, 'relay') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    try {
      if (mode === 'strict') {
        await vi.waitFor(() => expect(child.exitCode, output).toBe(1), { timeout: 20_000 });
        expect(output).toContain(`Port ${port} is already in use`);
      } else {
        await vi.waitFor(() => expect(output, output).toMatch(/http:\/\/127\.0\.0\.1:\d+/), { timeout: 20_000 });
        const url = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (!url) throw new Error(`Preview URL missing: ${output}`);
        const origin = url[0];
        if (mode === 'free') expect(Number(url[1])).toBe(port);
        if (mode === 'occupied') {
          expect(Number(url[1])).toBeGreaterThan(port);
          expect(output).toContain(`Port ${port} is in use, trying another one`);
        }
        expect(await (await fetch(origin)).text()).toContain('<!doctype html>');
        const session = await fetch(`${origin}/relay/session`, { method: 'POST', headers: { origin } });
        expect(session.status).toBe(200);
        expect(await session.json()).toEqual({ token: expect.any(String) });
      }
      if (mode !== 'free') {
        expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('existing server');
      }
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 30_000);
});
