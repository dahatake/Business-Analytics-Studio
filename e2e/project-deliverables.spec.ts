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
  test('the band sits right under the live bar and lists the current step\'s exit criteria', async ({ page }) => {
    await go(page, '/home');
    const band = page.getByTestId('dlv-band');
    await expect(band).toBeVisible();
    const live = await page.locator('.live-feed').boundingBox();
    const box = await band.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(live!.y + live!.height - 1);
    expect(box!.width).toBeGreaterThan(1000); // full width
    await expect(band).toContainText('ステップ 1/5: 課題定義');
    await expect(band).toContainText('成果物: 課題定義書');
    // Demo: the data checks pass; the deliverable fields and the sponsor's agreement are still open.
    await expect(page.getByTestId('dlv-progress')).toHaveText('4/6 完了');
    await expect(page.getByTestId('dlv-todo-define-sources')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-todo-define-doc')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('dlv-result-define-doc')).toHaveText('未記入 7 項目、数値・期限が足りない 0 項目');
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
    await expect(page.getByTestId('dlv-progress')).toHaveText('5/6 完了');
    await page.getByTestId('dlv-sign-define-agree').check();
    await expect(page.getByTestId('dlv-progress')).toHaveText('完了条件をすべて満たしました');
    await expect(page.getByTestId('dlv-result-define-agree')).toContainText('E2E が確認');
    await expect(page.getByTestId('dlv-band')).toHaveAttribute('data-complete', 'true');

    // The deliverable screen shows the drafted fields as AI (mock) and re-judges edits immediately.
    await page.getByTestId('dlv-open').click();
    await expect(page).toHaveURL(/#\/deliverables\?step=define/);
    await expect(page.getByTestId('dlv-name')).toHaveText('課題定義書');
    const success = page.getByTestId('dlv-field-success');
    await expect(success).toHaveValue(/2027-03-31/);
    await expect(page.getByTestId('dlv-fields').getByText('モック').first()).toBeVisible();
    await success.fill('リードタイムを短くする');
    await expect(page.getByText('数値を入れてください')).toBeVisible();
    await expect(page.getByTestId('dlv-screen-progress')).toHaveText('5/6 完了');
    expect(await scan(page)).toEqual([]);

    // Kept after a reload (project-scoped storage).
    await page.reload();
    await expect(page.getByTestId('dlv-field-success')).toHaveValue('リードタイムを短くする');
  });

  test('the band follows the stepper; each step has its own deliverable', async ({ page }) => {
    await go(page, '/home');
    await page.locator('.proj-step[data-step="plan"]').click();
    const band = page.getByTestId('dlv-band');
    await expect(band).toContainText('ステップ 5/5: 施策計画');
    await expect(band).toContainText('施策計画書（ロードマップと投資対効果）');
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
    await expect(page.getByTestId('dlv-progress')).toHaveText('3/6 完了');
  });

  test('automatic mode: summary only on short windows, full list on tall ones', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: '', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true }, version: 1 }));
    });
    await open(page, '/home');
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-progress')).toHaveText('4/6 完了');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('dlv-todo-define-doc')).toBeVisible();
    // 1440×900 (browser chrome excluded): the head and the open list would take 40 % (> 35 %) of the height, so it closes again.
    await page.setViewportSize({ width: 1440, height: 789 });
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('numbers in the text are reconciled with the KPIs; the payback hurdle is the project\'s own', async ({ page }) => {
    await go(page, '/deliverables?step=asis');
    await expect(page.getByTestId('dlv-todo-asis-reconcile')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-result-asis-reconcile')).toContainText('KPI の値と一致');

    await page.getByTestId('dlv-tab-plan').click();
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
    await expect(page.getByTestId('dlv-todo-define-doc')).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-progress')).toBeVisible();
  });

  test('English: the band, the draft and the deliverable screen have no Japanese', async ({ page }) => {
    await go(page, '/deliverables?step=kpi', 'en');
    await expect(page.getByTestId('dlv-name')).toHaveText('KPI definition and measurement plan');
    await page.getByTestId('dlv-screen-draft').click();
    await expect(page.getByTestId('dlv-draft-dialog')).toContainText('Draft: KPI definition');
    await page.getByTestId('dlv-draft-apply').click();
    await expect(page.getByTestId('dlv-field-formula')).toHaveValue(/lower is better/);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    expect(await scan(page)).toEqual([]);
  });
});
