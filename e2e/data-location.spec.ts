import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DeviceFolderSelection } from '../scripts/lib/deviceProtocol.ts';
import { writeLocation } from '../scripts/lib/deviceLocation.ts';
import { deviceSnapshot, seedDeviceData, setup } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const deviceRoot = resolve(process.env.BAS_RELAY_DIR ?? `.bas-local/e2e-${process.env.BAS_OUT ?? 'dist'}`);
const folders: string[] = [];
test.afterAll(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

function scratch() {
  const folder = resolve('.bas-local', `e2e-location-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  folders.push(folder);
  return folder;
}
async function scan(page: Page, include: string) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .include(include).exclude('[data-tabster-dummy]').analyze();
  return result.violations.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}
async function openSettings(page: Page) {
  await page.goto('/#/settings');
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  await expect(page.getByTestId('data-location-current')).toBeVisible();
}
async function pickResult(page: Page, selection: DeviceFolderSelection | null, delay = 0) {
  await page.route('**/device/folders/pick', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ title: 'Choose a data folder' });
    if (delay) await new Promise((done) => setTimeout(done, delay));
    await route.fulfill({ json: { selection } });
  }, { times: 1 });
  await page.getByTestId('data-location-change').click();
}

test('FR-339 picks a new data folder, copies the data into it and switches back to existing data', async ({ page }) => {
  test.setTimeout(90_000);
  const deviceId = randomUUID();
  const home = join(deviceRoot, 'device-tests', deviceId);
  const parent = scratch();
  const target = join(parent, 'BAS データ');
  mkdirSync(target);
  await setup(page, { lang: 'en', deviceId });
  await page.goto('/#/home');
  await seedDeviceData(page, { 'bas.scope.pj-location.note': JSON.stringify({ note: 'must travel with the folder' }) });
  const before = await deviceSnapshot(page);

  await openSettings(page);
  await expect(page.getByTestId('data-location-current')).toHaveText(home);
  expect(await scan(page, '[data-testid="data-location"]')).toEqual([]);

  await pickResult(page, { path: target, hasData: false, warnings: [] });
  await expect(page.getByTestId('data-location-confirm')).toContainText(target);
  expect(await scan(page, '[data-testid="data-location"]')).toEqual([]);
  await expect(page.getByTestId('data-location-mode')).toHaveAttribute('data-mode', 'copy');
  await page.getByTestId('data-location-confirm-button').click();
  await expect(page.getByTestId('data-location-current')).toHaveText(target);
  expect(existsSync(join(target, 'device.sqlite'))).toBe(true);
  const after = await deviceSnapshot(page);
  expect(after).toEqual(before);
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');

  // Going back to the default folder opens the data still kept there instead of copying over it.
  await pickResult(page, { path: home, hasData: true, warnings: [] });
  await expect(page.getByTestId('data-location-mode')).toHaveAttribute('data-mode', 'open');
  await page.getByTestId('data-location-confirm-button').click();
  await expect(page.getByTestId('data-location-current')).toHaveText(home);
  expect((await deviceSnapshot(page)).records['bas.scope.pj-location.note']).toEqual(before.records['bas.scope.pj-location.note']);
});

test('FR-339 preserves the data folder on cancellation and reports picker errors', async ({ page }) => {
  await setup(page, { lang: 'en' });
  await openSettings(page);
  const current = await page.getByTestId('data-location-current').textContent();
  await pickResult(page, null);
  await expect(page.getByTestId('data-location-change')).toBeEnabled();
  await expect(page.getByTestId('data-location-confirm')).toHaveCount(0);
  await expect(page.getByTestId('data-location-error')).toHaveCount(0);

  await page.route('**/device/folders/pick', (route) => route.fulfill({
    status: 503, json: { error: 'locationPickerUnavailable' },
  }), { times: 1 });
  await page.getByTestId('data-location-change').click();
  await expect(page.getByTestId('data-location-error')).toContainText('The folder picker is unavailable');
  await expect(page.getByTestId('data-location-current')).toHaveText(current!);
  await expect(page.getByTestId('data-location-confirm')).toHaveCount(0);
});

test('FR-339 shows Japanese validation and sync warnings after native selection', async ({ page }) => {
  await setup(page, { lang: 'ja' });
  await openSettings(page);
  await page.route('**/device/folders/pick', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ title: '保存先フォルダーを選ぶ' });
    await route.fulfill({ status: 400, json: { error: 'locationSame' } });
  }, { times: 1 });
  await page.getByTestId('data-location-change').click();
  await expect(page.getByTestId('data-location-error')).toContainText('現在の保存先と同じフォルダーです');
  await expect(page.getByTestId('data-location-confirm')).toHaveCount(0);

  const target = scratch();
  await page.route('**/device/folders/pick', (route) => route.fulfill({
    json: { selection: { path: target, hasData: false, warnings: ['syncedFolder'] } },
  }), { times: 1 });
  await page.getByTestId('data-location-change').click();
  await expect(page.getByTestId('data-location-confirm')).toContainText('OneDrive');
  await expect(page.getByTestId('data-location-error')).toHaveCount(0);
});

test('FR-339 leaves the native picker open while the user takes longer than 15 seconds', async ({ page }) => {
  await setup(page, { lang: 'en' });
  await openSettings(page);
  await pickResult(page, null, 15_500);
  await expect(page.getByTestId('data-location-change')).toBeDisabled();
  await expect(page.getByTestId('data-location-change')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('data-location-error')).toHaveCount(0);
  await expect(page.getByTestId('data-location-confirm')).toHaveCount(0);
});

test('FR-339 stops safely when the chosen folder is missing and can return to the default folder', async ({ page }) => {
  const deviceId = randomUUID();
  const home = join(deviceRoot, 'device-tests', deviceId);
  const missing = join(scratch(), 'unplugged');
  await setup(page, { lang: 'en', deviceId });
  await page.goto('/#/home');
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  writeLocation(home, missing);

  await page.reload();
  const error = page.getByTestId('device-startup-error');
  await expect(error).toContainText('cannot be found or holds no BAS data');
  await expect(error.getByTestId('device-location-path')).toContainText(missing);
  expect(existsSync(missing)).toBe(false);
  await error.getByRole('button', { name: /Go back to the default folder/ }).click();
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  await page.goto('/#/settings');
  await expect(page.getByTestId('data-location-current')).toHaveText(home);
});
