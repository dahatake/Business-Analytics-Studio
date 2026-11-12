import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { deviceSnapshot, seedDeviceData, setup } from './helpers.ts';
import { samplePack } from '../src/data/sample.ts';

const analysis = {
  asOf: '2026-11-10',
  entityScope: { legalEntity: 'Contoso', figuresScope: ['legal entity'] },
  statedObjectives: [{ id: 'O1', text: 'Reduce delivery delays', horizon: '2026', basis: 'customerStated', sourceIds: ['S1'] }],
  companyKpis: [{ id: 'K1', name: 'On-time delivery', target: '95', unit: '%', period: '2026', scope: 'legal entity', objectiveIds: ['O1'], sourceIds: ['S1'] }],
  segments: [], structuralIssues: [],
  analystHypotheses: [{ text: 'Not for generation', type: 'strategy' }],
  sources: [{ id: 'S1', title: 'Meeting notes', type: 'internal', accessedDate: '2026-11-10', locator: 'p. 2', excerpt: 'On-time delivery 95 % 2026 legal entity' }],
};

async function seed(page: Page, launch = true, lang: 'ja' | 'en' = 'ja') {
  await setup(page, { skipLaunch: !launch, lang });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.management')) return;
    sessionStorage.setItem('bas.e2e.management', '1');
    const createdAt = '2026-11-10T00:00:00.000Z';
    localStorage.setItem('bas.projects', JSON.stringify({
      version: 1,
      state: {
        companies: [
          { id: 'co-a', name: 'Contoso', createdAt },
          { id: 'co-b', name: 'Other', createdAt },
          { id: 'co-empty', name: 'Empty', createdAt },
        ],
        projects: [
          { id: 'pj-alpha', companyId: 'co-a', name: 'Alpha', createdAt, step: 'kpi' },
          { id: 'pj-beta', companyId: 'co-a', name: 'Beta', createdAt, step: 'define' },
          { id: 'pj-other', companyId: 'co-b', name: 'Gamma', createdAt, step: 'define' },
        ],
        target: { kind: 'project', projectId: 'pj-alpha' },
        lastProjectId: 'pj-alpha',
        demoStep: 'define',
      },
    }));
    for (const id of ['pj-alpha', 'pj-beta', 'pj-other', 'demo']) {
      localStorage.setItem(`bas.scope.${id}.management-test`, JSON.stringify({ note: id }));
    }
  });
  await page.goto('/#/projects');
  await expect(page.getByTestId(launch ? 'launch-screen' : 'proj-company-Contoso')).toBeVisible();
}

async function stored(page: Page) {
  return page.evaluate(() => ({
    registry: JSON.parse(localStorage.getItem('bas.projects')!).state,
    alpha: localStorage.getItem('bas.scope.pj-alpha.management-test'),
    beta: localStorage.getItem('bas.scope.pj-beta.management-test'),
    other: localStorage.getItem('bas.scope.pj-other.management-test'),
    demo: localStorage.getItem('bas.scope.demo.management-test'),
  }));
}

test('launch renames validate, cancel and persist without changing project identity or data', async ({ page }) => {
  await seed(page);
  const before = await stored(page);
  const rename = page.getByTestId('proj-rename-dialog');
  const save = rename.getByRole('button', { name: '保存', exact: true });
  await page.getByRole('button', { name: 'Contoso の名前を変更', exact: true }).click();
  await expect(rename.getByRole('textbox')).toHaveValue('Contoso');
  await expect(rename.getByRole('textbox')).toBeFocused();
  await rename.getByRole('textbox').fill('   ');
  await save.click();
  await expect(rename).toContainText('入力してください。');
  await rename.getByRole('textbox').fill(' Other ');
  await save.click();
  await expect(rename).toContainText('同じ名前の企業がすでにあります。');
  expect(await stored(page)).toEqual(before);
  await rename.getByRole('textbox').fill('Discarded');
  await rename.getByRole('button', { name: 'キャンセル' }).click();
  expect(await stored(page)).toEqual(before);
  await page.getByRole('button', { name: 'Contoso の名前を変更', exact: true }).click();
  await rename.getByRole('textbox').fill(' Renamed ');
  await rename.getByRole('textbox').press('Enter');
  await expect(page.getByTestId('launch-company-Renamed')).toBeVisible();

  const project = page.getByTestId('launch-project-pj-alpha');
  await project.getByRole('button', { name: /名前を変更/ }).click();
  await rename.getByRole('textbox').fill('Beta');
  await save.click();
  await expect(rename).toContainText('この企業に同じ名前の Project がすでにあります。');
  await rename.getByRole('textbox').fill(' ');
  await save.click();
  await expect(rename).toContainText('入力してください。');
  await rename.getByRole('textbox').fill('Discarded');
  await page.keyboard.press('Escape');
  await expect(project).toContainText('Alpha');
  await project.getByRole('button', { name: /名前を変更/ }).click();
  await rename.getByRole('textbox').fill(' Gamma ');
  await save.click();
  await expect(project).toContainText('Gamma');
  const after = await stored(page);
  expect(after.registry.companies[0]).toEqual({ ...before.registry.companies[0], name: 'Renamed' });
  expect(after.registry.projects[0]).toEqual({ ...before.registry.projects[0], name: 'Gamma' });
  expect(after.alpha).toEqual(before.alpha);
  expect(after.registry.target).toEqual(before.registry.target);
  expect(after.registry.lastProjectId).toBe('pj-alpha');
  await page.reload();
  await expect(page.getByTestId('launch-company-Renamed')).toContainText('Gamma');
  expect(await stored(page)).toEqual(after);
  const accessibility = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).exclude('[data-tabster-dummy]').analyze();
  expect(accessibility.violations).toEqual([]);
  await project.getByRole('button', { name: /を開く/ }).click();
  await expect(page.getByTestId('proj-target-menu')).toContainText('Renamed-Gamma');
  await page.evaluate(() => { window.location.hash = '/home'; });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed-Gamma');
});

test('launch confirms deletion, cascades data cleanup and leaves other companies and the sample intact', async ({ page }) => {
  await seed(page);
  const before = await stored(page);
  const confirm = page.getByTestId('proj-delete-confirm');
  const remove = confirm.getByRole('button', { name: '削除', exact: true });
  await page.getByTestId('launch-project-pj-alpha').getByRole('button', { name: /を削除/ }).click();
  await expect(confirm).toContainText('Contoso / Alpha');
  await confirm.getByRole('button', { name: 'キャンセル' }).click();
  expect(await stored(page)).toEqual(before);
  await page.getByTestId('launch-project-pj-alpha').getByRole('button', { name: /を削除/ }).click();
  await remove.click();
  await expect(page.getByTestId('launch-project-pj-alpha')).toHaveCount(0);
  const afterProject = await stored(page);
  expect(afterProject.alpha).toBeNull();
  expect(afterProject.beta).toBe(before.beta);
  expect(afterProject.registry.target).toEqual({ kind: 'demo' });
  expect(afterProject.registry.lastProjectId).toBeNull();
  await page.reload();
  expect(await stored(page)).toEqual(afterProject);

  await page.getByRole('button', { name: 'Contoso を削除', exact: true }).click();
  await expect(confirm).toContainText('Project 1 件');
  await page.keyboard.press('Escape');
  expect(await stored(page)).toEqual(afterProject);
  await page.getByRole('button', { name: 'Contoso を削除', exact: true }).click();
  await remove.click();
  await expect(page.getByTestId('launch-company-Contoso')).toHaveCount(0);
  const afterCompany = await stored(page);
  expect(afterCompany.beta).toBeNull();
  expect(afterCompany.other).toBe(before.other);
  expect(afterCompany.demo).toBe(before.demo);
  expect(afterCompany.registry.projects.map((p: { id: string }) => p.id)).toEqual(['pj-other']);

  await page.getByRole('button', { name: 'Empty を削除', exact: true }).click();
  await expect(confirm).toContainText('Project 0 件');
  await remove.click();
  await expect(page.getByTestId('launch-company-Empty')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('launch-company-Other')).toContainText('Gamma');
  await expect(page.getByTestId('launch-sample').getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('launch-sample')).not.toContainText('削除');
  await page.getByTestId('launch-open-demo').click();
  await expect(page.getByTestId('proj-target-menu')).toContainText('デモ');
});

test('management screen uses the same validated dialogs and preserves a company after its last project is deleted', async ({ page }) => {
  await seed(page, false);
  const company = page.getByTestId('proj-company-Contoso');
  const companyDialog = page.getByTestId('proj-company-dialog');
  await company.getByRole('button', { name: 'Contoso の企業情報を編集', exact: true }).click();
  await expect(page.getByTestId('proj-company-edit-name')).toHaveValue('Contoso');
  await page.getByTestId('proj-company-edit-name').fill('Other');
  await page.getByTestId('proj-company-edit-save').click();
  await expect(companyDialog).toContainText('同じ名前の企業がすでにあります。');
  await companyDialog.getByRole('button', { name: 'キャンセル' }).click();
  const projectDialog = page.getByTestId('proj-edit-dialog');
  await company.getByRole('button', { name: 'Alpha を編集', exact: true }).click();
  await page.getByTestId('proj-edit-name').fill('Beta');
  await page.getByTestId('proj-edit-save').click();
  await expect(projectDialog).toContainText('この企業に同じ名前の Project がすでにあります。');
  await page.getByTestId('proj-edit-name').fill('Updated');
  await page.getByTestId('proj-edit-save').click();
  await expect(projectDialog).toHaveCount(0);
  await expect(company.getByRole('rowheader', { name: 'Updated', exact: false })).toBeVisible();
  await expect(page.getByTestId('proj-target-menu')).toContainText('Contoso-Updated');
  for (const name of ['Updated', 'Beta']) {
    await company.getByRole('button', { name: `${name} を削除`, exact: true }).click();
    await page.getByTestId('proj-delete-confirm').getByRole('button', { name: '削除', exact: true }).click();
  }
  await expect(company).toContainText('Project はまだありません。');
  await page.reload();
  await expect(company).toContainText('Project はまだありません。');
  await page.getByTestId('proj-project-name-Contoso').fill('Replacement');
  await company.getByRole('button', { name: 'Project を作成', exact: true }).click();
  await expect(company.getByRole('rowheader', { name: 'Replacement' })).toBeVisible();
});

test('company information comes first and is shared; project inputs are multi-line and relations are drawn', async ({ page }) => {
  await seed(page, false);
  const company = page.getByTestId('proj-company-Contoso');
  const profile = company.getByTestId('proj-company-profile');
  // Company information is the first block of the company, above the projects table.
  expect(await company.evaluate((el) => {
    const info = el.querySelector('[data-testid="proj-company-profile"]')!;
    const table = el.querySelector('table')!;
    return Boolean(info.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await expect(profile).toContainText('未入力');

  await company.getByRole('button', { name: 'Contoso の企業情報を編集', exact: true }).click();
  await page.getByTestId('proj-company-edit-industry').fill('IT サービス');
  await page.getByTestId('proj-company-edit-url').fill('https://www.contoso.example');
  await page.getByTestId('proj-company-edit-notes').fill('グローバルの営業組織\n日本はアジア地域の一部');
  await page.getByTestId('proj-company-edit-save').click();
  await expect(profile).toContainText('IT サービス');
  await expect(profile.getByRole('link', { name: 'https://www.contoso.example' })).toBeVisible();

  await company.getByRole('button', { name: 'Alpha を編集', exact: true }).click();
  const purpose = page.getByTestId('proj-edit-purpose');
  expect(await purpose.evaluate((el) => el.tagName)).toBe('TEXTAREA');
  await purpose.fill('受注予測の精度を上げる\n営業パイプラインの滞留を減らす');
  await page.getByTestId('proj-edit-focus').fill('日本の営業');
  await page.getByTestId('proj-edit-save').click();
  const brief = page.getByTestId('proj-brief-purpose-pj-alpha');
  await expect(brief).toHaveText('受注予測の精度を上げる\n営業パイプラインの滞留を減らす');
  expect(await brief.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(30);
  await expect(page.getByTestId('proj-brief-pj-alpha')).toContainText('日本の営業');
  await expect(page.getByTestId('proj-brief-pj-beta')).toContainText('目的が未入力です');

  await page.getByTestId('proj-project-name-Contoso').fill('Forecast');
  await page.getByTestId('proj-project-purpose-Contoso').fill('営業パイプラインのデータから受注予測を作る');
  await company.getByRole('button', { name: 'Project を作成', exact: true }).click();
  await expect(company.getByRole('rowheader', { name: 'Forecast' })).toBeVisible();

  const rel = company.getByTestId('proj-rel');
  await expect(rel.getByTestId('proj-rel-suggestion')).toHaveCount(1);
  await expect(rel.getByTestId('proj-rel-suggestion')).toContainText('Alpha');
  await expect(rel.getByTestId('proj-rel-suggestion')).toContainText('Forecast');
  await rel.getByTestId('proj-rel-suggestion').getByRole('button', { name: '同じ課題として登録' }).click();
  await expect(rel.getByTestId('proj-rel-edge')).toHaveCount(1);
  await expect(rel.getByTestId('proj-rel-edge')).toHaveAttribute('data-kind', 'same');
  await expect(rel.getByTestId('proj-rel-groups')).toContainText('Alpha');
  await expect(rel.getByTestId('proj-rel-suggest')).toHaveCount(0);

  const form = rel.getByTestId('proj-rel-form');
  await form.getByTestId('proj-rel-from').selectOption({ label: 'Beta' });
  await form.getByTestId('proj-rel-kind').selectOption('dependsOn');
  await form.getByTestId('proj-rel-to').selectOption({ label: 'Alpha' });
  await form.getByTestId('proj-rel-add').click();
  await form.getByTestId('proj-rel-from').selectOption({ label: 'Alpha' });
  await form.getByTestId('proj-rel-kind').selectOption('dependsOn');
  await form.getByTestId('proj-rel-to').selectOption({ label: 'Beta' });
  await form.getByTestId('proj-rel-add').click();
  await expect(rel.getByTestId('proj-rel-error')).toContainText('この 2 つの Project にはすでに関係があります');
  await expect(rel.getByTestId('proj-rel-edge')).toHaveCount(2);
  await expect(rel.getByTestId('proj-rel-table')).toContainText('Beta は Alpha に依存する');

  await page.reload();
  await expect(company.getByTestId('proj-rel-edge')).toHaveCount(2);
  await expect(page.getByTestId('proj-brief-purpose-pj-alpha')).toHaveText('受注予測の精度を上げる\n営業パイプラインの滞留を減らす');
  const accessibility = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).exclude('[data-tabster-dummy]').analyze();
  expect(accessibility.violations).toEqual([]);

  // The project is deleted with its relations.
  await company.getByRole('button', { name: 'Beta を削除', exact: true }).click();
  await page.getByTestId('proj-delete-confirm').getByRole('button', { name: '削除', exact: true }).click();
  await expect(company.getByTestId('proj-rel-edge')).toHaveCount(1);
  expect((await stored(page)).registry.relations).toHaveLength(1);
});

test('projects with the same business issue in other words are flagged with reasons and merged only after agreement', async ({ page }) => {
  await seed(page, false);
  const company = page.getByTestId('proj-company-Contoso');
  const editPurpose = async (name: string, purpose: string) => {
    await company.getByRole('button', { name: `${name} を編集`, exact: true }).click();
    await page.getByTestId('proj-edit-purpose').fill(purpose);
    await page.getByTestId('proj-edit-save').click();
  };
  // No shared wording (Japanese vs English), so only the business themes connect them.
  await editPurpose('Alpha', '既存顧客の解約を減らす\n更新の売上を守る');
  await expect(company.getByTestId('proj-merge-warning')).toHaveCount(0);
  await editPurpose('Beta', 'Reduce churn and protect renewal revenue');
  const warning = company.getByTestId('proj-merge-warning');
  await expect(warning).toHaveCount(1);
  await expect(warning).toHaveAttribute('data-pair', 'Alpha|Beta');
  await expect(warning).toContainText('業務テーマが同じ');
  await expect(warning).toContainText('顧客維持・解約');
  await expect(warning).toContainText('売上・受注');

  await warning.getByTestId('proj-merge-dismiss').click();
  await expect(company.getByTestId('proj-merge-warning')).toHaveCount(0);
  await expect(company.getByTestId('proj-merge-dismissed')).toContainText('Alpha と Beta');
  await page.reload();
  await expect(company.getByTestId('proj-merge-warning')).toHaveCount(0);
  await company.getByTestId('proj-merge-restore').click();
  await expect(warning).toHaveCount(1);

  // A third project depends on Beta; the merge moves that dependency to the kept project.
  await page.getByTestId('proj-project-name-Contoso').fill('Support');
  await page.getByTestId('proj-project-purpose-Contoso').fill('オフィス移転の計画');
  await company.getByRole('button', { name: 'Project を作成', exact: true }).click();
  const form = company.getByTestId('proj-rel-form');
  await form.getByTestId('proj-rel-from').selectOption({ label: 'Support' });
  await form.getByTestId('proj-rel-kind').selectOption('dependsOn');
  await form.getByTestId('proj-rel-to').selectOption({ label: 'Beta' });
  await form.getByTestId('proj-rel-add').click();
  await expect(warning).toHaveCount(1);

  await warning.getByTestId('proj-merge-open').click();
  const dialog = page.getByTestId('proj-merge-dialog');
  await expect(dialog.getByTestId('proj-merge-dialog-reasons')).toContainText('顧客維持・解約');
  await expect(dialog.getByTestId('proj-merge-compare')).toContainText('Reduce churn and protect renewal revenue');
  await expect(dialog.getByRole('radio', { name: /^Alpha/ })).toBeChecked();
  const purpose = dialog.getByTestId('proj-merge-purpose');
  await expect(purpose).toHaveValue('既存顧客の解約を減らす\n更新の売上を守る\n\n【統合元: Beta】\nReduce churn and protect renewal revenue');
  await expect(dialog.getByTestId('proj-merge-effects')).toContainText('関係 1 件を Alpha に移します');
  await expect(dialog.getByTestId('proj-merge-effects')).toContainText('Beta の作業データは削除されます');
  const submit = dialog.getByTestId('proj-merge-submit');
  await expect(submit).toBeDisabled();
  const accessibility = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).exclude('[data-tabster-dummy]').analyze();
  expect(accessibility.violations).toEqual([]);
  const before = await stored(page);
  await dialog.getByTestId('proj-merge-name').fill('Retention');
  await dialog.getByTestId('proj-merge-confirm').check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(dialog).toHaveCount(0);
  await expect(company.getByTestId('proj-merge-done')).toContainText('Beta を Retention に統合しました。関係を 1 件移し、0 件を削除しました。');
  await expect(company.getByRole('rowheader', { name: 'Beta' })).toHaveCount(0);
  await expect(company.getByRole('rowheader', { name: /^Retention/ })).toBeVisible();
  await expect(page.getByTestId('proj-brief-purpose-pj-alpha')).toContainText('Reduce churn and protect renewal revenue');
  await expect(company.getByTestId('proj-rel-table')).toContainText('Support は Retention に依存する');
  await expect(company.getByTestId('proj-merge-warning')).toHaveCount(0);
  await page.reload();
  const history = page.getByTestId('proj-merged-pj-alpha');
  await expect(history).toContainText('Beta');
  await history.locator('summary').click();
  await expect(history).toContainText('業務テーマが同じ');
  const after = await stored(page);
  expect(after.registry.projects.map((p: { id: string }) => p.id)).not.toContain('pj-beta');
  expect(after.alpha).toBe(before.alpha);
  expect(after.beta).toBeNull();
  expect(after.other).toBe(before.other);
});

test('English launch management works on a narrow screen without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, true, 'en');
  await page.getByRole('button', { name: 'Rename Contoso', exact: true }).click();
  const rename = page.getByTestId('proj-rename-dialog');
  await rename.getByRole('textbox').fill('Renamed');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('launch-company-Renamed')).toBeVisible();
  await page.getByRole('button', { name: 'Delete Renamed', exact: true }).click();
  const confirm = page.getByTestId('proj-delete-confirm');
  await expect(confirm).toContainText('2 projects');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('company deletion purges device packs and boards only for its projects', async ({ page }) => {
  await seed(page);
  const index = Object.fromEntries(['pj-beta', 'pj-other'].map((projectId) => [projectId, {
    projectId, packId: samplePack.packId, company: samplePack.company, isSample: samplePack.isSample,
    entities: samplePack.entities.length, importedAt: '2026-11-10T00:00:00.000Z', files: ['sample.json'],
  }]));
  await seedDeviceData(page, {
    'bas.packs.index': JSON.stringify(index),
    ...Object.fromEntries(['pj-beta', 'pj-other'].flatMap((id) => [
      [`bas.binary.pack.${id}`, JSON.stringify(samplePack)],
      [`bas.binary.ink.${id}::board`, JSON.stringify({ strokes: [], notes: [], cards: [], links: [] })],
    ])),
  });
  const keys = async () => {
    const records = (await deviceSnapshot(page)).records;
    const result = { 'bas-packs': [] as string[], 'bas-ink': [] as string[] };
    for (const [key, record] of Object.entries(records)) {
      if (record.value === null) continue;
      if (key.startsWith('bas.binary.pack.')) result['bas-packs'].push(key.slice('bas.binary.pack.'.length));
      if (key.startsWith('bas.binary.ink.')) result['bas-ink'].push(key.slice('bas.binary.ink.'.length));
    }
    result['bas-packs'].sort();
    result['bas-ink'].sort();
    return result;
  };
  const before = await keys();
  await page.reload();
  await expect(page.getByTestId('launch-project-pj-beta')).toContainText('顧客パック取込済み');
  await page.getByTestId('launch-project-pj-beta').getByRole('button', { name: /名前を変更/ }).click();
  await page.getByTestId('proj-rename-dialog').getByRole('textbox').fill('Renamed pack project');
  await page.getByTestId('proj-rename-dialog').getByRole('button', { name: '保存', exact: true }).click();
  expect(await keys()).toEqual(before);
  await expect(page.getByTestId('launch-project-pj-beta')).toContainText('顧客パック取込済み');
  await page.getByRole('button', { name: 'Contoso を削除', exact: true }).click();
  await expect(page.getByTestId('proj-delete-confirm')).toContainText('Project 2 件');
  await page.getByTestId('proj-delete-confirm').getByRole('button', { name: '削除', exact: true }).click();
  await expect.poll(keys).toEqual({ 'bas-packs': ['pj-other'], 'bas-ink': ['pj-other::board'] });
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('bas.packs.index')!)))).toEqual(['pj-other']);
  await page.reload();
  await expect(page.getByTestId('launch-company-Contoso')).toHaveCount(0);
  await expect(page.getByTestId('launch-project-pj-other')).toContainText('顧客パック取込済み');
  expect(await keys()).toEqual({ 'bas-packs': ['pj-other'], 'bas-ink': ['pj-other::board'] });
});

test('company analysis, alignment, independent evaluation and generation preview persist without external calls', async ({ page }) => {
    await page.route('**/relay/news', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ company: 'Contoso', lang: 'ja', provider: 'Google News RSS', fetchedAt: '2026-11-10T00:00:00Z', articles: [] }),
    }));
    let aiCalls = 0;
    await page.route('**/relay/ai', (route) => { aiCalls++; return route.abort(); });
    await seed(page, false);
    const company = page.getByTestId('proj-company-Contoso');
    await page.getByTestId('proj-edit-pj-alpha').click();
    await page.getByTestId('proj-edit-purpose').fill('Improve deliveries');
    await page.getByTestId('proj-edit-save').click();
    await company.getByTestId('company-anchor-edit').click();
    await company.getByTestId('company-anchor-json').fill(JSON.stringify(analysis));
    await company.getByTestId('company-anchor-save').click();
    await expect(company.getByTestId('company-anchor-summary')).toContainText('Reduce delivery delays');

    await page.getByTestId('project-alignment-pj-alpha').click();
    const dialog = page.getByTestId('alignment-dialog');
    await dialog.getByTestId('alignment-kind').selectOption('direct');
    await dialog.getByRole('checkbox', { name: /O1: Reduce delivery delays/ }).check();
    await dialog.getByLabel('企業・部門の KPI').selectOption('K1');
    await dialog.getByLabel('Project の KPI').fill('Delay rate');
    await dialog.getByLabel('寄与の道筋・因果関係').fill('Fewer delays improve delivery.');
    await dialog.getByRole('checkbox', { name: /S1: Meeting notes/ }).check();
    await dialog.getByText('AI に整合案と反証を作らせる').click();
    await expect(dialog.getByTestId('alignment-ai-preview')).toContainText('Reduce delivery delays');
    await expect(dialog.getByTestId('alignment-ai-preview')).not.toContainText('Not for generation');
    await expect(dialog.getByTestId('alignment-ai-run')).toBeDisabled();
    await dialog.getByLabel('確認者の役割（氏名は不要）').fill('Sponsor');
    await dialog.getByLabel('確認日').fill('2026-11-10');
    await dialog.getByTestId('alignment-confirm').check();
    await dialog.getByTestId('alignment-save').click();
    await expect(dialog).toContainText('整合記録を保存しました。');
    await dialog.getByRole('button', { name: '閉じる' }).click();

    const evaluation = company.getByTestId('alignment-evaluation-co-a');
    await evaluation.locator('summary').click();
    const cases = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, expected: 'unaligned', observed: i === 9 ? 'direct' : 'unaligned', negativeControl: true })),
      { id: 'p1', expected: 'direct', observed: 'direct', negativeControl: false },
      { id: 'p2', expected: 'indirect', observed: 'indirect', negativeControl: false },
      { id: 'p3', expected: 'direct', observed: 'indirect', negativeControl: false },
      { id: 'p4', expected: 'indirect', observed: 'direct', negativeControl: false },
    ];
    await evaluation.getByTestId('alignment-evaluation-json').fill(JSON.stringify(cases));
    await expect(evaluation.getByTestId('alignment-evaluation-result')).toContainText('90%');
    await expect(evaluation.getByTestId('alignment-evaluation-result')).toContainText('重大な誤判定: 1 件');
    await expect(evaluation.getByTestId('alignment-evaluation-result')).toContainText('95% Wilson');
    await expect(evaluation.getByTestId('alignment-evaluation-result')).toContainText('κ の 95% 信頼区間（漸近正規近似）: -0.98〜0.98');
    await evaluation.getByTestId('alignment-evaluation-independent').check();
    await evaluation.getByTestId('alignment-evaluation-save').click();
    await expect(evaluation).toContainText('評価ケースを端末に保存しました。');
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await expect(company.getByTestId('company-anchor-summary')).toContainText('Reduce delivery delays');
    await evaluation.locator('summary').click();
    await expect(evaluation.getByTestId('alignment-evaluation-result')).toContainText('90%');
    await page.getByTestId('project-alignment-pj-alpha').click();
    await expect(dialog.getByTestId('alignment-confirm')).toBeChecked();
    await dialog.getByRole('button', { name: '閉じる' }).click();

    const download = page.waitForEvent('download');
    await company.getByRole('button', { name: 'Alpha を JSON で書き出す' }).click();
    const exportedPath = await (await download).path();
    expect(JSON.parse(readFileSync(exportedPath, 'utf8'))).toMatchObject({
      companyAnchor: { versions: [{ anchor: { statedObjectives: [{ id: 'O1' }] } }] },
      project: { alignments: [{ kind: 'direct', status: 'confirmed' }] },
    });
    await page.getByTestId('audience-toggle').click();
    await expect(company.getByTestId('company-anchor-co-a')).toHaveCount(0);
    await company.getByRole('button', { name: 'Alpha を JSON で書き出す' }).click();
    await expect(page.getByRole('status').filter({ hasText: '社外表示では企業分析を含むバックアップを出力できません。' })).toBeVisible();
    await page.getByTestId('audience-toggle').click();

    await page.getByTestId('proj-generate-pj-alpha').click();
    const gen = page.getByTestId('gen-dialog');
    await gen.getByTestId('gen-anchor-preview').locator('summary').click();
    await expect(gen.getByTestId('gen-anchor-preview')).toContainText('Reduce delivery delays');
    await expect(gen.getByTestId('gen-anchor-preview')).not.toContainText('Not for generation');
    await gen.getByTestId('gen-public-topic').fill('public logistics');
    await expect(gen.getByTestId('gen-public-topic-consent')).not.toBeChecked();
    await gen.getByTestId('gen-public-topic-consent').check();
    await gen.getByTestId('gen-public-topic').fill('other public topic');
    await expect(gen.getByTestId('gen-public-topic-consent')).not.toBeChecked();
    expect(aiCalls).toBe(0);
});

test('company history can be reviewed and restored without changing the generation version until saved', async ({ page }) => {
  await page.route('**/relay/news', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ company: 'Contoso', lang: 'ja', provider: 'Google News RSS', fetchedAt: '2026-11-10T00:00:00Z', articles: [] }),
  }));
  await seed(page, false);
  const company = page.getByTestId('proj-company-Contoso');
  await company.getByTestId('company-anchor-edit').click();
  await company.getByTestId('company-anchor-json').fill(JSON.stringify(analysis));
  await company.getByTestId('company-anchor-save').click();
  const updated = { ...analysis, statedObjectives: [{ ...analysis.statedObjectives[0], text: 'Reduce delays further' }] };
  await company.getByTestId('company-anchor-edit').click();
  await company.getByTestId('company-anchor-json').fill(JSON.stringify(updated));
  await company.getByTestId('company-anchor-save').click();
  await expect(company.getByTestId('company-anchor-version')).toHaveValue('2');
  await company.getByTestId('company-anchor-version').selectOption('1');
  await expect(company.getByTestId('company-anchor-summary')).toContainText('Reduce delivery delays');

  await page.getByTestId('proj-generate-pj-alpha').click();
  const gen = page.getByTestId('gen-dialog');
  await gen.getByTestId('gen-anchor-preview').locator('summary').click();
  await expect(gen.getByTestId('gen-anchor-preview')).toContainText('Reduce delays further');
  await gen.getByRole('button', { name: 'キャンセル' }).click();

  await company.getByTestId('company-anchor-edit').click();
  await expect(company.getByTestId('company-anchor-version')).toBeDisabled();
  await company.getByTestId('company-anchor-save').click();
  await expect(company.getByTestId('company-anchor-version')).toHaveValue('3');
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  await page.reload();
  await expect(company.getByTestId('company-anchor-version')).toHaveValue('3');
  await expect(company.getByTestId('company-anchor-summary')).toContainText('Reduce delivery delays');
  await company.getByTestId('company-anchor-version').selectOption('2');
  await expect(company.getByTestId('company-anchor-summary')).toContainText('Reduce delays further');
});

test('external view blocks unclassifiable content derived from internal company analysis', async ({ page }) => {
    await page.route('**/relay/news', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ company: 'Contoso', lang: 'ja', provider: 'Google News RSS', fetchedAt: '2026-11-10T00:00:00Z', articles: [] }),
    }));
    await seed(page, false);
    const internalPack = {
      ...samplePack,
      extensions: {
        ...samplePack.extensions,
        companyAnchor: { version: 1, savedAt: '2026-11-10T00:00:00.000Z', anchor: analysis },
        workflow: { stages: [{ id: 'private-stage', name: 'Internal workflow detail', sourceIds: ['source-anchor-1'] }] },
        okr: { kpis: [{ id: 'private-kpi', name: 'Internal KPI detail' }], objectives: [] },
        dataCatalog: { items: [{ name: 'Internal catalog detail', description: 'Private' }] },
      },
    };
    await seedDeviceData(page, {
      'bas.packs.index': JSON.stringify({ 'pj-alpha': {
        projectId: 'pj-alpha', packId: internalPack.packId, company: internalPack.company, isSample: false,
        entities: internalPack.entities.length, importedAt: '2026-11-10T00:00:00.000Z', files: ['synthetic.json'],
      } }),
      'bas.binary.pack.pj-alpha': JSON.stringify(internalPack),
    });
    await page.reload();
    await page.evaluate(() => { window.location.hash = '/flows'; });
    await expect(page.getByText('Internal workflow detail')).toBeVisible();
    await page.getByTestId('audience-toggle').click();
    await expect(page.getByTestId('company-anchor-external-restricted')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Internal workflow detail');
    await expect(page.locator('body')).not.toContainText('Internal KPI detail');
    await expect(page.locator('body')).not.toContainText('Internal catalog detail');
    await page.evaluate(() => { window.location.hash = '/data'; });
    await expect(page.getByTestId('company-anchor-external-restricted')).toBeVisible();
    await expect(page.getByTestId('pack-export')).toHaveCount(0);
    await page.getByTestId('audience-toggle').click();
    await expect(page.getByTestId('pack-export')).toBeVisible();
});

test('external view hides company snapshots and disables their raw pack export', async ({ page }) => {
  await page.route('**/relay/news', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ company: 'Contoso', lang: 'ja', provider: 'Google News RSS', fetchedAt: '2026-11-10T00:00:00Z', articles: [] }),
  }));
  await seed(page, false);
  const publicAnalysis = {
    ...analysis,
    statedObjectives: [{ ...analysis.statedObjectives[0], basis: 'published' }],
    sources: [{ ...analysis.sources[0], type: 'public', url: 'https://example.com/plan' }],
  };
  const pack = {
    ...samplePack,
    extensions: {
      ...samplePack.extensions,
      companyAnchor: { version: 1, savedAt: '2026-11-10T00:00:00.000Z', anchor: publicAnalysis },
      companyAlignment: { projectPurpose: 'Improve deliveries', alignments: [] },
    },
  };
  await seedDeviceData(page, {
    'bas.packs.index': JSON.stringify({ 'pj-alpha': {
      projectId: 'pj-alpha', packId: pack.packId, company: pack.company, isSample: false,
      entities: pack.entities.length, importedAt: '2026-11-10T00:00:00.000Z', files: ['synthetic.json'],
    } }),
    'bas.binary.pack.pj-alpha': JSON.stringify(pack),
  });
  await page.reload();
  await page.evaluate(() => { window.location.hash = '/data'; });
  await expect(page.getByTestId('pack-alignment-snapshot')).toBeVisible();
  await page.getByTestId('audience-toggle').click();
  await expect(page.getByTestId('company-anchor-external-restricted')).toHaveCount(0);
  await expect(page.getByTestId('pack-alignment-snapshot')).toHaveCount(0);
  await expect(page.getByTestId('pack-export')).toBeDisabled();
});
