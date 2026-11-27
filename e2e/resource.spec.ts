import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .include('[data-testid="resource-brief"]')
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus sentinels; same exclusion as e2e/a11y.spec.ts.
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('FR-326 resource optimization', () => {
  test('scrubbing and playback move the same date on the chart and allocation map', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    const clock = page.getByTestId('sim-date');
    const allocation = page.getByTestId('resource-view').getByRole('tab', { name: /Allocation at/ });
    await clock.press('End');
    await expect(allocation).toContainText('100%');
    await clock.press('Home');
    await expect(allocation).toContainText('(0%');
    const at = await clock.getAttribute('aria-valuetext');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(clock).not.toHaveAttribute('aria-valuetext', at!);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(allocation).toContainText((await clock.getAttribute('aria-valuetext'))!);
  });
  test('dragging the chart moves the date freely, and playback resumes from the released date', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    const clock = page.getByTestId('sim-date');
    const chart = page.getByTestId('sim-chart');
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    // viewBox -55..600 holds the axis at 8..592: map a fraction of the axis to screen pixels.
    const px = (f: number) => box.x + box.width * (63 + 584 * f) / 655;
    const midY = box.y + box.height / 2;
    await clock.press('Home');
    const start = (await clock.getAttribute('aria-valuetext'))!;
    await page.mouse.move(px(0.2), midY);
    await page.mouse.down();
    await page.mouse.move(px(0.8), midY, { steps: 5 });
    const late = (await clock.getAttribute('aria-valuetext'))!;
    await page.mouse.move(px(0.4), midY, { steps: 5 });
    await page.mouse.up();
    const mid = (await clock.getAttribute('aria-valuetext'))!;
    expect(start < mid && mid < late).toBe(true);
    await expect(page.getByTestId('resource-view').getByRole('tab', { name: /Allocation at/ })).toContainText(mid);

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await chart.scrollIntoViewIfNeeded();
    const box2 = (await chart.boundingBox())!;
    await page.mouse.move(box2.x + box2.width * (63 + 584 * 0.1) / 655, box2.y + box2.height / 2);
    await page.mouse.down();
    await expect(chart).toHaveAttribute('data-scrubbing', 'true');
    await page.mouse.move(box2.x + box2.width * (63 + 584 * 0.05) / 655, box2.y + box2.height / 2);
    const held = (await clock.getAttribute('aria-valuetext'))!;
    await page.waitForTimeout(600);
    await expect(clock).toHaveAttribute('aria-valuetext', held);
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(async () => (await clock.getAttribute('aria-valuetext'))! > held).toBe(true);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const go = page.getByRole('button', { name: /^(First improvement|Target reached|Deadline) \d{4}-\d{2}-\d{2}$/ }).first();
    const target = (await go.textContent())!.match(/\d{4}-\d{2}-\d{2}/)![0];
    await go.click();
    await expect(clock).toHaveAttribute('aria-valuetext', target);
  });
  test('the screen is renamed and explains the current state above the visual', async ({ page }) => {
    await open(page, '/optimize', { lang: 'ja' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('シミュレーション');
    const brief = page.getByTestId('resource-brief');
    await expect(brief).toBeVisible();
    await expect(page.getByTestId('resource-archetype')).toBeVisible();
    await expect(page.getByTestId('resource-facts').locator('li').first()).toBeVisible();
    // Offline, the commentary restates the computed facts and adds nothing.
    await page.getByTestId('resource-ai-run').click();
    await expect(page.getByTestId('resource-ai-text')).toContainText(/Supply|供給/);
    // The workbench sits above the detailed plant → region panels.
    const briefBox = (await brief.boundingBox())!;
    const detailBox = (await page.getByTestId('before-after').boundingBox())!;
    expect(briefBox.y).toBeLessThan(detailBox.y);
  });

  test('selecting an item highlights related items and opens its editor', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    const pool = page.locator('[data-testid^="resource-node-pool:"]').first();
    await pool.click();
    await expect(pool).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('resource-pool-editor')).toBeVisible();
    await expect(page.locator('.res-node.is-related').first()).toBeVisible();
    await expect(page.locator('.res-node.is-dim').first()).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(pool).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.res-node.is-dim')).toHaveCount(0);

    const demand = page.locator('[data-testid^="resource-node-demand:"]').first();
    await demand.focus();
    await page.keyboard.press('Enter');
    await expect(demand).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('resource-demand-editor')).toBeVisible();
  });

  test('simulation: editing an item recomputes, is marked, and resets', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    const served = page.getByTestId('resource-kpi-served');
    const pool = page.locator('[data-testid^="resource-node-pool:"]').first();
    await pool.click();
    const capacity = page.getByTestId('resource-capacity');
    await capacity.fill('0');
    await capacity.press('Enter');
    await expect(page.getByTestId('resource-changes')).toBeVisible();
    await expect(pool).toHaveAttribute('aria-label', /capacity 0 /);
    await expect(page.getByTestId('resource-facts')).toContainText(/simulat/i);
    const before = await served.textContent();
    await page.getByTestId('resource-reset').click();
    await expect(page.getByTestId('resource-changes')).toHaveCount(0);
    await expect(served).not.toHaveText(before ?? '');
  });

  test('people lens: people → work, with owners, view toggle and accessible markup', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    await page.getByTestId('resource-lens').getByRole('tab', { name: /people/i }).click();
    await expect(page.locator('[data-testid^="resource-node-pool:"]').first()).toBeVisible();
    await expect(page.getByTestId('resource-kpi-weighted')).toBeVisible();
    const view = page.getByTestId('resource-view');
    await view.getByRole('tab').first().click();
    await expect(view.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    await axe(page);
    // People are never named in what is sent to the AI (D-29); the offline answer echoes the prompt's facts.
    await page.keyboard.press('Escape');
    const hours = page.getByTestId('resource-hours');
    await hours.fill('40');
    await hours.press('Enter');
    await expect(page.getByTestId('resource-facts')).toContainText(/Constraint:/);
    await page.getByTestId('resource-ai-run').click();
    const aiText = (await page.getByTestId('resource-ai-text').textContent()) ?? '';
    expect(aiText).toMatch(/Person \d+/);
    const names = await page.locator('.res-node[data-node^="pool:"] text').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
    for (const n of names.filter((x) => x.length > 2 && !/\d/.test(x))) expect(aiText).not.toContain(n);
  });

  test('the user can override the detected industry', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    await page.getByTestId('resource-archetype-select').selectOption('itServices');
    await expect(page.getByTestId('resource-archetype')).toHaveAttribute('data-archetype', 'itServices');
    await axe(page);
  });
});
