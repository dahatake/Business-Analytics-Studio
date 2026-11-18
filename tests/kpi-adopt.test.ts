import { describe, expect, it } from 'vitest';
import {
  addKpiDrafts, addOkrDrafts, applyCopilotPick, discardKpiDraft, emptyDrafts, kpiAdoptState, kpiDraftPrompt, okrAdoptState,
  parseKpiDraftResponse, parseTarget, saveAllDrafts, saveKpiDraft, saveOkrDraft, MAX_AI_KPIS, type DraftPromptInput,
} from '../src/modules/project/kpiAdopt.ts';
import type { KpiData } from '../src/modules/project/model.ts';

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
