import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiComplete, preflight, readLedger, setLiveTransport, writeLedger, type LiveCall } from '../src/ai/client.ts';
import { DEFAULT_MONTHLY_BUDGET_JPY } from '../src/ai/policy.ts';
import { loaded } from '../src/data/pack.ts';
import { useAiSettings, isConfigured, liveReady, parseBudget, runtimeSettings } from '../src/modules/ai/settingsStore.ts';
import { LEGACY_FOUNDRY_KEY, copyLegacyPatch, legacyState, readLegacyFoundry } from '../src/modules/ai/legacy.ts';
import '../src/modules/ai/mocks.ts';
import {
  STORY_CAP_JPY, STORY_MAX_CALLS, STORY_OUTPUT_TOKENS, STORY_PLANNED_CALLS, STORY_SAFETY_FACTOR, estimateStory, parsePrice, runStoryGeneration,
  sourcesFromSolutions, storyMock, storyPrompt, storyState, type StoryVideo,
} from '../src/modules/ai/story.ts';
import { buildIndex, chatPrompt, contextWindow, pairsInPrompt, search, tokenize, type ChatTurn } from '../src/modules/ai/search.ts';
import {
  appliedForRoute, applyProposals, commitApply, parseProposals, reviewPrompt, undoLastApply, useAiOverrides, overrideKey, type Proposal,
} from '../src/modules/ai/review.ts';
import { buildExplanation, componentsForRoute, entitiesOfComponents } from '../src/modules/ai/explain.ts';
import { deleteExpiredUsage, expiredUsageCount, usageSummary } from '../src/modules/ai/ledger.ts';
import { USAGE_MAX_CHARS, USAGE_TIMEOUT_MS, TimeoutError, withTimeout } from '../src/modules/ai/usage.ts';

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/;

describe('story video budget (FR-292, PARAM-128〜131)', () => {
  it('estimates planned calls × unit prices × 1.2', () => {
    const e = estimateStory(10_000, { input: '300', output: '1200' });
    const perCall = (10_000 * 300 + STORY_OUTPUT_TOKENS * 1200) / 1_000_000;
    expect(e.perCallJpy).toBeCloseTo(perCall);
    expect(e.totalJpy).toBeCloseTo(perCall * STORY_PLANNED_CALLS * STORY_SAFETY_FACTOR);
    expect(STORY_SAFETY_FACTOR).toBe(1.2);
    expect(e.ok).toBe(true);
  });

  it('refuses to start above 1000 JPY and without valid prices (no defaults)', () => {
    const over = estimateStory(10_000, { input: '40000', output: '40000' });
    expect(over.totalJpy).toBeGreaterThan(STORY_CAP_JPY);
    expect(over).toMatchObject({ ok: false, reason: 'overCap' });
    for (const bad of ['', '0', '-1', 'abc']) expect(estimateStory(100, { input: bad, output: '1' }).reason).toBe('noPrice');
    expect(parsePrice('2.5')).toBe(2.5);
  });

  it('a just-under-cap estimate is allowed; the boundary uses the safety factor', () => {
    const perCallAtCap = STORY_CAP_JPY / (STORY_PLANNED_CALLS * STORY_SAFETY_FACTOR);
    const price = String((perCallAtCap * 1_000_000) / STORY_OUTPUT_TOKENS);
    expect(estimateStory(0, { input: '1', output: price }).ok).toBe(true);
    expect(estimateStory(0, { input: '1', output: String(Number(price) * 1.01) }).ok).toBe(false);
  });

  it('stops before a call that would exceed the cap, and after the maximum number of calls', async () => {
    const est = estimateStory(0, { input: '1', output: String((300 * 1_000_000) / STORY_OUTPUT_TOKENS) }); // 300 JPY per call
    expect(est.ok).toBe(true); // 300 × 2 × 1.2 = 720
    let calls = 0;
    const costly = await runStoryGeneration(est, async () => { calls++; return { text: 'x', costJpy: 700 }; });
    expect(costly).toMatchObject({ status: 'aborted', reason: 'budget', calls: 1 });
    expect(calls).toBe(1);
    const failing = await runStoryGeneration(estimateStory(0, { input: '1', output: '1' }), async () => null);
    expect(failing).toMatchObject({ status: 'aborted', reason: 'maxCalls', calls: STORY_MAX_CALLS });
    const ok = await runStoryGeneration(estimateStory(0, { input: '1', output: '1' }), async (step) => ({ text: step, costJpy: 0.01 }));
    expect(ok).toMatchObject({ status: 'done', calls: 2, outputs: { storyboard: 'storyboard', animation: 'animation' } });
    const cancelled = await runStoryGeneration(estimateStory(0, { input: '1', output: '1' }), async () => ({ text: 'x', costJpy: 0 }), () => true);
    expect(cancelled.reason).toBe('cancelled');
  });

  it('mock storyboard follows the source and goes stale when the source changes', () => {
    const src = sourcesFromSolutions(() => true)[0]!;
    const scenes = JSON.parse(storyMock(storyPrompt(src, 'en', 'storyboard'))) as { title: string }[];
    expect(scenes[0]!.title).toBe((src.title as { en: string }).en);
    expect(scenes.length).toBe(src.steps.length + 1);
    const video = { sourceId: src.id, sourceUpdatedAt: src.updatedAt, status: 'latest' } as StoryVideo;
    expect(storyState(video, src)).toBe('latest');
    expect(storyState(video, { ...src, updatedAt: 'changed' })).toBe('stale');
    expect(storyState(undefined, src)).toBe('none');
  });
});

describe('local search (FR-017)', () => {
  const index = buildIndex(loaded.pack.entities, [
    { id: 'uc-x', name: { ja: '出荷の見える化', en: 'Shipment visibility' }, summary: 'typed by user', persona: 'business', steps: [], relatedIds: [], origin: 'registered', updatedAt: '2026-11-09' },
  ]);

  it('tokenizes Latin words and Japanese bigrams', () => {
    expect(tokenize('Lead time')).toEqual(['lead', 'time']);
    expect(tokenize('受注から')).toEqual(['受注', '注か', 'から']);
  });

  it('ranks name matches above description-only matches, in both languages', () => {
    const en = search(index, 'lead time');
    expect(en.slice(0, 2).map((h) => h.id).sort()).toEqual(['issue-lead-time', 'kpi-lead-time']);
    const ja = search(index, 'リードタイム');
    expect(ja[0]!.id).toBe('kpi-lead-time');
    const shipment = search(index, '出荷');
    expect(shipment.some((h) => h.id === 'uc-x' && h.type === 'usecase')).toBe(true);
    const synthetic = [
      { id: 'b-desc', type: 'entity' as const, fields: [{ text: 'other', weight: 3 }, { text: 'alpha beta', weight: 1 }] },
      { id: 'a-name', type: 'entity' as const, fields: [{ text: 'alpha', weight: 3 }, { text: 'none', weight: 1 }] },
      { id: 'c-none', type: 'entity' as const, fields: [{ text: 'gamma', weight: 3 }] },
    ];
    expect(search(synthetic, 'alpha').map((h) => h.id)).toEqual(['a-name', 'b-desc']);
    // Every query word plus the exact phrase outranks a single-word name match.
    expect(search(synthetic, 'alpha beta').map((h) => h.id)).toEqual(['b-desc', 'a-name']);
  });

  it('is deterministic and empty for empty queries', () => {
    expect(search(index, '  ')).toEqual([]);
    expect(search(index, 'energy')).toEqual(search(index, 'energy'));
  });
});

describe('chat context (PARAM-123)', () => {
  const turns: ChatTurn[] = Array.from({ length: 7 }, (_, i) => ({ q: `q${i}`, a: `a${i}`, citations: [], reasons: [] }));

  it('keeps only the last 5 question-answer pairs', () => {
    expect(contextWindow(turns).map((t) => t.q)).toEqual(['q2', 'q3', 'q4', 'q5', 'q6']);
    const p = chatPrompt('new', turns);
    expect(p).not.toContain('q1');
    expect(p).toContain('q2');
    expect(p.endsWith('Q: new')).toBe(true);
    expect(pairsInPrompt(p)).toBe(5);
    expect(pairsInPrompt(chatPrompt('first', []))).toBe(0);
  });

  it('answers with a mock grounded in the hits, internal ones included (D-2)', async () => {
    const grounding = ['issue-lead-time', 'deal-tsubasa-cobot'].map((id) => loaded.byId.get(id)!);
    const r = await aiComplete({ use: 'chat', lang: 'en', prompt: chatPrompt('lead time?', turns), entities: grounding });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toContain('c03NotApproved');
    expect(r.text).toContain('Long order-to-ship lead time');
    expect(r.text).toContain('Co-developed'); // internal deal: since D-2 a real model could receive it, so the mock may show it
    expect(r.text).toContain('last 5 pairs');
    expect(JAPANESE.test(r.text)).toBe(false);
  });
});

describe('Copilot analysis proposals (FR-279〜281)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAiOverrides.getState().reset();
  });

  const components = componentsForRoute('/');
  const mk = async (): Promise<Proposal[]> => {
    const r = await aiComplete({ use: 'review', lang: 'ja', prompt: reviewPrompt('ja', '/', components), entities: entitiesOfComponents(components) });
    expect(r.mode).toBe('mock');
    return parseProposals(r.text, components)!;
  };

  it('the mock returns one proposal per component', async () => {
    const ps = await mk();
    expect(ps.map((p) => p.componentId)).toEqual(['kpi', 'issue', 'solution']);
    expect(ps.every((p) => p.text.length > 0 && p.status === 'proposed')).toBe(true);
    expect(parseProposals('not json', components)).toBeNull();
  });

  it('applies edited proposals, skips discarded ones, and undoes the apply', async () => {
    const ps = await mk();
    ps[0] = { ...ps[0]!, text: 'edited KPI proposal', status: 'editing' };
    ps[2] = { ...ps[2]!, status: 'discarded' };
    const r = commitApply('/', ps, new Date('2026-11-09T00:00:00Z'));
    expect(r.ok && r.appliedIds).toEqual(['kpi', 'issue']);
    const after = useAiOverrides.getState().value;
    expect(after.overrides[overrideKey('/', 'kpi')]!.text).toBe('edited KPI proposal');
    expect(after.overrides[overrideKey('/', 'solution')]).toBeUndefined();
    expect(undoLastApply()).toBe(true);
    expect(useAiOverrides.getState().value.overrides).toEqual({});
    expect(undoLastApply()).toBe(false);
  });

  it('is all-or-nothing: an empty proposal blocks the whole apply', async () => {
    const ps = await mk();
    ps[1] = { ...ps[1]!, text: '  ' };
    const r = applyProposals({}, '/', ps, new Date());
    expect(r).toEqual({ ok: false, reason: 'empty', componentIds: ['issue'] });
    expect(commitApply('/', ps).ok).toBe(false);
    expect(useAiOverrides.getState().value.undo).toEqual([]);
    expect(applyProposals({}, '/', ps.map((p) => ({ ...p, status: 'discarded' as const })), new Date())).toMatchObject({ ok: false, reason: 'nothing' });
  });
});

describe('explain fallback (FR-274/277)', () => {
  it('links issues to solutions and KPIs; the mock sees what a live send would (internal included, D-2)', async () => {
    const ents = entitiesOfComponents(componentsForRoute('/'));
    const x = buildExplanation(ents);
    const lead = x.issues.find((i) => i.issue.id === 'issue-lead-time')!;
    expect(lead.solutions.length).toBeGreaterThan(0);
    expect(lead.kpis.map((k) => k.id)).toContain('kpi-lead-time');
    expect(x.issues[0]!.issue.impact).toBeGreaterThanOrEqual(x.issues.at(-1)!.issue.impact);
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', entities: ents });
    expect(r.mode).toBe('mock');
    expect(r.text).toContain('Long order-to-ship lead time');
    expect(r.text).toContain('Transferring expert skills'); // internal issue (D-2)
    expect(JAPANESE.test(r.text)).toBe(false);
  });

  it('entity routes explain the focus and its neighbours', () => {
    const c = componentsForRoute('/entity/issue-lead-time');
    expect(c[0]).toMatchObject({ id: 'focus', entityIds: ['issue-lead-time'] });
    expect(c[1]!.entityIds.length).toBeGreaterThan(0);
  });
});


const CONNECTION = { endpoint: 'https://res.openai.azure.com', deployment: 'gpt', apiVersion: '2024-10-21' };
const READY = { liveEnabled: true, relayConnection: CONNECTION, foundryKeySaved: true, priceInputPerM: '1000', priceOutputPerM: '4000' };
const OFF = {
  liveEnabled: false, endpoint: '', deployment: '', foundryKeySaved: false, relayConnection: null, provider: 'foundry' as const, authMethod: 'apiKey' as const,
  priceInputPerM: '', priceOutputPerM: '', monthlyBudgetJpy: DEFAULT_MONTHLY_BUDGET_JPY,
};

describe('settings provider wiring (FR-132, FR-275, D-1, D-3)', () => {
  let calls: LiveCall[];
  beforeEach(() => {
    localStorage.clear();
    useAiSettings.setState(OFF);
    calls = [];
    setLiveTransport(async (c) => {
      calls.push(c);
      return { text: 'live answer', inputTokens: 1000, outputTokens: 500 };
    });
  });
  afterEach(() => setLiveTransport(null));

  it('is off and unconfigured by default, with the 100,000 JPY budget and no prices, so nothing is sent', async () => {
    expect(runtimeSettings()).toEqual({ liveEnabled: false, configured: false, monthlyBudgetJpy: 100_000, prices: null });
    const r = await aiComplete({ use: 'explain', lang: 'ja', prompt: 'x' });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toEqual(expect.arrayContaining(['liveDisabled', 'notConfigured', 'notConfirmed', 'noUnitPrice']));
    expect(r.blockedReasons).not.toContain('c03NotApproved'); // D-1: "explain" is approved
    expect(calls).toHaveLength(0);
  });

  it('feeds the unit prices (PARAM-130) and the single budget to the core', () => {
    useAiSettings.setState({ ...READY, monthlyBudgetJpy: 5000 });
    expect(runtimeSettings()).toEqual({ liveEnabled: true, configured: true, monthlyBudgetJpy: 5000, prices: { inputPerM: 1000, outputPerM: 4000 } });
    useAiSettings.setState({ priceOutputPerM: '0' });
    expect(runtimeSettings().prices).toBeNull();
    expect(liveReady(useAiSettings.getState())).toBe(false);
  });

  it('unapproved uses stay mock even when everything is configured (C-03)', async () => {
    useAiSettings.setState(READY);
    const r = await aiComplete({ use: 'chat', lang: 'ja', prompt: 'x', userConfirmed: true, personConfirmed: true });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toEqual(['c03NotApproved']);
    expect(calls).toHaveLength(0);
  });

  it('"explain" goes live only after confirmation, sends internal items (D-2) and records the actual cost', async () => {
    useAiSettings.setState(READY);
    const entities = entitiesOfComponents(componentsForRoute('/'));
    const req = { use: 'explain' as const, lang: 'en' as const, prompt: 'Explain', entities };
    const pf = preflight({ ...req, userConfirmed: true, personConfirmed: true });
    expect(pf.allowed).toBe(true);
    expect(pf.internalCount).toBeGreaterThan(0);
    expect(pf.estimatedCostJpy).toBeCloseTo(((pf.estimatedInputTokens * 1000 + 1500 * 4000) / 1_000_000) * 1.2);
    expect((await aiComplete(req)).blockedReasons).toEqual(['notConfirmed']);
    expect(calls).toHaveLength(0);

    const r = await aiComplete({ ...req, userConfirmed: true, personConfirmed: true });
    expect(r).toMatchObject({ mode: 'live', text: 'live answer', blockedReasons: [] });
    expect(r.costJpy).toBeCloseTo((1000 * 1000 + 500 * 4000) / 1_000_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toContain('Transferring expert skills');
    expect(calls[0]!.maxOutputTokens).toBe(1500);
    const ledger = readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ use: 'explain', inputTokens: 1000, outputTokens: 500 });
    expect(JSON.stringify(ledger)).not.toContain('Explain'); // prompts and answers are never recorded

    // D-3: a 1 JPY budget stops the next send before it reaches the transport.
    useAiSettings.setState({ monthlyBudgetJpy: 1 });
    const blocked = await aiComplete({ ...req, userConfirmed: true, personConfirmed: true });
    expect(blocked.mode).toBe('mock');
    expect(blocked.blockedReasons).toContain('budget');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the mock with "liveFailed" when the transport fails, and records nothing', async () => {
    useAiSettings.setState(READY);
    setLiveTransport(async () => { throw new Error('relay 502'); });
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'x', userConfirmed: true, personConfirmed: true });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toEqual(['liveFailed']);
    expect(readLedger()).toEqual([]);
  });

  it('"configured" means endpoint, deployment and key are saved in the relay; Copilot SDK and Entra ID never count (C-07)', () => {
    const s = { relayConnection: CONNECTION, foundryKeySaved: true };
    expect(isConfigured({ ...s, provider: 'copilotSdk', authMethod: 'apiKey' })).toBe(false);
    expect(isConfigured({ ...s, provider: 'foundry', authMethod: 'entraId' })).toBe(false);
    expect(isConfigured({ ...s, provider: 'foundry', authMethod: 'apiKey' })).toBe(true);
    expect(isConfigured({ ...s, relayConnection: null, provider: 'foundry', authMethod: 'apiKey' })).toBe(false);
    expect(isConfigured({ ...s, foundryKeySaved: false, provider: 'foundry', authMethod: 'apiKey' })).toBe(false);
  });

  it('never persists key values; persists one budget (the v1 review budget is dropped)', async () => {
    useAiSettings.getState().update({ endpoint: 'https://e', monthlyBudgetJpy: 2500 });
    const raw = localStorage.getItem('bas.ai.settings') ?? '';
    expect(raw).toContain('https://e');
    expect(raw).toContain('"monthlyBudgetJpy":2500');
    expect(raw).not.toContain('KeySaved');
    expect(raw).not.toContain('relayConnection');
    localStorage.setItem('bas.ai.settings', JSON.stringify({ state: { endpoint: 'https://old', reviewBudgetJpy: 7 }, version: 1 }));
    await useAiSettings.persist.rehydrate();
    expect(useAiSettings.getState().endpoint).toBe('https://old');
    expect('reviewBudgetJpy' in useAiSettings.getState()).toBe(false);
  });

  it('accepts only whole JPY ≥ 0 as the budget', () => {
    expect(parseBudget('100000')).toBe(100_000);
    expect(parseBudget('0')).toBe(0);
    for (const bad of ['', '-1', '1.5', 'abc', '1e3']) expect(parseBudget(bad), bad).toBeNull();
  });
});

describe('legacy Foundry settings (D-6, P-01)', () => {
  const legacy = { endpoint: 'https://legacy.openai.azure.com', deployment: 'old', authMethod: 'apiKey' };
  const fetchSpy = vi.fn();
  const transportSpy = vi.fn();
  const common = () => {
    const s = useAiSettings.getState();
    return { endpoint: s.endpoint, deployment: s.deployment, authMethod: s.authMethod };
  };
  beforeEach(() => {
    localStorage.clear();
    useAiSettings.setState(OFF);
    fetchSpy.mockReset();
    transportSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    setLiveTransport(transportSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setLiveTransport(null);
    // ⑦: in every state, nothing went out and nothing was enabled.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(transportSpy).not.toHaveBeenCalled();
    expect(useAiSettings.getState().liveEnabled).toBe(false);
  });

  it('none: no legacy record and no common connection', () => {
    expect(readLegacyFoundry()).toBeNull();
    expect(legacyState(readLegacyFoundry(), common())).toEqual({ kind: 'none' });
  });

  it('legacy only: offered as a candidate, copied only by the explicit action, live stays off, the record stays', async () => {
    localStorage.setItem(LEGACY_FOUNDRY_KEY, JSON.stringify(legacy));
    const before = localStorage.getItem(LEGACY_FOUNDRY_KEY);
    const st = legacyState(readLegacyFoundry(), common());
    expect(st).toEqual({ kind: 'legacyOnly', legacy });
    expect(useAiSettings.getState().endpoint).toBe(''); // never auto-copied
    useAiSettings.setState({ liveEnabled: true });
    useAiSettings.getState().update(copyLegacyPatch(readLegacyFoundry()!));
    expect(common()).toEqual(legacy);
    expect(useAiSettings.getState().liveEnabled).toBe(false);
    expect(useAiSettings.getState().relayConnection).toBeNull(); // saving in the relay is a separate action
    expect(localStorage.getItem(LEGACY_FOUNDRY_KEY)).toBe(before);
    expect(legacyState(readLegacyFoundry(), common()).kind).toBe('same');
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'x', userConfirmed: true, personConfirmed: true });
    expect(r.mode).toBe('mock');
  });

  it('common only', () => {
    useAiSettings.setState({ endpoint: 'https://res.openai.azure.com', deployment: 'gpt' });
    expect(legacyState(readLegacyFoundry(), common())).toEqual({ kind: 'commonOnly' });
  });

  it('both differ: the common one wins and the difference is shown; deleting the common one leaves the legacy one', () => {
    localStorage.setItem(LEGACY_FOUNDRY_KEY, JSON.stringify({ ...legacy, authMethod: 'entraId' }));
    useAiSettings.setState({ endpoint: 'https://res.openai.azure.com', deployment: 'old' });
    const st = legacyState(readLegacyFoundry(), common());
    expect(st).toMatchObject({ kind: 'differ', fields: ['endpoint', 'authMethod'] });
    expect(useAiSettings.getState().endpoint).toBe('https://res.openai.azure.com');
    useAiSettings.setState({ endpoint: '', deployment: '' });
    expect(legacyState(readLegacyFoundry(), common()).kind).toBe('legacyOnly');
    expect(localStorage.getItem(LEGACY_FOUNDRY_KEY)).not.toBeNull();
  });

  it('ignores malformed legacy records', () => {
    for (const raw of ['not json', '{}', JSON.stringify({ ...legacy, authMethod: 'password' })]) {
      localStorage.setItem(LEGACY_FOUNDRY_KEY, raw);
      expect(readLegacyFoundry(), raw).toBeNull();
    }
  });
});

describe('usage and limits (FR-276, NFR-COST-001, D-3, D-7, PARAM-121/122)', () => {
  beforeEach(() => localStorage.clear());

  it('summarizes the ledger against the single monthly budget with warn/stop levels', () => {
    const now = new Date('2026-11-20T03:00:00Z');
    const rec = (use: string, costJpy: number, at = '2026-11-20T01:00:00Z') => ({ at, use, inputTokens: 0, outputTokens: 0, costJpy });
    const s = usageSummary([rec('explain', 0), rec('chat', 0), rec('review', 85_000), rec('review', 99, '2026-10-01T00:00:00Z')], now, 100_000);
    expect(s).toEqual({ todayCalls: 2, dailyLimit: 30, monthSpentJpy: 85_000, monthBudgetJpy: 100_000, monthLevel: 'warn' });
    expect(usageSummary([rec('explain', 50_000)], now, 50_000).monthLevel).toBe('stop');
    expect(usageSummary([], now, 0).monthLevel).toBe('stop');
  });

  it('deletes records older than 13 months only when asked (D-7)', () => {
    const now = new Date('2026-11-20T03:00:00Z');
    const rec = (at: string) => ({ at, use: 'explain', inputTokens: 1, outputTokens: 1, costJpy: 1 });
    writeLedger([rec('2025-10-31T14:59:00Z'), rec('2025-10-31T15:00:00Z'), rec('2026-11-01T00:00:00Z')]);
    expect(expiredUsageCount(now)).toBe(1); // 2025-10 JST is outside; 2025-11 JST (15:00Z on 10/31) is kept
    expect(readLedger()).toHaveLength(3);
    expect(deleteExpiredUsage(now)).toBe(1);
    expect(readLedger().map((r) => r.at)).toEqual(['2025-10-31T15:00:00Z', '2026-11-01T00:00:00Z']);
    expect(deleteExpiredUsage(now)).toBe(0);
  });

  it('caps input at 8000 characters and times out after 60 s', async () => {
    expect(USAGE_MAX_CHARS).toBe(8000);
    expect(USAGE_TIMEOUT_MS).toBe(60_000);
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(1), 50)).resolves.toBe(1);
    const r = await aiComplete({ use: 'aiUsageAnalysis', lang: 'en', prompt: 'We answer customer inquiry emails and read invoice documents.' });
    expect(r.text).toMatch(/inquiries|documents/);
  });
});

describe('applied proposals on their screen (I-2)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAiOverrides.getState().reset();
  });

  it('lists the route\'s applied proposals with before → after, and Undo restores the previous state', () => {
    const p = (componentId: string, text: string): Proposal => ({ componentId, label: 'kind.kpi', text, original: text, status: 'proposed' });
    commitApply('/', [p('kpi', 'first')], new Date('2026-11-09T00:00:00Z'));
    commitApply('/plan', [p('initiative', 'other route')]);
    commitApply('/', [p('kpi', 'second'), p('issue', 'issue text')], new Date('2026-11-10T00:00:00Z'));
    const diffs = appliedForRoute(useAiOverrides.getState().value, '/');
    expect(diffs.map((d) => [d.componentId, d.before, d.after])).toEqual([['kpi', 'first', 'second'], ['issue', null, 'issue text']]);
    expect(appliedForRoute(useAiOverrides.getState().value, '/plan').map((d) => [d.before, d.after])).toEqual([[null, 'other route']]);
    expect(undoLastApply()).toBe(true);
    expect(appliedForRoute(useAiOverrides.getState().value, '/').map((d) => [d.componentId, d.before, d.after])).toEqual([['kpi', null, 'first']]);
  });
});
