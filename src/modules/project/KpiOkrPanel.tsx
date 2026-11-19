import { useState } from 'react';
import { Badge, Button, Field, Input, MessageBar, MessageBarBody, ProgressBar, Select } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import { achievementPct, kpiStatusText, lacksCompanyKpi, okrPct, statusForPct, validateKpi, type KpiField, type KpiStatusText } from './kpiOkr.ts';
import { newId, ORG_LEVELS, type KpiData, type KpiDef, type KpiOrg, type Okr, type OrgLevel } from './model.ts';
import { useKpis, useScopeKpis } from './stores.ts';
import { ScrollRegion } from './common.tsx';
import { useCheckContext } from './deliverablesUi.tsx';
import { KpiDefinitionPanel, OriginBadge } from './StrategyPanels.tsx';
import { KpiDraftList, OkrDraftList, OrgBadge, PackOkrPanel } from './KpiAdoptUi.tsx';

const EMPTY = { name: '', unit: '', baseline: '', current: '', target: '', deadline: '', orgLevel: '', orgName: '' };
const STATUS_COLOR: Record<KpiStatusText, 'success' | 'informative' | 'subtle' | 'warning'> = {
  achieved: 'success', inProgress: 'informative', notStarted: 'warning', unmeasurable: 'subtle',
};

function StatusBadge({ status }: { status: KpiStatusText }) {
  const { t } = useI18n();
  return <Badge appearance="tint" color={STATUS_COLOR[status]} data-status={status}>{t(`proj.kpiStatus.${status}`)}</Badge>;
}

function withOrg(o: Okr, org: KpiOrg | undefined): Okr {
  const next = { ...o };
  delete next.org;
  return org ? { ...next, org } : next;
}

/** An edited organisation is the user's own statement, so the estimate mark is dropped. */
function orgFrom(level: string, name: string): KpiOrg | undefined {
  if (!(ORG_LEVELS as readonly string[]).includes(level)) return undefined;
  const n = name.trim();
  return { level: level as OrgLevel, ...(n ? { name: n } : {}) };
}

function OrgFields({ level, name, onChange, idPrefix }: { level: string; name: string; onChange: (level: string, name: string) => void; idPrefix: string }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('proj.org.levelLabel')}>
        <Select value={level} onChange={(_, d) => onChange(d.value, name)} data-testid={`${idPrefix}-org-level`}>
          <option value="">{t('proj.org.unset')}</option>
          {ORG_LEVELS.map((l) => <option key={l} value={l}>{t(`proj.org.level.${l}`)}</option>)}
        </Select>
      </Field>
      <Field label={t('proj.org.name')}>
        <Input value={name} maxLength={80} disabled={!level} onChange={(_, d) => onChange(level, d.value)} data-testid={`${idPrefix}-org-name`} />
      </Field>
    </>
  );
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
  const [okrOrg, setOkrOrg] = useState({ level: '', name: '' });
  const [orgEditing, setOrgEditing] = useState<string | null>(null);
  const [krs, setKrs] = useState([{ text: '', kpiId: '' }]);
  const [okrError, setOkrError] = useState<string | null>(null);
  const ctx = useCheckContext();
  const objectiveText = (id: string) => ctx.objectives.find((o) => o.id === id)?.text;

  const submitKpi = () => {
    const bad = validateKpi(form);
    setErrors(bad);
    if (bad.length) return;
    const prev = editing ? data.kpis.find((k) => k.id === editing) : undefined;
    const typed = orgFrom(form.orgLevel, form.orgName);
    // An unchanged estimate keeps its mark; any change makes it the user's statement.
    const org = prev?.org && typed && prev.org.level === typed.level && (prev.org.name ?? '') === (typed.name ?? '') ? prev.org : typed;
    const def: KpiDef = {
      id: editing ?? newId('kpi'),
      name: form.name.trim(), unit: form.unit.trim(), baseline: Number(form.baseline), current: Number(form.current), target: Number(form.target), deadline: form.deadline,
      ...(org ? { org } : {}),
    };
    set((v) => ({ ...v, kpis: editing ? v.kpis.map((k) => (k.id === editing ? (k.adoptedFrom ? { ...def, adoptedFrom: k.adoptedFrom } : def) : k)) : [...v.kpis, def] }));
    setForm(EMPTY);
    setEditing(null);
  };
  const edit = (k: KpiDef) => {
    setEditing(k.id);
    setErrors([]);
    setForm({ name: loc(k.name, lang), unit: loc(k.unit, lang), baseline: String(k.baseline), current: String(k.current), target: String(k.target), deadline: k.deadline, orgLevel: k.org?.level ?? '', orgName: k.org?.name ?? '' });
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
    const org = orgFrom(okrOrg.level, okrOrg.name);
    set((v) => ({ ...v, okrs: [...v.okrs, { id: newId('okr'), objective: objective.trim(), keyResults: valid.map((k) => ({ id: newId('kr'), text: k.text.trim(), kpiId: k.kpiId })), ...(org ? { org } : {}) }] }));
    setObjective('');
    setOkrOrg({ level: '', name: '' });
    setKrs([{ text: '', kpiId: '' }]);
    setOkrError(null);
  };
  const setOkrOrgOf = (id: string, level: string, name: string) => {
    const org = orgFrom(level, name);
    set((v) => ({ ...v, okrs: v.okrs.map((o) => (o.id === id ? withOrg(o, org) : o)) }));
  };
  const fieldProps = (f: KpiField) => (errors.includes(f) ? { validationState: 'error' as const, validationMessage: t(`proj.kpi.err.${f}`) } : {});

  return (
    <>
      <KpiDefinitionPanel ctx={ctx} />
      <Panel title={t('proj.kpi.title')} rationale="proj.kpi.why" className="span-full" testId="proj-kpi-panel" id="proj-kpi-panel">
        {lacksCompanyKpi(data) && <MessageBar intent="warning" data-testid="proj-kpi-unit-only"><MessageBarBody>{t('proj.org.unitOnly')}</MessageBarBody></MessageBar>}
        <ScrollRegion label={t('proj.kpi.title')}>
          <table className="data-table compact">
            <caption className="visually-hidden">{t('proj.kpi.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('proj.kpi.name')}</th>
                <th scope="col">{t('proj.org.label')}</th>
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
              {data.kpis.length === 0 && <tr><td colSpan={10} className="empty">{t('proj.kpi.none')}</td></tr>}
              {data.kpis.map((k) => {
                const pct = achievementPct(k);
                const name = loc(k.name, lang);
                return (
                  <tr key={k.id}>
                    <th scope="row">{name} <OriginBadge origin={k.origin} /></th>
                    <td><OrgBadge org={k.org} testId={`proj-kpi-org-${k.id}`} /></td>
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
        <KpiDraftList data={data} commit={setStore} />
        <form className="proj-kpi-form" onSubmit={(e) => { e.preventDefault(); submitKpi(); }} aria-label={t(editing ? 'proj.kpi.editTitle' : 'proj.kpi.addTitle')}>
          <h3 className="proj-h3">{t(editing ? 'proj.kpi.editTitle' : 'proj.kpi.addTitle')}</h3>
          <div className="proj-kpi-fields">
            <Field label={t('proj.kpi.name')} {...fieldProps('name')}><Input value={form.name} onChange={(_, d) => setForm({ ...form, name: d.value })} data-testid="proj-kpi-name" /></Field>
            <Field label={t('proj.kpi.unit')} {...fieldProps('unit')}><Input value={form.unit} onChange={(_, d) => setForm({ ...form, unit: d.value })} /></Field>
            <Field label={t('proj.kpi.baseline')} {...fieldProps('baseline')}><Input type="number" value={form.baseline} onChange={(_, d) => setForm({ ...form, baseline: d.value })} /></Field>
            <Field label={t('proj.kpi.current')} {...fieldProps('current')}><Input type="number" value={form.current} onChange={(_, d) => setForm({ ...form, current: d.value })} /></Field>
            <Field label={t('proj.kpi.target')} {...fieldProps('target')}><Input type="number" value={form.target} onChange={(_, d) => setForm({ ...form, target: d.value })} /></Field>
            <Field label={t('proj.kpi.deadline')} {...fieldProps('deadline')}><Input type="date" value={form.deadline} onChange={(_, d) => setForm({ ...form, deadline: d.value })} /></Field>
            <OrgFields level={form.orgLevel} name={form.orgName} idPrefix="proj-kpi" onChange={(orgLevel, orgName) => setForm({ ...form, orgLevel, orgName })} />
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
                  <OriginBadge origin={o.origin} />
                  <span>{pct === null ? '—' : `${Math.round(pct)}%`}</span>
                  <StatusBadge status={statusForPct(pct)} />
                  <OrgBadge org={o.org} testId={`proj-okr-org-${o.id}`} />
                  <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label={t('proj.org.editNamed', { name: loc(o.objective, lang) })} aria-expanded={orgEditing === o.id} onClick={() => setOrgEditing(orgEditing === o.id ? null : o.id)} data-testid={`proj-okr-org-edit-${o.id}`} />
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('proj.okr.deleteNamed', { name: loc(o.objective, lang) })} onClick={() => set((v) => ({ ...v, okrs: v.okrs.filter((x) => x.id !== o.id) }))} />
                </div>
                {orgEditing === o.id && (
                  <div className="proj-form-row">
                    <OrgFields level={o.org?.level ?? ''} name={o.org?.name ?? ''} idPrefix={`proj-okr-${o.id}`} onChange={(level, name) => setOkrOrgOf(o.id, level, name)} />
                  </div>
                )}
                {(o.companyObjectiveIds ?? []).some(objectiveText) && (
                  <p className="muted" data-testid={`proj-okr-company-${o.id}`}>{t('sol.thread.objective')}{': '}{(o.companyObjectiveIds ?? []).map(objectiveText).filter(Boolean).join(lang === 'ja' ? '、' : ', ')}</p>
                )}
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
        <OkrDraftList data={data} commit={setStore} />
        <form className="proj-okr-form" onSubmit={(e) => { e.preventDefault(); submitOkr(); }} aria-label={t('proj.okr.addTitle')}>
          <h3 className="proj-h3">{t('proj.okr.addTitle')}</h3>
          <Field label={t('proj.okr.objective')}><Input value={objective} onChange={(_, d) => setObjective(d.value)} /></Field>
          <div className="proj-form-row">
            <OrgFields level={okrOrg.level} name={okrOrg.name} idPrefix="proj-okr-new" onChange={(level, name) => setOkrOrg({ level, name })} />
          </div>
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
      <PackOkrPanel data={data} />
    </>
  );
}
