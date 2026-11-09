import { expect, test } from '@playwright/test';
import { PARAMS } from '../src/config/params.ts';
import { card, open } from './helpers.ts';

test.describe('F-3.2.1 detail cards', () => {
  test('hover opens after a delay, the card is hoverable, and leaving closes it', async ({ page }) => {
    await open(page, '/directory?tab=people', { lang: 'en' });
    const ref = page.locator('main [data-entity-ref="person-ito-mariko"]').first();
    await ref.hover();
    await expect(card(page)).toHaveCount(0);
    await page.waitForTimeout(PARAMS.cardOpenDelayMs + 150);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-entity-id', 'person-ito-mariko');
    await expect(card(page)).toContainText('Head of Quality Assurance');
    await expect(ref).toHaveAttribute('aria-expanded', 'true');

    // Move onto the card: it must stay open (WCAG 1.4.13 hoverable).
    const box = (await card(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 5 });
    await page.waitForTimeout(PARAMS.cardCloseDelayMs + 200);
    await expect(card(page)).toBeVisible();

    await page.mouse.move(5, 600);
    await page.waitForTimeout(PARAMS.cardCloseDelayMs + 200);
    await expect(card(page)).toHaveCount(0);
  });

  test('keyboard focus opens, Escape dismisses and keeps focus on the trigger', async ({ page }) => {
    await open(page, '/directory?tab=customers', { lang: 'en' });
    await page.locator('#dir-filter').focus();
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      await page.keyboard.press('Tab');
      found = await page.evaluate(() => document.activeElement?.getAttribute('data-entity-ref') === 'cust-sakura-motors');
    }
    expect(found).toBe(true);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-via', 'focus');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-entity-ref'))).toBe('cust-sakura-motors');
  });

  test('inputs, checkboxes and sliders never open a card', async ({ page }) => {
    await open(page, '/directory?tab=people', { lang: 'en' });
    await page.locator('#dir-search').focus();
    await page.locator('#dir-search').fill('Ito');
    await page.getByRole('checkbox').first().focus();
    await page.getByRole('checkbox').first().hover();
    await page.waitForTimeout(PARAMS.cardOpenDelayMs + 200);
    await expect(card(page)).toHaveCount(0);
  });

  test('external audience: confidential values are hidden in cards and lists', async ({ page }) => {
    await open(page, '/directory?tab=deals', { lang: 'en', audience: 'external' });
    await expect(page.getByTestId('directory-panel')).toContainText('1 confidential item(s) hidden');
    await expect(page.locator('main [data-entity-ref="deal-tsubasa-cobot"]')).toHaveCount(0);
    await expect(page.getByTestId('directory-table')).not.toContainText('¥186M');
    await page.locator('main [data-entity-ref="deal-sakura-ev"]').first().hover();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('confidential value(s) hidden');
    await expect(card(page)).not.toContainText('¥186M');
  });

  test('internal audience shows the same values', async ({ page }) => {
    await open(page, '/directory?tab=deals', { lang: 'en', audience: 'internal' });
    await expect(page.getByTestId('directory-table')).toContainText('¥186M');
    await page.locator('main [data-entity-ref="deal-sakura-ev"]').first().hover();
    await expect(card(page)).toContainText('¥186M');
  });

  test('graph nodes, chart points and Gantt bars use the same card', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.locator('.priority-matrix [data-entity-ref="issue-lead-time"]').hover();
    await expect(card(page)).toHaveAttribute('data-entity-id', 'issue-lead-time');
    await open(page, '/plan', { lang: 'en' });
    await page.locator('.gantt [data-entity-ref="init-dp-rollout"]').focus();
    await expect(card(page)).toHaveAttribute('data-entity-id', 'init-dp-rollout');
  });
});

test.describe('F-3.2.3 drill-through', () => {
  test('a reference with a destination is a link; Back restores search, filter, tab and selection', async ({ page }) => {
    await open(page, '/directory', { lang: 'en' });
    await page.getByRole('tab', { name: 'Deals' }).click();
    await page.locator('#dir-search').fill('valve');
    await page.locator('#dir-filter').selectOption('won');
    await page.getByRole('checkbox', { name: 'Select Hygienic valve upgrade' }).check();
    await expect(page.getByTestId('directory-table').locator('tbody tr')).toHaveCount(1);

    const link = page.getByRole('link', { name: 'Hygienic valve upgrade' });
    await link.click();
    await expect(page).toHaveURL(/#\/entity\/deal-umi-hygiene/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hygienic valve upgrade');

    await page.goBack();
    await expect(page.locator('#dir-search')).toHaveValue('valve');
    await expect(page.locator('#dir-filter')).toHaveValue('won');
    await expect(page.getByRole('tab', { name: 'Deals' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('checkbox', { name: 'Select Hygienic valve upgrade' })).toBeChecked();
    await expect(page.getByTestId('directory-table').locator('tbody tr')).toHaveCount(1);
  });

  test('the in-page Back button also restores state', async ({ page }) => {
    await open(page, '/directory?tab=customers&q=energy', { lang: 'en' });
    await page.getByRole('link', { name: 'Kaze Wind Energy' }).click();
    await page.getByTestId('back').click();
    await expect(page.locator('#dir-search')).toHaveValue('energy');
  });

  test('selection is separate from navigation: the checkbox does not navigate', async ({ page }) => {
    await open(page, '/directory?tab=people', { lang: 'en' });
    await page.getByRole('checkbox', { name: 'Select Yui Sato' }).check();
    await expect(page).toHaveURL(/#\/directory\?.*sel=person-sato-yui/);
    await expect(page.getByText('1 selected')).toBeVisible();
  });

  test('a reference without a destination is not a link (sources)', async ({ page }) => {
    await open(page, '/entity/issue-lead-time', { lang: 'en' });
    const source = page.locator('main [data-entity-ref="src-annual-report"]');
    await expect(source).toHaveJSProperty('tagName', 'BUTTON');
    await expect(page.getByRole('link', { name: 'Integrated Report 2025 (sample)' })).toHaveCount(0);
    await source.click();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('no detail screen');
  });

  test('diagram nodes select on click/Enter; drilling through is a separate action', async ({ page }) => {
    await open(page, '/relations', { lang: 'en' });
    const node = page.locator('.chain-diagram [data-entity-ref="deal-sakura-ev"]');
    await node.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/relations\?.*sel=deal-sakura-ev/);
    await expect(node).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('selection-panel')).toBeVisible();
    await page.getByTestId('selection-panel').getByRole('link', { name: 'Open details' }).click();
    await expect(page).toHaveURL(/#\/entity\/deal-sakura-ev/);
    await page.goBack();
    await expect(page.locator('.chain-diagram [data-entity-ref="deal-sakura-ev"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('F-3.2.2 map popups', () => {
  test('a site opens the same entity card by hover and keyboard, Enter selects it', async ({ page }) => {
    await open(page, '/map', { lang: 'en' });
    const marker = page.locator('.geo-map [data-entity-ref="site-nagoya"]');
    await marker.hover();
    await expect(card(page)).toHaveAttribute('data-entity-id', 'site-nagoya');
    await page.mouse.move(5, 600);
    await expect(card(page)).toHaveCount(0);

    await marker.focus();
    await expect(card(page)).toHaveAttribute('data-entity-id', 'site-nagoya');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/sel=site-nagoya/);
    await expect(page.getByTestId('map-selection')).toContainText('Ren Tanaka');
  });
});

test.describe('F-3.2.4 business relationships', () => {
  test('selecting an invoice highlights its customer → deal → deliverable chain', async ({ page }) => {
    await open(page, '/relations?sel=inv-2026-101', { lang: 'en' });
    for (const id of ['cust-sakura-motors', 'deal-sakura-ev', 'dlv-sakura-ev-proto', 'inv-2026-101']) {
      await expect(page.locator(`.chain-diagram [data-entity-ref="${id}"]`)).toHaveClass(/\bon\b/);
    }
    await expect(page.locator('.chain-diagram [data-entity-ref="cust-kaze-energy"]')).toHaveClass(/\bdim\b/);
  });

  test('the relationship graph reacts to hops and focus', async ({ page }) => {
    await open(page, '/relations?view=graph&focus=cust-sakura-motors&hops=1', { lang: 'en' });
    const one = await page.locator('.force-graph .graph-node').count();
    await open(page, '/relations?view=graph&focus=cust-sakura-motors&hops=3', { lang: 'en' });
    const three = await page.locator('.force-graph .graph-node').count();
    expect(three).toBeGreaterThan(one);
    await page.locator('.force-graph [data-entity-ref="deal-sakura-ev"]').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/focus=deal-sakura-ev/);
  });
});
