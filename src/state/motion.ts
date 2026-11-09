import { useSyncExternalStore } from 'react';
import { useSettings } from './settings.ts';

function mediaStore(query: string) {
  const subscribe = (cb: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', cb);
    return () => mql.removeEventListener('change', cb);
  };
  const get = () => window.matchMedia(query).matches;
  return { subscribe, get };
}

const reduceStore = mediaStore('(prefers-reduced-motion: reduce)');
const darkStore = mediaStore('(prefers-color-scheme: dark)');

/** F-3.1.5: honor the OS setting unless the user overrides it in the app. */
export function useReducedMotion(): boolean {
  const pref = useSettings((s) => s.motion);
  const os = useSyncExternalStore(reduceStore.subscribe, reduceStore.get, () => false);
  return pref === 'reduce' || (pref === 'system' && os);
}

export function useEffectiveDark(): boolean {
  const pref = useSettings((s) => s.theme);
  const os = useSyncExternalStore(darkStore.subscribe, darkStore.get, () => true);
  return pref === 'dark' || (pref === 'system' && os);
}

/** Duration helper for d3 transitions: 0 when motion is reduced. */
export function motionMs(reduced: boolean, ms: number): number {
  return reduced ? 0 : ms;
}
