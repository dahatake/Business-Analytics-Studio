import { DeviceStorageError, initializeDeviceStorage, recoveryDeviceData } from './data/deviceStorage.ts';
import { isLang, translate, type Lang, type MessageKey } from './i18n/core.ts';
import { downloadBlob } from './modules/show/recorder.ts';
import './styles.css';

let lang: Lang = navigator.language.startsWith('ja') ? 'ja' : 'en';
const t = (key: MessageKey) => translate(lang, key);
const root = document.getElementById('root')!;
const splash = root.firstElementChild!.cloneNode(true);

function showStartupStatus(key: MessageKey) {
  document.documentElement.lang = lang;
  root.querySelector('[data-testid="startup-status"]')!.textContent = t(key);
}

async function start(useDeviceCopy = false) {
  if (!root.querySelector('[data-testid="startup-splash"]')) root.replaceChildren(splash.cloneNode(true));
  showStartupStatus('device.loading');
  try {
    await initializeDeviceStorage(useDeviceCopy);
    showStartupStatus('startup.loading');
    const { useSettings } = await import('./state/settings.ts');
    const { lang: savedLang, motion } = useSettings.getState();
    if (isLang(savedLang)) lang = savedLang;
    if (motion === 'reduce') root.querySelector('[data-testid="startup-splash"]')!.setAttribute('data-reduce-motion', 'true');
    showStartupStatus('startup.loading');
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
