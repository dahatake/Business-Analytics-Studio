import { beforeEach, describe, expect, it } from 'vitest';
import { summarizeTokens } from '../src/ai/tokenUsage.ts';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import type { Entity } from '../src/data/schema.ts';
import { useProjects } from '../src/state/projects.ts';
import { analysisDraftBaseline, approveAnalysisDraft, computeAnalysis, demoAnalyses, categoryScore, newAnalysis, shownMethodsOf, validateItems } from '../src/modules/project/analysis.ts';
import { itemEntities, itemKey, relatedItems } from '../src/modules/project/analysisLinks.ts';
import { highlightedScore, layoutPlot } from '../src/modules/project/analysisPlot.ts';
import { nextDot } from '../src/modules/project/analysisPlotRender.ts';
import { describeInsight } from '../src/modules/project/analysisText.ts';
import { translate } from '../src/i18n/core.ts';
import { achievementPct, demoKpis, kpiStatusText, lacksCompanyKpi, okrPct, packKpis, statusForPct, validateKpi } from '../src/modules/project/kpiOkr.ts';
import {
  addRecord, addTheme, adoptSuggestion, applyLens, deleteTheme, DEMO_GLOSSARY, demoDiscussion, DiscussionEditor, parseGlossary,
  themeCounts, treeOrder, validateRecord, validateTheme,
} from '../src/modules/project/discussion.ts';
import {
  defaultFileName, parseImport, parseJson, parseMarkdown, prepareExport, toFollowUp, toJson, toMarkdown, type ExportOptions, type ExportSource,
} from '../src/modules/project/exportFormat.ts';
import { parseDraft, parseSuggestions, suggestionRequest } from '../src/modules/project/mocks.ts';
import { RECOMMEND_MAX_PROMPT_CHARS } from '../src/ai/policy.ts';
import { AnalysisSchema, type AnalysisItem, type MethodId, type ProjectData } from '../src/modules/project/model.ts';
import { exportProjectPack, importProject } from '../src/modules/project/projectFile.ts';
import { saveAnalysisForProject } from '../src/modules/project/stores.ts';
import { scopedKey } from '../src/state/projects.ts';

const pack = loadPack(samplePack);
const item = (category: string, score: number, weight = 1, id = `${category}-${score}-${weight}`): AnalysisItem => ({ id, category, text: id, score, weight, author: 'human' });
const analysisOf = (method: MethodId, items: AnalysisItem[], weights: Record<string, number> = {}) => ({ method, items, weights });
const tEn = (k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate('en', k, v);

describe('analysis computations (FR-133/134)', () => {
  it('keeps a persisted AI draft out of calculations until explicit approval and prevents double adoption', () => {
    const base = newAnalysis('fiveForces', 'Review', 'an-review', '2026-11-18');
    const draft = { ...base, draft: {
      items: [{ ...item('rivalry', 5), author: 'ai' as const, mock: true }],
      baseline: analysisDraftBaseline(base), lang: 'en' as const, audience: 'internal' as const, at: '2026-11-19',
    } };
    const restored = AnalysisSchema.parse(JSON.parse(JSON.stringify(draft)));
    expect(computeAnalysis(restored).overall).toBeNull();
    const approved = approveAnalysisDraft(restored, 'en', 'internal', '2026-11-20');
    expect(approved.items).toHaveLength(1);
    expect(computeAnalysis(approved).overall).toBe(5);
    expect(approved.draft).toBeUndefined();
    expect(() => approveAnalysisDraft(approved, 'en', 'internal', 'later')).toThrow();
    expect(draft.items).toEqual([]);
  });

  it('refuses analysis draft approval after edits or a change of language or audience', () => {
    const base = newAnalysis('swot', 'Review', 'an-review', '2026-11-18');
    const draft = { ...base, draft: { items: [item('strengths', 4)], baseline: analysisDraftBaseline(base), lang: 'ja' as const, audience: 'internal' as const, at: 'now' } };
    expect(() => approveAnalysisDraft({ ...draft, weights: { strengths: 5 } }, 'ja', 'internal', 'later')).toThrow(/inputs/);
    expect(() => approveAnalysisDraft({ ...draft, items: [item('threats', 3)] }, 'ja', 'internal', 'later')).toThrow(/inputs/);
    expect(() => approveAnalysisDraft(draft, 'en', 'internal', 'later')).toThrow();
    expect(() => approveAnalysisDraft(draft, 'ja', 'external', 'later')).toThrow();
  });

  it('category score is the weighted mean of item scores; weight 0 is ignored', () => {
    const items = [item('strengths', 5, 1, 'a'), item('strengths', 2, 2, 'b'), item('strengths', 1, 0, 'c')];
    expect(categoryScore(items, 'strengths')).toBe(3);
    expect(categoryScore(items, 'threats')).toBeNull();
  });

  it('SWOT: position and strategy from weighted category scores', () => {
    const base = [item('strengths', 4), item('weaknesses', 2), item('opportunities', 5), item('threats', 3)];
    const r = computeAnalysis(analysisOf('swot', base));
    expect(r.overall).toBeNull();
    expect(r.insight).toEqual({ kind: 'swot', internal: 2, external: 2, strategy: 'aggressive' });
    // Weights change the result immediately.
    const heavyW = computeAnalysis(analysisOf('swot', base, { weaknesses: 3 }));
    expect(heavyW.insight).toMatchObject({ internal: -2, strategy: 'turnaround' });
    expect(computeAnalysis(analysisOf('swot', [item('strengths', 4), item('threats', 5)])).insight).toMatchObject({ strategy: 'diversify' });
    expect(computeAnalysis(analysisOf('swot', [item('weaknesses', 4), item('threats', 5)])).insight).toMatchObject({ strategy: 'defensive' });
  });

  it('Five forces: intensity, attractiveness and strongest force', () => {
    const r = computeAnalysis(analysisOf('fiveForces', [item('rivalry', 5), item('newEntrants', 1), item('substitutes', 3), item('buyerPower', 4), item('supplierPower', 2)]));
    expect(r.overall).toBe(3);
    expect(r.insight).toEqual({ kind: 'fiveForces', intensity: 3, attractiveness: 3, strongest: 'rivalry' });
    const weighted = computeAnalysis(analysisOf('fiveForces', [item('rivalry', 5), item('newEntrants', 1)], { rivalry: 3 }));
    expect(weighted.overall).toBe(4);
  });

  it('Value chain: strongest and weakest activity', () => {
    const r = computeAnalysis(analysisOf('valueChain', [item('operations', 2), item('technology', 5), item('service', 3)]));
    expect(r.categories).toHaveLength(9);
    expect(r.insight).toEqual({ kind: 'valueChain', strongest: 'technology', weakest: 'operations' });
    expect(r.overall).toBeCloseTo(10 / 3);
  });

  it('3C: advantage = company − competitor', () => {
    const r = computeAnalysis(analysisOf('threeC', [item('customer', 4), item('competitor', 3), item('company', 4.5)]));
    expect(r.insight).toEqual({ kind: 'threeC', advantage: 1.5, customer: 4 });
    expect(describeInsight(r, tEn)).toContain('ahead');
    expect(computeAnalysis(analysisOf('threeC', [item('customer', 4)])).insight).toMatchObject({ advantage: null });
  });

  it('Balanced scorecard: weakest perspective and spread', () => {
    const r = computeAnalysis(analysisOf('bsc', [item('financial', 4), item('customerView', 3), item('process', 2), item('learning', 5)]));
    expect(r.insight).toEqual({ kind: 'bsc', weakest: 'process', spread: 3 });
    expect(r.overall).toBe(3.5);
  });

  it('an empty analysis has no result yet, and validation flags bad items', () => {
    const a = newAnalysis('fiveForces', 'x', 'an-1', '2026-11-09');
    expect(Object.keys(a.weights)).toHaveLength(5);
    expect(computeAnalysis(a).overall).toBeNull();
    expect(describeInsight(computeAnalysis(a), tEn)).toBe('Add items to see the result.');
    expect(validateItems([{ ...item('rivalry', 9), text: ' ' }]).map((i) => i.field).sort()).toEqual(['score', 'text']);
  });

  it('demo analyses come from the pack; recomputation is far below PARAM-032 (2 s)', () => {
    const d = demoAnalyses(samplePack);
    expect(d.analyses.map((a) => a.method)).toEqual(['swot', 'bsc']);
    const swot = d.analyses[0]!;
    expect(swot.items.filter((i) => i.category === 'weaknesses')).toHaveLength(pack.pack.entities.filter((e) => e.kind === 'issue').length);
    const big = { ...swot, items: Array.from({ length: 2000 }, (_, i) => item(['strengths', 'weaknesses', 'opportunities', 'threats'][i % 4]!, (i % 5) + 1, 1, `i${i}`)) };
    const t0 = performance.now();
    computeAnalysis(big);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('the AI draft mock answer parses into items of the method', () => {
    expect(parseDraft('swot', 'strengths|A|4\nbogus|B|3\nthreats|C|x', 'en')).toEqual([
      { category: 'strengths', text: 'A', score: 4 },
      { category: 'threats', text: 'C', score: 3 },
    ]);
  });

  it('D-20: live suggestions lose bullets and numbering, and are capped at 5 lines', () => {
    expect(parseSuggestions('1. 目標を決める\n- 試行する\n・**関係者に共有する**\n\n（4）測る\n2) 広げる\n6. 余分', 'ja'))
      .toEqual(['目標を決める', '試行する', '関係者に共有する', '測る', '広げる']);
    // A year at the start of a sentence is not numbering.
    expect(parseSuggestions('2026年度中に試行する', 'ja')).toEqual(['2026年度中に試行する']);
  });

  it('D-20: attached text is shortened so prompt + context stay within the relay limit', () => {
    const req = suggestionRequest('在庫', 'ja', [], { text: 'あ'.repeat(RECOMMEND_MAX_PROMPT_CHARS * 2), media: [] });
    expect(req.prompt.length).toBeLessThanOrEqual(RECOMMEND_MAX_PROMPT_CHARS);
    expect(req.prompt.endsWith('[…]')).toBe(true);
    expect(suggestionRequest('在庫', 'ja', [], { text: '短い資料', media: [] }).prompt).toBe('[bas-proj:recommend] 在庫\n\n短い資料');
  });
});

describe('cross-highlighting between analyses (FR-135)', () => {
  const d = demoAnalyses(samplePack);
  const swot = d.analyses.find((a) => a.method === 'swot')!;
  const bsc = d.analyses.find((a) => a.method === 'bsc')!;
  const textOf = (i: AnalysisItem) => (typeof i.text === 'string' ? i.text : i.text.en);
  const byText = (a: typeof swot, en: string) => a.items.find((i) => textOf(i) === en)!;
  const nameOf = (id: string) => { const n = pack.byId.get(id)!.name; return typeof n === 'string' ? n : n.en; };

  it('an issue highlights, in another analysis, the KPIs the pack measures it by and, in its own, the solutions that resolve it', () => {
    const issue = pack.byId.get('issue-lead-time')!;
    const kpis = pack.edges.filter((e) => e.source === issue.id && e.type === 'measuredBy').map((e) => nameOf(e.target));
    const sols = pack.edges.filter((e) => e.target === issue.id && e.type === 'resolves').map((e) => nameOf(e.source));
    expect(kpis.length).toBeGreaterThan(0);
    const rel = relatedItems({ analysisId: swot.id, itemIds: [byText(swot, nameOf(issue.id)).id] }, d.analyses, pack);
    const bscHits = bsc.items.filter((i) => rel.has(itemKey(bsc.id, i.id))).map(textOf).sort();
    expect(bscHits).toEqual([...kpis].sort());
    // "On-time delivery" is only reachable through the measuredBy edge.
    expect(rel.get(itemKey(bsc.id, byText(bsc, 'On-time delivery').id))).toEqual({ kind: 'near', entityId: 'kpi-otd' });
    for (const s of sols) expect(rel.get(itemKey(swot.id, byText(swot, s).id))).toMatchObject({ kind: 'near', entityId: expect.stringMatching(/^sol-/) });
    // Unrelated items stay unmarked, and the selection itself is not "related".
    expect(rel.has(itemKey(swot.id, byText(swot, 'Rising raw-material prices').id))).toBe(false);
    expect(rel.has(itemKey(swot.id, byText(swot, nameOf(issue.id)).id))).toBe(false);
  });

  it('items naming the same entity, or with the same text, link as "same"; a whole category can be the selection', () => {
    const free = { ...newAnalysis('threeC', 'x', 'an-free', '2026-01-01'), items: [
      { ...item('company', 4, 1, 'f1'), text: { ja: '名古屋工場の稼働率が高い', en: 'High utilisation at Nagoya Plant' } },
      { ...item('competitor', 3, 1, 'f2'), text: 'Rising raw-material prices' },
      { ...item('customer', 3, 1, 'f3'), text: 'Nagoya Plantation tea' },
    ] };
    const all = [swot, free];
    const plant = byText(swot, 'Nagoya Plant');
    const rel = relatedItems({ analysisId: swot.id, itemIds: [plant.id] }, all, pack);
    expect(rel.get(itemKey(free.id, 'f1'))).toEqual({ kind: 'same', entityId: 'site-nagoya' });
    // Latin names match whole words only.
    expect(rel.has(itemKey(free.id, 'f3'))).toBe(false);
    const threat = byText(swot, 'Rising raw-material prices');
    expect(relatedItems({ analysisId: swot.id, itemIds: [threat.id] }, all, pack).get(itemKey(free.id, 'f2'))).toEqual({ kind: 'same' });
    const strengths = swot.items.filter((i) => i.category === 'strengths').map((i) => i.id);
    expect(relatedItems({ analysisId: swot.id, itemIds: strengths }, all, pack).has(itemKey(free.id, 'f1'))).toBe(true);
    expect(itemEntities(free.items[0]!, pack)).toEqual(new Set(['site-nagoya']));
  });

  it('shown methods default to the methods that have analyses and keep the method order', () => {
    expect(shownMethodsOf(d)).toEqual(['swot', 'bsc']);
    expect(shownMethodsOf({ ...d, shownMethods: ['bsc', 'fiveForces'] })).toEqual(['fiveForces', 'bsc']);
    expect(shownMethodsOf({ ...d, shownMethods: [] })).toEqual([]);
  });
});

describe('d3 dot plot layout (FR-135)', () => {
  // Many ties on purpose: the beeswarm has to stack them without overlap.
  const many = analysisOf('swot', [
    ...Array.from({ length: 14 }, (_, k) => item('strengths', 4, (k % 5) + 1, `s${k}`)),
    item('weaknesses', 1, 3, 'w1'), item('weaknesses', 5, 0, 'w2'), item('weaknesses', 3, 2, 'w3'),
    item('threats', 3, 1, 't1'),
  ]);

  it('dots never overlap, stay inside their band and plot area, and follow the score order on x', () => {
    const l = layoutPlot(many);
    expect(l.dots).toHaveLength(many.items.length);
    for (let a = 0; a < l.dots.length; a++) {
      for (let b = a + 1; b < l.dots.length; b++) {
        const p = l.dots[a]!, q = l.dots[b]!;
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(p.r + q.r - 0.5);
      }
    }
    for (const dot of l.dots) {
      const row = l.rows.find((r) => r.id === dot.category)!;
      expect(dot.y - dot.r).toBeGreaterThanOrEqual(row.y0 - 0.5);
      expect(dot.y + dot.r).toBeLessThanOrEqual(row.y1 + 0.5);
      expect(dot.x - dot.r).toBeGreaterThanOrEqual(l.left - 0.5);
      expect(dot.x + dot.r).toBeLessThanOrEqual(l.right + 0.5);
    }
    const w = (id: string) => l.dots.find((dd) => dd.itemId === id)!;
    expect(w('w1').x).toBeLessThan(w('w3').x);
    expect(w('w3').x).toBeLessThan(w('w2').x);
    // Bigger weight, bigger dot; weight 0 still gets a visible dot.
    expect(w('s4').r).toBeGreaterThan(w('s0').r);
    expect(w('w2').r).toBeGreaterThan(0);
    // Rows follow the method's category order and do not overlap.
    expect(l.rows.map((r) => r.id)).toEqual(['strengths', 'weaknesses', 'opportunities', 'threats']);
    for (let k = 1; k < l.rows.length; k++) expect(l.rows[k]!.y0).toBeGreaterThanOrEqual(l.rows[k - 1]!.y1);
  });

  it('is deterministic, and editing one item moves only that item (object constancy for the transition)', () => {
    expect(layoutPlot(many)).toEqual(layoutPlot(many));
    const edited = { ...many, items: many.items.map((i) => (i.id === 't1' ? { ...i, score: 5 } : i)) };
    const before = layoutPlot(many), after = layoutPlot(edited);
    const pos = (l: typeof before, id: string) => l.dots.find((dd) => dd.itemId === id)!;
    expect(pos(after, 't1').x).toBeGreaterThan(pos(before, 't1').x);
    for (const id of ['s0', 'w1', 'w3']) expect(pos(after, id)).toEqual(pos(before, id));
  });

  it('the mean line sits at the category score; an empty category has none', () => {
    const l = layoutPlot(many);
    const weak = l.rows.find((r) => r.id === 'weaknesses')!;
    expect(weak.mean).toBe(categoryScore(many.items, 'weaknesses'));
    expect(l.rows.find((r) => r.id === 'opportunities')!.meanX).toBeNull();
  });

  it('cross-highlight value is the weighted mean of only the highlighted items (Power BI style)', () => {
    const items = [item('strengths', 5, 1, 'a'), item('strengths', 2, 2, 'b'), item('strengths', 1, 1, 'c')];
    expect(highlightedScore(items, 'strengths', (i) => i.id !== 'c')).toBe(3);
    expect(highlightedScore(items, 'strengths', () => false)).toBeNull();
  });

  it('arrow keys move along a row by score and to the nearest dot of the next row with dots', () => {
    const l = layoutPlot(many);
    const leftmost = [...l.dots].filter((dd) => dd.category === 'weaknesses').sort((a, b) => a.x - b.x)[0]!.itemId;
    expect(leftmost).toBe('w1');
    expect(nextDot(l, 'w1', 'ArrowRight')).toBe('w3');
    expect(nextDot(l, 'w3', 'ArrowLeft')).toBe('w1');
    expect(nextDot(l, 'w1', 'ArrowLeft')).toBeNull();
    // Opportunities is empty, so ↓ from weaknesses lands on threats.
    expect(nextDot(l, 'w3', 'ArrowDown')).toBe('t1');
    expect(nextDot(l, 't1', 'ArrowUp')).toBe('w3');
    expect(nextDot(l, 't1', 'Home')).toMatch(/^s\d+$/);
    expect(nextDot(l, 's0', 'End')).toBe('t1');
  });
});

describe('KPI status thresholds (PARAM-044 / PARAM-045)', () => {
  it('≥ 100 % reads achieved, ≤ 0 % reads not started, otherwise in progress', () => {
    expect(statusForPct(100)).toBe('achieved');
    expect(statusForPct(140)).toBe('achieved');
    expect(statusForPct(99.9)).toBe('inProgress');
    expect(statusForPct(0.1)).toBe('inProgress');
    expect(statusForPct(0)).toBe('notStarted');
    expect(statusForPct(-20)).toBe('notStarted');
    expect(statusForPct(null)).toBe('unmeasurable');
    expect(translate('ja', 'proj.kpiStatus.achieved')).toBe('達成');
    expect(translate('ja', 'proj.kpiStatus.notStarted')).toBe('未着手');
  });

  it('achievement works for decreasing KPIs and OKRs average their key results', () => {
    expect(achievementPct({ baseline: 14, current: 12, target: 10 })).toBe(50);
    expect(kpiStatusText({ baseline: 14, current: 10, target: 10 })).toBe('achieved');
    expect(kpiStatusText({ baseline: 14, current: 15, target: 10 })).toBe('notStarted');
    expect(achievementPct({ baseline: 5, current: 5, target: 5 })).toBeNull();
    const kpis = [
      { id: 'a', name: 'a', unit: 'u', baseline: 0, current: 50, target: 100, deadline: '2027-01-01' },
      { id: 'b', name: 'b', unit: 'u', baseline: 0, current: 200, target: 100, deadline: '2027-01-01' },
    ];
    expect(okrPct({ id: 'o', objective: 'o', keyResults: [{ id: 'k1', text: 'x', kpiId: 'a' }, { id: 'k2', text: 'y', kpiId: 'b' }] }, kpis)).toBe(75);
  });

  it('validates KPI input and builds demo KPIs/OKRs from the pack', () => {
    expect(validateKpi({ name: '', unit: '日', baseline: '1', current: 'x', target: '2', deadline: '2027-13-40' }).sort()).toEqual(['current', 'deadline', 'name']);
    const d = demoKpis(samplePack);
    expect(d.kpis.length).toBe(pack.pack.entities.filter((e) => e.kind === 'kpi').length);
    expect(d.okrs.every((o) => o.keyResults.length >= 1 && o.keyResults.every((kr) => d.kpis.some((k) => k.id === kr.kpiId)))).toBe(true);
  });

  it('a generated pack seeds its numeric KPIs and only the internal OKRs whose key results reach them', () => {
    const kpiId = samplePack.entities.find((e) => e.kind === 'kpi')!.id;
    const raw = { ...samplePack, extensions: { ...samplePack.extensions, okr: { objectives: [
      { id: 'okr-linked', objective: '顧客満足を高める', keyResults: [{ text: 'NSAT を上げる', kpiId }, { text: '文章だけの目標' }] },
      { id: 'okr-text', objective: '文章だけの OKR', keyResults: [{ text: '社内展開する', target: '全社' }] },
    ] } } };
    const d = packKpis(raw, new Date('2026-05-10T00:00:00Z'));
    expect(d.kpis.map((k) => k.id)).toEqual(samplePack.entities.filter((e) => e.kind === 'kpi').map((e) => e.id));
    expect(d.kpis.every((k) => k.deadline === '2027-05-10')).toBe(true);
    expect(d.okrs).toEqual([{ id: 'okr-linked', objective: '顧客満足を高める',     keyResults: [{ id: 'okr-linked-kr-1', text: 'NSAT を上げる', kpiId }], origin: 'customerDefined' }]);
  });

  it('FR-341: carries the organisation of extensions.okr to KPIs and OKRs, and flags unit-only KPIs (AC-947)', () => {
    const kpiId = samplePack.entities.find((e) => e.kind === 'kpi')!.id;
    const orgUnits = [
      { id: 'org-company', level: 'legalEntity', name: 'Contoso', basis: 'userInput' },
      { id: 'org-unit', level: 'business', name: '物流事業部', basis: 'inferred', sourceIds: ['s1'] },
    ];
    const raw = { ...samplePack, extensions: { ...samplePack.extensions, okr: { orgUnits, kpis: [], objectives: [
      { id: 'okr-unit', objective: '出荷を速める', orgUnitId: 'org-unit', keyResults: [{ text: 'NSAT を上げる', kpiId }] },
      { id: 'okr-co', objective: '全社の顧客満足', orgUnitId: 'org-company', keyResults: [{ text: '全社 NSAT', kpiId }] },
    ] } } };
    const d = packKpis(raw, new Date('2026-05-10T00:00:00Z'));
    expect(d.okrs.map((o) => [o.id, o.org])).toEqual([
      ['okr-unit', { level: 'business', name: '物流事業部', inferred: true }],
      ['okr-co', { level: 'legalEntity', name: 'Contoso' }],
    ]);
    // Two objectives of different organisations measure it: the KPI's own organisation is left for the user.
    expect(d.kpis.find((k) => k.id === kpiId)!.org).toBeUndefined();
    expect(lacksCompanyKpi(d)).toBe(false);
    expect(lacksCompanyKpi({ ...d, okrs: d.okrs.filter((o) => o.id === 'okr-unit') })).toBe(true);
    // Items without an organisation are not evidence either way.
    expect(lacksCompanyKpi({ kpis: d.kpis, okrs: [] })).toBe(false);
  });
});

describe('discussion editing (FR-042, FR-044〜FR-050)', () => {
  it('builds the tree, validates input and prevents cycles', () => {
    const d = demoDiscussion();
    expect(treeOrder(d).map((x) => [x.theme.id, x.depth])[1]).toEqual(['th-demo-forecast', 1]);
    expect(validateTheme(d, { title: ' ', parentId: null }).title).toBe('required');
    expect(validateTheme(d, { title: 'x', parentId: 'th-demo-forecast' }, 'th-demo-leadtime').parent).toBe('cycle');
    expect(validateRecord({ text: 'ok', due: '2026/01/01' }).due).toBe('dueFormat');
    expect(deleteTheme(d, 'th-demo-leadtime').records.some((r) => r.themeId === 'th-demo-forecast')).toBe(false);
  });

  it('distinguishes customer decisions from AI suggestions and counts G-001 per theme', () => {
    let d = demoDiscussion();
    const counts = themeCounts(d);
    expect(counts.find((c) => c.themeId === 'th-demo-leadtime')).toMatchObject({ decisions: 1, actions: 1, met: true });
    expect(counts.find((c) => c.themeId === 'th-demo-forecast')).toMatchObject({ met: false });
    d = adoptSuggestion(d, 'rec-demo-3', 'rec-x', 'at');
    const adopted = d.records.find((r) => r.id === 'rec-x')!;
    expect(adopted).toMatchObject({ kind: 'decision', author: 'human' });
    expect(d.records.find((r) => r.id === 'rec-demo-3')).toMatchObject({ kind: 'suggestion', author: 'ai' });
  });

  it('undo/redo of edits through UndoStack, with who/when/what change history', () => {
    let clock = 0;
    const ed = new DiscussionEditor({ themes: [], records: [] }, [], () => `2026-11-09T00:00:0${clock++}Z`);
    const one = addTheme(ed.value, { title: 'Pricing', parentId: null, classification: 'shareable' }, 'th-1');
    ed.apply(one, 'Aki', 'add', 'theme', 'Pricing');
    const two = addRecord(ed.value, { themeId: 'th-1', kind: 'decision', text: 'Raise by 3%' }, 'rec-1', 'at');
    ed.apply(two, 'Aki', 'add', 'record', 'Raise by 3%');
    expect(ed.value.records).toHaveLength(1);
    expect(ed.undo('Ben').records).toHaveLength(0);
    expect(ed.undo('Ben').themes).toHaveLength(0);
    expect(ed.stack.canUndo).toBe(false);
    expect(ed.redo('Ben').themes).toHaveLength(1);
    expect(ed.redo('Ben').records).toHaveLength(1);
    expect(ed.history.map((h) => [h.who, h.op, h.target])).toEqual([
      ['Aki', 'add', 'theme'], ['Aki', 'add', 'record'], ['Ben', 'undo', 'all'], ['Ben', 'undo', 'all'], ['Ben', 'redo', 'all'], ['Ben', 'redo', 'all'],
    ]);
    expect(ed.history[0]).toMatchObject({ at: '2026-11-09T00:00:00Z', label: 'Pricing' });
    // A new edit clears the redo branch.
    ed.undo('Ben');
    ed.apply(addTheme(ed.value, { title: 'Other', parentId: null, classification: 'shareable' }, 'th-2'), 'Ben', 'add', 'theme', 'Other');
    expect(ed.stack.canRedo).toBe(false);
  });

  it('keeps at most 100 undo steps (PARAM-024)', () => {
    const ed = new DiscussionEditor({ themes: [], records: [] });
    for (let i = 0; i < 120; i++) ed.apply(addTheme(ed.value, { title: `T${i}`, parentId: null, classification: 'shareable' }, `t${i}`), '', 'add', 'theme', `T${i}`);
    expect(ed.stack.depth).toBe(100);
  });

  it('lens Business ⇔ IT relabels terms via the glossary (FR-019)', () => {
    expect(applyLens('需要予測で生産計画を前倒しする', DEMO_GLOSSARY, 'ja', 'it')).toBe('時系列予測モデルでスケジューリング APIを前倒しする');
    expect(applyLens('Lead time is long', DEMO_GLOSSARY, 'en', 'it')).toBe('cycle-time metric is long');
    expect(applyLens('需要予測', DEMO_GLOSSARY, 'ja', 'business')).toBe('需要予測');
    expect(parseGlossary([{ term: 'A', definition: 'B', it: 'C' }, { bogus: true }])).toEqual([{ term: 'A', definition: 'B', it: 'C' }]);
    expect(parseGlossary('x')).toBeNull();
  });
});

const source = (data: ProjectData, now = new Date('2026-11-09T01:00:00Z')): ExportSource => ({
  company: 'Contoso', project: 'Growth', data, useCases: [], byId: pack.byId, now,
});
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ lang: 'ja', audience: 'internal', themeId: null, include: { kpi: true, analysis: true, useCases: true }, ...o });
const demoData = (): ProjectData => ({ discussion: demoDiscussion(), kpi: demoKpis(samplePack), analysis: demoAnalyses(samplePack) });

describe('export and restore (FR-051〜FR-056, FR-219)', () => {
  it('default file name is <company>-<project>-discussion-YYYYMMDD.md (Asia/Tokyo date)', () => {
    expect(defaultFileName('Contoso', 'Growth', new Date('2026-11-09T16:00:00Z'))).toBe('Contoso-Growth-discussion-20261110.md');
    expect(defaultFileName('A/B Co', 'P: 1', new Date('2026-01-02T00:00:00Z'), 'followup')).toBe('A_B_Co-P_1-followup-20260102.md');
    expect(defaultFileName('C', 'P', new Date('2026-01-02T00:00:00Z'), 'discussion', 'json')).toBe('C-P-discussion-20260102.json');
  });

  it('Markdown round-trip restores exactly the same data', () => {
    const data = demoData();
    for (const lang of ['ja', 'en'] as const) {
      const { bundle } = prepareExport(source(data), opts({ lang }));
      const md = toMarkdown(bundle);
      expect(md).toContain('## ');
      const back = parseMarkdown(md);
      if (!back.ok) throw new Error(back.error);
      expect(back.result.discussion).toEqual(data.discussion);
      expect(back.result.kpi).toEqual(data.kpi);
      expect(back.result.analysis).toEqual(data.analysis);
    }
  });

  it('round-trips user text with Markdown-like and HTML-like characters', () => {
    let d = addTheme({ themes: [], records: [] }, { title: 'A <b>&</b> | # "x" -->', parentId: null, classification: 'shareable' }, 'th-1');
    d = addRecord(d, { themeId: 'th-1', kind: 'action', text: 'line1\nline2 <!-- bas:record id=evil -->', owner: 'Ann & Bob', due: '2026-12-01' }, 'rec-1', '2026-11-09T00:00:00Z');
    const data: ProjectData = { discussion: d, kpi: { kpis: [], okrs: [] }, analysis: { analyses: [], activeId: null } };
    const back = parseMarkdown(toMarkdown(prepareExport(source(data), opts()).bundle));
    if (!back.ok) throw new Error(back.error);
    expect(back.result.discussion).toEqual(d);
  });

  it('hand edits in the readable part win over the data block', () => {
    const data = demoData();
    const md = toMarkdown(prepareExport(source(data), opts({ lang: 'en' })).bundle).replace('- Cut lead time to 10 days or less by March 2027. ', '- Cut lead time to 9 days. ');
    const back = parseMarkdown(md);
    if (!back.ok) throw new Error(back.error);
    expect(back.result.discussion.records.find((r) => r.id === 'rec-demo-2')!.text).toBe('Cut lead time to 9 days.');
    expect(back.result.discussion.records.find((r) => r.id === 'rec-demo-1')!.text).toEqual(data.discussion.records[0]!.text);
  });

  it('includes the AI token table only for internal recipients, and still restores', () => {
    const usage = summarizeTokens([{ at: '2026-05-01T00:00:00Z', use: 'explain', inputTokens: 2000, outputTokens: 300 }]);
    const internal = toMarkdown(prepareExport(source(demoData()), opts({ lang: 'en' })).bundle, usage);
    expect(internal).toContain('## Generative AI token usage');
    expect(internal).toContain('| Explain current state | 1 | 2,000 | 300 | 2,300 |');
    const back = parseMarkdown(internal);
    if (!back.ok) throw new Error(back.error);
    expect(back.result.discussion).toEqual(demoData().discussion);
    const external = toMarkdown(prepareExport(source(demoData()), opts({ lang: 'en', audience: 'external' })).bundle, usage);
    expect(external).not.toContain('Generative AI token usage');
  });

  it('restores from the readable sections alone when the data block was removed', () => {
    const md = toMarkdown(prepareExport(source(demoData()), opts({ lang: 'en' })).bundle).split('```json bas-export')[0]!;
    const back = parseMarkdown(md);
    if (!back.ok) throw new Error(back.error);
    expect(back.result.discussion.themes).toHaveLength(4);
    expect(back.result.discussion.themes[1]).toMatchObject({ id: 'th-demo-forecast', parentId: 'th-demo-leadtime', title: 'Bring production planning forward with demand forecasting' });
    expect(back.result.kpi).toBeNull();
    expect(parseMarkdown('')).toEqual({ ok: false, error: 'empty' });
    expect(parseMarkdown('# nothing')).toEqual({ ok: false, error: 'invalid' });
  });

  it('JSON export/import round-trip', () => {
    const data = demoData();
    const json = toJson(prepareExport(source(data), opts()).bundle);
    const back = parseJson(json);
    if (!back.ok) throw new Error(back.error);
    expect(back.result.discussion).toEqual(data.discussion);
    expect(back.result.analysis).toEqual(data.analysis);
    expect(parseImport(json)).toEqual(back);
    expect(parseJson('{"format":"other"}')).toEqual({ ok: false, error: 'invalid' });
  });

  it('confidentiality: external exports exclude internal items; internal exports warn', () => {
    const data = demoData();
    const internal = prepareExport(source(data), opts());
    expect(internal.internalIncluded).toBe(2);
    expect(internal.bundle.discussion.themes.some((t) => t.id === 'th-demo-cash')).toBe(true);
    const external = prepareExport(source(data), opts({ audience: 'external' }));
    expect(external.bundle.discussion.themes.some((t) => t.classification === 'internal')).toBe(false);
    expect(external.bundle.discussion.records.some((r) => r.classification === 'internal' || r.themeId === 'th-demo-cash')).toBe(false);
    expect(external.excludedInternal).toBeGreaterThanOrEqual(2);
    expect(external.internalIncluded).toBe(0);
    expect(toMarkdown(external.bundle)).not.toContain('請求書の電子化');
  });

  it('person confirmation is triggered by "person" entities in the export (FR-219), and scope narrows it', () => {
    const data = demoData();
    const all = prepareExport(source(data), opts());
    expect(all.personCount).toBe(2);
    const quality = prepareExport(source(data), opts({ themeId: 'th-demo-quality' }));
    expect(quality.personCount).toBe(1);
    expect(quality.bundle.discussion.themes.map((t) => t.id)).toEqual(['th-demo-quality']);
    const forecast = prepareExport(source(data), opts({ themeId: 'th-demo-forecast' }));
    expect(forecast.personCount).toBe(0);
    // FR-219 counts persons in the exported scope. Internal audience: every person in scope, internal ones included.
    const byId = new Map(pack.byId);
    const sato = byId.get('person-sato-yui') as Entity;
    byId.set(sato.id, { ...sato, classification: 'internal' });
    expect(prepareExport({ ...source(data), byId }, opts()).personCount).toBe(2);
    // External audience: the export's confidentiality filter hides the internal person, so it is not counted
    // (D-2 lets generative AI send internal items, but the display rule for an external audience is unchanged).
    const external = prepareExport({ ...source(data), byId }, opts({ audience: 'external' }));
    expect(external.personCount).toBe(1);
    expect(external.related.some((e) => e.id === sato.id)).toBe(false);
    expect(external.bundle.relatedIds).not.toContain(sato.id);
  });

  it('includes KPIs, analyses and counts in Markdown and creates a follow-up document (FR-053, FR-055, G-001)', () => {
    const { bundle } = prepareExport(source(demoData()), opts({ lang: 'en' }));
    const md = toMarkdown(bundle);
    expect(md).toContain('## Counts per theme');
    expect(md).toContain('## KPIs');
    expect(md).toContain('## OKRs');
    expect(md).toContain('## Analyses');
    expect(md).toContain('#### Decisions (by the customer)');
    expect(md).toContain('#### Next actions');
    const follow = toFollowUp(bundle);
    expect(follow).toContain('Contoso-Growth follow-up');
    expect(follow).toContain('- [ ] Prepare three years of order data for analysis.');
  });
});

describe('project file with ids (FR-139)', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjects.setState({ companies: [], projects: [], relations: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'asis' });
  });

  it('saves generated analyses to their project without changing the currently open demo', () => {
    const data = demoAnalyses(samplePack);
    saveAnalysisForProject('pj-generated', data);
    expect(JSON.parse(localStorage.getItem(scopedKey('pj-generated', 'proj.analysis'))!)).toEqual(data);
    expect(useProjects.getState().target).toEqual({ kind: 'demo' });
  });

  it('exports and re-imports a project with the same ids and data', async () => {
    const c = useProjects.getState().addCompany('Contoso');
    if (!c.ok) throw new Error();
    const p = useProjects.getState().addProject(c.id, 'Growth');
    if (!p.ok) throw new Error();
    localStorage.setItem(scopedKey(p.id, 'proj.discussion'), JSON.stringify({ themes: [{ id: 't' }], records: [] }));
    const file = (await exportProjectPack(p.id))!;
    expect(file.project.data['proj.discussion']).toEqual({ themes: [{ id: 't' }], records: [] });
    expect(await importProject(JSON.stringify(file))).toEqual({ ok: false, error: 'exists' });
    useProjects.getState().deleteProject(p.id);
    useProjects.getState().deleteCompany(c.id);
    expect(localStorage.getItem(scopedKey(p.id, 'proj.discussion'))).toBeNull();
    const r = await importProject(JSON.stringify(file));
    expect(r).toEqual({ ok: true, name: 'Contoso-Growth', projectId: p.id });
    expect(useProjects.getState().companies[0]!.id).toBe(c.id);
    expect(JSON.parse(localStorage.getItem(scopedKey(p.id, 'proj.discussion'))!)).toEqual({ themes: [{ id: 't' }], records: [] });
    expect(await importProject('nope')).toEqual({ ok: false, error: 'invalid' });
  });

  it('carries the company information, project inputs and relations to projects that exist', async () => {
    const s = useProjects.getState();
    const c = s.addCompany('Contoso', { industry: 'Retail', notes: 'Sales org' });
    if (!c.ok) throw new Error();
    const a = s.addProject(c.id, 'Pipeline', { purpose: 'Improve\nforecast', asOf: '2025-01-31' });
    const b = s.addProject(c.id, 'Quote');
    if (!a.ok || !b.ok) throw new Error();
    const rel = s.addRelation(a.id, b.id, 'dependsOn', 'quote data feeds pipeline');
    if (!rel.ok) throw new Error();
    const file = JSON.parse(JSON.stringify(await exportProjectPack(a.id)));
    expect(file.project.relations).toHaveLength(1);

    s.deleteProject(a.id);
    expect(useProjects.getState().relations).toEqual([]);
    expect(await importProject(JSON.stringify(file))).toMatchObject({ ok: true, projectId: a.id });
    expect(useProjects.getState().projects.find((p) => p.id === a.id)!.brief).toEqual({ purpose: 'Improve\nforecast', asOf: '2025-01-31' });
    expect(useProjects.getState().relations).toEqual([expect.objectContaining({ id: rel.id, from: a.id, to: b.id, kind: 'dependsOn' })]);

    // In a fresh store the other project is missing, so the relation is not restored; the company information is.
    useProjects.setState({ companies: [], projects: [], relations: [] });
    expect((await importProject(JSON.stringify(file))).ok).toBe(true);
    expect(useProjects.getState().relations).toEqual([]);
    expect(useProjects.getState().companies[0]).toMatchObject({ name: 'Contoso', industry: 'Retail', notes: 'Sales org' });
  });
});
