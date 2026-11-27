import { afterEach, describe, expect, it } from 'vitest';
import type { LoopAnswer } from '../src/ai/agentLoop.ts';
import { setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';
import { loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import type { CustomerPack } from '../src/data/schema.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import {
  emptyDeliverables, normalizeDeliverables, setDelayEstimate, setFraming, setSituation, type AppCheckContext, type DeliverableData,
} from '../src/modules/project/deliverables.ts';
import {
  allParts, approveDiagnosis, diagnosisContext, diagnosisEvidence, diagnosisMockAnswer, diagnosisPrompt, diagnosisRules, draftDiagnosis,
  framingWarnings, requestDiagnosis, ruleDiagnosis, verifyDiagnosis,
} from '../src/modules/project/issueDiagnosis.ts';
import { projectTriage } from '../src/modules/project/issueTriage.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';

function context(data: CustomerPack = samplePack, deliverables: DeliverableData = emptyDeliverables()): AppCheckContext {
  const pack = loadPack(data);
  return {
    pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(),
    deliverables, strategy: emptyStrategy(), objectives: [], projectObjectiveIds: [], today: '2026-11-09',
  };
}
/** The sample with one cause shared by the lead-time and quality issues. */
const shared: CustomerPack = {
  ...samplePack,
  entities: samplePack.entities.map((e) => (e.kind === 'issue' && e.id === 'issue-quality' ? { ...e, causeIds: [...e.causeIds, 'cause-manual-scheduling'] } : e)),
};
const answer = (text: string): LoopAnswer => ({ text, inputTokens: 10, outputTokens: 10 });
const framing = (q = '今期にどの原因から手を打つか？') => ({ question: q, owner: '生産本部長', hypothesis: '計画の手作業が真因', falsifier: 'リードタイムが縮まない', frame: 'threat', control: 'partial', reason: '損失が続く' });

afterEach(() => {
  setLiveTransport(null);
  setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
  writeLedger([]);
});

describe('FR-385 the data a person judges', () => {
  it('lists every candidate issue with its data, KPI trends, the SWOT position and causes shared by two or more issues', () => {
    const plain = diagnosisEvidence(context());
    expect(plain.issues.map((i) => i.id)).toEqual(projectTriage(context()).action);
    expect(plain.trendCounts.improving).toBeGreaterThan(0);
    expect(plain.trendCounts.worsening).toBe(0);
    expect(plain.shared).toEqual([]);
    const ev = diagnosisEvidence(context(shared));
    expect(ev.shared).toEqual([expect.objectContaining({ causeId: 'cause-manual-scheduling', issueIds: ['issue-lead-time', 'issue-quality'], impactSum: 9, sourced: expect.any(Boolean) })]);
  });

  it('sends no personal name to Copilot', () => {
    const json = JSON.stringify(diagnosisContext(context(), 'ja'));
    for (const p of samplePack.entities.filter((e) => e.kind === 'person')) {
      expect(json).not.toContain(p.name.ja);
      expect(json).not.toContain(p.name.en);
    }
  });

  it('flags judgments that contradict the data', () => {
    const i = { feasibility: 5, growth: 'worsening' as const, provisional: true };
    expect(framingWarnings({ frame: 'opportunity', control: 'none' }, i)).toEqual(['controlVsFeasibility', 'opportunityWorsening', 'provisionalRating']);
    expect(framingWarnings({ frame: 'threat', control: 'full' }, { feasibility: 5, growth: 'improving', provisional: false })).toEqual([]);
  });
});

describe('FR-385 checking Copilot\'s answer', () => {
  const ctx = context(shared);
  const c = diagnosisContext(ctx, 'ja');
  const rules = diagnosisRules(ctx, c);
  const person = samplePack.entities.find((e) => e.kind === 'person')!;

  it('accepts only complete, valid parts', () => {
    const text = JSON.stringify({
      situation: { type: 'realignment', reason: 'KPI は改善中だが即応はない' },
      crux: { causeId: 'cause-unknown', name: '手作業の計画', issueIds: ['issue-lead-time', 'issue-ghost'], reason: '2 件に効く', addressable: '自部門で変えられる' },
      issues: {
        'issue-lead-time': framing(),
        'issue-quality': framing('原因は何か'), // no question mark
        'issue-cash': { ...framing(), owner: `${person.name.ja} 部長` }, // a personal name
        'issue-energy': { ...framing(), frame: 'risk' }, // not a frame
      },
    });
    const v = verifyDiagnosis(text, ['situation', 'crux', 'issue:issue-lead-time', 'issue:issue-quality', 'issue:issue-cash', 'issue:issue-energy'], rules);
    expect(Object.keys(v).sort()).toEqual(['crux', 'issue:issue-lead-time', 'situation']);
    // An unknown cause becomes a hypothesis; an unknown issue is dropped.
    expect(v.crux).toEqual(expect.objectContaining({ issueIds: ['issue-lead-time'], origin: 'ai' }));
    expect(v.crux).not.toHaveProperty('causeId');
    expect(verifyDiagnosis('not json', ['situation'], rules)).toEqual({});
    expect(verifyDiagnosis('```json\n{"situation":{"type":"turnaround","reason":"r"}}\n```', ['situation'], rules).situation).toMatchObject({ type: 'turnaround' });
  });

  it('asks again only for the parts left out, and completes from Copilot', async () => {
    const prompts: string[] = [];
    const full = JSON.parse(diagnosisMockAnswer(diagnosisPrompt(c))) as { issues: Record<string, unknown> };
    const run = await draftDiagnosis(c, rules, async (prompt, round) => {
      prompts.push(prompt);
      if (round === 1) {
        const { 'issue-skills': _left, ...issues } = full.issues;
        return answer(JSON.stringify({ ...full, issues, crux: {} }));
      }
      return answer(JSON.stringify({ crux: { causeId: 'cause-manual-scheduling', name: 'n', issueIds: ['issue-quality'], reason: 'r', addressable: 'a' }, issues: { 'issue-skills': framing() } }));
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('REPAIR');
    expect(prompts[1]).toContain('crux, issue:issue-skills');
    expect(run).toMatchObject({ stop: 'complete', rounds: 2, placeholders: [], mock: false });
    expect(run.crux).toMatchObject({ causeId: 'cause-manual-scheduling', origin: 'ai' });
    expect(run.issues['issue-skills']).toMatchObject({ owner: '生産本部長', origin: 'ai' });
    expect(Object.keys(run.issues).sort()).toEqual(c.issues.map((i) => i.id).sort());
  });

  it('never leaves a part open: what Copilot does not fill becomes a labelled BAS placeholder', async () => {
    const run = await draftDiagnosis(c, rules, async () => answer(JSON.stringify({ situation: { type: 'turnaround', reason: '悪化' } })));
    expect(run.situation).toMatchObject({ type: 'turnaround', origin: 'ai' });
    expect(run.stop).toBe('stalled');
    expect(run.placeholders).toEqual(['crux', ...c.issues.map((i) => `issue:${i.id}`)]);
    expect(run.crux).toMatchObject({ causeId: 'cause-manual-scheduling', origin: 'rule' });
    for (const i of c.issues) {
      expect(run.issues[i.id]).toMatchObject({ origin: 'rule' });
      expect(run.issues[i.id]!.question).toMatch(/？$/);
    }
  });

  it('without a live connection the panel gets the labelled mock, marked as placeholders', async () => {
    const run = await requestDiagnosis(c, rules);
    expect(run.mock).toBe(true);
    expect(run.situation.origin).toBe('rule');
    expect(Object.values(run.issues).every((f) => f.origin === 'rule')).toBe(true);
  });

  it('a live answer goes through the relay transport and is not a mock', async () => {
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    const calls: string[] = [];
    setLiveTransport(async (call) => { calls.push(call.prompt); return { text: diagnosisMockAnswer(call.prompt), inputTokens: 1, outputTokens: 1 }; });
    const run = await requestDiagnosis(c, rules);
    expect(calls).toHaveLength(1);
    expect(run).toMatchObject({ mock: false, placeholders: [] });
    expect(run.situation.origin).toBe('ai');
  });
});

describe('FR-385 approval and its effect on the triage', () => {
  const ctx = context(shared);
  const c = diagnosisContext(ctx, 'ja');
  const draft = ruleDiagnosis(c);
  const meta = { by: 'E2E', at: '2026-11-27T00:00:00Z' };

  it('approving all writes every part; a person\'s own judgment is kept unless approved one by one', () => {
    const own = setFraming(emptyDeliverables(), 'issue-cash', { ...framing('人が書いた問い？'), frame: 'threat', control: 'full', origin: 'human', ...meta });
    const all = approveDiagnosis(own, draft, allParts(draft), meta);
    expect(all.situation).toMatchObject({ type: draft.situation.type, origin: 'rule' });
    expect(all.crux).toMatchObject({ causeId: 'cause-manual-scheduling' });
    expect(Object.keys(all.framings!).sort()).toEqual(c.issues.map((i) => i.id).sort());
    expect(all.framings!['issue-cash']!.question).toBe('人が書いた問い？');
    const forced = approveDiagnosis(all, draft, ['issue:issue-cash'], meta, true);
    expect(forced.framings!['issue-cash']!.origin).toBe('rule');
    // Stored values are read back defensively.
    expect(normalizeDeliverables(JSON.parse(JSON.stringify(all))).framings).toEqual(all.framings);
    expect(normalizeDeliverables({ ...all, framings: { 'issue-x': { question: 'no mark' } } }).framings).toEqual({});
  });

  it('the confirmed situation sets the planning cycle: a turnaround sends a 6-month slack to monitoring, pressing stays pressing', () => {
    const est = (impact: number, response: number) => ({ impactMonths: { low: impact, mode: impact, high: impact }, durationMonths: { low: response, mode: response, high: response }, note: 'n', at: meta.at, by: meta.by });
    const base = setDelayEstimate(setDelayEstimate(emptyDeliverables(), 'issue-lead-time', est(18, 12)), 'issue-quality', est(2, 6));
    const annual = projectTriage(context(samplePack, base));
    expect(annual.cycle).toBe(12);
    expect(annual.issues.find((i) => i.id === 'issue-lead-time')).toMatchObject({ urgency: 'significant', disposition: 'plan' });
    const turnaround = projectTriage(context(samplePack, setSituation(base, { type: 'turnaround', reason: 'r', origin: 'human', ...meta })));
    expect(turnaround.cycle).toBe(3);
    expect(turnaround.issues.find((i) => i.id === 'issue-lead-time')).toMatchObject({ urgency: 'low', disposition: 'monitor' });
    expect(turnaround.issues.find((i) => i.id === 'issue-quality')).toMatchObject({ urgency: 'pressing', disposition: 'act' });
  });

  it('the confirmed crux moves its issues first within their disposition', () => {
    const before = projectTriage(context(samplePack)).action;
    expect(before.at(-1)).toBe('issue-skills');
    const data = approveDiagnosis(emptyDeliverables(), { ...draft, crux: { name: '暗黙知', issueIds: ['issue-skills'], reason: 'r', addressable: 'a', origin: 'ai' } }, ['crux'], meta);
    const after = projectTriage(context(samplePack, data));
    expect(after.action[0]).toBe('issue-skills');
    expect(after.issues[0]).toMatchObject({ id: 'issue-skills', crux: true });
  });
});
