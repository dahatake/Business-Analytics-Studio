import { DeviceStorageError, changeDeviceLocation, getDeviceLocation, initializeDeviceStorage, recoveryDeviceData } from './data/deviceStorage.ts';
import { isLang, translate, type Lang, type MessageKey } from './i18n/core.ts';
import { downloadBlob } from './modules/show/recorder.ts';
import './styles.css';

let lang: Lang = navigator.language.startsWith('ja') ? 'ja' : 'en';
const t = (key: MessageKey, vars?: Record<string, string>) => translate(lang, key, vars);
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
    const { useSettings } = await import('./state/settings.ts');
    const { lang: savedLang, motion, showSplash } = useSettings.getState();
    if (isLang(savedLang)) lang = savedLang;
    if (showSplash) {
      if (motion === 'reduce') root.querySelector('[data-testid="startup-splash"]')!.setAttribute('data-reduce-motion', 'true');
      showStartupStatus('startup.loading');
    } else {
      root.replaceChildren();
    }
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
    const unavailable = error instanceof DeviceStorageError && error.locationUnavailable;
    message.textContent = t(unavailable ? 'device.locationUnavailable' : error instanceof DeviceStorageError && error.conflict ? 'device.conflict' : 'device.error');
    section.append(title, message);
    if (unavailable) {
      const path = document.createElement('p');
      path.dataset.testid = 'device-location-path';
      section.append(path);
      void getDeviceLocation().then((location) => { if (location.path) path.textContent = t('device.locationPath', { path: location.path }); }, () => {});
    }
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
    if (unavailable) {
      button('device.useDefaultLocation', () => {
        void changeDeviceLocation(null, 'default').catch(() => { message.textContent = t('device.error'); });
      });
    }
    root.replaceChildren(section);
  }
}

void start();
