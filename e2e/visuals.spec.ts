import { expect, test, type Page } from '@playwright/test';
import { open, scan, seedDeviceData, setup } from './helpers.ts';
import { samplePack } from '../src/data/sample.ts';

test.describe('F-3.3 visuals', () => {
  test('strategy overview replaces KPI cards with a consistent objective-to-solution map', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await expect(page.getByRole('heading', { level: 1 })).    toHaveText('Sample company-Demo');
    await expect(page.locator('.kpi-card')).toHaveCount(0);
    await expect(page.getByTestId('strategy-map')).toBeVisible();
    await expect(page.getByTestId('strategy-map').locator('[data-lane="issue"]')).toHaveCount(5);
    await expect(page.getByTestId('strategy-map').locator('[data-lane="solution"]')).toHaveCount(5);
    await expect(page.getByTestId('strategy-next')).not.toBeEmpty();
  });

  test('priority criterion and ordering re-rank issues and persist across all five steps', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.getByTestId('strategy-axis').selectOption('impact');
    const rows = page.getByTestId('strategy-ranking').locator('[data-issue]');
    const scores = () => rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-score'))));
    const desc = await scores();
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    await page.getByTestId('strategy-sort').selectOption('asc');
    const asc = await scores();
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(asc).not.toEqual(desc);
    for (const step of ['asis', 'tobe', 'kpi', 'solution', 'deliverable']) {
      await page.goto(`/#/step?step=${step}&view=details`);
      await expect(page.getByTestId('strategy-axis')).toHaveValue('impact');
      await expect(page.getByTestId('strategy-sort')).toHaveValue('asc');
      await expect(page.getByTestId('strategy-map')).toBeVisible();
    }
    await page.reload();
    await expect(page.getByTestId('strategy-axis')).toHaveValue('impact');
  });

  test('before/after share unit, period, scope and a zero-based axis; raw numbers are shown', async ({ page }) => {
    await open(page, '/optimize', { lang: 'en' });
    const panel = page.getByTestId('before-after');
    await expect(panel).toContainText('Period: October 2026 (one month)');
    await expect(panel).toContainText('3 plants × 5 regions, total demand 1,100 t');
    for (const fig of await panel.locator('.compare-figure').all()) {
      const bars = fig.locator('rect.bar');
      await expect(bars).toHaveCount(2);
      // Both bars grow from the same baseline (same axis).
      const bottoms = await bars.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.bottom); }));
      expect(Math.abs(bottoms[0]! - bottoms[1]!)).toBeLessThanOrEqual(1);
      await expect(fig.locator('.y.axis .tick text').first()).toHaveText('0');
    }
    const rows = page.getByTestId('raw-numbers').locator('tbody tr');
    await expect(rows).toHaveCount(3);
  });

  test('changing assumptions recomputes; infeasible demand is explained', async ({ page }) => {
    await open(page, '/optimize?growth=15', { lang: 'en' });
    await expect(page.getByTestId('optimize-summary')).toContainText('exceeds capacity');
    await open(page, '/optimize?growth=5&carbon=20000', { lang: 'en' });
    await expect(page.getByTestId('capacity-report')).toBeVisible();
    await expect(page.getByTestId('optimize-summary')).toContainText('Demand 5%, carbon price 20,000');
  });

  test('the material flow is a tab of the business process screen and the old flows link opens it', async ({ page }) => {
    await open(page, '/flows?section=architecture', { lang: 'en' });
    await expect(page).toHaveURL(/#\/process\?/);
    await expect(page).toHaveURL(/tab=material/);
    await expect(page.getByTestId('td-arch-switch')).toBeVisible();
    await page.getByRole('tab', { name: 'Process map and analysis', exact: true }).click();
    await expect(page.getByTestId('bp-map')).toBeVisible();
    await expect(page).not.toHaveURL(/tab=/);
  });
  test('Sankey, Gantt, map and graph render interactive, focusable items', async ({ page }) => {
    await open(page, '/flows', { lang: 'en' });
    await expect(page.locator('.sankey-link')).toHaveCount(19);
    await page.locator('.sankey [data-entity-ref="site-nagoya"]').hover();
    // Horizontal link paths have a zero-height box, so assert on the highlight classes rather than visibility.
    await expect(page.locator('.sankey-link.on')).toHaveCount(5);
    await expect(page.locator('.sankey-link.dim')).toHaveCount(14);
    await open(page, '/plan', { lang: 'en' });
    await expect(page.locator('.gantt [data-entity-ref]')).toHaveCount(7);
    await expect(page.locator('.gantt-dep')).toHaveCount(2);
    await open(page, '/map', { lang: 'en' });
    await expect(page.locator('.geo-map [data-entity-ref]')).toHaveCount(6);
  });

  test('every visual explains why it was chosen', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.getByTestId('strategy-panel').getByRole('button', { name: 'Why this visual' }).click();
    await expect(page.getByRole('dialog').or(page.locator('.rationale-surface'))).toContainText('Equal-width curves');
  });
});

test.describe('F-3.1 imagery', () => {
  test('people have portraits and customers/products have illustrations in lists', async ({ page }) => {
    await open(page, '/directory?tab=people', { lang: 'en' });
    await expect(page.locator('[data-testid="directory-table"] .art-portrait')).toHaveCount(10);
    await open(page, '/directory?tab=customers', { lang: 'en' });
    await expect(page.locator('[data-testid="directory-table"] svg.art')).toHaveCount(6);
    await open(page, '/directory?tab=products', { lang: 'en' });
    await expect(page.locator('[data-testid="directory-table"] svg.art')).toHaveCount(6);
  });
});

const l = (ja: string, en: string) => ({ ja, en });
const workflowSource = samplePack.entities.find((entity) => entity.kind === 'source')!;
const workflowStages = [
  {
    id: 'intake', name: l('受付', 'Intake'), team: l('営業チーム', 'Sales team'),
    inputs: [l('顧客の要望', 'Customer request')], activities: [l('内容を整理', 'Organize the request')],
    outputs: [l('要望一覧', 'Request list'), l('依頼記録', 'Request record')],
    data: [l('案件システム', 'Case system')], next: ['review', 'delivery'],
    handoffTo: [l('外部パートナー', 'External partner')], sourceIds: [workflowSource.id],
  },
  { id: 'review', name: l('審査', 'Review'), next: ['intake'] },
  { id: 'delivery', name: l('引き渡し', 'Delivery') },
  ...Array.from({ length: 17 }, (_, i) => ({ id: `stage-${i + 4}`, name: l(`補助工程 ${i + 4}`, `Supporting stage ${i + 4}`) })),
];

async function seedWorkflow(page: Page, stages: unknown[], lang: 'ja' | 'en' = 'ja') {
  await setup(page, { lang });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.workflow')) return;
    sessionStorage.setItem('bas.e2e.workflow', '1');
    const createdAt = '2026-11-10T00:00:00.000Z';
    localStorage.setItem('bas.projects', JSON.stringify({
      version: 1,
      state: {
        companies: [{ id: 'co-a', name: 'Contoso', createdAt }],
        projects: [{ id: 'pj-alpha', companyId: 'co-a', name: 'Alpha', createdAt, step: 'asis' }],
        target: { kind: 'project', projectId: 'pj-alpha' },
        lastProjectId: 'pj-alpha',
        demoStep: 'asis',
      },
    }));
  });
  await page.goto('/#/process?level=steps');
  await expect(page.locator('main#main')).toBeVisible();
  const pack = { ...samplePack, flows: [], extensions: { ...samplePack.extensions, workflow: { stages } } };
  await seedDeviceData(page, {
    'bas.packs.index': JSON.stringify({ 'pj-alpha': {
      projectId: 'pj-alpha', packId: pack.packId, company: pack.company, isSample: false,
      entities: pack.entities.length, importedAt: '2026-11-10T00:00:00.000Z', files: ['synthetic.json'],
    } }),
    'bas.binary.pack.pj-alpha': JSON.stringify(pack),
  });
  await page.reload();
  await expect(page.getByTestId('bp-map')).toBeVisible();
}

test.describe('business process from a pack workflow (FR-380)', () => {
  test('draws recorded branches and returns, and shows inputs, outputs and sources without inventing links', async ({ page }) => {
    await seedWorkflow(page, workflowStages);
    const map = page.getByTestId('bp-map');
    await expect(map.locator('[data-testid^="bp-step-"]')).toHaveCount(20);
    await expect(map.getByTestId('bp-canvas')).toContainText('営業チーム');
    await expect(page.getByTestId('bp-edge-intake-review')).toHaveCount(1);
    await expect(page.getByTestId('bp-edge-intake-delivery')).toHaveCount(1);
    // "review → intake" goes back to an earlier step: a loop, not a second arrow forward.
    await expect(page.getByTestId('bp-edge-review-intake')).toHaveCount(0);
    await expect(page.getByTestId('bp-loop-loop-review-intake')).toHaveCount(1);
    await expect(page.locator('[data-testid^="bp-edge-stage-"]')).toHaveCount(0);

    await page.getByTestId('bp-step-intake').hover();
    const hover = page.getByTestId('bp-hovercard');
    await expect(hover).toContainText('顧客の要望');
    await expect(hover).toContainText('依頼記録');
    await expect(hover).toContainText('外部パートナー');
    await expect(hover).toContainText(workflowSource.name.ja);
    await page.keyboard.press('Escape');
    await page.mouse.move(2, 2);
    await expect(hover).toHaveCount(0);

    await page.getByTestId('bp-step-review').focus();
    await expect(page.getByTestId('bp-hovercard')).toContainText('審査');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/sel=review/);
    await expect(page.getByTestId('bp-detail')).toContainText('審査');
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page, '[data-testid="bp-map-panel"]')).toEqual([]);
  });

  test('ignores missing references and keeps steps that share an id', async ({ page }) => {
    await seedWorkflow(page, [
      { id: 'start', name: 'Start', next: ['missing', 'duplicate'] },
      { id: 'duplicate', name: 'First duplicate' },
      { id: 'duplicate', name: 'Second duplicate' },
    ]);
    await expect(page.locator('[data-testid^="bp-step-"]')).toHaveCount(3);
    await expect(page.getByTestId('bp-edge-start-duplicate')).toHaveCount(1);
    await expect(page.locator('[data-testid^="bp-edge-start-missing"]')).toHaveCount(0);
    await page.getByTestId('bp-step-duplicate~2').hover();
    await expect(page.getByTestId('bp-hovercard')).toContainText('出典なし');
  });

  test('works in English at 320px and passes accessibility checks', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await seedWorkflow(page, workflowStages, 'en');
    await page.getByTestId('bp-step-intake').focus();
    await expect(page.getByTestId('bp-hovercard')).toContainText('Customer request');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page, 'main')).toEqual([]);
  });
});
