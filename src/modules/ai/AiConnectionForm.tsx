import { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody,
  Radio, RadioGroup, Select, Spinner, Switch,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Delete20Regular, Key20Regular, PersonKey20Regular, PlugConnected20Regular, Save20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { D4Warning } from './AiCommon.tsx';
import { RelayError, acceptWorkIqEula, pollWorkIqSignIn, startWorkIqSignIn, verifyWorkIq, type ConnectionSaveError, type SecretName, type WorkIqDeviceCode } from './relayClient.ts';
import { connectionTestPreflight, isConfigured, liveReady, parseBudget, providerPrices, useAiSettings, workIqReady, type AiProvider, type AuthMethod } from './settingsStore.ts';
import { DEFAULT_FOUNDRY_API_VERSION, foundryChatUrl, isFoundryV1, parseFoundryConnection, parseFoundryEndpoint } from '../../ai/foundry.ts';
import './ai.css';

/** API key entry: write-only. The value goes to the relay and is cleared; only "saved" is ever shown (NFR-SEC-001/005/012). */
export function KeyField({ name, label, testId }: { name: SecretName; label: string; testId: string }) {
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

/** FR-275 common connection, saved in the relay (endpoint, deployment, API version). The browser keeps a copy for display. */
export function ConnectionActions() {
  const { t } = useI18n();
  const s = useAiSettings();
  const [message, setMessage] = useState<'saved' | 'deleted' | ConnectionSaveError | null>(null);
  const [providerStatus, setProviderStatus] = useState<number | undefined>();
  const [testing, setTesting] = useState(false);
  const [consent, setConsent] = useState(false);
  const [validationRequested, setValidationRequested] = useState(false);
  const relay = s.relayConnection;
  const draft = parseFoundryConnection({
    endpoint: s.endpoint.trim(), deployment: s.deployment.trim(), apiVersion: s.apiVersion.trim() || DEFAULT_FOUNDRY_API_VERSION,
  }, true);
  const problem = draft.ok ? null : draft.error;
  const precheck = connectionTestPreflight(s);
  const blockers = [
    problem ? t(`ai.conn.msg.${problem}`) : null,
    !s.relayReachable ? t('ai.relay.unreachable') : null,
    s.authMethod !== 'apiKey' ? t('ai.auth.entraIdNote') : null,
    !s.foundryKeySaved ? t('ai.conn.msg.keyMissing') : null,
    !precheck.budget.allowed ? t('ai.conn.msg.budget') : null,
    !consent ? t('ai.conn.msg.consentRequired') : null,
  ].filter((reason) => reason !== null);
  const [, refreshBudget] = useState(0);
  const coolingDown = precheck.budget.reasons.includes('tooSoon');
  useEffect(() => {
    if (!coolingDown) return;
    const timer = setTimeout(() => refreshBudget((v) => v + 1), 5_000);
    return () => clearTimeout(timer);
  }, [coolingDown]);
  const differs = relay !== null && (!draft.ok || relay.endpoint !== draft.value.endpoint || relay.deployment !== draft.value.deployment || relay.apiVersion !== draft.value.apiVersion);
  useEffect(() => {
    setMessage(null);
    setProviderStatus(undefined);
    setConsent(false);
  }, [s.endpoint, s.deployment, s.apiVersion, s.authMethod, s.monthlyBudgetJpy]);
  const save = async () => {
    if (testing) return;
    setMessage(null);
    setProviderStatus(undefined);
    setValidationRequested(true);
    if (blockers.length > 0) return;
    setValidationRequested(false);
    setTesting(true);
    try {
      const r = await s.saveConnection();
      setMessage(r.ok ? 'saved' : r.error);
      setProviderStatus(r.ok ? undefined : r.providerStatus);
    } catch {
      setMessage('failed');
    } finally {
      setTesting(false);
      setConsent(false);
    }
  };
  const remove = async () => {
    setMessage((await s.deleteConnection()) ? 'deleted' : 'failed');
  };
  return (
    <div className="ai-stack">
      <p className="ai-status" data-testid="ai-relay-connection">
        <span>{t('ai.conn.relayLabel')}</span>
        <Badge appearance="tint" color={s.connectionVerifiedAt ? 'success' : 'informative'}>{s.connectionVerifiedAt ? t('ai.conn.verified') : relay ? t('ai.conn.unverified') : t('ai.conn.notSaved')}</Badge>
      </p>
      {s.connectionVerifiedAt && <p className="muted" data-testid="ai-connection-verified-at">{t('ai.conn.verifiedAt', { at: s.connectionVerifiedAt })}</p>}
      {differs && <p className="muted" data-testid="ai-relay-connection-differs">{t('ai.conn.differs', { endpoint: relay.endpoint, deployment: relay.deployment })}</p>}
      {problem && <p role="alert" data-testid="ai-connection-validation">{t(`ai.conn.msg.${problem}`)}</p>}
      {draft.ok && <p className="muted" data-testid="ai-connection-destination">{t('ai.conn.destination', { url: foundryChatUrl(draft.value) })}</p>}
      <p className="muted" data-testid="ai-connection-test-info">{t('ai.conn.testInfo')}</p>
      <p className="muted" data-testid="ai-connection-test-cost">{t('ai.cost.unknown')}</p>
      {!s.foundryKeySaved && <p className="muted">{t('ai.conn.msg.keyMissing')}</p>}
      {!precheck.budget.allowed && <p role="alert">{t('ai.conn.msg.budget')}</p>}
      <Checkbox checked={consent} onChange={(_, d) => setConsent(d.checked === true)} disabled={testing} label={t('ai.conn.consent')} data-testid="ai-connection-consent" />
      {validationRequested && blockers.length > 0 && (
        <MessageBar intent="error" data-testid="ai-connection-blockers">
          <MessageBarBody>
            <p>{t('ai.conn.checkBeforeTest')}</p>
            <ul>{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </MessageBarBody>
        </MessageBar>
      )}
      <div className="ai-row">
        <Button appearance="primary" icon={testing ? <Spinner size="tiny" /> : <PlugConnected20Regular />} onClick={() => void save()} disabled={testing} data-testid="ai-connection-save">{t(testing ? 'ai.conn.testing' : 'ai.conn.save')}</Button>
        <Button icon={<Delete20Regular />} onClick={() => void remove()} disabled={testing || !s.relayReachable || (relay === null && s.endpoint === '' && s.deployment === '')} data-testid="ai-connection-delete">{t('ai.conn.delete')}</Button>
      </div>
      {message && <MessageBar intent={message === 'saved' || message === 'deleted' ? 'success' : 'error'} data-testid="ai-connection-msg"><MessageBarBody>{t(`ai.conn.msg.${message}`)}{providerStatus !== undefined && ` (HTTP ${providerStatus})`}</MessageBarBody></MessageBar>}
    </div>
  );
}

/** D-3: one monthly budget for the whole app (integer JPY ≥ 0). */
export function BudgetInput() {
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

export function ProviderChoice() {
  const { t } = useI18n();
  const provider = useAiSettings((s) => s.provider);
  const update = useAiSettings((s) => s.update);
  return (
    <RadioGroup value={provider} onChange={(_, d) => update({ provider: d.value as AiProvider })} aria-labelledby="ai-lbl-provider" data-testid="ai-provider">
      <span id="ai-lbl-provider" className="ai-label">{t('ai.settings.provider')}</span>
      <Radio value="foundry" label={t('ai.provider.foundry')} data-testid="ai-provider-foundry" />
      <Radio value="copilotSdk" label={t('ai.provider.copilotSdk')} data-testid="ai-provider-copilot" />
    </RadioGroup>
  );
}

/** Foundry endpoint, deployment, API version, authentication and key (FR-275). */
export function FoundryFields() {
  const { t } = useI18n();
  const s = useAiSettings();
  const endpoint = parseFoundryEndpoint(s.endpoint, true);
  const v1 = endpoint.ok && isFoundryV1(endpoint.value);
  return (
    <>
      <Field label={t('ai.settings.endpoint')} hint={t('ai.settings.endpointHint')}>
        <Input value={s.endpoint} onChange={(_, d) => s.update({ endpoint: d.value })} data-testid="ai-endpoint" />
      </Field>
      <Field label={t('ai.settings.deployment')} hint={t('ai.settings.deploymentHint')}>
        <Input value={s.deployment} onChange={(_, d) => s.update({ deployment: d.value })} data-testid="ai-deployment" />
      </Field>
      <Field label={t('ai.settings.apiVersion')} hint={v1 ? t('ai.settings.v1Hint') : undefined}>
        <Input value={s.apiVersion} onChange={(_, d) => s.update({ apiVersion: d.value })} disabled={v1} data-testid="ai-api-version" />
      </Field>
      <RadioGroup value={s.authMethod} onChange={(_, d) => s.update({ authMethod: d.value as AuthMethod })} aria-labelledby="ai-lbl-auth">
        <span id="ai-lbl-auth" className="ai-label">{t('ai.settings.auth')}</span>
        <Radio value="apiKey" label={t('ai.auth.apiKey')} />
        <Radio value="entraId" label={t('ai.auth.entraId')} />
      </RadioGroup>
      {s.authMethod === 'entraId' && <p className="muted">{t('ai.auth.entraIdNote')}</p>}
      <KeyField name="foundryKey" label={t('ai.key.foundry')} testId="ai-foundry-key" />
      <ConnectionActions />
      <p className="ai-status" data-testid="ai-key-protection">
        <span>{t('ai.keyProtection.label')}</span>
        <Badge appearance="tint" color={s.keyProtection === 'dpapi' ? 'success' : 'informative'} data-protection={s.keyProtection ?? 'unknown'}>
          {s.keyProtection ? t(`ai.keyProtection.${s.keyProtection}`) : t('ai.keyProtection.unknown')}
        </Badge>
      </p>
      <WorkIqSettings />
    </>
  );
}

const WORKIQ_ERRORS = [
  'invalidSettings', 'notConfigured', 'notSignedIn', 'signInNotStarted', 'signInExpired', 'signInDeclined', 'authFailed', 'workiqForbidden', 'workiqBusy',
  'workiqTimeout', 'workiqUnavailable', 'badWorkiqResponse', 'workiqNoGrounding', 'outboundNotAllowed', 'relayUnreachable', 'workiqEulaRequired', 'workiqCliMissing',
] as const;
type WorkIqMessage = (typeof WORKIQ_ERRORS)[number] | 'failed';
const workIqMessage = (code: string | undefined): WorkIqMessage => ((WORKIQ_ERRORS as readonly string[]).includes(code ?? '') ? (code as WorkIqMessage) : 'failed');
export const WORKIQ_EULA_URL = 'https://github.com/microsoft/work-iq';

/**
 * D-14: Microsoft Work IQ for the customer pack, Microsoft Foundry only. Two routes, both run by the relay:
 * Microsoft's Work IQ CLI on this PC (its own sign-in; no app registration or admin consent in BAS), or the user's own
 * public-client app registration (delegated WorkIQAgent.Ask) signed in by device code. This screen never sees a token.
 */
export function WorkIqSettings() {
  const { t } = useI18n();
  const workiq = useAiSettings((s) => s.workiq);
  const reachable = useAiSettings((s) => s.relayReachable);
  const budget = useAiSettings((s) => s.monthlyBudgetJpy);
  const { saveWorkIq, deleteWorkIq, refreshRelay } = useAiSettings.getState();
  const [route, setRoute] = useState<'cli' | 'app'>(workiq?.method ?? 'cli');
  const [tenantId, setTenantId] = useState(workiq?.tenantId ?? '');
  const [clientId, setClientId] = useState(workiq?.clientId ?? '');
  const [code, setCode] = useState<WorkIqDeviceCode | null>(null);
  const [message, setMessage] = useState<'saved' | 'savedCli' | 'deleted' | 'signedIn' | 'verified' | 'eulaAccepted' | WorkIqMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [consent, setConsent] = useState(false);
  const [eulaConsent, setEulaConsent] = useState(false);
  const polling = useRef(0);

  useEffect(() => {
    if (workiq) setRoute(workiq.method);
    setTenantId((v) => v || workiq?.tenantId || '');
    setClientId((v) => v || workiq?.clientId || '');
  }, [workiq?.method, workiq?.tenantId, workiq?.clientId]);
  useEffect(() => () => { polling.current++; }, []);
  useEffect(() => { setConsent(false); setMessage(null); }, [tenantId, clientId, route]);

  const appChanged = workiq?.method !== 'app' || workiq.tenantId !== tenantId.trim().toLowerCase() || workiq.clientId !== clientId.trim().toLowerCase();
  const changed = route === 'cli' ? workiq?.method !== 'cli' : appChanged;
  const save = async () => {
    setBusy(true);
    const r = await saveWorkIq(route === 'cli' ? { method: 'cli' } : { method: 'app', tenantId, clientId });
    setBusy(false);
    setCode(null);
    setMessage(r.ok ? (route === 'cli' ? 'savedCli' : 'saved') : workIqMessage(r.error));
  };
  const acceptEula = async () => {
    if (!eulaConsent) return;
    setBusy(true);
    setMessage(null);
    try {
      await acceptWorkIqEula();
      setMessage('eulaAccepted');
    } catch (error) {
      setMessage(workIqMessage(error instanceof RelayError ? error.code : undefined));
    } finally {
      setBusy(false);
      setEulaConsent(false);
    }
  };
  const remove = async () => {
    polling.current++;
    setCode(null);
    setMessage((await deleteWorkIq()) ? 'deleted' : 'failed');
  };
  const signIn = async () => {
    const run = ++polling.current;
    setMessage(null);
    let started: WorkIqDeviceCode;
    try {
      started = await startWorkIqSignIn();
    } catch (error) {
      setMessage(workIqMessage(error instanceof RelayError ? error.code : undefined));
      return;
    }
    setCode(started);
    let wait = started.interval;
    while (polling.current === run) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (polling.current !== run) return;
      try {
        const r = await pollWorkIqSignIn();
        if (r.status === 'signedIn') {
          setCode(null);
          setMessage('signedIn');
          await refreshRelay();
          return;
        }
        wait = r.interval;
      } catch (error) {
        if (polling.current !== run) return;
        setCode(null);
        setMessage(workIqMessage(error instanceof RelayError ? error.code : undefined));
        return;
      }
    }
  };

  const check = async () => {
    if (!consent || checking || budget <= 0) return;
    setChecking(true);
    setMessage(null);
    try {
      await verifyWorkIq();
      setMessage('verified');
    } catch (error) {
      setMessage(workIqMessage(error instanceof RelayError ? error.code : undefined));
    } finally {
      await refreshRelay();
      setChecking(false);
      setConsent(false);
    }
  };

  const cliSaved = workiq?.method === 'cli';
  const canVerify = cliSaved ? route === 'cli' : workiq?.signedIn === true;
  return (
    <section className="ai-stack" aria-labelledby="ai-workiq-title" data-testid="ai-workiq">
      <h3 id="ai-workiq-title" className="ai-h3">{t('ai.workiq.title')}</h3>
      <p className="muted">{t('ai.workiq.lead')}</p>
      <p id="ai-workiq-lbl-route" className="ai-label">{t('ai.workiq.route')}</p>
      <RadioGroup value={route} onChange={(_, d) => setRoute(d.value === 'app' ? 'app' : 'cli')} aria-labelledby="ai-workiq-lbl-route" disabled={!reachable || busy || checking} data-testid="ai-workiq-route">
        <Radio value="cli" label={t('ai.workiq.route.cli')} data-testid="ai-workiq-route-cli" />
        <Radio value="app" label={t('ai.workiq.route.app')} data-testid="ai-workiq-route-app" />
      </RadioGroup>
      <p className="ai-status" data-testid="ai-workiq-state">
        <span>{t('ai.workiq.state')}</span>
        <Badge appearance="tint" color={workiq?.signedIn ? 'success' : 'informative'}>
          {workiq === null ? t('ai.conn.notSaved')
            : cliSaved ? t(workiq.verifiedAt ? 'ai.workiq.cliReady' : 'ai.workiq.cliSaved')
              : workiq.signedIn ? t('ai.workiq.signedIn', { account: workiq.account ?? '—' }) : t('ai.workiq.notSignedIn')}
        </Badge>
      </p>
      {route === 'cli' ? (
        <>
          <p className="muted">{t('ai.workiq.cliInfo')}</p>
          <div className="ai-row">
            <Button appearance="primary" icon={<Save20Regular />} onClick={() => void save()} disabled={!reachable || busy || checking || !changed} data-testid="ai-workiq-save">
              {t('ai.workiq.saveCli')}
            </Button>
            <Button icon={<Delete20Regular />} onClick={() => void remove()} disabled={!reachable || busy || checking || workiq === null} data-testid="ai-workiq-delete">{t('ai.workiq.delete')}</Button>
          </div>
          {cliSaved && (
            <div className="ai-stack" data-testid="ai-workiq-eula">
              <p className="muted">
                {t('ai.workiq.eulaInfo')}{' '}
                <a href={WORKIQ_EULA_URL} target="_blank" rel="noopener noreferrer">{WORKIQ_EULA_URL}</a>
              </p>
              <Checkbox checked={eulaConsent} onChange={(_, d) => setEulaConsent(d.checked === true)} disabled={busy || checking} label={t('ai.workiq.eulaConsent')} data-testid="ai-workiq-eula-consent" />
              <Button icon={busy ? <Spinner size="tiny" /> : undefined} onClick={() => void acceptEula()} disabled={!reachable || busy || checking || !eulaConsent} data-testid="ai-workiq-eula-accept">
                {t('ai.workiq.eulaAccept')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted">{t('ai.workiq.appInfo')}</p>
          <Field label={t('ai.workiq.tenantId')} hint={t('ai.workiq.tenantHint')}>
            <Input value={tenantId} spellCheck={false} onChange={(_, d) => setTenantId(d.value)} disabled={!reachable || checking} data-testid="ai-workiq-tenant" />
          </Field>
          <Field label={t('ai.workiq.clientId')} hint={t('ai.workiq.clientHint')}>
            <Input value={clientId} spellCheck={false} onChange={(_, d) => setClientId(d.value)} disabled={!reachable || checking} data-testid="ai-workiq-client" />
          </Field>
          <div className="ai-row">
            <Button appearance="primary" icon={<Save20Regular />} onClick={() => void save()} disabled={!reachable || busy || checking || !changed || !tenantId.trim() || !clientId.trim()} data-testid="ai-workiq-save">
              {t('ai.workiq.save')}
            </Button>
            <Button icon={<PersonKey20Regular />} onClick={() => void signIn()} disabled={!reachable || busy || checking || workiq?.method !== 'app' || changed || code !== null} data-testid="ai-workiq-signin">
              {t(workiq?.signedIn ? 'ai.workiq.signInAgain' : 'ai.workiq.signIn')}
            </Button>
            <Button icon={<Delete20Regular />} onClick={() => void remove()} disabled={!reachable || busy || checking || workiq === null} data-testid="ai-workiq-delete">{t('ai.workiq.delete')}</Button>
          </div>
        </>
      )}
      {code && (
        <MessageBar intent="info" data-testid="ai-workiq-code">
          <MessageBarBody>
            {t('ai.workiq.codeIntro')}{' '}
            <a href={code.verificationUri} target="_blank" rel="noopener noreferrer">{code.verificationUri}</a>{' '}
            <strong data-testid="ai-workiq-usercode">{code.userCode}</strong>
            <span className="muted"> {t('ai.workiq.codeWaiting')}</span>
          </MessageBarBody>
        </MessageBar>
      )}
      {message && (
        <p role="status" className="muted" data-testid="ai-workiq-msg">{t(`ai.workiq.msg.${message}`)}</p>
      )}
      <p className="ai-status" data-testid="ai-workiq-verification">
        <Badge appearance="tint" color={workiq?.signedIn && workiq.verifiedAt ? 'success' : 'warning'}>
          {workiq?.signedIn && workiq.verifiedAt ? t('ai.workiq.verifiedAt', { at: workiq.verifiedAt }) : t('ai.workiq.unverified')}
        </Badge>
      </p>
      <p className="muted">{t('ai.workiq.testInfo')}</p>
      <Checkbox checked={consent} onChange={(_, d) => setConsent(d.checked === true)} disabled={checking} label={t('ai.workiq.testConsent')} data-testid="ai-workiq-consent" />
      {budget <= 0 && <p role="alert">{t('ai.conn.msg.budget')}</p>}
      <Button icon={checking ? <Spinner size="tiny" /> : <PlugConnected20Regular />} onClick={() => void check()} disabled={!reachable || busy || checking || changed || !canVerify || !consent || budget <= 0 || code !== null} data-testid="ai-workiq-check">
        {t(checking ? 'ai.workiq.testing' : 'ai.workiq.test')}
      </Button>
    </section>
  );
}

/**
 * D-12: GitHub Copilot through the relay's Copilot SDK. The sign-in belongs to the Copilot CLI (`copilot` → `/login`);
 * this app only reads whether it is signed in and which models it offers, and saves the chosen model in the relay.
 */
export function CopilotSettings() {
  const { t, fmt } = useI18n();
  const status = useAiSettings((s) => s.copilotStatus);
  const savedModel = useAiSettings((s) => s.copilotModel);
  const reachable = useAiSettings((s) => s.relayReachable);
  const { checkCopilot, saveCopilotModel, deleteCopilot } = useAiSettings.getState();
  const [checking, setChecking] = useState(false);
  const [choice, setChoice] = useState(savedModel ?? '');
  const [message, setMessage] = useState<'saved' | 'deleted' | 'failed' | null>(null);

  useEffect(() => setChoice((c) => c || savedModel || ''), [savedModel]);
  const check = async () => {
    setChecking(true);
    const r = await checkCopilot();
    setChecking(false);
    if (!choice && r.models.length) setChoice(r.model ?? r.models[0]!.id);
  };
  const models = status?.models ?? [];
  const signedIn = status?.authenticated === true;
  const multiplierOf = (id: string) => models.find((m) => m.id === id)?.multiplier;

  return (
    <div className="ai-stack" data-testid="ai-copilot">
      <p className="muted">{t('ai.copilot.lead')}</p>
      <div className="ai-row">
        <Button icon={checking ? <Spinner size="tiny" /> : <ArrowSync20Regular />} onClick={() => void check()} disabled={!reachable || checking} data-testid="ai-copilot-check">
          {t('ai.copilot.check')}
        </Button>
      </div>
      <p className="ai-status" data-testid="ai-copilot-signin">
        <span>{t('ai.copilot.signIn')}</span>
        <Badge appearance="tint" color={signedIn ? 'success' : status ? 'warning' : 'informative'}>
          {status === null ? t('ai.copilot.unchecked') : signedIn ? t('ai.copilot.signedIn', { login: status.login ?? '—' }) : t(`ai.copilot.err.${copilotErrorKey(status.error)}`)}
        </Badge>
      </p>
      {status && !signedIn && <p className="muted" data-testid="ai-copilot-howto">{t('ai.copilot.howTo')}</p>}
      {signedIn && (
        <Field label={t('ai.copilot.model')} hint={t('ai.copilot.modelHint')}>
          <Select value={choice} onChange={(_, d) => setChoice(d.value)} data-testid="ai-copilot-model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.multiplier === null ? m.name : t('ai.copilot.modelOption', { name: m.name, multiplier: fmt.number(m.multiplier) })}</option>
            ))}
          </Select>
        </Field>
      )}
      <p className="ai-status" data-testid="ai-copilot-saved">
        <span>{t('ai.copilot.savedModel')}</span>
        <Badge appearance="tint" color={savedModel ? 'success' : 'informative'}>{savedModel ?? t('ai.conn.notSaved')}</Badge>
        {savedModel && multiplierOf(savedModel) != null && <span className="muted">{t('ai.copilot.multiplier', { multiplier: fmt.number(multiplierOf(savedModel)!) })}</span>}
      </p>
      {signedIn && savedModel && multiplierOf(savedModel) == null && <p className="muted" data-testid="ai-copilot-multiplier-unknown">{t('ai.copilot.multiplierUnknown')}</p>}
      <div className="ai-row">
        <Button
          appearance="primary"
          icon={<Save20Regular />}
          disabled={!reachable || !signedIn || !choice}
          onClick={() => void saveCopilotModel(choice).then((ok) => setMessage(ok ? 'saved' : 'failed'))}
          data-testid="ai-copilot-save"
        >
          {t('ai.copilot.save')}
        </Button>
        <Button icon={<Delete20Regular />} disabled={!reachable || !savedModel} onClick={() => void deleteCopilot().then((ok) => setMessage(ok ? 'deleted' : 'failed'))} data-testid="ai-copilot-delete">
          {t('ai.copilot.delete')}
        </Button>
      </div>
      {message && <p role="status" className="muted" data-testid="ai-copilot-msg">{t(`ai.copilot.msg.${message}`)}</p>}
    </div>
  );
}

const COPILOT_ERRORS = ['notSignedIn', 'sdkUnavailable', 'startFailed', 'providerError', 'relayUnreachable'] as const;
function copilotErrorKey(code: string | null): (typeof COPILOT_ERRORS)[number] {
  return (COPILOT_ERRORS as readonly string[]).includes(code ?? '') ? (code as (typeof COPILOT_ERRORS)[number]) : code === null ? 'notSignedIn' : 'providerError';
}

/** Foundry cost notice or Copilot premium-request pricing (D-12). */
export function PriceFields() {
  const { t } = useI18n();
  const s = useAiSettings();
  const ok = providerPrices(s) !== null;
  return (
    <div className="ai-stack">
      {s.provider === 'copilotSdk' ? (
        <Field label={t('ai.price.perRequest')} hint={t('ai.price.perRequestHint')}>
          <Input inputMode="decimal" value={s.copilotPricePerRequest} onChange={(_, d) => s.update({ copilotPricePerRequest: d.value })} data-testid="ai-price-request" />
        </Field>
      ) : <p className="muted" data-testid="ai-foundry-cost-note">{t('ai.cost.unknown')}</p>}
      {s.provider === 'copilotSdk' && !ok && <p className="muted" data-testid="ai-price-missing">{t('ai.price.missing')}</p>}
    </div>
  );
}

/** Readiness of the chosen provider for live sends, as one line (used by the settings dialog and the pack generator). */
export function AiReadiness() {
  const { t } = useI18n();
  const s = useAiSettings();
  const items: ['relay' | 'configured' | 'prices' | 'live' | 'workiq', boolean][] = [
    ['relay', s.relayReachable],
    ['configured', isConfigured(s)],
    ['live', s.liveEnabled],
  ];
  if (s.provider === 'copilotSdk') items.splice(2, 0, ['prices', providerPrices(s) !== null]);
  else items.splice(2, 0, ['workiq', workIqReady(s)]);
  return (
    <ul className="ai-readiness" data-testid="ai-readiness">
      {items.map(([key, ok]) => (
        <li key={key} data-ok={ok}>
          <Badge appearance="tint" color={ok ? 'success' : 'warning'}>{ok ? t('ai.ready.ok') : t('ai.ready.missing')}</Badge>
          <span>{t(key === 'configured' && s.provider === 'foundry' ? 'ai.ready.verified' : `ai.ready.${key}`)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The settings needed before any live send, in one column: provider, its connection, prices, budget and the live switch. */
export function AiQuickSettings() {
  const { t } = useI18n();
  const s = useAiSettings();
  const refreshRelay = useAiSettings((x) => x.refreshRelay);
  useEffect(() => {
    void refreshRelay();
  }, [refreshRelay]);
  return (
    <div className="ai-stack ai-quick" data-testid="ai-quick-settings">
      <D4Warning />
      {!s.relayReachable && (
        <MessageBar intent="warning" data-testid="ai-relay-unreachable"><MessageBarBody>{t('ai.relay.unreachable')}</MessageBarBody></MessageBar>
      )}
      <ProviderChoice />
      {s.provider === 'copilotSdk' ? <CopilotSettings /> : <FoundryFields />}
      {s.provider === 'copilotSdk' && <><h3 className="ai-h3">{t('ai.price.titleCopilot')}</h3><PriceFields /></>}
      <BudgetInput />
      <Switch checked={s.liveEnabled} onChange={(_, d) => s.update({ liveEnabled: d.checked })} label={t('ai.settings.liveSwitch')} data-testid="ai-live-switch" />
      <p className="muted">{t('ai.settings.liveNote')}</p>
      <AiReadiness />
      <p className="ai-status">
        <span>{t('ai.settings.state')}</span>
        <Badge appearance="filled" color={liveReady(s) ? 'success' : 'warning'} data-testid="ai-state">{liveReady(s) ? t('ai.settings.stateLive') : t('ai.mock.badge')}</Badge>
      </p>
    </div>
  );
}

/** The AI settings as a dialog, for screens outside the app shell (launch screen, project management). */
export function AiSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className="ai-settings-dialog" data-testid="ai-settings-dialog">
        <DialogBody>
          <DialogTitle>{t('ai.nav.settings')}</DialogTitle>
          <DialogContent>
            <AiQuickSettings />
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose} data-testid="ai-settings-dialog-close">{t('ai.dialog.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
