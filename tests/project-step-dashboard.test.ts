import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { translate, type MessageKey } from '../src/i18n/core.ts';
import { IMPROVEMENT_STEPS } from '../src/state/projects.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { applyDraft, emptyDeliverables, STEP_DEFS, type CheckContext } from '../src/modules/project/deliverables.ts';
import { buildDraft } from '../src/modules/project/deliverableDraft.ts';
import { stepDashboard, tileTone, TOP_ISSUES } from '../src/modules/project/stepDashboard.ts';
import { emptyStrategy, upsertContribution } from '../src/modules/project/strategy.ts';
import { approveGeneratedBrief, briefText, buildStepBrief, parseBrief, requestLiveStepBrief, requestStepBrief, stepBriefRequest, verifyNumbers } from '../src/modules/project/stepBrief.ts';
import { setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';

const TODAY = '2026-11-09';
const clone = () => JSON.parse(JSON.stringify(samplePack)) as typeof samplePack;
const pack = loadPack(samplePack);

const demoCtx = (p = pack): CheckContext => ({
  pack: p,
  discussion: demoDiscussion(),
  kpi: demoKpis(p.pack),
  analysis: demoAnalyses(p.pack),
  useCases: demoUseCases(),
  deliverables: emptyDeliverables(),
  today: TODAY,
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

function draftedCtx(): CheckContext {
  const c = demoCtx();
  let data = c.deliverables;
  for (const step of IMPROVEMENT_STEPS) {
    data = applyDraft(data, step, buildDraft({ step, ctx: c, lang: 'ja', audience: 'internal' }), { overwrite: false, mock: true, at: '2026-11-09T09:00:00Z' }).data;
  }
  return { ...c, deliverables: data, objectives: [{ id: 'o1', text: 'Grow margin' }], projectObjectiveIds: ['o1'] };
}

const contexts: [string, () => CheckContext][] = [['demo', () => demoCtx()], ['drafted', draftedCtx], ['empty project', emptyProjectCtx]];

it('D-51: a live summary missing sections is repaired for those sections only', async () => {
  const c = demoCtx();
  const b = buildStepBrief(stepDashboard('kpi', c), c, 'en', 'internal');
  const full = briefText(b);
  const withoutActions = full.replace(/### actions[\s\S]*?(?=### caveats)/, '');
  const prompts: string[] = [];
  setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
  setLiveTransport(async (call) => {
    prompts.push(call.prompt);
    return { text: call.prompt.includes('REPAIR:') ? '### actions\n- Review the KPI owners' : withoutActions, inputTokens: 5, outputTokens: 5 };
  });
  try {
    const result = await requestLiveStepBrief(b, stepBriefRequest(b, c, 'en'));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Write ONLY these sections');
    expect(prompts[1]).toContain('actions');
    expect(result.content.actions).toEqual(['Review the KPI owners']);
    expect(result.content.answer).toBe(parseBrief(full).answer);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 10 });
  } finally {
    setLiveTransport(null);
    setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
    writeLedger([]);
  }
});

it('requires explicit summary approval and refuses stale, different-language or unverified drafts', async () => {
  const c = demoCtx();
  const b = buildStepBrief(stepDashboard('kpi', c), c, 'en', 'internal');
  const generated = await requestStepBrief(b, c, 'en');
  expect(generated.approval).toBeUndefined();
  const approved = approveGeneratedBrief(generated, b, 'en', 'Reviewer', '2026-11-19');
  expect(approved.approval).toEqual({ by: 'Reviewer', at: '2026-11-19' });
  expect(generated.approval).toBeUndefined();
  expect(() => approveGeneratedBrief(generated, { ...b, hash: 'changed' }, 'en', '', 'now')).toThrow();
  expect(() => approveGeneratedBrief(generated, b, 'ja', '', 'now')).toThrow();
  expect(() => approveGeneratedBrief({ ...generated, check: { ...generated.check, unverified: ['99999'] } }, b, 'en', '', 'now')).toThrow();
  expect(c.deliverables.signOffs).toEqual({});
});

describe('step dashboard (FR-317)', () => {
  it.each(contexts)('every criterion tile agrees with its exit criterion (%s)', (_, make) => {
    const c = make();
    for (const step of IMPROVEMENT_STEPS) {
      const d = stepDashboard(step, c);
      const todoIds = STEP_DEFS[step].todos.map((t) => t.id);
      for (const tile of d.tiles) {
        if (!tile.todoId) continue;
        expect(todoIds, `${step}/${tile.id}`).toContain(tile.todoId);
        const done = d.results.find((r) => r.todo.id === tile.todoId)!.done;
        const tone = tileTone(tile, d.results);
        expect(tone === 'ok', `${step}/${tile.id} tone`).toBe(done);
        const where = `${step}/${tile.id} ${tile.value}/${tile.total} done=${done}`;
        if (tile.kind === 'ratio') expect(tile.total > 0 && tile.value === tile.total, where).toBe(done);
        if (tile.kind === 'count') expect(tile.total > 0 && tile.value > 0, where).toBe(done);
        if (tile.kind === 'problems' && tile.total > 0) expect(tile.value === 0, where).toBe(done);
      }
    }
  });

  it('shows every step\'s document fields and the criteria progress the band shows', () => {
    const c = draftedCtx();
    for (const step of IMPROVEMENT_STEPS) {
      const d = stepDashboard(step, c);
      const doc = d.tiles.find((t) => t.id === 'doc')!;
      expect(doc.total).toBe(STEP_DEFS[step].fields.length);
      expect(d.doc.complete + d.doc.vague).toBeLessThanOrEqual(d.doc.total);
      expect(d.doc.byAi).toBe(d.doc.complete + d.doc.vague);
      expect(d.progress.total).toBe(STEP_DEFS[step].todos.length);
      expect(d.inputs.map((i) => i.id)).toEqual(STEP_DEFS[step].inputs);
    }
  });

  it('says "no data" instead of 0 % or 100 % where a new project has nothing to judge', () => {
    const c = emptyProjectCtx();
    const kpi = stepDashboard('kpi', c);
    for (const id of ['kpisValid', 'deadlinesAhead', 'okrsLinked', 'okrsAligned']) {
      const tile = kpi.tiles.find((t) => t.id === id)!;
      expect(tile.total, id).toBe(0);
      expect(tileTone(tile, kpi.results), id).toBe('empty');
    }
    const tobe = stepDashboard('tobe', c);
    expect(tileTone(tobe.tiles.find((t) => t.id === 'useCases')!, tobe.results)).toBe('empty');
    expect(stepDashboard('asis', c).inputs.find((i) => i.id === 'discussion')!.count).toBe(0);
  });

  it('counts from the raw data: removing one issue\'s sources lowers the tile by one and opens it', () => {
    const before = stepDashboard('asis', demoCtx()).tiles.find((t) => t.id === 'issuesSourced')!;
    const raw = clone();
    const issue = raw.entities.find((e) => e.kind === 'issue' && e.sourceIds.length > 0)! as { sourceIds: string[] };
    issue.sourceIds = [];
    const d = stepDashboard('asis', demoCtx(loadPack(raw)));
    const after = d.tiles.find((t) => t.id === 'issuesSourced')!;
    expect(after.total).toBe(before.total);
    expect(after.value).toBe(Math.min(before.value, before.total - 1));
    expect(tileTone(after, d.results)).toBe('open');
    expect(d.detail.step === 'asis' && d.detail.issues.filter((i) => !i.sourced).length).toBe(after.total - after.value);
  });

  it('has a label in both languages for every tile', () => {
    const ids = new Set(IMPROVEMENT_STEPS.flatMap((s) => stepDashboard(s, draftedCtx()).tiles.map((t) => t.id)));
    for (const id of ids) {
      for (const lang of ['ja', 'en'] as const) expect(translate(lang, `proj.dash.tile.${id}` as MessageKey), `${lang} ${id}`).toBeTruthy();
    }
  });
});

describe('step deliverables by purpose', () => {
  it('as-is ranks issues by the stated priority score and shows each one\'s KPI gap', () => {
    const d = stepDashboard('asis', demoCtx()).detail;
    if (d.step !== 'asis') throw new Error('step');
    expect(d.issues.length).toBeGreaterThan(0);
    d.issues.forEach((i, n) => expect(i.rank).toBe(n + 1));
    for (let n = 1; n < d.issues.length; n++) expect(d.issues[n - 1]!.score).toBeGreaterThanOrEqual(d.issues[n]!.score);
    const gaps = d.issues.filter((i) => i.gap);
    expect(gaps.length).toBeGreaterThan(0);
    for (const i of gaps) expect(i.gap!.remaining).toBeGreaterThanOrEqual(0);
  });

  it('every issue needs a solution: removing one solution\'s issue links fails sol-issues and names the issue', () => {
    const ok = stepDashboard('solution', demoCtx());
    expect(ok.results.find((r) => r.todo.id === 'sol-issues')!.done).toBe(true);
    const raw = clone();
    const sol = raw.entities.find((e) => e.kind === 'solution')! as { issueIds: string[] };
    const orphans = sol.issueIds.filter((id) => !raw.entities.some((e) => e !== (sol as unknown) && e.kind === 'solution' && (e as { issueIds: string[] }).issueIds.includes(id)));
    sol.issueIds = [];
    const d = stepDashboard('solution', demoCtx(loadPack(raw)));
    const r = d.results.find((x) => x.todo.id === 'sol-issues')!;
    expect(r.outcome).toMatchObject({ ok: false, code: 'issuesWithoutSolution', vars: { n: orphans.length } });
    expect(r.outcome!.refs!.map((x) => (x.type === 'text' ? '' : x.id)).sort()).toEqual([...orphans].sort());
    if (d.detail.step !== 'solution') throw new Error('step');
    expect(d.detail.issues.filter((i) => i.solutionIds.length === 0).map((i) => i.id).sort()).toEqual([...orphans].sort());
  });

  it('to-be shows the top issues and which use cases describe their solved state', () => {
    const c = demoCtx();
    const d = stepDashboard('tobe', c).detail;
    if (d.step !== 'tobe') throw new Error('step');
    expect(d.topIssues.length).toBeLessThanOrEqual(TOP_ISSUES);
    d.topIssues.forEach((i, n) => expect(i.rank).toBe(n + 1));
    expect(d.useCases.length).toBe(c.useCases.filter((u) => u.origin === 'registered').length);
    for (const i of d.topIssues) {
      for (const id of i.useCaseIds) expect(d.useCases.find((u) => u.id === id)!.issueIds).toContain(i.id);
    }
  });

  it('a brief says how mature it is and which earlier steps are still open, so any step can be worked on first', () => {
    const c = emptyProjectCtx();
    const b = buildStepBrief(stepDashboard('deliverable', c), c, 'ja', 'internal');
    expect(b.maturity).toBe('hypothesis');
    expect(b.openSteps).toEqual(IMPROVEMENT_STEPS.slice(0, -1));
    expect(b.caveats.join('\n')).toContain(translate('ja', 'proj.step.asis'));
    expect(buildStepBrief(stepDashboard('asis', c), c, 'en', 'internal').openSteps).toEqual([]);
  });
});

describe('step charts data (FR-318)', () => {
  it('ranks causes by linked impact with a cumulative share that ends at 100%', () => {
    const d = stepDashboard('asis', demoCtx()).detail;
    if (d.step !== 'asis') throw new Error('step');
    expect(d.causes.length).toBeGreaterThan(0);
    for (let i = 1; i < d.causes.length; i++) expect(d.causes[i - 1]!.weight).toBeGreaterThanOrEqual(d.causes[i]!.weight);
    expect(d.causes.at(-1)!.cumulative).toBeCloseTo(1, 6);
  });

  it('the contribution bridge of every KPI adds up to its expected value', () => {
    const c = draftedCtx();
    const sols = c.pack.pack.entities.filter((e) => e.kind === 'solution').slice(0, 2);
    let s = emptyStrategy();
    for (const k of c.kpi.kpis) {
      for (const [i, sol] of sols.entries()) {
        s = upsertContribution(s, {
          id: `c-${sol.id}-${k.id}`, solutionId: sol.id, kpiId: k.id, lever: 'sites', leverUnit: 'sites',
          amount: { low: 5, mode: 10, high: 20 }, effectPerUnit: { low: 0.01 * (i + 1), mode: 0.02 * (i + 1), high: 0.04 * (i + 1) },
          rampStart: '2026-12-01', fullEffect: '2027-03-31', basis: 'assumption', evidence: '',
        });
      }
    }
    const d = stepDashboard('solution', { ...c, strategy: s }).detail;
    if (d.step !== 'solution') throw new Error('step');
    expect(d.sims.length).toBe(c.kpi.kpis.length);
    for (const r of d.sims) {
      const k = c.kpi.kpis.find((x) => x.id === r.kpiId)!;
      const dir = Math.sign(k.target - k.current) || Math.sign(k.target - k.baseline) || 1;
      expect(r.bridge.length, r.kpiId).toBe(sols.length);
      expect(r.current + dir * r.bridge.reduce((a, b) => a + b.expected, 0), r.kpiId).toBeCloseTo(r.expected, 6);
      expect(dir * (r.p90 - r.p10), r.kpiId).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('step executive summary (FR-319)', () => {
  const all = (b: ReturnType<typeof buildStepBrief>) => [b.answer, b.situation, b.complication, b.question, ...b.findings, ...b.actions, ...b.caveats].join('\n');

  it.each(contexts)('every figure in the rule-based brief is a ledger fact, in both languages (%s)', (_, make) => {
    const c = make();
    for (const step of IMPROVEMENT_STEPS) {
      for (const lang of ['ja', 'en'] as const) {
        const b = buildStepBrief(stepDashboard(step, c), c, lang, 'internal');
        expect(b.answer, `${step}/${lang}`).toBeTruthy();
        expect(b.findings.length, `${step}/${lang}`).toBeLessThanOrEqual(3);
        expect(b.findingFacts.length).toBe(b.findings.length);
        for (const ids of b.findingFacts) for (const id of ids) expect(b.facts.map((f) => f.id), `${step}/${lang}/${id}`).toContain(id);
        const check = verifyNumbers(all(b), b);
        expect(check.unverified, `${step}/${lang}: ${all(b)}`).toEqual([]);
      }
    }
  });

  it('flags a figure that is not in the ledger', () => {
    const c = demoCtx();
    const b = buildStepBrief(stepDashboard('asis', c), c, 'en', 'internal');
    expect(verifyNumbers(`${b.answer} Revenue grows 987654 times.`, b).unverified).toContain('987654');
  });

  it('changes the answer and the hash when the data changes', () => {
    const c = demoCtx();
    const before = buildStepBrief(stepDashboard('asis', c), c, 'en', 'internal');
    const raw = clone();
    // The top cause loses its links: the Pareto (and so the answer) must re-rank.
    const top = before.refs.find((id) => c.pack.byId.get(id)?.kind === 'cause')!;
    for (const e of raw.entities) if (e.kind === 'issue') (e as { causeIds?: string[] }).causeIds = ((e as { causeIds?: string[] }).causeIds ?? []).filter((id) => id !== top);
    const c2 = demoCtx(loadPack(raw));
    const after = buildStepBrief(stepDashboard('asis', c2), c2, 'en', 'internal');
    expect(after.hash).not.toBe(before.hash);
    expect(after.answer).not.toBe(before.answer);
  });

  it('marks a saved brief stale when a referenced description changes without numeric changes', () => {
    const c = demoCtx();
    const before = buildStepBrief(stepDashboard('asis', c), c, 'en', 'internal');
    const raw = clone();
    const referenced = raw.entities.find((entity) => entity.id === before.refs[0]);
    if (!referenced) throw new Error('Missing referenced fixture');
    referenced.description.en += ' Updated evidence.';
    const changed = demoCtx(loadPack(raw));
    const after = buildStepBrief(stepDashboard('asis', changed), changed, 'en', 'internal');
    expect(after.facts).toEqual(before.facts);
    expect(after.hash).not.toBe(before.hash);
  });

  it('round-trips through the section format the model is asked for', () => {
    const c = draftedCtx();
    for (const step of IMPROVEMENT_STEPS) {
      const b = buildStepBrief(stepDashboard(step, c), c, 'ja', 'internal');
      const p = parseBrief(briefText(b));
      expect(p).toEqual({ answer: b.answer, situation: b.situation, complication: b.complication, question: b.question, findings: b.findings, actions: b.actions, caveats: b.caveats });
    }
  });

  it('falls back to the rule-based brief, labelled mock, when live AI is off', async () => {
    const c = demoCtx();
    const b = buildStepBrief(stepDashboard('kpi', c), c, 'en', 'internal');
    const g = await requestStepBrief(b, c, 'en');
    expect(g.mode).toBe('mock');
    expect(g.content.answer).toBe(b.answer);
    expect(g.hash).toBe(b.hash);
    expect(g.check.unverified).toEqual([]);
  });

  it('names no internal item for the external audience', () => {
    const c = demoCtx();
    for (const step of IMPROVEMENT_STEPS) {
      const b = buildStepBrief(stepDashboard(step, c), c, 'en', 'external');
      for (const id of b.refs) expect(c.pack.byId.get(id)?.classification, `${step}/${id}`).not.toBe('internal');
    }
  });
});
