import { useEffect, useState } from 'react';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody,
  ProgressBar, Radio, RadioGroup, Switch,
} from '@fluentui/react-components';
import { Delete20Regular, Key20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { isUseApproved, readLedger } from '../../ai/client.ts';
import { C03_TABLE, isApproved, type AiUse } from '../../ai/policy.ts';
import { useI18n } from '../../i18n/index.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { D4Warning, MockNotice } from './AiCommon.tsx';
import { copyLegacyPatch, legacyState, readLegacyFoundry } from './legacy.ts';
import { deleteExpiredUsage, expiredUsageCount, usageSummary, type BudgetLevel } from './ledger.ts';
import { relayAiCheck, type ConnectionSaveError, type SecretName } from './relayClient.ts';
import { isConfigured, liveReady, parseBudget, useAiSettings, type AiProvider, type AuthMethod } from './settingsStore.ts';
import { STORY_CAP_JPY, STORY_SAFETY_FACTOR, parsePrice } from './story.ts';
import './mocks.ts';
import './ai.css';
/** API key entry: write-only. The value goes to the relay and is cleared; only "saved" is ever shown (NFR-SEC-001/005/012). */
function KeyField({ name, label, testId }: { name: SecretName; label: string; testId: string }) {
  const { t } = useI18n();
  const saved = useAiSettings((s) => (name === 'foundryKey' ? s.foundryKeySaved : s.speechKeySaved));
  const reachable = useAiSettings((s) => s.relayReachable);
  const saveKey = useAiSettings((s) => s.saveKey);
  const deleteKey = useAiSettings((s) => s.deleteKey);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<'saved' | 'deleted' | 'failed' | null>(null);
  const showInput = !saved || editing;

  const save = async () => {
    const v = value;
    setValue('');
    const ok = v.trim() !== '' && (await saveKey(name, v));
    setMessage(ok ? 'saved' : 'failed');
    if (ok) setEditing(false);
  };
  const remove = async () => {
    const ok = await deleteKey(name);
    setMessage(ok ? 'deleted' : 'failed');
    setEditing(false);
  };

  return (
    <div className="ai-key" data-testid={testId}>
      <p className="ai-status">
        <span>{label}</span>
        <Badge appearance="tint" color={saved ? 'success' : 'informative'} data-testid={`${testId}-state`}>{saved ? t('ai.key.saved') : t('ai.key.notSaved')}</Badge>
      </p>
      {showInput && (
        <div className="ai-row">
          <Field label={t('ai.key.input', { name: label })} hint={t('ai.key.hint')}>
            <Input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(_, d) => setValue(d.value)} disabled={!reachable} data-testid={`${testId}-input`} />
          </Field>
          <Button appearance="primary" icon={<Key20Regular />} onClick={() => void save()} disabled={!reachable || value.trim() === ''} data-testid={`${testId}-save`}>{t('ai.key.save')}</Button>
          {editing && <Button onClick={() => { setEditing(false); setValue(''); }}>{t('ai.key.cancel')}</Button>}
        </div>
      )}
      {saved && !editing && (
        <div className="ai-row">
          <Button onClick={() => setEditing(true)} data-testid={`${testId}-change`}>{t('ai.key.change')}</Button>
          <Button icon={<Delete20Regular />} onClick={() => void remove()} data-testid={`${testId}-delete`}>{t('ai.key.delete')}</Button>
        </div>
      )}
      {message && <p role="status" className="muted">{t(`ai.key.msg.${message}`)}</p>}
    </div>
  );
}

function Meter({ label, ratio, level, testId }: { label: string; ratio: number; level: BudgetLevel; testId: string }) {
  const { t } = useI18n();
  return (
    <Field
      label={label}
      validationState={level === 'ok' ? 'none' : level === 'warn' ? 'warning' : 'error'}
      validationMessage={level === 'ok' ? undefined : t(`ai.level.${level}`)}
      data-testid={testId}
    >
      <ProgressBar value={Math.min(1, Math.max(0, ratio))} thickness="large" />
    </Field>
  );
}



/** FR-275 common connection, saved in the relay (endpoint, deployment, API version). The browser keeps a copy for display. */
function ConnectionActions() {
  const { t } = useI18n();
  const s = useAiSettings();
  const [message, setMessage] = useState<'saved' | 'deleted' | ConnectionSaveError | null>(null);
  const relay = s.relayConnection;
  const differs = relay !== null && (relay.endpoint !== s.endpoint.trim() || relay.deployment !== s.deployment.trim() || relay.apiVersion !== s.apiVersion.trim());
  const save = async () => {
    const r = await s.saveConnection();
    setMessage(r.ok ? 'saved' : r.error);
  };
  const remove = async () => {
    setMessage((await s.deleteConnection()) ? 'deleted' : 'failed');
  };
  return (
    <div className="ai-stack">
      <p className="ai-status" data-testid="ai-relay-connection">
        <span>{t('ai.conn.relayLabel')}</span>
        <Badge appearance="tint" color={relay ? 'success' : 'informative'}>{relay ? t('ai.conn.saved') : t('ai.conn.notSaved')}</Badge>
      </p>
      {differs && <p className="muted" data-testid="ai-relay-connection-differs">{t('ai.conn.differs', { endpoint: relay.endpoint, deployment: relay.deployment })}</p>}
      <div className="ai-row">
        <Button appearance="primary" icon={<PlugConnected20Regular />} onClick={() => void save()} disabled={!s.relayReachable} data-testid="ai-connection-save">{t('ai.conn.save')}</Button>
        <Button icon={<Delete20Regular />} onClick={() => void remove()} disabled={!s.relayReachable || (relay === null && s.endpoint === '' && s.deployment === '')} data-testid="ai-connection-delete">{t('ai.conn.delete')}</Button>
      </div>
      {message && <p role="status" className="muted" data-testid="ai-connection-msg">{t(`ai.conn.msg.${message}`)}</p>}
    </div>
  );
}

/** D-6 / P-01: a legacy Foundry record is read only; moving it is an explicit action, and live stays off. */
function LegacyPanel() {
  const { t } = useI18n();
  const s = useAiSettings();
  const [moved, setMoved] = useState(false);
  const legacy = readLegacyFoundry();
  const state = legacyState(legacy, { endpoint: s.endpoint, deployment: s.deployment, authMethod: s.authMethod });
  if (state.kind === 'none' || state.kind === 'commonOnly') {
    return moved ? <p role="status" className="muted" data-testid="ai-legacy-moved">{t('ai.legacy.moved')}</p> : null;
  }
  const l = state.legacy;
  return (
    <Panel title={t('ai.legacy.title')} testId="ai-legacy">
      <div className="ai-stack" data-state={state.kind}>
        <p>{t(`ai.legacy.state.${state.kind}`)}</p>
        <dl className="ai-dl">
          <dt>{t('ai.settings.endpoint')}</dt><dd>{l.endpoint || t('ai.legacy.empty')}</dd>
          <dt>{t('ai.settings.deployment')}</dt><dd>{l.deployment || t('ai.legacy.empty')}</dd>
          <dt>{t('ai.settings.auth')}</dt><dd>{t(`ai.auth.${l.authMethod}`)}</dd>
        </dl>
        {state.kind === 'differ' && (
          <p data-testid="ai-legacy-diff">{t('ai.legacy.diff', { fields: state.fields.map((f) => t(`ai.legacy.field.${f}`)).join(t('ai.listSep')) })}</p>
        )}
        {state.kind === 'legacyOnly' && (
          <div>
            <Button onClick={() => { s.update(copyLegacyPatch(l)); setMoved(true); }} data-testid="ai-legacy-move">{t('ai.legacy.move')}</Button>
          </div>
        )}
        {moved && <p role="status" className="muted" data-testid="ai-legacy-moved">{t('ai.legacy.moved')}</p>}
        <p className="muted">{t('ai.legacy.note')}</p>
      </div>
    </Panel>
  );
}

/** D-3: one monthly budget for the whole app (integer JPY ≥ 0). */
function BudgetInput() {
  const { t } = useI18n();
  const budget = useAiSettings((s) => s.monthlyBudgetJpy);
  const update = useAiSettings((s) => s.update);
  const [text, setText] = useState(String(budget));
  useEffect(() => setText(String(budget)), [budget]);
  const valid = parseBudget(text) !== null;
  return (
    <Field label={t('ai.usage.budget')} hint={t('ai.usage.budgetHint')} validationState={valid ? 'none' : 'error'} validationMessage={valid ? undefined : t('ai.usage.budgetInvalid')}>
      <Input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={text}
        onChange={(_, d) => {
          setText(d.value);
          const v = parseBudget(d.value);
          if (v !== null) update({ monthlyBudgetJpy: v });
        }}
        data-testid="ai-budget-input"
      />
    </Field>
  );
}

/** D-7: deleting records older than 13 months only on an explicit, confirmed action. */
function LedgerPrune({ onChange }: { onChange: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);
  const count = expiredUsageCount();
  const run = () => {
    setDeleted(deleteExpiredUsage());
    setConfirming(false);
    onChange();
  };
  return (
    <div className="ai-stack" data-testid="ai-ledger-prune">
      <p data-testid="ai-ledger-expired">{t('ai.ledger.expired', { count })}</p>
      <div>
        <Button icon={<Delete20Regular />} disabled={count === 0} onClick={() => setConfirming(true)} data-testid="ai-ledger-prune-button">{t('ai.ledger.delete')}</Button>
      </div>
      {deleted !== null && <p role="status" className="muted">{t('ai.ledger.deleted', { count: deleted })}</p>}
      <Dialog open={confirming} modalType="alert" onOpenChange={(_, d) => { if (!d.open) setConfirming(false); }}>
        <DialogSurface data-testid="ai-ledger-prune-confirm">
          <DialogBody>
            <DialogTitle>{t('ai.ledger.confirmTitle')}</DialogTitle>
            <DialogContent>
              <p>{t('ai.ledger.confirmBody', { count })}</p>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={run} data-testid="ai-ledger-prune-ok">{t('ai.ledger.delete')}</Button>
              <Button onClick={() => setConfirming(false)}>{t('ai.person.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/** FR-275/FR-282 connection, FR-132 live switch, C-03 table, FR-276/NFR-COST-001 usage, PARAM-130 prices, FR-167/168 speech, FR-182. */
export function AiSettingsScreen() {
  const { t, fmt } = useI18n();
  const s = useAiSettings();
  const refreshRelay = useAiSettings((x) => x.refreshRelay);
  const configured = isConfigured(s);
  const [ledgerVersion, setLedgerVersion] = useState(0);
  const usage = usageSummary(readLedger(), new Date(), s.monthlyBudgetJpy);
  const [check, setCheck] = useState<string[] | null>(null);
  const uses = Object.keys(C03_TABLE) as AiUse[];
  const live = liveReady(s) && uses.some((u) => isUseApproved(u));

  useEffect(() => {
    void refreshRelay();
  }, [refreshRelay]);

  const priceOk = parsePrice(s.priceInputPerM) !== null && parsePrice(s.priceOutputPerM) !== null;
  const tbd = (v: string) => (v === 'TBD' ? t('ai.c03.tbd') : v);

  return (
    <div className="screen ai-screen" data-ledger={ledgerVersion}>
      <PageHeader title={t('ai.nav.settings')} subtitle={t('ai.settings.subtitle')} />
      <D4Warning />
      {!s.relayReachable && (
        <MessageBar intent="warning" data-testid="ai-relay-unreachable"><MessageBarBody>{t('ai.relay.unreachable')}</MessageBarBody></MessageBar>
      )}
      <div className="grid-2">
        <Panel title={t('ai.settings.connection')} testId="ai-connection">
          <div className="ai-stack">
            <RadioGroup value={s.provider} onChange={(_, d) => s.update({ provider: d.value as AiProvider })} aria-labelledby="ai-lbl-provider">
              <span id="ai-lbl-provider" className="ai-label">{t('ai.settings.provider')}</span>
              <Radio value="foundry" label={t('ai.provider.foundry')} />
              <Radio value="copilotSdk" label={t('ai.provider.copilotSdk')} />
            </RadioGroup>
            {s.provider === 'copilotSdk' && <p className="muted">{t('ai.provider.copilotSdkNote')}</p>}
            <Field label={t('ai.settings.endpoint')} hint={t('ai.settings.endpointHint')}>
              <Input value={s.endpoint} onChange={(_, d) => s.update({ endpoint: d.value })} data-testid="ai-endpoint" />
            </Field>
            <Field label={t('ai.settings.deployment')}>
              <Input value={s.deployment} onChange={(_, d) => s.update({ deployment: d.value })} data-testid="ai-deployment" />
            </Field>
            <Field label={t('ai.settings.apiVersion')}>
              <Input value={s.apiVersion} onChange={(_, d) => s.update({ apiVersion: d.value })} data-testid="ai-api-version" />
            </Field>
            <RadioGroup value={s.authMethod} onChange={(_, d) => s.update({ authMethod: d.value as AuthMethod })} aria-labelledby="ai-lbl-auth">
              <span id="ai-lbl-auth" className="ai-label">{t('ai.settings.auth')}</span>
              <Radio value="apiKey" label={t('ai.auth.apiKey')} />
              <Radio value="entraId" label={t('ai.auth.entraId')} />
            </RadioGroup>
            {s.authMethod === 'entraId' && <p className="muted">{t('ai.auth.entraIdNote')}</p>}
            <ConnectionActions />
            <KeyField name="foundryKey" label={t('ai.key.foundry')} testId="ai-foundry-key" />
            <p className="ai-status" data-testid="ai-key-protection">
              <span>{t('ai.keyProtection.label')}</span>
              <Badge appearance="tint" color={s.keyProtection === 'dpapi' ? 'success' : 'informative'} data-protection={s.keyProtection ?? 'unknown'}>
                {s.keyProtection ? t(`ai.keyProtection.${s.keyProtection}`) : t('ai.keyProtection.unknown')}
              </Badge>
            </p>
            <p className="ai-status" data-testid="ai-configured">
              <span>{t('ai.settings.configuredLabel')}</span>
              <Badge appearance="tint" color={configured ? 'success' : 'informative'}>{configured ? t('ai.settings.configured') : t('ai.settings.notConfigured')}</Badge>
            </p>
          </div>
        </Panel>

        <Panel title={t('ai.settings.live')} testId="ai-live">
          <div className="ai-stack">
            <Switch checked={s.liveEnabled} onChange={(_, d) => s.update({ liveEnabled: d.checked })} label={t('ai.settings.liveSwitch')} data-testid="ai-live-switch" />
            <p className="muted">{t('ai.settings.liveNote')}</p>
            <p className="ai-status">
              <span>{t('ai.settings.state')}</span>
              <Badge appearance="filled" color={live ? 'success' : 'warning'} data-testid="ai-state">{live ? t('ai.settings.stateLive') : t('ai.mock.badge')}</Badge>
            </p>
            <div>
              <Button onClick={() => void relayAiCheck('connectionTest').then((r) => setCheck(r.reasons))} data-testid="ai-relay-check">{t('ai.settings.check')}</Button>
            </div>
            {check && <MockNotice reasons={check} />}
          </div>
        </Panel>
      </div>

      <LegacyPanel />

      <Panel title={t('ai.c03.title')} testId="ai-c03">
        <p className="muted">{t('ai.c03.lead')}</p>
        <div className="ai-table-wrap" tabIndex={0} role="region" aria-label={t('ai.c03.title')}>
          <table className="data-table">
            <caption className="visually-hidden">{t('ai.c03.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ai.c03.use')}</th>
                <th scope="col">{t('ai.c03.provider')}</th>
                <th scope="col">{t('ai.c03.data')}</th>
                <th scope="col">{t('ai.c03.condition')}</th>
                <th scope="col">{t('ai.c03.cost')}</th>
                <th scope="col">{t('ai.c03.questions')}</th>
                <th scope="col">{t('ai.c03.status')}</th>
              </tr>
            </thead>
            <tbody>
              {uses.map((u) => {
                const row = C03_TABLE[u];
                const ok = isApproved(row);
                return (
                  <tr key={u} data-use={u} data-approved={ok}>
                    <th scope="row">{t(`ai.use.${u}`)}</th>
                    <td>{row.provider === 'TBD' ? t('ai.c03.tbd') : t(`ai.provider.${row.provider}`)}</td>
                    <td lang={row.data === 'TBD' ? undefined : 'en'}>{tbd(row.data)}</td>
                    <td lang={row.enableCondition === 'TBD' ? undefined : 'en'}>{tbd(row.enableCondition)}</td>
                    <td>{row.costCapJpy === 'TBD' ? t('ai.c03.tbd') : fmt.yen(row.costCapJpy)}</td>
                    <td lang="en">{row.openQuestions.join(', ')}</td>
                    <td><Badge appearance="tint" color={ok ? 'success' : 'danger'}>{ok ? t('ai.c03.approved') : t('ai.c03.blocked')}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title={t('ai.usage.title')} testId="ai-usage">
          <div className="ai-stack">
            <p data-testid="ai-usage-daily">{t('ai.usage.daily', { used: usage.todayCalls, limit: usage.dailyLimit })}</p>
            <Meter label={t('ai.usage.month', { spent: fmt.yen(usage.monthSpentJpy), budget: fmt.yen(usage.monthBudgetJpy) })} ratio={usage.monthBudgetJpy > 0 ? usage.monthSpentJpy / usage.monthBudgetJpy : 1} level={usage.monthLevel} testId="ai-usage-month" />
            <p className="muted">{t('ai.usage.thresholds')}</p>
            <BudgetInput />
            <p className="muted">{t('ai.usage.mockFree')}</p>
            <p className="muted" data-testid="ai-usage-no-content">{t('ai.usage.noContent')}</p>
            <LedgerPrune onChange={() => setLedgerVersion((v) => v + 1)} />
          </div>
        </Panel>

        <Panel title={t('ai.price.title')} testId="ai-prices">
          <div className="ai-stack">
            <p className="muted">{t('ai.price.lead', { cap: fmt.yen(STORY_CAP_JPY), factor: STORY_SAFETY_FACTOR })}</p>
            <Field label={t('ai.price.input')}>
              <Input inputMode="decimal" value={s.priceInputPerM} onChange={(_, d) => s.update({ priceInputPerM: d.value })} data-testid="ai-price-input" />
            </Field>
            <Field label={t('ai.price.output')}>
              <Input inputMode="decimal" value={s.priceOutputPerM} onChange={(_, d) => s.update({ priceOutputPerM: d.value })} data-testid="ai-price-output" />
            </Field>
            {!priceOk && <p className="muted" data-testid="ai-price-missing">{t('ai.price.missing')}</p>}
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title={t('ai.speech.title')} testId="ai-speech">
          <div className="ai-stack">
            <p className="muted">{t('ai.speech.lead')}</p>
            <Field label={t('ai.speech.endpoint')}>
              <Input value={s.speechEndpoint} onChange={(_, d) => s.update({ speechEndpoint: d.value })} data-testid="ai-speech-endpoint" />
            </Field>
            <Field label={t('ai.speech.region')}>
              <Input value={s.speechRegion} onChange={(_, d) => s.update({ speechRegion: d.value })} data-testid="ai-speech-region" />
            </Field>
            <KeyField name="speechKey" label={t('ai.key.speech')} testId="ai-speech-key" />
          </div>
        </Panel>

        <Panel title={t('ai.media.title')} testId="ai-media">
          <div className="ai-stack">
            <Switch checked={false} disabled label={t('ai.media.speech')} />
            <Switch checked={false} disabled label={t('ai.media.vision')} />
            <p className="muted" data-testid="ai-media-blocked">{t('ai.media.blocked')}</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}