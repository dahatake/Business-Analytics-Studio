import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { translate, type MessageKey } from '../src/i18n/core.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../src/state/projects.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import {
  applyDraft, cyclicInitiatives, emptyDeliverables, evaluateStep, fieldHintKey, fieldKey, inputKey, normalizeDeliverables, PAYBACK_MAX_YEARS, paybackLimit,
  paybackYears, progressOf, resultKey, setField, setPaybackLimit, setSignOff, statedValues, STEP_DEFS, todoKey, todoWhyKey, valueMismatches,
  type CheckContext, type DeliverableData,
} from '../src/modules/project/deliverables.ts';
import type { EntityOf } from '../src/data/schema.ts';
import { isUseApproved } from '../src/ai/client.ts';
import { C03_TABLE, isApproved } from '../src/ai/policy.ts';
import { BAND_LIST_HEIGHT_GUESS, shouldAutoExpand } from '../src/modules/project/deliverablesUi.tsx';
import { buildDraft, draftPrompt, draftToText, parseDraftText, requestDeliverableDraft } from '../src/modules/project/deliverableDraft.ts';
import { requestAnalysisDraft } from '../src/modules/project/mocks.ts';

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

describe('step deliverables: definitions', () => {
  it('defines a deliverable for each of the five steps with fields, exit criteria and at least one human sign-off', () => {
    expect(Object.keys(STEP_DEFS).sort()).toEqual([...IMPROVEMENT_STEPS].sort());
    for (const s of IMPROVEMENT_STEPS) {
      const d = STEP_DEFS[s];
      expect(d.fields.length, s).toBeGreaterThanOrEqual(5);
      expect(d.todos.filter((x) => x.kind === 'auto').length, s).toBeGreaterThanOrEqual(3);
      expect(d.todos.filter((x) => x.kind === 'manual').length, s).toBe(1);
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
    const ctxs = [emptyProjectCtx(), demoCtx(), demoCtx({ deliverables: drafted(demoCtx()) }), { ...emptyProjectCtx(), pack: loadPack(broken) }];
    for (const c of ctxs) for (const s of IMPROVEMENT_STEPS) for (const r of evaluateStep(s, c)) if (r.outcome) keys.push(resultKey(r.outcome.code));
    for (const k of new Set(keys)) {
      for (const lang of ['ja', 'en'] as const) expect(typeof translate(lang, k as MessageKey), `${lang}:${k}`).toBe('string');
    }
  });
});

describe('step deliverables: validity checks', () => {
  it('a new, empty project fails every project-data check and every deliverable field check', () => {
    const c = emptyProjectCtx();
    const define = byId('define', c);
    expect(define['define-sources']!.done).toBe(true); // pack data is shared
    expect(define['define-decision']!.outcome?.code).toBe('noThemes');
    expect(define['define-doc']!.outcome).toMatchObject({ ok: false, code: 'docMissing', vars: { empty: 7, vague: 0 } });
    expect(define['define-doc']!.outcome?.refs).toHaveLength(7);
    expect(define['define-agree']!.done).toBe(false);
    expect(byId('asis', c)['asis-framework']!.outcome?.code).toBe('noAnalysis');
    expect(byId('kpi', c)['kpi-valid']!.outcome?.code).toBe('noProjectKpis');
    expect(byId('kpi', c)['kpi-coverage']!.outcome?.code).toBe('issuesNotMeasured');
    expect(byId('kpi', c)['kpi-okr']!.outcome?.code).toBe('noOkr');
    expect(byId('usecase', c)['uc-registered']!.outcome?.code).toBe('noUseCases');
    expect(byId('plan', c)['plan-decision']!.outcome?.code).toBe('noPlanDecision');
    for (const s of IMPROVEMENT_STEPS) expect(progressOf(evaluateStep(s, c)).complete, s).toBe(false);
  });

  it('the demo meets every data check; only the deliverable fields and the sign-offs are left', () => {
    const c = demoCtx();
    for (const s of IMPROVEMENT_STEPS) {
      const open = evaluateStep(s, c).filter((r) => !r.done).map((r) => r.todo.id);
      expect(open.sort(), s).toEqual(STEP_DEFS[s].todos.filter((x) => x.kind === 'manual' || x.id.endsWith('-doc')).map((x) => x.id).sort());
    }
  });

  it('after "Draft with Copilot" and the sign-offs every step is complete (ja and en)', () => {
    for (const lang of ['ja', 'en'] as const) {
      const base = demoCtx();
      let data = drafted(base, lang);
      for (const s of IMPROVEMENT_STEPS) for (const x of STEP_DEFS[s].todos.filter((y) => y.kind === 'manual')) data = setSignOff(data, x.id, { at: '2026-11-09T10:00:00Z', by: 'Tester' });
      const c = { ...base, deliverables: data };
      for (const s of IMPROVEMENT_STEPS) {
        const failed = evaluateStep(s, c).filter((r) => !r.done).map((r) => `${r.todo.id}:${r.outcome?.code}`);
        expect(failed, `${lang}:${s}`).toEqual([]);
      }
    }
  });

  it('field checks reject statements without numbers or deadlines (SMART)', () => {
    let data = emptyDeliverables();
    const at = '2026-11-09T00:00:00Z';
    for (const f of STEP_DEFS.define.fields) data = setField(data, 'define', f.id, { text: 'TBD', author: 'human', updatedAt: at });
    let r = byId('define', { ...emptyProjectCtx(), deliverables: data })['define-doc']!;
    expect(r.outcome).toMatchObject({ ok: false, code: 'docVague', vars: { empty: 0, vague: 3 } });
    expect(r.outcome?.refs?.map((x) => (x.type === 'field' ? x.id : '')).sort()).toEqual(['impact', 'problem', 'success']);
    data = setField(data, 'define', 'problem', { text: 'Lead time 16 days', author: 'human', updatedAt: at });
    data = setField(data, 'define', 'impact', { text: '¥120M a year', author: 'human', updatedAt: at });
    data = setField(data, 'define', 'success', { text: '10 days', author: 'human', updatedAt: at });
    r = byId('define', { ...emptyProjectCtx(), deliverables: data })['define-doc']!;
    expect(r.outcome).toMatchObject({ ok: false, code: 'docVague', vars: { vague: 1 } }); // success has no deadline
    data = setField(data, 'define', 'success', { text: '10 days by 2027-03-31', author: 'human', updatedAt: at });
    expect(byId('define', { ...emptyProjectCtx(), deliverables: data })['define-doc']!.done).toBe(true);
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
    const define = byId('define', c);
    expect(define['define-sources']!.done).toBe(false);
    expect(refIds(define['define-sources']!)).toEqual(['issue-energy']);
    expect(refIds(define['define-causes']!)).toEqual(['issue-energy']);
    const plan = byId('plan', c);
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
    const u = byId('usecase', c);
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
    const demo = byId('plan', demoCtx())['plan-payback']!;
    expect(demo.outcome).toMatchObject({ ok: true, code: 'paybackOk', vars: { max: PAYBACK_MAX_YEARS } });
    const strict = setPaybackLimit(emptyDeliverables(), { value: 1, at: '2026-11-09T10:00:00Z', by: 'CFO office' });
    expect(paybackLimit(strict)).toBe(1);
    const failing = byId('plan', { ...demoCtx(), deliverables: strict })['plan-payback']!;
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
    let r = byId('define', { ...emptyProjectCtx(), deliverables: data })['define-agree']!;
    expect(r).toMatchObject({ done: true, signOff: { by: 'Sato' } });
    data = setSignOff(data, 'define-agree', null);
    r = byId('define', { ...emptyProjectCtx(), deliverables: data })['define-agree']!;
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
    const define = buildDraft({ step: 'define', ctx: c, lang: 'ja', audience: 'internal' });
    expect(define.problem).toContain('受注から出荷までが長い');
    expect(define.problem).toContain('16 日'); // kpi-lead-time current
    expect(define.success).toContain('2027-03-31');
    expect(define.hypotheses).toContain('【仮説】');
    expect(define.sponsor).not.toMatch(/Okafor|オカフォー/); // roles, not personal names
    const plan = buildDraft({ step: 'plan', ctx: c, lang: 'en', audience: 'internal' });
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
    let data = setField(emptyDeliverables(), 'define', 'problem', { text: 'mine', author: 'human', updatedAt: 't' });
    const draft = { problem: 'ai problem', impact: 'ai impact', bogus: 'x' };
    const kept = applyDraft(data, 'define', draft, { overwrite: false, mock: true, at: 't2' });
    expect(kept.applied).toEqual(['impact']);
    expect(kept.data.docs.define?.problem?.text).toBe('mine');
    expect(kept.data.docs.define?.impact).toEqual({ text: 'ai impact', author: 'ai', mock: true, updatedAt: 't2' });
    data = applyDraft(data, 'define', draft, { overwrite: true, mock: false, at: 't3' }).data;
    expect(data.docs.define?.problem).toEqual({ text: 'ai problem', author: 'ai', updatedAt: 't3' });
  });

  it('goes through the C-03 gate; without approval the mock answers and says why', async () => {
    const c = demoCtx();
    const { response, fields } = await requestDeliverableDraft({ step: 'asis', ctx: c, lang: 'ja', audience: 'internal' });
    expect(response.mode).toBe('mock');
    expect(response.blockedReasons).toContain('c03NotApproved');
    expect(Object.keys(fields).sort()).toEqual(STEP_DEFS.asis.fields.map((f) => f.id).sort());
    expect(draftPrompt({ step: 'asis', ctx: c, lang: 'en', audience: 'internal' })).toContain('### <fieldId>');
    // Mocks are picked by use, so the full field set above came from the 'deliverableDraft' mock. Drafts have their own
    // C-03 row (D-9), still blocked, so approving another use cannot turn them live.
    expect(isApproved(C03_TABLE.deliverableDraft)).toBe(false);
    expect(isUseApproved('deliverableDraft')).toBe(false);
    expect(C03_TABLE.deliverableDraft.openQuestions.join(' ')).toContain('D-9');
    // The analysis draft keeps its own 'structure' mock.
    const analysis = await requestAnalysisDraft('swot', 'ja', []);
    expect(analysis.items.length).toBeGreaterThan(0);
  });
});
