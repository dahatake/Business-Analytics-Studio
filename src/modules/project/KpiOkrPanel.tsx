import { useState } from 'react';
import { Badge, Button, Field, Input, MessageBar, MessageBarBody, ProgressBar, Select } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { loaded, packOrigin } from '../../data/pack.ts';
import { OkrExtension } from '../../data/extensionSchemas.ts';
import { Panel } from '../../ui/Panel.tsx';
import { achievementPct, kpiStatusText, okrPct, statusForPct, validateKpi, type KpiField, type KpiStatusText } from './kpiOkr.ts';
import { newId, type KpiData, type KpiDef } from './model.ts';
import { useKpis, useScopeKpis } from './stores.ts';
import { ScrollRegion } from './common.tsx';

const EMPTY = { name: '', unit: '', baseline: '', current: '', target: '', deadline: '' };
const STATUS_COLOR: Record<KpiStatusText, 'success' | 'informative' | 'subtle' | 'warning'> = {
  achieved: 'success', inProgress: 'informative', notStarted: 'warning', unmeasurable: 'subtle',
};

function StatusBadge({ status }: { status: KpiStatusText }) {
  const { t } = useI18n();
  return <Badge appearance="tint" color={STATUS_COLOR[status]} data-status={status}>{t(`proj.kpiStatus.${status}`)}</Badge>;
}

/** FR-153 (definitions) and FR-154 (default display): KPI table with status text, OKRs linked to KPIs. */
export function KpiOkrPanel() {
  const { t, lang } = useI18n();
  const data = useScopeKpis();
  const setStore = useKpis((s) => s.set);
  // Edits start from the resolved KPIs, so the first edit saves the pack's KPIs along with it.
  const set = (update: (v: KpiData) => KpiData) => setStore(update(data));
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [errors, setErrors] = useState<KpiField[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);

  const [objective, setObjective] = useState('');
  const [krs, setKrs] = useState([{ text: '', kpiId: '' }]);
  const [okrError, setOkrError] = useState<string | null>(null);

  const submitKpi = () => {
    const bad = validateKpi(form);
    setErrors(bad);
    if (bad.length) return;
    const def: KpiDef = {
      id: editing ?? newId('kpi'),
      name: form.name.trim(), unit: form.unit.trim(), baseline: Number(form.baseline), current: Number(form.current), target: Number(form.target), deadline: form.deadline,
    };
    set((v) => ({ ...v, kpis: editing ? v.kpis.map((k) => (k.id === editing ? def : k)) : [...v.kpis, def] }));
    setForm(EMPTY);
    setEditing(null);
  };
  const edit = (k: KpiDef) => {
    setEditing(k.id);
    setErrors([]);
    setForm({ name: loc(k.name, lang), unit: loc(k.unit, lang), baseline: String(k.baseline), current: String(k.current), target: String(k.target), deadline: k.deadline });
  };
  const remove = (k: KpiDef) => {
    if (data.okrs.some((o) => o.keyResults.some((kr) => kr.kpiId === k.id))) {
      setBlocked(loc(k.name, lang));
      return;
    }
    setBlocked(null);
    set((v) => ({ ...v, kpis: v.kpis.filter((x) => x.id !== k.id) }));
  };
  const submitOkr = () => {
    const valid = krs.filter((k) => k.text.trim() && k.kpiId);
    if (!objective.trim()) return setOkrError(t('proj.okr.errObjective'));
    if (valid.length === 0) return setOkrError(t('proj.okr.errKr'));
    set((v) => ({ ...v, okrs: [...v.okrs, { id: newId('okr'), objective: objective.trim(), keyResults: valid.map((k) => ({ id: newId('kr'), text: k.text.trim(), kpiId: k.kpiId })) }] }));
    setObjective('');
    setKrs([{ text: '', kpiId: '' }]);
    setOkrError(null);
  };
  const fieldProps = (f: KpiField) => (errors.includes(f) ? { validationState: 'error' as const, validationMessage: t(`proj.kpi.err.${f}`) } : {});

  return (
    <>
      <Panel title={t('proj.kpi.title')} rationale="proj.kpi.why" className="span-full" testId="proj-kpi-panel" id="proj-kpi-panel">
        <ScrollRegion label={t('proj.kpi.title')}>
          <table className="data-table compact">
            <caption className="visually-hidden">{t('proj.kpi.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('proj.kpi.name')}</th>
                <th scope="col">{t('proj.kpi.unit')}</th>
                <th scope="col" className="num">{t('proj.kpi.baseline')}</th>
                <th scope="col" className="num">{t('proj.kpi.current')}</th>
                <th scope="col" className="num">{t('proj.kpi.target')}</th>
                <th scope="col">{t('proj.kpi.deadline')}</th>
                <th scope="col">{t('proj.kpi.achievement')}</th>
                <th scope="col">{t('proj.kpi.status')}</th>
                <th scope="col">{t('proj.projects.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.kpis.length === 0 && <tr><td colSpan={9} className="empty">{t('proj.kpi.none')}</td></tr>}
              {data.kpis.map((k) => {
                const pct = achievementPct(k);
                const name = loc(k.name, lang);
                return (
                  <tr key={k.id}>
                    <th scope="row">{name}</th>
                    <td>{loc(k.unit, lang)}</td>
                    <td className="num">{k.baseline}</td>
                    <td className="num">{k.current}</td>
                    <td className="num">{k.target}</td>
                    <td>{k.deadline}</td>
                    <td className="proj-pct">
                      <ProgressBar value={pct === null ? 0 : Math.max(0, Math.min(1, pct / 100))} aria-label={t('proj.kpi.progressLabel', { name })} />
                      <span>{pct === null ? '—' : `${Math.round(pct)}%`}</span>
                    </td>
                    <td><StatusBadge status={kpiStatusText(k)} /></td>
                    <td>
                      <div className="proj-row">
                        <Button size="small" icon={<Edit20Regular />} onClick={() => edit(k)} aria-label={t('proj.kpi.editNamed', { name })}>{t('proj.edit')}</Button>
                        <Button size="small" icon={<Delete20Regular />} onClick={() => remove(k)} aria-label={t('proj.kpi.deleteNamed', { name })}>{t('proj.delete')}</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
        {blocked && <MessageBar intent="warning"><MessageBarBody>{t('proj.kpi.inUse', { name: blocked })}</MessageBarBody></MessageBar>}
        <form className="proj-kpi-form" onSubmit={(e) => { e.preventDefault(); submitKpi(); }} aria-label={t(editing ? 'proj.kpi.editTitle' : 'proj.kpi.addTitle')}>
          <h3 className="proj-h3">{t(editing ? 'proj.kpi.editTitle' : 'proj.kpi.addTitle')}</h3>
          <div className="proj-kpi-fields">
            <Field label={t('proj.kpi.name')} {...fieldProps('name')}><Input value={form.name} onChange={(_, d) => setForm({ ...form, name: d.value })} data-testid="proj-kpi-name" /></Field>
            <Field label={t('proj.kpi.unit')} {...fieldProps('unit')}><Input value={form.unit} onChange={(_, d) => setForm({ ...form, unit: d.value })} /></Field>
            <Field label={t('proj.kpi.baseline')} {...fieldProps('baseline')}><Input type="number" value={form.baseline} onChange={(_, d) => setForm({ ...form, baseline: d.value })} /></Field>
            <Field label={t('proj.kpi.current')} {...fieldProps('current')}><Input type="number" value={form.current} onChange={(_, d) => setForm({ ...form, current: d.value })} /></Field>
            <Field label={t('proj.kpi.target')} {...fieldProps('target')}><Input type="number" value={form.target} onChange={(_, d) => setForm({ ...form, target: d.value })} /></Field>
            <Field label={t('proj.kpi.deadline')} {...fieldProps('deadline')}><Input type="date" value={form.deadline} onChange={(_, d) => setForm({ ...form, deadline: d.value })} /></Field>
          </div>
          <div className="proj-row">
            <Button type="submit" appearance="primary" icon={<Add20Regular />}>{t(editing ? 'proj.save' : 'proj.kpi.add')}</Button>
            {editing && <Button onClick={() => { setEditing(null); setForm(EMPTY); setErrors([]); }}>{t('proj.cancel')}</Button>}
          </div>
        </form>
      </Panel>
      <Panel title={t('proj.okr.title')} rationale="proj.okr.why" className="span-full" testId="proj-okr-panel" id="proj-okr-panel">
        {data.okrs.length === 0 && <p className="muted">{t('proj.okr.none')}</p>}
        <ul className="proj-okrs">
          {data.okrs.map((o) => {
            const pct = okrPct(o, data.kpis);
            return (
              <li key={o.id} className="proj-okr">
                <div className="proj-okr-head">
                  <strong>{loc(o.objective, lang)}</strong>
                  <span>{pct === null ? '—' : `${Math.round(pct)}%`}</span>
                  <StatusBadge status={statusForPct(pct)} />
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('proj.okr.deleteNamed', { name: loc(o.objective, lang) })} onClick={() => set((v) => ({ ...v, okrs: v.okrs.filter((x) => x.id !== o.id) }))} />
                </div>
                <ul>
                  {o.keyResults.map((kr) => {
                    const k = data.kpis.find((x) => x.id === kr.kpiId);
                    return (
                      <li key={kr.id}>
                        {loc(kr.text, lang)}
                        {k && <span className="muted">{t('proj.okr.linked', { kpi: loc(k.name, lang) })}</span>}
                        {k && <StatusBadge status={kpiStatusText(k)} />}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
        <form className="proj-okr-form" onSubmit={(e) => { e.preventDefault(); submitOkr(); }} aria-label={t('proj.okr.addTitle')}>
          <h3 className="proj-h3">{t('proj.okr.addTitle')}</h3>
          <Field label={t('proj.okr.objective')}><Input value={objective} onChange={(_, d) => setObjective(d.value)} /></Field>
          {krs.map((kr, i) => (
            <div key={i} className="proj-form-row">
              <Field label={t('proj.okr.krText', { n: i + 1 })}>
                <Input value={kr.text} onChange={(_, d) => setKrs(krs.map((x, j) => (j === i ? { ...x, text: d.value } : x)))} />
              </Field>
              <Field label={t('proj.okr.krKpi', { n: i + 1 })}>
                <Select value={kr.kpiId} onChange={(_, d) => setKrs(krs.map((x, j) => (j === i ? { ...x, kpiId: d.value } : x)))}>
                  <option value="">{t('proj.okr.chooseKpi')}</option>
                  {data.kpis.map((k) => <option key={k.id} value={k.id}>{loc(k.name, lang)}</option>)}
                </Select>
              </Field>
            </div>
          ))}
          {okrError && <p className="proj-error" role="alert">{okrError}</p>}
          <div className="proj-row">
            <Button onClick={() => setKrs([...krs, { text: '', kpiId: '' }])} icon={<Add20Regular />}>{t('proj.okr.addKr')}</Button>
            <Button type="submit" appearance="primary">{t('proj.okr.add')}</Button>
          </div>
        </form>
      </Panel>
      <PackOkrPanel />
    </>
  );
}

/** Internal KPIs/OKRs found by Work IQ (extensions.okr), shown as found: targets are often text, not numbers. */
function PackOkrPanel() {
  const { t, lang } = useI18n();
  const scope = useKpis((s) => s.scope);
  if (packOrigin.kind !== 'imported' || packOrigin.projectId !== scope) return null;
  const parsed = OkrExtension.safeParse(loaded.pack.extensions?.okr);
  if (!parsed.success || (parsed.data.kpis.length === 0 && parsed.data.objectives.length === 0)) return null;
  const { kpis, objectives } = parsed.data;
  const text = (v: Localizable | undefined) => (v === undefined ? '' : loc(v, lang));
  return (
    <Panel title={t('proj.packOkr.title')} rationale="proj.packOkr.why" className="span-full" testId="proj-pack-okr">
      {kpis.length > 0 && (
        <ScrollRegion label={t('proj.packOkr.kpis')}>
          <table className="data-table compact">
            <caption>{t('proj.packOkr.kpis')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('proj.kpi.name')}</th>
                <th scope="col">{t('proj.packOkr.definition')}</th>
                <th scope="col">{t('proj.kpi.target')}</th>
                <th scope="col">{t('proj.kpi.current')}</th>
                <th scope="col">{t('proj.packOkr.period')}</th>
                <th scope="col">{t('proj.packOkr.owner')}</th>
                <th scope="col">{t('proj.packOkr.sources')}</th>
              </tr>
            </thead>
            <tbody>
              {kpis.map((k) => (
                <tr key={k.id}>
                  <th scope="row">{text(k.name)}</th>
                  <td>{text(k.definition)}</td>
                  <td>{[k.target, k.unit].filter(Boolean).join(' ')}</td>
                  <td>{k.current ?? t('proj.packOkr.unmeasured')}</td>
                  <td>{k.period ?? ''}</td>
                  <td>{text(k.owner)}</td>
                  <td>{fmtSources(k.sourceIds, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {objectives.length > 0 && (
        <ul className="proj-okrs" aria-label={t('proj.packOkr.objectives')}>
          {objectives.map((o) => (
            <li key={o.id} className="proj-okr">
              <div className="proj-okr-head">
                <strong>{text(o.objective)}</strong>
                {o.owner !== undefined && <span className="muted">{text(o.owner)}</span>}
              </div>
              <ul>
                {o.keyResults.map((kr, i) => (
                  <li key={i}>
                    {text(kr.text)}
                    {(kr.target || kr.period) && <span className="muted">{[kr.target, kr.period].filter(Boolean).join(' / ')}</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function fmtSources(ids: readonly string[] | undefined, lang: Parameters<typeof loc>[1]): string {
  if (!ids?.length) return '';
  const byId = new Map(loaded.pack.entities.map((e) => [e.id, e]));
  return ids.map((id) => {
    const e = byId.get(id);
    return e ? loc(e.name, lang) : id;
  }).join(', ');
}
