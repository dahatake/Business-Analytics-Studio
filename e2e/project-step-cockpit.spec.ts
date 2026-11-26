import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, scan, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const STEPS = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'] as const;
const SHOTS = process.env.BAS_SHOTS;

async function go(page: Page, route: string, lang: Lang = 'ja') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.ck')) return;
    sessionStorage.setItem('bas.e2e.ck', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: 'E2E', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true, todoCollapsed: true }, version: 1 }));
  });
  await open(page, route, { lang });
}

test.describe('FR-378 step decision view', () => {
  test('each stepper button opens the decision view: question, summary, minimum data and what-if only', async ({ page }) => {
    await go(page, '/home');
    const stepper = page.getByTestId('proj-stepper');
    for (const step of STEPS) {
      await stepper.locator(`[data-step="${step}"]`).click();
      const dash = page.getByTestId('step-dash');
      await expect(dash).toHaveAttribute('data-step', step);
      await expect(dash).toHaveAttribute('data-view', 'decision');
      await expect(page.getByTestId('ck-question')).toBeVisible();
      await expect(page.getByTestId('ck-answer')).not.toBeEmpty();
      await expect(page.getByTestId('ck-cards').locator('li')).toHaveCount(4);
      await expect(page.locator('.ck-hero').first()).toBeVisible();
      // The detail panels are not shown in the decision view.
      await expect(page.getByTestId('step-dash-tiles')).toHaveCount(0);
      await expect(page.getByTestId('strategy-panel')).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/cockpit-${step}.png`, fullPage: true });
      expect(await scan(page), step).toEqual([]);
    }
    await page.getByTestId('step-dash-view-details').click();
    await expect(page.getByTestId('step-dash')).toHaveAttribute('data-view', 'details');
    await expect(page.getByTestId('step-dash-tiles')).toBeVisible();
    await expect(page).toHaveURL(/view=details/);
  });

  test('the issue what-if re-ranks against the baseline, saves and compares scenarios, and resets', async ({ page }) => {
    await go(page, '/step?step=asis');
    const wi = page.getByTestId('ck-wi-issue');
    const headline = wi.getByTestId('ck-wi-issue-headline');
    const before = await headline.getAttribute('data-top');
    expect(before).toBeTruthy();
    // Rescore the current first place: execution 1 and value 1 push it down.
    await wi.getByTestId('ck-wi-issue-item-select').selectOption(before!);
    await wi.getByTestId('ck-wi-issue-score-value').selectOption('1');
    await wi.getByTestId('ck-wi-issue-score-execution').selectOption('1');
    await wi.getByTestId('ck-wi-issue-score-size').selectOption('5');
    await expect(headline).not.toHaveAttribute('data-top', before!);
    const row = wi.locator(`.ck-rank-row[data-id="${before}"]`);
    await expect(row.locator('.ck-delta')).toHaveClass(/is-down/);
    await expect(row).toContainText('変更');
    await wi.getByTestId('ck-wi-issue-save').click();
    await wi.getByTestId('ck-wi-issue-preset-speed').click();
    await expect(wi.getByTestId('ck-wi-issue-preset-speed')).toHaveAttribute('aria-pressed', 'true');
    await wi.getByTestId('ck-wi-issue-tab-compare').click();
    const cmp = wi.getByTestId('ck-wi-issue-compare');
    await expect(cmp.locator('th', { hasText: 'シナリオ A' })).toBeVisible();
    await wi.getByTestId('ck-wi-issue-tab-sensitivity').click();
    await expect(wi.getByTestId('ck-wi-issue-tool-sensitivity').locator('.ck-rank-row')).toHaveCount(6);
    await wi.getByTestId('ck-wi-issue-tab-stability').click();
    await expect(wi.getByTestId('ck-wi-issue-stab-rows')).toBeVisible();
    // The scenario is kept across a reload (project data).
    await page.reload();
    await expect(page.getByTestId('ck-wi-issue-preset-speed')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('ck-wi-issue-reset').click();
    await expect(page.getByTestId('ck-wi-issue-headline')).toHaveAttribute('data-top', before!);
    expect(await scan(page, '[data-testid="ck-wi-issue"]')).toEqual([]);
  });

  test('a budget cap funds the best combination and the frontier shows the trade-off', async ({ page }) => {
    await go(page, '/step?step=solution');
    const wi = page.getByTestId('ck-wi-solution');
    await expect(wi.getByTestId('ck-wi-solution-stat-funded')).toContainText('5 / 5');
    await wi.getByTestId('ck-wi-solution-budget').fill('60');
    await expect(wi.getByTestId('ck-wi-solution-stat-funded')).not.toContainText('5 / 5');
    await expect(wi.getByTestId('ck-wi-solution-stat-cost')).toContainText('60');
    await wi.getByTestId('ck-wi-solution-tab-frontier').click();
    await expect(wi.getByTestId('ck-wi-solution-tool-frontier').locator('.ck-rank-row')).toHaveCount(11);
    await expect(wi.locator('.ck-rank-row.is-mark')).toHaveCount(1);
  });

  test('the KPI what-if moves the required pace with target and deadline', async ({ page }) => {
    await go(page, '/step?step=kpi');
    const wi = page.getByTestId('ck-wi-kpi');
    await expect(wi.getByTestId('ck-wi-kpi-rows').locator('.ck-rank-row').first()).toBeVisible();
    const slider = wi.getByTestId('ck-wi-kpi-deadline');
    await slider.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await expect(wi.getByTestId('ck-wi-kpi-headline')).toContainText('この条件で');
    await expect(wi.getByTestId('ck-wi-kpi-reset')).toBeEnabled();
  });

  test('the last step lists the kinds of action, builds the plan and saves the requirements into the project folder', async ({ page }) => {
    await go(page, '/step?step=deliverable');
    const list = page.getByTestId('ck-solutions');
    const types = list.getByTestId('ck-sol-types-sol-demand-planning');
    for (const type of ['dataPipeline', 'analytics', 'mlModel', 'change']) await expect(types.locator(`[data-type="${type}"]`)).toBeVisible();
    await expect(list.getByTestId('ck-sol-types-sol-knowledge-copilot').locator('[data-type="copilotPrompt"]')).toBeVisible();
    // Add an AI agent to the demand-planning solution.
    await list.getByTestId('ck-sol-edit-sol-demand-planning').click();
    await list.getByTestId('ck-sol-type-sol-demand-planning-agent').check();
    await expect(types.locator('[data-type="agent"]')).toBeVisible();
    // Plan with two lanes: the what-if's item cap.
    await page.getByTestId('ck-wi-solution-max').fill('2');
    await page.getByTestId('ck-wi-solution-max').press('Tab');
    await page.getByTestId('ck-wi-solution-use').click();
    // Add the demand-planning solution to the plan by hand.
    await list.getByTestId('ck-sol-include-sol-demand-planning').check();
    await expect(list.locator('[data-solution="sol-demand-planning"]')).toHaveAttribute('data-in-plan', 'true');
    const plan = page.getByTestId('ck-plan');
    await expect(plan.getByTestId('ck-plan-rows').locator('.ck-rank-row').first()).toBeVisible();
    const analytics = plan.locator('.ck-rank-row[data-key="sol-demand-planning:analytics"]');
    const pipeline = plan.locator('.ck-rank-row[data-key="sol-demand-planning:dataPipeline"]');
    expect(Number(await analytics.getAttribute('data-start'))).toBe(Number(await pipeline.getAttribute('data-end')));
    // Save the requirements definition of the demand-planning solution.
    const doc = plan.getByTestId('ck-doc-sol-demand-planning');
    await expect(doc.getByTestId('ck-doc-file-sol-demand-planning')).toHaveText('需要予測と生産計画の最適化-Production-Requirements-Definision.md');
    await doc.getByTestId('ck-doc-save-sol-demand-planning').click();
    await expect(plan.getByTestId('ck-doc-message')).toContainText('Production-Requirements-Definision.md');
    const path = (await doc.getByTestId('ck-doc-path-sol-demand-planning').textContent())!;
    try {
      expect(existsSync(path)).toBe(true);
      const md = readFileSync(path, 'utf8');
      expect(md).toContain('# 需要予測と生産計画の最適化 — 本番開発の要求定義書');
      expect(md).toContain('エージェントのループを持つ AI エージェントの開発');
      expect(md).toContain('【要記入】');
      // Saving again asks before replacing the file.
      await doc.getByTestId('ck-doc-save-sol-demand-planning').click();
      await expect(page.getByTestId('ck-doc-exists')).toBeVisible();
      await page.getByTestId('ck-doc-exists').getByRole('button', { name: '上書きする' }).click();
      await expect(plan.getByTestId('ck-doc-message')).toContainText('1 件を保存しました');
      expect(await scan(page)).toEqual([]);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  test('English decision views contain no Japanese and pass axe', async ({ page }) => {
    await go(page, '/home', 'en');
    for (const step of STEPS) {
      await page.goto(`/#/step?step=${step}`);
      await expect(page.getByTestId('ck-question')).toBeVisible();
      const text = await visibleTextExcludingOtherLang(page, 'en');
      expect(text.match(new RegExp(`.{0,40}${JAPANESE.source}.{0,20}`, 'g')), step).toBeNull();
      expect(await scan(page), step).toEqual([]);
    }
  });
});
