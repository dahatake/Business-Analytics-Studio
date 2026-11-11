import { crc32 } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open } from './helpers.ts';
import { COLLECTION_SECTIONS } from '../src/data/collection.ts';

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
    extensions: {
      collection: {
        asOf: '2026-11-10', webSearch: 'blocked', webSearchReason: 'Web search disabled by policy',
        sections: COLLECTION_SECTIONS.map((key) => ({
          key, status: 'partial', sourceIds: ['src-plan'], missingFields: ['full scope'],
          reason: 'Available approved material only', nextAction: 'Ask the data owner',
        })),
      },
      dataCatalog: { items: [{ name: 'Fabrikam Orders', columns: ['orderId'], url: 'https://example.com/orders' }] },
      okr: {
        kpis: [{ id: 'okr-kpi-nps', name: '顧客推奨度', target: '前年比 +5 ポイント', sourceIds: ['src-plan'] }],
        objectives: [{ id: 'okr-delivery', objective: '納期で選ばれる', keyResults: [{ text: '納期遵守率を 95% にする', kpiId: 'kpi-otd' }], sourceIds: ['src-plan'] }],
      },
      glossary: [{ term: 'OTD', definition: 'On time delivery' }],
      graph: { relations: [{ source: 'site-gifu', target: 'kpi-otd', semantic: 'measurement' }] },
      architecture: { asIs: [{ layer: 'data', name: 'Fabrikam ERP' }] },
      coreObject: { candidates: [{ name: '岐阜工場' }], reason: 'Approved plant' },
      brand: { primary: '#1267B4' },
    },
    entities: [
      { ...base('src-plan', 'source', 'digital', 'data', ['中期経営計画 2026', 'Mid-term plan 2026'], []), publisher: l('Fabrikam 精工', 'Fabrikam Seiko'), publishedDate: '2026-04-01', url: 'https://example.com/plan', accessedDate: '2026-11-10', origin: 'web' },
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
  const { part: _p, ...head } = part1;
  return {
    answer1: `資料の一覧を作りました。\n\n| 資料名 | 種類 |\n|---|---|\n| 中期経営計画 2026 | PDF |\n\n${fence(part1)}\n\n続きは『続けて』と送ってください（PART 1/2）`,
    answer2: `PART 2/2 です。\n\n${fence(part2)}`,
    pack: { ...head, entities: [...part1.entities, ...part2.entities] },
  };
}

/** A stored (uncompressed) zip, as Python's zipfile writes by default. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [fileName, text] of Object.entries(files)) {
    const body = Buffer.from(text, 'utf8');
    const name = Buffer.from(fileName, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(body), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test.describe('data management: customer pack import (FR-302〜FR-304)', () => {
  test('Copilot answer → check → fix prompt → import into a new project → screens use it → delete', async ({ page }) => {
    await open(page, '/data');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('データ管理');
    await expect(page.getByTestId('pack-origin')).toContainText('アプリに同梱のサンプル');

    // Two Microsoft 365 Copilot prompts: public web research without work data, then the pack as a zip with web search off (FR-307・FR-308).
    await page.getByText('公開Web調査プロンプトを表示', { exact: true }).click();
    await expect(page.getByTestId('pack-research-text')).toHaveValue(/公開Web/);
    await expect(page.getByTestId('pack-research-text')).toHaveValue(/Bing/);
    await page.getByTestId('pack-prompt').getByText('顧客パック作成プロンプトを表示').click();
    await expect(page.getByTestId('pack-prompt-text')).toHaveValue(/顧客パック/);
    await expect(page.getByTestId('pack-prompt-text')).toHaveValue(/sourceIds/);
    await expect(page.getByTestId('pack-prompt-text')).toHaveValue(/pack\.json/);
    await expect(page.getByTestId('pack-prompt-text')).toHaveValue(/Web を検索しない/);
    await expect(page.getByTestId('pack-research-copy')).toBeVisible();
    await expect(page.getByTestId('pack-prompt').getByRole('button', { name: /コピー/ })).toHaveCount(2);

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
    // The preview and current-pack panels each expose coverage independently.
    const previewCoverage = page.getByTestId('pack-coverage').last();
    await previewCoverage.locator('summary').click();
    await expect(previewCoverage).toContainText('利用不可');
    await expect(previewCoverage.getByTestId('pack-coverage-dataCatalog')).toContainText('一部取得');

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
    // The app's own count of what the analysis needs, and a re-fetch the user starts when they choose.
    await expect(page.getByTestId('pack-ready-dataCatalog')).toHaveAttribute('data-met', 'false');
    await expect(page.getByTestId('pack-ready-dataCatalog')).toContainText('不足');
    await expect(page.getByTestId('pack-ready-kpi')).toHaveAttribute('data-met', 'true');
    await expect(page.getByTestId('pack-ready-summary')).toContainText('項目が基準を満たしています');
    expect(await scan(page)).toEqual([]);
    await page.getByTestId('pack-refetch').click();
    const regen = page.getByTestId('gen-dialog');
    await expect(regen.getByTestId('gen-company')).toHaveValue('Fabrikam 精工');
    await expect(regen.getByTestId('gen-project')).toHaveValue('需要予測');
    await expect(regen.getByTestId('gen-prefilled')).toHaveCount(0); // imported, not generated: nothing to prefill
    await expect(regen.getByTestId('gen-start')).toBeDisabled();
    await regen.getByRole('button', { name: 'キャンセル' }).click();
    await expect(regen).toHaveCount(0);

    await page.evaluate(() => { window.location.hash = '/directory'; });
    await expect(page.locator('main#main')).toContainText('岐阜工場');
    await page.evaluate(() => { window.location.hash = '/optimize'; });
    await expect(page.getByTestId('optimize-unavailable')).toBeVisible();
    await page.evaluate(() => { window.location.hash = '/catalog'; });
    await expect(page.getByTestId('uc-import')).toContainText('Fabrikam Orders');
    // Catalog items no use-case entity covers are still listed with the data entities.
    await expect(page.getByTestId('uc-catalog-items')).toContainText('Fabrikam Orders');
    await page.reload();
    await expect(page.getByTestId('uc-import')).toContainText('Fabrikam Orders');
    // The project starts from its own pack's KPIs and internal OKRs.
    await page.evaluate(() => { window.location.hash = '/analysis?tab=kpi'; });
    await expect(page.getByTestId('proj-kpi-panel')).toContainText('納期遵守率');
    await expect(page.getByTestId('proj-okr-panel')).toContainText('納期で選ばれる');
    await expect(page.getByTestId('proj-pack-okr')).toContainText('顧客推奨度');
    await expect(page.getByTestId('proj-pack-okr')).toContainText('未計測');
    expect(await scan(page)).toEqual([]);

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

  test('English UI; the zip from Copilot imports directly; the launch screen shows which projects have an imported pack', async ({ page }) => {
    await open(page, '/data', { lang: 'en' });
    await page.getByTestId('pack-current').getByTestId('pack-coverage').locator('summary').click();
    await expect(page.getByTestId('pack-current')).toContainText('No collection report');
    const good = copilotParts();
    await page.getByTestId('pack-file-input').setInputFiles({
      name: 'fabrikam-seiko.zip', mimeType: 'application/zip',
      buffer: storedZip({ 'pack.json': JSON.stringify(good.pack, null, 2), 'README.md': '# Sources\n- Mid-term plan 2026\n' }),
    });
    await page.getByTestId('pack-check').click();
    await expect(page.getByTestId('pack-verdict')).toContainText('The check passed');
    await expect(page.getByTestId('pack-files')).toContainText('fabrikam-seiko.zip/pack.json');
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
