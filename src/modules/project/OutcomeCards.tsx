import { useMemo, type ComponentPropsWithRef } from 'react';
import { Badge } from '@fluentui/react-components';
import { getEntity } from '../../data/pack.ts';
import type { EntityOf } from '../../data/schema.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import type { Lang } from '../../i18n/core.ts';
import type { Audience } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import type { AppCheckContext } from './deliverables.ts';
import { expectedOutcomes, type ExpectedOutcomes, type KpiOutcome, type OkrOutcome } from './expectedOutcomes.ts';

/**
 * FR-382: one model for the business outcomes, shown as summary cards in the top bar and in Step 2 (To-Be), so both always
 * show the same numbers. The detail of each card is the same content in the bar's hover popup and in Step 2.
 */
export type OutcomeItem =
  | { key: string; kind: 'kpi'; outcome: KpiOutcome }
  | { key: string; kind: 'okr'; outcome: OkrOutcome }
  | { key: string; kind: 'solution'; solution: EntityOf<'solution'> }
  | { key: string; kind: 'issue'; issue: EntityOf<'issue'> };

type Fmt = ReturnType<typeof useI18n>['fmt'];
type T = ReturnType<typeof useI18n>['t'];

/** Outcomes the audience may see: hidden entities, and KPIs that rely on them, are left out. */
export function visibleOutcomes(data: ExpectedOutcomes, audience: Audience) {
  const entityIsVisible = (id: string) => {
    const entity = getEntity(id);
    return !entity || !isHidden(entity, audience);
  };
  const kpis = data.kpis.filter((k) =>
    entityIsVisible(k.definition.id)
    && (k.definition.sourceIds ?? []).every(entityIsVisible)
    && k.contributions.every((c) => entityIsVisible(c.solutionId)));
  const kpiIds = new Set(kpis.map((k) => k.definition.id));
  const okrs = data.okrs.map((okr) => ({
    ...okr,
    keyResults: okr.keyResults.filter((kr) => !kr.kpi || kpiIds.has(kr.kpi.definition.id)),
  })).filter((okr) => okr.keyResults.length > 0);
  const solutions = data.solutions.filter((solution) =>
    entityIsVisible(solution.id) && solution.sourceIds.every(entityIsVisible));
  const issues = data.issues.filter((issue) => entityIsVisible(issue.id));
  return { kpis, okrs, solutions, issues };
}

export function outcomeItems(visible: ReturnType<typeof visibleOutcomes>): OutcomeItem[] {
  return [
    ...visible.kpis.map((outcome): OutcomeItem => ({ key: `kpi-${outcome.definition.id}`, kind: 'kpi', outcome })),
    ...visible.okrs.map((outcome): OutcomeItem => ({ key: `okr-${outcome.definition.id}`, kind: 'okr', outcome })),
    ...visible.solutions.map((solution): OutcomeItem => ({ key: `solution-${solution.id}`, kind: 'solution', solution })),
    ...visible.issues.map((issue): OutcomeItem => ({ key: `issue-${issue.id}`, kind: 'issue', issue })),
  ];
}

export function useOutcomeItems(ctx: AppCheckContext, lang: Lang, audience: Audience) {
  const data = useMemo(() => expectedOutcomes(ctx, lang), [ctx, lang]);
  const visible = useMemo(() => visibleOutcomes(data, audience), [data, audience]);
  const items = useMemo(() => outcomeItems(visible), [visible]);
  return { data, visible, items };
}

/** Language-independent value signature, used to mark cards whose values changed. */
export function outcomeSignature(item: OutcomeItem): string {
  const simSig = (o: KpiOutcome) => o.simulation ? [o.simulation.p10, o.simulation.p50, o.simulation.p90, o.simulation.probability, o.simulation.warnings] : null;
  switch (item.kind) {
    case 'kpi': {
      const k = item.outcome.definition;
      return JSON.stringify([k.baseline, k.current, k.target, k.deadline, k.origin, k.sourceIds ?? [], simSig(item.outcome), item.outcome.contributions.map((c) => [c.id, c.basis, c.evidence])]);
    }
    case 'okr': return JSON.stringify([item.outcome.definition.origin, item.outcome.keyResults.map((kr) => kr.kpi ? [kr.kpi.definition.id, simSig(kr.kpi)] : kr.text)]);
    case 'solution': return JSON.stringify([item.solution.annualBenefitJpy, item.solution.costJpy, item.solution.issueIds, item.solution.sourceIds]);
    case 'issue': return '';
  }
}

export function outcomeName(item: OutcomeItem, lang: Lang): string {
  switch (item.kind) {
    case 'kpi': return loc(item.outcome.definition.name, lang);
    case 'okr': return loc(item.outcome.definition.objective, lang);
    case 'solution': return loc(item.solution.name, lang);
    case 'issue': return loc(item.issue.name, lang);
  }
}

const KIND_KEY: Record<OutcomeItem['kind'], MessageKey> = {
  kpi: 'proj.outcomes.kindKpi',
  okr: 'proj.outcomes.kindOkr',
  solution: 'proj.outcomes.kindSolution',
  issue: 'proj.outcomes.kindIssue',
};

/** The one line a summary card shows: the forecast when there is one, otherwise what the data states. */
export function outcomeHeadline(item: OutcomeItem, t: T, lang: Lang, fmt: Fmt): string {
  switch (item.kind) {
    case 'kpi': {
      const { definition: k, simulation: sim } = item.outcome;
      return sim
        ? t('proj.outcomes.sum.forecast', { p50: fmt.number(sim.p50), unit: loc(k.unit, lang), probability: fmt.percent(sim.probability) })
        : t('proj.outcomes.sum.plan', { current: fmt.number(k.current), target: fmt.number(k.target), unit: loc(k.unit, lang) });
    }
    case 'okr':
      return t('proj.outcomes.sum.okr', { n: item.outcome.keyResults.length, m: item.outcome.keyResults.filter((kr) => kr.kpi?.simulation).length });
    case 'solution':
      return t('proj.outcomes.sum.benefit', { amount: fmt.yenCompact(item.solution.annualBenefitJpy) });
    case 'issue':
      return t('proj.outcomes.sum.issue');
  }
}

function sourceNames(ids: readonly string[] | undefined, lang: Lang) {
  return (ids ?? [])
    .map((id) => getEntity(id))
    .filter((e): e is EntityOf<'source'> => e?.kind === 'source')
    .map((e) => loc(e.name, lang));
}

export function OutcomeStatus({ item }: { item: OutcomeItem }) {
  const { t } = useI18n();
  if (item.kind === 'kpi') {
    if (item.outcome.simulation) return <Badge appearance="tint" color="success">{t('proj.outcomes.simulated')}</Badge>;
    if (item.outcome.definition.origin === 'proposed') return <Badge appearance="outline" color="warning">{t('proj.outcomes.proposed')}</Badge>;
    return <Badge appearance="outline" color="informative">{t('proj.outcomes.unestimated')}</Badge>;
  }
  if (item.kind === 'solution') return <Badge appearance="outline" color="informative">{t('proj.outcomes.sourceLabel')}</Badge>;
  if (item.kind === 'issue' || item.outcome.definition.origin === 'proposed') return <Badge appearance="outline" color="warning">{t('proj.outcomes.proposed')}</Badge>;
  return null;
}

/** Compact card: kind, name, one headline and the status. The whole card is a link to the outcome's detail and input screen. */
export function OutcomeSummaryCard({ item, href, testId, current, ...rest }: { item: OutcomeItem; href: string; testId: string; current?: boolean } & Omit<ComponentPropsWithRef<'a'>, 'href'>) {
  const { t, lang, fmt } = useI18n();
  // `rest` carries the ref and the hover/focus handlers a wrapping Tooltip needs.
  return (
    <a {...rest} className="outcome-summary" href={href} data-kind={item.kind} data-testid={testId} aria-current={current ? 'true' : undefined}>
      <span className="outcome-card-kind">{t(KIND_KEY[item.kind])}</span>
      <span className="outcome-summary-name">{outcomeName(item, lang)}</span>
      <span className="outcome-summary-headline" data-testid={`${testId}-headline`}>{outcomeHeadline(item, t, lang, fmt)}</span>
      <span className="outcome-summary-status"><OutcomeStatus item={item} /></span>
    </a>
  );
}

function KpiDetail({ outcome }: { outcome: KpiOutcome }) {
  const { t, lang, fmt } = useI18n();
  const { definition: k, simulation: sim, contributions } = outcome;
  return (
    <>
      <p>{t('proj.outcomes.baseline', { baseline: fmt.number(k.baseline) })}</p>
      <p>{t('proj.outcomes.currentTarget', { current: fmt.number(k.current), target: fmt.number(k.target), unit: loc(k.unit, lang) })}</p>
      <p>{t('proj.outcomes.deadline', { date: k.deadline })}</p>
      {sim
        ? <>
          <p><strong>{t('proj.outcomes.forecastLabel')}</strong> {t('proj.outcomes.forecast', { p10: fmt.number(sim.p10), p50: fmt.number(sim.p50), p90: fmt.number(sim.p90), unit: loc(k.unit, lang), probability: fmt.percent(sim.probability) })}</p>
          {sim.warnings.length > 0 && <ul className="outcome-warnings">{sim.warnings.map((warning) => <li key={warning}>{t(`sol.warn.${warning}`)}</li>)}</ul>}
        </>
        : <p className="muted">{t('proj.outcomes.noEstimate')}</p>}
      <p className="muted">{t('proj.outcomes.sources', { sources: sourceNames(k.sourceIds, lang).join(lang === 'ja' ? '、' : ', ') || t('proj.outcomes.noSources') })}</p>
      {contributions.length > 0 && (
        <ul className="outcome-contributions">
          {contributions.map((contribution) => {
            const solution = getEntity(contribution.solutionId);
            return (
              <li key={contribution.id}>
                <strong>{solution && 'name' in solution ? loc(solution.name, lang) : contribution.solutionId}</strong>
                {contribution.lever && ` · ${contribution.lever}`}
                {` · ${t(`sol.c.basis.${contribution.basis}`)}`}
                {contribution.evidence && ` · ${contribution.evidence}`}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function OkrDetail({ outcome }: { outcome: OkrOutcome }) {
  const { t, lang, fmt } = useI18n();
  return (
    <>
      <ul className="outcome-key-results">
        {outcome.keyResults.map((kr, index) => (
          <li key={`${outcome.definition.id}-${index}`}>
            <strong>{kr.kpi ? loc(kr.kpi.definition.name, lang) : kr.text}</strong>
            {kr.kpi?.simulation
              ? <span> — {t('proj.outcomes.forecast', { p10: fmt.number(kr.kpi.simulation.p10), p50: fmt.number(kr.kpi.simulation.p50), p90: fmt.number(kr.kpi.simulation.p90), unit: loc(kr.kpi.definition.unit, lang), probability: fmt.percent(kr.kpi.simulation.probability) })}</span>
              : kr.kpi
                ? <span className="muted"> — {t('proj.outcomes.unestimated')}</span>
                : <span className="muted"> — {t('proj.outcomes.missingKpi')}</span>}
          </li>
        ))}
      </ul>
      <p className="muted">{t('proj.outcomes.noOkrAggregate')}</p>
    </>
  );
}

function SolutionDetail({ solution, audience }: { solution: EntityOf<'solution'>; audience: Audience }) {
  const { t, lang, fmt } = useI18n();
  const relatedIssues = solution.issueIds
    .map((id) => getEntity(id))
    .filter((e): e is EntityOf<'issue'> => e?.kind === 'issue' && !isHidden(e, audience))
    .map((e) => loc(e.name, lang));
  return (
    <>
      <p>{loc(solution.description, lang)}</p>
      <p><strong>{t('proj.outcomes.sourceBenefit', { amount: fmt.yenCompact(solution.annualBenefitJpy) })}</strong></p>
      <p>{t('proj.outcomes.sourceCost', { amount: fmt.yenCompact(solution.costJpy) })}</p>
      {relatedIssues.length > 0 && <p>{t('proj.outcomes.relatedIssues', { issues: relatedIssues.join(lang === 'ja' ? '、' : ', ') })}</p>}
      <p className="muted">{t('proj.outcomes.sources', { sources: sourceNames(solution.sourceIds, lang).join(lang === 'ja' ? '、' : ', ') || t('proj.outcomes.noSources') })}</p>
      <p className="muted">{t('proj.outcomes.sourceOnly')}</p>
    </>
  );
}

/** Everything known about one outcome: the bar's hover popup and Step 2's detail panel render this same content. */
export function OutcomeDetail({ item, audience, testId }: { item: OutcomeItem; audience: Audience; testId?: string }) {
  const { t, lang } = useI18n();
  return (
    <article className="outcome-card" data-kind={item.kind} data-testid={testId}>
      <span className="outcome-card-kind">{t(KIND_KEY[item.kind])}</span>
      <header className="outcome-card-header">
        <h4>{outcomeName(item, lang)}</h4>
        <OutcomeStatus item={item} />
      </header>
      {item.kind === 'kpi' && <KpiDetail outcome={item.outcome} />}
      {item.kind === 'okr' && <OkrDetail outcome={item.outcome} />}
      {item.kind === 'solution' && <SolutionDetail solution={item.solution} audience={audience} />}
      {item.kind === 'issue' && <>
        <p>{loc(item.issue.description, lang)}</p>
        <p className="muted">{t('proj.outcomes.issueCandidate')}</p>
      </>}
    </article>
  );
}
