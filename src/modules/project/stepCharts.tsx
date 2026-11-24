import { useId, type CSSProperties, type ReactNode } from 'react';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { kpiProgress } from '../../domain/kpi.ts';
import { loc } from '../../state/text.ts';
import type { EntityOf } from '../../data/schema.ts';
import { ScrollRegion } from './common.tsx';
import { vitalCount, type CauseBar, type InitiativeRow, type IssueRow, type KpiRow, type SimRow, type SolutionRow } from './stepDashboard.ts';

/*
 * FR-318: one chart per decision of a step (Berinato's "declarative" visuals). Each chart:
 * - has an action title (the conclusion, not the topic) computed from the same data;
 * - encodes state with shape or glyph as well as colour (WCAG 1.4.1), with 3:1 non-text contrast (1.4.11, Fluent tokens);
 * - is one image for assistive technology (role="img" named by its title) with the same data as a table below it.
 */

/** Display name of an entity in the chart, or a placeholder when it is hidden for the audience. */
export type NameOf = (id: string) => string;

const OK = '✓';
const NG = '✕';
const pct = (x: number) => `${Math.max(0, Math.min(100, x * 100))}%`;

interface FigureProps {
  id: string;
  title: string;
  read: string;
  /** The visual, presented to assistive technology as one image named by the title. */
  visual: ReactNode;
  legend?: ReactNode;
  /** The same data as a table. */
  table: ReactNode;
}

export function ChartFigure({ id, title, read, visual, legend, table }: FigureProps) {
  const { t } = useI18n();
  const cap = useId();
  return (
    <figure className="step-chart" data-testid={`step-dash-chart-${id}`}>
      <figcaption id={cap} className="step-chart-title">{title}</figcaption>
      <p className="step-chart-read muted">{read}</p>
      {legend && <div className="step-chart-legend" aria-hidden="true">{legend}</div>}
      <div className="step-chart-visual" role="img" aria-labelledby={cap}>{visual}</div>
      <details className="step-chart-data" data-testid={`step-dash-chart-${id}-data`}>
        <summary>{t('proj.dash.chart.table')}</summary>
        <ScrollRegion label={title}>{table}</ScrollRegion>
      </details>
    </figure>
  );
}

export function LegendItem({ kind, label }: { kind: string; label: string }) {
  return <span className="step-chart-key"><span className={`step-chart-swatch ${kind}`} />{label}</span>;
}

export function Glyph({ ok }: { ok: boolean }) {
  return <span className={ok ? 'step-chart-ok' : 'step-chart-ng'}>{ok ? OK : NG}</span>;
}

/* ---------- 1 As-is: Pareto of root causes ---------- */

export function CauseParetoChart({ causes, nameOf }: { causes: CauseBar[]; nameOf: NameOf }) {
  const { t, fmt } = useI18n();
  if (causes.length === 0) return <p className="muted" data-testid="step-dash-chart-pareto-empty">{t('proj.dash.chart.pareto.empty')}</p>;
  const vital = vitalCount(causes);
  const max = Math.max(...causes.map((c) => c.weight), 1);
  const share = causes[vital - 1]?.cumulative ?? 0;
  return (
    <ChartFigure
      id="pareto"
      title={t('proj.dash.chart.pareto.title', { n: vital, total: causes.length, share: fmt.percent(share) })}
      read={t('proj.dash.chart.pareto.read')}
      legend={<><LegendItem kind="is-brand" label={t('proj.dash.chart.pareto.vital')} /><LegendItem kind="is-neutral" label={t('proj.dash.chart.pareto.trivial')} /></>}
      visual={(
        <div className="step-chart-rows">
          {causes.map((c, i) => (
            <div key={c.id} className={`step-chart-row${i === vital ? ' is-cut' : ''}`} data-vital={i < vital}>
              <span className="step-chart-label">{nameOf(c.id)}</span>
              <span className="step-chart-track">
                <span className={`step-chart-bar ${i < vital ? 'is-brand' : 'is-neutral'}`} style={{ width: pct(c.weight / max) }} />
              </span>
              <span className="step-chart-value">{`${fmt.number(c.weight)} · ${fmt.percent(c.cumulative)}`}</span>
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col" className="num">{t('proj.dash.col.rank')}</th>
            <th scope="col">{t('proj.dash.col.cause')}</th>
            <th scope="col" className="num">{t('proj.dash.col.weight')}</th>
            <th scope="col" className="num">{t('proj.dash.col.issues')}</th>
            <th scope="col" className="num">{t('proj.dash.col.cumulative')}</th>
            <th scope="col">{t('proj.dash.col.vital')}</th>
          </tr></thead>
          <tbody>
            {causes.map((c, i) => (
              <tr key={c.id}>
                <td className="num">{i + 1}</td>
                <th scope="row">{nameOf(c.id)}</th>
                <td className="num">{fmt.number(c.weight)}</td>
                <td className="num">{c.issues}</td>
                <td className="num">{fmt.percent(c.cumulative)}</td>
                <td><Glyph ok={i < vital} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
}

/* ---------- 1b As-is: priority matrix (impact × feasibility) ---------- */

/** Ratings on the 1–5 scale above the midpoint count as high. */
const MATRIX_MID = 3;
const QUADRANTS = ['quickWin', 'majorBet', 'fillIn', 'later'] as const;
export type Quadrant = (typeof QUADRANTS)[number];

export function quadrantOf(i: Pick<IssueRow, 'impact' | 'feasibility'>): Quadrant {
  const hi = i.impact > MATRIX_MID;
  const easy = i.feasibility > MATRIX_MID;
  return hi ? (easy ? 'quickWin' : 'majorBet') : (easy ? 'fillIn' : 'later');
}

export function PriorityMatrix({ issues, nameOf }: { issues: IssueRow[]; nameOf: NameOf }) {
  const { t, fmt } = useI18n();
  if (issues.length === 0) return <p className="muted" data-testid="step-dash-chart-matrix-empty">{t('proj.dash.chart.matrix.empty')}</p>;
  const by = (q: Quadrant) => issues.filter((i) => quadrantOf(i) === q);
  return (
    <ChartFigure
      id="matrix"
      title={t('proj.dash.chart.matrix.title', { n: by('quickWin').length, big: by('majorBet').length, total: issues.length })}
      read={t('proj.dash.chart.matrix.read')}
      visual={(
        <div className="step-chart-matrix">
          <span className="step-chart-matrix-axis is-y">{t('proj.dash.chart.matrix.impactAxis')}</span>
          <div className="step-chart-matrix-grid">
            {(['majorBet', 'quickWin', 'later', 'fillIn'] as const).map((q) => (
              <div key={q} className={`step-chart-quadrant is-${q}`} data-quadrant={q}>
                <span className="step-chart-quadrant-name">{t(`proj.dash.chart.matrix.${q}` as MessageKey)}</span>
                <ol className="step-chart-quadrant-list">
                  {by(q).map((i) => <li key={i.id} data-issue={i.id}>{t('proj.dash.chart.matrix.item', { rank: i.rank, name: nameOf(i.id) })}</li>)}
                </ol>
              </div>
            ))}
          </div>
          <span className="step-chart-matrix-axis is-x">{t('proj.dash.chart.matrix.feasibilityAxis')}</span>
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col" className="num">{t('proj.dash.col.rank')}</th>
            <th scope="col">{t('proj.dash.col.issue')}</th>
            <th scope="col" className="num">{t('proj.dash.col.impact')}</th>
            <th scope="col" className="num">{t('proj.dash.col.feasibility')}</th>
            <th scope="col" className="num">{t('proj.dash.col.score')}</th>
            <th scope="col">{t('proj.dash.col.quadrant')}</th>
          </tr></thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td className="num">{i.rank}</td>
                <th scope="row">{nameOf(i.id)}</th>
                <td className="num">{fmt.number(i.impact)}</td>
                <td className="num">{fmt.number(i.feasibility)}</td>
                <td className="num">{fmt.number(i.score)}</td>
                <td>{t(`proj.dash.chart.matrix.${quadrantOf(i)}` as MessageKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
}

/* ---------- 2 To-be: gap to target ---------- */

const GAP_MAX = 1.2;

export function GapChart({ kpis, nameOf }: { kpis: EntityOf<'kpi'>[]; nameOf: NameOf }) {
  const { t, fmt, lang } = useI18n();
  const rows = kpis.filter((k) => k.target !== k.baseline).map((k) => ({ k, p: kpiProgress(k) })).sort((a, b) => a.p - b.p || a.k.id.localeCompare(b.k.id));
  if (rows.length === 0) return <p className="muted" data-testid="step-dash-chart-gap-empty">{t('proj.dash.chart.gap.empty')}</p>;
  const avg = rows.reduce((a, r) => a + r.p, 0) / rows.length;
  const achieved = rows.filter((r) => r.p >= 1).length;
  return (
    <ChartFigure
      id="gap"
      title={t('proj.dash.chart.gap.title', { avg: fmt.percent(avg), achieved, total: rows.length, name: nameOf(rows[0]!.k.id) })}
      read={t('proj.dash.chart.gap.read')}
      legend={<><LegendItem kind="is-brand" label={t('proj.dash.chart.gap.progress')} /><LegendItem kind="is-target" label={t('proj.dash.chart.target')} /></>}
      visual={(
        <div className="step-chart-rows">
          {rows.map(({ k, p }) => (
            <div key={k.id} className="step-chart-row" data-kpi={k.id}>
              <span className="step-chart-label">{nameOf(k.id)}</span>
              <span className="step-chart-track">
                <span className={`step-chart-bar ${p >= 1 ? 'is-good' : 'is-brand'}`} style={{ width: pct(Math.max(0, p) / GAP_MAX) }} />
                <span className="step-chart-mark is-target" style={{ left: pct(1 / GAP_MAX) }} />
              </span>
              <span className="step-chart-value">{fmt.percent(p)} <Glyph ok={p >= 1} /></span>
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.dash.col.kpi')}</th>
            <th scope="col" className="num">{t('proj.dash.col.baseline')}</th>
            <th scope="col" className="num">{t('proj.dash.col.current')}</th>
            <th scope="col" className="num">{t('proj.dash.col.target')}</th>
            <th scope="col" className="num">{t('proj.dash.col.progress')}</th>
          </tr></thead>
          <tbody>
            {rows.map(({ k, p }) => {
              const unit = loc(k.unit, lang);
              return (
                <tr key={k.id}>
                  <th scope="row">{nameOf(k.id)}</th>
                  <td className="num">{fmt.number(k.baseline)} {unit}</td>
                  <td className="num">{fmt.number(k.current)} {unit}</td>
                  <td className="num">{fmt.number(k.target)} {unit}</td>
                  <td className="num">{fmt.percent(p)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    />
  );
}

/* ---------- 3 KPI: definition quality heatmap ---------- */

const QUALITY = ['valid', 'gap', 'ahead', 'inOkr'] as const;
type Quality = (typeof QUALITY)[number];
const qualityOf = (k: KpiRow): Record<Quality, boolean> => ({ valid: k.valid, gap: k.target !== k.baseline, ahead: k.ahead, inOkr: k.inOkr });

export function KpiQualityChart({ kpis }: { kpis: KpiRow[] }) {
  const { t, lang } = useI18n();
  if (kpis.length === 0) return <p className="muted" data-testid="step-dash-chart-quality-empty">{t('proj.dash.chart.quality.empty')}</p>;
  const rows = kpis.map((k) => ({ k, q: qualityOf(k) }));
  const ok = rows.filter((r) => QUALITY.every((c) => r.q[c])).length;
  const weakest = QUALITY.map((c) => ({ c, n: rows.filter((r) => !r.q[c]).length })).sort((a, b) => b.n - a.n)[0]!;
  const col = (c: Quality) => t(`proj.dash.chart.quality.${c}` as MessageKey);
  return (
    <ChartFigure
      id="quality"
      title={weakest.n === 0
        ? t('proj.dash.chart.quality.titleAll', { total: rows.length })
        : t('proj.dash.chart.quality.title', { ok, total: rows.length, check: col(weakest.c), n: weakest.n })}
      read={t('proj.dash.chart.quality.read')}
      legend={<><LegendItem kind="is-good" label={`${OK} ${t('proj.dash.ok')}`} /><LegendItem kind="is-bad" label={`${NG} ${t('proj.dash.ng')}`} /></>}
      visual={(
        <div className="step-chart-heat" style={{ '--cols': QUALITY.length } as CSSProperties}>
          <span />
          {QUALITY.map((c) => <span key={c} className="step-chart-heat-head">{col(c)}</span>)}
          {rows.map(({ k, q }) => (
            <div key={k.id} className="step-chart-heat-row" data-kpi={k.id}>
              <span className="step-chart-label">{loc(k.name, lang)}</span>
              {QUALITY.map((c) => <span key={c} className={`step-chart-cell ${q[c] ? 'is-good' : 'is-bad'}`} data-check={c} data-ok={q[c]}>{q[c] ? OK : NG}</span>)}
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.dash.col.kpi')}</th>
            {QUALITY.map((c) => <th key={c} scope="col">{col(c)}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(({ k, q }) => (
              <tr key={k.id}>
                <th scope="row">{loc(k.name, lang)}</th>
                {QUALITY.map((c) => <td key={c}><Glyph ok={q[c]} /> {t(q[c] ? 'proj.dash.ok' : 'proj.dash.ng')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
}

/* ---------- 4 Solution: P10–P90 range vs target, and the contribution bridge ---------- */

/** Lower/upper ends of a row's scale, with a little room on both sides. */
function domain(values: number[]): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
  return [lo - pad, hi + pad];
}

/** Whether \alue\ is at or past \	arget\ in the KPI's direction. */
const reached = (value: number, target: number, up: boolean) => (up ? value - target : target - value) >= 0;
const hits = (s: SimRow) => reached(s.p50, s.target, s.target >= s.current);

export function RangeChart({ sims }: { sims: SimRow[] }) {
  const { t, fmt, lang } = useI18n();
  if (sims.length === 0) return <p className="muted" data-testid="step-dash-chart-range-empty">{t('proj.dash.chart.range.empty')}</p>;
  const hit = sims.filter(hits).length;
  return (
    <ChartFigure
      id="range"
      title={t('proj.dash.chart.range.title', { hit, total: sims.length })}
      read={t('proj.dash.chart.range.read')}
      legend={(
        <>
          <LegendItem kind="is-band" label={t('proj.dash.chart.range.band')} />
          <LegendItem kind="is-median" label={t('proj.dash.col.p50')} />
          <LegendItem kind="is-current" label={t('proj.dash.col.current')} />
          <LegendItem kind="is-target" label={t('proj.dash.chart.target')} />
        </>
      )}
      visual={(
        <div className="step-chart-rows">
          {sims.map((s) => {
            const [lo, hi] = domain([s.current, s.target, s.p10, s.p90]);
            const x = (v: number) => pct((v - lo) / (hi - lo));
            const a = Math.min(s.p10, s.p90);
            const b = Math.max(s.p10, s.p90);
            return (
              <div key={s.kpiId} className="step-chart-row" data-kpi={s.kpiId} data-hit={hits(s)}>
                <span className="step-chart-label">{loc(s.name, lang)}</span>
                <span className="step-chart-track is-plain">
                  <span className="step-chart-band" style={{ left: x(a), width: `calc(${x(b)} - ${x(a)})` }} />
                  <span className="step-chart-mark is-median" style={{ left: x(s.p50) }} />
                  <span className="step-chart-dot" style={{ left: x(s.current) }} />
                  <span className="step-chart-mark is-target" style={{ left: x(s.target) }} />
                </span>
                <span className="step-chart-value">{t('proj.dash.chart.range.value', { p: fmt.percent(s.probability) })} <Glyph ok={hits(s)} /></span>
              </div>
            );
          })}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.dash.col.kpi')}</th>
            <th scope="col" className="num">{t('proj.dash.col.current')}</th>
            <th scope="col" className="num">{t('proj.dash.col.p10')}</th>
            <th scope="col" className="num">{t('proj.dash.col.p50')}</th>
            <th scope="col" className="num">{t('proj.dash.col.p90')}</th>
            <th scope="col" className="num">{t('proj.dash.col.target')}</th>
            <th scope="col" className="num">{t('proj.dash.col.probability')}</th>
          </tr></thead>
          <tbody>
            {sims.map((s) => {
              const unit = loc(s.unit, lang);
              return (
                <tr key={s.kpiId}>
                  <th scope="row">{loc(s.name, lang)}</th>
                  <td className="num">{fmt.number(s.current)} {unit}</td>
                  <td className="num">{fmt.number(s.p10)} {unit}</td>
                  <td className="num">{fmt.number(s.p50)} {unit}</td>
                  <td className="num">{fmt.number(s.p90)} {unit}</td>
                  <td className="num">{fmt.number(s.target)} {unit}</td>
                  <td className="num">{fmt.percent(s.probability)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    />
  );
}

export function BridgeChart({ sims, nameOf }: { sims: SimRow[]; nameOf: NameOf }) {
  const { t, fmt, lang } = useI18n();
  const withSteps = sims.filter((s) => s.bridge.length > 0);
  if (withSteps.length === 0) return <p className="muted" data-testid="step-dash-chart-bridge-empty">{t('proj.dash.chart.bridge.empty')}</p>;
  // The solution with the largest share of the expected gain, summed over KPIs as shares (KPIs have different units).
  const shareBy = new Map<string, number>();
  for (const s of withSteps) {
    const total = s.bridge.reduce((a, b) => a + b.expected, 0);
    if (total > 0) for (const b of s.bridge) shareBy.set(b.solutionId, (shareBy.get(b.solutionId) ?? 0) + b.expected / total / withSteps.length);
  }
  const [lead, leadShare] = [...shareBy].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['', 0];
  return (
    <ChartFigure
      id="bridge"
      title={lead ? t('proj.dash.chart.bridge.title', { name: nameOf(lead), share: fmt.percent(leadShare) }) : t('proj.dash.chart.bridge.titleNone')}
      read={t('proj.dash.chart.bridge.read')}
      legend={<><LegendItem kind="is-brand" label={t('proj.dash.chart.bridge.step')} /><LegendItem kind="is-current" label={t('proj.dash.col.current')} /><LegendItem kind="is-target" label={t('proj.dash.chart.target')} /></>}
      visual={(
        <div className="step-chart-bridges">
          {withSteps.map((s) => {
            const dir = s.expected >= s.current ? 1 : -1;
            const [lo, hi] = domain([s.current, s.expected, s.target]);
            const x = (v: number) => pct((v - lo) / (hi - lo));
            let at = s.current;
            return (
              <div key={s.kpiId} className="step-chart-bridge" data-kpi={s.kpiId}>
                <span className="step-chart-bridge-name">{loc(s.name, lang)}</span>
                <div className="step-chart-row">
                  <span className="step-chart-label">{t('proj.dash.col.current')}</span>
                  <span className="step-chart-track is-plain"><span className="step-chart-dot" style={{ left: x(s.current) }} /><span className="step-chart-mark is-target" style={{ left: x(s.target) }} /></span>
                  <span className="step-chart-value">{fmt.number(s.current)}</span>
                </div>
                {s.bridge.map((b) => {
                  const from = at;
                  at += dir * b.expected;
                  const [l, r] = from <= at ? [from, at] : [at, from];
                  return (
                    <div key={b.solutionId} className="step-chart-row" data-solution={b.solutionId}>
                      <span className="step-chart-label">{nameOf(b.solutionId)}</span>
                      <span className="step-chart-track is-plain">
                        <span className="step-chart-bar is-brand is-float" style={{ left: x(l), width: `calc(${x(r)} - ${x(l)})` }} />
                        <span className="step-chart-mark is-target" style={{ left: x(s.target) }} />
                      </span>
                      <span className="step-chart-value">{`${dir > 0 ? '+' : '−'}${fmt.number(b.expected)}`}</span>
                    </div>
                  );
                })}
                <div className="step-chart-row is-total">
                  <span className="step-chart-label">{t('proj.dash.col.expected')}</span>
                  <span className="step-chart-track is-plain"><span className="step-chart-dot is-total" style={{ left: x(s.expected) }} /><span className="step-chart-mark is-target" style={{ left: x(s.target) }} /></span>
                  <span className="step-chart-value">{fmt.number(s.expected)} <Glyph ok={reached(s.expected, s.target, dir > 0)} /></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.dash.col.kpi')}</th>
            <th scope="col">{t('proj.dash.col.solution')}</th>
            <th scope="col" className="num">{t('proj.dash.col.expectedGain')}</th>
          </tr></thead>
          <tbody>
            {withSteps.flatMap((s) => [
              ...s.bridge.map((b) => (
                <tr key={`${s.kpiId}-${b.solutionId}`}>
                  <th scope="row">{loc(s.name, lang)}</th>
                  <td>{nameOf(b.solutionId)}</td>
                  <td className="num">{fmt.number(b.expected)} {loc(s.unit, lang)}</td>
                </tr>
              )),
              <tr key={`${s.kpiId}-total`}>
                <th scope="row">{loc(s.name, lang)}</th>
                <td>{t('proj.dash.col.expected')}</td>
                <td className="num">{`${fmt.number(s.current)} → ${fmt.number(s.expected)} (${t('proj.dash.col.target')} ${fmt.number(s.target)})`} {loc(s.unit, lang)}</td>
              </tr>,
            ])}
          </tbody>
        </table>
      )}
    />
  );
}

/* ---------- 5 Deliverable: roadmap (Gantt) and payback vs the hurdle ---------- */

const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export function GanttChart({ rows, today, nameOf }: { rows: InitiativeRow[]; today: string; nameOf: NameOf }) {
  const { t, fmt } = useI18n();
  const valid = rows.filter((r) => Number.isFinite(day(r.start)) && Number.isFinite(day(r.end)));
  if (valid.length === 0) return <p className="muted" data-testid="step-dash-chart-gantt-empty">{t('proj.dash.chart.gantt.empty')}</p>;
  const sorted = [...valid].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const t0 = Math.min(...sorted.map((r) => day(r.start)), day(today));
  const t1 = Math.max(...sorted.map((r) => day(r.end)), day(today));
  const span = t1 - t0 || 1;
  const x = (v: number) => pct((v - t0) / span);
  const conflicts = sorted.filter((r) => r.conflict).length;
  const last = sorted.reduce((a, r) => (r.end > a ? r.end : a), sorted[0]!.end);
  return (
    <ChartFigure
      id="gantt"
      title={conflicts
        ? t('proj.dash.chart.gantt.title', { n: sorted.length, conflicts, end: fmt.date(last) })
        : t('proj.dash.chart.gantt.titleOk', { n: sorted.length, end: fmt.date(last) })}
      read={t('proj.dash.chart.gantt.read')}
      legend={<><LegendItem kind="is-plan" label={t('proj.dash.chart.gantt.plan')} /><LegendItem kind="is-brand" label={t('proj.dash.col.progress')} /><LegendItem kind="is-today" label={t('proj.dash.chart.today')} /></>}
      visual={(
        <div className="step-chart-rows">
          {sorted.map((r) => (
            <div key={r.id} className="step-chart-row" data-initiative={r.id} data-conflict={r.conflict}>
              <span className="step-chart-label">{nameOf(r.id)}</span>
              <span className="step-chart-track is-plain">
                <span className={`step-chart-bar is-plan is-float${r.conflict ? ' is-conflict' : ''}`} style={{ left: x(day(r.start)), width: `calc(${x(day(r.end))} - ${x(day(r.start))})` }}>
                  <span className="step-chart-fill" style={{ width: pct(r.progress) }} />
                </span>
                <span className="step-chart-mark is-today" style={{ left: x(day(today)) }} />
              </span>
              <span className="step-chart-value">{fmt.percent(r.progress)} <Glyph ok={!r.conflict} /></span>
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.dash.col.initiative')}</th>
            <th scope="col">{t('proj.dash.col.period')}</th>
            <th scope="col" className="num">{t('proj.dash.col.progress')}</th>
            <th scope="col">{t('proj.dash.col.schedule')}</th>
          </tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <th scope="row">{nameOf(r.id)}</th>
                <td>{`${fmt.date(r.start)} – ${fmt.date(r.end)}`}</td>
                <td className="num">{fmt.percent(r.progress)}</td>
                <td><Glyph ok={!r.conflict} /> {t(r.conflict ? 'proj.dash.ng' : 'proj.dash.ok')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
}

export function PaybackChart({ rows, limit, nameOf }: { rows: SolutionRow[]; limit: number; nameOf: NameOf }) {
  const { t } = useI18n();
  if (rows.length === 0) return <p className="muted" data-testid="step-dash-chart-payback-empty">{t('proj.dash.chart.payback.empty')}</p>;
  const sorted = [...rows].sort((a, b) => (a.payback ?? Infinity) - (b.payback ?? Infinity) || a.id.localeCompare(b.id));
  const finite = sorted.flatMap((r) => (r.payback !== null && Number.isFinite(r.payback) ? [r.payback] : []));
  const max = Math.max(limit * 1.5, ...finite, 1);
  const inLimit = (r: SolutionRow) => r.payback !== null && !(r.payback > limit);
  const ok = sorted.filter(inLimit).length;
  const years = (r: SolutionRow) => (r.payback === null ? '—' : Number.isFinite(r.payback) ? t('proj.dash.years', { n: r.payback.toFixed(1) }) : t('proj.dash.never'));
  return (
    <ChartFigure
      id="payback"
      title={t('proj.dash.chart.payback.title', { ok, total: sorted.length, max: limit })}
      read={t('proj.dash.chart.payback.read')}
      legend={<><LegendItem kind="is-good" label={t('proj.dash.chart.payback.within')} /><LegendItem kind="is-bad" label={t('proj.dash.chart.payback.over')} /><LegendItem kind="is-target" label={t('proj.dash.chart.payback.hurdle')} /></>}
      visual={(
        <div className="step-chart-rows">
          {sorted.map((r) => {
            const within = inLimit(r);
            return (
              <div key={r.id} className="step-chart-row" data-solution={r.id} data-ok={within}>
                <span className="step-chart-label">{nameOf(r.id)}</span>
                <span className="step-chart-track">
                  {r.payback !== null && Number.isFinite(r.payback) && <span className={`step-chart-bar ${within ? 'is-good' : 'is-bad'}`} style={{ width: pct(r.payback / max) }} />}
                  <span className="step-chart-mark is-target" style={{ left: pct(limit / max) }} />
                </span>
                <span className="step-chart-value">{years(r)} <Glyph ok={within} /></span>
              </div>
            );
          })}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('proj.dash.col.solution')}</th>
            <th scope="col" className="num">{t('proj.dash.col.payback')}</th>
            <th scope="col">{t('proj.dash.chart.payback.hurdle')}</th>
          </tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <th scope="row">{nameOf(r.id)}</th>
                <td className="num">{years(r)}</td>
                <td><Glyph ok={inLimit(r)} /> {t(inLimit(r) ? 'proj.dash.ok' : 'proj.dash.ng')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
}
