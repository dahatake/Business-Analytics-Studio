import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { Delete20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { DECISION_MODEL, DECISION_PRICE, decisionUrl, validateDecisionConnection } from '../../ai/decision.ts';
import type { DecisionSaveError } from './relayClient.ts';
import { isDecisionReady, useAiSettings } from './settingsStore.ts';
import './ai.css';

/** Codes with Decision-specific wording; the rest reuse the Foundry connection messages. */
const OWN_ERRORS = ['invalidBody', 'invalidEndpoint', 'invalidKey', 'keyMissing', 'unauthorized', 'deploymentNotFound', 'invalidApiRequest', 'badProviderResponse'] as const;
type OwnError = (typeof OWN_ERRORS)[number];
const isOwn = (code: string): code is OwnError => (OWN_ERRORS as readonly string[]).includes(code);
type Message = { kind: 'saved' | 'deleted' } | { kind: 'error'; code: DecisionSaveError; providerStatus?: number };

/**
 * D-44: the optional Microsoft Foundry Decision connection. It is saved only after a synthetic test request succeeds
 * in the relay; the key goes to the relay vault only. When it is not set, KPI/OKR drafting works as before.
 */
export function DecisionSettings() {
  const { t } = useI18n();
  const s = useAiSettings();
  const saved = s.decision;
  const [endpoint, setEndpoint] = useState(saved?.endpoint ?? '');
  const [deployment, setDeployment] = useState(saved?.deployment ?? 'decision-1-1');
  const [key, setKey] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [validationRequested, setValidationRequested] = useState(false);

  useEffect(() => {
    if (saved) {
      setEndpoint(saved.endpoint);
      setDeployment(saved.deployment);
    }
  }, [saved]);

  if (!s.relayReachable) return <p className="muted" data-testid="ai-decision-unreachable">{t('ai.decision.needsRelay')}</p>;

  const draft = { endpoint: endpoint.trim(), deployment: deployment.trim(), ...(key.trim() ? { key: key.trim() } : {}) };
  const checked = validateDecisionConnection(draft);
  const blockers = [
    !checked.ok ? t(isOwn(checked.error) ? `ai.decision.err.${checked.error}` : `ai.conn.msg.${checked.error}`) : null,
    !key.trim() && !saved ? t('ai.decision.err.keyMissing') : null,
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
      if (r.ok) setKey('');
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
      if (r.ok) {
        setEndpoint('');
        setKey('');
      }
    } finally {
      setBusy(false);
    }
  };
  const errorText = (code: DecisionSaveError) => t(isOwn(code) ? `ai.decision.err.${code}` : `ai.conn.msg.${code}`);

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
      <Field label={t('ai.decision.endpoint')} hint={t('ai.decision.endpointHint')}>
        <Input value={endpoint} onChange={(_, d) => setEndpoint(d.value)} placeholder="https://my-resource.services.ai.azure.com" disabled={busy} data-testid="ai-decision-endpoint" />
      </Field>
      <Field label={t('ai.decision.deployment')}>
        <Input value={deployment} onChange={(_, d) => setDeployment(d.value)} disabled={busy} data-testid="ai-decision-deployment" />
      </Field>
      <Field label={t('ai.decision.key')} hint={t(saved ? 'ai.decision.keyHintSaved' : 'ai.decision.keyHint')}>
        <Input type="password" value={key} onChange={(_, d) => setKey(d.value)} autoComplete="off" disabled={busy} data-testid="ai-decision-key" />
      </Field>
      {checked.ok && <p className="muted" data-testid="ai-decision-destination">{t('ai.mediaConn.destination', { url: decisionUrl(checked.value) })}</p>}
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
