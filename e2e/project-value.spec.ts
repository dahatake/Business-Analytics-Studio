import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, seedDeviceData, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .include('[data-testid="val-panel"]')
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function go(page: Page, step: 'solution' | 'deliverable', lang: Lang = 'ja') {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.val')) return;
    sessionStorage.setItem('bas.e2e.val', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: 'E2E', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true, todoCollapsed: true }, version: 1 }));
  });
  await open(page, `/step?step=${step}`, { lang });
  await expect(page.getByTestId('val-panel')).toBeVisible();
}

const p50 = async (page: Page) => Number(await page.getByTestId('val-p50').getAttribute('data-value'));

test.describe('FR-327 business value model', () => {
  test('recalculates at one and five years and persists only explicitly saved assumptions', async ({ page }) => {
    await go(page, 'solution');
    const horizon = page.getByTestId('val-horizon');
    await expect(horizon).toHaveValue('5');
    const fiveYears = await p50(page);
    await horizon.press('Home');
    await expect(horizon).toHaveValue('1');
    await expect.poll(() => p50(page)).not.toBe(fiveYears);
    const oneYear = await p50(page);
    await page.reload();
    await expect(horizon).toHaveValue('5');
    await expect.poll(() => p50(page)).toBe(fiveYears);
    await horizon.press('Home');
    await page.getByTestId('val-save-assumptions').click();
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await expect(horizon).toHaveValue('1');
    await expect.poll(() => p50(page)).toBe(oneYear);
  });

  test('shows the hidden value drivers, what-if, links and lines, and exports HTML that recomputes the same NPV', async ({ page }) => {
    await go(page, 'solution');
    const panel = page.getByTestId('val-panel');
    // The demo decomposes e-invoicing: the one-off working capital appears as its own driver.
    await expect(panel.getByTestId('step-dash-chart-val-bridge').locator('[data-driver="capital"]')).toBeVisible();
    await expect(panel.getByTestId('val-check-undecomposed')).toBeVisible();
    const base = await p50(page);
    expect(Number.isFinite(base)).toBe(true);

    // What-if: leaving a solution out changes the NPV and is not saved until asked.
    await panel.getByTestId('val-include-sol-e-invoice').uncheck();
    await expect(panel.getByTestId('val-dirty')).toBeVisible();
    await expect.poll(() => p50(page)).not.toBe(base);
    await panel.getByTestId('val-reset').click();
    await expect.poll(() => p50(page)).toBe(base);

    // An effect nobody examined: the question for its type, then "examined: none".
    await panel.getByTestId('val-cell-sol-e-invoice-risk').click();
    await expect(panel.getByTestId('val-hint')).toBeVisible();
    await panel.getByTestId('val-hint-reviewed').click();
    await expect(panel.locator('td[data-state="reviewed"]').getByTestId('val-cell-sol-e-invoice-risk')).toBeVisible();

    // Add a risk benefit from the matrix: the cell turns into money and the line is listed.
    await panel.getByTestId('val-cell-sol-vision-inspection-risk').click();
    await panel.getByTestId('val-hint-add').click();
    const form = panel.getByTestId('val-form');
    await expect(form.getByTestId('val-f-lever')).toHaveValue('risk');
    await form.getByTestId('val-f-label').fill('リコールの期待損失の低減');
    await form.getByTestId('val-f-amount-low').fill('5');
    await form.getByTestId('val-f-amount-mode').fill('10');
    await form.getByTestId('val-f-amount-high').fill('30');
    await form.getByTestId('val-f-save').click();
    await expect(panel.getByTestId('val-lines')).toContainText('リコールの期待損失の低減');
    await expect(panel.locator('td[data-state="money"]').getByTestId('val-cell-sol-vision-inspection-risk')).toBeVisible();

    // The data implies a shared platform; confirming it with a share changes the marginal value.
    const key = 'sharedCost:sol-demand-planning:sol-energy-twin';
    await panel.getByTestId(`val-suggest-confirm-${key}`).click();
    await panel.getByTestId('val-l-share').fill('20');
    await panel.getByTestId('val-l-save').click();
    await expect(panel.getByTestId(`val-link-${key}`)).toBeVisible();
    await expect(panel.getByTestId(`val-suggest-${key}`)).toHaveCount(0);
    await expect(panel.getByTestId('step-dash-chart-val-marginal').locator('[data-solution="sol-demand-planning"]')).toHaveAttribute('data-differs', 'true');

    // Saved with the project.
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    const saved = await p50(page);
    await page.reload();
    await expect(page.getByTestId(`val-link-${key}`)).toBeVisible();
    await expect.poll(() => p50(page)).toBe(saved);

    expect(await scan(page)).toEqual([]);

    // The exported file runs the same engine: same P50 with no network and no app.
    const [download] = await Promise.all([page.waitForEvent('download'), panel.getByTestId('val-export').click()]);
    const html = await readFile((await download.path())!, 'utf8');
    const file = await page.context().newPage();
    await file.setContent(html);
    await expect(file.getByTestId('vh-p50')).not.toBeEmpty();
    expect(Number(await file.getByTestId('vh-p50').getAttribute('data-value'))).toBeCloseTo(saved, 0);
    await file.locator('input[data-solution="sol-e-invoice"]').uncheck();
    await expect.poll(async () => Number(await file.getByTestId('vh-p50').getAttribute('data-value'))).not.toBeCloseTo(saved, 0);
    await file.close();
  });

  test('is English-only in English and accessible on the plan step', async ({ page }) => {
    await go(page, 'deliverable', 'en');
    await expect(page.getByTestId('step-dash-chart-val-tornado')).toBeVisible();
    const text = await page.getByTestId('val-panel').evaluate((el) => el.textContent ?? '');
    expect(text).not.toMatch(JAPANESE);
    expect(await visibleTextExcludingOtherLang(page, 'en')).toBeTruthy();
    expect(await scan(page)).toEqual([]);
  });
});

test.describe('FR-335 the app resolves the open items', () => {
  test('rules draft without AI, a person adopts the verified lines, and realisation and correlation are shown', async ({ page }) => {
    await go(page, 'solution');
    const panel = page.getByTestId('val-panel');
    await expect(panel.getByTestId('val-irr')).not.toHaveAttribute('data-value', '');
    await expect(panel.getByTestId('val-robust')).toContainText('判断は変わりません');
    await expect(panel.getByTestId('val-corr-effect')).toBeVisible();
    await expect(panel.getByTestId('val-check-undecomposed')).toBeVisible();
    const before = await p50(page);

    await panel.getByTestId('val-draft-rules').click();
    await expect(panel.getByTestId('val-draft-notice')).toContainText('下書き');
    const draft = panel.getByTestId('val-draft');
    await expect(draft.locator('[data-status="assumed"]').first()).toBeVisible();
    await expect(draft.locator('[data-status="unverified"]')).toHaveCount(0);
    // Nothing changes before adoption.
    expect(await p50(page)).toBe(before);
    await panel.getByTestId('val-draft-adopt-all').click();
    await expect(panel.getByTestId('val-draft')).toHaveCount(0);
    await expect(panel.getByTestId('val-check-undecomposed')).toHaveCount(0);
    await expect.poll(() => p50(page)).not.toBe(before);

    // Realisation: at the demo's date every solution is still being built, so nothing can be measured yet; actuals are recorded.
    const real = panel.getByTestId('val-realization');
    await expect(real.locator('h3')).toContainText('まだ測れていない');
    await expect(real.getByTestId('val-real-apply')).toBeDisabled();
    await real.getByTestId('val-real-add-val-demo-ei-cost').click();
    await real.getByTestId('val-real-amount').fill('1');
    await real.getByTestId('val-real-save').click();
    await expect(real.locator('tr[data-line="val-demo-ei-cost"]')).toContainText(/1(\.0)? 百万円/);
    expect(await scan(page)).toEqual([]);
  });

  test('Copilot drafts are recomputed: forged numbers stay unverified and are not adopted in bulk', async ({ page }) => {
    await go(page, 'solution');
    await page.route('**/relay/status', (route) => route.fulfill({ json: {
      secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
      connectionVerifiedAt: '2026-01-01T00:00:00Z',
    } }));
    const prompts: string[] = [];
    await page.route('**/relay/ai', async (route) => {
      const body = route.request().postDataJSON() as { prompt: string; use: string };
      prompts.push(body.prompt);
      expect(body.use).toBe('valueDraft');
      const base = { solutionId: 'sol-vision-inspection', nature: 'financial', timing: 'annual', sign: 'benefit', kpiId: 'kpi-defect', owner: '品質保証部長', conversion: { low: 1, mode: 1, high: 1 } };
      await route.fulfill({ json: { text: JSON.stringify({
        lines: [
          { ...base, lever: 'risk', label: 'リコールの期待損失の低減', amount: { low: 5e6, mode: 8.5e6, high: 15e6 }, formula: 'benefit * p', inputs: [{ name: 'benefit', value: 85e6, ref: 'sol-vision-inspection.annualBenefitJpy' }, { name: 'p', value: 0.1, ref: 'assumption' }], rationale: '不良の流出による損失' },
          { ...base, lever: 'cost', label: '偽の数値', amount: { low: 1e8, mode: 2e8, high: 3e8 }, formula: 'b', inputs: [{ name: 'b', value: 2e8, ref: 'sol-vision-inspection.annualBenefitJpy' }] },
        ],
        reviewed: [{ solutionId: 'sol-vision-inspection', lever: 'option', reason: '将来の選択肢は小さい' }],
        groups: [], discountRate: null,
      }), inputTokens: 100, outputTokens: 100 } });
    });
    await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey', monthlyBudgetJpy: 100000 }, version: 1 }) });
    await page.reload();
    const panel = page.getByTestId('val-panel');
    await panel.getByTestId('val-draft-copilot').click();
    await expect(panel.getByTestId('val-draft-notice')).toContainText('1 件は検算できず');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.startsWith('[bas-proj:valueDraft]')).toBe(true);
    expect(prompts[0]).toContain('sol-vision-inspection.annualBenefitJpy = 85000000');
    const draft = panel.getByTestId('val-draft');
    await expect(draft.locator('[data-status="assumed"]')).toContainText('リコールの期待損失の低減');
    await expect(draft.locator('[data-status="unverified"]')).toContainText('パックの値 sol-vision-inspection.annualBenefitJpy と不一致');
    expect(await scan(page)).toEqual([]);
    await panel.getByTestId('val-draft-adopt-all').click();
    await expect(panel.getByTestId('val-lines')).toContainText('リコールの期待損失の低減');
    await expect(panel.getByTestId('val-lines')).not.toContainText('偽の数値');
    await expect(draft.locator('[data-status="unverified"]')).toHaveCount(1);
    await expect(panel.locator('td[data-state="reviewed"]').getByTestId('val-cell-sol-vision-inspection-option')).toBeVisible();
  });
});

test.describe('FR-336 [Copilotで説明]', () => {
  test('without a connection it shows a labelled explanation whose figures match the ledger, live diagrams and sources', async ({ page }) => {
    await go(page, 'solution');
    const panel = page.getByTestId('val-panel');
    await expect(panel.getByTestId('val-explain-body')).toHaveCount(0);
    await panel.getByTestId('val-explain-run').click();
    const body = panel.getByTestId('val-explain-body');
    await expect(body).toHaveAttribute('data-mode', 'mock');
    await expect(body.getByTestId('val-explain-verified')).toBeVisible();
    for (const c of ['npv', 'lineage', 'worked', 'uncertainty', 'sensitivity', 'robustness', 'portfolio']) await expect(body.getByTestId(`val-explain-${c}`)).toBeVisible();
    await expect(body.getByTestId('val-explain-tree').locator('li[data-node="npv"]')).toBeVisible();
    await expect(body.getByTestId('val-x-worked')).toContainText('×');
    const refs = body.locator('.val-refs a');
    expect(await refs.count()).toBeGreaterThanOrEqual(15);
    for (const href of await refs.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) expect(href).toMatch(/^https:\/\//);
    await expect(body.locator('a[href="https://hbr.org/1979/09/risk-analysis-in-capital-investment"]')).toBeVisible();
    const before = await body.locator('li[data-node="npv"]').getAttribute('data-value');
    // The diagrams follow the what-if; the text is marked out of date.
    await panel.getByTestId('val-include-sol-e-invoice').uncheck();
    await expect(body.getByTestId('val-explain-stale')).toBeVisible();
    await expect.poll(() => body.locator('li[data-node="npv"]').getAttribute('data-value')).not.toBe(before);
    expect(await scan(page)).toEqual([]);
  });

  test('English has no Japanese, and Copilot figures that are not in the ledger are flagged', async ({ page }) => {
    await go(page, 'deliverable', 'en');
    await page.route('**/relay/status', (route) => route.fulfill({ json: {
      secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
      connectionVerifiedAt: '2026-01-01T00:00:00Z',
    } }));
    const prompts: string[] = [];
    await page.route('**/relay/ai', async (route) => {
      const body = route.request().postDataJSON() as { prompt: string; use: string };
      prompts.push(body.prompt);
      expect(body.use).toBe('valueExplain');
      await route.fulfill({ json: { text: JSON.stringify({ headline: 'The portfolio is worth 12,345 million yen.', sections: { npv: 'NPV compares today\'s value of future cash with the investment.' }, questions: ['Who owns the largest assumption?'] }), inputTokens: 100, outputTokens: 100 } });
    });
    await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey', monthlyBudgetJpy: 100000 }, version: 1 }) });
    await page.reload();
    const panel = page.getByTestId('val-panel');
    await panel.getByTestId('val-explain-run').click();
    const body = panel.getByTestId('val-explain-body');
    await expect(body).toHaveAttribute('data-mode', 'live');
    await expect(body.getByTestId('val-explain-unverified')).toContainText('12,345');
    expect(prompts[0]!.startsWith('[bas-proj:valueExplain]')).toBe(true);
    expect(prompts[0]).toContain('npvMode');
    const text = await body.evaluate((el) => el.textContent ?? '');
    expect(text).not.toMatch(JAPANESE);
    expect(await scan(page)).toEqual([]);
  });
});
