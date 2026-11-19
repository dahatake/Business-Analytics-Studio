import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SOL = 'sol-energy-twin';

async function scan(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function go(page: Page, route: string, lang: Lang = 'ja') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.req')) return;
    sessionStorage.setItem('bas.e2e.req', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: 'E2E', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true, todoCollapsed: false }, version: 1 }));
  });
  await open(page, route, { lang });
}

/** The solution is an AI agent: its deliverable is the agent specification. */
async function makeAgent(page: Page) {
  await go(page, '/deliverables?step=solution', 'en');
  await page.getByTestId(`sol-solution-${SOL}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.getByTestId(`sol-type-${SOL}`).selectOption('agent');
  await page.getByTestId('dlv-tab-deliverable').click();
  await page.getByTestId(`sol-doc-${SOL}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });
}

test.describe('requirements management', () => {
  test('an AI agent gets its own specification with the handbook sections, and wording that cannot be verified is flagged', async ({ page }) => {
    await makeAgent(page);
    for (const id of ['roleSplit', 'uncertainty', 'fallback', 'dataSupply', 'evaluation', 'monitoring', 'logging']) {
      await expect(page.getByTestId(`sol-doc-${SOL}-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId(`sol-doc-${SOL}-fallback`)).toHaveValue(/route to a person/);
    const box = page.getByTestId(`sol-doc-${SOL}-roleSplit`);
    await box.fill('- The system shall be easy to use');
    await box.blur();
    await expect(page.getByTestId(`sol-doc-quality-${SOL}-roleSplit`)).toContainText('"easy" cannot be verified');
    await expect(page.getByTestId(`sol-doc-clean-${SOL}`)).toContainText('Wording issues');
    await expect(page.getByTestId(`sol-doc-stamp-${SOL}-roleSplit`)).toContainText('Written by E2E');
    await box.fill('- Staff approve every refund over 10,000 JPY');
    await box.blur();
    await expect(page.getByTestId(`sol-doc-quality-${SOL}-roleSplit`)).toHaveCount(0);
  });

  test('evidence by hand reaches the specification, the ledger keeps decisions per requirement id, and CSV / ReqIF export them', async ({ page }) => {
    await makeAgent(page);
    await page.locator('details.sol-ev-manual > summary').click();
    await page.getByTestId('sol-ev-manual-kind').selectOption('complaint');
    await page.getByTestId('sol-ev-manual-title').fill('Late delivery');
    await page.getByTestId('sol-ev-manual-summary').fill('Orders miss the promised date');
    await page.getByTestId('sol-ev-manual-add').click();
    await expect(page.getByTestId('sol-ev-list')).toContainText('Late delivery');
    await expect(page.getByTestId(`sol-doc-${SOL}-functionalReq`)).toHaveValue(/VC-[\w-]+: Complaint "Late delivery"/);

    await page.getByTestId(`sol-ledger-${SOL}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    const row = page.locator(`[data-testid^="sol-led-row-${SOL}-BR-"]`).first();
    const id = (await row.getAttribute('data-testid'))!.replace(`sol-led-row-${SOL}-`, '');
    await page.getByTestId(`sol-led-priority-${id}`).selectOption('must');
    await page.getByTestId(`sol-led-status-${id}`).selectOption('approved');
    await page.reload();
    await page.getByTestId(`sol-ledger-${SOL}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await expect(page.getByTestId(`sol-led-priority-${id}`)).toHaveValue('must');
    await expect(page.getByTestId(`sol-led-status-${id}`)).toHaveValue('approved');

    const csv = page.waitForEvent('download');
    await page.getByTestId(`sol-ledger-csv-${SOL}`).click();
    expect((await csv).suggestedFilename()).toMatch(/\.csv$/);
    const reqif = page.waitForEvent('download');
    await page.getByTestId(`sol-ledger-reqif-${SOL}`).click();
    const download = await reqif;
    expect(download.suggestedFilename()).toMatch(/\.reqif$/);
    const xml = await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8');
    expect(xml).toContain('<REQ-IF ');
    expect(xml).toContain(`LONG-NAME="${id}"`);
    expect(xml).toContain('Must'.toLowerCase());
  });

  test('a change record keeps its reason, impact and approver', async ({ page }) => {
    await makeAgent(page);
    await page.getByTestId('sol-chg-subject').fill('BR-lead-time');
    await page.getByTestId('sol-chg-summary').fill('Target changed');
    await page.getByTestId('sol-chg-reason').fill('Board decision');
    await page.getByTestId('sol-chg-impact').fill('Acceptance test');
    await page.getByTestId('sol-chg-approver').fill('Director');
    await page.getByTestId('sol-chg-add').click();
    await expect(page.getByTestId('sol-chg-list')).toContainText('Board decision');
    await page.reload();
    await expect(page.getByTestId('sol-chg-list')).toContainText('Director');
  });

  test('a rare but severe issue is shown as a hidden gem on the current-state step', async ({ page }) => {
    await go(page, '/deliverables?step=asis', 'en');
    const row = page.locator('[data-testid^="sol-sig-row-"]').first();
    const id = (await row.getAttribute('data-testid'))!.replace('sol-sig-row-', '');
    await page.getByTestId(`sol-sig-frequency-${id}`).selectOption('1');
    await page.getByTestId(`sol-sig-severity-${id}`).selectOption('5');
    await expect(page.getByTestId('sol-sig-gems')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId(`sol-sig-severity-${id}`)).toHaveValue('5');
    await expect(page.getByTestId('sol-sig-gems')).toBeVisible();
  });

  for (const lang of ['ja', 'en'] as const) {
    test(`the requirement panels have no accessibility violations (${lang})`, async ({ page }) => {
      await go(page, '/deliverables?step=deliverable', lang);
      await page.getByTestId('sol-ev-manual-add').scrollIntoViewIfNeeded();
      await page.locator('details.sol-ev-manual > summary').click();
      await page.locator('details.sol-doc').first().evaluate((el) => { (el as HTMLDetailsElement).open = true; });
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    });
  }
});
