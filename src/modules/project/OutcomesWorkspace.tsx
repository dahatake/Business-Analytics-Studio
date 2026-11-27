import { useEffect, useState } from 'react';
import { Button, Field, Input, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { Checkmark20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { hrefFor, useRoute } from '../../state/router.ts';
import { useSettings, type Audience } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import type { AppCheckContext } from './deliverables.ts';
import { validateKpi, type KpiField } from './kpiOkr.ts';
import type { KpiData, KpiDef } from './model.ts';
import { OutcomeDetail, OutcomeSummaryCard, outcomeName, useOutcomeItems, type OutcomeItem } from './OutcomeCards.tsx';
import { SimulationWorkbench } from './SimulationWorkbench.tsx';
import { SIM_TABS, simulationHref } from './simulationHref.ts';
import { ContributionEditor } from './StrategyPanels.tsx';
import { useKpis, useScopeKpis } from './stores.ts';

const FIELDS = ['name', 'unit', 'baseline', 'current', 'target', 'deadline'] as const;
type KpiForm = Record<typeof FIELDS[number], string>;

const formOf = (k: KpiDef, lang: 'ja' | 'en'): KpiForm => ({
  name: loc(k.name, lang), unit: loc(k.unit, lang), baseline: String(k.baseline), current: String(k.current), target: String(k.target), deadline: k.deadline,
});

/**
 * FR-382: edits the KPI behind an outcome in place. A KPI proposed from the data is not stored yet: it is adopted first,
 * so a person decides before it counts. Unchanged names and units keep their bilingual text.
 */
function KpiOutcomeEditor({ def }: { def: KpiDef }) {
  const { t, lang } = useI18n();
  const data = useScopeKpis();
  const setStore = useKpis((s) => s.set);
  const write = (fn: (d: KpiData) => KpiData) => setStore(fn(data));
  const stored = data.kpis.find((k) => k.id === def.id);
  const [form, setForm] = useState<KpiForm>(() => formOf(stored ?? def, lang));
  const [errors, setErrors] = useState<KpiField[]>([]);
  const [saved, setSaved] = useState(false);
  const signature = JSON.stringify(stored ?? def);
  useEffect(() => { setForm(formOf(stored ?? def, lang)); setErrors([]); }, [signature, lang]);

  if (!stored) {
    return (
      <div className="outcome-ws-adopt" data-testid="outcome-adopt">
        <MessageBar intent="warning"><MessageBarBody>{t('proj.outcomes.ws.proposedNote')}</MessageBarBody></MessageBar>
        <Button appearance="primary" icon={<Checkmark20Regular />} onClick={() => write((d) => ({ ...d, kpis: [...d.kpis, def] }))} data-testid="outcome-adopt-kpi">
          {t('proj.outcomes.ws.adopt')}
        </Button>
      </div>
    );
  }
  const submit = () => {
    const bad = validateKpi(form);
    setErrors(bad);
    setSaved(false);
    if (bad.length) return;
    const next: KpiDef = {
      ...stored,
      name: form.name.trim() === loc(stored.name, lang) ? stored.name : form.name.trim(),
      unit: form.unit.trim() === loc(stored.unit, lang) ? stored.unit : form.unit.trim(),
      baseline: Number(form.baseline), current: Number(form.current), target: Number(form.target), deadline: form.deadline,
    };
    write((d) => ({ ...d, kpis: d.kpis.map((k) => (k.id === stored.id ? next : k)) }));
    setSaved(true);
  };
  return (
    <form className="outcome-ws-form" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label={t('proj.outcomes.ws.editKpi')} data-testid="outcome-kpi-form">
      <div className="proj-kpi-fields">
        {FIELDS.map((f) => (
          <Field key={f} label={t(`proj.kpi.${f}`)} validationState={errors.includes(f) ? 'error' : 'none'} validationMessage={errors.includes(f) ? t(`proj.kpi.err.${f}`) : undefined}>
            <Input
              type={f === 'deadline' ? 'date' : f === 'name' || f === 'unit' ? 'text' : 'number'}
              value={form[f]}
              onChange={(_, d) => { setForm({ ...form, [f]: d.value }); setSaved(false); }}
              data-testid={`outcome-kpi-${f}`}
            />
          </Field>
        ))}
      </div>
      <div className="proj-row">
        <Button type="submit" appearance="primary" data-testid="outcome-kpi-save">{t('proj.save')}</Button>
        <span role="status">{saved ? t('proj.outcomes.ws.saved') : ''}</span>
      </div>
    </form>
  );
}

/** Solutions whose contribution estimates move this outcome: the solutions linked to the KPI, or the solution itself. */
function relatedSolutionIds(item: OutcomeItem, ctx: AppCheckContext, visible: (id: string) => boolean): string[] {
  if (item.kind === 'solution') return [item.solution.id];
  if (item.kind !== 'kpi') return [];
  const id = item.outcome.definition.id;
  const ids = new Set(item.outcome.contributions.map((c) => c.solutionId));
  for (const e of ctx.pack.pack.entities) if (e.kind === 'solution' && e.kpiIds.includes(id)) ids.add(e.id);
  return [...ids].filter(visible);
}

function OutcomeEditor({ item, ctx, audience }: { item: OutcomeItem; ctx: AppCheckContext; audience: Audience }) {
  const { t, lang } = useI18n();
  const visible = (id: string) => {
    const e = ctx.pack.byId.get(id);
    return !e || audience === 'internal' || !('visibility' in e) || e.visibility !== 'internal';
  };
  const solutions = relatedSolutionIds(item, ctx, visible);
  return (
    <div className="outcome-ws-editor" data-testid="outcome-editor">
      {item.kind === 'kpi' && <>
        <h3 className="proj-h3">{t('proj.outcomes.ws.editKpi')}</h3>
        <KpiOutcomeEditor key={item.outcome.definition.id} def={item.outcome.definition} />
      </>}
      {item.kind === 'okr' && <>
        <h3 className="proj-h3">{t('proj.outcomes.ws.keyResults')}</h3>
        <ul className="outcome-ws-links">
          {item.outcome.keyResults.map((kr, i) => kr.kpi
            ? <li key={i}><a href={simulationHref({ outcome: `kpi-${kr.kpi.definition.id}`, target: 'outcome-detail' })}>{t('proj.outcomes.ws.openKpi', { name: loc(kr.kpi.definition.name, lang) })}</a></li>
            : <li key={i} className="muted">{kr.text}</li>)}
        </ul>
        <a href={hrefFor('/deliverables', { step: 'kpi' })}>{t('proj.outcomes.ws.editOkr')}</a>
      </>}
      {item.kind === 'issue' && <>
        <p>{t('proj.outcomes.ws.issueHint')}</p>
        <a href={hrefFor('/deliverables', { step: 'kpi' })}>{t('proj.outcomes.ws.defineKpi')}</a>
      </>}
      {solutions.length > 0 && <>
        <h3 className="proj-h3">{t('proj.outcomes.ws.contributions')}</h3>
        <p className="muted">{t('proj.outcomes.ws.contributionsHint')}</p>
        {solutions.map((id) => (
          <section key={id} className="outcome-ws-solution" aria-label={loc(ctx.pack.byId.get(id)?.name ?? id, lang)}>
            <h4>{loc(ctx.pack.byId.get(id)?.name ?? id, lang)}</h4>
            <ContributionEditor solutionId={id} ctx={ctx} />
          </section>
        ))}
      </>}
    </div>
  );
}

/**
 * FR-382: Step 2 (To-Be) view of the business outcomes. The same summary cards as the top bar; the selected outcome's detail,
 * the data behind it to edit, and the simulation that values the To-Be, focused on the selected KPI.
 */
export function OutcomesWorkspace({ ctx }: { ctx: AppCheckContext }) {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const route = useRoute();
  const { items } = useOutcomeItems(ctx, lang, audience);
  const requested = route.query.get('outcome');
  const selected = items.find((i) => i.key === requested)
    ?? items.find((i) => i.kind === 'kpi' && i.outcome.simulation)
    ?? items[0];
  const sim = SIM_TABS.find((tab) => tab === route.query.get('sim'));
  const simStep = route.query.get('simStep') ?? undefined;
  return (
    <>
      <Panel title={t('proj.outcomes.title')} className="span-full" testId="outcome-ws">
        <p className="muted">{t('proj.outcomes.ws.intro')}</p>
        {items.length > 0
          ? (
            <ul className="outcome-ws-list" aria-label={t('proj.outcomes.listLabel')}>
              {items.map((item) => (
                <li key={item.key}>
                  <OutcomeSummaryCard item={item} href={simulationHref({ outcome: item.key, tab: sim, step: simStep })} testId={`outcome-ws-${item.key}`} current={item.key === selected?.key} />
                </li>
              ))}
            </ul>
          )
          : <p role="status">{t('proj.outcomes.noData')}</p>}
      </Panel>
      {selected && (
        <section id="outcome-detail" tabIndex={-1} className="outcome-ws-detail span-full" aria-labelledby="outcome-detail-title" data-testid="outcome-detail" data-outcome={selected.key}>
          <h2 id="outcome-detail-title">{t('proj.outcomes.ws.detailTitle', { name: outcomeName(selected, lang) })}</h2>
          <div className="outcome-ws-detail-grid">
            <OutcomeDetail item={selected} audience={audience} />
            <OutcomeEditor item={selected} ctx={ctx} audience={audience} />
          </div>
        </section>
      )}
      <SimulationWorkbench kpiId={selected?.kind === 'kpi' ? selected.outcome.definition.id : undefined} />
    </>
  );
}
