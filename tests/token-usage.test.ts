import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '../src/ai/budget.ts';
import { aiComplete, readLedger, rebindLedgerScope, setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';
import { recordsOfScope, summarizeTokens } from '../src/ai/tokenUsage.ts';
import { tokenSection } from '../src/modules/project/exportFormat.ts';

const rec = (o: Partial<UsageRecord>): UsageRecord => ({ at: '2026-05-01T00:00:00.000Z', use: 'packBuild', inputTokens: 0, outputTokens: 0, costJpy: null, ...o });

describe('token summary per step', () => {
  it('groups pack generation by step (every fix round is "verify"), other uses by use, in first-use order; total = sum of lines', () => {
    const s = summarizeTokens([
      rec({ at: '2026-05-01T00:00:03Z', stage: 'fix-1', inputTokens: 6000, outputTokens: 2500 }),
      rec({ at: '2026-05-01T00:00:01Z', stage: 'foundation', inputTokens: 6000, outputTokens: 2500 }),
      rec({ at: '2026-05-01T00:00:02Z', stage: 'business', inputTokens: 6000, outputTokens: 2500 }),
      rec({ at: '2026-05-01T00:00:04Z', stage: 'fix-2', inputTokens: 100, outputTokens: 50 }),
      rec({ at: '2026-05-01T00:00:05Z', use: 'explain', inputTokens: 2000, outputTokens: 300, costJpy: 0.5 }),
    ]);
    expect(s.lines.map((l) => [l.use, l.step, l.calls, l.totalTokens])).toEqual([
      ['packBuild', 'foundation', 1, 8500],
      ['packBuild', 'business', 1, 8500],
      ['packBuild', 'verify', 2, 8650],
      ['explain', undefined, 1, 2300],
    ]);
    expect(s.total).toMatchObject({ calls: 5, inputTokens: 20100, outputTokens: 7850, totalTokens: 27950 });
    expect(s.total.totalTokens).toBe(s.lines.reduce((n, l) => n + l.totalTokens, 0));
  });

  it('an unknown price makes the group cost unknown (never free); estimates are counted; bad numbers are ignored', () => {
    const s = summarizeTokens([
      rec({ use: 'explain', costJpy: 1, inputTokens: 10, outputTokens: 5 }),
      rec({ use: 'explain', costJpy: 2, inputTokens: Number.NaN, outputTokens: -3, estimated: true }),
      rec({ use: 'connectionTest', costJpy: null, inputTokens: 1, outputTokens: 1 }),
    ]);
    expect(s.lines[0]).toMatchObject({ costJpy: 3, totalTokens: 15, estimatedCalls: 1 });
    expect(s.total).toMatchObject({ costJpy: null, totalTokens: 17, estimatedCalls: 1 });
    expect(summarizeTokens([]).total).toMatchObject({ calls: 0, totalTokens: 0, costJpy: 0 });
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
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, configured: true, prices: { inputPerM: 300, outputPerM: 1200 } }));
    setLiveTransport(async () => ({ text: 'ok', inputTokens: 1200, outputTokens: 340 }));
    const r = await aiComplete({ use: 'explain', lang: 'en', prompt: 'Explain', userConfirmed: true, scope: 'pj-x', stage: 'foundation' });
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(readLedger()).toEqual([expect.objectContaining({ use: 'explain', scope: 'pj-x', stage: 'foundation', inputTokens: 1200, outputTokens: 340 })]);
    expect(readLedger()[0]!.provider).toBeDefined();
    expect(readLedger()[0]!.estimated).toBeUndefined();

    const mock = await aiComplete({ use: 'chat', lang: 'en', prompt: 'Hi', userConfirmed: true, scope: 'pj-x' });
    expect(mock.mode).toBe('mock');
    expect(mock.usage).toBeUndefined();
    expect(readLedger()).toHaveLength(1);
  });

  it('rebinding moves only the run\'s records to the project', () => {
    writeLedger([rec({ scope: 'gen-run-1', inputTokens: 1 }), rec({ scope: 'pj-a', inputTokens: 2 }), rec({ inputTokens: 3 })]);
    rebindLedgerScope('gen-run-1', 'pj-b');
    expect(readLedger().map((r) => r.scope)).toEqual(['pj-b', 'pj-a', undefined]);
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
});
