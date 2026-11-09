import { expect, test } from '@playwright/test';
import { open } from './helpers.ts';

// Software WebGL so the 3D viewer can start in headless Chromium.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

test('3D data viewer opens and its selection is synchronized with the table (FR-169 / FR-170)', async ({ page }) => {
  await open(page, '/catalog', { lang: 'en' });
  const viewer = page.getByTestId('uc-viewer');
  await expect(viewer).toHaveAttribute('data-webgl', 'true');
  await viewer.getByRole('button', { name: '3D' }).click();
  await expect(viewer).toHaveAttribute('data-mode', '3d');
  await expect(viewer.locator('canvas')).toBeVisible();
  await expect(viewer.locator('.uc-viewer-3d')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('uc-entities').getByRole('button', { name: 'Invoice', exact: true }).click();
  await expect(viewer).toHaveAttribute('data-selected', 'de-invoice');
  await expect(page.getByTestId('uc-viewer-caption')).toContainText('Invoice');
  // Keyboard in the viewer moves the selection and the table follows (NFR-A11Y-007).
  await viewer.locator('.uc-viewer-box').focus();
  await page.keyboard.press('ArrowRight');
  await expect(viewer).not.toHaveAttribute('data-selected', 'de-invoice');
  const next = await viewer.getAttribute('data-selected');
  await expect(page.locator(`tr[data-entity-id="${next}"]`)).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect(viewer).toHaveAttribute('data-detail', 'columns');
  await viewer.getByRole('button', { name: 'Rotate left' }).click();
  await expect(viewer.locator('canvas')).toBeVisible();
});
