// FR-374: customer download page and guide (site/), and their consistency with the packager and release workflow.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyAssets, detectTarget, TARGETS as SITE_TARGETS } from '../site/assets/download.js';
import { TARGETS as PACKAGE_TARGETS } from '../scripts/portable.ts';

const SITE = join(import.meta.dirname, '..', 'site');
const read = (file: string) => readFileSync(join(SITE, file), 'utf8');
const asset = (name: string) => ({ name, size: 1, browser_download_url: `https://example.test/${name}` });

describe('download page', () => {
  it('lists one zip per target in the page order, ignores checksums and finds SHA256SUMS.txt', () => {
    const { packages, sums } = classifyAssets([
      asset('BusinessAnalyticsStudio-0.2.0-abc1234-mac-arm64.zip'),
      asset('BusinessAnalyticsStudio-0.2.0-abc1234-mac-arm64.zip.sha256'),
      asset('BusinessAnalyticsStudio-0.2.0-abc1234-win-x64.zip'),
      asset('SHA256SUMS.txt'),
      asset('notes.zip'),
    ]);
    expect(packages.map((p) => p.target)).toEqual(['win-x64', 'mac-arm64']);
    expect(packages[0]).toMatchObject({ start: 'start.cmd', url: 'https://example.test/BusinessAnalyticsStudio-0.2.0-abc1234-win-x64.zip' });
    expect(sums).toBe('https://example.test/SHA256SUMS.txt');
    expect(classifyAssets(undefined)).toEqual({ packages: [], sums: null });
  });

  it('recommends the zip for the CPU the browser reports, and lets ?os= override it', () => {
    expect(detectTarget({ platform: 'Windows', architecture: 'x86' })).toBe('win-x64');
    expect(detectTarget({ platform: 'Windows', architecture: 'arm' })).toBe('win-arm64');
    // Safari and Firefox do not report the CPU: a Mac defaults to Apple silicon.
    expect(detectTarget({ platform: 'MacIntel' })).toBe('mac-arm64');
    expect(detectTarget({ platform: 'macOS', architecture: 'x86' })).toBe('mac-x64');
    expect(detectTarget({ userAgent: 'Mozilla/5.0 (X11; Linux aarch64)' })).toBe('linux-arm64');
    expect(detectTarget({ userAgent: 'Mozilla/5.0 (Linux; Android 15)' })).toBeNull();
    expect(detectTarget({ platform: 'Windows', override: 'linux-x64' })).toBe('linux-x64');
    expect(detectTarget({ platform: 'Windows', override: 'bogus' })).toBe('win-x64');
  });

  it('knows exactly the targets the packager builds and the release workflow publishes', () => {
    const ids = SITE_TARGETS.map((t) => t.id);
    expect([...ids].sort()).toEqual(Object.keys(PACKAGE_TARGETS).sort());
    const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    const published = /^\s*TARGETS:\s*(.+)$/m.exec(workflow)?.[1]?.split(',').map((t) => t.trim());
    expect(published?.sort()).toEqual([...ids].sort());
    for (const t of SITE_TARGETS) expect(t.start).toBe(PACKAGE_TARGETS[t.id]!.os === 'win32' ? 'start.cmd' : PACKAGE_TARGETS[t.id]!.os === 'darwin' ? 'start.command' : 'start.sh');
  });
});

describe('guide', () => {
  const guide = read('guide.md');

  it('every screenshot it shows exists, and every generated screenshot is used', () => {
    const shown = [...guide.matchAll(/\]\((images\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(shown.length).toBeGreaterThanOrEqual(8);
    for (const file of shown) expect(existsSync(join(SITE, file)), file).toBe(true);
    const script = readFileSync(join(import.meta.dirname, '..', 'scripts', 'guide-screenshots.ts'), 'utf8');
    const generated = [...script.matchAll(/'(\d\d-[a-z0-9-]+\.png)'/g)].map((m) => `images/${m[1]}`);
    expect(generated.length).toBeGreaterThanOrEqual(8);
    expect([...new Set(shown)].sort()).toEqual([...new Set(generated)].sort());
  });

  it('every in-page link points at an anchor that exists', () => {
    const anchors = new Set([...guide.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
    const links = [...guide.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(5);
    for (const id of links) expect(anchors.has(id), id).toBe(true);
    // The download page and the portable README link to these sections.
    for (const id of ['trouble', 'it']) expect(anchors.has(id)).toBe(true);
    expect(read('index.html')).toMatch(/guide\.html#trouble/);
  });
});
