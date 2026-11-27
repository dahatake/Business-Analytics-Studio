import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, deviceSnapshot, open, scan, seedDeviceData, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { buildDraft, buildTaskDrafts, draftToText } from '../src/modules/project/deliverableDraft.ts';
import { emptyDeliverables, setField, setQualification, STEP_DEFS } from '../src/modules/project/deliverables.ts';
import type { ImprovementStep } from '../src/state/projects.ts';
import type { RepairOption } from '../src/modules/project/taskResolution.ts';
import { workflowAnswer } from '../tests/fixtures/workflow.ts';

/** Demo deliverables with every issue qualified as "pursue" by the person (FR-347). */
function qualifiedDemo() {
  let data = emptyDeliverables();
  for (const issue of samplePack.entities.filter((e) => e.kind === 'issue')) {
    data = setQualification(data, issue.id, { verdict: 'pursue', reason: '測定した差に価値がある', different: '予算とスポンサーが決まった', at: '2026-11-09T00:00:00Z', by: 'E2E' });
  }
  return data;
}

/** The person has already qualified every demo issue: the scenario is about the rest of the step. */
async function seedQualified(page: Page) {
  await seedDeviceData(page, { 'bas.scope.demo.proj.deliverables': JSON.stringify(qualifiedDemo()) });
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();
}

async function go(page: Page, route: string, lang: Lang = 'ja') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.dlv')) return;
    sessionStorage.setItem('bas.e2e.dlv', '1');
    localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: 'E2E', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true, todoCollapsed: false }, version: 1 }));
  });
  await open(page, route, { lang });
}

async function fakeAi(page: Page) {
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z',
  } }));
  await page.route('**/relay/ai', async (route) => {
    const request = route.request().postDataJSON() as { prompt: string; lang: Lang };
    if (request.prompt.startsWith('[bas-proj:workflowDraft]')) {
      await route.fulfill({ json: { text: JSON.stringify(workflowAnswer(request.prompt)), inputTokens: 100, outputTokens: 100 } });
      return;
    }
    const step = /\[bas-proj:deliverable:([a-z]+)\]/.exec(request.prompt)?.[1] as ImprovementStep;
    const pack = loadPack(samplePack);
    const ctx = { pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(), deliverables: emptyDeliverables(), today: '2026-11-09' };
    const input = { step, ctx, lang: request.lang, audience: 'internal' } as const;
    const labels = request.lang === 'ja'
      ? ['事実・根拠', '不足情報', '仮説', '選択肢', '推奨', '理由', '検証', '影響']
      : ['Facts and evidence', 'Missing information', 'Hypotheses', 'Options', 'Recommendation', 'Reasoning', 'Verification', 'Impact'];
    const tasks = Object.fromEntries(Object.entries(buildTaskDrafts(input)).map(([id, text]) => [`task-${id}`, labels.map((label) => `${label}: ${text.replace(/\n/g, ' ')}`).join('\n')]));
    await route.fulfill({ json: { text: `${draftToText(buildDraft(input))}\n\n${draftToText(tasks)}`, inputTokens: 100, outputTokens: 100 } });
  });
  await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();
}

async function generateDraft(page: Page) {
  await page.getByTestId('dlv-draft-generate').click();
  await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
  await expect(page.getByTestId('dlv-draft-mode')).toHaveAttribute('data-mode', 'live');
}

async function openStepDraft(page: Page) {
  const previous = await page.evaluate(() => window.location.hash);
  await page.getByTestId('dlv-open').click();
  await page.getByTestId('dlv-screen-draft').click();
  await page.evaluate((hash) => { window.location.hash = hash; }, previous);
  await expect(page.getByTestId('dlv-draft-dialog')).toBeVisible();
}

test.describe('Copilot task resolution', () => {
  async function prepare(page: Page, lang: Lang, mode: 'repair' | 'newKpi' | 'linearScale' | 'partial' | 'invalid' | 'invalidJson' | 'missingRationale' | 'failure' = 'repair') {
    await go(page, '/deliverables?step=asis', lang);
    await fakeAi(page);
    const newKpi = mode === 'newKpi' || mode === 'linearScale' || mode === 'partial';
    // newKpi: no existing KPI shares a source with the issues, so the only grounded drafts are new KPIs.
    const upserts = samplePack.entities.flatMap((e): object[] => e.kind === 'issue' ? [{ ...e, kpiIds: [] }] : newKpi && e.kind === 'kpi' ? [{ ...e, sourceIds: [] }] : []);
    await seedDeviceData(page, { 'bas.scope.demo.pack.edits': JSON.stringify({ upserts, deleted: [], regions: [] }) });
    await page.reload();
    const requests: string[] = [];
    let proposals = 0;
    await page.route('**/relay/ai', async (route) => {
      const request = route.request().postDataJSON() as { prompt: string };
      requests.push(request.prompt);
      if (mode === 'failure') return route.fulfill({ status: 502, json: { error: 'synthetic resolution failure' } });
      // D-49 follow-up for what the choices left out: this fixture gives nothing, so BAS's provisional rule fills the values.
      if (request.prompt.startsWith('[bas-proj:resolve-complete:')) return route.fulfill({ json: { text: JSON.stringify({ optionIds: [], completed: {} }), inputTokens: 10, outputTokens: 10 } });
      proposals += 1;
      const partial = mode === 'partial' && proposals === 1;
      const options = JSON.parse(request.prompt.split('Allowed repair options: ')[1]!) as RepairOption[];
      const ja = lang === 'ja';
      const links = mode === 'invalid' ? ['invented-edit'] : options.filter((o) => o.kind === 'link').map((o) => o.id);
      const creates = options.filter((o) => o.kind === 'create');
      const kpiDraft = {
        name: { ja: '受注から出荷までの日数', en: 'Order-to-shipment days' }, description: { ja: '出典の課題を測る指標です。', en: 'Measures the sourced issue.' },
        unit: { ja: '日', en: 'days' }, period: { ja: '月次', en: 'Monthly' }, direction: 'decrease', scale: mode === 'linearScale' ? 'linear' : 'ratio',
        baseline: 20, current: 18, target: 10, estimateNote: { ja: '20・18・10 は推定です。月次の実績で確認してください。', en: '20, 18 and 10 are estimates; confirm with monthly actuals.' },
      };
      // After a partial approval the lead-time KPI exists, so the next proposal drafts the first issue still open.
      const leadTime = (creates.find((o) => o.kind === 'create' && o.issueId === 'issue-lead-time') ?? creates[0]!).id;
      const choices = [
        ...(partial ? [{ id: 'new-kpi-later', label: ja ? 'リードタイムのKPIだけを先に下書きする' : 'Draft only the lead-time KPI first', optionIds: [leadTime], drafts: { [leadTime]: kpiDraft }, rationale: ja ? '他の課題は出典を確認してから下書きします。' : 'Other issues are drafted after their sources are checked.' }] : []),
        ...(newKpi ? [] : [{ id: 'link-all', label: ja ? '根拠のあるKPIをすべて関連付ける' : 'Link every sourced KPI', optionIds: links, rationale: ja ? '各KPIは課題と同じ出典に記載されています。' : 'Each KPI is documented in the same source as its issue.', tradeoffs: ja ? '共通の出典は因果を証明しません。' : 'A shared source does not prove causation.' }]),
        { id: 'new-kpi', label: ja ? 'リードタイムのKPIを新規に下書きする' : 'Draft a new lead-time KPI', optionIds: [leadTime], drafts: { [leadTime]: kpiDraft }, rationale: ja ? '課題の出典に測定対象が記載されています。' : 'The issue source names what to measure.' },
        ...(newKpi && !partial ? [{ id: 'new-all', label: ja ? 'すべての課題にKPIを下書きする' : 'Draft a KPI for every issue', optionIds: creates.map((o) => o.id), drafts: Object.fromEntries(creates.map((o) => [o.id, kpiDraft])), rationale: ja ? '各課題の出典に基づきます。' : 'Based on each issue source.' }] : []),
      ];
      await route.fulfill({ json: {
        text: mode === 'invalidJson' ? '{"choices":[' : JSON.stringify({
          choices: mode === 'missingRationale' ? choices.map(({ rationale: _rationale, ...rest }) => rest) : choices, recommendedId: choices[0]!.id,
          reasoning: ja ? '既存の出典を確認し、KPIのドラフトを承認してください。他案より検証可能です。' : 'Check the existing sources and approve the KPI draft; this is more verifiable than the other choice.',
          missingInformation: newKpi ? [ja ? '基準値・現在値・目標値と責任者の確認が必要です。' : 'Baseline, current, target and owner must be confirmed.'] : [],
        }), inputTokens: 100, outputTokens: 100,
      } });
    });
    return { requests, todo: page.getByTestId('dlv-exit').getByTestId('dlv-todo-define-kpi-link') };
  }

  async function generate(page: Page) {
    await page.getByTestId('dlv-resolve-generate').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
  }

  for (const lang of ['ja', 'en'] as const) {
    test(`repairs the actual data after approval and persists the rechecked result (${lang})`, async ({ page }) => {
      const { requests, todo } = await prepare(page, lang);
      const draftText = lang === 'ja' ? '確認待ちの影響のドラフト' : 'Impact draft awaiting review';
      const draft = setField(emptyDeliverables(), 'asis', 'impact', { text: draftText, author: 'ai', updatedAt: '2026-11-26T00:00:00Z' });
      await seedDeviceData(page, { 'bas.scope.demo.proj.deliverables': JSON.stringify(draft) });
      await page.reload();
      if (lang === 'ja') await page.evaluate(() => { window.location.hash = '/deliverables?step=asis&target=dlv-fields'; });
      await expect(todo).toHaveAttribute('data-done', 'false');
      await expect(todo.getByRole('link', { name: lang === 'ja' ? /対応する:/ : /Work on it:/ })).toBeVisible();
      const resolve = todo.getByTestId('dlv-resolve-define-kpi-link');
      await expect(resolve).toHaveText(lang === 'ja' ? 'Copilotで解決' : 'Resolve with Copilot');
      await resolve.click();
      await generate(page);
      await expect(page.getByTestId('dlv-resolve-recommendation')).toContainText(lang === 'ja' ? 'Copilot の推奨: 根拠のあるKPIをすべて関連付ける' : 'Copilot recommends: Link every sourced KPI');
      await expect(page.getByTestId('dlv-resolve-radio-link-all')).toBeChecked();
      await expect(page.getByTestId('dlv-resolve-edits-new-kpi')).toContainText(lang === 'ja' ? '新しい KPI「受注から出荷までの日数」を作成し' : 'Create a new KPI "Order-to-shipment days"');
      await expect(page.getByTestId('dlv-resolve-other-text')).toBeVisible();
      await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
      await expect(todo).toHaveAttribute('data-done', 'false'); // Generation is not application.
      expect(requests).toHaveLength(1);
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
      await page.getByTestId('dlv-resolve-apply').dblclick();
      if (lang === 'en') await page.setViewportSize({ width: 390, height: 844 });
      const dialog = page.getByTestId('dlv-resolve-dialog');
      const success = page.getByTestId('dlv-resolve-success');
      const status = page.getByTestId('dlv-resolve-result');
      const inputLink = page.getByTestId('dlv-resolve-input-link');
      const taskLink = page.getByTestId('dlv-resolve-task-link');
      await expect(success).toBeVisible();
      await expect(page.getByTestId('dlv-resolve-success-icon')).toBeVisible();
      await expect(dialog.getByRole('heading', { name: lang === 'ja' ? 'タスクが完了しました' : 'Task completed' })).toBeVisible();
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toContainText(lang === 'ja' ? '解消を確認' : 'confirmed this task is resolved');
      await expect(status).toContainText(lang === 'ja' ? '人の確認は変更していません' : 'Human sign-offs were not changed');
      await expect(status).toContainText(lang === 'ja' ? '課題すべてが KPI につながっています' : 'issues are linked to a KPI');
      await expect(status).toBeFocused();
      await expect(dialog).not.toContainText(lang === 'ja' ? '設定済みの Foundry または GitHub Copilot で' : 'Use the configured Foundry or GitHub Copilot connection');
      await expect(page.getByTestId('dlv-resolve-apply')).toHaveCount(0);
      await expect(inputLink).toHaveAttribute('href', '#/deliverables?step=asis&target=dlv-fields');
      await expect(taskLink).toHaveAttribute('href', /#\/relations\?.*edit=.*field=kpiIds/);
      expect(await scan(page, lang === 'en' ? '[data-testid="dlv-resolve-dialog"]' : undefined)).toEqual([]);
      if (lang === 'en') {
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        await expect(inputLink).toBeInViewport();
        await expect(taskLink).toBeInViewport();
      }
      if (lang === 'en') expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
      await expect(todo).toHaveAttribute('data-done', 'true');
      const snapshot = await deviceSnapshot(page);
      const saved = snapshot.records['bas.scope.demo.proj.deliverables']?.value;
      if (typeof saved !== 'string') throw new Error('Expected saved deliverables');
      const data = JSON.parse(saved) as { signOffs: object; docs: { asis: { impact: { author: string } } }; recommendations: Record<string, { approved: { text: string } }> };
      expect(data.signOffs).toEqual({});
      expect(data.docs.asis.impact.author).toBe('ai');
      expect(data.recommendations['internal:define-kpi-link']!.approved.text).toContain('KPI');
      expect(data.recommendations['internal:define-kpi-link']!.approved.text).toContain(lang === 'ja' ? 'Copilot の推奨案を選択しました。' : 'The Copilot recommendation was selected.');
      if (lang === 'ja') {
        await page.keyboard.press('Tab');
        await expect(inputLink).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('dlv-fields')).toBeFocused();
        await expect(page.getByTestId('dlv-field-impact')).toHaveValue(draftText);
        await page.getByTestId('dlv-approve-impact').click();
        await expect(page.getByTestId('dlv-approved-impact')).toBeVisible();
        await page.getByTestId('dlv-field-problem').fill('入力画面で編集した内容');
      } else {
        const href = await taskLink.getAttribute('href');
        const issueId = new URLSearchParams(href!.split('?')[1]).get('edit');
        expect(issueId).toBeTruthy();
        await taskLink.click();
        const editor = page.getByTestId('entry-dialog');
        await expect(editor).toBeVisible();
        await expect(editor.getByTestId('entry-field-kpiIds')).toBeVisible();
        await editor.getByTestId('entry-field-description').fill('Reviewed after resolution.');
        await editor.getByTestId('entry-save').click();
        await expect(editor).toHaveCount(0);
        await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
        const edits = (await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']?.value;
        if (typeof edits !== 'string') throw new Error('Expected saved pack edits');
        const upserts = (JSON.parse(edits) as { upserts: { id: string; description: { en: string } }[] }).upserts;
        expect(upserts.find((entity) => entity.id === issueId)?.description.en).toBe('Reviewed after resolution.');
      }
      await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
      await page.evaluate(() => { window.location.hash = '/deliverables?step=asis'; });
      await page.reload();
      await expect(todo).toHaveAttribute('data-done', 'true');
      await expect(todo.getByTestId('dlv-resolve-define-kpi-link')).toHaveCount(0);
      await expect(todo.getByTestId('dlv-task-approved-define-kpi-link')).toBeVisible();
      if (lang === 'ja') {
        await expect(page.getByTestId('dlv-approved-impact')).toBeVisible();
        await expect(page.getByTestId('dlv-field-problem')).toHaveValue('入力画面で編集した内容');
      }
      expect(requests).toHaveLength(1);
    });
  }

  test('does not show success until the resolved data is durably saved', async ({ page }) => {
    const { todo } = await prepare(page, 'ja');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    let writing = false;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/device/state', async (route) => {
      if (route.request().method() === 'POST') {
        writing = true;
        await hold;
      }
      await route.continue();
    });
    await page.getByTestId('dlv-resolve-apply').click();
    try {
      await expect.poll(() => writing).toBe(true);
      await expect(todo).toHaveAttribute('data-done', 'true');
      await expect(page.getByTestId('dlv-resolve-success')).toHaveCount(0);
      await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled();
    } finally {
      release();
    }
    await expect(page.getByTestId('dlv-resolve-success')).toBeVisible();
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  });

  test('opens the resolved deliverable field so its AI draft can be reviewed and approved', async ({ page }) => {
    await go(page, '/deliverables?step=asis&target=dlv-field-problem');
    await fakeAi(page);
    let data = emptyDeliverables();
    for (const field of STEP_DEFS.asis.fields.filter((item) => item.id !== 'problem')) {
      data = setField(data, 'asis', field.id, { text: '現状の調査結果は 16 日です。', author: 'human', updatedAt: '2026-11-26T00:00:00Z' });
    }
    await seedDeviceData(page, { 'bas.scope.demo.proj.deliverables': JSON.stringify(data) });
    await page.reload();
    await page.route('**/relay/ai', async (route) => {
      const request = route.request().postDataJSON() as { prompt: string };
      const options = JSON.parse(request.prompt.split('Allowed repair options: ')[1]!) as RepairOption[];
      const field = options.find((option) => option.kind === 'field' && option.field === 'problem');
      if (!field) throw new Error('Expected the missing problem field');
      await route.fulfill({ json: { text: JSON.stringify({
        choices: [
          { id: 'a', label: '出典に基づく案', optionIds: [field.id], rationale: '出典に基づいて測定した現状を示します。' },
          { id: 'b', label: '確認を優先する案', optionIds: [field.id], rationale: '測定担当者の確認を優先します。', tradeoffs: '確認に時間がかかります。' },
        ],
        recommendedId: 'a', reasoning: '出典に基づく案は測定結果を確認しやすいため推奨します。', missingInformation: [],
      }), inputTokens: 100, outputTokens: 100 } });
    });
    const todo = page.getByTestId('dlv-exit').getByTestId('dlv-todo-asis-doc');
    await todo.getByTestId('dlv-resolve-asis-doc').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    await page.getByTestId('dlv-resolve-apply').click();
    await expect(page.getByTestId('dlv-resolve-success')).toBeVisible();
    const taskLink = page.getByTestId('dlv-resolve-task-link');
    await expect(taskLink).toHaveAttribute('href', '#/deliverables?step=asis&target=dlv-field-problem');
    await taskLink.click();
    await expect(page.getByTestId('dlv-field-problem')).toBeFocused();
    await expect(page.getByTestId('dlv-field-box-problem')).toHaveAttribute('data-author', 'ai');
    await page.getByTestId('dlv-approve-problem').click();
    await expect(page.getByTestId('dlv-approved-problem')).toBeVisible();
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await expect(page.getByTestId('dlv-approved-problem')).toBeVisible();
    await expect(todo).toHaveAttribute('data-done', 'true');
  });

  test('shows success for resolved cause hypotheses and opens the affected issue for editing', async ({ page }) => {
    await go(page, '/deliverables?step=asis');
    await fakeAi(page);
    const issue = samplePack.entities.find((entity) => entity.kind === 'issue' && entity.id === 'issue-lead-time');
    if (!issue || issue.kind !== 'issue') throw new Error('Expected the lead-time issue');
    await seedDeviceData(page, { 'bas.scope.demo.pack.edits': JSON.stringify({ upserts: [{ ...issue, causeIds: [] }], deleted: [], regions: [] }) });
    await page.reload();
    await page.route('**/relay/ai', async (route) => {
      const request = route.request().postDataJSON() as { prompt: string };
      const options = JSON.parse(request.prompt.split('Allowed repair options: ')[1]!) as RepairOption[];
      const link = options.find((option) => option.kind === 'link' && option.field === 'causeIds');
      if (!link) throw new Error('Expected a sourced cause link');
      await route.fulfill({ json: { text: JSON.stringify({
        choices: [
          { id: 'a', label: '出典に基づく案', optionIds: [link.id], rationale: '課題と原因に共通する出典を確認します。' },
          { id: 'b', label: '確認を優先する案', optionIds: [link.id], rationale: '業務担当者による原因の確認を優先します。', tradeoffs: '確認に時間がかかります。' },
        ],
        recommendedId: 'a', reasoning: '出典を確認しやすい案を推奨します。', missingInformation: [],
      }), inputTokens: 100, outputTokens: 100 } });
    });
    const todo = page.getByTestId('dlv-exit').getByTestId('dlv-todo-define-causes');
    await expect(todo).toHaveAttribute('data-done', 'false');
    await todo.getByTestId('dlv-resolve-define-causes').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    await page.getByTestId('dlv-resolve-apply').click();
    await expect(page.getByTestId('dlv-resolve-success-icon')).toBeVisible();
    await expect(page.getByTestId('dlv-resolve-result')).toContainText('課題すべてに原因の仮説があります');
    const taskLink = page.getByTestId('dlv-resolve-task-link');
    await expect(taskLink).toHaveAttribute('href', /#\/relations\?.*edit=issue-lead-time.*field=causeIds/);
    await taskLink.click();
    const editor = page.getByTestId('entry-dialog');
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('entry-field-causeIds')).toBeVisible();
    await editor.getByTestId('entry-field-description').fill('原因を確認した後に課題を編集しました。');
    await editor.getByTestId('entry-save').click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await page.evaluate(() => { window.location.hash = '/deliverables?step=asis'; });
    await page.reload();
    await expect(todo).toHaveAttribute('data-done', 'true');
  });

  test('prefills a new KPI with proposed values and an owner, labels their basis, and saves it as linked data on approval', async ({ page }) => {
    const { todo } = await prepare(page, 'ja', 'newKpi');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-radio-new-kpi')).toBeChecked();
    await expect(page.getByTestId('dlv-resolve-dialog')).toContainText('基準値・現在値・目標値と責任者の確認が必要です。');
    const field = (name: string) => page.getByTestId(`dlv-resolve-human-kpi-draft-lead-time-${name}`);
    // Every value the reviewer confirms is already filled: Copilot's numbers and an owner chosen from local data.
    await expect(field('baseline')).toHaveValue('20');
    await expect(field('current')).toHaveValue('18');
    await expect(field('target')).toHaveValue('10');
    await expect(field('ownerId')).not.toHaveValue('');
    await expect(field('baseline-field')).toHaveAttribute('data-basis', 'estimate');
    await expect(field('baseline-field')).toContainText('Copilot の推定値です');
    await expect(field('note')).toContainText('20・18・10 は推定です。');
    await expect(page.getByTestId('dlv-resolve-human-kpi-draft-lead-time')).toContainText('課題に関係する KPI の責任者から選択');
    await expect(page.getByTestId('dlv-resolve-preview')).toContainText('承認するとこの変更を保存します');
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    await field('baseline').fill('');
    await expect(page.getByTestId('dlv-resolve-preview')).toContainText('承認の前に入力が必要です: 基準値');
    await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled();
    await field('baseline').fill('20');
    await field('target').fill('25'); // a "decrease" KPI whose target is worse than its baseline is not approvable
    await expect(page.getByTestId('dlv-resolve-preview-error')).toContainText('direction');
    await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled();
    await field('target').fill('12');
    await expect(field('target-field')).toHaveAttribute('data-basis', 'human');
    await field('ownerId').selectOption('person-sato-yui');
    await expect(page.getByTestId('dlv-resolve-preview')).toContainText('承認するとこの変更を保存します');
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page)).toEqual([]);
    // D-49: the recommended choice drafted one KPI; BAS added the other choice's drafts so approving it resolves the task.
    await expect(page.getByTestId('dlv-resolve-added-new-kpi')).toContainText('この案が残した不足を BAS が補いました（4 件の変更を追加）');
    await page.getByTestId('dlv-resolve-apply').click();
    await expect(page.getByTestId('dlv-resolve-result')).toContainText('解消を確認');
    await expect(todo).toHaveAttribute('data-done', 'true');
    const snapshot = await deviceSnapshot(page);
    const edits = snapshot.records['bas.scope.demo.pack.edits']?.value;
    if (typeof edits !== 'string') throw new Error('Expected saved pack edits');
    const upserts = (JSON.parse(edits) as { upserts: { id: string; kpiIds?: string[]; [key: string]: unknown }[] }).upserts;
    expect(upserts.find((e) => e.id === 'kpi-draft-lead-time')).toMatchObject({
      kind: 'kpi', author: 'ai', baseline: 20, current: 18, target: 12, ownerId: 'person-sato-yui', direction: 'decrease', sourceIds: ['src-annual-report'],
    });
    expect(upserts.find((e) => e.id === 'issue-lead-time')?.kpiIds).toEqual(['kpi-draft-lead-time']);
    const saved = snapshot.records['bas.scope.demo.proj.deliverables']?.value;
    if (typeof saved !== 'string') throw new Error('Expected saved deliverables');
    const text = (JSON.parse(saved) as { recommendations: Record<string, { approved: { text: string } }> }).recommendations['internal:define-kpi-link']!.approved.text;
    expect(text).toContain('新しい KPI「受注から出荷までの日数」を作成し');
    expect(text).toMatch(/人が承認した値（出どころ）:\n尺度: 比率[^)]*\(Copilot の提案\) \/ 望ましい方向: 減少 \(Copilot の提案\) \/ 基準値: 20 \(Copilot の推定値[^)]*\) \/ 現在値: 18 \(Copilot の推定値[^)]*\) \/ 目標値: 12 \(あなたが入力\) \/ 責任者: .+ \((あなたが入力|課題に関係する KPI の責任者から選択)\)/);
  });

  test('D-49: when Copilot answers a KPI scale as "linear" and gives no exact value when asked again, BAS sets a labelled provisional one', async ({ page }) => {
    const { requests, todo } = await prepare(page, 'ja', 'linearScale');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-error')).toHaveCount(0);
    await expect(page.getByTestId('dlv-resolve-radio-new-kpi')).toBeChecked();
    // One proposal, then the two follow-up rounds for the values still missing.
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain('[bas-proj:resolve-complete:define-kpi-link]');
    expect(requests[1]).toContain('"missing":["scale"');
    await expect(page.getByTestId('dlv-resolve-rounds')).toContainText('不足分を Copilot に 2 回追加で依頼しました');
    const field = (name: string) => page.getByTestId(`dlv-resolve-human-kpi-draft-lead-time-${name}`);
    await expect(page.getByTestId('dlv-resolve-edits-new-kpi')).toContainText('Copilot は尺度を「linear」と回答しましたが');
    await expect(field('scale')).toHaveValue('ratio');
    await expect(field('scale-field')).toHaveAttribute('data-basis', 'provisional');
    await expect(field('scale-field')).toContainText('BAS の仮置きです');
    await expect(field('note')).toContainText('BAS の仮置き（尺度）');
    await expect(field('direction')).toHaveValue('decrease');
    await expect(field('direction-field')).toHaveAttribute('data-basis', 'proposed');
    await expect(page.getByTestId('dlv-resolve-preview')).toContainText('承認するとこの変更を保存します');
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    expect(await scan(page)).toEqual([]);
    await field('scale').selectOption('interval');
    await expect(field('scale-field')).toHaveAttribute('data-basis', 'human');
    await page.getByTestId('dlv-resolve-apply').click();
    await expect(page.getByTestId('dlv-resolve-result')).toContainText('解消を確認');
    const edits = (await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']?.value;
    if (typeof edits !== 'string') throw new Error('Expected saved pack edits');
    const upserts = (JSON.parse(edits) as { upserts: { id: string }[] }).upserts;
    expect(upserts.find((e) => e.id === 'kpi-draft-lead-time')).toMatchObject({ kind: 'kpi', scale: 'interval', direction: 'decrease' });
    expect(upserts.find((e) => e.id === 'kpi-draft-cash')).toMatchObject({ kind: 'kpi', scale: 'ratio' });
  });

  test('D-49: items Copilot left without any draft are listed, and after approval the rest is drafted with one click', async ({ page }) => {
    const { requests, todo } = await prepare(page, 'ja', 'partial');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-uncovered')).toContainText('Copilot は次の項目の変更を作成しませんでした');
    expect(requests.filter((p) => p.startsWith('[bas-proj:resolve-complete:'))).toHaveLength(2);
    await page.getByTestId('dlv-resolve-apply').click();
    await expect(page.getByTestId('dlv-resolve-result')).toContainText('まだ未解決です');
    await expect(page.getByTestId('dlv-resolve-success')).toHaveCount(0);
    await expect(todo).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('dlv-resolve-continue')).toHaveText('残りの不足を Copilot で作成');
    expect(await scan(page)).toEqual([]);
    await page.getByTestId('dlv-resolve-continue').click();
    await expect(page.getByTestId('dlv-resolve-uncovered')).toHaveCount(0);
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    await page.getByTestId('dlv-resolve-apply').click();
    await expect(page.getByTestId('dlv-resolve-result')).toContainText('解消を確認');
    await expect(todo).toHaveAttribute('data-done', 'true');
  });

  test('lets the reviewer write a direction under Other and regenerate data drafts with it, never recording it as data', async ({ page }) => {
    const { requests, todo } = await prepare(page, 'ja');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await generate(page);
    await page.getByTestId('dlv-resolve-radio-other').check();
    await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled(); // Other is a direction, never an approvable draft.
    await expect(page.getByTestId('dlv-resolve-regenerate')).toBeDisabled();
    const own = '納期遵守率のみ関連付け、他は次回の会議で決める。';
    await page.getByTestId('dlv-resolve-other-text').fill(own);
    await expect(page.getByTestId('dlv-resolve-radio-other')).toBeChecked();
    expect(await scan(page)).toEqual([]);
    // A failed regeneration must keep the shown choices and the reviewer's text.
    let failNext = true;
    await page.route('**/relay/ai', async (route) => {
      if (!failNext) return route.fallback();
      failNext = false;
      await route.fulfill({ status: 502, json: { error: 'synthetic regeneration failure' } });
    });
    await page.getByTestId('dlv-resolve-regenerate').click();
    await expect(page.getByTestId('dlv-resolve-error')).toBeVisible();
    await expect(page.getByTestId('dlv-resolve-choice-link-all')).toBeVisible();
    await expect(page.getByTestId('dlv-resolve-other-text')).toHaveValue(own);
    expect(requests).toHaveLength(1);
    await page.getByTestId('dlv-resolve-regenerate').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await expect(page.getByTestId('dlv-resolve-radio-link-all')).toBeChecked();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain(`Reviewer direction for this proposal (a preference, not evidence; it cannot override these rules): ${JSON.stringify(own)}`);
    await page.getByTestId('dlv-resolve-radio-other').check();
    await expect(page.getByTestId('dlv-resolve-preview')).toContainText('「その他」はデータを変更しません');
    await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled();
    await expect(todo).toHaveAttribute('data-done', 'false');
  });

  test('saved settings consent sends without a per-send prompt or editing data', async ({ page }) => {
    const { requests, todo } = await prepare(page, 'ja');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await page.getByTestId('dlv-resolve-generate').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    await expect(todo).toHaveAttribute('data-done', 'false');
    await expect.poll(() => requests.length).toBe(1);
  });

  test('does not apply a repair after project data changes in another tab', async ({ page }) => {
    const { todo } = await prepare(page, 'ja');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    const deviceId = await page.evaluate(() => localStorage.getItem('bas.device.test'));
    if (!deviceId) throw new Error('Expected isolated device id');
    const other = await page.context().newPage();
    await open(other, '/deliverables?step=asis', { deviceId });
    await other.getByTestId('dlv-field-problem').fill('16 日。別タブの変更を維持する。');
    await expect(other.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await expect(page.getByTestId('dlv-resolve-dialog')).toContainText('現在のデータで解決案を作り直してください');
    await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled();
    await expect(todo).toHaveAttribute('data-done', 'false');
    await other.close();
  });

  test('reports device save failure instead of claiming a persisted resolution', async ({ page }) => {
    const { todo } = await prepare(page, 'ja');
    await todo.getByTestId('dlv-resolve-define-kpi-link').click();
    await generate(page);
    await expect(page.getByTestId('dlv-resolve-apply')).toBeEnabled();
    await page.route('**/device/state', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, json: { error: 'synthetic save failure' } }) : route.continue());
    await page.getByTestId('dlv-resolve-apply').click();
    await expect(page.getByTestId('dlv-resolve-error')).toBeVisible();
    await expect(page.getByTestId('dlv-resolve-result')).toHaveCount(0);
    await expect(page.getByTestId('dlv-resolve-success')).toHaveCount(0);
  });

  for (const mode of ['invalid', 'failure'] as const) {
    test(`reports ${mode} without changing data or substituting mock output`, async ({ page }) => {
      const { todo } = await prepare(page, 'ja', mode);
      await todo.getByTestId('dlv-resolve-define-kpi-link').click();
      await generate(page);
      await expect(page.getByTestId('dlv-resolve-error')).toBeVisible();
      await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled();
      await expect(page.getByTestId('dlv-resolve-choices')).toHaveCount(0);
      await expect(todo).toHaveAttribute('data-done', 'false');
    });
  }

  for (const lang of ['ja', 'en'] as const) {
    for (const mode of ['invalidJson', 'missingRationale'] as const) {
      test(`explains ${mode} without updating data (${lang})`, async ({ page }) => {
        const { todo } = await prepare(page, lang, mode);
        const before = (await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']?.value;
        await todo.getByTestId('dlv-resolve-define-kpi-link').click();
        await generate(page);
        const error = page.getByTestId('dlv-resolve-error');
        await expect(error).toContainText(lang === 'ja' ? '今回のデータ変更はありません' : 'No data was changed');
        await expect(error).toContainText(mode === 'invalidJson' ? 'JSON' : 'choices.0.rationale');
        await expect(page.getByTestId('dlv-resolve-apply')).toBeDisabled();
        await expect(page.getByTestId('dlv-resolve-choices')).toHaveCount(0);
        await expect(todo).toHaveAttribute('data-done', 'false');
        expect((await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']?.value).toBe(before);
      });
    }
  }
});

test.describe('step deliverables and to-do band', () => {
  test('the step signal follows task completion, survives reload, and clears when work is undone', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    await fakeAi(page);
    await seedQualified(page);
    const steps = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'] as const;
    const stepper = page.getByTestId('proj-stepper');
    for (const step of steps) await expect(stepper.locator(`[data-step="${step}"]`)).toHaveAttribute('data-complete', 'false');
    const button = stepper.locator('[data-step="asis"]');
    await button.click();
    await openStepDraft(page);
    await generateDraft(page);
    await page.getByTestId('dlv-draft-apply').click();
    await expect(button).toHaveAttribute('data-complete', 'false'); // Draft alone is not sign-off.
    await page.getByTestId('dlv-sign-asis-field').check();
    await expect(button).toHaveAttribute('data-complete', 'false');
    await page.getByTestId('dlv-sign-define-agree').check();
    await expect(button).toHaveAttribute('data-complete', 'true');
    await expect(button).toHaveAccessibleName(/完了/);
    await expect(button.locator('.proj-step-check')).toBeVisible();
    const rgb = await button.evaluate((el) => getComputedStyle(el).backgroundColor.match(/\d+/g)!.map(Number));
    expect(rgb[1]).toBeGreaterThan(rgb[0]!);
    expect(rgb[1]).toBeGreaterThan(rgb[2]!);
    await page.getByTestId('dlv-sign-define-agree').uncheck();
    await expect(button).toHaveAttribute('data-complete', 'false');
    await page.getByTestId('dlv-sign-define-agree').check();
    // Drafting and signing the to-be step is not enough: the project is not yet tied to a company objective.
    await stepper.locator('[data-step="tobe"]').click();
    await page.waitForTimeout(5100);
    await openStepDraft(page);
    await generateDraft(page);
    await page.getByTestId('dlv-draft-apply').click();
    await page.getByTestId('dlv-sign-tobe-agree').check();
    await expect(stepper.locator('[data-step="tobe"]')).toHaveAttribute('data-complete', 'false');
    await expect(page.getByTestId('dlv-todo-tobe-link')).toHaveAttribute('data-done', 'false');
    await page.reload();
    await expect(button).toHaveAttribute('data-complete', 'true');
    expect(await scan(page)).toEqual([]);

    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('dlv-field-problem').fill('数値がない');
    await expect(button).toHaveAttribute('data-complete', 'false');

    // Completion belongs to the project, not the device or the previously selected step.
    await page.goto('/#/projects');
    await page.getByTestId('proj-company-name').fill('完了検証社');
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.getByTestId('proj-project-name-完了検証社').fill('未完了Project');
    await page.getByRole('button', { name: 'Project を作成' }).click();
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: '未完了Project' }).click();
    for (const step of steps) await expect(stepper.locator(`[data-step="${step}"]`)).toHaveAttribute('data-complete', 'false');
  });

  test('the fix link in every step opens and focuses the first incomplete deliverable field', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 750 });
    await go(page, '/home');
    await fakeAi(page);
    await seedQualified(page);
    const steps = [
      ['asis', 'asis-doc', 'problem'],
      ['tobe', 'tobe-doc', 'vision'],
      ['kpi', 'kpi-doc', 'kpiTree'],
      ['solution', 'uc-doc', 'options'],
      ['deliverable', 'plan-doc', 'roadmap'],
    ] as const;
    for (const [step, todo, field] of steps) {
      await page.locator(`.proj-step[data-step="${step}"]`).click();
      const fix = page.getByTestId('dlv-band').getByTestId(`dlv-todo-${todo}`).getByRole('link', { name: /対応する/ });
      await fix.click();
      const input = page.getByTestId(`dlv-field-${field}`);
      await expect(input).toBeFocused();
      await expect(page.getByTestId(`dlv-tab-${step}`)).toHaveAttribute('aria-selected', 'true');
      const top = await input.boundingBox();
      const chrome = await page.locator('.chrome').boundingBox();
      expect(top!.y).toBeGreaterThanOrEqual(chrome!.y + chrome!.height);
      expect(top!.y + top!.height).toBeLessThanOrEqual(750);

      // Reusing the same link must focus it again even though the hash does not change.
      await page.locator('#main').focus();
      await fix.click();
      await expect(input).toBeFocused();
    }
    // A warning in a previously drafted document targets the specific invalid field, not the first field.
    await page.locator('.proj-step[data-step="asis"]').click();
    await openStepDraft(page);
    await generateDraft(page);
    await page.getByTestId('dlv-draft-apply').click();
    await page.getByTestId('dlv-next').click();
    await expect(page.locator('#dlv-sign-asis-field')).toBeFocused();
    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('dlv-field-impact').fill('要改善');
    await page.getByTestId('dlv-band').getByTestId('dlv-todo-asis-doc').getByRole('link', { name: /対応する/ }).click();
    await expect(page.getByTestId('dlv-field-impact')).toBeFocused();
    expect(await scan(page)).toEqual([]);
  });

  test('component targets work across lazy screens and same-screen tab changes', async ({ page }) => {
    await go(page, '/home');
    const targets = [
      ['/analysis?target=proj-method-panel', 'proj-method-panel'],
      ['/analysis?tab=kpi&target=proj-kpi-panel', 'proj-kpi-panel'],
      ['/analysis?tab=kpi&target=proj-okr-panel', 'proj-okr-panel'],
      ['/discussion?target=proj-canvas', 'proj-canvas'],
      ['/discussion?target=proj-tree', 'proj-tree'],
      ['/relations?view=table&target=relation-table', 'relation-table'],
      ['/usecases?target=uc-list', 'uc-list'],
      ['/plan?target=gantt-panel', 'gantt-panel'],
      ['/plan?target=plan-table', 'plan-table'],
    ] as const;
    for (const [route, target] of targets) {
      await page.evaluate((hash) => { window.location.hash = hash; }, route);
      await expect(page.locator(`#${target}`)).toBeFocused();
    }
    await page.evaluate(() => { window.location.hash = '/analysis?tab=kpi&target=proj-okr-panel'; });
    await expect(page.locator('#proj-okr-panel')).toBeFocused();
    await page.getByRole('tab', { name: '分析', exact: true }).click();
    await expect(page).not.toHaveURL(/target=/);
    await expect(page.getByTestId('proj-method-panel')).toBeVisible();
  });

  test('news, business outcomes, and tasks appear in order and list the current step\'s exit criteria', async ({ page }) => {
    await go(page, '/home');
    const band = page.getByTestId('dlv-band');
    const outcomesRegion = page.getByRole('region', { name: '期待されるビジネスの効果', exact: true });
    const newsRegion = page.getByRole('region', { name: '企業ニュース', exact: true });
    await expect(outcomesRegion).toBeVisible();
    await expect(newsRegion).toBeVisible();
    await expect(band).toBeVisible();
    const outcomes = await outcomesRegion.boundingBox();
    const news = await newsRegion.boundingBox();
    const box = await band.boundingBox();
    expect(outcomes!.y).toBeGreaterThanOrEqual(news!.y + news!.height - 1);
    expect(box!.y).toBeGreaterThanOrEqual(outcomes!.y + outcomes!.height - 1);
    expect(box!.width).toBeGreaterThan(1000); // full width
    await expect(band.getByText('タスク（次にやること）')).toBeVisible();
    await expect(band).not.toContainText('ステップ 1/5: 現状分析');
    await expect(band).toContainText('成果物: 現状分析レポート（優先順位つき課題一覧と KPI/OKR ギャップ）');
    // Demo: the data checks pass; the issue qualification, the deliverable fields, the field check and the sponsor's agreement are still open.
    await expect(page.getByTestId('dlv-progress')).toHaveText('8/12 完了');
    await expect(page.getByTestId('dlv-todo-define-sources')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-todo-asis-doc')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('dlv-result-asis-doc')).toHaveText('未記入 10 項目、数値・期限が足りない 0 項目');
    await expect(page.getByTestId('dlv-result-asis-qualify')).toHaveText('取り組むかどうかを判断していない課題が 5 件あります（黄信号）');
    // The head line says what to do next, and the open criteria come first in the list.
    await expect(page.getByTestId('dlv-next')).toHaveAttribute('data-todo', 'asis-qualify');
    await expect(page.getByTestId('dlv-next')).toContainText('次にやること:');
    await expect(band.locator('.dlv-band-list > li').first()).toHaveAttribute('data-done', 'false');
    expect(await scan(page)).toEqual([]);
  });

  test('Draft with Copilot fills the deliverable, the sign-off completes the step', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    // Every issue was already qualified by the person (FR-347); the draft and the sign-offs finish the step.
    await seedQualified(page);
    await openStepDraft(page);
    const dialog = page.getByTestId('dlv-draft-dialog');
    await expect(dialog).toBeVisible();
    await generateDraft(page);
    await expect(dialog.getByTestId('dlv-draft-field-problem')).toContainText('受注から出荷までが長い');
    expect(await scan(page)).toEqual([]);
    await dialog.getByTestId('dlv-draft-apply').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('dlv-progress')).toHaveText('10/12 完了');
    await page.getByTestId('dlv-sign-asis-field').check();
    await page.getByTestId('dlv-sign-define-agree').check();
    await expect(page.getByTestId('dlv-progress')).toHaveText('完了条件をすべて満たしました');
    await expect(page.getByTestId('dlv-result-define-agree')).toContainText('E2E が確認');
    await expect(page.getByTestId('dlv-band')).toHaveAttribute('data-complete', 'true');
    await expect(page.getByTestId('dlv-next')).toHaveCount(0);

    // The deliverable screen shows the drafted fields and re-judges edits immediately.
    await page.getByTestId('dlv-open').click();
    await expect(page).toHaveURL(/#\/deliverables\?step=asis/);
    await expect(page.getByTestId('dlv-name')).toHaveText('現状分析レポート（優先順位つき課題一覧と KPI/OKR ギャップ）');
    const problem = page.getByTestId('dlv-field-problem');
    await expect(problem).toHaveValue(/16 日/);
    await expect(page.getByTestId('dlv-fields').getByText('モック')).toHaveCount(0);

    // FR-338: the AI suggestion is confirmed by approving it as it is; the person's later edit drops the approval.
    const impactBox = page.getByTestId('dlv-field-box-impact');
    await expect(impactBox).toHaveAttribute('data-author', 'ai');
    await expect(impactBox.getByText('AI の提案', { exact: true })).toBeVisible();
    const impactText = await page.getByTestId('dlv-field-impact').inputValue();
    await page.getByTestId('dlv-approve-impact').click();
    await expect(impactBox).toHaveAttribute('data-author', 'human');
    await expect(page.getByTestId('dlv-approved-impact')).toHaveText('確定');
    await expect(impactBox.getByText('AI の提案', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('dlv-approve-impact')).toHaveCount(0);
    await expect(page.getByTestId('dlv-approval-impact')).toContainText('AI の提案を承認して確定');
    await expect(page.getByTestId('dlv-field-impact')).toHaveValue(impactText);
    await expect(page.getByTestId('dlv-approve-problem')).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('dlv-approved-impact')).toHaveText('確定');
    await page.getByTestId('dlv-field-impact').fill(`${impactText} 追記`);
    await expect(page.getByTestId('dlv-approved-impact')).toHaveCount(0);
    await expect(page.getByTestId('dlv-approval-impact')).toHaveCount(0);
    await expect(page.getByTestId('dlv-field-box-impact').getByText('人が入力')).toBeVisible();

    await problem.fill('リードタイムを短くする');
    await expect(page.getByText('数値を入れてください')).toBeVisible();
    await expect(page.getByTestId('dlv-screen-progress')).toHaveText('11/12 完了');
    expect(await scan(page)).toEqual([]);

    // Kept after a reload (project-scoped storage).
    await page.reload();
    await expect(page.getByTestId('dlv-field-problem')).toHaveValue('リードタイムを短くする');
  });

  test('task recommendations remain drafts until approved and survive reload without signing off', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    await openStepDraft(page);
    const dialog = page.getByTestId('dlv-draft-dialog');
    await generateDraft(page);
    await expect(dialog.getByTestId('dlv-task-preview-asis-field')).toContainText('ドラフト');
    await expect(dialog.getByTestId('dlv-task-simulation')).toContainText('未完了');
    await dialog.getByTestId('dlv-task-approve-asis-field').click();
    await expect(dialog.getByTestId('dlv-task-preview-asis-field')).toContainText('承認済み');
    await expect(page.getByTestId('dlv-sign-asis-field')).not.toBeChecked();
    await dialog.getByRole('button', { name: '閉じる' }).click();
    await page.goto('/#/deliverables?step=asis');
    await expect(page.getByTestId('dlv-task-approved-asis-field')).toContainText('承認済み');
    await expect(page.getByTestId('dlv-task-draft-define-agree')).toContainText('ドラフト');
    await page.reload();
    await expect(page.getByTestId('dlv-task-approved-asis-field')).toContainText('承認済み');
    await expect(page.getByTestId('dlv-todo-asis-field').first()).toHaveAttribute('data-done', 'false');
    await page.getByRole('button', { name: '社内向け表示' }).click();
    await expect(page.getByTestId('dlv-task-approved-asis-field')).toHaveCount(0);
    await expect(page.getByTestId('dlv-task-draft-define-agree')).toHaveCount(0);
    await page.getByRole('button', { name: '社外向け表示' }).click();
    await expect(page.getByTestId('dlv-task-approved-asis-field')).toBeVisible();
  });

  test('saved settings consent sends immediately and relay failure does not create a mock draft', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    let calls = 0;
    await page.route('**/relay/ai', async (route) => {
      calls += 1;
      await route.fulfill({ status: 504, json: { error: 'timeout' } });
    });
    await openStepDraft(page);
    await page.getByTestId('dlv-draft-generate').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    const alert = page.getByTestId('dlv-draft-dialog').getByRole('alert');
    await expect(alert).toContainText('relay 504 timeout');
    await expect(alert).toContainText('モックへの切り替えや成果物への反映は行っていません');
    await expect(alert).not.toContainText('モックで応答しました');
    expect(calls).toBe(1);
    await expect(page.getByTestId('dlv-draft-mode')).toHaveCount(0);
    await expect(page.getByTestId('dlv-draft-apply')).toBeDisabled();
  });

  test('a slow draft shows its stage, elapsed time and limit, and Cancel really stops the request', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    let aborted = false;
    await page.route('**/relay/ai', async (route) => {
      page.once('requestfailed', (r) => { if (r.url().includes('/relay/ai')) aborted = true; });
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      await route.fulfill({ status: 504, json: { error: 'timeout' } }).catch(() => undefined);
    });
    await openStepDraft(page);
    const dialog = page.getByTestId('dlv-draft-dialog');
    await page.getByTestId('dlv-draft-generate').click();
    const progress = dialog.getByTestId('dlv-draft-progress');
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await expect(progress).toHaveAttribute('data-stage', 'generate');
    await expect(progress).toHaveAttribute('data-activity', 'fields');
    await expect(progress.getByRole('status')).toHaveText('成果物の各項目を作成しています…');
    await expect(progress.getByTestId('dlv-draft-progress-detail')).toContainText('2 回のうち 1 回目');
    await expect(progress.locator('[data-step="confirm"]')).toHaveAttribute('data-status', 'done');
    await expect(progress.locator('[data-step="generate"]')).toHaveAttribute('data-status', 'running');
    await expect(progress.getByTestId('dlv-draft-progress-bar')).toBeVisible();
    await expect(progress).toContainText('5 分たっても応答がなければ自動的に打ち切ります');
    const status = progress.getByTestId('dlv-draft-progress-status');
    await expect(status).toContainText('3 段階中 1 段階完了');
    await expect(status).toContainText('送信から 0:02 経過', { timeout: 5_000 });
    await expect(page.getByTestId('dlv-draft-apply')).toHaveCount(0);
    await dialog.getByTestId('dlv-draft-cancel').click();
    await expect(dialog.getByTestId('dlv-draft-cancelled')).toHaveText('作成を取り消しました。成果物は変更していません。');
    await expect(progress).toHaveCount(0);
    await expect(page.getByTestId('dlv-draft-generate')).toBeVisible();
    await expect.poll(() => aborted).toBe(true);
    expect(await scan(page)).toEqual([]);
  });

  test('task workbench previews a field without saving it', async ({ page }) => {
    await go(page, '/home');
    await page.getByTestId('dlv-band').getByTestId('dlv-todo-asis-doc').getByRole('link', { name: /判断・シミュレーション/ }).click();
    const panel = page.getByTestId('dlv-task-workbench');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('dlv-task-what-if-result')).toContainText('未記入 10 項目');
    await panel.getByTestId('dlv-task-what-if').fill('仮入力 16 日');
    await expect(panel.getByTestId('dlv-task-what-if-result')).toContainText('未記入 9 項目');
    await page.goto('/#/deliverables?step=asis');
    await expect(page.getByTestId('dlv-field-problem')).toHaveValue('');
    await page.reload();
    await expect(page.getByTestId('dlv-field-problem')).toHaveValue('');
  });

  test('every task offers a transparent, unsaved comparison of business-impact assumptions', async ({ page }) => {
    test.setTimeout(120_000);
    await go(page, '/home');
    for (const [step, definition] of Object.entries(STEP_DEFS)) {
      for (const todo of definition.todos) {
        await page.evaluate(({ step, id }) => { location.hash = `/optimize?tab=task&step=${step}&task=${id}&target=dlv-task-workbench`; }, { step, id: todo.id });
        const panel = page.getByTestId('dlv-task-workbench');
        await expect(panel.getByTestId(`dlv-todo-${todo.id}`)).toBeVisible();
        await expect(panel.getByTestId('dlv-impact-simulation')).toBeVisible();
      }
    }
    await page.evaluate(() => { location.hash = '/deliverables?step=asis&task=asis-doc&target=dlv-task-workbench'; });
    await expect(page).toHaveURL(/#\/optimize\?/);
    const sim = page.getByTestId('dlv-impact-simulation');
    for (const [key, value] of Object.entries({ baselineBenefit: '1000', baselineCost: '200', benefit: '1800', cost: '300', investment: '1400', years: '3' })) {
      await sim.getByTestId(`dlv-impact-${key}`).fill(value);
    }
    await expect(sim.getByTestId('dlv-impact-result')).toContainText('700');
    await expect(sim.getByTestId('dlv-impact-result')).toContainText('2 年');
    await sim.getByTestId('dlv-impact-compare').check();
    for (const [key, value] of Object.entries({ benefit: '2000', cost: '500', investment: '700' })) {
      await sim.getByTestId(`dlv-impact-alt-${key}`).fill(value);
    }
    await expect(sim.getByTestId('dlv-impact-alt-result')).toContainText('1,400');
    await expect(sim.getByTestId('dlv-impact-result')).toContainText('B − A');
    await page.reload();
    await expect(page.getByTestId('dlv-impact-benefit')).toHaveValue('');
    await expect(page.getByTestId('dlv-impact-result')).toHaveCount(0);
  });

  test('missing causes link directly to the issue and can be registered there', async ({ page }) => {
    await go(page, '/relations?view=table&edit=issue-lead-time&field=causeIds&target=relation-table');
    const editor = page.getByTestId('entry-dialog');
    await editor.getByTestId('entry-field-causeIds-cause-manual-scheduling').uncheck();
    await editor.getByTestId('entry-field-causeIds-cause-siloed-inventory').uncheck();
    await editor.getByTestId('entry-save').click();
    const todo = page.getByTestId('dlv-band').getByTestId('dlv-todo-define-causes');
    await expect(todo).toHaveAttribute('data-done', 'false');
    await todo.getByRole('link', { name: /判断・シミュレーション/ }).click();
    const workbench = page.getByTestId('dlv-task-workbench');
    await workbench.getByTestId('dlv-task-what-if-cause-manual-scheduling').check();
    await expect(workbench.getByTestId('dlv-task-what-if-result')).toContainText('すべて');
    await expect(todo).toHaveAttribute('data-done', 'false');
    await todo.getByRole('link', { name: /対応する/ }).click();
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('entry-field-causeIds-cause-manual-scheduling')).toBeFocused();
    await editor.getByTestId('entry-new-causeIds').click();
    const nested = page.getByTestId('entry-dialog-1');
    await nested.getByTestId('entry-field-name').fill('検証する原因仮説');
    await nested.getByTestId('entry-save').click();
    await expect(nested).toBeHidden();
    await expect(editor.getByTestId('entry-field-causeIds').getByLabel('検証する原因仮説')).toBeChecked();
    await editor.getByTestId('entry-save').click();
    await expect(todo).toHaveAttribute('data-done', 'true');
    const evidence = page.getByTestId('dlv-band').getByTestId('dlv-todo-asis-cause-evidence');
    await expect(evidence).toHaveAttribute('data-done', 'false');
    await evidence.getByRole('link', { name: /対応する/ }).click();
    await expect(editor.getByTestId('entry-field-sourceIds-src-interview')).toBeVisible();
    await editor.getByTestId('entry-field-sourceIds-src-interview').check();
    await editor.getByTestId('entry-save').click();
    await expect(evidence).toHaveAttribute('data-done', 'true');
    await page.reload();
    await expect(page.getByTestId('dlv-band').getByTestId('dlv-todo-define-causes')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-band').getByTestId('dlv-todo-asis-cause-evidence')).toHaveAttribute('data-done', 'true');
  });

  test('a missing KPI link opens the affected issue and updates the check when saved', async ({ page }) => {
    await go(page, '/relations?view=table&edit=issue-lead-time&field=kpiIds&target=relation-table');
    const editor = page.getByTestId('entry-dialog');
    await editor.getByTestId('entry-field-kpiIds-kpi-lead-time').uncheck();
    await editor.getByTestId('entry-field-kpiIds-kpi-otd').uncheck();
    await editor.getByTestId('entry-save').click();
    const todo = page.getByTestId('dlv-band').getByTestId('dlv-todo-define-kpi-link');
    await expect(todo).toHaveAttribute('data-done', 'false');
    await todo.getByRole('link', { name: /対応する/ }).click();
    await expect(editor.getByTestId('entry-field-kpiIds-kpi-lead-time')).toBeFocused();
    await editor.getByTestId('entry-field-kpiIds-kpi-lead-time').check();
    await editor.getByTestId('entry-save').click();
    await expect(todo).toHaveAttribute('data-done', 'true');
  });

  test('schedule task opens an editable initiative and rechecks the corrected dates', async ({ page }) => {
    await go(page, '/relations?view=table&edit=init-dp-rollout&field=start&target=relation-table');
    const editor = page.getByTestId('entry-dialog');
    await editor.getByTestId('entry-field-start').fill('2026-06-01');
    await editor.getByTestId('entry-save').click();
    await page.locator('.proj-step[data-step="deliverable"]').click();
    const todo = page.getByTestId('dlv-band').getByTestId('dlv-todo-plan-schedule');
    await expect(todo).toHaveAttribute('data-done', 'false');
    await todo.getByRole('link', { name: /対応する/ }).click();
    await expect(editor.getByTestId('entry-field-start')).toBeFocused();
    await editor.getByTestId('entry-field-start').fill('2026-10-01');
    await editor.getByTestId('entry-save').click();
    await expect(todo).toHaveAttribute('data-done', 'true');
    await page.reload();
    await expect(page.getByTestId('dlv-band').getByTestId('dlv-todo-plan-schedule')).toHaveAttribute('data-done', 'true');
  });

  test('coverage task creates a plan for the missing solution and persists it', async ({ page }) => {
    await go(page, '/relations?view=table&edit=init-et-model&target=relation-table');
    const editor = page.getByTestId('entry-dialog');
    await editor.getByTestId('entry-delete').click();
    await editor.getByTestId('entry-delete').click();
    await expect(editor).toBeHidden();
    await page.locator('.proj-step[data-step="deliverable"]').click();
    const todo = page.getByTestId('dlv-band').getByTestId('dlv-todo-plan-coverage');
    await expect(todo).toHaveAttribute('data-done', 'false');
    await todo.getByRole('link', { name: /対応する/ }).click();
    await expect(editor.getByTestId('entry-field-solutionId')).toBeFocused();
    await editor.getByTestId('entry-field-name').fill('エネルギーツインの計画');
    await editor.getByTestId('entry-field-solutionId').selectOption('sol-energy-twin');
    await editor.getByTestId('entry-field-start').fill('2026-10-15');
    await editor.getByTestId('entry-field-end').fill('2027-02-26');
    await editor.getByTestId('entry-field-progress').fill('0.15');
    await editor.getByTestId('entry-field-ownerId').selectOption('person-yamamoto-hiroshi');
    await editor.getByTestId('entry-save').click();
    await expect(editor).toBeHidden();
    await expect(todo).toHaveAttribute('data-done', 'true');
    await page.reload();
    await expect(page.getByTestId('dlv-band').getByTestId('dlv-todo-plan-coverage')).toHaveAttribute('data-done', 'true');
    await go(page, '/plan');
    await expect(page.locator('#plan-table')).toContainText('エネルギーツインの計画');
  });

  test('the band follows the stepper; each step has its own deliverable', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    await page.locator('.proj-step[data-step="deliverable"]').click();
    const band = page.getByTestId('dlv-band');
    await expect(band).toContainText('ステップ 5/5: 要求定義・計画');
    await expect(band).toContainText('成果物: 要求定義書・プロジェクト計画書');
    await expect(page.getByTestId('dlv-todo-plan-schedule')).toHaveAttribute('data-done', 'true');
    await openStepDraft(page);
    await generateDraft(page);
    await expect(page.getByTestId('dlv-draft-field-businessCase')).toContainText('回収');
    await page.getByTestId('dlv-draft-apply').click();
    await expect(page.getByTestId('dlv-todo-plan-doc')).toHaveAttribute('data-done', 'true');
  });

  test('one Draft button also fills missing data: each value is labelled, applied as pending and reviewed one by one', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    const SOL = 'sol-demand-planning';
    const INIT = 'init-dp-pilot';
    const upserts = samplePack.entities.flatMap((e): object[] => {
      if (e.id === SOL) { const { costJpy: _c, annualBenefitJpy: _b, ...rest } = e as typeof e & { costJpy?: number; annualBenefitJpy?: number }; return [rest]; }
      if (e.id === INIT) { const { ownerId: _o, ...rest } = e as typeof e & { ownerId?: string }; return [rest]; }
      return [];
    });
    await seedDeviceData(page, { 'bas.scope.demo.pack.edits': JSON.stringify({ upserts, deleted: [], regions: [] }) });
    await page.reload();
    await expect(page.locator('main#main')).toBeVisible();
    const fillPrompts: string[] = [];
    await page.route('**/relay/ai', async (route) => {
      const request = route.request().postDataJSON() as { prompt: string };
      if (!request.prompt.startsWith('[bas-proj:fill]')) return route.fallback();
      fillPrompts.push(request.prompt);
      const note = (ja: string, en: string) => ({ ja, en });
      // D-49: the retry asks only for the gap the first answer left without a value, and this time Copilot estimates it.
      if (request.prompt.includes('Retry:')) {
        return route.fulfill({ json: { inputTokens: 50, outputTokens: 50, text: JSON.stringify({ items: [
          { gapId: `${SOL}:annualBenefitJpy`, basis: 'estimate', value: 45_000_000, note: note('需要予測の改善幅から推定。経営企画部の効果試算で確認', 'From the forecast improvement; confirm with corporate planning') },
        ] }) } });
      }
      await route.fulfill({ json: { inputTokens: 100, outputTokens: 100, text: JSON.stringify({ items: [
        // Claims a source, but no source says it: the app labels it an estimate.
        { gapId: `${SOL}:costJpy`, basis: 'evidence', value: 30_000_000, quote: '導入費用は3000万円', sourceIds: ['src-annual-report'], note: note('統合報告書の投資計画', 'Investment plan') },
        { gapId: `${SOL}:annualBenefitJpy`, basis: 'unacquired', value: null, note: note('経営企画部の効果試算', 'Corporate planning benefit estimate') },
        { gapId: `${INIT}:ownerRole`, basis: 'estimate', value: { ja: '生産管理部長', en: 'Head of production control' }, note: note('PoC は生産計画の範囲', 'The PoC covers production planning') },
      ] }) } });
    });

    await page.locator('.proj-step[data-step="deliverable"]').click();
    await openStepDraft(page);
    const dialog = page.getByTestId('dlv-draft-dialog');
    const toggle = dialog.getByTestId('dlv-fill-toggle');
    await expect(toggle).toBeChecked();
    await expect(dialog).toContainText('データ欠損時に Copilot にドラフトを作成してもらう（欠損 3 件）');
    await dialog.getByTestId('dlv-draft-generate').click();
    // The fill request and the text draft are sent back to back (D-41: no send interval).
    await expect(page.getByTestId('dlv-draft-mode')).toHaveAttribute('data-mode', 'live', { timeout: 20_000 });
    expect(fillPrompts).toHaveLength(2);
    expect(fillPrompts[0]).toContain(`${INIT}:ownerRole`);
    expect(fillPrompts[1]).toContain(`"gapId":"${SOL}:annualBenefitJpy"`);
    expect(fillPrompts[1]).not.toContain(`"gapId":"${INIT}:ownerRole"`);
    const proposals = dialog.getByTestId('dlv-fill-proposals');
    await expect(proposals.getByTestId(`dlv-fill-proposal-${SOL}-costJpy`)).toHaveAttribute('data-basis', 'estimate');
    await expect(proposals.getByTestId(`dlv-fill-proposal-${SOL}-costJpy`).getByTestId('dlv-fill-downgraded')).toBeVisible();
    await expect(proposals.getByTestId(`dlv-fill-proposal-${SOL}-annualBenefitJpy`)).toHaveAttribute('data-basis', 'estimate');
    await expect(proposals.getByTestId(`dlv-fill-proposal-${INIT}-ownerRole`)).toHaveAttribute('data-basis', 'estimate');
    expect(await scan(page)).toEqual([]);
    await dialog.getByTestId('dlv-draft-apply').click();
    await expect(dialog).toBeHidden();
    // An unreviewed estimate is not an owner yet.
    await expect(page.getByTestId('dlv-todo-plan-owner')).toHaveAttribute('data-done', 'false');

    await page.getByTestId('dlv-open').click();
    const panel = page.getByTestId('dlv-fill-panel');
    const cost = panel.getByTestId(`dlv-fill-${SOL}-costJpy`);
    const benefit = panel.getByTestId(`dlv-fill-${SOL}-annualBenefitJpy`);
    const owner = panel.getByTestId(`dlv-fill-${INIT}-ownerRole`);
    await expect(panel.getByTestId('dlv-fill-summary')).toHaveText('資料に記載 0 件 / Copilot 推定 3 件 / 未取得 0 件 / 人が入力 0 件（レビュー待ち 3 件）');
    for (const row of [cost, benefit, owner]) await expect(row).toHaveAttribute('data-status', 'pending');
    expect(await scan(page)).toEqual([]);

    await owner.getByTestId('dlv-fill-approve').click();
    await expect(owner).toHaveAttribute('data-status', 'approved');
    await expect(owner).toContainText('E2E が');
    await expect(page.getByTestId('dlv-band').getByTestId('dlv-todo-plan-owner')).toHaveAttribute('data-done', 'true');

    await cost.getByTestId('dlv-fill-reject').click();
    await expect(cost).toHaveAttribute('data-status', 'rejected');
    const costOf = async () => {
      const edits = JSON.parse((await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']?.value ?? '{"upserts":[]}') as { upserts: { id: string; costJpy?: number; annualBenefitJpy?: number }[] };
      return edits.upserts.find((e) => e.id === SOL) ?? ({} as { costJpy?: number; annualBenefitJpy?: number });
    };
    await expect.poll(async () => (await costOf()).costJpy).toBeUndefined();

    await benefit.getByTestId('dlv-fill-edit').click();
    await benefit.getByTestId('dlv-fill-input').fill('60,000,000');
    await benefit.getByTestId('dlv-fill-save').click();
    await expect(benefit).toHaveAttribute('data-basis', 'human');
    await expect(benefit).toHaveAttribute('data-status', 'approved');
    await expect.poll(async () => (await costOf()).annualBenefitJpy).toBe(60_000_000);
    expect(await scan(page)).toEqual([]);

    await page.reload();
    await expect(page.getByTestId(`dlv-fill-${INIT}-ownerRole`)).toHaveAttribute('data-status', 'approved');
    await expect(page.getByTestId(`dlv-fill-${SOL}-costJpy`)).toHaveAttribute('data-status', 'rejected');
    await expect(page.getByTestId(`dlv-fill-${SOL}-annualBenefitJpy`)).toHaveAttribute('data-basis', 'human');
  });

  test('a new project starts with failing checks that link to where the work is done', async ({ page }) => {
    await go(page, '/projects');
    await page.getByTestId('proj-company-name').fill('検証社');
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.getByTestId('proj-project-name-検証社').fill('新規');
    await page.getByRole('button', { name: 'Project を作成' }).click();
    await page.getByTestId('proj-target-menu').click();
    await page.getByRole('menuitemradio', { name: '新規' }).click();
    const decision = page.getByTestId('dlv-todo-define-decision');
    await expect(decision).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('dlv-result-define-decision')).toHaveText('論点がまだありません');
    await decision.getByRole('link', { name: /対応する/ }).click();
    await expect(page).toHaveURL(/#\/discussion/);
    await expect(page.locator('#proj-tree')).toBeFocused();
    await expect(page.getByTestId('dlv-progress')).toHaveText('6/12 完了');
  });

  test('automatic mode: summary only on short windows, full list on tall ones', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: '', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true }, version: 1 }));
    });
    await open(page, '/home');
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-progress')).toHaveText('8/12 完了');
    await page.setViewportSize({ width: 1600, height: 1400 });
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('dlv-todo-asis-doc')).toBeVisible();
    const bottom = await page.getByTestId('dlv-band').evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
    expect(bottom).toBeLessThanOrEqual(1400 * 0.35);
    // At a shorter viewport the fixed area and list no longer fit within 35% of the height.
    await page.setViewportSize({ width: 1440, height: 789 });
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('numbers in the text are reconciled with the KPIs; the payback hurdle is the project\'s own', async ({ page }) => {
    await go(page, '/deliverables?step=asis');
    const exit = page.getByTestId('dlv-exit');
    await expect(exit.getByTestId('dlv-todo-asis-reconcile')).toHaveAttribute('data-done', 'true');
    await expect(exit.getByTestId('dlv-result-asis-reconcile')).toContainText('KPI の値と一致');

    await page.getByTestId('dlv-tab-deliverable').click();
    const payback = page.getByTestId('dlv-todo-plan-payback');
    await expect(payback).toContainText('3 年以内（構築期間を含む）');
    await expect(payback).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-payback-source')).toContainText('アプリの仮定');
    expect(await scan(page)).toEqual([]);
    const limit = page.getByTestId('dlv-payback-limit');
    await limit.fill('1');
    await limit.press('Enter');
    await expect(payback).toHaveAttribute('data-done', 'false');
    await expect(payback).toContainText('1 年以内');
    await expect(page.getByTestId('dlv-payback-source')).toContainText('E2E が 1 年に設定');
    await page.reload();
    await expect(page.getByTestId('dlv-payback-limit')).toHaveValue('1');
    await page.getByTestId('dlv-payback-reset').click();
    await expect(page.getByTestId('dlv-todo-plan-payback')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('dlv-payback-limit')).toHaveValue('3');
  });

  test('the band can be collapsed and stays collapsed', async ({ page }) => {
    await go(page, '/home');
    const toggle = page.getByTestId('dlv-band-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-todo-asis-doc')).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('dlv-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('dlv-progress')).toBeVisible();
  });

  test('solution step: confirming a type and estimating a contribution feeds the KPI simulation and the linked deliverable', async ({ page }) => {
    await go(page, '/deliverables?step=solution');
    await expect(page.getByTestId('dlv-todo-sol-type')).toHaveAttribute('data-done', 'false');
    const sol = page.getByTestId('sol-solution-sol-energy-twin');
    await sol.evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await page.getByTestId('sol-type-sol-energy-twin').selectOption('process');
    await page.getByTestId('sol-contrib-add-sol-energy-twin').click();
    await page.getByTestId('sol-c-lever').fill('切替拠点');
    await page.getByTestId('sol-c-unit').fill('拠点');
    for (const [k, v] of [['low', '3'], ['mode', '4'], ['high', '5']] as const) await page.getByTestId(`sol-c-amount-${k}`).fill(v);
    for (const [k, v] of [['low', '50'], ['mode', '80'], ['high', '100']] as const) await page.getByTestId(`sol-c-effect-${k}`).fill(v);
    await page.getByTestId('sol-c-ramp').fill('2026-12-01');
    await page.getByTestId('sol-c-full').fill('2027-01-31');
    await page.getByTestId('sol-c-save').click();
    await page.locator('#sol-sim').click();
    await expect(page.getByTestId('sol-sim-kpi-co2')).toBeVisible();
    await expect(page.getByTestId('sol-sim-prob-kpi-co2')).toHaveText(/%/);
    const time = page.getByTestId('sim-time');
    await time.getByRole('combobox').selectOption('kpi-co2');
    await expect(time).toContainText('最初の改善日：2026-12-02');
    await time.getByTestId('sim-date').press('End');
    await time.getByText('このKPIに寄与する施策と効果の発現割合').click();
    await expect(time).toContainText('切替拠点');
    await expect(time).toContainText('100%');
    await page.goBack();
    await expect(page.getByTestId('sol-thread-solution-sol-energy-twin')).toBeVisible();
    await page.getByTestId('dlv-tab-deliverable').click();
    await expect(page.getByTestId('sol-doc-state-sol-energy-twin')).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.reload();
    await page.getByTestId('dlv-tab-solution').click();
    await page.locator('#sol-sim').click();
    await expect(page.getByTestId('sol-sim-kpi-co2')).toBeVisible();
  });

  test('English: the band, the draft and the deliverable screen have no Japanese', async ({ page }) => {
    await go(page, '/deliverables?step=kpi', 'en');
    await fakeAi(page);
    await expect(page.getByTestId('dlv-name')).toHaveText('KPI/OKR definition (measurement plan)');
    await page.getByTestId('dlv-screen-draft').click();
    await expect(page.getByTestId('dlv-draft-dialog')).toContainText('Draft: KPI/OKR definition');
    await generateDraft(page);
    await page.getByTestId('dlv-draft-apply').click();
    await expect(page.getByTestId('dlv-field-formula')).toHaveValue(/lower is better/);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    expect(await scan(page)).toEqual([]);
  });
});

test.describe('step handoff and Copilot form drafts', () => {
  test('a step is confirmed only when its ToDos are done; its items become the next step input and a later edit asks for reconfirmation', async ({ page }) => {
    await go(page, '/home');
    await fakeAi(page);
    await seedQualified(page);
    const stepper = page.getByTestId('proj-stepper');
    const asis = stepper.locator('[data-step="asis"]');
    await asis.click();
    await page.getByTestId('step-dash-view-details').click();
    await expect(page.getByTestId('step-handoff-status')).toHaveAttribute('data-status', 'none');
    await expect(page.getByTestId('step-handoff-confirm')).toBeDisabled();
    await expect(page.getByTestId('step-handoff-blocker')).toHaveText('ToDo をすべて完了すると確定できます。');
    await openStepDraft(page);
    await generateDraft(page);
    await page.getByTestId('dlv-draft-apply').click();
    await page.getByTestId('dlv-sign-asis-field').check();
    await expect(page.getByTestId('step-handoff-confirm')).toBeDisabled();
    await page.getByTestId('dlv-sign-define-agree').check();
    await expect(page.getByTestId('step-handoff-confirm')).toBeEnabled();
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page)).toEqual([]);

    await page.getByTestId('step-handoff-confirm').click();
    await expect(page).toHaveURL(/#\/step\?step=tobe/);
    await expect(asis).toHaveAttribute('data-handoff', 'current');
    await page.getByTestId('step-dash-view-details').click();
    const inherited = page.getByTestId('step-handoff-inherited-items');
    await expect(inherited.locator('tbody tr').first()).toBeVisible();
    await expect(inherited.locator('[data-change="changed"]')).toHaveCount(0);
    await expect(page.getByTestId('step-handoff-inherited')).toContainText('E2E が確定');
    // The next step cannot be confirmed before its own ToDos are done.
    await expect(page.getByTestId('step-handoff-confirm')).toBeDisabled();
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await scan(page)).toEqual([]);
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await expect(asis).toHaveAttribute('data-handoff', 'current');

    // Editing a confirmed item afterwards marks it and asks for reconfirmation.
    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('dlv-field-problem').fill('受注から出荷までが長い(追記)');
    await expect(asis).toHaveAttribute('data-handoff', 'stale');
    await page.goto('/#/step?step=tobe&view=details');
    await expect(page.getByTestId('step-handoff-upstream-changed')).toBeVisible();
    await expect(page.getByTestId('step-handoff-inherited-items').locator('[data-change="changed"]')).toHaveCount(1);
  });

  test('use case: a Copilot draft is a proposal until approved; a changed input blocks the stale draft', async ({ page }) => {
    await go(page, '/usecases?uc=new');
    const draft = page.getByTestId('uc-draft');
    await draft.getByTestId('uc-draft-create').click();
    const preview = page.getByTestId('uc-draft-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('モック');
    await expect(page.locator('#uc-name')).toHaveValue('');
    expect(await scan(page)).toEqual([]);
    // Typing after the draft was made: the draft no longer matches the input and cannot be approved.
    await page.locator('#uc-name').fill('在庫の見える化');
    await expect(page.getByTestId('uc-draft-stale')).toBeVisible();
    await expect(page.getByTestId('uc-draft-approve')).toBeDisabled();
    await page.getByTestId('uc-draft-discard').click();
    await expect(preview).toBeHidden();

    await page.getByTestId('uc-draft-create').click();
    await page.getByTestId('uc-draft-approve').click();
    await expect(page.getByTestId('uc-draft-applied')).toBeVisible();
    await expect(page.locator('#uc-name')).toHaveValue('在庫の見える化');
    await expect(page.locator('#uc-step-title-0')).not.toHaveValue('');
  });

  test('contribution and deliverable section: approve a Copilot draft into the form and the document', async ({ page }) => {
    await go(page, '/deliverables?step=solution');
    const sol = page.getByTestId('sol-solution-sol-energy-twin');
    await sol.evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await page.getByTestId('sol-contrib-add-sol-energy-twin').click();
    await page.getByTestId('sol-c-draft-sol-energy-twin-create').click();
    await expect(page.getByTestId('sol-c-draft-sol-energy-twin-preview')).toBeVisible();
    await page.getByTestId('sol-c-draft-sol-energy-twin-approve').click();
    await expect(page.getByTestId('sol-c-lever')).not.toHaveValue('');
    await expect(page.getByTestId('sol-c-basis')).toHaveValue('assumption');
    await page.getByTestId('sol-c-save').click();
    await page.locator('#sol-sim').click();
    await expect(page.getByTestId('sol-sim-kpi-co2')).toBeVisible();
    await page.goBack();

    await page.getByTestId('dlv-tab-deliverable').click();
    const doc = page.getByTestId('sol-doc-sol-energy-twin');
    await doc.evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    const section = doc.locator('[data-kind="section"]').first();
    const id = (await section.getAttribute('data-testid'))!.replace('sol-doc-draft-sol-energy-twin-', '');
    await section.getByTestId(`sol-doc-draft-sol-energy-twin-${id}-create`).click();
    const text = await section.getByTestId(`sol-doc-draft-sol-energy-twin-${id}-preview`).locator('pre').innerText();
    await section.getByTestId(`sol-doc-draft-sol-energy-twin-${id}-approve`).click();
    await expect(page.getByTestId(`sol-doc-sol-energy-twin-${id}`)).toHaveValue(text);
    await expect(page.getByTestId(`sol-doc-reset-sol-energy-twin-${id}`)).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });
});