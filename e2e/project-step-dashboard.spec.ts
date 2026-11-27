import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, scan, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';
import { STEP_DEFS } from '../src/modules/project/deliverables.ts';

const STEPS = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'] as const;

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
      await page.getByTestId('step-dash-view-details').click();
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
    await go(page, '/step?step=asis&view=details');
    const doc = page.getByTestId('step-dash-tile-doc');
    await expect(doc).toHaveAttribute('data-tone', 'open');
    await page.getByTestId('step-dash-open').click();
    await expect(page).toHaveURL(/#\/deliverables\?step=asis/);
    for (const field of STEP_DEFS.asis.fields) {
      await page.getByTestId(`dlv-field-${field.id}`).fill('2026-11-09 16');
    }
    await page.goto('/#/step?step=asis&view=details');
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
    await page.getByTestId('step-dash-view-details').click();
    const tile = page.getByTestId('step-dash-tile-decisions');
    await expect(tile).toHaveAttribute('data-tone', 'empty');
    await expect(tile).toContainText('データなし');
    await expect(page.getByTestId('step-dash-next')).toBeVisible();
    await expect(page.locator('.step-dash-tile[data-tone="ok"]:not([data-todo])')).toHaveCount(0);
    await expectTilesMatchBand(page);
  });

  test('each step shows its decision chart, a data table alternative and a rule-based executive summary', async ({ page }) => {
    await go(page, '/step?step=asis&view=details');
    const charts: Record<(typeof STEPS)[number], string[]> = {
      asis: ['matrix', 'pareto', 'gap'], tobe: [], kpi: ['quality'], solution: ['range', 'bridge'], deliverable: ['gantt', 'payback'],
    };
    for (const step of STEPS) {
      await page.getByTestId('proj-stepper').locator(`[data-step="${step}"]`).click();
      await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', step);
      await page.getByTestId('step-dash-view-details').click();
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
    await go(page, '/step?step=asis&view=details');
    const rows = page.getByTestId('step-dash-chart-pareto').locator('.step-chart-row');
    await expect(rows.first()).toHaveAttribute('data-vital', 'true');
    await expect(page.getByTestId('step-dash-chart-pareto').locator('.step-chart-bar.is-brand').first()).toBeVisible();
    await page.goto('/#/step?step=deliverable&view=details');
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
    await go(page, '/step?step=kpi&view=details');
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
    await page.goto('/#/step?step=kpi&view=details');
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
    await go(page, '/step?step=asis&view=details');
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
    await page.goto('/#/step?step=solution&view=details');
    await expect(page.getByTestId('step-dash-qualified-out')).toContainText('1 件');
    await expect(page.getByTestId('step-dash-issue-solutions').locator(`tr[data-issue="${firstId}"]`)).toHaveCount(0);
    await expectTilesMatchBand(page);
  });

  test('the qualification dialog has no accessibility violations in English', async ({ page }) => {
    await go(page, '/step?step=asis&view=details', 'en');
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

test.describe('Order by cost of delay, the data each method needs, and a person\'s estimate (FR-365)', () => {
  test('As-is compares CD3 with impact × feasibility, and an estimate changes the order and is kept', async ({ page }) => {
    await go(page, '/step?step=asis&view=details');
    await page.getByTestId('simulation-link').click();
    const panel = page.getByTestId('step-cod');
    await expect(panel).toBeVisible();
    const verdict = panel.getByTestId('step-cod-verdict');
    await expect(verdict).toHaveAttribute('data-verdict', 'differs');
    await expect(verdict).toHaveAttribute('data-pick', 'issue-cash');
    await expect(panel.getByTestId('step-cod-ifpick')).toBeVisible();
    await expect(panel.getByTestId('step-cod-row-issue-cash')).toBeVisible();
    await expect(panel.getByTestId('step-cod-saving')).toHaveText(/16,508,48\d/);
    await expect(panel.getByTestId('step-cod-ready-costOfDelay')).toHaveAttribute('data-status', 'ready');
    await expect(panel.getByTestId('step-cod-ready-costOfDelay')).toHaveAttribute('data-changes', 'yes');
    await expect(panel.getByTestId('step-cod-ready-kano')).toHaveAttribute('data-status', 'notStored');

    await panel.getByTestId('step-cod-sim').locator('summary').click();
    await panel.getByTestId('step-cod-exclude-issue-cash').check();
    await expect(verdict).toHaveAttribute('data-pick', 'issue-lead-time');
    await panel.getByTestId('step-cod-reset').click();
    await expect(verdict).toHaveAttribute('data-pick', 'issue-cash');

    await panel.getByTestId('step-cod-estimate-issue-lead-time').click();
    const dialog = page.getByTestId('cod-est-dialog');
    await dialog.getByTestId('cod-est-duration-low').fill('0.5');
    await dialog.getByTestId('cod-est-duration-mode').fill('0.5');
    await dialog.getByTestId('cod-est-duration-high').fill('0.5');
    await dialog.getByTestId('cod-est-save').click();
    await expect(dialog.getByTestId('cod-est-note')).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByTestId('cod-est-note').fill('Plant manager interview');
    await dialog.getByTestId('cod-est-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(verdict).toHaveAttribute('data-pick', 'issue-lead-time');
    await expect(verdict).toHaveAttribute('data-verdict', 'agree');

    await page.reload();
    await expect(page.getByTestId('step-cod-verdict')).toHaveAttribute('data-pick', 'issue-lead-time');
    await page.getByTestId('step-cod-estimate-issue-lead-time').click();
    await page.getByTestId('cod-est-clear').click();
    await expect(page.getByTestId('step-cod-verdict')).toHaveAttribute('data-pick', 'issue-cash');
    await page.goto('/#/step?step=kpi&view=details');
    await expect(page.getByTestId('step-priority')).toBeVisible();
    await expect(page.getByTestId('step-cod')).toHaveCount(0);
  });

  test('the panel and the estimate dialog pass axe, in English with no Japanese', async ({ page }) => {
    await go(page, '/step?step=asis&view=details', 'en');
    await page.getByTestId('simulation-link').click();
    const panel = page.getByTestId('step-cod');
    await expect(panel).toContainText('Order by cost of delay');
    await panel.getByTestId('step-cod-sim').locator('summary').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    await panel.getByTestId('step-cod-estimate-issue-cash').click();
    await expect(page.getByTestId('cod-est-dialog')).toBeVisible();
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
  });
});

test.describe('Ansoff disposition: impact × urgency from time (FR-383)', () => {
  test('timing an issue turns it into "respond now", puts it first, flags the step and is kept', async ({ page }) => {
    await go(page, '/step?step=asis&view=details');
    await page.getByTestId('simulation-link').click();
    const panel = page.getByTestId('step-triage');
    await expect(panel).toBeVisible();
    const verdict = panel.getByTestId('step-triage-verdict');
    await expect(verdict).toHaveAttribute('data-unassessed', '5');
    await expect(verdict).toHaveAttribute('data-timed', '0');
    await expect(panel.getByTestId('step-triage-untimed')).toBeVisible();
    await expect(panel.getByTestId('step-triage-next-issue')).toHaveAttribute('data-issue', 'issue-lead-time');
    await expect(panel.getByTestId('step-triage-row-issue-skills')).toHaveAttribute('data-order', '5');

    await panel.getByTestId('step-triage-estimate-issue-skills').click();
    const dialog = page.getByTestId('cod-est-dialog');
    for (const [k, v] of [['low', '6'], ['mode', '12'], ['high', '24']] as const) await dialog.getByTestId(`cod-est-impact-${k}`).fill(v);
    for (const [k, v] of [['low', '24'], ['mode', '36'], ['high', '48']] as const) await dialog.getByTestId(`cod-est-duration-${k}`).fill(v);
    await dialog.getByTestId('cod-est-note').fill('HR plan: first retirements within a year');
    await dialog.getByTestId('cod-est-save').click();
    await expect(dialog).toHaveCount(0);
    const row = panel.getByTestId('step-triage-row-issue-skills');
    await expect(row).toHaveAttribute('data-disposition', 'act');
    await expect(row).toHaveAttribute('data-urgency', 'pressing');
    await expect(row).toHaveAttribute('data-order', '1');
    await expect(verdict).toHaveAttribute('data-act', '1');
    await expect(panel.getByTestId('step-triage-act')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('step-triage-row-issue-skills')).toHaveAttribute('data-disposition', 'act');
    await page.goto('/#/step?step=asis&view=details');
    await expect(page.getByTestId('step-priority-emph-pressing')).toBeVisible();
    await page.getByTestId('simulation-link').click();
    await page.getByTestId('step-triage-estimate-issue-skills').click();
    await page.getByTestId('cod-est-clear').click();
    await expect(page.getByTestId('step-triage-row-issue-skills')).toHaveAttribute('data-disposition', 'unassessed');
  });

  test('the panel, its table and the time dialog pass axe, in English with no Japanese', async ({ page }) => {
    await go(page, '/step?step=asis&view=details', 'en');
    await page.getByTestId('simulation-link').click();
    const panel = page.getByTestId('step-triage');
    await expect(panel).toContainText('What to do with each issue');
    await panel.getByTestId('step-triage-anchors').locator('summary').click();
    await panel.getByTestId('step-dash-chart-triage-data').locator('summary').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    await panel.getByTestId('step-triage-next-estimate').click();
    await expect(page.getByTestId('cod-est-impact')).toBeVisible();
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
  });
});

test.describe('Issue diagnosis: every datum to judge, a Copilot draft, a person\'s approval (FR-385)', () => {
  test('the draft covers every issue, approval confirms it, and a person\'s own judgment changes the urgency cycle and is kept', async ({ page }) => {
    await go(page, '/step?step=asis&view=details');
    const panel = page.getByTestId('step-diagnosis');
    await expect(panel).toBeVisible();
    const situation = panel.getByTestId('step-dx-situation');
    await expect(situation).toHaveAttribute('data-cycle', '12');
    await expect(panel.getByTestId('step-dx-situation-evidence')).toContainText('改善');
    await expect(panel.getByTestId('step-dx-noshared')).toBeVisible();
    const rows = panel.locator('[data-testid^="step-dx-row-"]');
    await expect(rows).toHaveCount(5);
    await expect(panel.getByTestId('step-dx-row-issue-skills')).toHaveAttribute('data-state', 'none');
    await expect(panel.getByTestId('step-dx-row-issue-skills')).toContainText('出典');

    // No live connection: the draft is the labelled mock, every issue covered.
    await panel.getByTestId('step-dx-generate').click();
    await expect(panel.getByTestId('step-dx-draft')).toHaveAttribute('data-mode', 'mock');
    await expect(panel.locator('[data-testid^="step-dx-row-"][data-state="draft-rule"]')).toHaveCount(5);
    await expect(panel.getByTestId('step-dx-question-issue-cash')).toContainText('？');
    await expect(situation).toHaveAttribute('data-confirmed', 'none');
    await panel.getByTestId('step-dx-approve-all').click();
    await expect(panel.locator('[data-testid^="step-dx-row-"][data-state="confirmed-rule"]')).toHaveCount(5);
    await expect(panel.getByTestId('step-dx-crux-confirmed')).toBeVisible();
    await expect(situation).not.toHaveAttribute('data-confirmed', 'none');

    // A person's own situation sets the planning cycle of the urgency.
    await situation.getByTestId('step-dx-situation-own').locator('summary').click();
    await situation.getByRole('radio', { name: '立て直し' }).check();
    await situation.getByTestId('step-dx-situation-reason').fill('受注の減少で資金繰りが厳しい');
    await situation.getByTestId('step-dx-situation-save').click();
    await expect(situation).toHaveAttribute('data-confirmed', 'turnaround');
    await expect(situation).toHaveAttribute('data-cycle', '3');

    // A person's framing: the question must end with a question mark.
    await panel.getByTestId('step-dx-edit-issue-cash').click();
    const dialog = page.getByTestId('dx-framing-dialog');
    await dialog.getByTestId('dx-f-question').fill('請求の電子化に投資するか');
    await dialog.getByTestId('dx-f-save').click();
    await expect(dialog.getByTestId('dx-f-question')).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByTestId('dx-f-question').fill('請求の電子化に今期投資するか？');
    await dialog.getByRole('radio', { name: '機会（利得・制御できる）' }).check();
    await dialog.getByTestId('dx-f-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByTestId('step-dx-row-issue-cash')).toHaveAttribute('data-state', 'confirmed-human');
    await expect(panel.getByTestId('step-dx-frame-issue-cash')).toHaveAttribute('data-frame', 'opportunity');

    await page.reload();
    await expect(page.getByTestId('step-dx-row-issue-cash')).toHaveAttribute('data-state', 'confirmed-human');
    await expect(page.getByTestId('step-dx-situation')).toHaveAttribute('data-cycle', '3');
    await page.goto('/#/step?step=kpi&view=details');
    await expect(page.getByTestId('step-priority')).toBeVisible();
    await expect(page.getByTestId('step-diagnosis')).toHaveCount(0);
  });

  test('the panel, its draft and the framing dialog pass axe, in English with no Japanese', async ({ page }) => {
    await go(page, '/step?step=asis&view=details', 'en');
    const panel = page.getByTestId('step-diagnosis');
    await expect(panel).toContainText('Issue diagnosis');
    await panel.getByTestId('step-dx-generate').click();
    await expect(panel.getByTestId('step-dx-draft')).toHaveAttribute('data-mode', 'mock');
    await panel.getByTestId('step-dx-situation-own').locator('summary').click();
    await panel.getByTestId('step-dx-crux-own').locator('summary').click();
    await panel.evaluate((el) => el.scrollIntoView());
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    await panel.getByTestId('step-dx-edit-issue-quality').click();
    await expect(page.getByTestId('dx-framing-dialog')).toBeVisible();
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
  });
});

test.describe('Khalsa advice on every step screen (FR-351)', () => {
  test('each step shows its advice and priority aids (FR-358) on the dashboard and on the deliverable screen', async ({ page }) => {
    await go(page, '/step?step=asis&view=details');
    for (const step of STEPS) {
      await page.goto(`/#/step?step=${step}&view=details`);
      const advice = page.getByTestId('step-advice');
      await expect(advice).toBeVisible();
      await expect(advice.getByTestId(`step-advice-ask.${step}`)).toBeVisible();
      const panel = page.getByTestId('step-priority');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('step-priority-summary')).not.toBeEmpty();
      await expect(panel.getByTestId('step-priority-critique')).not.toBeEmpty();
      expect(await panel.getByTestId('step-priority-sources').getByRole('link').count()).toBeGreaterThan(0);
      await page.goto(`/#/deliverables?step=${step}`);
      await expect(page.getByTestId('step-advice')).toBeVisible();
      await expect(page.getByTestId(`step-advice-ask.${step}`)).toBeVisible();
      await expect(page.getByTestId('step-priority')).toBeVisible();
    }
    await page.goto('/#/step?step=asis&view=details');
    await expect(page.getByTestId('step-priority-candidates')).toBeVisible();
  });

  test('the advice follows the data: qualifying the issues removes the yellow light, and its link opens the work', async ({ page }) => {
    await go(page, '/step?step=asis&view=details');
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
    await page.goto('/#/step?step=solution&view=details');
    await expect(page.getByTestId('step-advice-noPursued')).toBeVisible();
  });

  test('the advice panel and the priority aids (FR-358) pass axe on every step in English and have no Japanese', async ({ page }) => {
    await go(page, '/step?step=asis&view=details', 'en');
    for (const step of STEPS) {
      await page.goto(`/#/step?step=${step}&view=details`);
      await expect(page.getByTestId('step-priority')).toContainText('Priority aids');
      await expect(page.getByTestId('step-advice')).toBeVisible();
      await expect(page.getByTestId('step-advice')).toContainText('Advice based on Khalsa');
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await scan(page), step).toEqual([]);
      expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    }
  });
});

test.describe('Firmness of the issue order and the one check worth making next (FR-364)', () => {
  test('As-is and To-be show rank acceptability, and the simulation re-ranks without saving', async ({ page }) => {
    await go(page, '/step?step=asis&view=details');
    await page.getByTestId('simulation-link').click();
    const panel = page.getByTestId('step-robust');
    await expect(panel).toBeVisible();
    const verdict = panel.getByTestId('step-robust-verdict');
    await expect(verdict).toHaveAttribute('data-verdict', /^(robust|contested)$/);
    await expect(verdict).toHaveAttribute('data-pick', 'issue-lead-time');
    await expect(panel.getByTestId('step-robust-row-issue-lead-time')).toBeVisible();
    await expect(panel.getByTestId('step-robust-next')).toBeVisible();

    await panel.getByTestId('step-robust-sim').locator('summary').click();
    await panel.getByTestId('step-robust-exclude-issue-lead-time').check();
    await expect(verdict).not.toHaveAttribute('data-pick', 'issue-lead-time');
    await expect(panel.getByTestId('step-robust-row-issue-lead-time')).toHaveCount(0);
    await panel.getByTestId('step-robust-reset').click();
    await expect(verdict).toHaveAttribute('data-pick', 'issue-lead-time');

    await page.reload();
    await expect(page.getByTestId('step-robust-verdict')).toHaveAttribute('data-pick', 'issue-lead-time');
    await page.goto('/#/step?step=tobe&view=details');
    await page.getByTestId('simulation-link').click();
    await expect(page.getByTestId('step-robust')).toBeVisible();
    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('simulation-link').click();
    await expect(page.getByTestId('step-robust')).toBeVisible();
    await page.goto('/#/step?step=kpi&view=details');
    await expect(page.getByTestId('step-priority')).toBeVisible();
    await expect(page.getByTestId('step-robust')).toHaveCount(0);
  });

  test('the panel passes axe with the simulation open, in English with no Japanese', async ({ page }) => {
    await go(page, '/step?step=asis&view=details', 'en');
    await page.getByTestId('simulation-link').click();
    const panel = page.getByTestId('step-robust');
    await expect(panel).toContainText('How firm the ranking is');
    await panel.getByTestId('step-robust-sim').locator('summary').click();
    await expect(panel.getByTestId('step-robust-weight')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
  });
});