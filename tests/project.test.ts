import { beforeEach, describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import type { Entity } from '../src/data/schema.ts';
import { useProjects } from '../src/state/projects.ts';
import { computeAnalysis, demoAnalyses, categoryScore, newAnalysis, validateItems } from '../src/modules/project/analysis.ts';
import { describeInsight } from '../src/modules/project/analysisText.ts';
import { translate } from '../src/i18n/core.ts';
import { achievementPct, demoKpis, kpiStatusText, okrPct, statusForPct, validateKpi } from '../src/modules/project/kpiOkr.ts';
import {
  addRecord, addTheme, adoptSuggestion, applyLens, deleteTheme, DEMO_GLOSSARY, demoDiscussion, DiscussionEditor, parseGlossary,
  themeCounts, treeOrder, validateRecord, validateTheme,
} from '../src/modules/project/discussion.ts';
import {
  defaultFileName, parseImport, parseJson, parseMarkdown, prepareExport, toFollowUp, toJson, toMarkdown, type ExportOptions, type ExportSource,
} from '../src/modules/project/exportFormat.ts';
import { parseDraft } from '../src/modules/project/mocks.ts';
import type { AnalysisItem, MethodId, ProjectData } from '../src/modules/project/model.ts';
import { exportProject, importProject } from '../src/modules/project/projectFile.ts';
import { scopedKey } from '../src/state/projects.ts';

const pack = loadPack(samplePack);
const item = (category: string, score: number, weight = 1, id = `${category}-${score}-${weight}`): AnalysisItem => ({ id, category, text: id, score, weight, author: 'human' });
const analysisOf = (method: MethodId, items: AnalysisItem[], weights: Record<string, number> = {}) => ({ method, items, weights });
const tEn = (k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate('en', k, v);

describe('analysis computations (FR-133/134)', () => {
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
    useProjects.setState({ companies: [], projects: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
  });

  it('exports and re-imports a project with the same ids and data', () => {
    const c = useProjects.getState().addCompany('Contoso');
    if (!c.ok) throw new Error();
    const p = useProjects.getState().addProject(c.id, 'Growth');
    if (!p.ok) throw new Error();
    localStorage.setItem(scopedKey(p.id, 'proj.discussion'), JSON.stringify({ themes: [{ id: 't' }], records: [] }));
    const file = exportProject(p.id)!;
    expect(file.data['proj.discussion']).toEqual({ themes: [{ id: 't' }], records: [] });
    expect(importProject(JSON.stringify(file))).toEqual({ ok: false, error: 'exists' });
    useProjects.getState().deleteProject(p.id);
    useProjects.getState().deleteCompany(c.id);
    expect(localStorage.getItem(scopedKey(p.id, 'proj.discussion'))).toBeNull();
    const r = importProject(JSON.stringify(file));
    expect(r).toEqual({ ok: true, name: 'Contoso-Growth', projectId: p.id });
    expect(useProjects.getState().companies[0]!.id).toBe(c.id);
    expect(JSON.parse(localStorage.getItem(scopedKey(p.id, 'proj.discussion'))!)).toEqual({ themes: [{ id: 't' }], records: [] });
    expect(importProject('nope')).toEqual({ ok: false, error: 'invalid' });
  });
});
