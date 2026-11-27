import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Lang } from '../i18n/core.ts';
import { appStorage as localStorage, syncDeviceStore } from '../data/deviceStorage.ts';

export type ThemePref = 'dark' | 'light' | 'system';
export type MotionPref = 'system' | 'reduce' | 'full';
export type Audience = 'internal' | 'external';

export interface SettingsState {
  lang: Lang;
  theme: ThemePref;
  motion: MotionPref;
  showSplash: boolean;
  muted: boolean;
  bgm: boolean;
  sfx: boolean;
  volume: number;
  /** FR-002 / FR-117: who is watching. `external` hides `internal` content in cards, lists and charts. */
  audience: Audience;
  /** FR-379: the nav rail shows icons only, widening the main area. */
  navCollapsed: boolean;
  processWorker: string;
  processPeriod: 'month' | 'custom';
  processPeriodStart: string;
  processPeriodEnd: string;
  setProcessWorker: (worker: string) => void;
  setProcessPeriod: (period: 'month' | 'custom') => void;
  setProcessPeriodStart: (date: string) => void;
  setProcessPeriodEnd: (date: string) => void;
  setLang: (lang: Lang) => void;
  setTheme: (theme: ThemePref) => void;
  setMotion: (motion: MotionPref) => void;
  setShowSplash: (showSplash: boolean) => void;
  setMuted: (muted: boolean) => void;
  setBgm: (bgm: boolean) => void;
  setSfx: (sfx: boolean) => void;
  setVolume: (volume: number) => void;
  setAudience: (audience: Audience) => void;
  setNavCollapsed: (navCollapsed: boolean) => void;
}

export const SETTINGS_STORAGE_KEY = 'bas.settings';

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      lang: 'ja',
      theme: 'dark',
      motion: 'system',
      showSplash: true,
      muted: true,
      bgm: true,
      sfx: true,
      volume: 0.5,
      audience: 'internal',
      navCollapsed: false,
      processWorker: '',
      processPeriod: 'month',
      processPeriodStart: '',
      processPeriodEnd: '',
      setProcessWorker: (processWorker) => set({ processWorker }),
      setProcessPeriod: (processPeriod) => set({ processPeriod }),
      setProcessPeriodStart: (processPeriodStart) => set({ processPeriodStart }),
      setProcessPeriodEnd: (processPeriodEnd) => set({ processPeriodEnd }),
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setMotion: (motion) => set({ motion }),
      setShowSplash: (showSplash) => set({ showSplash }),
      setMuted: (muted) => set({ muted }),
      setBgm: (bgm) => set({ bgm }),
      setSfx: (sfx) => set({ sfx }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
      setAudience: (audience) => set({ audience }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ lang, theme, motion, showSplash, muted, bgm, sfx, volume, audience, navCollapsed, processWorker, processPeriod, processPeriodStart, processPeriodEnd }) => ({ lang, theme, motion, showSplash, muted, bgm, sfx, volume, audience, navCollapsed, processWorker, processPeriod, processPeriodStart, processPeriodEnd }),
    },
  ),
);
syncDeviceStore(SETTINGS_STORAGE_KEY, () => useSettings.persist.rehydrate());
