import { describe, expect, it, beforeEach } from 'vitest';
import { closesCycle, createScopedStore, MAX_PROJECTS_PER_COMPANY, onProjectDeleted, scopedKey, useProjects } from '../src/state/projects.ts';
import { UndoStack } from '../src/state/history.ts';

describe('companies and projects (FR-137〜139)', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjects.setState({ companies: [], projects: [], relations: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
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

  it('validates renames without changing identity, scope data or selection, and persists them', async () => {
    const s = useProjects.getState();
    const a = s.addCompany('A');
    const b = s.addCompany('B');
    if (!a.ok || !b.ok) throw new Error();
    const one = s.addProject(a.id, 'One');
    const two = s.addProject(a.id, 'Two');
    const other = s.addProject(b.id, 'Elsewhere');
    if (!one.ok || !two.ok || !other.ok) throw new Error();
    s.setTarget({ kind: 'project', projectId: one.id });
    s.setStep('kpi');
    const companyBefore = useProjects.getState().companies[0]!;
    const projectBefore = useProjects.getState().projects[0]!;
    localStorage.setItem(scopedKey(one.id, 'notes'), 'keep me');

    expect(s.renameCompany(a.id, '  ')).toEqual({ ok: false, reason: 'emptyName' });
    expect(s.renameCompany(a.id, ' B ')).toEqual({ ok: false, reason: 'duplicate' });
    expect(s.renameCompany('missing', 'C')).toEqual({ ok: false, reason: 'notFound' });
    expect(s.renameProject(one.id, '  ')).toEqual({ ok: false, reason: 'emptyName' });
    expect(s.renameProject(one.id, ' Two ')).toEqual({ ok: false, reason: 'duplicate' });
    expect(s.renameProject('missing', 'X')).toEqual({ ok: false, reason: 'notFound' });
    expect(useProjects.getState().companies[0]).toEqual(companyBefore);
    expect(useProjects.getState().projects[0]).toEqual(projectBefore);

    expect(s.renameCompany(a.id, ' A ')).toEqual({ ok: true });
    expect(s.renameProject(one.id, ' One ')).toEqual({ ok: true });
    expect(s.renameCompany(a.id, ' Renamed ')).toEqual({ ok: true });
    // Project names are unique within a company, not across companies.
    expect(s.renameProject(one.id, ' Elsewhere ')).toEqual({ ok: true });
    const renamedCompanies = useProjects.getState().companies;
    const renamedProjects = useProjects.getState().projects;
    expect(renamedCompanies[0]).toEqual({ ...companyBefore, name: 'Renamed' });
    expect(renamedProjects[0]).toEqual({ ...projectBefore, name: 'Elsewhere' });
    expect(localStorage.getItem(scopedKey(one.id, 'notes'))).toBe('keep me');

    const persisted = localStorage.getItem('bas.projects');
    expect(persisted).not.toBeNull();
    useProjects.setState({ companies: [], projects: [] }, false);
    localStorage.setItem('bas.projects', persisted!);
    await useProjects.persist.rehydrate();
    expect(useProjects.getState().companies).toEqual(renamedCompanies);
    expect(useProjects.getState().projects).toEqual(renamedProjects);
    expect(useProjects.getState().target).toEqual({ kind: 'project', projectId: one.id });
    expect(useProjects.getState().lastProjectId).toBe(one.id);
  });

  it('cascades company deletion, clears active and last selection, and preserves unrelated data', () => {
    const s = useProjects.getState();
    const a = s.addCompany('A');
    const b = s.addCompany('B');
    if (!a.ok || !b.ok) throw new Error();
    const one = s.addProject(a.id, 'One');
    const two = s.addProject(a.id, 'Two');
    const other = s.addProject(b.id, 'Other');
    if (!one.ok || !two.ok || !other.ok) throw new Error();
    for (const id of [one.id, two.id, other.id, 'demo']) localStorage.setItem(scopedKey(id, 'notes'), id);
    s.setTarget({ kind: 'project', projectId: one.id });
    const deleted: string[] = [];
    const unsubscribe = onProjectDeleted((id) => deleted.push(id));
    try {
      s.deleteCompany(a.id);
    } finally {
      unsubscribe();
    }
    expect(deleted).toEqual([one.id, two.id]);
    expect(useProjects.getState().companies.map((c) => c.id)).toEqual([b.id]);
    expect(useProjects.getState().projects.map((p) => p.id)).toEqual([other.id]);
    expect(useProjects.getState().target).toEqual({ kind: 'demo' });
    expect(useProjects.getState().lastProjectId).toBeNull();
    expect(localStorage.getItem(scopedKey(one.id, 'notes'))).toBeNull();
    expect(localStorage.getItem(scopedKey(two.id, 'notes'))).toBeNull();
    expect(localStorage.getItem(scopedKey(other.id, 'notes'))).toBe(other.id);
    expect(localStorage.getItem(scopedKey('demo', 'notes'))).toBe('demo');
  });

  it('keeps an empty company and an unrelated active target when deleting its last project', () => {
    const s = useProjects.getState();
    const c = s.addCompany('A');
    if (!c.ok) throw new Error();
    const p = s.addProject(c.id, 'One');
    if (!p.ok) throw new Error();
    s.setTarget({ kind: 'project', projectId: p.id });
    s.setTarget({ kind: 'demo' });
    s.deleteProject(p.id);
    expect(useProjects.getState().companies.map((company) => company.id)).toEqual([c.id]);
    expect(useProjects.getState().projects).toEqual([]);
    expect(useProjects.getState().target).toEqual({ kind: 'demo' });
    expect(useProjects.getState().lastProjectId).toBeNull();
    expect(s.addProject(c.id, 'New').ok).toBe(true);
  });
});

describe('company information and project inputs', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjects.setState({ companies: [], projects: [], relations: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
  });

  it('keeps company information once per company and the inputs per project, trimming and clearing fields', () => {
    const s = useProjects.getState();
    const c = s.addCompany('Contoso', { industry: ' Retail ', officialUrl: 'https://contoso.example' });
    if (!c.ok) throw new Error();
    const p = s.addProject(c.id, 'Sales', { purpose: 'Line 1\nLine 2', materialNames: ['a.csv'] });
    if (!p.ok) throw new Error();
    expect(useProjects.getState().companies[0]).toMatchObject({ industry: 'Retail', officialUrl: 'https://contoso.example' });
    expect(useProjects.getState().projects[0]!.brief).toEqual({ purpose: 'Line 1\nLine 2', materialNames: ['a.csv'] });

    s.updateCompanyProfile(c.id, { notes: 'Global sales org', officialUrl: '' });
    expect(useProjects.getState().companies[0]).toMatchObject({ industry: 'Retail', notes: 'Global sales org' });
    expect(useProjects.getState().companies[0]).not.toHaveProperty('officialUrl');

    s.updateProjectBrief(p.id, { focus: 'Japan', materialNames: [], useWorkIq: true });
    expect(useProjects.getState().projects[0]!.brief).toEqual({ purpose: 'Line 1\nLine 2', focus: 'Japan', useWorkIq: true });
  });

  it('registers relations once per pair, rejects self, other company and cycles, and drops them with the project', () => {
    const s = useProjects.getState();
    const a = s.addCompany('A');
    const b = s.addCompany('B');
    if (!a.ok || !b.ok) throw new Error();
    const [x, y, z, other] = [s.addProject(a.id, 'X'), s.addProject(a.id, 'Y'), s.addProject(a.id, 'Z'), s.addProject(b.id, 'O')];
    if (!x.ok || !y.ok || !z.ok || !other.ok) throw new Error();

    expect(s.addRelation(x.id, x.id, 'same')).toEqual({ ok: false, reason: 'self' });
    expect(s.addRelation(x.id, 'missing', 'same')).toEqual({ ok: false, reason: 'notFound' });
    expect(s.addRelation(x.id, other.id, 'correlated')).toEqual({ ok: false, reason: 'otherCompany' });
    expect(s.addRelation(x.id, y.id, 'dependsOn').ok).toBe(true);
    expect(s.addRelation(y.id, x.id, 'correlated')).toEqual({ ok: false, reason: 'duplicate' });
    expect(s.addRelation(y.id, z.id, 'dependsOn').ok).toBe(true);
    // X → Y → Z, so Z → X would close a loop.
    expect(s.addRelation(z.id, x.id, 'dependsOn')).toEqual({ ok: false, reason: 'cycle' });
    expect(closesCycle(useProjects.getState().relations, z.id, x.id)).toBe(true);
    const r = s.addRelation(z.id, x.id, 'correlated', '  same customers ');
    expect(r.ok).toBe(true);
    expect(useProjects.getState().relations.find((rel) => r.ok && rel.id === r.id)).toMatchObject({ companyId: a.id, note: 'same customers' });

    s.deleteProject(y.id);
    expect(useProjects.getState().relations.map((rel) => [rel.from, rel.to])).toEqual([[z.id, x.id]]);
    s.deleteCompany(a.id);
    expect(useProjects.getState().relations).toEqual([]);
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
