import { describe, expect, it, vi } from 'vitest';
import { askUntilValid, repairNote, runAgentLoop, type LoopAnswer } from '../src/ai/agentLoop.ts';

const answer = (text: string, input = 10, output = 10): LoopAnswer => ({ text, inputTokens: input, outputTokens: output });
const verify = (a: LoopAnswer, pending: string[]) => Object.fromEntries(a.text.split(',').filter((id) => pending.includes(id)).map((id) => [id, id.toUpperCase()]));

describe('D-51 agentic loop', () => {
  it('asks again only for the missing units and keeps what already passed', async () => {
    const ask = vi.fn<(pending: string[], round: number) => Promise<LoopAnswer>>()
      .mockResolvedValueOnce(answer('a,c'))
      .mockResolvedValueOnce(answer('b,a'));
    const result = await runAgentLoop({ units: ['a', 'b', 'c'], ask, verify });
    expect(ask.mock.calls.map((c) => c[0])).toEqual([['a', 'b', 'c'], ['b']]);
    expect(result).toMatchObject({ stop: 'complete', missing: [], values: { a: 'A', b: 'B', c: 'C' }, inputTokens: 20, outputTokens: 20 });
  });

  it('stops when a repair makes no progress and returns the partial result', async () => {
    const ask = vi.fn().mockResolvedValue(answer('a'));
    const result = await runAgentLoop({ units: ['a', 'b'], ask, verify });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ stop: 'stalled', missing: ['b'], values: { a: 'A' } });
  });

  it('honours the round limit, the token budget and an abort', async () => {
    const slow = vi.fn().mockImplementation(async (pending: string[]) => answer(pending[0]!));
    expect(await runAgentLoop({ units: ['a', 'b', 'c', 'd'], ask: slow, verify, maxRounds: 2 })).toMatchObject({ stop: 'maxRounds', missing: ['c', 'd'] });
    const budget = vi.fn().mockImplementation(async (pending: string[]) => answer(pending[0]!, 50, 50));
    expect(await runAgentLoop({ units: ['a', 'b', 'c'], ask: budget, verify, tokenBudget: 100 })).toMatchObject({ stop: 'budget', missing: ['b', 'c'] });
    const controller = new AbortController();
    const abort = vi.fn().mockImplementation(async () => { controller.abort(); return answer('a'); });
    expect(await runAgentLoop({ units: ['a', 'b'], ask: abort, verify, signal: controller.signal })).toMatchObject({ stop: 'aborted', values: { a: 'A' } });
  });

  it('throws a first-round failure but keeps the partial result when a repair fails', async () => {
    await expect(runAgentLoop({ units: ['a'], ask: async () => { throw new Error('offline'); }, verify })).rejects.toThrow('offline');
    const ask = vi.fn().mockResolvedValueOnce(answer('a')).mockRejectedValueOnce(new Error('cut off'));
    const result = await runAgentLoop({ units: ['a', 'b'], ask, verify });
    expect(result).toMatchObject({ stop: 'failed', missing: ['b'], values: { a: 'A' } });
    expect((result.error as Error).message).toBe('cut off');
  });

  it('askUntilValid corrects a rejected answer once, with the reason, and then throws the parser error', async () => {
    const parse = (t: string) => { if (t !== 'ok') throw new Error(`bad:${t}`); return 42; };
    const prompts: (string | null)[] = [];
    const ask = vi.fn(async (feedback: string | null) => { prompts.push(feedback); return answer(feedback ? 'ok' : 'nope'); });
    const fixed = await askUntilValid({ ask, parse });
    expect(fixed).toMatchObject({ value: 42, rounds: 2, inputTokens: 20, outputTokens: 20 });
    expect(prompts).toEqual([null, 'bad:nope']);
    expect(repairNote('bad:nope')).toContain('bad:nope');
    const never = vi.fn(async () => answer('nope'));
    await expect(askUntilValid({ ask: never, parse })).rejects.toThrow('bad:nope');
    expect(never).toHaveBeenCalledTimes(2);
    const valid = vi.fn(async () => answer('ok'));
    await askUntilValid({ ask: valid, parse });
    expect(valid).toHaveBeenCalledTimes(1);
  });

  it('never asks for units that were seeded and never overwrites them', async () => {
    const ask = vi.fn().mockResolvedValue(answer('a,b'));
    const result = await runAgentLoop({ units: ['a', 'b'], seed: { a: 'kept' }, ask, verify });
    expect(ask.mock.calls[0]![0]).toEqual(['b']);
    expect(result.values).toEqual({ a: 'kept', b: 'B' });
  });
});
