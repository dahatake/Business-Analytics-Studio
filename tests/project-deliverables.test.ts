import { afterEach, describe, expect, it, vi } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { translate, type MessageKey } from '../src/i18n/core.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../src/state/projects.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import {
  applyDraft, approveField, cyclicInitiatives, emptyDeliverables, evaluateStep, fieldHintKey, fieldKey, inputKey, nextTodo, normalizeDeliverables, openFirst, PAYBACK_MAX_YEARS, paybackLimit,
  paybackYears, progressOf, rankedIssues, resultKey, setField, setPaybackLimit, setQualification, setSignOff, statedValues, STEP_DEFS, todoKey, todoWhyKey, valueMismatches,
  type CheckContext, type DeliverableData,
} from '../src/modules/project/deliverables.ts';
import type { EntityOf } from '../src/data/schema.ts';
import { setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';
import { BAND_LIST_HEIGHT_GUESS, shouldAutoExpand, todoHref } from '../src/modules/project/deliverablesUi.tsx';
import { parseHash } from '../src/state/router.ts';
import { buildDraft, buildTaskDrafts, draftEntities, draftPrompt, draftRequest, draftToText, parseDraftText, parseTaskDrafts, requestDeliverableDraft } from '../src/modules/project/deliverableDraft.ts';
import { emptyStrategy, setSection, setSolutionType, strategyThread, upsertContribution, type StrategyData } from '../src/modules/project/strategy.ts';
import { buildSolutionDoc } from '../src/modules/project/solutionDocs.ts';
import { simulateTaskImpact } from '../src/modules/project/taskImpact.ts';
import { stepDashboard } from '../src/modules/project/stepDashboard.ts';
import { humanDescription, parseResolution, previewResolution, repairDescription, repairOptions, requestResolution, resolutionRequest, suggestOwner, unsupportedNumbers, valueBasis, type EntityDraft, type RepairOption, type ResolutionInput } from '../src/modules/project/taskResolution.ts';

const TODAY = '2026-11-09';
const clone = () => JSON.parse(JSON.stringify(samplePack)) as typeof samplePack;
const pack = loadPack(samplePack);

const demoCtx = (over: Partial<CheckContext> = {}): CheckContext => ({
  pack,
  discussion: demoDiscussion(),
  kpi: demoKpis(pack.pack),
  analysis: demoAnalyses(pack.pack),
  useCases: demoUseCases(),
  deliverables: emptyDeliverables(),
  today: TODAY,
  ...over,
});

const emptyProjectCtx = (): CheckContext => ({
  pack,
  discussion: { themes: [], records: [] },
  kpi: { kpis: [], okrs: [] },
  analysis: { analyses: [], activeId: null },
  useCases: [],
  deliverables: emptyDeliverables(),
  today: TODAY,
});

const byId = (step: ImprovementStep, c: CheckContext) => Object.fromEntries(evaluateStep(step, c).map((r) => [r.todo.id, r]));

/** Every step drafted (as the "Draft with Copilot" mock would) and applied. */
function drafted(c: CheckContext, lang: 'ja' | 'en' = 'ja', audience: 'internal' | 'external' = 'internal'): DeliverableData {
  let data = c.deliverables;
  for (const step of IMPROVEMENT_STEPS) {
    data = applyDraft(data, step, buildDraft({ step, ctx: c, lang, audience }), { overwrite: false, mock: true, at: '2026-11-09T09:00:00Z' }).data;
  }
  return data;
}

const OBJECTIVE = { id: 'obj-mtp-1', text: '中期経営計画: 2027 年度までに納期遵守率 98 %' };

/** The person qualifies every issue of the pack (FR-347). */
function qualifyAll(data: DeliverableData, c: CheckContext, verdict: 'pursue' | 'notNow' | 'no' = 'pursue'): DeliverableData {
  for (const i of c.pack.pack.entities.filter((e) => e.kind === 'issue')) {
    data = setQualification(data, i.id, { verdict, reason: `${i.id}: measured by its KPI; the gap is worth acting on`, ...(verdict === 'pursue' ? { different: 'Budget is now approved' } : {}), at: '2026-11-09T10:00:00Z', by: 'Tester' });
  }
  return data;
}

it('passes applied upstream text to the next step draft without leaking it to the external request', () => {
  const ctx = demoCtx();
  ctx.deliverables = setField(ctx.deliverables, 'asis', 'problem', { text: 'INTERNAL-UPSTREAM-HYPOTHESIS', author: 'ai', mock: true, updatedAt: 'now' });
  ctx.deliverables = setField(ctx.deliverables, 'solution', 'options', { text: 'FUTURE-STEP-TEXT', author: 'human', updatedAt: 'now' });
  const input = { step: 'tobe' as const, ctx, lang: 'en' as const, audience: 'internal' as const };
  const prompt = draftPrompt(input);
  expect(prompt).toContain('"problem":{"text":"INTERNAL-UPSTREAM-HYPOTHESIS","author":"ai","mock":true}');
  expect(prompt).not.toContain('FUTURE-STEP-TEXT');
  expect(prompt).toContain('not independently verified evidence');
  expect(draftPrompt({ ...input, audience: 'external' })).not.toContain('INTERNAL-UPSTREAM-HYPOTHESIS');
  expect(draftPrompt({ ...input, step: 'asis' })).not.toContain('INTERNAL-UPSTREAM-HYPOTHESIS');
});

describe('Copilot task repairs', () => {
  afterEach(() => {
    setLiveTransport(null);
    setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
    writeLedger([]);
  });
  const missingLinks = (): ResolutionInput => {
    const raw = clone();
    raw.entities = raw.entities.map((e) => e.kind === 'issue' ? { ...e, kpiIds: [] } : e);
    return { step: 'asis', todoId: 'define-kpi-link', ctx: demoCtx({ pack: loadPack(raw) }), lang: 'ja', audience: 'internal' };
  };
  const links = (options: RepairOption[]) => options.filter((o) => o.kind === 'link');
  const creates = (options: RepairOption[]) => options.filter((o) => o.kind === 'create');
  const proposal = (optionIds: string[]) => ({ optionIds });
  const choice = (id: string, optionIds: string[], extra: object = {}) => ({ id, label: `Choice ${id}`, optionIds, rationale: 'Grounded in the supplied sources.', ...extra });
  const response = (choices: object[], extra: object = {}) => ({ choices, recommendedId: 'a', reasoning: 'A is better than B because it is fully sourced.', missingInformation: [], ...extra });
  const kpiDraft: EntityDraft = {
    name: { ja: '所要日数', en: 'Days required' }, description: { ja: '出典の課題を測る指標', en: 'Measures the sourced issue' },
    unit: { ja: '日', en: 'days' }, period: { ja: '月次', en: 'Monthly' }, direction: 'decrease', scale: 'ratio',
  };
  const causeDraft: EntityDraft = { name: { ja: '工程間の待ち', en: 'Waiting between processes' }, description: { ja: '出典に基づく原因の仮説', en: 'Cause hypothesis from the source' } };

  it('repairs all missing KPI relationships without changing observations, sign-offs or unrelated fields', () => {
    const input = missingLinks();
    const options = links(repairOptions(input));
    expect(options.length).toBeGreaterThan(0);
    const preview = previewResolution(input, proposal(options.map((o) => o.id)), options, '2026-11-16T00:00:00Z');
    expect(preview.result!.done).toBe(true);
    expect(resolutionRequest(input, options).use).toBe('deliverableDraft');
    const entities = preview.changes.flatMap((change) => change.op === 'upsert' ? [change.entity] : []);
    expect(entities).toHaveLength(5);
    for (const entity of entities) {
      expect(entity.kind).toBe('issue');
      const original = input.ctx.pack.byId.get(entity.id)!;
      expect({ ...entity, kpiIds: [] }).toEqual(original);
    }
    expect(preview.deliverables).toBe(input.ctx.deliverables);
    expect(byId('asis', input.ctx)['define-kpi-link']!.done).toBe(false);
  });

  it('rejects invented, duplicate, data-less and tampered edits, and does not claim a partial repair is resolved', () => {
    const input = missingLinks();
    const options = repairOptions(input);
    const [first, second] = links(options).map((o) => o.id) as [string, string];
    const parse = (value: object) => parseResolution(JSON.stringify(value), options);
    expect(() => parse(response([choice('a', ['link:invented']), choice('b', [second])]))).toThrow(/unknown/);
    expect(() => parse(response([choice('a', [first, first]), choice('b', [second])]))).toThrow(/duplicate/);
    expect(() => parse(response([choice('a', [first]), choice('b', [second])], { target: 999 }))).toThrow();
    expect(() => parse(response([choice('a', [first])]))).toThrow(); // a single choice gives the reviewer nothing to compare
    expect(() => parse(response([choice('a', [first]), choice('b', [], { label: 'Escalate' })]))).toThrow(); // every choice must be a data draft
    expect(() => parse(response([choice('a', [first, second]), choice('b', [second, first])]))).toThrow(/duplicate choices/); // reordering is not an alternative
    expect(() => parse(response([choice('a', [first]), choice('b', [first], { rationale: ' grounded in the supplied sources ' })]))).toThrow(/duplicate choices/); // relabeling is a paraphrase
    const sameEdits = parse(response([
      choice('a', [first], { tradeoffs: 'Apply now; the owner confirms afterwards.' }),
      choice('b', [first], { rationale: 'Only after the owner confirms the source.', tradeoffs: 'Delays completion until sign-off.' }),
    ]));
    expect(sameEdits.choices.map((c) => c.optionIds)).toEqual([[first], [first]]); // same edits, different reasoning
    expect(() => parse(response([choice('a', [first]), choice('b', [second])], { recommendedId: 'z' }))).toThrow(/recommends an unknown/);
    expect(() => parse(response([choice('a', [first], { texts: { [first]: 'x' } }), choice('b', [second])]))).toThrow(/unknown field/);
    expect(() => parse(response([choice('a', [first], { drafts: { [first]: causeDraft } }), choice('b', [second])]))).toThrow(/unknown entity/);
    const parsed = parse(response([choice('a', [first]), choice('b', [first, second], { tradeoffs: 'Links a less certain KPI.' })], { missingInformation: ['Owner decision'] }));
    expect(parsed.recommendedId).toBe('a');
    expect(parsed.choices.map((c) => c.optionIds.length)).toEqual([1, 2]);
    const one = options[0]!;
    const bad = one.kind === 'link' ? { ...one, relatedId: 'kpi-invented' } : { ...one, text: '999999' };
    expect(() => previewResolution(input, proposal([one.id]), [bad], 'now')).toThrow(/no longer/);
    expect(() => previewResolution(input, proposal([]), options, 'now')).toThrow(/changes no data/);
    expect(previewResolution(input, proposal([one.id]), options, 'now').result!.done).toBe(false);
  });

  it('asks for compared data drafts, forwards reviewer direction, and rejects AI field text with unsupported numbers', () => {
    const input: ResolutionInput = { ctx: demoCtx(), step: 'asis', todoId: 'asis-doc', lang: 'ja', audience: 'internal' };
    const options = repairOptions(input);
    const field = options.find((o) => o.kind === 'field')!;
    const prompt = resolutionRequest(input, options, '  現場責任者の合意を優先する  ').prompt;
    expect(prompt).toContain('2 to 4 materially different choices');
    expect(prompt).toContain('comparing it with every other choice');
    expect(prompt).toContain('must include at least one supplied option id');
    expect(prompt).toContain('"現場責任者の合意を優先する"');
    expect(resolutionRequest(input, options).prompt).not.toContain('Reviewer direction');
    expect(unsupportedNumbers('リードタイム１６日、改善率 37.5 %', '16 days')).toEqual(['37.5']);
    expect(() => previewResolution(input, { optionIds: [field.id], texts: { [field.id]: '在庫回転を 987654 回改善する。' } }, options, 'now')).toThrow(/unsupported numbers.*987654/);
    const rewritten = previewResolution(input, { optionIds: [field.id], texts: { [field.id]: '出典の記述に基づき、現状の課題を整理する。' } }, options, 'now');
    expect(rewritten.selected[0]).toMatchObject({ kind: 'field', text: '出典の記述に基づき、現状の課題を整理する。' });
    expect(() => previewResolution(input, { optionIds: [field.id], texts: { 'field:asis:invented': 'x' } }, options, 'now')).toThrow(/unknown field/);
  });

  it('provides a valid JSON example with a rationale inside each choice', () => {
    const input = missingLinks();
    const prompt = resolutionRequest(input, repairOptions(input)).prompt;
    const prefix = 'Return only JSON: ';
    const line = prompt.split('\n').find((part) => part.startsWith(prefix));
    expect(line).toBeDefined();
    const example = JSON.parse(line!.slice(prefix.length).replace(/\.$/, '')) as {
      choices: { optionIds: string[]; rationale?: string; drafts?: object }[];
    };
    expect(example.choices).toHaveLength(2);
    expect(example.choices.every((item) => item.rationale)).toBe(true);
    expect(example.choices[1]!.drafts).toBeDefined();
    const options: RepairOption[] = [
      { id: example.choices[0]!.optionIds[0]!, kind: 'link', entityId: 'issue', field: 'kpiIds', relatedId: 'kpi', evidenceIds: ['source'] },
      { id: example.choices[1]!.optionIds[0]!, kind: 'create', entityKind: 'kpi', issueId: 'issue', newId: 'new-kpi', evidenceIds: ['source'] },
    ];
    expect(parseResolution(JSON.stringify(example), options).choices).toHaveLength(2);
  });

  it('never proposes unsourced or hidden relationships, and drafts new entities only for sourced, visible issues', () => {
    const input = missingLinks();
    const raw = clone();
    raw.entities = raw.entities.map((e) => e.kind === 'kpi' ? { ...e, sourceIds: [] } : e.kind === 'issue' ? { ...e, kpiIds: [] } : e);
    const unsourced = repairOptions({ ...input, ctx: demoCtx({ pack: loadPack(raw) }) });
    expect(links(unsourced)).toEqual([]);
    // With no linkable KPI the task still gets a data draft: a new KPI grounded in the issue's own sources.
    expect(creates(unsourced)).toContainEqual(expect.objectContaining({ entityKind: 'kpi', issueId: 'issue-lead-time', newId: 'kpi-draft-lead-time', evidenceIds: ['src-annual-report'] }));
    const external = { ...input, audience: 'external' as const };
    const request = resolutionRequest(external, repairOptions(external));
    expect(request.prompt).not.toContain('issue-skills');
    expect(request.prompt).not.toContain('person-');
    expect(request.entities?.some((e) => e.kind === 'person')).toBe(false);
    expect(repairOptions({ ...input, todoId: 'define-decision' })).toEqual([]);
    const unsourcedIssues = clone();
    unsourcedIssues.entities = unsourcedIssues.entities.filter((e) => e.kind !== 'kpi').map((e) => e.kind === 'issue' ? { ...e, kpiIds: [], sourceIds: [] } : e);
    expect(repairOptions({ ...input, ctx: demoCtx({ pack: loadPack(unsourcedIssues) }) })).toEqual([]);
  });

  it('turns an approved KPI draft into linked data only after a person supplies the measured values and an owner', () => {
    const input = missingLinks();
    const options = creates(repairOptions(input));
    expect(options).toHaveLength(5);
    const ids = options.map((o) => o.id);
    const drafts = Object.fromEntries(ids.map((id) => [id, kpiDraft]));
    const parse = (value: object) => parseResolution(JSON.stringify(value), options);
    expect(() => parse(response([choice('a', [ids[0]!]), choice('b', ids, { drafts })]))).toThrow(/without its draft/);
    expect(() => parse(response([choice('a', [ids[0]!], { drafts: { [ids[0]!]: causeDraft } }), choice('b', ids, { drafts })]))).toThrow(/incomplete/);
    expect(parse(response([choice('a', [ids[0]!], { drafts: { [ids[0]!]: kpiDraft } }), choice('b', ids, { drafts })])).choices).toHaveLength(2);

    const pending = previewResolution(input, { optionIds: ids, drafts }, options, 'now');
    expect(pending.result).toBeNull();
    expect(pending.changes).toEqual([]);
    expect(pending.missing).toHaveLength(ids.length * 4);
    // Proposed KPI numbers fill the form even when they are estimates; the label is decided locally, and AI text citing an unsupported number is still rejected.
    const proposed: EntityDraft = { ...kpiDraft, baseline: 777, current: 68, target: 500, estimateNote: { ja: '777 は推定、68 は出典の値', en: '777 is an estimate, 68 is from the source' } };
    expect(previewResolution(input, { optionIds: [ids[0]!], drafts: { [ids[0]!]: proposed } }, options, 'now').missing).toEqual([{ optionId: ids[0], field: 'ownerId' }]);
    expect(valueBasis(input, options[0]!, proposed, undefined, 'baseline')).toBe('estimate');
    // 68 日 appears only in another issue (issue-cash), so it is not evidence for this issue's KPI.
    expect(options[0]!.issueId).not.toBe('issue-cash');
    expect(valueBasis(input, options[0]!, proposed, undefined, 'current')).toBe('estimate');
    expect(valueBasis(input, options[0]!, proposed, { baseline: 30 }, 'baseline')).toBe('human');
    expect(valueBasis(input, options[0]!, kpiDraft, undefined, 'target')).toBeNull();
    // On its own issue a number is evidence only for the field its clause names and only in the KPI's unit.
    const cash = options.find((o) => o.issueId === 'issue-cash')!;
    const stated: EntityDraft = { ...kpiDraft, baseline: 68, current: 61, target: 45 };
    expect(valueBasis(input, cash, stated, undefined, 'baseline')).toBe('evidence');
    expect(valueBasis(input, cash, stated, undefined, 'target')).toBe('evidence');
    expect(valueBasis(input, cash, stated, undefined, 'current')).toBe('estimate'); // "平均 61 日" names no field
    expect(valueBasis(input, cash, { ...stated, target: 68 }, undefined, 'target')).toBe('estimate');
    expect(valueBasis(input, cash, { ...stated, unit: { ja: '%', en: '%' } }, undefined, 'baseline')).toBe('estimate');
    expect(() => previewResolution(input, { optionIds: [ids[0]!], drafts: { [ids[0]!]: { ...proposed, estimateNote: { ja: '987654 件から推定', en: 'From 987654 cases' } } } }, options, 'now'))
      .toThrow(/unsupported numbers.*987654/);
    const backwards = parse(response([choice('a', [ids[0]!], { drafts: { [ids[0]!]: { ...kpiDraft, baseline: 10, current: 12, target: 20 } } }), choice('b', ids, { drafts })]));
    expect(backwards.choices[0]!.drafts![ids[0]!]).toMatchObject({ baseline: 10, current: 12 });
    expect(backwards.choices[0]!.drafts![ids[0]!]!.target).toBeUndefined(); // a "decrease" target above the baseline is left for the reviewer
    const fields = (extra: object) => parse(response([choice('a', [ids[0]!], { drafts: { [ids[0]!]: { ...kpiDraft, ...extra } as EntityDraft } }), choice('b', ids, { drafts })])).choices[0]!.drafts![ids[0]!]!;
    expect(fields({ unit: '%', period: '月次' })).toMatchObject({ unit: { ja: '%', en: '%' }, period: { ja: '月次', en: '月次' } });
    expect(() => fields({ unit: undefined })).toThrow(/incomplete/);
    const owner = suggestOwner(input, options[0]!)!;
    expect(owner.basis).toBe('relatedKpi');
    expect(input.ctx.pack.pack.entities.some((e) => e.kind === 'kpi' && e.ownerId === owner.id)).toBe(true);
    const bare = clone();
    bare.entities = bare.entities.filter((e) => !['kpi', 'solution', 'initiative'].includes(e.kind)).map((e) => e.kind === 'issue' ? { ...e, kpiIds: [] } : e);
    const bareInput = { ...input, ctx: demoCtx({ pack: loadPack(bare) }) };
    const bareOption = creates(repairOptions(bareInput))[0]!;
    const approver = bare.entities.find((e) => e.kind === 'person')!;
    expect(suggestOwner(bareInput, bareOption, ` ${approver.name.en.toUpperCase()} `)).toEqual({ id: approver.id, basis: 'editor' });
    expect(suggestOwner(bareInput, bareOption, 'Someone Else')).toBeUndefined();
    expect(humanDescription(options[0]!, input, proposed, { current: 61, ownerId: owner.id }, owner))
      .toMatch(/^尺度: 比率.* \(Copilot の提案\) \/ 望ましい方向: 減少 \(Copilot の提案\) \/ 基準値: 777 \(Copilot の推定値.*\) \/ 現在値: 61 \(あなたが入力\) \/ 目標値: 500 \(Copilot の推定値.*\) \/ 責任者: .+ \(課題に関係する KPI の責任者から選択\)$/);
    const human = Object.fromEntries(options.map((o) => [o.id, o.issueId === 'issue-cash'
      ? { baseline: 68, current: 61, target: 45, ownerId: 'person-sato-yui' }
      : { baseline: 20, current: 18, target: 10, ownerId: 'person-sato-yui' }]));
    expect(() => previewResolution(input, { optionIds: ids, drafts, human: { ...human, [ids[0]!]: { ...human[ids[0]!], target: human[ids[0]!]!.baseline } } }, options, 'now')).toThrow(/direction/);
    const notPerson = previewResolution(input, { optionIds: ids, drafts, human: { ...human, [ids[0]!]: { ...human[ids[0]!], ownerId: 'issue-cash' } } }, options, 'now');
    expect(notPerson.missing).toEqual([{ optionId: ids[0], field: 'ownerId' }]);

    const preview = previewResolution(input, { optionIds: ids, drafts, human }, options, 'now');
    expect(preview.missing).toEqual([]);
    expect(preview.result!.done).toBe(true);
    const entities = preview.changes.flatMap((c) => c.op === 'upsert' ? [c.entity] : []);
    const kpis = entities.filter((e) => e.kind === 'kpi');
    expect(kpis.map((k) => k.id)).toEqual(options.map((o) => o.newId));
    expect(kpis[0]).toMatchObject({ author: 'ai', world: 'digital', type: 'metric', ownerId: 'person-sato-yui', direction: 'decrease', sourceIds: options[0]!.evidenceIds });
    for (const option of options) {
      const issue = entities.find((e) => e.id === option.issueId);
      expect(issue?.kind === 'issue' && issue.kpiIds).toEqual([option.newId]);
    }
    expect(input.ctx.pack.byId.has(options[0]!.newId)).toBe(false);
  });

  it('never guesses a KPI scale or direction the model did not state exactly; the reviewer chooses it before approval', () => {
    const input = missingLinks();
    const options = creates(repairOptions(input));
    const ids = options.map((o) => o.id);
    const owner = 'person-sato-yui';
    const numbers = { baseline: 20, current: 18, target: 12, ownerId: owner };
    // Reproduction of a real Foundry answer (names and numbers replaced): two KPI drafts said "linear", the others "ratio".
    // Before the fix the whole proposal was rejected with "choices.N.drafts.<id>.scale".
    const real = response([
      choice('a', [ids[0]!], { drafts: { [ids[0]!]: { ...kpiDraft, scale: 'linear', direction: 'increase', baseline: 10, current: 10, target: 12 } } }),
      choice('b', [ids[1]!, ids[2]!], { drafts: { [ids[1]!]: { ...kpiDraft, scale: 'linear' }, [ids[2]!]: kpiDraft } }),
      choice('c', [ids[0]!, ids[1]!], { drafts: { [ids[0]!]: { ...kpiDraft, scale: 'linear', direction: 'increase', baseline: 10, current: 10, target: 12 }, [ids[1]!]: { ...kpiDraft, scale: 'linear' } } }),
    ]);
    const parsed = parseResolution(JSON.stringify(real), options);
    const linear = parsed.choices[0]!.drafts![ids[0]!]!;
    expect(linear.scale).toBeUndefined();
    expect(linear.unrecognized).toEqual({ scale: 'linear' });
    expect(parsed.choices[1]!.drafts![ids[2]!]).toMatchObject({ scale: 'ratio' });
    expect(parsed.choices[1]!.drafts![ids[2]!]!.unrecognized).toBeUndefined();
    expect(repairDescription(options[0]!, input, linear)).toContain('Copilot は尺度を「linear」と回答しましたが');
    const pending = previewResolution(input, { optionIds: [ids[0]!], drafts: { [ids[0]!]: linear }, human: { [ids[0]!]: { ownerId: owner } } }, options, 'now');
    expect(pending.missing).toEqual([{ optionId: ids[0], field: 'scale' }]);
    expect(pending.changes).toEqual([]);
    const chosen = previewResolution(input, { optionIds: [ids[0]!], drafts: { [ids[0]!]: linear }, human: { [ids[0]!]: { ownerId: owner, scale: 'interval' } } }, options, 'now');
    expect(chosen.missing).toEqual([]);
    expect(chosen.changes.find((c) => c.op === 'upsert' && c.entity.kind === 'kpi')).toMatchObject({ entity: { scale: 'interval', direction: 'increase' } });
    expect(humanDescription(options[0]!, input, linear, { scale: 'interval', ownerId: owner })).toMatch(/^尺度: 間隔.* \(あなたが入力\) \/ 望ましい方向: 増加 \(Copilot の提案\)/);

    const draftWith = (extra: object) => parseResolution(JSON.stringify(response([
      choice('a', [ids[0]!], { drafts: { [ids[0]!]: { ...kpiDraft, ...extra } } }), choice('b', [ids[1]!], { drafts: { [ids[1]!]: kpiDraft } }),
    ])), options).choices[0]!.drafts![ids[0]!]!;
    const missingOf = (draft: EntityDraft, human: object = {}) => previewResolution(input, { optionIds: [ids[0]!], drafts: { [ids[0]!]: draft }, human: { [ids[0]!]: { ...numbers, ...human } } }, options, 'now').missing.map((m) => m.field);
    // Exact values, in either language and with "scale" spelled out, are accepted.
    for (const [said, scale] of [['Ratio', 'ratio'], [' interval_scale ', 'interval'], ['比率尺度', 'ratio'], ['間隔', 'interval']] as const) expect(draftWith({ scale: said }).scale).toBe(scale);
    for (const [said, direction] of [['Decrease', 'decrease'], ['higher is better', 'increase'], ['減少', 'decrease'], ['増やす', 'increase']] as const) expect(draftWith({ direction: said }).direction).toBe(direction);
    // Unknown, ambiguous, negated or structured answers are never mapped; each becomes a field the reviewer must choose.
    for (const said of ['linear', 'ordinal', 'nominal', 'log', 'ratio or interval', '比率または間隔', 'not ratio', '比率ではない', '', null, 0, { ja: '比率', en: 'ratio' }]) {
      const draft = draftWith({ scale: said });
      expect(draft.scale, JSON.stringify(said)).toBeUndefined();
      expect(draft.unrecognized?.scale, JSON.stringify(said)).toBeDefined();
      expect(missingOf(draft), JSON.stringify(said)).toEqual(['scale']);
    }
    for (const said of ['Do not increase', '増加させない', 'increase or decrease', '増減', 'up', 'down', 'reduce', '向上', '高いほど良い', 'maintain', '維持']) {
      const draft = draftWith({ direction: said });
      expect(draft.direction, said).toBeUndefined();
      expect(draft.unrecognized?.direction, said).toBe(said);
      expect(missingOf(draft), said).toEqual(['direction']);
    }
    // Without a stated direction the proposed target is kept, not judged; it must be re-entered if it does not improve under the reviewer's choice.
    const undirected = draftWith({ direction: 'Do not increase', baseline: 20, current: 18, target: 12 });
    expect(undirected.target).toBe(12);
    expect(missingOf(undirected, { target: undefined, direction: 'increase' })).toEqual(['target']);
    expect(missingOf(undirected, { target: undefined, direction: 'decrease' })).toEqual([]);
    // A cleared choice never falls back to the proposal, and a model cannot pre-fill the local "unrecognized" record.
    expect(missingOf(kpiDraft, { scale: '' })).toEqual(['scale']);
    expect(draftWith({ unrecognized: { scale: 'ratio' } }).unrecognized).toBeUndefined();
  });

  it('drafts a sourced cause for each issue without one and links it on approval', () => {
    const raw = clone();
    raw.entities = raw.entities.map((e) => e.kind === 'issue' ? { ...e, causeIds: [] } : e);
    const input: ResolutionInput = { step: 'asis', todoId: 'define-causes', ctx: demoCtx({ pack: loadPack(raw) }), lang: 'ja', audience: 'internal' };
    const options = creates(repairOptions(input));
    expect(options.map((o) => o.newId)).toContain('cause-draft-lead-time');
    const ids = options.map((o) => o.id);
    const preview = previewResolution(input, { optionIds: ids, drafts: Object.fromEntries(ids.map((id) => [id, causeDraft])) }, options, 'now');
    expect(preview.missing).toEqual([]);
    expect(preview.result!.done).toBe(true);
    const cause = preview.changes.find((c) => c.op === 'upsert' && c.entity.id === options[0]!.newId);
    expect(cause).toMatchObject({ entity: { kind: 'cause', world: 'real', author: 'ai', sourceIds: options[0]!.evidenceIds } });
  });

  it('repairs only failed document fields and refuses a regression of a previously completed numeric check', () => {
    const ctx = demoCtx();
    const input: ResolutionInput = { ctx, step: 'asis', todoId: 'asis-doc', lang: 'ja', audience: 'internal' };
    const options = repairOptions(input);
    const preview = previewResolution(input, proposal(options.map((o) => o.id)), options, '2026-11-16');
    expect(preview.result!.done).toBe(true);
    expect(preview.changes).toEqual([]);
    expect(preview.deliverables.docs.asis?.problem?.author).toBe('ai');
    expect(preview.deliverables.signOffs).toEqual({});
    const filledInput = { ...input, ctx: { ...ctx, deliverables: setField(ctx.deliverables, 'asis', 'problem', { text: '16 days, keep this field', author: 'human', updatedAt: 'now' }) } };
    expect(repairOptions(filledInput).some((o) => o.kind === 'field' && o.field === 'problem')).toBe(false);
    for (const [step, todoId] of [['tobe', 'tobe-doc'], ['kpi', 'kpi-doc'], ['solution', 'uc-doc'], ['deliverable', 'plan-doc']] as const) {
      const otherInput = { ...input, step, todoId };
      const fields = repairOptions(otherInput);
      expect(fields.length).toBeGreaterThan(0);
      const otherPreview = previewResolution(otherInput, proposal(fields.map((o) => o.id)), fields, 'now');
      expect(Object.keys(otherPreview.deliverables.docs[step] ?? {}).length).toBeGreaterThan(0);
      expect(otherPreview.changes).toEqual([]);
      expect(otherPreview.deliverables.signOffs).toEqual({});
    }

    const raw = clone();
    raw.entities = raw.entities.map((e) => e.id === 'issue-lead-time' && e.kind === 'issue' ? { ...e, description: { ja: '999 日', en: '999 days' }, kpiIds: [] } : e);
    // Linking a KPI makes an existing unsupported numeric assertion checkable, exposing a regression.
    const inconsistent = { ...missingLinks(), ctx: demoCtx({ pack: loadPack(raw) }) };
    const leadTime = repairOptions(inconsistent).filter((o) => o.kind === 'link' && o.relatedId === 'kpi-lead-time');
    expect(byId('asis', inconsistent.ctx)['asis-reconcile']!.done).toBe(true);
    expect(() => previewResolution(inconsistent, proposal(leadTime.map((o) => o.id)), leadTime, 'now')).toThrow(/regress/);
  });

  it('uses the live gate without a mock fallback and reports invalid provider responses', async () => {
    const input = missingLinks();
    const options = repairOptions(input);
    const [first, second] = links(options).map((o) => o.id) as [string, string];
    const request = { ...resolutionRequest(input, options) };
    writeLedger([]);
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true, provider: 'copilotSdk' }));
    const transport = vi.fn(async () => ({ text: JSON.stringify(response([choice('a', [first]), choice('b', [second])])), inputTokens: 100, outputTokens: 100 }));
    setLiveTransport(transport);
    const result = await requestResolution(request, options, new AbortController().signal);
    expect(result.choices[0]!.optionIds).toEqual([first]);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ provider: 'copilotSdk', use: 'deliverableDraft' }), expect.any(AbortSignal));
    writeLedger([]);
    setLiveTransport(async () => ({ text: 'not JSON', inputTokens: 1, outputTokens: 1 }));
    await expect(requestResolution(request, options, new AbortController().signal)).rejects.toThrow(/JSON/);
    writeLedger([]);
    setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: true }));
    await expect(requestResolution(request, options, new AbortController().signal)).rejects.toThrow(/blocked/);
  });
});

describe('task business impact scenarios', () => {
  const input = { baselineBenefit: '1000', baselineCost: '200', benefit: '1800', cost: '300', investment: '1400', years: '3' };
  it('compares annual and cumulative net benefit against the current baseline', () => {
    expect(simulateTaskImpact(input)).toEqual({ ok: true, baselineAnnual: 800, scenarioAnnual: 1500, annualChange: 700, totalChange: 700, paybackYears: 2 });
    expect(simulateTaskImpact({ ...input, benefit: '900' })).toEqual({ ok: true, baselineAnnual: 800, scenarioAnnual: 600, annualChange: -200, totalChange: -2000, paybackYears: null });
  });
  it('does not silently turn absent, invalid or excessive assumptions into zero', () => {
    for (const patch of [{ benefit: '' }, { cost: '-1' }, { investment: '1.5' }, { years: '0' }, { years: '51' }, { benefit: '10000000000001' }]) {
      expect(simulateTaskImpact({ ...input, ...patch })).toEqual({ ok: false });
    }
    expect(simulateTaskImpact({ ...input, investment: '0' })).toMatchObject({ ok: true, paybackYears: 0 });
  });
});

/**
 * What a person does on the strategy panels: confirm each solution's type (digital only where a use case exists),
 * estimate contributions that close every project KPI gap, align the project to a company objective, and write the
 * deliverable sections the data cannot fill.
 */
function withStrategy(c: CheckContext): CheckContext {
  const at = '2026-11-09T09:00:00Z';
  const solutions = pack.pack.entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution');
  let s: StrategyData = emptyStrategy();
  const registered = c.useCases.filter((u) => u.origin === 'registered');
  for (const sol of solutions) s = setSolutionType(s, sol.id, registered.some((u) => u.relatedIds.includes(sol.id)) ? 'digital' : 'process', 'Tester', at);
  const claims = new Map<string, string[]>();
  for (const sol of solutions) {
    const own = c.kpi.kpis.filter((k) => sol.kpiIds.includes(k.id));
    for (const k of own.length ? own : c.kpi.kpis.slice(0, 1)) claims.set(k.id, [...(claims.get(k.id) ?? []), sol.id]);
  }
  for (const k of c.kpi.kpis) if (!claims.has(k.id)) claims.set(k.id, [solutions[0]!.id]);
  for (const [kpiId, sols] of claims) {
    const k = c.kpi.kpis.find((x) => x.id === kpiId)!;
    const per = (Math.abs(k.target - k.current) * 1.2) / sols.length / 10;
    for (const solutionId of sols) {
      s = upsertContribution(s, {
        id: `c-${solutionId}-${kpiId}`, solutionId, kpiId, lever: 'sites switched', leverUnit: 'sites',
        amount: { low: 10, mode: 10, high: 10 }, effectPerUnit: { low: per, mode: per, high: per },
        rampStart: '2026-12-01', fullEffect: '2027-01-31', basis: 'measured', evidence: 'pilot 2026-10',
      });
    }
  }
  // Every KPI must be a key result of some OKR (the demo leaves kpi-co2 outside its OKRs).
  const inOkr = new Set(c.kpi.okrs.flatMap((o) => o.keyResults.map((kr) => kr.kpiId)));
  const extra = c.kpi.kpis.filter((k) => !inOkr.has(k.id)).map((k) => ({ id: `kr-${k.id}`, kpiId: k.id, text: k.name }));
  const okrs = extra.length && c.kpi.okrs[0] ? [{ ...c.kpi.okrs[0], keyResults: [...c.kpi.okrs[0].keyResults, ...extra] }, ...c.kpi.okrs.slice(1)] : c.kpi.okrs;
  const ctx: CheckContext = { ...c, kpi: { ...c.kpi, okrs }, strategy: s, objectives: [OBJECTIVE], projectObjectiveIds: [OBJECTIVE.id] };
  const thread = strategyThread({ ...ctx, strategy: s, objectives: [OBJECTIVE], projectObjectiveIds: [OBJECTIVE.id] });
  for (const sol of solutions) {
    const doc = buildSolutionDoc(sol, thread.solutions.find((x) => x.id === sol.id)!, thread, { ...ctx, strategy: s, objectives: [OBJECTIVE], projectObjectiveIds: [OBJECTIVE.id] }, 'ja');
    for (const sec of doc.sections.filter((x) => x.open)) s = setSection(s, sol.id, sec.id, `${sec.id}: 2027-03-31 までに担当部長が確定`);
  }
  return { ...ctx, strategy: s };
}

/** The strategy-panel checks a person completes (the demo pack holds no company objectives or estimates). */
const STRATEGY_TODOS = ['tobe-link', 'kpi-company', 'sol-type', 'sol-contribution', 'sol-target', 'dlv-trace', 'dlv-docs'];

describe('step deliverables: definitions', () => {
  it('every task links to a component, and document failures link to the first field needing work', () => {
    for (const step of IMPROVEMENT_STEPS) {
      for (const r of evaluateStep(step, demoCtx())) {
        const route = parseHash(todoHref(r));
        expect(route.query.get('target'), r.todo.id).toBeTruthy();
        if (r.todo.id.endsWith('-doc')) {
          expect(route.path).toBe('/deliverables');
          expect(route.query.get('step')).toBe(step);
          expect(route.query.get('target')).toBe(`dlv-field-${STEP_DEFS[step].fields[0]!.id}`);
        }
        if (r.todo.kind === 'manual') expect(route.query.get('target')).toBe(`dlv-sign-${r.todo.id}`);
        if (route.path === '/analysis' && r.todo.id !== 'asis-framework') expect(route.query.get('tab')).toBe('kpi');
        if (route.path === '/relations') expect(route.query.get('view')).toBe('table');
      }
    }
    const c = demoCtx();
    const data = setField(drafted(c), 'tobe', 'success', { text: 'Improve', author: 'human', updatedAt: '2026-11-09T10:00:00Z' });
    expect(parseHash(todoHref(byId('tobe', { ...c, deliverables: data })['tobe-doc']!)).query.get('target')).toBe('dlv-field-success');
    expect(parseHash(todoHref(byId('kpi', c)['kpi-okr']!)).query.get('target')).toBe('proj-okr-panel');
    expect(parseHash(todoHref(byId('asis', emptyProjectCtx())['define-decision']!)).query.get('target')).toBe('proj-tree');
    // Strategy checks open the panel where the gap is fixed.
    const target = (step: ImprovementStep, id: string) => parseHash(todoHref(byId(step, c)[id]!)).query.get('target');
    expect(target('tobe', 'tobe-link')).toBe('proj-active');
    expect(target('kpi', 'kpi-definition')).toBe('sol-def');
    expect(target('kpi', 'kpi-company')).toBe('sol-def');
    expect(target('solution', 'sol-type')).toBe('sol-types');
    expect(target('solution', 'sol-target')).toBe('sol-sim');
    expect(target('deliverable', 'dlv-trace')).toBe('sol-thread');
    expect(target('deliverable', 'dlv-docs')).toBe('sol-docs');
    expect(target('deliverable', 'plan-payback')).toBe('dlv-criteria');
  });

  it('defines a deliverable for each of the five steps with fields, exit criteria and at least one human sign-off', () => {
    expect(IMPROVEMENT_STEPS).toEqual(['asis', 'tobe', 'kpi', 'solution', 'deliverable']);
    expect(Object.keys(STEP_DEFS).sort()).toEqual([...IMPROVEMENT_STEPS].sort());
    for (const s of IMPROVEMENT_STEPS) {
      const d = STEP_DEFS[s];
      expect(d.fields.length, s).toBeGreaterThanOrEqual(5);
      expect(d.todos.filter((x) => x.kind === 'auto').length, s).toBeGreaterThanOrEqual(2);
      expect(d.todos.filter((x) => x.kind === 'manual').length, s).toBeGreaterThanOrEqual(1);
      expect(d.todos.every((x) => (x.kind === 'auto') === (typeof x.check === 'function')), s).toBe(true);
      expect(d.inputs.length, s).toBeGreaterThan(0);
    }
    const ids = IMPROVEMENT_STEPS.flatMap((s) => STEP_DEFS[s].todos.map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every label, hint, reason and result message exists in both languages', () => {
    const keys: string[] = [];
    for (const s of IMPROVEMENT_STEPS) {
      const d = STEP_DEFS[s];
      keys.push(`dlv.${s}.name`, `dlv.${s}.purpose`, ...d.inputs.map(inputKey), ...d.fields.flatMap((f) => [fieldKey(s, f.id), fieldHintKey(s, f.id)]), ...d.todos.flatMap((x) => [todoKey(x.id), todoWhyKey(x.id)]));
    }
    // Result codes: collect from contexts that exercise both verdicts of every check.
    const broken = clone();
    broken.entities = broken.entities.filter((e) => !['issue', 'cause', 'kpi', 'solution', 'initiative'].includes(e.kind));
    const ctxs = [emptyProjectCtx(), demoCtx(), demoCtx({ deliverables: drafted(demoCtx()) }), withStrategy(demoCtx({ deliverables: drafted(demoCtx()) })), { ...emptyProjectCtx(), pack: loadPack(broken) }];
    for (const c of ctxs) for (const s of IMPROVEMENT_STEPS) for (const r of evaluateStep(s, c)) if (r.outcome) keys.push(resultKey(r.outcome.code));
    for (const k of new Set(keys)) {
      for (const lang of ['ja', 'en'] as const) expect(typeof translate(lang, k as MessageKey), `${lang}:${k}`).toBe('string');
    }
  });
});

describe('step deliverables: validity checks', () => {
  it('a new, empty project fails every project-data check and every deliverable field check', () => {
    const c = emptyProjectCtx();
    const asis = byId('asis', c);
    expect(asis['define-sources']!.done).toBe(true); // pack data is shared
    expect(asis['define-decision']!.outcome?.code).toBe('noThemes');
    expect(asis['asis-doc']!.outcome).toMatchObject({ ok: false, code: 'docMissing', vars: { empty: 10, vague: 0 } });
    expect(asis['asis-doc']!.outcome?.refs).toHaveLength(10);
    expect(asis['define-agree']!.done).toBe(false);
    expect(asis['asis-framework']!.outcome?.code).toBe('noAnalysis');
    expect(byId('tobe', c)['tobe-link']!.outcome?.code).toBe('noCompanyObjectives');
    expect(byId('tobe', c)['tobe-doc']!.outcome).toMatchObject({ ok: false, code: 'docMissing', vars: { empty: 5 } });
    expect(byId('kpi', c)['kpi-definition']!.done).toBe(false);
    expect(byId('kpi', c)['kpi-valid']!.outcome?.code).toBe('noProjectKpis');
    expect(byId('kpi', c)['kpi-coverage']!.outcome?.code).toBe('issuesNotMeasured');
    expect(byId('kpi', c)['kpi-okr']!.outcome?.code).toBe('noOkr');
    expect(byId('tobe', c)['uc-registered']!.outcome?.code).toBe('noUseCases');
    expect(byId('solution', c)['sol-issues']!.done).toBe(true); // pack data is shared
    expect(byId('solution', c)['sol-type']!.outcome?.code).toBe('typesUnconfirmed');
    expect(byId('solution', c)['sol-contribution']!.outcome?.code).toBe('solutionsWithoutContribution');
    expect(byId('solution', c)['sol-target']!.outcome?.code).toBe('noProjectKpis');
    expect(byId('deliverable', c)['plan-decision']!.outcome?.code).toBe('noPlanDecision');
    expect(byId('deliverable', c)['dlv-docs']!.outcome?.code).toBe('docsOpen');
    for (const s of IMPROVEMENT_STEPS) expect(progressOf(evaluateStep(s, c)).complete, s).toBe(false);
  });

  it('FR-368: a customer KPI or OKR alone makes the definition valid; AI drafts stay provisional until a person inspects them', () => {
    const okr = (origin: 'customerDefined' | 'proposed', reviewedAt?: string) => ({ id: `okr-${origin}`, objective: 'Grow the platform', keyResults: [], origin, ...(reviewedAt ? { reviewedAt } : {}) });
    const kpi = (origin: 'customerDefined' | 'proposed' | undefined, reviewedAt?: string) => ({
      id: `kpi-${origin ?? 'manual'}`, name: 'Win rate', unit: '%', baseline: 10, current: 12, target: 20, deadline: '2027-06-30',
      ...(origin ? { origin } : {}), ...(reviewedAt ? { reviewedAt } : {}),
    });
    const defined = { definition: { status: 'defined' as const, note: '', at: '2026-11-09T09:00:00Z', by: 'tester' } };
    const run = (data: CheckContext['kpi'], strategy = emptyStrategy()) => byId('kpi', { ...emptyProjectCtx(), kpi: data, strategy: { ...strategy, ...defined } });

    // OKR only, no KPI: still the customer's own definition.
    const okrOnly = run({ kpis: [], okrs: [okr('customerDefined')] });
    expect(okrOnly['kpi-definition']!.outcome).toMatchObject({ ok: true, code: 'definitionImported', vars: { n: 1 } });
    expect(okrOnly['kpi-review']!.outcome?.code).toBe('reviewNotNeeded');

    // No customer KPI/OKR: AI drafts are placeholders, and the review stays open until each one is inspected.
    const undefinedStatus = (data: CheckContext['kpi']) => byId('kpi', { ...emptyProjectCtx(), kpi: data, strategy: { ...emptyStrategy(), definition: { status: 'undefined', note: '', at: '2026-11-09T09:00:00Z', by: 'tester' } } });
    const drafts = undefinedStatus({ kpis: [kpi('proposed')], okrs: [okr('proposed')] });
    expect(drafts['kpi-definition']!.outcome).toMatchObject({ ok: true, code: 'definitionProvisional', vars: { n: 2 } });
    expect(drafts['kpi-review']!.outcome).toMatchObject({ ok: false, code: 'provisionalUnreviewed', vars: { n: 2 } });
    expect(drafts['kpi-review']!.outcome?.refs).toHaveLength(2);
    const half = undefinedStatus({ kpis: [kpi('proposed', '2026-11-10T09:00:00Z')], okrs: [okr('proposed')] });
    expect(half['kpi-review']!.outcome).toMatchObject({ ok: false, vars: { n: 1 } });
    const inspected = undefinedStatus({ kpis: [kpi('proposed', '2026-11-10T09:00:00Z')], okrs: [okr('proposed', '2026-11-10T09:00:00Z')] });
    expect(inspected['kpi-review']!.outcome).toMatchObject({ ok: true, code: 'provisionalReviewed', vars: { n: 2 } });

    // Hand entry without a source is neither: the definition stays missing, and the customer said it is defined → not imported.
    expect(undefinedStatus({ kpis: [kpi(undefined)], okrs: [] })['kpi-definition']!.outcome?.code).toBe('definitionMissing');
    expect(run({ kpis: [kpi('proposed')], okrs: [] })['kpi-definition']!.outcome?.code).toBe('definitionNotImported');
    expect(byId('kpi', emptyProjectCtx())['kpi-review']!.outcome?.code).toBe('noProjectKpis');

    // The dashboard counts the same inspections.
    const d = stepDashboard('kpi', { ...emptyProjectCtx(), kpi: { kpis: [kpi('proposed', '2026-11-10T09:00:00Z')], okrs: [okr('proposed')] } });
    expect(d.tiles.find((t) => t.id === 'provisionalUnreviewed')).toMatchObject({ kind: 'problems', value: 1, total: 2, todoId: 'kpi-review' });
    expect(d.detail.step === 'kpi' && d.detail.basis).toMatchObject({ basis: 'provisional', unreviewed: 1 });
    for (const code of ['definitionProvisional', 'provisionalUnreviewed', 'provisionalReviewed', 'reviewNotNeeded']) {
      for (const lang of ['ja', 'en'] as const) expect(typeof translate(lang, resultKey(code) as MessageKey), `${lang}:${code}`).toBe('string');
    }
  });

  it('the demo meets every data check; the fields, the sign-offs, the qualification and the strategy work are left', () => {
    const open = (c: CheckContext, s: ImprovementStep) => evaluateStep(s, c).filter((r) => !r.done).map((r) => r.todo.id).sort();
    // Qualifying issues is the person's judgment, like a sign-off: the demo data never decides it.
    const userWork = (s: ImprovementStep, extra: string[]) => STEP_DEFS[s].todos.filter((x) => x.kind === 'manual' || x.id.endsWith('-doc') || x.id === 'asis-qualify' || extra.includes(x.id)).map((x) => x.id).sort();
    const c = demoCtx();
    for (const s of IMPROVEMENT_STEPS) expect(open(c, s), s).toEqual(userWork(s, STRATEGY_TODOS));
    // Once the strategy panels are done, only the fields and the sign-offs remain.
    const strategic = withStrategy(c);
    for (const s of IMPROVEMENT_STEPS) expect(open(strategic, s), s).toEqual(userWork(s, []));
  });

  it('the band names the next thing to do and lists open criteria first; nothing is next once the step is complete', () => {
    const c = demoCtx();
    const results = evaluateStep('asis', c);
    expect(nextTodo(results)?.todo.id).toBe('asis-qualify');
    const ordered = openFirst(results).map((r) => r.todo.id);
    expect(ordered.slice(0, 4)).toEqual(['asis-qualify', 'asis-doc', 'asis-field', 'define-agree']);
    expect([...ordered].sort()).toEqual(results.map((r) => r.todo.id).sort());
    // After the qualification and the draft the field check passes, so the sign-offs become next; after them, nothing is left.
    let data = qualifyAll(drafted(c), c);
    expect(nextTodo(evaluateStep('asis', { ...c, deliverables: data }))?.todo.id).toBe('asis-field');
    data = setSignOff(data, 'asis-field', { at: '2026-11-09T10:00:00Z', by: 'Tester' });
    data = setSignOff(data, 'define-agree', { at: '2026-11-09T10:00:00Z', by: 'Tester' });
    expect(nextTodo(evaluateStep('asis', { ...c, deliverables: data }))).toBeUndefined();
  });

  it('after "Draft with Copilot", the qualification, the strategy work and the sign-offs every step is complete (ja and en)', () => {
    for (const lang of ['ja', 'en'] as const) {
      const base = demoCtx();
      let data = qualifyAll(drafted(base, lang), base);
      for (const s of IMPROVEMENT_STEPS) for (const x of STEP_DEFS[s].todos.filter((y) => y.kind === 'manual')) data = setSignOff(data, x.id, { at: '2026-11-09T10:00:00Z', by: 'Tester' });
      const c = withStrategy({ ...base, deliverables: data });
      for (const s of IMPROVEMENT_STEPS) {
        const failed = evaluateStep(s, c).filter((r) => !r.done).map((r) => `${r.todo.id}:${r.outcome?.code}`);
        expect(failed, `${lang}:${s}`).toEqual([]);
      }
    }
  });

  it('field checks reject statements without numbers or deadlines (SMART)', () => {
    let data = emptyDeliverables();
    const at = '2026-11-09T00:00:00Z';
    for (const f of STEP_DEFS.asis.fields) data = setField(data, 'asis', f.id, { text: 'TBD', author: 'human', updatedAt: at });
    const r = byId('asis', { ...emptyProjectCtx(), deliverables: data })['asis-doc']!;
    expect(r.outcome).toMatchObject({ ok: false, code: 'docVague', vars: { empty: 0, vague: 3 } });
    expect(r.outcome?.refs?.map((x) => (x.type === 'field' ? x.id : '')).sort()).toEqual(['evidence', 'impact', 'problem']);
    for (const f of STEP_DEFS.tobe.fields) data = setField(data, 'tobe', f.id, { text: 'TBD', author: 'human', updatedAt: at });
    const tobe = () => byId('tobe', { ...emptyProjectCtx(), deliverables: data })['tobe-doc']!;
    expect(tobe().outcome?.refs?.map((x) => (x.type === 'field' ? x.id : '')).sort()).toEqual(['gap', 'success', 'vision']);
    data = setField(data, 'tobe', 'vision', { text: 'Next-day shipping nationwide by FY27', author: 'human', updatedAt: at });
    data = setField(data, 'tobe', 'gap', { text: '16 → 10 days', author: 'human', updatedAt: at });
    data = setField(data, 'tobe', 'success', { text: '10 days', author: 'human', updatedAt: at });
    let r2 = tobe();
    expect(r2.outcome).toMatchObject({ ok: false, code: 'docVague', vars: { vague: 1 } }); // success has no deadline
    data = setField(data, 'tobe', 'success', { text: '10 days by 2027-03-31', author: 'human', updatedAt: at });
    r2 = tobe();
    expect(r2.done).toBe(true);
  });

  it('counter-examples in the pack are caught and point at the offending items', () => {
    const p = clone();
    const issue = p.entities.find((e) => e.id === 'issue-energy') as { sourceIds: string[]; causeIds: string[]; kpiIds: string[] };
    issue.sourceIds = [];
    issue.causeIds = [];
    const rollout = p.entities.find((e) => e.id === 'init-dp-rollout') as { start: string };
    rollout.start = '2026-09-01'; // before its prerequisite ends (2026-09-30)
    const sol = p.entities.find((e) => e.id === 'sol-energy-twin') as { costJpy: number; annualBenefitJpy: number };
    sol.costJpy = 400_000_000; // 10-year payback
    const kpi = p.entities.find((e) => e.id === 'kpi-defect') as { target: number };
    kpi.target = 900; // "decrease" KPI with a target above the baseline
    const c = { ...demoCtx(), pack: loadPack(p) };
    const refIds = (r: ReturnType<typeof byId>[string]) => r.outcome?.refs?.map((x) => (x.type === 'entity' ? x.id : '')) ?? [];
    const asis = byId('asis', c);
    expect(asis['define-sources']!.done).toBe(false);
    expect(refIds(asis['define-sources']!)).toEqual(['issue-energy']);
    expect(refIds(asis['define-causes']!)).toEqual(['issue-energy']);
    const plan = byId('deliverable', c);
    expect(refIds(plan['plan-schedule']!)).toEqual(['init-dp-rollout']);
    expect(plan['plan-payback']!.outcome).toMatchObject({ ok: false, code: 'paybackTooLong', vars: { n: 1, max: 3 } });
    expect(refIds(byId('kpi', c)['kpi-direction']!)).toEqual(['kpi-defect']);
  });

  it('project-data counter-examples: past deadlines, dangling OKRs, thin use cases', () => {
    const base = demoCtx();
    const kpi = { ...base.kpi, kpis: base.kpi.kpis.map((k, i) => (i === 0 ? { ...k, deadline: '2026-01-31' } : k)), okrs: [...base.kpi.okrs, { id: 'okr-x', objective: 'X', keyResults: [{ id: 'kr-x', text: 'x', kpiId: 'kpi-missing' }] }] };
    const useCases = base.useCases.map((u, i) => (i === 0 ? { ...u, steps: u.steps.slice(0, 2), relatedIds: [] } : u));
    const c = { ...base, kpi, useCases };
    const k = byId('kpi', c);
    expect(k['kpi-deadline']!.outcome).toMatchObject({ ok: false, code: 'kpisPastDeadline', vars: { n: 1, today: TODAY } });
    expect(k['kpi-okr']!.outcome).toMatchObject({ ok: false, code: 'okrDangling', vars: { n: 1 } });
    const u = byId('tobe', c);
    expect(u['uc-complete']!.done).toBe(false);
    expect(u['uc-trace']!.done).toBe(false);
  });

  it('numbers written in issues and discussion records are reconciled with the KPI values', () => {
    const demo = byId('asis', demoCtx())['asis-reconcile']!;
    expect(demo.outcome).toMatchObject({ ok: true, code: 'valuesReconciled' });
    expect(Number(demo.outcome!.vars!.n)).toBeGreaterThanOrEqual(3);
    // Counter-example: the record says 14 days, but the KPI says baseline 21 / current 16 / target 10.
    const discussion = demoDiscussion();
    const rec = discussion.records.find((r) => r.id === 'rec-demo-1')!;
    rec.text = { ja: '現状は受注から出荷まで平均 14 日。', en: 'Today order to shipment takes 14 days on average.' };
    const bad = byId('asis', { ...demoCtx(), discussion })['asis-reconcile']!;
    expect(bad.outcome).toMatchObject({ ok: false, code: 'valuesMismatch', vars: { n: 1 } });
    const ref = bad.outcome!.refs![0]!;
    expect(JSON.stringify(ref)).toContain('「14 日」');
    // The pack text is checked too: the issue says 68 while the KPI's current value is 61 (68 is the baseline, so it passes).
    const p = clone();
    const cash = p.entities.find((e) => e.id === 'issue-cash') as { description: { ja: string; en: string } };
    cash.description = { ja: '売掛金の回収に平均 70 日かかる。', en: 'Receivables take 70 days on average to collect.' };
    const issueBad = valueMismatches({ ...demoCtx(), pack: loadPack(p) });
    expect(issueBad.mismatches.map((m) => m.where)).toEqual([{ type: 'issue', id: 'issue-cash' }]);
    // With no KPI-linked text at all there is nothing to compare, which is not a failure.
    expect(byId('asis', emptyProjectCtx())['asis-reconcile']!.done).toBe(true);
  });

  it('stated values skip dates and changes, and need a word boundary for Latin units', () => {
    expect(statedValues('平均 16 日。期限は 3 月 31 日、5 日短縮する。2026/3/31 日', '日')).toEqual([16]);
    expect(statedValues('takes 16 days; 3 days shorter; 1,200 days', 'days')).toEqual([16, 1200]);
    expect(statedValues('500 ppmx and 40 ppm', 'ppm')).toEqual([40]);
    expect(statedValues('anything', '')).toEqual([]);
  });

  it('payback includes the build period and uses the project\'s own hurdle when set', () => {
    const sol = { id: 's', costJpy: 100, annualBenefitJpy: 100 } as EntityOf<'solution'>;
    const init = (start: string, end: string) => ({ id: start, solutionId: 's', start, end }) as EntityOf<'initiative'>;
    expect(paybackYears(sol, [])).toBe(1);
    expect(paybackYears(sol, [init('2026-01-01', '2026-07-01'), init('2026-04-01', '2027-01-01')])).toBeCloseTo(2, 2);
    expect(paybackYears({ ...sol, annualBenefitJpy: 0 }, [])).toBe(Infinity);
    // The sample's longest payback with its build period is ~1.2 years: within the default, but not within a 1-year hurdle.
    const demo = byId('deliverable', demoCtx())['plan-payback']!;
    expect(demo.outcome).toMatchObject({ ok: true, code: 'paybackOk', vars: { max: PAYBACK_MAX_YEARS } });
    const strict = setPaybackLimit(emptyDeliverables(), { value: 1, at: '2026-11-09T10:00:00Z', by: 'CFO office' });
    expect(paybackLimit(strict)).toBe(1);
    const failing = byId('deliverable', { ...demoCtx(), deliverables: strict })['plan-payback']!;
    expect(failing.outcome).toMatchObject({ ok: false, code: 'paybackTooLong', vars: { max: 1 } });
    expect(paybackLimit(setPaybackLimit(strict, null))).toBe(PAYBACK_MAX_YEARS);
    // A broken stored criterion falls back to the default instead of breaking the check.
    expect(paybackLimit(normalizeDeliverables({ docs: {}, signOffs: {}, criteria: { paybackMaxYears: { value: 'x' } } }))).toBe(PAYBACK_MAX_YEARS);
    expect(paybackLimit(normalizeDeliverables({ docs: {}, signOffs: {}, criteria: 'x' }))).toBe(PAYBACK_MAX_YEARS);
    expect(normalizeDeliverables(JSON.parse(JSON.stringify(strict))).criteria?.paybackMaxYears).toEqual({ value: 1, at: '2026-11-09T10:00:00Z', by: 'CFO office' });
  });

  it('the band opens automatically only when the head and the list fit in 35 % of the window', () => {
    const head = 173; // measured: bottom of the band head
    expect(shouldAutoExpand(head, BAND_LIST_HEIGHT_GUESS, 1080 - 133)).toBe(true); // 1920×1080 at 100 %
    expect(shouldAutoExpand(head, BAND_LIST_HEIGHT_GUESS, 1000)).toBe(true);
    expect(shouldAutoExpand(head, BAND_LIST_HEIGHT_GUESS, 900 - 111)).toBe(false); // 1440×900
    expect(shouldAutoExpand(head, BAND_LIST_HEIGHT_GUESS, 720)).toBe(false);
    expect(shouldAutoExpand(head, BAND_LIST_HEIGHT_GUESS, 0)).toBe(false);
  });

  it('dependency cycles are detected', () => {
    const mk = (id: string, dependsOn: string[]) => ({ id, dependsOn }) as Parameters<typeof cyclicInitiatives>[0][number];
    expect(cyclicInitiatives([mk('a', ['b']), mk('b', ['c']), mk('c', ['a']), mk('d', ['a'])]).sort()).toEqual(['a', 'b', 'c']);
    expect(cyclicInitiatives([mk('a', []), mk('b', ['a'])])).toEqual([]);
  });

  it('sign-offs are recorded with who and when, and can be withdrawn', () => {
    let data = setSignOff(emptyDeliverables(), 'define-agree', { at: '2026-11-09T10:00:00Z', by: 'Sato' });
    let r = byId('asis', { ...emptyProjectCtx(), deliverables: data })['define-agree']!;
    expect(r).toMatchObject({ done: true, signOff: { by: 'Sato' } });
    data = setSignOff(data, 'define-agree', null);
    r = byId('asis', { ...emptyProjectCtx(), deliverables: data })['define-agree']!;
    expect(r.done).toBe(false);
  });

  it('broken stored data falls back to empty instead of breaking the screen', () => {
    expect(normalizeDeliverables({ docs: 'x' })).toEqual(emptyDeliverables());
    expect(normalizeDeliverables(null)).toEqual(emptyDeliverables());
  });
});

describe('Draft with Copilot', () => {
  it('drafts are grounded in the pack: numbers, sources and owners come from the data', () => {
    const c = demoCtx();
    const asis = buildDraft({ step: 'asis', ctx: c, lang: 'ja', audience: 'internal' });
    expect(asis.problem).toContain('受注から出荷までが長い');
    expect(asis.problem).toContain('16 日'); // kpi-lead-time current
    expect(asis.sponsor).not.toMatch(/Okafor|オカフォー/); // roles, not personal names
    const tobe = buildDraft({ step: 'tobe', ctx: c, lang: 'ja', audience: 'internal' });
    expect(tobe.success).toContain('2027-03-31');
    expect(tobe.hypotheses).toContain('【仮説】');
    const plan = buildDraft({ step: 'deliverable', ctx: c, lang: 'en', audience: 'internal' });
    expect(plan.roadmap?.split('\n')[0]).toContain('2026-07-01'); // sorted by start
    expect(plan.businessCase).toContain('payback 0.4 years'); // 48M / 120M
    // The ask never asks to start an initiative that is already finished (init-dp-pilot is 100 % done).
    expect(plan.ask).not.toContain('Demand forecasting PoC');
    expect(plan.ask).toContain('2026-11-16');
  });

  it('for an external audience the draft leaves out internal items', () => {
    const c = demoCtx();
    const internalNames = pack.pack.entities.filter((e) => e.classification === 'internal').flatMap((e) => [e.name.ja, e.name.en]);
    for (const step of IMPROVEMENT_STEPS) {
      for (const lang of ['ja', 'en'] as const) {
        const text = draftToText(buildDraft({ step, ctx: c, lang, audience: 'external' }));
        for (const n of internalNames) expect(text.includes(n), `${step}/${lang}: ${n}`).toBe(false);
      }
    }
  });

  it('the "### field" format round-trips and unknown sections are dropped', () => {
    const fields = buildDraft({ step: 'kpi', ctx: demoCtx(), lang: 'en', audience: 'internal' });
    expect(parseDraftText('kpi', draftToText(fields))).toEqual(fields);
    expect(parseDraftText('kpi', '### formula\nA / B\n### bogus\nx\n## owner\nCFO')).toEqual({ formula: 'A / B', owner: 'CFO' });
  });

  it('applying a draft never overwrites what a person wrote unless asked', () => {
    let data = setField(emptyDeliverables(), 'asis', 'problem', { text: 'mine', author: 'human', updatedAt: 't' });
    const draft = { problem: 'ai problem', impact: 'ai impact', bogus: 'x' };
    const kept = applyDraft(data, 'asis', draft, { overwrite: false, mock: true, at: 't2' });
    expect(kept.applied).toEqual(['impact']);
    expect(kept.data.docs.asis?.problem?.text).toBe('mine');
    expect(kept.data.docs.asis?.impact).toEqual({ text: 'ai impact', author: 'ai', mock: true, updatedAt: 't2' });
    data = applyDraft(data, 'asis', draft, { overwrite: true, mock: false, at: 't3' }).data;
    expect(data.docs.asis?.problem).toEqual({ text: 'ai problem', author: 'ai', updatedAt: 't3' });
  });

  it('FR-338: approving an AI suggestion confirms the shown text as the person\'s, never a changed or human text', () => {
    const base = applyDraft(emptyDeliverables(), 'asis', { problem: 'ai problem', impact: 'ai impact' }, { overwrite: false, mock: true, at: 't1' }).data;
    const approved = approveField(base, 'asis', 'problem', 'ai problem', 'Sato', 't2');
    expect(approved.docs.asis?.problem).toEqual({ text: 'ai problem', author: 'human', updatedAt: 't2', approved: { at: 't2', by: 'Sato', mock: true } });
    expect(approved.docs.asis?.impact?.author).toBe('ai');
    expect(approveField(base, 'asis', 'problem', 'older text', 'Sato', 't2')).toBe(base);
    expect(approveField(approved, 'asis', 'problem', 'ai problem', 'Kato', 't3')).toBe(approved);
    expect(approveField(base, 'asis', 'owner', '', 'Sato', 't2')).toBe(base);
    expect(normalizeDeliverables(JSON.parse(JSON.stringify(approved))).docs.asis?.problem?.approved).toEqual({ at: 't2', by: 'Sato', mock: true });
  });

  afterEach(() => {
    setLiveTransport(null);
    setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
    writeLedger([]);
  });

  it('requires confirmation and never substitutes a mock on failure', async () => {
    const c = demoCtx();
    const input = { step: 'asis', ctx: c, lang: 'ja', audience: 'internal' } as const;
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, configured: true }));
    setLiveTransport(send);
    await expect(requestDeliverableDraft(input, draftRequest(input))).rejects.toThrow('notConfirmed');
    expect(send).not.toHaveBeenCalled();
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    await expect(requestDeliverableDraft(input, { ...draftRequest(input) })).rejects.toThrow('offline');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lets a complete Copilot draft take longer than the generic 60-second timeout', async () => {
    vi.useFakeTimers();
    try {
      const input = { step: 'asis', ctx: demoCtx(), lang: 'ja', audience: 'internal' } as const;
      const text = [
        ...STEP_DEFS.asis.fields.map((f) => `### ${f.id}\nfield`),
        ...STEP_DEFS.asis.todos.map((todo) => `### task-${todo.id}\n事実・根拠: 既知\n不足情報: 未確認\n仮説: 検証が必要\n選択肢: 1) 確認 2) 保留\n推奨: 確認\n理由: 根拠不足\n検証: 記録を照合\n影響: 要試算`),
      ].join('\n');
      setRuntimeSettingsProvider(() => ({ provider: 'copilotSdk', liveEnabled: true, sendConsent: true, configured: true }));
      setLiveTransport((call) => new Promise((resolve, reject) => {
        setTimeout(() => {
          if (call.timeoutMs < 75_000) reject(Object.assign(new Error('relay 504 timeout'), { status: 504 }));
          else resolve({ text, inputTokens: 100, outputTokens: 100 });
        }, Math.min(call.timeoutMs, 75_000));
      }));
      const result = expect(requestDeliverableDraft(input, {
        ...draftRequest(input),
      })).resolves.toMatchObject({ response: { mode: 'live' }, fields: { problem: 'field' } });
      await Promise.all([result, vi.advanceTimersByTimeAsync(150_000)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts complete live sections for every step and rejects incomplete responses', async () => {
    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    for (const step of IMPROVEMENT_STEPS) {
      writeLedger([]);
      const input = { step, ctx: demoCtx(), lang: 'ja', audience: 'internal' } as const;
      const sections = [
        ...STEP_DEFS[step].fields.map((f) => `### ${f.id}\nfield`),
        ...STEP_DEFS[step].todos.map((todo) => `### task-${todo.id}\n事実・根拠: 既知\n不足情報: 未確認\n仮説: 検証が必要\n選択肢: 1) 確認 2) 保留\n推奨: 確認\n理由: 根拠不足\n検証: 記録を照合\n影響: 要試算`),
      ].join('\n');
      setLiveTransport(async () => ({ text: sections, inputTokens: 10, outputTokens: 10 }));
      const result = await requestDeliverableDraft(input, { ...draftRequest(input) });
      expect(result.response.mode).toBe('live');
      expect(Object.keys(result.tasks)).toHaveLength(STEP_DEFS[step].todos.length);
      expect(Object.keys(result.fields)).toHaveLength(STEP_DEFS[step].fields.length);
    }
    writeLedger([]);
    const input = { step: 'asis', ctx: demoCtx(), lang: 'ja', audience: 'internal' } as const;
    setLiveTransport(async () => ({ text: '### problem\nincomplete', inputTokens: 10, outputTokens: 10 }));
    await expect(requestDeliverableDraft(input, { ...draftRequest(input) })).rejects.toThrow('必要な項目がありません');
    writeLedger([]);
    const incompleteTasks = [
      ...STEP_DEFS.asis.fields.map((f) => `### ${f.id}\nfield`),
      ...STEP_DEFS.asis.todos.map((todo) => `### task-${todo.id}\n事実・根拠: 既知\n不足情報: 未確認\n仮説: 検証が必要\n選択肢: 1) 確認 2) 保留\n推奨: 確認\n理由: 根拠不足\n影響: 要試算`),
    ].join('\n');
    setLiveTransport(async () => ({ text: incompleteTasks, inputTokens: 10, outputTokens: 10 }));
    await expect(requestDeliverableDraft(input, { ...draftRequest(input) })).rejects.toThrow('task-define-causes');
  });

  it('keeps task sections separate and links missing causes to the issue', () => {
    const raw = clone();
    const issue = raw.entities.find((e) => e.kind === 'issue')!;
    if (issue.kind !== 'issue') throw new Error('Expected issue');
    issue.causeIds = [];
    const ctx = demoCtx({ pack: loadPack(raw) });
    expect(buildTaskDrafts({ step: 'asis', ctx, lang: 'en', audience: 'internal' })['define-causes']).toContain('not enough evidence');
    expect(parseTaskDrafts('asis', '### task-define-causes\ncheck\n### task-bogus\nignore\n### problem\nfield')).toEqual({ 'define-causes': 'check' });
    expect(parseDraftText('asis', '### problem\nfield\n### task-define-causes\ncheck')).toEqual({ problem: 'field' });
    const cause = byId('asis', ctx)['define-causes']!;
    const route = parseHash(todoHref(cause));
    expect(route.query.get('edit')).toBe(issue.id);
    expect(route.query.get('field')).toBe('causeIds');
  });

  it('excludes internal entities and project free text for external audiences', () => {
    const c = demoCtx();
    const input = { step: 'asis', ctx: c, lang: 'en', audience: 'external' } as const;
    const request = draftRequest(input);
    expect(request.entities).toEqual(draftEntities(c, 'external'));
    expect(request.entities?.every((e) => e.classification === 'shareable' && e.sourceIds.every((id) => c.pack.byId.get(id)?.classification === 'shareable'))).toBe(true);
    expect(draftPrompt(input)).toContain('Project data: null');
    for (const entity of c.pack.pack.entities.filter((e) => e.classification === 'internal')) {
      expect(request.prompt).not.toContain(entity.id);
    }
  });
});

describe('issue qualification (FR-347: Khalsa "Should they do it?")', () => {
  /** The demo pack plus one low-priority issue that has no solution and no KPI. */
  const extraCtx = (): CheckContext => {
    const raw = clone();
    raw.entities.push({ ...raw.entities.find((e) => e.kind === 'issue')!, id: 'issue-extra', impact: 1, feasibility: 1, causeIds: [], kpiIds: [] } as never);
    return demoCtx({ pack: loadPack(raw) });
  };
  const issueIds = (c: CheckContext) => c.pack.pack.entities.filter((e) => e.kind === 'issue').map((e) => e.id);

  it('an issue nobody qualified is a yellow light: the As-Is stays open until every issue has a verdict', () => {
    const c = demoCtx();
    const open = byId('asis', c)['asis-qualify']!;
    expect(open.outcome).toMatchObject({ ok: false, code: 'issuesUnqualified', vars: { n: issueIds(c).length } });
    expect(open.outcome?.refs?.map((r) => (r.type === 'entity' ? r.id : '')).sort()).toEqual(issueIds(c).sort());
    let data = qualifyAll(c.deliverables, c);
    data = setQualification(data, issueIds(c)[0]!, { verdict: 'no', reason: 'Worth less than it costs', at: TODAY, by: 'Tester' });
    expect(byId('asis', { ...c, deliverables: data })['asis-qualify']!.outcome).toMatchObject({ ok: true, code: 'issuesQualified', vars: { pursue: issueIds(c).length - 1, out: 1 } });
  });

  it('a "no" or "not now" takes the issue off the path to a solution, and the checks say how many were left out', () => {
    const c = extraCtx();
    expect(byId('solution', c)['sol-issues']!.outcome).toMatchObject({ ok: false, code: 'issuesWithoutSolution', refs: [{ type: 'entity', id: 'issue-extra' }] });
    expect(byId('kpi', c)['kpi-coverage']!.outcome?.code).toBe('issuesNotMeasured');
    for (const verdict of ['no', 'notNow'] as const) {
      const data = setQualification(c.deliverables, 'issue-extra', { verdict, reason: 'One complaint a year; not worth a project', at: TODAY, by: 'Tester' });
      const q = { ...c, deliverables: data };
      expect(byId('solution', q)['sol-issues']!.outcome, verdict).toMatchObject({ ok: true, code: 'pursuedIssuesSolved', vars: { out: 1 } });
      expect(byId('kpi', q)['kpi-coverage']!.outcome, verdict).toMatchObject({ ok: true, code: 'pursuedIssuesTracked', vars: { out: 1 } });
    }
    // A "pursue" keeps it on the path: it still needs a solution and a KPI.
    const pursued = setQualification(c.deliverables, 'issue-extra', { verdict: 'pursue', reason: 'Lost two key accounts', different: 'New CFO sponsors it', at: TODAY, by: 'Tester' });
    expect(byId('solution', { ...c, deliverables: pursued })['sol-issues']!.done).toBe(false);
  });

  it('the top-priority check moves to the best pursued issue; when every issue is qualified out, that "no" is the result', () => {
    const c = demoCtx();
    const [first, second] = rankedIssues(c.pack);
    const data = setQualification(c.deliverables, first!.id, { verdict: 'notNow', reason: 'Waiting for the ERP upgrade', at: TODAY, by: 'Tester' });
    const top = byId('tobe', { ...c, deliverables: data })['uc-top-issue']!.outcome!;
    expect(top.ok ? top.vars?.issue : top.refs?.[0]).toEqual(top.ok ? second!.id : { type: 'entity', id: second!.id });
    const none = { ...c, deliverables: qualifyAll(c.deliverables, c, 'no') };
    expect(byId('asis', none)['asis-qualify']!.done).toBe(true);
    for (const [step, id] of [['tobe', 'uc-top-issue'], ['kpi', 'kpi-coverage'], ['solution', 'sol-issues']] as const) {
      expect(byId(step, none)[id]!.outcome?.code, id).toBe('noPursuedIssues');
    }
  });

  it('a verdict needs its evidence; "pursue" also needs what is different this time; a broken stored entry is dropped alone', () => {
    const base = { at: TODAY, by: 'Tester' };
    expect(() => setQualification(emptyDeliverables(), 'issue-x', { verdict: 'no', reason: '   ', ...base })).toThrow();
    expect(() => setQualification(emptyDeliverables(), 'issue-x', { verdict: 'pursue', reason: 'Costs 40M a year', ...base })).toThrow();
    const ok = setQualification(emptyDeliverables(), 'issue-x', { verdict: 'pursue', reason: ' Costs 40M a year ', different: 'Budget approved', ...base });
    expect(ok.qualifications?.['issue-x']?.reason).toBe('Costs 40M a year');
    const stored = JSON.parse(JSON.stringify({ ...ok, qualifications: { ...ok.qualifications, 'issue-y': { verdict: 'maybe', reason: 'x', ...base } } }));
    expect(Object.keys(normalizeDeliverables(stored).qualifications ?? {})).toEqual(['issue-x']);
    expect(setQualification(ok, 'issue-x', null).qualifications).toEqual({});
  });

  it('the draft takes its scope from the verdicts, quotes reasons only for an internal audience, and the live prompt carries each verdict', () => {
    const c = demoCtx();
    const out = rankedIssues(c.pack)[0]!;
    const data = setQualification(qualifyAll(c.deliverables, c), out.id, { verdict: 'no', reason: 'Competitors are equally slow', at: TODAY, by: 'Tester' });
    const q = { ...c, deliverables: data };
    const internal = buildDraft({ step: 'asis', ctx: q, lang: 'en', audience: 'internal' });
    expect(internal.scopeOut).toContain(`${out.name.en}: no (Competitors are equally slow)`);
    expect(internal.scopeIn).not.toContain(out.name.en);
    expect(internal.constraints).toContain('what is different this time (Budget is now approved)');
    const external = buildDraft({ step: 'asis', ctx: q, lang: 'en', audience: 'external' });
    expect(external.scopeOut).not.toContain('Competitors are equally slow');
    expect(external.constraints).not.toContain('Budget is now approved');
    const prompt = draftPrompt({ step: 'solution', ctx: q, lang: 'en', audience: 'external' });
    expect(prompt).toContain(`"id":"${out.id}","kind":"issue"`);
    expect(prompt).toMatch(new RegExp(`"id":"${out.id}"[^}]*"qualification":"no"`));
    expect(prompt).not.toContain('Competitors are equally slow');
  });

  it('dashboard tiles give the same verdict as the criteria they stand for', () => {
    const c = extraCtx();
    const data = setQualification(qualifyAll(c.deliverables, c), 'issue-extra', { verdict: 'no', reason: 'Rare', at: TODAY, by: 'Tester' });
    const q = { ...c, deliverables: data };
    const asis = stepDashboard('asis', q);
    expect(asis.tiles.find((t) => t.id === 'issuesQualified')).toMatchObject({ value: issueIds(c).length, total: issueIds(c).length, todoId: 'asis-qualify' });
    expect(asis.detail.step === 'asis' && asis.detail.issues.find((i) => i.id === 'issue-extra')?.verdict).toBe('no');
    const sol = stepDashboard('solution', q);
    const tile = sol.tiles.find((t) => t.id === 'issuesSolved')!;
    expect(tile).toMatchObject({ value: issueIds(c).length - 1, total: issueIds(c).length - 1 });
    expect(sol.results.find((r) => r.todo.id === 'sol-issues')!.done).toBe(true);
    expect(sol.detail.step === 'solution' && sol.detail.qualifiedOut).toBe(1);
    expect(stepDashboard('kpi', q).tiles.find((t) => t.id === 'issuesTracked')).toMatchObject({ value: issueIds(c).length - 1, total: issueIds(c).length - 1 });
  });

  it('the criterion links to the issue table of the As-Is dashboard', () => {
    const r = evaluateStep('asis', demoCtx()).find((x) => x.todo.id === 'asis-qualify')!;
    const { path, query } = parseHash(todoHref(r));
    expect(path).toBe('/step');
    expect(query.get('step')).toBe('asis');
    expect(query.get('target')).toBe('step-dash-issues');
  });
});
