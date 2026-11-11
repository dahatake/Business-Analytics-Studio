import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { JAPANESE, open, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

/** Mark the first-run dialog as seen (once per test, so reloads keep the app's own state). */
async function skipFirstRun(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.proj')) return;
    sessionStorage.setItem('bas.e2e.proj', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: '', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true }, version: 1 }));
  });
}

async function go(page: Page, route: string, lang: Lang = 'ja') {
  await skipFirstRun(page);
  await open(page, route, { lang });
}

/** Navigate inside the running app (keeps in-memory state such as the undo stack). */
async function nav(page: Page, route: string) {
  await page.evaluate((r) => { window.location.hash = r; }, route);
  await expect(page.locator('main#main')).toBeVisible();
}

async function createCompanyAndProjects(page: Page, company: string, projects: string[]) {
  await nav(page, '/projects');
  await page.getByTestId('proj-company-name').fill(company);
  await page.getByRole('button', { name: '登録', exact: true }).click();
  for (const p of projects) {
    await page.getByTestId(`proj-project-name-${company}`).fill(p);
    await page.getByRole('button', { name: 'Project を作成' }).click();
    await expect(page.getByRole('rowheader', { name: p })).toBeVisible();
  }
}

async function chooseTarget(page: Page, name: string | RegExp) {
  await page.getByTestId('proj-target-menu').click();
  await page.getByRole('menuitemradio', { name }).click();
}

test.describe('project module', () => {
  test('start-up: selection screen with the sample company and registered projects, then the project screen (FR-144, FR-267)', async ({ page }) => {
    await open(page, '/home', { skipLaunch: false });
    await expect(page.getByTestId('launch-screen')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('企業と Project を選ぶ');
    await expect(page.getByTestId('launch-sample')).toContainText('サンプル企業');
    await expect(page.getByTestId('launch-sample')).toContainText('デモ Project');
    await expect(page.locator('body')).not.toContainText(/青空精機|架空/);
    expect(await scan(page)).toEqual([]);

    await page.getByTestId('launch-company-name').fill('Contoso');
    await page.getByTestId('launch-project-name').fill('Alpha');
    await page.getByTestId('launch-create').click();
    await expect(page).toHaveURL(/#\/home/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contoso-Alpha');
    await expect(page.locator('header.topbar')).not.toContainText(/青空精機|架空/);
    await expect(page.getByTestId('proj-target-menu')).toContainText('Contoso-Alpha');

    // The choice holds for the session: a reload goes straight to the project screen.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contoso-Alpha');

    await page.getByTestId('proj-target-menu').click();
    await page.getByTestId('proj-target-launch').click();
    await expect(page.getByTestId('launch-company-Contoso')).toContainText('Alpha');
    await page.getByTestId('launch-open-demo').click();
    await expect(page.getByTestId('proj-target-menu')).toContainText('デモ');
    await expect(page.locator('header.topbar')).not.toContainText(/青空精機|架空/);
  });

  test('companies and projects; the top menu switches target and data never mixes (FR-137, FR-138, FR-148, G-007)', async ({ page }) => {
    await go(page, '/home');
    await createCompanyAndProjects(page, 'Contoso', ['Alpha', 'Beta']);
    await expect(page.getByText('2 / 50 件')).toBeVisible();
    expect(await scan(page)).toEqual([]);

    await chooseTarget(page, 'Alpha');
    await expect(page.getByTestId('proj-target-menu')).toContainText('Contoso-Alpha');
    await nav(page, '/discussion');
    await expect(page.getByTestId('proj-tree')).toContainText('論点はまだありません。');
    await page.getByTestId('proj-theme-title').fill('Alpha only theme');
    await page.getByTestId('proj-theme-add').click();
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Alpha only theme');

    await chooseTarget(page, 'Beta');
    await expect(page.getByTestId('proj-target-menu')).toContainText('Contoso-Beta');
    await expect(page.getByText('Alpha only theme')).toHaveCount(0);
    await expect(page.getByTestId('proj-tree')).toContainText('論点はまだありません。');

    await chooseTarget(page, /^デモ/);
    await expect(page.getByText('Alpha only theme')).toHaveCount(0);
    await expect(page.getByTestId('proj-tree')).toContainText('受注から出荷までのリードタイムを短くする');

    await chooseTarget(page, 'Alpha');
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Alpha only theme');

    // FR-186: the main screen's h1 is "company-project" of the open project (or the last one opened).
    await nav(page, '/home');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contoso-Alpha');
    await chooseTarget(page, /^デモ/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contoso-Alpha');
  });

  test('app title returns to launch by click and keyboard without losing project work', async ({ page }) => {
    await go(page, '/home');
    await createCompanyAndProjects(page, 'Contoso', ['Alpha']);
    await chooseTarget(page, 'Alpha');
    await nav(page, '/discussion');
    await page.getByTestId('proj-theme-title').fill('Keep this project work');
    await page.getByTestId('proj-theme-add').click();
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Keep this project work');

    const title = page.getByRole('button', { name: 'Business Analytics Studio', exact: true });
    const launch = page.getByTestId('launch-screen');
    const reopenProject = async () => {
      await page.getByRole('button', { name: 'Contoso-Alpha を開く', exact: true }).click();
      await expect(page.getByTestId('proj-target-menu')).toContainText('Contoso-Alpha');
    };
    await title.click();
    await expect(launch).toBeVisible();
    await expect(launch).toBeFocused();
    await expect(page.getByTestId('launch-company-Contoso')).toContainText('Alpha');
    await page.reload();
    await expect(launch).toBeVisible();
    await reopenProject();
    await nav(page, '/discussion');
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Keep this project work');

    for (const key of ['Enter', 'Space']) {
      await title.focus();
      await title.press(key);
      await expect(launch).toBeVisible();
      await expect(launch).toBeFocused();
      await reopenProject();
    }
    await nav(page, '/discussion');
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Keep this project work');
  });

  test('stepper shows the current step and is operable by keyboard (FR-136, G-006, PARAM-086)', async ({ page }) => {
    await go(page, '/home');
    const stepper = page.getByTestId('proj-stepper');
    const current = stepper.locator('[aria-current="step"]');
    await expect(current).toContainText('課題定義');
    await expect(page.getByTestId('proj-home-step')).toContainText('課題定義');
    const box = await current.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await current.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(current).toContainText('KPI 測定');
    await expect(page.getByTestId('proj-home-step')).toContainText('KPI 測定');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    await expect(current).toContainText('現状分析');
    for (const b of await stepper.getByRole('button').all()) {
      const bb = await b.boundingBox();
      expect(bb!.height).toBeGreaterThanOrEqual(44);
      expect(bb!.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('help panel is closed by default and toggles with aria-expanded (FR-266, FR-268)', async ({ page }) => {
    await go(page, '/home');
    const toggle = page.getByTestId('proj-help-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('proj-help')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('proj-help')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'はじめての方へ' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '顧客パックとは' })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('proj-help')).toBeHidden();
    // FR-187: analysis screens lead back to the main screen.
    await nav(page, '/analysis');
    await page.getByTestId('back-to-home').click();
    await expect(page).toHaveURL(/#\/home/);
  });

  test('@perf analysis: changing a parameter updates the result within 2 s (FR-134, PARAM-032) and viewers switch (FR-135)', async ({ page }) => {
    await go(page, '/analysis');
    await expect(page.getByTestId('proj-result-matrix')).toBeVisible();
    await page.getByRole('radio', { name: '表', exact: true }).check();
    const cell = page.getByTestId('proj-score-strengths');
    await expect(cell).toHaveText('4.00');
    const t0 = Date.now();
    await page.getByTestId('proj-item-score-1').fill('1');
    await expect(cell).not.toHaveText('4.00', { timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(2000);
    const insight = await page.getByTestId('proj-insight').textContent();
    await page.getByTestId('proj-weight-threats').fill('5');
    await expect(page.getByTestId('proj-insight')).not.toHaveText(insight ?? '', { timeout: 2000 });
    await page.getByRole('radio', { name: 'グラフ' }).check();
    await expect(page.getByTestId('proj-result-chart')).toBeVisible();

    // FR-133: start a new method; FR-140: AI draft is labelled as mock.
    await page.getByRole('radio', { name: /^ファイブフォース分析/ }).check();
    await page.getByTestId('proj-start-analysis').click();
    await expect(page.getByTestId('proj-insight')).toHaveText('項目を追加すると結果が表示されます。');
    await page.getByTestId('proj-ai-draft').click();
    await expect(page.getByTestId('proj-ai-note')).toContainText('モック');
    await expect(page.getByTestId('proj-overall')).toBeVisible();

    // FR-153/154: KPI status text.
    await page.getByRole('tab', { name: 'KPI・OKR' }).click();
    await expect(page.getByTestId('proj-kpi-panel')).toBeVisible();
    await expect(page.getByTestId('proj-okr-panel')).toContainText('納期と品質で選ばれる工場になる');
  });

  test('discussion: themes, decisions, next actions, undo/redo, export with default name and restore (FR-044〜FR-056)', async ({ page }) => {
    await go(page, '/home');
    await createCompanyAndProjects(page, 'Contoso', ['Alpha']);
    await chooseTarget(page, 'Alpha');
    await nav(page, '/discussion');

    await page.getByTestId('proj-theme-title').fill('Pricing');
    await page.getByTestId('proj-theme-add').click();
    await page.getByTestId('proj-rec-kind').selectOption('decision');
    await page.getByTestId('proj-rec-text').fill('Raise list prices by 3%');
    await page.getByTestId('proj-rec-add').click();
    await page.getByTestId('proj-rec-kind').selectOption('action');
    await page.getByTestId('proj-rec-text').fill('Draft the new price table');
    await page.getByTestId('proj-rec-owner').fill('Aki');
    await page.getByTestId('proj-rec-add').click();
    await expect(page.getByTestId('proj-section-decision')).toContainText('Raise list prices by 3%');
    await expect(page.getByTestId('proj-section-action')).toContainText('Draft the new price table');
    await expect(page.getByTestId('proj-goal-summary')).toContainText('論点 1 件のうち 1 件');

    // Validation (FR-046)
    await page.getByTestId('proj-rec-add').click();
    await expect(page.getByText('入力してください。')).toBeVisible();

    await page.getByTestId('proj-undo').click();
    await expect(page.getByTestId('proj-section-action')).not.toContainText('Draft the new price table');
    await page.getByTestId('proj-redo').click();
    await expect(page.getByTestId('proj-section-action')).toContainText('Draft the new price table');
    await expect(page.getByTestId('proj-history')).toContainText('元に戻す');
    expect(await scan(page)).toEqual([]);

    // Export (FR-051/054): default file name and Markdown content.
    await page.getByTestId('proj-export').click();
    const dialog = page.getByTestId('proj-export-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('proj-export-preview')).toContainText('Raise list prices by 3%');
    const name = await page.getByTestId('proj-export-filename').inputValue();
    expect(name).toMatch(/^Contoso-Alpha-discussion-\d{8}\.md$/);
    const downloadPromise = page.waitForEvent('download', (d) => d.suggestedFilename().includes('-discussion-'));
    await page.getByTestId('proj-export-confirm').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(name);
    const path = await download.path();
    const md = readFileSync(path!, 'utf8');
    expect(md).toContain('#### 決定事項（顧客の決定）');
    expect(md).toContain('- Raise list prices by 3%');

    // Delete the theme, then restore it from the exported Markdown (FR-056).
    await page.getByTestId('proj-canvas').getByRole('button', { name: '削除', exact: true }).first().click();
    await expect(page.getByTestId('proj-tree')).toContainText('論点はまだありません。');
    await page.getByTestId('proj-import').setInputFiles(path!);
    await expect(page.getByTestId('proj-import-msg')).toContainText('論点 1 件・記録 2 件を復元しました');
    await expect(page.getByTestId('proj-section-decision')).toContainText('Raise list prices by 3%');
    await expect(page.getByTestId('proj-section-action')).toContainText('Draft the new price table');
  });

  test('export with people asks for confirmation with count and scope; shortcut opens it (FR-052, FR-219)', async ({ page }) => {
    await go(page, '/discussion');
    await page.keyboard.press('Control+Shift+E');
    await expect(page.getByTestId('proj-export-dialog')).toBeVisible();
    await page.getByTestId('proj-export-confirm').click();
    const confirm = page.getByTestId('proj-persons-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('2 件');
    await expect(confirm).toContainText('すべての論点');
    await confirm.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByTestId('proj-export-dialog')).toBeVisible();
    // External audience: internal items are excluded and reported.
    await page.getByRole('radio', { name: '社外' }).check();
    await expect(page.getByTestId('proj-export-dialog')).toContainText('社外秘の');
    await expect(page.getByTestId('proj-export-preview')).not.toContainText('請求書の電子化で入金を早める');
    await page.getByTestId('proj-export-confirm').click();
    const downloadPromise = page.waitForEvent('download', (d) => d.suggestedFilename().includes('-discussion-'));
    await page.getByTestId('proj-persons-confirm').getByRole('button', { name: '続行してエクスポート' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-デモ-discussion-\d{8}\.md$/);
  });

  test('top-bar export button is always visible', async ({ page }) => {
    await go(page, '/');
    await expect(page.getByTestId('proj-export-all')).toBeVisible();
    await page.getByTestId('proj-export-all').click();
    await expect(page.getByTestId('proj-export-dialog')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const route of ['/home', '/projects', '/analysis', '/analysis?tab=kpi', '/discussion']) {
      test(`axe ${lang} ${route}`, async ({ page }) => {
        await go(page, route, lang);
        await page.waitForTimeout(400);
        expect(await scan(page)).toEqual([]);
      });
    }
  }

  test('axe with the help panel open and with the person confirmation', async ({ page }) => {
    await go(page, '/home', 'en');
    await page.getByTestId('proj-help-toggle').click();
    expect(await scan(page)).toEqual([]);
    await page.getByTestId('proj-export-all').click();
    await page.getByTestId('proj-export-confirm').click();
    await expect(page.getByTestId('proj-persons-confirm')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('English shows no Japanese on the project screens (except user-typed data)', async ({ page }) => {
    await go(page, '/home', 'en');
    for (const route of ['/home', '/projects', '/analysis', '/analysis?tab=kpi', '/discussion']) {
      await nav(page, route);
      await page.waitForTimeout(200);
      const text = await page.evaluate(() => {
        const roots = [document.querySelector('main'), document.querySelector('.proj-topbar')].filter((x): x is Element => !!x);
        const parts: string[] = [];
        for (const r of roots) {
          const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (!el || el.closest('[lang="ja"]')) continue;
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            parts.push(n.textContent ?? '');
          }
          r.querySelectorAll('[aria-label]').forEach((e) => parts.push(e.getAttribute('aria-label') ?? ''));
          r.querySelectorAll('option').forEach((e) => parts.push(e.textContent ?? ''));
        }
        return parts.join('\n');
      });
      const leaked = text.split('\n').filter((l) => JAPANESE.test(l));
      expect(leaked, route).toEqual([]);
    }
  });
});
