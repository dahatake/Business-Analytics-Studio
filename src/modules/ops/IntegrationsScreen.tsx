import { useId, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Input, Label, MessageBar, MessageBarBody, Select, Switch } from '@fluentui/react-components';
import catalogMarkdown from '../../../docs/integration-catalog.md?raw';
import { C03_TABLE, isApproved, type AiUse } from '../../ai/policy.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useActiveProject } from '../../state/projects.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { checkCatalog, MAX_SELECTED_INTEGRATIONS, requirementIds, type CatalogRow } from './catalog.ts';
import { addCandidate, AUTH_METHODS, EMPTY_SETTINGS, removeCandidate, toggle, updateSettings, useProjectIntegrations, type AuthMethod, type UpdateResult } from './integrationsStore.ts';
import './ops.css';

type T = ReturnType<typeof useI18n>['t'];

/** FR-203: selecting an integration never allows a send; the gate column and the C-03 table decide. */
function sendCondition(t: T, gate: string | null): { text: string; allowed: boolean } {
  if (gate === null) return { text: t('ops.gate.candidate'), allowed: false };
  if (gate === 'dev-only') return { text: t('ops.gate.devOnly'), allowed: false };
  const blocked = /^blocked:(Q-\d+)$/.exec(gate);
  if (blocked) return { text: t('ops.gate.blocked', { question: blocked[1]! }), allowed: false };
  const use = /^c03:(\w+)$/.exec(gate)?.[1] as AiUse | undefined;
  const row = use ? C03_TABLE[use] : undefined;
  if (!row) return { text: t('ops.gate.unknown'), allowed: false };
  if (!isApproved(row)) return { text: t('ops.gate.c03NotApproved', { use: use!, questions: row.openQuestions.join(', ') }), allowed: false };
  return { text: t('ops.gate.c03Approved'), allowed: false };
}

function useCatalog() {
  return useMemo(() => checkCatalog(catalogMarkdown, new Date()), []);
}

function SettingsCard({ id, name, gate }: { id: string; name: string; gate: string | null }) {
  const { t } = useI18n();
  const store = useProjectIntegrations();
  const s = store.value.settings[id] ?? EMPTY_SETTINGS;
  const [storeName, setStoreName] = useState(s.secretStoreName);
  const [error, setError] = useState(false);
  const authId = useId();
  const storeId = useId();
  const apply = (patch: Parameters<typeof updateSettings>[2]) => {
    const { next, result } = updateSettings(store.value, id, patch);
    if (result.ok) store.set(next);
    return result.ok;
  };
  const cond = sendCondition(t, gate);
  return (
    <section className="ops-int-card" aria-labelledby={`${storeId}-h`} data-testid={`int-settings-${id}`}>
      <h3 id={`${storeId}-h`} className="ops-subtitle">{name}</h3>
      <div className="control">
        <Label htmlFor={authId}>{t('ops.int.auth')}</Label>
        <Select id={authId} value={s.authMethod} onChange={(_, d) => apply({ authMethod: d.value as AuthMethod })}>
          {AUTH_METHODS.map((m) => <option key={m} value={m}>{t(`ops.auth.${m}` as MessageKey)}</option>)}
        </Select>
      </div>
      <div className="control">
        <Label htmlFor={storeId}>{t('ops.int.secretStore')}</Label>
        <Input
          id={storeId}
          value={storeName}
          onChange={(_, d) => {
            setStoreName(d.value);
            setError(!apply({ secretStoreName: d.value }));
          }}
          aria-invalid={error}
          aria-describedby={`${storeId}-hint`}
          data-testid={`secret-store-${id}`}
          autoComplete="off"
        />
        <span id={`${storeId}-hint`} className={error ? 'ops-error' : 'muted'} role={error ? 'alert' : undefined}>{error ? t('ops.int.secretRejected') : t('ops.int.secretStoreHint')}</span>
      </div>
      <div className="ops-switches">
        <Switch checked={s.termsChecked} onChange={(_, d) => apply({ termsChecked: d.checked })} label={t('ops.int.terms')} />
        <Switch checked={s.costChecked} onChange={(_, d) => apply({ costChecked: d.checked })} label={t('ops.int.cost')} />
        <Switch checked={s.slaChecked} onChange={(_, d) => apply({ slaChecked: d.checked })} label={t('ops.int.sla')} />
      </div>
      <p className="ops-send" data-testid={`send-${id}`}><strong>{t('ops.int.send')}</strong> {cond.text}</p>
    </section>
  );
}

/** /integrations: catalog check (FR-199), per-project selection (FR-201, PARAM-068) and settings (FR-202, NFR-SEC-008), send conditions (FR-203). */
export function IntegrationsScreen() {
  const { t } = useI18n();
  const { project } = useActiveProject();
  const store = useProjectIntegrations();
  const { rows, problems } = useCatalog();
  const [message, setMessage] = useState<UpdateResult | null>(null);
  const [candidateName, setCandidateName] = useState('');
  const candidateId = useId();
  const state = store.value;
  const count = state.selected.length;
  const atLimit = count >= MAX_SELECTED_INTEGRATIONS;
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');

  const onToggle = (id: string) => {
    const { next, result } = toggle(state, id);
    if (result.ok) store.set(next);
    setMessage(result.ok ? null : result);
  };
  const onAdd = () => {
    const { next, result } = addCandidate(state, candidateName);
    setMessage(result.ok ? null : result);
    if (result.ok) {
      store.set(next);
      setCandidateName('');
    }
  };
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? state.candidates.find((c) => c.id === id)?.name ?? id;
  const gateOf = (id: string) => rows.find((r) => r.id === id)?.gate ?? null;

  const statusBadge = (row: CatalogRow) => (
    <Badge appearance="tint" color={row.status === 'active' ? 'success' : row.status === 'retired' ? 'danger' : 'informative'}>{t(`ops.status.${row.status}` as MessageKey)}</Badge>
  );

  return (
    <div className="screen screen-ops">
      <PageHeader
        title={t('ops.nav.integrations')}
        subtitle={project ? t('ops.int.subtitleProject', { project: project.name }) : t('ops.int.subtitleDemo')}
      />
      <Panel title={t('ops.int.check')} rationale="ops.int.checkWhy" testId="int-check">
        <p data-testid="int-check-summary">
          {t('ops.int.checkSummary', { rows: rows.length, errors: errors.length, warnings: warnings.length })}
        </p>
        {problems.length > 0 && (
          <ul className="ops-list">
            {problems.map((p, i) => (
              <li key={i}>
                <Badge appearance="tint" color={p.severity === 'error' ? 'danger' : 'warning'}>{p.severity === 'error' ? t('ops.int.error') : t('ops.int.warning')}</Badge>{' '}
                {t(`ops.check.${p.code}` as MessageKey, { row: p.rowId ?? '-', column: p.column ?? '-', impact: p.impact.join(', ') || '-' })}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">{t('ops.int.checkCli')}</p>
      </Panel>
      <Panel title={t('ops.int.candidates')} rationale="ops.int.candidatesWhy" testId="int-candidates">
        <div className="control">
          <Label htmlFor={candidateId}>{t('ops.int.candidateName')}</Label>
          <div className="ops-row">
            <Input id={candidateId} value={candidateName} onChange={(_, d) => setCandidateName(d.value)} onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }} data-testid="candidate-name" />
            <Button onClick={onAdd} data-testid="candidate-add">{t('ops.int.candidateAdd')}</Button>
          </div>
          <span className="muted">{t('ops.int.candidateHint')}</span>
        </div>
        {state.candidates.length > 0 && (
          <ul className="ops-list">
            {state.candidates.map((c) => (
              <li key={c.id} className="ops-row">
                <span>{c.name}</span>
                <Button size="small" onClick={() => store.set(removeCandidate(state, c.id))} aria-label={t('ops.int.candidateRemove', { name: c.name })}>{t('ops.int.remove')}</Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('ops.int.catalog')} rationale="ops.int.catalogWhy" testId="int-catalog" className="span-full">
        <p role="status" data-testid="int-count">{t('ops.int.count', { count, max: MAX_SELECTED_INTEGRATIONS })}</p>
        {message && !message.ok && (
          <MessageBar intent="warning" data-testid="int-message">
            <MessageBarBody>{t(`ops.int.reason.${message.reason}` as MessageKey, { max: MAX_SELECTED_INTEGRATIONS })}</MessageBarBody>
          </MessageBar>
        )}
        {atLimit && !message && <p className="muted" data-testid="int-limit-note">{t('ops.int.reason.limit', { max: MAX_SELECTED_INTEGRATIONS })}</p>}
        <div className="table-scroll" role="region" aria-label={t('ops.int.catalog')} tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('ops.int.col.select')}</th><th scope="col">{t('ops.int.col.partner')}</th><th scope="col">{t('ops.int.col.direction')}</th>
                <th scope="col">{t('ops.int.col.status')}</th><th scope="col">{t('ops.int.col.checked')}</th><th scope="col">{t('ops.int.col.send')}</th>
                <th scope="col">{t('ops.int.col.requirements')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`int-row-${row.id}`}>
                  <td><Checkbox checked={state.selected.includes(row.id)} onChange={() => onToggle(row.id)} label={row.name} data-testid={`int-select-${row.id}`} /></td>
                  <td>{row.partner}</td>
                  <td>{t(`ops.direction.${row.direction}` as MessageKey)}</td>
                  <td>{statusBadge(row)}</td>
                  <td className="num">{row.lastChecked}</td>
                  <td>{sendCondition(t, row.gate).text}</td>
                  <td>{requirementIds(row).join(', ')}</td>
                </tr>
              ))}
              {state.candidates.map((c) => (
                <tr key={c.id} data-testid={`int-row-${c.id}`}>
                  <td><Checkbox checked={state.selected.includes(c.id)} onChange={() => onToggle(c.id)} label={c.name} data-testid={`int-select-${c.id}`} /></td>
                  <td>{t('ops.int.candidatePartner')}</td>
                  <td>{t('ops.int.unknown')}</td>
                  <td><Badge appearance="tint" color="informative">{t('ops.status.candidate')}</Badge></td>
                  <td>{t('ops.int.unknown')}</td>
                  <td>{sendCondition(t, null).text}</td>
                  <td>{t('ops.int.unknown')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t('ops.int.settings')} rationale="ops.int.settingsWhy" testId="int-settings" className="span-full">
        <p className="muted">{t('ops.int.settingsHelp')}</p>
        {state.selected.length === 0 ? (
          <p>{t('ops.int.noneSelected')}</p>
        ) : (
          <div className="ops-int-grid">
            {state.selected.map((id) => <SettingsCard key={`${store.scope}-${id}`} id={id} name={nameOf(id)} gate={gateOf(id)} />)}
          </div>
        )}
      </Panel>
    </div>
  );
}
