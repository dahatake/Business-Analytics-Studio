import { useEffect, useMemo, type ReactNode } from 'react';
import { Badge, Button, ProgressBar } from '@fluentui/react-components';
import { DocumentText20Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { IMPROVEMENT_STEPS, useActiveProject, useProjects, type ImprovementStep } from '../../state/projects.ts';
import { hrefFor, revisitRouteTarget, useRoute } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { kpiProgress } from '../../domain/kpi.ts';
import { ScrollRegion } from './common.tsx';
import { inputKey, type TodoResult } from './deliverables.ts';
import { deliverableNameKey, todoHref, todoLabel, useCheckContext, usePaybackLimit } from './deliverablesUi.tsx';
import { StepBriefPanel } from './StepBriefPanel.tsx';
import { BridgeChart, CauseParetoChart, GanttChart, GapChart, KpiQualityChart, PaybackChart, PriorityMatrix, RangeChart, type NameOf } from './stepCharts.tsx';
import { stepDashboard, tileTone, type DashTile, type DetailOf, type KpiRow, type OkrRow, type SolutionRow, type StepDashboard, type StepDetail } from './stepDashboard.ts';
import './project.css';

const isStep = (s: string | null): s is ImprovementStep => !!s && (IMPROVEMENT_STEPS as readonly string[]).includes(s);
type Visible = (id: string) => boolean;

/** Hash link for a stored "path?query" string. */
const linkOf = (href: string) => {
  const [path = '/', query = ''] = href.split('?');
  return hrefFor(path, new URLSearchParams(query));
};

function YesNo({ ok }: { ok: boolean }) {
  const { t } = useI18n();
  return <span className={ok ? 'step-dash-yes' : 'step-dash-no'}>{t(ok ? 'proj.dash.yes' : 'proj.dash.no')}</span>;
}

function OkNg({ ok }: { ok: boolean }) {
  const { t } = useI18n();
  return <span className={ok ? 'step-dash-yes' : 'step-dash-no'}>{t(ok ? 'proj.dash.ok' : 'proj.dash.ng')}</span>;
}

function HiddenNote({ n }: { n: number }) {
  const { t } = useI18n();
  return n > 0 ? <p className="muted" data-testid="step-dash-hidden">{t('proj.dash.hidden', { n })}</p> : null;
}

function Empty({ text = 'proj.dash.empty' }: { text?: MessageKey }) {
  const { t } = useI18n();
  return <p className="muted step-dash-empty">{t(text)}</p>;
}

/** One decision input. Its state is the verdict of the exit criterion it stands for, so it agrees with the to-do band. */
function Tile({ tile, results }: { tile: DashTile; results: TodoResult[] }) {
  const { t, fmt } = useI18n();
  const tone = tileTone(tile, results);
  const r = tile.todoId ? results.find((x) => x.todo.id === tile.todoId) : undefined;
  const label = t(`proj.dash.tile.${tile.id}` as MessageKey);
  const value = tone === 'empty'
    ? t('proj.dash.noData')
    : tile.kind === 'ratio'
      ? t('proj.dash.ratio', { value: fmt.number(tile.value), total: fmt.number(tile.total) })
      : t('proj.dash.items', { value: fmt.number(tile.value) });
  const state = t(`proj.dash.tone.${tone}`);
  const color = tone === 'ok' ? 'success' : tone === 'open' ? 'warning' : 'informative';
  return (
    <li>
      <a
        className="step-dash-tile"
        href={r ? todoHref(r) : linkOf(tile.href)}
        onClick={revisitRouteTarget}
        data-testid={`step-dash-tile-${tile.id}`}
        data-tone={tone}
        data-todo={tile.todoId}
        data-value={tile.value}
        data-total={tile.total}
      >
        <span className="step-dash-tile-label">{label}</span>
        <span className="step-dash-tile-value">{value}</span>
        {tile.kind === 'ratio' && tone !== 'empty' && (
          <ProgressBar value={tile.total ? tile.value / tile.total : 0} color={tone === 'ok' ? 'success' : 'warning'} thickness="large" aria-hidden />
        )}
        {tile.kind === 'problems' && tone !== 'empty' && <span className="step-dash-tile-sub">{t('proj.dash.ofChecked', { total: fmt.number(tile.total) })}</span>}
        <Badge size="small" appearance="tint" color={color} className="step-dash-tile-state">{state}</Badge>
      </a>
    </li>
  );
}

function Summary({ d }: { d: StepDashboard }) {
  const { t } = useI18n();
  const limit = usePaybackLimit();
  const manual = d.results.filter((r) => r.todo.kind === 'manual');
  return (
    <Panel title={t('proj.dash.summary')} testId="step-dash-summary" className="span-full">
      <div className="step-dash-summary">
        <p className="muted">{t('proj.dash.subtitle')}</p>
        <p className="step-dash-deliverable">{t('dlv.band.deliverable', { name: t(deliverableNameKey(d.step)) })}</p>
        <div className="step-dash-progress">
          <span data-testid="step-dash-progress">{t('proj.dash.progress', { done: d.progress.done, total: d.progress.total })}</span>
          <ProgressBar value={d.progress.total ? d.progress.done / d.progress.total : 0} color={d.progress.complete ? 'success' : 'brand'} thickness="large" aria-label={t('proj.dash.progress', { done: d.progress.done, total: d.progress.total })} />
        </div>
        {d.next ? (
          <p className="step-dash-next">
            <strong>{t('dlv.band.next')}</strong>{' '}
            <a href={todoHref(d.next)} onClick={revisitRouteTarget} data-testid="step-dash-next">{todoLabel(t, d.next.todo.id, limit)}</a>
          </p>
        ) : (
          <p className="step-dash-next" data-testid="step-dash-complete">{t('dlv.band.complete')}</p>
        )}
        {manual.length > 0 && (
          <div>
            <h3 className="step-dash-subhead">{t('proj.dash.signoffs')}</h3>
            <ul className="step-dash-signoffs">
              {manual.map((r) => (
                <li key={r.todo.id} data-testid={`step-dash-sign-${r.todo.id}`} data-done={r.done}>
                  <a href={todoHref(r)} onClick={revisitRouteTarget}>{todoLabel(t, r.todo.id, limit)}</a>{' '}
                  <Badge size="small" appearance="tint" color={r.done ? 'success' : 'warning'}>{t(r.done ? 'proj.dash.signed' : 'dlv.waiting')}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Links to the visible entities of a list, or "no" when there are none; hidden ones are only counted. */
function Refs({ ids, visible }: { ids: string[]; visible: Visible }) {
  const { t } = useI18n();
  if (ids.length === 0) return <YesNo ok={false} />;
  const shown = ids.filter(visible);
  return (
    <span className="step-dash-refs">
      {shown.map((id) => <EntityRef key={id} id={id} />)}
      {shown.length < ids.length && <span className="muted">{t('proj.dash.hiddenRefs', { n: ids.length - shown.length })}</span>}
    </span>
  );
}

function AsisDetail({ d, visible, nameOf }: { d: DetailOf<'asis'>; visible: Visible; nameOf: NameOf }) {
  const { t, lang, fmt } = useI18n();
  const issues = d.issues.filter((i) => visible(i.id));
  const kpis = d.kpis.filter((k) => visible(k.id));
  const mismatches = d.mismatches.filter((m) => m.where.type !== 'issue' || visible(m.where.id));
  return (
    <>
      <Panel title={t('proj.dash.asis.issues')} testId="step-dash-issues" className="span-full">
        <p className="muted">{t('proj.dash.asis.issuesHint')}</p>
        {d.issues.length === 0 ? <Empty /> : (
          <ScrollRegion label={t('proj.dash.asis.issues')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col" className="num">{t('proj.dash.col.rank')}</th>
                <th scope="col">{t('proj.dash.col.issue')}</th>
                <th scope="col" className="num">{t('proj.dash.col.score')}</th>
                <th scope="col" className="num">{t('proj.dash.col.impact')}</th>
                <th scope="col" className="num">{t('proj.dash.col.feasibility')}</th>
                <th scope="col" className="num">{t('proj.dash.col.kpiGap')}</th>
                <th scope="col">{t('proj.dash.col.tracked')}</th>
                <th scope="col">{t('proj.dash.col.source')}</th>
                <th scope="col">{t('proj.dash.col.cause')}</th>
                <th scope="col">{t('proj.dash.col.solution')}</th>
              </tr></thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.id} data-issue={i.id}>
                    <td className="num">{i.rank}</td>
                    <th scope="row"><EntityRef id={i.id} /></th>
                    <td className="num">{fmt.number(i.score)}</td>
                    <td className="num">{fmt.number(i.impact)}</td>
                    <td className="num">{fmt.number(i.feasibility)}</td>
                    <td className="num">{i.gap ? fmt.percent(i.gap.remaining) : '–'}</td>
                    <td><YesNo ok={i.inProject} /></td>
                    <td><YesNo ok={i.sourced} /></td>
                    <td><YesNo ok={i.caused} /></td>
                    <td><YesNo ok={i.solutionIds.length > 0} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <HiddenNote n={d.issues.length - issues.length} />
      </Panel>
      <Panel title={t('proj.dash.chart.matrix.panel')} testId="step-dash-matrix" className="span-full">
        <PriorityMatrix issues={issues} nameOf={nameOf} />
      </Panel>
      <Panel title={t('proj.dash.chart.pareto.panel')} testId="step-dash-pareto" className="span-full">
        <CauseParetoChart causes={d.causes} nameOf={nameOf} />
      </Panel>
      <Panel title={t('proj.dash.asis.kpis')} testId="step-dash-gaps" className="span-full">
        {d.kpis.length === 0 ? <Empty text="proj.dash.asis.noKpis" /> : <GapChart kpis={kpis} nameOf={nameOf} />}
        <HiddenNote n={d.kpis.length - kpis.length} />
      </Panel>
      <Panel title={t('proj.dash.asis.mismatches')} testId="step-dash-mismatches" className="span-full">
        {d.mismatches.length === 0 ? (
          <p className="muted">{d.checkedValues ? t('proj.dash.asis.noMismatch', { n: d.checkedValues }) : t('proj.dash.asis.noValues')}</p>
        ) : (
          <ScrollRegion label={t('proj.dash.asis.mismatches')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.dash.col.where')}</th>
                <th scope="col" className="num">{t('proj.dash.col.stated')}</th>
                <th scope="col">{t('proj.dash.col.recorded')}</th>
              </tr></thead>
              <tbody>
                {mismatches.map((m, n) => (
                  <tr key={`${m.where.id}-${n}`}>
                    <th scope="row">{m.where.type === 'issue' ? <EntityRef id={m.where.id} /> : loc(m.label, lang)}</th>
                    <td className="num">{fmt.number(m.stated)} {loc(m.unit, lang)}</td>
                    <td>{m.kpis.map((k, i) => <div key={i}>{`${loc(k.name, lang)}: ${fmt.number(k.baseline)} / ${fmt.number(k.current)} / ${fmt.number(k.target)}`}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <HiddenNote n={d.mismatches.length - mismatches.length} />
      </Panel>
    </>
  );
}

function KpiTable({ rows, label }: { rows: KpiRow[]; label: string }) {
  const { t, lang, fmt } = useI18n();
  return (
    <ScrollRegion label={label}>
      <table className="data-table compact">
        <thead><tr>
          <th scope="col">{t('proj.dash.col.kpi')}</th>
          <th scope="col" className="num">{t('proj.dash.col.baseline')}</th>
          <th scope="col" className="num">{t('proj.dash.col.current')}</th>
          <th scope="col" className="num">{t('proj.dash.col.target')}</th>
          <th scope="col" className="num">{t('proj.dash.col.progress')}</th>
          <th scope="col">{t('proj.dash.col.deadline')}</th>
          <th scope="col">{t('proj.dash.col.valid')}</th>
          <th scope="col">{t('proj.dash.col.okr')}</th>
        </tr></thead>
        <tbody>
          {rows.map((k) => {
            const unit = loc(k.unit, lang);
            return (
              <tr key={k.id}>
                <th scope="row">{loc(k.name, lang)}</th>
                <td className="num">{fmt.number(k.baseline)} {unit}</td>
                <td className="num">{fmt.number(k.current)} {unit}</td>
                <td className="num">{fmt.number(k.target)} {unit}</td>
                <td className="num">{k.target === k.baseline ? '–' : fmt.percent(kpiProgress(k))}</td>
                <td>{k.deadline ? fmt.date(k.deadline) : '–'} {!k.ahead && <OkNg ok={false} />}</td>
                <td><OkNg ok={k.valid} /></td>
                <td><YesNo ok={k.inOkr} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function OkrTable({ rows, label }: { rows: OkrRow[]; label: string }) {
  const { t, lang } = useI18n();
  return (
    <ScrollRegion label={label}>
      <table className="data-table compact">
        <thead><tr>
          <th scope="col">{t('proj.dash.col.okr')}</th>
          <th scope="col" className="num">{t('proj.dash.col.keyResults')}</th>
          <th scope="col">{t('proj.dash.col.kpi')}</th>
          <th scope="col">{t('proj.dash.col.objective')}</th>
        </tr></thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <th scope="row">{loc(o.objective, lang)}</th>
              <td className="num">{o.keyResults}</td>
              <td><YesNo ok={o.linked} /></td>
              <td><YesNo ok={o.aligned} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function TobeDetail({ d, visible }: { d: DetailOf<'tobe'>; visible: Visible }) {
  const { t, lang, fmt } = useI18n();
  const top = d.topIssues.filter((i) => visible(i.id));
  const ucs = d.useCases.filter((u) => visible(u.id));
  const hasProposed = d.proposed.kpis.length + d.proposed.okrs.length > 0;
  return (
    <>
      <Panel title={t('proj.dash.tobe.topIssues')} testId="step-dash-top-issues" className="span-full">
        <p className="muted">{t('proj.dash.tobe.topIssuesHint')}</p>
        {d.topIssues.length === 0 ? <Empty text="proj.dash.tobe.noIssues" /> : (
          <ScrollRegion label={t('proj.dash.tobe.topIssues')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col" className="num">{t('proj.dash.col.rank')}</th>
                <th scope="col">{t('proj.dash.col.issue')}</th>
                <th scope="col" className="num">{t('proj.dash.col.score')}</th>
                <th scope="col">{t('proj.dash.col.useCases')}</th>
              </tr></thead>
              <tbody>
                {top.map((i) => (
                  <tr key={i.id} data-issue={i.id} data-covered={i.useCaseIds.length > 0}>
                    <td className="num">{i.rank}</td>
                    <th scope="row"><EntityRef id={i.id} /></th>
                    <td className="num">{fmt.number(i.score)}</td>
                    <td><Refs ids={i.useCaseIds} visible={visible} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <HiddenNote n={d.topIssues.length - top.length} />
      </Panel>
      <Panel title={t('proj.dash.tobe.useCases')} testId="step-dash-use-cases" className="span-full">
        {d.useCases.length === 0 ? <Empty text="proj.dash.tobe.noUseCases" /> : (
          <ScrollRegion label={t('proj.dash.tobe.useCases')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.dash.col.useCase')}</th>
                <th scope="col">{t('proj.dash.col.persona')}</th>
                <th scope="col" className="num">{t('proj.dash.col.steps')}</th>
                <th scope="col">{t('proj.dash.col.effect')}</th>
                <th scope="col">{t('proj.dash.col.issue')}</th>
                <th scope="col" className="num">{t('proj.dash.col.kpis')}</th>
              </tr></thead>
              <tbody>
                {ucs.map((u) => (
                  <tr key={u.id}>
                    <th scope="row">{loc(u.name, lang)}</th>
                    <td>{t(`persona.${u.persona}` as MessageKey)}</td>
                    <td className="num">{u.steps}</td>
                    <td><YesNo ok={u.hasEffect} /></td>
                    <td><Refs ids={u.issueIds} visible={visible} /></td>
                    <td className="num">{u.kpis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <HiddenNote n={d.useCases.length - ucs.length} />
      </Panel>
      <Panel title={t('proj.dash.tobe.objectives')} testId="step-dash-objectives" className="span-full">
        {d.objectives.length === 0 ? <Empty text="proj.dash.tobe.noObjectives" /> : (
          <ScrollRegion label={t('proj.dash.tobe.objectives')}>
            <table className="data-table compact">
              <thead><tr><th scope="col">{t('proj.dash.col.objective')}</th><th scope="col">{t('proj.dash.col.linked')}</th></tr></thead>
              <tbody>
                {d.objectives.map((o) => <tr key={o.id}><th scope="row">{o.text}</th><td><YesNo ok={o.linked} /></td></tr>)}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </Panel>
      <Panel title={t('proj.dash.tobe.proposed')} testId="step-dash-proposed" className="span-full">
        <p className="muted">{t('proj.dash.tobe.proposedHint')}</p>
        {!hasProposed && <Empty text="proj.dash.tobe.noProposed" />}
        {d.proposed.kpis.length > 0 && <KpiTable rows={d.proposed.kpis} label={t('proj.dash.tobe.proposed')} />}
        {d.proposed.okrs.length > 0 && <OkrTable rows={d.proposed.okrs} label={t('proj.dash.kpi.okrs')} />}
      </Panel>
    </>
  );
}

function KpiDetail({ d }: { d: DetailOf<'kpi'> }) {
  const { t } = useI18n();
  return (
    <>
      <Panel title={t('proj.dash.chart.quality.panel')} testId="step-dash-quality" className="span-full">
        <KpiQualityChart kpis={d.kpis} />
      </Panel>
      <Panel title={t('proj.dash.kpi.kpis')} testId="step-dash-kpis" className="span-full">
        <p className="muted">{t('proj.dash.kpi.definition', { status: t(`sol.def.status.${d.definition}` as MessageKey) })}</p>
        {d.kpis.length === 0 ? <Empty /> : <KpiTable rows={d.kpis} label={t('proj.dash.kpi.kpis')} />}
      </Panel>
      <Panel title={t('proj.dash.kpi.okrs')} testId="step-dash-okrs" className="span-full">
        {d.okrs.length === 0 ? <Empty /> : <OkrTable rows={d.okrs} label={t('proj.dash.kpi.okrs')} />}
      </Panel>
    </>
  );
}

function SolutionsTable({ rows, visible, limit, title }: { rows: SolutionRow[]; visible: Visible; limit?: number; title: string }) {
  const { t, fmt } = useI18n();
  const shown = rows.filter((s) => visible(s.id));
  if (rows.length === 0) return <Empty />;
  return (
    <>
      <ScrollRegion label={title}>
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.dash.col.solution')}</th>
            <th scope="col">{t('proj.dash.col.type')}</th>
            <th scope="col" className="num">{t('proj.dash.col.contributions')}</th>
            <th scope="col" className="num">{t('proj.dash.col.cost')}</th>
            <th scope="col" className="num">{t('proj.dash.col.benefit')}</th>
            <th scope="col" className="num">{t('proj.dash.col.payback')}</th>
          </tr></thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <th scope="row"><EntityRef id={s.id} /></th>
                <td>{t(`sol.type.${s.type}` as MessageKey)} <Badge size="small" appearance="outline" color={s.confirmed ? 'success' : 'warning'}>{t(s.confirmed ? 'proj.dash.confirmed' : 'proj.dash.inferred')}</Badge></td>
                <td className="num">{s.contributions}</td>
                <td className="num">{fmt.yen(s.costJpy)}</td>
                <td className="num">{fmt.yen(s.annualBenefitJpy)}</td>
                <td className="num">
                  {Number.isFinite(s.payback) ? t('proj.dash.years', { n: s.payback.toFixed(1) }) : t('proj.dash.never')}
                  {limit !== undefined && <> <OkNg ok={s.payback <= limit} /></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <HiddenNote n={rows.length - shown.length} />
    </>
  );
}

function SolutionDetail({ d, visible, nameOf }: { d: DetailOf<'solution'>; visible: Visible; nameOf: NameOf }) {
  const { t, lang, fmt } = useI18n();
  const issues = d.issues.filter((i) => visible(i.id));
  return (
    <>
      <Panel title={t('proj.dash.sol.issues')} testId="step-dash-issue-solutions" className="span-full">
        <p className="muted">{t('proj.dash.sol.issuesHint')}</p>
        {d.issues.length === 0 ? <Empty text="proj.dash.tobe.noIssues" /> : (
          <ScrollRegion label={t('proj.dash.sol.issues')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col" className="num">{t('proj.dash.col.rank')}</th>
                <th scope="col">{t('proj.dash.col.issue')}</th>
                <th scope="col" className="num">{t('proj.dash.col.score')}</th>
                <th scope="col">{t('proj.dash.col.solution')}</th>
                <th scope="col">{t('proj.dash.col.useCases')}</th>
              </tr></thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.id} data-issue={i.id} data-solved={i.solutionIds.length > 0}>
                    <td className="num">{i.rank}</td>
                    <th scope="row"><EntityRef id={i.id} /></th>
                    <td className="num">{fmt.number(i.score)}</td>
                    <td><Refs ids={i.solutionIds} visible={visible} /></td>
                    <td><Refs ids={i.useCaseIds} visible={visible} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <HiddenNote n={d.issues.length - issues.length} />
      </Panel>
      <Panel title={t('proj.dash.chart.range.panel')} testId="step-dash-range" className="span-full">
        <RangeChart sims={d.sims} />
      </Panel>
      <Panel title={t('proj.dash.chart.bridge.panel')} testId="step-dash-bridge" className="span-full">
        <BridgeChart sims={d.sims} nameOf={nameOf} />
      </Panel>
      <Panel title={t('proj.dash.sol.solutions')} testId="step-dash-solutions" className="span-full">
        <SolutionsTable rows={d.solutions} visible={visible} title={t('proj.dash.sol.solutions')} />
      </Panel>
      <Panel title={t('proj.dash.sol.coverage')} testId="step-dash-coverage" className="span-full">
        {d.coverage.length === 0 ? <Empty /> : (
          <ScrollRegion label={t('proj.dash.sol.coverage')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.dash.col.kpi')}</th>
                <th scope="col" className="num">{t('proj.dash.col.coverage')}</th>
                <th scope="col" className="num">{t('proj.dash.col.probability')}</th>
              </tr></thead>
              <tbody>
                {d.coverage.map((r) => (
                  <tr key={r.kpiId}>
                    <th scope="row">{loc(r.name, lang)}</th>
                    <td className="num">
                      {r.coverage === undefined ? t('proj.dash.notEstimated') : r.coverage === null ? t('proj.dash.noGap') : <>{fmt.percent(r.coverage)} <OkNg ok={r.coverage >= 1} /></>}
                    </td>
                    <td className="num">{r.probability === undefined ? '–' : fmt.percent(r.probability)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </Panel>
    </>
  );
}

function DeliverableDetail({ d, visible, nameOf, today }: { d: DetailOf<'deliverable'>; visible: Visible; nameOf: NameOf; today: string }) {
  const { t, fmt } = useI18n();
  const rows = d.initiatives.filter((i) => visible(i.id));
  const trace = d.trace.filter((r) => visible(r.solutionId));
  return (
    <>
      <Panel title={t('proj.dash.dlv.trace')} testId="step-dash-trace" className="span-full">
        <p className="muted">{t('proj.dash.dlv.traceHint')}</p>
        {d.trace.length === 0 ? <Empty /> : (
          <ScrollRegion label={t('proj.dash.dlv.trace')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.dash.col.solution')}</th>
                <th scope="col">{t('proj.dash.col.issue')}</th>
                <th scope="col" className="num">{t('proj.dash.col.kpis')}</th>
                <th scope="col">{t('proj.dash.col.useCases')}</th>
                <th scope="col">{t('proj.dash.col.initiative')}</th>
                <th scope="col" className="num">{t('proj.dash.col.owned')}</th>
                <th scope="col">{t('proj.dash.col.traced')}</th>
              </tr></thead>
              <tbody>
                {trace.map((r) => (
                  <tr key={r.solutionId} data-solution={r.solutionId} data-complete={r.complete}>
                    <th scope="row"><EntityRef id={r.solutionId} /> <span className="muted">{t(`sol.type.${r.type}` as MessageKey)}</span></th>
                    <td><Refs ids={r.issueIds} visible={visible} /></td>
                    <td className="num">{r.kpiIds.length}</td>
                    <td>{r.type === 'digital' ? <Refs ids={r.useCaseIds} visible={visible} /> : '–'}</td>
                    <td><Refs ids={r.initiativeIds} visible={visible} /></td>
                    <td className="num">{t('proj.dash.ratio', { value: fmt.number(r.owned), total: fmt.number(r.initiativeIds.length) })}</td>
                    <td><OkNg ok={r.complete} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <HiddenNote n={d.trace.length - trace.length} />
      </Panel>
      <Panel title={t('proj.dash.dlv.initiatives')} testId="step-dash-initiatives" className="span-full">
        <GanttChart rows={d.initiatives} today={today} nameOf={nameOf} />
        {d.initiatives.length > 0 && (
          <ScrollRegion label={t('proj.dash.dlv.initiatives')}>
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('proj.dash.col.initiative')}</th>
                <th scope="col">{t('proj.dash.col.solution')}</th>
                <th scope="col">{t('proj.dash.col.period')}</th>
                <th scope="col">{t('proj.dash.col.owner')}</th>
                <th scope="col" className="num">{t('proj.dash.col.progress')}</th>
                <th scope="col">{t('proj.dash.col.schedule')}</th>
              </tr></thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <th scope="row"><EntityRef id={i.id} /></th>
                    <td><EntityRef id={i.solutionId} /></td>
                    <td>{`${fmt.date(i.start)} – ${fmt.date(i.end)}`}</td>
                    <td>{i.ownerId ? <EntityRef id={i.ownerId} /> : <YesNo ok={false} />}</td>
                    <td className="num">{fmt.percent(i.progress)}</td>
                    <td><OkNg ok={!i.conflict} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <HiddenNote n={d.initiatives.length - rows.length} />
      </Panel>
      <Panel title={t('proj.dash.sol.solutions')} testId="step-dash-payback" className="span-full">
        <p className="muted">{t('proj.dash.dlv.payback', { max: d.paybackLimit })}</p>
        <PaybackChart rows={d.solutions} limit={d.paybackLimit} nameOf={nameOf} />
        <SolutionsTable rows={d.solutions} visible={visible} limit={d.paybackLimit} title={t('proj.dash.sol.solutions')} />
      </Panel>
    </>
  );
}

function StepDetailPanels({ d, visible, nameOf, today }: { d: StepDetail; visible: Visible; nameOf: NameOf; today: string }) {
  switch (d.step) {
    case 'asis': return <AsisDetail d={d} visible={visible} nameOf={nameOf} />;
    case 'tobe': return <TobeDetail d={d} visible={visible} />;
    case 'kpi': return <KpiDetail d={d} />;
    case 'solution': return <SolutionDetail d={d} visible={visible} nameOf={nameOf} />;
    case 'deliverable': return <DeliverableDetail d={d} visible={visible} nameOf={nameOf} today={today} />;
  }
}

function DocPanel({ d }: { d: StepDashboard }) {
  const { t } = useI18n();
  const empty = d.doc.total - d.doc.complete - d.doc.vague;
  const item = (key: MessageKey, n: number, id: string): ReactNode => (
    <div className="step-dash-stat" data-testid={`step-dash-doc-${id}`}><dt>{t(key)}</dt><dd>{t('proj.dash.items', { value: n })}</dd></div>
  );
  return (
    <Panel title={t('proj.dash.doc')} testId="step-dash-doc">
      <dl className="step-dash-stats">
        {item('proj.dash.doc.complete', d.doc.complete, 'complete')}
        {item('proj.dash.doc.vague', d.doc.vague, 'vague')}
        {item('proj.dash.doc.empty', empty, 'empty')}
        {item('proj.dash.doc.byAi', d.doc.byAi, 'ai')}
      </dl>
    </Panel>
  );
}

function InputsPanel({ d }: { d: StepDashboard }) {
  const { t } = useI18n();
  return (
    <Panel title={t('proj.dash.inputs')} testId="step-dash-inputs">
      <ul className="step-dash-inputs">
        {d.inputs.map((i) => (
          <li key={i.id}>
            <a href={linkOf(i.href)}>{t(inputKey(i.id))}</a>{' '}
            <Badge appearance="outline" color={i.count ? 'informative' : 'warning'} data-testid={`step-dash-input-${i.id}`}>
              {i.count ? t('dlv.screen.count', { n: i.count }) : t('proj.dash.noData')}
            </Badge>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** FR-317: the step dashboard opened from the stepper — everything the step decides on, in one place. */
export function StepDashboardScreen() {
  const { t, lang } = useI18n();
  const route = useRoute();
  const { step: activeStep } = useActiveProject();
  const setStep = useProjects((s) => s.setStep);
  const q = route.query.get('step');
  const step: ImprovementStep = isStep(q) ? q : activeStep;
  // A shared link or the back button opens a step other than the current one: make it current so the stepper agrees.
  useEffect(() => { if (step !== activeStep) setStep(step); }, [step, activeStep, setStep]);
  const ctx = useCheckContext();
  const audience = useSettings((s) => s.audience);
  const d = useMemo(() => stepDashboard(step, ctx), [step, ctx]);
  const visible = useMemo<Visible>(() => (id) => {
    const e = ctx.pack.byId.get(id);
    return !e || !isHidden(e, audience);
  }, [ctx, audience]);
  const nameOf = useMemo<NameOf>(() => (id) => {
    const e = ctx.pack.byId.get(id);
    if (!e) return id;
    return isHidden(e, audience) ? t('proj.dash.chart.hidden') : loc(e.name, lang);
  }, [ctx, audience, lang, t]);
  const n = IMPROVEMENT_STEPS.indexOf(step) + 1;
  return (
    <div className="screen proj-screen step-dash" data-testid="step-dash" data-step={step}>
      <PageHeader
        title={t('proj.dash.title', { n, total: IMPROVEMENT_STEPS.length, step: t(`proj.step.${step}`) })}
        subtitle={t(`dlv.${step}.purpose` as MessageKey)}
        actions={(
          <Button as="a" href={hrefFor('/deliverables', { step })} appearance="primary" icon={<DocumentText20Regular />} data-testid="step-dash-open">
            {t('dlv.band.open')}
          </Button>
        )}
      />
      <StepBriefPanel d={d} ctx={ctx} audience={audience} />
      <Summary d={d} />
      <Panel title={t('proj.dash.tiles')} testId="step-dash-tiles" className="span-full">
        <p className="muted">{t('proj.dash.tilesHint')}</p>
        <ul className="step-dash-tiles">
          {d.tiles.map((tile) => <Tile key={tile.id} tile={tile} results={d.results} />)}
        </ul>
      </Panel>
      <StepDetailPanels d={d.detail} visible={visible} nameOf={nameOf} today={ctx.today} />
      <DocPanel d={d} />
      <InputsPanel d={d} />
    </div>
  );
}
