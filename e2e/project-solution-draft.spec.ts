import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

/**
 * The last phase after the drafts: Copilot proposes each solution's type and every open section, the person approves, and
 * the software-solvable work is handed off — a requirements definition for an application, Microsoft 365 Copilot
 * instructions (prompt + attachments) for a prompt.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SOL = 'sol-knowledge-copilot';

async function scan(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]').analyze();
  return result.violations.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

/** Names inside a stored ZIP (the central directory). */
function zipNames(bytes: Buffer): string[] {
  const end = bytes.length - 22;
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const len = bytes.readUInt16LE(at + 28);
    names.push(bytes.subarray(at + 46, at + 46 + len).toString('utf8'));
    at += 46 + len + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return names;
}

async function promptSolution(page: Page, lang: Lang) {
  await open(page, '/deliverables?step=solution', { lang });
  await page.getByTestId(`sol-solution-${SOL}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.getByTestId(`sol-type-${SOL}`).selectOption('prompt');
  await page.getByTestId('dlv-tab-deliverable').click();
  await page.getByTestId(`sol-doc-${SOL}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });
}

test.describe('solution drafts and the software hand-off', () => {
  test('draft → approve fills the prompt spec; the Copilot instructions and the bundle download as ZIP', async ({ page }) => {
    await promptSolution(page, 'ja');
    await expect(page.getByTestId(`sol-doc-state-${SOL}`)).toContainText('未記入');
    await expect(page.getByTestId(`sol-doc-instruction-${SOL}`)).toBeDisabled();

    await page.getByTestId(`sol-draft-generate-${SOL}`).click();
    const review = page.getByTestId(`sol-draft-review-${SOL}`);
    await expect(review).toBeVisible();
    await expect(review).toHaveAttribute('data-mode', 'mock');
    await expect(page.getByTestId(`sol-draft-type-${SOL}`)).toHaveAttribute('data-type', 'prompt');
    await expect(page.getByTestId(`sol-draft-section-${SOL}-copilotPrompt`)).toContainText('添付ファイル');
    // Nothing is written before approval.
    await expect(page.getByTestId(`sol-doc-state-${SOL}`)).toContainText('未記入');
    expect(await scan(page)).toEqual([]);

    await page.getByTestId(`sol-draft-approve-${SOL}`).click();
    await expect(review).toHaveCount(0);
    await expect(page.getByTestId(`sol-doc-state-${SOL}`)).toHaveText('記入済み');
    await expect(page.getByTestId(`sol-doc-${SOL}-copilotAttachments`)).toHaveValue(/kpi\.csv/);

    const instruction = page.waitForEvent('download');
    await page.getByTestId(`sol-doc-instruction-${SOL}`).click();
    const file = await instruction;
    expect(file.suggestedFilename()).toMatch(/-copilot\.zip$/);
    const names = zipNames(await readFile((await file.path())!));
    expect(names).toEqual(expect.arrayContaining(['指示書.md', 'prompt.txt', 'attachments/kpi.csv']));

    const bundle = page.waitForEvent('download');
    await page.getByTestId('sol-docs-bundle').click();
    const all = zipNames(await readFile((await (await bundle).path())!));
    expect(all[0]).toBe('README.md');
    expect(all.filter((n) => n.endsWith('/prompt.txt'))).toHaveLength(1);
    expect(all.filter((n) => n.endsWith('/要求定義書.md')).length).toBeGreaterThan(0);
  });

  test('the draft review is localized in English', async ({ page }) => {
    await promptSolution(page, 'en');
    await page.getByTestId(`sol-draft-generate-${SOL}`).click();
    await expect(page.getByTestId(`sol-draft-review-${SOL}`)).toContainText('Copilot draft (not approved)');
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
  });

  test('FR-384: a person chooses AI Adoption or AI First per solution and the choice is kept', async ({ page }) => {
    await open(page, '/deliverables?step=solution');
    const solution = page.getByTestId(`sol-solution-${SOL}`);
    await solution.evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    const select = page.getByTestId(`sol-approach-${SOL}`);
    await expect(select).toHaveValue('');
    await expect(page.getByTestId(`sol-approach-badge-${SOL}`)).toHaveCount(0);
    await select.selectOption('first');
    await expect(page.getByTestId(`sol-approach-badge-${SOL}`)).toHaveText('AI First');
    await expect(solution).toContainText('BPR');
    expect(await scan(page)).toEqual([]);

    await page.goto('/#/deliverables?step=solution');
    await expect(page.getByTestId(`sol-approach-badge-${SOL}`)).toHaveText('AI First');
    await page.getByTestId(`sol-solution-${SOL}`).evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await page.getByTestId(`sol-approach-${SOL}`).selectOption('');
    await expect(page.getByTestId(`sol-approach-badge-${SOL}`)).toHaveCount(0);
  });
});
