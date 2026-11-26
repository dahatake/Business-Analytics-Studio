import { expect, test } from '@playwright/test';
import { open, scan } from './helpers.ts';

test.describe('FR-380 business process', () => {
  test('the rail offers the business process and no relation graph or Twin', async ({ page }) => {
    await open(page, '/home');
    const rail = page.locator('.rail');
    await expect(rail.locator('a[href="#/process"]')).toContainText('業務プロセス');
    await expect(rail.locator('a[href="#/relations"], a[href="#/graph"], a[href="#/twin3d"]')).toHaveCount(0);
  });

  test('zooms from the bird\'s-eye phases to steps and details, with outside parties apart from the company', async ({ page }) => {
    await open(page, '/process', { lang: 'en' });
    const map = page.getByTestId('bp-map');
    await expect(map).toHaveAttribute('data-level', 'overview');
    await expect(map.locator('button[data-testid^="bp-phase-"]')).toHaveCount(5);
    await expect(page.getByTestId('bp-phase-phase-order-external')).toContainText('Outside');
    await expect(page.getByTestId('bp-phase-phase-order')).toContainText('Company');
    await expect(page.getByTestId('bp-lane-party-customer')).toContainText('Outside');
    await expect(page.getByTestId('bp-lane-party-sales')).toContainText('Company');

    await page.getByTestId('bp-phase-phase-plan').click();
    await expect(map).toHaveAttribute('data-level', 'steps');
    await expect(page).toHaveURL(/level=steps/);
    await page.getByTestId('bp-level-detail').click();
    await expect(page.getByTestId('bp-step-st-plan')).toContainText('First pass');

    // Keyboard alternative to the wheel: + and - on the focused map.
    await page.getByTestId('bp-level-steps').click();
    await page.getByTestId('bp-canvas').focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await expect(map).toHaveAttribute('data-level', 'detail');
    await page.keyboard.press('0');
    await expect(map).toHaveAttribute('data-level', 'overview');
  });

  test('hover and focus show the same summary card; Escape closes it', async ({ page }) => {
    await open(page, '/process?level=steps', { lang: 'en' });
    const step = page.getByTestId('bp-step-st-stock-check');
    // Focus pans a step hidden outside the canvas into view (WCAG 2.4.11), then the pointer can reach it.
    await step.focus();
    const card = page.getByTestId('bp-hovercard');
    await expect(card).toContainText('Check stock and free capacity');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await step.hover();
    await expect(card).toContainText('Hidden small workflows');
    await expect(card).toContainText('Excel');
    await page.mouse.move(2, 2);
    await expect(card).toHaveCount(0);
    await page.getByTestId('bp-step-st-plan').focus();
    await expect(card).toContainText('Inputs');
    await expect(page.getByTestId('bp-step-st-plan')).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  });

  test('to-be removes, combines and adds steps on the same map, and the totals compare both states', async ({ page }) => {
    await open(page, '/process?state=toBe&level=steps', { lang: 'en' });
    await expect(page.getByTestId('bp-step-st-order-confirm')).toHaveClass(/is-gone/);
    await expect(page.getByTestId('bp-step-st-stock-check')).toContainText('Combined into');
    await expect(page.getByTestId('bp-step-st-notify')).toContainText('New');
    // The removed check no longer sits between order entry and planning.
    await expect(page.getByTestId('bp-edge-st-order-entry-st-plan')).toHaveCount(1);
    await expect(page.getByTestId('bp-loop-loop-replan-daily')).toContainText('daily');
    await expect(page.getByTestId('bp-loop-loop-replan-weekly')).toHaveCount(0);

    await page.getByTestId('bp-state-asIs').click();
    await expect(page.getByTestId('bp-step-st-notify')).toHaveCount(0);
    await expect(page.getByTestId('bp-loop-loop-replan-weekly')).toContainText('weekly');

    await expect(page.getByTestId('bp-tile-lead')).toContainText('→');
    await expect(page.getByTestId('bp-tile-effort')).toContainText('FTE');
    await expect(page.getByTestId('bp-reconcile-kpi-lead-time-asIs')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('bp-reconcile-kpi-lead-time-toBe')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('bp-io-st-plan')).toContainText('Excel');
  });

  test('a step edited in step 2 is saved with the project, and the summary goes into the deliverable', async ({ page }) => {
    await open(page, '/process?state=toBe&level=steps&sel=st-ship', { lang: 'en' });
    await page.getByTestId('bp-edit-step').click();
    await page.getByTestId('bp-ed-change').selectOption('remove');
    await page.getByTestId('bp-ed-save').click();
    await expect(page.getByTestId('bp-origin-edited')).toBeVisible();
    await expect(page.getByTestId('bp-step-st-ship')).toHaveClass(/is-gone/);

    await page.getByTestId('bp-write-summary').click();
    await expect(page.getByTestId('bp-written')).toBeVisible();
    await page.getByTestId('bp-written').getByRole('link').click();
    await expect(page).toHaveURL(/#\/deliverables\?.*step=tobe/);
    await expect(page.locator('#dlv-field-toBeProcess, [id="dlv-field-toBeProcess"]').first()).toContainText('Remove');

    await page.goto('/#/process');
    await expect(page.getByTestId('bp-origin-edited')).toBeVisible();
    await page.getByTestId('bp-reset').click();
    await expect(page.getByTestId('bp-origin-edited')).toHaveCount(0);
  });

  for (const lang of ['ja', 'en'] as const) {
    test(`passes accessibility checks in every state (${lang})`, async ({ page }) => {
      for (const route of ['/process', '/process?state=toBe&level=steps', '/process?state=compare&level=detail&sel=st-plan', '/process?tab=table']) {
        await open(page, route, { lang });
        await expect(page.locator('main#main')).toBeVisible();
        expect(await scan(page, 'main')).toEqual([]);
      }
    });
  }
});
