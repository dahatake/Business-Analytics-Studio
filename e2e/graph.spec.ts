import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, card, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const stage = (page: Page) => page.getByTestId('graph-stage');

/** Screen point on an edge that is not covered by a node (so a real click lands on the edge). */
async function clearEdgePoint(page: Page, selector: string): Promise<{ id: string; x: number; y: number }> {
  await expect(page.locator(selector).first()).toBeAttached();
  await page.getByTestId('graph-svg').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const found = await page.evaluate((sel) => {
    for (const edge of document.querySelectorAll<SVGGElement>(sel)) {
      const path = edge.querySelector<SVGPathElement>('.graph2-edge-hit');
      const ctm = path?.getScreenCTM();
      if (!path || !ctm) continue;
      const total = path.getTotalLength();
      for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
        const q = path.getPointAtLength(total * f);
        const p = new DOMPoint(q.x, q.y).matrixTransform(ctm);
        if (p.y < 0 || p.y > window.innerHeight || p.x < 0 || p.x > window.innerWidth) continue;
        if (document.elementFromPoint(p.x, p.y)?.closest('[data-edge-id]') === edge) return { id: edge.getAttribute('data-edge-id')!, x: p.x, y: p.y };
      }
    }
    return null;
  }, selector);
  expect(found).not.toBeNull();
  return found!;
}

const VIEW_ROUTES = [
  '/graph',
  '/graph?level=overview',
  '/graph?level=detail&sel=kpi-defect',
  '/graph?format=2d',
  '/graph?format=3d',
  '/graph?twins=1&world=real',
  '/graph?view=twin',
  '/graph?view=twin&level=overview&format=2d',
  '/graph?view=spatial&format=2d',
  '/graph?view=spatial&level=detail&format=2d',
  '/graph?view=spatial&format=graph&level=overview',
  '/graph?view=criteria',
];

test.describe('Graph module (FR-235–FR-248)', () => {
  test('@perf FR-238: switching 2D / 3D / Graph completes within 2000 ms', async ({ page }) => {
    await open(page, '/graph', { lang: 'en' });
    await expect(page.locator('[data-node-id]').first()).toBeVisible();
    for (const [name, format] of [['3D', '3d'], ['2D', '2d'], ['Graph', 'graph'], ['3D', '3d']] as const) {
      const started = Date.now();
      await page.getByTestId('graph-format').getByRole('radio', { name, exact: true }).check();
      await expect(stage(page)).toHaveAttribute('data-format', format);
      if (format === '3d') await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-ready', 'true');
      else await expect(page.locator('[data-node-id]').first()).toBeVisible();
      expect(Date.now() - started, format).toBeLessThan(2000);
    }
  });

  test('FR-237: semantic zoom changes the representation, not only the scale', async ({ page }) => {
    await open(page, '/graph?level=overview&format=2d', { lang: 'en' });
    await expect(page.locator('.graph2-node--cluster').first()).toBeVisible();
    await expect(page.locator('.graph2-node--entity')).toHaveCount(0);
    for (let i = 0; i < 4; i++) await page.getByTestId('graph-zoom-in').click();
    await expect(stage(page)).toHaveAttribute('data-level', 'element');
    await expect(page.locator('.graph2-node--cluster')).toHaveCount(0);
    await expect(page.locator('.graph2-node--entity').first()).toBeVisible();
    // Select an element, then zoom in to its details (attributes / KPI values).
    await page.locator('tr[data-row-for="kpi-defect"]').click();
    await page.locator('[data-node-id="kpi-defect"] .graph2-node-hit').click();
    await expect(card(page)).toBeVisible();
    for (let i = 0; i < 4; i++) await page.getByTestId('graph-zoom-in').click();
    await expect(stage(page)).toHaveAttribute('data-level', 'detail');
    await expect(page.locator('.graph2-node--attribute').first()).toBeVisible();
    // Zooming out goes back up a level.
    for (let i = 0; i < 4; i++) await page.getByTestId('graph-zoom-out').click();
    await expect(stage(page)).toHaveAttribute('data-level', 'element');
  });

  test('FR-218: world filter shows real, digital or both', async ({ page }) => {
    await open(page, '/graph?format=2d', { lang: 'en' });
    await expect(page.locator('[data-node-id="kpi-defect"]')).toHaveCount(1);
    const both = await page.locator('[data-node-id]').count();
    await page.getByTestId('graph-world').getByRole('radio', { name: 'Real world' }).check();
    await expect(page.locator('[data-node-id="kpi-defect"]')).toHaveCount(0);
    await expect(page.locator('[data-node-id="site-nagoya"]')).toHaveCount(1);
    const real = await page.locator('[data-node-id]').count();
    await page.getByTestId('graph-world').getByRole('radio', { name: 'Digital world' }).check();
    await expect(page.locator('[data-node-id="site-nagoya"]')).toHaveCount(0);
    await expect(page.locator('[data-node-id="kpi-defect"]')).toHaveCount(1);
    const digital = await page.locator('[data-node-id]').count();
    expect(real + digital).toBe(both);
    // Twin relations overlay
    await page.getByTestId('graph-world').getByRole('radio', { name: 'Both' }).check();
    await expect(page.locator('.graph2-edge.is-twin')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Show twin relations' }).check();
    await expect(page.locator('.graph2-edge.is-twin').first()).toBeAttached();
  });

  test('FR-247: an edge card opens on click and closes on the second click', async ({ page }) => {
    await open(page, '/graph?level=overview&format=2d', { lang: 'en' });
    const { id, x, y } = await clearEdgePoint(page, '.graph2-edge.is-bundle');
    const edge = page.locator(`[data-edge-id="${id}"]`);
    await page.mouse.click(x, y);
    const infocard = page.getByTestId('graph-infocard');
    await expect(infocard).toBeVisible();
    await expect(infocard).toHaveAttribute('data-card-kind', 'edge');
    await expect(infocard).toHaveAttribute('data-card-for', id);
    await expect(edge).toHaveAttribute('aria-expanded', 'true');
    // ≤ 5 main relations, the rest summarised (PARAM-105)
    expect(await infocard.locator('.graph-infocard-list li').count()).toBeLessThanOrEqual(5);
    await page.mouse.click(x, y);
    await expect(infocard).toHaveCount(0);
    // Keyboard: Enter on a focused edge toggles too
    await edge.focus();
    await page.keyboard.press('Enter');
    await expect(infocard).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(infocard).toHaveCount(0);
  });

  test('FR-247: a node reuses the entity detail card; second click closes it', async ({ page }) => {
    await open(page, '/graph?format=2d', { lang: 'en' });
    const node = page.locator('[data-node-id="kpi-defect"]');
    await node.locator('.graph2-node-hit').click();
    await expect(card(page)).toBeVisible();
    await node.locator('.graph2-node-hit').click();
    await expect(card(page)).toHaveCount(0);
  });

  test('FR-248: clicking a table row highlights the node for about 2 s and centres it', async ({ page }) => {
    await open(page, '/graph?format=2d', { lang: 'en' });
    const node = page.locator('[data-node-id="kpi-defect"]');
    await page.locator('tr[data-row-for="kpi-defect"]').click();
    const started = Date.now();
    await expect(node).toHaveClass(/is-highlighted/);
    await expect(stage(page)).not.toHaveAttribute('data-pan-x', '0');
    await page.waitForTimeout(1400);
    await expect(node).toHaveClass(/is-highlighted/);
    await expect(node).not.toHaveClass(/is-highlighted/, { timeout: 3000 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(1700);
    expect(elapsed).toBeLessThan(2900);
    // Centred: the node is near the middle of the svg
    const svg = (await page.getByTestId('graph-svg').boundingBox())!;
    const box = (await node.locator('.graph2-node-hit').boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (svg.x + svg.width / 2))).toBeLessThan(40);
    expect(Math.abs(box.y + box.height / 2 - (svg.y + svg.height / 2))).toBeLessThan(40);
  });

  test('FR-245: Shift+arrow pans by 40 px, +/- zoom by 1.25× within 0.25–4×, arrows traverse nodes', async ({ page }) => {
    await open(page, '/graph?format=2d', { lang: 'en' });
    const first = page.locator('[data-node-id][tabindex="0"]');
    await first.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(stage(page)).toHaveAttribute('data-pan-x', '-40');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(stage(page)).toHaveAttribute('data-pan-y', '-40');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(stage(page)).toHaveAttribute('data-pan-x', '0');
    // Keyboard traversal
    const before = await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'));
    await page.keyboard.press('ArrowRight');
    const after = await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'));
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    // Zoom out with "-" (element level without selection: zoom stays on this level until 0.45×)
    await page.keyboard.press('-');
    await expect(stage(page)).toHaveAttribute('data-zoom', '0.8000');
    await page.keyboard.press('0');
    await expect(stage(page)).toHaveAttribute('data-zoom', '1.0000');
    await page.keyboard.press('+');
    await expect(stage(page)).toHaveAttribute('data-zoom', '1.2500');
    // Toolbar pan buttons are a non-drag alternative
    await page.getByRole('button', { name: 'Pan up' }).click();
    await expect(stage(page)).toHaveAttribute('data-pan-y', '40');
  });

  test('FR-246: the diagram alone goes full screen and back', async ({ page }) => {
    await open(page, '/graph?format=2d', { lang: 'en' });
    const button = page.getByTestId('graph-fullscreen');
    await button.click();
    await expect(stage(page)).toHaveAttribute('data-fullscreen', /native|fallback/);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const box = (await stage(page).boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.width).toBeGreaterThan(vp.width - 40);
    await page.getByTestId('graph-fullscreen').click();
    await expect(stage(page)).not.toHaveAttribute('data-fullscreen', /.+/);
    await expect(page.getByTestId('graph-fullscreen')).toHaveAttribute('aria-pressed', 'false');
  });

  test('FR-239/240: Twin view shows Data and Control flows; spatial view overlays KPIs', async ({ page }) => {
    await open(page, '/graph?view=twin&format=2d', { lang: 'en' });
    await expect(page.locator('.graph2-edge.is-flow-data').first()).toBeAttached();
    await expect(page.locator('.graph2-edge.is-flow-control').first()).toBeAttached();
    await expect(page.getByTestId('graph-edge-table')).toContainText('Data (real to digital)');
    await expect(page.getByTestId('graph-edge-table')).toContainText('Control (digital to real)');
    await page.goto('/#/graph?view=spatial&format=2d&level=element');
    await expect(page.locator('.graph2-node--area').first()).toBeVisible();
    await expect(page.locator('.graph2-kpi').first()).toBeAttached();
    await expect(page.getByTestId('graph-node-table')).toContainText('Floor 1');
  });

  test('FR-235: the suitability panel gives a verdict with a reason', async ({ page }) => {
    await open(page, '/graph?view=criteria', { lang: 'en' });
    const result = page.getByTestId('graph-suit-result');
    await expect(result).toHaveAttribute('data-suitable', 'true');
    await page.getByLabel('Direction').selectOption('undirected');
    await expect(result).toHaveAttribute('data-suitable', 'false');
    await expect(result).toContainText('needs a direction');
  });

  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const route of VIEW_ROUTES) {
      test(`axe ${lang} ${route}`, async ({ page }) => {
        await open(page, route, { lang });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        if (!route.includes('criteria')) {
          if (route.includes('format=3d')) await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-ready', 'true');
          else await expect(page.locator('[data-node-id]').first()).toBeVisible();
        }
        await page.waitForTimeout(300);
        expect(await scan(page)).toEqual([]);
        if (lang === 'en') {
          const text = await visibleTextExcludingOtherLang(page, 'en');
          const leaked = text.split('\n').filter((l) => JAPANESE.test(l));
          expect(leaked).toEqual([]);
        }
      });
    }
  }

  test('axe with an edge card open', async ({ page }) => {
    await open(page, '/graph?level=overview&format=2d', { lang: 'en' });
    const p = await clearEdgePoint(page, '.graph2-edge.is-bundle');
    await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId('graph-infocard')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });
});
