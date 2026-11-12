import { beforeEach, describe, expect, it } from 'vitest';
import { anchorEvidenceChecks, anchorFreshness, CompanyAnchorSchema, companyAnchorRequiresInternalView, parseCompanyAnchor } from '../src/data/companyAnchor.ts';
import { latestCompanyAnchor, readCompanyAnchorDocument } from '../src/state/companyAnchors.ts';
import { useProjects } from '../src/state/projects.ts';
import {
  alignmentEvaluationKey, alignmentPrompt, alignmentSnapshot, AlignmentEvaluationCasesSchema, assessAlignment, emptyAlignment, evaluateAlignmentCases,
  evaluateNegativeControls, orderedCompanyObjectives, parseAlignmentProposal, projectEvidenceSources, type Alignment, type AlignmentEvaluationCase,
} from '../src/modules/project/companyAlignment.ts';
import { exportProject, importProject } from '../src/modules/project/projectFile.ts';
import { CustomerPack } from '../src/data/schema.ts';
import { samplePack } from '../src/data/sample.ts';

const anchor = CompanyAnchorSchema.parse({
  asOf: '2026-10-01',
  entityScope: { legalEntity: 'Example Company', parent: 'Example Group', figuresScope: ['legal entity', 'group'] },
  statedObjectives: [
    { id: 'O1', text: 'Reduce delivery delays', horizon: '2026', basis: 'published', sourceIds: ['S1'] },
    { id: 'O2', text: 'Improve group resilience', horizon: '2026', basis: 'published', scope: 'group', sourceIds: ['S1'] },
    { id: 'O3', text: 'Improve service response', horizon: '2026', basis: 'customerStated', scope: 'department', sourceIds: ['S2'] },
  ],
  companyKpis: [{ id: 'K1', name: 'On-time delivery', target: '95', unit: '%', period: '2026', scope: 'legal entity', objectiveIds: ['O1'], sourceIds: ['S1'] }],
  segments: [],
  structuralIssues: [],
  analystHypotheses: [{ text: 'Use robots', type: 'strategy' }],
  sources: [
    { id: 'S1', title: 'Annual plan', url: 'https://example.com/plan', accessedDate: '2026-10-01', locator: 'p. 2', excerpt: 'On-time delivery target 95 % in 2026 for legal entity' },
    { id: 'S2', title: 'Meeting notes', type: 'internal', accessedDate: '2026-10-01', locator: 'meeting 1' },
  ],
});

const version = { version: 1, savedAt: '2026-10-01T00:00:00.000Z', anchor };
const direct = (): Alignment => ({
  ...emptyAlignment(1), kind: 'direct', objectiveIds: ['O1'], companyKpiId: 'K1', projectKpi: 'Order delay rate',
  pathway: 'Reducing order delays increases on-time delivery', sourceIds: ['S1'], assessedPurpose: 'Improve deliveries',
});

describe('company anchor and project alignment', () => {
  it('accepts a sourced appendix and rejects missing sections, duplicate or unknown sources', () => {
    expect(parseCompanyAnchor(`Report\n\`\`\`json\n${JSON.stringify(anchor)}\n\`\`\``)).toMatchObject({ ok: true });
    expect(parseCompanyAnchor(JSON.stringify({ ...anchor, companyKpis: undefined })).ok).toBe(false);
    expect(parseCompanyAnchor(JSON.stringify({ ...anchor, sources: [anchor.sources[0], anchor.sources[0]] })).ok).toBe(false);
    expect(parseCompanyAnchor(JSON.stringify({ ...anchor, statedObjectives: [{ ...anchor.statedObjectives[0], sourceIds: ['unknown'] }] })).ok).toBe(false);
    expect(parseCompanyAnchor(JSON.stringify({ ...anchor, sources: [{ ...anchor.sources[0], url: '' }] })).ok).toBe(false);
  });

  it('flags unverified metrics and freshness without claiming a source was verified', () => {
    expect(anchorEvidenceChecks(anchor)[0]?.missing).toEqual([]);
    const changed = CompanyAnchorSchema.parse({ ...anchor, companyKpis: [{ ...anchor.companyKpis[0], target: '90' }] });
    expect(anchorEvidenceChecks(changed)[0]?.missing).toContain('target');
    expect(anchorFreshness(anchor, new Date('2026-11-02T00:00:00Z')).stale).toBe(true);
    const event = CompanyAnchorSchema.parse({ ...anchor, refreshEvents: [{ date: '2026-10-10', description: 'New plan' }] });
    expect(anchorFreshness(event, new Date('2026-10-11T00:00:00Z')).stale).toBe(true);
  });

  it('prevents external display of packs using internal or invalid company inputs, including recorded inputs', () => {
    const publicOnly = { ...version, anchor: { ...anchor, sources: anchor.sources.filter((source) => source.type === 'public'), statedObjectives: anchor.statedObjectives.filter((objective) => objective.id !== 'O3') } };
    expect(companyAnchorRequiresInternalView(undefined)).toBe(false);
    expect(companyAnchorRequiresInternalView({ companyAnchor: publicOnly })).toBe(false);
    expect(companyAnchorRequiresInternalView({ companyAnchor: version })).toBe(true);
    expect(companyAnchorRequiresInternalView({ generation: { inputs: { companyAnchor: version } } })).toBe(true);
    expect(companyAnchorRequiresInternalView({ companyAnchor: { version: 1 } })).toBe(true);
  });

  it('requires real objectives, sources and both KPI sides; parent use and changed purpose are visible', () => {
    expect(assessAlignment('Improve deliveries', version, direct())).toMatchObject({ kind: 'direct', issues: [], outdated: false });
    expect(assessAlignment('Different purpose', version, direct()).outdated).toBe(true);
    expect(assessAlignment('Improve deliveries', version, { ...direct(), companyKpiId: '', sourceIds: ['made-up'] }))
      .toMatchObject({ kind: 'unaligned', issues: expect.arrayContaining(['companyKpi', 'unknownSource']) });
    expect(assessAlignment('Improve deliveries', version, { ...direct(), kind: 'enabler', objectiveIds: ['O2'] }).parentUsed).toBe(true);
    expect(assessAlignment('Improve deliveries', version, { ...direct(), kind: 'defensive', objectiveIds: [], risk: 'Safety', sourceIds: ['S2'] }).kind).toBe('defensive');
    expect(assessAlignment('Improve deliveries', version, {
      ...direct(), effect: { value: '1', unit: 'JPY', period: '2026', scope: 'legal entity' },
      denominator: { value: '10', unit: 'JPY', period: '2026', scope: 'group' },
    }).issues).toContain('comparison');
  });

  it('presents the legal entity before department and group goals without changing the saved order', () => {
    const reordered = { ...anchor, statedObjectives: [anchor.statedObjectives[1]!, anchor.statedObjectives[2]!, anchor.statedObjectives[0]!] };
    expect(orderedCompanyObjectives(reordered).map((objective) => objective.id)).toEqual(['O1', 'O3', 'O2']);
    expect(reordered.statedObjectives.map((objective) => objective.id)).toEqual(['O2', 'O3', 'O1']);
    expect(alignmentPrompt(reordered, 'Purpose', { projectKpi: '', sources: [] }, 'en')).toContain('Assess the legal entity objectives first');
  });

  it('does not count missing evidence or a fabricated objective as direct in negative controls', () => {
    const controls = Array.from({ length: 10 }, (_, i) => assessAlignment('Unrelated project', version, {
      ...direct(), objectiveIds: [i % 2 ? 'NOT-AN-OBJECTIVE' : 'O1'], companyKpiId: '',
    }));
    expect(evaluateNegativeControls(controls)).toMatchObject({ total: 10, unaligned: 10, falseDirect: 0, rate: 1, meetsTarget: true });
    expect(evaluateNegativeControls([])).toMatchObject({ rate: null, meetsTarget: false });
  });

  it('keeps model answers as drafts even if they claim confirmation', () => {
    const suggestion = parseAlignmentProposal(JSON.stringify({ ...direct(), status: 'confirmed', confirmedBy: 'invented', confirmedAt: '2026-10-01' }), version);
    expect(suggestion).toMatchObject({ origin: 'ai', status: 'draft', confirmedBy: '', confirmedAt: '' });
    expect(() => parseAlignmentProposal('not json', version)).toThrow();
  });

  it('detects an ambiguous source and expires confirmation based on regenerated project evidence', () => {
    const confirmed = { ...direct(), status: 'confirmed' as const, confirmedBy: 'Sponsor', confirmedAt: '2026-10-01' };
    expect(assessAlignment('Improve deliveries', version, confirmed, ['S1']).issues).toContain('ambiguousSource');
    const snapshot = alignmentSnapshot(version, 'Improve deliveries', [
      confirmed,
      { ...confirmed, id: 'project-evidence', sourceIds: ['source-web-1'] },
    ], 'en');
    expect(snapshot[0]).toMatchObject({ status: 'confirmed', confirmedBy: 'Sponsor' });
    expect(snapshot[1]).toMatchObject({ status: 'draft', confirmedBy: '', confirmedAt: '', assessedPurpose: '' });
    expect(alignmentSnapshot(version, 'Improve deliveries', [], 'en')[0]).toMatchObject({ kind: 'unaligned', status: 'draft' });
  });

  it('includes only selected project-source summaries in the proposal, not analyst hypotheses or unrelated people', () => {
    const lt = (text: string) => ({ ja: text, en: text });
    const source = (id: string, origin: string) => ({
      id, kind: 'source', name: lt(id), description: lt('source'), world: 'digital', type: 'data',
      classification: 'internal', author: 'human', sourceIds: [], publisher: lt('publisher'),
      accessedDate: '2026-10-01', origin,
    });
    const pack = CustomerPack.parse({
      ...samplePack,
      entities: [
        source('source-workiq-1', 'm365'),
        source('source-web-1', 'web'),
        { id: 'cause-1', kind: 'cause', name: lt('Work IQ fact'), description: lt('Review the original'), world: 'real', type: 'event', classification: 'internal', author: 'ai', sourceIds: ['source-workiq-1'] },
        { id: 'person-1', kind: 'person', name: lt('Private person'), description: lt('Private'), world: 'real', type: 'person', classification: 'internal', author: 'ai', sourceIds: ['source-workiq-1'], role: lt('Role'), siteId: 'site-1' },
      ],
      extensions: {},
    });
    const sources = projectEvidenceSources(pack, 'en');
    expect(sources.find((item) => item.id === 'source-workiq-1')?.facts).toEqual([{ kind: 'cause', text: 'Work IQ fact: Review the original' }]);
    const prompt = alignmentPrompt(anchor, 'Improve deliveries', { projectKpi: 'Delay rate', sources: sources.filter((s) => s.id === 'source-workiq-1') }, 'en');
    expect(prompt).toContain('Work IQ fact');
    expect(prompt).toContain('not original documents');
    expect(prompt).not.toContain('source-web-1');
    expect(prompt).not.toContain('Private person');
    expect(prompt).not.toContain('Use robots');
  });
});

describe('independent alignment evaluation', () => {
  const projectCases: AlignmentEvaluationCase[] = [
    { id: 'p1', expected: 'direct', observed: 'direct', negativeControl: false },
    { id: 'p2', expected: 'direct', observed: 'indirect', negativeControl: false },
    { id: 'p3', expected: 'indirect', observed: 'direct', negativeControl: false },
    { id: 'p4', expected: 'indirect', observed: 'indirect', negativeControl: false },
  ];
  const controls: AlignmentEvaluationCase[] = Array.from({ length: 10 }, (_, index) => ({
    id: `n${index}`, expected: 'unaligned', observed: index === 9 ? 'direct' : 'unaligned', negativeControl: true,
  }));

  it('separates controls from agreement, kappa and the direct distribution at the 90% boundary', () => {
    const result = evaluateAlignmentCases([...projectCases, ...controls]);
    expect(result.negative).toMatchObject({ total: 10, unaligned: 9, rate: 0.9, falseDirect: 1, meetsTarget: true });
    expect(result).toMatchObject({ total: 4, matches: 2, agreement: 0.5, kappa: 0, direct: 2, directRate: 0.5, directWarning: false });
    expect(result.negativeInterval?.low).toBeCloseTo(0.59585, 4);
    expect(result.negativeInterval?.high).toBeCloseTo(0.98212, 4);
    expect(result.agreementInterval?.low).toBeCloseTo(0.15004, 4);
    expect(result.directInterval?.low).toBeCloseTo(0.15004, 4);
    expect(result.kappaInterval?.low).toBeCloseTo(-0.97998, 4);
    expect(result.kappaInterval?.high).toBeCloseTo(0.97998, 4);
    const below = evaluateAlignmentCases([...controls.slice(0, 8), { ...controls[8]!, observed: 'indirect' }, controls[9]!]);
    expect(below.negative).toMatchObject({ rate: 0.8, meetsTarget: false });
  });

  it('does not claim a rate, kappa or confidence interval for empty or degenerate samples', () => {
    expect(evaluateAlignmentCases([])).toMatchObject({
      agreement: null, kappa: null, kappaInterval: null, directRate: null, directInterval: null, negativeInterval: null, agreementInterval: null,
      negative: { rate: null, meetsTarget: false },
    });
    expect(evaluateAlignmentCases([projectCases[0]!])).toMatchObject({ agreement: 1, kappa: null, directWarning: true });
    expect(evaluateAlignmentCases([projectCases[0]!, projectCases[3]!])).toMatchObject({ agreement: 1, kappa: 1, kappaInterval: null });
    expect(evaluateAlignmentCases([projectCases[0]!, projectCases[1]!, { ...projectCases[1]!, id: 'p5' }]))
      .toMatchObject({ kappa: 0, kappaInterval: null });
    expect(evaluateAlignmentCases(controls)).toMatchObject({ total: 0, agreement: null, directRate: null });
  });

  it('matches a published symmetric two-category kappa interval example', () => {
    // Independent reference: https://tagaroo.ai/blog/confidence-intervals-for-agreement/ (n=20, κ=.60).
    const groups = [
      { expected: 'direct' as const, observed: 'direct' as const, count: 8 },
      { expected: 'direct' as const, observed: 'indirect' as const, count: 2 },
      { expected: 'indirect' as const, observed: 'direct' as const, count: 2 },
      { expected: 'indirect' as const, observed: 'indirect' as const, count: 8 },
    ];
    const cases: AlignmentEvaluationCase[] = groups.flatMap(({ count, ...pair }) =>
      Array.from({ length: count }, (_, index) => ({ ...pair, id: `${pair.expected}-${pair.observed}-${index}`, negativeControl: false })));
    const result = evaluateAlignmentCases(cases);
    expect(result.kappa).toBeCloseTo(0.6, 8);
    expect(result.kappaInterval?.low).toBeCloseTo(0.25, 2);
    expect(result.kappaInterval?.high).toBeCloseTo(0.95, 2);
  });

  it('rejects duplicate IDs, positive-labelled controls and unrecognized fields', () => {
    expect(AlignmentEvaluationCasesSchema.safeParse([projectCases[0], projectCases[0]]).success).toBe(false);
    expect(AlignmentEvaluationCasesSchema.safeParse([{ ...controls[0], expected: 'direct' }]).success).toBe(false);
    expect(AlignmentEvaluationCasesSchema.safeParse([{ ...projectCases[0], name: 'unneeded' }]).success).toBe(false);
  });
});

describe('company anchor persistence and project portability', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjects.setState({ companies: [], projects: [], relations: [], mergeDismissals: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
  });

  it('versions shared company data separately, exports it, restores it, and deletes it with the company', () => {
    const state = useProjects.getState();
    const c = state.addCompany('Example Company');
    if (!c.ok) throw new Error();
    const p = state.addProject(c.id, 'Delivery', { purpose: 'Improve deliveries' });
    if (!p.ok) throw new Error();
    expect(state.setCompanyAnchor(c.id, anchor)).toEqual({ ok: true, version: 1 });
    expect(state.setCompanyAnchor(c.id, { ...anchor, asOf: '2026-10-02' })).toEqual({ ok: true, version: 2 });
    state.setProjectAlignments(p.id, [direct()]);
    localStorage.setItem(alignmentEvaluationKey(c.id), JSON.stringify({ cases: [] }));
    expect(readCompanyAnchorDocument(c.id)?.versions.map((v) => v.anchor.asOf)).toEqual(['2026-10-01', '2026-10-02']);
    const exported = exportProject(p.id);
    expect(exported?.companyAnchor?.versions).toHaveLength(2);
    state.deleteCompany(c.id);
    expect(latestCompanyAnchor(c.id)).toBeNull();
    expect(localStorage.getItem(alignmentEvaluationKey(c.id))).toBeNull();
    expect(importProject(JSON.stringify(exported))).toMatchObject({ ok: true });
    expect(latestCompanyAnchor(c.id)?.version).toBe(2);
    expect(useProjects.getState().projects[0]?.alignments).toHaveLength(1);
  });

  it('never overwrites another registered company anchor on import', () => {
    const state = useProjects.getState();
    const original = state.addCompany('Example Company');
    if (!original.ok) throw new Error();
    const p = state.addProject(original.id, 'Delivery');
    if (!p.ok) throw new Error();
    state.setCompanyAnchor(original.id, anchor);
    state.setProjectAlignments(p.id, [{ ...direct(), status: 'confirmed', confirmedBy: 'Sponsor', confirmedAt: '2026-10-01' }]);
    const file = exportProject(p.id);
    state.deleteCompany(original.id);
    const other = state.addCompany('Example Company');
    if (!other.ok) throw new Error();
    state.setCompanyAnchor(other.id, { ...anchor, asOf: '2026-10-04' });
    expect(importProject(JSON.stringify(file))).toMatchObject({ ok: true, anchorSkipped: true });
    expect(latestCompanyAnchor(other.id)?.anchor.asOf).toBe('2026-10-04');
    expect(useProjects.getState().projects[0]?.alignments?.[0]).toMatchObject({ status: 'draft', confirmedBy: '' });
  });
});
