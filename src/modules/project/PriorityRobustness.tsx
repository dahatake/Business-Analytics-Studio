import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Field, Slider } from '@fluentui/react-components';
import { ArrowReset20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import type { CheckContext } from './deliverables.ts';
import { PRIORITY_WEIGHTS } from './priorityAnalysis.ts';
import { priorityInputs } from './priorityBrief.ts';
import { analyzeRobustness, TOP_N, type IssueRobustness } from './priorityRobustness.ts';
import { ChartFigure, LegendItem } from './stepCharts.tsx';

const pct = (x: number) => `${Math.max(0, Math.min(100, x * 100))}%`;
/** Rows drawn in the charts; the data tables list every issue. */
const CHART_ROWS = 8;
const VOI_ROWS = 5;
type IdSet = ReadonlySet<string>;

function Bar({ value, brand }: { value: number; brand: boolean }) {
  return (
    <span className="step-chart-track">
      <span className={`step-chart-bar ${brand ? 'is-brand' : 'is-neutral'}`} style={{ width: pct(value) }} />
    </span>
  );
}

/**
 * FR-364: how firm the order of the issues is, the one rating worth checking next, and a what-if (weights, checked ratings,
 * issues set aside). Recomputed from the project's data whenever it changes (Copilot drafts, pack import, approvals); the what-if is not saved.
 */
export function PriorityRobustnessPanel({ step, ctx }: { step: ImprovementStep; ctx: CheckContext }) {
  const { t, fmt, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [impactWeight, setImpactWeight] = useState(PRIORITY_WEIGHTS.impact);
  const [confirmed, setConfirmed] = useState<IdSet>(new Set());
  const [excluded, setExcluded] = useState<IdSet>(new Set());
  const voiNum = useMemo(() => new Intl.NumberFormat(fmt.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [fmt.locale]);
  const inputs = useMemo(() => priorityInputs(ctx), [ctx]);
  const r = useMemo(() => analyzeRobustness(inputs, { impactWeight, confirmed, excluded }), [inputs, impactWeight, confirmed, excluded]);
  const nameOf = (id: string) => {
    const e = ctx.pack.byId.get(id);
    if (!e) return id;
    return isHidden(e, audience) ? t('proj.dash.chart.hidden') : loc(e.name, lang);
  };
  const toggle = (set: IdSet, id: string, on: boolean): IdSet => {
    const next = new Set(set);
    if (on) next.add(id); else next.delete(id);
    return next;
  };
  const changed = impactWeight !== PRIORITY_WEIGHTS.impact || confirmed.size > 0 || excluded.size > 0;
  const reset = () => { setImpactWeight(PRIORITY_WEIGHTS.impact); setConfirmed(new Set()); setExcluded(new Set()); };
  const pick = r.issues[0];
  const byVoi = [...r.issues].filter((i) => i.voi.both > 0).sort((a, b) => b.voi.both - a.voi.both).slice(0, VOI_ROWS);
  const maxVoi = Math.max(...byVoi.map((i) => i.voi.both), 0);
  const rangeOf = (i: IssueRobustness) => (i.rankLow === i.rankHigh ? t('proj.rob.rankOne', { rank: i.rankLow }) : t('proj.rob.range', { low: i.rankLow, high: i.rankHigh }));
  const id = `prio-rob-${step}`;

  return (
    <Panel title={t('proj.rob.title')} rationale="proj.rob.rationale" testId="step-robust" className="span-full">
      <p className="muted">{t('proj.rob.lead', { runs: r.runs })}</p>
      <section className="prio-block" aria-labelledby={`${id}-pick`} data-testid="step-robust-verdict" data-verdict={r.verdict} data-pick={r.pick ?? undefined} data-weight-driven={r.weightDriven}>
        <h4 id={`${id}-pick`} className="prio-label">{t('proj.rob.pickLabel')}</h4>
        {pick ? (
          <>
            <p className="prio-summary">
              <EntityRef id={pick.id} />{' '}
              <Badge size="small" appearance="tint" color={r.verdict === 'robust' ? 'success' : 'warning'}>{t(`proj.rob.badge.${r.verdict === 'robust' ? 'robust' : 'contested'}`)}</Badge>
            </p>
            <p data-testid="step-robust-verdict-text">
              <strong>
                {r.n === 1 ? t('proj.rob.verdict.single')
                  : r.verdict === 'robust' ? t('proj.rob.verdict.robust', { share: fmt.percent(r.pickShare) })
                    : r.weightDriven ? t('proj.rob.verdict.weight', { share: fmt.percent(r.pickShare), fixed: fmt.percent(r.pickShareFixedWeights) })
                      : t('proj.rob.verdict.contested', { share: fmt.percent(r.pickShare) })}
              </strong>
            </p>
            {r.rival && <p data-testid="step-robust-rival">{t('proj.rob.rival')}{' '}<EntityRef id={r.rival} /></p>}
          </>
        ) : <p data-testid="step-robust-verdict-text">{t('proj.rob.verdict.none')}</p>}
      </section>
      {pick && r.n > 1 && (
        <section className="prio-block" aria-labelledby={`${id}-next`} data-testid="step-robust-next">
          <h4 id={`${id}-next`} className="prio-label">{t('proj.rob.nextLabel')}</h4>
          {r.weightDriven && <p data-testid="step-robust-next-weight">{t('proj.rob.next.weight')}</p>}
          {r.next ? (
            <p data-testid="step-robust-next-check" data-issue={r.next.id} data-rating={r.next.rating}>
              <EntityRef id={r.next.id} />{' '}
              {t('proj.rob.next.check', { rating: t(`proj.rob.rating.${r.next.rating}`), flip: fmt.percent(r.next.flip), voi: voiNum.format(r.next.voi) })}
            </p>
          ) : <p data-testid="step-robust-next-none">{t('proj.rob.next.none')}</p>}
        </section>
      )}
      {r.n > 1 && (
        <ChartFigure
          id="prio-robust"
          title={t('proj.rob.chart.rank.title', { top: TOP_N })}
          read={t('proj.rob.chart.rank.read')}
          legend={<><LegendItem kind="is-brand" label={t('proj.rob.first')} /><LegendItem kind="is-neutral" label={t('proj.rob.top', { top: TOP_N })} /></>}
          visual={(
            <div className="step-chart-rows">
              {r.issues.slice(0, CHART_ROWS).map((i) => (
                <div key={i.id} className="step-chart-row dec-two-bars" data-testid={`step-robust-row-${i.id}`} data-first={i.pFirst}>
                  <span className="step-chart-label">{nameOf(i.id)}</span>
                  <span className="dec-bars"><Bar value={i.pFirst} brand /><Bar value={i.pTop} brand={false} /></span>
                  <span className="step-chart-value">{`${fmt.percent(i.pFirst)} · ${fmt.percent(i.pTop)}`}</span>
                </div>
              ))}
            </div>
          )}
          table={(
            <table className="data-table compact">
              <thead><tr>
                <th scope="col" className="num">{t('proj.dash.col.rank')}</th><th scope="col">{t('proj.rob.col.issue')}</th>
                <th scope="col" className="num">{t('proj.rob.col.impact')}</th><th scope="col" className="num">{t('proj.rob.col.feasibility')}</th>
                <th scope="col">{t('proj.rob.col.evidence')}</th><th scope="col" className="num">{t('proj.rob.col.score')}</th>
                <th scope="col" className="num">{t('proj.rob.first')}</th><th scope="col" className="num">{t('proj.rob.top', { top: TOP_N })}</th>
                <th scope="col">{t('proj.rob.col.range')}</th>
              </tr></thead>
              <tbody>
                {r.issues.map((i) => (
                  <tr key={i.id}>
                    <td className="num">{i.rank}</td><th scope="row">{nameOf(i.id)}</th>
                    <td className="num">{i.impact}</td><td className="num">{i.feasibility}</td>
                    <td>{t(`proj.rob.evidence.${i.evidence}`)}</td><td className="num">{fmt.number(i.score)}</td>
                    <td className="num">{fmt.percent(i.pFirst)}</td><td className="num">{fmt.percent(i.pTop)}</td><td>{rangeOf(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
      )}
      {r.n > 1 && (byVoi.length > 0 ? (
        <ChartFigure
          id="prio-voi"
          title={t('proj.rob.chart.voi.title')}
          read={t('proj.rob.chart.voi.read')}
          legend={<LegendItem kind="is-brand" label={t('proj.rob.col.voi')} />}
          visual={(
            <div className="step-chart-rows">
              {byVoi.map((i) => (
                <div key={i.id} className="step-chart-row" data-testid={`step-robust-voi-${i.id}`}>
                  <span className="step-chart-label">{nameOf(i.id)}</span>
                  <Bar value={maxVoi > 0 ? i.voi.both / maxVoi : 0} brand />
                  <span className="step-chart-value">{voiNum.format(i.voi.both)}</span>
                </div>
              ))}
            </div>
          )}
          table={(
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.rob.col.issue')}</th><th scope="col" className="num">{t('proj.rob.col.voi')}</th>
                <th scope="col" className="num">{t('proj.rob.col.voiImpact')}</th><th scope="col" className="num">{t('proj.rob.col.voiFeasibility')}</th>
                <th scope="col" className="num">{t('proj.rob.col.flip')}</th>
              </tr></thead>
              <tbody>
                {r.issues.map((i) => (
                  <tr key={i.id}>
                    <th scope="row">{nameOf(i.id)}</th><td className="num">{voiNum.format(i.voi.both)}</td>
                    <td className="num">{voiNum.format(i.voi.impact)}</td><td className="num">{voiNum.format(i.voi.feasibility)}</td>
                    <td className="num">{fmt.percent(i.flip.both)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
      ) : <p className="muted" data-testid="step-robust-voi-empty">{t('proj.rob.chart.voi.empty')}</p>)}
      {inputs.length > 0 && (
        <details className="dec-edit" data-testid="step-robust-sim">
          <summary>{t('proj.rob.sim.label')}</summary>
          <p className="muted">{t('proj.rob.sim.lead')}</p>
          <fieldset className="dec-weights">
            <legend>{t('proj.rob.sim.weightLegend')}</legend>
            <Field label={t('proj.rob.sim.weight', { impact: impactWeight, feasibility: 100 - impactWeight })} size="small">
              <Slider min={0} max={100} step={10} size="small" value={impactWeight} onChange={(_, data) => setImpactWeight(data.value)} data-testid="step-robust-weight" />
            </Field>
          </fieldset>
          <table className="data-table compact">
            <thead><tr>
              <th scope="col">{t('proj.rob.col.issue')}</th><th scope="col">{t('proj.rob.sim.confirm')}</th><th scope="col">{t('proj.rob.sim.exclude')}</th>
            </tr></thead>
            <tbody>
              {inputs.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{nameOf(i.id)}</th>
                  <td><Checkbox checked={confirmed.has(i.id)} onChange={(_, d) => setConfirmed((s) => toggle(s, i.id, d.checked === true))} aria-label={`${nameOf(i.id)} ${t('proj.rob.sim.confirm')}`} data-testid={`step-robust-confirm-${i.id}`} /></td>
                  <td><Checkbox checked={excluded.has(i.id)} onChange={(_, d) => setExcluded((s) => toggle(s, i.id, d.checked === true))} aria-label={`${nameOf(i.id)} ${t('proj.rob.sim.exclude')}`} data-testid={`step-robust-exclude-${i.id}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button appearance="subtle" icon={<ArrowReset20Regular />} disabled={!changed} onClick={reset} data-testid="step-robust-reset">{t('proj.rob.sim.reset')}</Button>
        </details>
      )}
    </Panel>
  );
}
