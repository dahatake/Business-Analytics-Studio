import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { itemKey } from '../src/modules/project/analysisLinks.ts';
import type { Analysis, KpiDef } from '../src/modules/project/model.ts';
import { evidenceLinks, overviewFacts, quadrantOf, scoreAllSteps, stepTargets, targetsOfItem } from '../src/modules/project/analysisTargets.ts';

const pack = loadPack(samplePack);
const demo = demoAnalyses(samplePack).analyses;
const kpis = demoKpis(samplePack).kpis;
const useCases = demoUseCases();
const score = (analyses: readonly Analysis[], extraKpis: readonly KpiDef[] = kpis) => scoreAllSteps({ pack, useCases, kpis: extraKpis, analyses });
const swotWith = (items: Analysis['items'], weights = { strengths: 1, weaknesses: 1, opportunities: 1, threats: 1 }): Analysis => ({
  id: 'an-t', method: 'swot', title: 'T', items, weights, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const item = (id: string, category: string, text: string, s = 4, weight = 1) => ({ id, category, text, score: s, weight, author: 'human' as const });

describe('step targets (FR-340)', () => {
  it('extracts the targets of every step from the pack and project data', () => {
    const t = stepTargets({ pack, useCases, kpis });
    expect(t.asis.filter((x) => x.kind === 'issue')).toHaveLength(samplePack.entities.filter((e) => e.kind === 'issue').length);
    expect(t.asis.some((x) => x.kind === 'cause')).toBe(true);
    expect(t.tobe.map((x) => x.id)).toEqual(useCases.map((u) => `uc:${u.id}`));
    expect(t.solution.length).toBeGreaterThan(0);
    expect(t.deliverable.every((x) => x.kind === 'initiative')).toBe(true);
    for (const list of Object.values(t)) for (const x of list) expect(x.data).toBeGreaterThanOrEqual(0), expect(x.data).toBeLessThanOrEqual(1);
  });

  it('states the data signal by a fixed formula per kind', () => {
    const t = stepTargets({ pack, useCases, kpis });
    const lead = t.asis.find((x) => x.id === 'issue-lead-time')!;
    expect(lead.basis).toMatchObject({ kind: 'issue', score: Math.round(lead.data * 100) });
    // a cause takes the score of the most important issue it causes
    const issue = samplePack.entities.find((e) => e.kind === 'issue' && e.causeIds.length > 0) as Extract<(typeof samplePack.entities)[number], { kind: 'issue' }>;
    const cause = t.asis.find((x) => x.id === issue.causeIds[0])!;
    expect(cause.data).toBeGreaterThanOrEqual(t.asis.find((x) => x.id === issue.id)!.data);
    // the best ROI solution is 1; a finished initiative has no remaining data urgency
    expect(Math.max(...t.solution.map((x) => x.data))).toBe(1);
    // a use case scores by its most important related issue
    const uc = useCases.find((u) => u.relatedIds.includes('issue-lead-time'))!;
    expect(t.tobe.find((x) => x.id === `uc:${uc.id}`)!.data).toBeGreaterThanOrEqual(lead.data);
  });

  it('adds project KPIs that are not already pack KPIs, and treats unmeasurable progress as 0', () => {
    const k0 = kpis[0]!;
    const dup: KpiDef = { ...k0 };
    const own: KpiDef = { ...k0, id: 'k-own', name: { ja: '独自の指標', en: 'Own metric' }, baseline: 5, current: 5, target: 5 };
    const t = stepTargets({ pack, useCases, kpis: [dup, own] });
    expect(t.kpi.filter((x) => x.kind === 'projectKpi').map((x) => x.id)).toEqual(['pkpi:k-own']);
    expect(t.kpi.find((x) => x.id === 'pkpi:k-own')!).toMatchObject({ data: 0, basis: { kind: 'kpi', progress: null } });
  });
});

describe('analysis support and quadrants (FR-340)', () => {
  it('counts an item naming the target as direct evidence and one relation away as near (×0.5)', () => {
    const all = score(demo);
    const lead = all.asis.find((x) => x.id === 'issue-lead-time')!;
    const direct = lead.evidence.find((e) => e.link === 'direct')!;
    expect(direct).toMatchObject({ analysisId: 'an-demo-swot', category: 'weaknesses', value: direct.score });
    const near = lead.evidence.find((e) => e.link === 'near' && e.category === 'opportunities')!;
    expect(near.value).toBe(near.score * 0.5);
    expect(lead.support).toBeCloseTo(lead.evidence.reduce((s, e) => s + e.value, 0), 5);
  });

  it('applies item and category weights, and ignores weight 0', () => {
    const one = score([swotWith([item('a', 'weaknesses', '受注から出荷までが長い', 4, 0.5)], { strengths: 1, weaknesses: 2, opportunities: 1, threats: 1 })]);
    expect(one.asis.find((x) => x.id === 'issue-lead-time')!.evidence[0]!.value).toBe(4);
    const off = score([swotWith([item('a', 'weaknesses', '受注から出荷までが長い')], { strengths: 1, weaknesses: 0, opportunities: 1, threats: 1 })]);
    expect(off.asis.find((x) => x.id === 'issue-lead-time')!.support).toBe(0);
  });

  it('matches use cases and project KPIs by name when they are not pack entities', () => {
    const uc = useCases[0]!;
    const name = typeof uc.name === 'string' ? uc.name : uc.name.ja;
    const all = score([swotWith([item('a', 'opportunities', `${name}ための取り組み`)])]);
    expect(all.tobe.find((x) => x.id === `uc:${uc.id}`)!.evidence[0]!).toMatchObject({ link: 'direct', itemId: 'a' });
  });

  it('separates data from analyses: blind spots, unbacked claims, focus', () => {
    expect([quadrantOf(0.8, 0.8), quadrantOf(0.8, 0.1), quadrantOf(0.1, 0.8), quadrantOf(0.1, 0.1)]).toEqual(['focus', 'underexamined', 'unbacked', 'later']);
    // no analyses: everything with data is a blind spot, and support stays 0 (the scale is not stretched)
    const none = score([]);
    expect(none.asis.every((x) => x.support === 0 && x.supportN === 0)).toBe(true);
    expect(none.asis.find((x) => x.id === 'issue-lead-time')!.quadrant).toBe('underexamined');
    // one faint near mention in a step does not make it "high"
    const faint = score([swotWith([item('a', 'opportunities', '需要予測と生産計画の最適化', 1)])]);
    expect(faint.deliverable.every((x) => x.supportN < 0.5)).toBe(true);
  });

  it('ranks by the mean of both signals, ties by data', () => {
    const list = score(demo).asis;
    expect(list.map((x) => x.rank)).toEqual(list.map((_, i) => i + 1));
    const key = (x: (typeof list)[number]) => (x.data + x.supportN) / 2;
    for (let i = 1; i < list.length; i++) expect(key(list[i - 1]!)).toBeGreaterThanOrEqual(key(list[i]!));
    expect(list[0]!.id).toBe('issue-lead-time');
  });

  it('links items and targets both ways for cross-highlighting', () => {
    const all = score(demo);
    const lead = all.asis.find((x) => x.id === 'issue-lead-time')!;
    const keys = evidenceLinks(lead);
    const direct = lead.evidence.find((e) => e.link === 'direct')!;
    expect(keys.get(itemKey(direct.analysisId, direct.itemId))).toEqual({ kind: 'same', entityId: 'issue-lead-time' });
    const near = lead.evidence.find((e) => e.link === 'near')!;
    expect(keys.get(itemKey(near.analysisId, near.itemId))).toMatchObject({ kind: 'near' });
    expect(lead.nearIds).toContain(near.via);
    expect(targetsOfItem(all.asis, itemKey(direct.analysisId, direct.itemId)).has('issue-lead-time')).toBe(true);
  });
});

describe('overview facts (FR-340)', () => {
  it('summarises the dashboard for the chosen step and reacts to edits', () => {
    const f = overviewFacts(score(demo), demo, 'asis');
    expect(f).toMatchObject({ analyses: 2, items: demo.reduce((s, a) => s + a.items.length, 0), step: 'asis' });
    expect(f.top?.id).toBe('issue-lead-time');
    expect(f.underexamined.every((x) => x.kind === 'cause')).toBe(true);
    // the target named directly by the most analyses (SWOT + BSC both name the lead-time KPI)
    expect(f.mostCited).toMatchObject({ analyses: 2 });

    const empty = overviewFacts(score([]), [], 'asis');
    expect(empty).toMatchObject({ analyses: 0, items: 0, top: null, mostCited: null, uncovered: empty.targets });
  });
});
