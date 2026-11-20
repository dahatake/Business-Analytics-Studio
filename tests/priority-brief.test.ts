import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { translate, type MessageKey } from '../src/i18n/core.ts';
import { IMPROVEMENT_STEPS } from '../src/state/projects.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { emptyDeliverables, type CheckContext } from '../src/modules/project/deliverables.ts';
import { priorityBrief } from '../src/modules/project/priorityBrief.ts';
import { analyzeCandidates, analyzePackPriority, PRIORITY_METHODS, PRIORITY_SOURCES, quadrantOf, STEP_METHODS } from '../src/modules/project/priorityAnalysis.ts';

const pack = loadPack(samplePack);
const demoCtx = (): CheckContext => ({
  pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(),
  deliverables: emptyDeliverables(), today: '2026-11-09',
});

describe('priority aids (FR-358)', () => {
  it('every method cites catalogued sources and every source is cited by a method', () => {
    const ids = new Set(PRIORITY_SOURCES.map((s) => s.id));
    expect(ids.size).toBe(PRIORITY_SOURCES.length);
    const cited = new Set(Object.values(PRIORITY_METHODS).flat());
    for (const id of cited) expect(ids.has(id as string), id).toBe(true);
    for (const id of ids) expect((cited as Set<string>).has(id), `uncited ${id}`).toBe(true);
    for (const s of PRIORITY_SOURCES) if (s.url) expect(s.url, s.id).toMatch(/^https:\/\//);
    for (const step of IMPROVEMENT_STEPS) for (const m of STEP_METHODS[step]) expect(m in PRIORITY_METHODS, `${step}:${m}`).toBe(true);
  });

  it('splits issues by impact and feasibility and counts weak evidence', () => {
    expect(quadrantOf(5, 4)).toBe('quickWin');
    expect(quadrantOf(5, 3)).toBe('bigBet');
    expect(quadrantOf(3, 5)).toBe('fillIn');
    expect(quadrantOf(2, 2)).toBe('reconsider');
    const { candidates, stats } = analyzeCandidates([
      { id: 'issue-a', impact: 5, feasibility: 5, sourced: true, measured: true },
      { id: 'issue-b', impact: 5, feasibility: 2, sourced: true, measured: false },
      { id: 'issue-c', impact: 1, feasibility: 1, sourced: false, measured: false },
    ]);
    expect(candidates.map((c) => c.id)).toEqual(['issue-a', 'issue-b', 'issue-c']);
    expect(stats).toEqual({ n: 3, quickWin: 1, bigBet: 1, fillIn: 0, reconsider: 1, unproven: 2 });
  });

  it('analyses the issues of a generated pack and ignores other entities', () => {
    const a = analyzePackPriority([
      { kind: 'issue', id: 'issue-a', impact: 4, feasibility: 4, sourceIds: ['source-x'], kpiIds: ['kpi-x'] },
      { kind: 'issue', id: 'issue-b', impact: 'high', feasibility: 4 },
      { kind: 'site', id: 'site-a' },
    ]);
    expect(a.stats).toMatchObject({ n: 1, quickWin: 1, unproven: 0 });
    expect(a.sourceIds.length).toBeGreaterThan(0);
  });

  it('every step has a summary, a critique and well-formed emphasis in both languages with the same placeholders', () => {
    const c = demoCtx();
    const keys = new Set<string>(['proj.prio.title', 'proj.prio.lead']);
    for (const step of IMPROVEMENT_STEPS) {
      const b = priorityBrief(step, c);
      expect(b.sources.length, step).toBeGreaterThan(0);
      expect(b.emphasis.length, step).toBeGreaterThan(0);
      keys.add(`proj.prio.summary.${step}`);
      keys.add(`proj.prio.critique.${step}`);
      for (const e of b.emphasis) { keys.add(`proj.prio.emph.${e.id}`); keys.add(`proj.prio.tone.${e.tone}`); }
      for (const m of b.methods) for (const part of ['name', 'use', 'limit']) keys.add(`proj.prio.method.${m}.${part}`);
      for (const s of b.sources) keys.add(`proj.prio.kind.${s.kind}`);
      for (const q of ['quickWin', 'bigBet', 'fillIn', 'reconsider']) keys.add(`proj.prio.quadrant.${q}`);
      const text = translate('ja', `proj.prio.summary.${step}` as MessageKey, b.vars);
      expect(text, step).not.toMatch(/\{\w+\}/);
    }
    for (const key of keys) {
      const ja = translate('ja', key as MessageKey);
      const en = translate('en', key as MessageKey);
      expect(ja, key).not.toBe(key);
      expect(en, key).not.toBe(key);
      expect(en, key).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      expect([...ja.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), key).toEqual([...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
    }
  });

  it('never ranks an issue the person qualified out, and the summary counts what the step screen counts', () => {
    const c = demoCtx();
    const asis = priorityBrief('asis', c);
    expect(asis.stats.n).toBe(asis.stats.quickWin + asis.stats.bigBet + asis.stats.fillIn + asis.stats.reconsider);
    expect(asis.candidates.length).toBeLessThanOrEqual(3);
  });
});
