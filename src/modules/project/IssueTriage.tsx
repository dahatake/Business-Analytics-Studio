import { useMemo, useState } from 'react';
import { Badge, Button } from '@fluentui/react-components';
import { Edit20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { DelayEstimateDialog } from './CostOfDelay.tsx';
import type { CheckContext } from './deliverables.ts';
import {
  ANSOFF_TABLE, IMPACT_LEVELS, projectTriage, RATING_ANCHORS, URGENCY_LEVELS,
  type Disposition, type TriageIssue, type TriageSummary,
} from './issueTriage.ts';
import { packEntityName } from './priorityRobustness.ts';
import type { Range3 } from './simulate.ts';
import { ChartFigure } from './stepCharts.tsx';

const DISPOSITION_COLOR: Record<Disposition, 'danger' | 'warning' | 'informative' | 'subtle' | 'success'> = {
  act: 'danger', plan: 'warning', unassessed: 'informative', monitor: 'subtle', review: 'subtle', drop: 'subtle',
};
const URGENCY_ROWS = [...URGENCY_LEVELS].reverse();

/** The triage line of an ingest summary (pack generation, pack import). */
export function TriageSummaryLine({ summary, pack, testId }: { summary: TriageSummary; pack: Record<string, unknown>; testId: string }) {
  const { t, lang } = useI18n();
  const name = (id: string) => packEntityName(pack, id, lang);
  const sep = lang === 'ja' ? '、' : ', ';
  return (
    <>
      <dt>{t('proj.gen.sum.triage')}</dt>
      <dd data-testid={testId} data-act={summary.counts.act} data-gated={summary.gated.length} data-timed={summary.timed}>
        {t('proj.gen.sum.triageValue', { act: summary.counts.act, plan: summary.counts.plan, unassessed: summary.counts.unassessed, gated: summary.gated.length })}
        {summary.act.length > 0 && <><br />{t('proj.gen.sum.triageAct', { names: summary.act.map(name).join(sep) })}</>}
        {summary.gated.length > 0 && <><br />{t('proj.gen.sum.triageGated', { names: summary.gated.map(name).join(sep) })}</>}
        {summary.next && <><br />{t(`proj.gen.sum.triageNext.${summary.next.need}`, { name: name(summary.next.id) })}</>}
      </dd>
    </>
  );
}

/**
 * FR-383: Ansoff's disposition of each issue (impact × urgency, with urgency from time), the issues kept for action and those set
 * aside, growth from the KPIs, the issue whose timing to estimate first, and the rating definitions. Recomputed when the project's
 * data change (estimates, pack import, qualification); a person's estimate is saved with the project.
 */
export function IssueTriagePanel({ step, ctx }: { step: ImprovementStep; ctx: CheckContext }) {
  const { t, fmt, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [editing, setEditing] = useState<string | null>(null);
  const tri = useMemo(() => projectTriage(ctx), [ctx]);
  const nameOf = (id: string) => {
    const e = ctx.pack.byId.get(id);
    if (!e) return id;
    return isHidden(e, audience) ? t('proj.dash.chart.hidden') : loc(e.name, lang);
  };
  const months = (x: number) => t('proj.cod.months', { n: fmt.number(Math.round(x * 10) / 10) });
  const rangeText = (r: Range3 | null) => {
    if (!r) return t('proj.cod.unknown');
    return r.low === r.high ? months(r.mode) : t('proj.cod.range', { mode: months(r.mode), low: months(r.low), high: months(r.high) });
  };
  const startText = (i: TriageIssue) => {
    if (i.done) return t('proj.tri.start.done');
    if (i.slack === null) return t(`proj.tri.need.${i.need ?? 'both'}`);
    return i.slack <= 0 ? t('proj.tri.start.late', { n: fmt.number(Math.round(-i.slack * 10) / 10) }) : t('proj.tri.start.by', { n: fmt.number(Math.round(i.slack * 10) / 10) });
  };
  const cell = (u: (typeof URGENCY_LEVELS)[number] | null, l: (typeof IMPACT_LEVELS)[number]) => tri.issues.filter((i) => i.urgency === u && i.impactLevel === l);
  const id = `prio-tri-${step}`;
  const editIssue = editing ? ctx.pack.byId.get(editing) : undefined;
  const act = tri.issues.filter((i) => i.disposition === 'act');

  return (
    <Panel title={t('proj.tri.title')} rationale="proj.tri.rationale" testId="step-triage" className="span-full">
      <p className="muted">{t('proj.tri.lead', { cycle: tri.cycle })}</p>
      <section className="prio-block" aria-labelledby={`${id}-sum`} data-testid="step-triage-verdict"
        data-act={tri.counts.act} data-unassessed={tri.counts.unassessed} data-plan={tri.counts.plan} data-gated={tri.gated.length} data-timed={tri.timed}>
        <h4 id={`${id}-sum`} className="prio-label">{t('proj.tri.summaryLabel')}</h4>
        {tri.issues.length === 0 ? <p>{t('proj.tri.empty')}</p> : (
          <>
            <p className="prio-summary"><strong>{t('proj.tri.summary', { n: tri.issues.length, act: tri.counts.act, plan: tri.counts.plan, unassessed: tri.counts.unassessed, gated: tri.gated.length, timed: tri.timed })}</strong></p>
            {act.length > 0 && (
              <p data-testid="step-triage-act">{t('proj.tri.actLabel')}{' '}
                {act.map((i, k) => <span key={i.id}>{k > 0 && (lang === 'ja' ? '、' : ', ')}<EntityRef id={i.id} /></span>)}
              </p>
            )}
            {tri.gated.length > 0 && <p data-testid="step-triage-gated">{t('proj.tri.gatedNote', { n: tri.gated.length })}</p>}
            {tri.timed === 0 && <p className="muted" data-testid="step-triage-untimed">{t('proj.tri.untimed')}</p>}
          </>
        )}
      </section>
      {tri.issues.length > 0 && (
        <section className="prio-block" aria-labelledby={`${id}-next`} data-testid="step-triage-next">
          <h4 id={`${id}-next`} className="prio-label">{t('proj.tri.nextLabel')}</h4>
          {tri.next ? (
            <p data-testid="step-triage-next-issue" data-issue={tri.next.id} data-need={tri.next.need}>
              <EntityRef id={tri.next.id} />{' '}{t(`proj.tri.next.${tri.next.need}`)}{' '}
              <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setEditing(tri.next!.id)} aria-label={`${t('proj.tri.estimate')}: ${nameOf(tri.next.id)}`} data-testid="step-triage-next-estimate">
                {t('proj.tri.estimate')}
              </Button>
            </p>
          ) : <p data-testid="step-triage-next-none">{t('proj.tri.next.none')}</p>}
        </section>
      )}
      {tri.issues.length > 0 && (
        <ChartFigure
          id="triage"
          title={t('proj.tri.chart.title')}
          read={t('proj.tri.chart.read')}
          visual={(
            <div className="step-chart-matrix">
              <span className="step-chart-matrix-axis is-y">{t('proj.tri.axis.urgency')}</span>
              <div className="step-chart-matrix-grid tri-grid">
                {[...URGENCY_ROWS, null].map((u) => IMPACT_LEVELS.map((l) => {
                  const d: Disposition = u ? ANSOFF_TABLE[u][l] : l === 'low' ? 'review' : 'unassessed';
                  const items = cell(u, l);
                  return (
                    <div key={`${u ?? 'unrated'}-${l}`} className={`step-chart-quadrant tri-cell is-${d}`} data-urgency={u ?? 'unrated'} data-impact={l} data-disposition={d}>
                      <span className="step-chart-quadrant-name">{`${t(`proj.tri.urgency.${u ?? 'unrated'}`)} × ${t(`proj.tri.impact.${l}`)}`}</span>
                      <span className="tri-cell-disp">{t(`proj.tri.disp.${d}`)}</span>
                      <ul className="step-chart-quadrant-list">
                        {items.map((i) => <li key={i.id} data-issue={i.id}>{nameOf(i.id)}</li>)}
                      </ul>
                    </div>
                  );
                }))}
              </div>
              <span className="step-chart-matrix-axis is-x">{t('proj.tri.axis.impact')}</span>
            </div>
          )}
          table={(
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.tri.axis.urgency')}</th>
                {IMPACT_LEVELS.map((l) => <th key={l} scope="col">{t(`proj.tri.impact.${l}`)}</th>)}
              </tr></thead>
              <tbody>
                {[...URGENCY_ROWS, null].map((u) => (
                  <tr key={u ?? 'unrated'}>
                    <th scope="row">{t(`proj.tri.urgency.${u ?? 'unrated'}`)}</th>
                    {IMPACT_LEVELS.map((l) => {
                      const d: Disposition = u ? ANSOFF_TABLE[u][l] : l === 'low' ? 'review' : 'unassessed';
                      const names = cell(u, l).map((i) => nameOf(i.id));
                      return <td key={l}>{t(`proj.tri.disp.${d}`)}{names.length > 0 ? `: ${names.join(lang === 'ja' ? '、' : ', ')}` : ''}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
      )}
      {tri.issues.length > 0 && (
        <section className="prio-block" aria-labelledby={`${id}-list`} data-testid="step-triage-list">
          <h4 id={`${id}-list`} className="prio-label">{t('proj.tri.listLabel')}</h4>
          <p className="muted">{t('proj.tri.listLead')}</p>
          <table className="data-table compact">
            <thead><tr>
              <th scope="col" className="num">{t('proj.tri.col.order')}</th><th scope="col">{t('proj.rob.col.issue')}</th>
              <th scope="col">{t('proj.tri.col.disposition')}</th><th scope="col">{t('proj.tri.col.impact')}</th>
              <th scope="col">{t('proj.tri.col.impactTime')}</th><th scope="col">{t('proj.tri.col.response')}</th>
              <th scope="col">{t('proj.tri.col.start')}</th><th scope="col" className="num">{t('proj.tri.col.late')}</th>
              <th scope="col">{t('proj.tri.col.growth')}</th><th scope="col">{t('proj.cod.col.action')}</th>
            </tr></thead>
            <tbody>
              {tri.issues.map((i) => (
                <tr key={i.id} data-testid={`step-triage-row-${i.id}`} data-disposition={i.disposition} data-urgency={i.urgency ?? 'unrated'} data-order={i.order} data-growth={i.growth}>
                  <td className="num">{i.order}</td>
                  <th scope="row">{nameOf(i.id)}{i.crux && <>{' '}<Badge size="small" appearance="outline" data-testid={`step-triage-crux-${i.id}`}>{t('proj.tri.crux')}</Badge></>}</th>
                  <td><Badge size="small" appearance="tint" color={DISPOSITION_COLOR[i.disposition]}>{t(`proj.tri.disp.${i.disposition}`)}</Badge></td>
                  <td>{t('proj.tri.impactValue', { n: i.impact, level: t(`proj.tri.impact.${i.impactLevel}`) })}{i.provisional ? ` ${t('proj.tri.provisional')}` : ''}</td>
                  <td>{rangeText(i.impactTime)}{i.impactOrigin ? ` (${t(`proj.cod.origin.${i.impactOrigin}`)})` : ''}</td>
                  <td>{i.done ? t('proj.tri.start.done') : rangeText(i.response)}{!i.done && i.responseOrigin ? ` (${t(`proj.cod.origin.${i.responseOrigin}`)})` : ''}</td>
                  <td>{startText(i)}</td>
                  <td className="num">{i.pLate === null ? '—' : fmt.percent(i.pLate)}</td>
                  <td>{t(`proj.tri.growth.${i.growth}`)}</td>
                  <td>
                    <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setEditing(i.id)} aria-label={`${t('proj.tri.estimate')}: ${nameOf(i.id)}`} data-testid={`step-triage-estimate-${i.id}`}>
                      {t('proj.tri.estimate')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <details className="dec-edit" data-testid="step-triage-anchors">
        <summary>{t('proj.tri.anchorsLabel')}</summary>
        <p className="muted">{t('proj.tri.anchorsLead')}</p>
        {(['impact', 'feasibility'] as const).map((kind) => (
          <section key={kind} aria-labelledby={`${id}-anchor-${kind}`}>
            <h5 id={`${id}-anchor-${kind}`} className="prio-label">{t(`proj.tri.anchors.${kind}`)}</h5>
            <ol className="tri-anchors" reversed>
              {([5, 4, 3, 2, 1] as const).map((n) => <li key={n} value={n}>{RATING_ANCHORS[kind][n][lang]}</li>)}
            </ol>
          </section>
        ))}
      </details>
      {editIssue?.kind === 'issue' && <DelayEstimateDialog ctx={ctx} issueId={editIssue.id} name={nameOf(editIssue.id)} onClose={() => setEditing(null)} />}
    </Panel>
  );
}
