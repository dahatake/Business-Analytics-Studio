import { describe, expect, it } from 'vitest';
import { loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { expectedOutcomes } from '../src/modules/project/expectedOutcomes.ts';
import { emptyDeliverables, type AppCheckContext } from '../src/modules/project/deliverables.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';

const pack = loadPack(samplePack);

function context(loadedPack = pack): AppCheckContext {
  return {
    pack: loadedPack,
    discussion: { themes: [], records: [] },
    kpi: { kpis: [], okrs: [] },
    analysis: { analyses: [], activeId: null },
    useCases: demoUseCases(),
    deliverables: emptyDeliverables(),
    today: '2026-11-18',
    strategy: emptyStrategy(),
    objectives: [],
    projectObjectiveIds: [],
  };
}

describe('expected business outcomes', () => {
  it('proposes measurable KPI/OKR outcomes from linked pack data without inventing a forecast', () => {
    const result = expectedOutcomes(context(), 'ja');

    expect(result.proposedDefinitions).toBe(true);
    expect(result.kpis.length).toBeGreaterThan(0);
    expect(result.kpis.every((k) => k.definition.origin === 'proposed' && !k.simulation)).toBe(true);
    expect(result.okrs.length).toBeGreaterThan(0);
    expect(result.solutions.length).toBeGreaterThan(0);
  });

  it('uses the existing contribution simulation and its evidence for a project KPI', () => {
    const ctx = context();
    ctx.kpi = demoKpis(pack.pack);
    const kpi = ctx.kpi.kpis[0]!;
    const solution = pack.pack.entities.find((e) => e.kind === 'solution' && e.kpiIds.includes(kpi.id));
    expect(solution?.kind).toBe('solution');
    if (solution?.kind !== 'solution') throw new Error('Sample KPI must have a linked solution');
    ctx.strategy = {
      ...emptyStrategy(),
      contributions: [{
        id: 'outcome-test-contribution',
        solutionId: solution.id,
        kpiId: kpi.id,
        lever: 'pilot volume',
        leverUnit: 'units',
        amount: { low: 10, mode: 10, high: 10 },
        effectPerUnit: { low: 0.1, mode: 0.1, high: 0.1 },
        rampStart: '2026-01-01',
        fullEffect: '2026-11-01',
        basis: 'measured',
        evidence: 'pilot report',
      }],
    };

    const result = expectedOutcomes(ctx, 'ja');

    expect(result.kpis.find((item) => item.definition.id === kpi.id)).toMatchObject({
      simulation: { contributions: 1 },
      contributions: [{ evidence: 'pilot report' }],
    });
  });

  it('shows issue-derived candidates when the pack has no measurable KPIs', () => {
    const withoutMetrics = loadPack({
      ...samplePack,
      entities: samplePack.entities.filter((e) => !['kpi', 'solution', 'initiative'].includes(e.kind)),
    });

    const result = expectedOutcomes(context(withoutMetrics), 'ja');

    expect(result.kpis).toHaveLength(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
