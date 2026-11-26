import { useEffect, useRef, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { FolderOpen20Regular } from '@fluentui/react-icons';
import type { DeviceFolderSelection, DeviceLocation } from '../../scripts/lib/deviceProtocol.ts';
import { changeDeviceLocation, DeviceStorageError, getDeviceLocation, pickDeviceFolder } from '../data/deviceStorage.ts';
import { useI18n, type MessageKey } from '../i18n/index.ts';
import { Panel } from '../ui/Panel.tsx';
import './dataLocation.css';

function errorKey(error: unknown): MessageKey {
  const known = ['locationInvalid', 'locationNetwork', 'locationSame', 'locationServed', 'locationNotWritable', 'locationHasData',
    'locationNoData', 'locationCorrupt', 'locationFixed', 'locationUnavailable', 'locationPickerUnavailable', 'locationPickerFailed'] as const;
  const code = error instanceof DeviceStorageError ? known.find((key) => key === error.code) : undefined;
  return code ? `settings.storage.err.${code}` : 'settings.storage.failed';
}

/** FR-339: choose the folder that holds the device database (Project packs, projects, settings). */
export function DataLocationPanel() {
  const { t } = useI18n();
  const [location, setLocation] = useState<DeviceLocation | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [picking, setPicking] = useState(false);
  const picker = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<DeviceFolderSelection | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    void getDeviceLocation().then(setLocation, () => setLoadError(true));
    return () => picker.current?.abort();
  }, []);

  const choose = async () => {
    if (picker.current) return;
    const controller = new AbortController();
    picker.current = controller;
    setPicking(true);
    setError(null);
    try {
      const selection = await pickDeviceFolder(t('settings.storage.pickerTitle'), controller.signal);
      if (!controller.signal.aborted && selection) setSelected(selection);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorKey(e));
    } finally {
      if (picker.current === controller) picker.current = null;
      if (!controller.signal.aborted) setPicking(false);
    }
  };

  const confirm = async () => {
    if (!selected) return;
    setSwitching(true);
    setError(null);
    try {
      await changeDeviceLocation(selected.path, selected.hasData ? 'open' : 'copy');
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
        <Button icon={<FolderOpen20Regular />} disabled={picking} onClick={() => void choose()} data-testid="data-location-change">{t('settings.storage.change')}</Button>
      )}
      {selected && (
        <div className="data-location-confirm" role="group" aria-label={t('settings.storage.selected', { path: selected.path })} data-testid="data-location-confirm">
          <p>{t('settings.storage.selected', { path: selected.path })}</p>
          <p data-testid="data-location-mode" data-mode={selected.hasData ? 'open' : 'copy'}>
            {t(selected.hasData ? 'settings.storage.modeOpen' : 'settings.storage.modeCopy')}
          </p>
          {selected.warnings.map((w) => (
            <MessageBar key={w} intent="warning"><MessageBarBody>{t(`settings.storage.warn.${w}`)}</MessageBarBody></MessageBar>
          ))}
          <div className="data-location-actions">
            <Button appearance="primary" disabled={switching} onClick={() => void confirm()} data-testid="data-location-confirm-button">
              {t(selected.hasData ? 'settings.storage.confirmOpen' : 'settings.storage.confirmCopy')}
            </Button>
            <Button disabled={switching} onClick={() => { setSelected(null); setError(null); }}>{t('settings.storage.cancel')}</Button>
          </div>
          {switching && <Spinner size="tiny" label={t('settings.storage.switching')} />}
        </div>
      )}
      <div aria-live="polite">
        {picking && <Spinner size="tiny" label={t('settings.storage.picking')} />}
        {error && <MessageBar intent="error" data-testid="data-location-error"><MessageBarBody>{t(error)}{error !== 'settings.storage.failed' && ` ${t('settings.storage.failed')}`}</MessageBarBody></MessageBar>}
      </div>
      <p className="muted">{t('settings.storage.keysNote')}</p>
      <p className="muted">{t('settings.storage.oldKept')}</p>
    </Panel>
  );
}
