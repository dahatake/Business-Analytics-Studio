import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, MessageBar, MessageBarBody, Switch } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { Panel } from '../../ui/Panel.tsx';
import { D4Warning } from './AiCommon.tsx';
import { AiReadiness, CopilotSettings, FoundryFields, ProviderChoice } from './AiConnectionForm.tsx';
import { NetworkStatus } from './NetworkStatus.tsx';
import { copyLegacyPatch, legacyState, readLegacyFoundry } from './legacy.ts';
import { isConfigured, liveReady, useAiSettings } from './settingsStore.ts';
import './mocks.ts';
import './ai.css';

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

/**
 * The one AI settings view: Foundry services, broad send consent and the live switch.
 * It is shown only inside AiSettingsDialog, so every condition of liveReady() is visible wherever settings are opened.
 */
export function AiSettingsContent() {
  const { t } = useI18n();
  const s = useAiSettings();
  const refreshRelay = useAiSettings((x) => x.refreshRelay);
  const configured = isConfigured(s);
  const live = liveReady(s);

  useEffect(() => {
    void refreshRelay();
  }, [refreshRelay]);

  return (
    <>
      <D4Warning />
      {!s.relayReachable && (
        <MessageBar intent="warning" data-testid="ai-relay-unreachable"><MessageBarBody>{t('ai.relay.unreachable')}</MessageBarBody></MessageBar>
      )}
      <div className="grid-2">
        <Panel title={t('ai.settings.connection')} testId="ai-connection">
          <div className="ai-stack">
            <ProviderChoice />
            {s.provider === 'copilotSdk' ? <CopilotSettings /> : <FoundryFields />}
            <AiReadiness />
            <NetworkStatus />
            <p className="ai-status" data-testid="ai-configured">
              <span>{t('ai.settings.configuredLabel')}</span>
              <Badge appearance="tint" color={configured ? 'success' : 'informative'}>{configured ? t('ai.settings.configured') : t('ai.settings.notConfigured')}</Badge>
            </p>
          </div>
        </Panel>

        <Panel title={t('ai.settings.live')} testId="ai-live">
          <div className="ai-stack">
            <Checkbox
              checked={s.sendConsent}
              onChange={(_, d) => s.update({ sendConsent: d.checked === true, ...(d.checked ? {} : { liveEnabled: false }) })}
              label={t('ai.settings.sendConsent')}
              data-testid="ai-send-consent"
            />
            <p className="muted">{t('ai.settings.sendConsentNote')}</p>
            <Switch checked={s.liveEnabled} disabled={!s.sendConsent} onChange={(_, d) => s.update({ liveEnabled: d.checked })} label={t('ai.settings.liveSwitch')} data-testid="ai-live-switch" />
            <p className="muted">{t('ai.settings.liveNote')}</p>
            <p className="ai-status">
              <span>{t('ai.settings.state')}</span>
              <Badge appearance="filled" color={live ? 'success' : 'warning'} data-testid="ai-state">{live ? t('ai.settings.stateLive') : t('ai.mock.badge')}</Badge>
            </p>
          </div>
        </Panel>
      </div>

      <LegacyPanel />
    </>
  );
}
