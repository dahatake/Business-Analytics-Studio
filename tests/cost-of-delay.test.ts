import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { verifyPack } from '../src/data/verify.ts';
import { analyzeCostOfDelay, delayInputs, methodReadiness, sequenceCost, VALUE_SPREAD, wsptOrder, type DelayEntity } from '../src/modules/project/costOfDelay.ts';
import { normalizeDeliverables, setDelayEstimate } from '../src/modules/project/deliverables.ts';
import { analyzePackPriority } from '../src/modules/project/priorityAnalysis.ts';

const issue = (id: string, impact: number, feasibility: number): DelayEntity => ({ kind: 'issue', id, impact, feasibility });
const solution = (id: string, issueIds: string[], annualBenefitJpy?: number): DelayEntity => ({ kind: 'solution', id, issueIds, annualBenefitJpy });
const initiative = (id: string, solutionId: string, start: string, end: string, progress = 0): DelayEntity => ({ kind: 'initiative', id, solutionId, start, end, progress });
const fixed = (x: number) => ({ low: x, mode: x, high: x });
const estimate = (value?: number, months?: number) => ({
  ...(value ? { valuePerMonthJpy: fixed(value) } : {}), ...(months ? { durationMonths: fixed(months) } : {}),
  note: 'interview', at: '2026-01-01T00:00:00Z', by: 'me',
});

function permutations(n: number): number[][] {
  if (n === 1) return [[0]];
  return permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)]));
}

describe('FR-365 cost of delay (CD3)', () => {
  it('orders by value ÷ duration, which no other order beats', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 30; t++) {
      const v = Array.from({ length: 5 }, () => 1 + rnd() * 9);
      const d = Array.from({ length: 5 }, () => 0.5 + rnd() * 6);
      const best = Math.min(...permutations(5).map((p) => sequenceCost(p, v, d)));
      expect(sequenceCost(wsptOrder(v, d, [0, 1, 2, 3, 4]), v, d)).toBeCloseTo(best, 9);
    }
  });

  it('reads the demo pack: the nearly finished cash fix comes before lead time once months are counted', () => {
    const c = analyzeCostOfDelay(samplePack.entities as DelayEntity[]);
    expect(c.ranked.map((r) => r.id)).toEqual(['issue-cash', 'issue-lead-time', 'issue-quality', 'issue-energy', 'issue-skills']);
    expect(c).toMatchObject({ verdict: 'differs', pick: 'issue-cash', ifPick: 'issue-lead-time', firm: true, missing: [], done: [] });
    expect(c.beatShare).toBeGreaterThan(0.9);
    expect(c.savingLow).toBeGreaterThan(0);
    expect(c.pursued).toBe(c.ranked.length + c.missing.length);
    expect(c.ranked.length).toBeGreaterThanOrEqual(2);
    expect(c.costCd3).toBeLessThanOrEqual(c.costIf);
    expect(Math.abs(c.saving - (c.costIf - c.costCd3))).toBeLessThanOrEqual(1);
    expect(analyzeCostOfDelay(samplePack.entities as DelayEntity[])).toEqual(c);
    for (const r of c.ranked) {
      expect(Math.abs(r.cd3 / (r.meanValue / r.meanDuration) - 1)).toBeLessThan(0.01);
      expect(r.valueOrigin).toBe('solution');
    }
  });

  it('prefers a person, then the stated material, then derived values', () => {
    const ents = [issue('a', 5, 5), solution('s', ['a'], 120_000_000), initiative('i', 's', '2026-01-01', '2026-07-01')];
    const ext = { items: [{ issueId: 'a', valuePerMonthJpy: fixed(5_000_000), quote: '月 500 万円の損失', sourceIds: ['src'] }] };
    expect(delayInputs(ents)[0]!.value!.mode).toBe(10_000_000);
    expect(delayInputs(ents, { extension: ext })[0]).toMatchObject({ valueOrigin: 'pack', value: fixed(5_000_000), durationOrigin: 'initiative' });
    const human = delayInputs(ents, { extension: ext, estimates: { a: estimate(2_000_000, 3) } })[0]!;
    expect(human).toMatchObject({ valueOrigin: 'human', durationOrigin: 'human', value: fixed(2_000_000), duration: fixed(3) });
  });

  it('widens an unapproved Copilot benefit and splits a shared one', () => {
    const ents = [issue('a', 5, 5), issue('b', 4, 4), solution('s', ['a', 'b'], 24_000_000)];
    const [a] = delayInputs(ents, { unreviewed: new Set(['s']) });
    expect(a!.value).toEqual({ low: 1_000_000 * (1 - VALUE_SPREAD.estimate), mode: 1_000_000, high: 1_000_000 * (1 + VALUE_SPREAD.estimate) });
    expect(a!.valueFirm).toBe(false);
  });

  it('says where each missing number comes from, and drops finished issues', () => {
    const ents = [
      issue('a', 5, 5), solution('sa', ['a']),
      issue('b', 4, 4), solution('sb', ['b'], 12_000_000), initiative('ib', 'sb', '2025-01-01', '2025-06-01', 1),
      issue('c', 3, 3),
    ];
    const c = analyzeCostOfDelay(ents);
    expect(c.done).toEqual(['b']);
    expect(c.missing.map((m) => [m.id, m.valueVia, m.durationVia, m.fillSolutionId])).toEqual([['a', 'fill', 'initiative', 'sa'], ['c', 'solution', 'solution', null]]);
    expect(c.verdict).toBe('none');
  });

  it('values knowing a number in yen (closed form for two issues)', () => {
    // a: 10k/month for 2 months, b: value 2k–10k (mean 6k) for 1 month. CD3 order: b (6k) before a (5k).
    const ents = [issue('a', 5, 5), issue('b', 1, 1)];
    const c = analyzeCostOfDelay(ents, { estimates: { a: estimate(10_000, 2), b: { ...estimate(undefined, 1), valuePerMonthJpy: { low: 2_000, mode: 6_000, high: 10_000 } } } });
    expect(c.verdict).toBe('differs');
    expect(c.pick).toBe('b');
    expect(c.costIf).toBe(10_000 * 2 + 6_000 * 3);
    expect(c.costCd3).toBe(6_000 * 1 + 10_000 * 3);
    // Once b's value x is known: a first iff x < 5k, saving (10k − 2x) there. E over triangular(2k, 6k, 10k):
    // ∫2k..5k (10k − 2x)(x − 2k)/16M dx = 562.5 yen.
    expect(c.ranked.find((r) => r.id === 'b')!.evppi.value).toBeGreaterThan(560);
    expect(c.ranked.find((r) => r.id === 'b')!.evppi.value).toBeLessThan(565);
    expect(c.ranked.find((r) => r.id === 'a')!.evppi.value).toBe(0);
    expect(c.next).toEqual({ id: 'b', param: 'value', evppiJpy: c.ranked.find((r) => r.id === 'b')!.evppi.value });
  });

  it('reports the data each method lacks, re-run on the real one-issue packs', () => {
    const one = analyzePackPriority([{ kind: 'issue', id: 'x', impact: 4, feasibility: 3, sourceIds: ['s'] }]);
    const rows = Object.fromEntries((one.readiness ?? []).map((r) => [r.method, r]));
    expect(rows.costOfDelay).toMatchObject({ status: 'missing', changes: 'unknown' });
    expect(rows.impactEffort!.status).toBe('partial');
    expect(rows.kano!.status).toBe('notStored');
    const demo = analyzePackPriority(samplePack.entities as unknown as Record<string, unknown>[]);
    expect(demo.costOfDelay!.ranked).toBeGreaterThanOrEqual(2);
    expect(methodReadiness(5, { ranked: [], pursued: 5, verdict: 'none' })[2]).toMatchObject({ status: 'missing', need: 5 });
  });

  it('keeps a person\'s estimate in the project data and drops only a broken one', () => {
    const base = normalizeDeliverables({});
    const saved = setDelayEstimate(base, 'a', estimate(1_000_000, 2));
    const round = normalizeDeliverables(JSON.parse(JSON.stringify({ ...saved, delayEstimates: { ...saved.delayEstimates, b: { note: '' } } })));
    expect(round.delayEstimates).toEqual({ a: estimate(1_000_000, 2) });
    expect(setDelayEstimate(round, 'a', null).delayEstimates).toEqual({});
    expect(() => setDelayEstimate(base, 'a', { ...estimate(1, 1), valuePerMonthJpy: { low: 3, mode: 2, high: 4 } })).toThrow();
  });

  it('checks extensions.delayCost against the issues and sources', () => {
    const src = samplePack.entities.find((e) => e.kind === 'source')!.id;
    const iss = samplePack.entities.find((e) => e.kind === 'issue')!.id;
    const item = (issueId: string) => ({ issueId, durationMonths: fixed(3), quote: '3 か月で解決', sourceIds: [src] });
    const ofExt = (items: unknown[]) => verifyPack({ ...samplePack, extensions: { ...(samplePack.extensions ?? {}), delayCost: { items } } })
      .problems.filter((p) => p.path.includes('extensions.delayCost'));
    expect(ofExt([item(iss)])).toEqual([]);
    expect(ofExt([item('issue-none')])).toContainEqual(expect.objectContaining({ code: 'DANGLING_REF' }));
    expect(ofExt([item(iss), item(iss)])).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_ID' }));
    expect(ofExt([{ ...item(iss), sourceIds: [] }]).length).toBeGreaterThan(0);
  });
});
