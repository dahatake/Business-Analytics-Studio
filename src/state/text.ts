import type { Lang } from '../i18n/core.ts';

/** Sample data is bilingual; text the user types is kept as typed (§3.2: data entered by users is not translated). */
export type Localizable = string | { ja: string; en: string };

export function loc(text: Localizable, lang: Lang): string {
  return typeof text === 'string' ? text : text[lang];
}

/** All languages' text, for search and for Markdown export. */
export function locAll(text: Localizable): string[] {
  return typeof text === 'string' ? [text] : [text.ja, text.en];
}
