import { useEffect, useState } from 'react';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody,
  ProgressBar, Switch,
} from '@fluentui/react-components';
import { Delete20Regular } from '@fluentui/react-icons';
import { isUseApproved, readLedger } from '../../ai/client.ts';
import { C03_TABLE, approvedProviders, isApproved, type AiUse } from '../../ai/policy.ts';
import { useI18n } from '../../i18n/index.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { D4Warning, MockNotice } from './AiCommon.tsx';
import { BudgetInput, CopilotSettings, FoundryFields, KeyField, PriceFields, ProviderChoice } from './AiConnectionForm.tsx';
import { copyLegacyPatch, legacyState, readLegacyFoundry } from './legacy.ts';
import { deleteExpiredUsage, expiredUsageCount, usageSummary, type BudgetLevel } from './ledger.ts';
import { relayAiCheck } from './relayClient.ts';
import { isConfigured, liveReady, useAiSettings } from './settingsStore.ts';
import { STORY_CAP_JPY, STORY_SAFETY_FACTOR } from './story.ts';
import './mocks.ts';
import './ai.css';

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
            <ProviderChoice />
            {s.provider === 'copilotSdk' ? <CopilotSettings /> : <FoundryFields />}
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
                    <td>{row.provider === 'TBD' ? t('ai.c03.tbd') : approvedProviders(row).map((p) => t(`ai.provider.${p}`)).join(t('ai.listSep'))}</td>
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

        <Panel title={s.provider === 'copilotSdk' ? t('ai.price.titleCopilot') : t('ai.price.title')} testId="ai-prices">
          <div className="ai-stack">
            <p className="muted">{t(s.provider === 'copilotSdk' ? 'ai.price.leadCopilot' : 'ai.price.lead', { cap: fmt.yen(STORY_CAP_JPY), factor: STORY_SAFETY_FACTOR })}</p>
            <PriceFields />
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
