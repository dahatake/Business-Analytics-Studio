import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Select, Textarea } from '@fluentui/react-components';
import { Add20Regular, ArrowDownload20Regular, ArrowReset20Regular, Delete20Regular, Edit20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { getEntity, loaded } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { hrefFor } from '../../state/router.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import { downloadText, ScrollRegion, useTargetNames } from './common.tsx';
import type { AppCheckContext as CheckContext } from './deliverables.ts';
import { threadOf } from './deliverables.ts';
import { DEFINITION_STATUSES, kpiDefinitionState, proposeKpiDefinition, type DefinitionStatus } from './kpiOkr.ts';
import { newId, type KpiData, type KpiOrigin } from './model.ts';
import { EVIDENCE_BASES, SIM_RUNS, validRange, type EvidenceBasis } from './simulate.ts';
import { buildSolutionDoc, kindKey, sectionKey, solutionDocMarkdown } from './solutionDocs.ts';
import {
  gapCount, normalizeStrategy, removeContribution, setSection, setSolutionType, SOLUTION_TYPES, upsertContribution,
  type Contribution, type SolutionType, type StrategyData, type StrategyThread,
} from './strategy.ts';
import { useKpis, useProjUi, useScopeKpis, useStrategy } from './stores.ts';

const ORIGIN_COLOR: Record<KpiOrigin, 'brand' | 'informative' | 'warning'> = { customerDefined: 'brand', companyAnchor: 'informative', proposed: 'warning' };

export function OriginBadge({ origin }: { origin?: KpiOrigin }) {
  const { t } = useI18n();
  if (!origin) return null;
  return <Badge size="small" appearance="outline" color={ORIGIN_COLOR[origin]} data-origin={origin}>{t(`sol.origin.${origin}`)}</Badge>;
}

const entityName = (id: string, lang: 'ja' | 'en') => {
  const e = getEntity(id);
  return e && 'name' in e ? loc(e.name as Parameters<typeof loc>[0], lang) : id;
};

function useStrategyWriter() {
  const set = useStrategy((s) => s.set);
  return (fn: (d: StrategyData) => StrategyData) => set((prev) => fn(normalizeStrategy(prev)));
}

/** Edits start from the resolved KPIs (pack KPIs of an imported project), like KpiOkrPanel. */
function useKpiWriter() {
  const data = useScopeKpis();
  const setStore = useKpis((s) => s.set);
  return (fn: (d: KpiData) => KpiData) => setStore(fn(data));
}

const by = () => useProjUi.getState().editor.trim();
const pct = (v: number) => `${Math.round(v * 100)}%`;

/* ---------- Line of sight: company objective → OKR → KPI → solution ---------- */

export function StrategyThreadPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang, fmt } = useI18n();
  const thread = threadOf(ctx);
  const kpiDef = (id: string) => ctx.kpi.kpis.find((k) => k.id === id);
  const okrDef = (id: string) => ctx.kpi.okrs.find((o) => o.id === id);
  const simOf = (id: string) => thread.sims.find((s) => s.kpiId === id);
  const gaps = gapCount(thread);
  const linkedOkrs = new Set(thread.objectives.flatMap((o) => o.okrIds));
  const linkedKpis = new Set(thread.okrs.flatMap((o) => o.kpiIds));
  const linkedSolutions = new Set(thread.kpis.flatMap((k) => k.solutionIds));

  const solutionItem = (id: string) => {
    const s = thread.solutions.find((x) => x.id === id)!;
    return (
      <li key={id} data-testid={`sol-thread-solution-${id}`}>
        <a href={hrefFor(`/entity/${id}`)}>{entityName(id, lang)}</a>{' '}
        <Badge size="small" appearance={s.typeConfirmed ? 'filled' : 'outline'} color="informative">{t(`sol.type.${s.type}`)}</Badge>{' '}
        <span className="muted">{t('sol.type.deliverable', { kind: t(kindKey(s.deliverable)) })}</span>{' '}
        <span className="muted">{t('sol.thread.useCases', { n: s.useCaseIds.length })}</span>{' '}
        <span className="muted">{t('sol.thread.initiatives', { n: s.initiativeIds.length })}</span>
      </li>
    );
  };
  const kpiItem = (id: string) => {
    const k = thread.kpis.find((x) => x.id === id);
    const def = kpiDef(id);
    const sim = simOf(id);
    return (
      <li key={id} data-testid={`sol-thread-kpi-${id}`}>
        <strong>{def ? loc(def.name, lang) : id}</strong> <OriginBadge origin={k?.origin} />{' '}
        {sim && <span className="muted">{t('sol.thread.sim', { p50: fmt.number(sim.p50), prob: pct(sim.probability) })}</span>}
        {k && k.solutionIds.length > 0
          ? <ul>{k.solutionIds.map(solutionItem)}</ul>
          : <p className="muted">{t('sol.thread.noSolution')}</p>}
      </li>
    );
  };
  const okrItem = (id: string) => {
    const o = thread.okrs.find((x) => x.id === id);
    const def = okrDef(id);
    return (
      <li key={id} data-testid={`sol-thread-okr-${id}`}>
        <strong>{def ? loc(def.objective, lang) : id}</strong> <OriginBadge origin={o?.origin} />{' '}
        {o?.inherited && <span className="muted">{t('sol.thread.viaProject')}</span>}
        {o && o.kpiIds.length > 0 ? <ul>{o.kpiIds.map(kpiItem)}</ul> : <p className="muted">{t('sol.thread.noKr')}</p>}
      </li>
    );
  };

  return (
    <Panel title={t('sol.thread.title')} className="span-full" testId="sol-thread" id="sol-thread">
      <p className="muted">{t('sol.thread.intro')}</p>
      <p data-testid="sol-thread-status">
        <Badge appearance="tint" color={gaps ? 'warning' : 'success'}>{gaps ? t('sol.thread.summaryGaps', { n: gaps }) : t('sol.thread.summaryOk')}</Badge>
      </p>
      {thread.objectives.length === 0 && <MessageBar intent="info"><MessageBarBody>{t('sol.thread.noObjectives')}</MessageBarBody></MessageBar>}
      <ul className="sol-tree">
        {thread.objectives.map((o) => (
          <li key={o.id} data-testid={`sol-thread-objective-${o.id}`}>
            <span className="muted">{t('sol.thread.objective')}</span> <strong>{o.text}</strong>
            {o.okrIds.length > 0 && <ul>{o.okrIds.map(okrItem)}</ul>}
          </li>
        ))}
      </ul>
      {thread.okrs.some((o) => !linkedOkrs.has(o.id)) && (
        <section aria-label={t('sol.thread.unlinkedOkrs')}>
          <h3 className="proj-h3">{t('sol.thread.unlinkedOkrs')}</h3>
          <ul className="sol-tree">{thread.okrs.filter((o) => !linkedOkrs.has(o.id)).map((o) => okrItem(o.id))}</ul>
        </section>
      )}
      {thread.kpis.some((k) => !linkedKpis.has(k.id)) && (
        <section aria-label={t('sol.thread.unlinkedKpis')}>
          <h3 className="proj-h3">{t('sol.thread.unlinkedKpis')}</h3>
          <ul className="sol-tree">{thread.kpis.filter((k) => !linkedKpis.has(k.id)).map((k) => kpiItem(k.id))}</ul>
        </section>
      )}
      {thread.solutions.some((s) => !linkedSolutions.has(s.id)) && (
        <section aria-label={t('sol.thread.unlinkedSolutions')}>
          <h3 className="proj-h3">{t('sol.thread.unlinkedSolutions')}</h3>
          <ul className="sol-tree">{thread.solutions.filter((s) => !linkedSolutions.has(s.id)).map((s) => solutionItem(s.id))}</ul>
        </section>
      )}
      {gaps > 0 && (
        <ul className="sol-gaps" data-testid="sol-thread-gaps">
          {(Object.keys(thread.gaps) as (keyof StrategyThread['gaps'])[]).filter((g) => thread.gaps[g].length > 0).map((g) => (
            <li key={g}>
              <strong>{t(`sol.gap.${g}`)}</strong>{' '}
              <Badge size="small" appearance="outline" color="warning">{thread.gaps[g].length}</Badge>{' '}
              <span className="muted">{thread.gaps[g].map((id) => {
                const k = kpiDef(id);
                const o = okrDef(id);
                return k ? loc(k.name, lang) : o ? loc(o.objective, lang) : entityName(id, lang);
              }).join(lang === 'ja' ? '、' : ', ')}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ---------- KPI/OKR definition: retrieved, partial, undefined → define here ---------- */

export function KpiDefinitionPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang, fmt } = useI18n();
  const write = useStrategyWriter();
  const writeKpis = useKpiWriter();
  const [message, setMessage] = useState<string | null>(null);
  const state = useMemo(() => kpiDefinitionState(loaded.pack), []);
  const confirmed = ctx.strategy.definition;
  const status: DefinitionStatus = confirmed?.status ?? state.status;

  const confirm = (v: string) => write((d) => {
    if (v === '') {
      const { definition: _drop, ...rest } = d;
      return rest;
    }
    return { ...d, definition: { status: v as DefinitionStatus, note: '', at: new Date().toISOString(), by: by() } };
  });
  const propose = () => {
    const deadline = `${Number(ctx.today.slice(0, 4)) + 1}${ctx.today.slice(4)}`;
    const next = proposeKpiDefinition({ pack: loaded.pack, current: ctx.kpi, objectives: ctx.objectives, deadline, lang });
    const added = next.kpis.length - ctx.kpi.kpis.length + next.okrs.length - ctx.kpi.okrs.length;
    if (added > 0) writeKpis(() => next);
    setMessage(added > 0 ? t('sol.def.proposed', { n: added }) : t('sol.def.nothing'));
  };
  const toggleObjective = (okrId: string, objectiveId: string, on: boolean) => writeKpis((d) => ({
    ...d,
    okrs: d.okrs.map((o) => {
      if (o.id !== okrId) return o;
      const ids = new Set(o.companyObjectiveIds ?? []);
      if (on) ids.add(objectiveId);
      else ids.delete(objectiveId);
      return { ...o, companyObjectiveIds: [...ids] };
    }),
  }));

  return (
    <Panel title={t('sol.def.title')} className="span-full" testId="sol-def" id="sol-def">
      <p>
        <strong>{t('sol.def.status')}</strong>{' '}
        <Badge appearance="filled" color={status === 'defined' ? 'success' : status === 'partial' ? 'informative' : 'warning'} data-testid="sol-def-status" data-status={status}>
          {t(`sol.def.status.${status}`)}
        </Badge>
      </p>
      <p className="muted">
        {confirmed
          ? (confirmed.by ? t('sol.def.confirmed', { date: fmt.date(confirmed.at.slice(0, 10)), by: confirmed.by }) : t('sol.def.confirmedAnon', { date: fmt.date(confirmed.at.slice(0, 10)) }))
          : t(state.stated ? 'sol.def.stated' : 'sol.def.inferred')}
      </p>
      <p>{t('sol.def.counts', { kpis: state.kpis, objectives: state.objectives })}</p>
      <p className="muted">{state.checkedSources.length ? t('sol.def.checked', { sources: state.checkedSources.join(lang === 'ja' ? '、' : ', ') }) : t('sol.def.checkedNone')}</p>
      <Field label={t('sol.def.confirm')}>
        <Select value={confirmed?.status ?? ''} onChange={(_, d) => confirm(d.value)} data-testid="sol-def-confirm">
          <option value="">{t('sol.def.auto')}</option>
          {DEFINITION_STATUSES.map((s) => <option key={s} value={s}>{t(`sol.def.status.${s}`)}</option>)}
        </Select>
      </Field>
      {status !== 'defined' && (
        <div className="sol-def-propose">
          <p className="muted">{t(status === 'notRetrieved' ? 'sol.def.retrieveHint' : 'sol.def.proposeHint')}</p>
          {status === 'notRetrieved' && <p className="muted">{t('sol.def.proposeHint')}</p>}
          <Button appearance="primary" icon={<Sparkle20Regular />} onClick={propose} data-testid="sol-def-propose">{t('sol.def.propose')}</Button>
          {message && <p role="status" data-testid="sol-def-message">{message}</p>}
        </div>
      )}
      <h3 className="proj-h3">{t('sol.okr.title')}</h3>
      {ctx.objectives.length === 0 && <p className="muted">{t('sol.thread.noObjectives')}</p>}
      {ctx.kpi.okrs.length === 0 && <p className="muted">{t('sol.okr.none')}</p>}
      {ctx.objectives.length > 0 && ctx.kpi.okrs.map((o) => (
        <fieldset key={o.id} className="sol-okr-link" data-testid={`sol-okr-link-${o.id}`}>
          <legend>{t('sol.okr.objectives', { okr: loc(o.objective, lang) })} <OriginBadge origin={o.origin} /></legend>
          {ctx.objectives.map((obj) => (
            <Checkbox
              key={obj.id}
              label={obj.text}
              checked={(o.companyObjectiveIds ?? []).includes(obj.id)}
              onChange={(_, d) => toggleObjective(o.id, obj.id, !!d.checked)}
              data-testid={`sol-okr-link-${o.id}-${obj.id}`}
            />
          ))}
        </fieldset>
      ))}
    </Panel>
  );
}

/* ---------- Solution types, contributions and the simulation ---------- */

type RangeForm = { low: string; mode: string; high: string };
interface ContributionForm {
  kpiId: string;
  lever: string;
  leverUnit: string;
  amount: RangeForm;
  effectPerUnit: RangeForm;
  rampStart: string;
  fullEffect: string;
  basis: EvidenceBasis;
  evidence: string;
}
const emptyRange = (): RangeForm => ({ low: '', mode: '', high: '' });
const toRange = (r: RangeForm) => ({ low: Number(r.low), mode: Number(r.mode), high: Number(r.high) });
const fromRange = (r: { low: number; mode: number; high: number }): RangeForm => ({ low: String(r.low), mode: String(r.mode), high: String(r.high) });
const rangeOk = (r: RangeForm) => [r.low, r.mode, r.high].every((v) => v.trim() !== '') && validRange(toRange(r));

function RangeFields({ label, value, onChange, testId }: { label: string; value: RangeForm; onChange: (r: RangeForm) => void; testId: string }) {
  const { t } = useI18n();
  const touched = [value.low, value.mode, value.high].some((v) => v.trim() !== '');
  const bad = touched && !rangeOk(value);
  return (
    <fieldset className="sol-range">
      <legend>{label}</legend>
      {(['low', 'mode', 'high'] as const).map((k) => (
        <Field key={k} label={t(`sol.c.${k}`)} validationState={bad ? 'error' : 'none'}>
          <Input type="number" value={value[k]} onChange={(_, d) => onChange({ ...value, [k]: d.value })} data-testid={`${testId}-${k}`} />
        </Field>
      ))}
      {bad && <p className="proj-error" role="alert">{t('sol.c.invalid')}</p>}
    </fieldset>
  );
}

function ContributionEditor({ solutionId, ctx }: { solutionId: string; ctx: CheckContext }) {
  const { t, lang, fmt } = useI18n();
  const write = useStrategyWriter();
  const mine = ctx.strategy.contributions.filter((c) => c.solutionId === solutionId);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ContributionForm | null>(null);
  const kpis = ctx.kpi.kpis;
  const kpiName = (id: string) => {
    const k = kpis.find((x) => x.id === id);
    return k ? loc(k.name, lang) : id;
  };
  const blank = (): ContributionForm => {
    const sol = getEntity(solutionId);
    const first = (sol?.kind === 'solution' ? sol.kpiIds.find((id) => kpis.some((k) => k.id === id)) : undefined) ?? kpis[0]?.id ?? '';
    const deadline = kpis.find((k) => k.id === first)?.deadline ?? ctx.today;
    return { kpiId: first, lever: '', leverUnit: '', amount: emptyRange(), effectPerUnit: emptyRange(), rampStart: ctx.today, fullEffect: deadline, basis: 'assumption', evidence: '' };
  };
  const start = (c?: Contribution) => {
    setEditing(c?.id ?? null);
    setForm(c
      ? { kpiId: c.kpiId, lever: c.lever, leverUnit: c.leverUnit, amount: fromRange(c.amount), effectPerUnit: fromRange(c.effectPerUnit), rampStart: c.rampStart, fullEffect: c.fullEffect, basis: c.basis, evidence: c.evidence }
      : blank());
  };
  const ok = form && form.kpiId && form.lever.trim() && rangeOk(form.amount) && rangeOk(form.effectPerUnit) && form.rampStart && form.fullEffect;
  const save = () => {
    if (!form || !ok) return;
    write((d) => upsertContribution(d, {
      id: editing ?? newId('ctr'), solutionId, kpiId: form.kpiId, lever: form.lever.trim(), leverUnit: form.leverUnit.trim(),
      amount: toRange(form.amount), effectPerUnit: toRange(form.effectPerUnit), rampStart: form.rampStart, fullEffect: form.fullEffect, basis: form.basis, evidence: form.evidence.trim(),
    }));
    setForm(null);
    setEditing(null);
  };

  if (kpis.length === 0) return <p className="muted">{t('sol.c.noKpi')}</p>;
  return (
    <div className="sol-contrib" data-testid={`sol-contrib-${solutionId}`}>
      {mine.length === 0 && !form && <p className="muted">{t('sol.c.none')}</p>}
      <ul className="sol-contrib-list">
        {mine.map((c) => (
          <li key={c.id} data-testid={`sol-contrib-item-${c.id}`}>
            <strong>{kpiName(c.kpiId)}</strong>{' '}
            <span>{c.lever}</span>{' '}
            <span className="muted">{t('sol.c.amount')}{': '}{[c.amount.low, c.amount.mode, c.amount.high].map(fmt.number).join(' – ')} {c.leverUnit}</span>{' '}
            <span className="muted">{t('sol.c.effect')}{': '}{[c.effectPerUnit.low, c.effectPerUnit.mode, c.effectPerUnit.high].map(fmt.number).join(' – ')}</span>{' '}
            <Badge size="small" appearance="outline" color={c.basis === 'assumption' ? 'warning' : 'informative'}>{t(`sol.c.basis.${c.basis}`)}</Badge>{' '}
            <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => start(c)} aria-label={t('proj.edit')} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => write((d) => removeContribution(d, c.id))} aria-label={t('sol.c.remove')} data-testid={`sol-contrib-remove-${c.id}`} />
          </li>
        ))}
      </ul>
      {form ? (
        <form className="sol-contrib-form" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={t('sol.c.add')}>
          <div className="proj-kpi-fields">
            <Field label={t('sol.c.kpi')}>
              <Select value={form.kpiId} onChange={(_, d) => setForm({ ...form, kpiId: d.value })} data-testid="sol-c-kpi">
                {kpis.map((k) => <option key={k.id} value={k.id}>{loc(k.name, lang)}</option>)}
              </Select>
            </Field>
            <Field label={t('sol.c.lever')} hint={t('sol.c.leverHint')}>
              <Input value={form.lever} onChange={(_, d) => setForm({ ...form, lever: d.value })} data-testid="sol-c-lever" />
            </Field>
            <Field label={t('sol.c.leverUnit')}>
              <Input value={form.leverUnit} onChange={(_, d) => setForm({ ...form, leverUnit: d.value })} data-testid="sol-c-unit" />
            </Field>
          </div>
          <RangeFields label={t('sol.c.amount')} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} testId="sol-c-amount" />
          <RangeFields label={t('sol.c.effect')} value={form.effectPerUnit} onChange={(effectPerUnit) => setForm({ ...form, effectPerUnit })} testId="sol-c-effect" />
          <div className="proj-kpi-fields">
            <Field label={t('sol.c.rampStart')}><Input type="date" value={form.rampStart} onChange={(_, d) => setForm({ ...form, rampStart: d.value })} data-testid="sol-c-ramp" /></Field>
            <Field label={t('sol.c.fullEffect')}><Input type="date" value={form.fullEffect} onChange={(_, d) => setForm({ ...form, fullEffect: d.value })} data-testid="sol-c-full" /></Field>
            <Field label={t('sol.c.basis')}>
              <Select value={form.basis} onChange={(_, d) => setForm({ ...form, basis: d.value as EvidenceBasis })} data-testid="sol-c-basis">
                {EVIDENCE_BASES.map((b) => <option key={b} value={b}>{t(`sol.c.basis.${b}`)}</option>)}
              </Select>
            </Field>
            <Field label={t('sol.c.evidence')}><Input value={form.evidence} onChange={(_, d) => setForm({ ...form, evidence: d.value })} data-testid="sol-c-evidence" /></Field>
          </div>
          <div className="proj-row">
            <Button type="submit" appearance="primary" disabled={!ok} data-testid="sol-c-save">{t(editing ? 'proj.save' : 'sol.c.add')}</Button>
            <Button onClick={() => { setForm(null); setEditing(null); }}>{t('proj.cancel')}</Button>
          </div>
        </form>
      ) : (
        <Button icon={<Add20Regular />} onClick={() => start()} data-testid={`sol-contrib-add-${solutionId}`}>{t('sol.c.add')}</Button>
      )}
    </div>
  );
}

export function SolutionStrategyPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const write = useStrategyWriter();
  const thread = threadOf(ctx);
  const setType = (id: string, v: string) => write((d) => setSolutionType(d, id, v === '' ? null : (v as SolutionType), by(), new Date().toISOString()));
  return (
    <>
      <Panel title={t('sol.type.title')} className="span-full" testId="sol-types" id="sol-types">
        <p className="muted">{t('sol.type.intro')}</p>
        {thread.solutions.length === 0 && <p className="muted">{t('sol.doc.none')}</p>}
        {thread.solutions.map((s) => (
          <details key={s.id} className="sol-solution" data-testid={`sol-solution-${s.id}`} open={thread.solutions.length <= 3}>
            <summary>
              <strong>{entityName(s.id, lang)}</strong>{' '}
              <Badge size="small" appearance={s.typeConfirmed ? 'filled' : 'outline'} color="informative">{t(`sol.type.${s.type}`)}</Badge>{' '}
              <span className="muted">{t('sol.type.deliverable', { kind: t(kindKey(s.deliverable)) })}</span>
            </summary>
            <Field label={t('sol.type.label')}>
              <Select value={s.typeConfirmed ? s.type : ''} onChange={(_, d) => setType(s.id, d.value)} data-testid={`sol-type-${s.id}`}>
                <option value="">{t('sol.type.inferred')}{': '}{t(`sol.type.${s.type}`)}</option>
                {SOLUTION_TYPES.map((x) => <option key={x} value={x}>{t(`sol.type.${x}`)}</option>)}
              </Select>
            </Field>
            <ContributionEditor solutionId={s.id} ctx={ctx} />
          </details>
        ))}
      </Panel>
      <SimulationPanel ctx={ctx} />
    </>
  );
}

export function SimulationPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang, fmt } = useI18n();
  const thread = threadOf(ctx);
  return (
    <Panel title={t('sol.sim.title')} className="span-full" testId="sol-sim" id="sol-sim">
      <p className="muted">{t('sol.sim.intro', { runs: SIM_RUNS })}</p>
      {thread.sims.length === 0 ? <p className="muted">{t('sol.sim.none')}</p> : (
        <ScrollRegion label={t('sol.sim.title')}>
          <table className="data-table compact">
            <caption className="visually-hidden">{t('sol.sim.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('sol.sim.kpi')}</th>
                <th scope="col">{t('sol.sim.now')}</th>
                <th scope="col" className="num">{t('sol.sim.expected')}</th>
                <th scope="col" className="num">{t('sol.sim.range')}</th>
                <th scope="col" className="num">{t('sol.sim.prob')}</th>
                <th scope="col" className="num">{t('sol.sim.coverage')}</th>
                <th scope="col">{t('sol.sim.warn')}</th>
              </tr>
            </thead>
            <tbody>
              {thread.sims.map((s) => {
                const k = ctx.kpi.kpis.find((x) => x.id === s.kpiId);
                return (
                  <tr key={s.kpiId} data-testid={`sol-sim-${s.kpiId}`}>
                    <th scope="row">{k ? loc(k.name, lang) : s.kpiId}</th>
                    <td>{k ? `${fmt.number(k.current)} → ${fmt.number(k.target)}` : ''}</td>
                    <td className="num">{fmt.number(s.expected)}</td>
                    <td className="num">{[s.p10, s.p50, s.p90].map(fmt.number).join(' / ')}</td>
                    <td className="num" data-testid={`sol-sim-prob-${s.kpiId}`}>{pct(s.probability)}</td>
                    <td className="num">{s.coverage === null ? '—' : pct(s.coverage)}</td>
                    <td>{s.warnings.length ? <ul>{s.warnings.map((w) => <li key={w}>{t(`sol.warn.${w}`)}</li>)}</ul> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Panel>
  );
}

/* ---------- Final deliverable per solution: requirements spec or the plan that fits ---------- */

function SectionEditor({ solutionId, id, text, edited }: { solutionId: string; id: string; text: string; edited: boolean }) {
  const { t } = useI18n();
  const write = useStrategyWriter();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    if (draft !== text) write((d) => setSection(d, solutionId, id, draft));
    setDraft(null);
  };
  return (
    <Field
      label={{ children: (
        <span className="dlv-field-label">
          {t(sectionKey(id) as MessageKey)}
          {edited && <Badge size="small" appearance="tint" color="brand">{t('sol.doc.edited')}</Badge>}
          {edited && <Button size="small" appearance="subtle" icon={<ArrowReset20Regular />} onClick={() => write((d) => setSection(d, solutionId, id, null))} data-testid={`sol-doc-reset-${solutionId}-${id}`}>{t('sol.doc.reset')}</Button>}
        </span>
      ) }}
    >
      <Textarea
        value={draft ?? text}
        resize="vertical"
        rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        onChange={(_, d) => setDraft(d.value)}
        onBlur={commit}
        data-testid={`sol-doc-${solutionId}-${id}`}
      />
    </Field>
  );
}

export function SolutionDocsPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const names = useTargetNames();
  const thread = threadOf(ctx);
  const docs = useMemo(() => thread.solutions.flatMap((ts) => {
    const s = getEntity(ts.id);
    return s?.kind === 'solution' ? [buildSolutionDoc(s, ts, thread, ctx, lang)] : [];
  }), [thread, ctx, lang]);
  const exportDoc = (d: (typeof docs)[number]) => {
    const title = `${entityName(d.solutionId, lang)} — ${t(kindKey(d.kind))}`;
    downloadText(`${names.company}-${names.project}-${title}.md`.replace(/[\\/:*?"<>|]/g, '_'), solutionDocMarkdown(d, title, lang), 'text/markdown');
  };
  return (
    <Panel title={t('sol.doc.title')} className="span-full" testId="sol-docs" id="sol-docs">
      <p className="muted">{t('sol.doc.intro')}</p>
      {docs.length === 0 && <p className="muted">{t('sol.doc.none')}</p>}
      {docs.map((d) => {
        const open = d.sections.filter((s) => s.open).length;
        return (
          <details key={d.solutionId} className="sol-doc" data-testid={`sol-doc-${d.solutionId}`}>
            <summary>
              <strong>{entityName(d.solutionId, lang)}</strong>{' '}
              <Badge size="small" appearance="filled" color="informative">{t(kindKey(d.kind))}</Badge>{' '}
              <Badge size="small" appearance="tint" color={d.complete ? 'success' : 'warning'} data-testid={`sol-doc-state-${d.solutionId}`}>
                {d.complete ? t('sol.doc.complete') : t('sol.doc.open', { n: open })}
              </Badge>
            </summary>
            <div className="proj-row">
              <Button icon={<ArrowDownload20Regular />} onClick={() => exportDoc(d)} data-testid={`sol-doc-export-${d.solutionId}`}>{t('sol.doc.export')}</Button>
            </div>
            <div className="dlv-fields">
              {d.sections.map((s) => <SectionEditor key={s.id} solutionId={d.solutionId} id={s.id} text={s.text} edited={s.edited} />)}
            </div>
          </details>
        );
      })}
    </Panel>
  );
}
