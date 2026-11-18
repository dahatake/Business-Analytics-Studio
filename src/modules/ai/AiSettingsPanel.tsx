import { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, MessageBar, MessageBarBody,
  ProgressBar, Switch,
} from '@fluentui/react-components';
import { Delete20Regular } from '@fluentui/react-icons';
import { readLedger } from '../../ai/client.ts';
import { useI18n } from '../../i18n/index.ts';
import { hrefFor, useRoute } from '../../state/router.ts';
import { Panel } from '../../ui/Panel.tsx';
import { D4Warning } from './AiCommon.tsx';
import { AiReadiness, BudgetInput, CopilotSettings, FoundryFields, PriceFields, ProviderChoice } from './AiConnectionForm.tsx';
import { MediaConnectionForm } from './MediaConnectionForm.tsx';
import { copyLegacyPatch, legacyState, readLegacyFoundry } from './legacy.ts';
import { deleteExpiredUsage, expiredUsageCount, usageSummary, type BudgetLevel } from './ledger.ts';
import { isConfigured, liveReady, useAiSettings } from './settingsStore.ts';
import { closeAiSettings, openAiSettings, useAiSettingsDialog } from './uiStore.ts';
import './mocks.ts';
import './ai.css';

function Meter({ label, ratio, level, testId }: { label: string; ratio: number; level: BudgetLevel; testId: string }) {
  const { t } = useI18n();
  // Tiny diagnostic costs must not serialize aria-valuenow in exponential notation.
  const value = Math.round(Math.min(1, Math.max(0, ratio)) * 1_000_000) / 1_000_000;
  return (
    <Field
      label={label}
      validationState={level === 'ok' ? 'none' : level === 'warn' ? 'warning' : 'error'}
      validationMessage={level === 'ok' ? undefined : t(`ai.level.${level}`)}
      data-testid={testId}
    >
      <ProgressBar value={value} thickness="large" />
    </Field>
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
              <Button onClick={() => setConfirming(false)}>{t('ai.dialog.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/**
 * The one AI settings view: connection, broad send consent, live switch, usage, prices, speech and media.
 * It is shown only inside AiSettingsDialog, so every condition of liveReady() is visible wherever settings are opened.
 */
export function AiSettingsContent() {
  const { t, fmt } = useI18n();
  const s = useAiSettings();
  const refreshRelay = useAiSettings((x) => x.refreshRelay);
  const configured = isConfigured(s);
  const [, setLedgerVersion] = useState(0);
  const usage = usageSummary(readLedger(), new Date(), s.monthlyBudgetJpy);
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

      <div className="grid-2">
        <Panel title={t('ai.usage.title')} testId="ai-usage">
          <div className="ai-stack">
            <p data-testid="ai-usage-daily">{t('ai.usage.daily', { used: usage.todayCalls, limit: usage.dailyLimit })}</p>
            <Meter label={t('ai.usage.month', { spent: fmt.yen(usage.monthSpentJpy), budget: fmt.yen(usage.monthBudgetJpy) })} ratio={usage.monthBudgetJpy > 0 ? usage.monthSpentJpy / usage.monthBudgetJpy : 1} level={usage.monthLevel} testId="ai-usage-month" />
            <p className="muted">{t('ai.usage.thresholds')}</p>
            {usage.monthUnpricedCalls !== undefined && <p className="muted" data-testid="ai-usage-unpriced">{t('ai.usage.unpriced', { count: usage.monthUnpricedCalls })}</p>}
            <BudgetInput />
            <p className="muted">{t('ai.usage.mockFree')}</p>
            <p className="muted" data-testid="ai-usage-no-content">{t('ai.usage.noContent')}</p>
            <LedgerPrune onChange={() => setLedgerVersion((v) => v + 1)} />
          </div>
        </Panel>

        <Panel title={t('ai.cost.title')} testId="ai-prices">
          <div className="ai-stack">
            <PriceFields />
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title={t('ai.speech.title')} testId="ai-speech">
          <div className="ai-stack">
            <p className="muted">{t('ai.speech.lead')}</p>
            <MediaConnectionForm service="speech" />
          </div>
        </Panel>

        <Panel title={t('ai.media.title')} testId="ai-media">
          <div className="ai-stack">
            <h3 className="ai-label">{t('ai.media.visionTitle')}</h3>
            <p className="muted">{t('ai.media.visionLead')}</p>
            <MediaConnectionForm service="vision" />
            <Switch checked={false} disabled label={t('ai.media.speech')} />
            <Switch checked={false} disabled label={t('ai.media.vision')} />
            <p className="muted" data-testid="ai-media-blocked">{t('ai.media.blocked')}</p>
          </div>
        </Panel>
      </div>
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
