import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import { valueEngine, type EngineLine, type EngineModel } from '../src/modules/project/valueEngine.ts';
import {
  adoptVerifiedDraft, buildValueModel, coverage, cumulativeShare, demoValue, dismissSuggestion, emptyValue, evalFormula, normalizeValue, parseValueDraft, realizationOf, ruleDraft,
  setIncluded, suggestGroups, suggestLinks, upsertBenefit, upsertLink, valueChecks, valueDraftPrompt, type BenefitLine, type DraftContext, type ValueData,
} from '../src/modules/project/valueModel.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { valueHtml } from '../src/modules/project/valueHtml.ts';
import { CONCEPT_REFS, EXPLAIN_CONCEPTS, exampleLine, explainFacts, explainPrompt, parseExplain, REFERENCES, ruleExplanation, valueTree, workedExample } from '../src/modules/project/valueExplain.ts';

const pt = (v: number) => ({ low: v, mode: v, high: v });
const annuity = (r: number, n: number) => (r === 0 ? n : (1 - (1 + r) ** -n) / r);
const line = (over: Partial<EngineLine> = {}): EngineLine => ({
  id: 'l1', solutionId: 'a', lever: 'cost', monetized: true, oneOff: false, sign: 1, amount: pt(30), conversion: pt(1), ...over,
});
const model = (over: Partial<EngineModel> = {}): EngineModel => ({
  solutions: [{ id: 'a', cost: pt(100), buildYears: 0 }],
  lines: [line()], links: [], selected: ['a'], discountRate: 0.1, horizonYears: 5, runs: 200, seed: 1, rateSwing: 0.03,
  stress: { costFactor: 5, benefitFactor: 0.375 }, ...over,
});

describe('value engine (FR-327)', () => {
  it('matches the closed-form NPV of a certain annuity and puts all runs on it', () => {
    const r = valueEngine(model());
    const npv = -100 + 30 * annuity(0.1, 5);
    expect(r.npv.mode).toBeCloseTo(npv, 6);
    expect(r.npv.p10).toBeCloseTo(npv, 6);
    expect(r.npv.p90).toBeCloseTo(npv, 6);
    expect(r.npv.pPositive).toBe(1);
    expect(r.levers.investment).toBeCloseTo(-100);
    expect(r.levers.cost).toBeCloseTo(30 * annuity(0.1, 5));
  });

  it('ramps benefits after the build period and lands one-off cash in the first benefit year', () => {
    const r = valueEngine(model({
      solutions: [{ id: 'a', cost: pt(100), buildYears: 1.5 }],
      lines: [line(), line({ id: 'l2', lever: 'capital', oneOff: true, amount: pt(50) })],
    }));
    const d = (t: number) => 1.1 ** -t;
    const annual = 30 * (0.5 * d(2) + d(3) + d(4) + d(5));
    expect(r.levers.cost).toBeCloseTo(annual, 6);
    expect(r.levers.capital).toBeCloseTo(50 * d(2), 6);
    expect(r.npv.mode).toBeCloseTo(-100 + annual + 50 * d(2), 6);
  });

  it('counts dis-benefits and conversion, and the drivers add up to the NPV', () => {
    const r = valueEngine(model({ lines: [line({ conversion: pt(0.5) }), line({ id: 'run', sign: -1, amount: pt(4) })] }));
    const a = annuity(0.1, 5);
    expect(r.levers.cost).toBeCloseTo(15 * a, 6);
    expect(r.levers.disbenefit).toBeCloseTo(-4 * a, 6);
    expect(Object.values(r.levers).reduce((x, y) => x + y, 0)).toBeCloseTo(r.npv.mode, 6);
  });

  it('applies enables, synergy, overlap and shared cost only when both solutions are in the portfolio', () => {
    const two = (links: EngineModel['links'], selected = ['a', 'b']) => valueEngine(model({
      solutions: [{ id: 'a', cost: pt(100), buildYears: 0 }, { id: 'b', cost: pt(40), buildYears: 0 }],
      lines: [line(), line({ id: 'lb', solutionId: 'b', amount: pt(20) })], links, selected,
    }));
    const a = annuity(0.1, 5);
    const pvB = (mult: number, cost = 40) => -cost + 20 * mult * a;
    const enables = two([{ kind: 'enables', from: 'a', to: 'b', share: 0 }], ['b']);
    expect(enables.npv.mode).toBeCloseTo(-40, 6);
    expect(enables.solutions.find((s) => s.id === 'b')!.enabled).toBe(false);
    // b alone is worth only its cost; inside the portfolio a is worth its own value plus b's benefits.
    const both = two([{ kind: 'enables', from: 'a', to: 'b', share: 0 }]);
    const sa = both.solutions.find((s) => s.id === 'a')!;
    expect(sa.standalone).toBeCloseTo(-100 + 30 * a, 6);
    expect(sa.marginal).toBeCloseTo(-100 + 30 * a + 20 * a, 6);
    expect(two([{ kind: 'synergy', from: 'a', to: 'b', share: 0.25 }]).solutions.find((s) => s.id === 'b')!.pv).toBeCloseTo(pvB(1.25), 6);
    expect(two([{ kind: 'overlap', from: 'a', to: 'b', share: 0.5 }]).solutions.find((s) => s.id === 'b')!.pv).toBeCloseTo(pvB(0.5), 6);
    expect(two([{ kind: 'sharedCost', from: 'a', to: 'b', share: 0.5 }]).solutions.find((s) => s.id === 'b')!.pv).toBeCloseTo(pvB(1, 20), 6);
    expect(two([{ kind: 'overlap', from: 'a', to: 'b', share: 0.5 }], ['b']).solutions.find((s) => s.id === 'b')!.pv).toBeCloseTo(pvB(1), 6);
  });

  it('is reproducible for a seed and its Monte Carlo mean agrees with the expected value', () => {
    const m = model({
      runs: 4000,
      solutions: [{ id: 'a', cost: { low: 80, mode: 100, high: 180 }, buildYears: 0 }],
      lines: [line({ amount: { low: 10, mode: 30, high: 60 }, conversion: { low: 0.4, mode: 0.7, high: 1 } })],
    });
    const r = valueEngine(m);
    expect(valueEngine(m)).toEqual(r);
    expect(valueEngine({ ...m, seed: 2 }).npv.p50).not.toBe(r.npv.p50);
    const mean = (x: { low: number; mode: number; high: number }) => (x.low + x.mode + x.high) / 3;
    const expected = -mean({ low: 80, mode: 100, high: 180 }) + mean({ low: 10, mode: 30, high: 60 }) * mean({ low: 0.4, mode: 0.7, high: 1 }) * annuity(0.1, 5);
    expect(Math.abs(r.npv.mean - expected) / Math.abs(expected)).toBeLessThan(0.05);
    expect(r.npv.p10).toBeLessThan(r.npv.p50);
    expect(r.npv.p50).toBeLessThan(r.npv.p90);
    expect(r.hist.counts.reduce((x, y) => x + y, 0)).toBe(4000);
  });

  it('ranks the inputs in a tornado and runs the black-swan stress test', () => {
    const r = valueEngine(model({ lines: [line({ amount: { low: 10, mode: 30, high: 60 } })] }));
    const amount = r.tornado.find((b) => b.kind === 'amount')!;
    expect(amount.atLow).toBeCloseTo(-100 + 10 * annuity(0.1, 5), 6);
    expect(amount.atHigh).toBeCloseTo(-100 + 60 * annuity(0.1, 5), 6);
    expect(r.tornado[0]!.id).toBe('amount:l1');
    expect(r.tornado.some((b) => b.kind === 'rate')).toBe(true);
    expect(r.stress).toEqual({ solutionId: 'a', npv: expect.closeTo(-500 + 30 * 0.375 * annuity(0.1, 5), 6) });
  });

  it('reports the discounted payback', () => {
    expect(valueEngine(model({ discountRate: 0 })).payback).toBeCloseTo(100 / 30, 6);
    expect(valueEngine(model({ lines: [line({ amount: pt(10) })] })).payback).toBeNull();
  });

  it('gives the same result from its embedded source as from the module (the exported HTML recomputes it)', () => {
    const m = model({ lines: [line({ amount: { low: 10, mode: 30, high: 60 } })], runs: 500 });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const embedded = new Function(`return (${String(valueEngine)});`)() as typeof valueEngine;
    expect(embedded(m)).toEqual(valueEngine(m));
  });
});

describe('value model from project data (FR-327)', () => {
  const pack = loadPack(samplePack);
  const visible = () => true;

  it('stands the pack benefit in for an undecomposed solution and flags it', () => {
    const built = buildValueModel(pack, emptyStrategy(), emptyValue(), visible, { runs: 50 });
    const sol = pack.pack.entities.find((e) => e.kind === 'solution' && e.id === 'sol-e-invoice')!;
    expect(built.solutions.every((s) => s.implicit)).toBe(true);
    expect(built.model.lines.find((l) => l.solutionId === 'sol-e-invoice')!.amount.mode).toBe(sol.kind === 'solution' ? sol.annualBenefitJpy : 0);
    const checks = valueChecks(emptyValue(), built).map((c) => c.id);
    expect(checks).toEqual(expect.arrayContaining(['undecomposed', 'noDisbenefit', 'openCells', 'defaultRate', 'pointEstimate']));
  });

  it('shows the one-off working capital the single annual figure hid (demo)', () => {
    const built = buildValueModel(pack, emptyStrategy(), demoValue(), visible, { runs: 200 });
    const r = valueEngine(built.model);
    expect(r.levers.capital).toBeGreaterThan(0);
    expect(r.levers.disbenefit).toBeLessThan(0);
    const cells = coverage(demoValue(), built.solutions).filter((c) => c.solutionId === 'sol-e-invoice');
    expect(cells.find((c) => c.column === 'capital')!.state).toBe('money');
    expect(cells.find((c) => c.column === 'risk')!.state).toBe('open');
    expect(cells.find((c) => c.column === 'disbenefit')!.state).toBe('money');
  });

  it('leaves out solutions hidden from the audience and excluded ones from the selection', () => {
    const built = buildValueModel(pack, emptyStrategy(), setIncluded(emptyValue(), 'sol-e-invoice', false), (id) => id !== 'sol-knowledge-copilot');
    expect(built.hidden).toBe(1);
    expect(built.solutions.map((s) => s.id)).not.toContain('sol-knowledge-copilot');
    expect(built.model.selected).not.toContain('sol-e-invoice');
  });

  it('suggests links the data implies, never with a share, and forgets dismissed ones', () => {
    const data = emptyValue();
    const built = buildValueModel(pack, emptyStrategy(), data, visible);
    const s = suggestLinks(pack, data, built.solutions);
    const shared = s.find((x) => x.kind === 'sharedCost')!;
    expect(shared).toMatchObject({ from: 'sol-demand-planning', to: 'sol-energy-twin', reason: 'sharedProduct', detail: ['Microsoft Fabric'] });
    expect(suggestLinks(pack, dismissSuggestion(data, shared.key), built.solutions).some((x) => x.key === shared.key)).toBe(false);
    const confirmed = upsertLink(data, { id: 'k1', kind: 'sharedCost', from: 'sol-demand-planning', to: 'sol-energy-twin', share: 0.2, note: '', at: '', by: '' });
    expect(suggestLinks(pack, confirmed, built.solutions).some((x) => x.key === shared.key)).toBe(false);
  });

  it('flags an enabler left out of the portfolio and a cost saving assumed to be all cash', () => {
    const fullCash: BenefitLine = { id: 'x', solutionId: 'sol-energy-twin', label: 'x', lever: 'cost', nature: 'financial', timing: 'annual', sign: 'benefit', amountJpy: pt(1), conversion: pt(1), owner: 'o', basis: 'expert', evidence: '' };
    let data = upsertLink({ ...emptyValue(), benefits: [fullCash] }, { id: 'k', kind: 'enables', from: 'sol-demand-planning', to: 'sol-energy-twin', share: 0, note: '', at: '', by: '' });
    data = setIncluded(data, 'sol-demand-planning', false);
    const checks = valueChecks(data, buildValueModel(pack, emptyStrategy(), data, visible, { runs: 10 }));
    expect(checks.find((c) => c.id === 'enablerMissing')!.refs).toEqual(['sol-energy-twin']);
    expect(checks.find((c) => c.id === 'fullConversion')!.refs).toEqual(['x']);
    expect(checks.find((c) => c.id === 'unmeasured')!.refs).toEqual(['x']);
  });

  it('keeps valid items and drops invalid ones when loading saved data', () => {
    const ok = demoValue().benefits[0]!;
    const data = normalizeValue({
      benefits: [ok, { ...ok, id: 'bad', amountJpy: undefined }, { ...ok, id: 'bad2', conversion: { low: 0, mode: 1.5, high: 2 } }],
      links: [{ id: 'k', kind: 'overlap', from: 'a', to: 'a', share: 0.5, note: '', at: '', by: '' }],
      settings: { discountRate: 0.9, horizonYears: 7, confirmed: true, excluded: ['x', 3], costs: { a: { low: 1, mode: 2, high: 3 }, b: { low: 3, mode: 2, high: 1 } } },
    });
    expect(data.benefits.map((b) => b.id)).toEqual([ok.id]);
    expect(data.links).toEqual([]);
    expect(data.settings).toEqual({ discountRate: 0.08, horizonYears: 7, confirmed: false, excluded: ['x'], costs: { a: { low: 1, mode: 2, high: 3 } }, adoptionRho: 0.5, correlationConfirmed: false, applyRealization: false });
  });
});

describe('interactive value model HTML (FR-327)', () => {
  const pack = loadPack(samplePack);
  const built = buildValueModel(pack, emptyStrategy(), demoValue(), () => true, { runs: 300 });
  const html = valueHtml({ model: built.model, lang: 'ja', title: 'テスト <Project>', names: { 'sol-e-invoice': '請求 </script><b>' }, lineLabels: {}, createdAt: '2026-11-18' });

  it('is self-contained, locked down and escapes data', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('テスト &lt;Project&gt;');
  });

  it('recomputes the same NPV as the app when opened', () => {
    document.open();
    document.write(html);
    document.close();
    const shown = document.querySelector('[data-testid="vh-p50"]')!.getAttribute('data-value');
    expect(Number(shown)).toBeCloseTo(valueEngine(built.model).npv.p50, 3);
    (document.querySelector('[data-solution="sol-e-invoice"]') as HTMLInputElement).click();
    const without = valueEngine({ ...built.model, selected: built.model.selected.filter((id) => id !== 'sol-e-invoice') });
    expect(Number(document.querySelector('[data-testid="vh-p50"]')!.getAttribute('data-value'))).toBeCloseTo(without.npv.p50, 3);
  });
});

describe('the app resolves the remaining items (FR-335)', () => {
  const pack = loadPack(samplePack);
  const kpis = demoKpis(samplePack).kpis.map((k) => ({ id: k.id, baseline: k.baseline, current: k.current, target: k.target, name: typeof k.name === 'string' ? k.name : k.name.ja, unit: typeof k.unit === 'string' ? k.unit : k.unit.ja }));
  const ctxOf = (data: ValueData, p = pack): DraftContext => ({ pack: p, data, built: buildValueModel(p, emptyStrategy(), data, () => true, { runs: 50 }), kpis, lang: 'ja', at: '2026-11-18T00:00:00Z' });

  it('correlates grouped effects as theory predicts (Spearman 6/π·asin(ρ/2)) and keeps independent runs unchanged', () => {
    const two = (groups?: EngineModel['groups']) => valueEngine(model({
      runs: 20_000, discountRate: 0, horizonYears: 1,
      lines: [line({ amount: { low: 0, mode: 50, high: 100 } }), line({ id: 'l2', amount: { low: 0, mode: 50, high: 100 } })],
      ...(groups ? { groups } : {}),
    }));
    const width = (r: ReturnType<typeof valueEngine>) => r.npv.p90 - r.npv.p10;
    const base = two();
    expect(two([])).toEqual(base);
    const spearman = (rho: number) => (6 / Math.PI) * Math.asin(rho / 2);
    for (const rho of [0.5, 1]) {
      const ratio = width(two([{ id: 'g', rho, lineIds: ['l1', 'l2'] }])) / width(base);
      expect(ratio).toBeGreaterThan(Math.sqrt(1 + spearman(rho)) * 0.95);
      expect(ratio).toBeLessThan(Math.sqrt(1 + spearman(rho)) * 1.05);
    }
  });

  it('finds the IRR at which NPV is zero and applies the realisation correction', () => {
    const r = valueEngine(model());
    expect(r.irr).toBeCloseTo(0.15238, 4);
    expect(valueEngine(model({ discountRate: r.irr! })).npv.mode).toBeCloseTo(0, 4);
    expect(valueEngine(model({ lines: [line({ amount: pt(10) })] })).irr).toBeLessThan(0);
    expect(valueEngine(model({ realization: 0.5 })).levers.cost).toBeCloseTo(15 * annuity(0.1, 5), 6);
  });

  it('puts the effects of one solution in an adoption group (PARAM-185) and suggests cross-solution groups by KPI', () => {
    const built = buildValueModel(pack, emptyStrategy(), demoValue(), () => true);
    expect(built.model.groups).toContainEqual({ id: 'adoption:sol-e-invoice', rho: 0.5, lineIds: ['val-demo-ei-cost', 'val-demo-ei-capital'] });
    expect(valueChecks(demoValue(), built).map((c) => c.id)).toContain('defaultCorrelation');
    const shared: BenefitLine = { ...demoValue().benefits[0]!, id: 'x', solutionId: 'sol-vision-inspection' };
    const data = upsertBenefit(demoValue(), shared);
    expect(suggestGroups(data, buildValueModel(pack, emptyStrategy(), data, () => true))).toEqual([{ key: 'group:kpi:kpi-dso', kpiId: 'kpi-dso', lineIds: ['val-demo-ei-capital', 'val-demo-ei-cost', 'x'] }]);
  });

  it('evaluates formulas without eval and refuses anything else', () => {
    expect(evalFormula('benefit * (share - 0.1) / 2', { benefit: 100, share: 0.5 })).toBeCloseTo(20);
    expect(evalFormula('a × b ÷ c', { a: 6, b: 4, c: 3 })).toBeCloseTo(8);
    expect(evalFormula('-a + 2', { a: 1 })).toBe(1);
    expect(evalFormula('unknown * 2', {})).toBeNull();
    expect(evalFormula('alert(1)', {})).toBeNull();
    expect(evalFormula('1 +', {})).toBeNull();
  });

  it('recomputes every drafted amount and rejects forged facts, mismatches, unknown ids, caps and duplicates', () => {
    const c = ctxOf(emptyValue());
    const benefit = 30_000_000;
    const base = { solutionId: 'sol-e-invoice', lever: 'cost', nature: 'financial', timing: 'annual', sign: 'benefit', kpiId: 'kpi-dso', owner: '経理部長', conversion: { low: 0.5, mode: 0.7, high: 0.9 } };
    const d = parseValueDraft(JSON.stringify({ lines: [
      { ...base, label: '派生', amount: { low: 20e6, mode: benefit, high: 40e6 }, formula: 'b', inputs: [{ name: 'b', value: benefit, ref: 'sol-e-invoice.annualBenefitJpy' }] },
      { ...base, label: '仮定', amount: { low: 10e6, mode: 15e6, high: 20e6 }, formula: 'b * s', inputs: [{ name: 'b', value: benefit, ref: 'sol-e-invoice.annualBenefitJpy' }, { name: 's', value: 0.5, ref: 'assumption' }] },
      { ...base, label: '偽の値', amount: { low: 10e6, mode: 99e6, high: 120e6 }, formula: 'b', inputs: [{ name: 'b', value: 99e6, ref: 'sol-e-invoice.annualBenefitJpy' }] },
      { ...base, label: '計算違い', amount: { low: 1e6, mode: 5e6, high: 9e6 }, formula: 'b * s', inputs: [{ name: 'b', value: benefit, ref: 'sol-e-invoice.annualBenefitJpy' }, { name: 's', value: 0.5 }] },
      { ...base, solutionId: 'ghost', label: 'x', amount: { low: 1, mode: 1, high: 1 } },
      { ...base, lever: 'magic', label: 'y' },
      { ...base, label: '幅が不正', amount: { low: 5, mode: 1, high: 9 } },
      { ...base, label: '測定のみ', nature: 'measurable', kpiId: 'kpi-ghost' },
      ...Array.from({ length: 4 }, (_, i) => ({ ...base, label: `多すぎ${i}`, nature: 'observable' })),
    ], reviewed: [{ solutionId: 'sol-e-invoice', lever: 'risk', reason: '該当なし' }, { solutionId: 'sol-e-invoice', lever: 'cost', reason: '下書きにある' }],
    groups: [{ name: 'g', rho: 0.6, lines: ['d0', 'd1'], reason: '同じ要因' }, { name: 'bad', rho: 2, lines: ['d0', 'd1'] }],
    discountRate: { value: 0.065, sourceRef: 'src-annual-report', rationale: 'x' } }), c, 'copilot');
    const status = Object.fromEntries(d.lines.map((l) => [typeof l.label === 'string' ? l.label : l.label.ja, l.provenance?.status]));
    expect(status).toMatchObject({ 派生: 'derived', 仮定: 'assumed', 偽の値: 'unverified', 計算違い: 'unverified', 測定のみ: 'noNumber' });
    expect(d.lines.find((l) => l.label === '測定のみ')!.kpiId).toBeUndefined();
    expect(d.lines).toHaveLength(6);
    expect(d.rejected).toEqual(expect.arrayContaining(['d4:invalid', 'd5:invalid', 'd6:amount', 'd11:limit', 'reviewed:sol-e-invoice:cost', 'group']));
    expect(d.reviewed).toEqual([{ solutionId: 'sol-e-invoice', column: 'risk', reason: '該当なし' }]);
    expect(d.groups).toEqual([{ name: 'g', rho: 0.6, lineIds: [d.lines[0]!.id, d.lines[1]!.id], reason: '同じ要因' }]);
    expect(d.discountRate).toMatchObject({ value: 0.065, grounded: false });
    expect(d.overclaim).toEqual(['sol-e-invoice']);
    // A rate the source states is grounded.
    const withWacc = structuredClone(samplePack);
    const src = withWacc.entities.find((e) => e.id === 'src-annual-report')! as { description: { ja: string; en: string } };
    src.description = { ja: '資本コスト（WACC）は 6.5％ と開示。', en: 'Discloses a WACC of 6.5%.' };
    const p2 = loadPack(withWacc);
    expect(parseValueDraft({ lines: [], discountRate: { value: 0.065, sourceRef: 'src-annual-report' } }, ctxOf(emptyValue(), p2), 'copilot').discountRate!.grounded).toBe(true);
    // Adopting all leaves the unverified lines for a person and never touches them silently.
    const adopted = adoptVerifiedDraft({ ...emptyValue(), draft: d }, 'E2E', '2026-11-18T00:00:00Z');
    expect(adopted.benefits.map((b) => b.label)).toEqual(['派生', '仮定', '測定のみ', '多すぎ0', '多すぎ1', '多すぎ2'].filter((x) => d.lines.some((l) => l.label === x && l.provenance?.status !== 'unverified')));
    expect(adopted.draft!.lines.map((l) => l.provenance!.status)).toEqual(['unverified', 'unverified']);
    expect(adopted.groups).toHaveLength(1);
    expect(adopted.settings.discountRate).toBe(0.08);
  });

  it('drafts deterministically from the pack without AI and resolves the undecomposed and dis-benefit checks', () => {
    const c = ctxOf(emptyValue());
    const d = ruleDraft(c);
    expect(ruleDraft(c)).toEqual(d);
    expect(d.rejected).toEqual([]);
    expect(d.lines.filter((l) => l.amountJpy).every((l) => l.provenance!.status === 'assumed')).toBe(true);
    const capital = d.lines.find((l) => l.solutionId === 'sol-e-invoice' && l.lever === 'capital')!;
    expect(capital).toMatchObject({ nature: 'measurable', kpiId: 'kpi-dso' });
    expect(capital.amountJpy).toBeUndefined();
    const run = d.lines.find((l) => l.solutionId === 'sol-e-invoice' && l.sign === 'disbenefit')!;
    expect(run.amountJpy).toEqual({ low: 1_500_000, mode: 2_250_000, high: 3_000_000 });
    const after = adoptVerifiedDraft({ ...emptyValue(), draft: d }, 'E2E', '2026-11-18T00:00:00Z');
    const checks = valueChecks(after, buildValueModel(pack, emptyStrategy(), after, () => true, { runs: 10 })).map((x) => x.id);
    expect(checks).not.toContain('undecomposed');
    expect(checks).not.toContain('noDisbenefit');
    expect(valueDraftPrompt(c)).toContain('sol-e-invoice.annualBenefitJpy = 30000000');
    expect(valueDraftPrompt(c).startsWith('[bas-proj:valueDraft]')).toBe(true);
  });

  it('tracks realisation against plan to date, from actuals or KPI progress, with calibration', () => {
    expect(cumulativeShare(0.4, 0.5, false)).toBe(0);
    expect(cumulativeShare(1, 0.5, false)).toBeCloseTo(0.125);
    expect(cumulativeShare(2, 0.5, false)).toBeCloseTo(1);
    expect(cumulativeShare(0.6, 0.5, true)).toBe(1);
    const data = demoValue();
    const built = buildValueModel(pack, emptyStrategy(), data, () => true, { runs: 10 });
    const proxy = realizationOf(data, built, pack, kpis, '2027-08-03');
    expect(proxy.basis).toBe('proxy');
    const dso = kpis.find((k) => k.id === 'kpi-dso')!;
    const row = proxy.rows.find((r) => r.lineId === 'val-demo-ei-cost')!;
    const build = built.solutions.find((s) => s.id === 'sol-e-invoice')!.buildYears;
    const t = (Date.parse('2027-08-03') - Date.parse('2026-08-03')) / (365.25 * 24 * 3600 * 1000);
    expect(row.proxy).toBeCloseTo(((dso.current - dso.baseline) / (dso.target - dso.baseline)) / Math.min(1, t - build), 6);
    expect(row.planned!.mode).toBeCloseTo(24e6 * 0.7 * cumulativeShare(t, build, false), 0);
    const t1 = (Date.parse('2027-08-01') - Date.parse('2026-08-03')) / (365.25 * 24 * 3600 * 1000);
    const due = 24e6 * 0.7 * cumulativeShare(t1, build, false);
    const withActual = { ...data, actuals: [{ id: 'a', lineId: 'val-demo-ei-cost', date: '2027-08-01', amountJpy: due * 0.3, note: '', at: '', by: '' }] };
    const actual = realizationOf(withActual, built, pack, kpis, '2027-08-03');
    expect(actual.basis).toBe('actual');
    expect(actual.factor).toBeCloseTo(0.3, 6);
    expect(actual.coverage).toBe(0);
    const inside = realizationOf({ ...withActual, actuals: [{ ...withActual.actuals[0]!, amountJpy: due * 0.6 }] }, built, pack, kpis, '2027-08-03');
    expect(inside.coverage).toBe(1);
  });
});

describe('[Copilotで説明] explains how the numbers are produced (FR-336)', () => {
  const pack = loadPack(samplePack);
  const built = buildValueModel(pack, emptyStrategy(), demoValue(), () => true, { runs: 300 });
  const names = Object.fromEntries([...built.solutions.map((s) => [s.id, s.id]), ...built.model.lines.map((l) => [l.id, `line ${l.id}`])]);
  const input = (m = built.model) => {
    const result = valueEngine(m);
    return { model: m, result, independent: m.groups?.length ? valueEngine({ ...m, groups: [] }) : null, names, linked: [] as string[] };
  };

  it('reproduces every line\'s present value step by step, and the tree adds up to the engine\'s NPV', () => {
    const linked = { ...built.model, links: [{ kind: 'synergy' as const, from: 'sol-demand-planning', to: 'sol-e-invoice', share: 0.2 }], realization: 0.9 };
    for (const m of [built.model, linked]) {
      const { result } = input(m);
      for (const id of Object.keys(result.linePv)) expect(workedExample(m, result, id)!.pv).toBeCloseTo(result.linePv[id]!, 4);
      const tree = valueTree(m, result);
      expect(tree.children.reduce((a, c) => a + c.value, 0)).toBeCloseTo(result.npv.mode, 4);
      for (const d of tree.children.filter((c) => c.kind === 'driver')) expect(d.children.reduce((a, c) => a + c.value, 0)).toBeCloseTo(d.value, 4);
    }
    const { result } = input();
    const ex = workedExample(built.model, result, 'val-demo-ei-cost')!;
    expect(ex.cash).toBeCloseTo(24e6 * 0.7, 4);
    expect(ex.factor).toBeCloseTo(ex.years.reduce((a, y) => a + y.share / 1.08 ** y.year, 0), 9);
    expect(exampleLine(result)).toBe(Object.entries(result.linePv).sort((a, b) => b[1] - a[1])[0]![0]);
  });

  it('writes an on-device explanation whose every figure is in the fact ledger, in both languages', () => {
    for (const lang of ['ja', 'en'] as const) {
      const x = input();
      const f = explainFacts(x, lang);
      const rule = ruleExplanation(x, f, lang);
      expect(Object.keys(rule.sections)).toEqual([...EXPLAIN_CONCEPTS]);
      const check = parseExplain(JSON.stringify(rule), f);
      expect(check.unverified).toEqual({});
      expect(check.checked).toBeGreaterThan(20);
      expect(explainPrompt(x, f, lang).startsWith('[bas-proj:valueExplain]')).toBe(true);
    }
  });

  it('flags figures the AI made up and ignores unknown parts', () => {
    const x = input();
    const f = explainFacts(x, 'ja');
    const check = parseExplain(JSON.stringify({ headline: 'NPV は 999 億円です。', sections: { npv: '利回りは 42.5% です。', bogus: 'x' }, questions: ['a', 'b', 'c', 'd'] }), f);
    expect(check.unverified.headline).toEqual(['999']);
    expect(check.unverified.npv).toEqual(['42.5']);
    expect(Object.keys(check.content.sections)).toEqual(['npv']);
    expect(check.content.questions).toHaveLength(3);
    expect(() => parseExplain('not json', f)).toThrow();
  });

  it('cites at least one reachable-looking source per concept', () => {
    for (const c of EXPLAIN_CONCEPTS) {
      expect(CONCEPT_REFS[c].length).toBeGreaterThan(0);
      for (const id of CONCEPT_REFS[c]) {
        const r = REFERENCES[id]!;
        expect(r.url).toMatch(/^https:\/\//);
        expect(r.summary.ja.length).toBeGreaterThan(20);
        expect(r.summary.en).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      }
    }
  });
});
