import { expect, test } from '@playwright/test';
import { card, open } from './helpers.ts';

// Runs in the "touch" project (Pixel 7 emulation: hasTouch + isMobile).
test.describe('F-3.2.1 / F-3.2.2 touch', () => {
  test('tapping a reference opens its card instead of navigating; the card offers Open', async ({ page }) => {
    await open(page, '/directory?tab=customers', { lang: 'en' });
    await page.locator('main [data-entity-ref="cust-umi-foods"]').first().tap();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-via', 'touch');
    await expect(page).toHaveURL(/#\/directory/);
    await card(page).getByRole('button', { name: 'Open' }).tap();
    await expect(page).toHaveURL(/#\/entity\/cust-umi-foods/);
  });

  test('tapping a map site opens the same card', async ({ page }) => {
    await open(page, '/map', { lang: 'en' });
    await page.locator('.geo-map [data-entity-ref="site-sendai"]').tap();
    await expect(card(page)).toHaveAttribute('data-entity-id', 'site-sendai');
  });

  test('tapping outside dismisses the card', async ({ page }) => {
    await open(page, '/directory?tab=people', { lang: 'en' });
    await page.locator('main [data-entity-ref="person-sato-yui"]').first().tap();
    await expect(card(page)).toBeVisible();
    await page.locator('h1').tap();
    await expect(card(page)).toHaveCount(0);
  });

  test('layout reflows without horizontal page scroll at 320 CSS px (PARAM-029)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    for (const route of ['/', '/directory', '/optimize', '/settings']) {
      await open(page, route, { lang: 'en' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, route).toBeLessThanOrEqual(1);
    }
  });
});
