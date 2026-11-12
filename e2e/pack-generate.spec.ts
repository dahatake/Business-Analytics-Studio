import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, setup, visibleTextExcludingOtherLang } from './helpers.ts';

/*
 * FR-311 (D-12): "Create customer pack with Copilot" on the launch screen and in project management, with the AI
 * settings reachable from there. These tests only read the relay; the live generation test changes the relay's saved
 * connection, so it lives in e2e/ai.spec.ts, whose tests run in order in one worker (the relay is shared by the server).
 */
test.describe.configure({ mode: 'default' });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function seed(page: Page, lang: 'ja' | 'en', withInputs = false) {
  await setup(page, { skipLaunch: false, lang });
  await page.addInitScript((inputs) => {
    if (sessionStorage.getItem('bas.e2e.gen')) return;
    sessionStorage.setItem('bas.e2e.gen', '1');
    const createdAt = '2026-11-10T00:00:00.000Z';
    localStorage.setItem('bas.projects', JSON.stringify({
      version: 1,
      state: {
        companies: [{ id: 'co-c', name: 'Contoso', createdAt, ...(inputs ? { industry: 'IT サービス', officialUrl: 'https://www.contoso.example' } : {}) }],
        projects: [{
          id: 'pj-c', companyId: 'co-c', name: 'Delivery', createdAt, step: 'define',
          ...(inputs ? { brief: { purpose: '配送遅延を減らす\n顧客満足度を上げる', focus: '関東の物流', asOf: '2026-10-01' } } : {}),
        }],
        target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define',
      },
    }));
  }, withInputs);
  await page.goto('/');
  await expect(page.getByTestId('launch-screen')).toBeVisible();
}

test('launch screen: AI settings and the generator are reachable; missing required fields are listed and block the start', async ({ page }) => {
  await seed(page, 'en');
  await page.getByTestId('launch-ai-settings').click();
  const settings = page.getByTestId('ai-settings-dialog');
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('ai-endpoint')).toBeVisible();
  await expect(settings.getByTestId('ai-workiq')).toBeVisible();
  await expect(settings.getByTestId('ai-workiq-route-cli')).toBeChecked(); // D-14: Microsoft's Work IQ CLI is the default route
  await expect(settings.getByTestId('ai-workiq-check')).toBeDisabled(); // nothing saved yet
  await settings.getByTestId('ai-provider-copilot').check();
  await expect(settings.getByTestId('ai-copilot')).toBeVisible();
  await expect(settings.getByTestId('ai-workiq')).toHaveCount(0); // D-14: Work IQ belongs to Microsoft Foundry only
  await expect(settings.getByTestId('ai-copilot-signin')).toContainText('Not checked');
  await expect(settings.getByTestId('ai-endpoint')).toHaveCount(0);
  await expect(settings.getByTestId('ai-price-request')).toBeVisible();
  expect(await scan(page)).toEqual([]);
  await settings.getByTestId('ai-provider-foundry').check();
  await settings.getByTestId('ai-settings-dialog-close').click();
  await expect(settings).toHaveCount(0);

  await page.getByTestId('launch-generate-pj-c').click();
  const dialog = page.getByTestId('gen-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('gen-company')).toHaveValue('Contoso');
  await expect(dialog.getByTestId('gen-project')).toHaveValue('Delivery');
  await expect(dialog.getByTestId('gen-missing')).toHaveText('Required fields missing: Purpose (improvement theme)');
  await expect(dialog.getByTestId('gen-start')).toBeDisabled();
  await expect(dialog.getByTestId('ai-readiness')).toContainText('To do');
  await expect(dialog.getByTestId('gen-workiq')).toBeDisabled(); // Foundry is selected, but nobody signed in to Work IQ
  await expect(dialog.getByTestId('gen-workiq-note')).toContainText('choose the Work IQ CLI');
  await dialog.getByTestId('gen-purpose').fill('Reduce late deliveries');
  await expect(dialog.getByTestId('gen-missing')).toHaveCount(0);
  await expect(dialog.getByTestId('gen-start')).toBeDisabled(); // AI not configured, confirmations not given
  const text = await visibleTextExcludingOtherLang(page, 'en');
  expect(text.split('\n').filter((l) => JAPANESE.test(l))).toEqual([]);
  expect(await scan(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByTestId('launch-generate').click();
  await expect(page.getByTestId('gen-missing')).toContainText('Company name');
  await expect(page.getByTestId('gen-missing')).toContainText('Project name');
});

test('Japanese labels on the launch screen', async ({ page }) => {
  await seed(page, 'ja');
  await expect(page.getByTestId('launch-generate')).toHaveText('顧客パックを Copilot で作成');
  await expect(page.getByTestId('launch-ai-settings')).toHaveText('AI 設定');
  await page.getByTestId('launch-generate').click();
  await expect(page.getByTestId('gen-missing')).toContainText('企業名');
});

test('generator fits narrow screens and can be resized in both directions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page, 'ja');
  await page.getByTestId('launch-generate-pj-c').click();
  const dialog = page.getByTestId('gen-dialog');
  await dialog.getByTestId('gen-public-topic').fill('a'.repeat(80));
  await dialog.getByTestId('gen-files').setInputFiles({
    name: `${'longfilename'.repeat(12)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('material'),
  });

  const assertFits = async () => {
    const overflow = await dialog.evaluate((surface) => {
      const elements = surface.querySelectorAll('.fui-DialogContent, .gen-form, .gen-grid, .gen-llm, .fui-Checkbox__label, .gen-file-list li');
      return [...elements].filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => ({ className: el.className, width: el.clientWidth, scrollWidth: el.scrollWidth }));
    });
    expect(overflow).toEqual([]);
    await expect(dialog.getByTestId('gen-start')).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'キャンセル' })).toBeInViewport();
  };

  await assertFits();
  const before = (await dialog.boundingBox())!;
  await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 203, before.y + before.height - 203, { steps: 10 });
  await page.mouse.up();
  const after = (await dialog.boundingBox())!;
  expect(after.width).toBeLessThan(before.width - 100);
  expect(after.height).toBeLessThan(before.height - 100);
  await assertFits();
  await page.mouse.move(after.x + after.width - 3, after.y + after.height - 3);
  await page.mouse.down();
  await page.mouse.move(after.x + after.width + 147, after.y + after.height + 147, { steps: 10 });
  await page.mouse.up();
  const enlarged = (await dialog.boundingBox())!;
  expect(enlarged.width).toBeGreaterThan(after.width + 100);
  expect(enlarged.height).toBeGreaterThan(after.height + 100);
  await assertFits();
  await dialog.getByTestId('gen-purpose').fill('入力内容を保持する');

  for (const viewport of [{ width: 768, height: 700 }, { width: 320, height: 700 }, { width: 320, height: 400 }]) {
    await page.setViewportSize(viewport);
    await assertFits();
    await expect(dialog.getByTestId('gen-purpose')).toHaveValue('入力内容を保持する');
    await dialog.getByTestId('gen-workiq-section').scrollIntoViewIfNeeded();
    await expect(dialog.getByTestId('gen-workiq-note')).toBeVisible();
  }
});

test('D-14: with GitHub Copilot as the provider the generator neither offers nor mentions Work IQ', async ({ page }) => {
  await seed(page, 'en');
  await page.getByTestId('launch-ai-settings').click();
  const settings = page.getByTestId('ai-settings-dialog');
  await settings.getByTestId('ai-provider-copilot').check();
  await settings.getByTestId('ai-settings-dialog-close').click();
  await page.getByTestId('launch-generate-pj-c').click();
  const dialog = page.getByTestId('gen-dialog');
  await expect(dialog.getByTestId('gen-news')).toBeVisible();
  await expect(dialog.getByTestId('gen-workiq-section')).toHaveCount(0);
  await expect(dialog.getByTestId('gen-sends')).not.toContainText('Work IQ');
});

test('company information is entered once and reused; the project inputs come back multi-line in the generator', async ({ page }) => {
  await seed(page, 'ja', true);
  await expect(page.getByTestId('launch-purpose-pj-c')).toContainText('配送遅延を減らす');
  await page.getByTestId('launch-generate-pj-c').click();
  const dialog = page.getByTestId('gen-dialog');
  await expect(dialog.getByTestId('gen-company-note')).toContainText('登録済みの企業です');
  await expect(dialog.getByTestId('gen-industry')).toHaveValue('IT サービス');
  await expect(dialog.getByTestId('gen-url')).toHaveValue('https://www.contoso.example');
  await expect(dialog.getByTestId('gen-purpose')).toHaveValue('配送遅延を減らす\n顧客満足度を上げる');
  await expect(dialog.getByTestId('gen-focus')).toHaveValue('関東の物流');
  await expect(dialog.getByTestId('gen-asof')).toHaveValue('2026-10-01');
  await expect(dialog.getByTestId('gen-missing')).toHaveCount(0);
  await expect(dialog.getByTestId('gen-replaces')).toHaveCount(0); // no pack yet
  // Company first, then the project.
  expect(await dialog.evaluate((el) => {
    const company = el.querySelector('[data-testid="gen-company-section"]')!;
    const purpose = el.querySelector('[data-testid="gen-purpose"]')!;
    return Boolean(company.compareDocumentPosition(purpose) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  expect(await scan(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'キャンセル' }).click();

  // A new project of the same company does not ask for the company information again.
  await page.getByTestId('launch-company-name').fill('Contoso');
  await page.getByTestId('launch-project-name').fill('Billing');
  await page.getByTestId('launch-generate').click();
  await expect(dialog.getByTestId('gen-company-note')).toContainText('登録済みの企業です');
  await expect(dialog.getByTestId('gen-industry')).toHaveValue('IT サービス');
  await expect(dialog.getByTestId('gen-url')).toHaveValue('https://www.contoso.example');
  await expect(dialog.getByTestId('gen-purpose')).toHaveValue('');
});
