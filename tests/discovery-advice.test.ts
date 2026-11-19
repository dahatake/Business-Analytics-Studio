import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { translate, type MessageKey } from '../src/i18n/core.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../src/state/projects.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { ADVICE_PRINCIPLES, discoveryAdvice, type AdviceItem } from '../src/modules/project/discoveryAdvice.ts';
import { applyDraft, emptyDeliverables, evaluateStep, rankedIssues, setPaybackLimit, setQualification, type CheckContext, type DeliverableData } from '../src/modules/project/deliverables.ts';
import { buildDraft } from '../src/modules/project/deliverableDraft.ts';

const AT = '2026-11-09T09:00:00Z';
const pack = loadPack(samplePack);

const demoCtx = (over: Partial<CheckContext> = {}): CheckContext => ({
  pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(),
  deliverables: emptyDeliverables(), today: '2026-11-09', ...over,
});
const emptyCtx = (): CheckContext => ({
  pack, discussion: { themes: [], records: [] }, kpi: { kpis: [], okrs: [] }, analysis: { analyses: [], activeId: null },
  useCases: [], deliverables: emptyDeliverables(), today: '2026-11-09',
});
const ids = (step: ImprovementStep, c: CheckContext) => discoveryAdvice(step, c).map((i) => i.id);
const find = (step: ImprovementStep, c: CheckContext, id: string): AdviceItem | undefined => discoveryAdvice(step, c).find((i) => i.id === id);

function qualify(data: DeliverableData, c: CheckContext, verdict: 'pursue' | 'no' = 'pursue', only?: string[]): DeliverableData {
  for (const i of c.pack.pack.entities.filter((e) => e.kind === 'issue' && (!only || only.includes(e.id)))) {
    data = setQualification(data, i.id, { verdict, reason: 'The gap costs 40M a year', ...(verdict === 'pursue' ? { different: 'Budget approved' } : {}), at: AT, by: 'T' });
  }
  return data;
}
function drafted(c: CheckContext): DeliverableData {
  let data = c.deliverables;
  for (const step of IMPROVEMENT_STEPS) data = applyDraft(data, step, buildDraft({ step, ctx: c, lang: 'ja', audience: 'internal' }), { overwrite: false, mock: false, at: AT }).data;
  return data;
}

describe('step advice from Khalsa (FR-351)', () => {
  it('every step lists yellow lights first, ends with the next conversation, and refers only to existing entities', () => {
    for (const c of [emptyCtx(), demoCtx()]) {
      for (const step of IMPROVEMENT_STEPS) {
        const items = discoveryAdvice(step, c);
        const tones = items.map((i) => i.tone);
        expect(tones, step).toEqual([...tones].sort((a, b) => ['yellow', 'green', 'info'].indexOf(a) - ['yellow', 'green', 'info'].indexOf(b)));
        expect(items.some((i) => i.id === `ask.${step}`), step).toBe(true);
        expect(new Set(items.map((i) => i.id)).size, step).toBe(items.length);
        for (const i of items) for (const id of i.refs) expect(c.pack.byId.has(id), `${step}:${i.id}:${id}`).toBe(true);
        expect(items.some((i) => i.tone === 'yellow') !== items.some((i) => i.tone === 'green'), step).toBe(true);
      }
    }
  });

  it('every message, principle and tone exists in both languages with the same placeholders', () => {
    const solved = demoCtx();
    const declined = demoCtx({ deliverables: qualify(emptyDeliverables(), solved, 'no') });
    const seen = new Set<string>();
    for (const c of [emptyCtx(), demoCtx(), declined, demoCtx({ deliverables: drafted(demoCtx()) })]) {
      for (const step of IMPROVEMENT_STEPS) for (const i of discoveryAdvice(step, c)) {
        seen.add(`proj.advice.item.${i.id}`);
        seen.add(`proj.advice.tone.${i.tone}`);
        seen.add(`proj.advice.principle.${i.principle}`);
        const vars = { step: 'x', status: 'x', ...i.vars };
        for (const lang of ['ja', 'en'] as const) expect(translate(lang, `proj.advice.item.${i.id}` as MessageKey, vars), `${lang}:${i.id}`).not.toMatch(/\{\w+\}/);
      }
    }
    for (const p of ADVICE_PRINCIPLES) seen.add(`proj.advice.principle.${p}`);
    for (const key of seen) {
      for (const lang of ['ja', 'en'] as const) expect(translate(lang, key as MessageKey), `${lang}:${key}`).not.toBe(key);
    }
  });

  it('As-Is: unqualified issues, missing KPIs and baselines and unsourced claims are yellow; qualifying clears the first', () => {
    const c = emptyCtx();
    const open = find('asis', c, 'unqualified')!;
    expect(open).toMatchObject({ tone: 'yellow', principle: 'qualify', vars: { n: rankedIssues(pack).length } });
    expect(open.refs.length).toBe(rankedIssues(pack).length);
    expect(ids('asis', demoCtx({ deliverables: qualify(emptyDeliverables(), c) }))).not.toContain('unqualified');
    // A verdict whose reason has neither a number nor a 1-10 rating asks to quantify.
    let data = qualify(emptyDeliverables(), c);
    const first = rankedIssues(pack)[0]!.id;
    data = setQualification(data, first, { verdict: 'pursue', reason: 'It feels important', different: 'New sponsor', at: AT, by: 'T' });
    expect(find('asis', demoCtx({ deliverables: data }), 'reasonNoNumber')).toMatchObject({ vars: { n: 1 }, refs: [first] });
    // The same data in an unmeasured pack is caught: drop every KPI link.
    const raw = JSON.parse(JSON.stringify(samplePack)) as typeof samplePack;
    for (const e of raw.entities) if (e.kind === 'issue') { e.kpiIds = []; e.sourceIds = []; }
    const bare = demoCtx({ pack: loadPack(raw) });
    expect(find('asis', bare, 'unmeasured')).toMatchObject({ tone: 'yellow', principle: 'measure', vars: { n: rankedIssues(pack).length } });
    expect(find('asis', bare, 'unsourced')?.principle).toBe('evidence');
  });

  it('a "no" is advice too: declined issues need no solution, and a solution that only solves declined issues is flagged', () => {
    const c = demoCtx();
    const [first] = rankedIssues(pack);
    const solutionFor = pack.pack.entities.find((e) => e.kind === 'solution' && e.issueIds.includes(first!.id))!;
    const onlyFirst = pack.pack.entities.filter((e) => e.kind === 'solution' && e.issueIds.every((id) => id === first!.id)).map((e) => e.id);
    const q = demoCtx({ deliverables: qualify(qualify(emptyDeliverables(), c), c, 'no', [first!.id]) });
    expect(find('solution', q, 'declined')).toMatchObject({ tone: 'info', vars: { n: 1 } });
    expect(find('solution', q, 'orphanSolution')?.refs.sort()).toEqual(onlyFirst.sort());
    expect(onlyFirst).toContain(solutionFor.id);
    expect(find('solution', c, 'orphanSolution')).toBeUndefined();
    // Everything declined: the later steps say so instead of nagging for solutions.
    const none = demoCtx({ deliverables: qualify(emptyDeliverables(), c, 'no') });
    for (const step of ['tobe', 'kpi', 'solution', 'deliverable'] as const) expect(find(step, none, 'noPursued')?.tone, step).toBe('info');
    expect(find('asis', none, 'allDeclined')?.principle).toBe('qualify');
  });

  it('advice agrees with the exit criteria: it is yellow exactly while the criterion it mirrors is open', () => {
    const base = demoCtx();
    const mirrors: [ImprovementStep, string, string][] = [
      ['asis', 'unqualified', 'asis-qualify'], ['asis', 'unmeasured', 'define-kpi-link'], ['asis', 'mismatch', 'asis-reconcile'],
      ['tobe', 'topUncovered', 'uc-top-issue'], ['kpi', 'kpiInvalid', 'kpi-valid'], ['kpi', 'kpiPast', 'kpi-deadline'], ['kpi', 'untracked', 'kpi-coverage'],
      ['solution', 'unsolved', 'sol-issues'], ['solution', 'noContribution', 'sol-contribution'],
      ['deliverable', 'noOwner', 'plan-owner'], ['deliverable', 'schedule', 'plan-schedule'], ['deliverable', 'paybackOver', 'plan-payback'], ['deliverable', 'chain', 'dlv-trace'],
      ['deliverable', 'noDecision', 'plan-decision'],
    ];
    const qualified = qualify(emptyDeliverables(), base);
    const variants = [emptyCtx(), base, demoCtx({ deliverables: qualified }), demoCtx({ deliverables: qualify(qualified, base, 'no', [rankedIssues(pack)[0]!.id]) })];
    for (const c of variants) {
      for (const [step, id, todo] of mirrors) {
        const done = evaluateStep(step, c).find((r) => r.todo.id === todo)!.done;
        const yellow = find(step, c, id)?.tone === 'yellow';
        // A criterion can also fail for a reason the advice does not cover (e.g. no issues), but advice never fires while it passes.
        if (done) expect(yellow, `${step}:${id} fires while ${todo} passes`).toBe(false);
      }
    }
    for (const [step, id, todo] of [['asis', 'unqualified', 'asis-qualify'], ['kpi', 'untracked', 'kpi-coverage'], ['solution', 'unsolved', 'sol-issues'], ['deliverable', 'noOwner', 'plan-owner']] as const) {
      const c = variants[0]!;
      if (!evaluateStep(step, c).find((r) => r.todo.id === todo)!.done) expect(find(step, c, id)?.tone, `${step}:${id}`).toBe('yellow');
    }
  });

  it('Resources and Decision: the payback limit is an assumption until the project records its own; the ask and the RACI must be written', () => {
    const c = demoCtx();
    expect(find('deliverable', c, 'paybackAssumed')).toMatchObject({ tone: 'info', principle: 'resources', vars: { years: 3 } });
    const set = demoCtx({ deliverables: setPaybackLimit(emptyDeliverables(), { value: 4, at: AT, by: 'T' }) });
    expect(find('deliverable', set, 'paybackAssumed')).toBeUndefined();
    expect(find('deliverable', c, 'noAsk')?.principle).toBe('decision');
    expect(find('deliverable', c, 'noRaci')?.tone).toBe('yellow');
    const written = demoCtx({ deliverables: drafted(c) });
    expect(find('deliverable', written, 'noAsk')).toBeUndefined();
    expect(find('deliverable', written, 'noRaci')).toBeUndefined();
  });

  it('unapproved AI text and an incomplete previous step are flagged as guesses; the person\'s approval and finished work are not', () => {
    const c = demoCtx();
    const ai = demoCtx({ deliverables: drafted(c) });
    const fields = Object.keys(ai.deliverables.docs.asis ?? {}).length;
    expect(find('asis', ai, 'aiUnconfirmed')).toMatchObject({ tone: 'yellow', principle: 'noGuess', vars: { n: fields } });
    expect(find('asis', c, 'aiUnconfirmed')).toBeUndefined();
    expect(find('tobe', c, 'upstream')).toMatchObject({ tone: 'info', vars: { step: 'asis' } });
    expect(find('asis', c, 'upstream')).toBeUndefined();
  });

  it('with nothing open the step is green and still asks for the conversation the data cannot replace', () => {
    const c = demoCtx();
    const quiet = discoveryAdvice('asis', demoCtx({ deliverables: qualify(emptyDeliverables(), c) }));
    expect(quiet.some((i) => i.tone === 'yellow')).toBe(false);
    expect(quiet.some((i) => i.id === 'clear' && i.tone === 'green')).toBe(true);
    expect(quiet.at(-1)).toMatchObject({ id: 'ask.asis', tone: 'info', principle: 'inquiry', href: null });
  });
});
