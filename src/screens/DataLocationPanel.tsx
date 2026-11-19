import { useEffect, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { FolderOpen20Regular } from '@fluentui/react-icons';
import type { DeviceFolderListing, DeviceLocation } from '../../scripts/lib/deviceProtocol.ts';
import { changeDeviceLocation, getDeviceLocation } from '../data/deviceStorage.ts';
import { useI18n, type MessageKey } from '../i18n/index.ts';
import { errorKey, FolderPicker } from '../ui/FolderPicker.tsx';
import { Panel } from '../ui/Panel.tsx';

/** FR-339: choose the folder that holds the device database (Project packs, projects, settings). */
export function DataLocationPanel() {
  const { t } = useI18n();
  const [location, setLocation] = useState<DeviceLocation | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<DeviceFolderListing | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    void getDeviceLocation().then(setLocation, () => setLoadError(true));
  }, []);

  const confirm = async () => {
    if (!selected) return;
    setSwitching(true);
    setError(null);
    try {
      await changeDeviceLocation(selected.path, selected.target.hasData ? 'open' : 'copy');
    } catch (e) {
      setError(errorKey(e));
      setSwitching(false);
    }
  };

  return (
    <Panel title={t('settings.storage')} testId="data-location">
      <p>{t('settings.storage.intro')}</p>
      {loadError && <MessageBar intent="error"><MessageBarBody>{t('settings.storage.failed')}</MessageBarBody></MessageBar>}
      {location && (
        <dl className="data-location-paths">
          <dt>{t('settings.storage.current')}</dt>
          <dd><code data-testid="data-location-current">{location.path}</code></dd>
          {!location.isDefault && (
            <>
              <dt>{t('settings.storage.default')}</dt>
              <dd><code>{location.defaultPath}</code></dd>
            </>
          )}
        </dl>
      )}
      {location?.isDefault && !location.fixed && <p className="muted">{t('settings.storage.isDefault')}</p>}
      {location?.fixed && <p className="muted" data-testid="data-location-fixed">{t('settings.storage.fixed')}</p>}
      {location && !location.fixed && !selected && (
        <Button icon={<FolderOpen20Regular />} onClick={() => setPicking(true)} data-testid="data-location-change">{t('settings.storage.change')}</Button>
      )}
      {selected && (
        <div className="data-location-confirm" role="group" aria-label={t('settings.storage.selected', { path: selected.path })} data-testid="data-location-confirm">
          <p>{t('settings.storage.selected', { path: selected.path })}</p>
          <p data-testid="data-location-mode" data-mode={selected.target.hasData ? 'open' : 'copy'}>
            {t(selected.target.hasData ? 'settings.storage.modeOpen' : 'settings.storage.modeCopy')}
          </p>
          {selected.target.warnings.map((w) => (
            <MessageBar key={w} intent="warning"><MessageBarBody>{t(`settings.storage.warn.${w}`)}</MessageBarBody></MessageBar>
          ))}
          <div className="data-location-actions">
            <Button appearance="primary" disabled={switching} onClick={() => void confirm()} data-testid="data-location-confirm-button">
              {t(selected.target.hasData ? 'settings.storage.confirmOpen' : 'settings.storage.confirmCopy')}
            </Button>
            <Button disabled={switching} onClick={() => { setSelected(null); setError(null); }}>{t('settings.storage.cancel')}</Button>
          </div>
          {switching && <Spinner size="tiny" label={t('settings.storage.switching')} />}
        </div>
      )}
      <div aria-live="polite">
        {error && <MessageBar intent="error" data-testid="data-location-error"><MessageBarBody>{t(error)}{error !== 'settings.storage.failed' && ` ${t('settings.storage.failed')}`}</MessageBarBody></MessageBar>}
      </div>
      <p className="muted">{t('settings.storage.keysNote')}</p>
      <p className="muted">{t('settings.storage.oldKept')}</p>
      <FolderPicker
        open={picking}
        onCancel={() => setPicking(false)}
        onSelect={(listing) => { setPicking(false); setSelected(listing); setError(null); }}
      />
    </Panel>
  );
}
