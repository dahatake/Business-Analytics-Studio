import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JAPANESE, deviceSnapshot, open, openAiSettings, seedDeviceData, setup, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

// The relay (keys, connection, per-use interval) is shared by every test of this preview server, so this file runs in
// order in one worker. The live tests need the preview server started with BAS_RELAY_TEST_OUTBOUND=1 (see below).
test.describe.configure({ mode: 'default' });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FAKE_KEY = 'sk-e2e-FAKE-0123456789-do-not-use';

test.describe('Strategic overview optimization', () => {
  test.describe.configure({ mode: 'serial' });
  for (const provider of ['foundry', 'copilotSdk'] as const) {
    test(`${provider}: real transport draft is not applied until approval, then survives reload`, async ({ page }) => {
      let calls = 0;
      let kpiData: { kpis: { current: number }[]; okrs: unknown[] } | null = null;
      await page.route('**/relay/status', (route) => route.fulfill({ json: {
        secrets: { foundryKey: true },
        connection: { endpoint: 'https://example.openai.azure.com', deployment: 'test', apiVersion: '2025-04-01-preview' },
        connectionVerifiedAt: '2026-11-16T00:00:00Z', keyProtection: null, copilot: { model: 'gpt-5' }, workiq: null,
      } }));
      await page.route('**/relay/ai', async (route) => {
        const request = route.request().postDataJSON();
        expect(request.use).toBe('strategyOverview');
        expect(request.provider).toBe(provider);
        expect(request.context).toBe('');
        expect(request.prompt).not.toContain('"kind":"person"');
        calls++;
        const raw = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
        kpiData = raw.kpiOkr;
        const issue = raw.items.find((e: { kind: string }) => e.kind === 'issue');
        await route.fulfill({ json: { text: JSON.stringify({
          answer: 'Validate the operational bottleneck before investing.',
          findings: [{ text: 'The intervention must serve a measured outcome.', refs: [issue.id] }],
          actions: [{ text: 'Confirm the cause with source evidence.', refs: [issue.id] }],
          caveats: ['Causal impact remains a hypothesis.'],
          axis: 'impact', axisReason: 'Use recorded business impact.',
          objectiveIssues: [], patches: [{
            id: issue.id, description: { ja: '運用ボトルネックの仮説を検証する。', en: 'Validate the operational bottleneck hypothesis.' },
            impact: 5, reason: 'Prioritize the source-linked bottleneck.', refs: [issue.id],
          }],
        }), inputTokens: 500, outputTokens: 300 } });
      });
      await openAiSettings(page, { lang: 'en' });
      await page.getByTestId(provider === 'foundry' ? 'ai-provider-foundry' : 'ai-provider-copilot').check();
      await page.getByTestId('ai-send-consent').check();
      await page.getByTestId('ai-live-switch').check();
      await page.goto('/#/');
      const before = (await deviceSnapshot(page)).records['bas.scope.demo.pack.edits'];
      await page.getByTestId('strategy-optimize').click();
      await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
      await expect(page.getByTestId('strategy-draft')).toBeVisible();
      await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
      expect((await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']).toEqual(before);
      expect(calls).toBe(1);
      await page.getByTestId('strategy-save').click();
      await expect(page.getByTestId('strategy-saved')).toContainText('Draft saved');
      expect((await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']).toEqual(before);
      await page.reload();
      await expect(page.getByTestId('strategy-draft')).toBeVisible();
      const originalKpis = JSON.stringify(kpiData);
      const changedKpis = JSON.parse(originalKpis);
      changedKpis.kpis[0].current += 1;
      await seedDeviceData(page, { 'bas.scope.demo.proj.kpi': JSON.stringify(changedKpis) });
      await page.reload();
      await expect(page.getByTestId('strategy-stale')).toBeVisible();
      await expect(page.getByTestId('strategy-confirm')).toBeDisabled();
      await page.getByTestId('strategy-save').click();
      await expect(page.getByTestId('strategy-saved')).toContainText('Draft saved');
      await expect(page.getByTestId('strategy-confirm')).toBeDisabled();
      await seedDeviceData(page, { 'bas.scope.demo.proj.kpi': originalKpis });
      await page.reload();
      await expect(page.getByTestId('strategy-confirm')).toBeEnabled();
      await page.getByTestId('strategy-confirm').click();
      await expect(page.getByTestId('strategy-saved')).toBeVisible();
      await expect(page.getByTestId('strategy-draft')).toHaveCount(0);
      await expect(page.getByTestId('strategy-ranking')).toContainText('Validate the operational bottleneck hypothesis.');
      await page.reload();
      await expect(page.getByTestId('strategy-approved')).toBeVisible();
      await expect(page.getByTestId('strategy-ranking')).toContainText('Validate the operational bottleneck hypothesis.');
      expect(calls).toBe(1);
      expect(await scan(page)).toEqual([]);
    });
  }

  test('disabled live connection fails explicitly without a mock or data mutation', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.getByTestId('strategy-optimize').click();
    await expect(page.getByTestId('strategy-error')).toContainText('real connection');
    await expect(page.getByTestId('strategy-draft')).toHaveCount(0);
  });

  test('each step saves its own strategy and tactics without changing source data', async ({ page }) => {
    test.setTimeout(120_000);
    const steps = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'];
    const requests: string[] = [];
    await page.route('**/relay/status', (route) => route.fulfill({ json: {
      secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
      connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
    } }));
    await page.route('**/relay/ai', async (route) => {
      const request = route.request().postDataJSON() as { prompt: string };
      const input = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
      requests.push(input.step);
      const issue = input.items.find((item: { kind: string }) => item.kind === 'issue');
      await route.fulfill({ json: { text: JSON.stringify({
        answer: `Strategy for ${input.step}`,
        findings: [{ text: 'Validate the issue.', refs: [issue.id] }],
        actions: [{ text: `Tactic for ${input.step}`, refs: [issue.id] }],
        caveats: ['This is a hypothesis.'], axis: 'impact', axisReason: 'Use recorded impact.',
        objectiveIssues: [], patches: [],
      }), inputTokens: 100, outputTokens: 100 } });
    });
    await open(page, '/', { lang: 'en' });
    await seedDeviceData(page, {
      'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }),
    });
    await page.reload();
    const before = (await deviceSnapshot(page)).records['bas.scope.demo.pack.edits'];
    await expect(page.getByTestId('ai-review-button')).toHaveCount(0);
    for (const step of steps) {
      await page.goto(`/#/step?step=${step}`);
      await page.getByTestId('strategy-optimize').click();
      await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
      const draft = page.getByTestId('strategy-draft');
      await expect(draft).toContainText(`Strategy for ${step}`);
      await expect(draft).toContainText(`Tactic for ${step}`);
      await draft.getByTestId('strategy-save').click();
      await expect(page.getByTestId('strategy-saved')).toContainText('Draft saved');
      await page.reload();
      await expect(page.getByTestId('strategy-draft')).toContainText(`Strategy for ${step}`);
      expect((await deviceSnapshot(page)).records['bas.scope.demo.pack.edits']).toEqual(before);
    }
    expect(requests).toEqual(steps);
    for (const step of steps) {
      await page.goto(`/#/step?step=${step}`);
      await expect(page.getByTestId('strategy-draft')).toContainText(`Strategy for ${step}`);
    }
    const key = 'bas.scope.demo.proj.overview';
    const overview = JSON.parse((await deviceSnapshot(page)).records[key]!.value!);
    overview.draft = { ...overview.stepDrafts['internal:asis'], proposal: { ...overview.stepDrafts['internal:asis'].proposal, answer: 'Shared batch strategy' } };
    await seedDeviceData(page, { [key]: JSON.stringify(overview) });
    await page.goto('/#/?draft=shared');
    await page.reload();
    await expect(page.getByTestId('strategy-draft')).toContainText('Shared batch strategy');
    await page.getByRole('button', { name: 'Show this step’s draft' }).click();
    await expect(page.getByTestId('strategy-draft')).toContainText('Strategy for deliverable');
    await page.getByRole('button', { name: 'Show shared batch draft' }).click();
    await expect(page.getByTestId('strategy-draft')).toContainText('Shared batch strategy');
  });
});

/** The relay refuses a connection test within 5 s of the previous one (429) and each attempt clears the consent, so retry both. */
async function saveVerifiedConnection(scope: Page | ReturnType<Page['getByTestId']>, verified: string) {
  await expect(async () => {
    await scope.getByTestId('ai-connection-consent').check();
    await scope.getByTestId('ai-connection-save').click();
    await expect(scope.getByTestId('ai-relay-connection')).toContainText(verified, { timeout: 2_000 });
  }).toPass({ intervals: [1_000, 2_000, 3_000], timeout: 20_000 });
}

async function scan(page: Page, includes: string[] = []) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const builder = new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS);
  for (const selector of includes) builder.include(selector);
  // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
  const result = await builder.exclude('[data-tabster-dummy]').analyze();
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

  test('Copilot is ready without any price or budget input', async ({ page }) => {
    await page.route('**/relay/status', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), copilot: { model: 'gpt-5' } } });
    });
    await openAiSettings(page, { lang: 'ja' });
    await page.getByTestId('ai-provider-copilot').check();
    await page.getByTestId('ai-send-consent').check();
    await page.getByTestId('ai-live-switch').check();
    await expect(page.getByTestId('ai-price-request')).toHaveCount(0);
    await expect(page.getByTestId('ai-provider-cost-note')).toHaveCount(0);
    await expect(page.getByTestId('ai-state')).not.toContainText('モック');
    await page.reload();
    await page.getByTestId('nav-ai-settings').click(); // a reload closes the dialog, like any page change
    await expect(page.getByTestId('ai-provider-copilot')).toBeChecked();
    await expect(page.getByTestId('ai-price-request')).toHaveCount(0);
    await expect(page.getByTestId('ai-state')).not.toContainText('モック');
  });

  for (const lang of ['ja', 'en'] as const) {
    test(`${lang}: AI settings explain one-time consent for request data`, async ({ page }) => {
      const settings = await openAiSettings(page, { lang });
      await expect(settings.getByTestId('ai-send-consent')).toBeVisible();
      await expect(settings.getByTestId('ai-policy-rules')).toHaveCount(0);
      await expect(settings.getByText(lang === 'ja' ? '同意は端末に保存され' : 'Consent is saved on this device')).toBeVisible();
      expect((await settings.boundingBox())?.width).toBe(960);
      await page.setViewportSize({ width: 720, height: 900 });
      const narrow = await settings.boundingBox();
      expect(narrow?.width).toBeGreaterThan(600);
      expect(narrow?.width).toBeLessThan(720);
    });
  }

  test('saves a key through the relay without ever showing or returning it, then deletes it', async ({ page }) => {
    const bodies = recordResponses(page);
    await openAiSettings(page, { lang: 'en' });
    const foundry = page.getByTestId('ai-foundry-key');
    await expect(foundry.getByTestId('ai-foundry-key-state')).toHaveText('Not set');
    await foundry.getByTestId('ai-foundry-key-input').fill(FAKE_KEY);
    await foundry.getByTestId('ai-foundry-key-save').click();
    await expect(foundry.getByTestId('ai-foundry-key-state')).toHaveText('Saved');
    await expect(foundry.getByTestId('ai-foundry-key-change')).toBeVisible();

    await page.reload();
    await page.getByTestId('nav-ai-settings').click(); // a reload closes the dialog, like any page change
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
    expect(bodies.join('\n')).not.toContain(FAKE_KEY);
  });

  test('Microsoft Entra ID replaces the key field with a relay-held sign-in (FR-323)', async ({ page }) => {
    await openAiSettings(page, { lang: 'en' });
    await expect(page.getByTestId('ai-foundry-key')).toBeVisible();
    await page.getByTestId('ai-auth-entra').click();
    const entra = page.getByTestId('ai-entra');
    await expect(entra).toBeVisible();
    for (const id of ['ai-endpoint', 'ai-deployment', 'ai-api-version', 'ai-foundry-key']) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(entra.getByTestId('ai-entra-signin')).toBeVisible();
    await expect(page.getByTestId('ai-entra-instance')).toHaveCount(0);
    await expect(page.getByTestId('ai-entra-account')).toContainText('Not signed in');
    await page.getByTestId('ai-auth-apikey').click();
    for (const id of ['ai-endpoint', 'ai-deployment', 'ai-api-version', 'ai-foundry-key']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test('Decision is a model picker only: selection saves without test consent, survives reload and can be disabled', async ({ page }) => {
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const endpoint = 'https://decision-resource.services.ai.azure.com';
    let decision: Record<string, unknown> | null = null;
    let entraMode = false;
    let rejectSelection = false;
    const saves: Record<string, unknown>[] = [];
    await page.route('**/relay/status', (route) => route.fulfill({ json: {
      secrets: { foundryKey: !entraMode },
      connection: {
        endpoint: 'https://decision-resource.openai.azure.com/openai/v1', deployment: 'chat', apiVersion: '2025-04-01-preview',
        ...(entraMode ? { auth: 'entraId', tenantId } : {}),
      },
      connectionVerifiedAt: '2026-11-19T00:00:00.000Z', decision,
      entra: { signedIn: entraMode, account: entraMode ? 'user@example.test' : null, tenantId, signIn: { status: entraMode ? 'signedIn' : 'idle' } },
    } }));
    await page.route('**/relay/entra/tenants', (route) => route.fulfill({ json: { tenants: [{ tenantId, name: 'Directory', signedIn: true }] } }));
    await page.route('**/relay/entra/instances', (route) => route.fulfill({ json: { instances: [{
      id: `/subscriptions/${tenantId}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/decision-resource`,
      name: 'decision-resource', kind: 'AIServices', location: 'eastus', resourceGroup: 'rg', subscriptionId: tenantId,
      subscriptionName: 'Test', tenantId, endpoint: 'https://decision-resource.openai.azure.com/openai/v1', keyAuthDisabled: false,
    }] } }));
    await page.route('**/relay/entra/inspect', (route) => route.fulfill({ json: {
      deployments: [{ name: 'chat', model: 'gpt-chat-latest', version: '', sku: 'GlobalStandard' }],
      access: { canCall: true, canAssign: false },
    } }));
    await page.route('**/relay/foundry/services', (route) => route.fulfill({ json: {
      speech: 'available', vision: 'available', decision: 'available',
      deployments: ['decision-1-1', 'decision-other'].map((name) => ({ name, model: 'Microsoft-Decision-1.1', version: '1', sku: 'GlobalStandard' })),
    } }));
    await page.route('**/relay/decision/model', (route) => {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      saves.push(input);
      if (rejectSelection) return route.fulfill({ status: 403, json: { error: 'resourceUnavailable' } });
      decision = input.deployment === null ? null : { ...input, endpoint, ...(entraMode ? { auth: 'entraId', tenantId } : {}), verifiedAt: '2026-11-19T00:00:00.000Z' };
      return route.fulfill({ json: { decision } });
    });
    await openAiSettings(page, { lang: 'en' });
    const panel = page.getByTestId('ai-foundry-models');
    const picker = panel.getByTestId('ai-decision-deployment');
    await expect(picker).toBeEnabled();
    await expect(panel.locator('select')).toHaveCount(1);
    await expect(panel.locator('button, input')).toHaveCount(0);
    await expect(panel.getByTestId('ai-foundry-admin')).toHaveCount(0);
    await picker.selectOption('decision-1-1');
    await expect(picker).toHaveValue('decision-1-1');
    expect(saves[0]).toEqual({ deployment: 'decision-1-1' });
    rejectSelection = true;
    await picker.selectOption('decision-other');
    await expect(panel).toContainText('Ask your administrator to set it up in Azure');
    await expect(picker).toHaveValue('decision-1-1');
    rejectSelection = false;

    entraMode = true;
    await page.reload();
    await page.getByTestId('nav-ai-settings').click();
    await page.getByTestId('ai-auth-entra').check();
    await page.getByTestId('ai-entra-instance').selectOption({ label: 'decision-resource — Test / rg (eastus)' });
    await expect(page.getByTestId('ai-entra-deployment')).toHaveValue('chat');
    await expect(picker).toBeEnabled();
    expect(await panel.evaluate((element) => !!element.previousElementSibling?.querySelector('[data-testid="ai-entra-deployment"]'))).toBe(true);
    await expect(picker).toHaveValue('');
    await picker.selectOption('decision-1-1');
    await expect(picker).toHaveValue('decision-1-1');
    await page.reload();
    await page.getByTestId('nav-ai-settings').click();
    await expect(picker).toHaveValue('decision-1-1');
    await picker.selectOption('');
    await expect(picker).toHaveValue('');
    await expect(picker).toBeEnabled();
    expect(saves).toEqual([{ deployment: 'decision-1-1' }, { deployment: 'decision-other' }, { deployment: 'decision-1-1' }, { deployment: null }]);
    await panel.scrollIntoViewIfNeeded();
    expect(await scan(page, ['[data-testid="ai-foundry-models"]'])).toEqual([]);
  });

  test('selects a directory and signs in before showing its Foundry resources', async ({ page }) => {
    const home = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
    const guest = '16b3c013-d300-468d-ac64-7eda0820b6d3';
    let guestSignedIn = false;
    let statusChecks = 0;
    const requests: string[] = [];
    await page.route('**/relay/status', (route) => route.fulfill({ json: {
      secrets: { foundryKey: false }, connection: null, connectionVerifiedAt: null,
      entra: { signedIn: true, account: 'user@example.com', tenantId: home, signIn: {
        status: guestSignedIn ? (++statusChecks < 3 ? 'pending' : 'signedIn') : 'idle',
      } },
    } }));
    await page.route('**/relay/entra/tenants', (route) => route.fulfill({ json: { tenants: [
      { tenantId: home, name: 'Home', signedIn: true }, { tenantId: guest, name: 'Guest directory', signedIn: false },
    ] } }));
    await page.route('**/relay/entra/signin', (route) => {
      expect(route.request().postDataJSON()).toEqual({ tenantId: guest });
      guestSignedIn = true;
      return route.fulfill({ json: { url: null } });
    });
    await page.route('**/relay/entra/instances', (route) => {
      const { tenantId } = route.request().postDataJSON() as { tenantId: string };
      requests.push(tenantId);
      if (tenantId === guest && !guestSignedIn) return route.fulfill({ status: 401, json: { error: 'interactionRequired' } });
      const name = tenantId === home ? 'home-resource' : 'guest-resource';
      return route.fulfill({ json: { instances: [{
        id: `/subscriptions/${tenantId}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/${name}`,
        name, kind: 'AIServices', location: 'eastus', resourceGroup: 'rg', subscriptionId: tenantId,
        subscriptionName: name, tenantId, endpoint: `https://${name}.openai.azure.com/openai/v1`, keyAuthDisabled: false,
      }] } });
    });
    await page.route('**/relay/entra/inspect', (route) => route.fulfill({ json: {
      deployments: [{ name: 'gpt-chat-latest', model: 'gpt-chat-latest', version: '', sku: 'Standard' }],
      access: { canCall: true, canAssign: false },
    } }));
    await openAiSettings(page, { lang: 'en' });
    await page.getByTestId('ai-auth-entra').click();
    await expect(page.getByTestId('ai-entra-instance')).toContainText('home-resource');
    await page.getByTestId('ai-entra-directory').selectOption(guest);
    await expect(page.getByTestId('ai-entra-directory-signin')).toContainText('Additional sign-in required');
    await expect(page.getByTestId('ai-entra-instance')).toHaveCount(0);
    await page.getByTestId('ai-entra-directory-signin').click();
    await expect(page.getByTestId('ai-entra-directory-signin')).toBeDisabled();
    await expect(page.getByTestId('ai-entra-msg')).toHaveCount(0);
    await expect(page.getByTestId('ai-entra-instance')).toContainText('guest-resource');
    await expect(page.getByTestId('ai-entra-instance')).not.toContainText('home-resource');
    await page.getByTestId('ai-entra-instance').selectOption({ label: 'guest-resource — guest-resource / rg (eastus)' });
    await expect(page.getByTestId('ai-entra-deployment')).toHaveValue('gpt-chat-latest');
    expect(requests).toContain(guest);
  });

  for (const lang of ['ja', 'en'] as const) {
    test(`Foundry shows concise administrator guidance for unavailable services, not network failures (${lang})`, async ({ page }) => {
      let state: 'unavailable' | 'unknown' | 'partial' = 'unavailable';
      await page.route('**/relay/status', (route) => route.fulfill({ json: {
        secrets: { foundryKey: true },
        connection: { endpoint: 'https://bas-foundry.openai.azure.com/openai/v1', deployment: 'chat', apiVersion: '2024-10-21' },
        connectionVerifiedAt: '2026-11-20T00:00:00Z',
      } }));
      await page.route('**/relay/foundry/services', (route) => route.fulfill({ json: {
        speech: state === 'partial' ? 'available' : state,
        vision: state === 'partial' ? 'unavailable' : state,
        decision: state === 'partial' ? 'available' : state,
        deployments: state === 'partial' ? [{ name: 'decision-current', model: 'Microsoft-Decision-1.1', version: '1', sku: 'Standard' }] : [],
      } }));
      await openAiSettings(page, { lang });
      const notice = page.getByTestId('ai-foundry-admin');
      await expect(notice).toContainText(lang === 'ja' ? '管理者に Azure 側のセットアップを依頼' : 'Ask your administrator to set it up in Azure');
      for (const name of ['AI Speech', 'AI Vision', 'Decision']) await expect(notice).toContainText(name);
      await expect(page.getByTestId('ai-decision-deployment')).toBeDisabled();
      await expect(page.getByTestId('ai-foundry-models').locator('button, input')).toHaveCount(0);
      await notice.scrollIntoViewIfNeeded();
      expect(await scan(page, ['[data-testid="ai-foundry-models"]'])).toEqual([]);

      state = 'unknown';
      await page.reload();
      await page.getByTestId('nav-ai-settings').click();
      await expect(page.getByTestId('ai-foundry-check-failed')).toContainText(lang === 'ja' ? 'リソースがないと判定したものではありません' : 'does not mean the resources are missing');
      await expect(notice).toHaveCount(0);
      state = 'partial';
      await page.reload();
      await page.getByTestId('nav-ai-settings').click();
      await expect(notice).toContainText('AI Vision');
      await expect(notice).not.toContainText('AI Speech');
      await expect(notice).not.toContainText('Decision');
      await expect(page.getByTestId('ai-decision-deployment')).toBeEnabled();
    });

    test(`Foundry is the only service settings area after connection succeeds (${lang})`, async ({ page }) => {
      const connection = { endpoint: 'https://bas-foundry.openai.azure.com/openai/v1', deployment: 'model-router', apiVersion: '2024-10-21' };
      let verified = false;
      const serviceCalls: string[] = [];
      let backgroundChecks = 0;
      let saves = 0;
      const serviceResult = {
        speech: 'available', vision: 'available', decision: 'available',
        deployments: [{ name: 'decision-1-1', model: 'Microsoft-Decision-1.1', version: '1', sku: 'GlobalStandard' }],
      };
      await page.route('**/relay/foundry/services', (route) => {
        backgroundChecks++;
        return route.fulfill({ json: serviceResult });
      });
      await page.route('**/relay/status', (route) => route.fulfill({ json: {
        secrets: { foundryKey: true }, connection: verified ? connection : null,
        connectionVerifiedAt: verified ? '2026-11-20T00:00:00.000Z' : null,
        media: verified ? { endpoint: 'https://bas-foundry.cognitiveservices.azure.com', auth: 'apiKey', unavailable: null, speech: null, vision: null } : null,
        entra: null,
      } }));
      await page.route('**/relay/connection', (route) => {
        if (route.request().method() === 'DELETE') {
          verified = false;
          return route.fulfill({ json: { connection: null } });
        }
        saves++;
        expect(route.request().postDataJSON()).toMatchObject({ checkServices: true });
        verified = true;
        return route.fulfill({ json: {
          connection, connectionVerifiedAt: '2026-11-20T00:00:00.000Z', usage: { inputTokens: 10, outputTokens: 1 }, services: serviceResult,
        } });
      });
      await page.route(/\/relay\/(?:media\/(?:speech|vision)|decision|speech\/(?:route|separate))$/, (route) => {
        serviceCalls.push(route.request().url());
        return route.fulfill({ status: 500, json: { error: 'unexpectedServiceCall' } });
      });
      const dialog = await openAiSettings(page, { lang });
      const services = dialog.getByTestId('ai-foundry').getByTestId('ai-foundry-models');
      await expect(services).toHaveCount(0);
      await expect(dialog.getByTestId('ai-foundry-services-locked')).toBeVisible();
      await page.getByTestId('ai-endpoint').fill(connection.endpoint);
      await page.getByTestId('ai-deployment').fill(connection.deployment);
      await page.getByTestId('ai-connection-consent').check();
      await page.getByTestId('ai-connection-save').click();
      await expect(services).toBeVisible();
      await expect(services.getByTestId('ai-decision-deployment')).toBeEnabled();
      await expect(services.getByTestId('ai-decision-deployment')).toContainText('decision-1-1 (Microsoft-Decision-1.1)');
      await expect(dialog.getByTestId('ai-connection-msg')).toBeVisible();
      expect(await services.evaluate((element) => !!element.previousElementSibling?.querySelector('[data-testid="ai-deployment"]'))).toBe(true);
      expect(saves).toBe(1);
      expect(backgroundChecks).toBe(0);
      await expect(services.locator('select')).toHaveCount(1);
      await expect(services.locator('button, input')).toHaveCount(0);
      for (const id of ['ai-speech-connection', 'ai-vision-connection', 'ai-speech', 'ai-media', 'ai-decision-panel', 'ai-speech-route-choice', 'ai-speech-separate']) {
        await expect(dialog.getByTestId(id)).toHaveCount(0);
      }
      await page.reload();
      await page.getByTestId('nav-ai-settings').click();
      await expect(services.getByTestId('ai-decision-deployment')).toBeEnabled();
      await services.scrollIntoViewIfNeeded();
      expect(await scan(page, ['[data-testid="ai-foundry-models"]'])).toEqual([]);
      await page.getByTestId('ai-provider-copilot').check();
      await expect(dialog.getByTestId('ai-foundry-models')).toHaveCount(0);
      await expect(dialog.getByTestId('ai-decision')).toHaveCount(0);
      await page.getByTestId('ai-provider-foundry').check();
      await expect(services).toBeVisible();
      await page.getByTestId('ai-connection-delete').click();
      await expect(services).toHaveCount(0);
      await expect(dialog.getByTestId('ai-foundry-services-locked')).toBeVisible();
      expect(serviceCalls).toEqual([]);
    });
  }

  test('the relay refuses writes without its header and rejects AI requests without a connection', async ({ page }) => {
    await openAiSettings(page, { lang: 'en' });
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
    expect(r.body).toEqual({ allowed: false, reasons: ['notConfigured'] });
    await expect(page.getByTestId('ai-connection-save')).toBeEnabled();
    await page.getByTestId('ai-connection-save').click();
    await expect(page.getByTestId('ai-connection-blockers')).toContainText('No connection test was sent');
    await expect(page.getByTestId('ai-connection-test-info')).toContainText('No customer');
  });

  for (const lang of ['en', 'ja'] as const) {
    test(`${lang}: Work IQ sign-in is not retrieval verification; consent, success and failed retest are separate`, async ({ page }) => {
      let verifiedAt: string | null = null;
      let checks = 0;
      const state = () => ({
        method: 'app',
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        account: 'user@contoso.example', signedIn: true, verifiedAt,
      });
      await page.route('**/relay/status', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ json: { ...await response.json(), workiq: state() } });
      });
      await page.route('**/relay/workiq/verify', async (route) => {
        expect(route.request().postDataJSON()).toEqual({ provider: 'foundry' });
        checks++;
        verifiedAt = checks === 1 ? '2026-11-11T05:00:00.000Z' : null;
        await route.fulfill({ status: checks === 1 ? 200 : 403, json: checks === 1 ? { workiq: state() } : { error: 'workiqForbidden' } });
      });
      await openAiSettings(page, { lang });
      await expect(page.getByTestId('ai-workiq-route-app')).toBeChecked();
      await expect(page.getByTestId('ai-workiq-state')).toContainText('user@contoso.example');
      await expect(page.getByTestId('ai-workiq-verification')).not.toContainText('2026-11-11');
      await expect(page.getByTestId('ai-workiq-check')).toBeDisabled();
      await page.getByTestId('ai-workiq-consent').check();
      expect(checks).toBe(0);
      await page.getByTestId('ai-workiq-check').click();
      await expect(page.getByTestId('ai-workiq-verification')).toContainText('2026-11-11T05:00:00.000Z');
      await expect(page.getByTestId('ai-workiq-msg')).toContainText(lang === 'en' ? 'test passed' : '検証に成功');
      await expect(page.getByTestId('ai-workiq-consent')).not.toBeChecked();
      await page.reload();
      await page.getByTestId('nav-ai-settings').click(); // a reload closes the dialog, like any page change
      await expect(page.getByTestId('ai-workiq-verification')).toContainText('2026-11-11T05:00:00.000Z');
      await page.getByTestId('ai-workiq-consent').check();
      await page.getByTestId('ai-workiq-check').click();
      await expect(page.getByTestId('ai-workiq-msg')).toContainText(lang === 'en' ? 'refused' : '拒否');
      await expect(page.getByTestId('ai-workiq-verification')).not.toContainText('2026-11-11');
      await expect(page.getByTestId('ai-readiness')).toContainText(lang === 'en' ? 'Verify Work IQ' : 'Work IQ の情報取得を検証');
      expect(checks).toBe(2);
      expect(await scan(page)).toEqual([]);
      await page.getByTestId('ai-provider-copilot').check();
      // D-14 (2026-11-19): Work IQ is offered with GitHub Copilot too, but it is optional there, so it is not a readiness item.
      await expect(page.getByTestId('ai-workiq')).toBeVisible();
      await expect(page.getByTestId('ai-readiness')).not.toContainText('Work IQ');
    });

    test(`${lang}: Work IQ CLI route needs no app registration; the user accepts the EULA and retrieval is still verified`, async ({ page }) => {
      let saved = false;
      let eula = 0;
      let verifiedAt: string | null = null;
      const state = () => (saved ? { method: 'cli', tenantId: null, clientId: null, account: null, signedIn: verifiedAt !== null, verifiedAt } : null);
      await page.route('**/relay/status', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ json: { ...await response.json(), workiq: state() } });
      });
      await page.route('**/relay/workiq', async (route) => {
        expect(route.request().method()).toBe('PUT');
        expect(route.request().postDataJSON()).toEqual({ method: 'cli' });
        saved = true;
        await route.fulfill({ json: { workiq: state() } });
      });
      await page.route('**/relay/workiq/eula', async (route) => {
        expect(route.request().postDataJSON()).toEqual({ provider: 'foundry', accept: true });
        eula++;
        await route.fulfill({ json: { accepted: true } });
      });
      await page.route('**/relay/workiq/verify', async (route) => {
        if (eula === 0) return route.fulfill({ status: 412, json: { error: 'workiqEulaRequired' } });
        verifiedAt = '2026-11-11T06:00:00.000Z';
        await route.fulfill({ json: { workiq: state() } });
      });
      await openAiSettings(page, { lang });
      await expect(page.getByTestId('ai-workiq-route-cli')).toBeChecked();
      await expect(page.getByTestId('ai-workiq-tenant')).toHaveCount(0);
      await expect(page.getByTestId('ai-workiq-eula')).toHaveCount(0);
      await page.getByTestId('ai-workiq-save').click();
      await expect(page.getByTestId('ai-workiq-msg')).toContainText(lang === 'en' ? 'Work IQ CLI is selected' : 'Work IQ CLI を選びました');
      await expect(page.getByTestId('ai-workiq-state')).toContainText(lang === 'en' ? 'not verified yet' : '未検証');
      await page.getByTestId('ai-workiq-consent').check();
      await page.getByTestId('ai-workiq-check').click();
      await expect(page.getByTestId('ai-workiq-msg')).toContainText('EULA');
      await expect(page.getByTestId('ai-workiq-verification')).not.toContainText('2026-11-11');
      await expect(page.getByTestId('ai-workiq-eula')).toContainText('https://github.com/microsoft/work-iq');
      await expect(page.getByTestId('ai-workiq-eula-accept')).toBeDisabled();
      expect(eula).toBe(0);
      await page.getByTestId('ai-workiq-eula-consent').check();
      await page.getByTestId('ai-workiq-eula-accept').click();
      await expect(page.getByTestId('ai-workiq-msg')).toContainText(lang === 'en' ? 'EULA was accepted' : 'EULA に同意しました');
      expect(eula).toBe(1);
      await page.getByTestId('ai-workiq-consent').check();
      await page.getByTestId('ai-workiq-check').click();
      await expect(page.getByTestId('ai-workiq-verification')).toContainText('2026-11-11T06:00:00.000Z');
      await expect(page.getByTestId('ai-workiq-state')).toContainText(lang === 'en' ? 'Work IQ CLI ready' : 'Work IQ CLI を利用可能');
      expect(await scan(page)).toEqual([]);
    });

    test(`${lang}: with Microsoft Foundry, Work IQ via Foundry is not selectable after Work IQ refused the tenant; the saved CLI stays usable`, async ({ page }) => {
      const tenantId = '11111111-2222-3333-4444-555555555555';
      const project = 'https://bas-foundry.services.ai.azure.com/api/projects/bas-proj';
      const cli = { method: 'cli', tenantId: null, clientId: null, account: null, signedIn: true, verifiedAt: '2026-11-20T00:00:00.000Z' };
      let foundry: Record<string, unknown> | null = { endpoint: project, connection: 'workiq-mcp', verifiedAt: null, refusedAt: '2026-11-25T01:02:03.000Z' };
      const calls: string[] = [];
      const state = () => (foundry?.verifiedAt
        ? { method: 'foundry', tenantId: null, clientId: null, account: null, signedIn: true, verifiedAt: foundry.verifiedAt, foundry }
        : { ...cli, ...(foundry ? { foundry } : {}) });
      await page.route('**/relay/status', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ json: { ...await response.json(),
          secrets: { foundryKey: false },
          connection: { endpoint: 'https://bas-foundry.openai.azure.com/openai/v1', deployment: 'model-router', apiVersion: '2025-04-01-preview', auth: 'entraId', tenantId },
          connectionVerifiedAt: '2026-11-19T00:00:00.000Z',
          entra: { signedIn: true, account: 'user@example.test', tenantId, signIn: { status: 'signedIn' } },
          workiq: state(),
        } });
      });
      await page.route('**/relay/entra/tenants', (route) => route.fulfill({ json: { tenants: [{ tenantId, name: 'Directory', signedIn: true }] } }));
      await page.route('**/relay/entra/instances', (route) => route.fulfill({ json: { instances: [] } }));
      await page.route('**/relay/workiq/foundry/discover', async (route) => {
        calls.push('discover');
        await route.fulfill({ json: { account: 'bas-foundry', projects: 1, candidates: [{ endpoint: project, project: 'bas-proj', connection: 'workiq-mcp', problem: null }] } });
      });
      await page.route('**/relay/workiq/foundry', async (route) => {
        expect(route.request().method()).toBe('DELETE');
        calls.push('deleteFoundry');
        foundry = null;
        await route.fulfill({ json: { workiq: state() } });
      });
      await page.route('**/relay/workiq', async (route) => {
        expect(route.request().method()).toBe('PUT');
        expect(route.request().postDataJSON()).toEqual({ method: 'cli' });
        calls.push('saveCli');
        await route.fulfill({ json: { workiq: state() } });
      });
      await openAiSettings(page, { lang });
      const foundryRoute = page.getByTestId('ai-workiq-route-foundry');
      await expect(foundryRoute).toBeDisabled();
      await expect(page.getByTestId('ai-workiq-foundry-unavailable')).toHaveAttribute('data-reason', 'refused');
      await expect(page.getByTestId('ai-workiq-foundry-unavailable')).toContainText('2026-11-25T01:02:03.000Z');
      await expect(page.getByTestId('ai-workiq-route-cli')).toBeChecked();
      await expect(page.getByTestId('ai-workiq-state')).toContainText(lang === 'en' ? 'Work IQ CLI ready' : 'Work IQ CLI を利用可能');
      // The CLI route is already saved and verified; saving it again is allowed and keeps the check.
      await expect(page.getByTestId('ai-workiq-save')).toBeEnabled();
      await page.getByTestId('ai-workiq-save').click();
      await expect(page.getByTestId('ai-workiq-msg')).toContainText(lang === 'en' ? 'Work IQ CLI is selected' : 'Work IQ CLI を選びました');
      await expect(page.getByTestId('ai-workiq-verification')).toContainText('2026-11-20T00:00:00.000Z');
      expect(await scan(page)).toEqual([]);

      // Asking again removes the recorded refusal; the connection found in the Foundry resource becomes selectable.
      await page.getByTestId('ai-workiq-foundry-recheck').click();
      await expect(foundryRoute).toBeEnabled();
      await expect(page.getByTestId('ai-workiq-foundry-unavailable')).toHaveCount(0);
      await foundryRoute.check();
      await expect(page.getByTestId('ai-workiq-foundry-connection')).toHaveValue(`${project}|workiq-mcp`);
      await expect(page.getByTestId('ai-workiq-foundry-connection')).toContainText('bas-proj / workiq-mcp');
      await expect(page.getByTestId('ai-workiq-local')).toHaveCount(0);

      // While the Foundry route is in use, the CLI button removes it first (the relay refuses the CLI until then).
      foundry = { endpoint: project, connection: 'workiq-mcp', verifiedAt: '2026-11-26T00:00:00.000Z', refusedAt: null };
      await page.reload();
      await page.getByTestId('nav-ai-settings').click();
      await expect(foundryRoute).toBeChecked();
      await expect(page.getByTestId('ai-workiq-foundry-state')).toContainText('2026-11-26T00:00:00.000Z');
      await page.getByTestId('ai-workiq-route-cli').check();
      await expect(page.getByTestId('ai-workiq-cli-off')).toBeVisible();
      calls.length = 0;
      await page.getByTestId('ai-workiq-save').click();
      await expect(page.getByTestId('ai-workiq-msg')).toContainText(lang === 'en' ? 'Work IQ CLI is selected' : 'Work IQ CLI を選びました');
      expect(calls.filter((c) => c !== 'discover')).toEqual(['deleteFoundry', 'saveCli']);
      await expect(page.getByTestId('ai-workiq-cli-off')).toHaveCount(0);
      await expect(page.getByTestId('ai-workiq-route-cli')).toBeChecked();
    });

    test(`${lang}: launch settings explains blocked tests instead of disabling the action`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 920 });
      await seedLaunch(page, lang);
      await page.getByTestId('launch-ai-settings').click();
      const settings = page.getByTestId('ai-settings-dialog');
      const d4Warning = settings.getByTestId('ai-d4-warning');
      await expect(d4Warning).toBeVisible();
      const warningBox = await d4Warning.boundingBox();
      const warningBodyBox = await d4Warning.locator('.fui-MessageBarBody').boundingBox();
      expect(warningBox).not.toBeNull();
      expect(warningBodyBox).not.toBeNull();
      expect(warningBodyBox!.y + warningBodyBox!.height).toBeLessThanOrEqual(warningBox!.y + warningBox!.height + 1);
      let sends = 0;
      page.on('request', (req) => {
        if (req.url().endsWith('/relay/connection') && req.method() === 'PUT') sends++;
      });
      await settings.getByTestId('ai-endpoint').fill('https://resource.services.ai.azure.com/api/projects/project');
      await settings.getByTestId('ai-deployment').fill('gpt-deployed');
      await expect(settings.getByTestId('ai-price-input')).toHaveCount(0);
      await expect(settings.getByTestId('ai-price-output')).toHaveCount(0);
      await expect(settings.getByTestId('ai-connection-test-cost')).toHaveCount(0);
      await expect(settings.getByTestId('ai-connection-destination')).toContainText('https://resource.services.ai.azure.com/openai/v1/chat/completions');
      await expect(settings.getByTestId('ai-api-version')).toBeDisabled();
      await expect(settings.getByTestId('ai-connection-validation')).toHaveCount(0);
      await settings.getByTestId('ai-connection-consent').check();
      await expect(settings.getByTestId('ai-connection-save')).toBeEnabled();
      await settings.getByTestId('ai-connection-save').click();
      await expect(settings.getByTestId('ai-connection-blockers')).toContainText(lang === 'en' ? 'First save the API key' : 'API キー');
      await expect(settings.getByTestId('ai-connection-blockers')).toContainText(lang === 'en' ? 'No connection test was sent' : '接続テストは送信していません');
      expect(sends).toBe(0);
      expect(await scan(page)).toEqual([]);
    });
  }
});

test.describe('mock answers stay mock (FR-011, FR-132, NFR-LEGAL-002)', () => {
  test('global consent does not bypass connection requirements, and no per-use confirmation is shown', async ({ page }) => {
    await openAiSettings(page, { lang: 'en' });
    const live = page.getByRole('switch', { name: 'Enable the real connection to generative AI' });
    await expect(live).not.toBeChecked();
    await expect(live).toBeDisabled();
    await page.getByTestId('ai-send-consent').check();
    await live.check();
    await expect(page.getByTestId('ai-state')).toHaveText('Mock');
    await expect(page.getByTestId('ai-d4-warning')).toBeVisible();
    await expect(page.getByTestId('ai-d4-banner')).toBeVisible();
    await page.goto('/#/assistant');
    await page.getByTestId('ai-chat-input').fill('lead time');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('ai-person-confirm')).toHaveCount(0);
    const answer = page.getByTestId('ai-chat-log').getByTestId('ai-mock-label').first();
    await expect(answer).toContainText('Mock');
    await expect(answer.locator('[data-reason="notConfigured"]')).toBeVisible();
    await expect(answer.locator('[data-reason="liveDisabled"]')).toHaveCount(0);
    await expect(answer.locator('[data-entity-ref]').first()).toBeVisible();
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
    test(`${lang}: project guidance, DNS/auth failures, v1 verification and key invalidation`, async ({ page }) => {
      sent = [];
      responseStatus = 401;
      const bodies = recordResponses(page);
      await openAiSettings(page, { lang });
      await page.getByTestId('ai-endpoint').fill('https://resource.services.ai.azure.com/api/projects/project');
      await page.getByTestId('ai-deployment').fill('gpt-deployed');
      await expect(page.getByTestId('ai-connection-destination')).toContainText('https://resource.services.ai.azure.com/openai/v1/chat/completions');
      await expect(page.getByTestId('ai-api-version')).toBeDisabled();
      await expect(page.getByTestId('ai-connection-validation')).toHaveCount(0);
      await expect(page.getByTestId('ai-connection-save')).toBeEnabled();
      await page.getByTestId('ai-connection-save').click();
      await expect(page.getByTestId('ai-connection-blockers')).toContainText(lang === 'en' ? 'First save the API key' : 'API キー');
      expect(sent).toHaveLength(0);
      await page.getByTestId('ai-foundry-key-input').fill(FAKE_KEY);
      await page.getByTestId('ai-foundry-key-save').click();
      await expect(page.getByTestId('ai-foundry-key-state')).toHaveText(lang === 'en' ? 'Saved' : '保存済み');
      await expect(page.getByTestId('ai-price-input')).toHaveCount(0);
      await expect(page.getByTestId('ai-price-output')).toHaveCount(0);
      await page.getByTestId('ai-endpoint').fill('https://missing-foundry-resource.invalid');
      await page.getByTestId('ai-connection-consent').check();
      await page.getByTestId('ai-connection-save').click();
      await expect(page.getByTestId('ai-connection-msg')).toContainText(lang === 'en' ? 'cannot be resolved' : '名前解決できません');
      await expect(page.getByTestId('ai-relay-connection')).toContainText(lang === 'en' ? 'Not saved' : '未保存');
      await page.waitForTimeout(5100);
      await page.getByTestId('ai-endpoint').fill(`${stubUrl}/openai/v1/`);
      await expect(page.getByTestId('ai-api-version')).toBeDisabled();
      await expect(page.getByTestId('ai-connection-save')).toBeEnabled();
      await page.getByTestId('ai-connection-save').click();
      await expect(page.getByTestId('ai-connection-blockers')).toContainText(lang === 'en' ? 'consent checkbox' : '同意チェック');
      expect(sent).toHaveLength(0);
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
      await expect(page.getByTestId('ai-usage-daily')).toBeVisible();
      await expect(page.getByTestId('ai-usage-month')).toHaveCount(0);
      await page.getByTestId('ai-connection-consent').check();
      await expect(page.getByTestId('ai-connection-save')).toBeEnabled({ timeout: 7000 });
      await page.reload();
      await page.getByTestId('nav-ai-settings').click(); // a reload closes the dialog, like any page change
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

  test('global consent prevents a second confirmation for person data', async ({ page }) => {
    const settings = await openAiSettings(page, { lang: 'en' });
    await settings.getByTestId('ai-send-consent').check();
    await settings.getByTestId('ai-settings-dialog-close').click();
    await open(page, '/entity/person-ito-mariko', { lang: 'en' });
    await page.getByTestId('ai-explain-button').click();
    const panel = page.getByTestId('ai-explain-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('ai-person-confirm')).toHaveCount(0);
    await expect(panel.getByTestId('ai-mock-label')).toBeVisible();
    await expect(panel.locator('[data-reason="notConfirmed"]')).toHaveCount(0);
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
    await expect(page.getByTestId('ai-import-reasons')).toContainText('Connection settings are incomplete');
  });

  test('story video exports standalone HTML with playback and safe model text', async ({ page }) => {
    await open(page, '/assistant', { lang: 'en', motion: 'full' });
    const story = page.getByTestId('ai-story');
    await expect(story.getByTestId('ai-story-estimate')).toHaveCount(0);
    await expect(story.getByTestId('ai-story-generate-live')).toBeDisabled();
    await expect(story.getByTestId('ai-story-generate')).toBeEnabled();
    await expect(story.getByTestId('ai-story-overcap')).toHaveCount(0);
    await story.getByTestId('ai-story-generate').click();
    await expect(story.getByTestId('ai-story-state')).toHaveText('Latest');
    await expect(story.getByTestId('ai-mock-label')).toContainText('Mock');
    const player = page.frameLocator('[data-testid="ai-story-player"]');
    await expect(player.locator('li').first()).toBeVisible();
    const first = await player.locator('h1').textContent();
    await expect(player.locator('li')).toHaveCount(1);
    await story.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(story.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(player.locator('h1')).not.toHaveText(first!, { timeout: 5000 });
    await story.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(story.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    const download = page.waitForEvent('download');
    await story.getByTestId('ai-story-download').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.html$/);
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const html = Buffer.concat(chunks).toString('utf8');
    const savedUrl = new URL('/saved-story.html', page.url()).href;
    await page.route(savedUrl, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(savedUrl);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Restart', exact: true }).click();
    await expect(page.locator('#position')).toContainText('1 /');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeHidden();
    await expect(page.locator('li').nth(1)).toBeVisible();
    await noJapanese(page);
  });

  test('live HTML story uses one gated request, renders text safely, and survives reload', async ({ page }) => {
    let calls = 0;
    await page.route('**/relay/status', (route) => route.fulfill({ json: {
      secrets: { foundryKey: true },
      connection: { endpoint: 'https://example.openai.azure.com', deployment: 'model-router', apiVersion: '2024-10-21' },
      connectionVerifiedAt: '2026-11-17T00:00:00Z', keyProtection: null, copilot: null, workiq: null,
    } }));
    await page.route('**/relay/ai', async (route) => {
      expect(route.request().postDataJSON().use).toBe('storyVideo');
      calls++;
      await route.fulfill({ json: {
        text: JSON.stringify({ scenes: [{ title: 'Source evidence', narration: '<img src=x onerror=alert(1)>', role: 'opening', durationMs: 3000 }] }),
        inputTokens: 100, outputTokens: 80,
      } });
    });
    const settings = await openAiSettings(page, { lang: 'en' });
    await settings.getByTestId('ai-send-consent').check();
    await settings.getByTestId('ai-live-switch').check();
    await settings.getByTestId('ai-settings-dialog-close').click();
    await page.goto('/#/assistant');
    await page.getByTestId('ai-story-generate-live').click();
    await expect(page.getByTestId('ai-story').getByTestId('ai-live-label')).toBeVisible();
    await expect(page.getByTestId('ai-story').getByTestId('ai-live-tokens')).toHaveText('Tokens used: 180 (input 100 / output 80)');
    expect(calls).toBe(1);
    const frame = page.frameLocator('[data-testid="ai-story-player"]');
    await expect(frame.locator('li')).toContainText('<img src=x onerror=alert(1)>');
    await expect(frame.locator('img')).toHaveCount(0);
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await expect(page.frameLocator('[data-testid="ai-story-player"]').locator('li')).toContainText('onerror');
    expect(calls).toBe(1);
  });
});

test.describe('AI screens accessibility (axe, WCAG 2.2 AA) and language', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    for (const route of ['/assistant', '/ai-settings']) {
      test(`${lang} ${route}`, async ({ page }) => {
        await open(page, route, { lang });
        await page.waitForTimeout(500);
        expect(await scan(page)).toEqual([]);
        if (lang === 'en') await noJapanese(page);
      });
    }

    test(`${lang} AI settings dialog`, async ({ page }) => {
      // D-6: a legacy Foundry record makes the settings show the "move" candidate, which is scanned too.
      await page.addInitScript(() => localStorage.setItem('bas.foundry.settings', JSON.stringify({ endpoint: 'https://legacy.example.com', deployment: 'old', authMethod: 'apiKey' })));
      const settings = await openAiSettings(page, { lang });
      await expect(settings.getByTestId('ai-legacy')).toBeVisible();
      await page.waitForTimeout(500);
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') await noJapanese(page);
    });

    test(`${lang} D-25: AI settings have one place; links and old bookmarks open the same dialog`, async ({ page }) => {
      await open(page, '/assistant', { lang });
      await page.getByTestId('nav-ai-settings').click();
      const settings = page.getByTestId('ai-settings-dialog');
      await expect(settings.getByTestId('ai-send-consent')).toBeVisible();
      await settings.getByTestId('ai-settings-dialog-close').click();
      await expect(settings).toHaveCount(0);
      await page.goto('/#/ai-settings');
      await expect(settings.getByTestId('ai-send-consent')).toBeVisible();
      await expect(page).toHaveURL(/#\/home$/);
      await page.goBack();
      await expect(settings).toHaveCount(0); // leaving the route closes it, so it never covers another screen
    });

    test(`${lang} with the explain panel open`, async ({ page }) => {
      await open(page, '/plan', { lang });
      await page.getByTestId('ai-explain-button').click();
      await expect(page.getByTestId('ai-explain-panel').getByTestId('ai-mock-label')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') await noJapanese(page);
      await expect(page.getByTestId('ai-review-button')).toHaveCount(0);
    });
  }
});

test.describe('legacy Foundry settings (D-6, P-01)', () => {
  test('are shown as a candidate, copied only on request, and live stays off', async ({ page }) => {
    const legacy = { endpoint: 'https://legacy.example.com', deployment: 'old', authMethod: 'apiKey' };
    await page.addInitScript((v) => localStorage.setItem('bas.foundry.settings', v), JSON.stringify(legacy));
    const outbound: string[] = [];
    page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1')) outbound.push(r.url()); });
    await openAiSettings(page, { lang: 'en' });
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

test.describe('usage log (budget management removed)', () => {
  test('shows only today\'s call count: no budget, price or retention controls, and old records with a cost still load', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('bas.e2e.ledger')) return;
      sessionStorage.setItem('bas.e2e.ledger', '1');
      localStorage.setItem('bas.ai.ledger', JSON.stringify([
        { at: '2020-01-01T00:00:00Z', use: 'explain', inputTokens: 1, outputTokens: 1, costJpy: 1 },
        { at: new Date().toISOString(), use: 'explain', inputTokens: 1, outputTokens: 1, costJpy: 1 },
      ]));
    });
    await openAiSettings(page, { lang: 'en' });
    await expect(page.getByTestId('ai-usage-daily')).toContainText('1 / 30');
    await expect(page.getByTestId('ai-usage-no-content')).toBeVisible();
    for (const id of ['ai-budget-input', 'ai-usage-month', 'ai-usage-unpriced', 'ai-prices', 'ai-ledger-prune', 'ai-ledger-expired', 'ai-ledger-prune-button']) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    expect(await scan(page)).toEqual([]);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('bas.ai.ledger') ?? '[]')) as unknown[]).toHaveLength(2);
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
        const body = Buffer.concat(chunks).toString('utf8');
        // D-22: a step brief in the requested sections, with one figure (987,654) that is in no fact ledger.
        const content = body.includes('[bas-proj:stepBrief:')
          ? '### answer\nStub brief: fix the definitions first.\n### situation\nStub situation.\n### complication\nStub complication with 987,654 open items.\n### question\nWhat first?\n### findings\n- Stub finding.\n### actions\n- Stub action.\n### caveats\n- Stub caveat.'
          : 'Stub live explanation of the screen.';
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 2000, completion_tokens: 300 } }));
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
    await openAiSettings(page, { lang });
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
    await expect(page.getByTestId('ai-price-input')).toHaveCount(0);
    await expect(page.getByTestId('ai-price-output')).toHaveCount(0);
    await saveVerifiedConnection(page, lang === 'en' ? 'Verified and saved' : '接続確認済み・保存済み');
    received.length = 0;
    await page.getByTestId('ai-send-consent').check();
    await page.getByTestId('ai-live-switch').check();
  }

  test('live answer and token record without any pricing or budget input; the job shows its reported tokens', async ({ page }) => {
    await configure(page, 'en');
    await expect(page.getByTestId('ai-state')).toHaveText('Live (consent and settings active)');
    await expect(page.getByTestId('ai-configured')).toContainText('Saved');
    await expect(page.getByTestId('ai-key-protection')).toContainText(process.platform === 'win32' ? 'DPAPI' : 'Key file');
    await expect(page.getByTestId('ai-d4-warning')).toBeVisible();
    await expect(page.getByTestId('ai-d4-banner')).toBeVisible();
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);

    await page.goto('/#/');
    await page.getByTestId('ai-explain-button').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);

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
    const ledger = JSON.parse(await page.evaluate(() => localStorage.getItem('bas.ai.ledger') ?? '[]')) as { use: string; inputTokens: number; outputTokens: number }[];
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.use).toBe('connectionTest');
    expect(ledger[1]!.use).toBe('explain');
    expect(ledger[1]).toMatchObject({ inputTokens: 2000, outputTokens: 300 });
    expect(ledger[1]).not.toHaveProperty('costJpy');
    await expect(panel.getByTestId('ai-live-tokens')).toHaveText('Tokens used: 2,300 (input 2,000 / output 300)');
    expect(JSON.stringify(ledger)).not.toContain('Stub live');
    await noJapanese(page);
    expect(await scan(page)).toEqual([]);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();

    await page.getByTestId('nav-ai-settings').click();
    await expect(page.getByTestId('ai-usage-daily')).toContainText('1 / 30');
    await expect(page.getByTestId('ai-budget-input')).toHaveCount(0);
    expect(received).toHaveLength(1);
  });

  test('ja: saved consent sends without a per-send confirmation', async ({ page }) => {
    await configure(page, 'ja');
    expect(await scan(page)).toEqual([]);
    await page.goto('/#/');
    await page.getByTestId('ai-explain-button').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    expect(await scan(page)).toEqual([]);
    await expect(page.getByTestId('ai-explain-panel').getByTestId('ai-live-label')).toContainText('実際の応答');
    expect(received).toHaveLength(1);
  });

  test('D-22: [Generate with Copilot] sends without a second confirmation and flags a figure not in the fact ledger', async ({ page }) => {
    await configure(page, 'en');
    await page.goto('/#/step?step=kpi');
    const gen = page.getByTestId('step-dash-brief-generate');
    await expect(page.getByTestId('step-dash-brief-ai-col')).toContainText('Send consent is given once in AI settings');
    received.length = 0;
    await gen.click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    const ai = page.getByTestId('step-dash-brief-ai');
    await expect(ai).toHaveAttribute('data-mode', 'live');
    await expect(ai.getByTestId('ai-live-label')).toContainText('Live');
    await expect(ai.getByTestId('step-dash-brief-ai-answer')).toHaveText('Stub brief: fix the definitions first.');
    await expect(ai.getByTestId('step-dash-brief-unverified')).toContainText('987,654');
    expect(received).toHaveLength(1);
    const sent = JSON.stringify((JSON.parse(received[0]!.body) as { messages: unknown[] }).messages);
    expect(sent).toContain('[bas-proj:stepBrief:kpi]');
    expect(sent).toContain('Fact ledger:');
    const ledger = JSON.parse(await page.evaluate(() => localStorage.getItem('bas.ai.ledger') ?? '[]')) as { use: string }[];
    expect(ledger.at(-1)!.use).toBe('stepBrief');
    expect(JSON.stringify(ledger)).not.toContain('Stub brief');
    expect(await scan(page)).toEqual([]);
  });
  test('D-20: settings consent sends the approved theme and its text attachment without a per-send confirmation', async ({ page }) => {
    await page.addInitScript(() => {
      if (localStorage.getItem('bas.proj.ui')) return;
      localStorage.setItem('bas.proj.ui', JSON.stringify({ state: { editor: '', editMode: true, lens: 'business', analysisLayout: 'split', firstRunDone: true }, version: 1 }));
    });
    await configure(page, 'en');
    await page.goto('/#/discussion');
    const canvas = page.getByTestId('proj-canvas');
    await expect(page.getByTestId('proj-ai-mode')).toHaveText('Live');
    await canvas.getByTestId('proj-att-input').setInputFiles([{ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Visit notes\nThe E2E plant waits 3 days for parts.\n') }]);
    await expect(canvas.getByTestId('proj-att-item')).toHaveCount(1);
    const suggestions = canvas.getByTestId('proj-section-suggestion').locator('.proj-records > li');
    const before = await suggestions.count();
    received.length = 0;

    await canvas.getByTestId('proj-ask-ai').click();
    await expect(page.getByTestId('ai-live-confirm')).toHaveCount(0);
    expect(await scan(page)).toEqual([]);

    await expect(canvas.getByTestId('proj-ai-outcome').getByTestId('ai-live-label')).toContainText('Live');
    await expect(suggestions).toHaveCount(before + 1);
    await expect(suggestions.last()).toContainText('Stub live explanation of the screen.');
    expect(received).toHaveLength(1);
    const sent = JSON.parse(received[0]!.body) as { messages: { role: string; content: unknown }[] };
    expect(sent.messages[0]!.content).toContain('One per line');
    expect(JSON.stringify(sent.messages[1]!.content)).toContain('waits 3 days for parts');
    const ledger = JSON.parse(await page.evaluate(() => localStorage.getItem('bas.ai.ledger') ?? '[]')) as { use: string }[];
    expect(ledger.at(-1)!.use).toBe('recommend');
    expect(JSON.stringify(ledger)).not.toContain('waits 3 days');
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

/* FR-311 (D-12): Project pack generation on the launch screen against a local stub provider (same server flag as above). */
test.describe('live generation through the relay (D-12)', () => {
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
    extensions: { brand: { primary: '#1267B4', logo: { src: 'brand/logo', alt: lt('Contoso logo'), minWidthPx: 20 } } },
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
  const analysisCategories = {
    swot: ['strengths', 'weaknesses', 'opportunities', 'threats'],
    fiveForces: ['rivalry', 'newEntrants', 'substitutes', 'buyerPower', 'supplierPower'],
    valueChain: ['inbound', 'operations', 'outbound', 'marketing', 'service', 'infrastructure', 'hr', 'technology', 'procurement'],
    threeC: ['customer', 'competitor', 'company'],
    bsc: ['financial', 'customerView', 'process', 'learning'],
  };
  const analysisAnswer = {
    analyses: Object.entries(analysisCategories).map(([method, categories]) => ({
      method,
      items: categories.map((category) => ({ category, text: { ja: `${method} ${category}`, en: `${method} ${category}` }, score: 3 })),
    })),
  };

  test.beforeAll(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] };
        const user = body.messages[1]!.content;
        received.push({ body, user });
        const answer = user.includes('# Verified Project pack') ? analysisAnswer
          : user.startsWith('Build the foundation') ? stageA
            : user.startsWith('Build the business part') ? stageB : { remove: ['initiative-x'] };
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
    let workiqVerifiedAt: string | null = null;
    const workiqState = () => ({
      tenantId: '11111111-2222-3333-4444-555555555555', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      account: 'user@contoso.example', signedIn: true, verifiedAt: workiqVerifiedAt,
    });
    await page.route('**/relay/status', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), workiq: workiqState() } });
    });
    await page.route('**/relay/workiq/verify', async (route) => {
      workiqVerifiedAt = '2026-11-11T05:00:00.000Z';
      await route.fulfill({ json: { workiq: workiqState() } });
    });
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
    await expect(settings.getByTestId('ai-price-input')).toHaveCount(0);
    await expect(settings.getByTestId('ai-price-output')).toHaveCount(0);
    await saveVerifiedConnection(settings, 'Verified and saved');
    received.length = 0;
    await settings.getByTestId('ai-send-consent').check();
    await settings.getByTestId('ai-live-switch').check();
    await expect(settings.getByTestId('ai-state')).toHaveText('Live (consent and settings active)');
    await settings.getByTestId('ai-settings-dialog-close').click();

    await page.getByTestId('launch-generate-pj-c').click();
    const dialog = page.getByTestId('gen-dialog');
    await dialog.getByTestId('gen-purpose').fill('Reduce late deliveries');
    await dialog.getByTestId('gen-news').uncheck(); // no internet in the test
    await dialog.getByTestId('gen-files').setInputFiles({ name: 'delivery-kpi.csv', mimeType: 'text/csv', buffer: Buffer.from('kpi,baseline,current,target\non-time delivery %,92,94,98\ngear unit price JPY,12000,,\nlogo minimum width: 20 px\n') });
    await expect(dialog.getByTestId('gen-file-list')).toContainText('delivery-kpi.csv');
    await expect(dialog.getByTestId('gen-estimate')).toContainText(/\d+ to \d+/);
    await expect(dialog.getByTestId('gen-check-cost')).toHaveCount(0);
    await expect(dialog.getByTestId('gen-start')).toBeDisabled();
    await dialog.getByTestId('gen-check-approved').check();
    await expect(dialog.getByTestId('gen-start')).toBeDisabled(); // a model response and sign-in alone are insufficient
    await dialog.getByTestId('gen-open-settings').click();
    await settings.getByTestId('ai-workiq-consent').check();
    await settings.getByTestId('ai-workiq-check').click();
    await expect(settings.getByTestId('ai-workiq-verification')).toContainText('2026-11-11');
    await settings.getByTestId('ai-settings-dialog-close').click();
    // D-14: how many follow-up rounds may run is the user's choice (1–4, default 3).
    await expect(dialog.getByTestId('gen-workiq-rounds')).toHaveValue('3');
    await dialog.getByTestId('gen-workiq-rounds').fill('9');
    await expect(dialog.getByTestId('gen-workiq-rounds')).toHaveValue('4');
    await dialog.getByTestId('gen-workiq').uncheck(); // this test's material is the attached synthetic CSV
    await expect(dialog.getByTestId('gen-workiq-rounds')).toHaveCount(0);
    expect(await scan(page)).toEqual([]);
    // Verifying Work IQ and changing its inclusion alters the approved send scope, so reconfirm both approvals.
    await dialog.getByTestId('gen-check-approved').check();
    await expect(dialog.getByTestId('gen-start')).toBeEnabled();
    await dialog.getByTestId('gen-check-logo').check();
    await expect(dialog.getByTestId('gen-start')).toBeDisabled();
    await dialog.getByTestId('gen-logo-file').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await dialog.getByTestId('gen-start').click();
    await expect(dialog.getByRole('alert')).toContainText('Cannot import the logo');
    expect(received).toHaveLength(0);
    const logoBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=';
    await dialog.getByTestId('gen-logo-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(logoBase64, 'base64') });
    await dialog.getByTestId('gen-start').click();

    await expect(dialog.getByTestId('gen-saved')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('gen-progress')).toHaveCount(0);
    await expect(dialog.getByTestId('gen-checks')).toHaveText('1 fix rounds, 0 items removed, 0 invented sources discarded');
    await expect(dialog.getByTestId('gen-cost')).toHaveCount(0);
    // Tokens per step as the provider reported them (6,000 + 2,500 per call) and their total.
    await expect(dialog.getByTestId('gen-tokens-row-total')).toHaveText(['8,500', '8,500', '8,500', '8,500']);
    await expect(dialog.getByTestId('gen-tokens-row')).toContainText(['Foundation', 'Business', 'Check and fix', 'Five analyses']);
    await expect(dialog.getByTestId('gen-tokens-total-value')).toHaveText('34,000');
    await expect(dialog.getByTestId('gen-ungrounded')).toHaveCount(0);
    expect(await scan(page)).toEqual([]);

    // What went out: JSON mode, the attached file's text, the app-made source id; stage B saw the foundation ids.
    expect(received).toHaveLength(4);
    expect(received[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(received[0]!.user).toContain('on-time delivery %,92,94,98');
    expect(received[0]!.user).toContain('source-doc-1');
    expect(received[1]!.user).toContain('site-tokyo');
    expect(received[2]!.user).toContain('initiative-x');
    expect(received[3]!.user).toContain('"fiveForces"');
    expect(received.map((r) => JSON.stringify(r.body)).join('')).not.toContain(FAKE_KEY);
    expect(received.map((r) => JSON.stringify(r.body)).join('')).not.toContain(logoBase64);

    const stored = await page.evaluate(() => ({
      index: JSON.parse(localStorage.getItem('bas.packs.index') ?? '{}') as Record<string, { files: string[]; entities: number }>,
      ledger: JSON.parse(localStorage.getItem('bas.ai.ledger') ?? '[]') as { use: string; scope?: string; stage?: string }[],
    }));
    expect(stored.index['pj-c']).toMatchObject({ files: ['generated:foundry', 'delivery-kpi.csv'] });
    expect(stored.ledger.filter((r) => r.use === 'packBuild')).toHaveLength(4);
    expect(stored.ledger.filter((r) => r.use === 'packBuild').map((r) => [r.scope, r.stage])).toEqual([['pj-c', 'foundation'], ['pj-c', 'business'], ['pj-c', 'fix-1'], ['pj-c', 'analysis']]);
    expect(stored.ledger.every((r) => !('costJpy' in r))).toBe(true);

    const reloaded = page.waitForEvent('load', { timeout: 10_000 }).catch(() => undefined);
    await dialog.getByTestId('gen-open').click();
    await reloaded;
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.getByTestId('dlv-batch-dialog')).toBeVisible(); // the new pack is finished by the all-items AI draft step
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dlv-batch-dialog')).toHaveCount(0);
    await page.evaluate(() => { window.location.hash = '/brand'; });
    await expect(page.getByTestId('brand-logo').locator('img')).toHaveJSProperty('naturalWidth', 1);
    await expect(page.getByTestId('brand-logo')).toContainText('20 px');
    await page.evaluate(() => { window.location.hash = '/analysis'; });
    await expect.poll(async () => (await page.locator('.proj-method-count').allTextContents()).reduce((n, x) => n + Number.parseInt(x, 10), 0)).toBe(5);
    await expect(page.getByTestId('proj-result-plot').first()).toBeVisible();
    await expect(page.getByTestId('proj-params').getByText('Mock', { exact: true })).toHaveCount(0);
    expect(received).toHaveLength(4); // opening the screen only displays the saved analyses

    // The final export shows the same per-step tokens, the export itself as 0, and the total; internal Markdown only.
    await page.goto('/#/discussion');
    await page.getByTestId('proj-export').click();
    const exportDialog = page.getByTestId('proj-export-dialog');
    const tokens = exportDialog.getByTestId('proj-export-tokens-table');
    await expect(tokens.getByTestId('proj-export-tokens-table-row-total')).toHaveText(['8,500', '8,500', '8,500', '8,500', '0']);
    await expect(tokens.getByTestId('proj-export-tokens-table-row').last()).toContainText('Export (uses no generative AI)');
    await expect(tokens.getByTestId('proj-export-tokens-table-total-value')).toHaveText('34,000');
    await exportDialog.getByRole('radio', { name: 'Internal' }).check();
    await expect(exportDialog.getByTestId('proj-export-preview')).toContainText('| **Total** | 4 | 24,000 | 10,000 | 34,000 |');
    await exportDialog.getByRole('radio', { name: 'External' }).check();
    await expect(exportDialog.getByTestId('proj-export-preview')).not.toContainText('Generative AI token usage');
    expect(await scan(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.goto('/#/data');
    await expect(page.locator('main#main')).toContainText('Contoso Manufacturing');
    // Re-fetching later starts from this run's inputs, and nothing runs before the user confirms again.
    await expect(page.getByTestId('pack-ready')).toBeVisible();
    await page.getByTestId('pack-refetch').click();
    const again = page.getByTestId('gen-dialog');
    await expect(again.getByTestId('gen-prefilled')).toBeVisible();
    await expect(again.getByTestId('gen-purpose')).toHaveValue('Reduce late deliveries');
    await expect(again.getByTestId('gen-file-list')).toContainText('delivery-kpi.csv');
    await expect(again.getByTestId('gen-check-approved')).not.toBeChecked();
    await expect(again.getByTestId('gen-start')).toBeDisabled();
    expect(await scan(page)).toEqual([]);
    await again.getByRole('button', { name: 'Cancel' }).click();
    await expect(again).toHaveCount(0);

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
