import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { stampKpiDefinition } from '../src/data/kpiDefinition.ts';
import type { EntityOf } from '../src/data/schema.ts';
import { migrateStep } from '../src/state/projects.ts';
import { demoKpis, kpiDefinitionState, proposeKpiDefinition } from '../src/modules/project/kpiOkr.ts';
import { realisedShare, simulate, type ContributionInput, type KpiTarget } from '../src/modules/project/simulate.ts';
import { DELIVERABLE_OF, emptyStrategy, setSection, setSolutionType, strategyThread, upsertContribution, type StrategyContext } from '../src/modules/project/strategy.ts';
import { buildSolutionDoc, hasToFill, SECTIONS } from '../src/modules/project/solutionDocs.ts';
import { emptyDeliverables } from '../src/modules/project/deliverables.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';

const pack = loadPack(samplePack);
const KPI: KpiTarget = { id: 'k', baseline: 20, current: 16, target: 10, deadline: '2027-03-31' };
const contrib = (over: Partial<ContributionInput> = {}): ContributionInput => ({
  id: 'c1', solutionId: 's1', kpiId: 'k', amount: { low: 10, mode: 10, high: 10 }, effectPerUnit: { low: 0.3, mode: 0.3, high: 0.3 },
  rampStart: '2026-12-01', fullEffect: '2027-01-31', basis: 'measured', ...over,
});

describe('contribution simulation (FR-314)', () => {
  it('a certain contribution moves the KPI in its direction by amount × effect', () => {
    const [r] = simulate([KPI], [contrib()]);
    expect(r!.expected).toBeCloseTo(3);
    expect(r!.p50).toBeCloseTo(13); // lower is better: 16 − 3
    expect(r!.p10).toBeCloseTo(13);
    expect(r!.coverage).toBeCloseTo(0.5);
    expect(r!.probability).toBe(0);
    expect(r!.warnings).toEqual([]);
  });

  it('counts only the share realised by the deadline (linear ramp)', () => {
    expect(realisedShare('2027-01-01', '2027-05-01', '2027-03-01')).toBeCloseTo(59 / 120);
    expect(realisedShare('2027-04-01', '2027-05-01', '2027-03-31')).toBe(0);
    const [late] = simulate([KPI], [contrib({ rampStart: '2027-04-01', fullEffect: '2027-06-01' })]);
    expect(late!.expected).toBe(0);
    expect(late!.warnings).toContain('afterDeadline');
  });

  it('uses the triangular mean, P10 is the pessimistic side, and the result is reproducible', () => {
    const c = contrib({ amount: { low: 5, mode: 10, high: 15 }, effectPerUnit: { low: 0.2, mode: 0.6, high: 1 } });
    const a = simulate([KPI], [c])[0]!;
    expect(a.expected).toBeCloseTo(10 * 0.6);
    expect(a.p10).toBeGreaterThan(a.p50); // lower is better, so the pessimistic value is higher
    expect(a.p90).toBeLessThan(a.p50);
    expect(simulate([KPI], [c])[0]).toEqual(a);
  });

  it('flags overlap between solutions, over-claiming, assumption-only estimates and invalid ranges', () => {
    const r = simulate([KPI], [
      contrib({ basis: 'assumption', effectPerUnit: { low: 0.6, mode: 0.6, high: 0.6 } }),
      contrib({ id: 'c2', solutionId: 's2', basis: 'assumption', effectPerUnit: { low: 0.6, mode: 0.6, high: 0.6 } }),
      contrib({ id: 'c3', amount: { low: 5, mode: 1, high: 9 } }),
    ])[0]!;
    expect(r.contributions).toBe(2);
    expect(r.coverage).toBeCloseTo(2);
    expect(r.probability).toBe(1);
    expect([...r.warnings].sort()).toEqual(['assumptionOnly', 'invalidRange', 'overclaim', 'overlap']);
  });

  it('skips KPIs without contributions', () => {
    expect(simulate([KPI], [])).toEqual([]);
  });
});

describe('KPI/OKR definition status (FR-313)', () => {
  it('migrates stored step ids of the old four-step flow', () => {
    expect(migrateStep('define')).toBe('asis');
    expect(migrateStep('usecase')).toBe('solution');
    expect(migrateStep('plan')).toBe('deliverable');
    expect(migrateStep('tobe')).toBe('tobe');
    expect(migrateStep(42)).toBe('asis');
  });

  it('stamps what was found and never trusts a claimed definition the pack does not contain', () => {
    expect(stampKpiDefinition(undefined, 0, ['src-a', ' '])).toMatchObject({ definitionStatus: 'notRetrieved', checkedSources: ['src-a'], kpis: [], objectives: [] });
    expect(stampKpiDefinition({ definitionStatus: 'defined' }, 0, []).definitionStatus).toBe('notRetrieved');
    expect(stampKpiDefinition({ definitionStatus: 'defined' }, 2, []).definitionStatus).toBe('defined');
    expect(stampKpiDefinition({ definitionStatus: 'undefined', checkedSources: ['IR 2026'] }, 0, ['x'])).toMatchObject({ definitionStatus: 'undefined', checkedSources: ['IR 2026'] });
    expect(stampKpiDefinition({ objectives: [{ keyResults: [{}] }] }, 0, []).definitionStatus).toBe('defined');
    expect(stampKpiDefinition({}, 3, []).definitionStatus).toBe('partial');
  });

  it('reads the stated status, or infers it for older packs', () => {
    const stated = { ...pack.pack, extensions: { ...pack.pack.extensions, okr: { definitionStatus: 'undefined', checkedSources: ['IR 2026'], kpis: [], objectives: [] } } };
    expect(kpiDefinitionState(stated)).toMatchObject({ status: 'undefined', stated: true, checkedSources: ['IR 2026'] });
    const old = { ...pack.pack, extensions: { ...pack.pack.extensions, okr: undefined } };
    expect(kpiDefinitionState(old)).toMatchObject({ status: 'partial', stated: false });
    const none = { ...old, entities: old.entities.filter((e) => e.kind !== 'kpi') };
    expect(kpiDefinitionState(none).status).toBe('notRetrieved');
  });

  it('proposes KPIs and OKRs from the issues, linked to the company objective, without touching existing ones', () => {
    const p = proposeKpiDefinition({ pack: pack.pack, current: { kpis: [], okrs: [] }, objectives: [{ id: 'obj', text: 'MTP' }], deadline: '2027-03-31', lang: 'ja' });
    expect(p.kpis.length).toBeGreaterThan(0);
    expect(p.kpis.every((k) => k.origin === 'proposed' && k.deadline === '2027-03-31')).toBe(true);
    expect(p.okrs).toHaveLength(1);
    expect(p.okrs[0]).toMatchObject({ origin: 'proposed', companyObjectiveIds: ['obj'] });
    expect(new Set(p.okrs[0]!.keyResults.map((kr) => kr.kpiId))).toEqual(new Set(p.kpis.map((k) => k.id)));
    const current = demoKpis(pack.pack);
    const again = proposeKpiDefinition({ pack: pack.pack, current, objectives: [], deadline: '2027-03-31', lang: 'en' });
    expect(again.kpis.slice(0, current.kpis.length)).toEqual(current.kpis);
    expect(again.okrs.slice(0, current.okrs.length)).toEqual(current.okrs);
  });
});

describe('strategy thread and solution deliverables (FR-312, FR-315)', () => {
  const solutions = pack.pack.entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution');
  const base = (): StrategyContext => ({ pack, kpi: demoKpis(pack.pack), useCases: demoUseCases(), strategy: emptyStrategy(), objectives: [], projectObjectiveIds: [] });

  it('links company objectives → OKRs (inherited through the project) → KPIs → solutions and lists the gaps', () => {
    const c = base();
    const t = strategyThread(c);
    expect(t.gaps.okrsWithoutObjective).toEqual([]); // not reported until the company has objectives
    expect(t.gaps.solutionsWithoutContribution).toEqual(solutions.map((s) => s.id));
    const aligned = strategyThread({ ...c, objectives: [{ id: 'o1', text: 'MTP' }], projectObjectiveIds: ['o1'] });
    expect(aligned.okrs.every((o) => o.objectiveIds.includes('o1') && o.inherited)).toBe(true);
    expect(aligned.objectives[0]).toMatchObject({ viaProject: true, okrIds: aligned.okrs.map((o) => o.id) });
    const orphan = strategyThread({ ...c, objectives: [{ id: 'o1', text: 'MTP' }] });
    expect(orphan.gaps.okrsWithoutObjective).toEqual(orphan.okrs.map((o) => o.id));
  });

  it('a digital solution without a registered use case is a gap; a contribution links a solution to the KPI', () => {
    const s = solutions[0]!;
    const k = demoKpis(pack.pack).kpis[0]!;
    let data = setSolutionType(emptyStrategy(), s.id, 'digital', 'Tester', '2026-11-09T00:00:00Z');
    const c = { ...base(), useCases: [], strategy: data };
    expect(strategyThread(c).gaps.digitalWithoutUseCase).toContain(s.id);
    data = upsertContribution(data, { ...contrib({ id: 'x', solutionId: s.id, kpiId: k.id }), lever: 'sites', leverUnit: 'sites', evidence: '' });
    const t = strategyThread({ ...c, strategy: data });
    expect(t.solutions.find((x) => x.id === s.id)!.kpiIds).toContain(k.id);
    expect(t.gaps.solutionsWithoutContribution).not.toContain(s.id);
    expect(t.sims.map((x) => x.kpiId)).toEqual([k.id]);
  });

  it('builds the deliverable that fits each solution type; it is complete only when no section is left to fill', () => {
    const s = solutions[0]!;
    for (const type of ['digital', 'people'] as const) {
      let data = setSolutionType(emptyStrategy(), s.id, type, 'Tester', '2026-11-09T00:00:00Z');
      const doc = () => {
        const c = { ...base(), strategy: data, deliverables: emptyDeliverables(), today: '2026-11-09' };
        const t = strategyThread(c);
        return buildSolutionDoc(s, t.solutions.find((x) => x.id === s.id)!, t, c, 'en');
      };
      const d = doc();
      expect(d.kind).toBe(DELIVERABLE_OF[type]);
      expect(d.sections.map((x) => x.id)).toEqual(SECTIONS[DELIVERABLE_OF[type]]);
      expect(d.complete).toBe(false);
      expect(d.sections.filter((x) => x.open).every((x) => hasToFill(x.text))).toBe(true);
      for (const sec of d.sections.filter((x) => x.open)) data = setSection(data, s.id, sec.id, `${sec.id} agreed by 2027-03-31`);
      const done = doc();
      expect(done.complete).toBe(true);
      expect(done.sections.filter((x) => x.edited).length).toBeGreaterThan(0);
    }
  });
});
