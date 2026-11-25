import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { deviceSnapshot, JAPANESE, open, seedDeviceData, visibleTextExcludingOtherLang } from './helpers.ts';
import { emptyDeliverables, setField, setSignOff, STEP_DEFS } from '../src/modules/project/deliverables.ts';
import type { ImprovementStep } from '../src/state/projects.ts';

type Provider = 'foundry' | 'copilotSdk';
type RelayRequest = { use: string; provider: Provider; prompt: string; context: string };
const steps: ImprovementStep[] = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'];
const taskText = [
  '事実・根拠: 事実', '不足情報: 要確認', '仮説: 仮説', '選択肢: 比較',
  '推奨: 検証', '理由: 根拠', '検証: 照合', '影響: 評価',
].join('\n');

function answer(request: RelayRequest): string {
  if (request.prompt.startsWith('[bas-proj:solution:')) {
    const context = JSON.parse(request.prompt.slice(request.prompt.indexOf('CONTEXT: ') + 9)) as { types: Record<string, { open: string[] }> };
    const type = Object.keys(context.types)[0]!;
    return JSON.stringify({ type, reason: '仮説', sections: Object.fromEntries(context.types[type]!.open.map((id) => [id, '提案（仮説）'])) });
  }
  if (request.use === 'deliverableDraft') {
    const step = /\[bas-proj:deliverable:([a-z]+)\]/.exec(request.prompt)?.[1] as ImprovementStep;
    return [
      ...STEP_DEFS[step].fields.map((field) => `### ${field.id}\n提案`),
      ...STEP_DEFS[step].todos.map((todo) => `### task-${todo.id}\n${taskText}`),
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

async function setupBatch(page: Page, provider: Provider, failOnce?: string, audience: 'internal' | 'external' = 'internal') {
  const requests: RelayRequest[] = [];
  let shouldFail = !!failOnce;
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
  } }));
  await page.route('**/relay/ai', async (route) => {
    const request = route.request().postDataJSON() as RelayRequest;
    requests.push(request);
    if (shouldFail && request.prompt.includes(failOnce!)) {
      shouldFail = false;
      await route.fulfill({ status: 504, json: { error: 'fixtureTimeout' } });
      return;
    }
    await route.fulfill({ json: { text: answer(request), inputTokens: 100, outputTokens: 100 } });
  });
  await open(page, '/deliverables?step=asis', { audience });
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
      await expect(page.getByTestId('dlv-batch-progress')).toContainText('16/16', { timeout: 110_000 });
      expect(requests).toHaveLength(16);
      expect(requests.every((request) => request.provider === provider)).toBe(true);
      expect(requests.filter((request) => request.use === 'deliverableDraft')).toHaveLength(10);
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
      await page.goto('/#/step?step=tobe');
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
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('16/16', { timeout: 60_000 });
    await expect(page.getByTestId('dlv-batch-error')).toHaveCount(0);
    expect(requests).toHaveLength(16);
  });

  test('failure keeps completed drafts and retries only unfinished jobs', async ({ page }) => {
    const requests = await setupBatch(page, 'foundry', '[bas-proj:deliverable:tobe]');
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-error')).toContainText('実接続に失敗', { timeout: 30_000 });
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('2/16');
    await expect(page.getByTestId('dlv-batch-fields-asis')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('dlv-batch-fields-tobe')).toHaveAttribute('data-status', 'failed');
    await page.getByTestId('dlv-batch-generate').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('16/16', { timeout: 110_000 });
    expect(requests.filter((request) => request.prompt.includes('[bas-proj:deliverable:asis]'))).toHaveLength(1);
    expect(requests.filter((request) => request.prompt.includes('[bas-proj:deliverable:tobe]'))).toHaveLength(2);
  });

  test('stopping while a job is in flight preserves completed drafts', async ({ page }) => {
    const requests = await setupBatch(page, 'foundry');
    const release = await holdTobe(page);
    await openBatch(page);
    await confirmBatch(page);
    await expect(page.getByTestId('dlv-batch-fields-tobe')).toHaveAttribute('data-status', 'working', { timeout: 30_000 });
    await page.getByTestId('dlv-batch-stop').click();
    release();
    await expect(page.getByTestId('dlv-batch-progress')).toContainText('2/16');
    await expect(page.getByTestId('dlv-batch-fields-tobe')).toHaveAttribute('data-status', 'pending');
    expect(requests).toHaveLength(2);
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
    expect(requests).toHaveLength(2);
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
    await expect.poll(() => requests.length).toBe(1);
    const sent = JSON.stringify(requests[0]);
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
