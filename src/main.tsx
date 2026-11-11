import { DeviceStorageError, initializeDeviceStorage, recoveryDeviceData } from './data/deviceStorage.ts';
import { translate, type Lang, type MessageKey } from './i18n/core.ts';
import { downloadBlob } from './modules/show/recorder.ts';
import './styles.css';

const lang: Lang = navigator.language.startsWith('ja') ? 'ja' : 'en';
const t = (key: MessageKey) => translate(lang, key);

async function start(useDeviceCopy = false) {
  const root = document.getElementById('root')!;
  root.textContent = t('device.loading');
  try {
    await initializeDeviceStorage(useDeviceCopy);
    const { boot } = await import('./bootstrap.tsx');
    await boot();
  } catch (error) {
    const section = document.createElement('section');
    section.className = 'device-startup-error';
    section.setAttribute('role', 'alert');
    section.dataset.testid = 'device-startup-error';
    const title = document.createElement('h1');
    title.textContent = t('device.title');
    const message = document.createElement('p');
    message.textContent = t(error instanceof DeviceStorageError && error.conflict ? 'device.conflict' : 'device.error');
    section.append(title, message);
    const button = (key: MessageKey, action: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = t(key);
      el.addEventListener('click', action);
      section.append(el);
    };
    button('device.retry', () => window.location.reload());
    button('device.recovery', () => {
      void recoveryDeviceData().then((data) => downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'bas-recovery.json'))
        .catch(() => { message.textContent = t('device.recoveryError'); });
    });
    if (error instanceof DeviceStorageError && error.migration) {
      button('device.useDevice', () => { void start(true); });
    }
    root.replaceChildren(section);
  }
}

void start();
