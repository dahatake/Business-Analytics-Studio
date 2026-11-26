import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import type { EntityOf } from '../src/data/schema.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { emptyDeliverables, type CheckContext } from '../src/modules/project/deliverables.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import {
  baselineScenario, BUDGET_UNITS, issueCandidates, partsOf, quintile, rank, selectFunded, sensitivity, solutionCandidates, stability, urgencyOf,
  type Candidate, type Scored, type ScoreKey,
} from '../src/modules/project/whatIf.ts';
import { inferActions, requirementsFileName, safeFileStem, scheduleActions } from '../src/modules/project/actionPlan.ts';
import { buildProductionDoc } from '../src/modules/project/productionRequirements.ts';
import { addMonths, BASE_KPI_LEVER, kpiWhatIf } from '../src/modules/project/kpiWhatIf.ts';
import { normalizeActionPlan, normalizeWhatIf } from '../src/modules/project/cockpitStore.ts';
import { ProjectFileExists, writeProjectFile } from '../scripts/lib/deviceLocation.ts';

const TODAY = '2026-11-26';
const pack = loadPack(samplePack);
const ctx = (): CheckContext & { strategy: ReturnType<typeof emptyStrategy> } => ({
  pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(),
  deliverables: emptyDeliverables(), today: TODAY, strategy: emptyStrategy(),
});

const S = (value: number): Scored => ({ value: value as 1, origin: 'user', basis: 'user' });
const cand = (id: string, s: Partial<Record<ScoreKey, number>>, costJpy?: number): Candidate => ({
  id, kind: 'solution', ...(costJpy !== undefined ? { costJpy } : {}),
  scores: { value: S(s.value ?? 3), alignment: S(s.alignment ?? 3), confidence: S(s.confidence ?? 3), execution: S(s.execution ?? 3), option: S(s.option ?? 3), urgency: S(s.urgency ?? 3), size: S(s.size ?? 3) },
});

describe('FR-378 what-if prioritisation', () => {
  it('uses the WSJF form: benefit × time ÷ size', () => {
    const neutral = { value: 3, alignment: 3, confidence: 3, execution: 3, option: 3, urgency: 3, size: 3 };
    const p = partsOf(neutral, baselineScenario().weights);
    expect(p.benefit).toBeCloseTo(0.5);
    expect(p.time).toBeCloseTo(1.25);
    expect(p.size).toBeCloseTo(1);
    expect(p.priority).toBeCloseTo(62.5);
    // Doubling the size halves the priority; full urgency at strength 100 doubles it.
    expect(partsOf({ ...neutral, size: 6 }, baselineScenario().weights).priority).toBeCloseTo(31.25);
    expect(partsOf({ ...neutral, urgency: 5 }, { ...baselineScenario().weights, urgency: 100 }).time).toBeCloseTo(2);
  });

  it('derives every default from the data, a rule, or the labelled midpoint', () => {
    const issues = issueCandidates(ctx());
    expect(issues.map((c) => c.id)).toEqual(expect.arrayContaining(['issue-lead-time', 'issue-cash']));
    const lead = issues.find((c) => c.id === 'issue-lead-time')!;
    expect(lead.scores.value).toEqual({ value: 5, origin: 'data', basis: 'impact' });
    expect(lead.scores.execution).toEqual({ value: 3, origin: 'data', basis: 'feasibility' });
    expect(lead.scores.option.origin).toBe('unrated');
    expect(lead.scores.confidence).toMatchObject({ value: 5, origin: 'rule', basis: 'sourcedMeasured' });
    expect(lead.costJpy).toBe(48_000_000);
    const sols = solutionCandidates(ctx());
    const dp = sols.find((c) => c.id === 'sol-demand-planning')!;
    // Largest benefit of the five solutions → 5; a pilot initiative → reversible, try small.
    expect(dp.scores.value).toMatchObject({ value: 5, basis: 'benefit' });
    expect(dp.scores.option).toMatchObject({ value: 4, basis: 'pilot' });
    expect(quintile([1, 2, 3, 4, 5], 1)).toBe(1);
    expect(quintile([1, 2, 3, 4, 5], 5)).toBe(5);
    expect(urgencyOf([], TODAY).origin).toBe('unrated');
    expect(urgencyOf(['2027-01-31'], TODAY).value).toBe(5);
    expect(urgencyOf(['2028-12-31'], TODAY).value).toBe(1);
  });

  it('funds the best combination under budget and item cap (matches brute force, never over budget)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let trial = 0; trial < 40; trial += 1) {
      const n = 3 + Math.floor(rnd() * 6);
      const budget = 100 * BUDGET_UNITS;
      const items = Array.from({ length: n }, (_, i) => ({
        id: `x${i}`, value: Math.round(rnd() * 100) / 10, costJpy: 100 * Math.floor(1 + rnd() * BUDGET_UNITS * 0.6), required: false, priority: rnd(), benefit: rnd(),
      }));
      const cap = trial % 2 ? null : 1 + Math.floor(rnd() * n);
      const got = selectFunded(items, budget, cap);
      const cost = got.ids.reduce((a, id) => a + items.find((x) => x.id === id)!.costJpy, 0);
      expect(cost).toBeLessThanOrEqual(budget);
      if (cap !== null) expect(got.ids.length).toBeLessThanOrEqual(cap);
      let best = 0;
      for (let mask = 0; mask < 1 << n; mask += 1) {
        const pick = items.filter((_, i) => mask & (1 << i));
        if (pick.reduce((a, x) => a + x.costJpy, 0) <= budget && (cap === null || pick.length <= cap)) best = Math.max(best, pick.reduce((a, x) => a + x.value, 0));
      }
      expect(got.ids.reduce((a, id) => a + items.find((x) => x.id === id)!.value, 0)).toBeCloseTo(best, 9);
    }
  });

  it('keeps must-do items, drops excluded ones and flags over-commitment', () => {
    const cands = [cand('a', { value: 5 }, 60), cand('b', { value: 4 }, 50), cand('c', { value: 1 }, 50)];
    const r = rank(cands, { ...baselineScenario(), required: ['c'], excluded: ['a'], budgetJpy: 100, maxItems: null });
    expect(r.funded.sort()).toEqual(['b', 'c']);
    expect(r.rows.find((x) => x.id === 'a')).toMatchObject({ excluded: true, rank: 0, funded: false });
    expect(rank(cands, { ...baselineScenario(), required: ['a', 'b'], budgetJpy: 100, maxItems: null }).overCommitted).toBe(true);
  });

  it('finds the weight at which first place changes (closed form)', () => {
    // Only value (30) and alignment (20) count: a leads while 30·m_value > 20 and 30 > 20·m_alignment.
    const w = { value: 30, alignment: 20, confidence: 0, execution: 0, option: 0, urgency: 0 };
    const cands = [cand('a', { value: 5, alignment: 1 }), cand('b', { value: 1, alignment: 5 })];
    const s = sensitivity(cands, { ...baselineScenario(), weights: w });
    const value = s.find((x) => x.key === 'value')!;
    const alignment = s.find((x) => x.key === 'alignment')!;
    expect(value).toMatchObject({ holdsFrom: 0.7, lowLeader: 'b' });
    expect(alignment).toMatchObject({ holdsTo: 1.5, highLeader: 'b' });
    expect(s.find((x) => x.key === 'confidence')).toMatchObject({ lowLeader: null, highLeader: null });
  });

  it('measures how settled first place is, reproducibly', () => {
    const cands = issueCandidates(ctx());
    const a = stability(cands, baselineScenario());
    expect(stability(cands, baselineScenario())).toEqual(a);
    expect(a.reduce((x, r) => x + r.first, 0)).toBeCloseTo(1, 6);
    expect(a.reduce((x, r) => x + r.top3, 0)).toBeCloseTo(3, 6);
    const clear = stability([cand('a', { value: 5, alignment: 5, confidence: 5 }), cand('b', { value: 1, alignment: 1, confidence: 5 })], baselineScenario());
    expect(clear[0]).toMatchObject({ id: 'a', first: 1 });
  });

  it('ignores malformed saved scenarios', () => {
    const d = normalizeWhatIf({ issue: { current: { weights: { value: 999, alignment: 'x' }, overrides: { a: { value: 9, size: 2 } }, budgetJpy: -1 } }, solution: 3 });
    expect(d.issue.current.weights.value).toBe(30);
    expect(d.issue.current.overrides).toEqual({ a: { size: 2 } });
    expect(d.issue.current.budgetJpy).toBeNull();
    expect(d.solution.current).toEqual(baselineScenario());
  });
});

describe('FR-378 KPI what-if', () => {
  const k = { id: 'k', baseline: 100, current: 80, target: 50, deadline: '2027-11-26' };
  it('computes the required pace and responds to target and deadline', () => {
    const [base] = kpiWhatIf([k], [], TODAY, BASE_KPI_LEVER);
    expect(base!.gap).toBe(30);
    expect(base!.progress).toBeCloseTo(0.4);
    expect(base!.pace!).toBeCloseTo(30 / 12, 1);
    // 30 of the 50-unit distance remain over 12 months: 5% of the distance a month.
    expect(base!.monthlyShare!).toBeCloseTo(30 / 12 / 50, 2);
    const [later] = kpiWhatIf([k], [], TODAY, { ...BASE_KPI_LEVER, deadlineMonths: 12 });
    expect(later!.pace!).toBeCloseTo(30 / 24, 1);
    const [stretch] = kpiWhatIf([k], [], TODAY, { ...BASE_KPI_LEVER, stretch: 0.2 });
    expect(stretch!.target).toBe(40);
    const [overdue] = kpiWhatIf([{ ...k, deadline: '2026-01-31' }], [], TODAY, BASE_KPI_LEVER);
    expect(overdue!.pace).toBeNull();
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('FR-378 action plan and production requirements', () => {
  const sol = (id: string) => pack.byId.get(id) as EntityOf<'solution'>;
  it('infers the kinds of action from products and wording, with the reason', () => {
    expect(inferActions(sol('sol-demand-planning'), 'digital').map((a) => a.type)).toEqual(['dataPipeline', 'analytics', 'mlModel', 'change']);
    expect(inferActions(sol('sol-knowledge-copilot'), 'digital').map((a) => a.type)).toEqual(['copilotPrompt', 'dataPipeline', 'change']);
    expect(inferActions(sol('sol-e-invoice'), 'digital').map((a) => a.type)).toEqual(['app', 'dataPipeline', 'change']);
    const reasons = inferActions(sol('sol-demand-planning'), 'digital');
    expect(reasons.find((a) => a.type === 'mlModel')!.reason).toBe('Azure Machine Learning');
    expect(inferActions(sol('sol-e-invoice'), 'people').map((a) => a.type)).toContain('change');
    expect(inferActions({ name: { ja: 'x', en: 'x' }, description: { ja: 'y', en: 'y' }, msProducts: [] }, 'digital').map((a) => a.type)).toEqual(['app', 'change']);
  });

  it('orders actions by dependency and solutions by priority within the lanes', () => {
    const actions = { a: inferActions(sol('sol-demand-planning'), 'digital'), b: inferActions(sol('sol-e-invoice'), 'digital') };
    const one = scheduleActions(['a', 'b'], actions, 1);
    const at = (key: string) => one.find((x) => x.key === key)!;
    expect(at('a:analytics').startWeek).toBe(at('a:dataPipeline').endWeek);
    expect(at('a:change').startWeek).toBe(Math.max(at('a:analytics').endWeek, at('a:mlModel').endWeek));
    expect(at('b:app').startWeek).toBe(at('a:change').endWeek);
    const two = scheduleActions(['a', 'b'], actions, null);
    expect(two.find((x) => x.key === 'b:app')!.startWeek).toBe(0);
  });

  it('writes the requested file name, keeps unknowns to fill and invents no number', () => {
    expect(requirementsFileName('需要予測と生産計画の最適化')).toBe('需要予測と生産計画の最適化-Production-Requirements-Definision.md');
    expect(safeFileStem('a/b:c?')).toBe('a_b_c_');
    expect(safeFileStem('CON')).toBe('_CON');
    const c = ctx();
    const s = sol('sol-demand-planning');
    const actions = inferActions(s, 'digital');
    const doc = buildProductionDoc({
      solution: s, actions, schedule: scheduleActions([s.id], { [s.id]: actions }, null), ctx: c, lang: 'ja',
      company: 'サンプル', project: 'デモ', planStart: TODAY, visible: () => true,
    });
    for (const h of ['## 4. 業務要求', '### 5.1', 'データ連携', '機械学習モデル', 'データの可視化', '## 11. 追跡表', '## 12. 未決事項']) expect(doc.markdown).toContain(h);
    expect(doc.requirementIds).toEqual(expect.arrayContaining(['DP-01', 'BI-02', 'ML-04']));
    expect(doc.markdown).toContain('時系列の予測');
    expect(doc.toFill.length).toBeGreaterThan(5);
    expect(doc.markdown.match(/【要記入】/g)!.length).toBeGreaterThanOrEqual(doc.toFill.length - 2);
    // Every number in the KPI lines comes from the project data.
    const kpi = c.kpi.kpis.find((k) => s.kpiIds.includes(k.id))!;
    expect(doc.markdown).toContain(`BR-${kpi.id}`);
    const en = buildProductionDoc({ solution: s, actions, schedule: [], ctx: c, lang: 'en', company: 'Sample', project: 'Demo', planStart: TODAY, visible: () => true });
    expect(en.markdown).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/);
  });

  it('normalizes a stored plan', () => {
    const p = normalizeActionPlan({ actions: { a: [{ type: 'app' }, { type: 'app' }, { type: 'bogus' }] }, selected: [1], start: 'x' });
    expect(p.actions.a!.map((x) => x.type)).toEqual(['app']);
    expect(p.selected).toBeNull();
    expect(p.start).toBeNull();
  });
});

describe('FR-378 saving into the project folder', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it('writes only portable Markdown names inside projects/ and never overwrites silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bas-files-'));
    dirs.push(dir);
    const path = writeProjectFile(dir, 'サンプル-デモ', 'a-Production-Requirements-Definision.md', '# a', false);
    expect(path).toBe(join(dir, 'projects', 'サンプル-デモ', 'a-Production-Requirements-Definision.md'));
    expect(readFileSync(path, 'utf8')).toBe('# a');
    expect(() => writeProjectFile(dir, 'サンプル-デモ', 'a-Production-Requirements-Definision.md', '# b', false)).toThrow(ProjectFileExists);
    writeProjectFile(dir, 'サンプル-デモ', 'a-Production-Requirements-Definision.md', '# b', true);
    expect(readFileSync(path, 'utf8')).toBe('# b');
    for (const [folder, name] of [['..', 'a.md'], ['p', '../a.md'], ['p', 'a/b.md'], ['p', 'a.txt'], ['CON', 'a.md'], ['p', 'a.md.'], ['', 'a.md']]) {
      expect(() => writeProjectFile(dir, folder, name, 'x', true)).toThrow();
    }
    expect(() => writeProjectFile(dir, 'p', 'a.md', 'x'.repeat(4 * 1024 * 1024 + 1), true)).toThrow();
    writeFileSync(join(dir, 'outside.md'), 'keep');
    expect(readFileSync(join(dir, 'outside.md'), 'utf8')).toBe('keep');
  });
});
