import { useMemo, type ReactNode } from 'react';
import { Badge, Button, Checkbox, Field, Input, Select, Slider } from '@fluentui/react-components';
import { ArrowDownload20Regular, ArrowReset20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { DecisionReportExtension, REPORT_EVIDENCE, type DecisionReport, type ReportEvidence } from '../../data/extensionSchemas.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { Panel } from '../../ui/Panel.tsx';
import {
  AUTO_CHECKS, autoChecks, BASELINE_STATUS, emptyDecisionInputs, evidenceProfile, GATE_PLACEHOLDER, gapRows, ISSUE_CRITERIA, MANUAL_CHECKS,
  OPTION_CRITERIA, rankAcceptability, rankIssues, rankOptions, rankQuestions, reportGate, riskMatrix, simulateGate,
  VOI_CRITERIA, type BaselineStatus, type DecisionInputs, type GateInputs, type Rated,
} from './decisionSupport.ts';
import { ChartFigure, Glyph, LegendItem } from './stepCharts.tsx';
import { downloadText, useTargetNames } from './common.tsx';
import { buildReportRequirements, reportRequirementsMarkdown } from './reportRequirements.ts';
import { buildDrafts, effectiveLinks, resolve, type DraftDecision } from './reportDrafts.ts';
import { useDecisionInputs } from './stores.ts';

/*
 * FR-321: decision support on each step dashboard, computed from an imported decision report
 * (extensions.decisionReport) and the user's own ratings. Shown only when the pack holds a report.
 * Every value the user has not rated is labelled as coming from the report or as not rated.
 */

type Update = (fn: (d: DecisionInputs) => DecisionInputs) => void;
type Props = { r: DecisionReport; d: DecisionInputs; update: Update };

const pct = (x: number) => `${Math.max(0, Math.min(100, x * 100))}%`;
const RATINGS = [1, 2, 3, 4, 5] as const;

/** The report the active pack carries, or null. */
export function useDecisionReport(extensions: Record<string, unknown> | undefined): DecisionReport | null {
  return useMemo(() => {
    const parsed = DecisionReportExtension.safeParse(extensions?.decisionReport);
    return parsed.success ? parsed.data : null;
  }, [extensions]);
}

export function DecisionSupport({ step, report, visible, gateOnly }: { step: ImprovementStep; report: DecisionReport | null; visible: boolean; gateOnly?: boolean }) {
  const { lang } = useI18n();
  const all = useDecisionInputs((s) => s.value);
  const set = useDecisionInputs((s) => s.set);
  const saved = report ? all[report.sourceId] : undefined;
  const drafts = useMemo(
    () => (report && visible ? buildDrafts(report, { ...emptyDecisionInputs(), ...saved }, lang) : null),
    [report, saved, visible, lang],
  );
  if (!report || !visible || !drafts) return null;
  const d = { ...emptyDecisionInputs(), ...saved };
  const update: Update = (fn) => set((v) => ({ ...v, [report.sourceId]: fn({ ...emptyDecisionInputs(), ...v[report.sourceId] }) }));
  const reset = () => set((v) => {
    const next = { ...v };
    delete next[report.sourceId];
    return next;
  });
  const p = { r: report, d, update };
  if (gateOnly) return <GatePanel {...p} />;
  const links = effectiveLinks(drafts.optionIssues);
  const decide = <DraftDecisionsPanel {...p} drafts={drafts.decisions.filter((x) => x.step === step)} />;
  return (
    <>
      <EvidencePanel r={report} step={step} onReset={reset} />
      {step === 'asis' && <><IssuePanel {...p} /><QuestionPanel {...p} />{decide}</>}
      {step === 'tobe' && <><GapPanel {...p} />{decide}</>}
      {step === 'kpi' && <><KpiPanel {...p} />{decide}</>}
      {step === 'solution' && <><OptionPanel {...p} links={links} />{decide}</>}
      {step === 'deliverable' && <><RequirementsDraftPanel r={report} d={d} />{decide}<RoadmapPanel r={report} /><RiskPanel {...p} /><ChecklistPanel {...p} links={links} /></>}
    </>
  );
}

/* ---------- FR-322: drafted decisions with a recommendation and its rationale ---------- */

function DraftDecisionsPanel({ r, d, update, drafts }: Props & { drafts: DraftDecision[] }) {
  const { t } = useI18n();
  if (!drafts.length) return null;
  const open = drafts.filter((x) => resolve(x, d).origin === 'inferred').length;
  const choose = (id: string, value: string) => update((x) => {
    const choices = { ...x.choices };
    if (value) choices[id] = value; else delete choices[id];
    return { ...x, choices };
  });
  const acceptAll = () => update((x) => ({ ...x, choices: { ...x.choices, ...Object.fromEntries(drafts.filter((y) => !x.choices[y.id]).map((y) => [y.id, y.recommended])) } }));
  return (
    <Panel
      title={t('proj.dash.dec.draft.panel')} rationale="proj.dash.dec.draft.rationale" testId="step-dash-dec-drafts" className="span-full"
      actions={open > 0 ? <Button size="small" onClick={acceptAll} data-testid="step-dash-dec-drafts-accept">{t('proj.dash.dec.draft.acceptAll')}</Button> : undefined}
    >
      <p data-testid="step-dash-dec-drafts-read" data-open={open}>
        <Glyph ok={open === 0} />{' '}
        {t(open ? 'proj.dash.dec.draft.readOpen' : 'proj.dash.dec.draft.readDone', { total: drafts.length, open })}
      </p>
      <table className="data-table compact dec-drafts">
        <thead><tr>
          <th scope="col">{t('proj.dash.dec.draft.col.subject')}</th>
          <th scope="col">{t('proj.dash.dec.draft.col.choice')}</th>
          <th scope="col">{t('proj.dash.dec.draft.col.confidence')}</th>
          <th scope="col">{t('proj.dash.dec.draft.col.reasons')}</th>
        </tr></thead>
        <tbody>
          {drafts.map((x) => {
            const res = resolve(x, d);
            const rec = x.options.find((o) => o.id === x.recommended)!;
            return (
              <tr key={x.id} data-testid={`step-dash-dec-draft-${x.id}`} data-kind={x.kind} data-origin={res.origin} data-chosen={res.option.id}>
                <th scope="row">
                  <span className="dec-kind">{t(`proj.dash.dec.draft.kind.${x.kind}`)}</span>
                  <Quote lang={r.lang}>{x.subject}</Quote> <span className="muted">{`L${x.line}`}</span>
                </th>
                <td>
                  <Select
                    size="small" aria-label={`${t(`proj.dash.dec.draft.kind.${x.kind}`)}: ${x.subject}`} data-testid={`step-dash-dec-choice-${x.id}`}
                    value={d.choices[x.id] && x.options.some((o) => o.id === d.choices[x.id]) ? d.choices[x.id] : ''}
                    onChange={(_, data) => choose(x.id, data.value)}
                  >
                    <option value="">{t('proj.dash.dec.draft.unconfirmed', { label: rec.label })}</option>
                    {x.options.map((o) => <option key={o.id} value={o.id}>{o.id === x.recommended ? t('proj.dash.dec.draft.star', { label: o.label }) : o.label}</option>)}
                  </Select>
                  {res.origin === 'inferred' && <Badge size="small" appearance="outline" color="warning">{t('proj.dash.dec.draft.inferred')}</Badge>}
                </td>
                <td><Badge size="small" appearance="tint" color={x.confidence === 'high' ? 'success' : x.confidence === 'medium' ? 'informative' : 'warning'}>{t(`proj.dash.dec.draft.conf.${x.confidence}`)}</Badge></td>
                <td>
                  <details className="dec-why">
                    <summary>{t('proj.dash.dec.draft.why', { label: rec.label })}</summary>
                    <ul>{x.reasons.map((s, i) => <li key={i}>{s}</li>)}</ul>
                    <p><strong>{t('proj.dash.dec.draft.flip')}</strong> {x.flip}</p>
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

/* ---------- Shared inputs ---------- */

function RatingSelect({ label, value, onChange, testId }: { label: string; value: Rated; onChange: (v: number | undefined) => void; testId?: string }) {
  const { t } = useI18n();
  return (
    <Select
      size="small" aria-label={label} data-testid={testId} data-origin={value.origin}
      value={value.origin === 'user' ? String(value.value) : ''}
      onChange={(_, data) => onChange(data.value ? Number(data.value) : undefined)}
    >
      <option value="">{t(`proj.dash.dec.default.${value.origin === 'user' ? 'unrated' : value.origin}`, { value: value.value })}</option>
      {RATINGS.map((n) => <option key={n} value={n}>{n}</option>)}
    </Select>
  );
}

function OriginBadge({ origin }: { origin: Rated['origin'] }) {
  const { t } = useI18n();
  if (origin === 'user') return null;
  return <Badge size="small" appearance="outline" color={origin === 'report' ? 'informative' : 'warning'}>{t(`proj.dash.dec.origin.${origin}`)}</Badge>;
}

function Weights<K extends string>({ keys, weights, label, onChange, testId }: {
  keys: readonly K[]; weights: Record<K, number>; label: (k: K) => string; onChange: (k: K, v: number) => void; testId: string;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="dec-weights" data-testid={testId}>
      <legend>{t('proj.dash.dec.weights')}</legend>
      {keys.map((k) => (
        <Field key={k} label={`${label(k)}: ${weights[k]}`} size="small">
          <Slider min={0} max={5} step={1} size="small" value={weights[k]} onChange={(_, data) => onChange(k, data.value)} data-testid={`${testId}-${k}`} />
        </Field>
      ))}
    </fieldset>
  );
}

function ScoreBar({ value, max = 5, brand }: { value: number; max?: number; brand: boolean }) {
  return (
    <span className="step-chart-track">
      <span className={`step-chart-bar ${brand ? 'is-brand' : 'is-neutral'}`} style={{ width: pct(value / max) }} />
    </span>
  );
}

function Quote({ children, lang }: { children: ReactNode; lang: string }) {
  return <span lang={lang} className="dec-quote">{children}</span>;
}

/* ---------- All steps: what the report says, and how firmly ---------- */

const EV_CLASS: Record<ReportEvidence | 'unlabelled', string> = {
  fact: 'is-fact', external: 'is-external', interpretation: 'is-interpretation', hypothesis: 'is-hypothesis',
  proposedTarget: 'is-proposed', toConfirm: 'is-confirm', unlabelled: 'is-unlabelled',
};

function EvidencePanel({ r, step, onReset }: { r: DecisionReport; step: ImprovementStep; onReset: () => void }) {
  const { t, fmt } = useI18n();
  const profile = evidenceProfile(r, step);
  const labelled = profile.sentences - profile.unlabelled;
  const parts = [...REPORT_EVIDENCE.map((e) => [e, profile.counts[e]] as const), ['unlabelled', profile.unlabelled] as const].filter(([, n]) => n > 0);
  const total = Math.max(1, profile.sentences);
  const read = !profile.sentences
    ? t('proj.dash.dec.ev.none')
    : !labelled
      ? t('proj.dash.dec.ev.noLabels', { sentences: profile.sentences })
      : t('proj.dash.dec.ev.read', { sentences: profile.sentences, labelled, uncertain: fmt.percent(profile.uncertainShare) });
  return (
    <Panel
      title={t('proj.dash.dec.title')} rationale="proj.dash.dec.rationale" testId="step-dash-dec" className="span-full"
      actions={<Button size="small" appearance="subtle" icon={<ArrowReset20Regular />} onClick={onReset} data-testid="step-dash-dec-reset">{t('proj.dash.dec.reset')}</Button>}
    >
      <p className="muted">
        {t('proj.dash.dec.source', { title: r.title, asOf: r.asOf ?? '—' })}
        {r.positioning && <> <Quote lang={r.lang}>{r.positioning}</Quote></>}
      </p>
      <ChartFigure
        id="dec-evidence"
        title={t('proj.dash.dec.ev.title', { step: t(`proj.step.${step}`) })}
        read={read}
        legend={<>{parts.map(([e]) => <LegendItem key={e} kind={`dec-ev ${EV_CLASS[e]}`} label={t(`proj.dash.dec.ev.${e}`)} />)}</>}
        visual={(
          <div className="dec-stack" data-testid="step-dash-dec-stack">
            {parts.map(([e, n]) => <span key={e} className={`dec-ev ${EV_CLASS[e]}`} style={{ width: pct(n / total) }} data-evidence={e} data-count={n} />)}
          </div>
        )}
        table={(
          <table className="data-table compact">
            <thead><tr><th scope="col">{t('proj.dash.dec.col.evidence')}</th><th scope="col" className="num">{t('proj.dash.dec.col.sentences')}</th></tr></thead>
            <tbody>{parts.map(([e, n]) => <tr key={e}><th scope="row">{t(`proj.dash.dec.ev.${e}`)}</th><td className="num">{n}</td></tr>)}</tbody>
          </table>
        )}
      />
    </Panel>
  );
}

/* ---------- As-is: issue priority and the questions worth asking first ---------- */

function IssuePanel({ r, d, update }: Props) {
  const { t, fmt } = useI18n();
  const rows = rankIssues(r, d);
  if (!rows.length) return null;
  const top = rows[0]!;
  const fragile = rows.slice(0, 3).filter((x) => x.hypothesis && !x.falsifier).length;
  const rate = (id: string, k: (typeof ISSUE_CRITERIA)[number], v: number | undefined) =>
    update((x) => ({ ...x, issues: { ...x.issues, [id]: { ...x.issues[id], [k]: v } } }));
  return (
    <Panel title={t('proj.dash.dec.issue.panel')} rationale="proj.dash.dec.issue.rationale" testId="step-dash-dec-issues" className="span-full">
      <Weights keys={ISSUE_CRITERIA} weights={d.issueWeights} label={(k) => t(`proj.dash.dec.issue.${k}`)} testId="step-dash-dec-issue-w"
        onChange={(k, v) => update((x) => ({ ...x, issueWeights: { ...x.issueWeights, [k]: v } }))} />
      <ChartFigure
        id="dec-issues"
        title={t('proj.dash.dec.issue.title', { title: top.title, score: fmt.number(top.score) })}
        read={fragile ? t('proj.dash.dec.issue.fragile', { n: fragile }) : t('proj.dash.dec.issue.read')}
        legend={<><LegendItem kind="is-brand" label={t('proj.dash.dec.top3')} /><LegendItem kind="is-neutral" label={t('proj.dash.dec.rest')} /></>}
        visual={(
          <div className="step-chart-rows">
            {rows.map((row) => (
              <div key={row.id} className="step-chart-row" data-testid={`step-dash-dec-issue-${row.id}`} data-rank={row.rank}>
                <span className="step-chart-label" lang={r.lang}>{`${row.rank}. ${row.title}`}</span>
                <ScoreBar value={row.score} brand={row.rank <= 3} />
                <span className="step-chart-value">{fmt.number(row.score)}</span>
              </div>
            ))}
          </div>
        )}
        table={(
          <table className="data-table compact">
            <thead><tr>
              <th scope="col" className="num">{t('proj.dash.col.rank')}</th><th scope="col">{t('proj.dash.dec.col.issue')}</th>
              {ISSUE_CRITERIA.map((k) => <th key={k} scope="col">{t(`proj.dash.dec.issue.${k}`)}</th>)}
              <th scope="col" className="num">{t('proj.dash.dec.col.score')}</th>
              <th scope="col">{t('proj.dash.dec.col.hypothesis')}</th><th scope="col">{t('proj.dash.dec.col.falsifier')}</th>
            </tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="num">{row.rank}</td>
                  <th scope="row" lang={r.lang}>{row.title}</th>
                  {ISSUE_CRITERIA.map((k) => <td key={k}>{row.ratings[k].value}</td>)}
                  <td className="num">{fmt.number(row.score)}</td>
                  <td><Glyph ok={!row.hypothesis} /></td><td><Glyph ok={row.falsifier} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      />
      <details className="dec-edit" open>
        <summary>{t('proj.dash.dec.rate')}</summary>
        <div className="dec-grid" role="group" aria-label={t('proj.dash.dec.rate')}>
          {rows.map((row) => {
            const issue = r.issues.find((i) => i.id === row.id)!;
            return (
              <div key={row.id} className="dec-card" data-testid={`step-dash-dec-rate-${row.id}`}>
                <div className="dec-card-head">
                  <strong lang={r.lang}>{row.title}</strong>
                  {row.hypothesis && <Badge size="small" color="warning" appearance="tint">{t('proj.dash.dec.ev.hypothesis')}</Badge>}
                </div>
                <div className="dec-ratings">
                  {ISSUE_CRITERIA.map((k) => (
                    <label key={k}>{t(`proj.dash.dec.issue.${k}`)} <OriginBadge origin={row.ratings[k].origin} />
                      <RatingSelect label={`${row.title} ${t(`proj.dash.dec.issue.${k}`)}`} value={row.ratings[k]} onChange={(v) => rate(row.id, k, v)} testId={`step-dash-dec-rate-${row.id}-${k}`} />
                    </label>
                  ))}
                </div>
                {issue.rootCause && <p className="dec-note"><strong>{t('proj.dash.dec.issue.rootCause')}</strong> <Quote lang={r.lang}>{issue.rootCause}</Quote></p>}
                <p className="dec-note"><strong>{t('proj.dash.dec.col.falsifier')}</strong> {issue.falsifier ? <Quote lang={r.lang}>{issue.falsifier}</Quote> : <span className="muted">{t('proj.dash.dec.notStated')}</span>}</p>
              </div>
            );
          })}
        </div>
      </details>
    </Panel>
  );
}

function QuestionPanel({ r, d, update }: Props) {
  const { t, fmt } = useI18n();
  const rows = rankQuestions(r, d);
  if (!rows.length) return null;
  const rated = rows.filter((q) => VOI_CRITERIA.some((k) => q.ratings[k].origin === 'user')).length;
  const rate = (id: string, k: (typeof VOI_CRITERIA)[number], v: number | undefined) =>
    update((x) => ({ ...x, questions: { ...x.questions, [id]: { ...x.questions[id], [k]: v } } }));
  return (
    <Panel title={t('proj.dash.dec.q.panel')} rationale="proj.dash.dec.q.rationale" testId="step-dash-dec-questions" className="span-full">
      <p className="muted">{rated ? t('proj.dash.dec.q.read', { top: rows[0]!.text, rated, total: rows.length }) : t('proj.dash.dec.q.unrated', { total: rows.length })}</p>
      <div className="dec-table-wrap">
        <table className="data-table compact" data-testid="step-dash-dec-q-table">
          <caption className="visually-hidden">{t('proj.dash.dec.q.panel')}</caption>
          <thead><tr>
            <th scope="col" className="num">{t('proj.dash.col.rank')}</th><th scope="col">{t('proj.dash.dec.col.question')}</th>
            {VOI_CRITERIA.map((k) => <th key={k} scope="col">{t(`proj.dash.dec.q.${k}`)}</th>)}
            <th scope="col">{t('proj.dash.dec.col.voi')}</th>
          </tr></thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.id} data-testid={`step-dash-dec-q-${q.id}`} data-rank={q.rank}>
                <td className="num">{q.rank}</td>
                <th scope="row" lang={r.lang}>{q.text}</th>
                {VOI_CRITERIA.map((k) => (
                  <td key={k}><RatingSelect label={`${q.text} ${t(`proj.dash.dec.q.${k}`)}`} value={q.ratings[k]} onChange={(v) => rate(q.id, k, v)} testId={`step-dash-dec-q-${q.id}-${k}`} /></td>
                ))}
                <td className="dec-score-cell"><ScoreBar value={q.score} brand={q.rank <= 3 && rated > 0} /><span className="step-chart-value">{fmt.number(q.score)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ---------- To-be: maturity gaps ---------- */

function GapPanel({ r, d, update }: Props) {
  const { t, fmt } = useI18n();
  const rows = gapRows(r, d);
  if (!rows.length) return null;
  const rated = rows.filter((g) => g.size !== undefined);
  const top = rated[0];
  const set = (id: string, k: 'current' | 'target', v: number | undefined) =>
    update((x) => ({ ...x, gaps: { ...x.gaps, [id]: { ...x.gaps[id], [k]: v } } }));
  const level = (n: number | undefined) => (n === undefined ? { value: 3, origin: 'unrated' as const } : { value: n, origin: 'user' as const });
  return (
    <Panel title={t('proj.dash.dec.gap.panel')} rationale="proj.dash.dec.gap.rationale" testId="step-dash-dec-gaps" className="span-full">
      <ChartFigure
        id="dec-gaps"
        title={top ? t('proj.dash.dec.gap.title', { area: top.area, from: top.current!, to: top.target! }) : t('proj.dash.dec.gap.titleUnrated', { n: rows.length })}
        read={t('proj.dash.dec.gap.read', { rated: rated.length, total: rows.length })}
        legend={<><LegendItem kind="is-current" label={t('proj.dash.dec.gap.current')} /><LegendItem kind="is-brand" label={t('proj.dash.dec.gap.target')} /><LegendItem kind="is-neutral" label={t('proj.dash.dec.gap.priorityLegend')} /></>}
        visual={(
          <div className="step-chart-rows">
            {rows.map((g) => (
              <div key={g.id} className="step-chart-row" data-testid={`step-dash-dec-gap-${g.id}`}>
                <span className="step-chart-label" lang={r.lang}>{g.area}</span>
                <span className="step-chart-track is-plain">
                  {g.current !== undefined && g.target !== undefined && (
                    <span className="step-chart-bar is-float is-brand dec-dumbbell" style={{ left: pct((Math.min(g.current, g.target) - 1) / 4), width: pct(Math.abs(g.target - g.current) / 4) }} />
                  )}
                  {g.size === undefined && g.priority !== undefined && <span className="step-chart-bar is-float is-neutral" style={{ width: pct(g.priority / 3) }} />}
                  {g.current !== undefined && <span className="step-chart-dot" style={{ left: pct((g.current - 1) / 4) }} />}
                  {g.target !== undefined && <span className="step-chart-dot dec-dot-target" style={{ left: pct((g.target - 1) / 4) }} />}
                </span>
                <span className="step-chart-value">{g.size !== undefined ? fmt.number(g.weighted!) : g.priority !== undefined ? t('proj.dash.dec.gap.priorityValue', { value: fmt.number(g.priority) }) : t('proj.dash.dec.origin.unrated')}</span>
              </div>
            ))}
          </div>
        )}
        table={(
          <table className="data-table compact">
            <thead><tr>
              <th scope="col">{t('proj.dash.dec.col.area')}</th><th scope="col">{t('proj.dash.dec.col.priority')}</th>
              <th scope="col">{t('proj.dash.dec.gap.asIs')}</th><th scope="col">{t('proj.dash.dec.gap.toBe')}</th><th scope="col">{t('proj.dash.dec.gap.gap')}</th>
            </tr></thead>
            <tbody>
              {rows.map((g) => {
                const src = r.gaps.find((x) => x.id === g.id)!;
                return (
                  <tr key={g.id}>
                    <th scope="row" lang={r.lang}>{g.area}</th><td>{g.priority ?? '—'}</td>
                    <td lang={r.lang}>{src.asIs ?? '—'}</td><td lang={r.lang}>{src.toBe ?? '—'}</td><td lang={r.lang}>{src.gap ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      />
      <div className="dec-grid" role="group" aria-label={t('proj.dash.dec.rate')}>
        {rows.map((g) => (
          <div key={g.id} className="dec-card">
            <strong lang={r.lang}>{g.area}</strong>
            {r.gaps.find((x) => x.id === g.id)?.gap && <p className="dec-note"><Quote lang={r.lang}>{r.gaps.find((x) => x.id === g.id)!.gap}</Quote></p>}
            <div className="dec-ratings">
              <label>{t('proj.dash.dec.gap.current')}<RatingSelect label={`${g.area} ${t('proj.dash.dec.gap.current')}`} value={level(g.current)} onChange={(v) => set(g.id, 'current', v)} testId={`step-dash-dec-gap-${g.id}-current`} /></label>
              <label>{t('proj.dash.dec.gap.target')}<RatingSelect label={`${g.area} ${t('proj.dash.dec.gap.target')}`} value={level(g.target)} onChange={(v) => set(g.id, 'target', v)} testId={`step-dash-dec-gap-${g.id}-target`} /></label>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ---------- KPI: measurability and the trial gate ---------- */

function KpiPanel({ r, d, update }: Props) {
  const { t } = useI18n();
  if (!r.kpis.length) return null;
  const status = (id: string): BaselineStatus => d.kpiBaseline[id] ?? 'none';
  const measured = r.kpis.filter((k) => status(k.id) === 'measured').length;
  const undefinedCount = r.kpis.filter((k) => !k.definition).length;
  return (
    <Panel title={t('proj.dash.dec.kpi.panel')} rationale="proj.dash.dec.kpi.rationale" testId="step-dash-dec-kpis" className="span-full">
      <p className="muted">{t('proj.dash.dec.kpi.read', { measured, total: r.kpis.length, undefinedCount })}</p>
      <div className="dec-table-wrap">
        <table className="data-table compact">
          <caption className="visually-hidden">{t('proj.dash.dec.kpi.panel')}</caption>
          <thead><tr>
            <th scope="col">{t('proj.dash.dec.col.category')}</th><th scope="col">{t('proj.dash.dec.col.kpi')}</th>
            <th scope="col">{t('proj.dash.dec.col.definition')}</th><th scope="col">{t('proj.dash.dec.col.baseline')}</th>
          </tr></thead>
          <tbody>
            {r.kpis.map((k) => (
              <tr key={k.id} data-testid={`step-dash-dec-kpi-${k.id}`}>
                <td lang={r.lang}>{k.category ?? '—'}</td>
                <th scope="row" lang={r.lang}>{k.name}</th>
                <td>{k.definition ? <Quote lang={r.lang}>{k.definition}</Quote> : <><Glyph ok={false} /> {t('proj.dash.dec.notStated')}</>}</td>
                <td>
                  <Select size="small" aria-label={`${k.name} ${t('proj.dash.dec.col.baseline')}`} value={status(k.id)} data-testid={`step-dash-dec-kpi-${k.id}-baseline`}
                    onChange={(_, data) => update((x) => ({ ...x, kpiBaseline: { ...x.kpiBaseline, [k.id]: data.value as BaselineStatus } }))}>
                    {BASELINE_STATUS.map((s) => <option key={s} value={s}>{t(`proj.dash.dec.kpi.${s}`)}</option>)}
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function GatePanel({ r, d, update }: Props) {
  const { t, fmt } = useI18n();
  const fromReport = reportGate(r);
  const g: GateInputs = { gate: fromReport ?? 0.2, ...GATE_PLACEHOLDER, ...d.gate, effect: { ...GATE_PLACEHOLDER.effect, ...d.gate.effect } };
  const result = useMemo(() => simulateGate(g), [g.gate, g.effect.low, g.effect.mode, g.effect.high, g.cv, g.n, g.overhead]); // eslint-disable-line react-hooks/exhaustive-deps
  const placeholder = d.gate.effect === undefined;
  const setGate = (patch: Partial<GateInputs>) => update((x) => ({ ...x, gate: { ...x.gate, ...patch } }));
  const percentInput = (label: string, value: number, onChange: (v: number) => void, id: string) => (
    <Field label={label} size="small">
      <Input type="number" size="small" min={0} max={99} step={1} value={String(Math.round(value * 100))} data-testid={`step-dash-dec-gate-${id}`}
        contentAfter={<span aria-hidden="true">{'%'}</span>} onChange={(_, data) => onChange(Number(data.value) / 100)} />
    </Field>
  );
  const best = result?.curve.find((c) => c.correct >= 0.8);
  return (
    <Panel title={t('proj.dash.dec.gate.panel')} rationale="proj.dash.dec.gate.rationale" testId="step-dash-dec-gate" className="span-full">
      <p className="muted">{fromReport !== null ? t('proj.dash.dec.gate.fromReport', { gate: fmt.percent(fromReport) }) : t('proj.dash.dec.gate.noReport')}</p>
      {placeholder && <p className="dec-warn" data-testid="step-dash-dec-gate-placeholder">{t('proj.dash.dec.gate.placeholder')}</p>}
      <div className="dec-gate-inputs">
        {percentInput(t('proj.dash.dec.gate.gate'), g.gate, (v) => setGate({ gate: v }), 'gate')}
        {percentInput(t('proj.dash.dec.gate.low'), g.effect.low, (v) => setGate({ effect: { ...g.effect, low: v } }), 'low')}
        {percentInput(t('proj.dash.dec.gate.mode'), g.effect.mode, (v) => setGate({ effect: { ...g.effect, mode: v } }), 'mode')}
        {percentInput(t('proj.dash.dec.gate.high'), g.effect.high, (v) => setGate({ effect: { ...g.effect, high: v } }), 'high')}
        {percentInput(t('proj.dash.dec.gate.overhead'), g.overhead, (v) => setGate({ overhead: v }), 'overhead')}
        {percentInput(t('proj.dash.dec.gate.cv'), g.cv, (v) => setGate({ cv: v }), 'cv')}
        <Field label={t('proj.dash.dec.gate.n')} size="small">
          <Input type="number" size="small" min={3} max={500} step={1} value={String(g.n)} data-testid="step-dash-dec-gate-n" onChange={(_, data) => setGate({ n: Math.round(Number(data.value)) })} />
        </Field>
      </div>
      {!result ? <p className="dec-warn" role="alert" data-testid="step-dash-dec-gate-invalid">{t('proj.dash.dec.gate.invalid')}</p> : (
        <>
          <dl className="dec-stats" data-testid="step-dash-dec-gate-result">
            <div><dt>{t('proj.dash.dec.gate.pass')}</dt><dd data-testid="step-dash-dec-gate-pass">{fmt.percent(result.pass)}</dd></div>
            <div><dt>{t('proj.dash.dec.gate.falsePass')}</dt><dd data-testid="step-dash-dec-gate-falsePass">{fmt.percent(result.falsePass)}</dd></div>
            <div><dt>{t('proj.dash.dec.gate.falseFail')}</dt><dd data-testid="step-dash-dec-gate-falseFail">{fmt.percent(result.falseFail)}</dd></div>
          </dl>
          <ChartFigure
            id="dec-gate"
            title={best ? t('proj.dash.dec.gate.title', { n: best.n }) : t('proj.dash.dec.gate.titleNone', { max: result.curve[result.curve.length - 1]!.n })}
            read={t('proj.dash.dec.gate.read', { n: g.n, correct: fmt.percent(result.correct) })}
            legend={<><LegendItem kind="is-brand" label={t('proj.dash.dec.gate.enough')} /><LegendItem kind="is-neutral" label={t('proj.dash.dec.gate.notEnough')} /></>}
            visual={(
              <div className="step-chart-rows">
                {result.curve.map((c) => (
                  <div key={c.n} className="step-chart-row">
                    <span className="step-chart-label">{t('proj.dash.dec.gate.perArm', { n: c.n })}</span>
                    <ScoreBar value={c.correct} max={1} brand={c.correct >= 0.8} />
                    <span className="step-chart-value">{fmt.percent(c.correct)}</span>
                  </div>
                ))}
              </div>
            )}
            table={(
              <table className="data-table compact">
                <thead><tr><th scope="col" className="num">{t('proj.dash.dec.gate.n')}</th><th scope="col" className="num">{t('proj.dash.dec.gate.correct')}</th></tr></thead>
                <tbody>{result.curve.map((c) => <tr key={c.n}><td className="num">{c.n}</td><td className="num">{fmt.percent(c.correct)}</td></tr>)}</tbody>
              </table>
            )}
          />
        </>
      )}
    </Panel>
  );
}

/* ---------- Solution: options, robustness and issue coverage ---------- */

function OptionPanel({ r, d, update, links }: Props & { links: ReadonlyMap<string, readonly string[]> }) {
  const { t, fmt } = useI18n();
  const issueRows = rankIssues(r, d);
  const rows = rankOptions(r, d, issueRows, links);
  const acc = useMemo(() => new Map(rankAcceptability(rows, d.optionWeights).map((a) => [a.id, a])), [JSON.stringify(rows.map((x) => x.ratings)), JSON.stringify(d.optionWeights)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null;
  const top = rows[0]!;
  const p1 = acc.get(top.id)?.first ?? 0;
  const issueTitle = new Map(r.issues.map((i, n) => [i.id, `${n + 1}`]));
  const rate = (id: string, k: (typeof OPTION_CRITERIA)[number], v: number | undefined) =>
    update((x) => ({ ...x, options: { ...x.options, [id]: { ...x.options[id], [k]: v } } }));
  return (
    <Panel title={t('proj.dash.dec.opt.panel')} rationale="proj.dash.dec.opt.rationale" testId="step-dash-dec-options" className="span-full">
      <Weights keys={OPTION_CRITERIA} weights={d.optionWeights} label={(k) => t(`proj.dash.dec.opt.${k}`)} testId="step-dash-dec-opt-w"
        onChange={(k, v) => update((x) => ({ ...x, optionWeights: { ...x.optionWeights, [k]: v } }))} />
      <ChartFigure
        id="dec-options"
        title={t('proj.dash.dec.opt.title', { label: top.label, title: top.title, p: fmt.percent(p1) })}
        read={p1 >= 0.7 ? t('proj.dash.dec.opt.robust') : t('proj.dash.dec.opt.close')}
        legend={<><LegendItem kind="is-brand" label={t('proj.dash.dec.opt.score')} /><LegendItem kind="is-neutral" label={t('proj.dash.dec.opt.first')} /></>}
        visual={(
          <div className="step-chart-rows">
            {rows.map((o) => (
              <div key={o.id} className="step-chart-row dec-two-bars" data-testid={`step-dash-dec-opt-${o.id}`} data-rank={o.rank} data-first={acc.get(o.id)?.first}>
                <span className="step-chart-label" lang={r.lang}>{`${o.label}. ${o.title}`}</span>
                <span className="dec-bars">
                  <ScoreBar value={o.score} brand />
                  <ScoreBar value={acc.get(o.id)?.first ?? 0} max={1} brand={false} />
                </span>
                <span className="step-chart-value">{`${fmt.number(o.score)} · ${fmt.percent(acc.get(o.id)?.first ?? 0)}`}</span>
              </div>
            ))}
          </div>
        )}
        table={(
          <table className="data-table compact">
            <thead><tr>
              <th scope="col" className="num">{t('proj.dash.col.rank')}</th><th scope="col">{t('proj.dash.dec.col.option')}</th>
              {OPTION_CRITERIA.map((k) => <th key={k} scope="col">{t(`proj.dash.dec.opt.${k}`)}</th>)}
              <th scope="col" className="num">{t('proj.dash.dec.col.score')}</th><th scope="col" className="num">{t('proj.dash.dec.opt.first')}</th>
              <th scope="col" className="num">{t('proj.dash.dec.opt.meanRank')}</th>
            </tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="num">{o.rank}</td><th scope="row" lang={r.lang}>{`${o.label}. ${o.title}`}</th>
                  {OPTION_CRITERIA.map((k) => <td key={k}>{o.ratings[k].value}</td>)}
                  <td className="num">{fmt.number(o.score)}</td><td className="num">{fmt.percent(acc.get(o.id)?.first ?? 0)}</td>
                  <td className="num">{fmt.number(acc.get(o.id)?.meanRank ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      />
      <details className="dec-edit" open>
        <summary>{t('proj.dash.dec.rate')}</summary>
        <div className="dec-grid" role="group" aria-label={t('proj.dash.dec.rate')}>
          {rows.map((o) => (
            <div key={o.id} className="dec-card" data-testid={`step-dash-dec-rate-${o.id}`}>
              <strong lang={r.lang}>{`${o.label}. ${o.title}`}</strong>
              <p className="dec-note">
                <strong>{t('proj.dash.dec.opt.issues')}</strong>{' '}
                {o.issues.length ? o.issues.map((id) => t('proj.dash.dec.opt.issueN', { n: issueTitle.get(id)! })).join(' · ') : <span className="muted">{t('proj.dash.dec.notStated')}</span>}
                {o.inferredIssues && <>{' '}<Badge size="small" appearance="outline" color="warning" data-testid={`step-dash-dec-opt-inferred-${o.id}`}>{t('proj.dash.dec.draft.inferred')}</Badge></>}
              </p>
              <div className="dec-ratings">
                {OPTION_CRITERIA.map((k) => (
                  <label key={k}>{t(`proj.dash.dec.opt.${k}`)} <OriginBadge origin={o.ratings[k].origin} />
                    <RatingSelect label={`${o.label} ${t(`proj.dash.dec.opt.${k}`)}`} value={o.ratings[k]} onChange={(v) => rate(o.id, k, v)} testId={`step-dash-dec-rate-${o.id}-${k}`} />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </Panel>
  );
}

/* ---------- Deliverable: requirements draft, roadmap, risks and the decision checklist ---------- */

function RequirementsDraftPanel({ r, d }: { r: DecisionReport; d: DecisionInputs }) {
  const { t, lang } = useI18n();
  const names = useTargetNames();
  const draft = useMemo(() => buildReportRequirements(r, d, lang), [r, d, lang]);
  const download = () => downloadText(
    `${names.company}-${names.project}-${t('proj.dash.dec.req.file')}.md`.replace(/[\\/:*?"<>|]/g, '_'),
    reportRequirementsMarkdown(draft), 'text/markdown',
  );
  return (
    <Panel
      title={t('proj.dash.dec.req.panel')} rationale="proj.dash.dec.req.rationale" testId="step-dash-dec-req" className="span-full"
      actions={<Button size="small" icon={<ArrowDownload20Regular />} onClick={download} data-testid="step-dash-dec-req-download">{t('proj.dash.dec.req.download')}</Button>}
    >
      <p data-testid="step-dash-dec-req-read" data-to-fill={draft.toFill} data-to-confirm={draft.toConfirm}>
        <Glyph ok={draft.toFill === 0 && draft.toConfirm === 0} />{' '}
        {t(draft.toFill || draft.toConfirm ? 'proj.dash.dec.req.readOpen' : 'proj.dash.dec.req.readDone', { sections: draft.sections.length, reqs: draft.requirements.length, open: draft.toFill, confirm: draft.toConfirm })}
      </p>
      <details className="dec-req-preview">
        <summary>{t('proj.dash.dec.req.preview')}</summary>
        {draft.sections.map((s, i) => (
          <section key={s.id} data-testid={`step-dash-dec-req-${s.id}`}>
            <h4>{`${i + 1}. ${s.title}`}</h4>
            <pre lang={r.lang}>{s.body}</pre>
          </section>
        ))}
      </details>
    </Panel>
  );
}

function RoadmapPanel({ r }: { r: DecisionReport }) {
  const { t } = useI18n();
  if (!r.roadmap.length) return null;
  const fields = ['purpose', 'actions', 'owners', 'deliverables', 'kpis'] as const;
  return (
    <Panel title={t('proj.dash.dec.road.panel')} testId="step-dash-dec-roadmap" className="span-full">
      <ol className="dec-roadmap">
        {r.roadmap.map((p) => (
          <li key={p.id} data-testid={`step-dash-dec-road-${p.id}`}>
            <strong lang={r.lang}>{p.title}</strong>
            <dl className="meta-list">
              {fields.filter((f) => p[f]).map((f) => <div key={f}><dt>{t(`proj.dash.dec.road.${f}`)}</dt><dd lang={r.lang}>{p[f]}</dd></div>)}
            </dl>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function RiskPanel({ r, d, update }: Props) {
  const { t } = useI18n();
  if (!r.risks.length) return null;
  const { cells, unrated } = riskMatrix(r, d);
  const name = new Map(r.risks.map((x, i) => [x.id, `R${i + 1}`]));
  const severe = cells.filter((c) => c.likelihood * c.impact >= 12).reduce((n, c) => n + c.ids.length, 0);
  const set = (id: string, k: 'likelihood' | 'impact', v: number | undefined) =>
    update((x) => ({ ...x, risks: { ...x.risks, [id]: { ...x.risks[id], [k]: v } } }));
  const rating = (v: number | undefined): Rated => (v === undefined ? { value: 3, origin: 'unrated' } : { value: v, origin: 'user' });
  return (
    <Panel title={t('proj.dash.dec.risk.panel')} rationale="proj.dash.dec.risk.rationale" testId="step-dash-dec-risks" className="span-full">
      <ChartFigure
        id="dec-risks"
        title={unrated.length === r.risks.length ? t('proj.dash.dec.risk.titleUnrated', { n: r.risks.length }) : t('proj.dash.dec.risk.title', { severe })}
        read={t('proj.dash.dec.risk.read', { unrated: unrated.length, total: r.risks.length })}
        visual={(
          <div className="step-chart-matrix">
            <span className="step-chart-matrix-axis is-y">{t('proj.dash.dec.risk.likelihood')}</span>
            <div className="dec-heat">
              {cells.map((c) => (
                <span key={`${c.likelihood}-${c.impact}`} className={`dec-heat-cell ${c.likelihood * c.impact >= 12 ? 'is-high' : c.likelihood * c.impact >= 6 ? 'is-mid' : 'is-low'}`} data-testid={`step-dash-dec-heat-${c.likelihood}-${c.impact}`}>
                  {c.ids.map((id) => name.get(id)).join(' ')}
                </span>
              ))}
            </div>
            <span />
            <span className="step-chart-matrix-axis">{t('proj.dash.dec.risk.impact')}</span>
          </div>
        )}
        table={(
          <table className="data-table compact">
            <thead><tr><th scope="col">{t('proj.dash.dec.col.id')}</th><th scope="col">{t('proj.dash.dec.col.risk')}</th><th scope="col">{t('proj.dash.dec.risk.likelihood')}</th><th scope="col">{t('proj.dash.dec.risk.impact')}</th></tr></thead>
            <tbody>{r.risks.map((x) => <tr key={x.id}><td>{name.get(x.id)}</td><th scope="row" lang={r.lang}>{x.name}</th><td>{d.risks[x.id]?.likelihood ?? '—'}</td><td>{d.risks[x.id]?.impact ?? '—'}</td></tr>)}</tbody>
          </table>
        )}
      />
      <div className="dec-table-wrap">
        <table className="data-table compact">
          <caption className="visually-hidden">{t('proj.dash.dec.risk.panel')}</caption>
          <thead><tr>
            <th scope="col">{t('proj.dash.dec.col.id')}</th><th scope="col">{t('proj.dash.dec.col.risk')}</th><th scope="col">{t('proj.dash.dec.risk.mitigation')}</th>
            <th scope="col">{t('proj.dash.dec.risk.likelihood')}</th><th scope="col">{t('proj.dash.dec.risk.impact')}</th>
          </tr></thead>
          <tbody>
            {r.risks.map((x) => (
              <tr key={x.id} data-testid={`step-dash-dec-risk-${x.id}`}>
                <td>{name.get(x.id)}</td>
                <th scope="row"><Quote lang={r.lang}>{x.name}</Quote>{x.description && <div className="muted"><Quote lang={r.lang}>{x.description}</Quote></div>}</th>
                <td>{x.mitigation ? <Quote lang={r.lang}>{x.mitigation}</Quote> : <><Glyph ok={false} /> {t('proj.dash.dec.notStated')}</>}</td>
                <td><RatingSelect label={`${x.name} ${t('proj.dash.dec.risk.likelihood')}`} value={rating(d.risks[x.id]?.likelihood)} onChange={(v) => set(x.id, 'likelihood', v)} testId={`step-dash-dec-risk-${x.id}-likelihood`} /></td>
                <td><RatingSelect label={`${x.name} ${t('proj.dash.dec.risk.impact')}`} value={rating(d.risks[x.id]?.impact)} onChange={(v) => set(x.id, 'impact', v)} testId={`step-dash-dec-risk-${x.id}-impact`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ChecklistPanel({ r, d, update, links }: Props & { links: ReadonlyMap<string, readonly string[]> }) {
  const { t } = useI18n();
  const auto = autoChecks(r, d, links);
  const done = auto.filter((c) => c.ok).length + MANUAL_CHECKS.filter((k) => d.checks[k]).length;
  const total = AUTO_CHECKS.length + MANUAL_CHECKS.length;
  return (
    <Panel title={t('proj.dash.dec.check.panel')} rationale="proj.dash.dec.check.rationale" testId="step-dash-dec-check" className="span-full">
      <p className="muted" data-testid="step-dash-dec-check-read">{t('proj.dash.dec.check.read', { done, total })}</p>
      <ul className="dec-checks">
        {auto.map((c) => (
          <li key={c.id} data-testid={`step-dash-dec-check-${c.id}`} data-ok={c.ok}>
            <Glyph ok={c.ok} /> {t(`proj.dash.dec.check.${c.id}`, { value: c.value, total: c.total })}
          </li>
        ))}
        {MANUAL_CHECKS.map((k) => (
          <li key={k}>
            <Checkbox checked={Boolean(d.checks[k])} label={t(`proj.dash.dec.check.${k}`)} data-testid={`step-dash-dec-check-${k}`}
              onChange={(_, data) => update((x) => ({ ...x, checks: { ...x.checks, [k]: Boolean(data.checked) } }))} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
