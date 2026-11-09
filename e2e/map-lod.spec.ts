import { expect, test } from '@playwright/test';
import { open } from './helpers.ts';

// The hiding rule itself (overlap by priority, hysteresis) is unit-tested in tests/mapLabels.test.ts. The sample sites
// do not overlap at the fitted zoom, so here every label must be visible and stay visible while zooming.
test.describe('FR-035 map label LOD', () => {
  test('sample labels do not overlap, so all are shown at every zoom; names stay accessible', async ({ page }) => {
    await open(page, '/map', { lang: 'en' });
    const labels = page.locator('.geo-map [data-label-for]');
    await expect(labels).toHaveCount(6);
    const boxes = await labels.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        expect(a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b, `labels ${i} and ${j} overlap`).toBe(false);
      }
    }
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(labels).toHaveCount(6);
    await expect(page.locator('.geo-map [data-entity-ref="site-yokohama-dc"]')).toHaveAttribute('aria-label', /Yokohama Distribution Center/);
  });

  test('the selected site always shows its label', async ({ page }) => {
    await open(page, '/map?sel=site-yokohama-dc', { lang: 'en' });
    await expect(page.locator('.geo-map [data-label-for="site-yokohama-dc"]')).toBeVisible();
  });
});
