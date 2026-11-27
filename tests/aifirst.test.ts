import { describe, expect, it } from 'vitest';
import { AiPlatformExtension, AI_CAPABILITIES } from '../src/data/extensionSchemas.ts';
import { samplePack } from '../src/data/sample.ts';
import { verifyPack } from '../src/data/verify.ts';
import { demoAiPlatform } from '../src/modules/aifirst/demo.ts';
import {
  addEvaluation, buildAiFirst, CAPABILITY, closeOver, linearOrder, orderCheck, requiredCapabilities, sanitizePlatform,
  setCapability, setCheck, stageOrder, STAGES, targetStage, withAreas, type SolutionInfo,
} from '../src/modules/aifirst/model.ts';
import { solutionInfos } from '../src/modules/aifirst/store.ts';
import { repairExtensions } from '../src/modules/project/packGenerate.ts';
import { emptyStrategy, setSolutionApproach, setSolutionType } from '../src/modules/project/strategy.ts';

const AT = '2026-11-27';
const sample = () => solutionInfos(emptyStrategy());
const view = (p = demoAiPlatform, sols: SolutionInfo[] = sample()) => buildAiFirst(p, sols);
const area = (v: ReturnType<typeof view>, id: string) => v.areas.find((a) => a.id === id)!;

describe('FR-386: the capability order (the report\'s DSM, chapter 5)', () => {
  it('the straight four phases have 7 backward and 4 missing dependencies; the revised stages have none', () => {
    const linear = orderCheck(linearOrder);
    expect(linear.backward).toHaveLength(7);
    expect(linear.backward).toEqual(expect.arrayContaining([
      ['copilot', 'identity'], ['copilot', 'oversharing'], ['vibeCoding', 'identity'], ['vibeCoding', 'devGuardrails'],
      ['vibeCoding', 'registry'], ['dataProducts', 'oversharing'], ['grounding', 'oversharing'],
    ]));
    expect(linear.missing).toHaveLength(4);
    expect(linear.missing.every(([, need]) => need === 'outcomes')).toBe(true);
    expect(orderCheck(stageOrder)).toEqual({ backward: [], missing: [] });
  });

  it('every prerequisite exists and the graph has no cycle', () => {
    for (const id of AI_CAPABILITIES) {
      for (const r of CAPABILITY[id].requires) expect(AI_CAPABILITIES).toContain(r);
      const deps = closeOver(CAPABILITY[id].requires);
      expect(deps.has(id), id).toBe(false);
    }
  });

  it('the platform parts are the same for both approaches; AI First goes deeper, the target depends on type and approach', () => {
    const adoption = requiredCapabilities('prompt', 'adoption');
    const first = requiredCapabilities('prompt', 'first');
    expect([...adoption].filter((id) => !first.has(id))).toEqual(['registry']);
    expect([...first].filter((id) => !adoption.has(id)).sort()).toEqual(['coe', 'dataProducts', 'evals']);
    expect(requiredCapabilities('agent', null).has('delegation')).toBe(true);
    expect(targetStage(['prompt'], 'adoption')).toBe('p1');
    expect(targetStage(['prompt'], 'first')).toBe('p4');
    expect(targetStage(['digital'], null)).toBe('p3');
  });
});

describe('FR-386: where each business area stands and how its loop turns (sample)', () => {
  it('areas stand at different heights, with progress ahead of their position and their own loops', () => {
    const v = view();
    expect(v.areas.map((a) => [a.id, a.position])).toEqual([
      ['area-skills', 'p2'], ['area-demand', 'p0'], ['area-inspection', 'p1'], ['area-invoice', 'p0'], ['area-energy', 'p0'],
    ]);
    const skills = area(v, 'area-skills');
    expect(skills.loop).toMatchObject({ closed: true, trend: 'up', iterations: 3 });
    expect(skills.basis).toBe('mixed');
    expect(skills.fraction).toBe(0.5);
    // AI First demand planning already has its data product (P3) while its rubric (P0) is missing.
    const demand = area(v, 'area-demand');
    expect(demand.ahead).toEqual(['p3']);
    expect(demand.progress[0]!.items.find((i) => i.id === 'rubric')!.met).toBe(false);
    // The pack's measured KPI baseline counts as evidence without a manual check.
    expect(demand.progress[0]!.items.find((i) => i.id === 'baseline')).toMatchObject({ met: true, basis: 'evidence', source: 'pack' });
    const inspection = area(v, 'area-inspection');
    expect(inspection.loop.steps).toEqual({ run: true, observe: false, evaluate: true, improve: false });
    expect(inspection.loop.trend).toBe('down');
    expect(area(v, 'area-energy').progress[0]!.items.find((i) => i.kind === 'approach')!.met).toBe(false);
  });

  it('flags building with vibe coding before code scanning and an inventory as an order contradiction', () => {
    const v = view();
    const contradictions = v.violations.filter((x) => x.severity === 'contradiction');
    expect(contradictions.filter((x) => x.kind === 'capability').map((x) => [x.id, x.needs])).toEqual([['vibeCoding', 'devGuardrails'], ['vibeCoding', 'registry']]);
    expect(contradictions.filter((x) => x.kind === 'area').map((x) => `${x.id}:${x.needs}`).sort()).toEqual([
      'area-inspection:devGuardrails', 'area-inspection:registry', 'area-skills:devGuardrails', 'area-skills:registry',
    ]);
    // Fixing the prerequisites removes them.
    let p = setCapability(demoAiPlatform, 'devGuardrails', { level: 1, basis: 'evidence' });
    p = setCapability(p, 'registry', { level: 1, basis: 'evidence' });
    const after = view(p);
    expect(after.violations.filter((x) => x.severity === 'contradiction')).toEqual([]);
    expect(area(after, 'area-skills').position).toBe('p3');
  });

  it('the roadmap comes from the solutions: dependency waves, ordered by the value they unlock per effort', () => {
    const v = view();
    expect(v.roadmap.map((r) => [r.id, r.wave])).toEqual([['registry', 1], ['devGuardrails', 1]]);
    expect(v.roadmap[0]!.value).toBe(300_000_000);
    expect(v.notNeeded).toEqual(['agentIdentity', 'modelRouting', 'delegation']);
    // Making the skills-transfer solution an agent needs the agent's identity and routing first, delegation after.
    const agent = solutionInfos(setSolutionType(emptyStrategy(), 'sol-knowledge-copilot', 'agent', 'T', AT));
    const r = view(demoAiPlatform, agent).roadmap;
    const waveOf = (id: string) => r.find((x) => x.id === id)?.wave;
    expect(waveOf('agentIdentity')).toBe(1);
    expect(waveOf('modelRouting')).toBe(1);
    expect(waveOf('delegation')).toBe(2);
    expect(r.find((x) => x.id === 'agentIdentity')!.unassessed).toBe(true);
    expect(r.find((x) => x.id === 'delegation')!.missing).toEqual(['registry', 'agentIdentity', 'modelRouting']);
  });

  it('without stored areas, one area per AI-related solution takes its approach from the solution screen (FR-384)', () => {
    const sols = solutionInfos(setSolutionApproach(setSolutionType(emptyStrategy(), 'sol-e-invoice', 'process', 'T', AT), 'sol-demand-planning', 'first', 'T', AT));
    const v = view({ capabilities: [], areas: [] }, sols);
    expect(v.derivedAreas).toBe(true);
    expect(v.areas.map((a) => a.id)).not.toContain('area-sol-e-invoice');
    expect(v.nonAiSolutions).toEqual(['sol-e-invoice']);
    expect(area(v, 'area-sol-demand-planning')).toMatchObject({ approach: 'first', approachSource: 'strategy', target: 'p4' });
    // Nothing is assessed: every capability gap is listed as unassessed, never as "none".
    expect(v.roadmap.every((x) => x.unassessed)).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it('edits keep the other areas and record the judgement; evaluations stay in date order', () => {
    const v = view({ capabilities: [], areas: [] });
    const current = v.areas.map((a) => ({ id: a.id, name: a.name, solutionIds: a.solutionIds, checks: [], evaluations: [] }));
    let p = withAreas({ capabilities: [], areas: [] }, current, (list) => list.map((a) => (a.id === 'area-sol-vision-inspection'
      ? addEvaluation(addEvaluation(setCheck(a, 'rubric', { met: true, basis: 'selfReport', note: ' 基準 ', by: 'T', at: AT }), { date: '2026-11-01', score: 70, metric: 'x' }), { date: '2026-10-01', score: 60, metric: 'x' })
      : a)));
    expect(p.areas).toHaveLength(v.areas.length);
    const edited = p.areas.find((a) => a.id === 'area-sol-vision-inspection')!;
    expect(edited.checks[0]).toEqual({ id: 'rubric', met: true, basis: 'selfReport', note: '基準', by: 'T', at: AT });
    expect(edited.evaluations.map((e) => e.score)).toEqual([60, 70]);
    p = setCapability(p, 'identity', { level: 2, basis: 'evidence' });
    expect(setCapability(p, 'identity', null).capabilities).toEqual([]);
    expect(STAGES).toHaveLength(5);
  });
});

describe('FR-386: stored and generated data are read defensively', () => {
  it('drops unknown capabilities, clamps levels, removes dangling ids and renames duplicate areas', () => {
    const raw = {
      capabilities: [{ id: 'copilot', level: 7, basis: 'evidence', sourceIds: ['src-annual-report', 'made-up'] }, { id: 'quantum', level: 1, basis: 'evidence' }],
      areas: [
        { id: 'a', name: 'A', solutionIds: ['sol-e-invoice', 'sol-none'], checks: [{ id: 'rubric', met: true, basis: 'evidence' }, { id: 'magic', met: true }], evaluations: [{ date: 'soon', score: 1, metric: 'x' }] },
        { id: 'a', name: 'B' },
        'broken',
      ],
    };
    const p = sanitizePlatform(raw, { sourceIds: new Set(['src-annual-report']), solutionIds: new Set(['sol-e-invoice']) })!;
    expect(p.capabilities).toEqual([{ id: 'copilot', level: 3, basis: 'evidence', sourceIds: ['src-annual-report'] }]);
    expect(p.areas.map((a) => a.id)).toEqual(['a', 'area-2']);
    expect(p.areas[0]).toMatchObject({ solutionIds: ['sol-e-invoice'], checks: [{ id: 'rubric' }], evaluations: [] });
    expect(sanitizePlatform('nope')).toBeNull();
  });

  it('pack generation repairs the extension instead of losing it: dangling ids go, stated assessments stay', () => {
    const pack = structuredClone(samplePack) as unknown as Record<string, unknown> & { extensions: Record<string, unknown> };
    pack.extensions = { ...pack.extensions, aiPlatform: { capabilities: [{ id: 'copilot', level: 2, basis: 'evidence', sourceIds: ['src-annual-report', 'source-made-up'] }, { id: 'magic', level: 1 }], areas: [{ name: 'X', solutionIds: ['sol-none'] }] } };
    const repaired = repairExtensions(pack as never) as unknown as { extensions: { aiPlatform: unknown } };
    expect(repaired.extensions.aiPlatform).toEqual({
      capabilities: [{ id: 'copilot', level: 2, basis: 'evidence', sourceIds: ['src-annual-report'] }],
      areas: [{ id: 'area-1', name: 'X', solutionIds: [], checks: [], evaluations: [] }],
    });
    expect(verifyPack(repaired).problems.filter((p) => p.severity === 'error' && p.path.startsWith('extensions.aiPlatform'))).toEqual([]);
    pack.extensions.aiPlatform = { capabilities: [{ id: 'magic', level: 1 }] };
    expect((repairExtensions(pack as never) as unknown as { extensions: Record<string, unknown> }).extensions.aiPlatform).toBeUndefined();
  });

  it('the pack verifier checks the extension and its references', () => {
    const pack = structuredClone(samplePack);
    pack.extensions = { ...pack.extensions, aiPlatform: demoAiPlatform };
    expect(AiPlatformExtension.safeParse(pack.extensions.aiPlatform).success).toBe(true);
    expect(verifyPack(pack).problems.filter((e) => e.severity === 'error' && e.path.startsWith('extensions.aiPlatform'))).toEqual([]);
    pack.extensions.aiPlatform = { areas: [{ id: 'x', name: 'X', solutionIds: ['sol-none'], checks: [{ id: 'rubric', met: true, basis: 'evidence', sourceIds: ['made-up'] }] }] };
    const paths = verifyPack(pack).problems.filter((e) => e.severity === 'error').map((e) => e.path).filter((p) => p.startsWith('extensions.aiPlatform'));
    expect(paths).toEqual(['extensions.aiPlatform.areas[0].solutionIds[0]', 'extensions.aiPlatform.areas[0].checks[0].sourceIds[0]']);
    pack.extensions.aiPlatform = { capabilities: [{ id: 'copilot', level: 9, basis: 'evidence' }] };
    expect(verifyPack(pack).problems.some((e) => e.path === 'extensions.aiPlatform' && e.code === 'EXTENSION_SCHEMA')).toBe(true);
  });
});
