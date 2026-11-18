import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { setup } from './helpers.ts';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test('shows startup from the initial HTML through device and pack loading', async ({ page }) => {
  await setup(page, { lang: 'en' });
  let releaseScripts!: () => void;
  let releaseDevice!: () => void;
  let releasePack!: () => void;
  let markPackStarted!: () => void;
  const scriptsReady = new Promise<void>((resolve) => { releaseScripts = resolve; });
  const deviceReady = new Promise<void>((resolve) => { releaseDevice = resolve; });
  const packReady = new Promise<void>((resolve) => { releasePack = resolve; });
  const packStarted = new Promise<void>((resolve) => { markPackStarted = resolve; });
  await page.route('**/assets/*.js', async (route) => { await scriptsReady; await route.continue(); });
  await page.route('**/device/state', async (route) => { await deviceReady; await route.continue(); });
  await page.route('**/data/pack.json', async (route) => { markPackStarted(); await packReady; await route.continue(); });

  await page.goto('/#/home', { waitUntil: 'commit' });
  const splash = page.getByTestId('startup-splash');
  const status = page.getByTestId('startup-status');
  await expect(splash).toBeVisible();
  await expect(status).toHaveText('アプリを準備しています…');
  await expect(page.locator('.startup-indicator span')).toHaveCSS('animation-name', 'none');
  const accessibility = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);

  releaseScripts();
  await expect(status).toHaveText('Loading data saved on this PC…');
  await expect(page.locator('main#main')).toHaveCount(0);
  releaseDevice();
  await packStarted;
  await expect(status).toHaveText('Preparing the app…');
  await expect(splash).toBeVisible();
  releasePack();
  await expect(splash).toHaveCount(0);
  await expect(page.locator('main#main')).toBeVisible();
});

test('uses saved language and reduced motion while loading the pack', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await setup(page, { lang: 'ja', motion: 'reduce' });
  let releasePack!: () => void;
  let markPackStarted!: () => void;
  const packReady = new Promise<void>((resolve) => { releasePack = resolve; });
  const packStarted = new Promise<void>((resolve) => { markPackStarted = resolve; });
  await page.route('**/data/pack.json', async (route) => { markPackStarted(); await packReady; await route.continue(); });
  await page.goto('/#/home', { waitUntil: 'commit' });
  await packStarted;
  await expect(page.getByTestId('startup-status')).toHaveText('アプリを準備しています…');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('.startup-indicator span')).toHaveCSS('animation-name', 'none');
  releasePack();
  await expect(page.locator('main#main')).toBeVisible();
});

test('startup failure replaces the splash and retry restores it', async ({ page }) => {
  await setup(page, { lang: 'en' });
  let releaseRetry!: () => void;
  const retryReady = new Promise<void>((resolve) => { releaseRetry = resolve; });
  let fail = true;
  await page.route('**/device/state', async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { error: 'deviceUnavailable' } });
    else { await retryReady; await route.continue(); }
  });
  await page.goto('/#/home');
  await expect(page.getByTestId('device-startup-error')).toBeVisible();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Reload / retry' }).click();
  await expect(page.getByTestId('startup-splash')).toBeVisible();
  await expect(page.getByTestId('startup-status')).toHaveText('Loading data saved on this PC…');
  releaseRetry();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
  await expect(page.locator('main#main')).toBeVisible();
});
