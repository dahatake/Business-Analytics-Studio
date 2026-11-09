import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const l = (ja: string, en: string) => ({ ja, en });
const base = (id: string, kind: string, world: string, type: string, name: [string, string], sourceIds = ['src-plan']) => ({
  id, kind, world, type, name: l(...name), description: l(`${name[0]}の説明`, `About ${name[1]}`), classification: 'internal', author: 'ai', sourceIds,
});

/** A customer pack as Microsoft 365 Copilot answers it with the BAS prompt: prose + PART 1/2 and PART 2/2. */
function copilotParts(kpiSourceIds = ['src-plan']) {
  const part1 = {
    part: '1/2',
    packId: 'fabrikam-seiko',
    company: { name: l('Fabrikam 精工', 'Fabrikam Seiko'), industry: l('精密部品', 'Precision parts') },
    isSample: false,
    regions: [{ id: 'region-chubu', name: l('中部', 'Chubu') }],
    flows: [],
    entities: [
      { ...base('src-plan', 'source', 'digital', 'data', ['中期経営計画 2026', 'Mid-term plan 2026'], []), publisher: l('Fabrikam 精工', 'Fabrikam Seiko'), publishedDate: '2026-04-01' },
      { ...base('site-gifu', 'site', 'real', 'site', ['岐阜工場', 'Gifu Plant']), role: 'plant', lat: 35.42, lon: 136.76, capacityTPerMonth: 300 },
    ],
  };
  const part2 = {
    part: '2/2',
    entities: [
      { ...base('person-lead', 'person', 'real', 'person', ['生産管理部長', 'Production manager']), role: l('生産管理部長', 'Production manager'), siteId: 'site-gifu' },
      { ...base('kpi-otd', 'kpi', 'digital', 'metric', ['納期遵守率', 'On-time delivery'], kpiSourceIds), unit: l('%', '%'), baseline: 82, current: 88, target: 95, direction: 'increase', scale: 'ratio', period: l('2026 年度', 'FY2026'), ownerId: 'person-lead' },
      { ...base('cause-manual', 'cause', 'real', 'event', ['手作業の段取り', 'Manual setup']) },
      { ...base('issue-delay', 'issue', 'real', 'event', ['出荷遅延', 'Shipping delays']), impact: 4, feasibility: 3, causeIds: ['cause-manual'], kpiIds: ['kpi-otd'] },
    ],
  };
  const fence = (v: unknown) => `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;
  return {
    answer1: `資料の一覧を作りました。\n\n| 資料名 | 種類 |\n|---|---|\n| 中期経営計画 2026 | PDF |\n\n${fence(part1)}\n\n続きは『続けて』と送ってください（PART 1/2）`,
    answer2: `PART 2/2 です。\n\n${fence(part2)}`,
  };
}

test.describe('data management: customer pack import (FR-302〜FR-304)', () => {
  test('Copilot answer → check → fix prompt → import into a new project → screens use it → delete', async ({ page }) => {
    await open(page, '/data');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('データ管理');
    await expect(page.getByTestId('pack-origin')).toContainText('アプリに同梱のサンプル');

    // The Microsoft 365 Copilot prompt is available on the screen.
    await page.getByTestId('pack-prompt').getByText('プロンプトの全文を表示').click();
    await expect(page.getByTestId('pack-prompt-text')).toHaveValue(/顧客パック/);
    await expect(page.getByTestId('pack-prompt-text')).toHaveValue(/sourceIds/);

    // 1) A number without a source: the check fails and offers a fix prompt for Copilot.
    const bad = copilotParts([]);
    await page.getByTestId('pack-paste').fill(`${bad.answer1}\n\n${bad.answer2}`);
    await page.getByTestId('pack-check').click();
    await expect(page.getByTestId('pack-verdict')).toContainText('取り込めません');
    await expect(page.getByTestId('pack-problems')).toContainText('数値の出典がない');
    await expect(page.getByTestId('pack-fix-text')).toHaveValue(/\[MISSING_SOURCE\] entities\[3\]\.sourceIds \(kpi-otd\)/);
    await expect(page.getByTestId('pack-import-apply')).toHaveCount(0);
    expect(await scan(page)).toEqual([]);

    // 2) The corrected answer: PART 1 pasted, PART 2 uploaded as a saved file, plus a file that cannot be read.
    const good = copilotParts();
    await page.getByTestId('pack-paste').fill(good.answer1);
    await page.getByTestId('pack-file-input').setInputFiles([
      { name: 'copilot-part2.txt', mimeType: 'text/plain', buffer: Buffer.from(good.answer2) },
      { name: 'source.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') },
    ]);
    await page.getByTestId('pack-check').click();
    await expect(page.getByTestId('pack-verdict')).toContainText('検査に合格しました');
    await expect(page.getByTestId('pack-files')).toContainText('source.xlsx');
    await expect(page.getByTestId('pack-files')).toContainText('この形式は読めません');
    await expect(page.getByTestId('pack-summary')).toContainText('Fabrikam 精工');

    // FR-304: a human confirms before the all-or-nothing import.
    const apply = page.getByTestId('pack-import-apply');
    await expect(apply).toBeDisabled();
    await page.getByTestId('pack-check-approved').check();
    await page.getByTestId('pack-check-classified').check();
    await page.getByTestId('pack-check-people').check();
    await expect(page.getByTestId('pack-dest-company')).toHaveValue('Fabrikam 精工');
    await page.getByTestId('pack-dest-project').fill('需要予測');
    expect(await scan(page)).toEqual([]);
    await apply.click();

    // The app restarts on the imported pack, in the new project.
    await expect(page.getByTestId('pack-imported-notice')).toContainText('Fabrikam 精工-需要予測');
    await expect(page.getByTestId('pack-origin')).toContainText('この画面で取り込んだパック');
    await expect(page.getByTestId('pack-origin')).toContainText('copilot-part2.txt');
    await expect(page.getByTestId('proj-target-menu')).toContainText('Fabrikam 精工-需要予測');
    await expect(page.getByTestId('sample-pack-badge')).toHaveCount(0);

    await page.evaluate(() => { window.location.hash = '/directory'; });
    await expect(page.locator('main#main')).toContainText('岐阜工場');
    await page.evaluate(() => { window.location.hash = '/optimize'; });
    await expect(page.getByTestId('optimize-unavailable')).toBeVisible();

    // Switching to the demo goes back to the sample; the project keeps its pack.
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: /^デモ/ }).click();
    await expect(page.getByTestId('sample-pack-badge')).toBeVisible();
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: '需要予測' }).click();
    await expect(page.getByTestId('sample-pack-badge')).toHaveCount(0);

    // The launch screen marks the project; deleting the pack returns the project to the bundled pack.
    await page.evaluate(() => { window.location.hash = '/data'; });
    await page.getByTestId('pack-delete').click();
    await page.getByTestId('pack-delete-confirm').getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('pack-origin')).toContainText('アプリに同梱のサンプル');
    await expect(page.getByTestId('pack-target')).toContainText('Fabrikam 精工-需要予測');
  });

  test('English UI; the launch screen shows which projects have an imported pack', async ({ page }) => {
    await open(page, '/data', { lang: 'en' });
    const good = copilotParts();
    await page.getByTestId('pack-paste').fill(`${good.answer1}\n${good.answer2}`);
    await page.getByTestId('pack-check').click();
    await expect(page.getByTestId('pack-verdict')).toContainText('The check passed');
    await page.getByTestId('pack-check-approved').check();
    await page.getByTestId('pack-check-classified').check();
    await page.getByTestId('pack-check-people').check();
    await page.getByTestId('pack-dest-project').fill('Forecast');
    await page.getByTestId('pack-import-apply').click();
    await expect(page.getByTestId('pack-imported-notice')).toContainText('Fabrikam Seiko-Forecast');

    await page.getByTestId('proj-target-menu').click();
    await page.getByTestId('proj-target-launch').click();
    await expect(page.getByTestId('launch-screen')).toBeVisible();
    await expect(page.getByTestId('launch-company-Fabrikam Seiko')).toContainText('Customer pack imported');
    expect(await scan(page)).toEqual([]);
  });
});
