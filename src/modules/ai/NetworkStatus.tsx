import { useEffect, useState } from 'react';
import { Badge, Button, Spinner } from '@fluentui/react-components';
import { Globe20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { checkNetwork, fetchNetworkStatus, type NetworkHostCheck, type NetworkInfo } from './relayClient.ts';

/** FR-372: the proxy and certificates the relay uses, and a check that each outbound host can be opened. */
export function NetworkStatus() {
  const { t } = useI18n();
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [results, setResults] = useState<NetworkHostCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchNetworkStatus().then((n) => {
      if (live) setNetwork(n);
    });
    return () => {
      live = false;
    };
  }, []);

  const run = async () => {
    setChecking(true);
    setFailed(false);
    const r = await checkNetwork();
    setChecking(false);
    if (!r) {
      setFailed(true);
      return;
    }
    if (r.network) setNetwork(r.network);
    setResults(r.results);
  };

  const route = !network
    ? t('ai.network.unknown')
    : network.mode === 'direct'
      ? t('ai.network.direct')
      : network.mode === 'proxy'
        ? t('ai.network.proxy', { proxy: network.proxy ?? '' })
        : t('ai.network.pac', { url: network.pacUrl ?? '' });

  return (
    <div className="ai-stack" data-testid="ai-network">
      <p className="ai-status">
        <span>{t('ai.network.label')}</span>
        <Badge appearance="tint" color={network ? 'informative' : 'warning'} data-mode={network?.mode ?? 'unknown'} data-testid="ai-network-mode">{route}</Badge>
        {network && network.source !== 'none' && <span className="muted">{t(`ai.network.source.${network.source}`)}</span>}
      </p>
      {network && (
        <p className="ai-status">
          <span>{t('ai.network.systemCa')}</span>
          <Badge appearance="tint" color={network.systemCa ? 'success' : 'informative'} data-testid="ai-network-ca">{network.systemCa ? t('ai.network.systemCaOn') : t('ai.network.systemCaOff')}</Badge>
        </p>
      )}
      {network?.note === 'pacUnavailable' && <p className="muted" data-testid="ai-network-note">{t('ai.network.pacUnavailable')}</p>}
      <div className="ai-row">
        <Button icon={checking ? <Spinner size="tiny" /> : <Globe20Regular />} onClick={() => void run()} disabled={checking} data-testid="ai-network-check">{t('ai.network.check')}</Button>
      </div>
      {failed && <p role="status" className="muted" data-testid="ai-network-failed">{t('ai.network.checkFailed')}</p>}
      {results && (
        <ul className="ai-network-results" data-testid="ai-network-results" aria-live="polite">
          {results.length === 0 && <li>{t('ai.network.noHosts')}</li>}
          {results.map((r) => (
            <li key={r.host} data-host={r.host} data-ok={r.ok}>
              <Badge appearance="tint" color={r.ok ? 'success' : 'danger'}>{r.ok ? t('ai.network.ok') : t('ai.network.ng')}</Badge>
              <span>{t('ai.network.hostLine', { host: r.host, via: t(`ai.network.via.${r.via}`) })}</span>
              {r.error && <span className="muted">{t(`ai.network.err.${r.error}`)}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">{t('ai.network.note')}</p>
    </div>
  );
}
