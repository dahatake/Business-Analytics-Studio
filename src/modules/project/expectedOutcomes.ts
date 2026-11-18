import type { EntityOf } from '../../data/schema.ts';
import type { AppCheckContext } from './deliverables.ts';
import { proposeKpiDefinition } from './kpiOkr.ts';
import type { KpiDef, Okr } from './model.ts';
import type { KpiSimulation } from './simulate.ts';
import { strategyThread, type Contribution } from './strategy.ts';
import type { Lang } from '../../i18n/core.ts';

export interface KpiOutcome {
  definition: KpiDef;
  simulation?: KpiSimulation;
  contributions: Contribution[];
}

export interface OkrOutcome {
  definition: Okr;
  keyResults: { text: string; kpi?: KpiOutcome }[];
}

export interface ExpectedOutcomes {
  kpis: KpiOutcome[];
  okrs: OkrOutcome[];
  solutions: EntityOf<'solution'>[];
  issues: EntityOf<'issue'>[];
  proposedDefinitions: boolean;
}

export function expectedOutcomes(ctx: AppCheckContext, lang: Lang): ExpectedOutcomes {
  const proposedDefinitions = ctx.kpi.kpis.length === 0 || ctx.kpi.okrs.length === 0;
  const kpiData = proposedDefinitions
    ? proposeKpiDefinition({
      pack: ctx.pack.pack,
      current: ctx.kpi,
      objectives: ctx.objectives,
      deadline: `${Number(ctx.today.slice(0, 4)) + 1}${ctx.today.slice(4)}`,
      lang,
    })
    : ctx.kpi;
  const thread = strategyThread({
    pack: ctx.pack,
    kpi: kpiData,
    useCases: ctx.useCases,
    strategy: ctx.strategy,
    objectives: ctx.objectives,
    projectObjectiveIds: ctx.projectObjectiveIds,
  });
  const simulationById = new Map(thread.sims.map((s) => [s.kpiId, s]));
  const kpis = kpiData.kpis.map((definition): KpiOutcome => ({
    definition,
    simulation: simulationById.get(definition.id),
    contributions: ctx.strategy.contributions.filter((c) => c.kpiId === definition.id),
  }));
  const kpiById = new Map(kpis.map((k) => [k.definition.id, k]));

  return {
    kpis,
    okrs: kpiData.okrs.map((definition) => ({
      definition,
      keyResults: definition.keyResults.map((kr) => ({ text: typeof kr.text === 'string' ? kr.text : kr.text[lang], kpi: kpiById.get(kr.kpiId) })),
    })),
    solutions: ctx.pack.pack.entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution'),
    issues: kpis.length === 0
      ? ctx.pack.pack.entities.filter((e): e is EntityOf<'issue'> => e.kind === 'issue')
      : [],
    proposedDefinitions,
  };
}
