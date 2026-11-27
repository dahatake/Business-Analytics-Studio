import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open, seedDeviceData, setup } from './helpers.ts';
import { samplePack } from '../src/data/sample.ts';

/** FR-349 / FR-350: the strategy map is a portal to each item's input place, and shows drafts next to saved data. */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');

test('an issue opens its editor, and the return bar brings focus back to that item on the map', async ({ page }) => {
  await open(page, '/', { lang: 'en' });
  await expect(page.getByTestId('strategy-portal-hint')).toBeVisible();
  expect(await scan(page)).toEqual([]);
  await page.locator('[id="stg-node-issue:issue-lead-time"]').click();
  await expect(page).toHaveURL(/#\/relations\?.*edit=issue-lead-time/);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('portal-return-link')).toContainText('Long order-to-ship lead time');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByTestId('portal-return-link').click();
  await expect(page.getByTestId('strategy-map')).toBeVisible();
  await expect.poll(() => focusedId(page)).toBe('stg-node-issue:issue-lead-time');
  await expect(page.getByTestId('portal-return')).toHaveCount(0);
});

test('a KPI opens its row on the KPI tab and a lane heading opens its list', async ({ page }) => {
  await open(page, '/', { lang: 'en' });
  await page.locator('[id="stg-node-kpi:kpi-otd"]').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/analysis\?tab=kpi&target=proj-kpi-row-kpi-otd/);
  await expect.poll(() => focusedId(page)).toBe('proj-kpi-row-kpi-otd');
  await page.getByTestId('portal-return-link').click();
  await expect.poll(() => focusedId(page)).toBe('stg-node-kpi:kpi-otd');
  await page.locator('#stg-lane-okr').click();
  await expect.poll(() => focusedId(page)).toBe('proj-okr-panel');
});

test('FR-381: the map zooms between bird\'s-eye, items and detail, opens sub-data, and each row edits its exact field', async ({ page }) => {
  await open(page, '/', { lang: 'en' });
  const map = page.getByTestId('strategy-map');
  await expect(page.getByTestId('strategy-level-items')).toHaveAttribute('aria-checked', 'true');
  const issue = page.locator('[id="stg-node-issue:issue-lead-time"]');
  await expect(issue).toHaveAccessibleName(/Long order-to-ship lead time.*Edit$/);
  await expect(issue.locator('text.strategy-edit')).toHaveText('Edit');

  // One item's chain is highlighted on hover; others fade.
  await issue.hover();
  await expect(map).toHaveClass(/has-focus/);
  await expect(page.locator('[data-node="issue:issue-lead-time"]').locator('xpath=ancestor::*[contains(@class,"strategy-card")][1]')).toHaveClass(/is-focus/);

  const toggle = page.getByTestId('stg-toggle-issue:issue-lead-time');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const impactRow = page.locator('[id="stg-row-issue:issue-lead-time-impact"]');
  await expect(impactRow).toHaveCount(0);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(impactRow).toHaveAccessibleName(/^Impact: \d \/ 5$/);
  expect(await scan(page)).toEqual([]);

  await impactRow.click();
  await expect(page).toHaveURL(/#\/relations\?.*edit=issue-lead-time&field=impact/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('portal-return-link').click();
  // The opened sub-data is kept, and focus returns to the row that was used.
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => focusedId(page)).toBe('stg-row-issue:issue-lead-time-impact');

  await page.getByTestId('strategy-close-all').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('strategy-level-detail').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const value = page.getByTestId('strategy-zoom-value');
  await expect(value).toHaveText('Zoom 100%');
  await page.getByTestId('strategy-zoom-in').click();
  await expect(value).toHaveText('Zoom 125%');
  const before = await map.evaluate((el) => el.getBoundingClientRect().width);
  await page.getByTestId('strategy-zoom-out').click();
  await expect(value).toHaveText('Zoom 100%');
  expect(await map.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(before);

  // Bird's-eye: one block per lane with counts; choosing a block shows that lane's items.
  await page.getByTestId('strategy-level-overview').click();
  const overview = page.getByTestId('strategy-map-overview');
  await expect(overview).toBeVisible();
  await expect(map).toHaveCount(0);
  await expect(page.getByTestId('strategy-ov-issue')).toHaveAccessibleName(/^5 items/);
  await expect(page.getByTestId('strategy-ov-issue')).toHaveAccessibleDescription(/^Issues \/ 1\. /);
  expect(await scan(page)).toEqual([]);
  await page.getByTestId('strategy-ov-issue').click();
  await expect(page.getByTestId('strategy-level-items')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => focusedId(page)).toBe('stg-lane-issue');
});

async function seedProject(page: Page, unit = '') {
  await setup(page, { lang: 'en' });
  await page.addInitScript(({ unit }) => {
    if (sessionStorage.getItem('bas.e2e.portal')) return;
    sessionStorage.setItem('bas.e2e.portal', '1');
    const createdAt = '2026-11-10T00:00:00.000Z';
    localStorage.setItem('bas.projects', JSON.stringify({
      version: 1,
      state: {
        companies: [{ id: 'co-a', name: 'Contoso', createdAt }],
        projects: [{ id: 'pj-alpha', companyId: 'co-a', name: 'Alpha', createdAt, step: 'kpi', ...(unit ? { brief: { orgUnit: unit } } : {}) }],
        target: { kind: 'project', projectId: 'pj-alpha' },
        lastProjectId: 'pj-alpha',
        demoStep: 'define',
      },
    }));
  }, { unit });
  await page.goto('/#/');
  await expect(page.locator('main#main')).toBeVisible();
  const anchor = {
    asOf: '2026-11-01', refreshTriggers: [], refreshEvents: [],
    entityScope: { legalEntity: 'Contoso', figuresScope: ['Contoso'] },
    statedObjectives: [{ id: 'obj-reach', text: 'Triple partner-led customer reach', horizon: 'FY2027', basis: 'published', scope: 'legalEntity', sourceIds: ['S1'] }],
    companyKpis: [], segments: [], structuralIssues: [], analystHypotheses: [],
    sources: [{ id: 'S1', title: 'Mid-term plan', type: 'public', provenance: 'primary', url: 'https://example.com/plan', accessedDate: '2026-11-01', locator: 'p. 4' }],
  };
  const okr = {
    kpis: [{ id: 'k-reach', name: 'Customer Reach', target: '10x', unit: 'x', sourceIds: [] }],
    objectives: [],
  };
  const pack = { ...samplePack, extensions: { ...samplePack.extensions, okr, companyAnchor: { version: 1, savedAt: '2026-11-01T00:00:00.000Z', anchor } } };
  await seedDeviceData(page, {
    'bas.packs.index': JSON.stringify({ 'pj-alpha': {
      projectId: 'pj-alpha', packId: pack.packId, company: pack.company, isSample: false,
      entities: pack.entities.length, importedAt: '2026-11-10T00:00:00.000Z', files: ['synthetic.json'],
    } }),
    'bas.binary.pack.pj-alpha': JSON.stringify(pack),
  });
  await page.reload();
  await expect(page.getByTestId('strategy-map')).toBeVisible();
}

test('drafts appear dashed on the map; a draft objective is checked and saved in a popup', async ({ page }) => {
  await seedProject(page);
  const draftObjective = page.locator('[id="stg-node-objective:draft:obj-reach"]');
  await expect(draftObjective.locator('[data-draft="new"]')).toContainText('Draft (not saved)');
  await expect(page.getByTestId('strategy-drafts')).toContainText('1 drafts');

  // A KPI draft adopted on the KPI tab shows up on the map before it is saved.
  await page.goto('/#/analysis?tab=kpi');
  await page.getByTestId('proj-adopt-select-k-reach').check();
  await page.getByTestId('proj-adopt-kpi').click();
  await page.goto('/#/');
  const draftKpi = page.locator('[id^="stg-node-kpi:draft:"]');
  await expect(draftKpi).toHaveCount(1);
  await expect(draftKpi).toHaveAccessibleName(/Customer Reach.*Draft \(not saved\)/);
  await expect(draftKpi).toHaveAccessibleDescription('KPIs (optional)');
  await expect(page.getByTestId('strategy-drafts')).toContainText('2 drafts');
  expect(await scan(page)).toEqual([]);

  await draftObjective.click();
  const dialog = page.getByTestId('strategy-objective-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('strategy-objective-text')).toHaveValue('Triple partner-led customer reach');
  await expect(page.getByTestId('strategy-objective-url')).toHaveValue('https://example.com/plan');
  await page.getByTestId('strategy-objective-url').fill('');
  await page.getByTestId('strategy-objective-save').click();
  await expect(page.getByTestId('strategy-objective-errors')).toBeVisible();
  expect(await scan(page)).toEqual([]);
  await page.getByTestId('strategy-objective-url').fill('https://example.com/plan');
  await page.getByTestId('strategy-objective-save').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('strategy-objective-saved')).toBeVisible();
  const saved = page.locator('[id="stg-node-objective:obj-reach"]');
  await expect(saved).toBeVisible();
  await expect(draftObjective).toHaveCount(0);
  await expect.poll(() => focusedId(page)).toBe('stg-node-objective:obj-reach');
  await expect(saved).toHaveAttribute('href', '#/projects?target=company-anchor-co-a');
  await page.reload();
  await expect(page.locator('[id="stg-node-objective:obj-reach"]')).toBeVisible();
});

test('FR-367: Copilot gets the business objectives, registering stated ones and keeping the rest as drafts', async ({ page }) => {
  await seedProject(page);
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
  } }));
  const prompts: string[] = [];
  await page.route('**/relay/ai', async (route) => {
    const prompt = (route.request().postDataJSON() as { prompt: string }).prompt;
    prompts.push(prompt);
    const data = JSON.parse(prompt.split('\n')[2]!) as { evidence: { ref: string; kind: string; text: string }[] };
    // A source line quoted word for word (stated) and one objective built from related data (drafted).
    const source = data.evidence.find((e) => e.kind === 'source' && e.text.split('\n')[1]!.split(/\s+/).length > 4)!;
    const line = source.text.split('\n')[1]!;
    const objectives = [
      { tier: 'stated', text: line, horizon: line.split(/\s+/)[0], scope: 'legalEntity', evidence: [{ ref: source.ref, excerpt: line }], reason: '' },
      { tier: 'drafted', text: 'Run more high-quality engagements with the same team', horizon: '', scope: 'business', scopeName: 'Hub', evidence: [], reason: 'Built from the issues.' },
    ];
    await route.fulfill({ json: { text: JSON.stringify({ objectives }), inputTokens: 100, outputTokens: 100 } });
  });

  await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
  await page.reload();
  await expect(page.getByTestId('strategy-map')).toBeVisible();

  await page.getByTestId('strategy-objectives-fetch').click();
  await expect(page.getByTestId('strategy-objectives-result')).toContainText('Saved 1 business objectives and made 1 drafts.');
  await expect(page.getByTestId('strategy-objectives-result')).toContainText('Work IQ is not connected');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatch(/^\[bas-proj:objectiveDraft\]/);
  await expect(page.locator('[id^="stg-node-objective:OBJ-"]')).toHaveCount(1);
  const draft = page.locator('[id^="stg-node-objective:draft:objd-"]');
  await expect(draft).toHaveCount(1);
  expect(await scan(page)).toEqual([]);

  await draft.click();
  await expect(page.getByTestId('strategy-objective-tier')).toContainText('Draft built from related data (no evidence): Built from the issues.');
  await expect(page.getByTestId('strategy-objective-text')).toHaveValue('Run more high-quality engagements with the same team');
  expect(await scan(page)).toEqual([]);
  await page.getByTestId('strategy-objective-discard').click();
  await expect(page.getByTestId('strategy-objective-dialog')).toBeHidden();
  await expect(draft).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[id^="stg-node-objective:OBJ-"]')).toHaveCount(1);
  await expect(page.locator('[id^="stg-node-objective:draft:objd-"]')).toHaveCount(0);
});

test('batch token labels identify business objectives and KPI/OKR pick and fill', async ({ page }) => {
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
  } }));
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => { releaseNext = resolve; });
  await page.route('**/relay/ai', async (route) => {
    const request = route.request().postDataJSON() as { use: string; stage?: string };
    if (request.use === 'objectiveDraft') {
      await route.fulfill({ json: { text: '{"objectives":[]}', inputTokens: 31, outputTokens: 3 } });
    } else if (request.stage === 'kpiOkr:pick') {
      await route.fulfill({ json: { text: JSON.stringify({ kpis: [{ id: 'okr.kpi:k-reach', reason: 'Relevant' }], okrs: [] }), inputTokens: 41, outputTokens: 4 } });
    } else if (request.stage === 'kpiOkr:fill') {
      await route.fulfill({ json: { text: '{"kpis":[],"okrs":[]}', inputTokens: 51, outputTokens: null } });
    } else {
      await next;
      await route.fulfill({ status: 504, json: { error: 'fixtureTimeout' } }).catch(() => undefined);
    }
  });
  try {
    await seedProject(page);
    await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
    await page.reload();
    await expect(page.getByTestId('strategy-map')).toBeVisible();
    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('dlv-draft').click();
    await page.getByTestId('dlv-batch-generate').click();
    await expect(page.getByTestId('dlv-batch-objectives')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('dlv-batch-kpiOkr')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('dlv-batch-fields-asis')).toHaveAttribute('data-status', 'working');

    const objective = page.locator('[data-testid="dlv-batch-tokens-row"][data-use="objectiveDraft"]');
    const pick = page.locator('[data-testid="dlv-batch-tokens-row"][data-step="kpiOkr:pick"]');
    const fill = page.locator('[data-testid="dlv-batch-tokens-row"][data-step="kpiOkr:fill"]');
    await expect(objective.locator('th')).toHaveText('Shared across all steps: business objectives (Work IQ) and drafts');
    await expect(pick.locator('th')).toContainText('All steps: KPI/OKR drafts');
    await expect(pick.locator('th')).toContainText('Candidate selection or missing proposals');
    await expect(fill.locator('th')).toContainText('All steps: KPI/OKR drafts');
    await expect(fill.locator('th')).toContainText('Estimating empty fields');
    await expect(objective.locator('td')).toHaveText(['1', '31', '3', '34']);
    await expect(pick.locator('td')).toHaveText(['1', '41', '4', '45']);
    await expect(fill.locator('td')).toHaveText(['1', '51', 'unknown', 'unknown']);
    await expect(page.getByTestId('dlv-batch-tokens-total').locator('td')).toHaveText(['3', '123', 'unknown', 'unknown']);
    await page.getByTestId('dlv-batch-stop').click();
    releaseNext();
    await expect(page.getByTestId('dlv-batch-current')).toHaveCount(0);
  } finally {
    releaseNext();
  }
});

for (const fixture of [
  {
    name: 'a Work IQ fallback',
    sections: [{ key: 'objectivesCompany', error: 'workiqUnavailable' }],
    notices: ['Work IQ did not provide objectives', 'workiqUnavailable'],
  },
  {
    name: 'partial and confidential exclusions',
    sections: [
      { key: 'objectivesCompany', question: 'What are the objectives?', answer: 'A synthetic objective.', citations: [], sensitivity: null, fetchedAt: '2026-01-01T00:00:00Z', withheld: 2 },
      { key: 'objectivesUnit', error: 'workiqUnavailable' },
    ],
    notices: ['1 Work IQ search result(s) could not be retrieved', 'Some sources or answers labelled Confidential or higher were excluded'],
  },
]) test(`batch progress follows Work IQ and Copilot and reports ${fixture.name}`, async ({ page }) => {
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
    workiq: { method: 'cli', account: null, signedIn: true, verifiedAt: '2026-11-18T00:00:00Z' },
  } }));
  let releaseWorkIq!: () => void;
  let releaseObjective!: () => void;
  let releaseNext!: () => void;
  const workIq = new Promise<void>((resolve) => { releaseWorkIq = resolve; });
  const objective = new Promise<void>((resolve) => { releaseObjective = resolve; });
  const next = new Promise<void>((resolve) => { releaseNext = resolve; });
  await page.route('**/relay/workiq/ask', async (route) => {
    expect((route.request().postDataJSON() as { aspects: string[] }).aspects).toEqual(['objectivesCompany', 'objectivesUnit']);
    await workIq;
    await route.fulfill({ json: { sections: fixture.sections } }).catch(() => undefined);
  });
  await page.route('**/relay/ai', async (route) => {
    const request = route.request().postDataJSON() as { use: string };
    if (request.use === 'objectiveDraft') {
      await objective;
      await route.fulfill({ json: { text: '{"objectives":[]}', inputTokens: 10, outputTokens: 10 } }).catch(() => undefined);
    } else {
      await next;
      await route.fulfill({ status: 504, json: { error: 'fixtureTimeout' } }).catch(() => undefined);
    }
  });
  try {
    await seedProject(page, 'Synthetic unit');
    await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
    await page.reload();
    await expect(page.getByTestId('strategy-map')).toBeVisible();
    await page.goto('/#/deliverables?step=asis');
    await page.getByTestId('dlv-draft').click();
    await page.getByTestId('dlv-batch-generate').click();
    const progress = page.getByTestId('dlv-batch-current-progress');
    await expect(page.getByTestId('dlv-batch-objectives')).toHaveAttribute('data-status', 'working');
    await expect(progress).toHaveAttribute('data-activity', 'workiq');
    await expect(progress).toContainText('Searching for information with Work IQ');
    await expect(progress).toContainText('time remaining are unknown');
    releaseWorkIq();
    await expect(progress).toHaveAttribute('data-activity', 'generate');
    await expect(progress).toContainText('AI is generating');
    await expect(page.getByTestId('dlv-batch-objectives')).toHaveAttribute('data-status', 'working');
    for (const notice of fixture.notices) await expect(page.getByTestId('dlv-batch-objectives-note')).toContainText(notice);
    releaseObjective();
    await expect(page.getByTestId('dlv-batch-objectives')).toHaveAttribute('data-status', 'done');
    for (const notice of fixture.notices) await expect(page.getByTestId('dlv-batch-objectives-note')).toContainText(notice);
    await page.getByTestId('dlv-batch-stop').click();
    releaseNext();
    await expect(page.getByTestId('dlv-batch-current')).toHaveCount(0);
    await expect(page.getByTestId('dlv-batch-objectives')).toHaveAttribute('data-status', 'done');
  } finally {
    releaseWorkIq();
    releaseObjective();
    releaseNext();
  }
});

test('individual objective progress reports a search failure while Copilot is still working', async ({ page }) => {
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
    workiq: { method: 'cli', account: null, signedIn: true, verifiedAt: '2026-11-18T00:00:00Z' },
  } }));
  let releaseWorkIq!: () => void;
  let releaseAi!: () => void;
  const workIq = new Promise<void>((resolve) => { releaseWorkIq = resolve; });
  const ai = new Promise<void>((resolve) => { releaseAi = resolve; });
  await page.route('**/relay/workiq/ask', async (route) => {
    await workIq;
    await route.fulfill({ json: { sections: [{ key: 'objectivesCompany', error: 'workiqUnavailable' }] } }).catch(() => undefined);
  });
  await page.route('**/relay/ai', async (route) => {
    await ai;
    await route.fulfill({ json: { text: '{"objectives":[]}', inputTokens: 10, outputTokens: 10 } }).catch(() => undefined);
  });
  try {
    await seedProject(page);
    await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
    await page.reload();
    await page.getByTestId('strategy-objectives-fetch').click();
    const progress = page.getByTestId('strategy-objectives-progress');
    await expect(progress).toHaveAttribute('data-activity', 'workiq');
    releaseWorkIq();
    await expect(progress).toHaveAttribute('data-activity', 'generate');
    const searchStatus = page.getByTestId('strategy-objectives-search-status');
    await expect(searchStatus).toContainText('Work IQ gave no answer');
    await expect(searchStatus).toContainText('1 Work IQ search result(s) could not be retrieved');
    await expect(page.getByTestId('strategy-objectives-result')).toHaveCount(0);
    expect(await scan(page)).toEqual([]);
    releaseAi();
    await expect(page.getByTestId('strategy-objectives-result')).toContainText('Work IQ gave no answer');
    await expect(progress).toHaveCount(0);
  } finally {
    releaseWorkIq();
    releaseAi();
  }
});

test('a form draft shows Work IQ before Copilot without claiming the draft is finished', async ({ page }) => {
  await page.route('**/relay/status', (route) => route.fulfill({ json: {
    secrets: { foundryKey: true }, connection: { endpoint: 'https://test.invalid', deployment: 'fixture', apiVersion: '2024-10-21' },
    connectionVerifiedAt: '2026-01-01T00:00:00Z', copilot: { model: 'fixture-model' },
    workiq: { method: 'cli', account: null, signedIn: true, verifiedAt: '2026-11-18T00:00:00Z' },
  } }));
  let releaseWorkIq!: () => void;
  let releaseAi!: () => void;
  const workIq = new Promise<void>((resolve) => { releaseWorkIq = resolve; });
  const ai = new Promise<void>((resolve) => { releaseAi = resolve; });
  await page.route('**/relay/workiq/ask', async (route) => {
    await workIq;
    await route.fulfill({ json: { sections: [{ key: 'topic-0', error: 'workiqUnavailable' }] } }).catch(() => undefined);
  });
  await page.route('**/relay/ai', async (route) => {
    await ai;
    await route.fulfill({ json: { text: '{"values":{"name":"Synthetic issue (assumption)"}}', inputTokens: 10, outputTokens: 10 } }).catch(() => undefined);
  });
  try {
    await seedProject(page);
    await seedDeviceData(page, { 'bas.ai.settings': JSON.stringify({ state: { provider: 'foundry', liveEnabled: true, sendConsent: true, authMethod: 'apiKey' }, version: 1 }) });
    await page.reload();
    await page.goto('/#/workspace');
    await page.getByTestId('entry-bar-summary').getByTestId('entry-add-issue').click();
    const dialog = page.getByTestId('entry-dialog');
    await dialog.getByTestId('entry-draft-workiq').check();
    await dialog.getByTestId('entry-draft-create').click();
    const progress = dialog.getByTestId('entry-draft-progress');
    await expect(progress).toHaveAttribute('data-activity', 'workiq');
    await expect(progress).toContainText('Searching for information with Work IQ');
    await expect(progress).toContainText('time remaining are unknown');
    releaseWorkIq();
    await expect(progress).toHaveAttribute('data-activity', 'generate');
    await expect(progress).toContainText('AI is generating');
    await expect(progress).toContainText('Check and process the answer');
    await expect(dialog.getByTestId('entry-draft-workiq-note')).toContainText('1 Work IQ search result(s) could not be retrieved');
    await expect(dialog.getByTestId('entry-draft-workiq-note')).toContainText('Work IQ returned nothing usable; the draft does not use it.');
    await expect(dialog.getByTestId('entry-field-name')).toHaveValue('');
    expect(await scan(page)).toEqual([]);
    releaseAi();
    await expect(dialog.getByTestId('entry-draft-preview')).toBeVisible();
    await expect(progress).toHaveCount(0);
    await expect(dialog.getByTestId('entry-field-name')).toHaveValue('');
    await dialog.getByTestId('entry-draft-approve').click();
    await expect(dialog.getByTestId('entry-field-name')).toHaveValue('Synthetic issue (assumption)');
  } finally {
    releaseWorkIq();
    releaseAi();
  }
});

test('the external view shows confirmed data only and keeps company objectives non-interactive', async ({ page }) => {
  await open(page, '/', { lang: 'en', audience: 'external' });
  await expect(page.getByTestId('strategy-map')).toBeVisible();
  await expect(page.locator('#stg-lane-objective')).toHaveCount(0);
  await expect(page.locator('#stg-empty-objective')).toHaveCount(0);
  await expect(page.locator('[data-draft]')).toHaveCount(0);
  await expect(page.locator('#stg-lane-issue')).toHaveAttribute('href', /#\/relations/);
});
