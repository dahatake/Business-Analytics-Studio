import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang } from './helpers.ts';

/**
 * FR-386 AI First Analytics: the hill climb is shown as a contour map (several heights at once, never a staircase),
 * each business area has its own loop, order contradictions and the roadmap follow from the capability table.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]').analyze();
  return result.violations.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const openCap = (page: Page, id: string) => page.getByTestId(`aif-cap-${id}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });

test.describe('AI First Analytics (FR-386)', () => {
  test('shows each area at its own height with its loop, the contradictions, the roadmap and why it is not linear', async ({ page }) => {
    await open(page, '/aifirst');
    await expect(page.getByRole('heading', { level: 1, name: 'AI First Analytics' })).toBeVisible();
    await expect(page.getByTestId('aif-not-linear')).toContainText('順番に進む工程表ではありません');
    await expect(page.getByTestId('aif-origin')).toHaveAttribute('data-origin', 'demo');

    const map = page.getByTestId('aif-map-svg');
    await expect(map.locator('[data-testid^="aif-marker-"]')).toHaveCount(5);
    await expect(map.locator('[data-stage]')).toHaveCount(5);
    // Several heights at once: P2, P1 and P0 areas, and progress ahead of the position (P3 for demand planning).
    await expect(map.locator('g[data-area="area-skills"]')).toHaveAttribute('data-position', 'p2');
    await expect(map.locator('g[data-area="area-inspection"]')).toHaveAttribute('data-position', 'p1');
    await expect(map.locator('g[data-area="area-demand"] [data-ahead="p3"]')).toHaveCount(1);
    // The skills-transfer loop turns (all four parts on); the inspection loop is open at "observe".
    await expect(page.getByTestId('aif-marker-area-skills').locator('.aif-loop-on')).toHaveCount(4);
    await expect(page.getByTestId('aif-marker-area-inspection').locator('[data-step="observe"]')).toHaveClass('aif-loop-off');

    await expect(page.getByTestId('aif-sum-loops')).toContainText('1 / 5');
    await expect(page.getByTestId('aif-sum-violations')).toHaveAttribute('data-count', '6');
    await expect(page.getByTestId('aif-sum-next')).toContainText('アプリとエージェントの台帳');
    await expect(page.getByTestId('aif-roadmap').locator('tbody tr').first()).toHaveAttribute('data-testid', 'aif-roadmap-registry');
    await expect(page.getByTestId('aif-model-linear')).toHaveAttribute('data-backward', '7');
    await expect(page.getByTestId('aif-model-linear')).toHaveAttribute('data-missing', '4');
    await expect(page.getByTestId('aif-model-revised')).toHaveAttribute('data-backward', '0');
    await expect(page.getByTestId('aif-table').locator('tbody tr')).toHaveCount(5);

    // Keyboard: a marker is a button; Enter selects it and the URL keeps the selection.
    await page.getByTestId('aif-marker-area-demand').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/sel=area-demand/);
    await expect(page.getByTestId('aif-area-area-demand')).toHaveAttribute('data-position', 'p0');
    await expect(page.getByTestId('aif-area-ahead')).toContainText('P3');
    await expect(page.getByTestId('aif-gate-p0')).toHaveAttribute('data-done', 'false');

    await page.screenshot({ path: test.info().outputPath('aifirst-ja.png'), fullPage: true });
    expect(await scan(page)).toEqual([]);
  });

  test('fixing the prerequisites removes the contradictions and moves the area up; edits persist and can be undone', async ({ page }) => {
    await open(page, '/aifirst');
    for (const id of ['devGuardrails', 'registry']) {
      await openCap(page, id);
      await page.getByTestId(`aif-cap-level-${id}`).selectOption('1');
    }
    await expect(page.getByTestId('aif-sum-violations')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('aif-violations-none')).toBeVisible();
    await expect(page.getByTestId('aif-map-svg').locator('g[data-area="area-skills"]')).toHaveAttribute('data-position', 'p3');
    await expect(page.getByTestId('aif-origin')).toHaveAttribute('data-origin', 'edited');

    await page.goto('/#/aifirst');
    await expect(page.getByTestId('aif-map-svg').locator('g[data-area="area-skills"]')).toHaveAttribute('data-position', 'p3');
    await page.getByTestId('aif-reset').click();
    await expect(page.getByTestId('aif-origin')).toHaveAttribute('data-origin', 'demo');
    await expect(page.getByTestId('aif-sum-violations')).toHaveAttribute('data-count', '6');
  });

  test('an area closes its loop by linking use to the KPI and improving on its rubric', async ({ page }) => {
    await open(page, '/aifirst?sel=area-inspection');
    const area = page.getByTestId('aif-area-area-inspection');
    await expect(area.getByTestId('aif-loop-list').locator('[data-step="observe"]')).toHaveAttribute('data-done', 'false');
    await area.getByTestId('aif-check-kpiLink').check();
    await expect(area.getByTestId('aif-loop-list').locator('[data-step="observe"]')).toHaveAttribute('data-done', 'true');
    await area.getByTestId('aif-check-basis-kpiLink').selectOption('evidence');
    await area.getByTestId('aif-eval-date').fill('2026-11-25');
    await area.getByTestId('aif-eval-score').fill('91');
    await area.getByTestId('aif-eval-add').click();
    await expect(area.getByTestId('aif-loop-list').locator('[data-step="improve"]')).toHaveAttribute('data-done', 'true');
    await expect(area.getByTestId('aif-trend-svg')).toBeVisible();
    await expect(page.getByTestId('aif-sum-loops')).toContainText('2 / 5');
    await expect(page.getByTestId('aif-marker-area-inspection').locator('.aif-loop-on')).toHaveCount(4);
    expect(await scan(page)).toEqual([]);
  });

  test('is localized in English with no Japanese and no accessibility violations', async ({ page }) => {
    await open(page, '/aifirst', { lang: 'en' });
    await expect(page.getByTestId('aif-not-linear')).toContainText('not a schedule of steps in order');
    await expect(page.getByTestId('aif-sum-next')).toContainText('App and agent inventory');
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    await page.screenshot({ path: test.info().outputPath('aifirst-en.png'), fullPage: true });
    expect(await scan(page)).toEqual([]);
  });
});
