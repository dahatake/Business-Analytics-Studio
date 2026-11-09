import { expect, test } from '@playwright/test';
import { JAPANESE, ROUTES, open, visibleTextExcludingOtherLang } from './helpers.ts';

test.describe('F-3.5.2 language toggle', () => {
  test('switches instantly without reloading and keeps the choice', async ({ page }) => {
    await open(page, '/', { lang: 'ja' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.getByRole('link', { name: '概要' })).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = 1; });
    const navigations: string[] = [];
    page.on('framenavigated', (f) => navigations.push(f.url()));

    await page.getByTestId('lang-toggle').getByRole('button', { name: 'English' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Executive overview');
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
    expect(navigations).toEqual([]);
    await expect(page.getByTestId('lang-toggle').getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
  });

  test('the toggle sits in the top bar on every screen', async ({ page }) => {
    for (const route of ['/', '/map', '/optimize', '/settings']) {
      await open(page, route);
      const box = await page.getByTestId('lang-toggle').boundingBox();
      expect(box!.y).toBeLessThan(60);
    }
  });
});

test.describe('F-3.5.1 no untranslated strings', () => {
  for (const route of ROUTES) {
    test(`English has no Japanese text on ${route}`, async ({ page }) => {
      await open(page, route, { lang: 'en' });
      await page.waitForTimeout(400);
      const text = await visibleTextExcludingOtherLang(page, 'en');
      const leaks = text.split('\n').filter((line) => JAPANESE.test(line));
      expect(leaks).toEqual([]);
    });
  }

  test('Japanese mode shows Japanese UI and data', async ({ page }) => {
    await open(page, '/directory?tab=customers', { lang: 'ja' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('データの一覧');
    await expect(page.getByRole('link', { name: '桜モーターズ' })).toBeVisible();
  });

  test('the optimization API answers in the selected language', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    await expect(page.getByTestId('optimize-message')).toContainText('Optimization saves');
    await page.getByTestId('lang-toggle').getByRole('button', { name: '日本語' }).click();
    await expect(page.getByTestId('optimize-message')).toContainText('最適化で');
    await expect(page.getByText(/ローカル API/)).toBeVisible();
  });
});
