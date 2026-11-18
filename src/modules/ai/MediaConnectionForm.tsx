import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Checkbox, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { Dismiss20Regular, PlugConnected20Regular, ShieldKeyhole20Regular, ShieldQuestion20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { mediaTestUrl, type MediaService } from '../../ai/mediaConnection.ts';
import { RelayError, mediaAccess, type MediaAccess, type MediaTestError } from './relayClient.ts';
import { isMediaConfigured, useAiSettings } from './settingsStore.ts';
import './ai.css';

const ENTRA_ERRORS = ['notSignedIn', 'interactionRequired', 'authFailed', 'armForbidden', 'armError', 'armTimeout', 'roleAssignFailed', 'outboundNotAllowed'] as const;
const SOURCE_ERRORS = ['noConnection', 'unsupportedHost'] as const;
const RESOURCE_ERRORS = ['resourceNotFound', 'notEntra'] as const;
const includes = <T extends string>(list: readonly T[], code: string): code is T => (list as readonly string[]).includes(code);
const accessErrorKey = (error: unknown) => {
  const code = error instanceof RelayError ? error.code : '';
  if (includes(ENTRA_ERRORS, code)) return `ai.entra.err.${code}` as const;
  if (includes(SOURCE_ERRORS, code)) return `ai.mediaConn.msg.${code}` as const;
  if (includes(RESOURCE_ERRORS, code)) return `ai.mediaConn.access.${code}` as const;
  return 'ai.entra.err.failed' as const;
};
/** Failures where the resource may simply not offer the service (an Azure OpenAI resource, or Image Analysis outside its regions). */
const SERVICE_MISSING: readonly MediaTestError[] = ['invalidApiRequest', 'unauthorized', 'forbidden'];

/**
 * FR-328: Azure AI Speech / Azure AI Vision use the Microsoft Foundry connection — the same resource (called on its
 * `<name>.cognitiveservices.azure.com` host) and the same API key or Entra ID sign-in — so there is nothing to enter
 * here. The relay tests the service on that resource and seals the result to the Foundry connection.
 */
export function MediaConnectionForm({ service }: { service: MediaService }) {
  const { t } = useI18n();
  const s = useAiSettings();
  const media = s.media;
  const testId = `ai-${service}`;
  const entra = media.auth === 'entraId';
  const [message, setMessage] = useState<'verified' | 'cleared' | MediaTestError | null>(null);
  const [providerStatus, setProviderStatus] = useState<number | undefined>();
  const [testing, setTesting] = useState(false);
  const [consent, setConsent] = useState(false);
  const [validationRequested, setValidationRequested] = useState(false);
  const [access, setAccess] = useState<MediaAccess | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessMessage, setAccessMessage] = useState<{ intent: 'error' | 'success'; text: string } | null>(null);
  const accessRequest = useRef(0);
  const configured = isMediaConfigured(s, service);
  const verifiedAt = media.verifiedAt[service];
  const destination = media.endpoint ? new URL(mediaTestUrl(service, media.endpoint)) : null;
  const blockers = [
    !s.relayReachable ? t('ai.relay.unreachable') : null,
    media.unavailable ? t(`ai.mediaConn.msg.${media.unavailable}`) : null,
    media.endpoint && entra && s.entra?.signedIn !== true ? t('ai.mediaConn.msg.notSignedIn') : null,
    media.endpoint && !entra && !s.foundryKeySaved ? t('ai.mediaConn.msg.keyMissing') : null,
    !consent ? t('ai.mediaConn.consentRequired') : null,
  ].filter((reason) => reason !== null);

  // A different Foundry resource or authentication is a new destination: ask again and forget the role check.
  useEffect(() => {
    accessRequest.current += 1;
    setMessage(null);
    setProviderStatus(undefined);
    setConsent(false);
    setAccess(null);
    setAccessMessage(null);
    setAccessBusy(false);
  }, [media.endpoint, media.auth]);

  const test = async () => {
    if (testing) return;
    setMessage(null);
    setProviderStatus(undefined);
    setValidationRequested(true);
    if (blockers.length > 0) return;
    setValidationRequested(false);
    setTesting(true);
    try {
      const r = await s.testMedia(service);
      setMessage(r.ok ? 'verified' : r.error);
      setProviderStatus(r.ok ? undefined : r.providerStatus);
    } catch {
      setMessage('failed');
    } finally {
      setTesting(false);
      setConsent(false);
    }
  };
  const clear = async () => {
    setMessage((await s.clearMedia(service)) ? 'cleared' : 'failed');
  };
  const checkAccess = async (action: 'access' | 'role') => {
    const request = ++accessRequest.current;
    setAccessBusy(true);
    setAccessMessage(null);
    try {
      const r = await mediaAccess(service, action);
      if (request !== accessRequest.current) return;
      setAccess(r);
      if (action === 'role') setAccessMessage({ intent: 'success', text: t('ai.entra.assigned') });
    } catch (error) {
      if (request === accessRequest.current) setAccessMessage({ intent: 'error', text: t(accessErrorKey(error)) });
    } finally {
      if (request === accessRequest.current) setAccessBusy(false);
    }
  };

  return (
    <div className="ai-stack" data-testid={`${testId}-connection`}>
      <p className="muted">{t('ai.mediaConn.viaFoundry')}</p>
      {media.unavailable ? (
        <p role="alert" data-testid={`${testId}-unavailable`}>{t(`ai.mediaConn.msg.${media.unavailable}`)}</p>
      ) : (
        <dl className="ai-dl" data-testid={`${testId}-source`}>
          <dt>{t('ai.mediaConn.endpoint')}</dt><dd data-testid={`${testId}-endpoint`}>{media.endpoint}</dd>
          <dt>{t('ai.settings.auth')}</dt><dd data-testid={`${testId}-auth`}>{t(`ai.auth.${media.auth ?? 'apiKey'}`)}</dd>
        </dl>
      )}
      <p className="ai-status" data-testid={`${testId}-relay-connection`}>
        <span>{t('ai.mediaConn.relayLabel')}</span>
        <Badge appearance="tint" color={configured ? 'success' : 'informative'} data-testid={`${testId}-verified`}>
          {configured ? t('ai.conn.verified') : t('ai.conn.unverified')}
        </Badge>
      </p>
      {verifiedAt && <p className="muted" data-testid={`${testId}-verified-at`}>{t('ai.conn.verifiedAt', { at: verifiedAt })}</p>}
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
        <Button appearance="primary" icon={testing ? <Spinner size="tiny" /> : <PlugConnected20Regular />} onClick={() => void test()} disabled={testing} data-testid={`${testId}-test`}>
          {t(testing ? 'ai.mediaConn.testing' : 'ai.mediaConn.test')}
        </Button>
        <Button icon={<Dismiss20Regular />} onClick={() => void clear()} disabled={testing || !s.relayReachable || verifiedAt === null} data-testid={`${testId}-clear`}>
          {t('ai.mediaConn.clear')}
        </Button>
      </div>
      {message && (
        <MessageBar intent={message === 'verified' || message === 'cleared' ? 'success' : 'error'} data-testid={`${testId}-msg`}>
          <MessageBarBody>
            {t(`ai.mediaConn.msg.${message}`)}{providerStatus !== undefined && ` (HTTP ${providerStatus})`}
            {SERVICE_MISSING.includes(message as MediaTestError) && <p data-testid={`${testId}-hint`}>{t(`ai.mediaConn.hint.${service}`)}</p>}
          </MessageBarBody>
        </MessageBar>
      )}
      {entra && !media.unavailable && (
        <div className="ai-stack" data-testid={`${testId}-access`}>
          <p className="muted">{t(`ai.mediaConn.access.note.${service}`)}</p>
          <div className="ai-row">
            <Button icon={accessBusy ? <Spinner size="tiny" /> : <ShieldQuestion20Regular />} onClick={() => void checkAccess('access')} disabled={accessBusy || s.entra?.signedIn !== true} data-testid={`${testId}-access-check`}>
              {t('ai.mediaConn.access.check')}
            </Button>
          </div>
          {access && (
            <p className="ai-status" data-testid={`${testId}-access-result`}>
              <span>{`${access.resource.name} (${access.resource.kind})`}</span>
              <Badge appearance="tint" color={access.access.canCall ? 'success' : 'warning'} data-testid={`${testId}-access-badge`}>
                {t(access.access.canCall ? 'ai.entra.media.access.ok' : 'ai.entra.media.access.missing')}
              </Badge>
            </p>
          )}
          {access && !access.access.canCall && (
            <>
              <p className="muted">{t(access.access.canAssign ? `ai.entra.${service}.assignHint` : `ai.entra.${service}.askAdmin`)}</p>
              {access.access.canAssign && (
                <div className="ai-row">
                  <Button icon={<ShieldKeyhole20Regular />} onClick={() => void checkAccess('role')} disabled={accessBusy} data-testid={`${testId}-access-assign`}>{t('ai.entra.assign')}</Button>
                </div>
              )}
            </>
          )}
          {accessMessage && <MessageBar intent={accessMessage.intent} data-testid={`${testId}-access-msg`}><MessageBarBody>{accessMessage.text}</MessageBarBody></MessageBar>}
        </div>
      )}
    </div>
  );
}