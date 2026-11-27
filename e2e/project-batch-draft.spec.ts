import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { deviceSnapshot, JAPANESE, open, seedDeviceData, visibleTextExcludingOtherLang } from './helpers.ts';
import { emptyDeliverables, setField, setSignOff, STEP_DEFS } from '../src/modules/project/deliverables.ts';
import type { ImprovementStep } from '../src/state/projects.ts';
import { workflowAnswer } from '../tests/fixtures/workflow.ts';
import { DIAGNOSIS_MARK, diagnosisMockAnswer } from '../src/modules/project/issueDiagnosis.ts';

type Provider = 'foundry' | 'copilotSdk';
type RelayRequest = { use: string; provider: Provider; lang: 'ja' | 'en'; prompt: string; context: string; stage?: string };
const steps: ImprovementStep[] = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'];
const taskText = [
  '事実・根拠: 事実', '不足情報: 要確認', '仮説: 仮説', '選択肢: 比較',
  '推奨: 検証', '理由: 根拠', '検証: 照合', '影響: 評価',
].join('\n');
const englishTaskText = [
  'Facts and evidence: Evidence', 'Missing information: To confirm', 'Hypotheses: Hypothesis', 'Options: Compare',
  'Recommendation: Verify', 'Reasoning: Evidence', 'Verification: Check', 'Impact: Evaluate',
].join('\n');

function answer(request: RelayRequest): string {
  if (request.prompt.startsWith('[bas-proj:workflowDraft]')) return JSON.stringify(workflowAnswer(request.prompt));
  // FR-385: the issue diagnosis gets a complete answer (the app's own deterministic mock).
  if (request.prompt.startsWith(DIAGNOSIS_MARK)) return diagnosisMockAnswer(request.prompt);
  if (request.prompt.startsWith('[bas-proj:solution:')) {
    const context = JSON.parse(request.prompt.slice(request.prompt.indexOf('CONTEXT: ') + 9)) as { types: Record<string, { open: string[] }> };
    const type = Object.keys(context.types)[0]!;
    return JSON.stringify({ type, reason: '仮説', sections: Object.fromEntries(context.types[type]!.open.map((id) => [id, '提案（仮説）'])) });
  }
  // FR-376: the task phase (and the resolution it reuses) gets no usable answer here, so every task draft is BAS's labelled rule.
  if (request.prompt.startsWith('[bas-proj:task:') || request.prompt.startsWith('[bas-proj:resolve')) return '{}';
  if (request.use === 'deliverableDraft') {
    const step = /\[bas-proj:deliverable:([a-z]+)\]/.exec(request.prompt)?.[1] as ImprovementStep;
    return [
      ...STEP_DEFS[step].fields.map((field) => `### ${field.id}\n提案`),
      ...STEP_DEFS[step].todos.map((todo) => `### task-${todo.id}\n${request.lang === 'en' ? englishTaskText : taskText}`),
    ].join('\n');
  }
  if (request.use === 'stepBrief') {
    return ['answer', 'situation', 'complication', 'question', 'findings', 'actions', 'caveats']
      .map((section) => `### ${section}\n提案`).join('\n');
  }
  return JSON.stringify({
    answer: '確認する', findings: [{ text: '根拠を確認', refs: ['issue-quality'] }],
    actions: [{ text: '検証する', refs: ['issue-quality'] }], caveats: ['仮説'], axis: 'impact',
    axisReason: '影響を評価', objectiveIssues: [], patches: [],
  });
}

async function setupBatch(page: Page, provider: Provider, failOnce?: string, audience: 'internal' | 'external' = 'internal', lang: 'ja' | 'en' = 'ja') {
  const requests: RelayRequest[] = [];
  let shouldFail = !!failOnce;
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
  } }));
  await page.route('**/relay/ai', async (route) => {
    const request = route.request().postDataJSON() as RelayRequest;
    // FR-376: the task phase's calls (stage tasks:<todo>) are counted by the task-draft test, not here.
    if (!request.stage?.startsWith('tasks:')) requests.push(request);
    if (shouldFail && request.prompt.includes(failOnce!)) {
      shouldFail = false;
      await route.fulfill({ status: 504, json: { error: 'fixtureTimeout' } });
      return;
    }
    await route.fulfill({ json: { text: answer(request), inputTokens: 100, outputTokens: 100 } });
  });
  await open(page, '/deliverables?step=asis', { audience, lang });
  const at = '2026-11-09T00:00:00Z';
  const data = setSignOff(setField(emptyDeliverables(), 'asis', 'problem', { text: '人が入力した成果物', author: 'human', updatedAt: at }),
    'asis-field', { at, by: '担当者' });
  data.recommendations = { [`internal:${STEP_DEFS.asis.todos[0]!.id}`]: { approved: { text: '承認済みの提案', mock: false, at, by: '担当者' } } };
  await seedDeviceData(page, {
    'bas.ai.settings': JSON.stringify({ state: { provider, liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }),
    'bas.scope.demo.proj.deliverables': JSON.stringify(data),
  });
  await page.reload();
  await expect(page.locator('main#main')).toBeVisible();
  return requests;
}

async function openBatch(page: Page) {
  await expect(page.getByTestId('dlv-draft')).toHaveText('全てのステップに対してCopilotでドラフト作成');
  await page.getByTestId('dlv-draft').click();
  await expect(page.getByTestId('dlv-batch-dialog')).toBeVisible();
  await expect(page.getByTestId('dlv-batch-dialog')).toContainText('議論テーマ別の提案、企業分析との整合案、添付を使う生成は対象外です。');
}

async function confirmBatch(page: Page) {
  await page.getByTestId('dlv-batch-generate').click();
  await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
}

/** Holds the To-Be deliverable request in flight (D-41: there is no interval wait to stop in any more). */
async function holdTobe(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/relay/ai', async (route) => {
    const request = route.request().postDataJSON() as RelayRequest;
    if (!request.prompt.includes('[bas-proj:deliverable:tobe]')) return route.fallback();
    await gate;
    await route.fulfill({ json: { text: answer(request), inputTokens: 100, outputTokens: 100 } }).catch(() => undefined);
  });
  return release;
}

test.describe('all-step live drafts', () => {
  test.setTimeout(180_000);

  for (const provider of ['foundry', 'copilotSdk'] as const) {
    test(`${provider}: saved settings consent sends drafts without per-send prompts and protects existing work`, async ({ page }) => {
      const requests = await setupBatch(page, provider);
      await openBatch(page);
      if (provider === 'foundry') {
        const scan = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .exclude('[data-tabster-dummy]').analyze();
        expect(scan.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
      }
      await confirmBatch(page);
      await expect(page.getByRole('dialog', { name: '全ステップのドラフトを一括作成' })).toBeVisible();
      await expect(page.getByTestId('dlv-batch-progress')).toContainText('19/19', { timeout: 110_000 });
      // D-44: the As-Is deliverable (22 sections) is drafted as a fields call and a tasks call.
      expect(requests).toHaveLength(19);
      expect(requests.every((request) => request.provider === provider)).toBe(true);
      expect(requests.filter((request) => request.use === 'deliverableDraft')).toHaveLength(8);
      expect(requests.filter((request) => request.use === 'solutionDraft')).toHaveLength(5);
      expect(requests.filter((request) => request.prompt.startsWith('[bas-proj:solution:'))).toHaveLength(5);
      expect(requests.filter((request) => request.use === 'stepBrief')).toHaveLength(5);
      expect(requests.filter((request) => request.use === 'strategyOverview')).toHaveLength(1);

      const saved = (await deviceSnapshot(page)).records;
      const deliverables = JSON.parse(saved['bas.scope.demo.proj.deliverables']!.value!);
      const drafts = JSON.parse(saved['bas.scope.demo.proj.fieldDrafts']!.value!);
      const briefs = JSON.parse(saved['bas.scope.demo.proj.stepBriefs']!.value!);
      const solutionDrafts = JSON.parse(saved['bas.scope.demo.proj.solutionDrafts']!.value!);
      expect(Object.keys(solutionDrafts)).toHaveLength(5);
      expect(saved['bas.scope.demo.proj.strategy']).toBeUndefined();
      expect(deliverables.docs.asis.problem.text).toBe('人が入力した成果物');
      expect(deliverables.signOffs['asis-field'].by).toBe('担当者');
      expect(deliverables.recommendations[`internal:${STEP_DEFS.asis.todos[0]!.id}`].approved.text).toBe('承認済みの提案');
      for (const step of steps) {
        expect(Object.keys(drafts[`internal:${step}`].fields)).toHaveLength(STEP_DEFS[step].fields.length);
        expect(briefs[`internal:${step}`].mode).toBe('live');
      }

      const strategyLink = page.getByTestId('dlv-batch-strategy').getByRole('link');
      await expect(strategyLink).toBeVisible();
      await strategyLink.click();
      await expect(page.getByTestId('strategy-draft')).toBeVisible();
      await expect(page.getByTestId('strategy-stale')).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId('strategy-draft')).toBeVisible();
      await page.goto('/#/step?step=tobe&view=details');
      await expect(page.getByTestId('step-dash-brief-ai')).toHaveAttribute('data-mode', 'live');
      await expect(page.getByTestId('step-dash-brief-ai')).toHaveAttribute('data-stale', 'false');
      await page.reload();
      await expect(page.getByTestId('step-dash-brief-ai')).toHaveAttribute('data-mode', 'live');
      await page.goto('/#/deliverables?step=asis');
      await expect(page.getByTestId('dlv-field-problem')).toHaveValue('人が入力した成果物');
      await page.getByTestId('dlv-screen-draft').click();
      await expect(page.getByTestId('dlv-draft-mode')).toHaveAttribute('data-mode', 'live');
      await expect(page.getByTestId('dlv-draft-field-problem')).toContainText('提案');
      await page.getByTestId('dlv-draft-apply').click();
      await expect(page.getByTestId('dlv-field-problem')).toHaveValue('人が入力した成果物');
    });
  }

  for (const lang of ['ja', 'en'] as const) {
    test(`token usage names every batch step and split call with its own reported counts (${lang})`, async ({ page }) => {
      await setupBatch(page, 'copilotSdk', undefined, 'internal', lang);
      const calls: { stage: string; input: number; output: number | null }[] = [];
      await page.route('**/relay/ai', async (route) => {
        const request = route.request().postDataJSON() as RelayRequest;
        if (!request.stage) throw new Error('Missing batch stage');
        const input = (calls.length + 1) * 101;
        const output = request.stage === 'brief-tobe' ? null : (calls.length + 1) * 13;
        calls.push({ stage: request.stage, input, output });
        await route.fulfill({ json: { text: answer(request), inputTokens: input, outputTokens: output } });
      });
      if (lang === 'ja') await openBatch(page);
      else await page.getByTestId('dlv-draft').click();
      await confirmBatch(page);
      await expect(page.getByTestId('dlv-batch-progress')).toContainText('19/19', { timeout: 110_000 });
      // FR-376: the task phase adds one row per task it asked Copilot about (tasks:<todo>).
      expect(calls.filter((call) => !call.stage.startsWith('tasks:'))).toHaveLength(19);
      await expect(page.getByTestId('dlv-batch-tokens-row')).toHaveCount(calls.length);

      const unknown = lang === 'ja' ? '不明' : 'unknown';
      const num = (n: number | null) => n === null ? unknown : n.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US');
      for (const { stage, input, output } of calls) {
        const row = page.locator(`[data-testid="dlv-batch-tokens-row"][data-step="${stage}"]`);
        const job = page.getByTestId(`dlv-batch-${stage.split(':')[0]}`);
        await expect(row.locator('th')).toContainText(await job.locator('strong').innerText());
        await expect(row.locator('td')).toHaveText([
          '1', num(input), num(output), num(output === null ? null : input + output),
        ]);
      }
      await expect(page.locator('[data-testid="dlv-batch-tokens-row"][data-step="fields-asis:fields"] th'))
        .toContainText(lang === 'ja' ? '成果物の各項目' : 'Deliverable fields');
      await expect(page.locator('[data-testid="dlv-batch-tokens-row"][data-step="fields-asis:tasks"] th'))
        .toContainText(lang === 'ja' ? 'タスク別の推奨案' : 'Task recommendations');
      await expect(page.getByTestId('dlv-batch-tokens-total').locator('td')).toHaveText([
        String(calls.length), num(calls.reduce((sum, call) => sum + call.input, 0)), unknown, unknown,
      ]);

      const scan = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .exclude('[data-tabster-dummy]').analyze();
      expect(scan.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
      const dialog = page.getByTestId('dlv-batch-dialog');
      const table = page.getByTestId('dlv-batch-tokens');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const dialogBox = await dialog.boundingBox();
        const tableBox = await table.boundingBox();
        expect(tableBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
        expect(tableBox!.x + tableBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1);
        expect(await table.locator('th, td').evaluateAll((cells) =>
          cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map((cell) => cell.textContent))).toEqual([]);
      }
      await page.setViewportSize({ width: 1280, height: 720 });
      await dialog.getByRole('button', { name: lang === 'ja' ? '閉じる' : 'Close', exact: true }).click();
      await page.getByTestId('proj-export-all').click();
      await expect(page.getByTestId('proj-export-dialog')).toBeVisible();
      await expect(page.getByTestId('proj-export-tokens-table-row')).toHaveCount(calls.length + 1);
      await expect(page.getByTestId('proj-export-preview'))
        .toContainText(lang === 'ja' ? '成果物のドラフト作成' : 'Deliverable drafts');
      await expect(page.getByTestId('proj-export-tokens-table-total').locator('td')).toHaveText([
        String(calls.length), num(calls.reduce((sum, call) => sum + call.input, 0)), unknown, unknown,
      ]);
    });
  }

  test('D-41: runs to the end at any time, even after many calls today and with no interval', async ({ page }) => {
    const requests = await setupBatch(page, 'copilotSdk');
    const now = Date.now();
    const ledger = ['deliverableDraft', 'stepBrief', 'strategyOverview'].flatMap((use) =>
      Array.from({ length: 40 }, (_, i) => ({ at: new Date(now - i * 100).toISOString(), use, inputTokens: 1, outputTokens: 1, scope: 'demo' })));
    await seedDeviceData(page, { 'bas.ai.ledger': JSON.stringify(ledger) });
    await page.reload();
    await expect(page.locator('main#main')).toBeVisible();
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('19/19', { timeout: 60_000 });
    await expect(page.getByTestId('dlv-batch-error')).toHaveCount(0);
    expect(requests).toHaveLength(19);
  });

  test('FR-376: every open task gets a checked draft; the person only edits or approves, and each value shows its data state', async ({ page }) => {
    await setupBatch(page, 'foundry');
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('19/19', { timeout: 110_000 });
    await expect(page.getByTestId('dlv-batch-tasks-summary')).toContainText('件のタスクにドラフトを保存しました');
    // Nothing is applied by the batch: the sign-off still waits.
    let saved = JSON.parse((await deviceSnapshot(page)).records['bas.scope.demo.proj.deliverables']!.value!);
    expect(saved.signOffs['define-agree']).toBeUndefined();
    await page.getByTestId('dlv-batch-tasks-review').click();
    const review = page.getByTestId('dlv-td-review');
    await expect(review).toBeVisible();
    await expect(review.getByTestId('dlv-state-legend')).toContainText('BAS の仮置き');
    await expect(page.getByTestId('dlv-td-row-define-agree')).toHaveAttribute('data-state', 'ready');
    const scan = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .exclude('[data-tabster-dummy]').analyze();
    expect(scan.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);

    // A sign-off record is edited to what the person confirmed, then approved: that is the sign-off.
    await page.getByTestId('dlv-td-row-review-define-agree').click();
    const dialog = page.getByTestId('dlv-td-dialog');
    await expect(dialog.getByTestId('dlv-td-verdict')).toContainText('承認すると、このタスクは完了します');
    await expect(dialog.getByTestId('dlv-td-signoff-note')).toContainText('Copilot は聞き取りや合意を行っていません');
    await expect(dialog.getByTestId('dlv-td-lines').locator('li').first()).toHaveAttribute('data-state', 'estimate');
    await dialog.getByTestId('dlv-td-edit-start').click();
    await dialog.getByTestId('dlv-td-edit-0-text').fill('2026-11-20 スポンサーと課題・範囲・成功の定義に合意');
    await expect(dialog.getByTestId('dlv-td-lines').locator('li').first()).toHaveAttribute('data-state', 'human');
    await dialog.getByTestId('dlv-td-approve').click();
    await expect(dialog.getByTestId('dlv-td-done')).toBeVisible();
    await dialog.getByTestId('dlv-td-close').click();
    saved = JSON.parse((await deviceSnapshot(page)).records['bas.scope.demo.proj.deliverables']!.value!);
    expect(saved.signOffs['define-agree']).toBeTruthy();
    expect(saved.recommendations['internal:define-agree'].approved.text).toContain('[人が入力] 2026-11-20 スポンサーと課題・範囲・成功の定義に合意');
    await expect(page.getByTestId('dlv-td-row-define-agree')).toHaveAttribute('data-state', 'done');

    // Approving the rest leaves no task that a draft could complete.
    await page.getByTestId('dlv-td-approve-all').click();
    await expect(page.getByTestId('dlv-td-review-message')).toContainText('件のドラフトを承認して保存しました');
    await expect(review.locator('li[data-state="ready"], li[data-state="viaOther"]')).toHaveCount(0);
    for (const id of ['asis-qualify', 'define-decision', 'define-agree', 'kpi-measure', 'plan-approve']) {
      await expect(page.getByTestId(`dlv-td-row-${id}`)).toHaveAttribute('data-state', 'done');
    }
    saved = JSON.parse((await deviceSnapshot(page)).records['bas.scope.demo.proj.deliverables']!.value!);
    expect(Object.keys(saved.qualifications ?? {}).length).toBeGreaterThan(0);
    expect(saved.docs.asis.problem.text).toBe('人が入力した成果物');
    expect(saved.signOffs['asis-field'].by).toBe('担当者');
    await page.getByTestId('dlv-td-review-close').click();
    await expect(page.getByTestId('dlv-td-state-define-agree').first()).toHaveAttribute('data-state', 'confirmed');
  });

  test('D-44: a failure keeps completed drafts, the batch goes on, and retry runs only unfinished jobs', async ({ page }) => {
    const requests = await setupBatch(page, 'foundry', '[bas-proj:deliverable:tobe]');
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('18/19', { timeout: 110_000 });
    await expect(page.getByTestId('dlv-batch-error')).toContainText('1 件を作成できませんでした');
    await expect(page.getByTestId('dlv-batch-failure-fields-tobe')).toContainText('実接続に失敗');
    await expect(page.getByTestId('dlv-batch-fields-asis')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('dlv-batch-fields-tobe')).toHaveAttribute('data-status', 'failed');
    await expect(page.getByTestId('dlv-batch-fields-kpi')).toHaveAttribute('data-status', 'done');
    await page.getByTestId('dlv-batch-generate').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('19/19', { timeout: 110_000 });
    await expect(page.getByTestId('dlv-batch-error')).toHaveCount(0);
    expect(requests.filter((request) => request.prompt.includes('[bas-proj:deliverable:asis]'))).toHaveLength(2);
    expect(requests.filter((request) => request.prompt.includes('[bas-proj:deliverable:tobe]'))).toHaveLength(2);
  });

  test('D-44: an answer cut off at the output cap is retried split, then reported with its cause', async ({ page }) => {
    const requests = await setupBatch(page, 'foundry');
    await page.route('**/relay/ai', async (route) => {
      const request = route.request().postDataJSON() as RelayRequest;
      if (!request.prompt.includes('[bas-proj:deliverable:kpi]')) return route.fallback();
      requests.push(request);
      await route.fulfill({ status: 502, json: { error: 'outputLimit', inputTokens: 900, outputTokens: 32000, reasoningTokens: 32000 } });
    });
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('18/19', { timeout: 110_000 });
    await expect(page.getByTestId('dlv-batch-failure-fields-kpi')).toContainText('出力上限');
    const kpi = requests.filter((request) => request.prompt.includes('[bas-proj:deliverable:kpi]'));
    expect(kpi).toHaveLength(2);
    expect(kpi[1]!.prompt).toContain('This call covers only the fields');
    expect(kpi[1]!.stage).toBe('fields-kpi:fields');
    const first = page.locator('[data-testid="dlv-batch-tokens-row"][data-step="fields-kpi"]');
    const retry = page.locator('[data-testid="dlv-batch-tokens-row"][data-step="fields-kpi:fields"]');
    await expect(first.locator('th')).toHaveText('KPI/OKR 定義: 成果物とタスク別の提案');
    await expect(retry.locator('th')).toContainText('KPI/OKR 定義: 成果物とタスク別の提案');
    await expect(retry.locator('th')).toContainText('成果物の各項目');
    await expect(first.locator('td')).toHaveText(['1', '900', '32,000', '32,900']);
    await expect(retry.locator('td')).toHaveText(['1', '900', '32,000', '32,900']);
  });

  test('shows the current split call, elapsed time and a wider responsive dialog', async ({ page }) => {
    await setupBatch(page, 'foundry');
    let releaseFields!: () => void;
    let releaseTasks!: () => void;
    const fields = new Promise<void>((resolve) => { releaseFields = resolve; });
    const tasks = new Promise<void>((resolve) => { releaseTasks = resolve; });
    await page.route('**/relay/ai', async (route) => {
      const request = route.request().postDataJSON() as RelayRequest;
      if (request.stage === 'fields-asis:fields') await fields;
      else if (request.stage === 'fields-asis:tasks') await tasks;
      else return route.fallback();
      await route.fulfill({ json: { text: answer(request), inputTokens: 100, outputTokens: 100 } }).catch(() => undefined);
    });
    try {
      await openBatch(page);
      const dialog = page.getByTestId('dlv-batch-dialog');
      const desktop = await dialog.boundingBox();
      expect(desktop!.width).toBeGreaterThan(1000);
      await confirmBatch(page);
      const current = page.getByTestId('dlv-batch-current');
      const progress = page.getByTestId('dlv-batch-current-progress');
      await expect(current).toContainText('現状分析: 成果物とタスク別の提案');
      await expect(progress).toHaveAttribute('data-activity', 'fields');
      await expect(progress).toContainText('成果物の各項目を作成しています');
      await expect(progress.getByTestId('dlv-batch-current-progress-detail')).toContainText('2 回のうち 1 回目');
      await expect(progress.getByTestId('dlv-batch-current-progress-status')).toContainText('この処理の開始から 0:02 経過', { timeout: 5000 });
      await expect(page.getByTestId('dlv-batch-progress')).toContainText('1/19');
      await expect(page.getByTestId('dlv-batch-progress-bar')).toHaveAttribute('aria-valuenow', String(1 / 19));
      await expect(progress.getByTestId('dlv-batch-current-progress-bar')).toHaveAttribute('aria-valuetext', '3 段階中 1 段階完了');
      const scan = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .exclude('[data-tabster-dummy]').analyze();
      expect(scan.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);

      releaseFields();
      await expect(progress).toHaveAttribute('data-activity', 'tasks');
      await expect(progress).toContainText('タスク別の推奨案を作成しています');
      await expect(progress.getByTestId('dlv-batch-current-progress-detail')).toContainText('2 回のうち 2 回目');
      await expect(page.getByTestId('dlv-batch-progress')).toContainText('1/19');

      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await dialog.boundingBox();
      expect(mobile!.width).toBeGreaterThan(340);
      expect(mobile!.width).toBeLessThanOrEqual(358);
      await expect(page.getByTestId('dlv-batch-stop')).toBeVisible();
      await page.getByTestId('dlv-batch-stop').click();
      releaseTasks();
      await expect(page.getByTestId('dlv-batch-fields-asis')).toHaveAttribute('data-status', 'pending');
      await expect(current).toHaveCount(0);
      await expect(dialog).toContainText('実行を中断しました');
      const cancelled = page.locator('[data-testid="dlv-batch-tokens-row"][data-step="fields-asis:tasks"]');
      await expect(cancelled.locator('th')).toContainText('現状分析: 成果物とタスク別の提案');
      await expect(cancelled.locator('th')).toContainText('タスク別の推奨案');
      await expect(cancelled.locator('th')).toContainText('推定を含む');

      await page.getByTestId('dlv-batch-generate').click();
      await expect(page.getByTestId('dlv-batch-progress')).toContainText('19/19', { timeout: 110_000 });
      await expect(page.getByTestId('dlv-batch-progress-bar')).toHaveAttribute('aria-valuenow', '1');
      await expect(page.getByTestId('dlv-batch-progress-bar')).toHaveAttribute('aria-valuemax', '1');
    } finally {
      releaseFields();
      releaseTasks();
    }
  });

  test('stopping while a job is in flight preserves completed drafts', async ({ page }) => {
    const requests = await setupBatch(page, 'foundry');
    const release = await holdTobe(page);
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-fields-tobe')).toHaveAttribute('data-status', 'working', { timeout: 30_000 });
    await page.getByTestId('dlv-batch-stop').click();
    release();
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('3/19');
    await expect(page.getByTestId('dlv-batch-fields-tobe')).toHaveAttribute('data-status', 'pending');
    expect(requests).toHaveLength(4);
    await page.getByTestId('dlv-batch-fields-asis').getByRole('button', { name: 'この成果物のドラフトを確認' }).click();
    await expect(page.getByTestId('dlv-draft-mode')).toHaveAttribute('data-mode', 'live');
    const key = 'bas.scope.demo.proj.fieldDrafts';
    const current = JSON.parse((await deviceSnapshot(page)).records[key]!.value!);
    current['internal:asis'].fields.problem = '別の作業で更新';
    current['internal:asis'].at = '2026-11-10T00:00:00Z';
    await seedDeviceData(page, { [key]: JSON.stringify(current) });
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'bas.device.saved' })));
    await expect(page.getByTestId('dlv-draft-changed')).toBeVisible();
    await expect(page.getByTestId('dlv-draft-apply')).toBeDisabled();
    await expect(page.getByTestId('dlv-draft-discard')).toBeDisabled();
    await page.getByTestId('dlv-draft-dialog').getByRole('button', { name: '閉じる' }).click();
    await page.reload();
    await page.getByTestId('dlv-screen-draft').click();
    await expect(page.getByTestId('dlv-draft-field-problem')).toContainText('別の作業で更新');
  });

  test('stops rather than overwriting a draft changed in another device session', async ({ page }) => {
    const requests = await setupBatch(page, 'foundry');
    const release = await holdTobe(page);
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-fields-tobe')).toHaveAttribute('data-status', 'working', { timeout: 30_000 });
    const key = 'bas.scope.demo.proj.fieldDrafts';
    const current = JSON.parse((await deviceSnapshot(page)).records[key]!.value!);
    current['internal:asis'].fields.problem = '別の作業で更新';
    await page.evaluate((changedKey) => {
      window.addEventListener('bas-device-change', (event) => {
        if (event instanceof CustomEvent && event.detail === changedKey) document.body.dataset.e2eDraftChanged = 'true';
      });
    }, key);
    await seedDeviceData(page, { [key]: JSON.stringify(current) });
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'bas.device.saved' })));
    await expect(page.locator('body')).toHaveAttribute('data-e2e-draft-changed', 'true');
    release();
    await expect(page.getByTestId('dlv-batch-error')).toContainText('変更されたため停止', { timeout: 30_000 });
    await expect(page.getByTestId('dlv-batch-generate')).toBeDisabled();
    expect(requests).toHaveLength(4);
    const saved = JSON.parse((await deviceSnapshot(page)).records[key]!.value!);
    expect(saved['internal:asis'].fields.problem).toBe('別の作業で更新');
  });

  for (const changed of ['field', 'task'] as const) {
    test(`individual regeneration preserves a ${changed} draft changed while waiting for the model`, async ({ page }) => {
      await setupBatch(page, 'foundry');
      const fieldKey = 'bas.scope.demo.proj.fieldDrafts';
      const deliverableKey = 'bas.scope.demo.proj.deliverables';
      const taskKey = `internal:${STEP_DEFS.asis.todos[0]!.id}`;
      const draft = { 'internal:asis': { fields: { problem: '最初の下書き' }, lang: 'ja', at: '2026-11-09T00:00:00Z' } };
      await seedDeviceData(page, { [fieldKey]: JSON.stringify(draft) });
      await page.reload();

      let releaseResponse!: () => void;
      let notifyRequest!: () => void;
      const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
      const requestStarted = new Promise<void>((resolve) => { notifyRequest = resolve; });
      await page.route('**/relay/ai', async (route) => {
        const request = route.request().postDataJSON() as RelayRequest;
        notifyRequest();
        await responseGate;
        await route.fulfill({ json: { text: answer(request), inputTokens: 100, outputTokens: 100 } });
      });

      try {
        await page.getByTestId('dlv-screen-draft').click();
        await expect(page.getByTestId('dlv-draft-field-problem')).toContainText('最初の下書き');
        await page.getByTestId('dlv-draft-regenerate').click();
        await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
        await requestStarted;

        const changedKey = changed === 'field' ? fieldKey : deliverableKey;
        await page.evaluate((key) => {
          window.addEventListener('bas-device-change', (event) => {
            if (event instanceof CustomEvent && event.detail === key) document.body.dataset.e2eDraftChanged = 'true';
          });
        }, changedKey);
        const deliverables = JSON.parse((await deviceSnapshot(page)).records[deliverableKey]!.value!);
        draft['internal:asis'].fields.problem = '別の作業で更新';
        draft['internal:asis'].at = '2026-11-10T00:00:00Z';
        deliverables.recommendations[taskKey].draft = { text: '別の作業で更新', mock: false, at: '2026-11-10T00:00:00Z' };
        await seedDeviceData(page, { [changedKey]: JSON.stringify(changed === 'field' ? draft : deliverables) });
        await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'bas.device.saved' })));
        await expect(page.locator('body')).toHaveAttribute('data-e2e-draft-changed', 'true');
        releaseResponse();

        await expect(page.getByTestId('dlv-draft-dialog')).toContainText('保存済みドラフトが別の操作で変更されました');
        const saved = JSON.parse((await deviceSnapshot(page)).records[changedKey]!.value!);
        const text = changed === 'field' ? saved['internal:asis'].fields.problem : saved.recommendations[taskKey].draft.text;
        expect(text).toBe('別の作業で更新');
      } finally {
        releaseResponse();
      }
    });
  }

  test('external-audience send excludes confidential and privately sourced data without a per-send prompt', async ({ page }) => {
    const requests = await setupBatch(page, 'foundry', undefined, 'external');
    await page.getByTestId('dlv-screen-draft').click();
    await page.getByTestId('dlv-draft-generate').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await expect.poll(() => requests.length).toBe(2);
    const sent = JSON.stringify(requests);
    for (const secret of ['熟練技能の継承', '技能伝承 Copilot', '現場インタビュー記録', 'cause-tacit-knowledge', 'src-interview']) {
      expect(sent).not.toContain(secret);
    }
  });

  for (const lang of ['ja', 'en'] as const) {
    test(`the all-step action fits on a narrow screen (${lang})`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await open(page, '/home', { lang });
      const button = page.getByTestId('dlv-draft');
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      await button.click();
      await expect(page.getByTestId('dlv-batch-dialog')).toBeVisible();
    });
  }

  test('the batch dialog is localized in English', async ({ page }) => {
    await open(page, '/home', { lang: 'en' });
    await expect(page.getByTestId('dlv-draft')).toHaveText('Create drafts for all steps with Copilot');
    await page.getByTestId('dlv-draft').click();
    await expect(page.getByRole('dialog', { name: 'Create drafts for all steps' })).toBeVisible();
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
  });
});
