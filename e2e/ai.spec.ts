import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

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
    await page.getByTestId('ai-relay-check').click();
    await expect(page.locator('[data-reason="c03NotApproved"]').first()).toBeVisible();
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
    await expect(page.locator('[data-testid="ai-c03"] tbody tr')).toHaveCount(15);
    await expect(page.locator('[data-testid="ai-c03"] tbody tr[data-approved="false"]')).toHaveCount(14);
    await expect(page.locator('[data-testid="ai-c03"] tbody tr[data-approved="true"]')).toHaveAttribute('data-use', 'explain');

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
    await page.getByTestId('ai-connection-save').click();
    await expect(page.getByTestId('ai-connection-msg')).toBeVisible();
    await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'Saved' : '保存済み');
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
    await page.getByTestId('ai-live-switch').check();
  }

  test('confirm → one request with internal data, "Live" answer, cost recorded; a 1 JPY budget then stops sending', async ({ page }) => {
    await configure(page, 'en');
    await expect(page.getByTestId('ai-state')).toHaveText('Live ("Explain current state" only)');
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
    expect((JSON.parse(received[0]!.body) as { max_tokens: number }).max_tokens).toBeLessThanOrEqual(1500);
    const ledger = JSON.parse(await page.evaluate(() => localStorage.getItem('bas.ai.ledger') ?? '[]')) as { costJpy: number; use: string }[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.use).toBe('explain');
    expect(ledger[0]!.costJpy).toBeCloseTo((2000 * 1000 + 300 * 4000) / 1_000_000);
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


