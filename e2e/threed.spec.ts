import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, card, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The 3D views live embedded in the map screen and in the architecture section of the material flow (business process screen). */
const ROUTES = { map: '/map?mode=3d', arch: '/process?tab=material&section=architecture&mode=3d' } as const;
const ARCH_2D = '/process?tab=material&section=architecture';
const TABS = Object.keys(ROUTES) as (keyof typeof ROUTES)[];

async function scan(page: Page, scope?: string) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const builder = new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]');
  if (scope) builder.include(scope);
  const result = await builder.analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const canvas = (page: Page) => page.getByTestId('td-canvas');
const viewport = (page: Page) => page.getByTestId('td-viewport');

test.describe('Contextual 2D / 3D views', () => {
  test('the replacement strategic overview has no legacy KPI tower or standalone 3D navigation', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await expect(page.locator('.rail a[href="#/twin3d"]')).toHaveCount(0);
    await expect(page.locator('.rail a[href="#/graph"]')).toHaveCount(0);
    await expect(page.getByTestId('strategy-panel')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    await expect(page.getByTestId('td-viewswitch')).toHaveCount(0);
    await expect(page.getByTestId('executive-summary')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('map switching preserves the entity selection, filters and original 2D map', async ({ page }) => {
    await open(page, '/map?sel=site-nagoya&flows=0', { lang: 'en' });
    const map = page.getByTestId('map-panel');
    await expect(page.getByTestId('map-selection')).toContainText('Nagoya Plant');
    await page.getByRole('radio', { name: '3D', exact: true }).check();
    await firstFrame(page);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'map-site-nagoya');
    await expect(page).toHaveURL(/sel=site-nagoya/);
    await expect(page).toHaveURL(/flows=0/);
    await page.getByTestId('td-quality').selectOption('low');
    await page.locator('[data-td-select="map-site-sendai"]').click();
    await page.getByRole('radio', { name: '2D', exact: true }).check();
    await expect(map).toBeVisible();
    await expect(page.getByTestId('map-selection')).toContainText('Sendai Plant');
    await expect(map.getByRole('switch')).not.toBeChecked();
    await page.getByRole('radio', { name: '3D', exact: true }).check();
    await firstFrame(page);
    await expect(page.getByTestId('td-quality')).toHaveValue('low');
  });

  test('architecture is on flows, also on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await open(page, '/flows', { lang: 'en' });
    await expect(page.getByTestId('sankey-panel')).toBeVisible();
    await page.getByRole('tab', { name: 'Architecture', exact: true }).click();
    await expect(page.getByTestId('td-arch-switch')).toBeVisible();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await page.getByRole('radio', { name: 'AsIs (current)' }).check();
    await expect(page.getByTestId('td-table')).toContainText('Spreadsheets and email');
    await page.getByRole('radio', { name: 'ToBe (future)' }).check();
    await expect(page.getByTestId('td-table')).toContainText('Microsoft Fabric');
    const control = page.getByTestId('td-viewswitch');
    await control.getByRole('radio', { name: '2D', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(control.getByRole('radio', { name: '3D', exact: true })).toBeChecked();
    await firstFrame(page);
    await page.getByRole('radio', { name: '2D', exact: true }).check();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await page.getByTestId('flow-sections').getByRole('tab', { name: 'Flows', exact: true }).click();
    await expect(page.locator('.sankey-link')).toHaveCount(19);
    await page.getByRole('tab', { name: 'Architecture', exact: true }).click();
    expect(await scan(page)).toEqual([]);
    await page.emulateMedia({ forcedColors: 'active' });
    // Legacy app chrome has separate high-contrast findings; verify the changed control here.
    expect(await scan(page, '.contextual-scene > .view-switch')).toEqual([]);
  });

  test('relocated architecture explains the 2D fallback when WebGL is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof original;
    });
    await open(page, '/process?tab=material&section=architecture&mode=3d', { lang: 'en' });
    await expect(page.getByRole('radio', { name: '3D', exact: true })).toBeDisabled();
    await expect(page.getByRole('radio', { name: '2D', exact: true })).toBeChecked();
    await expect(page.getByText('3D (WebGL) is not available in this environment, so the 2D view is shown.')).toBeVisible();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await page.getByRole('radio', { name: 'AsIs (current)' }).check();
    await expect(page.getByTestId('td-table')).toContainText('Spreadsheets and email');
    expect(await scan(page, '.contextual-scene')).toEqual([]);
  });

  test('unavailable WebGL returns to the native map with an explained disabled 3D option', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof original;
    });
    await open(page, '/map?mode=3d&sel=site-nagoya', { lang: 'en' });
    await expect(page.getByRole('radio', { name: '3D', exact: true })).toBeDisabled();
    await expect(page.getByRole('radio', { name: '2D', exact: true })).toBeChecked();
    await expect(page.getByTestId('map-selection')).toContainText('Nagoya Plant');
    await expect(page.getByText('3D (WebGL) is not available in this environment, so the 2D view is shown.')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('renderer initialization failure restores the native map and explains the disabled 3D option', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (this.dataset.testid === 'td-canvas' && /webgl/i.test(type)) return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof original;
    });
    await open(page, '/map?mode=3d&sel=site-nagoya', { lang: 'en' });
    const option = page.getByRole('radio', { name: '3D', exact: true });
    await expect(option).toBeDisabled();
    await expect(option).toHaveAccessibleDescription('3D rendering could not start, so the 2D view is shown.');
    await expect(page.getByRole('radio', { name: '2D', exact: true })).toBeChecked();
    await expect(page.getByTestId('map-selection')).toContainText('Nagoya Plant');
    await expect(canvas(page)).toHaveCount(0);
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await scan(page, '.contextual-scene > .view-switch')).toEqual([]);
  });
});

async function firstFrame(page: Page): Promise<number> {
  await expect(canvas(page)).toHaveAttribute('data-first-frame-ms', /^\d+$/, { timeout: 10_000 });
  return Number(await canvas(page).getAttribute('data-first-frame-ms'));
}

async function project(page: Page, id: string) {
  await viewport(page).scrollIntoViewIfNeeded();
  return page.evaluate((id) => window.__basTd?.project(id) ?? null, id);
}

async function sizes(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="td-canvas"]')!;
    const v = document.querySelector<HTMLElement>('[data-testid="td-viewport"]')!;
    const cr = c.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    return { cw: cr.width, ch: cr.height, vw: v.clientWidth, vh: v.clientHeight, vrw: vr.width, bw: c.width, bh: c.height, pr: Number(c.dataset.pixelRatio) };
  });
}

test.describe('Embedded 3D views', () => {
  for (const tab of TABS) {
    test(`@perf FR-147 ${tab}: first frame within 1 s (PARAM-038)`, async ({ page }) => {
      await open(page, ROUTES[tab], { lang: 'en' });
      const ms = await firstFrame(page);
      test.info().annotations.push({ type: 'first-frame-ms', description: `${tab} (page load): ${ms}` });
      expect(ms).toBeLessThanOrEqual(1000);
      expect(Number(await canvas(page).getAttribute('data-frames'))).toBeGreaterThan(0);
      await expect(page.getByTestId('td-table')).toBeVisible();
    });
  }

  test('@perf FR-146 canvas follows its container within 1 px within 1 s after resize', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, ROUTES.map, { lang: 'en' });
    await firstFrame(page);
    for (const vp of [{ width: 1280, height: 800 }, { width: 900, height: 700 }, { width: 1600, height: 1000 }, { width: 700, height: 900 }]) {
      await page.setViewportSize(vp);
      const start = Date.now();
      await expect.poll(async () => {
        const s = await sizes(page);
        return Math.abs(s.cw - s.vw) <= 1 && Math.abs(s.ch - s.vh) <= 1
          && Math.abs(s.bw - Math.floor(s.vw * s.pr)) <= 1 && Math.abs(s.bh - Math.floor(s.vh * s.pr)) <= 1;
      }, { timeout: 1000, intervals: [50] }).toBe(true);
      test.info().annotations.push({ type: 'resize-ms', description: `${vp.width}x${vp.height}: ${Date.now() - start}` });
    }
  });

  test('FR-021/146 a click on a known site position selects it and opens its card (also after a resize)', async ({ page }) => {
    await open(page, ROUTES.map, { lang: 'en' });
    await firstFrame(page);
    let p = await project(page, 'map-site-nagoya');
    expect(p).not.toBeNull();
    await page.mouse.click(p!.x, p!.y);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'map-site-nagoya');
    await expect(page).toHaveURL(/sel=site-nagoya/);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('Nagoya Plant');
    // Keyboard alternative: the table lists every site.
    await expect(page.locator('[data-td-select="map-site-sendai"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(card(page)).toBeHidden();
    await page.setViewportSize({ width: 960, height: 760 });
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(viewport(page)).toHaveAttribute('data-selected', '');
    p = await project(page, 'map-site-sendai');
    await page.mouse.click(p!.x, p!.y);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'map-site-sendai');
  });

  test('FR-217 the 2D/3D switch keeps the selection', async ({ page }) => {
    await open(page, ROUTES.arch, { lang: 'en' });
    await firstFrame(page);
    await page.locator('[data-td-select="arch-layer-data"]').click();
    await expect(viewport(page)).toHaveAttribute('data-selected', 'arch-layer-data');
    await expect(page.getByTestId('td-breadcrumb')).toContainText('Data');
    await page.getByRole('radio', { name: '2D', exact: true }).check();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await expect(page.locator('[data-td-id="arch-layer-data"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-td-id="arch-layer-process"]').press('Enter');
    await page.getByRole('radio', { name: '3D', exact: true }).check();
    await firstFrame(page);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'arch-layer-process');
    await expect(page).toHaveURL(/sel=arch-layer-process/);
  });

  test('FR-031/034/036 LOD follows zoom while animation is stopped; hidden levels are not drawn', async ({ page }) => {
    await open(page, ROUTES.map, { lang: 'en', motion: 'reduce' });
    await firstFrame(page);
    await expect(canvas(page)).toHaveAttribute('data-lod', '0');
    expect(await project(page, 'map-prod-gearbox')).toBeNull();
    const renderedFar = Number(await canvas(page).getAttribute('data-rendered'));
    const d0 = (await page.evaluate(() => window.__basTd!.pose().distance));
    await viewport(page).focus();
    await page.keyboard.press('+');
    const d1 = (await page.evaluate(() => window.__basTd!.pose().distance));
    expect(d0 / d1).toBeCloseTo(1.25, 5);
    for (let i = 0; i < 6; i++) await page.keyboard.press('+');
    await expect(canvas(page)).toHaveAttribute('data-lod', '2');
    // The deeper level is drawn now (the map also culls sites that leave the frame, so the total count may fall).
    expect(await project(page, 'map-prod-gearbox')).not.toBeNull();
    expect(Number(await canvas(page).getAttribute('data-rendered'))).toBeGreaterThan(0);
    expect(renderedFar).toBeGreaterThan(0);
    await expect(page.getByTestId('td-status')).toContainText('LOD 2');
    const az0 = (await page.evaluate(() => window.__basTd!.pose().azimuth));
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => window.__basTd!.pose().azimuth)).toBeLessThan(az0);
    await page.keyboard.press('Home');
    await expect(canvas(page)).toHaveAttribute('data-lod', '0');
  });

  test('FR-023 reduced motion: selection moves the camera instantly, no animation loop', async ({ page }) => {
    await open(page, ROUTES.map, { lang: 'en', motion: 'reduce' });
    await firstFrame(page);
    await page.locator('[data-td-select="map-site-sendai"]').click();
    await expect(viewport(page)).toHaveAttribute('data-selected', 'map-site-sendai');
    await expect(canvas(page)).toHaveAttribute('data-fly-ms', '0');
    await expect(canvas(page)).toHaveAttribute('data-animated-flights', '0');
    const f0 = Number(await canvas(page).getAttribute('data-frames'));
    await page.waitForTimeout(700);
    expect(Number(await canvas(page).getAttribute('data-frames'))).toBe(f0);
  });

  test('FR-023 full motion: selection flies the camera', async ({ page }) => {
    await open(page, ROUTES.map, { lang: 'en', motion: 'full' });
    await firstFrame(page);
    await page.locator('[data-td-select="map-site-sendai"]').click();
    await expect(canvas(page)).toHaveAttribute('data-animated-flights', '1');
    expect(Number(await canvas(page).getAttribute('data-fly-ms'))).toBeGreaterThanOrEqual(700);
    const f0 = Number(await canvas(page).getAttribute('data-frames'));
    await page.waitForTimeout(500);
    const f1 = Number(await canvas(page).getAttribute('data-frames'));
    expect(f1).toBeGreaterThan(f0);
    test.info().annotations.push({ type: 'fps', description: `map, full motion: ${await canvas(page).getAttribute('data-fps')} fps, quality ${await canvas(page).getAttribute('data-quality')}` });
  });

  test('FR-040 architecture AsIs/ToBe toggle', async ({ page }) => {
    await open(page, ROUTES.arch, { lang: 'en' });
    await firstFrame(page);
    await expect(page.getByTestId('td-table')).toContainText('Microsoft Fabric');
    await page.getByRole('radio', { name: 'AsIs (current)' }).check();
    await expect(page).toHaveURL(/arch=asis/);
    await expect(page.getByTestId('td-table')).not.toContainText('Microsoft Fabric');
    await expect(page.getByTestId('td-table')).toContainText('Spreadsheets and email');
    await firstFrame(page);
  });
});

test.describe('Embedded 3D views: accessibility and language', () => {
  const cases = [['map', '3d', ROUTES.map], ['arch', '3d', ROUTES.arch], ['arch', '2d', ARCH_2D]] as const;
  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const [tab, mode, route] of cases) {
      test(`axe ${lang} ${tab} ${mode}`, async ({ page }) => {
        await open(page, route, { lang });
        if (mode === '3d') await firstFrame(page);
        else await expect(page.getByTestId('td-2d')).toBeVisible();
        await page.waitForTimeout(300);
        expect(await scan(page)).toEqual([]);
        if (lang === 'en') {
          const text = await visibleTextExcludingOtherLang(page, 'en');
          const leaked = text.split('\n').filter((l) => JAPANESE.test(l));
          expect(leaked).toEqual([]);
        }
      });
    }
  }
});
