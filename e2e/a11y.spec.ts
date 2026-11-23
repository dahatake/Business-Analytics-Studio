import { expect, test } from '@playwright/test';
import { JAPANESE, ROUTES, cspViolations, card, open, scan, visibleTextExcludingOtherLang, watchViolations, type Lang } from './helpers.ts';

test.describe('Accessibility (axe, WCAG 2.2 AA)', () => {
  // One page load per route and language covers axe, the English-only-text check (F-3.5.1) and CSP violations (D-5).
  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const route of ROUTES) {
      test(`${lang} ${route}`, async ({ page }) => {
        await watchViolations(page);
        await open(page, route, { lang });
        await page.waitForTimeout(500);
        expect(await scan(page)).toEqual([]);
        expect(await cspViolations(page)).toEqual([]);
        if (lang === 'en') {
          const text = await visibleTextExcludingOtherLang(page, 'en');
          expect(text.split('\n').filter((line) => JAPANESE.test(line))).toEqual([]);
        }
      });
    }
  }

  test('with a detail card open', async ({ page }) => {
    await open(page, '/directory?tab=deals', { lang: 'en' });
    await page.locator('main [data-entity-ref="deal-sakura-ev"]').first().focus();
    await expect(card(page)).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('light theme', async ({ page }) => {
    await open(page, '/settings', { lang: 'en' });
    await page.getByRole('radio', { name: 'Light' }).check();
    for (const route of ['/', '/optimize', '/directory?tab=deals']) {
      await page.goto(`/#${route}`);
      await page.waitForTimeout(500);
      expect(await scan(page), route).toEqual([]);
    }
  });
});

