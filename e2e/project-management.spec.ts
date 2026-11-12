import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { deviceSnapshot, seedDeviceData, setup } from './helpers.ts';
import { samplePack } from '../src/data/sample.ts';

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
