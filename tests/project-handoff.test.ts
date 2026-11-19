import { afterEach, describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { IMPROVEMENT_STEPS } from '../src/state/projects.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { applyDraft, DeliverableDataSchema, emptyDeliverables, setQualification, STEP_DEFS, type CheckContext, type DeliverableData } from '../src/modules/project/deliverables.ts';
import { buildDraft } from '../src/modules/project/deliverableDraft.ts';
import { clearHandoff, confirmHandoff, handoffView, handoffViews, inheritedItems, inputLabels } from '../src/modules/project/handoff.ts';
import { FORM_DRAFT_SCHEMAS, mockFormDraft, parseFormDraft, requestFormDraft } from '../src/modules/project/formDraft.ts';
import { setRuntimeSettingsProvider } from '../src/ai/client.ts';

const pack = loadPack(samplePack);
const AT = '2026-11-09T09:00:00Z';

/** Demo project with every deliverable drafted and every issue qualified: the automatic ToDos of asis, tobe and kpi pass, the manual ones are open. */
function draftedCtx(): CheckContext {
  const c: CheckContext = {
    pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(),
    deliverables: emptyDeliverables(), today: '2026-11-09',
  };
  let data = c.deliverables;
  for (const step of IMPROVEMENT_STEPS) data = applyDraft(data, step, buildDraft({ step, ctx: c, lang: 'ja', audience: 'internal' }), { overwrite: false, mock: true, at: AT }).data;
  for (const issue of pack.pack.entities.filter((e) => e.kind === 'issue')) {
    data = setQualification(data, issue.id, { verdict: 'pursue', reason: 'Measured gap is worth closing', different: 'Sponsor and budget are in place', at: AT, by: 'Tester' });
  }
  return { ...c, deliverables: data, objectives: [{ id: 'o1', text: 'Grow margin' }], projectObjectiveIds: ['o1'] };
}

/** The person ticks the manual ToDos of a step. */
function signOff(data: DeliverableData, step: (typeof IMPROVEMENT_STEPS)[number]): DeliverableData {
  const ids = STEP_DEFS[step].todos.filter((t) => t.kind === 'manual').map((t) => t.id);
  return { ...data, signOffs: { ...data.signOffs, ...Object.fromEntries(ids.map((id) => [id, { at: AT, by: 'Tester' }])) } };
}

describe('step handoff: ToDo-gated confirmation and item lineage', () => {
  it('refuses to confirm while a ToDo is open, then records the step items once every ToDo is checked', () => {
    const c = draftedCtx();
    expect(handoffView('asis', c, 'ja')).toMatchObject({ status: 'none', blocker: 'todos' });
    expect(() => confirmHandoff(c.deliverables, 'asis', c, 'ja', 'Tester', AT)).toThrow('todos');

    const data = confirmHandoff(signOff(c.deliverables, 'asis'), 'asis', c, 'ja', 'Tester', AT);
    const record = data.handoffs!.asis!;
    expect(record).toMatchObject({ at: AT, by: 'Tester', upstream: '' });
    expect(record.items.filter((i) => i.kind === 'issue').length).toBeGreaterThan(0);
    expect(handoffView('asis', { ...c, deliverables: data }, 'ja')).toMatchObject({ status: 'current', blocker: null, changes: [] });
    // The record survives persistence (device storage parses with the schema).
    expect(DeliverableDataSchema.parse(JSON.parse(JSON.stringify(data))).handoffs?.asis).toEqual(record);
  });

  it('requires the previous step to be confirmed and current before the next one', () => {
    const c = draftedCtx();
    let data = signOff(signOff(c.deliverables, 'asis'), 'tobe');
    expect(handoffView('tobe', { ...c, deliverables: data }, 'ja').blocker).toBe('upstream');
    expect(() => confirmHandoff(data, 'tobe', c, 'ja', '', AT)).toThrow('upstream');

    data = confirmHandoff(data, 'asis', c, 'ja', '', AT);
    data = confirmHandoff(data, 'tobe', c, 'ja', '', AT);
    const inherited = inheritedItems('tobe', { ...c, deliverables: data }, 'ja');
    expect(inherited.from).toBe('asis');
    expect(inherited.items.every((i) => i.change === 'same')).toBe(true);
    expect(handoffViews({ ...c, deliverables: data }, 'ja').map((v) => v.status)).toEqual(['current', 'current', 'none', 'none', 'none']);
  });

  it('marks a changed item and makes the downstream confirmation stale until the upstream step is confirmed again', () => {
    const c = draftedCtx();
    let data = signOff(signOff(c.deliverables, 'asis'), 'tobe');
    data = confirmHandoff(data, 'asis', c, 'ja', '', AT);
    data = confirmHandoff(data, 'tobe', c, 'ja', '', AT);

    // A registered use case is edited after the tobe step was confirmed.
    const target = c.useCases.find((u) => u.origin === 'registered')!;
    const edited: CheckContext = { ...c, deliverables: data, useCases: c.useCases.map((u) => (u.id === target.id ? { ...u, summary: 'changed', updatedAt: AT } : u)) };
    const tobe = handoffView('tobe', edited, 'ja');
    expect(tobe.status).toBe('stale');
    expect(tobe.changes).toEqual([expect.objectContaining({ id: `usecase:${target.id}`, change: 'changed' })]);

    // An asis field edit makes asis stale and therefore tobe stale (upstream changed), even though tobe itself is unchanged.
    const asisField = Object.keys(data.docs.asis ?? {})[0]!;
    const fieldEdited = { ...data, docs: { ...data.docs, asis: { ...data.docs.asis, [asisField]: { ...data.docs.asis![asisField]!, text: `${data.docs.asis![asisField]!.text}\n追記` } } } };
    const views = handoffViews({ ...c, deliverables: fieldEdited }, 'ja');
    expect(views[0]!.status).toBe('stale');
    expect(views[1]).toMatchObject({ status: 'stale', upstreamChanged: true, blocker: 'upstream' });
    expect(inheritedItems('tobe', { ...c, deliverables: fieldEdited }, 'ja').items.find((i) => i.id === `field:asis.${asisField}`)?.change).toBe('changed');

    // Re-confirming asis lets tobe be confirmed again.
    const reconfirmed = confirmHandoff(fieldEdited, 'asis', c, 'ja', '', AT);
    expect(handoffView('tobe', { ...c, deliverables: reconfirmed }, 'ja').blocker).toBeNull();
    expect(clearHandoff(reconfirmed, 'asis').handoffs?.asis).toBeUndefined();
  });

  it('feeds the confirmed items, in confirmed order, to drafts of the next step', () => {
    const c = draftedCtx();
    const data = confirmHandoff(signOff(c.deliverables, 'asis'), 'asis', c, 'ja', '', AT);
    const confirmed = data.handoffs!.asis!.items.filter((i) => i.kind === 'issue').map((i) => i.label);
    expect(inputLabels('asis', 'issue', { ...c, deliverables: data }, 'ja')).toEqual(confirmed);
  });

  it('a changed verdict reaches the next step: a "no" removes the issue from what the To-Be is built on (FR-347)', () => {
    const c = draftedCtx();
    const data = confirmHandoff(signOff(c.deliverables, 'asis'), 'asis', c, 'ja', '', AT);
    const issue = pack.pack.entities.find((e) => e.kind === 'issue')!;
    const reasoned = setQualification(data, issue.id, { ...data.qualifications![issue.id]!, reason: 'Re-measured: the gap is twice as large' });
    expect(handoffView('asis', { ...c, deliverables: reasoned }, 'ja').changes).toEqual([expect.objectContaining({ id: `issue:${issue.id}`, change: 'changed' })]);
    const declined = setQualification(data, issue.id, { verdict: 'no', reason: 'Worth less than it costs', at: AT, by: 'Tester' });
    const view = handoffView('asis', { ...c, deliverables: declined }, 'ja');
    expect(view.changes).toEqual([expect.objectContaining({ id: `issue:${issue.id}`, change: 'removed' })]);
    expect(inputLabels('asis', 'issue', { ...c, deliverables: declined }, 'ja')).not.toContain(issue.name.ja);
  });
});

describe('Copilot form drafts', () => {
  afterEach(() => setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false })));

  it('parses only answers that satisfy the form rules', () => {
    expect(parseFormDraft('section', 'Here: {"text": "Scope"} done')).toEqual({ text: 'Scope' });
    expect(parseFormDraft('section', 'no json')).toBeNull();
    expect(parseFormDraft('usecase', '{"name": "X", "steps": []}')).toBeNull();
    const bad = { lever: 'L', amount: { low: 3, mode: 1, high: 2 }, effectPerUnit: { low: 1, mode: 1, high: 1 } };
    expect(parseFormDraft('contribution', JSON.stringify(bad))).toBeNull();
  });

  it('builds the mock from the previous step and keeps the contribution consistent with the KPI gap', async () => {
    const uc = await requestFormDraft('usecase', { name: '', summary: '', issues: ['在庫の偏り'], persona: '業務' }, 'ja');
    expect(uc.response.mode).toBe('mock');
    expect(uc.draft?.name).toContain('在庫の偏り');
    expect(FORM_DRAFT_SCHEMAS.usecase.safeParse(uc.draft).success).toBe(true);

    const kpi = { name: 'Lead time', unit: 'days', current: 20, target: 10, deadline: '2027-03-31' };
    const c = mockFormDraft('contribution', { solution: 'Planner', kpi, lever: '' }, 'en');
    expect(c.effectPerUnit.low).toBeLessThanOrEqual(c.effectPerUnit.mode);
    expect(c.amount.mode * c.effectPerUnit.mode).toBeCloseTo(kpi.target - kpi.current);
  });
});
