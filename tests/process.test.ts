import { describe, expect, it } from 'vitest';
import { WorkflowExtension } from '../src/data/extensionSchemas.ts';
import { samplePack } from '../src/data/sample.ts';
import { verifyPack } from '../src/data/verify.ts';
import { repairExtensions } from '../src/modules/project/packGenerate.ts';
import { demoWorkflow } from '../src/modules/process/demo.ts';
import {
  backEdges, buildProcess, criticalPath, flowEdges, ioAnalysis, layoutProcess, RECONCILE_TOLERANCE, reconcile, stepDelta, totals,
} from '../src/modules/process/model.ts';
import { removeStage } from '../src/modules/process/store.ts';
import { completeWorkflow, completeWorkflowWithRepair, workflowGaps, workflowPrompt } from '../src/modules/process/workflowDraft.ts';
import { buildMeasurement, measurementPeriod } from '../src/modules/process/measurement.ts';
import { workflowAnswer } from './fixtures/workflow.ts';
import { metricStatus } from '../src/modules/process/model.ts';

const demo = buildProcess(WorkflowExtension.parse(demoWorkflow));

describe('FR-380 business process model', () => {
  it('adds up the demo steps to the order-to-ship KPI in both states (as-is: current value, to-be: target)', () => {
    const [lead] = reconcile(demo, samplePack.entities);
    expect(lead!.kpiId).toBe('kpi-lead-time');
    const asIs = lead!.rows.find((r) => r.state === 'asIs')!;
    const toBe = lead!.rows.find((r) => r.state === 'toBe')!;
    expect(asIs.stepsHours! / 24).toBeCloseTo(16.96, 1);
    expect(Math.abs(asIs.gap!)).toBeLessThanOrEqual(RECONCILE_TOLERANCE);
    expect(Math.abs(toBe.gap!)).toBeLessThanOrEqual(RECONCILE_TOLERANCE);
    expect(toBe.stepsHours!).toBeLessThan(asIs.stepsHours!);
  });

  describe('evidence-aware process completion', () => {
    it('specifies allowed values and repairs only the invalid response field', async () => {
      const prompt = workflowPrompt(null, 'Purpose', 'en', []);
      expect(prompt).toContain('party.kind=customer|supplier|partner|regulator|department|team|other');
      const draft = workflowAnswer(prompt).workflow;
      const originalParty = draft.parties![0]!;
      const answer = { ...draft, parties: [{ ...originalParty, kind: 'employee' }, { id: 'outside', name: 'Supplier', side: 'external', kind: 'supplier' }] };
      const repairs: string[] = [];
      const result = await completeWorkflowWithRepair(null, answer, 'en', [], async (repairPrompt) => {
        repairs.push(repairPrompt);
        return { fixes: [{ path: ['parties', 0, 'kind'], value: 'team' }] };
      });
      expect(repairs).toHaveLength(1);
      expect(repairs[0]).toContain('"path":["parties",0,"kind"]');
      expect(result.parties).toMatchObject([{ ...originalParty, kind: 'team' }, { id: 'outside', kind: 'supplier' }]);
      expect(result.stages[0]!.id).toBe(draft.stages[0]!.id);
      expect(workflowGaps(result)).toEqual([]);
      expect(answer.parties[0]!.kind).toBe('employee');
    });

    it('rejects corrections to valid fields and reports unresolved schema errors', async () => {
      const draft = workflowAnswer(workflowPrompt(null, 'Purpose', 'en', [])).workflow;
      const answer = { ...draft, parties: [{ ...draft.parties![0]!, kind: 'employee' }] };
      let attempts = 0;
      await expect(completeWorkflowWithRepair(null, answer, 'en', [], async () => {
        attempts++;
        return { fixes: [{ path: ['parties', 0, 'kind'], value: 'team' }, { path: ['title'], value: 'Changed' }] };
      })).rejects.toMatchObject({ name: 'WorkflowDraftError', message: expect.stringContaining('parties') });
      expect(attempts).toBe(2);
      expect(answer.title).toEqual(draft.title);
    });

    it('does not request repairs for a valid workflow', async () => {
      const draft = workflowAnswer(workflowPrompt(null, 'Purpose', 'en', [])).workflow;
      let calls = 0;
      await completeWorkflowWithRepair(null, draft, 'en', [], async () => { calls++; return {}; });
      expect(calls).toBe(0);
    });

    it('propagates a repair transport failure rather than treating it as invalid data', async () => {
      const draft = workflowAnswer(workflowPrompt(null, 'Purpose', 'en', [])).workflow;
      const answer = { ...draft, parties: [{ ...draft.parties![0]!, kind: 'employee' }] };
      const failure = new Error('transport failed');
      await expect(completeWorkflowWithRepair(null, answer, 'en', [], async () => { throw failure; })).rejects.toBe(failure);
    });

    it('fills every missing metric but preserves edited values, references and provenance', () => {
      const original = WorkflowExtension.parse({
        stages: [{ id: 's', name: '独自の受付', asIs: { touchMinutes: 0, basis: 'stated' }, inputs: ['実際の依頼'] }],
      });
      const prompt = workflowPrompt(original, '受付を改善', 'ja', []);
      const result = completeWorkflow(original, workflowAnswer(prompt).workflow, 'ja', []);
      expect(workflowGaps(result)).toEqual([]);
      expect(result.stages[0]).toMatchObject({ id: 's', name: '独自の受付', inputs: ['実際の依頼'], asIs: { touchMinutes: 0 } });
      expect(result.stages[0]!.asIs!.evidence!.waitHours!.status).toBe('estimate');
      expect(result.stages[0]!.asIs!.evidence!.touchMinutes!.status).toBe('stated');
      expect(result.laborCostEvidence!.status).toBe('estimate');
    });

    it('rejects incomplete answers and invalid references instead of inventing success', () => {
      expect(() => completeWorkflow(null, { stages: [{ id: 's', name: 'S' }] }, 'ja', [])).toThrow('不足');
      const draft = workflowAnswer(workflowPrompt(null, 'Purpose', 'en', [])).workflow;
      draft.stages[0]!.next = ['missing'];
      expect(() => completeWorkflow(null, draft, 'en', [])).toThrow('reference');
    });

    it('downgrades unsupported measured claims, retaining only exact quoted stated numbers', () => {
      const draft = workflowAnswer(workflowPrompt(null, 'Purpose', 'en', [])).workflow;
      draft.stages[0]!.asIs!.evidence = {
        touchMinutes: { status: 'measured', method: 'AI says measured', sourceIds: ['s'], quote: '30 minutes' },
        waitHours: { status: 'stated', method: 'Quoted', sourceIds: ['s'], quote: 'wait 4 hours' },
      };
      const result = completeWorkflow(null, draft, 'en', [{ ref: 's', text: 'wait 4 hours' }]);
      expect(result.stages[0]!.asIs!.evidence).toMatchObject({ touchMinutes: { status: 'estimate' }, waitHours: { status: 'stated' } });
      const view = buildProcess(result);
      expect(metricStatus(view.steps[0]!.asIs, 'touchMinutes')).toEqual(['estimate']);
    });
  });

  describe('work-record measurement', () => {
    const period = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };
    const record = (id: string, kind: 'calendar' | 'worklog' | 'email' | 'chat', start: string, end?: string) => ({
      id, kind, category: kind === 'worklog' ? '実作業' : '案件A', description: '根拠から分類', start, end, ref: 's',
      quote: `${id} ${start} ${end ?? ''}${kind === 'worklog' ? ' actual work' : ''}`,
    });
    it('uses a calendar month with month-end clamping and validates custom dates', () => {
      const p = measurementPeriod({ processPeriod: 'month', processPeriodStart: '', processPeriodEnd: '' }, new Date(2026, 2, 31, 12));
      expect(new Date(p.start).getMonth()).toBe(1);
      expect(new Date(p.start).getDate()).toBe(28);
      expect(() => measurementPeriod({ processPeriod: 'custom', processPeriodStart: '2026-02-30', processPeriodEnd: '2026-03-01' })).toThrow('date');
      expect(() => measurementPeriod({ processPeriod: 'custom', processPeriodStart: '2026-11-05', processPeriodEnd: '2026-11-01' })).toThrow('precede');
    });

    it('calculates from verified records, deduplicates, clips the period and removes overlapping scheduled time', () => {
      const records = [
        record('cal', 'calendar', '2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z'),
        record('log', 'worklog', '2026-11-01T09:30:00Z', '2026-11-01T10:30:00Z'),
        record('email', 'email', '2026-11-01T11:00:00Z'),
        record('chat', 'chat', '2026-11-01T11:05:00Z'),
        record('clip', 'calendar', '2026-10-31T23:30:00Z', '2026-11-01T00:30:00Z'),
      ];
      const source = { ref: 's', title: '原記録', url: '', text: records.map((r) => r.quote).join('\n') };
      const result = buildMeasurement({ records: [...records, records[2], { ...records[0], id: 'invented' }], warnings: [] }, [source], period, '自分', 'UTC', null, 'ja');
      expect(result.records).toHaveLength(5);
      expect(result.categories.find((c) => c.name === '実作業')!.measuredMinutes).toBe(60);
      expect(result.categories.find((c) => c.name === '案件A')).toMatchObject({ calendarMinutes: 60, emailCount: 1, chatCount: 1, estimatedMinutes: 64 });
      expect(result.categories.reduce((n, c) => n + c.sharePct, 0)).toBeCloseTo(100);
      expect(result.coverage).toBe('partial');
      expect(result.warnings.join(' ')).toContain('重複');
      expect(result.warnings.join(' ')).toContain('invented');
    });

    it('never labels a scheduled meeting as actual work and never saves an empty retrieval as zero', () => {
      const r = record('meeting', 'worklog', '2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z');
      r.quote = 'meeting 2026-11-01T09:00:00Z 2026-11-01T10:00:00Z scheduled';
      expect(() => buildMeasurement({ records: [r] }, [{ ref: 's', title: '', url: '', text: r.quote }], period, 'me', 'UTC', null, 'ja')).toThrow('原記録');
      expect(() => buildMeasurement({ records: [] }, [], period, 'me', 'UTC', null, 'ja')).toThrow('原記録');
    });
  });

  it('bypasses removed and combined steps in the to-be flow and counts them as fully removed', () => {
    const toBe = flowEdges(demo, 'toBe');
    expect(toBe).toContainEqual(['st-request', 'st-quote']);
    expect(toBe).toContainEqual(['st-order-entry', 'st-plan']);
    expect(toBe.flat()).not.toContain('st-order-confirm');
    expect(flowEdges(demo, 'asIs')).toContainEqual(['st-request', 'st-stock-check']);
    expect(stepDelta(demo.byId.get('st-stock-check')!)).toEqual({ lead: -1, effort: -1 });
    expect(criticalPath(demo, 'toBe')!.ids).not.toContain('st-ship-instr');
  });

  it('turns time into people and money, and leaves money out without a rate', () => {
    const a = totals(demo, 'asIs');
    const b = totals(demo, 'toBe');
    expect(a.effortHours).toBeCloseTo(1423, 0);
    expect(b.effortHours).toBeCloseTo(773.5, 1);
    expect(a.costJpy).toBeCloseTo(1423 * 4500, 0);
    expect(b.steps).toBe(a.steps - 3 + 1);
    expect(b.hiddenWork).toBeLessThan(a.hiddenWork);
    const noRate = buildProcess(WorkflowExtension.parse({ ...demoWorkflow, laborCostPerHourJpy: undefined }));
    expect(totals(noRate, 'asIs').costJpy).toBeNull();
  });

  it('draws a next that goes back as a loop, not as flow', () => {
    const w = WorkflowExtension.parse({ stages: [
      { id: 'a', name: 'A', next: ['b'] }, { id: 'b', name: 'B', next: ['c'] }, { id: 'c', name: 'C', next: ['a'] },
    ] });
    expect(backEdges(buildProcess(w).steps)).toEqual([['c', 'a']]);
    const v = buildProcess(w);
    expect(v.loops).toMatchObject([{ from: 'c', to: 'a', implicit: true }]);
    expect(flowEdges(v, 'asIs')).not.toContainEqual(['c', 'a']);
    expect(criticalPath(v, 'asIs')!.ids).toEqual(['a', 'b', 'c']);
  });

  it('keeps outside parties above the company and every step in the same place in both states', () => {
    const layout = layoutProcess(demo);
    const external = layout.lanes.filter((l) => l.side === 'external');
    const internal = layout.lanes.filter((l) => l.side === 'internal');
    expect(Math.max(...external.map((l) => l.y))).toBeLessThan(layout.internalTop);
    expect(Math.min(...internal.map((l) => l.y))).toBe(layout.internalTop);
    expect(layout.steps.size).toBe(demo.steps.length);
    const cols = (id: string) => layout.steps.get(id)!.col;
    expect(cols('st-quote')).toBeGreaterThan(cols('st-stock-check'));
    expect(cols('st-make')).toBeGreaterThan(cols('st-supply'));
  });

  it('reads an older pack workflow (team names, plain inputs, no numbers)', () => {
    const v = buildProcess(WorkflowExtension.parse({ stages: [
      { id: 's1', name: { ja: '受付', en: 'Intake' }, team: 'Sales', inputs: ['Request'], outputs: ['Ticket'], next: ['s2'] },
      { id: 's2', name: 'Fulfil', team: 'Ops', inputs: ['Ticket'], outputs: [] },
    ] }));
    expect(v.lanes.map((l) => [l.side, l.name])).toEqual([['internal', 'Sales'], ['internal', 'Ops']]);
    expect(v.phases).toHaveLength(1);
    expect(v.hasToBe).toBe(false);
    expect(totals(v, 'asIs')).toMatchObject({ leadHours: 0, unknownOnPath: 2, effortHours: null });
    expect(ioAnalysis(v, 'asIs').map((r) => r.status)).toEqual(['partial', 'missing']);
  });

  it('verifies references of the process and keeps the demo valid', () => {
    const ok = verifyPack({ ...samplePack, extensions: { workflow: demoWorkflow } });
    expect(ok.problems.filter((i) => i.path.startsWith('extensions.workflow'))).toEqual([]);
    const broken = { ...demoWorkflow, stages: demoWorkflow.stages.map((s, i) => (i === 1 ? { ...s, partyId: 'party-missing' } : s)), loops: [{ id: 'l', from: 'st-x', to: 'st-make', kind: 'rework' }] };
    const bad = verifyPack({ ...samplePack, extensions: { workflow: broken } }).problems.filter((i) => i.code === 'DANGLING_REF').map((i) => i.path);
    expect(bad).toEqual(expect.arrayContaining(['extensions.workflow.stages[1].partyId', 'extensions.workflow.loops[0].from']));
  });

  it('removes a step together with every reference to it', () => {
    const next = removeStage(WorkflowExtension.parse(demoWorkflow), 'st-plan')!;
    expect(next.stages.some((s) => s.next.includes('st-plan'))).toBe(false);
    expect(next.loops!.some((l) => l.from === 'st-plan' || l.to === 'st-plan')).toBe(false);
    expect(WorkflowExtension.safeParse(next).success).toBe(true);
  });

  it('repairs a generated hidden workflow written as plain text', () => {
    const pack = repairExtensions({ entities: [], extensions: { workflow: { stages: [{ name: 'A', hiddenWork: 'Collect sheets by email' }] } } } as never) as { extensions: { workflow: unknown } };
    const w = WorkflowExtension.parse(pack.extensions.workflow);
    expect(w.stages[0]!.id).toBe('stage-1');
    expect(w.stages[0]!.hiddenWork).toEqual([{ name: 'Collect sheets by email' }]);
  });
});
