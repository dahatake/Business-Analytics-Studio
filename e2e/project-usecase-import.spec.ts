import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { JAPANESE, open, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const UC_KEY = 'bas.scope.demo.usecases';
const NEW_ID = 'uc-e2e-new';
const EDITED = 'Edited in the use case screen';

interface UseCaseLike { id: string; name: unknown; [k: string]: unknown }

async function scan(page: Page) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function go(page: Page, route: string, lang: Lang) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.proj')) return;
    sessionStorage.setItem('bas.e2e.proj', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: '', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true }, version: 1 }));
  });
  await open(page, route, { lang });
}

const storedUseCases = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null') as UseCaseLike[] | null, UC_KEY);

/**
 * Export the demo discussion with its use cases, then (1) edit one use case in the app's use-case store and
 * (2) add a new use case to the exported file. Restoring the file must offer both as candidates.
 */
async function exportEditAndRestore(page: Page, info: TestInfo, lang: Lang) {
  await go(page, '/discussion', lang);
  await page.getByTestId('proj-export').click();
  await expect(page.getByTestId('proj-export-dialog')).toBeVisible();
  const downloadPromise = page.waitForEvent('download', (d) => d.suggestedFilename().includes('-discussion-'));
  await page.getByTestId('proj-export-confirm').click();
  await page.getByTestId('proj-persons-confirm').getByRole('button').first().click();
  const download = await downloadPromise;
  const md = readFileSync((await download.path())!, 'utf8');
  const m = /```json bas-export\r?\n([\s\S]*?)\r?\n```/.exec(md);
  expect(m).not.toBeNull();
  const bundle = JSON.parse(m![1]!) as { useCases: UseCaseLike[] };
  expect(bundle.useCases.length).toBeGreaterThan(1);
  const target = bundle.useCases[0]!;

  // Edit after the export (as in the use case screen): same id, different name.
  const current = bundle.useCases.map((u) => (u.id === target.id ? { ...u, name: EDITED, updatedAt: new Date().toISOString() } : u));
  await page.evaluate(({ k, v }) => localStorage.setItem(k, JSON.stringify(v)), { k: UC_KEY, v: current });
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();

  // The file also carries a use case that does not exist in the app yet.
  const extra = { ...bundle.useCases[1]!, id: NEW_ID, name: 'E2E new use case', updatedAt: '2026-11-09T00:00:00.000Z' };
  const edited = md.replace(m![0], `\`\`\`json bas-export\n${JSON.stringify({ ...bundle, useCases: [...bundle.useCases, extra] }, null, 2)}\n\`\`\``);
  const file = info.outputPath(`restore-${lang}.md`);
  writeFileSync(file, edited, 'utf8');
  await page.getByTestId('proj-import').setInputFiles(file);
  const dialog = page.getByTestId('proj-uc-import-dialog');
  await expect(dialog).toBeVisible();
  return { dialog, target, total: bundle.useCases.length };
}

test.describe('project: use cases in a restored export (I-1)', () => {
  test('changed use case is kept on "keep current", a new one is imported, and undo restores the list', async ({ page }, info) => {
    const { dialog, target, total } = await exportEditAndRestore(page, info, 'ja');
    await expect(dialog.getByTestId(`proj-uc-cand-${target.id}`)).toHaveAttribute('data-status', 'changed');
    await expect(dialog.getByTestId(`proj-uc-cand-status-${target.id}`)).toHaveText('同じ ID で変更あり');
    await expect(dialog.getByTestId(`proj-uc-cand-${NEW_ID}`)).toHaveAttribute('data-status', 'new');
    await expect(dialog.locator('[data-status="identical"]')).toHaveCount(total - 1);
    // A changed use case is never replaced without an explicit choice.
    await expect(page.getByTestId('proj-uc-import-apply')).toBeDisabled();
    await expect(page.getByTestId('proj-uc-import-pending')).toBeVisible();
    expect(await scan(page)).toEqual([]);

    await dialog.getByTestId(`proj-uc-cand-${target.id}`).getByRole('radio', { name: '現在の内容を残す' }).check();
    await expect(page.getByTestId(`proj-uc-cand-add-${NEW_ID}`)).toBeChecked();
    await page.getByTestId('proj-uc-import-apply').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('proj-uc-import-msg')).toContainText('追加 1 件・置き換え 0 件・現在のまま 1 件');

    const after = (await storedUseCases(page))!;
    expect(after).toHaveLength(total + 1);
    expect(after.find((u) => u.id === target.id)!.name).toBe(EDITED);
    expect(after.some((u) => u.id === NEW_ID)).toBe(true);

    await page.getByTestId('proj-uc-undo').click();
    await expect(page.getByTestId('proj-uc-import-msg')).toContainText('取り込む前の状態に戻しました');
    const undone = (await storedUseCases(page))!;
    expect(undone).toHaveLength(total);
    expect(undone.some((u) => u.id === NEW_ID)).toBe(false);
    expect(undone.find((u) => u.id === target.id)!.name).toBe(EDITED);
  });

  test('English dialog: axe has no violations and no Japanese except user data', async ({ page }, info) => {
    const { dialog, target } = await exportEditAndRestore(page, info, 'en');
    await expect(dialog.getByTestId(`proj-uc-cand-status-${target.id}`)).toHaveText('Same ID, changed');
    expect(await scan(page)).toEqual([]);
    const text = await dialog.evaluate((root) => {
      const parts: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest('[lang="ja"]')) parts.push(n.textContent ?? '');
      root.querySelectorAll('[aria-label]').forEach((e) => parts.push(e.getAttribute('aria-label') ?? ''));
      return parts.join('\n');
    });
    expect(text.split('\n').filter((l) => JAPANESE.test(l))).toEqual([]);
    await dialog.getByTestId(`proj-uc-cand-${target.id}`).getByRole('radio', { name: 'Replace with the file version' }).check();
    await page.getByTestId('proj-uc-import-apply').click();
    await expect(page.getByTestId('proj-uc-import-msg')).toContainText('1 added, 1 replaced');
    const after = (await storedUseCases(page))!;
    expect(after.find((u) => u.id === target.id)!.name).toEqual(target.name);
    expect(await scan(page)).toEqual([]);
  });
});
