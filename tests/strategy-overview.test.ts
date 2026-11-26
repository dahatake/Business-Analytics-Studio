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
import {
  appendObjective, emptyDestination, laneHref, nodeDestination, packObjectiveDrafts, readinessDraftHref, type ObjectiveInput,
} from '../src/modules/project/strategyPortal.ts';
import { CompanyAnchorVersionSchema } from '../src/data/companyAnchor.ts';

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

  it('creates distinct step-focused prompts without sending internal deliverables to external audiences', () => {
    const ctx = context();
    ctx.deliverables.docs.asis = { problem: { text: 'PRIVATE_DELIVERABLE', author: 'human', updatedAt: '2026-11-16' } };
    const asis = overviewPrompt(ctx, state, 'en', 'internal', 'asis');
    const kpi = overviewPrompt(ctx, state, 'en', 'internal', 'kpi');
    expect(asis).toContain('validate root-cause hypotheses');
    expect(asis).toContain('PRIVATE_DELIVERABLE');
    expect(kpi).toContain('define measurable outcomes');
    expect(kpi).not.toContain('PRIVATE_DELIVERABLE');
    const external = overviewPrompt(overviewContext(ctx, 'external'), state, 'en', 'external', 'asis');
    expect(external).not.toContain('PRIVATE_DELIVERABLE');
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

  it('only accepts step deliverable figures when that deliverable was included in the request', () => {
    const ctx = context(), p = proposal(ctx);
    ctx.deliverables.docs.asis = { problem: { text: 'Customer wait is 98765 days', author: 'human', updatedAt: '2026-11-16' } };
    const withFigure = { ...p, answer: 'Customer wait is 98765 days.' };
    expect(() => validateOverviewProposal(withFigure, ctx, 'asis', 'internal')).not.toThrow();
    expect(() => validateOverviewProposal(withFigure, ctx, 'tobe', 'internal')).toThrow('Unverified figures');
    expect(() => validateOverviewProposal(withFigure, ctx, 'asis', 'external')).toThrow('Unverified figures');
    expect(() => validateOverviewProposal(withFigure, ctx)).toThrow('Unverified figures');
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

describe('strategy map portal and drafts (FR-349, FR-350)', () => {
  const okrDraft = { id: 'okr-d', objective: 'Draft OKR', kpiIds: ['kpi-d'], objectiveIds: ['obj-new'] };
  const drafts = (issueId: string) => ({
    objectives: [{ id: 'obj-growth', text: 'Already saved' }, { id: 'obj-new', text: 'Draft objective' }],
    okrs: [okrDraft], kpis: [{ id: 'kpi-d', name: 'Draft KPI' }],
    changed: [issueId], objectiveIssues: [{ objectiveId: 'obj-new', issueId }],
  });

  it('shows drafts as separate nodes and dashed links after the saved items, never replacing saved data', () => {
    const ctx = context();
    const issue = entitiesOf('issue', ctx.pack)[0]!;
    const plain = strategyMap(ctx, state, 'impact', 'en');
    const map = strategyMap(ctx, state, 'impact', 'en', true, drafts(issue.id));
    const node = (id: string) => map.nodes.find((n) => n.id === id);
    expect(node('objective:draft:obj-growth')).toBeUndefined();
    expect(node('objective:obj-growth')?.draft).toBeUndefined();
    expect(node('objective:draft:obj-new')).toMatchObject({ ref: 'obj-new', label: 'Draft objective', draft: 'new' });
    expect(node(`issue:${issue.id}`)?.draft).toBe('changed');
    expect(map.links).toContainEqual({ source: 'objective:draft:obj-new', target: 'okr:draft:okr-d', direct: false, draft: true });
    expect(map.links).toContainEqual({ source: 'okr:draft:okr-d', target: 'kpi:draft:kpi-d', direct: false, draft: true });
    expect(map.links).toContainEqual({ source: 'objective:draft:obj-new', target: `issue:${issue.id}`, direct: true, draft: true });
    const kpis = map.nodes.filter((n) => n.lane === 'kpi');
    expect(kpis.at(-1)?.id).toBe('kpi:draft:kpi-d');
    expect(map.nodes.filter((n) => !n.draft || n.draft === 'changed').map((n) => [n.id, n.score])).toEqual(plain.nodes.map((n) => [n.id, n.score]));
    expect(map.links.filter((l) => !l.draft)).toEqual(plain.links);
  });

  it('opens each item where it is entered or checked, and the popup only where no screen exists', () => {
    const issueNode = { lane: 'issue' as const, ref: 'I-1' };
    expect(nodeDestination(issueNode, 'c1', true)).toEqual({ kind: 'link', href: '#/relations?view=table&target=relation-table&edit=I-1&field=name' });
    expect(nodeDestination({ lane: 'kpi', ref: 'k1' }, 'c1', true)).toEqual({ kind: 'link', href: '#/analysis?tab=kpi&target=proj-kpi-row-k1' });
    expect(nodeDestination({ lane: 'kpi', ref: 'k1', draft: 'new' }, 'c1', true)).toEqual({ kind: 'link', href: '#/analysis?tab=kpi&target=proj-kpi-draft-k1' });
    expect(nodeDestination({ lane: 'okr', ref: 'o1', draft: 'new' }, 'c1', true)).toEqual({ kind: 'link', href: '#/analysis?tab=kpi&target=proj-okr-draft-o1' });
    expect(nodeDestination({ lane: 'objective', ref: 'obj', draft: 'new' }, 'c1', true)).toEqual({ kind: 'objective', draftId: 'obj' });
    expect(nodeDestination({ lane: 'objective', ref: 'obj', draft: 'new' }, 'c1', false)).toEqual({ kind: 'link', href: '#/projects?target=company-anchor-c1' });
    expect(nodeDestination({ lane: 'objective', ref: 'obj' }, 'c1', true)).toEqual({ kind: 'link', href: '#/projects?target=company-anchor-c1' });
    expect(emptyDestination('objective', 'c1', true)).toEqual({ kind: 'objective' });
    expect(emptyDestination('objective', '', true)).toEqual({ kind: 'link', href: '#/projects' });
    expect(emptyDestination('kpi', '', false)).toEqual({ kind: 'link', href: '#/analysis?tab=kpi&target=proj-kpi-name' });
    expect(emptyDestination('solution', '', false)).toEqual({ kind: 'link', href: '#/relations?view=table&target=relation-table&create=solution&field=name' });
    expect(laneHref('okr', '')).toBe('#/analysis?tab=kpi&target=proj-okr-panel');
    // Unmet readiness items open the form whose AI draft proposes the missing data.
    expect(readinessDraftHref('org')).toBe('#/relations?view=table&target=relation-table&create=person&field=name');
    expect(readinessDraftHref('customers')).toBe('#/relations?view=table&target=relation-table&create=customer&field=name');
    expect(readinessDraftHref('kpi')).toBe('#/analysis?tab=kpi&target=proj-kpi-panel');
    expect(readinessDraftHref('workflow')).toBeUndefined();
  });

  const input = (patch: Partial<ObjectiveInput> = {}): ObjectiveInput => ({
    text: 'Double recurring revenue', horizon: 'FY2027', basis: 'customerStated', scope: 'legalEntity', scopeName: '',
    source: { title: 'Kickoff notes', type: 'internal', url: '', locator: '2026-04-10', accessedDate: '2026-11-16', excerpt: '' }, ...patch,
  });

  it('adds an objective with its own source as a valid anchor, keeping a free draft id', () => {
    const first = appendObjective(null, input({ id: 'obj-new' }), 'Contoso', '2026-11-16');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.id).toBe('obj-new');
    expect(first.anchor.entityScope.legalEntity).toBe('Contoso');
    expect(first.anchor.statedObjectives[0]).toMatchObject({ id: 'obj-new', sourceIds: ['S-1'] });
    expect(first.anchor.sources[0]).toMatchObject({ id: 'S-1', type: 'internal', provenance: 'unknown' });
    const second = appendObjective(first.anchor, input({ id: 'obj-new' }), 'Contoso', '2026-11-16');
    expect(second.ok && [second.id, second.anchor.statedObjectives.length, second.anchor.sources.at(-1)?.id]).toEqual(['OBJ-2', 2, 'S-2']);
    expect(CompanyAnchorVersionSchema.safeParse({ version: 1, savedAt: '2026-11-16T00:00:00.000Z', anchor: first.anchor }).success).toBe(true);
    const roundTrip = packObjectiveDrafts({ companyAnchor: { version: 1, savedAt: '2026-11-16T00:00:00.000Z', anchor: first.anchor } }, []);
    expect(roundTrip).toEqual([{ ...input({ id: 'obj-new' }), source: { ...input().source } }]);
    expect(packObjectiveDrafts({ companyAnchor: { version: 1, savedAt: '2026-11-16T00:00:00.000Z', anchor: first.anchor } }, ['obj-new'])).toEqual([]);
    expect(packObjectiveDrafts({ companyAnchor: { broken: true } }, [])).toEqual([]);
  });

  it('reports the missing fields instead of saving an objective without a usable source', () => {
    const published = appendObjective(null, input({ basis: 'published', source: { ...input().source, type: 'public' } }), 'Contoso', '2026-11-16');
    expect(published).toEqual({ ok: false, errors: ['url'] });
    const empty = appendObjective(null, input({ text: ' ', horizon: '', source: { ...input().source, title: '', locator: '', accessedDate: '' } }), 'Contoso', '2026-11-16');
    expect(empty.ok ? [] : [...empty.errors].sort()).toEqual(['accessedDate', 'horizon', 'locator', 'text', 'title']);
  });
});
