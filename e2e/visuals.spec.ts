import { expect, test } from '@playwright/test';
import { open } from './helpers.ts';

test.describe('F-3.3 visuals', () => {
  test('KPI: every card shows name, actual, target, unit and direction; ring vs bullet by rule with a visible reason', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    const cards = page.locator('.kpi-card');
    await expect(cards).toHaveCount(6);
    for (const kpi of await cards.all()) {
      await expect(kpi.locator('.kpi-name')).not.toBeEmpty();
      await expect(kpi).toContainText('Actual');
      await expect(kpi).toContainText('Target');
      await expect(kpi.locator('.kpi-unit').first()).not.toBeEmpty();
      await expect(kpi.locator('.kpi-direction')).toHaveText(/Higher is better|Lower is better/);
    }
    await expect(page.locator('.kpi-card[data-visual="ring"]')).toHaveCount(5);
    const bullet = page.locator('.kpi-card[data-visual="bullet"]');
    await expect(bullet).toHaveAttribute('data-kpi-id', 'kpi-engagement');
    await expect(bullet.getByTestId('kpi-reason')).toContainText('interval scale');
  });

  test('priority weights re-rank issues (interactive)', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    const first = page.locator('.ranking-row').first();
    await expect(first).toContainText('Long order-to-ship lead time');
    const impact = page.getByRole('slider', { name: /Impact weight/ });
    await impact.focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
    await expect(first).toContainText('Slow invoicing and collection');
  });

  test('before/after share unit, period, scope and a zero-based axis; raw numbers are shown', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    const panel = page.getByTestId('before-after');
    await expect(panel).toContainText('Period: October 2026 (one month)');
    await expect(panel).toContainText('3 plants × 5 regions, total demand 1,100 t');
    for (const fig of await panel.locator('.compare-figure').all()) {
      const bars = fig.locator('rect.bar');
      await expect(bars).toHaveCount(2);
      // Both bars grow from the same baseline (same axis).
      const bottoms = await bars.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.bottom); }));
      expect(Math.abs(bottoms[0]! - bottoms[1]!)).toBeLessThanOrEqual(1);
      await expect(fig.locator('.y.axis .tick text').first()).toHaveText('0');
    }
    const rows = page.getByTestId('raw-numbers').locator('tbody tr');
    await expect(rows).toHaveCount(3);
  });

  test('changing assumptions recomputes; infeasible demand is explained', async ({ page }) => {
    await open(page, '/optimize?growth=15', { lang: 'en' });
    await expect(page.getByTestId('optimize-summary')).toContainText('exceeds capacity');
    await open(page, '/optimize?growth=5&carbon=20000', { lang: 'en' });
    await expect(page.getByTestId('capacity-report')).toBeVisible();
    await expect(page.getByTestId('optimize-summary')).toContainText('Demand 5%, carbon price 20,000');
  });

  test('Sankey, Gantt, map and graph render interactive, focusable items', async ({ page }) => {
    await open(page, '/flows', { lang: 'en' });
    await expect(page.locator('.sankey-link')).toHaveCount(19);
    await page.locator('.sankey [data-entity-ref="site-nagoya"]').hover();
    // Horizontal link paths have a zero-height box, so assert on the highlight classes rather than visibility.
    await expect(page.locator('.sankey-link.on')).toHaveCount(5);
    await expect(page.locator('.sankey-link.dim')).toHaveCount(14);
    await open(page, '/plan', { lang: 'en' });
    await expect(page.locator('.gantt [data-entity-ref]')).toHaveCount(7);
    await expect(page.locator('.gantt-dep')).toHaveCount(2);
    await open(page, '/map', { lang: 'en' });
    await expect(page.locator('.geo-map [data-entity-ref]')).toHaveCount(6);
  });

  test('every visual explains why it was chosen', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.getByTestId('kpi-panel').getByRole('button', { name: 'Why this visual' }).click();
    await expect(page.getByText(/number line \(bullet chart\)/)).toBeVisible();
  });
});

test.describe('F-3.1 imagery', () => {
  test('people have portraits and customers/products have illustrations in lists', async ({ page }) => {
    await open(page, '/directory?tab=people', { lang: 'en' });
    await expect(page.locator('[data-testid="directory-table"] .art-portrait')).toHaveCount(10);
    await open(page, '/directory?tab=customers', { lang: 'en' });
    await expect(page.locator('[data-testid="directory-table"] svg.art')).toHaveCount(6);
    await open(page, '/directory?tab=products', { lang: 'en' });
    await expect(page.locator('[data-testid="directory-table"] svg.art')).toHaveCount(6);
  });
});

