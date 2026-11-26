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

  test('flows live in the relations screen and the old flows link opens that view', async ({ page }) => {
    await open(page, '/flows?section=architecture', { lang: 'en' });
    await expect(page).toHaveURL(/#\/relations\?/);
    await expect(page).toHaveURL(/view=flow/);
    await expect(page.getByRole('tab', { name: 'Flows', exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Table', exact: true }).click();
    await expect(page.getByTestId('relation-table')).toBeVisible();
    await expect(page).not.toHaveURL(/section=/);
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
  await page.goto('/#/flows');
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
  await expect(page.getByTestId('workflow-panel')).toBeVisible();
}

test.describe('workflow map', () => {
  test('shows recorded branches, returns, outputs and sources without inventing adjacent handoffs', async ({ page }) => {
    await seedWorkflow(page, workflowStages);
    await expect(page.getByTestId('workflow-stages').locator(':scope > li')).toHaveCount(20);
    await page.getByRole('tab', { name: '工程マップ' }).click();
    const map = page.getByTestId('workflow-map');
    await expect(map.locator('.workflow-map-row')).toHaveCount(20);
    const first = page.getByTestId('workflow-map-row-0');
    await expect(first).toContainText('営業チーム');
    await expect(first).toContainText('要望一覧 / 依頼記録');
    await expect(first.getByRole('button', { name: '次の工程へ: 2. 審査' })).toBeVisible();
    await expect(first.getByRole('button', { name: '次の工程へ: 3. 引き渡し' })).toBeVisible();
    await expect(first).toContainText('外部の引き継ぎ先');
    await expect(first).toContainText('外部パートナー');
    await expect(page.getByTestId('workflow-map-row-1').getByRole('button', { name: '次の工程へ: 1. 受付' })).toBeVisible();
    await expect(page.getByTestId('workflow-map-row-2')).toContainText('次の工程・引き継ぎ先の記載なし');
    await expect(page.getByTestId('workflow-map-row-2').getByRole('button')).toHaveCount(1);

    const firstNode = page.getByTestId('workflow-map-node-0');
    await firstNode.focus();
    await firstNode.press('Enter');
    await expect(firstNode).toHaveAttribute('aria-expanded', 'true');
    const details = page.getByTestId('workflow-map-details-0');
    await expect(details.getByTestId('workflow-inputs')).toContainText('顧客の要望');
    await expect(details.getByTestId('workflow-activities')).toContainText('内容を整理');
    await expect(details.getByTestId('workflow-outputs')).toContainText('依頼記録');
    await expect(details.getByTestId('workflow-data')).toContainText('案件システム');
    await expect(details.getByTestId('workflow-sources')).toContainText(workflowSource.name.ja);
    await expect(details.getByTestId('workflow-map-previous').getByRole('button', { name: '前の工程へ: 2. 審査' })).toBeVisible();
    await first.getByRole('button', { name: '次の工程へ: 2. 審査' }).press('Enter');
    await expect(page.getByTestId('workflow-map-node-1')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('workflow-map-node-1')).toBeFocused();
    await expect(page.getByTestId('workflow-map-details-1').getByTestId('workflow-inputs')).toContainText('記載なし');
    await expect(page).toHaveURL(/flowView=map.*stage=2/);

    await page.reload();
    await expect(page.getByTestId('workflow-map-node-1')).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('tab', { name: '段階一覧' }).click();
    await expect(page.getByTestId('workflow-stages')).toBeVisible();
    await expect(page.getByTestId('workflow-stage-intake').getByTestId('workflow-next')).toContainText('審査 / 引き渡し / 外部パートナー');
    await page.getByRole('tab', { name: '工程マップ' }).click();
    await expect(page.getByTestId('workflow-map-node-1')).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page, '[data-testid="workflow-panel"]')).toEqual([]);
    await page.getByRole('tab', { name: 'アーキテクチャ', exact: true }).click();
    await expect(page.getByTestId('td-arch-switch')).toBeVisible();
    await page.getByTestId('flow-sections').getByRole('tab', { name: '流れ', exact: true }).click();
    await expect(page.getByTestId('workflow-map-node-1')).toHaveAttribute('aria-expanded', 'true');
    await page.goto('/#/flows?view=map&stage=1');
    await expect(page).toHaveURL(/#\/relations\?/);
    await expect(page).toHaveURL(/flowView=map/);
    await expect(page.getByTestId('workflow-map-node-0')).toHaveAttribute('aria-expanded', 'true');
  });

  test('reports missing and ambiguous references instead of creating false links', async ({ page }) => {
    await seedWorkflow(page, [
      { id: 'start', name: 'Start', next: ['missing', 'duplicate'] },
      { id: 'duplicate', name: 'First duplicate' },
      { id: 'duplicate', name: 'Second duplicate' },
    ]);
    await page.getByRole('tab', { name: '工程マップ' }).click();
    const first = page.getByTestId('workflow-map-row-0');
    await expect(first).toContainText('参照先が見つかりません: missing');
    await expect(first).toContainText('参照先を特定できません: duplicate');
    await expect(first.getByRole('button')).toHaveCount(1);
    await page.getByTestId('workflow-map-node-1').click();
    await expect(page.getByTestId('workflow-map-previous')).toContainText('前の工程を特定できません');
    await expect(page.getByTestId('workflow-map-details-1').getByTestId('workflow-sources')).toContainText('表示できる出典の記載なし');
  });

  test('works in English at 320px and passes accessibility checks', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await seedWorkflow(page, workflowStages, 'en');
    await page.getByRole('tab', { name: 'Process map' }).click();
    await page.getByTestId('workflow-map-node-0').click();
    await expect(page.getByTestId('workflow-map-details-0')).toContainText('Customer request');
    await expect(page.getByTestId('workflow-map-row-0')).toContainText('External partner');
    await expect(page.getByTestId('workflow-map-row-2')).toContainText('No next stage or handoff recorded');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page, '[data-testid="workflow-panel"]')).toEqual([]);
  });
});

