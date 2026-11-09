import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ROUTES, card, open, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: import('@playwright/test').Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

test.describe('Accessibility (axe, WCAG 2.2 AA)', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const route of ROUTES) {
      test(`${lang} ${route}`, async ({ page }) => {
        await open(page, route, { lang });
        await page.waitForTimeout(500);
        expect(await scan(page)).toEqual([]);
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

