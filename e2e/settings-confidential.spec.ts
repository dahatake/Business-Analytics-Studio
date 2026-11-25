import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedDeviceData, setup } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .include('[data-testid="confidential"]').exclude('[data-tabster-dummy]').analyze();
  return result.violations.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}
async function openSettings(page: Page) {
  await page.goto('/#/settings');
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  await expect(page.getByTestId('confidential')).toBeVisible();
}

test('AC-1023 confidential toggle defaults off, retention and allow persist, and delete-now empties the holdings', async ({ page }) => {
  await setup(page, { lang: 'en' });
  await openSettings(page);
  await expect(page.getByTestId('confidential-state')).toHaveAttribute('data-allow', 'false');
  await expect(page.getByTestId('confidential-toggle')).not.toBeChecked();
  await expect(page.getByTestId('confidential-days')).toHaveValue('7');
  await expect(page.getByTestId('confidential-none')).toBeVisible();
  await expect(page.getByTestId('confidential-purge')).toBeDisabled();
  expect(await scan(page)).toEqual([]);

  await page.getByTestId('confidential-toggle').check();
  await expect(page.getByTestId('confidential-state')).toHaveAttribute('data-allow', 'true');
  await page.getByTestId('confidential-days').fill('400');
  await page.getByTestId('confidential-days').press('Enter');
  await expect(page.getByTestId('confidential-days')).toHaveValue('365');
  await page.getByTestId('confidential-days').fill('3');
  await page.getByTestId('confidential-days').press('Enter');
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');

  // A holding taken just now for a company that is not registered: within the 3-day retention, so it stays listed.
  const since = new Date().toISOString();
  await seedDeviceData(page, {
    'bas.confidential': JSON.stringify({ state: { allow: true, retentionDays: 3, holdings: [{ company: 'E2E Confidential Co', labels: ['Confidential'], since, demo: false }] }, version: 1 }),
  });
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('confidential-toggle')).toBeChecked();
  await expect(page.getByTestId('confidential-days')).toHaveValue('3');
  await expect(page.getByTestId('confidential-holding')).toHaveCount(1);
  await expect(page.getByTestId('confidential-holding')).toContainText('E2E Confidential Co');
  expect(await scan(page)).toEqual([]);

  await page.getByTestId('confidential-purge').click();
  await expect(page.getByTestId('confidential-confirm')).toBeVisible();
  expect(await scan(page)).toEqual([]);
  await page.getByTestId('confidential-purge-yes').click();
  await expect(page.getByTestId('confidential-note')).toBeVisible();
  await expect(page.getByTestId('confidential-none')).toBeVisible();
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('confidential-none')).toBeVisible();
  await expect(page.getByTestId('confidential-toggle')).toBeChecked();
});
