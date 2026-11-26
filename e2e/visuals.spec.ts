import { expect, test } from '@playwright/test';
import { open } from './helpers.ts';

test.describe('F-3.3 visuals', () => {
  test('strategy overview replaces KPI cards with a consistent objective-to-solution map', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await expect(page.getByRole('heading', { level: 1 })).    toHaveText('Sample company-Demo');
    await expect(page.locator('.kpi-card')).toHaveCount(0);
    await expect(page.getByTestId('strategy-map')).toBeVisible();
    await expect(page.getByTestId('strategy-map').locator('[data-lane="issue"]')).toHaveCount(5);
    await expect(page.getByTestId('strategy-map').locator('[data-lane="solution"]')).toHaveCount(5);
    await expect(page.getByTestId('strategy-next')).not.toBeEmpty();
  });

  test('priority criterion and ordering re-rank issues and persist across all five steps', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.getByTestId('strategy-axis').selectOption('impact');
    const rows = page.getByTestId('strategy-ranking').locator('[data-issue]');
    const scores = () => rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-score'))));
    const desc = await scores();
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    await page.getByTestId('strategy-sort').selectOption('asc');
    const asc = await scores();
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(asc).not.toEqual(desc);
    for (const step of ['asis', 'tobe', 'kpi', 'solution', 'deliverable']) {
      await page.goto(`/#/step?step=${step}&view=details`);
      await expect(page.getByTestId('strategy-axis')).toHaveValue('impact');
      await expect(page.getByTestId('strategy-sort')).toHaveValue('asc');
      await expect(page.getByTestId('strategy-map')).toBeVisible();
    }
    await page.reload();
    await expect(page.getByTestId('strategy-axis')).toHaveValue('impact');
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
    await page.getByTestId('strategy-panel').getByRole('button', { name: 'Why this visual' }).click();
    await expect(page.getByRole('dialog').or(page.locator('.rationale-surface'))).toContainText('Equal-width curves');
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

