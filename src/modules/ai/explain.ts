import type { Entity, EntityKind, EntityOf } from '../../data/schema.ts';
import { entitiesOf, getEntity, neighbors, loaded } from '../../data/pack.ts';
import { kpiProgress } from '../../domain/kpi.ts';
import { translate, type Lang, type MessageKey } from '../../i18n/core.ts';

/** A data-bearing component of the current screen (FR-274, FR-278). */
export interface ScreenComponent {
  id: string;
  label: MessageKey;
  entityIds: string[];
}

const ids = (kind: EntityKind) => entitiesOf(kind).map((e) => e.id);
const comp = (kind: EntityKind): ScreenComponent => ({ id: kind, label: `kind.${kind}`, entityIds: ids(kind) });

/**
 * Route → components whose data the screen shows. Interpretation: core screens are owned by the integrator, so the AI
 * module derives the component list from the route and the pack instead of introspecting rendered components.
 */
export function componentsForRoute(path: string): ScreenComponent[] {
  const [first, second] = path.split('/').filter(Boolean);
  if (first === 'entity' && second && getEntity(second)) {
    return [
      { id: 'focus', label: 'ai.comp.focus', entityIds: [second] },
      { id: 'related', label: 'ai.comp.related', entityIds: neighbors(second).map((n) => n.entity.id).filter((id, i, a) => a.indexOf(id) === i) },
    ];
  }
  switch (first) {
    case undefined: return [comp('kpi'), comp('issue'), comp('solution')];
    case 'plan': return [comp('initiative'), comp('solution')];
    case 'optimize': return [comp('site'), { id: 'kpi', label: 'kind.kpi', entityIds: ['kpi-co2', 'kpi-lead-time'].filter((id) => getEntity(id)) }];
    case 'map':
    case 'flows': return [comp('site'), comp('supplier'), comp('customer')];
    case 'directory': return [comp('customer'), comp('deal'), comp('invoice')];
    default: return [comp('issue'), comp('solution'), comp('kpi')];
  }
}

export function entitiesOfComponents(components: ScreenComponent[]): Entity[] {
  const seen = new Set<string>();
  const out: Entity[] = [];
  for (const c of components) {
    for (const id of c.entityIds) {
      const e = loaded.byId.get(id);
      if (e && !seen.has(id)) {
        seen.add(id);
        out.push(e);
      }
    }
  }
  return out;
}

export interface IssueExplanation {
  issue: EntityOf<'issue'>;
  solutions: EntityOf<'solution'>[];
  kpis: EntityOf<'kpi'>[];
}

export interface Explanation {
  issues: IssueExplanation[];
  kpis: { kpi: EntityOf<'kpi'>; progress: number }[];
}

/**
 * FR-277 deterministic explanation built from data only: the issues in (or related to) the screen, the solutions that
 * resolve them and the KPIs they move, ordered by impact. `allow` filters what may be shown (audience / outbound).
 */
export function buildExplanation(entities: Entity[], allow: (e: Entity) => boolean = () => true): Explanation {
  const inScope = new Set(entities.filter(allow).map((e) => e.id));
  const solutions = entitiesOf('solution').filter(allow);
  const issueIds = new Set<string>();
  for (const e of entities.filter(allow)) {
    if (e.kind === 'issue') issueIds.add(e.id);
    if (e.kind === 'solution') e.issueIds.forEach((i) => issueIds.add(i));
    if (e.kind === 'initiative') getSolutionIssues(e.solutionId).forEach((i) => issueIds.add(i));
    if (e.kind === 'kpi') entitiesOf('issue').filter((i) => i.kpiIds.includes(e.id)).forEach((i) => issueIds.add(i.id));
  }
  const issues = entitiesOf('issue')
    .filter((i) => issueIds.has(i.id) && allow(i))
    .sort((a, b) => b.impact - a.impact || a.id.localeCompare(b.id))
    .map((issue) => {
      const sols = solutions.filter((s) => s.issueIds.includes(issue.id));
      const kpiIds = new Set([...issue.kpiIds, ...sols.flatMap((s) => s.kpiIds)]);
      const kpis = entitiesOf('kpi').filter((k) => kpiIds.has(k.id) && allow(k));
      return { issue, solutions: sols, kpis };
    });
  const kpis = entitiesOf('kpi')
    .filter((k) => allow(k) && (inScope.has(k.id) || issues.some((x) => x.kpis.includes(k))))
    .map((kpi) => ({ kpi, progress: kpiProgress(kpi) }));
  return { issues, kpis };
}

function getSolutionIssues(solutionId: string): string[] {
  const s = getEntity(solutionId);
  return s?.kind === 'solution' ? s.issueIds : [];
}

/** Plain-text form of the explanation (what the "explain" mock answers). */
export function explanationText(x: Explanation, lang: Lang): string {
  if (x.issues.length === 0 && x.kpis.length === 0) return translate(lang, 'ai.explain.empty');
  const lines: string[] = [];
  for (const { issue, solutions, kpis } of x.issues.slice(0, 5)) {
    lines.push(translate(lang, 'ai.explain.issueLine', {
      issue: issue.name[lang],
      solutions: solutions.map((s) => s.name[lang]).join(', ') || translate(lang, 'ai.explain.none'),
      kpis: kpis.map((k) => k.name[lang]).join(', ') || translate(lang, 'ai.explain.none'),
    }));
  }
  for (const { kpi, progress } of x.kpis.slice(0, 5)) {
    lines.push(translate(lang, 'ai.explain.kpiLine', { kpi: kpi.name[lang], progress: Math.round(progress * 100) }));
  }
  return lines.join('\n');
}
