import type { Entity } from './schema.ts';
import { isNewsDerived, loaded, type Edge, type LoadedPack, type RelationType } from './pack.ts';
export { isNewsDerived } from './pack.ts';

export interface NewsExclusion { headlines: number; derived: number }

export function newsExclusion(visible: (e: Entity) => boolean, data: LoadedPack = loaded): NewsExclusion {
  const out = { headlines: 0, derived: 0 };
  for (const e of data.pack.entities) {
    if (!visible(e) || !isNewsDerived(e, data.byId)) continue;
    if (e.kind === 'source') out.headlines++;
    else out.derived++;
  }
  return out;
}

export function allowedEdges(allow: (e: Entity) => boolean, data: LoadedPack = loaded): Edge[] {
  return data.edges.filter((edge) => {
    const s = data.byId.get(edge.source), t = data.byId.get(edge.target);
    return !!s && !!t && !isNewsDerived(s, data.byId) && !isNewsDerived(t, data.byId) && allow(s) && allow(t);
  });
}

export function degrees(edges: Edge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const e of edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  return degree;
}

export interface RelationGroup { type: RelationType; direction: 'out' | 'in'; ids: string[] }
export type EvidenceKind = 'internal' | 'm365' | 'public';
export type Gap = 'noEvidence' | 'noCause' | 'noKpi' | 'noSolution' | 'noInitiative' | 'unmeasured' | 'orphanCause' | 'uncited';

export interface EntityAnalysis {
  groups: RelationGroup[];
  evidence: { id: string; kind: EvidenceKind }[];
  /** Items that cite this entity (sources only). */
  citedBy: string[];
  degree: number;
  /** 1-based rank by connections among allowed entities that have any (ties share the better rank). */
  rank: number;
  ranked: number;
  gaps: Gap[];
}

export function evidenceKind(s: Entity): EvidenceKind {
  if (s.kind === 'source' && s.origin === 'm365') return 'm365';
  return s.classification === 'internal' ? 'internal' : 'public';
}

/** What the allowed (non-news) data says about one entity: its relations, evidence and structural gaps. */
export function analyzeEntity(id: string, allow: (e: Entity) => boolean, data: LoadedPack = loaded): EntityAnalysis | null {
  const e = data.byId.get(id);
  if (!e || isNewsDerived(e, data.byId) || !allow(e)) return null;
  const edges = allowedEdges(allow, data);
  const groups = new Map<string, RelationGroup>();
  const evidence: EntityAnalysis['evidence'] = [];
  const citedBy: string[] = [];
  const count = (type: RelationType, direction: 'out' | 'in') => groups.get(`${direction}:${type}`)?.ids.length ?? 0;
  for (const edge of edges) {
    const direction = edge.source === id ? 'out' : edge.target === id ? 'in' : null;
    if (!direction) continue;
    const other = direction === 'out' ? edge.target : edge.source;
    if (edge.type === 'citedFrom') {
      if (direction === 'out') evidence.push({ id: other, kind: evidenceKind(data.byId.get(other)!) });
      else citedBy.push(other);
      continue;
    }
    const key = `${direction}:${edge.type}`;
    const group = groups.get(key) ?? { type: edge.type, direction, ids: [] };
    group.ids.push(other);
    groups.set(key, group);
  }

  const gaps: Gap[] = [];
  if (e.kind === 'source') {
    if (citedBy.length === 0) gaps.push('uncited');
  } else if (evidence.length === 0) {
    gaps.push('noEvidence');
  }
  switch (e.kind) {
    case 'issue':
      if (count('causedBy', 'out') === 0) gaps.push('noCause');
      if (count('measuredBy', 'out') === 0) gaps.push('noKpi');
      if (count('resolves', 'in') === 0) gaps.push('noSolution');
      break;
    case 'solution':
      if (count('improves', 'out') === 0) gaps.push('noKpi');
      if (count('implements', 'in') === 0) gaps.push('noInitiative');
      break;
    case 'kpi':
      if (count('measuredBy', 'in') === 0 && count('improves', 'in') === 0) gaps.push('unmeasured');
      break;
    case 'cause':
      if (count('causedBy', 'in') === 0) gaps.push('orphanCause');
      break;
    default: break;
  }

  const degree = degrees(edges);
  const own = degree.get(id) ?? 0;
  const rank = 1 + [...degree.values()].filter((d) => d > own).length;
  return { groups: [...groups.values()], evidence, citedBy, degree: own, rank, ranked: degree.size, gaps };
}
