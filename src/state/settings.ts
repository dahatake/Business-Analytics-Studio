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
  muted: boolean;
  bgm: boolean;
  sfx: boolean;
  volume: number;
  /** FR-002 / FR-117: who is watching. `external` hides `internal` content in cards, lists and charts. */
  audience: Audience;
  setLang: (lang: Lang) => void;
  setTheme: (theme: ThemePref) => void;
  setMotion: (motion: MotionPref) => void;
  setMuted: (muted: boolean) => void;
  setBgm: (bgm: boolean) => void;
  setSfx: (sfx: boolean) => void;
  setVolume: (volume: number) => void;
  setAudience: (audience: Audience) => void;
}

export const SETTINGS_STORAGE_KEY = 'bas.settings';

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      lang: 'ja',
      theme: 'dark',
      motion: 'system',
      muted: true,
      bgm: true,
      sfx: true,
      volume: 0.5,
      audience: 'internal',
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setMotion: (motion) => set({ motion }),
      setMuted: (muted) => set({ muted }),
      setBgm: (bgm) => set({ bgm }),
      setSfx: (sfx) => set({ sfx }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
      setAudience: (audience) => set({ audience }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ lang, theme, motion, muted, bgm, sfx, volume, audience }) => ({ lang, theme, motion, muted, bgm, sfx, volume, audience }),
    },
  ),
);
syncDeviceStore(SETTINGS_STORAGE_KEY, () => useSettings.persist.rehydrate());
