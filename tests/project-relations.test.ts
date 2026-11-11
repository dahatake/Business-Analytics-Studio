import { describe, expect, it } from 'vitest';
import type { Project, ProjectRelation } from '../src/state/projects.ts';
import { circleLayout, MAX_SUGGESTIONS, sameIssueGroups, similarity, suggestRelations, SUGGEST_THRESHOLD } from '../src/modules/project/projectRelations.ts';

const project = (id: string, name: string, purpose?: string): Project => ({
  id, companyId: 'c', name, createdAt: '2025-01-01T00:00:00Z', step: 'define', ...(purpose ? { brief: { purpose } } : {}),
});
const relation = (from: string, to: string, kind: ProjectRelation['kind']): ProjectRelation => ({
  id: `${from}-${to}`, companyId: 'c', from, to, kind, createdAt: '2025-01-01T00:00:00Z',
});

describe('relations between projects (PARAM-150)', () => {
  const a = project('a', '営業パイプライン可視化', '受注予測の精度を上げ、営業パイプラインの滞留を減らす');
  const b = project('b', '受注予測の改善', '営業パイプラインのデータから受注予測を作る');
  const c = project('c', 'Office move', 'Plan the new office layout');

  it('scores wording overlap symmetrically between 0 and 1, ignoring width and case', () => {
    expect(similarity(a, b)).toBeGreaterThan(SUGGEST_THRESHOLD);
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a));
    expect(similarity(a, c)).toBeLessThan(SUGGEST_THRESHOLD);
    expect(similarity(project('x', 'ＣＲＭ Data'), project('y', 'crm data'))).toBe(1);
    expect(similarity(project('x', 'A'), project('y', 'A'))).toBe(0);
  });

  it('suggests unlinked similar pairs with the shared terms, and nothing once they are linked', () => {
    const s = suggestRelations([a, b, c], []);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ from: 'a', to: 'b' });
    expect(s[0]!.shared).toEqual(expect.arrayContaining(['営業パイプライン', '受注予測']));
    expect(suggestRelations([a, b, c], [relation('b', 'a', 'correlated')])).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => project(`p${i}`, `CRM data quality ${i}`));
    expect(suggestRelations(many, [])).toHaveLength(MAX_SUGGESTIONS);
  });

  it('groups projects joined by same-issue relations transitively, ignoring other kinds', () => {
    const ps = ['p', 'q', 'r', 's', 't'].map((id) => project(id, id));
    const groups = sameIssueGroups(ps, [relation('p', 'q', 'same'), relation('r', 'q', 'same'), relation('s', 't', 'dependsOn')]);
    expect(groups.map((g) => [...g].sort())).toEqual([['p', 'q', 'r']]);
  });

  it('places projects evenly on the circle starting at the top', () => {
    const pts = circleLayout(4, 100, 100, 50);
    expect(pts[0]!.x).toBeCloseTo(100);
    expect(pts[0]!.y).toBeCloseTo(50);
    expect(pts[1]!.x).toBeCloseTo(150);
    expect(pts[2]!.y).toBeCloseTo(150);
  });
});
