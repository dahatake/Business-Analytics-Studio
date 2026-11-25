import { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody, Switch,
} from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { hrefFor, useRoute } from '../../state/router.ts';
import { Panel } from '../../ui/Panel.tsx';
import { D4Warning } from './AiCommon.tsx';
import { AiReadiness, CopilotSettings, FoundryFields, ProviderChoice } from './AiConnectionForm.tsx';
import { copyLegacyPatch, legacyState, readLegacyFoundry } from './legacy.ts';
import { isConfigured, liveReady, useAiSettings } from './settingsStore.ts';
import { closeAiSettings, openAiSettings, useAiSettingsDialog } from './uiStore.ts';
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

/**
 * D-25: the only place to change AI settings. A dialog rather than a screen, so the launch screen (before a project is
 * chosen) and the pack generator (unsaved input) keep their state while settings are changed.
 */
export function AiSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface
        className="ai-settings-dialog"
        style={{ width: 'min(960px, calc(100vw - 32px))', maxWidth: 'min(960px, calc(100vw - 32px))' }}
        data-testid="ai-settings-dialog"
      >
        <DialogBody>
          <DialogTitle>{t('ai.nav.settings')}</DialogTitle>
          <DialogContent>
            <div className="ai-settings-body ai-stack">
              <p className="muted">{t('ai.settings.subtitle')}</p>
              <AiSettingsContent />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose} data-testid="ai-settings-dialog-close">{t('ai.dialog.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Mounted once by the App, at every start-up stage, for every entry point outside the pack generator. Moving to another
 * route closes it; a bookmark of the former /ai-settings screen opens it over Home.
 */
export function AiSettingsDialogHost() {
  const open = useAiSettingsDialog((s) => s.open);
  const path = useRoute().path;
  const redirected = useRef(false);
  useEffect(() => {
    if (path === '/ai-settings') {
      redirected.current = true;
      openAiSettings();
      window.location.replace(hrefFor('/home'));
    } else if (redirected.current) redirected.current = false;
    else closeAiSettings();
  }, [path]);
  return <AiSettingsDialog open={open} onClose={closeAiSettings} />;
}
