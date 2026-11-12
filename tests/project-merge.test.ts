import { beforeEach, describe, expect, it } from 'vitest';
import { planRelationMerge, useProjects, type MergeDismissal, type Project, type ProjectRelation } from '../src/state/projects.ts';
import {
  assessPair, EMPTY_EVIDENCE, MERGE_WARN_THRESHOLD, mergeBriefs, mergeWarnings, packEvidence, REWARN_MARGIN, themesOf, type PackEvidence,
} from '../src/modules/project/projectMerge.ts';

const project = (id: string, name: string, purpose?: string, extra: Partial<Project> = {}): Project => ({
  id, companyId: 'c', name, createdAt: '2025-01-01T00:00:00Z', step: 'define', ...(purpose ? { brief: { purpose } } : {}), ...extra,
});
const relation = (from: string, to: string, kind: ProjectRelation['kind']): ProjectRelation => ({
  id: `${from}-${to}`, companyId: 'c', from, to, kind, createdAt: '2025-01-01T00:00:00Z',
});
const noEvidence = new Map<string, PackEvidence>();

// Same business issue in different words: no shared wording, so the relation suggestions miss it.
const churn = project('a', '解約防止プログラム', '既存顧客の解約率を下げる');
const retention = project('b', 'Customer retention', 'Reduce churn of existing customers');
const office = project('c', 'Office move', 'Plan the new office layout');

describe('business-meaning merge warnings (PARAM-151〜154)', () => {
  it('finds a business theme across synonyms and languages, but not inside other words', () => {
    expect(themesOf(churn)).toContain('retention');
    expect(themesOf(retention)).toContain('retention');
    expect(themesOf(project('x', '顧客離反の分析'))).toContain('retention');
    expect(themesOf(office)).toEqual([]);
    // "ai" is a short Latin term: it must not match inside "maintain" or "said".
    expect(themesOf(project('y', 'Maintain what was said'))).not.toContain('ai');
    expect(themesOf(project('z', 'AI agent for sales'))).toContain('ai');
  });

  it('reads KPIs, OKRs, issues, solutions and catalog data from a pack, skipping anything malformed', () => {
    const ev = packEvidence({
      entities: [
        { kind: 'kpi', name: { ja: '解約率', en: 'Churn rate' } },
        { kind: 'issue', name: { ja: '更新前の接点不足', en: 'Few touchpoints before renewal' } },
        { kind: 'cause', name: '担当者の異動' },
        { kind: 'solution', name: { ja: 'ヘルススコア', en: 'Health score' } },
        { kind: 'kpi', name: 42 },
        null,
      ],
      extensions: {
        okr: { objectives: [{ objective: { ja: '継続率を高める', en: 'Raise retention' }, keyResults: [{ text: { ja: '更新率 95%', en: 'Renewal 95%' } }] }] },
        dataCatalog: { items: [{ name: { ja: '契約台帳', en: 'Contract ledger' } }, {}] },
      },
    });
    expect(ev.kpi.map((i) => i.ja)).toEqual(['解約率', '継続率を高める', '更新率 95%']);
    expect(ev.issue.map((i) => i.ja)).toEqual(['更新前の接点不足', '担当者の異動']);
    expect(ev.solution.map((i) => i.en)).toEqual(['Health score']);
    expect(ev.data.map((i) => i.ja)).toEqual(['契約台帳']);
    expect(packEvidence(null)).toEqual(EMPTY_EVIDENCE);
    expect(packEvidence({ entities: 'x', extensions: { okr: 3 } })).toEqual(EMPTY_EVIDENCE);
  });

  it('flags a pair sharing a theme and pack items with the reasons, and not unrelated projects', () => {
    const ea = packEvidence({ entities: [{ kind: 'kpi', name: '解約率' }, { kind: 'issue', name: '更新前の接点不足' }] });
    const eb = packEvidence({ entities: [{ kind: 'kpi', name: '解約率（月次）' }, { kind: 'issue', name: '更新前の顧客接点不足' }] });
    const evidence = new Map([['a', ea], ['b', eb]]);
    const r = assessPair(churn, retention, { relations: [], evidence });
    expect(r.score).toBeGreaterThanOrEqual(MERGE_WARN_THRESHOLD);
    expect(r.reasons.map((x) => x.kind)).toEqual(expect.arrayContaining(['theme', 'kpi', 'issue']));
    expect(r.reasons.find((x) => x.kind === 'kpi')!.items.map((i) => i.ja)).toEqual(['解約率']);
    // Pack items count only when both projects have a pack.
    expect(assessPair(churn, retention, { relations: [], evidence: new Map([['a', ea]]) }).reasons.map((x) => x.kind)).toEqual(['theme']);
    expect(assessPair(churn, office, { relations: [], evidence }).score).toBe(0);
  });

  it('counts a registered "same issue" relation, caps the score at 1, and lists strongest reasons first', () => {
    const r = assessPair(churn, retention, { relations: [relation('b', 'a', 'same')], evidence: noEvidence });
    expect(r.reasons[0]!.kind).toBe('sameRelation');
    expect(r.score).toBeCloseTo(0.75);
    const twin = project('t', '解約防止プログラム', '既存顧客の解約率を下げる');
    expect(assessPair(churn, twin, { relations: [relation('a', 't', 'same')], evidence: noEvidence }).score).toBe(1);
  });

  it('ignores themes every project shares, so one company-wide theme does not flag every pair', () => {
    const ps = ['p', 'q', 'r'].map((id) => project(id, `Project ${id}`, `${id}: 営業データの可視化`));
    expect(mergeWarnings(ps, [], noEvidence, []).warnings).toEqual([]);
    const two = ps.slice(0, 2);
    expect(assessPair(two[0]!, two[1]!, { relations: [], evidence: noEvidence }).reasons.map((x) => x.kind)).toContain('theme');
  });

  it('keeps a pair judged different quiet until the evidence grows by PARAM-153', () => {
    // Two shared themes (retention and revenue) reach the threshold without any shared wording.
    const a = project('a', '解約防止', '既存顧客の解約を減らし、更新の売上を守る');
    const b = project('b', 'Renewals', 'Reduce churn and protect renewal revenue');
    const base = mergeWarnings([a, b, office], [], noEvidence, []);
    expect(base.warnings.map((w) => [w.a, w.b])).toEqual([['a', 'b']]);
    const score = base.warnings[0]!.score;
    const dismissal: MergeDismissal = { id: 'd', companyId: 'c', a: 'b', b: 'a', score, at: '2025-02-01T00:00:00Z' };
    const quiet = mergeWarnings([a, b, office], [], noEvidence, [dismissal]);
    expect(quiet.warnings).toEqual([]);
    expect(quiet.dismissed.map((d) => d.dismissal.id)).toEqual(['d']);
    const grown = mergeWarnings([a, b, office], [relation('a', 'b', 'same')], noEvidence, [dismissal]);
    expect(grown.warnings[0]!.score).toBeGreaterThanOrEqual(score + REWARN_MARGIN);
    expect(grown.dismissed).toEqual([]);
    // Linking them as dependent or correlated says they are two projects on purpose.
    expect(mergeWarnings([a, b, office], [relation('b', 'a', 'dependsOn')], noEvidence, []).warnings).toEqual([]);
  });

  it('proposes merged inputs that keep both texts and combine the sources', () => {
    const keep = project('k', 'K', '解約率を下げる', { brief: { purpose: '解約率を下げる', focus: '法人', useWorkIq: false, workIqRounds: 2, materialNames: ['a.pdf'] } });
    const absorb = project('x', 'X', undefined, { brief: { purpose: '顧客離反を防ぐ', focus: '法人', researchNote: 'メモ', useWorkIq: true, workIqRounds: 3, asOf: '2025-03-01', materialNames: ['a.pdf', 'b.xlsx'] } });
    expect(mergeBriefs(keep, absorb, '【統合元: X】')).toEqual({
      purpose: '解約率を下げる\n\n【統合元: X】\n顧客離反を防ぐ',
      focus: '法人',
      asOf: '2025-03-01',
      researchNote: 'メモ',
      useWorkIq: true,
      workIqRounds: 3,
      materialNames: ['a.pdf', 'b.xlsx'],
    });
    expect(mergeBriefs(keep, keep, 'h').purpose).toBe('解約率を下げる');
  });
});

describe('re-pointing relations on merge', () => {
  it('drops the pair, duplicates and loops, and moves the rest to the kept project', () => {
    const plan = planRelationMerge([
      relation('k', 'x', 'same'),
      relation('x', 'p', 'correlated'),
      relation('k', 'q', 'correlated'),
      relation('x', 'q', 'dependsOn'),
      // r → s → k already; re-pointing x → r to k → r would loop.
      relation('r', 's', 'dependsOn'),
      relation('s', 'k', 'dependsOn'),
      relation('x', 'r', 'dependsOn'),
      relation('m', 'n', 'dependsOn'),
    ], 'k', 'x');
    expect(plan.dropped.map((d) => [d.relation.id, d.reason])).toEqual([['k-x', 'pair'], ['x-q', 'duplicate'], ['x-r', 'cycle']]);
    expect(plan.moved.map((r) => [r.from, r.to])).toEqual([['k', 'p']]);
    expect(plan.relations.some((r) => r.from === 'x' || r.to === 'x')).toBe(false);
    expect(plan.relations).toHaveLength(5);
  });
});

describe('mergeProjects (store)', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjects.setState({ companies: [], projects: [], relations: [], mergeDismissals: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
  });

  const setup = () => {
    const s = useProjects.getState();
    const c = s.addCompany('Contoso');
    if (!c.ok) throw new Error();
    const ids = ['Keep', 'Absorb', 'Other'].map((n) => {
      const r = useProjects.getState().addProject(c.id, n, { purpose: `${n} purpose` });
      if (!r.ok) throw new Error();
      return r.id;
    });
    return { company: c.id, keep: ids[0]!, absorb: ids[1]!, other: ids[2]! };
  };

  it('merges inputs and relations, deletes the absorbed project, records the reasons and moves the target', () => {
    const { keep, absorb, other } = setup();
    useProjects.getState().addRelation(absorb, keep, 'same');
    useProjects.getState().addRelation(absorb, other, 'dependsOn');
    useProjects.getState().dismissMergeWarning(absorb, other, 0.3);
    useProjects.getState().setTarget({ kind: 'project', projectId: absorb });
    const r = useProjects.getState().mergeProjects(keep, absorb, { name: 'Merged', brief: { purpose: 'Both purposes' }, reasons: ['theme'], score: 0.75, hadPack: false });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error();
    expect(r.moved.map((m) => [m.from, m.to])).toEqual([[keep, other]]);
    expect(r.dropped.map((d) => d.reason)).toEqual(['pair']);
    const st = useProjects.getState();
    expect(st.projects.map((p) => p.id)).toEqual([keep, other]);
    const kept = st.projects.find((p) => p.id === keep)!;
    expect(kept.name).toBe('Merged');
    expect(kept.brief).toEqual({ purpose: 'Both purposes' });
    expect(kept.mergedFrom).toEqual([expect.objectContaining({ name: 'Absorb', reasons: ['theme'], score: 0.75, brief: { purpose: 'Absorb purpose' } })]);
    expect(st.relations.map((x) => [x.from, x.to, x.kind])).toEqual([[keep, other, 'dependsOn']]);
    expect(st.mergeDismissals).toEqual([]);
    expect(st.target).toEqual({ kind: 'project', projectId: keep });
  });

  it('rejects invalid merges without changing anything', () => {
    const { keep, absorb, other } = setup();
    const opts = { brief: {}, reasons: [], score: 0.5, hadPack: false };
    const before = useProjects.getState().projects;
    expect(useProjects.getState().mergeProjects(keep, keep, opts)).toEqual({ ok: false, reason: 'self' });
    expect(useProjects.getState().mergeProjects(keep, 'nope', opts)).toEqual({ ok: false, reason: 'notFound' });
    expect(useProjects.getState().mergeProjects(keep, absorb, { ...opts, name: ' ' })).toEqual({ ok: false, reason: 'emptyName' });
    expect(useProjects.getState().mergeProjects(keep, absorb, { ...opts, name: 'Other' })).toEqual({ ok: false, reason: 'duplicate' });
    expect(useProjects.getState().projects).toBe(before);
    // Taking over the absorbed project's name is allowed.
    expect(useProjects.getState().mergeProjects(keep, absorb, { ...opts, name: 'Absorb' }).ok).toBe(true);
    expect(useProjects.getState().projects.map((p) => p.name)).toEqual(['Absorb', 'Other']);
    expect(other).toBeTruthy();
  });

  it('remembers and restores a "different issues" judgement per pair', () => {
    const { keep, absorb } = setup();
    useProjects.getState().dismissMergeWarning(keep, absorb, 0.5);
    useProjects.getState().dismissMergeWarning(absorb, keep, 0.6);
    const ds = useProjects.getState().mergeDismissals;
    expect(ds).toHaveLength(1);
    expect(ds[0]!.score).toBe(0.6);
    useProjects.getState().restoreMergeWarning(ds[0]!.id);
    expect(useProjects.getState().mergeDismissals).toEqual([]);
  });
});
