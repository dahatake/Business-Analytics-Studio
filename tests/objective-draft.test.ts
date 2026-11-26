import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';
import { CompanyAnchorVersionSchema } from '../src/data/companyAnchor.ts';
import { loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import * as relayClient from '../src/modules/ai/relayClient.ts';
import type { WorkIqSectionInfo } from '../src/modules/ai/relayClient.ts';
import {
  applyObjectives, classifyObjectives, objectiveAspects, objectiveEvidence, objectivePrompt, OBJECTIVE_DRAFT_MARK, PROVISIONAL_HORIZON, runObjectiveDraft, type ObjectiveDraftInput, type ObjectiveSearch,
} from '../src/modules/project/objectiveDraft.ts';

const PLAN = '中期経営計画2027: 2027年度までにエンゲージメント実施件数を年間300件に拡大する。顧客にAIとCopilotの真の価値を伝える。';
const section = (patch: Partial<Extract<WorkIqSectionInfo, { answer: string }>> = {}): WorkIqSectionInfo => ({
  key: 'objectivesUnit', question: 'Microsoft Innovation Hubの事業目標・年度目標・重点施策は何ですか?', answer: PLAN,
  citations: [{ title: 'FY27 Hub Plan.pptx', url: 'https://contoso.sharepoint.com/sites/hub/FY27.pptx' }],
  sensitivity: null, fetchedAt: '2026-11-25T03:00:00.000Z', ...patch,
});
const input = (patch: Partial<ObjectiveDraftInput> = {}): ObjectiveDraftInput => ({
  companyName: 'Microsoft', unit: 'Microsoft Innovation Hub', projectName: 'Hub FY27', purpose: 'Microsoft Innovation Hubが、大量に高品質なEngagementを実行できるようにしたい。',
  focus: '', lang: 'ja', today: '2026-11-25', pack: loadPack(samplePack).pack, workiq: [section()], saved: [], ...patch,
});
const answer = (objectives: unknown[]) => JSON.stringify({ objectives });
const classify = (objectives: unknown[], i = input()) => classifyObjectives(answer(objectives), i, objectiveEvidence(i));

describe('FR-367 business objectives from Work IQ, OKRs and sources', () => {
  it('sends the marker, the organisation and the evidence refs, and searches the unit only when it is known', () => {
    const prompt = objectivePrompt(input());
    expect(prompt.split('\n')[0]).toBe(OBJECTIVE_DRAFT_MARK);
    expect(prompt).toContain('"ref":"wiq:objectivesUnit"');
    expect(prompt).toContain('"ref":"purpose"');
    expect(objectiveAspects('Microsoft Innovation Hub')).toEqual(['objectivesCompany', 'objectivesUnit']);
    expect(objectiveAspects('')).toEqual(['objectivesCompany']);
    const wiq = objectiveEvidence(input()).find((e) => e.ref === 'wiq:objectivesUnit')!;
    expect(wiq).toMatchObject({ quotable: true, public: false, url: 'https://contoso.sharepoint.com/sites/hub/FY27.pptx', accessedDate: '2026-11-25' });
    expect(wiq.locator).toContain('FY27 Hub Plan.pptx');
  });

  describe('objective search progress and notices', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      setLiveTransport(null);
      setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
      writeLedger([]);
    });

    it.each([
      {
        label: 'partial failure and excluded sources',
        sections: [section({ withheld: 2 }), { key: 'objectivesCompany', error: 'workiqUnavailable' }],
        expected: { workIqAnswers: 1, workIqFailedSections: 1, workIqWithheld: 2, workIqError: null },
      },
      {
        label: 'an empty answer and an excluded section',
        sections: [section({ answer: '   ' }), { key: 'objectivesCompany', error: 'confidentialNotAllowed' }],
        expected: { workIqAnswers: 0, workIqFailedSections: 0, workIqWithheld: 1, workIqError: null },
      },
      {
        label: 'a complete failure',
        sections: [{ key: 'objectivesCompany', error: 'workiqUnavailable' }],
        expected: { workIqAnswers: 0, workIqFailedSections: 1, workIqWithheld: 0, workIqError: 'workiqUnavailable' },
      },
    ])('reports $label without mistaking it for a complete search', async ({ sections, expected }) => {
      vi.spyOn(relayClient, 'askWorkIqSections').mockResolvedValue(sections);
      setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
      setLiveTransport(async () => ({ text: answer([]), inputTokens: 10, outputTokens: 10 }));
      const { workiq: _workiq, ...draft } = input();
      const progress: { phase: string; search?: ObjectiveSearch }[] = [];
      const result = await runObjectiveDraft(draft, {
        companyId: 'company', companyName: draft.companyName, unit: draft.unit, projectName: draft.projectName,
        purpose: draft.purpose, focus: draft.focus,
      }, 'project', { provider: 'foundry' }, undefined, (phase, search) => progress.push({ phase, search }));
      expect(progress.map((entry) => entry.phase)).toEqual(['workiq', 'generate']);
      expect(progress[1]?.search).toMatchObject({ workIqUsed: true, ...expected });
      expect(result).toMatchObject({ workIqUsed: true, ...expected });
    });
  });

  it('registers an objective stated word for word as it is, with its Microsoft 365 source', () => {
    const [stated] = classify([{
      tier: 'stated', text: 'エンゲージメント実施件数を年間300件に拡大する', horizon: '2027年度', scope: 'department', scopeName: '',
      evidence: [{ ref: 'wiq:objectivesUnit', excerpt: '2027年度までにエンゲージメント実施件数を年間300件に拡大する' }], reason: '',
    }]);
    expect(stated).toMatchObject({ tier: 'stated', downgraded: false, basis: 'customerStated', scopeName: 'Microsoft Innovation Hub' });
    const applied = applyObjectives([stated!], null, 'Microsoft', '2026-11-25', 'ja');
    expect(applied.registered).toHaveLength(1);
    expect(applied.drafts).toEqual([]);
    expect(applied.anchor?.statedObjectives[0]).toMatchObject({ text: 'エンゲージメント実施件数を年間300件に拡大する', horizon: '2027年度', basis: 'customerStated', scope: 'department' });
    expect(applied.anchor?.sources[0]).toMatchObject({ type: 'internal', url: 'https://contoso.sharepoint.com/sites/hub/FY27.pptx', accessedDate: '2026-11-25' });
    expect(CompanyAnchorVersionSchema.safeParse({ version: 1, savedAt: '2026-11-25T00:00:00.000Z', anchor: applied.anchor }).success).toBe(true);
  });

  it('keeps a paraphrase, a missing horizon or an unsupported number as an unclear draft with the reason', () => {
    const [paraphrase, noHorizon, number] = classify([
      { tier: 'stated', text: 'Hubの活動を大幅に増やす', horizon: '2027年度', evidence: [{ ref: 'wiq:objectivesUnit', excerpt: 'Hubの活動を大幅に増やす' }] },
      { tier: 'stated', text: '顧客にAIとCopilotの真の価値を伝える', horizon: '', evidence: [{ ref: 'wiq:objectivesUnit', excerpt: '顧客にAIとCopilotの真の価値を伝える' }] },
      { tier: 'stated', text: 'エンゲージメント実施件数を年間500件に拡大する', horizon: '2027年度', evidence: [{ ref: 'wiq:objectivesUnit', excerpt: '2027年度までにエンゲージメント実施件数を年間300件に拡大する' }] },
    ]);
    expect(paraphrase).toMatchObject({ tier: 'unclear', downgraded: true });
    expect(paraphrase!.reason).toContain('原文と一致しません');
    expect(noHorizon!.reason).toContain('期間');
    expect(number).toMatchObject({ tier: 'unclear', unverified: ['500'] });
    const applied = applyObjectives([paraphrase!, noHorizon!, number!], null, 'Microsoft', '2026-11-25', 'ja');
    expect(applied.anchor).toBeNull();
    expect(applied.drafts.map((d) => d.tier)).toEqual(['unclear', 'unclear', 'unclear']);
    // The draft keeps the evidence it cited, so saving it later still has a traceable source.
    expect(applied.drafts[0]!.source).toMatchObject({ type: 'internal', url: 'https://contoso.sharepoint.com/sites/hub/FY27.pptx' });
  });

  it('drafts an objective from related data when nothing states one, and never cites the project purpose as stated', () => {
    const none = input({ workiq: [{ key: 'objectivesCompany', error: 'workiqUnavailable' }] });
    const [drafted, fromPurpose] = classify([
      { tier: 'drafted', text: '少人数で高品質なEngagementを大量に提供できる運営モデルを確立する', evidence: [{ ref: 'purpose', excerpt: '' }], reason: '目的から作成' },
      { tier: 'stated', text: 'Microsoft Innovation Hubが、大量に高品質なEngagementを実行できるようにしたい', horizon: 'FY27', evidence: [{ ref: 'purpose', excerpt: 'Microsoft Innovation Hubが、大量に高品質なEngagementを実行できるようにしたい' }] },
    ], none);
    expect(drafted).toMatchObject({ tier: 'drafted', horizon: PROVISIONAL_HORIZON.ja, basis: 'customerStated' });
    expect(drafted!.reason).toContain('BAS が仮置き'); // D-49: no draft is left without a horizon
    expect(drafted!.source.locator).toBe('BAS Project: Hub FY27');
    expect(fromPurpose).toMatchObject({ tier: 'unclear', downgraded: true });
    expect(objectiveEvidence(none).some((e) => e.kind === 'workiq')).toBe(false);
  });

  it('drops unknown refs and skips objectives already saved or repeated', () => {
    const i = input({ saved: [{ id: 'OBJ-1', text: '顧客にAIとCopilotの真の価値を伝える' }] });
    const out = classify([
      { tier: 'drafted', text: '顧客にAI と Copilot の真の価値を伝える。', evidence: [] },
      { tier: 'unclear', text: 'Hubらじおの視聴者を増やす', evidence: [{ ref: 'made-up', excerpt: 'x' }] },
      { tier: 'unclear', text: 'Hubらじおの視聴者を増やす', evidence: [] },
    ], i);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual([]);
  });

  it('replaces an older draft of the same objective and drops drafts that are now saved', () => {
    const [first] = classify([{ tier: 'drafted', text: 'Hubらじおの視聴者を増やす', evidence: [] }]);
    const earlier = applyObjectives([first!], null, 'Microsoft', '2026-11-25', 'ja').drafts;
    const again = applyObjectives([first!], null, 'Microsoft', '2026-11-26', 'ja', earlier);
    expect(again.drafts).toHaveLength(1);
    expect(again.added).toBe(1);
    expect(again.drafts[0]!.id).not.toBe(earlier[0]!.id);
  });
});
