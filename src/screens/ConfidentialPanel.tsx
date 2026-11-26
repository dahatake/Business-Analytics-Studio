import { useState } from 'react';
import { Button, Field, Input, MessageBar, MessageBarBody, Switch } from '@fluentui/react-components';
import { Delete20Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../i18n/index.ts';
import {
  CONFIDENTIAL_RETENTION_MAX_DAYS, CONFIDENTIAL_RETENTION_MIN_DAYS, expiresAt, purgeAllConfidential, purgeExpiredConfidential, useConfidential,
} from '../state/confidential.ts';
import { Panel } from '../ui/Panel.tsx';

/** FR-369 / FR-370: whether confidential Work IQ material may be kept, for how long, and deleting it now (D-43). */
export function ConfidentialPanel() {
  const { t, lang } = useI18n();
  const { allow, retentionDays, holdings, setAllow, setRetentionDays } = useConfidential();
  const [days, setDays] = useState(String(retentionDays));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ intent: 'success' | 'error'; key: MessageKey; n?: number } | null>(null);
  const when = (iso: string) => new Date(iso).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const commitDays = () => {
    const n = Number(days);
    setRetentionDays(Number.isFinite(n) && days.trim() !== '' ? n : retentionDays);
    setDays(String(useConfidential.getState().retentionDays));
    void purgeExpiredConfidential().catch(() => undefined);
  };
  const purgeNow = async () => {
    setBusy(true);
    try {
      const n = await purgeAllConfidential();
      setNote({ intent: 'success', key: 'settings.conf.purged', n });
    } catch {
      setNote({ intent: 'error', key: 'settings.conf.purgeFailed' });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Panel title={t('settings.conf')} testId="confidential">
      <p>{t('settings.conf.intro')}</p>
      <Switch checked={allow} onChange={(_, d) => setAllow(d.checked)} label={t('settings.conf.toggle')} data-testid="confidential-toggle" />
      <MessageBar intent={allow ? 'warning' : 'info'} data-testid="confidential-state" data-allow={allow ? 'true' : 'false'}>
        <MessageBarBody>{t(allow ? 'settings.conf.on' : 'settings.conf.off')}</MessageBarBody>
      </MessageBar>
      <Field label={t('settings.conf.days', { min: CONFIDENTIAL_RETENTION_MIN_DAYS, max: CONFIDENTIAL_RETENTION_MAX_DAYS })} hint={t('settings.conf.daysHint')}>
        <Input
          type="number" min={CONFIDENTIAL_RETENTION_MIN_DAYS} max={CONFIDENTIAL_RETENTION_MAX_DAYS} value={days}
          onChange={(_, d) => setDays(d.value)} onBlur={commitDays} onKeyDown={(e) => { if (e.key === 'Enter') commitDays(); }}
          data-testid="confidential-days"
        />
      </Field>
      <h3>{t('settings.conf.held')}</h3>
      {holdings.length === 0 ? <p className="muted" data-testid="confidential-none">{t('settings.conf.none')}</p> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t('settings.conf.held')}>
          <table className="data-table" data-testid="confidential-holdings">
            <thead><tr>
              <th scope="col">{t('settings.conf.col.company')}</th>
              <th scope="col">{t('settings.conf.col.labels')}</th>
              <th scope="col">{t('settings.conf.col.since')}</th>
              <th scope="col">{t('settings.conf.col.expires')}</th>
            </tr></thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.company} data-testid="confidential-holding">
                  <th scope="row">{h.demo ? t('settings.conf.demo', { company: h.company }) : h.company}</th>
                  <td>{h.labels.join(t('list.separator'))}</td>
                  <td>{when(h.since)}</td>
                  <td>{when(expiresAt(h, retentionDays))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">{t('settings.conf.scope')}</p>
      {confirming ? (
        <MessageBar intent="error" data-testid="confidential-confirm">
          <MessageBarBody>
            {t('settings.conf.purgeConfirm', { n: holdings.length })}
            <span className="data-location-actions">
              <Button appearance="primary" icon={<Delete20Regular />} onClick={() => void purgeNow()} disabled={busy} data-testid="confidential-purge-yes">{t('settings.conf.purgeYes')}</Button>
              <Button onClick={() => setConfirming(false)} disabled={busy}>{t('settings.conf.cancel')}</Button>
            </span>
          </MessageBarBody>
        </MessageBar>
      ) : (
        <Button icon={<Delete20Regular />} onClick={() => { setNote(null); setConfirming(true); }} disabled={holdings.length === 0} data-testid="confidential-purge">{t('settings.conf.purge')}</Button>
      )}
      {note && <MessageBar intent={note.intent} role="status" data-testid="confidential-note"><MessageBarBody>{t(note.key, { n: note.n ?? 0 })}</MessageBarBody></MessageBar>}
      <p className="muted">{t('settings.conf.limit')}</p>
    </Panel>
  );
}
