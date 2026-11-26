import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiLiveError, aiComplete, aiLive, preflight, readLedger, setLiveTransport, writeLedger, type LiveCall } from '../src/ai/client.ts';
import { workIqRequiredFor } from '../src/ai/policy.ts';
import { useAiSettings, connectionDraftProblem, connectionTestPreflight, isConfigured, isMediaConfigured, isSpeechReady, liveReady, runtimeSettings, workIqReady } from '../src/modules/ai/settingsStore.ts';
import { LEGACY_FOUNDRY_KEY, copyLegacyPatch, legacyState, readLegacyFoundry } from '../src/modules/ai/legacy.ts';
import '../src/modules/ai/mocks.ts';
import {
  appliedForRoute, applyProposals, commitApply, parseProposals, reviewPrompt, undoLastApply, useAiOverrides, overrideKey, type Proposal,
} from '../src/modules/ai/review.ts';
import { buildExplanation, componentsForRoute, entitiesOfComponents } from '../src/modules/ai/explain.ts';
import { dailyUsage } from '../src/modules/ai/ledger.ts';

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/;

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
const READY = { liveEnabled: true, sendConsent: true, relayConnection: CONNECTION, connectionVerifiedAt: '2026-11-10T00:00:00Z', foundryKeySaved: true };
const OFF = {
  liveEnabled: false, sendConsent: false, endpoint: '', deployment: '', foundryKeySaved: false, relayConnection: null, connectionVerifiedAt: null, provider: 'foundry' as const, authMethod: 'apiKey' as const,
};

describe('settings provider wiring (FR-132, FR-275, D-1)', () => {
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

  it('requires retrieval evidence for Work IQ with either allowed provider, but makes it mandatory only for Foundry', () => {
    const workiq = { method: 'app' as const, tenantId: 'tenant', clientId: 'client', account: null, signedIn: true, verifiedAt: null };
    expect(workIqReady({ provider: 'foundry', workiq })).toBe(false);
    const verified = { ...workiq, verifiedAt: '2026-11-11T05:00:00.000Z' };
    expect(workIqReady({ provider: 'foundry', workiq: verified })).toBe(true);
    expect(workIqReady({ provider: 'copilotSdk', workiq: verified })).toBe(true);
    expect(workIqReady({ provider: 'copilotSdk', workiq })).toBe(false);
    expect([workIqRequiredFor('foundry'), workIqRequiredFor('copilotSdk')]).toEqual([true, false]);
    expect(workIqReady({ provider: 'foundry', workiq: { ...verified, signedIn: false } })).toBe(false);
  });

  it('accepts project URLs and v1 formats, and guards the diagnostic interval before sending', () => {
    expect(connectionDraftProblem({ ...CONNECTION, endpoint: 'https://resource.services.ai.azure.com/api/projects/project' })).toBeNull();
    expect(connectionDraftProblem({ ...CONNECTION, endpoint: 'https://resource.services.ai.azure.com/openai/v1/' })).toBeNull();
    writeLedger([]);
    expect(connectionTestPreflight().budget.allowed).toBe(true);
    writeLedger([{ at: new Date().toISOString(), use: 'connectionTest', inputTokens: 1, outputTokens: 1 }]);
    expect(connectionTestPreflight().budget).toMatchObject({ allowed: false, reasons: ['tooSoon'] });
    writeLedger([]);
  });

  it('refuses a diagnostic inside the minimum interval without network access', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      writeLedger([{ at: new Date().toISOString(), use: 'connectionTest', inputTokens: 1, outputTokens: 1 }]);
      useAiSettings.setState({ ...READY });
      expect(await useAiSettings.getState().saveConnection()).toEqual({ ok: false, error: 'budget' });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); writeLedger([]); }
  });

  it.each([
    ['dnsFailure', 0], ['unauthorized', 0], ['timeout', 1], ['badProviderResponse', 1],
  ] as const)('records diagnostic %s honestly without marking it verified', async (error, records) => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/relay/session') return new Response('{"token":"test-session"}');
      if (url === '/relay/status') return new Response(JSON.stringify({ connection: CONNECTION, secrets: { foundryKey: true }, connectionVerifiedAt: null }));
      return new Response(JSON.stringify({ error }), { status: 502 });
    });
    try {
      useAiSettings.setState({ ...READY, ...CONNECTION });
      expect(await useAiSettings.getState().saveConnection()).toMatchObject({ ok: false, error });
      expect(readLedger()).toHaveLength(records);
      if (records) expect(readLedger()[0]).toMatchObject({ estimated: true });
      expect(isConfigured(useAiSettings.getState())).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('records actual diagnostic usage and refreshes persisted verification', async () => {
    const at = new Date().toISOString();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/relay/session') return new Response('{"token":"test-session"}');
      const status = { connection: CONNECTION, connectionVerifiedAt: at };
      return new Response(JSON.stringify(url === '/relay/status'
        ? { ...status, secrets: { foundryKey: true } }
        : { ...status, usage: { inputTokens: 30, outputTokens: 1 } }));
    });
    try {
      useAiSettings.setState({ ...READY, ...CONNECTION });
      expect(await useAiSettings.getState().saveConnection()).toMatchObject({ ok: true });
      expect(isConfigured(useAiSettings.getState())).toBe(true);
      expect(readLedger()).toHaveLength(1);
      expect(readLedger()[0]).toMatchObject({ use: 'connectionTest', inputTokens: 30, outputTokens: 1 });
      expect(readLedger()[0]).not.toHaveProperty('estimated');
    } finally { spy.mockRestore(); }
  });

  it('is off and unconfigured by default, so nothing is sent', async () => {
    expect(runtimeSettings()).toEqual({ provider: 'foundry', liveEnabled: false, sendConsent: false, configured: false });
    const r = await aiComplete({ use: 'explain', lang: 'ja', prompt: 'x' });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toEqual(expect.arrayContaining(['liveDisabled', 'notConfigured', 'notConfirmed']));
    expect(calls).toHaveLength(0);
  });

  it('keeps Foundry ready without any pricing or budget input', () => {
    useAiSettings.setState({ ...READY });
    expect(runtimeSettings()).toEqual({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true });
    expect(liveReady(useAiSettings.getState())).toBe(true);
  });

  it('Copilot is ready without any pricing input', () => {
    useAiSettings.setState({
      ...READY, provider: 'copilotSdk', copilotModel: 'claude-opus',
      copilotStatus: { reachable: true, available: true, authenticated: true, login: 'u', error: null, model: 'claude-opus', models: [{ id: 'claude-opus', name: 'Opus', multiplier: 10 }] },
    });
    expect(runtimeSettings()).toMatchObject({ provider: 'copilotSdk', configured: true });
    expect(liveReady(useAiSettings.getState())).toBe(true);
    useAiSettings.setState({ provider: 'foundry', copilotModel: null, copilotStatus: null });
  });

  it('revoking consent disables live mode, and changing provider requires new consent', () => {
    useAiSettings.setState({ ...READY, provider: 'foundry' });
    useAiSettings.getState().update({ sendConsent: false });
    expect(useAiSettings.getState()).toMatchObject({ sendConsent: false, liveEnabled: false });

    useAiSettings.setState({ ...READY, liveEnabled: true });
    useAiSettings.getState().update({ provider: 'copilotSdk' });
    expect(useAiSettings.getState()).toMatchObject({ provider: 'copilotSdk', sendConsent: false, liveEnabled: false });
    expect(liveReady(useAiSettings.getState())).toBe(false);
  });

  it('FR-311 aiLive never answers with a mock: a Copilot answer records the reported tokens', async () => {
    writeLedger([]);
    await expect(aiLive({ use: 'packBuild', lang: 'ja', prompt: 'x' })).rejects.toBeInstanceOf(AiLiveError);
    useAiSettings.setState({ ...READY, provider: 'copilotSdk', copilotModel: 'gpt-5', copilotStatus: null });
    const seenCalls: LiveCall[] = [];
    setLiveTransport(async (c) => { seenCalls.push(c); return { text: '{}', inputTokens: 10, outputTokens: 20 }; });
    const r = await aiLive({ use: 'packBuild', lang: 'ja', prompt: 'x', maxOutputTokens: 16000 });
    expect(r).toEqual({ text: '{}', inputTokens: 10, outputTokens: 20 });
    expect(seenCalls[0]).toMatchObject({ use: 'packBuild', provider: 'copilotSdk', maxOutputTokens: 16000 });
    expect(readLedger()).toEqual([expect.objectContaining({ use: 'packBuild', inputTokens: 10, outputTokens: 20 })]);
    await expect(aiLive({ use: 'explain', lang: 'ja', prompt: 'x' })).resolves.toMatchObject({ text: '{}' });
    setLiveTransport(async () => { throw new Error('relay 503 notSignedIn'); });
    await expect(aiLive({ use: 'packBuild', lang: 'ja', prompt: 'x' })).rejects.toMatchObject({ reasons: ['liveFailed'], message: 'relay 503 notSignedIn' });
    useAiSettings.setState({ provider: 'foundry', copilotModel: null });
    writeLedger([]);
  });

  it('a cancelled Copilot call that may already have used tokens is recorded as an estimate', async () => {
    writeLedger([]);
    useAiSettings.setState({ ...READY, provider: 'copilotSdk', copilotModel: 'gpt-5', copilotStatus: null });
    const ac = new AbortController();
    setLiveTransport(async (_c, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const pending = aiLive({ use: 'packBuild', lang: 'ja', prompt: 'x' }, ac.signal);
    ac.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiLiveError);
    expect(readLedger()).toEqual([expect.objectContaining({ use: 'packBuild', outputTokens: 0, estimated: true })]);
    useAiSettings.setState({ provider: 'foundry', copilotModel: null });
    writeLedger([]);
  });

  it('"explain" uses saved settings consent and records the reported tokens', async () => {
    useAiSettings.setState(READY);
    const entities = entitiesOfComponents(componentsForRoute('/'));
    const req = { use: 'explain' as const, lang: 'en' as const, prompt: 'Explain', entities };
    useAiSettings.setState({ sendConsent: false });
    const pf = preflight(req);
    expect(pf.allowed).toBe(false);
    expect(pf.reasons).toContain('notConfirmed');
    expect(pf.internalCount).toBeGreaterThan(0);
    expect((await aiComplete(req)).blockedReasons).toContain('notConfirmed');
    expect(calls).toHaveLength(0);

    useAiSettings.setState({ sendConsent: true });
    const r = await aiComplete(req);
    expect(r).toMatchObject({ mode: 'live', text: 'live answer', blockedReasons: [] });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toContain('Transferring expert skills');
    expect(calls[0]!.maxOutputTokens).toBe(1500);
    const ledger = readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ use: 'explain', inputTokens: 1000, outputTokens: 500 });
    expect(JSON.stringify(ledger)).not.toContain('Explain'); // prompts and answers are never recorded

    // The daily call limit still stops sending.
    writeLedger(Array.from({ length: 30 }, () => ({ at: new Date().toISOString(), use: 'explain', inputTokens: 1, outputTokens: 1 })));
    const blocked = await aiComplete({ ...req });
    expect(blocked.mode).toBe('mock');
    expect(blocked.blockedReasons).toContain('budget');
    expect(calls).toHaveLength(1);
  });

  it('records an interrupted Foundry call as an estimate, and retains quota enforcement', async () => {
    useAiSettings.setState(READY);
    setLiveTransport(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    await expect(aiLive({ use: 'explain', lang: 'en', prompt: 'x' }))
      .rejects.toMatchObject({ reasons: ['liveFailed'] });
    expect(readLedger()).toEqual([expect.objectContaining({ use: 'explain', outputTokens: 0, estimated: true })]);
    expect(preflight({ use: 'explain', lang: 'en', prompt: 'x' }).budget.reasons).toContain('tooSoon');
  });

  it('falls back to the mock with "liveFailed" when the transport fails, and records nothing', async () => {
    useAiSettings.setState(READY);
    setLiveTransport(async () => { throw new Error('relay 502'); });
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'x' });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toEqual(['liveFailed']);
    expect(readLedger()).toEqual([]);
  });

  it('"configured" means the relay holds what it needs: a Foundry connection verified with its saved authentication (key, or the signed-in Entra ID account), or (D-12) a Copilot model', () => {
    const s = { relayConnection: CONNECTION, foundryKeySaved: true, connectionVerifiedAt: '2026-11-10T00:00:00Z' };
    expect(isConfigured({ ...s, provider: 'copilotSdk', authMethod: 'apiKey' })).toBe(false);
    expect(isConfigured({ ...s, provider: 'copilotSdk', authMethod: 'apiKey', copilotModel: 'gpt-5' })).toBe(true);
    expect(isConfigured({ relayConnection: null, foundryKeySaved: false, provider: 'copilotSdk', authMethod: 'entraId', copilotModel: 'gpt-5' })).toBe(true);
    expect(isConfigured({ ...s, provider: 'foundry', authMethod: 'entraId' })).toBe(false);
    const entraConn = { ...CONNECTION, auth: 'entraId' as const, tenantId: '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a' };
    const signedIn = { signedIn: true, account: 'user@example.com', tenantId: entraConn.tenantId, signIn: 'idle' as const };
    expect(isConfigured({ ...s, relayConnection: entraConn, foundryKeySaved: false, provider: 'foundry', authMethod: 'entraId', entra: signedIn })).toBe(true);
    expect(isConfigured({ ...s, relayConnection: entraConn, provider: 'foundry', authMethod: 'entraId', entra: { ...signedIn, signedIn: false } })).toBe(false);
    expect(isConfigured({ ...s, relayConnection: entraConn, provider: 'foundry', authMethod: 'apiKey', entra: signedIn })).toBe(false);
    expect(isConfigured({ ...s, provider: 'foundry', authMethod: 'apiKey' })).toBe(true);
    expect(isConfigured({ ...s, provider: 'foundry', authMethod: 'apiKey', connectionVerifiedAt: null })).toBe(false);
    expect(isConfigured({ ...s, relayConnection: null, provider: 'foundry', authMethod: 'apiKey' })).toBe(false);
    expect(isConfigured({ ...s, foundryKeySaved: false, provider: 'foundry', authMethod: 'apiKey' })).toBe(false);
  });

  it('never persists key values, and drops the retired budget settings', async () => {
    useAiSettings.getState().update({ endpoint: 'https://e' });
    const raw = localStorage.getItem('bas.ai.settings') ?? '';
    expect(raw).toContain('https://e');
    expect(raw).not.toContain('monthlyBudgetJpy');
    expect(raw).not.toContain('KeySaved');
    expect(raw).not.toContain('relayConnection');
    localStorage.setItem('bas.ai.settings', JSON.stringify({ state: { endpoint: 'https://old', reviewBudgetJpy: 7, monthlyBudgetJpy: 500 }, version: 6 }));
    await useAiSettings.persist.rehydrate();
    expect(useAiSettings.getState().endpoint).toBe('https://old');
    expect('reviewBudgetJpy' in useAiSettings.getState()).toBe(false);
    expect('monthlyBudgetJpy' in useAiSettings.getState()).toBe(false);
  });

  it.each([2, 3])('migrates away old prices from version %i without losing the connection', async (version) => {
    localStorage.setItem('bas.ai.settings', JSON.stringify({
      version,
      state: { ...CONNECTION, priceInputPerM: '1000', priceOutputPerM: '4000', copilotPricePerRequest: '6' },
    }));
    await useAiSettings.persist.rehydrate();
    expect(useAiSettings.getState()).toMatchObject(CONNECTION);
    expect(useAiSettings.getState()).not.toHaveProperty('copilotPricePerRequest');
    expect(useAiSettings.getState()).not.toHaveProperty('priceInputPerM');
    expect(useAiSettings.getState()).not.toHaveProperty('priceOutputPerM');
    const saved = JSON.parse(localStorage.getItem('bas.ai.settings')!);
    expect(saved.version).toBe(7);
    expect(saved.state).not.toHaveProperty('copilotPricePerRequest');
    expect(saved.state).not.toHaveProperty('priceInputPerM');
    expect(saved.state).not.toHaveProperty('priceOutputPerM');
  });

  it.each([4, 5])('drops the v%i Speech / Vision fields: both now use the Foundry connection (FR-328)', async (version) => {
    localStorage.setItem('bas.ai.settings', JSON.stringify({ version, state: {
      ...CONNECTION, speechEndpoint: 'https://bas-speech.cognitiveservices.azure.com', speechRegion: 'japaneast',
      mediaDraft: { speech: { auth: 'apiKey', endpoint: 'https://bas-speech.cognitiveservices.azure.com' } },
    } }));
    await useAiSettings.persist.rehydrate();
    expect(useAiSettings.getState()).toMatchObject(CONNECTION);
    for (const field of ['speechEndpoint', 'speechRegion', 'mediaDraft']) expect(useAiSettings.getState()).not.toHaveProperty(field);
    const saved = JSON.parse(localStorage.getItem('bas.ai.settings')!);
    expect(saved.version).toBe(7);
    expect(JSON.stringify(saved.state)).not.toContain('bas-speech');
  });

  it('treats Speech / Vision as configured only after the relay verified them on the Foundry resource, and for Entra ID with a signed-in account (FR-328)', () => {
    const media = { endpoint: 'https://bas.cognitiveservices.azure.com', auth: 'entraId' as const, unavailable: null, verifiedAt: { speech: '2026-11-11T00:00:00Z', vision: null } };
    expect(isMediaConfigured({ media, entra: { signedIn: true } as never }, 'speech')).toBe(true);
    expect(isMediaConfigured({ media, entra: { signedIn: false } as never }, 'speech')).toBe(false);
    expect(isMediaConfigured({ media, entra: { signedIn: true } as never }, 'vision')).toBe(false);
    expect(isMediaConfigured({ media: { ...media, auth: 'apiKey' }, entra: null }, 'speech')).toBe(true);
    expect(isMediaConfigured({ media: { ...media, endpoint: null, auth: null, unavailable: 'noConnection' }, entra: { signedIn: true } as never }, 'speech')).toBe(false);
  });

  it('uses only the Foundry Speech verification even if an old relay reports a separate route', () => {
    const media = { endpoint: 'https://bas.cognitiveservices.azure.com', auth: 'apiKey' as const, unavailable: null, verifiedAt: { speech: '2026-11-11T00:00:00Z', vision: null } };
    const separate = { auth: 'apiKey' as const, endpoint: null, region: 'japaneast', verifiedAt: '2026-11-19T00:00:00Z' };
    expect(isSpeechReady({ media, entra: null, speechConnection: { route: 'foundry', eligible: true, separate } })).toBe(true);
    expect(isSpeechReady({ media, entra: null, speechConnection: { route: 'separate', eligible: true, separate } })).toBe(true);
    expect(isSpeechReady({ media: { ...media, verifiedAt: { speech: null, vision: null } }, entra: null, speechConnection: { route: 'separate', eligible: true, separate } })).toBe(false);
    expect(isSpeechReady({ media: { ...media, auth: 'entraId' }, entra: { signedIn: false } as never, speechConnection: { route: 'separate', eligible: true, separate } })).toBe(false);
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
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'x' });
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

describe('usage and limits (FR-276, PARAM-121/122)', () => {
  beforeEach(() => localStorage.clear());

  it('counts only today explain and chat calls against the daily limit; old records with a cost still load', () => {
    const now = new Date('2026-11-20T03:00:00Z');
    const rec = (use: string, at = '2026-11-20T01:00:00Z') => ({ at, use, inputTokens: 0, outputTokens: 0, costJpy: 85_000 });
    writeLedger([rec('explain'), rec('chat'), rec('review'), rec('explain', '2026-10-01T00:00:00Z')]);
    expect(dailyUsage(readLedger(), now)).toEqual({ todayCalls: 2, dailyLimit: 30 });
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
