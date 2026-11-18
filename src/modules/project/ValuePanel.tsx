import { useCallback, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Select, Slider } from '@fluentui/react-components';
import { Add20Regular, ArrowDownload20Regular, ArrowReset20Regular, Checkmark20Regular, Delete20Regular, Dismiss20Regular, Edit20Regular, Save20Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { downloadText, ScrollRegion, useTargetNames } from './common.tsx';
import type { AppCheckContext } from './deliverables.ts';
import { newId } from './model.ts';
import { EVIDENCE_BASES, validRange, type EvidenceBasis } from './simulate.ts';
import { ChartFigure, Glyph, LegendItem, type NameOf } from './stepCharts.tsx';
import { useProjUi, useValueModel } from './stores.ts';
import { valueEngine, type EngineResult } from './valueEngine.ts';
import { valueHtml } from './valueHtml.ts';
import { DraftBar, DraftReview, GroupsSection, RealizationSection } from './ValueResolve.tsx';
import { ExplainSection } from './ValueExplain.tsx';
import {
  buildValueModel, coverage, COVERAGE_COLUMNS, realizationOf, dismissSuggestion, HORIZON_RANGE, implicitLineId, LEVERS, LINK_KINDS, linkKey, NATURES, normalizeValue, RATE_RANGE,
  removeBenefit, removeLink, setSettings, suggestLinks, toggleReviewed, upsertBenefit, upsertLink, valueChecks,
  type BenefitLine, type BuiltValueModel, type CoverageColumn, type Lever, type LinkKind, type LinkSuggestion, type Nature, type ValueData, type ValueSolution,
} from './valueModel.ts';
import './value.css';

/*
 * FR-327: what the solutions are worth to the business, through which value driver, how certain, and how they depend on
 * each other. Every number comes from the project (people's estimates with their evidence) or a labelled PARAM default.
 */

const MILLION = 1_000_000;
const IMPLICIT = implicitLineId('');
const DRIVER_ORDER = ['investment', 'revenue', 'cost', 'capital', 'risk', 'option', 'unclassified', 'disbenefit'] as const;
type RangeForm = { low: string; mode: string; high: string };
type Scale = (v: number) => string;

const by = () => useProjUi.getState().editor.trim();
const clampPct = (x: number) => `${Math.max(0, Math.min(100, x * 100))}%`;
const domainOf = (values: number[]): [number, number] => {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  return hi > lo ? [lo, hi] : [lo - 1, hi + 1];
};
const scaleOf = (lo: number, hi: number): Scale => (v) => clampPct((v - lo) / (hi - lo));
const text = (v: Localizable, lang: 'ja' | 'en') => loc(v, lang);

function useValueWriter() {
  const set = useValueModel((s) => s.set);
  return useCallback((fn: (d: ValueData) => ValueData) => set((prev) => fn(normalizeValue(prev))), [set]);
}

/** Floating bar between two values on a shared scale. */
function Span({ from, to, x, kind }: { from: number; to: number; x: Scale; kind: string }) {
  const [l, r] = from <= to ? [from, to] : [to, from];
  return <span className={`step-chart-bar is-float ${kind}`} style={{ left: x(l), width: `calc(${x(r)} - ${x(l)})` }} />;
}

/* ---------- Charts ---------- */

function DriverBridge({ r }: { r: EngineResult }) {
  const { t, fmt } = useI18n();
  const drivers = DRIVER_ORDER.filter((k) => r.levers[k] !== undefined && Math.abs(r.levers[k]!) > 0);
  if (drivers.length === 0) return <p className="muted">{t('val.noSelection')}</p>;
  let at = 0;
  const steps = drivers.map((k) => {
    const from = at;
    at += r.levers[k]!;
    return { k, from, to: at };
  });
  const [lo, hi] = domainOf(steps.flatMap((s) => [s.from, s.to]));
  const x = scaleOf(lo, hi);
  const gains = drivers.filter((k) => k !== 'investment' && k !== 'disbenefit' && r.levers[k]! > 0);
  const gross = gains.reduce((a, k) => a + r.levers[k]!, 0);
  const top = [...gains].sort((a, b) => r.levers[b]! - r.levers[a]!)[0];
  return (
    <ChartFigure
      id="val-bridge"
      title={top ? t('val.bridge.title', { npv: fmt.yenCompact(r.npv.mode), driver: t(`val.driver.${top}` as MessageKey), share: fmt.percent(r.levers[top]! / gross) }) : t('val.bridge.titleNone', { npv: fmt.yenCompact(r.npv.mode) })}
      read={t('val.bridge.read')}
      legend={<><LegendItem kind="is-brand" label={t('val.bridge.gain')} /><LegendItem kind="is-bad" label={t('val.bridge.loss')} /><LegendItem kind="is-target" label={t('val.zero')} /></>}
      visual={(
        <div className="step-chart-rows">
          {steps.map((s) => (
            <div key={s.k} className="step-chart-row" data-driver={s.k}>
              <span className="step-chart-label">{t(`val.driver.${s.k}` as MessageKey)}</span>
              <span className="step-chart-track is-plain">
                <Span from={s.from} to={s.to} x={x} kind={s.to >= s.from ? 'is-brand' : 'is-bad val-hatch'} />
                <span className="step-chart-mark is-target" style={{ left: x(0) }} />
              </span>
              <span className="step-chart-value">{fmt.yenCompact(r.levers[s.k]!)}</span>
            </div>
          ))}
          <div className="step-chart-row is-total" data-driver="npv">
            <span className="step-chart-label">{t('val.npvMode')}</span>
            <span className="step-chart-track is-plain">
              <Span from={0} to={r.npv.mode} x={x} kind={r.npv.mode >= 0 ? 'is-good' : 'is-bad val-hatch'} />
              <span className="step-chart-mark is-target" style={{ left: x(0) }} />
            </span>
            <span className="step-chart-value">{fmt.yenCompact(r.npv.mode)} <Glyph ok={r.npv.mode >= 0} /></span>
          </div>
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr><th scope="col">{t('val.col.driver')}</th><th scope="col" className="num">{t('val.col.pv')}</th></tr></thead>
          <tbody>
            {drivers.map((k) => <tr key={k}><th scope="row">{t(`val.driver.${k}` as MessageKey)}</th><td className="num">{fmt.yen(r.levers[k]!)}</td></tr>)}
            <tr><th scope="row">{t('val.npvMode')}</th><td className="num">{fmt.yen(r.npv.mode)}</td></tr>
          </tbody>
        </table>
      )}
    />
  );
}

function Distribution({ r }: { r: EngineResult }) {
  const { t, fmt } = useI18n();
  const w = (r.hist.hi - r.hist.lo) / r.hist.counts.length;
  const max = Math.max(1, ...r.hist.counts);
  const bins = r.hist.counts.map((c, i) => ({ c, from: r.hist.lo + w * i, to: r.hist.lo + w * (i + 1) }));
  return (
    <ChartFigure
      id="val-dist"
      title={t('val.dist.title', { p: fmt.percent(r.npv.pPositive), p10: fmt.yenCompact(r.npv.p10), p90: fmt.yenCompact(r.npv.p90) })}
      read={t('val.dist.read', { runs: fmt.number(r.runs) })}
      legend={<><LegendItem kind="is-brand" label={t('val.dist.positive')} /><LegendItem kind="is-bad" label={t('val.dist.negative')} /></>}
      visual={(
        <div className="val-hist">
          {bins.map((b, i) => (
            <span key={i} className={`val-hist-bar ${b.to <= 0 ? 'is-bad val-hatch' : 'is-brand'}`} style={{ height: clampPct(b.c / max) }} />
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr><th scope="col">{t('val.col.bin')}</th><th scope="col" className="num">{t('val.col.runs')}</th></tr></thead>
          <tbody>{bins.map((b, i) => <tr key={i}><th scope="row">{`${fmt.yenCompact(b.from)} – ${fmt.yenCompact(b.to)}`}</th><td className="num">{b.c}</td></tr>)}</tbody>
        </table>
      )}
    />
  );
}

function Tornado({ r, label }: { r: EngineResult; label: (id: string, kind: string, ref: string) => string }) {
  const { t, fmt } = useI18n();
  if (r.tornado.length === 0) return <p className="muted" data-testid="val-tornado-empty">{t('val.tornado.empty')}</p>;
  const [lo, hi] = domainOf([r.npv.mode, ...r.tornado.flatMap((b) => [b.atLow, b.atHigh])]);
  const x = scaleOf(lo, hi);
  const first = r.tornado[0]!;
  return (
    <ChartFigure
      id="val-tornado"
      title={t('val.tornado.title', { name: label(first.id, first.kind, first.ref), swing: fmt.yenCompact(first.swing) })}
      read={t('val.tornado.read')}
      legend={<><LegendItem kind="is-band" label={t('val.tornado.range')} /><LegendItem kind="is-median" label={t('val.npvMode')} /><LegendItem kind="is-target" label={t('val.zero')} /></>}
      visual={(
        <div className="step-chart-rows">
          {r.tornado.map((b) => (
            <div key={b.id} className="step-chart-row" data-input={b.id}>
              <span className="step-chart-label">{label(b.id, b.kind, b.ref)}</span>
              <span className="step-chart-track is-plain">
                <span className="step-chart-band" style={{ left: x(Math.min(b.atLow, b.atHigh)), width: `calc(${x(Math.max(b.atLow, b.atHigh))} - ${x(Math.min(b.atLow, b.atHigh))})` }} />
                <span className="step-chart-mark is-median" style={{ left: x(r.npv.mode) }} />
                <span className="step-chart-mark is-target" style={{ left: x(0) }} />
              </span>
              <span className="step-chart-value">{fmt.yenCompact(b.swing)}</span>
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr><th scope="col">{t('val.col.input')}</th><th scope="col" className="num">{t('val.col.atLow')}</th><th scope="col" className="num">{t('val.col.atHigh')}</th><th scope="col" className="num">{t('val.col.swing')}</th></tr></thead>
          <tbody>{r.tornado.map((b) => <tr key={b.id}><th scope="row">{label(b.id, b.kind, b.ref)}</th><td className="num">{fmt.yen(b.atLow)}</td><td className="num">{fmt.yen(b.atHigh)}</td><td className="num">{fmt.yen(b.swing)}</td></tr>)}</tbody>
        </table>
      )}
    />
  );
}

/** A solution's standalone value against its marginal value in the portfolio: the gap is the interdependencies. */
function StandaloneMarginal({ r, nameOf, cost }: { r: EngineResult; nameOf: NameOf; cost: (id: string) => number }) {
  const { t, fmt } = useI18n();
  const rows = r.solutions;
  const differs = (s: EngineResult['solutions'][number]) => Math.abs(s.marginal - s.standalone) > Math.max(1, cost(s.id) * 0.005);
  const n = rows.filter(differs).length;
  const [lo, hi] = domainOf(rows.flatMap((s) => [s.standalone, s.marginal]));
  const x = scaleOf(lo, hi);
  return (
    <ChartFigure
      id="val-marginal"
      title={n ? t('val.marginal.title', { n, total: rows.length }) : t('val.marginal.titleNone')}
      read={t('val.marginal.read')}
      legend={<><LegendItem kind="is-current" label={t('val.col.standalone')} /><LegendItem kind="is-total" label={t('val.col.marginal')} /><LegendItem kind="is-target" label={t('val.zero')} /></>}
      visual={(
        <div className="step-chart-rows">
          {rows.map((s) => (
            <div key={s.id} className="step-chart-row" data-solution={s.id} data-differs={differs(s)} data-selected={s.selected}>
              <span className="step-chart-label">{nameOf(s.id)}{s.selected ? '' : ` (${t('val.excluded')})`}</span>
              <span className="step-chart-track is-plain">
                <Span from={s.standalone} to={s.marginal} x={x} kind="is-neutral val-link" />
                <span className="step-chart-mark is-target" style={{ left: x(0) }} />
                <span className="step-chart-dot" style={{ left: x(s.standalone) }} />
                <span className="step-chart-dot is-total" style={{ left: x(s.marginal) }} />
              </span>
              <span className="step-chart-value">{fmt.yenCompact(s.marginal)} <Glyph ok={s.marginal >= 0} /></span>
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr><th scope="col">{t('val.col.solution')}</th><th scope="col">{t('val.col.inPortfolio')}</th><th scope="col" className="num">{t('val.col.standalone')}</th><th scope="col" className="num">{t('val.col.marginal')}</th></tr></thead>
          <tbody>{rows.map((s) => <tr key={s.id}><th scope="row">{nameOf(s.id)}</th><td><Glyph ok={s.selected} /></td><td className="num">{fmt.yen(s.standalone)}</td><td className="num">{fmt.yen(s.marginal)}</td></tr>)}</tbody>
        </table>
      )}
    />
  );
}

/* ---------- Effects nobody has examined ---------- */

function CoverageMatrix({ data, built, nameOf, onAdd }: { data: ValueData; built: BuiltValueModel; nameOf: NameOf; onAdd: (solutionId: string, column: CoverageColumn) => void }) {
  const { t } = useI18n();
  const write = useValueWriter();
  const cells = coverage(data, built.solutions);
  const [focus, setFocus] = useState<{ solutionId: string; column: CoverageColumn } | null>(null);
  const open = cells.filter((c) => c.state === 'open').length;
  const sol = focus ? built.solutions.find((s) => s.id === focus.solutionId) : undefined;
  const focusCell = focus ? cells.find((c) => c.solutionId === focus.solutionId && c.column === focus.column) : undefined;
  return (
    <section className="val-section" aria-labelledby="val-coverage-title" data-testid="val-coverage">
      <h3 id="val-coverage-title" className="step-chart-title">{open ? t('val.coverage.title', { n: open, total: cells.length }) : t('val.coverage.titleDone')}</h3>
      <p className="step-chart-read muted">{t('val.coverage.read')}</p>
      <ScrollRegion label={t('val.coverage.table')}>
        <table className="data-table compact val-matrix">
          <thead><tr>
            <th scope="col">{t('val.col.solution')}</th>
            {COVERAGE_COLUMNS.map((c) => <th key={c} scope="col">{t(`val.column.${c}` as MessageKey)}</th>)}
          </tr></thead>
          <tbody>
            {built.solutions.map((s) => (
              <tr key={s.id}>
                <th scope="row">{nameOf(s.id)} <span className="muted">{t(`sol.type.${s.type}` as MessageKey)}</span></th>
                {COVERAGE_COLUMNS.map((c) => {
                  const cell = cells.find((x) => x.solutionId === s.id && x.column === c)!;
                  const active = focus?.solutionId === s.id && focus.column === c;
                  return (
                    <td key={c} className={`val-cell is-${cell.state}`} data-state={cell.state}>
                      <Button
                        size="small" appearance={active ? 'primary' : 'subtle'} aria-pressed={active}
                        onClick={() => setFocus(active ? null : { solutionId: s.id, column: c })}
                        data-testid={`val-cell-${s.id}-${c}`}
                      >
                        {t(`val.cell.${cell.state}` as MessageKey)}{cell.lines > 1 ? ` ×${cell.lines}` : ''}
                      </Button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {focus && sol && focusCell && (
        <div className="val-hint" role="region" aria-label={t('val.hint.region')} data-testid="val-hint">
          <p><strong>{nameOf(sol.id)}</strong>{' · '}{t(`val.column.${focus.column}` as MessageKey)}</p>
          <p>{t(`val.hint.${focus.column}.${sol.type}` as MessageKey)}</p>
          <div className="proj-row">
            <Button icon={<Add20Regular />} onClick={() => onAdd(sol.id, focus.column)} data-testid="val-hint-add">{t('val.hint.add')}</Button>
            {focusCell.lines === 0 && (
              <Button icon={focusCell.state === 'reviewed' ? <ArrowReset20Regular /> : <Checkmark20Regular />} onClick={() => write((d) => toggleReviewed(d, `${sol.id}:${focus.column}`))} data-testid="val-hint-reviewed">
                {t(focusCell.state === 'reviewed' ? 'val.hint.reopen' : 'val.hint.reviewed')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------- Benefit lines ---------- */

interface LineForm {
  id: string | null;
  solutionId: string;
  label: string;
  lever: Lever;
  nature: Nature;
  timing: 'annual' | 'oneOff';
  sign: 'benefit' | 'disbenefit';
  amount: RangeForm;
  conversion: RangeForm;
  kpiId: string;
  owner: string;
  basis: EvidenceBasis;
  evidence: string;
}

const emptyRange = (): RangeForm => ({ low: '', mode: '', high: '' });
const toRange = (r: RangeForm, unit: number) => ({ low: Number(r.low) * unit, mode: Number(r.mode) * unit, high: Number(r.high) * unit });
const fromRange = (r: { low: number; mode: number; high: number }, unit: number): RangeForm => ({ low: String(r.low / unit), mode: String(r.mode / unit), high: String(r.high / unit) });
const filled = (r: RangeForm) => [r.low, r.mode, r.high].every((v) => v.trim() !== '' && Number.isFinite(Number(v)));
const amountOk = (r: RangeForm) => filled(r) && validRange(toRange(r, 1)) && Number(r.low) >= 0;
const shareOk = (r: RangeForm) => filled(r) && validRange(toRange(r, 1)) && Number(r.low) >= 0 && Number(r.high) <= 100;

function RangeInputs({ legend, value, onChange, ok, testId }: { legend: string; value: RangeForm; onChange: (r: RangeForm) => void; ok: boolean; testId: string }) {
  const { t } = useI18n();
  const touched = [value.low, value.mode, value.high].some((v) => v.trim() !== '');
  const bad = touched && !ok;
  return (
    <fieldset className="sol-range">
      <legend>{legend}</legend>
      {(['low', 'mode', 'high'] as const).map((k) => (
        <Field key={k} label={t(`sol.c.${k}`)} validationState={bad ? 'error' : 'none'}>
          <Input type="number" value={value[k]} onChange={(_, d) => onChange({ ...value, [k]: d.value })} data-testid={`${testId}-${k}`} />
        </Field>
      ))}
      {bad && <p className="proj-error" role="alert">{t('val.form.invalidRange')}</p>}
    </fieldset>
  );
}

function LineEditor({ form, setForm, ctx, solutions, nameOf, onDone }: {
  form: LineForm; setForm: (f: LineForm) => void; ctx: AppCheckContext; solutions: ValueSolution[]; nameOf: NameOf; onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const write = useValueWriter();
  const money = form.nature === 'financial';
  const ok = form.solutionId && form.label.trim() && (!money || (amountOk(form.amount) && shareOk(form.conversion)));
  const save = () => {
    if (!ok) return;
    const line: BenefitLine = {
      id: form.id ?? newId('val'), solutionId: form.solutionId, label: form.label.trim(), lever: form.lever, nature: form.nature, timing: form.timing, sign: form.sign,
      ...(money ? { amountJpy: toRange(form.amount, MILLION) } : {}),
      conversion: money ? toRange(form.conversion, 0.01) : { low: 1, mode: 1, high: 1 },
      ...(form.kpiId ? { kpiId: form.kpiId } : {}),
      owner: form.owner.trim(), basis: form.basis, evidence: form.evidence.trim(),
    };
    write((d) => upsertBenefit(d, line));
    onDone();
  };
  return (
    <form className="val-form" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={t(form.id ? 'val.form.edit' : 'val.form.add')} data-testid="val-form">
      <div className="proj-kpi-fields">
        <Field label={t('val.col.solution')}>
          <Select value={form.solutionId} onChange={(_, d) => setForm({ ...form, solutionId: d.value })} data-testid="val-f-solution">
            {solutions.map((s) => <option key={s.id} value={s.id}>{nameOf(s.id)}</option>)}
          </Select>
        </Field>
        <Field label={t('val.form.label')} hint={t('val.form.labelHint')} required>
          <Input value={form.label} onChange={(_, d) => setForm({ ...form, label: d.value })} data-testid="val-f-label" />
        </Field>
        <Field label={t('val.form.sign')}>
          <Select value={form.sign} onChange={(_, d) => setForm({ ...form, sign: d.value as LineForm['sign'] })} data-testid="val-f-sign">
            <option value="benefit">{t('val.sign.benefit')}</option>
            <option value="disbenefit">{t('val.sign.disbenefit')}</option>
          </Select>
        </Field>
        <Field label={t('val.col.driver')}>
          <Select value={form.lever} onChange={(_, d) => setForm({ ...form, lever: d.value as Lever })} data-testid="val-f-lever">
            {LEVERS.map((l) => <option key={l} value={l}>{t(`val.driver.${l}` as MessageKey)}</option>)}
          </Select>
        </Field>
        <Field label={t('val.form.nature')} hint={t(`val.nature.${form.nature}.hint` as MessageKey)}>
          <Select value={form.nature} onChange={(_, d) => setForm({ ...form, nature: d.value as Nature })} data-testid="val-f-nature">
            {NATURES.map((n) => <option key={n} value={n}>{t(`val.nature.${n}` as MessageKey)}</option>)}
          </Select>
        </Field>
        {money && (
          <Field label={t('val.form.timing')}>
            <Select value={form.timing} onChange={(_, d) => setForm({ ...form, timing: d.value as LineForm['timing'] })} data-testid="val-f-timing">
              <option value="annual">{t('val.timing.annual')}</option>
              <option value="oneOff">{t('val.timing.oneOff')}</option>
            </Select>
          </Field>
        )}
      </div>
      {money && (
        <>
          <RangeInputs legend={t(form.timing === 'oneOff' ? 'val.form.amountOnce' : 'val.form.amount')} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} ok={amountOk(form.amount)} testId="val-f-amount" />
          <RangeInputs legend={t('val.form.conversion')} value={form.conversion} onChange={(conversion) => setForm({ ...form, conversion })} ok={shareOk(form.conversion)} testId="val-f-conv" />
          <p className="muted">{t('val.form.conversionHint')}</p>
        </>
      )}
      <div className="proj-kpi-fields">
        <Field label={t('val.form.kpi')} hint={t('val.form.kpiHint')}>
          <Select value={form.kpiId} onChange={(_, d) => setForm({ ...form, kpiId: d.value })} data-testid="val-f-kpi">
            <option value="">{t('val.form.noKpi')}</option>
            {ctx.kpi.kpis.map((k) => <option key={k.id} value={k.id}>{loc(k.name, lang)}</option>)}
          </Select>
        </Field>
        <Field label={t('val.form.owner')} hint={t('val.form.ownerHint')}>
          <Input value={form.owner} onChange={(_, d) => setForm({ ...form, owner: d.value })} data-testid="val-f-owner" />
        </Field>
        <Field label={t('sol.c.basis')}>
          <Select value={form.basis} onChange={(_, d) => setForm({ ...form, basis: d.value as EvidenceBasis })} data-testid="val-f-basis">
            {EVIDENCE_BASES.map((b) => <option key={b} value={b}>{t(`sol.c.basis.${b}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('sol.c.evidence')}>
          <Input value={form.evidence} onChange={(_, d) => setForm({ ...form, evidence: d.value })} data-testid="val-f-evidence" />
        </Field>
      </div>
      <div className="proj-row">
        <Button type="submit" appearance="primary" icon={<Save20Regular />} disabled={!ok} data-testid="val-f-save">{t('proj.save')}</Button>
        <Button onClick={onDone}>{t('proj.cancel')}</Button>
      </div>
    </form>
  );
}

function LinesTable({ data, built, nameOf, kpiName, onEdit }: { data: ValueData; built: BuiltValueModel; nameOf: NameOf; kpiName: (id: string) => string | null; onEdit: (line: BenefitLine) => void }) {
  const { t, lang, fmt } = useI18n();
  const write = useValueWriter();
  const ids = new Set(built.solutions.map((s) => s.id));
  const lines = data.benefits.filter((b) => ids.has(b.solutionId));
  const range = (r: { low: number; mode: number; high: number }, f: (v: number) => string) => [r.low, r.mode, r.high].map(f).join(' – ');
  if (lines.length === 0) return <p className="muted">{t('val.lines.none')}</p>;
  return (
    <ScrollRegion label={t('val.lines.title')}>
      <table className="data-table compact val-lines-table" data-testid="val-lines">
        <thead><tr>
          <th scope="col">{t('val.form.label')}</th>
          <th scope="col">{t('val.col.solution')}</th>
          <th scope="col">{t('val.col.driver')}</th>
          <th scope="col">{t('val.form.nature')}</th>
          <th scope="col" className="num">{t('val.col.amount')}</th>
          <th scope="col" className="num">{t('val.form.conversion')}</th>
          <th scope="col">{t('val.form.kpi')}</th>
          <th scope="col">{t('val.form.owner')}</th>
          <th scope="col">{t('sol.c.basis')}</th>
          <th scope="col">{t('val.col.actions')}</th>
        </tr></thead>
        <tbody>
          {lines.map((b) => {
            const kpi = b.kpiId ? kpiName(b.kpiId) : null;
            return (
              <tr key={b.id} data-line={b.id} data-sign={b.sign}>
                <th scope="row">{text(b.label, lang)}{b.sign === 'disbenefit' && <> <Badge size="small" appearance="outline" color="danger">{t('val.sign.disbenefit')}</Badge></>}</th>
                <td>{nameOf(b.solutionId)}</td>
                <td>{t(`val.driver.${b.lever}` as MessageKey)}</td>
                <td>{t(`val.nature.${b.nature}` as MessageKey)}</td>
                <td className="num">{b.amountJpy ? `${range(b.amountJpy, fmt.yenCompact)}${b.timing === 'oneOff' ? ` ${t('val.timing.oneOffShort')}` : ''}` : '–'}</td>
                <td className="num">{b.nature === 'financial' ? range(b.conversion, fmt.percent) : '–'}</td>
                <td>{kpi ?? <Badge size="small" appearance="outline" color="warning">{t('val.form.noKpi')}</Badge>}</td>
                <td>{text(b.owner, lang) || <Badge size="small" appearance="outline" color="warning">{t('val.lines.noOwner')}</Badge>}</td>
                <td><Badge size="small" appearance="outline" color={b.basis === 'assumption' ? 'warning' : 'informative'}>{t(`sol.c.basis.${b.basis}`)}</Badge></td>
                <td>
                  <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => onEdit(b)} aria-label={t('val.lines.edit', { name: text(b.label, lang) })} data-testid={`val-line-edit-${b.id}`} />
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => write((d) => removeBenefit(d, b.id))} aria-label={t('val.lines.remove', { name: text(b.label, lang) })} data-testid={`val-line-remove-${b.id}`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/* ---------- Interdependencies ---------- */

function Links({ data, built, suggestions, nameOf }: { data: ValueData; built: BuiltValueModel; suggestions: LinkSuggestion[]; nameOf: NameOf }) {
  const { t, fmt } = useI18n();
  const write = useValueWriter();
  const ids = new Set(built.solutions.map((s) => s.id));
  const links = data.links.filter((k) => ids.has(k.from) && ids.has(k.to));
  const [draft, setDraft] = useState<{ kind: LinkKind; from: string; to: string; share: string; note: string; key?: string } | null>(null);
  const shareNeeded = draft ? draft.kind !== 'enables' : false;
  const shareValue = draft ? Number(draft.share) / 100 : 0;
  const ok = draft && draft.from && draft.to && draft.from !== draft.to && (!shareNeeded || (draft.share.trim() !== '' && shareValue >= 0 && shareValue <= 1));
  const confirm = () => {
    if (!draft || !ok) return;
    write((d) => upsertLink(d, { id: newId('vlk'), kind: draft.kind, from: draft.from, to: draft.to, share: shareNeeded ? shareValue : 0, note: draft.note.trim(), at: new Date().toISOString(), by: by() }));
    setDraft(null);
  };
  const first = built.solutions[0]?.id ?? '';
  const second = built.solutions[1]?.id ?? first;
  const reason = (s: LinkSuggestion) => t(`val.link.reason.${s.reason}` as MessageKey, { detail: s.detail.map(nameOf).join(', ') });
  return (
    <section className="val-section" aria-labelledby="val-links-title" data-testid="val-links">
      <h3 id="val-links-title" className="step-chart-title">{t('val.links.title', { n: links.length, s: suggestions.length })}</h3>
      <p className="step-chart-read muted">{t('val.links.read')}</p>
      {suggestions.length > 0 && (
        <ul className="val-list" aria-label={t('val.links.suggested')}>
          {suggestions.map((s) => (
            <li key={s.key} data-testid={`val-suggest-${s.key}`}>
              <Badge appearance="outline" color="informative">{t(`val.link.kind.${s.kind}` as MessageKey)}</Badge>{' '}
              <span>{t('val.link.pair', { from: nameOf(s.from), to: nameOf(s.to) })}</span>{' '}
              <span className="muted">{reason(s)}</span>{' '}
              <Button size="small" icon={<Checkmark20Regular />} onClick={() => setDraft({ kind: s.kind, from: s.from, to: s.to, share: '', note: reason(s), key: s.key })} data-testid={`val-suggest-confirm-${s.key}`}>{t('val.links.confirm')}</Button>{' '}
              <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => write((d) => dismissSuggestion(d, s.key))} data-testid={`val-suggest-dismiss-${s.key}`}>{t('val.links.dismiss')}</Button>
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <ul className="val-list" aria-label={t('val.links.confirmed')}>
          {links.map((k) => (
            <li key={k.id} data-testid={`val-link-${linkKey(k.kind, k.from, k.to)}`}>
              <Badge appearance="filled" color="brand">{t(`val.link.kind.${k.kind}` as MessageKey)}</Badge>{' '}
              <span>{t('val.link.pair', { from: nameOf(k.from), to: nameOf(k.to) })}</span>{' '}
              {k.kind !== 'enables' && <span>{t(`val.link.effect.${k.kind}` as MessageKey, { share: fmt.percent(k.share) })}</span>}{' '}
              {k.note && <span className="muted">{k.note}</span>}{' '}
              <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => write((d) => removeLink(d, k.id))} aria-label={t('val.links.remove')} />
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <form className="val-form" onSubmit={(e) => { e.preventDefault(); confirm(); }} aria-label={t('val.links.form')} data-testid="val-link-form">
          <div className="proj-kpi-fields">
            <Field label={t('val.links.kind')} hint={t(`val.link.kindHint.${draft.kind}` as MessageKey)}>
              <Select value={draft.kind} onChange={(_, d) => setDraft({ ...draft, kind: d.value as LinkKind })} data-testid="val-l-kind">
                {LINK_KINDS.map((k) => <option key={k} value={k}>{t(`val.link.kind.${k}` as MessageKey)}</option>)}
              </Select>
            </Field>
            <Field label={t('val.links.from')}>
              <Select value={draft.from} onChange={(_, d) => setDraft({ ...draft, from: d.value })} data-testid="val-l-from">
                {built.solutions.map((s) => <option key={s.id} value={s.id}>{nameOf(s.id)}</option>)}
              </Select>
            </Field>
            <Field label={t('val.links.to')}>
              <Select value={draft.to} onChange={(_, d) => setDraft({ ...draft, to: d.value })} data-testid="val-l-to">
                {built.solutions.map((s) => <option key={s.id} value={s.id}>{nameOf(s.id)}</option>)}
              </Select>
            </Field>
            {shareNeeded && (
              <Field label={t(`val.link.shareLabel.${draft.kind}` as MessageKey)} hint={t('val.links.shareHint')} required validationState={draft.share.trim() !== '' && !ok ? 'error' : 'none'}>
                <Input type="number" min={0} max={100} value={draft.share} onChange={(_, d) => setDraft({ ...draft, share: d.value })} data-testid="val-l-share" />
              </Field>
            )}
            <Field label={t('val.links.note')}>
              <Input value={draft.note} onChange={(_, d) => setDraft({ ...draft, note: d.value })} data-testid="val-l-note" />
            </Field>
          </div>
          {draft.from === draft.to && <p className="proj-error" role="alert">{t('val.links.same')}</p>}
          <div className="proj-row">
            <Button type="submit" appearance="primary" disabled={!ok} data-testid="val-l-save">{t('val.links.save')}</Button>
            <Button onClick={() => setDraft(null)}>{t('proj.cancel')}</Button>
          </div>
        </form>
      ) : (
        built.solutions.length > 1 && <Button icon={<Add20Regular />} onClick={() => setDraft({ kind: 'enables', from: first, to: second, share: '', note: '' })} data-testid="val-link-add">{t('val.links.add')}</Button>
      )}
    </section>
  );
}

/* ---------- The panel ---------- */

export function ValueModelPanel({ ctx, nameOf }: { ctx: AppCheckContext; nameOf: NameOf }) {
  const { t, lang, fmt } = useI18n();
  const raw = useValueModel((s) => s.value);
  const data = useMemo(() => normalizeValue(raw), [raw]);
  const audience = useSettings((s) => s.audience);
  const write = useValueWriter();
  const names = useTargetNames();
  const visible = useCallback((id: string) => {
    const e = ctx.pack.byId.get(id);
    return !e || !isHidden(e, audience);
  }, [ctx, audience]);
  // What-if state: explored here, saved to the project only on request.
  const [whatIf, setWhatIf] = useState<{ selected?: string[]; rate?: number; horizon?: number; rho?: number; applyReal?: boolean }>({});
  const whatIfRho = whatIf.rho;
  const built = useMemo(() => buildValueModel(ctx.pack, ctx.strategy, whatIfRho === undefined ? data : setSettings(data, { adoptionRho: whatIfRho }), visible), [ctx, data, visible, whatIfRho]);
  const selected = whatIf.selected ?? built.model.selected;
  const rate = whatIf.rate ?? data.settings.discountRate;
  const horizon = whatIf.horizon ?? data.settings.horizonYears;
  const rho = whatIfRho ?? data.settings.adoptionRho;
  const kpiFacts = useMemo(() => ctx.kpi.kpis.map((k) => ({ id: k.id, baseline: k.baseline, current: k.current, target: k.target, name: loc(k.name, lang), unit: loc(k.unit, lang) })), [ctx, lang]);
  const realization = useMemo(() => realizationOf(data, built, ctx.pack, kpiFacts, ctx.today), [data, built, ctx, kpiFacts]);
  const applyReal = (whatIf.applyReal ?? data.settings.applyRealization) && realization.factor !== null;
  const model = useMemo(() => ({ ...built.model, selected, discountRate: rate, horizonYears: horizon, ...(applyReal ? { realization: realization.factor! } : {}) }), [built, selected, rate, horizon, applyReal, realization]);
  const result = useMemo(() => valueEngine(model), [model]);
  const independent = useMemo(() => (model.groups?.length ? valueEngine({ ...model, groups: [] }) : null), [model]);
  const checks = useMemo(() => valueChecks(data, built), [data, built]);
  const suggestions = useMemo(() => suggestLinks(ctx.pack, data, built.solutions), [ctx, data, built]);
  const scope = useValueModel((s) => s.scope);
  const draftCtx = useMemo(() => ({ pack: ctx.pack, data, built, kpis: kpiFacts, lang, at: '' }), [ctx, data, built, kpiFacts, lang]);
  const [form, setForm] = useState<LineForm | null>(null);
  const kpiName = useCallback((id: string) => {
    const k = ctx.kpi.kpis.find((x) => x.id === id);
    return k ? loc(k.name, lang) : null;
  }, [ctx, lang]);

  const lineLabel = useCallback((id: string) => {
    if (id.startsWith(IMPLICIT)) return t('val.implicit', { name: nameOf(id.slice(IMPLICIT.length)) });
    const b = data.benefits.find((x) => x.id === id);
    return b ? `${loc(b.label, lang)} (${nameOf(b.solutionId)})` : id;
  }, [data, lang, nameOf, t]);
  const tornadoLabel = (_id: string, kind: string, ref: string) =>
    kind === 'rate' ? t('val.kind.rate') : kind === 'cost' ? t('val.kind.cost', { name: nameOf(ref) }) : t(`val.kind.${kind}` as MessageKey, { name: lineLabel(ref) });
  const dirty = Object.values(whatIf).some((v) => v !== undefined);

  const startAdd = (solutionId: string, column?: CoverageColumn) => setForm({
    id: null, solutionId, label: '', lever: column && column !== 'disbenefit' ? column : 'cost', nature: 'financial', timing: 'annual',
    sign: column === 'disbenefit' ? 'disbenefit' : 'benefit', amount: emptyRange(), conversion: { low: '100', mode: '100', high: '100' }, kpiId: '', owner: '', basis: 'assumption', evidence: '',
  });
  const startEdit = (b: BenefitLine) => setForm({
    id: b.id, solutionId: b.solutionId, label: loc(b.label, lang), lever: b.lever, nature: b.nature, timing: b.timing, sign: b.sign,
    amount: b.amountJpy ? fromRange(b.amountJpy, MILLION) : emptyRange(), conversion: fromRange(b.conversion, 0.01), kpiId: b.kpiId ?? '',
    owner: loc(b.owner, lang), basis: b.basis, evidence: loc(b.evidence, lang),
  });
  const saveAssumptions = () => {
    write((d) => setSettings(d, {
      discountRate: rate, horizonYears: horizon, confirmed: true, excluded: built.solutions.filter((s) => !selected.includes(s.id)).map((s) => s.id),
      adoptionRho: rho, correlationConfirmed: true, applyRealization: applyReal,
    }));
    setWhatIf({});
  };
  const exportHtml = () => {
    const html = valueHtml({
      model, lang, title: t('val.export.title', { project: names.project || names.company }),
      names: Object.fromEntries(built.solutions.map((s) => [s.id, nameOf(s.id)])),
      lineLabels: Object.fromEntries(built.model.lines.map((l) => [l.id, lineLabel(l.id)])),
      createdAt: ctx.today,
    });
    downloadText(`value-model-${ctx.today}.html`, html, 'text/html');
  };

  if (built.solutions.length === 0) {
    return (
      <Panel title={t('val.title')} testId="val-panel" className="span-full">
        <p className="muted" data-testid="val-empty">{t('val.empty')}</p>
      </Panel>
    );
  }
  const costOf = (id: string) => built.solutions.find((s) => s.id === id)?.cost.mode ?? 0;
  const explainInput = {
    model, result, independent,
    names: { ...Object.fromEntries(built.solutions.map((s) => [s.id, nameOf(s.id)])), ...Object.fromEntries(built.model.lines.map((l) => [l.id, lineLabel(l.id)])) },
    linked: result.solutions.filter((s) => Math.abs(s.marginal - s.standalone) > Math.max(1, costOf(s.id) * 0.005)).map((s) => s.id),
  };
  // The decision is robust to an unknown cost of capital when NPV stays positive well above any plausible rate.
  const robustText = result.irr === null
    ? t('val.robust.none')
    : result.irr >= RATE_RANGE.max
      ? t('val.robust.high', { max: fmt.percent(RATE_RANGE.max) })
      : result.irr > rate
        ? t('val.robust.above', { irr: fmt.percent(result.irr), margin: fmt.number(Math.round((result.irr - rate) * 1000) / 10) })
        : t('val.robust.below', { irr: fmt.percent(result.irr), rate: fmt.percent(rate) });
  return (
    <Panel
      title={t('val.title')}
      testId="val-panel"
      className="span-full"
      actions={<Button icon={<ArrowDownload20Regular />} onClick={exportHtml} data-testid="val-export">{t('val.export')}</Button>}
    >
      <p className="muted">{t('val.lead')}</p>
      <ExplainSection input={explainInput} scope={scope} />
      {built.hidden > 0 && <p className="muted" data-testid="val-hidden">{t('val.hidden', { n: built.hidden })}</p>}
      <DraftBar draftCtx={draftCtx} scope={scope} />
      <DraftReview data={data} nameOf={nameOf} kpiName={kpiName} />

      <section className="val-section val-controls" aria-labelledby="val-whatif-title" data-testid="val-whatif">
        <h3 id="val-whatif-title" className="step-chart-title">{t('val.whatif')}</h3>
        <fieldset className="val-portfolio">
          <legend>{t('val.portfolio')}</legend>
          {built.solutions.map((s) => (
            <Checkbox
              key={s.id} checked={selected.includes(s.id)} label={`${nameOf(s.id)} · ${fmt.yenCompact(s.cost.mode)}`}
              onChange={(_, d) => setWhatIf({ ...whatIf, selected: d.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id) })}
              data-testid={`val-include-${s.id}`}
            />
          ))}
        </fieldset>
        <div className="val-sliders">
          <Field label={t('val.rate', { value: fmt.percent(rate) })} hint={data.settings.confirmed ? t('val.rate.confirmed') : t('val.rate.default')}>
            <Slider min={RATE_RANGE.min * 1000} max={RATE_RANGE.max * 1000} step={5} value={Math.round(rate * 1000)} onChange={(_, d) => setWhatIf({ ...whatIf, rate: d.value / 1000 })} data-testid="val-rate" />
          </Field>
          <Field label={t('val.horizon', { n: horizon })} hint={t('val.horizon.hint')}>
            <Slider min={HORIZON_RANGE.min} max={HORIZON_RANGE.max} step={1} value={horizon} onChange={(_, d) => setWhatIf({ ...whatIf, horizon: d.value })} data-testid="val-horizon" />
          </Field>
          <Field label={t('val.corr.adoption', { value: fmt.number(rho) })} hint={data.settings.correlationConfirmed ? t('val.corr.confirmed') : t('val.corr.default')}>
            <Slider min={0} max={100} step={5} value={Math.round(rho * 100)} onChange={(_, d) => setWhatIf({ ...whatIf, rho: d.value / 100 })} data-testid="val-rho" />
          </Field>
        </div>
        <div className="proj-row">
          <Button appearance="primary" icon={<Save20Regular />} onClick={saveAssumptions} disabled={!dirty && data.settings.confirmed} data-testid="val-save-assumptions">{t('val.saveAssumptions')}</Button>
          {dirty && <Button icon={<ArrowReset20Regular />} onClick={() => setWhatIf({})} data-testid="val-reset">{t('val.reset')}</Button>}
          {dirty && <Badge appearance="outline" color="warning" data-testid="val-dirty">{t('val.dirty')}</Badge>}
        </div>
        <dl className="step-dash-stats val-stats" aria-live="polite">
          <div className="step-dash-stat" data-testid="val-p50" data-value={result.npv.p50}><dt>{t('val.stat.p50')}</dt><dd>{fmt.yenCompact(result.npv.p50)}</dd></div>
          <div className="step-dash-stat"><dt>{t('val.stat.range')}</dt><dd>{`${fmt.yenCompact(result.npv.p10)} – ${fmt.yenCompact(result.npv.p90)}`}</dd></div>
          <div className="step-dash-stat" data-testid="val-positive" data-value={result.npv.pPositive}><dt>{t('val.stat.positive')}</dt><dd>{fmt.percent(result.npv.pPositive)}</dd></div>
          <div className="step-dash-stat"><dt>{t('val.stat.payback')}</dt><dd>{result.payback === null ? t('val.stat.never') : t('proj.dash.years', { n: result.payback.toFixed(1) })}</dd></div>
          <div className="step-dash-stat" data-testid="val-stress"><dt>{t('val.stat.stress')}</dt><dd>{result.stress ? fmt.yenCompact(result.stress.npv) : '–'}</dd></div>
          <div className="step-dash-stat" data-testid="val-irr" data-value={result.irr ?? ''}><dt>{t('val.stat.irr')}</dt><dd>{result.irr === null ? '–' : fmt.percent(result.irr)}</dd></div>
        </dl>
        <p data-testid="val-robust">{robustText}</p>
        {independent && <p className="muted" data-testid="val-corr-effect">{t('val.corr.effect', { with: `${fmt.yenCompact(result.npv.p10)} – ${fmt.yenCompact(result.npv.p90)}`, without: `${fmt.yenCompact(independent.npv.p10)} – ${fmt.yenCompact(independent.npv.p90)}` })}</p>}
        {result.stress && <p className="muted">{t('val.stress.read', { name: nameOf(result.stress.solutionId) })}</p>}
      </section>

      <DriverBridge r={result} />
      <Distribution r={result} />
      <StandaloneMarginal r={result} nameOf={nameOf} cost={costOf} />
      <Tornado r={result} label={tornadoLabel} />
      <CoverageMatrix data={data} built={built} nameOf={nameOf} onAdd={(id, column) => startAdd(id, column)} />
      <Links data={data} built={built} suggestions={suggestions} nameOf={nameOf} />
      <section className="val-section" aria-labelledby="val-corr-title" data-testid="val-corr">
        <h3 id="val-corr-title" className="step-chart-title">{t('val.corr.title')}</h3>
        <p className="step-chart-read muted">{t('val.corr.read')}</p>
        <GroupsSection data={data} built={built} lineLabel={lineLabel} />
      </section>

      <section className="val-section" aria-labelledby="val-lines-title" data-testid="val-lines-section">
        <h3 id="val-lines-title" className="step-chart-title">{t('val.lines.title')}</h3>
        <p className="step-chart-read muted">{t('val.lines.read')}</p>
        <LinesTable data={data} built={built} nameOf={nameOf} kpiName={kpiName} onEdit={startEdit} />
        {form
          ? <LineEditor form={form} setForm={setForm} ctx={ctx} solutions={built.solutions} nameOf={nameOf} onDone={() => setForm(null)} />
          : <Button icon={<Add20Regular />} onClick={() => startAdd(built.solutions[0]!.id)} data-testid="val-line-add">{t('val.lines.add')}</Button>}
      </section>
      <RealizationSection
        data={data} summary={realization} today={ctx.today} nameOf={nameOf} lineLabel={lineLabel} apply={applyReal}
        onApply={(v) => setWhatIf({ ...whatIf, applyReal: v })}
      />

      {checks.length > 0 && (
        <section className="val-section" aria-labelledby="val-checks-title" data-testid="val-checks">
          <h3 id="val-checks-title" className="step-chart-title">{t('val.checks.title', { n: checks.length })}</h3>
          {checks.map((c) => (
            <MessageBar key={c.id} intent={c.id === 'defaultRate' || c.id === 'openCells' ? 'info' : 'warning'} data-testid={`val-check-${c.id}`}>
              <MessageBarBody>
                {t(`val.check.${c.id}` as MessageKey, { n: c.refs.length })}{' '}
                {c.id !== 'defaultRate' && (
                  <span className="muted">
                    {c.refs.slice(0, 4).map((id, i) => (
                      <span key={id}>{i ? ', ' : ''}{built.solutions.some((s) => s.id === id) ? <EntityRef id={id} /> : lineLabel(id)}</span>
                    ))}
                    {c.refs.length > 4 ? ` +${c.refs.length - 4}` : ''}
                  </span>
                )}
              </MessageBarBody>
            </MessageBar>
          ))}
        </section>
      )}

      <details className="val-method">
        <summary>{t('val.method')}</summary>
        <p>{t('val.method.body', { runs: fmt.number(result.runs), swing: fmt.percent(model.rateSwing) })}</p>
        <p className="muted">{t('val.method.sources')}</p>
      </details>
    </Panel>
  );
}
