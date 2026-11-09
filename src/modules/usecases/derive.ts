import { entitiesOf, getEntity, loaded, type LoadedPack } from '../../data/pack.ts';
import type { EntityOf } from '../../data/schema.ts';
import type { PersonaView } from '../../state/personas.ts';
import { both } from './bitext.ts';
import { MAX_USECASE_STEPS, type UseCase, type UseCaseStep } from './store.ts';

const CANDIDATE_AT = '1970-01-01T00:00:00.000Z';

function personaFor(sol: EntityOf<'solution'>, index: number, data: LoadedPack): PersonaView {
  const issues = sol.issueIds.map((id) => getEntity(id, data)).filter((e): e is EntityOf<'issue'> => e?.kind === 'issue');
  if (issues.some((i) => i.impact >= 5)) return 'executive';
  if (sol.type === 'model') return 'it';
  return (['business', 'field', 'it'] as const)[index % 3]!;
}

/**
 * FR-158: use-case candidates derived from the pack's issues and solutions (origin 'derived', not saved).
 * One candidate per solution: confirm the issue → each cause → apply the solution → measure each KPI → effect.
 */
export function deriveCandidates(data: LoadedPack = loaded): UseCase[] {
  return entitiesOf('solution', data).map((sol, index) => {
    const issues = sol.issueIds.map((id) => getEntity(id, data)).filter((e): e is EntityOf<'issue'> => e?.kind === 'issue');
    const causes = [...new Set(issues.flatMap((i) => i.causeIds))].map((id) => getEntity(id, data)).filter((e) => e?.kind === 'cause');
    const kpis = [...new Set([...sol.kpiIds, ...issues.flatMap((i) => i.kpiIds)])].map((id) => getEntity(id, data)).filter((e): e is EntityOf<'kpi'> => e?.kind === 'kpi');
    const steps: UseCaseStep[] = [
      ...issues.map((i) => ({ title: both('uc.derive.issueTitle', { name: i.name }), description: i.description })),
      ...causes.map((c) => ({ title: both('uc.derive.causeTitle', { name: c!.name }), description: c!.description })),
      { title: both('uc.derive.solutionTitle', { name: sol.name }), description: sol.description },
      ...kpis.map((k) => ({ title: both('uc.derive.kpiTitle', { name: k.name }), description: k.description })),
    ].slice(0, MAX_USECASE_STEPS);
    const firstKpi = kpis[0];
    return {
      id: `derived-${sol.id}`,
      name: sol.name,
      summary: issues[0] ? both('uc.derive.summary', { issue: issues[0].name, solution: sol.name }) : sol.description,
      persona: personaFor(sol, index, data),
      steps,
      effect: firstKpi ? both('uc.derive.effect', { kpi: firstKpi.name, from: firstKpi.current, to: firstKpi.target, unit: firstKpi.unit }) : undefined,
      relatedIds: [sol.id, ...issues.map((i) => i.id), ...causes.map((c) => c!.id), ...kpis.map((k) => k.id)],
      origin: 'derived',
      updatedAt: CANDIDATE_AT,
      derivedFrom: sol.id,
    } satisfies UseCase;
  });
}

/** Candidates not yet registered (a deleted registration makes its candidate available again). */
export function openCandidates(registered: UseCase[], data: LoadedPack = loaded): UseCase[] {
  const taken = new Set(registered.map((u) => u.derivedFrom).filter(Boolean));
  return deriveCandidates(data).filter((c) => !taken.has(c.derivedFrom));
}
