import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '../src/ai/budget.ts';
import { aiComplete, aiLive, readLedger, rebindLedgerScope, setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';
import { recordsOfJob, recordsOfScope, summarizeTokens } from '../src/ai/tokenUsage.ts';
import { tokenSection } from '../src/modules/project/exportFormat.ts';
import { relayTransport } from '../src/modules/ai/relayClient.ts';

const rec = (o: Partial<UsageRecord>): UsageRecord => ({ at: '2026-05-01T00:00:00.000Z', use: 'packBuild', inputTokens: 0, outputTokens: 0, ...o });

describe('token summary per step', () => {
  it('groups pack generation by step (every fix round is "verify"), other uses by use, in first-use order; total = sum of lines', () => {
    const s = summarizeTokens([
      rec({ at: '2026-05-01T00:00:03Z', stage: 'fix-1', inputTokens: 6000, outputTokens: 2500 }),
      rec({ at: '2026-05-01T00:00:01Z', stage: 'foundation', inputTokens: 6000, outputTokens: 2500 }),
      rec({ at: '2026-05-01T00:00:02Z', stage: 'business', inputTokens: 6000, outputTokens: 2500 }),
      rec({ at: '2026-05-01T00:00:04Z', stage: 'fix-2', inputTokens: 100, outputTokens: 50 }),
      rec({ at: '2026-05-01T00:00:05Z', use: 'explain', inputTokens: 2000, outputTokens: 300 }),
    ]);
    expect(s.lines.map((l) => [l.use, l.step, l.calls, l.totalTokens])).toEqual([
      ['packBuild', 'foundation', 1, 8500],
      ['packBuild', 'business', 1, 8500],
      ['packBuild', 'verify', 2, 8650],
      ['explain', undefined, 1, 2300],
    ]);
    expect(s.total).toMatchObject({ calls: 5, inputTokens: 20100, outputTokens: 7850, totalTokens: 27950 });
    expect(s.total.totalTokens).toBe(s.lines.reduce((n, l) => n + (l.totalTokens ?? 0), 0));
  });

  it('unknown or invalid usage makes the group total unknown, not zero; estimates are counted', () => {
    const s = summarizeTokens([
      rec({ use: 'explain', inputTokens: 10, outputTokens: 5 }),
      rec({ use: 'explain', inputTokens: Number.NaN, outputTokens: -3, estimated: true }),
      rec({ use: 'connectionTest', inputTokens: 1, outputTokens: 1 }),
    ]);
    expect(s.lines[0]).toMatchObject({ totalTokens: null, estimatedCalls: 1 });
    expect(s.total).toMatchObject({ totalTokens: null, estimatedCalls: 1 });
    expect(s.total).not.toHaveProperty('costJpy');
    expect(summarizeTokens([]).total).toMatchObject({ calls: 0, totalTokens: 0 });
  });

  it('marks a partial group and its exported total unavailable rather than displaying a partial sum', () => {
    const s = summarizeTokens([rec({ inputTokens: 10, outputTokens: 5 }), rec({ inputTokens: null, outputTokens: null })]);
    expect(s.total).toMatchObject({ calls: 2, inputTokens: null, outputTokens: null, totalTokens: null });
    expect(tokenSection(s, 'en').join('\n')).toContain('| **Total** | 2 | unknown | unknown | unknown |');
  });

  it('a single job counts only its own scope, start time and uses, and shows estimates apart from reported tokens', () => {
    const records = [
      rec({ scope: 'pj-a', at: '2026-05-01T00:00:00Z', use: 'deliverableDraft', inputTokens: 5, outputTokens: 5 }),
      rec({ scope: 'pj-a', at: '2026-05-01T01:00:00Z', use: 'deliverableDraft', inputTokens: 100, outputTokens: 50 }),
      rec({ scope: 'pj-a', at: '2026-05-01T01:00:05Z', use: 'stepBrief', inputTokens: 40, outputTokens: 0, estimated: true }),
      rec({ scope: 'pj-a', at: '2026-05-01T01:00:06Z', use: 'explain', inputTokens: 9, outputTokens: 9 }),
      rec({ scope: 'pj-b', at: '2026-05-01T01:00:07Z', use: 'deliverableDraft', inputTokens: 7, outputTokens: 7 }),
    ];
    const job = summarizeTokens(recordsOfJob(records, { scope: 'pj-a', since: '2026-05-01T00:30:00Z', uses: ['deliverableDraft', 'stepBrief'] }));
    expect(job.lines.map((l) => [l.use, l.inputTokens, l.outputTokens, l.totalTokens, l.estimatedCalls])).toEqual([
      ['deliverableDraft', 100, 50, 150, 0],
      ['stepBrief', 40, 0, 40, 1],
    ]);
    expect(job.total).toMatchObject({ calls: 2, inputTokens: 140, outputTokens: 50, totalTokens: 190, estimatedCalls: 1 });
  });

  it('only the records of the asked scope count; unscoped (older) records are excluded', () => {
    const records = [rec({ scope: 'pj-a', inputTokens: 1 }), rec({ scope: 'pj-b', inputTokens: 2 }), rec({ inputTokens: 4 })];
    expect(recordsOfScope(records, 'pj-a').map((r) => r.inputTokens)).toEqual([1]);
  });
});

describe('ledger attribution', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    setLiveTransport(null);
    setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
  });

  it('a live call records scope, stage and provider and returns the reported usage; mock answers record nothing', async () => {
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true }));
    setLiveTransport(async () => ({ text: 'ok', inputTokens: 1200, outputTokens: 340 }));
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', scope: 'pj-x', stage: 'foundation' });
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(readLedger()).toEqual([expect.objectContaining({ use: 'explain', scope: 'pj-x', stage: 'foundation', inputTokens: 1200, outputTokens: 340 })]);
    expect(readLedger()[0]!.provider).toBeDefined();
    expect(readLedger()[0]!.estimated).toBeUndefined();

    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: false, configured: true }));
    const mock = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Hi', scope: 'pj-x' });
    expect(mock.mode).toBe('mock');
    expect(mock.usage).toBeUndefined();
    expect(readLedger()).toHaveLength(1);
  });

  it('a job summary keeps reported Foundry tokens, unknown Copilot usage and an estimated cancelled call apart', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const run = (provider: 'foundry' | 'copilotSdk', transport: Parameters<typeof setLiveTransport>[0], signal?: AbortSignal) => {
      setRuntimeSettingsProvider(() => ({ provider, liveEnabled: true, sendConsent: true, configured: true }));
      setLiveTransport(transport);
      return aiLive({ use: 'packBuild', lang: 'en', prompt: 'x', scope: 'pj-x', stage: 'foundation' }, signal);
    };
    await run('foundry', async () => ({ text: 'ok', inputTokens: 1000, outputTokens: 200 }));
    const foundry = summarizeTokens(recordsOfJob(readLedger(), { scope: 'pj-x', since }));
    expect(foundry.total).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 200, totalTokens: 1200, estimatedCalls: 0 });

    await run('copilotSdk', async () => ({ text: 'ok', inputTokens: null, outputTokens: null }));
    const withCopilot = summarizeTokens(recordsOfJob(readLedger(), { scope: 'pj-x', since }));
    expect(withCopilot.total).toMatchObject({ calls: 2, inputTokens: null, outputTokens: null, totalTokens: null, estimatedCalls: 0 });

    const ac = new AbortController();
    const pending = run('foundry', (_c, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), ac.signal);
    ac.abort();
    await pending.catch(() => undefined);
    const records = recordsOfJob(readLedger(), { scope: 'pj-x', since });
    expect(records.map((r) => r.provider)).toEqual(['foundry', 'copilotSdk', 'foundry']);
    expect(records[2]).toMatchObject({ estimated: true, outputTokens: 0 });
    expect(summarizeTokens(records.filter((r) => r.provider === 'foundry')).total).toMatchObject({ calls: 2, outputTokens: 200, estimatedCalls: 1 });
  });

  it('rebinding moves only the run\'s records to the project', () => {
    writeLedger([rec({ scope: 'gen-run-1', inputTokens: 1 }), rec({ scope: 'pj-a', inputTokens: 2 }), rec({ inputTokens: 3 })]);
    rebindLedgerScope('gen-run-1', 'pj-b');
    expect(readLedger().map((r) => r.scope)).toEqual(['pj-b', 'pj-a', undefined]);
  });

  it('passes unavailable Copilot usage through the relay into the ledger without treating it as zero', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(url === '/relay/session' ? { token: 'test' } : { text: 'ok', inputTokens: null, outputTokens: null }), { status: 200 }));
    try {
      setRuntimeSettingsProvider(() => ({ provider: 'copilotSdk', liveEnabled: true, sendConsent: true, configured: true }));
      setLiveTransport(relayTransport);
      const r = await aiComplete({ use: 'packBuild', lang: 'en', prompt: 'x', scope: 'pj-x' });
      expect(r).toMatchObject({ mode: 'live', usage: { inputTokens: null, outputTokens: null } });
      expect(readLedger()).toEqual([expect.objectContaining({ scope: 'pj-x', inputTokens: null, outputTokens: null })]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('preserves a sanitized provider throttle delay through the relay transport and aiLive', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'providerBusy', providerStatus: 429, retryAfterMs: 25000 }), { status: 502 },
    ));
    try {
      setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
      setLiveTransport(relayTransport);
      await expect(aiLive({ use: 'packBuild', lang: 'en', prompt: 'x' })).rejects.toMatchObject({
        reasons: ['liveFailed'], cause: { code: 'providerBusy', retryAfterMs: 25000 },
      });
    } finally {
      fetch.mockRestore();
    }
  });
});

describe('token section in the Markdown export', () => {
  it('lists each step, the export as 0 and the total', () => {
    const md = tokenSection(summarizeTokens([
      rec({ stage: 'foundation', inputTokens: 6000, outputTokens: 2500 }),
      rec({ at: '2026-05-01T00:00:01Z', stage: 'business', inputTokens: 6000, outputTokens: 2500 }),
    ]), 'ja').join('\n');
    expect(md).toContain('| 基盤の作成（企業・拠点・製品・顧客・人・ブランド） | 1 | 6,000 | 2,500 | 8,500 |');
    expect(md).toMatch(/\| 書き出し（生成AIは使いません） \| 0 \| 0 \| 0 \| 0 \|/);
    expect(md).toContain('| **合計** | 2 | 12,000 | 5,000 | 17,000 |');
  });

  it('names non-pack stages by their use in the exported token table', () => {
    const md = tokenSection(summarizeTokens([
      rec({ use: 'kpiOkrDraft', stage: 'kpiOkr:fill', inputTokens: 10, outputTokens: 5 }),
      rec({ use: 'kpiOkrScreen', stage: 'decision', inputTokens: 20, outputTokens: 5 }),
    ]), 'ja').join('\n');
    expect(md).toContain('| KPI・OKR のドラフト作成 | 1 | 10 | 5 | 15 |');
    expect(md).toContain('| KPI・OKR 候補の事前判定（Decision） | 1 | 20 | 5 | 25 |');
  });
});
