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
