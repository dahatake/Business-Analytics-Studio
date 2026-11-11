import { useState, useSyncExternalStore } from 'react';
import { Button } from '@fluentui/react-components';
import { deviceStatus, recoveryDeviceData, subscribeDeviceStatus } from '../data/deviceStorage.ts';
import { useI18n } from '../i18n/index.ts';
import { downloadBlob } from '../modules/show/recorder.ts';

export function useDeviceBlocked() {
  const status = useSyncExternalStore(subscribeDeviceStatus, deviceStatus);
  return status === 'error' || status === 'conflict';
}

export function DeviceStorageStatus() {
  const status = useSyncExternalStore(subscribeDeviceStatus, deviceStatus);
  const { t } = useI18n();
  const [recoveryError, setRecoveryError] = useState(false);
  if (status === 'saved' || status === 'saving') {
    return <div className="device-save-status" role="status" data-testid="device-save-status" data-status={status}>{t(`device.${status}`)}</div>;
  }
  return (
    <div className="device-storage-blocker" role="alertdialog" aria-modal="true" aria-labelledby="device-error-title" aria-describedby="device-error-message" data-testid="device-storage-error">
      <h2 id="device-error-title">{t('device.title')}</h2>
      <p id="device-error-message">{t(`device.${status}`)}</p>
      <Button autoFocus onClick={() => {
        void recoveryDeviceData().then((data) => downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'bas-recovery.json'))
          .catch(() => setRecoveryError(true));
      }}>{t('device.recovery')}</Button>
      <Button onClick={() => window.location.reload()}>{t('device.retry')}</Button>
      {recoveryError && <p role="alert">{t('device.recoveryError')}</p>}
    </div>
  );
}
