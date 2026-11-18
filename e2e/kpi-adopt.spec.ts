import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedDeviceData, setup } from './helpers.ts';
import { samplePack } from '../src/data/sample.ts';

/** FR-325: internal KPIs/OKRs (extensions.okr) adopted into the project as drafts, by hand or by Copilot. */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const okr = {
  kpis: [
    { id: 'k-reach', name: 'Customer Reach', definition: 'FY27の顧客リーチ拡大', target: '10倍', unit: '倍', current: '未計測', period: 'FY27', sourceIds: [] },
    { id: 'k-wins', name: 'Frontier Transformation Wins', target: '最低5件', unit: '件/Hub SE', period: '2027-06-30', sourceIds: [] },
    { id: 'k-eng', name: 'Partner engagements', target: '≥50 engagements', current: '12', sourceIds: [] },
  ],
  objectives: [
    { id: 'o-growth', objective: '顧客との接点を増やす', keyResults: [{ text: 'Customer Reach を伸ばす', target: '10倍', kpiId: 'k-reach' }], sourceIds: [] },
  ],
};

async function seed(page: Page) {
  await setup(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.kpiAdopt')) return;
    sessionStorage.setItem('bas.e2e.kpiAdopt', '1');
    const createdAt = '2026-11-10T00:00:00.000Z';
    localStorage.setItem('bas.projects', JSON.stringify({
      version: 1,
      state: {
        companies: [{ id: 'co-a', name: 'Contoso', createdAt }],
        projects: [{ id: 'pj-alpha', companyId: 'co-a', name: 'Alpha', createdAt, step: 'kpi', brief: { purpose: 'パートナー経由で顧客接点を広げる' } }],
        target: { kind: 'project', projectId: 'pj-alpha' },
        lastProjectId: 'pj-alpha',
        demoStep: 'define',
      },
    }));
  });
  await page.goto('/#/analysis?tab=kpi');
  await expect(page.locator('main#main')).toBeVisible();
  const pack = { ...samplePack, extensions: { ...samplePack.extensions, okr } };
  await seedDeviceData(page, {
    'bas.packs.index': JSON.stringify({ 'pj-alpha': {
      projectId: 'pj-alpha', packId: pack.packId, company: pack.company, isSample: false,
      entities: pack.entities.length, importedAt: '2026-11-10T00:00:00.000Z', files: ['synthetic.json'],
    } }),
    'bas.binary.pack.pj-alpha': JSON.stringify(pack),
  });
  await page.reload();
  await expect(page.getByTestId('proj-pack-okr')).toBeVisible();
}

test('selected internal KPIs and OKRs become editable drafts that save into the project', async ({ page }) => {
  await seed(page);
  const panel = page.getByTestId('proj-pack-okr');
  await expect(page.getByTestId('proj-adopt-kpi')).toBeDisabled();

  await page.getByTestId('proj-adopt-select-k-reach').check();
  await page.getByTestId('proj-adopt-kpi').click();
  const draft = page.getByTestId('proj-kpi-draft-okr.kpi:k-reach');
  await expect(draft).toContainText('ドラフト');
  await expect(draft).toContainText('10倍');
  await expect(draft.getByLabel('目標値', { exact: true })).toHaveValue('10');
  await expect(draft.getByLabel('単位', { exact: true })).toHaveValue('倍');
  // Unmeasured and fiscal-year values are not guessed.
  await expect(draft.getByLabel('現在値', { exact: true })).toHaveValue('');
  await expect(draft.getByLabel('期限', { exact: true })).toHaveValue('');
  await expect(panel.locator('[data-adopt="kpi-draft"]')).toHaveCount(1);
  await expect(page.getByTestId('proj-adopt-notice')).toContainText('KPI 1 件');

  // Saving with missing numbers keeps the draft and points at the fields.
  await draft.getByRole('button', { name: 'ドラフト「Customer Reach」を保存' }).click();
  await expect(draft).toBeVisible();
  await expect(draft).toContainText('期限を日付で入力してください。');
  await draft.getByLabel('基準値', { exact: true }).fill('1');
  await draft.getByLabel('現在値', { exact: true }).fill('2');
  await draft.getByLabel('期限', { exact: true }).fill('2027-03-31');
  await draft.getByRole('button', { name: 'ドラフト「Customer Reach」を保存' }).click();
  await expect(draft).toHaveCount(0);
  await expect(page.getByTestId('proj-kpi-panel').locator('table')).toContainText('Customer Reach');
  await expect(panel.locator('[data-adopt="kpi-adopted"]')).toHaveCount(1);

  // The objective reuses the saved KPI; its draft persists across a reload before saving.
  await page.getByTestId('proj-adopt-select-o-growth').check();
  await page.getByTestId('proj-adopt-okr').click();
  const okrDraft = page.getByTestId('proj-okr-draft-okr.obj:o-growth');
  await expect(okrDraft.getByRole('textbox', { name: /Objective/ })).toHaveValue('顧客との接点を増やす');
  await page.reload();
  await expect(okrDraft).toBeVisible();
  await expect(page.getByTestId('proj-kpi-drafts')).toHaveCount(0);
  await okrDraft.getByRole('button', { name: 'ドラフト「顧客との接点を増やす」を保存' }).click();
  await expect(okrDraft).toHaveCount(0);
  await expect(page.getByTestId('proj-okr-panel')).toContainText('顧客との接点を増やす');
  await expect(panel.locator('[data-adopt="okr-adopted"]')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('proj-kpi-panel').locator('table')).toContainText('Customer Reach');
  await expect(page.getByTestId('proj-okr-panel')).toContainText('顧客との接点を増やす');
  expect(await scan(page)).toEqual([]);
});

test('Copilot drafts only open candidates, with its reasons and unverified numbers shown', async ({ page }) => {
  await seed(page);
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z',
  } }));
  const prompts: string[] = [];
  await page.route('**/relay/ai', async (route) => {
    const body = route.request().postDataJSON() as { prompt: string; use: string };
    prompts.push(body.prompt);
    expect(body.use).toBe('kpiOkrDraft');
    await route.fulfill({ json: { text: JSON.stringify({
      kpis: [{ id: 'okr.kpi:k-wins', reason: '顧客接点の成果を件数で測れる' }, { id: 'okr.kpi:k-eng', reason: '売上 300% に効く' }, { id: 'okr.kpi:ghost', reason: 'x' }],
      okrs: [{ kpiIds: ['okr.kpi:k-wins', 'okr.kpi:k-eng'], objective: 'パートナーと顧客接点を広げる', reason: '目的と一致' }],
    }), inputTokens: 100, outputTokens: 100 } });
  });
  await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey', monthlyBudgetJpy: 100000 }, version: 1 }) });
  await page.reload();
  // k-reach is already drafted, so it is not sent.
  await page.getByTestId('proj-adopt-select-k-reach').check();
  await page.getByTestId('proj-adopt-kpi').click();
  await expect(page.getByTestId('proj-adopt-copilot-hint')).toContainText('3 件');

  await page.getByTestId('proj-adopt-copilot').click();
  await expect(page.getByTestId('proj-adopt-notice')).toContainText('KPI 2 件、OKR 1 件');
  await expect(page.getByTestId('proj-adopt-notice')).toContainText('1 件は社内の項目と一致しない');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('パートナー経由で顧客接点を広げる');
  expect(prompts[0]).not.toContain('okr.kpi:k-reach');
  expect(prompts[0]).toContain('okr.obj:o-growth');

  const wins = page.getByTestId('proj-kpi-draft-okr.kpi:k-wins');
  await expect(wins).toContainText('Copilot の案');
  await expect(wins).toContainText('顧客接点の成果を件数で測れる');
  await expect(wins.getByLabel('目標値', { exact: true })).toHaveValue('5');
  await expect(wins.getByLabel('期限', { exact: true })).toHaveValue('2027-06-30');
  await expect(page.getByTestId('proj-kpi-draft-okr.kpi:k-eng')).toContainText('300');
  const set = page.getByTestId('proj-okr-draft-okr.set:okr.kpi:k-eng+okr.kpi:k-wins');
  await expect(set).toContainText('Copilot の案');
  await expect(set).toContainText('保存すると、つながっている KPI のドラフト 2 件も保存します');

  // Saving the OKR is blocked until its linked KPI drafts are complete; then everything saves at once.
  await set.getByRole('button', { name: 'ドラフト「パートナーと顧客接点を広げる」を保存' }).click();
  await expect(set.getByRole('alert')).toBeVisible();
  for (const id of ['k-wins', 'k-eng']) {
    const card = page.getByTestId(`proj-kpi-draft-okr.kpi:${id}`);
    await card.getByLabel('基準値', { exact: true }).fill('0');
    await card.getByLabel('現在値', { exact: true }).fill('1');
    await card.getByLabel('期限', { exact: true }).fill('2027-06-30');
  }
  await set.getByRole('button', { name: 'ドラフト「パートナーと顧客接点を広げる」を保存' }).click();
  await expect(set).toHaveCount(0);
  await expect(page.getByTestId('proj-kpi-draft-okr.kpi:k-wins')).toHaveCount(0);
  await expect(page.getByTestId('proj-okr-panel')).toContainText('パートナーと顧客接点を広げる');
  await expect(page.getByTestId('proj-kpi-panel').locator('table')).toContainText('Frontier Transformation Wins');
  expect(await scan(page)).toEqual([]);
});
