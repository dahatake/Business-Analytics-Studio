import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

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
    await page.getByTestId('dlv-draft').click();
    await page.getByTestId('dlv-draft-apply').click();
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
      asis: ['pareto'], tobe: ['gap'], kpi: ['quality'], solution: ['range', 'bridge'], deliverable: ['gantt', 'payback'],
    };
    for (const step of STEPS) {
      await page.getByTestId('proj-stepper').locator(`[data-step="${step}"]`).click();
      await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', step);
      const brief = page.getByTestId('step-dash-brief');
      await expect(brief.getByTestId('step-dash-brief-answer')).not.toBeEmpty();
      await expect(brief.getByTestId('step-dash-brief-ledger')).toBeVisible();
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
    await expect(gen).toHaveText(/再生成/);
    expect(await scan(page)).toEqual([]);
    await ai.getByTestId('step-dash-brief-dismiss').click();
    await expect(ai).toHaveCount(0);
  });
});
