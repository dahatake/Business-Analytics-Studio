import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

test('FR-339 picks a new data folder, copies the data into it and switches back to existing data', async ({ page }) => {
  test.setTimeout(90_000);
  const deviceId = randomUUID();
  const home = join(deviceRoot, 'device-tests', deviceId);
  const parent = scratch();
  await setup(page, { lang: 'en', deviceId });
  await page.goto('/#/home');
  await seedDeviceData(page, { 'bas.scope.pj-location.note': JSON.stringify({ note: 'must travel with the folder' }) });
  const before = await deviceSnapshot(page);

  await openSettings(page);
  await expect(page.getByTestId('data-location-current')).toHaveText(home);
  expect(await scan(page, '[data-testid="data-location"]')).toEqual([]);

  await page.getByTestId('data-location-change').click();
  const picker = page.getByTestId('folder-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('folder-picker-path').fill(parent);
  await picker.getByTestId('folder-picker-go').click();
  await expect(picker.getByRole('heading', { name: `Folders in ${parent}` })).toBeVisible();
  await picker.getByTestId('folder-picker-new-name').fill('BAS data');
  await picker.getByTestId('folder-picker-create').click();
  const target = join(parent, 'BAS data');
  await expect(picker.getByTestId('folder-picker-path')).toHaveValue(target);
  expect(await scan(page, '[data-testid="folder-picker"]')).toEqual([]);
  // Typing a folder that holds data, or the current folder, is flagged before anything is changed.
  await picker.getByTestId('folder-picker-path').fill(home);
  await picker.getByTestId('folder-picker-go').click();
  await expect(picker.getByTestId('folder-picker-status')).toContainText('This is already the current data folder.');
  await expect(picker.getByTestId('folder-picker-select')).toBeDisabled();
  await picker.getByTestId('folder-picker-path').fill(target);
  await picker.getByTestId('folder-picker-go').click();
  await picker.getByTestId('folder-picker-select').click();
  await expect(picker).toBeHidden();

  await expect(page.getByTestId('data-location-mode')).toHaveAttribute('data-mode', 'copy');
  await page.getByTestId('data-location-confirm-button').click();
  await expect(page.getByTestId('data-location-current')).toHaveText(target);
  expect(existsSync(join(target, 'device.sqlite'))).toBe(true);
  const after = await deviceSnapshot(page);
  expect(after).toEqual(before);
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');

  // Going back to the default folder opens the data still kept there instead of copying over it.
  await page.getByTestId('data-location-change').click();
  await picker.getByTestId('folder-picker-path').fill(home);
  await picker.getByTestId('folder-picker-go').click();
  await expect(picker.getByTestId('folder-picker-status')).toContainText('This folder holds BAS data.');
  await picker.getByTestId('folder-picker-select').click();
  await expect(page.getByTestId('data-location-mode')).toHaveAttribute('data-mode', 'open');
  await page.getByTestId('data-location-confirm-button').click();
  await expect(page.getByTestId('data-location-current')).toHaveText(home);
  expect((await deviceSnapshot(page)).records['bas.scope.pj-location.note']).toEqual(before.records['bas.scope.pj-location.note']);
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
