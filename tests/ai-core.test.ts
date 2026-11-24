import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AI_USES, AI_LIMITS, PER_USE_LIMITS } from '../src/ai/policy.ts';
import { checkBudget, jstDay, estimateTokens, type UsageRecord } from '../src/ai/budget.ts';
import { evaluateGate } from '../src/ai/gate.ts';
import { selectOutbound } from '../src/ai/redact.ts';
import { aiComplete, preflight, readLedger, registerMock, setLiveTransport, setRuntimeSettingsProvider, type LiveCall } from '../src/ai/client.ts';
import { loaded } from '../src/data/pack.ts';

const okBudget = checkBudget([], new Date('2026-11-09T00:00:00Z'), { use: 'explain', estimatedInputTokens: 10, maxOutputTokens: 100 });
const allTrue = { liveEnabled: true, sendConsent: true, configured: true, budget: okBudget };

describe('AI send gate', () => {
  it('uses the same global consent gate for every AI use', () => {
    setRuntimeSettingsProvider(() => ({ provider: 'copilotSdk', liveEnabled: true, sendConsent: true, configured: true }));
    for (const use of AI_USES) {
      expect(preflight({ use, lang: 'en', prompt: '' }).allowed, use).toBe(true);
    }
  });

  it('requires live mode, saved consent, a configured provider and the safety limits', () => {
    expect(evaluateGate(allTrue).allowed).toBe(true);
    expect(evaluateGate({ ...allTrue, liveEnabled: false }).reasons).toEqual(['liveDisabled']);
    expect(evaluateGate({ ...allTrue, sendConsent: false }).reasons).toEqual(['notConfirmed']);
    expect(evaluateGate({ ...allTrue, configured: false }).reasons).toEqual(['notConfigured']);
    expect(evaluateGate({ ...allTrue, budget: { ...okBudget, allowed: false } }).reasons).toEqual(['budget']);
  });
});

describe('safety limits (PARAM-113〜116; no monetary budget)', () => {
  const rec = (at: string, use = 'explain'): UsageRecord => ({ at, use, inputTokens: 0, outputTokens: 0 });
  const req = { use: 'explain', estimatedInputTokens: 100, maxOutputTokens: 1000 };

  it('uses Japan calendar days', () => {
    expect(jstDay(new Date('2026-10-31T15:30:00Z'))).toBe('2026-11-01');
    expect(jstDay(new Date('2026-10-31T14:59:00Z'))).toBe('2026-10-31');
  });

  it('enforces the daily quota shared by explain and chat (Q-059)', () => {
    const ledger = Array.from({ length: AI_LIMITS.dailyCalls }, (_, i) => rec(`2026-11-09T0${i % 9}:00:00+09:00`, i % 2 ? 'chat' : 'explain'));
    const d = checkBudget(ledger, new Date('2026-11-09T12:00:00+09:00'), req);
    expect(d.reasons).toContain('dailyLimit');
    expect(checkBudget(ledger, new Date('2026-11-10T00:01:00+09:00'), req).reasons).not.toContain('dailyLimit');
  });

  it('enforces the minimum interval, input and output caps for "explain"', () => {
    const d = checkBudget([rec('2026-11-09T12:00:00+09:00')], new Date('2026-11-09T12:00:03+09:00'), { ...req, estimatedInputTokens: 9000, maxOutputTokens: 2000 });
    expect(d.reasons).toEqual(['tooSoon', 'inputTooLarge', 'outputTooLarge']);
  });

  it('counts calls with unknown tokens and old records that carry a retired cost field toward the rate and daily limits', () => {
    const now = new Date('2026-11-09T12:00:03+09:00');
    const unknown: UsageRecord = { ...rec('2026-11-09T12:00:00+09:00'), inputTokens: null, outputTokens: null };
    expect(checkBudget([unknown], now, req)).toMatchObject({ todayCalls: 1, reasons: ['tooSoon'] });
    const old = { ...rec('2026-11-09T12:00:00+09:00'), costJpy: 123 } as UsageRecord;
    expect(checkBudget(Array.from({ length: 30 }, () => old), now, req).reasons).toContain('dailyLimit');
    expect(checkBudget([unknown], now, req)).not.toHaveProperty('monthSpentJpy');
  });

  it('estimates tokens before sending', () => {
    expect(estimateTokens('受注')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('applies PARAM-113〜116 only where decided, not to every use (§3.1)', () => {
    const at = new Date('2026-11-09T12:00:00+09:00');
    expect(checkBudget([], at, { ...req, use: 'presentation', maxOutputTokens: 4000 }).reasons).toEqual([]);
    expect(checkBudget([], at, { ...req, use: 'presentation', maxOutputTokens: 4001 }).reasons).toEqual(['outputTooLarge']);
    expect(checkBudget([], at, { ...req, use: 'review', estimatedInputTokens: 50_000, maxOutputTokens: 9000 }).reasons).toEqual([]);
    expect(checkBudget([rec('2026-11-09T11:59:59+09:00', 'explain')], at, { ...req, use: 'chat', estimatedInputTokens: 9000 }).reasons).toEqual([]);
    expect(PER_USE_LIMITS.explain?.maxOutputTokens).toBe(1500);
  });

});

describe('outbound selection (D-2: internal may be sent)', () => {
  it('includes internal and person items under the global request consent', () => {
    const sel = selectOutbound(loaded.pack.entities, loaded.byId);
    expect(sel.included).toHaveLength(loaded.pack.entities.length);
    expect(sel.excludedIds).toEqual([]);
    expect(sel.included.some((e) => e.id === 'deal-tsubasa-cobot')).toBe(true);
    expect(sel.internalCount).toBeGreaterThan(0);
    expect(sel.personCount).toBe(10);
  });
});

describe('AI client', () => {
  const calls: LiveCall[] = [];
  beforeEach(() => {
    localStorage.clear();
    calls.length = 0;
    setLiveTransport(async (c) => {
      calls.push(c);
      return { text: 'live answer', inputTokens: 1000, outputTokens: 500 };
    });
  });
  afterEach(() => {
    setLiveTransport(null);
    setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
  });

  const kpis = () => loaded.pack.entities.filter((e) => e.kind === 'kpi');

  it('sends "explain" live only when every condition holds, and records the reported tokens', async () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true }));
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', entities: kpis() });
    expect(r.mode).toBe('live');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxOutputTokens).toBe(1500);
    expect(calls[0]!.context).toContain('Employee engagement'); // internal-sourced KPI is sent (D-2)
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(readLedger()).toEqual([expect.objectContaining({ use: 'explain', inputTokens: 1000, outputTokens: 500 })]);
    expect(readLedger()[0]).not.toHaveProperty('costJpy');
  });

  it('falls back to a labelled mock without calling the transport when any condition fails', async () => {
    registerMock('explain', (q, ctx) => `mock:${q.lang}:${ctx.split('\n').length}`);
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: false, configured: true }));
    const noConfirmation = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', entities: kpis() });
    expect(noConfirmation.mode).toBe('mock');
    expect(noConfirmation.blockedReasons).toEqual(['notConfirmed']);
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true }));
    const chat = await aiComplete({ use: 'chat', lang: 'en', prompt: 'Hi' });
    expect(chat.mode).toBe('live');
    expect(calls).toHaveLength(1);
    expect(readLedger()).toHaveLength(1);
  });

  it('uses the one-time AI-settings consent for all request data, including person data', async () => {
    const entities = loaded.pack.entities.filter((entity) => entity.kind === 'person').slice(0, 1);
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, configured: true, sendConsent: false }));
    const blocked = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', entities });
    expect(blocked.mode).toBe('mock');
    expect(blocked.blockedReasons).toEqual(['notConfirmed']);
    expect(calls).toHaveLength(0);

    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, configured: true, sendConsent: true }));
    const allowed = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', entities });
    expect(allowed.mode).toBe('live');
    expect(calls).toHaveLength(1);
  });

  it('stops sending once the daily call limit is used up, even with old records that carry a cost (0 transport calls)', async () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true }));
    const at = new Date(Date.now() - 60_000).toISOString();
    localStorage.setItem('bas.ai.ledger', JSON.stringify(Array.from({ length: AI_LIMITS.dailyCalls }, () => ({ at, use: 'explain', inputTokens: 1, outputTokens: 1, costJpy: 1 }))));
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain' });
    expect(r.blockedReasons).toContain('budget');
    expect(calls).toHaveLength(0);
  });

  it('a failing live call falls back to the mock (FR-283)', async () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true }));
    setLiveTransport(async () => { throw new Error('network'); });
    const r = await aiComplete({ use: 'explain', lang: 'ja', prompt: '説明' });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toEqual(['liveFailed']);
    expect(readLedger()).toHaveLength(0);
  });

  it('preflight reports request content without requiring per-send confirmation', () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true }));
    const pf = preflight({ use: 'explain', lang: 'en', prompt: 'Explain', entities: loaded.pack.entities });
    expect(pf.internalCount).toBeGreaterThan(0);
    expect(pf.personCount).toBe(10);
    expect(pf.estimatedInputTokens).toBeGreaterThan(0);
    expect(pf.reasons).toEqual([]);
  });

  it('shares a use between modules with matchers (mock registry)', async () => {
    registerMock('import', () => 'generic');
    registerMock('import', () => 'handwriting', (q) => q.prompt.startsWith('ink.handwriting:'));
    expect((await aiComplete({ use: 'import', lang: 'en', prompt: 'ink.handwriting: abc' })).text).toBe('handwriting');
    expect((await aiComplete({ use: 'import', lang: 'en', prompt: 'file' })).text).toBe('generic');
  });
});
