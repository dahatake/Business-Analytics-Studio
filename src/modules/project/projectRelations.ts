import type { Project, ProjectRelation } from '../../state/projects.ts';

/** PARAM-150: overlap of the projects' wording (0..1) from which a pair is offered as a possible relation. */
export const SUGGEST_THRESHOLD = 0.2;
export const MAX_SUGGESTIONS = 5;

const textOf = (p: Project) => [p.name, p.brief?.purpose, p.brief?.focus].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();

function bigrams(text: string): Set<string> {
  const s = text.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const out = new Set<string>();
  for (const word of s.split(' ')) for (let i = 0; i + 1 < word.length; i++) out.add(word.slice(i, i + 2));
  return out;
}

/** Words worth showing as the reason for a suggestion: Latin words of 3+ letters, CJK runs of 2+ characters. */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[a-z0-9]{3,}|[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu)) out.add(m[0]);
  return out;
}

/** Jaccard overlap of character bigrams of name, purpose and focus; language independent and deterministic. */
export function similarity(a: Project, b: Project): number {
  const x = bigrams(textOf(a));
  const y = bigrams(textOf(b));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return common / (x.size + y.size - common);
}

export interface RelationSuggestion {
  from: string;
  to: string;
  score: number;
  shared: string[];
}

/**
 * Pairs whose wording overlaps although nobody linked them yet: what the customer calls separate issues may be one,
 * or depend on each other. A hint for people to confirm, never a relation by itself.
 */
export function suggestRelations(projects: Project[], relations: ProjectRelation[]): RelationSuggestion[] {
  const linked = new Set(relations.flatMap((r) => [`${r.from}|${r.to}`, `${r.to}|${r.from}`]));
  const out: RelationSuggestion[] = [];
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i]!;
      const b = projects[j]!;
      if (linked.has(`${a.id}|${b.id}`)) continue;
      const score = similarity(a, b);
      if (score < SUGGEST_THRESHOLD) continue;
      const tb = terms(textOf(b));
      out.push({ from: a.id, to: b.id, score, shared: [...terms(textOf(a))].filter((w) => tb.has(w)).slice(0, 5) });
    }
  }
  return out.sort((p, q) => q.score - p.score).slice(0, MAX_SUGGESTIONS);
}

/** Projects joined by "same issue" relations (transitively), only groups of two or more. */
export function sameIssueGroups(projects: Project[], relations: ProjectRelation[]): string[][] {
  const parent = new Map(projects.map((p) => [p.id, p.id]));
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  for (const r of relations) if (r.kind === 'same' && parent.has(r.from) && parent.has(r.to)) parent.set(find(r.from), find(r.to));
  const groups = new Map<string, string[]>();
  for (const p of projects) groups.set(find(p.id), [...(groups.get(find(p.id)) ?? []), p.id]);
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Projects evenly on a circle around the company in the centre, starting at the top. */
export function circleLayout(count: number, cx: number, cy: number, r: number): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, count);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}
