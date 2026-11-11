import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { deviceSnapshot as state, seedDeviceData, setup } from './helpers.ts';
import { samplePack } from '../src/data/sample.ts';

test.describe.configure({ mode: 'serial' });
let preview: ChildProcess | null = null;
let secondOrigin = '';

async function startPreview() {
  let output = '';
  preview = spawn(process.execPath, [
    resolve('node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--outDir', process.env.BAS_OUT ?? 'dist',
    '--host', '127.0.0.1', '--port', '0',
  ], {
    env: { ...process.env, NO_COLOR: '1', BAS_RELAY_DIR: process.env.BAS_RELAY_DIR ?? `.bas-local/e2e-${process.env.BAS_OUT ?? 'dist'}`, BAS_DEVICE_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  preview.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
  preview.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
  await expect.poll(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], { message: 'second preview starts', timeout: 30_000 }).toBeTruthy();
  secondOrigin = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
}
async function stopPreview() {
  if (!preview || preview.exitCode !== null) return;
  const exit = once(preview, 'exit');
  preview.kill();
  await exit;
  preview = null;
}
test.beforeAll(startPreview);
test.afterAll(stopPreview);

async function saved(page: Page) {
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
}
test('legacy migration, different ports and browsers, restart, stale edits and failed saves', async ({ browser, page, baseURL }) => {
  test.setTimeout(120_000);
  expect(secondOrigin).not.toBe(baseURL);
  const deviceId = randomUUID();
  await setup(page, { lang: 'en', deviceId });
  const packKey = 'bas.binary.pack.pj-device';
  const inkKey = 'bas.binary.ink.pj-device::board';
  await page.addInitScript((pack) => {
    if (sessionStorage.getItem('device-seeded')) return;
    sessionStorage.setItem('device-seeded', '1');
    const createdAt = '2026-11-11T00:00:00.000Z';
    localStorage.setItem('bas.projects', JSON.stringify({ version: 1, state: {
      companies: [{ id: 'co-device', name: 'Device continuity', createdAt }],
      projects: [{ id: 'pj-device', companyId: 'co-device', name: 'Port independent', createdAt, step: 'define' }],
      target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define',
    } }));
    localStorage.setItem('bas.scope.pj-device.continuity', JSON.stringify({ note: 'legacy analysis and discussion' }));
    localStorage.setItem('bas.packs.index', JSON.stringify({
      'pj-device': { projectId: 'pj-device', packId: pack.packId, company: pack.company, isSample: pack.isSample, entities: pack.entities.length, importedAt: createdAt, files: ['legacy.json'] },
    }));
    // Keep an open transaction before the application starts; migration must wait for these original writes.
    for (const [name, store, key, value] of [
      ['bas-packs', 'packs', 'pj-device', pack],
      ['bas-ink', 'boards', 'pj-device::board', { strokes: [], notes: [{ id: 'legacy-note', text: { en: 'Retained board', ja: 'Retained board' }, x: 0, y: 0, w: 200, h: 100, color: 'yellow' }], cards: [], links: [] }],
    ] as const) {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(store);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => db.close();
      };
    }
  }, samplePack);
  await page.goto('/#/projects');
  await expect(page.getByTestId('proj-company-Device continuity')).toBeVisible();
  await saved(page);
  const migrated = await state(page);
  expect(JSON.parse(migrated.records[packKey]!.value!)).toEqual(samplePack);
  expect(JSON.parse(migrated.records[inkKey]!.value!).notes[0].text.en).toBe('Retained board');
  expect(migrated.records['bas.scope.pj-device.continuity']?.value).toContain('legacy analysis');

  const context = await browser.newContext();
  const other = await context.newPage();
  await setup(other, { lang: 'en', deviceId });
  await other.goto(`${secondOrigin}/#/projects`);
  await expect(other.getByTestId('proj-company-Device continuity')).toBeVisible();
  expect((await state(other)).records[packKey]).toEqual(migrated.records[packKey]);
  // Both pages have the original revision; the second browser must not overwrite this successful edit.
  await page.getByTestId('proj-company-name').fill('Saved from first port');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await saved(page);
  await other.getByTestId('proj-company-name').fill('Stale second port');
  await other.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(other.getByTestId('device-storage-error')).toBeVisible();
  expect((await state(page)).records['bas.projects']?.value).not.toContain('Stale second port');
  const download = other.waitForEvent('download');
  await other.getByRole('button', { name: 'Download recovery copy' }).click();
  expect((await download).suggestedFilename()).toBe('bas-recovery.json');
  await context.close();

  await stopPreview();
  await startPreview();
  const restartedContext = await browser.newContext();
  const restarted = await restartedContext.newPage();
  await setup(restarted, { lang: 'en', deviceId });
  await restarted.goto(`${secondOrigin}/#/projects`);
  await expect(restarted.getByTestId('proj-company-Saved from first port')).toBeVisible();
  expect((await state(restarted)).records[inkKey]).toEqual(migrated.records[inkKey]);

  await restarted.route('**/device/state', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 503, json: { error: 'deviceUnavailable' } });
    else await route.continue();
  });
  await restarted.getByTestId('proj-company-name').fill('Unsaved but recoverable');
  await restarted.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(restarted.getByTestId('device-storage-error')).toBeVisible();
  expect((await state(page)).records['bas.projects']?.value).not.toContain('Unsaved but recoverable');
  await restarted.unroute('**/device/state');
  restarted.on('dialog', (dialog) => { void dialog.accept(); });
  await restarted.reload();
  await expect(restarted.getByTestId('proj-company-Unsaved but recoverable')).toBeVisible();
  await saved(restarted);
  await restartedContext.close();
});

test('legacy conflicts require an explicit choice and startup failures never show an empty application', async ({ browser, page }) => {
  const deviceId = randomUUID();
  await setup(page, { lang: 'en', deviceId });
  await page.goto('/#/projects');
  await expect(page.getByTestId('proj-company-name')).toBeVisible();
  await page.getByTestId('proj-company-name').fill('Canonical company');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await saved(page);
  const context = await browser.newContext();
  const legacy = await context.newPage();
  await setup(legacy, { lang: 'en', deviceId });
  await legacy.addInitScript(() => localStorage.setItem('bas.projects', JSON.stringify({
    version: 1, state: { companies: [{ id: 'legacy-only', name: 'Do not lose this company', createdAt: '2026-11-11' }], projects: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' },
  })));
  await legacy.goto(`${secondOrigin}/#/projects`);
  await expect(legacy.getByTestId('device-startup-error')).toBeVisible();
  await expect(legacy.locator('main#main')).toHaveCount(0);
  expect(await legacy.evaluate(() => localStorage.getItem('bas.projects'))).toContain('Do not lose this company');
  expect((await state(page)).records['bas.projects']?.value).toContain('Canonical company');
  // The explicit choice archives the original data on disk before enabling the canonical device copy.
  await legacy.getByRole('button', { name: 'Use device data and keep legacy data' }).click();
  await expect(legacy.getByTestId('proj-company-Canonical company')).toBeVisible();
  await context.close();

  const brokenContext = await browser.newContext();
  const broken = await brokenContext.newPage();
  await setup(broken, { lang: 'en', deviceId });
  await broken.route('**/device/state', (route) => route.fulfill({ status: 503, json: { error: 'deviceUnavailable' } }));
  await broken.goto(`${secondOrigin}/#/projects`);
  await expect(broken.getByTestId('device-startup-error')).toBeVisible();
  await expect(broken.locator('main#main')).toHaveCount(0);
  await broken.unroute('**/device/state');
  await broken.getByRole('button', { name: 'Reload / retry' }).click();
  await expect(broken.getByTestId('proj-company-Canonical company')).toBeVisible();
  // Corrupt persisted values must also stop initialization, rather than silently falling back to defaults.
  await seedDeviceData(broken, { 'bas.projects': 'not JSON' });
  await broken.reload();
  await expect(broken.getByTestId('device-startup-error')).toBeVisible();
  await expect(broken.locator('main#main')).toHaveCount(0);
  await brokenContext.close();
});
