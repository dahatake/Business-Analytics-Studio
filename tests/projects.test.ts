import { describe, expect, it, beforeEach } from 'vitest';
import { createScopedStore, MAX_PROJECTS_PER_COMPANY, scopedKey, useProjects } from '../src/state/projects.ts';
import { UndoStack } from '../src/state/history.ts';

describe('companies and projects (FR-137〜139)', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjects.setState({ companies: [], projects: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
  });

  it('validates names and enforces PARAM-031 per company', () => {
    const s = useProjects.getState();
    expect(s.addCompany('  ')).toEqual({ ok: false, reason: 'emptyName' });
    const c = s.addCompany('Contoso');
    if (!c.ok) throw new Error();
    expect(s.addCompany('Contoso')).toEqual({ ok: false, reason: 'duplicate' });
    for (let i = 0; i < MAX_PROJECTS_PER_COMPANY; i++) expect(useProjects.getState().addProject(c.id, `P${i}`).ok).toBe(true);
    expect(useProjects.getState().addProject(c.id, 'one more')).toEqual({ ok: false, reason: 'limit' });
    expect(useProjects.getState().addProject('nope', 'x')).toEqual({ ok: false, reason: 'noCompany' });
  });

  it('keeps project data isolated and deletes it with the project (G-007: zero mixing)', () => {
    const notes = createScopedStore<string[]>('notes', (scope) => (scope === 'demo' ? ['sample'] : []));
    const c = useProjects.getState().addCompany('A');
    if (!c.ok) throw new Error();
    const p1 = useProjects.getState().addProject(c.id, 'One');
    const p2 = useProjects.getState().addProject(c.id, 'Two');
    if (!p1.ok || !p2.ok) throw new Error();

    expect(notes.getState().value).toEqual(['sample']);
    useProjects.getState().setTarget({ kind: 'project', projectId: p1.id });
    expect(notes.getState().value).toEqual([]);
    notes.getState().set((v) => [...v, 'p1 secret']);
    useProjects.getState().setTarget({ kind: 'project', projectId: p2.id });
    expect(notes.getState().value).toEqual([]);
    notes.getState().set(['p2 note']);
    useProjects.getState().setTarget({ kind: 'project', projectId: p1.id });
    expect(notes.getState().value).toEqual(['p1 secret']);
    useProjects.getState().setTarget({ kind: 'demo' });
    expect(notes.getState().value).toEqual(['sample']);

    useProjects.getState().deleteProject(p1.id);
    expect(localStorage.getItem(scopedKey(p1.id, 'notes'))).toBeNull();
    expect(localStorage.getItem(scopedKey(p2.id, 'notes'))).not.toBeNull();
  });

  it('tracks the improvement step per project', () => {
    const c = useProjects.getState().addCompany('B');
    if (!c.ok) throw new Error();
    const p = useProjects.getState().addProject(c.id, 'X');
    if (!p.ok) throw new Error();
    useProjects.getState().setTarget({ kind: 'project', projectId: p.id });
    useProjects.getState().setStep('kpi');
    expect(useProjects.getState().projects[0]!.step).toBe('kpi');
    expect(useProjects.getState().demoStep).toBe('define');
  });
});

describe('UndoStack (FR-046, PARAM-024)', () => {
  it('undoes, redoes, clears redo on new edits and caps history', () => {
    const s = new UndoStack(0, 3);
    [1, 2, 3, 4].forEach((v) => s.push(v));
    expect(s.depth).toBe(3);
    expect(s.undo()).toBe(3);
    expect(s.undo()).toBe(2);
    expect(s.undo()).toBe(1);
    expect(s.canUndo).toBe(false);
    expect(s.redo()).toBe(2);
    s.push(9);
    expect(s.canRedo).toBe(false);
    expect(s.value).toBe(9);
  });
});
