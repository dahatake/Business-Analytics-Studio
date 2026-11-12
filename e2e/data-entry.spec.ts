import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open } from './helpers.ts';

async function scan(page: Page) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

test.use({ viewport: { width: 1600, height: 1200 } });

async function skipFirstRun(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.proj')) return;
    sessionStorage.setItem('bas.e2e.proj', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: '', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true }, version: 1 }));
  });
}

async function nav(page: Page, route: string) {
  await page.evaluate((r) => { window.location.hash = r; }, route);
  await expect(page.locator('main#main')).toBeVisible();
}

test.describe('data entry', () => {
  test('workspace: add, edit and delete an issue; it is kept after a reload', async ({ page }) => {
    await open(page, '/workspace', { lang: 'en' });
    const bar = page.getByTestId('entry-bar-summary');
    await expect(bar).toBeVisible();

    await bar.getByTestId('entry-add-issue').click();
    const dialog = page.getByTestId('entry-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('entry-save').click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('entry-field-name').fill('Late deliveries at E2E plant');
    await dialog.getByTestId('entry-field-impact').selectOption('5');
    expect(await scan(page)).toEqual([]);
    await dialog.getByTestId('entry-save').click();
    await expect(dialog).toBeHidden();

    const pick = bar.getByTestId('entry-edit-pick');
    await expect(pick.locator('option', { hasText: 'Late deliveries at E2E plant' })).toHaveCount(1);

    await page.reload();
    await expect(page.getByTestId('entry-bar-summary')).toBeVisible();
    const option = page.getByTestId('entry-bar-summary').getByTestId('entry-edit-pick').locator('option', { hasText: 'Late deliveries at E2E plant' });
    await expect(option).toHaveCount(1);

    const id = await option.getAttribute('value');
    await page.getByTestId('entry-bar-summary').getByTestId('entry-edit-pick').selectOption(id!);
    await expect(dialog.getByTestId('entry-field-name')).toHaveValue('Late deliveries at E2E plant');
    await dialog.getByTestId('entry-field-name').fill('Late deliveries (renamed)');
    await dialog.getByTestId('entry-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('entry-bar-summary').getByTestId('entry-edit-pick').locator('option', { hasText: 'Late deliveries (renamed)' })).toHaveCount(1);

    await page.getByTestId('entry-bar-summary').getByTestId('entry-edit-pick').selectOption(id!);
    await dialog.getByTestId('entry-delete').click();
    await dialog.getByTestId('entry-delete').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('entry-bar-summary').getByTestId('entry-edit-pick').locator('option', { hasText: 'Late deliveries' })).toHaveCount(0);
  });

  test('discussion: create an issue from a theme, relate it, and keep it in the project after a reload', async ({ page }) => {
    await skipFirstRun(page);
    await open(page, '/home');
    await nav(page, '/projects');
    await page.getByTestId('proj-company-name').fill('Fabrikam');
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.getByTestId('proj-project-name-Fabrikam').fill('Entry');
    await page.getByRole('button', { name: 'Project を作成' }).click();
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: 'Entry' }).click();
    await nav(page, '/discussion');

    await page.getByTestId('proj-theme-title').fill('物流の遅延');
    await page.getByTestId('proj-theme-add').click();
    await page.getByTestId('proj-create-relate').selectOption('issue');
    const dialog = page.getByTestId('entry-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('entry-field-name').fill('倉庫の出荷待ち');
    await dialog.getByTestId('entry-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('proj-canvas')).toContainText('倉庫の出荷待ち');

    await page.reload();
    await expect(page.getByTestId('proj-canvas')).toContainText('倉庫の出荷待ち');
  });
});
