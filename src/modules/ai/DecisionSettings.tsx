import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Select, Spinner } from '@fluentui/react-components';
import { Delete20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { DECISION_MODEL, DECISION_PRICE, decisionEndpointFromChat, decisionUrl, validateDecisionConnection } from '../../ai/decision.ts';
import { inspectEntraInstance, listEntraInstances, type DecisionInput, type DecisionSaveError, type FoundryInstanceDetail } from './relayClient.ts';
import { isDecisionReady, useAiSettings } from './settingsStore.ts';
import './ai.css';

/** Codes with Decision-specific wording; the rest reuse the Foundry connection messages. */
const OWN_ERRORS = ['invalidBody', 'invalidEndpoint', 'invalidKey', 'keyMissing', 'unauthorized', 'deploymentNotFound', 'invalidApiRequest', 'badProviderResponse'] as const;
type OwnError = (typeof OWN_ERRORS)[number];
const isOwn = (code: string): code is OwnError => (OWN_ERRORS as readonly string[]).includes(code);
type Message = { kind: 'saved' | 'deleted' } | { kind: 'error'; code: DecisionSaveError; providerStatus?: number };

/**
 * D-37: the optional Microsoft Foundry Decision connection. It runs on the Foundry resource, sign-in and key of the chat
 * connection above — nothing is chosen or authenticated twice — and only asks for the Decision deployment name. It is saved
 * only after a synthetic test request succeeds in the relay. When unset, KPI/OKR drafting works as before.
 */
export function DecisionSettings() {
  const { t } = useI18n();
  const s = useAiSettings();
  const saved = s.decision;
  const chat = s.relayConnection;
  const auth = chat?.auth === 'entraId' ? 'entraId' : 'apiKey';
  const tenantId = chat?.tenantId ?? '';
  const endpoint = decisionEndpointFromChat(chat?.endpoint) ?? '';
  const [deployment, setDeployment] = useState(saved?.deployment ?? 'decision-1-1');
  const [deployments, setDeployments] = useState<FoundryInstanceDetail['deployments']>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [validationRequested, setValidationRequested] = useState(false);
  const signedIn = s.entra?.signedIn === true;

  useEffect(() => {
    if (saved) setDeployment(saved.deployment);
  }, [saved?.deployment]);

  useEffect(() => {
    setConsent(false);
  }, [endpoint, deployment, auth, tenantId]);

  // The deployments of the chat connection's resource, so the Decision one can be picked rather than typed.
  useEffect(() => {
    setDeployments([]);
    if (auth !== 'entraId' || !signedIn || !endpoint || !tenantId) return;
    let active = true;
    const signal = AbortSignal.timeout(90_000);
    void (async () => {
      const host = new URL(endpoint).hostname.split('.')[0];
      const instance = (await listEntraInstances(tenantId, signal)).find((i) => i.endpoint !== null && new URL(i.endpoint).hostname.split('.')[0] === host);
      if (!instance) return;
      const detail = await inspectEntraInstance(instance.id, instance.tenantId, signal, 'decision');
      if (!active) return;
      setDeployments(detail.deployments);
      setDeployment((current) => detail.deployments.some((d) => d.name === current) ? current : (detail.deployments[0]?.name ?? current));
    })().catch(() => undefined);
    return () => { active = false; };
  }, [auth, signedIn, endpoint, tenantId]);

  if (!s.relayReachable) return <p className="muted" data-testid="ai-decision-unreachable">{t('ai.decision.needsRelay')}</p>;

  const draft: DecisionInput = auth === 'entraId' ? { endpoint, deployment: deployment.trim(), auth, tenantId } : { endpoint, deployment: deployment.trim() };
  const checked = validateDecisionConnection(draft);
  const blockers = [
    !endpoint ? t('ai.decision.needsChat') : null,
    endpoint && !checked.ok ? t(isOwn(checked.error) ? `ai.decision.err.${checked.error}` : `ai.conn.msg.${checked.error}`) : null,
    endpoint && auth === 'entraId' && !signedIn ? t('ai.conn.msg.notSignedIn') : null,
    endpoint && auth === 'apiKey' && !s.foundryKeySaved ? t('ai.decision.err.keyMissing') : null,
    !consent ? t('ai.decision.consentRequired') : null,
  ].filter((reason) => reason !== null);
  const showBlockers = validationRequested && blockers.length > 0;
  const ready = isDecisionReady(s);

  const testAndSave = async () => {
    setMessage(null);
    setValidationRequested(true);
    if (blockers.length > 0 || busy) return;
    setValidationRequested(false);
    setBusy(true);
    try {
      const r = await s.saveDecision(draft);
      setMessage(r.ok ? { kind: 'saved' } : { kind: 'error', code: r.error, ...(r.providerStatus ? { providerStatus: r.providerStatus } : {}) });
    } finally {
      setConsent(false);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await s.deleteDecision();
      setMessage(r.ok ? { kind: 'deleted' } : { kind: 'error', code: r.error });
    } finally {
      setBusy(false);
    }
  };
  const errorText = (code: DecisionSaveError) => code === 'signInPending' || code === 'signInFailed'
    ? t(`ai.entra.err.${code}`) : t(isOwn(code) ? `ai.decision.err.${code}` : `ai.conn.msg.${code}`);

  return (
    <div className="ai-stack" data-testid="ai-decision">
      <p className="muted">{t('ai.decision.lead', { model: DECISION_MODEL })}</p>
      <p className="muted" data-testid="ai-decision-price">{t('ai.decision.price', { price: DECISION_PRICE.jpyPerMTokens })}</p>
      <p className="ai-status" data-testid="ai-decision-state">
        <span>{t('ai.decision.state')}</span>
        <Badge appearance="tint" color={ready ? 'success' : saved?.verifiedAt ? 'warning' : 'informative'} data-testid="ai-decision-badge">
          {t(ready ? 'ai.decision.ready' : saved?.verifiedAt ? 'ai.decision.waitingLive' : 'ai.decision.off')}
        </Badge>
      </p>
      {saved && <p className="muted" data-testid="ai-decision-saved">{`${saved.endpoint} / ${saved.deployment}`}</p>}
      <p className="muted" data-testid="ai-decision-shared">{t(endpoint ? 'ai.decision.shared' : 'ai.decision.needsChat')}</p>
      {endpoint && (
        <Field label={t('ai.decision.deployment')}>
          {deployments.length > 0 ? (
            <Select value={deployment} onChange={(_, d) => setDeployment(d.value)} disabled={busy} data-testid="ai-decision-deployment">
              {!deployments.some((x) => x.name === deployment) && <option value={deployment}>{deployment}</option>}
              {deployments.map((x) => <option key={x.name} value={x.name}>{`${x.name} (${x.model}${x.version ? ` ${x.version}` : ''}, ${x.sku})`}</option>)}
            </Select>
          ) : (
            <Input value={deployment} onChange={(_, d) => setDeployment(d.value)} disabled={busy} data-testid="ai-decision-deployment" />
          )}
        </Field>
      )}
      {checked.ok && <p className="muted" data-testid="ai-decision-destination">{t('ai.mediaConn.destination', { url: decisionUrl(checked.value) })}</p>}
      {endpoint && auth === 'entraId' && <p className="muted">{t('ai.decision.entraAccess')}</p>}
      <Checkbox checked={consent} onChange={(_, d) => setConsent(d.checked === true)} disabled={busy} label={t('ai.decision.consent')} data-testid="ai-decision-consent" />
      {showBlockers && (
        <MessageBar intent="error" data-testid="ai-decision-blockers">
          <MessageBarBody>
            <p>{t('ai.conn.checkBeforeTest')}</p>
            <ul>{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </MessageBarBody>
        </MessageBar>
      )}
      <div className="ai-row">
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <PlugConnected20Regular />} onClick={() => void testAndSave()} disabled={busy} data-testid="ai-decision-test">
          {t(busy ? 'ai.mediaConn.testing' : 'ai.decision.testAndSave')}
        </Button>
        <Button icon={<Delete20Regular />} onClick={() => void remove()} disabled={busy || !saved} data-testid="ai-decision-delete">
          {t('ai.decision.delete')}
        </Button>
      </div>
      {message && (
        <MessageBar intent={message.kind === 'error' ? 'error' : 'success'} data-testid="ai-decision-msg">
          <MessageBarBody>
            {message.kind === 'error'
              ? <>{errorText(message.code)}{message.providerStatus !== undefined && ` (HTTP ${message.providerStatus})`}</>
              : t(`ai.decision.msg.${message.kind}`)}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
