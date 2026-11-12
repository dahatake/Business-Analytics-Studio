import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, card, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TABS = ['twin', 'map', 'kpi', 'arch'] as const;

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const canvas = (page: Page) => page.getByTestId('td-canvas');
const viewport = (page: Page) => page.getByTestId('td-viewport');

test.describe('Contextual 2D / 3D views', () => {
  test('removes standalone navigation and switches overview KPIs without replacing the summary', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await expect(page.locator('.rail a[href="#/twin3d"]')).toHaveCount(0);
    await expect(page.getByTestId('kpi-panel')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    const control = page.getByTestId('td-viewswitch');
    await expect(control.getByRole('radio', { name: '2D', exact: true })).toBeChecked();
    await control.getByRole('radio', { name: '3D', exact: true }).check();
    await firstFrame(page);
    await expect(page.getByTestId('executive-summary')).toBeVisible();
    await expect(page.getByTestId('kpi-panel')).toBeHidden();
    await control.getByRole('radio', { name: '2D', exact: true }).check();
    await expect(page.getByTestId('kpi-panel')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
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

  test('twin and architecture are reachable from graph, also on a narrow screen', async ({ page }) => {
    await open(page, '/graph', { lang: 'en' });
    await page.getByRole('tab', { name: 'Digital twin', exact: true }).click();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await page.locator('[data-td-select="twin-m-1-3"]').click();
    const control = page.getByTestId('td-viewswitch');
    await control.getByRole('radio', { name: '2D', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(control.getByRole('radio', { name: '3D', exact: true })).toBeChecked();
    await firstFrame(page);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'twin-m-1-3');
    await page.setViewportSize({ width: 700, height: 900 });
    await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('architecture');
    await firstFrame(page);
    await expect(page.getByTestId('td-arch-switch')).toBeVisible();
    await page.getByRole('radio', { name: '2D', exact: true }).check();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await scan(page)).toEqual([]);
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

test.describe('/twin3d 3D views', () => {
  for (const tab of TABS) {
    test(`@perf FR-147 ${tab}: first frame within 1 s (PARAM-038)`, async ({ page }) => {
      await open(page, `/twin3d?tab=${tab}`, { lang: 'en' });
      const ms = await firstFrame(page);
      test.info().annotations.push({ type: 'first-frame-ms', description: `${tab} (page load): ${ms}` });
      expect(ms).toBeLessThanOrEqual(1000);
      // Opening the tab from another tab (no page load).
      await page.getByRole('tab', { name: 'Digital twin' }).click();
      await firstFrame(page);
      if (tab !== 'twin') {
        const t0 = Date.now();
        await page.getByTestId(`td-tab-${tab}`).click();
        await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
        const again = await firstFrame(page);
        test.info().annotations.push({ type: 'first-frame-ms', description: `${tab} (tab switch): ${again} (click→observed ${Date.now() - t0} ms)` });
        expect(again).toBeLessThanOrEqual(1000);
      }
      expect(Number(await canvas(page).getAttribute('data-frames'))).toBeGreaterThan(0);
      await expect(page.getByTestId('td-table')).toBeVisible();
    });
  }

  test('@perf FR-146 canvas follows its container within 1 px within 1 s after resize', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '/twin3d', { lang: 'en' });
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

  test('FR-146 a click on a known object position selects it (also after a resize)', async ({ page }) => {
    await open(page, '/twin3d?tab=kpi', { lang: 'en' });
    await firstFrame(page);
    let p = await project(page, 'kpi-kpi-otd');
    expect(p).not.toBeNull();
    await page.mouse.click(p!.x, p!.y);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'kpi-kpi-otd');
    await expect(page).toHaveURL(/sel=kpi-kpi-otd/);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('On-time delivery');

    await page.keyboard.press('Escape');
    await expect(card(page)).toBeHidden();
    await page.setViewportSize({ width: 960, height: 760 });
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(viewport(page)).toHaveAttribute('data-selected', '');
    p = await project(page, 'kpi-kpi-co2');
    await page.mouse.click(p!.x, p!.y);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'kpi-kpi-co2');
  });

  test('FR-021 picking a site on the 3D map opens its detail card', async ({ page }) => {
    await open(page, '/twin3d?tab=map', { lang: 'en' });
    await firstFrame(page);
    const p = await project(page, 'map-site-nagoya');
    expect(p).not.toBeNull();
    await page.mouse.click(p!.x, p!.y);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'map-site-nagoya');
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('Nagoya Plant');
    // Keyboard alternative: the table lists every site.
    await expect(page.locator('[data-td-select="map-site-sendai"]')).toBeVisible();
  });

  test('FR-217 the 2D/3D switch keeps the selection', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en' });
    await firstFrame(page);
    await page.locator('[data-td-select="twin-m-1-3"]').click();
    await expect(viewport(page)).toHaveAttribute('data-selected', 'twin-m-1-3');
    await expect(page.getByTestId('td-breadcrumb')).toContainText('Assembly');
    await page.getByRole('radio', { name: '2D' }).check();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await expect(page.locator('[data-td-id="twin-m-1-3"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-td-id="twin-m-2-1"]').click();
    await page.getByRole('radio', { name: '3D' }).check();
    await firstFrame(page);
    await expect(viewport(page)).toHaveAttribute('data-selected', 'twin-m-2-1');
    await expect(page).toHaveURL(/sel=twin-m-2-1/);
  });

  test('FR-031/034/036 LOD follows zoom while animation is stopped; hidden levels are not drawn', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en', motion: 'reduce' });
    await firstFrame(page);
    await expect(canvas(page)).toHaveAttribute('data-lod', '0');
    expect(await project(page, 'twin-m-1-1')).toBeNull();
    const renderedFar = Number(await canvas(page).getAttribute('data-rendered'));
    const d0 = (await page.evaluate(() => window.__basTd!.pose().distance));
    await viewport(page).focus();
    await page.keyboard.press('+');
    const d1 = (await page.evaluate(() => window.__basTd!.pose().distance));
    expect(d0 / d1).toBeCloseTo(1.25, 5);
    for (let i = 0; i < 6; i++) await page.keyboard.press('+');
    await expect(canvas(page)).toHaveAttribute('data-lod', '2');
    expect(await project(page, 'twin-m-1-1')).not.toBeNull();
    expect(Number(await canvas(page).getAttribute('data-rendered'))).toBeGreaterThan(renderedFar);
    await expect(page.getByTestId('td-status')).toContainText('LOD 2');
    const az0 = (await page.evaluate(() => window.__basTd!.pose().azimuth));
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => window.__basTd!.pose().azimuth)).toBeLessThan(az0);
    await page.keyboard.press('Home');
    await expect(canvas(page)).toHaveAttribute('data-lod', '0');
  });

  test('FR-023 reduced motion: selection moves the camera instantly, no animation loop', async ({ page }) => {
    await open(page, '/twin3d?tab=map', { lang: 'en', motion: 'reduce' });
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
    await open(page, '/twin3d?tab=map', { lang: 'en', motion: 'full' });
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

  test('FR-018 core object: reason shown and the core object can be changed', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en' });
    await firstFrame(page);
    await expect(page.getByTestId('td-core-reason')).toContainText('largest share of deal value');
    await page.getByTestId('td-core-select').selectOption('site-sendai');
    await expect(page).toHaveURL(/core=site-sendai/);
    await expect(page.getByTestId('td-breadcrumb')).toContainText('Sendai Plant');
    await expect(page.locator('[data-td-select="twin-p-prod-sensor"]')).toBeVisible();
  });

  test('FR-040 architecture AsIs/ToBe toggle', async ({ page }) => {
    await open(page, '/twin3d?tab=arch', { lang: 'en' });
    await firstFrame(page);
    await expect(page.getByTestId('td-table')).toContainText('Microsoft Fabric');
    await page.getByRole('radio', { name: 'AsIs (current)' }).check();
    await expect(page).toHaveURL(/arch=asis/);
    await expect(page.getByTestId('td-table')).not.toContainText('Microsoft Fabric');
    await expect(page.getByTestId('td-table')).toContainText('Spreadsheets and email');
    await firstFrame(page);
  });
});

test.describe('FR-065 WebGL unavailable', () => {
  test('falls back to 2D with a message on every tab', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    });
    await open(page, '/twin3d', { lang: 'en' });
    for (const tab of TABS) {
      await page.getByTestId(`td-tab-${tab}`).click();
      await expect(page.getByTestId('td-fallback')).toBeVisible();
      await expect(page.getByTestId('td-fallback')).toContainText('not available');
      await expect(page.getByTestId('td-2d')).toBeVisible();
      await expect(canvas(page)).toHaveCount(0);
      await expect(page.getByRole('radio', { name: '3D' })).toBeDisabled();
    }
    expect(await scan(page)).toEqual([]);
  });
});

test.describe('/twin3d accessibility and language', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const tab of TABS) {
      for (const mode of ['3d', '2d'] as const) {
        test(`axe ${lang} ${tab} ${mode}`, async ({ page }) => {
          await open(page, `/twin3d?tab=${tab}${mode === '2d' ? '&mode=2d' : ''}`, { lang });
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
  }
});
