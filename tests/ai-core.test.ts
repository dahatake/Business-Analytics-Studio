import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { C03_TABLE, isApproved, AI_LIMITS, PER_USE_LIMITS, type AiUse, type UseApproval } from '../src/ai/policy.ts';
import {
  checkBudget, jstDay, jstMonth, estimateTokens, estimateCostJpy, actualCostJpy, parseUnitPrices, partitionLedger, ledgerCutoffMonth,
  type UsageRecord,
} from '../src/ai/budget.ts';
import { evaluateGate } from '../src/ai/gate.ts';
import { selectOutbound } from '../src/ai/redact.ts';
import { aiComplete, preflight, readLedger, registerMock, setLiveTransport, setRuntimeSettingsProvider, isUseApproved, type LiveCall } from '../src/ai/client.ts';
import { loaded } from '../src/data/pack.ts';

const okBudget = checkBudget([], new Date('2026-11-09T00:00:00Z'), { use: 'explain', estimatedInputTokens: 10, maxOutputTokens: 100, estimatedCostJpy: 1 });
const allTrue = { liveEnabled: true, userConfirmed: true, configured: true, hasUnitPrices: true, budget: okBudget, personCount: 0, personConfirmed: true };

describe('C-03 table (D-1: staged approval)', () => {
  it('approves "explain" via Foundry and, since D-12, "packBuild" via Foundry or Copilot; every other use stays blocked even with every switch on', () => {
    const approved = (Object.keys(C03_TABLE) as AiUse[]).filter((u) => isApproved(C03_TABLE[u]));
    expect(approved).toEqual(['explain', 'packBuild']);
    expect(C03_TABLE.explain.provider).toBe('foundry');
    expect(C03_TABLE.packBuild.provider).toEqual(['foundry', 'copilotSdk']);
    expect(C03_TABLE.packBuild.costCapJpy).toBe(100_000);
    for (const use of Object.keys(C03_TABLE) as AiUse[]) {
      const d = evaluateGate({ use, ...allTrue });
      expect(d.allowed, use).toBe(approved.includes(use));
      if (!approved.includes(use)) expect(d.reasons).toEqual(['c03NotApproved']);
    }
    // The row also decides the provider: "explain" is never sent to Copilot.
    expect(evaluateGate({ use: 'explain', provider: 'copilotSdk', ...allTrue }).reasons).toEqual(['c03NotApproved']);
    expect(evaluateGate({ use: 'packBuild', provider: 'copilotSdk', ...allTrue }).allowed).toBe(true);
    expect(isUseApproved('explain')).toBe(true);
    expect(isUseApproved('chat')).toBe(false);
  });

  it('every other condition is still required for the approved row', () => {
    expect(evaluateGate({ use: 'explain', ...allTrue }).allowed).toBe(true);
    expect(evaluateGate({ use: 'explain', ...allTrue, liveEnabled: false }).reasons).toEqual(['liveDisabled']);
    expect(evaluateGate({ use: 'explain', ...allTrue, userConfirmed: false }).reasons).toEqual(['notConfirmed']);
    expect(evaluateGate({ use: 'explain', ...allTrue, configured: false }).reasons).toEqual(['notConfigured']);
    expect(evaluateGate({ use: 'explain', ...allTrue, hasUnitPrices: false }).reasons).toEqual(['noUnitPrice']);
    expect(evaluateGate({ use: 'explain', ...allTrue, personCount: 2, personConfirmed: false }).reasons).toEqual(['personNotConfirmed']);
  });

  it('a fictitious approval of another row works the same way (the table is the only switch)', () => {
    const approved: UseApproval = { provider: 'foundry', data: 'x', enableCondition: 'x', costCapJpy: 1000, openQuestions: [] };
    expect(evaluateGate({ use: 'chat', ...allTrue }, { ...C03_TABLE, chat: approved }).allowed).toBe(true);
  });
});

describe('budget guard (PARAM-113〜119, D-3)', () => {
  const rec = (at: string, use = 'explain', costJpy = 0): UsageRecord => ({ at, use, inputTokens: 0, outputTokens: 0, costJpy });
  const req = { use: 'explain', estimatedInputTokens: 100, maxOutputTokens: 1000, estimatedCostJpy: 10 };

  it('uses Japan calendar days and months', () => {
    expect(jstDay(new Date('2026-10-31T15:30:00Z'))).toBe('2026-11-01');
    expect(jstMonth(new Date('2026-10-31T14:59:00Z'))).toBe('2026-10');
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

  it('warns at 80% and stops at 100% of the monthly budget, resetting each JST month', () => {
    const spent = (jpy: number) => [rec('2026-11-01T09:00:00+09:00', 'review', jpy)];
    expect(checkBudget(spent(79_000), new Date('2026-11-20T00:00:00+09:00'), req).level).toBe('ok');
    expect(checkBudget(spent(80_000), new Date('2026-11-20T00:00:00+09:00'), req).level).toBe('warn');
    const stop = checkBudget(spent(99_995), new Date('2026-11-20T00:00:00+09:00'), req);
    expect(stop.level).toBe('stop');
    expect(stop.allowed).toBe(false);
    expect(checkBudget(spent(99_995), new Date('2026-12-01T00:00:00+09:00'), req).level).toBe('ok');
  });

  it('honours a user-changed monthly budget (D-3: changeable later)', () => {
    const limits = { ...AI_LIMITS, monthlyBudgetJpy: 20_000 };
    expect(checkBudget([rec('2026-11-01T09:00:00+09:00', 'explain', 19_995)], new Date('2026-11-09T12:00:00+09:00'), req, limits).reasons).toEqual(['monthlyStop']);
  });

  it('applies PARAM-113〜116 only where decided, not to every use (§3.1)', () => {
    const at = new Date('2026-11-09T12:00:00+09:00');
    expect(checkBudget([], at, { ...req, use: 'presentation', maxOutputTokens: 4000 }).reasons).toEqual([]);
    expect(checkBudget([], at, { ...req, use: 'presentation', maxOutputTokens: 4001 }).reasons).toEqual(['outputTooLarge']);
    expect(checkBudget([], at, { ...req, use: 'review', estimatedInputTokens: 50_000, maxOutputTokens: 9000 }).reasons).toEqual([]);
    expect(checkBudget([rec('2026-11-01T09:00:00+09:00', 'explain', 100_000)], at, { ...req, use: 'review' }).reasons).toEqual(['monthlyStop']);
    expect(checkBudget([rec('2026-11-09T11:59:59+09:00', 'explain')], at, { ...req, use: 'chat', estimatedInputTokens: 9000 }).reasons).toEqual([]);
    expect(PER_USE_LIMITS.explain?.maxOutputTokens).toBe(1500);
  });

  it('estimates tokens and costs; prices are required (D-3)', () => {
    expect(estimateTokens('受注')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(parseUnitPrices('', '1200')).toBeNull();
    expect(parseUnitPrices('0', '1200')).toBeNull();
    const p = parseUnitPrices('300', 1200)!;
    // The worked example in docs/decision-guide.md D-3: 8000 in + 1500 out = 4.2 JPY, ×1.2 for the estimate.
    expect(actualCostJpy(8000, 1500, p)).toBeCloseTo(4.2, 9);
    expect(estimateCostJpy(8000, 1500, p)).toBeCloseTo(5.04, 9);
  });

  it('D-7: keeps 13 JST months and reports older records (pruned only by an explicit action)', () => {
    const now = new Date('2026-11-09T12:00:00+09:00');
    expect(ledgerCutoffMonth(now)).toBe('2025-11');
    const { keep, expired } = partitionLedger([rec('2025-10-31T23:59:00+09:00'), rec('2025-11-01T00:00:00+09:00'), rec('2026-11-09T00:00:00+09:00')], now);
    expect(expired.map((r) => r.at)).toEqual(['2025-10-31T23:59:00+09:00']);
    expect(keep).toHaveLength(2);
  });
});

describe('outbound selection (D-2: internal may be sent)', () => {
  it('includes internal items and reports how many, plus persons for FR-219', () => {
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

  it('sends "explain" live only when every condition holds, and records the actual cost', async () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, configured: true, prices: { inputPerM: 300, outputPerM: 1200 } }));
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', entities: kpis(), userConfirmed: true });
    expect(r.mode).toBe('live');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxOutputTokens).toBe(1500);
    expect(calls[0]!.context).toContain('Employee engagement'); // internal-sourced KPI is sent (D-2)
    expect(r.costJpy).toBeCloseTo(0.9, 9);
    expect(readLedger()).toHaveLength(1);
  });

  it('falls back to a labelled mock without calling the transport when any condition fails', async () => {
    registerMock('explain', (q, ctx) => `mock:${q.lang}:${ctx.split('\n').length}`);
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, configured: true, prices: null }));
    const noPrice = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', entities: kpis(), userConfirmed: true });
    expect(noPrice.mode).toBe('mock');
    expect(noPrice.blockedReasons).toEqual(['noUnitPrice']);
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, configured: true, prices: { inputPerM: 300, outputPerM: 1200 } }));
    const chat = await aiComplete({ use: 'chat', lang: 'en', prompt: 'Hi', userConfirmed: true });
    expect(chat.blockedReasons).toContain('c03NotApproved');
    expect(calls).toHaveLength(0);
    expect(readLedger()).toHaveLength(0);
  });

  it('stops sending once the monthly budget is used up (0 transport calls)', async () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, configured: true, monthlyBudgetJpy: 1, prices: { inputPerM: 300, outputPerM: 1200 } }));
    localStorage.setItem('bas.ai.ledger', JSON.stringify([{ at: new Date().toISOString(), use: 'review', inputTokens: 0, outputTokens: 0, costJpy: 1 }]));
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', userConfirmed: true });
    expect(r.blockedReasons).toContain('budget');
    expect(calls).toHaveLength(0);
  });

  it('a failing live call falls back to the mock (FR-283)', async () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, configured: true, prices: { inputPerM: 300, outputPerM: 1200 } }));
    setLiveTransport(async () => { throw new Error('network'); });
    const r = await aiComplete({ use: 'explain', lang: 'ja', prompt: '説明', userConfirmed: true });
    expect(r.mode).toBe('mock');
    expect(r.blockedReasons).toEqual(['liveFailed']);
    expect(readLedger()).toHaveLength(0);
  });

  it('preflight reports content and estimated cost for the confirmation dialog', () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, configured: true, prices: { inputPerM: 300, outputPerM: 1200 } }));
    const pf = preflight({ use: 'explain', lang: 'en', prompt: 'Explain', entities: loaded.pack.entities });
    expect(pf.internalCount).toBeGreaterThan(0);
    expect(pf.personCount).toBe(10);
    expect(pf.estimatedCostJpy).toBeGreaterThan(0);
    expect(pf.reasons).toEqual(['notConfirmed', 'personNotConfirmed']);
  });

  it('shares a use between modules with matchers (mock registry)', async () => {
    registerMock('import', () => 'generic');
    registerMock('import', () => 'handwriting', (q) => q.prompt.startsWith('ink.handwriting:'));
    expect((await aiComplete({ use: 'import', lang: 'en', prompt: 'ink.handwriting: abc' })).text).toBe('handwriting');
    expect((await aiComplete({ use: 'import', lang: 'en', prompt: 'file' })).text).toBe('generic');
  });
});
