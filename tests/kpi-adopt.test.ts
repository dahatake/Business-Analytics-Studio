import { describe, expect, it } from 'vitest';
import {
  addKpiDrafts, addOkrDrafts, applyCopilotPick, discardKpiDraft, emptyDrafts, kpiAdoptState, kpiDraftPrompt, okrAdoptState,
  parseKpiDraftResponse, parseTarget, saveAllDrafts, saveKpiDraft, saveOkrDraft, MAX_AI_KPIS, type DraftPromptInput,
  applyMissingKpiDraftResponse, missingKpiDraftPrompt, missingKpiDrafts, applyKpiScreen, kpiScreenRequest, applyKpiFill, emptyKpiFields, kpiFillPrompt, kpiFillTargets,
  periodDate, provisionalFill,
} from '../src/modules/project/kpiAdopt.ts';
import { validateDecisionRequest } from '../src/ai/decision.ts';
import type { KpiData } from '../src/modules/project/model.ts';
import { samplePack } from '../src/data/sample.ts';

// Shapes taken from a real Work IQ pack (extensions.okr): text targets, units with qualifiers, unmeasured currents.
const ext = {
  kpis: [
    { id: 'k-reach', name: 'Customer Reach', definition: 'FY27の顧客リーチ拡大', target: '10倍', unit: '倍', current: '未計測', period: 'FY27', sourceIds: ['s1'] },
    { id: 'k-wins', name: 'Frontier Transformation Wins', target: '最低5件', unit: '件/Hub SE', period: '2026-06-30', sourceIds: ['s2'] },
    { id: 'k-eng', name: 'Engagements', target: '≥50 engagements', current: '12', sourceIds: [] },
    { id: 'k-rate', name: 'Adoption rate', target: '20〜30%', sourceIds: [] },
  ],
  objectives: [
    {
      id: 'o-growth', objective: '顧客との接点を増やす', sourceIds: ['s3'], companyObjectiveIds: ['co-1'],
      keyResults: [
        { text: 'Customer Reach を 10 倍にする', target: '10倍', kpiId: 'k-reach' },
        { text: 'ワークショップを実施', target: '月4回' },
      ],
    },
  ],
};
const empty = (): KpiData => ({ kpis: [], okrs: [] });
const input = (over: Partial<DraftPromptInput> = {}): DraftPromptInput => ({ purpose: '顧客接点の拡大', ext, data: empty(), drafts: emptyDrafts(), lang: 'ja', ...over });

describe('parseTarget (FR-325)', () => {
  it.each([
    ['10倍', '倍', '10', '倍', false],
    ['最低5件', '件/Hub SE', '5', '件/Hub SE', false],
    ['≥50 engagements', undefined, '50', 'engagements', false],
    ['20%', undefined, '20', '%', false],
    ['FY27までに10倍', undefined, '10', '倍', false],
    ['2026年3月までに５０件', undefined, '50', '件', false],
    ['20〜30%', undefined, '20', '%', true],
    ['20-30%', undefined, '20', '%', true],
    ['未計測', undefined, '', '', false],
  ])('%s → %s', (text, unit, value, u, multiple) => {
    const r = parseTarget(text, unit);
    expect(r.value).toBe(value);
    if (unit || value) expect(r.unit).toBe(u);
    expect(r.multiple).toBe(multiple);
  });
});

describe('adopting internal KPIs as drafts', () => {
  it('keeps the wording, flags what the user must check, and never guesses a deadline', () => {
    const { drafts, added } = addKpiDrafts(['okr.kpi:k-reach', 'okr.kpi:k-wins', 'okr.kpi:k-eng'], ext, empty(), emptyDrafts(), 'ja');
    expect(added).toBe(3);
    const [reach, wins, eng] = drafts.kpis;
    expect(reach).toMatchObject({ name: 'Customer Reach', target: '10', unit: '倍', baseline: '', current: '', deadline: '', original: { target: '10倍 倍', current: '未計測', period: 'FY27' } });
    expect(reach!.notes).toEqual(['noCurrent', 'noDeadline']);
    expect(wins).toMatchObject({ target: '5', unit: '件/Hub SE', deadline: '2026-06-30', sourceIds: ['s2'] });
    expect(eng).toMatchObject({ target: '50', baseline: '12', current: '12' });
    expect(eng!.notes).toContain('baselineFromCurrent');
  });

  it('skips candidates already drafted or adopted', () => {
    const first = addKpiDrafts(['okr.kpi:k-reach'], ext, empty(), emptyDrafts(), 'ja');
    const again = addKpiDrafts(['okr.kpi:k-reach'], ext, empty(), first.drafts, 'ja');
    expect(again).toMatchObject({ added: 0, skipped: 1 });
    const data: KpiData = { kpis: [{ id: 'x', name: 'R', unit: '倍', baseline: 1, current: 1, target: 10, deadline: '2027-03-31', adoptedFrom: 'okr.kpi:k-reach' }], okrs: [] };
    expect(kpiAdoptState('okr.kpi:k-reach', data, emptyDrafts())).toBe('adopted');
  });

  it('treats objectives packKpis already imported (same id) as adopted', () => {
    const data: KpiData = { kpis: [], okrs: [{ id: 'o-growth', objective: 'x', keyResults: [] }] };
    expect(okrAdoptState('okr.obj:o-growth', data, emptyDrafts())).toBe('adopted');
  });

  it('saves a completed draft as a customer-defined KPI that remembers where it came from', () => {
    const { drafts } = addKpiDrafts(['okr.kpi:k-reach'], ext, empty(), emptyDrafts(), 'ja');
    const id = drafts.kpis[0]!.id;
    const bad = saveKpiDraft(id, empty(), drafts);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatchObject({ kind: 'kpi', fields: ['baseline', 'current', 'deadline'] });
    const filled = { ...drafts, kpis: [{ ...drafts.kpis[0]!, baseline: '1', current: '1', deadline: '2027-06-30' }] };
    const ok = saveKpiDraft(id, empty(), filled);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.kpis[0]).toMatchObject({ id, baseline: 1, target: 10, origin: 'customerDefined', adoptedFrom: 'okr.kpi:k-reach', sourceIds: ['s1'] });
      expect(ok.drafts.kpis).toEqual([]);
    }
  });
});

describe('adopting internal OKRs as drafts', () => {
  it('links each key result to a KPI draft, reusing drafts and creating ones for unlinked key results', () => {
    const pre = addKpiDrafts(['okr.kpi:k-reach'], ext, empty(), emptyDrafts(), 'ja').drafts;
    const { drafts, added } = addOkrDrafts(['okr.obj:o-growth'], ext, empty(), pre, 'ja');
    expect(added).toBe(1);
    const okr = drafts.okrs[0]!;
    expect(okr).toMatchObject({ objective: '顧客との接点を増やす', companyObjectiveIds: ['co-1'], sourceIds: ['s3'] });
    expect(okr.keyResults[0]!.kpiId).toBe(pre.kpis[0]!.id);
    expect(okr.keyResults[1]!.text).toBe('ワークショップを実施 (月4回)');
    const krDraft = drafts.kpis.find((k) => k.id === okr.keyResults[1]!.kpiId)!;
    expect(krDraft).toMatchObject({ candidateId: 'okr.kr:o-growth:1', target: '4', unit: '回' });
    expect(drafts.kpis).toHaveLength(2);
  });

  it('saves an OKR only together with valid linked KPI drafts (atomic)', () => {
    const { drafts } = addOkrDrafts(['okr.kpi:k-wins'], ext, empty(), emptyDrafts(), 'ja');
    const okrId = drafts.okrs[0]!.id;
    const blocked = saveOkrDraft(okrId, empty(), drafts);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errors.map((e) => e.kind).sort()).toEqual(['kpi', 'link']);
    const filled = { ...drafts, kpis: drafts.kpis.map((k) => ({ ...k, baseline: '0', current: '2' })) };
    const ok = saveOkrDraft(okrId, empty(), filled);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.kpis).toHaveLength(1);
      expect(ok.data.okrs[0]).toMatchObject({ adoptedFrom: 'okr.kpi:k-wins', origin: 'customerDefined' });
      expect(ok.data.okrs[0]!.keyResults[0]!.kpiId).toBe(ok.data.kpis[0]!.id);
      expect(ok.drafts).toEqual({ kpis: [], okrs: [] });
    }
  });

  it('FR-341: an adopted KPI/OKR keeps the organisation of its candidate, with the estimate mark', () => {
    const withOrg = {
      ...ext,
      orgUnits: [{ id: 'org-unit', level: 'business' as const, name: '物流事業部', basis: 'inferred' as const, sourceIds: ['s1'] }],
      kpis: ext.kpis.map((k) => (k.id === 'k-wins' ? { ...k, orgUnitId: 'org-unit' } : k)),
    };
    const { drafts } = addOkrDrafts(['okr.kpi:k-wins'], withOrg, empty(), emptyDrafts(), 'ja');
    const org = { level: 'business', name: '物流事業部', inferred: true };
    expect(drafts.kpis[0]!.org).toEqual(org);
    expect(drafts.okrs[0]!.org).toEqual(org);
    const ok = saveOkrDraft(drafts.okrs[0]!.id, empty(), { ...drafts, kpis: drafts.kpis.map((k) => ({ ...k, baseline: '0', current: '2' })) });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.kpis[0]!.org).toEqual(org);
      expect(ok.data.okrs[0]!.org).toEqual(org);
    }
    // A candidate without an organisation stays without one.
    expect(addKpiDrafts(['okr.kpi:k-reach'], withOrg, empty(), emptyDrafts(), 'ja').drafts.kpis[0]).not.toHaveProperty('org');
  });

  it('measures an unlinked key result that restates an internal KPI by that KPI (PARAM-174)', () => {
    // Real packs restate KPIs as key results without kpiId, and list some KPIs twice.
    const real = {
      kpis: [...ext.kpis, { id: 'k-eng2', name: 'Annual Engagement Delivery', target: '50件以上', unit: '件', sourceIds: [] }, { id: 'k-acr', name: 'Influenced ACR', target: '20%', unit: '%', sourceIds: [] }],
      objectives: [{
        id: 'o-hub', objective: 'Deliver Hub Journeys', sourceIds: [],
        keyResults: [
          { text: 'Deliver and lead ≥50 engagements annually' },
          { text: 'FY27に顧客リーチを10倍へ拡大' },
          { text: 'Platform win 5件と ACR 20% を両立' },
          { text: 'Raise satisfaction by 20%' },
          { text: 'Agents at the core' },
        ],
      }],
    };
    const pre = addKpiDrafts(['okr.kpi:k-eng2'], real, empty(), emptyDrafts(), 'ja').drafts;
    const { drafts } = addOkrDrafts(['okr.obj:o-hub'], real, empty(), pre, 'ja');
    const linked = drafts.okrs[0]!.keyResults.map((kr) => drafts.kpis.find((k) => k.id === kr.kpiId)!.candidateId);
    expect(linked).toEqual([
      'okr.kpi:k-eng2', // twin of k-eng: the one already drafted is reused
      'okr.kpi:k-reach', // same number and a unit other than %
      'okr.kr:o-hub:2', // bundles two measures (5 and 20): not linked
      'okr.kr:o-hub:3', // only the number and % are shared
      'okr.kr:o-hub:4',
    ]);
    expect(drafts.kpis).toHaveLength(5);
    expect(addKpiDrafts(['okr.obj:o-hub', 'okr.kpi:k-reach'], real, empty(), emptyDrafts(), 'ja')).toMatchObject({ added: 5, skipped: 0 });
  });

  it('save-all keeps invalid drafts and discarding a KPI draft unlinks key results', () => {
    const { drafts } = addOkrDrafts(['okr.kpi:k-wins'], ext, empty(), emptyDrafts(), 'ja');
    const r = saveAllDrafts(empty(), drafts);
    expect(r.saved).toBe(0);
    expect(r.drafts).toEqual(drafts);
    const after = discardKpiDraft(drafts.kpis[0]!.id, drafts);
    expect(after.okrs[0]!.keyResults[0]!.kpiId).toBe('');
  });
});

describe('Copilot drafts (kpiOkrDraft)', () => {
  it('sends only open candidates with the mark', () => {
    const drafts = addKpiDrafts(['okr.kpi:k-reach'], ext, empty(), emptyDrafts(), 'ja').drafts;
    const p = kpiDraftPrompt(input({ drafts }));
    expect(p.startsWith('[bas-proj:kpiOkrDraft]')).toBe(true);
    expect(p).not.toContain('okr.kpi:k-reach');
    expect(p).toContain('okr.kpi:k-wins');
    expect(p).toContain('顧客接点の拡大');
    // Existing KPIs carry their targets so a twin with another name is recognizable (both models picked one 6/6 without).
    const data: KpiData = { kpis: [{ id: 'x', name: 'Engagements Led', unit: 'engagements', baseline: 0, current: 0, target: 50, deadline: '2027-06-30' }], okrs: [] };
    expect(kpiDraftPrompt(input({ data }))).toContain('Project にすでにある KPI（目標）: Engagements Led (50 engagements)');
  });

  describe('drafting missing definitions after pack creation', () => {
    const pack = { ...samplePack, entities: samplePack.entities.filter((e) => e.kind !== 'kpi') };
    const missingInput = (over: Partial<DraftPromptInput> = {}) => input({ ext: { kpis: [], objectives: [] }, ...over });
    const answer = () => ({
      kpis: [{ id: 'lead', name: '受注から出荷までの日数', unit: '日', reason: '出荷までの課題を測定する', evidenceIds: ['issue-lead-time'], target: 99, current: 50, deadline: '2099-01-01' }],
      okrs: [{ objective: '出荷までの流れを改善する', reason: '納期の課題に対応する', evidenceIds: ['issue-lead-time'], kpiIds: ['lead'] }],
    });

    it('uses the purpose and raw pack issues, not people, and leaves invented measurements blank', () => {
      const prompt = missingKpiDraftPrompt(missingInput(), pack);
      expect(prompt).toContain('Mode: proposeMissing');
      expect(prompt).toContain('顧客接点の拡大');
      expect(prompt).toContain('issue-lead-time');
      expect(prompt).not.toContain('person-sato-yui');
      const result = applyMissingKpiDraftResponse(JSON.stringify(answer()), missingInput(), pack);
      expect(result.drafts.kpis[0]).toMatchObject({
        name: '受注から出荷までの日数', unit: '日', baseline: '', current: '', target: '', deadline: '', origin: 'proposed',
        sourceIds: ['src-annual-report'], notes: ['noTarget', 'noCurrent', 'noDeadline'],
      });
      expect(result.drafts.okrs[0]!.keyResults[0]!.kpiId).toBe(result.drafts.kpis[0]!.id);
      expect(result.drafts.kpis[0]!.original.definition).toContain('受注から出荷までが長い');
      expect(saveAllDrafts(empty(), result.drafts).saved).toBe(0);
      const filled = { ...result.drafts, kpis: result.drafts.kpis.map((k) => ({ ...k, baseline: '5', current: '5', target: '3', deadline: '2027-03-31' })) };
      const saved = saveAllDrafts(empty(), filled);
      expect(saved.saved).toBe(2);
      expect(saved.data.kpis[0]!.origin).toBe('proposed');
      expect(saved.data.okrs[0]!.origin).toBe('proposed');
      expect(applyMissingKpiDraftResponse(JSON.stringify(answer()), missingInput({ data: saved.data }), pack).added).toBe(0);
      expect(applyMissingKpiDraftResponse(JSON.stringify(answer()), missingInput({ drafts: result.drafts }), pack).added).toBe(0);
    });

    it('fills only the missing side and reuses an existing KPI without changing it', () => {
      const existing = { id: 'saved', name: 'Delivery days', unit: 'days', baseline: 5, current: 4, target: 3, deadline: '2027-03-31' };
      const data = { kpis: [existing], okrs: [] };
      expect(missingKpiDrafts(missingInput({ data }))).toEqual({ kpis: false, okrs: true });
      const raw = answer();
      raw.okrs[0]!.kpiIds = ['saved'];
      const r = applyMissingKpiDraftResponse(JSON.stringify(raw), missingInput({ data }), pack);
      expect(r.drafts.kpis).toEqual([]);
      expect(r.drafts.okrs[0]!.keyResults[0]).toMatchObject({ kpiId: 'saved', text: 'Delivery days' });
      expect(data.kpis).toEqual([existing]);
      const onlyOkr = { kpis: [], okrs: [{ id: 'o', objective: 'Keep', keyResults: [] }] };
      expect(missingKpiDrafts(missingInput({ data: onlyOkr }))).toEqual({ kpis: true, okrs: false });
      const kpiOnly = applyMissingKpiDraftResponse(JSON.stringify(answer()), missingInput({ data: onlyOkr }), pack);
      expect(kpiOnly.drafts.kpis).toHaveLength(1);
      expect(kpiOnly.drafts.okrs).toEqual([]);
    });

    it('uses existing internal text KPI candidates when only the OKR is missing', () => {
      const i = missingInput({ ext: { kpis: ext.kpis, objectives: [] } });
      const raw = { kpis: [], okrs: [{ ...answer().okrs[0]!, kpiIds: ['okr.kpi:k-wins'] }] };
      expect(missingKpiDraftPrompt(i, pack)).toContain('okr.kpi:k-wins');
      const r = applyMissingKpiDraftResponse(JSON.stringify(raw), i, pack);
      expect(r.drafts.kpis[0]).toMatchObject({ candidateId: 'okr.kpi:k-wins', target: '5' });
      expect(r.drafts.kpis[0]!.origin).toBeUndefined();
      expect(r.drafts.okrs[0]!.keyResults[0]!.kpiId).toBe(r.drafts.kpis[0]!.id);
    });

    it('rejects malformed or fabricated references atomically, and exposes unsupported numbers', () => {
      for (const raw of ['{}', 'not json', JSON.stringify({ ...answer(), kpis: [{ ...answer().kpis[0], evidenceIds: ['fake'] }] }),
        JSON.stringify({ ...answer(), okrs: [{ ...answer().okrs[0], kpiIds: ['fake'] }] })]) {
        expect(() => applyMissingKpiDraftResponse(raw, missingInput(), pack)).toThrow();
      }
      const raw = answer();
      raw.kpis.push({ ...raw.kpis[0]! });
      expect(() => applyMissingKpiDraftResponse(JSON.stringify(raw), missingInput(), pack)).toThrow('Duplicate');
      const numeric = answer();
      numeric.kpis[0]!.reason = '300% の改善';
      expect(applyMissingKpiDraftResponse(JSON.stringify(numeric), missingInput(), pack).drafts.kpis[0]!.unverified).toContain('300');
      expect(missingInput().drafts).toEqual(emptyDrafts());
    });
  });

  it('drops unknown or duplicate ids, caps counts, and flags invented numbers', () => {
    const answer = '```json\n' + JSON.stringify({
      kpis: [
        { id: 'okr.kpi:k-wins', reason: '最低5件の実績が目的に直結' },
        { id: 'okr.kpi:k-wins', reason: 'dup' },
        { id: 'okr.kpi:nope', reason: 'x' },
        { id: 'okr.kpi:k-eng', reason: '売上 120% に効く' },
      ],
      okrs: [
        { id: 'okr.obj:o-growth', reason: '目的と同じ' },
        { kpiIds: ['okr.kpi:k-rate', 'okr.kpi:ghost'], objective: '採用を広げる', reason: '目的に合う' },
      ],
    }) + '\n```';
    const pick = parseKpiDraftResponse(answer, input());
    expect(pick.kpis.map((k) => k.candidateId)).toEqual(['okr.kpi:k-wins', 'okr.kpi:k-eng']);
    expect(pick.kpis[0]!.unverified).toEqual([]);
    expect(pick.kpis[1]!.unverified).toEqual(['120']);
    expect(pick.rejected).toEqual(['okr.kpi:k-wins', 'okr.kpi:nope', 'okr.kpi:ghost']);
    expect(pick.okrs[1]).toMatchObject({ kpiCandidateIds: ['okr.kpi:k-rate'], objective: '採用を広げる' });

    const many = { kpis: Array.from({ length: 9 }, (_, i) => ({ id: `okr.kpi:m${i}`, reason: '' })), okrs: [] };
    const bigExt = { kpis: many.kpis.map((k) => ({ id: k.id.slice(8), name: k.id, sourceIds: [] })), objectives: [] };
    expect(parseKpiDraftResponse(JSON.stringify(many), input({ ext: bigExt })).kpis).toHaveLength(MAX_AI_KPIS);
    expect(() => parseKpiDraftResponse('not json', input())).toThrow();
  });

  it('turns picks into Copilot drafts with the same mapping as the buttons', () => {
    const pick = parseKpiDraftResponse(JSON.stringify({
      kpis: [{ id: 'okr.kpi:k-wins', reason: 'r1' }],
      okrs: [{ id: 'okr.obj:o-growth', reason: 'r2' }, { kpiIds: ['okr.kpi:k-wins'], objective: '勝ち筋を増やす', reason: 'r3' }],
    }), input());
    const r = applyCopilotPick(pick, input());
    expect(r.added).toBe(3);
    expect(r.drafts.kpis.every((k) => k.by === 'copilot')).toBe(true);
    const wins = r.drafts.kpis.find((k) => k.candidateId === 'okr.kpi:k-wins')!;
    expect(wins).toMatchObject({ reason: 'r1', target: '5' });
    const composite = r.drafts.okrs.find((o) => o.candidateId === 'okr.set:okr.kpi:k-wins')!;
    expect(composite).toMatchObject({ objective: '勝ち筋を増やす', reason: 'r3' });
    expect(composite.keyResults[0]!.kpiId).toBe(wins.id);
    expect(applyCopilotPick(pick, input({ drafts: r.drafts })).added).toBe(0);
  });
});

describe('Decision pre-screen of the candidates (FR-325 / D-37)', () => {
  it('asks two yes/no questions per open candidate under opaque keys and passes validation', () => {
    const data: KpiData = { kpis: [{ id: 'x', name: 'Engagements Led', unit: 'engagements', baseline: 0, current: 0, target: 50, deadline: '2027-03-31' }], okrs: [] };
    const drafts = addKpiDrafts(['okr.kpi:k-rate'], ext, empty(), emptyDrafts(), 'ja').drafts;
    const plan = kpiScreenRequest(input({ data, drafts }))!;
    expect([...plan.keys.values()]).toEqual(['okr.kpi:k-reach', 'okr.kpi:k-wins', 'okr.kpi:k-eng', 'okr.obj:o-growth']);
    expect(Object.keys(plan.request.questions)).toEqual(['r_c1', 'd_c1', 'r_c2', 'd_c2', 'r_c3', 'd_c3', 'r_c4', 'd_c4']);
    expect(plan.request.state).toMatchObject({ projectPurpose: '顧客接点の拡大', existingKpis: ['Engagements Led (50 engagements)'] });
    expect(JSON.stringify(plan.request)).not.toContain('okr.kpi:');
    expect(validateDecisionRequest(plan.request)).not.toBeNull();
    expect(kpiScreenRequest(input({ purpose: ' ' }))).toBeNull();
  });

  it('drops duplicates and unrelated candidates, keeps the rest by relevance, and refuses partial answers', () => {
    const plan = kpiScreenRequest(input())!;
    const answers = { r_c1: 0.9, d_c1: 0.1, r_c2: 0.6, d_c2: 0.1, r_c3: 0.95, d_c3: 0.8, r_c4: 0.2, d_c4: 0.0, r_c5: 0.7, d_c5: 0.2 };
    const out = applyKpiScreen(ext, plan, answers)!;
    expect(out.ext.kpis.map((k) => k.id)).toEqual(['k-reach', 'k-wins']);
    expect(out.ext.objectives.map((o) => o.id)).toEqual(['o-growth']);
    expect(out.excluded).toEqual([
      { candidateId: 'okr.kpi:k-eng', why: 'duplicate', relevant: 0.95, duplicate: 0.8 },
      { candidateId: 'okr.kpi:k-rate', why: 'unrelated', relevant: 0.2, duplicate: 0 },
    ]);
    expect(out.kept).toBe(3);
    const filtered = parseKpiDraftResponse(JSON.stringify({ kpis: [{ id: 'okr.kpi:k-eng', reason: 'x' }], okrs: [] }), input({ ext: out.ext }));
    expect(filtered.kpis).toEqual([]);
    const { r_c2: _dropped, ...partial } = answers;
    expect(applyKpiScreen(ext, plan, partial)).toBeNull();
  });
});

describe('D-46: Copilot fills the fields the material leaves empty', () => {
  const adopted = () => addOkrDrafts(['okr.kpi:k-reach', 'okr.obj:o-growth'], ext, empty(), addKpiDrafts(['okr.kpi:k-rate'], ext, empty(), emptyDrafts(), 'ja').drafts, 'ja').drafts;
  const objectives = [{ id: 'OBJ-1', text: '顧客接点を増やす' }, { id: 'OBJ-2', text: '収益性の改善' }];
  const fillInput = (drafts = adopted()) => ({ purpose: '顧客接点の拡大', ext, drafts, objectives, lang: 'ja' as const, today: '2026-11-26' });

  it('asks only for the empty fields and the OKRs without a company objective', () => {
    const drafts = adopted();
    const prompt = kpiFillPrompt(fillInput(drafts))!;
    expect(prompt).toContain('Mode: fill');
    const data = JSON.parse(prompt.split('\n')[2]!);
    const reach = data.kpis.find((k: { name: string }) => k.name === 'Customer Reach');
    expect(reach.missing).toEqual(['baseline', 'current', 'deadline']);
    expect(reach.statedPeriod).toBe('FY27');
    // o-growth already names co-1; the OKR drafted from k-reach has none.
    expect(data.okrs).toHaveLength(1);
    expect(kpiFillTargets({ drafts, objectives: [] }).okrs).toHaveLength(0);
  });

  it('fills every empty field so the drafts can be saved, labels each estimate, and never overwrites stated values', () => {
    const drafts = adopted();
    const reach = drafts.kpis.find((d) => d.name === 'Customer Reach')!;
    const rate = drafts.kpis.find((d) => d.name === 'Adoption rate')!;
    const okr = drafts.okrs.find((o) => o.companyObjectiveIds.length === 0)!;
    const answer = JSON.stringify({
      kpis: [
        { id: reach.id, fields: { baseline: { value: '１', why: '未計測のため基準を 1 倍とした推定' }, current: { value: 1, why: '同上' }, deadline: { value: '2027-06-30', why: 'FY27 の期末' }, target: { value: '99', why: '上書きしてはいけない' } } },
        { id: rate.id, fields: { baseline: { value: '0', why: '推定' }, current: { value: '0', why: '推定' }, deadline: { value: 'FY27', why: '日付でない' } } },
        { id: 'unknown', fields: { target: { value: '1', why: 'x' } } },
      ],
      okrs: [{ id: okr.id, objectiveIds: ['OBJ-1', 'OBJ-9'], why: 'リーチ拡大は顧客接点の目標に貢献' }],
    });
    const r = applyKpiFill(answer, drafts, objectives);
    const filled = r.drafts.kpis.find((d) => d.id === reach.id)!;
    expect(filled).toMatchObject({ target: '10', baseline: '1', current: '1', deadline: '2027-06-30' });
    expect(filled.estimated).toEqual({ baseline: '未計測のため基準を 1 倍とした推定', current: '同上', deadline: 'FY27 の期末' });
    expect(filled.notes).not.toContain('noDeadline');
    expect(r.drafts.kpis.find((d) => d.id === rate.id)!.deadline).toBe('');
    expect(r).toMatchObject({ fields: 5, okrs: 1 });
    expect(r.remaining).toBe(r.drafts.kpis.reduce((n, d) => n + emptyKpiFields(d).length, 0));
    expect(emptyKpiFields(r.drafts.kpis.find((d) => d.id === rate.id)!)).toEqual(['deadline']);
    expect(r.drafts.okrs.find((o) => o.id === okr.id)).toMatchObject({ companyObjectiveIds: ['OBJ-1'], objectiveEstimate: 'リーチ拡大は顧客接点の目標に貢献' });
    // The OKR drafts link to the reach KPI draft; with every field filled it saves, the rate draft still blocks.
    const saved = saveAllDrafts(empty(), r.drafts);
    expect(saved.data.kpis.some((k) => k.name === 'Customer Reach' && k.deadline === '2027-06-30')).toBe(true);
    expect(saved.errors.some((e) => e.draftId === rate.id)).toBe(true);
  });

  it('rejects an answer that is not the requested JSON', () => {
    expect(() => applyKpiFill('not json', adopted(), objectives)).toThrow();
  });

  it('has nothing to ask once every draft is complete', () => {
    const drafts = adopted();
    const done = { kpis: drafts.kpis.map((d) => ({ ...d, unit: d.unit || '%', baseline: '0', current: '0', target: d.target || '1', deadline: '2027-06-30' })), okrs: drafts.okrs.map((o) => ({ ...o, companyObjectiveIds: ['OBJ-1'] })) };
    expect(kpiFillPrompt(fillInput(done))).toBeNull();
  });

  it('sets every field Copilot left empty by rule, marks it provisional, and lets the next fill replace it', () => {
    const drafts = adopted();
    const rate = drafts.kpis.find((d) => d.name === 'Adoption rate')!;
    const noName = { ...rate, id: 'kpi-x', candidateId: 'okr.kpi:x', name: '', unit: '', target: '', original: { definition: '新規顧客の獲得数', period: '2027年3月' } };
    const typed = { ...rate, id: 'kpi-y', candidateId: 'okr.kpi:y', current: 'abc' };
    const r = provisionalFill({ ...drafts, kpis: [...drafts.kpis, noName, typed] }, ext, 'ja', '2026-11-26');
    for (const d of r.drafts.kpis) expect(emptyKpiFields(d)).toEqual([]);
    const filledRate = r.drafts.kpis.find((d) => d.id === rate.id)!;
    // "20〜30%" states 20 % in the material; nothing states a baseline, current value or a date.
    expect(filledRate).toMatchObject({ unit: '%', target: '20', baseline: '0', current: '0', deadline: '2027-11-26' });
    expect(filledRate.provisional).toEqual({ baseline: 'baselineZero', current: 'currentBaseline', deadline: 'deadlineYear' });
    expect(filledRate.notes).not.toContain('noDeadline');
    expect(r.drafts.kpis.find((d) => d.id === 'kpi-x')).toMatchObject({
      name: '新規顧客の獲得数', unit: '件', target: '0', deadline: '2027-03-31',
      provisional: { name: 'nameDefinition', unit: 'unitDefault', target: 'targetBaseline', deadline: 'deadlinePeriod' },
    });
    // A value the user typed stays, even when invalid.
    expect(r.drafts.kpis.find((d) => d.id === 'kpi-y')!.current).toBe('abc');
    expect(saveAllDrafts(empty(), { kpis: r.drafts.kpis.filter((d) => d.id !== 'kpi-y'), okrs: [] }).errors).toEqual([]);

    const again = JSON.parse(kpiFillPrompt(fillInput(r.drafts))!.split('\n')[2]!);
    const asked = again.kpis.find((k: { id: string }) => k.id === rate.id);
    expect(asked).toMatchObject({ missing: ['baseline', 'current', 'deadline'], baseline: '', deadline: '' });
    const replaced = applyKpiFill(JSON.stringify({ kpis: [{ id: rate.id, fields: { deadline: { value: '2027-06-30', why: 'FY27 の期末' }, target: { value: '99', why: '上書き不可' } } }] }), r.drafts, objectives);
    const next = replaced.drafts.kpis.find((d) => d.id === rate.id)!;
    expect(next).toMatchObject({ deadline: '2027-06-30', target: '20', estimated: { deadline: 'FY27 の期末' }, provisional: { baseline: 'baselineZero', current: 'currentBaseline' } });
  });

  it.each([
    ['2026/6/30', '2026-06-30'], ['2027年3月', '2027-03-31'], ['2026-02', '2026-02-28'], ['FY27', ''], ['2026-13-01', ''], [undefined, ''],
  ])('periodDate(%s) = %s', (text, date) => {
    expect(periodDate(text)).toBe(date);
  });
});
