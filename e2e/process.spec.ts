import { expect, test } from '@playwright/test';
import { deviceSnapshot, open, scan, seedDeviceData } from './helpers.ts';
import { workflowAnswer } from '../tests/fixtures/workflow.ts';

test.describe('FR-380 business process', () => {
  test('completes missing process data, persists settings, and derives measured and estimated allocation from internal records', async ({ page }) => {
    await page.route('**/relay/status', (route) => route.fulfill({ json: {
      secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
      connectionVerifiedAt: '2026-01-01T00:00:00Z', workiq: { method: 'cli', signedIn: true, verifiedAt: '2026-01-01T00:00:00Z' },
    } }));
    const records = [
      { id: 'actual-1', kind: 'worklog', category: '案件A', description: '確認できた作業記録', start: '2026-10-05T09:00:00Z', end: '2026-10-05T10:00:00Z', ref: 'wiq:topic-1', quote: 'actual-1 2026-10-05T09:00:00Z 2026-10-05T10:00:00Z actual work' },
      { id: 'calendar-1', kind: 'calendar', category: '案件B', description: '予定時間', start: '2026-10-06T09:00:00Z', end: '2026-10-06T09:30:00Z', ref: 'wiq:topic-1', quote: 'calendar-1 2026-10-06T09:00:00Z 2026-10-06T09:30:00Z scheduled' },
      ...['案件C', '案件D', '案件E'].map((category, i) => ({
        id: `email-${i}`, kind: 'email', category, description: 'メールの推計', start: '2026-10-07T09:00:00Z', ref: 'wiq:topic-1', quote: `email-${i} 2026-10-07T09:00:00Z email`,
      })),
    ];
    const questions: { topics?: string[] }[] = [];
    let empty = false;
    await page.route('**/relay/workiq/ask', (route) => {
      const q = route.request().postDataJSON() as { topics?: string[] };
      questions.push(q);
      return route.fulfill({ json: { sections: [{ key: q.topics?.length ? 'topic-1' : 'process', question: '社内記録', answer: empty ? '未取得' : records.map((r) => r.quote).join('\n'), citations: [], sensitivity: null, fetchedAt: '2026-11-01T00:00:00Z' }] } });
    });
    await page.route('**/relay/ai', (route) => {
      const prompt = String(route.request().postDataJSON().prompt);
      return route.fulfill({ json: { text: JSON.stringify(prompt.startsWith('[bas-proj:workflowDraft]') ? workflowAnswer(prompt) : { records: empty ? [] : records, warnings: [] }), inputTokens: 100, outputTokens: 100 } });
    });
    await open(page, '/process');
    await seedDeviceData(page, {
      'bas.projects': JSON.stringify({ state: {
        companies: [{ id: 'company-process', name: 'テスト会社', createdAt: '2026-10-01' }],
        projects: [{ id: 'project-process', companyId: 'company-process', name: '業務改善', step: 'asis', createdAt: '2026-10-01', brief: { purpose: '作業時間を把握する' } }],
        target: { kind: 'project', projectId: 'project-process' }, relations: [], mergeDismissals: [], lastProjectId: 'project-process', demoStep: 'asis',
      }, version: 1 }),
      'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }),
      'bas.scope.project-process.process.workflow': JSON.stringify({ basePackId: 'sample', at: '2026-10-01', workflow: { stages: [{ id: 'edited', name: '人が編集した受付', asIs: { touchMinutes: 0 } }] } }),
    });
    await page.reload();
    await page.getByTestId('bp-ai-draft').click();
    await expect(page.getByTestId('bp-draft-note')).toContainText('仮説');
    await expect(page.getByTestId('bp-numeric-status')).toContainText('概算ドラフト');
    let saved = JSON.parse((await deviceSnapshot(page)).records['bas.scope.project-process.process.workflow']!.value!);
    expect(saved.workflow.stages[0]).toMatchObject({ id: 'edited', name: '人が編集した受付', asIs: { touchMinutes: 0, waitHours: 4, volumePerMonth: 20 } });
    await page.goto('/#/settings');
    await expect(page.getByTestId('bp-settings-period')).toHaveValue('month');
    await page.getByTestId('bp-settings-worker').fill('対象作業者（テスト）');
    await page.getByTestId('bp-settings-period').selectOption('custom');
    await page.getByTestId('bp-settings-start').fill('2026-10-01');
    await page.getByTestId('bp-settings-end').fill('2026-10-31');
    await page.reload();
    await expect(page.getByTestId('bp-settings-worker')).toHaveValue('対象作業者（テスト）');
    await expect(page.getByTestId('bp-settings-start')).toHaveValue('2026-10-01');
    await page.goto('/#/process');
    await page.getByTestId('bp-measure').click();
    await expect(page.getByTestId('bp-measure-confirm')).toBeVisible();
    expect(questions.filter((q) => q.topics?.length)).toHaveLength(0);
    await page.getByTestId('bp-measure-confirm').click();
    const result = page.getByTestId('bp-measurement');
    await expect(result).toContainText('案件E');
    await expect(result).toContainText('60 分');
    await expect(result).toContainText('記録からの推計');
    expect(questions.at(-1)?.topics?.[0]).toContain('対象作業者（テスト）');
    expect(questions.at(-1)?.topics?.[0]).toContain('1件=2分');
    saved = JSON.parse((await deviceSnapshot(page)).records['bas.scope.project-process.process.workflow']!.value!);
    expect(saved.workflow.measurement.categories).toHaveLength(5);
    expect(saved.workflow.measurement.coverage).toBe('partial');
    expect(saved.workflow.stages[0].asIs.touchMinutes).toBe(0);
    await page.reload();
    await expect(result).toContainText('案件E');
    empty = true;
    await page.getByTestId('bp-measure').click();
    await page.getByTestId('bp-measure-confirm').click();
    await expect(page.getByTestId('bp-ai-error')).toContainText('原記録');
    await expect(result).toContainText('案件E');
  });

  test('does not expose internal acquisition controls to an external audience', async ({ page }) => {
    await open(page, '/process', { audience: 'external' });
    await expect(page.getByTestId('bp-ai')).toHaveCount(0);
    await expect(page.getByTestId('bp-measurement')).toHaveCount(0);
  });

  test('the rail offers the business process and no relation graph or Twin', async ({ page }) => {
    await open(page, '/home');
    const rail = page.locator('.rail');
    await expect(rail.locator('a[href="#/process"]')).toContainText('業務プロセス');
    await expect(rail.locator('a[href="#/relations"], a[href="#/graph"], a[href="#/twin3d"]')).toHaveCount(0);
  });

  test('zooms from the bird\'s-eye phases to steps and details, with outside parties apart from the company', async ({ page }) => {
    await open(page, '/process', { lang: 'en' });
    const map = page.getByTestId('bp-map');
    await expect(map).toHaveAttribute('data-level', 'overview');
    await expect(map.locator('button[data-testid^="bp-phase-"]')).toHaveCount(5);
    await expect(page.getByTestId('bp-phase-phase-order-external')).toContainText('Outside');
    await expect(page.getByTestId('bp-phase-phase-order')).toContainText('Company');
    await expect(page.getByTestId('bp-lane-party-customer')).toContainText('Outside');
    await expect(page.getByTestId('bp-lane-party-sales')).toContainText('Company');

    await page.getByTestId('bp-phase-phase-plan').click();
    await expect(map).toHaveAttribute('data-level', 'steps');
    await expect(page).toHaveURL(/level=steps/);
    await page.getByTestId('bp-level-detail').click();
    await expect(page.getByTestId('bp-step-st-plan')).toContainText('First pass');

    // Keyboard alternative to the wheel: + and - on the focused map.
    await page.getByTestId('bp-level-steps').click();
    await page.getByTestId('bp-canvas').focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await expect(map).toHaveAttribute('data-level', 'detail');
    await page.keyboard.press('0');
    await expect(map).toHaveAttribute('data-level', 'overview');
  });

  test('hover and focus show the same summary card; Escape closes it', async ({ page }) => {
    await open(page, '/process?level=steps', { lang: 'en' });
    const step = page.getByTestId('bp-step-st-stock-check');
    // Focus pans a step hidden outside the canvas into view (WCAG 2.4.11), then the pointer can reach it.
    await step.focus();
    const card = page.getByTestId('bp-hovercard');
    await expect(card).toContainText('Check stock and free capacity');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await step.hover();
    await expect(card).toContainText('Hidden small workflows');
    await expect(card).toContainText('Excel');
    await page.mouse.move(2, 2);
    await expect(card).toHaveCount(0);
    await page.getByTestId('bp-step-st-plan').focus();
    await expect(card).toContainText('Inputs');
    await expect(page.getByTestId('bp-step-st-plan')).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  });

  test('to-be removes, combines and adds steps on the same map, and the totals compare both states', async ({ page }) => {
    await open(page, '/process?state=toBe&level=steps', { lang: 'en' });
    await expect(page.getByTestId('bp-step-st-order-confirm')).toHaveClass(/is-gone/);
    await expect(page.getByTestId('bp-step-st-stock-check')).toContainText('Combined into');
    await expect(page.getByTestId('bp-step-st-notify')).toContainText('New');
    // The removed check no longer sits between order entry and planning.
    await expect(page.getByTestId('bp-edge-st-order-entry-st-plan')).toHaveCount(1);
    await expect(page.getByTestId('bp-loop-loop-replan-daily')).toContainText('daily');
    await expect(page.getByTestId('bp-loop-loop-replan-weekly')).toHaveCount(0);

    await page.getByTestId('bp-state-asIs').click();
    await expect(page.getByTestId('bp-step-st-notify')).toHaveCount(0);
    await expect(page.getByTestId('bp-loop-loop-replan-weekly')).toContainText('weekly');

    await expect(page.getByTestId('bp-tile-lead')).toContainText('→');
    await expect(page.getByTestId('bp-tile-effort')).toContainText('FTE');
    await expect(page.getByTestId('bp-reconcile-kpi-lead-time-asIs')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('bp-reconcile-kpi-lead-time-toBe')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('bp-io-st-plan')).toContainText('Excel');
  });

  test('a step edited in step 2 is saved with the project, and the summary goes into the deliverable', async ({ page }) => {
    await open(page, '/process?state=toBe&level=steps&sel=st-ship', { lang: 'en' });
    await page.getByTestId('bp-edit-step').click();
    await page.getByTestId('bp-ed-change').selectOption('remove');
    await page.getByTestId('bp-ed-save').click();
    await expect(page.getByTestId('bp-origin-edited')).toBeVisible();
    await expect(page.getByTestId('bp-step-st-ship')).toHaveClass(/is-gone/);

    await page.getByTestId('bp-write-summary').click();
    await expect(page.getByTestId('bp-written')).toBeVisible();
    await page.getByTestId('bp-written').getByRole('link').click();
    await expect(page).toHaveURL(/#\/deliverables\?.*step=tobe/);
    await expect(page.locator('#dlv-field-toBeProcess, [id="dlv-field-toBeProcess"]').first()).toContainText('Remove');

    await page.goto('/#/process');
    await expect(page.getByTestId('bp-origin-edited')).toBeVisible();
    await page.getByTestId('bp-reset').click();
    await expect(page.getByTestId('bp-origin-edited')).toHaveCount(0);
  });

  test('the step editor is as wide as the other data-entry dialogs and never scrolls sideways', async ({ page }) => {
    await open(page, '/process?state=toBe&level=steps&sel=st-ship', { lang: 'ja' });
    for (const width of [1600, 1280, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId('bp-edit-step').click();
      const editor = page.getByTestId('bp-editor');
      await expect(editor).toBeVisible();
      const box = (await editor.boundingBox())!;
      expect(box.width).toBeGreaterThan(width > 1000 ? width * 0.79 : width - 40);
      expect(box.width).toBeLessThanOrEqual(width > 1000 ? width * 0.8 + 1 : width - 31);
      const overflow = await editor.locator('.bp-ed-content').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(await scan(page, '[data-testid="bp-editor"]')).toEqual([]);
      await editor.getByRole('button', { name: 'キャンセル', exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
  });

  for (const lang of ['ja', 'en'] as const) {
    test(`passes accessibility checks in every state (${lang})`, async ({ page }) => {
      for (const route of ['/process', '/process?state=toBe&level=steps', '/process?state=compare&level=detail&sel=st-plan', '/process?tab=table']) {
        await open(page, route, { lang });
        await expect(page.locator('main#main')).toBeVisible();
        expect(await scan(page, 'main')).toEqual([]);
      }
    });
  }
});
