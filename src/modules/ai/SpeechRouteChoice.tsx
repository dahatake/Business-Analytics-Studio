import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Radio, RadioGroup, Spinner } from '@fluentui/react-components';
import { Delete20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { SPEECH_INPUT_ERRORS, separateSpeechTestUrl, validateSeparateSpeech, type SpeechRoute } from '../../ai/mediaConnection.ts';
import type { SpeechSeparateError } from './relayClient.ts';
import { isSpeechReady, useAiSettings } from './settingsStore.ts';
import './ai.css';

/** Codes with wording specific to the separate resource; the rest reuse the Speech / Vision test messages. */
const OWN_ERRORS = [...SPEECH_INPUT_ERRORS, 'notEligible', 'notEntra', 'separateNotVerified', 'unauthorized', 'keyMissing'] as const;
type OwnError = (typeof OWN_ERRORS)[number];
const isOwn = (code: string): code is OwnError => (OWN_ERRORS as readonly string[]).includes(code);
type OpResult = { ok: true } | { ok: false; error: SpeechSeparateError; providerStatus?: number };
type Op = { (): Promise<OpResult> };
type Message = { kind: 'saved' | 'routeFoundry' | 'routeSeparate' | 'deleted' } | { kind: 'error'; code: SpeechSeparateError; providerStatus?: number };

/**
 * FR-329: once the Foundry connection and Speech on that resource are verified, the user may keep Speech on the
 * Foundry connection (default) or route it to a separate Azure AI Speech resource. A separate connection is saved, and
 * Speech switched to it, only after its connection test passes in the relay; the key goes to the relay vault only.
 */
export function SpeechRouteChoice() {
  const { t } = useI18n();
  const s = useAiSettings();
  const sc = s.speechConnection;
  const foundryEntra = s.relayConnection?.auth === 'entraId';
  const [selected, setSelected] = useState<SpeechRoute>(sc.route);
  const [auth, setAuth] = useState<'apiKey' | 'entraId'>(sc.separate?.auth ?? 'apiKey');
  const [endpoint, setEndpoint] = useState(sc.separate?.endpoint ?? '');
  const [region, setRegion] = useState(sc.separate?.region ?? '');
  const [key, setKey] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [validationRequested, setValidationRequested] = useState(false);

  useEffect(() => setSelected(sc.route), [sc.route]);
  useEffect(() => {
    if (!foundryEntra && auth === 'entraId') setAuth('apiKey');
  }, [foundryEntra, auth]);

  if (!s.relayReachable) return null;
  if (!sc.eligible && sc.route !== 'separate' && !sc.separate) {
    return <p className="muted" data-testid="ai-speech-route-locked">{t('ai.speechRoute.locked')}</p>;
  }

  const savedKeyUsable = sc.separate?.auth === 'apiKey';
  const draft = { auth, ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}), ...(auth === 'apiKey' && region.trim() ? { region: region.trim() } : {}), ...(auth === 'apiKey' && key.trim() ? { key: key.trim() } : {}) };
  const checked = validateSeparateSpeech(draft);
  const destination = checked.ok ? new URL(separateSpeechTestUrl(checked.value)) : null;
  const blockers = [
    !checked.ok ? t(isOwn(checked.error) ? `ai.speechRoute.err.${checked.error}` : 'ai.speechRoute.err.invalidBody') : null,
    auth === 'apiKey' && !key.trim() && !savedKeyUsable ? t('ai.speechRoute.err.keyMissing') : null,
    auth === 'entraId' && s.entra?.signedIn !== true ? t('ai.mediaConn.msg.notSignedIn') : null,
    !sc.eligible ? t('ai.speechRoute.err.notEligible') : null,
    !consent ? t('ai.speechRoute.consentRequired') : null,
  ].filter((reason) => reason !== null);
  const showBlockers = validationRequested && blockers.length > 0;

  const run = async (op: Op, success: Message['kind']) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await op();
      setMessage(r.ok ? { kind: success as 'saved' } : { kind: 'error', code: r.error, ...(r.providerStatus ? { providerStatus: r.providerStatus } : {}) });
      return r.ok;
    } finally {
      setBusy(false);
    }
  };
  const choose = async (route: SpeechRoute) => {
    setSelected(route);
    setMessage(null);
    if (route === sc.route) return;
    if (route === 'foundry') {
      if (!(await run(() => s.setSpeechRoute('foundry'), 'routeFoundry'))) setSelected(sc.route);
      return;
    }
    // Without a still-valid separate check, choosing it only opens the form; the route changes when its test passes.
    if (sc.separate?.verifiedAt) {
      if (!(await run(() => s.setSpeechRoute('separate'), 'routeSeparate'))) setSelected(sc.route);
    }
  };
  const testAndSave = async () => {
    setMessage(null);
    setValidationRequested(true);
    if (blockers.length > 0) return;
    setValidationRequested(false);
    const ok = await run(() => s.saveSeparateSpeech(draft), 'saved');
    setConsent(false);
    if (ok) setKey('');
  };
  const remove = async () => {
    const ok = await run(() => s.deleteSeparateSpeech(), 'deleted');
    if (ok) {
      setEndpoint('');
      setRegion('');
      setKey('');
      setSelected('foundry');
    }
  };
  const errorText = (code: SpeechSeparateError) => t(isOwn(code) ? `ai.speechRoute.err.${code}` : `ai.mediaConn.msg.${code}`);

  return (
    <div className="ai-stack" data-testid="ai-speech-route">
      <RadioGroup
        value={selected}
        onChange={(_, d) => void choose(d.value as SpeechRoute)}
        disabled={busy}
        aria-label={t('ai.speechRoute.label')}
        data-testid="ai-speech-route-choice"
      >
        <Radio value="foundry" label={t('ai.speechRoute.foundry')} data-testid="ai-speech-route-foundry" />
        <Radio value="separate" label={t('ai.speechRoute.separate')} data-testid="ai-speech-route-separate" />
      </RadioGroup>
      <p className="ai-status" data-testid="ai-speech-route-current">
        <span>{t('ai.speechRoute.current')}</span>
        <Badge appearance="tint" color={isSpeechReady(s) ? 'success' : 'warning'} data-testid="ai-speech-route-badge">
          {t(sc.route === 'separate' ? 'ai.speechRoute.separate' : 'ai.speechRoute.foundry')}
        </Badge>
      </p>
      {sc.route === 'separate' && !isSpeechReady(s) && <p className="muted" data-testid="ai-speech-route-stale">{t('ai.speechRoute.stale')}</p>}
      {!sc.eligible && <p className="muted" data-testid="ai-speech-route-ineligible">{t('ai.speechRoute.ineligible')}</p>}

      {selected === 'separate' && (
        <div className="ai-stack" data-testid="ai-speech-separate">
          <p className="muted">{t('ai.speechRoute.formLead')}</p>
          {sc.separate && (
            <p className="ai-status" data-testid="ai-speech-separate-saved">
              <span>{sc.separate.endpoint ?? sc.separate.region}</span>
              <Badge appearance="tint" color={sc.separate.verifiedAt ? 'success' : 'informative'} data-testid="ai-speech-separate-verified">
                {sc.separate.verifiedAt ? t('ai.conn.verified') : t('ai.conn.unverified')}
              </Badge>
            </p>
          )}
          <RadioGroup value={auth} onChange={(_, d) => setAuth(d.value as 'apiKey' | 'entraId')} disabled={busy} aria-label={t('ai.settings.auth')} layout="horizontal" data-testid="ai-speech-separate-auth">
            <Radio value="apiKey" label={t('ai.auth.apiKey')} data-testid="ai-speech-separate-auth-apiKey" />
            <Radio value="entraId" label={t('ai.auth.entraId')} disabled={!foundryEntra} data-testid="ai-speech-separate-auth-entraId" />
          </RadioGroup>
          {!foundryEntra && <p className="muted">{t('ai.speechRoute.entraNeedsFoundry')}</p>}
          <Field label={t('ai.speechRoute.endpoint')} hint={t(auth === 'entraId' ? 'ai.speechRoute.endpointHint.entraId' : 'ai.speechRoute.endpointHint.apiKey')}>
            <Input value={endpoint} onChange={(_, d) => setEndpoint(d.value)} placeholder="https://my-speech.cognitiveservices.azure.com" disabled={busy} data-testid="ai-speech-separate-endpoint" />
          </Field>
          {auth === 'apiKey' && (
            <>
              <Field label={t('ai.speechRoute.region')} hint={t('ai.speechRoute.regionHint')}>
                <Input value={region} onChange={(_, d) => setRegion(d.value)} placeholder="japaneast" disabled={busy} data-testid="ai-speech-separate-region" />
              </Field>
              <Field label={t('ai.speechRoute.key')} hint={t(savedKeyUsable ? 'ai.speechRoute.keyHintSaved' : 'ai.speechRoute.keyHint')}>
                <Input type="password" value={key} onChange={(_, d) => setKey(d.value)} autoComplete="off" disabled={busy} data-testid="ai-speech-separate-key" />
              </Field>
            </>
          )}
          {destination && <p className="muted" data-testid="ai-speech-separate-destination">{t('ai.mediaConn.destination', { url: `${destination.origin}${destination.pathname}` })}</p>}
          <Checkbox checked={consent} onChange={(_, d) => setConsent(d.checked === true)} disabled={busy} label={t('ai.speechRoute.consent')} data-testid="ai-speech-separate-consent" />
          {showBlockers && (
            <MessageBar intent="error" data-testid="ai-speech-separate-blockers">
              <MessageBarBody>
                <p>{t('ai.conn.checkBeforeTest')}</p>
                <ul>{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              </MessageBarBody>
            </MessageBar>
          )}
          <div className="ai-row">
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <PlugConnected20Regular />} onClick={() => void testAndSave()} disabled={busy} data-testid="ai-speech-separate-test">
              {t(busy ? 'ai.mediaConn.testing' : 'ai.speechRoute.testAndSave')}
            </Button>
            <Button icon={<Delete20Regular />} onClick={() => void remove()} disabled={busy || !sc.separate} data-testid="ai-speech-separate-delete">
              {t('ai.speechRoute.delete')}
            </Button>
          </div>
        </div>
      )}
      {message && (
        <MessageBar intent={message.kind === 'error' ? 'error' : 'success'} data-testid="ai-speech-route-msg">
          <MessageBarBody>
            {message.kind === 'error'
              ? <>{errorText(message.code)}{message.providerStatus !== undefined && ` (HTTP ${message.providerStatus})`}</>
              : t(`ai.speechRoute.msg.${message.kind}`)}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
