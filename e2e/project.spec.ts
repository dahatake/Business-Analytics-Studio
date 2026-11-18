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
  for (const scheme of ['light', 'dark'] as const) {
    test(`header preserves selected and focused states in ${scheme} forced colors`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
      await go(page, '/relations', 'en');
      const current = page.locator('.proj-step[data-step="asis"]');
      const other = page.locator('.proj-step[data-step="tobe"]');
      const english = page.getByRole('button', { name: 'English', exact: true });
      const japanese = page.getByRole('button', { name: '日本語', exact: true });
      const motion = page.getByTestId('motion-toggle');
      const systemColors = await page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const color = (value: string) => {
          probe.style.color = value;
          return getComputedStyle(probe).color;
        };
        const result = { highlight: color('Highlight'), buttonText: color('ButtonText'), canvasText: color('CanvasText') };
        probe.remove();
        return result;
      });
      const border = (selector: import('@playwright/test').Locator) => selector.evaluate((el) => getComputedStyle(el).borderTopColor);

      await expect(english).toHaveAttribute('aria-pressed', 'true');
      await expect(motion).toHaveAttribute('aria-pressed', 'true');
      await expect(current).toHaveAttribute('aria-current', 'step');
      expect(await border(current)).toBe(systemColors.highlight);
      expect(await border(other)).not.toBe(systemColors.highlight);
      expect(await border(english)).toBe(systemColors.highlight);
      expect(await border(japanese)).not.toBe(systemColors.highlight);
      expect(await border(motion)).toBe(systemColors.highlight);
      await expect(motion).toHaveCSS('border-top-width', '2px');
      for (const element of [page.getByTestId('sample-pack-badge'), page.locator('.proj-target-prefix'), page.locator('.proj-target-name')]) {
        expect([systemColors.buttonText, systemColors.canvasText]).toContain(await element.evaluate((el) => getComputedStyle(el).color));
      }

      await english.focus();
      const outline = await english.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, color: getComputedStyle(el).outlineColor }));
      expect(outline.style).not.toBe('none');
      expect(outline.color).toBe(systemColors.highlight);
      await motion.click();
      await expect(motion).toHaveAttribute('aria-pressed', 'false');
      await expect(motion).toHaveCSS('border-top-width', '1px');
      await page.mouse.move(0, 0);
      await english.focus();
      expect(await border(motion)).not.toBe(systemColors.highlight);
      await other.click();
      await expect(other).toHaveAttribute('aria-current', 'step');
      expect(await border(other)).toBe(systemColors.highlight);
      expect(await border(current)).not.toBe(systemColors.highlight);
      await japanese.click();
      await expect(japanese).toHaveAttribute('aria-pressed', 'true');
      expect(await border(japanese)).toBe(systemColors.highlight);
      expect(await border(english)).not.toBe(systemColors.highlight);
      const accessibility = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
        .withTags(TAGS).include('header.topbar').analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }

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
    await expect(page).toHaveURL(/#\/$/);
    // FR-186: '/' is the project's main screen, which shows the project workflow (the former analysis overview).
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contoso-Alpha');
    await expect(page.getByTestId('strategy-panel')).toBeVisible();
    await expect(page.getByRole('link', { name: 'メイン画面' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation').getByRole('link', { name: '概要', exact: true })).toHaveCount(0);
    await expect(page.locator('header.topbar')).not.toContainText(/青空精機|架空/);
    await expect(page.getByTestId('proj-target-menu')).toContainText('Contoso-Alpha');

    // The choice holds for the session: a reload goes straight to the project overview.
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

    // FR-186: the main screen's h1 is "company-project" of the open target, and the screen is the project workflow,
    // not the company/project quick start.
    await nav(page, '/home');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contoso-Alpha');
    await expect(page.getByTestId('strategy-panel')).toBeVisible();
    await expect(page.getByTestId('strategy-next')).toBeVisible();
    await expect(page.getByTestId('executive-summary')).toBeVisible();
    await expect(page.getByRole('heading', { name: '企業を登録する' })).toHaveCount(0);
    await chooseTarget(page, /^デモ/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('サンプル企業-デモ');
  });

  test('app title opens the main screen by click and keyboard without losing project work', async ({ page }) => {
    await go(page, '/home');
    await createCompanyAndProjects(page, 'Contoso', ['Alpha']);
    await chooseTarget(page, 'Alpha');
    await nav(page, '/discussion');
    await page.getByTestId('proj-theme-title').fill('Keep this project work');
    await page.getByTestId('proj-theme-add').click();
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Keep this project work');

    const title = page.getByRole('button', { name: 'Business Analytics Studio', exact: true });
    const home = page.getByRole('heading', { level: 1, name: 'Contoso-Alpha' });
    const reopenProject = async () => {
      await page.getByRole('button', { name: 'Contoso-Alpha を開く', exact: true }).click();
      await expect(page.getByTestId('proj-target-menu')).toContainText('Contoso-Alpha');
    };
    await title.click();
    await expect(page).toHaveURL(/#\/home/);
    await expect(home).toBeVisible();
    await expect(page.locator('#main')).toBeFocused();
    await page.getByTestId('proj-target-menu').click();
    await page.getByTestId('proj-target-launch').click();
    await expect(page.getByTestId('launch-screen')).toBeVisible();
    await expect(page.getByTestId('launch-company-Contoso')).toContainText('Alpha');
    await reopenProject();
    await nav(page, '/discussion');
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Keep this project work');

    for (const key of ['Enter', 'Space']) {
      await title.focus();
      await title.press(key);
      await expect(page).toHaveURL(/#\/home/);
      await expect(home).toBeVisible();
      await expect(page.locator('#main')).toBeFocused();
      await nav(page, '/discussion');
    }
    await nav(page, '/discussion');
    await expect(page.getByTestId('proj-canvas-title')).toHaveText('Keep this project work');
  });

  test('stepper shows the current step and is operable by keyboard (FR-136, G-006, PARAM-086)', async ({ page }) => {
    await go(page, '/home');
    const stepper = page.getByTestId('proj-stepper');
    const current = stepper.locator('[aria-current="step"]');
    await expect(current).toContainText('現状分析');
    await expect(page.getByTestId('proj-home-step')).toContainText('現状分析');
    const box = await current.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await current.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(current).toContainText('KPI/OKR 定義');
    // Activating a step opens its dashboard (FR-317); focus stays on the stepper for further keyboard use.
    await expect(page).toHaveURL(/#\/step\?step=kpi/);
    await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', 'kpi');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    await expect(current).toContainText('あるべき姿');
    await expect(page.getByTestId('step-dash')).toHaveAttribute('data-step', 'tobe');
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
    const swot = page.getByTestId('proj-tile-swot');
    await expect(swot.getByTestId('proj-result-plot')).toBeVisible();
    await swot.getByRole('radio', { name: '表', exact: true }).check();
    const cell = swot.getByTestId('proj-score-strengths');
    await expect(cell).toHaveText('4.00');
    const t0 = Date.now();
    await page.getByRole('slider', { name: '項目 1 の評価' }).press('Home');
    await expect(cell).not.toHaveText('4.00', { timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(2000);
    const insight = await swot.getByTestId('proj-insight').textContent();
    await page.getByRole('slider', { name: '脅威' }).press('End');
    await expect(swot.getByTestId('proj-insight')).not.toHaveText(insight ?? '', { timeout: 2000 });
    await swot.getByRole('radio', { name: 'グラフ' }).check();
    await expect(swot.getByTestId('proj-result-chart')).toBeVisible();

    // FR-133: add a method to the dashboard and start it; FR-140: AI draft is labelled as mock.
    const ff = page.getByTestId('proj-method-fiveForces');
    await expect(ff).toHaveAttribute('aria-pressed', 'false');
    await ff.click();
    await expect(ff).toHaveAttribute('aria-pressed', 'true');
    const tile = page.getByTestId('proj-tile-fiveForces');
    await tile.getByTestId('proj-start-fiveForces').click();
    await expect(tile.getByTestId('proj-insight')).toHaveText('項目を追加すると結果が表示されます。');
    await page.getByTestId('proj-ai-draft').click();
    await expect(page.getByTestId('proj-ai-note')).toContainText('モック');
    await expect(tile.getByTestId('proj-overall')).toBeVisible();

    // FR-153/154: KPI status text.
    await page.getByRole('tab', { name: 'KPI・OKR' }).click();
    await expect(page.getByTestId('proj-kpi-panel')).toBeVisible();
    await expect(page.getByTestId('proj-okr-panel')).toContainText('納期と品質で選ばれる工場になる');
  });

  test('analysis dashboard: several methods side by side, and selecting an item highlights related items in every tile (FR-135)', async ({ page }) => {
    await go(page, '/analysis');
    await expect(page.getByTestId('proj-method-swot')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('proj-method-bsc')).toHaveAttribute('aria-pressed', 'true');
    const swot = page.getByTestId('proj-tile-swot');
    const bsc = page.getByTestId('proj-tile-bsc');
    // The default view is the d3 dot plot: one dot per item.
    await expect(bsc.getByTestId('proj-result-plot')).toBeVisible();
    await expect(swot.locator('.proj-plot-dot')).not.toHaveCount(0);

    // Hovering a dot shows its details.
    const weakness = swot.getByRole('button', { name: /受注から出荷までが長い/ });
    await weakness.hover();
    await expect(swot.getByTestId('proj-plot-tip')).toContainText('受注から出荷までが長い');

    // An issue (weakness) is measured by KPIs in the BSC and resolved by a solution (opportunity) in the SWOT.
    await weakness.click();
    await expect(weakness).toHaveAttribute('aria-pressed', 'true');
    await expect(weakness).toHaveClass(/is-selected/);
    await expect(page.getByTestId('proj-link-status')).toContainText('受注から出荷までが長い');
    await expect(bsc.getByTestId('proj-link-count-bsc')).toBeVisible();
    await expect(bsc.getByRole('button', { name: /納期遵守率/ })).toHaveClass(/is-related-(same|near)/);
    await expect(swot.getByRole('button', { name: /需要予測と生産計画の最適化/ })).toHaveClass(/is-related-near/);
    await expect(bsc.locator('.proj-plot-dot.is-dimmed').first()).toBeVisible();

    // Arrow keys move the focus from dot to dot; Enter selects the focused dot.
    await weakness.focus();
    await page.keyboard.press('ArrowDown');
    const focused = page.locator('.proj-plot-dot:focus');
    await expect(focused).toHaveCount(1);
    await expect(weakness).not.toBeFocused();
    await page.keyboard.press('Enter');
    await expect(focused).toHaveAttribute('aria-pressed', 'true');
    await expect(weakness).toHaveAttribute('aria-pressed', 'false');
    await weakness.click();

    // The same selection holds in the other views of a tile; the chart overlays the highlighted items' value.
    await bsc.getByRole('radio', { name: 'マトリクス' }).check();
    await expect(bsc.locator('.proj-link-li.is-related', { hasText: '納期遵守率' })).toBeVisible();
    await bsc.getByRole('radio', { name: '表', exact: true }).check();
    await expect(bsc.locator('.proj-link-row.is-related')).not.toHaveCount(0);
    await bsc.getByRole('radio', { name: 'グラフ' }).check();
    await expect(bsc.getByTestId('proj-result-chart')).toHaveClass(/has-highlight/);
    await expect(bsc.getByTestId('proj-chart-hl-customerView')).not.toHaveAttribute('data-value', '');
    await expect(bsc.getByTestId('proj-chart-hl-customerView')).not.toHaveAttribute('width', '0');

    // A click on the empty area of a visual clears the selection, as in BI tools; so does Esc.
    await swot.locator('.proj-plot-bg').click({ position: { x: 4, y: 4 } });
    await expect(weakness).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.is-related, .is-related-same, .is-related-near')).toHaveCount(0);
    await weakness.click();
    await expect(weakness).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(weakness).toHaveAttribute('aria-pressed', 'false');

    // Hiding a method removes its tile, and the choice survives a reload.
    await page.getByTestId('proj-method-bsc').click();
    await expect(bsc).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('proj-tile-swot')).toBeVisible();
    await expect(page.getByTestId('proj-method-bsc')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('proj-tile-bsc')).toBeHidden();
  });

  test('analysis dot plot: editing a score moves the same dot (d3 keyed join), and reduced motion applies it at once (FR-134/135)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/analysis');
    const swot = page.getByTestId('proj-tile-swot');
    const dots = swot.locator('.proj-plot-dot');
    await expect(dots).not.toHaveCount(0);
    // Tag the DOM nodes: a keyed join updates them in place instead of re-creating them.
    const read = () => dots.evaluateAll((els) => els.map((el) => ({
      id: el.getAttribute('data-item-id'),
      cat: el.getAttribute('data-category'),
      score: el.getAttribute('data-score'),
      cx: Number(el.getAttribute('cx')),
      cy: Number(el.getAttribute('cy')),
      tagged: (el as unknown as { bas?: number }).bas === 1,
    })));
    await dots.evaluateAll((els) => els.forEach((el) => { (el as unknown as { bas?: number }).bas = 1; }));
    const before = await read();
    const was = (id: string | null) => before.find((x) => x.id === id)!;
    await page.getByRole('slider', { name: '項目 1 の評価' }).press('Home');
    await expect.poll(async () => (await read()).filter((d) => d.score !== was(d.id).score).length).toBe(1);
    const first = await read();
    const edited = first.find((d) => d.score !== was(d.id).score)!;
    expect(edited.score).toBe('1');
    expect(edited.cx).toBeLessThan(was(edited.id).cx);
    // Other categories keep their layout (a row only shifts as a whole when a row above changes height).
    const others = first.filter((x) => x.cat !== edited.cat);
    expect(others.length).toBeGreaterThan(0);
    for (const d of others) expect(d.cx).toBeCloseTo(was(d.id).cx, 6);
    for (const cat of new Set(others.map((d) => d.cat))) {
      const shifts = others.filter((d) => d.cat === cat).map((d) => d.cy - was(d.id).cy);
      for (const sh of shifts) expect(sh).toBeCloseTo(shifts[0]!, 6);
    }
    await page.waitForTimeout(200);
    // Reduced motion: the first changed frame is already the final position (no transition in flight).
    expect(await read()).toEqual(first);
    expect(first.every((d) => d.tagged)).toBe(true);
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
