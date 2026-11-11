import type { BrandVariants } from '@fluentui/react-components';
import { appStorage as localStorage, syncDeviceStore } from '../../data/deviceStorage.ts';
import { useMemo } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { loaded } from '../../data/pack.ts';
import { NO_OVERRIDE, parseBrand, resolveBrand, type BrandOverride, type BrandTone, type ResolvedBrand } from './brand.ts';

/** Default 16-step brand ramp (PARAM-017). The ops module replaces this with the customer pack's brand (FR-059). */
export const DEFAULT_BRAND: BrandVariants = {
  10: '#020305', 20: '#111723', 30: '#16263D', 40: '#193253', 50: '#1B3F6A', 60: '#1B4C82', 70: '#18599B', 80: '#1267B4',
  90: '#3174C2', 100: '#4F82C8', 110: '#6790CF', 120: '#7D9ED5', 130: '#92ACDC', 140: '#A6BAE2', 150: '#BAC9E9', 160: '#CDD8EF',
};

export const BRAND_STORAGE_KEY = 'bas.ops.brand';

interface BrandOverrideState extends BrandOverride {
  setPrimary: (primary: string | null) => void;
  setTone: (tone: BrandTone | null) => void;
  setFontFamily: (fontFamily: string | null) => void;
  reset: () => void;
}

/** FR-064: the user's brand override, persisted on this PC (applies to the loaded pack, not per project). */
export const useBrandOverride = create<BrandOverrideState>()(
  persist(
    (set) => ({
      ...NO_OVERRIDE,
      setPrimary: (primary) => set({ primary }),
      setTone: (tone) => set({ tone }),
      setFontFamily: (fontFamily) => set({ fontFamily: fontFamily?.trim() ? fontFamily.trim() : null }),
      reset: () => set({ ...NO_OVERRIDE }),
    }),
    {
      name: BRAND_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ primary, tone, fontFamily }) => ({ primary, tone, fontFamily }),
    },
  ),
);
syncDeviceStore(BRAND_STORAGE_KEY, () => useBrandOverride.persist.rehydrate());

export function useResolvedBrand(): ResolvedBrand {
  const primary = useBrandOverride((s) => s.primary);
  const tone = useBrandOverride((s) => s.tone);
  const fontFamily = useBrandOverride((s) => s.fontFamily);
  const extensions = loaded.pack.extensions;
  return useMemo(() => resolveBrand(parseBrand(extensions), { primary, tone, fontFamily }, DEFAULT_BRAND), [extensions, primary, tone, fontFamily]);
}

/** Feeds the app theme (App.tsx). Returns DEFAULT_BRAND unchanged when neither the pack nor the user sets a brand. */
export function useBrandVariants(): BrandVariants {
  return useResolvedBrand().variants;
}
