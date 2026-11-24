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

async function seed(page: Page, okrExt: Record<string, unknown> = okr, withoutKpis = false) {
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
  const pack = { ...samplePack, entities: samplePack.entities.filter((e) => !withoutKpis || e.kind !== 'kpi'), extensions: { ...samplePack.extensions, okr: okrExt } };
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

async function enableDraftAi(page: Page) {
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z',
  } }));
  await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
  await page.reload();
}

test('a pack without KPI/OKR candidates offers missing-only drafts that survive reload and save as proposals', async ({ page }) => {
  await seed(page, {}, true);
  let requests = 0;
  await page.route('**/relay/ai', async (route) => {
    requests++;
    const body = route.request().postDataJSON();
    expect(body.use).toBe('kpiOkrDraft');
    expect(body.prompt).toContain('Mode: proposeMissing');
    expect(body.prompt).toContain('パートナー経由で顧客接点を広げる');
    expect(body.prompt).toContain('issue-lead-time');
    await route.fulfill({ json: { text: JSON.stringify({
      kpis: [{ id: 'delivery', name: '出荷所要日数', unit: '日', reason: '出荷までの課題を測定', evidenceIds: ['issue-lead-time'] }],
      okrs: [{ objective: '出荷までの流れを改善する', reason: '課題の解消を目指す', evidenceIds: ['issue-lead-time'], kpiIds: ['delivery'] }],
    }), inputTokens: 100, outputTokens: 100 } });
  });
  await enableDraftAi(page);
  expect(requests).toBe(0);
  await expect(page.getByTestId('proj-missing-drafts')).toContainText('KPI / OKR');
  await page.getByTestId('proj-missing-copilot').click();
  const draft = page.getByTestId('proj-kpi-draft-proposal.kpi:delivery');
  await expect(draft).toContainText('定義案');
  for (const field of ['基準値', '現在値', '目標値', '期限']) await expect(draft.getByLabel(field, { exact: true })).toHaveValue('');
  await expect(page.getByTestId('proj-missing-copilot')).toHaveCount(0);
  await expect(page.getByTestId('proj-okr-drafts')).toContainText('出荷までの流れを改善する');
  await page.reload();
  await expect(draft).toBeVisible();
  expect(requests).toBe(1);
  await expect(page.getByTestId('proj-missing-copilot')).toHaveCount(0);
  await draft.getByLabel('基準値', { exact: true }).fill('5');
  await draft.getByLabel('現在値', { exact: true }).fill('5');
  await draft.getByLabel('目標値', { exact: true }).fill('3');
  await draft.getByLabel('期限', { exact: true }).fill('2027-03-31');
  await page.getByTestId('proj-drafts-save-all').click();
  await expect(draft).toHaveCount(0);
  await expect(page.getByTestId('proj-okr-drafts')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('proj-kpi-panel').locator('table')).toContainText('出荷所要日数');
  await expect(page.getByTestId('proj-okr-panel')).toContainText('出荷までの流れを改善する');
  await expect(page.getByTestId('proj-okr-panel')).toContainText('定義案');
  const row = page.getByTestId('proj-kpi-panel').locator('tr', { hasText: '出荷所要日数' });
  await row.getByRole('button', { name: '出荷所要日数 を編集' }).click();
  await page.locator('form.proj-kpi-form').getByLabel('現在値', { exact: true }).fill('4');
  await page.locator('form.proj-kpi-form').getByRole('button', { name: '保存' }).click();
  await page.reload();
  await expect(row).toContainText('定義案');
  expect(await scan(page)).toEqual([]);
});

test('missing OKRs link to existing pack KPIs without replacing them', async ({ page }) => {
  await seed(page, {});
  await page.route('**/relay/ai', async (route) => {
    expect(route.request().postDataJSON().prompt).toContain('"missing":{"kpis":false,"okrs":true}');
    await route.fulfill({ json: { text: JSON.stringify({
      kpis: [],
      okrs: [{ objective: '出荷を改善する', reason: '納期の課題', evidenceIds: ['issue-lead-time'], kpiIds: ['kpi-lead-time'] }],
    }), inputTokens: 100, outputTokens: 100 } });
  });
  await enableDraftAi(page);
  const table = page.getByTestId('proj-kpi-panel').locator('table');
  const before = await table.innerText();
  await page.getByTestId('proj-missing-copilot').click();
  await expect(page.getByTestId('proj-okr-drafts')).toBeVisible();
  await expect(page.getByTestId('proj-kpi-drafts')).toHaveCount(0);
  expect(await table.innerText()).toBe(before);
  await page.getByTestId('proj-okr-drafts').getByRole('button', { name: 'ドラフト「出荷を改善する」を保存' }).click();
  await expect(page.getByTestId('proj-okr-panel')).toContainText('出荷を改善する');
  expect(await table.innerText()).toBe(before);
});

test('missing draft failures are explicit and leave the project unchanged', async ({ page }) => {
  await seed(page, {}, true);
  await page.route('**/relay/ai', (route) => route.fulfill({ json: { text: '{}', inputTokens: 100, outputTokens: 100 } }));
  await enableDraftAi(page);
  await page.getByTestId('proj-missing-copilot').click();
  await expect(page.getByTestId('proj-adopt-notice')).toContainText('回答が想定した形式ではありません');
  await expect(page.getByTestId('proj-kpi-drafts')).toHaveCount(0);
  await expect(page.getByTestId('proj-okr-drafts')).toHaveCount(0);
  await expect(page.getByTestId('proj-missing-copilot')).toBeEnabled();
});

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
  await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
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

test('FR-341: internal KPIs/OKRs show their organisation, a unit-only project is warned, and the organisation is editable (AC-948)', async ({ page }) => {
  await seed(page, {
    ...okr,
    orgUnits: [
      { id: 'org-company', level: 'legalEntity', name: 'Contoso', basis: 'userInput' },
      { id: 'org-unit', level: 'business', name: '物流事業部', basis: 'inferred', sourceIds: ['source-doc-1'] },
    ],
    kpis: okr.kpis.map((k) => (k.id === 'k-reach' ? { ...k, orgUnitId: 'org-company' } : k)),
    objectives: okr.objectives.map((o) => ({ ...o, orgUnitId: 'org-unit' })),
  });
  await expect(page.getByTestId('proj-pack-kpi-org-k-reach')).toHaveText('全社・事業会社: Contoso');
  await expect(page.getByTestId('proj-pack-okr-org-o-growth')).toContainText('事業部・事業本部: 物流事業部');
  await expect(page.getByTestId('proj-pack-okr-org-o-growth')).toContainText('推定');
  await expect(page.getByTestId('proj-pack-kpi-org-k-wins')).toHaveText('未設定');
  await expect(page.getByTestId('proj-kpi-unit-only')).toHaveCount(0);

  // A KPI of the business unit only: the company-level measure is missing, so the BPR scope would be understated.
  const form = page.locator('form.proj-kpi-form');
  await page.getByTestId('proj-kpi-name').fill('構内搬送コスト率');
  await form.getByLabel('単位', { exact: true }).fill('日');
  await form.getByLabel('基準値', { exact: true }).fill('5');
  await form.getByLabel('現在値', { exact: true }).fill('4');
  await form.getByLabel('目標値', { exact: true }).fill('3');
  await form.getByLabel('期限', { exact: true }).fill('2027-03-31');
  await expect(page.getByTestId('proj-kpi-org-name')).toBeDisabled();
  await page.getByTestId('proj-kpi-org-level').selectOption('business');
  await page.getByTestId('proj-kpi-org-name').fill('物流事業部');
  await form.getByRole('button', { name: '追加' }).click();
  const row = page.getByTestId('proj-kpi-panel').locator('tr', { hasText: '構内搬送コスト率' });
  await expect(row).toContainText('事業部・事業本部: 物流事業部');
  await expect(page.getByTestId('proj-kpi-unit-only')).toContainText('全社');
  expect(await scan(page)).toEqual([]);

  // Re-scoping it to the company clears the warning; the choice is kept across a reload.
  await row.getByRole('button', { name: '構内搬送コスト率 を編集' }).click();
  await expect(page.getByTestId('proj-kpi-org-level')).toHaveValue('business');
  await page.getByTestId('proj-kpi-org-level').selectOption('legalEntity');
  await page.getByTestId('proj-kpi-org-name').fill('Contoso');
  await form.getByRole('button', { name: '保存' }).click();
  await expect(row).toContainText('全社・事業会社: Contoso');
  await expect(page.getByTestId('proj-kpi-unit-only')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('proj-kpi-panel').locator('tr', { hasText: '構内搬送コスト率' })).toContainText('全社・事業会社: Contoso');
});
