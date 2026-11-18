import { expect, test } from '@playwright/test';
import { PARAMS } from '../src/config/params.ts';
import { open, setup } from './helpers.ts';

test.describe('F-3.1.5 motion and sound', () => {
  test('OS reduced-motion: no opening, data-motion=reduced, animations disabled', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page, { motion: 'system', skipOpening: false, skipLaunch: true });
    await page.goto('/#/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByTestId('opening')).toHaveCount(0);
    const durations = await page.evaluate(() => ['.panel', '.aurora', '.main'].map((s) => getComputedStyle(document.querySelector(s)!).animationDuration));
    expect(durations.every((d) => d === '0s')).toBe(true);
  });

  test('full motion: the cinematic opening plays and can be skipped', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await setup(page, { motion: 'system', skipOpening: false });
    await page.goto('/#/');
    await expect(page.getByTestId('opening')).toBeVisible();
    // FR-076: the splash shows the application name only, never the sample customer's name.
    await expect(page.getByTestId('opening')).toContainText('Business Analytics Studio');
    await expect(page.getByTestId('opening')).not.toContainText(/青空精機|Aozora|架空|fictional/);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await page.getByRole('button', { name: /スキップ|Skip/ }).click();
    await expect(page.getByTestId('opening')).toHaveCount(0);
    // Start-up step 2 follows the splash.
    await expect(page.getByTestId('launch-screen')).toBeVisible();
    await page.getByTestId('launch-open-demo').click();
    await expect(page.locator('main#main')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('opening')).toBeVisible();
    await expect(page.locator('main#main')).toHaveCount(0);
    await page.getByRole('button', { name: /スキップ|Skip/ }).click();
    await expect(page.getByTestId('opening')).toHaveCount(0);
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.getByTestId('launch-screen')).toHaveCount(0);
  });

  test('Esc closes the opening', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await setup(page, { motion: 'full', skipOpening: false });
    await page.goto('/#/');
    await expect(page.getByTestId('opening')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('opening')).toHaveCount(0);
  });

  test('the opening closes itself and shows the selection screen', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await setup(page, { motion: 'full', skipOpening: false });
    await page.goto('/#/');
    await expect(page.getByTestId('opening')).toBeVisible();
    await expect(page.getByTestId('launch-screen')).toHaveCount(0);
    await expect(page.getByTestId('opening')).toHaveCount(0, { timeout: PARAMS.openingDurationMs + 3000 });
    await expect(page.getByTestId('launch-screen')).toBeVisible();
  });

  test('startup failure stays visible and retry shows the opening', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await setup(page, { motion: 'full', skipOpening: false });
    await page.route('**/device/state', (route) => route.fulfill({ status: 503, json: { error: 'deviceUnavailable' } }));
    await page.goto('/#/');
    await expect(page.getByTestId('device-startup-error')).toBeVisible();
    await expect(page.getByTestId('opening')).toHaveCount(0);
    await page.unroute('**/device/state');
    await page.getByRole('button', { name: /再読み込み|Reload/ }).click();
    await expect(page.getByTestId('opening')).toBeVisible();
    await page.getByRole('button', { name: /スキップ|Skip/ }).click();
    await expect(page.getByTestId('launch-screen')).toBeVisible();
  });

  test('reduced motion also stops Fluent UI motion (Web Animations), not only CSS animations', async ({ page }) => {
    const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, '/', { lang: 'en', motion: 'reduce' });
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await running()).toBe(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('motion-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await page.keyboard.press('Control+k');
    expect(await running()).toBeGreaterThan(0);
  });

  test('the in-app motion toggle overrides the OS and persists', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, '/', { motion: 'full', lang: 'en' });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await page.getByTestId('motion-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByTestId('motion-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  });

  test('sound starts muted; the mute toggle and settings persist', async ({ page }) => {
    await open(page, '/settings', { lang: 'en' });
    const toggle = page.getByTestId('sound-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('switch', { name: 'Background music' })).toBeDisabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('switch', { name: 'Background music' })).toBeEnabled();
    await page.reload();
    await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('startup splash visibility is a saved setting', async ({ page }) => {
    await open(page, '/settings', { lang: 'en' });
    const splashToggle = page.getByRole('switch', { name: 'Show the startup splash screen' });
    await expect(splashToggle).not.toBeChecked();
    await splashToggle.check();
    await expect(splashToggle).toBeChecked();

    let releasePack!: () => void;
    let markPackStarted!: () => void;
    const packReady = new Promise<void>((resolve) => { releasePack = resolve; });
    const packStarted = new Promise<void>((resolve) => { markPackStarted = resolve; });
    await page.route('**/data/pack.json', async (route) => { markPackStarted(); await packReady; await route.continue(); });
    await page.reload();
    await packStarted;
    await expect(page.getByTestId('startup-splash')).toBeVisible();
    releasePack();
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Show the startup splash screen' })).toBeChecked();

    await page.getByRole('switch', { name: 'Show the startup splash screen' }).uncheck();
    await page.reload();
    await expect(page.getByTestId('startup-splash')).toHaveCount(0);
    await expect(page.locator('main#main')).toBeVisible();
  });
});

test.describe('F-3.4.1 live feed', () => {
  test('shows update time, freshness and the simulation label; pause works', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    const feed = page.getByRole('region', { name: 'Live feed' });
    await expect(feed).toContainText('Simulation');
    await expect(feed).toContainText(/Updated \d{1,2}:\d{2}:\d{2}/);
    await expect(page.getByTestId('feed-freshness')).toHaveText('Fresh');
    await page.getByTestId('feed-pause').click();
    await expect(page.getByTestId('feed-freshness')).toHaveText('Paused');
    await page.getByTestId('feed-pause').click();
    await expect(page.getByTestId('feed-freshness')).toHaveText('Fresh');
  });

  test(`@perf agreed load: ${PARAMS.liveFeedLoadRatePerSec}/s for ${PARAMS.liveFeedLoadDurationMs / 1000}s keeps p95 latency ≤ ${PARAMS.liveFeedLatencyBudgetP95Ms} ms`, async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, '/', { lang: 'en' });
    await page.evaluate(() => (window as unknown as { __basFeed: { startLoad: () => void } }).__basFeed.startLoad());
    await page.waitForTimeout(PARAMS.liveFeedLoadDurationMs);
    const stats = await page.evaluate(() => (window as unknown as { __basFeed: { stats: () => { count: number; p50: number; p95: number; max: number } } }).__basFeed.stats());
    await page.evaluate(() => (window as unknown as { __basFeed: { stopLoad: () => void } }).__basFeed.stopLoad());
    test.info().annotations.push({ type: 'latency', description: JSON.stringify(stats) });
    console.log('live feed latency under load', JSON.stringify(stats));
    const expected = (PARAMS.liveFeedLoadRatePerSec * PARAMS.liveFeedLoadDurationMs) / 1000;
    expect(stats.count).toBeGreaterThanOrEqual(Math.floor(expected * 0.8));
    expect(stats.p95).toBeLessThanOrEqual(PARAMS.liveFeedLatencyBudgetP95Ms);
  });
});


