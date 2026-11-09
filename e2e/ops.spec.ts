import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JAPANESE, open, setup, type Lang } from './helpers.ts';
import { contrastRatio, DARK_BG } from '../src/modules/ops/color.ts';
import { startServer } from '../scripts/lib/serve.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const brandVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.querySelector('.fui-FluentProvider')!).getPropertyValue(n).trim().toUpperCase(), name);

/** Visible text and accessible names inside the main area (other modules' chrome is checked by their own specs). */
const mainText = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main#main')!;
    const names = [...main.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') ?? '');
    return `${(main as HTMLElement).innerText}\n${names.join('\n')}`;
  });

const INTEGRATIONS_KEY = 'bas.scope.demo.ops.integrations';

test.describe('ops: brand (FR-059〜FR-064)', () => {
  test('override changes the theme colour and persists after reload', async ({ page }) => {
    await open(page, '/brand', { lang: 'en' });
    await expect(page.getByTestId('brand-origin')).toHaveText('Default theme');
    await expect(page.getByTestId('template-version')).toHaveText(/^\d+\.\d+\.\d+/);
    const before = await brandVar(page, '--colorBrandBackground');
    await page.getByTestId('brand-primary-input').fill('#C239B3');
    await page.getByTestId('brand-apply').click();
    await expect(page.getByTestId('brand-origin')).toHaveText('Override on this PC');
    const after = await brandVar(page, '--colorBrandBackground');
    expect(after).not.toBe(before);
    const ramp70 = await page.locator('.ops-ramp li[data-step="70"]').getAttribute('data-color');
    expect(after).toBe(ramp70);
    expect(await brandVar(page, '--colorBrandForeground1')).toBe(await page.getByTestId('applied-dark').getAttribute('data-color'));
    await page.reload();
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.getByTestId('brand-primary')).toHaveText('#C239B3');
    expect(await brandVar(page, '--colorBrandBackground')).toBe(after);
    await page.getByTestId('brand-reset').click();
    await expect(page.getByTestId('brand-origin')).toHaveText('Default theme');
    expect(await brandVar(page, '--colorBrandBackground')).toBe(before);
  });

  test('a low-contrast primary shows a warning and the corrected colour is applied', async ({ page }) => {
    await open(page, '/brand', { lang: 'en' });
    await expect(page.getByTestId('contrast-warning')).toHaveCount(0);
    await page.getByTestId('brand-primary-input').fill('#1A1F4D');
    await page.getByTestId('brand-apply').click();
    await expect(page.getByTestId('contrast-warning')).toBeVisible();
    await expect(page.getByTestId('contrast-primaryOnDark')).toHaveAttribute('data-pass', 'false');
    const applied = (await page.getByTestId('applied-dark').getAttribute('data-color'))!;
    expect(applied).not.toBe('#1A1F4D');
    expect(contrastRatio(applied, DARK_BG)).toBeGreaterThanOrEqual(4.5);
    expect(await brandVar(page, '--colorBrandForeground1')).toBe(applied);
    const sampleColor = await page.getByTestId('brand-sample').evaluate((e) => getComputedStyle(e).color);
    const [r, g, b] = sampleColor.match(/\d+/g)!.map(Number) as [number, number, number];
    expect(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()).toBe(applied);
    // An invalid colour is refused with a message, nothing is applied.
    await page.getByTestId('brand-primary-input').fill('blue');
    await expect(page.getByRole('alert').filter({ hasText: '#RRGGBB' })).toBeVisible();
    await expect(page.getByTestId('brand-apply')).toBeDisabled();
  });

  test('presets and logo placeholder are shown', async ({ page }) => {
    await open(page, '/brand', { lang: 'en' });
    await expect(page.getByTestId('brand-presets').locator('tbody tr')).toHaveCount(6);
    await expect(page.getByTestId('logo-placeholder')).toBeVisible();
    await expect(page.locator('.ops-ramp li')).toHaveCount(16);
  });
});

test.describe('ops: integrations (FR-199〜FR-203)', () => {
  test('selection is limited to 20 per project', async ({ page }) => {
    await setup(page, { lang: 'en' });
    await page.addInitScript((key) => {
      if (sessionStorage.getItem('ops.e2e.seeded')) return;
      sessionStorage.setItem('ops.e2e.seeded', '1');
      const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `custom-e2e-${i}`, name: `Candidate ${i + 1}` }));
      localStorage.setItem(key, JSON.stringify({ selected: candidates.map((c) => c.id), candidates, settings: {} }));
    }, INTEGRATIONS_KEY);
    await page.goto('/#/integrations');
    await expect(page.getByTestId('int-count')).toHaveText('20 of 20 selected');
    const copilot = page.getByTestId('int-select-copilot-sdk');
    await copilot.click();
    await expect(copilot).not.toBeChecked();
    await expect(page.getByTestId('int-message')).toContainText('up to 20');
    await page.getByTestId('int-select-custom-e2e-0').click();
    await expect(page.getByTestId('int-count')).toHaveText('19 of 20 selected');
    await copilot.click();
    await expect(copilot).toBeChecked();
    await expect(page.getByTestId('int-count')).toHaveText('20 of 20 selected');
  });

  test('settings keep only the secret store name; no secret value fields', async ({ page }) => {
    await open(page, '/integrations', { lang: 'en' });
    await expect(page.getByTestId('int-check-summary')).toContainText('0 errors');
    await page.getByTestId('int-select-foundry').click();
    const card = page.getByTestId('int-settings-foundry');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('send-foundry')).toContainText('Never sends');
    expect(await page.locator('main input[type="password"]').count()).toBe(0);
    const labels = await page.locator('main label').allInnerTexts();
    expect(labels.filter((l) => /\b(api key|token|password|secret value|key value)\b/i.test(l))).toEqual([]);
    const store = page.getByTestId('secret-store-foundry');
    await store.fill('api_key=8f2a9c1d77e0');
    await expect(card.getByRole('alert')).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k) ?? '', INTEGRATIONS_KEY)).not.toContain('8f2a9c1d77e0');
    await store.fill('Windows Credential Manager: bas-foundry');
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k) ?? '', INTEGRATIONS_KEY)).toContain('bas-foundry');
    await page.reload();
    await expect(page.getByTestId('secret-store-foundry')).toHaveValue('Windows Credential Manager: bas-foundry');
  });
});

test('FR-101: a pack built by the CLI is shown without rebuilding the app', async ({ page }) => {
  test.setTimeout(90_000);
  const base = resolve('.bas-local', `e2e-ops-${test.info().workerIndex}`);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const template = resolve(process.env.BAS_OUT ?? 'dist');
  const indexBefore = readFileSync(join(template, 'index.html'), 'utf8');
  const r = spawnSync(process.execPath, ['scripts/bas.ts', 'build', 'Contoso Robotics E2E', '--industry', 'logistics', '--lang', 'en',
    '--template', template, '--work', join(base, 'work'), '--cache', join(base, 'cache'), '--logs', join(base, 'logs')], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const app = join(base, 'work', 'contoso-robotics-e2e');
  expect(readFileSync(join(app, 'index.html'), 'utf8')).toBe(indexBefore);
  const served = await startServer(app, 0);
  try {
    await setup(page, { lang: 'en' });
    await page.goto(`${served.url}#/`);
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.getByText('Contoso Robotics E2E').first()).toBeVisible();
    await page.goto(`${served.url}#/brand`);
    await expect(page.getByTestId('brand-origin')).toHaveText('Default theme');
  } finally {
    await served.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test.describe('ops: accessibility and language', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const route of ['/brand', '/integrations']) {
      test(`axe ${lang} ${route}`, async ({ page }) => {
        await open(page, route, { lang });
        await page.waitForTimeout(500);
        expect(await scan(page)).toEqual([]);
      });
    }
    test(`axe ${lang} with warning and settings open`, async ({ page }) => {
      await open(page, '/brand', { lang });
      await page.getByTestId('brand-primary-input').fill('#FFE600');
      await page.getByTestId('brand-apply').click();
      await expect(page.getByTestId('contrast-warning')).toBeVisible();
      expect(await scan(page), 'brand with warning').toEqual([]);
      await page.goto('/#/integrations');
      await page.getByTestId('int-select-workiq').click();
      await expect(page.getByTestId('int-settings-workiq')).toBeVisible();
      expect(await scan(page), 'integrations with settings').toEqual([]);
    });
  }

  test('English screens have no Japanese characters', async ({ page }) => {
    await open(page, '/brand', { lang: 'en' });
    await page.getByTestId('brand-primary-input').fill('#FFE600');
    await page.getByTestId('brand-apply').click();
    expect((await mainText(page)).match(JAPANESE)).toBeNull();
    await page.goto('/#/integrations');
    await page.getByTestId('int-select-foundry').click();
    await expect(page.getByTestId('int-settings-foundry')).toBeVisible();
    expect((await mainText(page)).match(JAPANESE)).toBeNull();
  });
});
