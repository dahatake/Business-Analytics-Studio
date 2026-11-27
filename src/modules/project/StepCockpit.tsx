import { useMemo } from 'react';
import { Badge, Button, Field, Slider } from '@fluentui/react-components';
import { ArrowReset20Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { hrefFor, replaceQuery } from '../../state/router.ts';
import type { Audience } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import type { AppCheckContext } from './deliverables.ts';
import { stepBriefContext } from './overviewModel.ts';
import { buildStepBrief } from './stepBrief.ts';
import { ChartFigure, GapChart, KpiQualityChart, PaybackChart, PriorityMatrix, RangeChart, type NameOf } from './stepCharts.tsx';
import { stepDashboard, type StepDashboard } from './stepDashboard.ts';
import { usePaybackLimit } from './deliverablesUi.tsx';
import { SimulationLink } from './SimulationLink.tsx';
import { solutionCandidates } from './whatIf.ts';
import { BASE_KPI_LEVER, kpiWhatIf, type KpiLever } from './kpiWhatIf.ts';
import { ActionPlanPanel, SolutionActionsPanel } from './ActionPlanPanel.tsx';
import { normalizeActionPlan, useActionPlan } from './cockpitStore.ts';
import './cockpit.css';

type Visible = (id: string) => boolean;

interface Card { id: string; label: string; value: string; sub?: string }

function KpiCards({ cards }: { cards: Card[] }) {
  return (
    <ul className="ck-cards" data-testid="ck-cards">
      {cards.map((c) => (
        <li key={c.id} className="ck-card" data-testid={`ck-card-${c.id}`}>
          <span className="ck-card-label">{c.label}</span>
          <span className="ck-card-value">{c.value}</span>
          {c.sub && <span className="ck-card-sub">{c.sub}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Answer first (Minto): the governing thought, at most three supporting points and the next action; figures from the ledger. */
function CockpitSummary({ d, ctx, audience, cards }: { d: StepDashboard; ctx: AppCheckContext; audience: Audience; cards: Card[] }) {
  const { t, lang } = useI18n();
  const briefCtx = useMemo(() => stepBriefContext(ctx, audience), [ctx, audience]);
  const brief = useMemo(() => buildStepBrief(audience === 'external' ? stepDashboard(d.step, briefCtx) : d, briefCtx, lang, audience), [d, briefCtx, lang, audience]);
  return (
    <Panel title={t('ck.summary')} testId="ck-summary" className="span-full ck-summary" rationale="ck.summaryWhy">
      <p className="ck-question" data-testid="ck-question"><span className="ck-question-label">{t('ck.questionLabel')}</span>{t(`ck.q.${d.step}`)}</p>
      <div className="ck-summary-grid">
        <div>
          <div className="ck-summary-meta">
            <Badge appearance="tint" color="informative">{t('ck.ruleBased', { n: brief.facts.length })}</Badge>
            <Badge appearance="outline" color={brief.maturity === 'agreed' ? 'success' : brief.maturity === 'evidenced' ? 'brand' : 'warning'} data-testid="ck-maturity" data-maturity={brief.maturity}>
              {t(`proj.dash.brief.maturity.${brief.maturity}`)}
            </Badge>
          </div>
          <p className="ck-answer" data-testid="ck-answer">{brief.answer}</p>
          {brief.findings.length > 0 && (
            <ol className="ck-findings" data-testid="ck-findings">{brief.findings.slice(0, 3).map((f, i) => <li key={i}>{f}</li>)}</ol>
          )}
          {brief.actions[0] && <p className="ck-next"><strong>{t('ck.nextAction')}</strong> {brief.actions[0]}</p>}
        </div>
        <KpiCards cards={cards} />
      </div>
    </Panel>
  );
}

export function KpiWhatIfPanel({ ctx, nameOf, lever, setLever }: { ctx: AppCheckContext; nameOf: NameOf; lever: KpiLever; setLever: React.Dispatch<React.SetStateAction<KpiLever>> }) {
  const { t, fmt, lang } = useI18n();
  const kpis = useMemo(() => ctx.kpi.kpis.filter((k) => Number.isFinite(k.baseline) && Number.isFinite(k.current) && Number.isFinite(k.target) && k.target !== k.baseline && /^\d{4}-\d{2}-\d{2}$/.test(k.deadline)), [ctx]);
  const contributions = ctx.strategy.contributions;
  const hasSim = contributions.some((c) => kpis.some((k) => k.id === c.kpiId));
  const base = useMemo(() => kpiWhatIf(kpis, contributions, ctx.today, BASE_KPI_LEVER), [kpis, contributions, ctx.today]);
  const now = useMemo(() => kpiWhatIf(kpis, contributions, ctx.today, lever), [kpis, contributions, ctx.today, lever]);
  const byId = new Map(base.map((r) => [r.id, r]));
  const name = (id: string) => {
    const k = kpis.find((x) => x.id === id);
    return k ? loc(k.name, lang) : nameOf(id);
  };
  const unit = (id: string) => { const k = kpis.find((x) => x.id === id); return k ? loc(k.unit, lang) : ''; };
  const changed = lever.stretch !== 0 || lever.deadlineMonths !== 0 || lever.effect !== 1 || lever.delayMonths !== 0;
  if (kpis.length === 0) {
    return (
      <Panel title={t('ck.kpi.title')} rationale="ck.kpi.why" testId="ck-wi-kpi" className="span-full ck-hero">
        <p className="muted" data-testid="ck-wi-kpi-empty">{t('ck.kpi.empty')}</p>
      </Panel>
    );
  }
  const share = (r: (typeof now)[number]) => (r.monthlyShare === null ? Number.POSITIVE_INFINITY : r.monthlyShare);
  const hardest = [...now].sort((a, b) => share(b) - share(a))[0]!;
  const maxS = Math.max(1e-9, ...now.flatMap((r) => [r.monthlyShare ?? 0, byId.get(r.id)?.monthlyShare ?? 0]));
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? t('ck.kpi.overdue') : fmt.percent(v));
  const lev = (k: keyof KpiLever, v: number) => setLever((s) => ({ ...s, [k]: v }));
  const headline = hasSim
    ? t('ck.kpi.headlineSim', { n: now.filter((r) => (r.probability ?? 0) >= 0.5).length, total: now.length })
    : hardest.monthlyShare === null ? t('ck.kpi.headlineOverdue', { name: name(hardest.id), n: now.filter((r) => r.monthlyShare === null).length })
    : t(changed ? 'ck.kpi.headline' : 'ck.kpi.headlineBase', {
      name: name(hardest.id), share: pct(hardest.monthlyShare), base: pct(byId.get(hardest.id)?.monthlyShare), progress: fmt.percent(hardest.progress),
    });
  return (
    <Panel title={t('ck.kpi.title')} rationale="ck.kpi.why" testId="ck-wi-kpi" className="span-full ck-hero">
      <p className="muted ck-lead">{t('ck.kpi.lead')}</p>
      <div className="ck-wi">
        <div className="ck-wi-levers" role="group" aria-label={t('ck.wi.levers')}>
          <fieldset className="ck-fieldset">
            <legend>{t('ck.wi.levers')}</legend>
            <Field size="small" label={t('ck.kpi.stretch', { value: fmt.percent(lever.stretch) })} hint={t('ck.kpi.stretchHint')}>
              <Slider min={-50} max={50} step={5} size="small" value={Math.round(lever.stretch * 100)} onChange={(_, d) => lev('stretch', d.value / 100)} data-testid="ck-wi-kpi-stretch"
                aria-valuetext={t('ck.kpi.stretch', { value: fmt.percent(lever.stretch) })} />
            </Field>
            <Field size="small" label={t('ck.kpi.deadline', { n: lever.deadlineMonths })} hint={t('ck.kpi.deadlineHint')}>
              <Slider min={-6} max={12} step={1} size="small" value={lever.deadlineMonths} onChange={(_, d) => lev('deadlineMonths', d.value)} data-testid="ck-wi-kpi-deadline"
                aria-valuetext={t('ck.kpi.deadline', { n: lever.deadlineMonths })} />
            </Field>
            {hasSim && (
              <>
                <Field size="small" label={t('ck.kpi.effect', { value: fmt.percent(lever.effect) })} hint={t('ck.kpi.effectHint')}>
                  <Slider min={50} max={150} step={5} size="small" value={Math.round(lever.effect * 100)} onChange={(_, d) => lev('effect', d.value / 100)} data-testid="ck-wi-kpi-effect"
                    aria-valuetext={t('ck.kpi.effect', { value: fmt.percent(lever.effect) })} />
                </Field>
                <Field size="small" label={t('ck.kpi.delay', { n: lever.delayMonths })} hint={t('ck.kpi.delayHint')}>
                  <Slider min={0} max={12} step={1} size="small" value={lever.delayMonths} onChange={(_, d) => lev('delayMonths', d.value)} data-testid="ck-wi-kpi-delay"
                    aria-valuetext={t('ck.kpi.delay', { n: lever.delayMonths })} />
                </Field>
              </>
            )}
            {!hasSim && <p className="muted ck-small" data-testid="ck-wi-kpi-nosim">{t('ck.kpi.noSim')} <a href={hrefFor('/deliverables', { step: 'solution' })}>{t('ck.kpi.noSimLink')}</a></p>}
          </fieldset>
          <Button icon={<ArrowReset20Regular />} disabled={!changed} onClick={() => setLever(BASE_KPI_LEVER)} data-testid="ck-wi-kpi-reset">{t('ck.wi.reset')}</Button>
        </div>
        <div className="ck-wi-results">
          <p className="ck-headline" aria-live="polite" data-testid="ck-wi-kpi-headline">{headline}</p>
          <ChartFigure
            id="ck-wi-kpi-pace"
            title={t(hasSim ? 'ck.kpi.chartSim' : 'ck.kpi.chart')}
            read={t(hasSim ? 'ck.kpi.readSim' : 'ck.kpi.read')}
            legend={<span className="ck-legend"><span className="ck-key is-scenario" />{t('ck.wi.legendScenario')}<span className="ck-key is-base" />{t('ck.wi.legendBase')}</span>}
            visual={(
              <div className="ck-rank" data-testid="ck-wi-kpi-rows">
                {now.map((r) => {
                  const b = byId.get(r.id);
                  const width = hasSim ? (r.probability ?? 0) : r.monthlyShare === null ? 1 : r.monthlyShare / maxS;
                  const basePos = hasSim ? (b?.probability ?? 0) : (b?.monthlyShare ?? maxS) / maxS;
                  return (
                    <div key={r.id} className="ck-rank-row is-sens" data-id={r.id} data-pace={r.pace ?? 'overdue'} data-probability={r.probability ?? ''}>
                      <span className="ck-rank-name">{name(r.id)}</span>
                      <span className="ck-rank-track">
                        <span className={`ck-rank-bar${r.pace === null ? ' is-excluded' : ' is-funded'}`} style={{ width: `${100 * Math.min(1, width)}%` }} />
                        <span className="ck-rank-base" style={{ left: `${100 * Math.min(1, basePos)}%` }} />
                      </span>
                      <span className="ck-rank-value">{hasSim
                        ? t('ck.kpi.prob', { now: fmt.percent(r.probability ?? 0), base: fmt.percent(b?.probability ?? 0) })
                        : t('ck.kpi.share', { now: pct(r.monthlyShare), base: pct(b?.monthlyShare) })}</span>
                    </div>
                  );
                })}
              </div>
            )}
            table={(
              <table className="data-table compact">
                <thead><tr>
                  <th scope="col">{t('ck.kpi.col.kpi')}</th>
                  <th scope="col" className="num">{t('ck.kpi.col.target')}</th>
                  <th scope="col">{t('ck.kpi.col.deadline')}</th>
                  <th scope="col" className="num">{t('ck.kpi.col.progress')}</th>
                  <th scope="col" className="num">{t('ck.kpi.col.pace')}</th>
                  <th scope="col" className="num">{t('ck.kpi.col.basePace')}</th>
                  {hasSim && <th scope="col" className="num">{t('ck.kpi.col.prob')}</th>}
                </tr></thead>
                <tbody>
                  {now.map((r) => {
                    const b = byId.get(r.id);
                    const pace = (p: number | null | undefined) => (p === null || p === undefined ? t('ck.kpi.overdue') : `${fmt.number(p)} ${unit(r.id)}`);
                    return (
                      <tr key={r.id}>
                        <th scope="row">{name(r.id)}</th>
                        <td className="num">{`${fmt.number(r.target)} ${unit(r.id)}`}</td>
                        <td>{r.deadline}</td>
                        <td className="num">{fmt.percent(r.progress)}</td>
                        <td className="num">{pace(r.pace)}</td>
                        <td className="num">{pace(b?.pace)}</td>
                        {hasSim && <td className="num">{r.probability === undefined ? '—' : fmt.percent(r.probability)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          />
        </div>
      </div>
    </Panel>
  );
}

function PrimaryData({ step, d, ctx, nameOf }: { step: ImprovementStep; d: StepDashboard; ctx: AppCheckContext; nameOf: NameOf }) {
  const { t } = useI18n();
  const limit = usePaybackLimit();
  const det = d.detail;
  const asis = step === 'tobe' ? stepDashboard('asis', ctx).detail : null;
  let body = null;
  if (det.step === 'asis') body = <PriorityMatrix issues={det.issues} nameOf={nameOf} />;
  else if (det.step === 'tobe' && asis?.step === 'asis') body = <GapChart kpis={asis.kpis} nameOf={nameOf} />;
  else if (det.step === 'kpi') body = <KpiQualityChart kpis={det.kpis} />;
  else if (det.step === 'solution') body = det.sims.length ? <RangeChart sims={det.sims} /> : <PaybackChart rows={det.solutions} limit={limit} nameOf={nameOf} />;
  if (!body) return null;
  return (
    <Panel title={t('ck.data')} rationale={`ck.dataWhy.${step}` as MessageKey} testId="ck-data" className="span-full">
      {body}
      <p className="muted ck-small">
        {t('ck.dataMore')}{' '}
        <a href={hrefFor('/step', { step, view: 'details' })} onClick={(e) => { e.preventDefault(); replaceQuery({ view: 'details' }); }} data-testid="ck-details-link">{t('ck.toDetails')}</a>
      </p>
    </Panel>
  );
}

function useCards(d: StepDashboard, visible: Visible, nameOf: NameOf): Card[] {
  const { t, fmt } = useI18n();
  const rawPlan = useActionPlan((s) => s.value);
  const plan = useMemo(() => normalizeActionPlan(rawPlan), [rawPlan]);
  const progress: Card = { id: 'progress', label: t('ck.card.progress'), value: t('ck.card.ofN', { n: d.progress.done, total: d.progress.total }), sub: t(d.progress.complete ? 'ck.card.complete' : 'ck.card.open') };
  const det = d.detail;
  if (det.step === 'asis') {
    const issues = det.issues.filter((i) => visible(i.id));
    const top = issues[0];
    return [
      { id: 'issues', label: t('ck.card.issues'), value: fmt.integer(issues.length) },
      { id: 'top', label: t('ck.card.top'), value: top ? nameOf(top.id) : '—', ...(top ? { sub: t('ck.card.score', { n: top.score }) } : {}) },
      { id: 'evidence', label: t('ck.card.evidence'), value: issues.length ? fmt.percent(issues.filter((i) => i.sourced).length / issues.length) : '—' },
      progress,
    ];
  }
  if (det.step === 'tobe') {
    const covered = det.topIssues.slice(0, 3).filter((i) => i.useCaseIds.length > 0).length;
    return [
      { id: 'covered', label: t('ck.card.covered'), value: t('ck.card.ofN', { n: covered, total: Math.min(3, det.topIssues.length) }) },
      { id: 'useCases', label: t('ck.card.useCases'), value: fmt.integer(det.useCases.length) },
      { id: 'proposed', label: t('ck.card.proposed'), value: fmt.integer(det.proposed.kpis.length + det.proposed.okrs.length) },
      progress,
    ];
  }
  if (det.step === 'kpi') {
    return [
      { id: 'kpis', label: t('ck.card.kpis'), value: fmt.integer(det.kpis.length) },
      { id: 'valid', label: t('ck.card.valid'), value: det.kpis.length ? fmt.percent(det.kpis.filter((k) => k.valid).length / det.kpis.length) : '—' },
      { id: 'inOkr', label: t('ck.card.inOkr'), value: det.kpis.length ? fmt.percent(det.kpis.filter((k) => k.inOkr).length / det.kpis.length) : '—' },
      progress,
    ];
  }
  if (det.step === 'solution') {
    const sols = det.solutions.filter((s) => visible(s.id));
    const sum = (f: (s: (typeof sols)[number]) => number | undefined) => { const xs = sols.map(f).filter((x): x is number => x !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined; };
    return [
      { id: 'solutions', label: t('ck.card.solutions'), value: fmt.integer(sols.length) },
      { id: 'benefit', label: t('ck.card.benefit'), value: fmt.yenCompact(sum((s) => s.annualBenefitJpy)) },
      { id: 'cost', label: t('ck.card.cost'), value: fmt.yenCompact(sum((s) => s.costJpy)) },
      progress,
    ];
  }
  const sols = det.solutions.filter((s) => visible(s.id));
  const saved = Object.keys(plan.saved).filter((id) => sols.some((s) => s.id === id)).length;
  return [
    { id: 'solutions', label: t('ck.card.solutions'), value: fmt.integer(sols.length) },
    { id: 'planned', label: t('ck.card.planned'), value: plan.selected ? fmt.integer(plan.selected.filter((id) => sols.some((s) => s.id === id)).length) : t('ck.card.auto') },
    { id: 'docs', label: t('ck.card.docs'), value: fmt.integer(saved) },
    progress,
  ];
}

/** FR-378: the decision view of a step — the question, the answer, the minimum data, and the what-if. */
export function StepCockpit({ step, d, ctx, audience, visible, nameOf }: {
  step: ImprovementStep; d: StepDashboard; ctx: AppCheckContext; audience: Audience; visible: Visible; nameOf: NameOf;
}) {
  const cards = useCards(d, visible, nameOf);
  const solutions = useMemo(() => (step === 'solution' || step === 'deliverable' ? solutionCandidates(ctx, visible) : []), [step, ctx, visible]);
  return (
    <>
      <CockpitSummary d={d} ctx={ctx} audience={audience} cards={cards} />
      {step === 'deliverable' ? <SolutionActionsPanel ctx={ctx} visible={visible} nameOf={nameOf} cands={solutions} /> : <PrimaryData step={step} d={d} ctx={ctx} nameOf={nameOf} />}
      <SimulationLink step={step} />
      {step === 'deliverable' && (
        <>
          <ActionPlanPanel ctx={ctx} visible={visible} nameOf={nameOf} cands={solutions} />
        </>
      )}
    </>
  );
}

