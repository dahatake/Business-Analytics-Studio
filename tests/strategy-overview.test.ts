import { beforeEach, describe, expect, it } from 'vitest';
import { activatePack, entitiesOf, loaded, loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { commitPackChanges, setBasePackRaw, usePackEdits } from '../src/state/packEdits.ts';
import { currentScope } from '../src/state/projects.ts';
import { emptyDeliverables, type AppCheckContext } from '../src/modules/project/deliverables.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import {
  availableAxes, humanizeProposal, overviewBaseline, overviewContext, overviewPrompt, proposalEntities, recommendedAxis, strategyMap,
  validateOverviewProposal, type OverviewProposal,
} from '../src/modules/project/overviewModel.ts';

const context = (): AppCheckContext => ({
  pack: loadPack(samplePack), kpi: demoKpis(samplePack), discussion: { themes: [], records: [] },
  analysis: { analyses: [], activeId: null }, useCases: [], deliverables: emptyDeliverables(),
  today: '2026-11-16', strategy: emptyStrategy(), objectives: [{ id: 'obj-growth', text: 'Profitable growth' }], projectObjectiveIds: ['obj-growth'],
});
const state = { objectiveIssues: [] };
const proposal = (ctx: AppCheckContext): OverviewProposal => {
  const issue = entitiesOf('issue', ctx.pack)[0]!;
  return {
    answer: 'Prioritize the bottleneck and validate the causal hypothesis.',
    findings: [{ text: 'A registered issue has a measured outcome.', refs: [issue.id] }],
    actions: [{ text: 'Confirm the intervention with the sponsor.', refs: [issue.id] }],
    caveats: ['Relationships alone do not prove causality.'],
    axis: 'impact', axisReason: 'Compare registered business impact.',
    objectiveIssues: [{ objectiveId: 'obj-growth', issueId: issue.id, reason: 'Validate this contribution to growth.', refs: [issue.id] }],
    patches: [{ id: issue.id, description: { ja: 'ボトルネックの仮説を検証する。', en: 'Validate the bottleneck hypothesis.' }, impact: 5, reason: 'This is an ordinal priority judgment.', refs: [issue.id] }],
  };
};

describe('strategic overview mapping and ranking', () => {
  it('keeps objectives and disconnected nodes, and bypasses optional metrics only with an explicit link', () => {
    const ctx = context();
    ctx.kpi = { kpis: [], okrs: [] };
    const p = proposal(ctx);
    const map = strategyMap(ctx, state, 'impact', 'en');
    expect(map.nodes.some((n) => n.lane === 'objective')).toBe(true);
    expect(map.links.some((l) => l.source.startsWith('objective:'))).toBe(false);
    const explicit = strategyMap(ctx, { objectiveIssues: p.objectiveIssues }, 'impact', 'en');
    expect(explicit.links).toContainEqual({ source: 'objective:obj-growth', target: `issue:${p.patches[0]!.id}`, direct: true });
    expect(explicit.nodes.filter((n) => n.lane === 'issue')).toHaveLength(entitiesOf('issue', ctx.pack).length);
  });

  it('connects explicit OKR/KPI/issue/solution references without inventing intermediate links', () => {
    const ctx = context();
    const map = strategyMap(ctx, state, 'impact', 'en');
    const issue = entitiesOf('issue', ctx.pack).find((i) => i.kpiIds.length)!;
    expect(map.links).toContainEqual({ source: `kpi:${issue.kpiIds[0]}`, target: `issue:${issue.id}`, direct: false });
    expect(map.links.some((l) => l.source === 'objective:obj-growth' && l.target.startsWith('okr:'))).toBe(true);
    const sol = entitiesOf('solution', ctx.pack)[0]!;
    expect(map.links).toContainEqual({ source: `issue:${sol.issueIds[0]}`, target: `solution:${sol.id}`, direct: false });
  });

  it('uses actual values for sorting, stable ties, missing evidence and unknown money values', () => {
    const ctx = context();
    const issues = entitiesOf('issue', ctx.pack);
    const first = issues[0]!;
    first.sourceIds = [];
    expect(recommendedAxis(ctx)).toBe('evidence');
    const sorted = strategyMap(ctx, state, 'evidence', 'en').nodes.filter((n) => n.lane === 'issue');
    expect(sorted[0]!.ref).toBe(first.id);
    const asc = strategyMap(ctx, state, 'impact', 'en', false).nodes.filter((n) => n.lane === 'issue');
    expect(asc.map((n) => n.score)).toEqual(issues.map((i) => i.impact).sort((a, b) => a - b));
    ctx.pack.pack.entities = ctx.pack.pack.entities.filter((e) => e.kind !== 'solution');
    expect(availableAxes(ctx)).not.toContain('money');
    expect(strategyMap(ctx, state, 'money', 'en').nodes.filter((n) => n.lane === 'issue').every((n) => n.score === null)).toBe(true);
    expect(strategyMap(ctx, state, 'impact', 'en')).toEqual(strategyMap(ctx, state, 'impact', 'en'));
  });

  it('filters hidden goals, project KPI edits and related entities before forming AI context', () => {
    const ctx = context();
    const hidden = entitiesOf('issue', ctx.pack)[0]!;
    hidden.classification = 'internal';
    hidden.description.en = 'PRIVATE_SENTINEL';
    ctx.kpi.kpis[0]!.current = 999991;
    const safe = overviewContext(ctx, 'external');
    expect(safe.objectives).toEqual([]);
    const prompt = overviewPrompt(safe, state, 'en');
    expect(prompt).not.toContain('PRIVATE_SENTINEL');
    expect(prompt).not.toContain('999991');
    expect(strategyMap(safe, state, 'impact', 'en').nodes.some((n) => n.ref === hidden.id)).toBe(false);
  });
});

describe('validated draft and approval updates', () => {
  beforeEach(() => {
    localStorage.clear();
    usePackEdits.getState().reset();
    setBasePackRaw(samplePack);
    activatePack(samplePack, { kind: 'sample' });
  });

  it('rejects invented numerical facts, illegal fields, invalid references and duplicate targets', () => {
    const ctx = context(), p = proposal(ctx);
    expect(validateOverviewProposal(p, ctx)).toEqual(p);
    expect(() => validateOverviewProposal({ ...p, answer: 'Guaranteed benefit 987654321 yen.' }, ctx)).toThrow('Unverified figures');
    expect(() => validateOverviewProposal({ ...p, patches: [{ ...p.patches[0], annualBenefitJpy: 987 }] }, ctx)).toThrow();
    expect(() => validateOverviewProposal({ ...p, patches: [p.patches[0], p.patches[0]] }, ctx)).toThrow('duplicate');
    expect(() => validateOverviewProposal({ ...p, patches: [{ ...p.patches[0], kpiIds: ['kpi-unknown'] }] }, ctx)).toThrow('relationship');
    expect(() => validateOverviewProposal({ ...p, findings: [{ text: 'x', refs: ['private-unknown'] }] }, ctx)).toThrow('hidden evidence');
  });

  it('accepts key result references, one-metric gaps and figures written in the business text, but not other derived figures', () => {
    const ctx = context(), p = proposal(ctx);
    const kpi = entitiesOf('kpi', ctx.pack).find((k) => k.current !== k.target)!;
    const gap = Math.abs(kpi.current - kpi.target);
    ctx.pack.pack.entities.push({ ...kpi, id: 'kpi-text-figure', description: { ja: '出荷後 77 日以内', en: 'within 77 days' } });
    expect(() => validateOverviewProposal({ ...p, answer: `Gap ${gap}, measured within 77 days.`, findings: [{ text: 'Key result.', refs: [ctx.kpi.okrs[0]!.keyResults[0]!.id] }] }, ctx)).not.toThrow();
    expect(() => validateOverviewProposal({ ...p, answer: `Sum ${kpi.current + kpi.target + kpi.baseline + 0.37}.` }, ctx)).toThrow('Unverified figures');
  });

  it('replaces internal IDs written in prose with item names, keeping refs and stored text per language', () => {
    const ctx = context(), p = proposal(ctx), issue = entitiesOf('issue', ctx.pack)[0]!;
    const h = humanizeProposal({ ...p, answer: `Start with ${issue.id}.`, patches: [{ ...p.patches[0]!, description: { ja: `${issue.id}を検証`, en: `Validate ${issue.id}-x and ${issue.id}` } }] }, ctx, 'en');
    expect(h.answer).toBe(`Start with "${issue.name.en}".`);
    expect(h.patches[0]!.description).toEqual({ ja: `「${issue.name.ja}」を検証`, en: `Validate ${issue.id}-x and "${issue.name.en}"` });
    expect(h.patches[0]!.refs).toEqual([issue.id]);
    const ja = humanizeProposal({ ...p, answer: `${issue.name.ja}（${issue.id}）はimpact5、costJpyを確認` }, ctx, 'ja');
    expect(ja.answer).toBe(`${issue.name.ja}は影響度5、投資額を確認`);
    expect(humanizeProposal({ ...p, answer: 'High impact; check costJpy.' }, ctx, 'en').answer).toBe('High impact; check investment.');
  });

  it('draft construction never mutates data; a batch applies once and preserves protected numeric data', async () => {
    const ctx = context(), baseline = overviewBaseline(ctx, state);
    const p = validateOverviewProposal(proposal(ctx), ctx), updates = proposalEntities(p, ctx);
    expect(overviewBaseline(ctx, state)).toBe(baseline);
    const numeric = entitiesOf('solution', loaded).map((s) => [s.costJpy, s.annualBenefitJpy]);
    await commitPackChanges(updates.map((entity) => ({ op: 'upsert', entity })), currentScope(), loaded);
    expect(loaded.byId.get(p.patches[0]!.id)?.description.en).toBe('Validate the bottleneck hypothesis.');
    expect(entitiesOf('solution', loaded).map((s) => [s.costJpy, s.annualBenefitJpy])).toEqual(numeric);
    expect(usePackEdits.getState().value.upserts).toHaveLength(1);
  });

  it('refuses stale work targets and invalid batches without partially saving data', async () => {
    const ctx = context(), changes = proposalEntities(proposal(ctx), ctx).map((entity) => ({ op: 'upsert' as const, entity }));
    await expect(commitPackChanges(changes, 'different-project', loaded)).rejects.toThrow('conflicts');
    const oldPack = loaded;
    activatePack(samplePack);
    await expect(commitPackChanges(changes, currentScope(), oldPack)).rejects.toThrow('conflicts');
    const solution = entitiesOf('solution', loaded)[0]!;
    const before = loaded;
    await expect(commitPackChanges([
      ...changes,
      { op: 'upsert', entity: { ...solution, issueIds: ['unknown-issue'] } },
    ], currentScope(), loaded)).rejects.toThrow('invalid data');
    expect(loaded).toBe(before);
    expect(usePackEdits.getState().value.upserts).toEqual([]);
  });
});
