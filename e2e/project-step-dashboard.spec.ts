import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';
import { STEP_DEFS } from '../src/modules/project/deliverables.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STEPS = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'] as const;

async function scan(page: Page) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function go(page: Page, route: string, lang: Lang = 'ja') {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.dash')) return;
    sessionStorage.setItem('bas.e2e.dash', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: 'E2E', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true, todoCollapsed: false }, version: 1 }));
  });
  await open(page, route, { lang });
}

/** Every tile tied to an exit criterion must agree with the band, which evaluates the criteria independently. */
async function expectTilesMatchBand(page: Page) {
  const tiles = page.locator('.step-dash-tile[data-todo]');
  const n = await tiles.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const tile = tiles.nth(i);
    const todo = await tile.getAttribute('data-todo');
    const tone = await tile.getAttribute('data-tone');
    const done = await page.getByTestId('dlv-band').getByTestId(`dlv-todo-${todo}`).getAttribute('data-done');
    if (done === 'true') expect(tone, `${todo} is done`).toBe('ok');
    else expect(tone, `${todo} is open`).not.toBe('ok');
  }
}

test.describe('step dashboard', () => {
  test('each stepper button opens its dashboard, and every tile agrees with the exit criteria', async ({ page }) => {
    await go(page, '/home');
    const stepper = page.getByTestId('proj-stepper');
    for (const step of STEPS) {
      await stepper.locator(`[data-step="${step}"]`).click();
      await expect(page).toHaveURL(new RegExp(`#/step\\?step=${step}`));
      await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', step);
      await expect(stepper.locator(`[data-step="${step}"]`)).toHaveAttribute('aria-current', 'step');
      await expect(page.getByTestId('step-dash-tile-doc')).toBeVisible();
      await expectTilesMatchBand(page);
      const band = (await page.getByTestId('dlv-progress').textContent())!.match(/\d+\/\d+/)![0];
      await expect(page.getByTestId('step-dash-progress')).toContainText(band);
    }
    expect(await scan(page)).toEqual([]);
  });

  test('a tile reflects a change to the underlying data and links to where the work is done', async ({ page }) => {
    await go(page, '/step?step=asis');
    const doc = page.getByTestId('step-dash-tile-doc');
    await expect(doc).toHaveAttribute('data-tone', 'open');
    await page.getByTestId('step-dash-open').click();
    await expect(page).toHaveURL(/#\/deliverables\?step=asis/);
    for (const field of STEP_DEFS.asis.fields) {
      await page.getByTestId(`dlv-field-${field.id}`).fill('2026-11-09 16');
    }
    await page.goto('/#/step?step=asis');
    await expect(doc).toHaveAttribute('data-tone', 'ok');
    await expect(page.getByTestId('step-dash-sign-asis-field')).toHaveAttribute('data-done', 'false');
    await expectTilesMatchBand(page);

    await page.getByTestId('step-dash-tile-decisions').click();
    await expect(page).toHaveURL(/#\/discussion/);
  });

  test('a new project shows "no data" instead of a false completion', async ({ page }) => {
    await go(page, '/projects');
    await page.getByTestId('proj-company-name').fill('ダッシュ社');
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.getByTestId('proj-project-name-ダッシュ社').fill('空Project');
    await page.getByRole('button', { name: 'Project を作成' }).click();
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: '空Project' }).click();
    await page.getByTestId('proj-stepper').locator('[data-step="asis"]').click();
    const tile = page.getByTestId('step-dash-tile-decisions');
    await expect(tile).toHaveAttribute('data-tone', 'empty');
    await expect(tile).toContainText('データなし');
    await expect(page.getByTestId('step-dash-next')).toBeVisible();
    await expect(page.locator('.step-dash-tile[data-tone="ok"]:not([data-todo])')).toHaveCount(0);
    await expectTilesMatchBand(page);
  });

  test('English: the dashboard has no Japanese and passes axe', async ({ page }) => {
    await go(page, '/step?step=kpi', 'en');
    await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', 'kpi');
    for (const step of STEPS) {
      await page.getByTestId('proj-stepper').locator(`[data-step="${step}"]`).click();
      await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', step);
      expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    }
    expect(await scan(page)).toEqual([]);
  });

  test('each step shows its decision chart, a data table alternative and a rule-based executive summary', async ({ page }) => {
    await go(page, '/step?step=asis');
    const charts: Record<(typeof STEPS)[number], string[]> = {
      asis: ['matrix', 'pareto', 'gap'], tobe: [], kpi: ['quality'], solution: ['range', 'bridge'], deliverable: ['gantt', 'payback'],
    };
    for (const step of STEPS) {
      await page.getByTestId('proj-stepper').locator(`[data-step="${step}"]`).click();
      await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', step);
      const brief = page.getByTestId('step-dash-brief');
      await expect(brief.getByTestId('step-dash-brief-answer')).not.toBeEmpty();
      await expect(brief.getByTestId('step-dash-brief-ledger')).toBeVisible();
      await expect(brief.getByTestId('step-dash-brief-maturity')).toHaveAttribute('data-maturity', /^(hypothesis|evidenced|agreed)$/);
      for (const id of charts[step]) {
        const chart = page.getByTestId(`step-dash-chart-${id}`);
        const empty = page.getByTestId(`step-dash-chart-${id}-empty`);
        await expect(chart.or(empty)).toBeVisible();
        if (await chart.isVisible()) {
          await expect(chart.locator('[role="img"]')).toHaveAccessibleName(/\S/);
          const data = page.getByTestId(`step-dash-chart-${id}-data`);
          await data.locator('summary').click();
          await expect(data.locator('table')).toBeVisible();
        }
      }
      expect(await scan(page), step).toEqual([]);
    }
  });

  test('the asis Pareto marks the vital few up to 80% and the payback chart flags solutions over the limit', async ({ page }) => {
    await go(page, '/step?step=asis');
    const rows = page.getByTestId('step-dash-chart-pareto').locator('.step-chart-row');
    await expect(rows.first()).toHaveAttribute('data-vital', 'true');
    await expect(page.getByTestId('step-dash-chart-pareto').locator('.step-chart-bar.is-brand').first()).toBeVisible();
    await page.goto('/#/step?step=deliverable');
    const pay = page.getByTestId('step-dash-chart-payback').or(page.getByTestId('step-dash-chart-payback-empty'));
    await expect(pay).toBeVisible();
    await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', 'deliverable');
    const bars = page.getByTestId('step-dash-chart-payback').locator('.step-chart-row');
    for (let i = 0; i < await bars.count(); i++) {
      const ok = await bars.nth(i).getAttribute('data-ok');
      await expect(bars.nth(i).locator(ok === 'true' ? '.step-chart-ok' : '.step-chart-ng')).toBeVisible();
    }
  });

  test('[Copilot で生成] without a live connection shows a labelled mock whose figures all match the fact ledger', async ({ page }) => {
    await go(page, '/step?step=kpi');
    const gen = page.getByTestId('step-dash-brief-generate');
    await expect(gen).toHaveText(/Copilot で生成/);
    await gen.click();
    const ai = page.getByTestId('step-dash-brief-ai');
    await expect(ai).toHaveAttribute('data-mode', 'mock');
    await expect(ai.getByTestId('ai-mock-label')).toBeVisible();
    await expect(ai.getByTestId('step-dash-brief-verified')).toBeVisible();
    await expect(ai.getByTestId('step-dash-brief-unverified')).toHaveCount(0);
    await expect(ai.getByTestId('step-dash-brief-ai-answer')).not.toBeEmpty();
    await expect(ai).toHaveAttribute('data-approved', 'false');
    await ai.getByTestId('step-dash-brief-approve').click();
    await expect(ai).toHaveAttribute('data-approved', 'true');
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await expect(ai).toHaveAttribute('data-approved', 'true');
    await expect(page.getByTestId('step-dash-brief-approved-at')).toContainText('E2E');
    await page.goto('/#/deliverables?step=kpi');
    const sign = page.getByTestId('dlv-exit').getByTestId('dlv-sign-kpi-measure');
    await expect(sign).not.toBeChecked();
    await sign.check();
    await page.goto('/#/step?step=kpi');
    await expect(ai).toHaveAttribute('data-stale', 'true');
    await expect(ai).toHaveAttribute('data-approved', 'false');
    await expect(gen).toHaveText(/再生成/);
    expect(await scan(page)).toEqual([]);
    await gen.click();
    await expect(ai).toHaveAttribute('data-approved', 'false');
    await ai.getByTestId('step-dash-brief-dismiss').click();
    await expect(ai).toHaveCount(0);
  });
});

test.describe('issue qualification (FR-347)', () => {
  test('every issue starts as a yellow light; a verdict needs its reason, "pursue" also what is different, and a "no" leaves the solution path', async ({ page }) => {
    await go(page, '/step?step=asis');
    const tile = page.getByTestId('step-dash-tile-issuesQualified');
    await expect(tile).toHaveAttribute('data-tone', 'open');
    await expect(tile).toHaveAttribute('data-value', '0');
    const issues = page.getByTestId('step-dash-issues');
    const first = issues.locator('tbody tr').first();
    const firstId = (await first.getAttribute('data-issue'))!;
    await expect(page.getByTestId(`qualify-cell-${firstId}`)).toContainText('未判断（黄信号）');

    // The criterion's link opens this table.
    await page.getByTestId('dlv-band').getByTestId('dlv-todo-asis-qualify').getByRole('link', { name: /対応する/ }).click();
    await expect(page).toHaveURL(/#\/step\?step=asis.*target=step-dash-issues/);
    await expect(page.locator('#step-dash-issues')).toBeFocused();

    // "No": the evidence is shown, the reason is required.
    await page.getByTestId(`qualify-open-${firstId}`).click();
    const dialog = page.getByTestId('qualify-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('qualify-evidence')).toContainText('現状');
    expect(await scan(page)).toEqual([]);
    await dialog.getByTestId('qualify-save').click();
    await expect(dialog).toContainText('判断を選んでください。');
    await dialog.getByTestId('qualify-verdict-no').check();
    await expect(dialog.getByTestId('qualify-different')).toHaveCount(0);
    await dialog.getByTestId('qualify-save').click();
    await expect(dialog).toContainText('入力してください。');
    await dialog.getByTestId('qualify-reason').fill('競合も同じ水準で、差の価値が投資に見合わない');
    await dialog.getByTestId('qualify-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`qualify-cell-${firstId}`)).toHaveAttribute('data-verdict', 'no');
    await expect(tile).toHaveAttribute('data-value', '1');

    // "Pursue" asks what is different this time.
    const second = (await issues.locator('tbody tr').nth(1).getAttribute('data-issue'))!;
    await page.getByTestId(`qualify-open-${second}`).click();
    await dialog.getByTestId('qualify-verdict-pursue').check();
    await dialog.getByTestId('qualify-reason').fill('失注の主因で、年 1.2 億円の差');
    await dialog.getByTestId('qualify-save').click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('qualify-different').fill('全社の計画統合が今期の経営方針になった');
    await dialog.getByTestId('qualify-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`qualify-cell-${second}`)).toHaveAttribute('data-verdict', 'pursue');

    // Kept after a reload, with who recorded it; downstream steps say the "no" was left out.
    await page.reload();
    await expect(page.getByTestId(`qualify-cell-${firstId}`)).toHaveAttribute('data-verdict', 'no');
    await page.getByTestId(`qualify-open-${firstId}`).click();
    await expect(dialog.getByTestId('qualify-saved')).toContainText('E2E');
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await page.goto('/#/step?step=solution');
    await expect(page.getByTestId('step-dash-qualified-out')).toContainText('1 件');
    await expect(page.getByTestId('step-dash-issue-solutions').locator(`tr[data-issue="${firstId}"]`)).toHaveCount(0);
    await expectTilesMatchBand(page);
  });

  test('the qualification dialog has no accessibility violations in English', async ({ page }) => {
    await go(page, '/step?step=asis', 'en');
    const id = (await page.getByTestId('step-dash-issues').locator('tbody tr').first().getAttribute('data-issue'))!;
    await page.getByTestId(`qualify-open-${id}`).click();
    const dialog = page.getByTestId('qualify-dialog');
    await dialog.getByTestId('qualify-verdict-pursue').check();
    await expect(dialog.getByTestId('qualify-different')).toBeVisible();
    await expect(dialog).toContainText('What is different this time');
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
  });
});

test.describe('Khalsa advice on every step screen (FR-351)', () => {
  test('each step shows its advice on the dashboard and on the deliverable screen, with links and a next conversation', async ({ page }) => {
    await go(page, '/step?step=asis');
    for (const step of STEPS) {
      await page.goto(`/#/step?step=${step}`);
      const advice = page.getByTestId('step-advice');
      await expect(advice).toBeVisible();
      await expect(advice.getByTestId(`step-advice-ask.${step}`)).toBeVisible();
      await page.goto(`/#/deliverables?step=${step}`);
      await expect(page.getByTestId('step-advice')).toBeVisible();
      await expect(page.getByTestId(`step-advice-ask.${step}`)).toBeVisible();
    }
  });

  test('the advice follows the data: qualifying the issues removes the yellow light, and its link opens the work', async ({ page }) => {
    await go(page, '/step?step=asis');
    const item = page.getByTestId('step-advice-unqualified');
    await expect(item).toHaveAttribute('data-tone', 'yellow');
    await expect(item).toContainText('判断していない課題が 5 件');
    await expect(page.getByTestId('step-advice-summary')).toBeVisible();
    await item.getByRole('link', { name: '対応する' }).click();
    await expect(page.locator('#step-dash-issues')).toBeFocused();
    const rows = page.getByTestId('step-dash-issues').locator('tbody tr');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const id = (await rows.nth(i).getAttribute('data-issue'))!;
      await page.getByTestId(`qualify-open-${id}`).click();
      const dialog = page.getByTestId('qualify-dialog');
      await dialog.getByTestId('qualify-verdict-no').check();
      await dialog.getByTestId('qualify-reason').fill('差は年 4,000 万円で、投資に見合わない');
      await dialog.getByTestId('qualify-save').click();
      await expect(dialog).toBeHidden();
    }
    await expect(page.getByTestId('step-advice-unqualified')).toHaveCount(0);
    await expect(page.getByTestId('step-advice-allDeclined')).toHaveAttribute('data-tone', 'info');
    await page.goto('/#/step?step=solution');
    await expect(page.getByTestId('step-advice-noPursued')).toBeVisible();
  });

  test('the advice panel passes axe on every step in English and has no Japanese', async ({ page }) => {
    await go(page, '/step?step=asis', 'en');
    for (const step of STEPS) {
      await page.goto(`/#/step?step=${step}`);
      await expect(page.getByTestId('step-advice')).toBeVisible();
      await expect(page.getByTestId('step-advice')).toContainText('Advice based on Khalsa');
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await scan(page), step).toEqual([]);
      expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    }
  });
});
