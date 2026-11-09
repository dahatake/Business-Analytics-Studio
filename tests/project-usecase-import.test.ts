import { beforeEach, describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { useProjects } from '../src/state/projects.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { parseImport, prepareExport, toJson, toMarkdown } from '../src/modules/project/exportFormat.ts';
import { canUndoUseCaseImport, commitUseCaseImport, undoUseCaseImport } from '../src/modules/project/stores.ts';
import {
  applyUseCaseSelection, classifyUseCases, defaultChoices, unresolvedIds, UseCaseImportUndo,
} from '../src/modules/project/useCaseImport.ts';
import { useUseCases, type UseCase } from '../src/modules/usecases/store.ts';

const pack = loadPack(samplePack);
const uc = (id: string, name: string, extra: Partial<UseCase> = {}): UseCase => ({
  id, name: { ja: `${name} ja`, en: name }, summary: 'summary', persona: 'business',
  steps: [{ title: 'step', description: 'do it' }], relatedIds: ['kpi-1'], origin: 'registered', updatedAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const now = new Date('2026-11-09T03:00:00Z');

describe('use cases in a restored export are candidates, never overwritten (I-1, FR-056)', () => {
  it('classifies candidates as new / same id but changed / identical (updatedAt and key order are ignored)', () => {
    const current = [uc('a', 'Alpha'), uc('b', 'Beta'), uc('c', 'Gamma')];
    const incoming = [
      { ...uc('a', 'Alpha'), updatedAt: '2030-01-01T00:00:00.000Z' },
      uc('b', 'Beta v2', { steps: [{ title: 'step', description: 'changed' }] }),
      uc('d', 'Delta'),
      uc('d', 'Delta duplicate'),
    ];
    const cands = classifyUseCases(incoming, current);
    expect(cands.map((c) => [c.incoming.id, c.status])).toEqual([['a', 'identical'], ['b', 'changed'], ['d', 'new']]);
    expect(cands[1]!.changedFields).toEqual(['name', 'steps']);
    expect(cands[1]!.current).toBe(current[1]);
    const { relatedIds, ...rest } = uc('c', 'Gamma');
    const reordered = JSON.parse(JSON.stringify({ relatedIds, ...rest })) as UseCase;
    expect(classifyUseCases([reordered], current)[0]!.status).toBe('identical');
  });

  it('new ones are proposed, changed ones need an explicit per-item choice, identical are skipped', () => {
    const current = [uc('a', 'Alpha'), uc('b', 'Beta'), uc('e', 'Epsilon')];
    const cands = classifyUseCases([uc('a', 'Alpha'), uc('b', 'Beta v2'), uc('e', 'Epsilon v2'), uc('d', 'Delta'), uc('f', 'Phi')], current);
    const choices = defaultChoices(cands);
    expect(choices).toEqual({ a: 'skip', b: undefined, e: undefined, d: 'add', f: 'add' });
    expect(unresolvedIds(cands, choices)).toEqual(['b', 'e']);

    const picked = { ...choices, b: 'keep' as const, e: 'replace' as const, f: 'skip' as const };
    expect(unresolvedIds(cands, picked)).toEqual([]);
    const res = applyUseCaseSelection(current, cands, picked, now);
    expect(res).toMatchObject({ added: 1, replaced: 1, kept: 1, skipped: 2 });
    expect(res.next.map((u) => u.id)).toEqual(['a', 'b', 'e', 'd']);
    expect(res.next[0]).toBe(current[0]);
    expect(res.next[1]).toBe(current[1]);
    expect(res.next[2]).toMatchObject({ name: { en: 'Epsilon v2' }, updatedAt: now.toISOString() });
    expect(current.map((u) => u.id)).toEqual(['a', 'b', 'e']);

    // Unchosen changed items are never replaced, and nothing to apply returns the same list.
    const none = applyUseCaseSelection(current, cands, { ...choices, d: 'skip', f: 'skip' }, now);
    expect(none.next).toBe(current);
    expect(none.replaced).toBe(0);
  });

  it('undo restores the previous use-case list, only while the list is what the import left', () => {
    const before = [uc('a', 'Alpha')];
    const after = [...before, uc('d', 'Delta')];
    const h = new UseCaseImportUndo();
    expect(h.canUndo('demo', before)).toBe(false);
    expect(h.commit('demo', before, after)).toBe(after);
    expect(h.canUndo('other', after)).toBe(false);
    expect(h.canUndo('demo', [...after])).toBe(false);
    expect(h.undo('demo', after)).toBe(before);
    expect(h.canUndo('demo', before)).toBe(false);
  });

  it('round-trips use cases through Markdown and JSON exports as candidates', () => {
    const list = [uc('a', 'Alpha', { effect: 'faster', derivedFrom: 'sol-1' }), uc('b', 'Beta', { origin: 'derived' })];
    const data = { discussion: demoDiscussion(), kpi: { kpis: [], okrs: [] }, analysis: { analyses: [], activeId: null } };
    const { bundle } = prepareExport(
      { company: 'C', project: 'P', data, useCases: list, byId: pack.byId, now },
      { lang: 'en', audience: 'internal', themeId: null, include: { kpi: false, analysis: false, useCases: true } },
    );
    for (const text of [toMarkdown(bundle), toJson(bundle)]) {
      const back = parseImport(text);
      if (!back.ok) throw new Error(back.error);
      expect(back.result.useCases).toEqual(list);
      expect(classifyUseCases(back.result.useCases!, list).every((c) => c.status === 'identical')).toBe(true);
    }
    const noUc = prepareExport(
      { company: 'C', project: 'P', data, useCases: list, byId: pack.byId, now },
      { lang: 'en', audience: 'internal', themeId: null, include: { kpi: false, analysis: false, useCases: false } },
    );
    const back = parseImport(toJson(noUc.bundle));
    expect(back.ok && back.result.useCases).toBeNull();
  });

  describe('store glue (written via useUseCases)', () => {
    beforeEach(() => {
      localStorage.clear();
      useProjects.setState({ companies: [], projects: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
    });

    it('commit writes the selection and undo restores the previous list', () => {
      useUseCases.getState().set([uc('a', 'Alpha'), uc('b', 'Beta')]);
      const before = useUseCases.getState().value;
      const cands = classifyUseCases([uc('b', 'Beta v2'), uc('d', 'Delta')], before);
      const res = applyUseCaseSelection(before, cands, { b: 'keep', d: 'add' }, now);
      commitUseCaseImport(res.next);
      expect(useUseCases.getState().value.map((u) => u.id)).toEqual(['a', 'b', 'd']);
      expect(loc(useUseCases.getState().value[1]!.name)).toBe('Beta');
      expect(canUndoUseCaseImport()).toBe(true);
      undoUseCaseImport();
      expect(useUseCases.getState().value).toBe(before);
      expect(canUndoUseCaseImport()).toBe(false);
    });
  });
});

const loc = (n: UseCase['name']) => (typeof n === 'string' ? n : n.en);
