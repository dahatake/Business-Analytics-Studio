import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Radio, RadioGroup, Spinner } from '@fluentui/react-components';
import { Delete20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { mediaTestUrl, type MediaConnection, type MediaService } from '../../ai/mediaConnection.ts';
import { KeyField } from './AiConnectionForm.tsx';
import { EntraConnection } from './EntraConnection.tsx';
import type { MediaConnectionInfo, MediaSaveError, SecretName } from './relayClient.ts';
import { isMediaConfigured, mediaSaveInput, useAiSettings, type AuthMethod } from './settingsStore.ts';
import './ai.css';

const KEY: Record<MediaService, SecretName> = { speech: 'speechKey', vision: 'visionKey' };

const sameAsSaved = (c: MediaConnection, saved: MediaConnectionInfo) =>
  saved.auth === c.auth && saved.endpoint === c.endpoint && saved.region === c.region
  && (c.auth === 'apiKey' || (saved.tenantId === c.tenantId && saved.resourceId === c.resourceId));

/**
 * FR-324: an Azure AI Speech or Azure AI Vision connection with API key or Microsoft Entra ID, chosen like the Microsoft
 * Foundry one. The relay saves it only after the service itself answered a test request with that credential, and seals
 * the check so a changed key or a different signed-in account shows "not verified" again.
 */
export function MediaConnectionForm({ service }: { service: MediaService }) {
  const { t } = useI18n();
  const s = useAiSettings();
  const draft = s.mediaDraft[service];
  const saved = s.media[service];
  const entra = draft.auth === 'entraId';
  const keySaved = service === 'speech' ? s.speechKeySaved : s.visionKeySaved;
  const testId = `ai-${service}`;
  const [message, setMessage] = useState<'saved' | 'deleted' | MediaSaveError | null>(null);
  const [providerStatus, setProviderStatus] = useState<number | undefined>();
  const [testing, setTesting] = useState(false);
  const [consent, setConsent] = useState(false);
  const [validationRequested, setValidationRequested] = useState(false);
  const input = mediaSaveInput(service, draft);
  const problemText = input.ok ? null : entra && (!draft.resourceId || !draft.endpoint) ? t(`ai.mediaConn.pick.${service}`) : t(`ai.mediaConn.msg.${input.error}`);
  const destination = input.ok ? new URL(mediaTestUrl(service, input.connection)) : null;
  const blockers = [
    problemText,
    !s.relayReachable ? t('ai.relay.unreachable') : null,
    entra && s.entra?.signedIn !== true ? t('ai.mediaConn.msg.notSignedIn') : null,
    !entra && !keySaved ? t('ai.mediaConn.msg.keyMissing') : null,
    !consent ? t('ai.mediaConn.consentRequired') : null,
  ].filter((reason) => reason !== null);
  const configured = isMediaConfigured(s, service);
  const differs = saved !== null && (!input.ok || !sameAsSaved(input.connection, saved.connection));

  useEffect(() => {
    setMessage(null);
    setProviderStatus(undefined);
    setConsent(false);
  }, [draft.auth, draft.endpoint, draft.region, draft.tenantId, draft.resourceId]);

  const save = async () => {
    if (testing) return;
    setMessage(null);
    setProviderStatus(undefined);
    setValidationRequested(true);
    if (blockers.length > 0) return;
    setValidationRequested(false);
    setTesting(true);
    try {
      const r = await s.saveMedia(service);
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
    setMessage((await s.deleteMedia(service)) ? 'deleted' : 'failed');
  };

  return (
    <div className="ai-stack" data-testid={`${testId}-connection`}>
      <RadioGroup
        value={draft.auth}
        onChange={(_, d) => s.updateMediaDraft(service, { auth: d.value as AuthMethod })}
        aria-labelledby={`${testId}-lbl-auth`}
        data-testid={`${testId}-auth-method`}
      >
        <span id={`${testId}-lbl-auth`} className="ai-label">{t('ai.settings.auth')}</span>
        <Radio value="apiKey" label={t('ai.auth.apiKey')} data-testid={`${testId}-auth-apikey`} />
        <Radio value="entraId" label={t('ai.auth.entraId')} data-testid={`${testId}-auth-entra`} />
      </RadioGroup>
      {entra ? (
        <EntraConnection
          media={{
            service,
            tenantId: draft.tenantId,
            resourceId: draft.resourceId,
            onSelect: (i) => s.updateMediaDraft(service, i?.endpoint
              ? { endpoint: i.endpoint, tenantId: i.tenantId, resourceId: i.id, region: i.location.toLowerCase() }
              : { endpoint: '', tenantId: '', resourceId: '', region: '' }),
          }}
        />
      ) : (
        <>
          <Field label={t('ai.speech.endpoint')} hint={t(`ai.mediaConn.endpointHint.${service}`)}>
            <Input value={draft.endpoint} onChange={(_, d) => s.updateMediaDraft(service, { endpoint: d.value })} data-testid={`${testId}-endpoint`} />
          </Field>
          {service === 'speech' && (
            <Field label={t('ai.speech.region')} hint={t('ai.mediaConn.regionHint')}>
              <Input value={draft.region} onChange={(_, d) => s.updateMediaDraft(service, { region: d.value })} data-testid={`${testId}-region`} />
            </Field>
          )}
          <KeyField name={KEY[service]} label={t(`ai.key.${service}`)} testId={`${testId}-key`} />
        </>
      )}
      <p className="ai-status" data-testid={`${testId}-relay-connection`}>
        <span>{t('ai.mediaConn.relayLabel')}</span>
        <Badge appearance="tint" color={configured ? 'success' : 'informative'} data-testid={`${testId}-verified`}>
          {configured ? t('ai.conn.verified') : saved ? t('ai.conn.unverified') : t('ai.conn.notSaved')}
        </Badge>
      </p>
      {saved?.verifiedAt && <p className="muted" data-testid={`${testId}-verified-at`}>{t('ai.conn.verifiedAt', { at: saved.verifiedAt })}</p>}
      {saved && (
        <p className="muted" data-testid={`${testId}-saved`}>
          {t('ai.mediaConn.saved', { auth: t(`ai.auth.${saved.connection.auth}`), target: saved.connection.endpoint ?? saved.connection.region ?? '' })}
        </p>
      )}
      {differs && <p className="muted" data-testid={`${testId}-differs`}>{t('ai.mediaConn.differs')}</p>}
      {problemText && <p role="alert" data-testid={`${testId}-validation`}>{problemText}</p>}
      {destination && <p className="muted" data-testid={`${testId}-destination`}>{t('ai.mediaConn.destination', { url: `${destination.origin}${destination.pathname}` })}</p>}
      <p className="muted" data-testid={`${testId}-test-info`}>{t(`ai.mediaConn.testInfo.${service}`)}</p>
      <Checkbox
        checked={consent}
        onChange={(_, d) => setConsent(d.checked === true)}
        disabled={testing}
        label={t(`ai.mediaConn.consent.${service}`)}
        data-testid={`${testId}-consent`}
      />
      {validationRequested && blockers.length > 0 && (
        <MessageBar intent="error" data-testid={`${testId}-blockers`}>
          <MessageBarBody>
            <p>{t('ai.conn.checkBeforeTest')}</p>
            <ul>{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </MessageBarBody>
        </MessageBar>
      )}
      <div className="ai-row">
        <Button appearance="primary" icon={testing ? <Spinner size="tiny" /> : <PlugConnected20Regular />} onClick={() => void save()} disabled={testing} data-testid={`${testId}-save`}>
          {t(testing ? 'ai.mediaConn.testing' : 'ai.conn.save')}
        </Button>
        <Button icon={<Delete20Regular />} onClick={() => void remove()} disabled={testing || !s.relayReachable || saved === null} data-testid={`${testId}-delete`}>
          {t('ai.mediaConn.delete')}
        </Button>
      </div>
      {message && (
        <MessageBar intent={message === 'saved' || message === 'deleted' ? 'success' : 'error'} data-testid={`${testId}-msg`}>
          <MessageBarBody>{t(`ai.mediaConn.msg.${message}`)}{providerStatus !== undefined && ` (HTTP ${providerStatus})`}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
