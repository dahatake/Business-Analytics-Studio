import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function go(page: Page, route: string, lang: Lang = 'ja') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.dlv')) return;
    sessionStorage.setItem('bas.e2e.dlv', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: 'E2E', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true, todoCollapsed: false }, version: 1 }));
  });
  await open(page, route, { lang });
}

test.describe('step deliverables and to-do band', () => {
  test('the step signal follows task completion, survives reload, and clears when work is undone', async ({ page }) => {
    await go(page, '/home');
    const steps = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'] as const;
    const stepper = page.getByTestId('proj-stepper');
    for (const step of steps) await expect(stepper.locator(`[data-step="${step}"]`)).toHaveAttribute('data-complete', 'false');
    const button = stepper.locator('[data-step="asis"]');
    await button.click();
    await page.getByTestId('dlv-draft').click();
    await page.getByTestId('dlv-draft-apply').click();
    await expect(button).toHaveAttribute('data-complete', 'false'); // Draft alone is not sign-off.
    await page.getByTestId('dlv-sign-asis-field').check();
    await expect(button).toHaveAttribute('data-complete', 'false');
    await page.getByTestId('dlv-sign-define-agree').check();
    await expect(button).toHaveAttribute('data-complete', 'true');
    await expect(button).toHaveAccessibleName(/完了/);
    await expect(button.locator('.proj-step-check')).toBeVisible();
    const rgb = await button.evaluate((el) => getComputedStyle(el).backgroundColor.match(/\d+/g)!.map(Number));
    expect(rgb[1]).toBeGreaterThan(rgb[0]!);
    expect(rgb[1]).toBeGreaterThan(rgb[2]!);
    await page.getByTestId('dlv-sign-define-agree').uncheck();
    await expect(button).toHaveAttribute('data-complete', 'false');
    await page.getByTestId('dlv-sign-define-agree').check();
    // Drafting and signing the to-be step is not enough: the project is not yet tied to a company objective.
    await stepper.locator('[data-step="tobe"]').click();
    await page.getByTestId('dlv-draft').click();
    await page.getByTestId('dlv-draft-apply').click();
    await page.getByTestId('dlv-sign-tobe-agree').check();
    await expect(stepper.locator('[data-step="tobe"]')).toHaveAttribute('data-complete', 'false');
    await expect(page.getByTestId('dlv-todo-tobe-link')).toHaveAttribute('data-done', 'false');
    await page.reload();
    await expect(button).toHaveAttribute('data-complete', 'true');
    expect(await scan(page)).toEqual([]);

    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('dlv-field-problem').fill('数値がない');
    await expect(button).toHaveAttribute('data-complete', 'false');

    // Completion belongs to the project, not the device or the previously selected step.
    await page.goto('/#/projects');
    await page.getByTestId('proj-company-name').fill('完了検証社');
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.getByTestId('proj-project-name-完了検証社').fill('未完了Project');
    await page.getByRole('button', { name: 'Project を作成' }).click();
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: '未完了Project' }).click();
    for (const step of steps) await expect(stepper.locator(`[data-step="${step}"]`)).toHaveAttribute('data-complete', 'false');
  });

  test('the fix link in every step opens and focuses the first incomplete deliverable field', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 750 });
    await go(page, '/home');
    const steps = [
      ['asis', 'asis-doc', 'problem'],
      ['tobe', 'tobe-doc', 'vision'],
      ['kpi', 'kpi-doc', 'kpiTree'],
      ['solution', 'uc-doc', 'options'],
      ['deliverable', 'plan-doc', 'roadmap'],
    ] as const;
    for (const [step, todo, field] of steps) {
      await page.locator(`.proj-step[data-step="${step}"]`).click();
      const fix = page.getByTestId('dlv-band').getByTestId(`dlv-todo-${todo}`).getByRole('link', { name: /対応する/ });
      await fix.click();
      const input = page.getByTestId(`dlv-field-${field}`);
      await expect(input).toBeFocused();
      await expect(page.getByTestId(`dlv-tab-${step}`)).toHaveAttribute('aria-selected', 'true');
      const top = await input.boundingBox();
      const chrome = await page.locator('.chrome').boundingBox();
      expect(top!.y).toBeGreaterThanOrEqual(chrome!.y + chrome!.height);
      expect(top!.y + top!.height).toBeLessThanOrEqual(750);

      // Reusing the same link must focus it again even though the hash does not change.
      await page.locator('#main').focus();
      await fix.click();
      await expect(input).toBeFocused();
    }
    // A warning in a previously drafted document targets the specific invalid field, not the first field.
    await page.locator('.proj-step[data-step="asis"]').click();
    await page.getByTestId('dlv-draft').click();
    await page.getByTestId('dlv-draft-apply').click();
    await page.getByTestId('dlv-next').click();
    await expect(page.locator('#dlv-sign-asis-field')).toBeFocused();
    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('dlv-field-impact').fill('要改善');
    await page.getByTestId('dlv-band').getByTestId('dlv-todo-asis-doc').getByRole('link', { name: /対応する/ }).click();
    await expect(page.getByTestId('dlv-field-impact')).toBeFocused();
    expect(await scan(page)).toEqual([]);
  });

  test('component targets work across lazy screens and same-screen tab changes', async ({ page }) => {
    await go(page, '/home');
    const targets = [
      ['/analysis?target=proj-method-panel', 'proj-method-panel'],
      ['/analysis?tab=kpi&target=proj-kpi-panel', 'proj-kpi-panel'],
      ['/analysis?tab=kpi&target=proj-okr-panel', 'proj-okr-panel'],
      ['/discussion?target=proj-canvas', 'proj-canvas'],
      ['/discussion?target=proj-tree', 'proj-tree'],
      ['/relations?view=table&target=relation-table', 'relation-table'],
      ['/usecases?target=uc-list', 'uc-list'],
      ['/plan?target=gantt-panel', 'gantt-panel'],
      ['/plan?target=plan-table', 'plan-table'],
    ] as const;
    for (const [route, target] of targets) {
      await page.evaluate((hash) => { window.location.hash = hash; }, route);
      await expect(page.locator(`#${target}`)).toBeFocused();
    }
    await page.evaluate(() => { window.location.hash = '/analysis?tab=kpi&target=proj-okr-panel'; });
    await expect(page.locator('#proj-okr-panel')).toBeFocused();
    await page.getByRole('tab', { name: '分析', exact: true }).click();
    await expect(page).not.toHaveURL(/target=/);
    await expect(page.getByTestId('proj-method-panel')).toBeVisible();
  });

  test('the band sits right under the live bar and lists the current step\'s exit criteria', async ({ page }) => {
    await go(page, '/home');
    const band = page.getByTestId('dlv-band');
    await expect(band).toBeVisible();
    const live = await page.getByRole('region', { name: 'ライブフィード' }).boundingBox();
    const news = await page.getByRole('region', { name: '企業ニュース' }).boundingBox();
    const box = await band.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(live!.y + live!.height - 1);
    expect(box!.y).toBeGreaterThanOrEqual(news!.y + news!.height - 1);
    expect(box!.width).toBeGreaterThan(1000); // full width
    await expect(band).toContainText('ステップ 1/5: 現状分析');
    await expect(band).toContainText('成果物: 現状分析レポート（課題定義を含む）');
    // Demo: the data checks pass; the deliverable fields, the field check and the sponsor's agreement are still open.
    await expect(page.getByTestId('dlv-progress')).toHaveText('8/11 完了');
    await expect(page.getByTestId('dlv-todo-define-sources')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-todo-asis-doc')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('dlv-result-asis-doc')).toHaveText('未記入 10 項目、数値・期限が足りない 0 項目');
    // The head line says what to do next, and the open criteria come first in the list.
    await expect(page.getByTestId('dlv-next')).toHaveAttribute('data-todo', 'asis-doc');
    await expect(page.getByTestId('dlv-next')).toContainText('次にやること:');
    await expect(band.locator('.dlv-band-list > li').first()).toHaveAttribute('data-done', 'false');
    expect(await scan(page)).toEqual([]);
  });

  test('Draft with Copilot fills the deliverable, the sign-off completes the step', async ({ page }) => {
    await go(page, '/home');
    await page.getByTestId('dlv-draft').click();
    const dialog = page.getByTestId('dlv-draft-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('dlv-draft-mode')).toHaveAttribute('data-mode', 'mock');
    await expect(dialog.getByTestId('dlv-draft-mode')).toContainText('モック');
    await expect(dialog.getByTestId('dlv-draft-field-problem')).toContainText('受注から出荷までが長い');
    expect(await scan(page)).toEqual([]);
    await dialog.getByTestId('dlv-draft-apply').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('dlv-progress')).toHaveText('9/11 完了');
    await page.getByTestId('dlv-sign-asis-field').check();
    await page.getByTestId('dlv-sign-define-agree').check();
    await expect(page.getByTestId('dlv-progress')).toHaveText('完了条件をすべて満たしました');
    await expect(page.getByTestId('dlv-result-define-agree')).toContainText('E2E が確認');
    await expect(page.getByTestId('dlv-band')).toHaveAttribute('data-complete', 'true');
    await expect(page.getByTestId('dlv-next')).toHaveCount(0);

    // The deliverable screen shows the drafted fields as AI (mock) and re-judges edits immediately.
    await page.getByTestId('dlv-open').click();
    await expect(page).toHaveURL(/#\/deliverables\?step=asis/);
    await expect(page.getByTestId('dlv-name')).toHaveText('現状分析レポート（課題定義を含む）');
    const problem = page.getByTestId('dlv-field-problem');
    await expect(problem).toHaveValue(/16 日/);
    await expect(page.getByTestId('dlv-fields').getByText('モック').first()).toBeVisible();
    await problem.fill('リードタイムを短くする');
    await expect(page.getByText('数値を入れてください')).toBeVisible();
    await expect(page.getByTestId('dlv-screen-progress')).toHaveText('10/11 完了');
    expect(await scan(page)).toEqual([]);

    // Kept after a reload (project-scoped storage).
    await page.reload();
    await expect(page.getByTestId('dlv-field-problem')).toHaveValue('リードタイムを短くする');
  });

  test('the band follows the stepper; each step has its own deliverable', async ({ page }) => {
    await go(page, '/home');
    await page.locator('.proj-step[data-step="deliverable"]').click();
    const band = page.getByTestId('dlv-band');
    await expect(band).toContainText('ステップ 5/5: 要求定義・成果物');
    await expect(band).toContainText('最終成果物（要求定義書・施策計画）');
    await expect(page.getByTestId('dlv-todo-plan-schedule')).toHaveAttribute('data-done', 'true');
    await page.getByTestId('dlv-draft').click();
    await expect(page.getByTestId('dlv-draft-field-businessCase')).toContainText('回収');
    await page.getByTestId('dlv-draft-apply').click();
    await expect(page.getByTestId('dlv-todo-plan-doc')).toHaveAttribute('data-done', 'true');
  });

  test('a new project starts with failing checks that link to where the work is done', async ({ page }) => {
    await go(page, '/projects');
    await page.getByTestId('proj-company-name').fill('検証社');
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.getByTestId('proj-project-name-検証社').fill('新規');
    await page.getByRole('button', { name: 'Project を作成' }).click();
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: '新規' }).click();
    const decision = page.getByTestId('dlv-todo-define-decision');
    await expect(decision).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('dlv-result-define-decision')).toHaveText('論点がまだありません');
    await decision.getByRole('link', { name: /対応する/ }).click();
    await expect(page).toHaveURL(/#\/discussion/);
    await expect(page.locator('#proj-tree')).toBeFocused();
    await expect(page.getByTestId('dlv-progress')).toHaveText('6/11 完了');
  });

  test('automatic mode: summary only on short windows, full list on tall ones', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: '', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true }, version: 1 }));
    });
    await open(page, '/home');
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-progress')).toHaveText('8/11 完了');
    await page.setViewportSize({ width: 1600, height: 1400 });
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('dlv-todo-asis-doc')).toBeVisible();
    const bottom = await page.getByTestId('dlv-band').evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
    expect(bottom).toBeLessThanOrEqual(1400 * 0.35);
    // At a shorter viewport the fixed area and list no longer fit within 35% of the height.
    await page.setViewportSize({ width: 1440, height: 789 });
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('numbers in the text are reconciled with the KPIs; the payback hurdle is the project\'s own', async ({ page }) => {
    await go(page, '/deliverables?step=asis');
    const exit = page.getByTestId('dlv-exit');
    await expect(exit.getByTestId('dlv-todo-asis-reconcile')).toHaveAttribute('data-done', 'true');
    await expect(exit.getByTestId('dlv-result-asis-reconcile')).toContainText('KPI の値と一致');

    await page.getByTestId('dlv-tab-deliverable').click();
    const payback = page.getByTestId('dlv-todo-plan-payback');
    await expect(payback).toContainText('3 年以内（構築期間を含む）');
    await expect(payback).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-payback-source')).toContainText('アプリの仮定');
    expect(await scan(page)).toEqual([]);
    const limit = page.getByTestId('dlv-payback-limit');
    await limit.fill('1');
    await limit.press('Enter');
    await expect(payback).toHaveAttribute('data-done', 'false');
    await expect(payback).toContainText('1 年以内');
    await expect(page.getByTestId('dlv-payback-source')).toContainText('E2E が 1 年に設定');
    await page.reload();
    await expect(page.getByTestId('dlv-payback-limit')).toHaveValue('1');
    await page.getByTestId('dlv-payback-reset').click();
    await expect(page.getByTestId('dlv-todo-plan-payback')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-payback-limit')).toHaveValue('3');
  });

  test('the band can be collapsed and stays collapsed', async ({ page }) => {
    await go(page, '/home');
    const toggle = page.getByTestId('dlv-band-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-todo-asis-doc')).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-progress')).toBeVisible();
  });

  test('solution step: confirming a type and estimating a contribution feeds the KPI simulation and the linked deliverable', async ({ page }) => {
    await go(page, '/deliverables?step=solution');
    await expect(page.getByTestId('dlv-todo-sol-type')).toHaveAttribute('data-done', 'false');
    const sol = page.getByTestId('sol-solution-sol-energy-twin');
    await sol.evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await page.getByTestId('sol-type-sol-energy-twin').selectOption('process');
    await page.getByTestId('sol-contrib-add-sol-energy-twin').click();
    await page.getByTestId('sol-c-lever').fill('切替拠点');
    await page.getByTestId('sol-c-unit').fill('拠点');
    for (const [k, v] of [['low', '3'], ['mode', '4'], ['high', '5']] as const) await page.getByTestId(`sol-c-amount-${k}`).fill(v);
    for (const [k, v] of [['low', '50'], ['mode', '80'], ['high', '100']] as const) await page.getByTestId(`sol-c-effect-${k}`).fill(v);
    await page.getByTestId('sol-c-ramp').fill('2026-12-01');
    await page.getByTestId('sol-c-full').fill('2027-01-31');
    await page.getByTestId('sol-c-save').click();
    await expect(page.getByTestId('sol-sim-kpi-co2')).toBeVisible();
    await expect(page.getByTestId('sol-sim-prob-kpi-co2')).toHaveText(/%/);
    await expect(page.getByTestId('sol-thread-solution-sol-energy-twin')).toBeVisible();
    await page.getByTestId('dlv-tab-deliverable').click();
    await expect(page.getByTestId('sol-doc-state-sol-energy-twin')).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.reload();
    await page.getByTestId('dlv-tab-solution').click();
    await expect(page.getByTestId('sol-sim-kpi-co2')).toBeVisible();
  });

  test('English: the band, the draft and the deliverable screen have no Japanese', async ({ page }) => {
    await go(page, '/deliverables?step=kpi', 'en');
    await expect(page.getByTestId('dlv-name')).toHaveText('KPI/OKR definition (measurement plan)');
    await page.getByTestId('dlv-screen-draft').click();
    await expect(page.getByTestId('dlv-draft-dialog')).toContainText('Draft: KPI/OKR definition');
    await page.getByTestId('dlv-draft-apply').click();
    await expect(page.getByTestId('dlv-field-formula')).toHaveValue(/lower is better/);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    expect(await scan(page)).toEqual([]);
  });
});
