import { translate, type MessageKey } from '../../i18n/core.ts';
import type { LText } from '../../data/schema.ts';
import { loc, type Localizable } from '../../state/text.ts';

/** Build bilingual data text from a dictionary template (generated data stays bilingual, F-3.5.1). */
export function both(key: MessageKey, vars: Record<string, Localizable | number> = {}): LText {
  const per = (lang: 'ja' | 'en') =>
    translate(lang, key, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'number' ? v : loc(v, lang)])));
  return { ja: per('ja'), en: per('en') };
}

/** Apply a function to every language of a Localizable, keeping user-typed strings as strings. */
export function mapLoc(text: Localizable, fn: (s: string) => string): Localizable {
  return typeof text === 'string' ? fn(text) : { ja: fn(text.ja), en: fn(text.en) };
}

export function isBlank(text: Localizable | undefined): boolean {
  if (text === undefined) return true;
  return typeof text === 'string' ? text.trim() === '' : text.ja.trim() === '' && text.en.trim() === '';
}
