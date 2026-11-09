import { beforeEach, describe, expect, it } from 'vitest';
import { useProjects, scopedKey } from '../src/state/projects.ts';
import { minimize, rectOf, moveWin } from '../src/modules/workspace/layout.ts';
import { defaultLayout } from '../src/modules/workspace/personas.ts';
import { layoutOf, resetLayout, setLayout, switchPersona, useWorkspace } from '../src/modules/workspace/store.ts';
import { filterCommands } from '../src/modules/workspace/commands.ts';

const AREA = { width: 1000, height: 640 };

describe('workspace store (FR-014, FR-015, FR-110, NFR-UX-001, FR-138)', () => {
  beforeEach(() => {
    useProjects.setState({ target: { kind: 'demo' } });
    useWorkspace.getState().reset();
  });

  it('starts with the executive view and its default layout', () => {
    const d = useWorkspace.getState().value;
    expect(d.persona).toBe('executive');
    expect(layoutOf(d)).toEqual(defaultLayout('executive'));
  });

  it('keeps a separate saved layout per persona, in localStorage', () => {
    setLayout((l) => minimize(l, 'kpi'));
    switchPersona('business');
    setLayout((l) => moveWin(l, 'chain', rectOf(0, 0, 0.5, 1), AREA));
    switchPersona('executive');
    const d = useWorkspace.getState().value;
    expect(layoutOf(d, 'executive').wins.find((w) => w.id === 'kpi')!.state).toBe('minimized');
    expect(layoutOf(d, 'business').wins.find((w) => w.id === 'chain')!.rect).toEqual(rectOf(0, 0, 0.5, 1));
    const saved = JSON.parse(localStorage.getItem(scopedKey('demo', 'workspace'))!);
    expect(saved.persona).toBe('executive');
    expect(Object.keys(saved.layouts).sort()).toEqual(['business', 'executive']);
    expect(saved.recent.map((r: { persona: string }) => r.persona)).toEqual(['executive', 'business']);
  });

  it('reset returns only the current persona to its default', () => {
    setLayout((l) => minimize(l, 'kpi'));
    switchPersona('it');
    setLayout((l) => minimize(l, 'kpi'));
    resetLayout();
    const d = useWorkspace.getState().value;
    expect(layoutOf(d, 'it')).toEqual(defaultLayout('it'));
    expect(layoutOf(d, 'executive').wins.find((w) => w.id === 'kpi')!.state).toBe('minimized');
  });

  it('each project keeps its own layouts', () => {
    setLayout((l) => minimize(l, 'kpi'));
    useProjects.setState({ target: { kind: 'project', projectId: 'pj-x' } });
    expect(layoutOf(useWorkspace.getState().value)).toEqual(defaultLayout('executive'));
    useProjects.setState({ target: { kind: 'demo' } });
    expect(layoutOf(useWorkspace.getState().value).wins.find((w) => w.id === 'kpi')!.state).toBe('minimized');
    localStorage.removeItem(scopedKey('pj-x', 'workspace'));
  });
});

describe('command palette filter (FR-111)', () => {
  const cmds = ['Go to Plan', 'Go to Map', 'Switch to the IT view', 'Reset the workspace layout'].map((label) => ({ id: label, label, run: () => {} }));
  it('matches every word, case-insensitively', () => {
    expect(filterCommands(cmds, 'plan').map((c) => c.label)).toEqual(['Go to Plan']);
    expect(filterCommands(cmds, 'go MAP').map((c) => c.label)).toEqual(['Go to Map']);
    expect(filterCommands(cmds, '')).toHaveLength(4);
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
  });
});
