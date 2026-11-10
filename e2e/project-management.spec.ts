import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { setup } from './helpers.ts';
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
  const rename = page.getByTestId('proj-rename-dialog');
  await company.getByRole('button', { name: 'Contoso の名前を変更', exact: true }).click();
  await rename.getByRole('textbox').fill('Other');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await expect(rename).toContainText('同じ名前の企業がすでにあります。');
  await rename.getByRole('button', { name: 'キャンセル' }).click();
  await company.getByRole('button', { name: 'Alpha の名前を変更', exact: true }).click();
  await rename.getByRole('textbox').fill('Updated');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
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

test('company deletion purges imported packs and IndexedDB boards only for its projects', async ({ page }) => {
  await seed(page);
  await page.evaluate(async (pack) => {
    const index = Object.fromEntries(['pj-beta', 'pj-other'].map((projectId) => [projectId, {
      projectId, packId: pack.packId, company: pack.company, isSample: pack.isSample,
      entities: pack.entities.length, importedAt: '2026-11-10T00:00:00.000Z', files: ['sample.json'],
    }]));
    localStorage.setItem('bas.packs.index', JSON.stringify(index));
    for (const [dbName, storeName] of [['bas-packs', 'packs'], ['bas-ink', 'boards']] as const) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(storeName, 'readwrite');
          const store = transaction.objectStore(storeName);
          for (const id of ['pj-beta', 'pj-other']) {
            store.put(storeName === 'packs' ? pack : { strokes: [], notes: [], cards: [], links: [] }, storeName === 'packs' ? id : `${id}::board`);
          }
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
    }
  }, samplePack);
  const keys = () => page.evaluate(async () => {
    const result: Record<string, IDBValidKey[]> = {};
    for (const [dbName, storeName] of [['bas-packs', 'packs'], ['bas-ink', 'boards']] as const) {
      result[dbName] = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(storeName, 'readonly');
          const get = transaction.objectStore(storeName).getAllKeys();
          transaction.oncomplete = () => { db.close(); resolve(get.result); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
    }
    return result;
  });
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
