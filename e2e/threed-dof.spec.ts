import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const canvas = (page: Page) => page.getByTestId('td-canvas');
const NAME = { ja: '被写界深度', en: 'Depth of field' } as const;
const dofSwitch = (page: Page, lang: Lang = 'en') => page.getByRole('switch', { name: NAME[lang] });

async function firstFrame(page: Page) {
  await expect(canvas(page)).toHaveAttribute('data-first-frame-ms', /^\d+$/, { timeout: 10_000 });
}

const frames = async (page: Page) => Number(await canvas(page).getAttribute('data-frames'));

/** Frames per second measured from the canvas frame counter over `ms`. */
async function measureFps(page: Page, ms = 1000) {
  const f0 = await frames(page);
  const t0 = Date.now();
  await page.waitForTimeout(ms);
  return ((await frames(page)) - f0) * 1000 / (Date.now() - t0);
}

test.describe('FR-067 depth of field', () => {
  test('off by default; available with High + cinematic effects + full motion', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en', motion: 'full' });
    await firstFrame(page);
    await expect(canvas(page)).toHaveAttribute('data-dof', 'off');
    await expect(dofSwitch(page)).not.toBeChecked();
    // Auto may already have lowered the preset on a slow host; choosing High makes the conditions explicit.
    await page.getByTestId('td-quality').selectOption('high');
    await expect(dofSwitch(page)).toBeEnabled();
    await expect(page.getByTestId('td-dof-reason')).toHaveCount(0);
    await expect(canvas(page)).toHaveAttribute('data-dof', 'off');
  });

  test('High + cinematic + toggle → DOF on and frames keep rendering (FPS measured)', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en', motion: 'full' });
    await firstFrame(page);
    // Manual High: the preset stays put, so the measurement compares DOF on/off at the same quality.
    await page.getByTestId('td-quality').selectOption('high');
    await page.waitForTimeout(800);
    const fpsOff = await measureFps(page);

    await dofSwitch(page).check();
    await expect(canvas(page)).toHaveAttribute('data-dof', 'on');
    const f0 = await frames(page);
    await page.waitForTimeout(150);
    const fpsOn = await measureFps(page);
    expect(await frames(page)).toBeGreaterThan(f0);
    test.info().annotations.push({ type: 'fps (headless SwiftShader)', description: `twin, High: DOF off ${fpsOff.toFixed(1)} fps, DOF on ${fpsOn.toFixed(1)} fps` });

    // Selecting an object keeps DOF on (focus follows the selection) and frames keep coming.
    await page.locator('[data-td-select="twin-m-1-3"]').click();
    const f1 = await frames(page);
    await page.waitForTimeout(300);
    expect(await frames(page)).toBeGreaterThan(f1);

    // Turning cinematic effects off removes DOF and disables the toggle with a reason.
    await page.getByRole('switch', { name: 'Cinematic effects' }).uncheck();
    await expect(canvas(page)).toHaveAttribute('data-dof', 'off');
    await expect(dofSwitch(page)).toBeDisabled();
    await expect(page.getByTestId('td-dof-reason')).toContainText('Cinematic effects');
  });

  test('the controller turns DOF off before lowering the preset (KPI-5)', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en', motion: 'full' });
    await firstFrame(page);
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="td-canvas"]')!;
      const log: string[] = [];
      (window as unknown as { __dofLog: string[] }).__dofLog = log;
      new MutationObserver(() => {
        // Third field: the "DOF was turned off automatically" note is already shown.
        const s = `${c.getAttribute('data-dof')}/${c.getAttribute('data-quality')}/${document.querySelector('[data-testid="td-dof-auto-off"]') ? 'noted' : '-'}`;
        if (log[log.length - 1] !== s) log.push(s);
      }).observe(c, { attributes: true, attributeFilter: ['data-dof', 'data-quality'] });
    });
    // Restart Auto at High (a slow host may already have lowered it), then turn DOF on right away.
    await page.getByTestId('td-quality').selectOption('high');
    await page.getByTestId('td-quality').selectOption('auto');
    await dofSwitch(page).check();
    // On a heavily loaded host the controller may give DOF up even before its chain has loaded.
    await expect(canvas(page).and(page.locator('[data-dof="on"]')).or(page.getByTestId('td-dof-auto-off'))).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    const fps = await measureFps(page, 1000);
    test.info().annotations.push({ type: 'fps (headless SwiftShader)', description: `twin, Auto (High) + DOF: ${fps.toFixed(1)} fps` });
    if (fps < 45) {
      await expect(canvas(page)).toHaveAttribute('data-dof', 'off', { timeout: 5000 });
      await expect(page.getByTestId('td-dof-auto-off')).toContainText('Depth of field was turned off');
      await expect(dofSwitch(page)).not.toBeChecked();
    }
    await page.waitForTimeout(500);
    const log = await page.evaluate(() => (window as unknown as { __dofLog: string[] }).__dofLog);
    // Never a lowered preset while DOF is drawn, and DOF was given up before the preset was first lowered.
    expect(log.filter((s) => s.startsWith('on/') && !s.startsWith('on/high/'))).toEqual([]);
    const firstLower = log.find((s) => !s.includes('/high/'));
    if (firstLower) expect(firstLower).toMatch(/\/noted$/);
    test.info().annotations.push({ type: 'dof/quality sequence', description: log.join(' → ') });
  });

  test('DOF keeps the 1 px size-follow guarantee', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '/twin3d', { lang: 'en', motion: 'full' });
    await firstFrame(page);
    await page.getByTestId('td-quality').selectOption('high');
    await dofSwitch(page).check();
    await expect(canvas(page)).toHaveAttribute('data-dof', 'on');
    for (const vp of [{ width: 900, height: 700 }, { width: 1500, height: 950 }]) {
      await page.setViewportSize(vp);
      const start = Date.now();
      await expect.poll(() => page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid="td-canvas"]')!;
        const v = document.querySelector<HTMLElement>('[data-testid="td-viewport"]')!;
        const cr = c.getBoundingClientRect();
        const pr = Number(c.dataset.pixelRatio);
        return Math.abs(cr.width - v.clientWidth) <= 1 && Math.abs(cr.height - v.clientHeight) <= 1
          && Math.abs(c.width - Math.floor(v.clientWidth * pr)) <= 1 && Math.abs(c.height - Math.floor(v.clientHeight * pr)) <= 1;
      }), { timeout: 1000, intervals: [50] }).toBe(true);
      test.info().annotations.push({ type: 'resize-ms (DOF on)', description: `${vp.width}x${vp.height}: ${Date.now() - start} (dof ${await canvas(page).getAttribute('data-dof')})` });
    }
  });

  test('reduced motion forces DOF off and explains why', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en', motion: 'reduce' });
    await firstFrame(page);
    await expect(canvas(page)).toHaveAttribute('data-dof', 'off');
    await expect(dofSwitch(page)).toBeDisabled();
    await expect(dofSwitch(page)).not.toBeChecked();
    await expect(page.getByTestId('td-dof-reason')).toContainText('reduced motion');
    await expect(dofSwitch(page)).toHaveAttribute('aria-describedby', /.+/);
  });

  test('Medium quality disables DOF with a reason; back to High re-enables it', async ({ page }) => {
    await open(page, '/twin3d', { lang: 'en', motion: 'full' });
    await firstFrame(page);
    await page.getByTestId('td-quality').selectOption('high');
    await dofSwitch(page).check();
    await expect(canvas(page)).toHaveAttribute('data-dof', 'on');
    await page.getByTestId('td-quality').selectOption('medium');
    await expect(canvas(page)).toHaveAttribute('data-dof', 'off');
    await expect(dofSwitch(page)).toBeDisabled();
    await expect(page.getByTestId('td-dof-reason')).toContainText('High');
    await page.getByTestId('td-quality').selectOption('high');
    await expect(dofSwitch(page)).toBeEnabled();
  });

  test('WebGL fallback is unaffected', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    });
    await open(page, '/twin3d', { lang: 'en', motion: 'full' });
    await expect(page.getByTestId('td-fallback')).toBeVisible();
    await expect(page.getByTestId('td-2d')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    await expect(dofSwitch(page)).toHaveCount(0);
    expect(await scan(page)).toEqual([]);
  });

  for (const lang of ['ja', 'en'] as Lang[]) {
    test(`axe ${lang}: DOF on, and DOF disabled with its reason`, async ({ page }) => {
      await open(page, '/twin3d', { lang, motion: 'full' });
      await firstFrame(page);
      await page.getByTestId('td-quality').selectOption('high');
      await dofSwitch(page, lang).check();
      await expect(canvas(page)).toHaveAttribute('data-dof', 'on');
      expect(await scan(page)).toEqual([]);
      await page.getByTestId('td-quality').selectOption('low');
      await expect(page.getByTestId('td-dof-reason')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') {
        const text = await visibleTextExcludingOtherLang(page, 'en');
        expect(text.split('\n').filter((l) => JAPANESE.test(l))).toEqual([]);
      }
    });
  }
});
