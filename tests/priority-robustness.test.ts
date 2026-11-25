import { describe, expect, it } from 'vitest';
import { analyzePackPriority, type PriorityInput } from '../src/modules/project/priorityAnalysis.ts';
import { analyzeRobustness, evidenceLevel, RATING_SPREAD, ROBUST_SHARE } from '../src/modules/project/priorityRobustness.ts';

const issue = (id: string, impact: number, feasibility: number, sourced = false, measured = false): PriorityInput =>
  ({ id, impact, feasibility, sourced, measured });

// The demo pack's five issues (all cited and measured).
const demo = [issue('lead', 5, 3, true, true), issue('quality', 4, 4, true, true), issue('energy', 3, 4, true, true), issue('cash', 3, 5, true, true), issue('skills', 4, 2, true, true)];

describe('FR-364 rank robustness and value of information', () => {
  it('is reproducible for a seed and its shares add up', () => {
    const a = analyzeRobustness(demo);
    expect(analyzeRobustness(demo)).toEqual(a);
    expect(a.issues.reduce((s, i) => s + i.pFirst, 0)).toBeCloseTo(1, 2);
    expect(a.issues.reduce((s, i) => s + i.pTop, 0)).toBeCloseTo(3, 2);
    expect(a.issues.map((i) => i.id)).toEqual(['lead', 'quality', 'cash', 'energy', 'skills']);
  });

  it('sets the error by the evidence behind the issue', () => {
    expect(evidenceLevel({ sourced: true, measured: true })).toBe('strong');
    expect(evidenceLevel({ sourced: true, measured: false })).toBe('partial');
    expect(evidenceLevel({ sourced: false, measured: false })).toBe('none');
    expect(RATING_SPREAD.none).toBeGreaterThan(RATING_SPREAD.partial);
    expect(RATING_SPREAD.partial).toBeGreaterThan(RATING_SPREAD.strong);
  });

  it('calls a clear leader firm and suggests no check', () => {
    const r = analyzeRobustness([issue('a', 5, 5), issue('b', 1, 1)]);
    expect(r.verdict).toBe('robust');
    expect(r.pickShare).toBe(1);
    expect(r.next).toBeNull();
    expect(r.issues[0]!.voi.both).toBe(0);
  });

  it('splits first place between equal issues', () => {
    const r = analyzeRobustness([issue('a', 3, 3), issue('b', 3, 3)], { runs: 4000 });
    expect(r.verdict).toBe('contested');
    expect(r.issues[0]!.pFirst).toBeGreaterThan(0.45);
    expect(r.issues[0]!.pFirst).toBeLessThan(0.55);
  });

  it('matches the closed-form EVPPI of one rating', () => {
    // a scores 65, b 50; impact-only error of each is 15 × 1.5 × T, T ~ triangular(-1, 0, 1).
    // EVPPI = 22.5 × (1 − d)³ / 6 and P(change) = (1 − d)² / 2 with d = 15 / 22.5.
    const r = analyzeRobustness([issue('a', 4, 3), issue('b', 3, 3)], { runs: 40000 });
    const d = 15 / 22.5;
    for (const i of r.issues) {
      expect(i.voi.impact).toBeCloseTo((22.5 * (1 - d) ** 3) / 6, 2);
      expect(i.flip.impact).toBeCloseTo((1 - d) ** 2 / 2, 2);
      expect(i.voi.both).toBeGreaterThanOrEqual(i.voi.impact);
    }
  });

  it('gives no value to a check that cannot change the pick', () => {
    const r = analyzeRobustness([issue('a', 5, 5, true, true), issue('b', 3, 3, true, true)]);
    expect(r.issues.every((i) => i.voi.both === 0 && i.flip.both === 0)).toBe(true);
    expect(analyzeRobustness([issue('a', 4, 3), issue('b', 3, 3)], { impactWeight: 0 }).issues.every((i) => i.voi.impact === 0)).toBe(true);
  });

  it('flags a pick that only the weighting puts in doubt', () => {
    const r = analyzeRobustness(demo);
    expect(r.verdict).toBe('contested');
    expect(r.pickShare).toBeLessThan(ROBUST_SHARE);
    expect(r.pickShareFixedWeights).toBeGreaterThanOrEqual(ROBUST_SHARE);
    expect(r.weightDriven).toBe(true);
  });

  it('points at the rating whose check is worth most when evidence is thin', () => {
    const r = analyzeRobustness(demo.map((i) => ({ ...i, sourced: false, measured: false })));
    expect(r.weightDriven).toBe(false);
    expect(r.next).toMatchObject({ id: 'lead', rating: 'impact' });
    const confirmed = analyzeRobustness(demo.map((i) => ({ ...i, sourced: false, measured: false })), { confirmed: new Set(['lead', 'quality']) });
    expect(confirmed.issues[0]!.evidence).toBe('strong');
    expect(confirmed.pickShare).toBeGreaterThan(r.pickShare);
  });

  it('re-ranks without the issues marked solved', () => {
    const r = analyzeRobustness(demo, { excluded: new Set(['lead']) });
    expect(r.n).toBe(4);
    expect(r.pick).toBe('quality');
    expect(analyzeRobustness([], {}).verdict).toBe('none');
  });

  it('is part of the analysis stored with a generated Project pack', () => {
    const p = analyzePackPriority(demo.map((i) => ({ kind: 'issue', id: i.id, impact: i.impact, feasibility: i.feasibility, sourceIds: ['s'], kpiIds: ['k'] })));
    expect(p.methods).toContain('robustness');
    expect(p.sourceIds).toEqual(expect.arrayContaining(['kahneman2016', 'lahdelma1998', 'howard1966', 'coyle2008']));
    expect(p.robustness).toMatchObject({ verdict: 'contested', weightDriven: true, pick: 'lead', runs: 2000 });
    expect(p.robustness!.top).toHaveLength(3);
  });
});
