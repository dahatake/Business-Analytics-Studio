import { useCallback, useMemo } from 'react';
import type { LText } from '../data/schema.ts';
import { useSettings } from '../state/settings.ts';
import { makeFormatters, pick, translate, type MessageKey, type Vars } from './core.ts';

export * from './core.ts';

export function useI18n() {
  const lang = useSettings((s) => s.lang);
  const t = useCallback((key: MessageKey, vars?: Vars) => translate(lang, key, vars), [lang]);
  const tx = useCallback((text: LText) => pick(lang, text), [lang]);
  const fmt = useMemo(() => makeFormatters(lang), [lang]);
  return { lang, t, tx, fmt };
}
export type T = ReturnType<typeof useI18n>['t'];
