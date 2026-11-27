import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PARAMS } from '../src/config/params.ts';
import { open, scan, seedDeviceData, setup } from './helpers.ts';

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

test.describe('F-3.4.1 expected business outcomes', () => {
  test('shows source-backed outcomes, detailed hover content, and all KPI/OKR results as an inline card row (FR-337)', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    const outcomes = page.getByRole('region', { name: 'Expected business impact' });
    await expect(outcomes.getByTestId('outcome-preview')).toContainText(/annual benefit stated in pack/i);
    await outcomes.getByTestId('outcome-preview').hover();
    await expect(page.getByRole('tooltip')).toContainText('not a simulation result or an actual result');

    const toggle = outcomes.getByTestId('outcomes-expand');
    const strip = page.getByTestId('outcomes-strip');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(strip).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(strip).toBeVisible();
    await expect(strip.getByTestId('outcome-kpi-kpi-lead-time')).toContainText('No forecast');
    await expect(strip.getByTestId('outcome-okr-okr-demo-delivery')).toBeAttached();
    // One horizontal row inside the window, like the ToDo band.
    const boxes = await strip.locator('.outcome-strip-list > li').evaluateAll((items) => items.map((li) => li.getBoundingClientRect().top));
    expect(boxes.length).toBeGreaterThan(1);
    expect(new Set(boxes.map((top) => Math.round(top))).size).toBe(1);
    const stripBox = (await strip.boundingBox())!;
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    const violations = (await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
      .include('[data-testid="outcomes-strip"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    expect(violations.map((v) => v.id)).toEqual([]);
    await toggle.click();
    await expect(strip).toBeHidden();
    await toggle.click();

    await seedDeviceData(page, {
      'bas.scope.demo.proj.strategy': JSON.stringify({
        types: {},
        contributions: [{
          id: 'outcome-e2e-contribution',
          solutionId: 'sol-demand-planning',
          kpiId: 'kpi-lead-time',
          lever: 'pilot volume',
          leverUnit: 'units',
          amount: { low: 10, mode: 10, high: 10 },
          effectPerUnit: { low: 0.1, mode: 0.1, high: 0.1 },
          rampStart: '2026-01-01',
          fullEffect: '2026-11-01',
          basis: 'measured',
          evidence: 'pilot report',
        }],
        sections: {},
      }),
    });
    await page.reload();
    const forecast = page.getByTestId('business-outcomes').getByTestId('outcome-preview');
    await expect(forecast).toContainText('P50');
    await forecast.hover();
    await expect(page.getByRole('tooltip')).toContainText('pilot report');
    // The open state is remembered across reloads.
    await expect(page.getByTestId('outcomes-expand')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('outcomes-strip').getByTestId('outcome-kpi-kpi-lead-time')).toContainText('Forecast available');
  });

  test('FR-382: compact summary cards pop up their related information and open the outcome in Step 2 with the simulation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, '/', { lang: 'en' });
    const nav = page.getByRole('navigation', { name: 'Main screens' });
    await expect(nav.getByRole('link', { name: 'Simulation' })).toHaveCount(0);
    await page.getByTestId('outcomes-expand').click();
    const strip = page.getByTestId('outcomes-strip');
    await expect(strip).toBeVisible();
    // The unfolded row is a strip of summaries, not a page of details (it used to be ~700 px tall).
    await expect.poll(async () => (await strip.boundingBox())!.height).toBeLessThanOrEqual(240);
    const card = strip.getByTestId('outcome-kpi-kpi-lead-time');
    await expect(card).toContainText('No forecast');
    await expect(card).not.toContainText('Sources');

    await card.hover();
    const popup = page.getByRole('tooltip').filter({ has: page.getByTestId('outcome-popup-kpi-kpi-lead-time') });
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('Sources');
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    // Keyboard focus shows the same popup (WCAG 1.4.13).
    await card.focus();
    await expect(popup).toBeVisible();

    await card.click();
    await expect(page).toHaveURL(/#\/step\?.*step=tobe.*view=outcomes.*outcome=kpi-kpi-lead-time/);
    await expect(page.getByTestId('step-dash')).toHaveAttribute('data-view', 'outcomes');
    await expect(page.getByTestId('step-dash-view-outcomes')).toHaveAttribute('aria-selected', 'true');
    const detail = page.getByTestId('outcome-detail');
    await expect(detail).toHaveAttribute('data-outcome', 'kpi-kpi-lead-time');
    await expect(page.getByTestId('outcome-ws-kpi-kpi-lead-time')).toHaveAttribute('aria-current', 'true');
    // The bar and Step 2 tell the same story about the same outcome.
    await expect(page.getByTestId('outcome-ws-kpi-kpi-lead-time-headline')).toHaveText(await strip.getByTestId('outcome-kpi-kpi-lead-time-headline').textContent() ?? '');
    await expect(page.getByTestId('simulation-workbench')).toBeVisible();
    await expect(page.getByTestId('sim-tab-kpi')).toHaveAttribute('aria-current', 'page');

    // Editing the KPI here updates the outcome everywhere.
    await detail.getByTestId('outcome-kpi-target').fill('3');
    await detail.getByTestId('outcome-kpi-save').click();
    await expect(detail.getByRole('status')).toContainText('Saved');
    await expect(page.getByTestId('outcome-ws-kpi-kpi-lead-time-headline')).toContainText('target 3');
    await expect(strip.getByTestId('outcome-kpi-kpi-lead-time-headline')).toContainText('target 3');
    expect(await scan(page)).toEqual([]);

    // Old simulation links still work.
    await page.goto('/#/optimize?tab=solutions');
    await expect(page).toHaveURL(/#\/step\?.*view=outcomes.*sim=solutions/);
    await expect(page.getByTestId('simulation-workbench')).toBeVisible();
  });

  test(`@perf agreed load: ${PARAMS.liveFeedLoadRatePerSec}/s for ${PARAMS.liveFeedLoadDurationMs / 1000}s keeps p95 latency ≤ ${PARAMS.liveFeedLatencyBudgetP95Ms} ms`, async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, '/', { lang: 'en' });
    await page.evaluate(() => (window as unknown as { __basFeed: { startLoad: () => void } }).__basFeed.startLoad());
    await page.waitForTimeout(PARAMS.liveFeedLoadDurationMs);
    const stats = await page.evaluate(() => (window as unknown as { __basFeed: { stats: () => { count: number; p50: number; p95: number; max: number } } }).__basFeed.stats());
    await page.evaluate(() => (window as unknown as { __basFeed: { stopLoad: () => void } }).__basFeed.stopLoad());
    test.info().annotations.push({ type: 'latency', description: JSON.stringify(stats) });
    console.log('feed render latency under load', JSON.stringify(stats));
    const expected = (PARAMS.liveFeedLoadRatePerSec * PARAMS.liveFeedLoadDurationMs) / 1000;
    expect(stats.count).toBeGreaterThanOrEqual(Math.floor(expected * 0.8));
    expect(stats.p95).toBeLessThanOrEqual(PARAMS.liveFeedLatencyBudgetP95Ms);
  });
});


