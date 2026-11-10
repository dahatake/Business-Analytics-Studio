import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JAPANESE, open, setup, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

// The relay (keys, connection, per-use interval) is shared by every test of this preview server, so this file runs in
// order in one worker. The live tests need the preview server started with BAS_RELAY_TEST_OUTBOUND=1 (see below).
test.describe.configure({ mode: 'default' });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FAKE_KEY = 'sk-e2e-FAKE-0123456789-do-not-use';

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function noJapanese(page: Page) {
  const text = await visibleTextExcludingOtherLang(page, 'en');
  expect(text.split('\n').filter((l) => JAPANESE.test(l))).toEqual([]);
}

/** Collects every response body so we can prove the key never comes back from the relay or anywhere else. */
function recordResponses(page: Page): string[] {
  const bodies: string[] = [];
  page.on('response', async (res) => {
    try {
      bodies.push(await res.text());
    } catch {
      // Redirects and aborted requests have no body.
    }
  });
  return bodies;
}

test.describe('AI settings and relay (FR-275, FR-282, FR-168, NFR-SEC-001/005/012)', () => {
  test.describe.configure({ mode: 'serial' });

  test('saves a key through the relay without ever showing or returning it, then deletes it', async ({ page }) => {
    const bodies = recordResponses(page);
    await open(page, '/ai-settings', { lang: 'en' });
    const foundry = page.getByTestId('ai-foundry-key');
    await expect(foundry.getByTestId('ai-foundry-key-state')).toHaveText('Not set');
    await foundry.getByTestId('ai-foundry-key-input').fill(FAKE_KEY);
    await foundry.getByTestId('ai-foundry-key-save').click();
    await expect(foundry.getByTestId('ai-foundry-key-state')).toHaveText('Saved');
    await expect(foundry.getByTestId('ai-foundry-key-change')).toBeVisible();

    const speech = page.getByTestId('ai-speech-key');
    await speech.getByTestId('ai-speech-key-input').fill(`${FAKE_KEY}-speech`);
    await speech.getByTestId('ai-speech-key-save').click();
    await expect(speech.getByTestId('ai-speech-key-state')).toHaveText('Saved');

    await page.reload();
    await expect(page.getByTestId('ai-foundry-key-state')).toHaveText('Saved');
    expect(await page.content()).not.toContain(FAKE_KEY);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(FAKE_KEY);
    const status = await page.evaluate(async () => (await fetch('/relay/status')).text());
    expect(status).not.toContain(FAKE_KEY);
    expect(bodies.join('\n')).not.toContain(FAKE_KEY);
    expect(bodies.some((b) => b.includes('"foundryKey":true'))).toBe(true);

    // Change, then delete.
    await page.getByTestId('ai-foundry-key-change').click();
    await expect(page.getByTestId('ai-foundry-key-input')).toHaveValue('');
    await page.getByRole('button', { name: 'Keep current key' }).click();
    await page.getByTestId('ai-foundry-key-delete').click();
    await expect(page.getByTestId('ai-foundry-key-state')).toHaveText('Not set');
    await page.getByTestId('ai-speech-key-delete').click();
    await expect(page.getByTestId('ai-speech-key-state')).toHaveText('Not set');
    expect(bodies.join('\n')).not.toContain(FAKE_KEY);
  });

  test('the relay refuses writes without its header and every AI send while C-03 is TBD', async ({ page }) => {
    await open(page, '/ai-settings', { lang: 'en' });
    const r = await page.evaluate(async () => {
      const noHeader = await fetch('/relay/secrets/foundryKey', { method: 'DELETE' });
      const getSession = await fetch('/relay/session');
      const { token } = (await (await fetch('/relay/session', { method: 'POST' })).json()) as { token: string };
      const ai = await fetch('/relay/ai', { method: 'POST', headers: { 'X-BAS-Relay': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ use: 'chat' }) });
      const status = await fetch('/relay/status', { headers: { 'X-BAS-Relay': token } });
      return { noHeader: noHeader.status, getSession: getSession.status, ai: ai.status, body: await ai.json(), status: status.status };
    });
    expect(r.noHeader).toBe(403);
    expect(r.getSession).toBe(403); // a same-origin GET carries no Origin, so it is refused (D-5)
    expect(r.status).toBe(200);
    expect(r.ai).toBe(403);
    expect(r.body).toEqual({ allowed: false, reasons: ['c03NotApproved', 'notConfigured'] });
    await expect(page.getByTestId('ai-connection-save')).toBeDisabled();
    await expect(page.getByTestId('ai-connection-test-info')).toContainText('No customer');
  });
});

test.describe('mock answers stay mock (FR-011, FR-132, NFR-LEGAL-002)', () => {
  test('enabling live mode keeps unapproved uses on a labelled mock with the C-03 reason, and shows the D-4 warning', async ({ page }) => {
    await open(page, '/ai-settings', { lang: 'en' });
    const live = page.getByRole('switch', { name: 'Enable the real connection to generative AI' });
    await expect(live).not.toBeChecked();
    await live.check();
    await expect(page.getByTestId('ai-state')).toHaveText('Mock');
    await expect(page.getByTestId('ai-d4-warning')).toBeVisible();
    await expect(page.getByTestId('ai-d4-banner')).toBeVisible();
    await expect(page.locator('[data-testid="ai-c03"] tbody tr')).toHaveCount(16);
    await expect(page.locator('[data-testid="ai-c03"] tbody tr[data-approved="false"]')).toHaveCount(13);
    // D-1 "explain" and, since D-12, "packBuild" (customer pack generation).
    await expect(page.locator('[data-testid="ai-c03"] tbody tr[data-approved="true"]')).toHaveCount(3);
    await expect(page.locator('[data-testid="ai-c03"] tbody tr[data-approved="true"]').first()).toHaveAttribute('data-use', 'explain');
    await expect(page.locator('[data-testid="ai-c03"] tbody tr[data-approved="true"]').last()).toHaveAttribute('data-use', 'packBuild');

    await page.goto('/#/assistant');
    await page.getByTestId('ai-chat-input').fill('lead time');
    await page.getByRole('button', { name: 'Send' }).click();
    // The top hits include a person, so FR-219 asks first.
    const confirm = page.getByTestId('ai-person-confirm');
    await expect(confirm).toContainText('1 "person" items');
    await confirm.getByRole('button', { name: 'Continue' }).click();
    const answer = page.getByTestId('ai-chat-log').getByTestId('ai-mock-label').first();
    await expect(answer).toContainText('Mock');
    await expect(answer.locator('[data-reason="c03NotApproved"]')).toBeVisible();
    await expect(answer.locator('[data-reason="liveDisabled"]')).toHaveCount(0);
    await expect(answer.locator('[data-entity-ref]').first()).toBeVisible();
    await expect(page.getByTestId('ai-chat-foundry')).toContainText('blocked');
  });
});

test.describe('verified Foundry connection settings (D-13)', () => {
  test.skip(process.env.BAS_RELAY_TEST_OUTBOUND !== '1', 'needs the local test provider switch');
  let stub: Server;
  let stubUrl = '';
  let responseStatus = 200;
  let sent: { url: string; body: Record<string, unknown> }[] = [];

  test.beforeAll(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        sent.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
        res.end(responseStatus === 200
          ? JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 30, completion_tokens: 1 } })
          : JSON.stringify({ error: { message: `Never expose ${FAKE_KEY}` } }));
      });
    });
    await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      const { token } = await (await fetch('/relay/session', { method: 'POST' })).json() as { token: string };
      for (const path of ['/relay/connection', '/relay/secrets/foundryKey']) {
        await fetch(path, { method: 'DELETE', headers: { 'X-BAS-Relay': token } });
      }
    });
  });
  test.afterAll(async () => {
    stub.closeAllConnections();
    await new Promise<void>((done) => stub.close(() => done()));
  });

  for (const lang of ['en', 'ja'] as const) {
    test(`${lang}: project guidance, DNS/auth failures, v1 verification, cost and key invalidation`, async ({ page }) => {
      sent = [];
      responseStatus = 401;
      const bodies = recordResponses(page);
      await open(page, '/ai-settings', { lang });
      await page.getByTestId('ai-endpoint').fill('https://resource.services.ai.azure.com/api/projects/project');
      await page.getByTestId('ai-deployment').fill('gpt-deployed');
      await expect(page.getByTestId('ai-connection-validation')).toContainText(lang === 'en' ? 'project URL' : 'プロジェクト用 URL');
      await expect(page.getByTestId('ai-connection-save')).toBeDisabled();
      expect(sent).toHaveLength(0);
      await page.getByTestId('ai-foundry-key-input').fill(FAKE_KEY);
      await page.getByTestId('ai-foundry-key-save').click();
      await expect(page.getByTestId('ai-foundry-key-state')).toHaveText(lang === 'en' ? 'Saved' : '保存済み');
      await page.getByTestId('ai-price-input').fill('1000');
      await page.getByTestId('ai-price-output').fill('4000');
      await page.getByTestId('ai-endpoint').fill('https://missing-foundry-resource.invalid');
      await page.getByTestId('ai-connection-consent').check();
      await page.getByTestId('ai-connection-save').click();
      await expect(page.getByTestId('ai-connection-msg')).toContainText(lang === 'en' ? 'cannot be resolved' : '名前解決できません');
      await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'Not saved' : '未保存');
      await page.waitForTimeout(5100);
      await page.getByTestId('ai-endpoint').fill(`${stubUrl}/openai/v1/`);
      await expect(page.getByTestId('ai-api-version')).toBeDisabled();
      await expect(page.getByTestId('ai-connection-save')).toBeDisabled();
      await page.getByTestId('ai-connection-consent').check();
      await page.getByTestId('ai-connection-save').click();
      await expect(page.getByTestId('ai-connection-msg')).toContainText('HTTP 401');
      await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'Not saved' : '未保存');
      expect(sent).toHaveLength(1);
      responseStatus = 200;
      await page.waitForTimeout(5100);
      await page.getByTestId('ai-connection-consent').check();
      await page.getByTestId('ai-connection-save').click();
      await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'Verified and saved' : '接続確認済み・保存済み');
      await expect(page.getByTestId('ai-connection-verified-at')).toBeVisible();
      expect(sent).toHaveLength(2);
      expect(sent[1]!.url).toBe('/openai/v1/chat/completions');
      expect(sent[1]!.body).toMatchObject({ model: 'gpt-deployed', max_completion_tokens: 256 });
      expect(JSON.stringify(sent[1]!.body)).not.toContain('Contoso');
      const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('bas.ai.ledger') ?? '[]') as { use: string }[]);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.use).toBe('connectionTest');
      await expect(page.getByTestId('ai-usage-month').getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^(?:0|1|0\.\d+)$/);
      await page.getByTestId('ai-connection-consent').check();
      await expect(page.getByTestId('ai-connection-save')).toBeEnabled({ timeout: 7000 });
      await page.reload();
      await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'Verified and saved' : '接続確認済み・保存済み');
      if (lang === 'en') await noJapanese(page);
      expect(await scan(page)).toEqual([]);
      expect(bodies.join('\n')).not.toContain(FAKE_KEY);
      await page.getByTestId('ai-foundry-key-change').click();
      await page.getByTestId('ai-foundry-key-input').fill(`${FAKE_KEY}-changed`);
      await page.getByTestId('ai-foundry-key-save').click();
      await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'unverified' : '接続未確認');
      await expect(page.getByTestId('ai-state')).toHaveText(lang === 'en' ? 'Mock' : 'モック');
    });
  }
});

test.describe('explain current state (FR-274, FR-277)', () => {
  test('opens from the top bar and shows "unavailable" with a deterministic fallback', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.getByTestId('ai-explain-button').click();
    const panel = page.getByTestId('ai-explain-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('ai-explain-status')).toContainText('Unavailable');
    await expect(panel.getByTestId('ai-mock-label')).toContainText('Mock');
    await expect(panel.getByTestId('ai-explain-answer')).toContainText('Long order-to-ship lead time');
    await expect(panel.getByTestId('ai-explain-fallback').locator('[data-entity-ref="issue-lead-time"]')).toBeVisible();
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
  });

  test('asks before using "person" data (FR-219) and sends nothing on cancel', async ({ page }) => {
    await open(page, '/entity/person-ito-mariko', { lang: 'en' });
    await page.getByTestId('ai-explain-button').click();
    const dialog = page.getByTestId('ai-person-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 "person" items');
    expect(await scan(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('ai-explain-panel')).toContainText('Nothing was sent');
  });
});

test.describe('Analyze with Copilot (FR-278〜FR-283)', () => {
  test('edit a proposal, apply it, then undo the apply', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.getByTestId('ai-review-button').click();
    const panel = page.getByTestId('ai-review-panel');
    await expect(panel).toContainText('No connection settings');
    await panel.getByTestId('ai-review-run').click();
    const kpi = panel.getByTestId('ai-proposal-kpi');
    await expect(kpi).toHaveAttribute('data-status', 'proposed');
    await expect(panel.getByTestId('ai-mock-label')).toContainText('Mock');
    await expect(panel).toContainText('ran with the mock');
    await kpi.getByRole('textbox').fill('Edited by the e2e test');
    await expect(kpi).toHaveAttribute('data-status', 'editing');
    await panel.getByTestId('ai-proposal-solution').getByRole('button', { name: 'Discard' }).click();
    await expect(panel.getByTestId('ai-proposal-solution')).toHaveAttribute('data-status', 'discarded');
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);

    await panel.getByTestId('ai-review-apply').click();
    await expect(panel.getByTestId('ai-review-notice')).toContainText('Applied 2 proposals');
    await expect(kpi).toHaveAttribute('data-status', 'applied');
    await expect(panel.getByTestId('ai-applied')).toContainText('Edited by the e2e test');

    // I-2: the screen shows a marker and the diff; the pack values themselves are not replaced.
    await page.getByRole('button', { name: 'Close' }).click();
    const notice = page.getByTestId('ai-applied-notice');
    await expect(notice).toContainText('AI proposals applied (2)');
    await notice.getByText('Show changes').click();
    await expect(notice.locator('[data-component="kpi"]')).toContainText('Edited by the e2e test');
    await expect(notice.locator('[data-component="kpi"] del')).toContainText('None');
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);
    await page.goto('/#/plan');
    await expect(notice).toHaveCount(0);
    await page.goto('/#/');
    await expect(notice).toBeVisible();
    await page.getByTestId('ai-review-button').click();

    await panel.getByTestId('ai-review-undo').click();
    await expect(panel.getByTestId('ai-review-notice')).toContainText('undone');
    await expect(panel.getByTestId('ai-applied')).toHaveCount(0);
    await expect(kpi).toHaveAttribute('data-status', 'editing');
    await expect(kpi.getByRole('textbox')).toHaveValue('Edited by the e2e test');
    await expect(page.getByTestId('ai-applied-notice')).toHaveCount(0);
  });
});

test.describe('assistant (FR-017, FR-284, FR-289, FR-291/292)', () => {
  test('search returns EntityRef links and chat answers are labelled mock', async ({ page }) => {
    await open(page, '/assistant', { lang: 'en' });
    await page.getByTestId('ai-search-input').fill('lead time');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const results = page.getByTestId('ai-search-results');
    await expect(results.locator('a.ref-link[data-entity-ref="kpi-lead-time"]')).toBeVisible();
    await page.getByTestId('ai-chat-input').fill('What slows order to ship?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('ai-chat-log').getByTestId('ai-mock-label')).toContainText('Mock');
    await expect(page.getByTestId('ai-chat-log')).toContainText('last 0 pairs');

    await page.getByTestId('ai-usage-input').fill('We answer customer inquiry emails and read invoice documents.');
    await page.getByTestId('ai-usage-run').click();
    await expect(page.getByTestId('ai-usage-result')).toContainText('inquiries');
    await expect(page.getByTestId('ai-usage-input')).toHaveAttribute('maxlength', '8000');

    await expect(page.getByTestId('ai-import-ai')).toBeDisabled();
    await expect(page.getByTestId('ai-import-reasons')).toContainText('C-03');
  });

  test('story video: unpriced → blocked, above 1000 JPY → blocked, cheap → created as mock', async ({ page }) => {
    await open(page, '/assistant', { lang: 'en' });
    const story = page.getByTestId('ai-story');
    await expect(story.getByTestId('ai-story-estimate')).toContainText('Unit prices are not entered');
    await expect(story.getByTestId('ai-story-generate')).toBeDisabled();

    await page.goto('/#/ai-settings');
    await page.getByTestId('ai-price-input').fill('40000');
    await page.getByTestId('ai-price-output').fill('400000');
    await page.goto('/#/assistant');
    await expect(story.getByTestId('ai-story-overcap')).toBeVisible();
    await expect(story.getByTestId('ai-story-generate')).toBeDisabled();

    await page.goto('/#/ai-settings');
    await page.getByTestId('ai-price-input').fill('1');
    await page.getByTestId('ai-price-output').fill('1');
    await page.goto('/#/assistant');
    await expect(story.getByTestId('ai-story-overcap')).toHaveCount(0);
    await story.getByTestId('ai-story-generate').click();
    await expect(story.getByTestId('ai-story-state')).toHaveText('Latest');
    await expect(story.getByTestId('ai-mock-label')).toContainText('Mock');
    await expect(story.getByTestId('ai-story-player').locator('li').first()).toBeVisible();
    await noJapanese(page);
  });
});

test.describe('AI screens accessibility (axe, WCAG 2.2 AA) and language', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const route of ['/assistant', '/ai-settings']) {
      test(`${lang} ${route}`, async ({ page }) => {
        // D-6: a legacy Foundry record makes /ai-settings show the "move" candidate, which is scanned too.
        await page.addInitScript(() => localStorage.setItem('bas.foundry.settings', JSON.stringify({ endpoint: 'https://legacy.example.com', deployment: 'old', authMethod: 'apiKey' })));
        await open(page, route, { lang });
        if (route === '/ai-settings') await expect(page.getByTestId('ai-legacy')).toBeVisible();
        await page.waitForTimeout(500);
        expect(await scan(page)).toEqual([]);
        if (lang === 'en') await noJapanese(page);
      });
    }

    test(`${lang} with the explain and review panels open`, async ({ page }) => {
      await open(page, '/plan', { lang });
      await page.getByTestId('ai-explain-button').click();
      await expect(page.getByTestId('ai-explain-panel').getByTestId('ai-mock-label')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') await noJapanese(page);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('ai-explain-panel')).toBeHidden();
      await page.getByTestId('ai-review-button').click();
      await page.getByTestId('ai-review-run').click();
      await expect(page.getByTestId('ai-proposal-initiative')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') await noJapanese(page);
    });
  }
});

test.describe('legacy Foundry settings (D-6, P-01)', () => {
  test('are shown as a candidate, copied only on request, and live stays off', async ({ page }) => {
    const legacy = { endpoint: 'https://legacy.example.com', deployment: 'old', authMethod: 'apiKey' };
    await page.addInitScript((v) => localStorage.setItem('bas.foundry.settings', v), JSON.stringify(legacy));
    const outbound: string[] = [];
    page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1')) outbound.push(r.url()); });
    await open(page, '/ai-settings', { lang: 'en' });
    const panel = page.getByTestId('ai-legacy');
    await expect(panel.locator('[data-state="legacyOnly"]')).toBeVisible();
    await expect(page.getByTestId('ai-endpoint')).toHaveValue('');
    await panel.getByTestId('ai-legacy-move').click();
    await expect(page.getByTestId('ai-endpoint')).toHaveValue(legacy.endpoint);
    await expect(page.getByTestId('ai-legacy-moved')).toBeVisible();
    await expect(page.getByTestId('ai-live-switch')).not.toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem('bas.foundry.settings'))).toBe(JSON.stringify(legacy));
    await page.getByTestId('ai-endpoint').fill('https://common.example.com');
    await expect(panel.getByTestId('ai-legacy-diff')).toContainText('Endpoint');
    expect(outbound).toEqual([]);
  });
});

test.describe('usage ledger retention (D-3, D-7)', () => {
  test('one budget input; old records are counted and deleted only after confirmation', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('bas.e2e.ledger')) return;
      sessionStorage.setItem('bas.e2e.ledger', '1');
      localStorage.setItem('bas.ai.ledger', JSON.stringify([
        { at: '2020-01-01T00:00:00Z', use: 'explain', inputTokens: 1, outputTokens: 1, costJpy: 1 },
        { at: new Date().toISOString(), use: 'explain', inputTokens: 1, outputTokens: 1, costJpy: 1 },
      ]));
    });
    await open(page, '/ai-settings', { lang: 'en' });
    await expect(page.getByTestId('ai-review-budget-input')).toHaveCount(0);
    await expect(page.getByTestId('ai-budget-input')).toHaveValue('100000');
    await expect(page.getByTestId('ai-usage-no-content')).toBeVisible();
    await expect(page.getByTestId('ai-ledger-expired')).toContainText('older than 13 months: 1');
    await page.getByTestId('ai-ledger-prune-button').click();
    const dialog = page.getByTestId('ai-ledger-prune-confirm');
    await expect(dialog).toContainText('1 usage records');
    expect(await scan(page)).toEqual([]);
    await dialog.getByTestId('ai-ledger-prune-ok').click();
    await expect(page.getByTestId('ai-ledger-expired')).toContainText('older than 13 months: 0');
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('bas.ai.ledger') ?? '[]')) as unknown[]).toHaveLength(1);
  });
});

/*
 * Live path for "explain" (D-1) against a local stub provider. The preview server must allow http://127.0.0.1:<port> as
 * the provider endpoint, which only BAS_RELAY_TEST_OUTBOUND=1 does (docs/relay-config.md). Run with:
 *   $env:BAS_PORT=4188; $env:BAS_OUT='dist-ai'; $env:BAS_RELAY_TEST_OUTBOUND='1'; npx playwright test e2e/ai --project=desktop
 * Without the variable these tests are skipped.
 */
test.describe('live "explain" through the relay (D-1, D-2, D-3, D-4)', () => {
  test.skip(process.env.BAS_RELAY_TEST_OUTBOUND !== '1', 'needs BAS_RELAY_TEST_OUTBOUND=1 for the preview server');

  let stub: Server;
  let stubUrl = '';
  const received: { url: string; apiKey: string | undefined; body: string }[] = [];

  test.beforeAll(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', apiKey: req.headers['api-key'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'Stub live explanation of the screen.' } }], usage: { prompt_tokens: 2000, completion_tokens: 300 } }));
      });
    });
    await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  test.afterAll(async ({ browser }) => {
    // Leave the relay as other tests expect it: no key, no connection.
    const page = await browser.newPage();
    await page.goto('/');
    await page.evaluate(async () => {
      const { token } = (await (await fetch('/relay/session', { method: 'POST' })).json()) as { token: string };
      await fetch('/relay/secrets/foundryKey', { method: 'DELETE', headers: { 'X-BAS-Relay': token } });
      await fetch('/relay/connection', { method: 'DELETE', headers: { 'X-BAS-Relay': token } });
    });
    await page.close();
    stub.closeAllConnections();
    await new Promise<void>((done) => stub.close(() => done()));
  });

  async function configure(page: Page, lang: Lang) {
    await open(page, '/ai-settings', { lang });
    await page.getByTestId('ai-endpoint').fill(stubUrl);
    await page.getByTestId('ai-deployment').fill('gpt-e2e');
    const saved = lang === 'en' ? 'Saved' : '保存済み';
    // The key-protection badge leaves "unknown" once GET /relay/status has answered, so the key state is settled.
    await expect(page.getByTestId('ai-key-protection')).not.toContainText(lang === 'en' ? 'Unknown' : '不明');
    if ((await page.getByTestId('ai-foundry-key-state').textContent()) !== saved) {
      await page.getByTestId('ai-foundry-key-input').fill(FAKE_KEY);
      await page.getByTestId('ai-foundry-key-save').click();
    }
    await expect(page.getByTestId('ai-foundry-key-state')).toHaveText(saved);
    await page.getByTestId('ai-price-input').fill('1000');
    await page.getByTestId('ai-price-output').fill('4000');
    await page.getByTestId('ai-connection-consent').check();
    await page.getByTestId('ai-connection-save').click();
    await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'Verified and saved' : '接続確認済み・保存済み');
    received.length = 0;
    await page.getByTestId('ai-live-switch').check();
  }

  test('confirm → one request with internal data, "Live" answer, cost recorded; a 1 JPY budget then stops sending', async ({ page }) => {
    await configure(page, 'en');
    await expect(page.getByTestId('ai-state')).toHaveText('Live (approved uses only)');
    await expect(page.getByTestId('ai-configured')).toContainText('Saved');
    await expect(page.getByTestId('ai-key-protection')).toContainText(process.platform === 'win32' ? 'DPAPI' : 'Key file');
    await expect(page.getByTestId('ai-d4-warning')).toBeVisible();
    await expect(page.getByTestId('ai-d4-banner')).toBeVisible();
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);

    await page.goto('/#/');
    await page.getByTestId('ai-explain-button').click();
    const dialog = page.getByTestId('ai-live-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('ai-live-internal')).not.toContainText(': 0');
    await expect(dialog.getByTestId('ai-live-cost')).toContainText('¥');
    await expect(dialog.getByTestId('ai-d4-warning')).toBeVisible();
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);
    expect(received).toHaveLength(0);
    await dialog.getByTestId('ai-live-send').click();

    const panel = page.getByTestId('ai-explain-panel');
    await expect(panel.getByTestId('ai-live-label')).toContainText('Live');
    await expect(panel.getByTestId('ai-explain-answer')).toHaveText('Stub live explanation of the screen.');
    await expect(panel.getByTestId('ai-explain-status')).toContainText('Available');
    await expect(panel.getByTestId('ai-explain-mode')).toHaveText('Live');
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/openai/deployments/gpt-e2e/chat/completions?api-version=2024-10-21');
    expect(received[0]!.apiKey).toBe(FAKE_KEY);
    expect(received[0]!.body).toContain('Transferring expert skills'); // internal entity (D-2)
    expect((JSON.parse(received[0]!.body) as { max_completion_tokens: number }).max_completion_tokens).toBeLessThanOrEqual(1500);
    const ledger = JSON.parse(await page.evaluate(() => localStorage.getItem('bas.ai.ledger') ?? '[]')) as { costJpy: number; use: string }[];
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.use).toBe('connectionTest');
    expect(ledger[1]!.use).toBe('explain');
    expect(ledger[1]!.costJpy).toBeCloseTo((2000 * 1000 + 300 * 4000) / 1_000_000);
    expect(JSON.stringify(ledger)).not.toContain('Stub live');
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();

    // D-3: with a 1 JPY budget the next request never reaches the provider.
    await page.goto('/#/ai-settings');
    await page.getByTestId('ai-budget-input').fill('1');
    await page.goto('/#/');
    await page.getByTestId('ai-explain-button').click();
    await expect(panel.getByTestId('ai-mock-label').locator('[data-reason="budget"]')).toBeVisible();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    expect(received).toHaveLength(1);
  });

  test('ja: the send confirmation passes axe and cancelling sends nothing', async ({ page }) => {
    await configure(page, 'ja');
    expect(await scan(page)).toEqual([]);
    await page.goto('/#/');
    await page.getByTestId('ai-explain-button').click();
    const dialog = page.getByTestId('ai-live-confirm');
    await expect(dialog.getByTestId('ai-d4-warning')).toBeVisible();
    expect(await scan(page)).toEqual([]);
    const before = received.length;
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByTestId('ai-explain-panel')).toContainText('送信していません');
    expect(received.length).toBe(before);
  });
});

/** Launch screen with one registered company and project (FR-311 live test). */
async function seedLaunch(page: Page, lang: Lang) {
  await setup(page, { skipLaunch: false, lang });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('bas.e2e.gen')) return;
    sessionStorage.setItem('bas.e2e.gen', '1');
    const createdAt = '2026-11-10T00:00:00.000Z';
    localStorage.setItem('bas.projects', JSON.stringify({
      version: 1,
      state: {
        companies: [{ id: 'co-c', name: 'Contoso', createdAt }],
        projects: [{ id: 'pj-c', companyId: 'co-c', name: 'Delivery', createdAt, step: 'define' }],
        target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define',
      },
    }));
  });
  await page.goto('/');
  await expect(page.getByTestId('launch-screen')).toBeVisible();
}

/* FR-311 (D-12): customer pack generation on the launch screen against a local stub provider (same server flag as above). */test.describe('live generation through the relay (D-12)', () => {
  test.skip(process.env.BAS_RELAY_TEST_OUTBOUND !== '1', 'needs BAS_RELAY_TEST_OUTBOUND=1 for the preview server');

  let stub: Server;
  let stubUrl = '';
  const received: { body: Record<string, unknown>; user: string }[] = [];
  const lt = (s: string) => ({ ja: s, en: s });
  const ent = (id: string, kind: string, world: string, type: string, extra: Record<string, unknown>) => ({
    id, kind, name: lt(id), description: lt(`${id} description`), world, type, classification: 'internal', author: 'ai', sourceIds: ['source-doc-1'], ...extra,
  });
  const stageA = {
    packId: 'contoso-delivery', company: { name: { ja: 'コントソ', en: 'Contoso Manufacturing' }, industry: lt('Manufacturing') }, isSample: false,
    regions: [{ id: 'region-kanto', name: lt('Kanto') }],
    entities: [
      ent('site-tokyo', 'site', 'real', 'site', { role: 'hq', lat: 35.68, lon: 139.76, capacityTPerMonth: 0 }),
      ent('product-gear', 'product', 'real', 'thing', { category: lt('Parts'), siteId: 'site-tokyo', unitPriceJpy: 12000 }),
      ent('person-lead', 'person', 'real', 'person', { role: lt('Logistics lead'), siteId: 'site-tokyo' }),
    ],
  };
  const stageB = {
    entities: [
      ent('kpi-otd', 'kpi', 'digital', 'metric', { unit: lt('%'), baseline: 92, current: 94, target: 98, direction: 'increase', scale: 'ratio', period: lt('FY2026'), ownerId: 'person-lead' }),
      ent('cause-plan', 'cause', 'real', 'event', {}),
      ent('issue-late', 'issue', 'real', 'event', { impact: 4, feasibility: 3, causeIds: ['cause-plan'], kpiIds: ['kpi-otd'] }),
      // Points to a solution that does not exist: the check must catch it and the fix round removes it.
      ent('initiative-x', 'initiative', 'real', 'operation', { solutionId: 'solution-none', start: '2026-12-01', end: '2027-03-31', progress: 0, dependsOn: [], ownerId: 'person-lead' }),
    ],
    gaps: [{ section: 'deal', missing: ['order ledger'], nextAction: 'Attach the order ledger' }],
  };

  test.beforeAll(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] };
        const user = body.messages[1]!.content;
        received.push({ body, user });
        const answer = user.startsWith('Build the foundation') ? stageA : user.startsWith('Build the business part') ? stageB : { remove: ['initiative-x'] };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 6000, completion_tokens: 2500 } }));
      });
    });
    await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await page.evaluate(async () => {
      const { token } = (await (await fetch('/relay/session', { method: 'POST' })).json()) as { token: string };
      await fetch('/relay/secrets/foundryKey', { method: 'DELETE', headers: { 'X-BAS-Relay': token } });
      await fetch('/relay/connection', { method: 'DELETE', headers: { 'X-BAS-Relay': token } });
    });
    await page.close();
    stub.closeAllConnections();
    await new Promise<void>((done) => stub.close(() => done()));
  });

  test('configure on the launch screen → generate → progress → verified pack saved with its record → open it', async ({ page }) => {
    await seedLaunch(page, 'en');
    await page.getByTestId('launch-ai-settings').click();
    const settings = page.getByTestId('ai-settings-dialog');
    await settings.getByTestId('ai-endpoint').fill(stubUrl);
    await settings.getByTestId('ai-deployment').fill('gpt-e2e');
    await expect(settings.getByTestId('ai-key-protection')).not.toContainText('Unknown');
    if ((await settings.getByTestId('ai-foundry-key-state').textContent()) !== 'Saved') {
      await settings.getByTestId('ai-foundry-key-input').fill(FAKE_KEY);
      await settings.getByTestId('ai-foundry-key-save').click();
    }
    await expect(settings.getByTestId('ai-foundry-key-state')).toHaveText('Saved');
    await settings.getByTestId('ai-price-input').fill('400');
    await settings.getByTestId('ai-price-output').fill('1600');
    await settings.getByTestId('ai-connection-consent').check();
    await settings.getByTestId('ai-connection-save').click();
    await expect(settings.getByTestId('ai-relay-connection')).toContainText('Verified and saved');
    received.length = 0;
    await settings.getByTestId('ai-live-switch').check();
    await expect(settings.getByTestId('ai-state')).toHaveText('Live (approved uses only)');
    await settings.getByTestId('ai-settings-dialog-close').click();

    await page.getByTestId('launch-generate-pj-c').click();
    const dialog = page.getByTestId('gen-dialog');
    await dialog.getByTestId('gen-purpose').fill('Reduce late deliveries');
    await dialog.getByTestId('gen-news').uncheck(); // no internet in the test
    await dialog.getByTestId('gen-files').setInputFiles({ name: 'delivery-kpi.csv', mimeType: 'text/csv', buffer: Buffer.from('kpi,baseline,current,target\non-time delivery %,92,94,98\ngear unit price JPY,12000,,\n') });
    await expect(dialog.getByTestId('gen-file-list')).toContainText('delivery-kpi.csv');
    await expect(dialog.getByTestId('gen-estimate')).toContainText('¥');
    await expect(dialog.getByTestId('gen-start')).toBeDisabled();
    await dialog.getByTestId('gen-check-approved').check();
    await dialog.getByTestId('gen-check-cost').check();
    expect(await scan(page)).toEqual([]);
    await dialog.getByTestId('gen-start').click();

    await expect(dialog.getByTestId('gen-saved')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('gen-progress')).toHaveCount(0);
    await expect(dialog.getByTestId('gen-checks')).toHaveText('1 fix rounds, 0 items removed, 0 invented sources discarded');
    await expect(dialog.getByTestId('gen-cost')).toContainText('(3 sends)');
    await expect(dialog.getByTestId('gen-ungrounded')).toHaveCount(0);
    expect(await scan(page)).toEqual([]);

    // What went out: JSON mode, the attached file's text, the app-made source id; stage B saw the foundation ids.
    expect(received).toHaveLength(3);
    expect(received[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(received[0]!.user).toContain('on-time delivery %,92,94,98');
    expect(received[0]!.user).toContain('source-doc-1');
    expect(received[1]!.user).toContain('site-tokyo');
    expect(received[2]!.user).toContain('initiative-x');
    expect(received.map((r) => JSON.stringify(r.body)).join('')).not.toContain(FAKE_KEY);

    const stored = await page.evaluate(() => ({
      index: JSON.parse(localStorage.getItem('bas.packs.index') ?? '{}') as Record<string, { files: string[]; entities: number }>,
      ledger: JSON.parse(localStorage.getItem('bas.ai.ledger') ?? '[]') as { use: string; costJpy: number }[],
    }));
    expect(stored.index['pj-c']).toMatchObject({ files: ['generated:foundry', 'delivery-kpi.csv'] });
    expect(stored.ledger.filter((r) => r.use === 'packBuild')).toHaveLength(3);
    expect(stored.ledger.every((r) => r.costJpy > 0)).toBe(true);

    await dialog.getByTestId('gen-open').click();
    await expect(page.locator('main#main')).toBeVisible();
    await page.goto('/#/data');
    await expect(page.locator('main#main')).toContainText('Contoso Manufacturing');

    // A generated pack is sparser than the sample (no customers, deals or invoices here): every screen must still render.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
    for (const route of ['/', '/home', '/analysis', '/assistant', '/board', '/brand', '/catalog', '/deliverables', '/directory', '/discussion', '/flows',
      '/graph', '/integrations', '/map', '/optimize', '/plan', '/projects', '/relations', '/settings', '/show', '/twin3d', '/usecases', '/workspace', '/ai-settings']) {
      await page.goto(`/#${route}`);
      await expect(page.locator('main#main'), route).toBeVisible();
      await page.waitForTimeout(300);
    }
    expect(errors).toEqual([]);
  });
});
