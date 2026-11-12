import { ja, type MessageKey } from './ja.ts';
import { en } from './en.ts';
import type { LText } from '../data/schema.ts';
import { PARAMS } from '../config/params.ts';

export type Lang = 'ja' | 'en';
export const LANGS: readonly Lang[] = ['ja', 'en'];
export const dictionaries: Record<Lang, Record<MessageKey, string>> = { ja, en };
export type { MessageKey };
export type Vars = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

export function isLang(v: unknown): v is Lang {
  return v === 'ja' || v === 'en';
}

export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const template = dictionaries[lang][key];
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function pick(lang: Lang, text: LText): string {
  return text[lang];
}

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!).sort();
}

export interface TranslationGaps {
  missing: Record<string, string[]>;
  extra: Record<string, string[]>;
  empty: Record<string, string[]>;
  placeholderMismatch: string[];
}

/** F-3.5.3: compares every language with the reference (ja). Any non-empty list is a failure. */
export function findTranslationGaps(dicts: Record<string, Record<string, string>>, reference = 'ja'): TranslationGaps {
  const ref = dicts[reference] ?? {};
  const refKeys = Object.keys(ref);
  const gaps: TranslationGaps = { missing: {}, extra: {}, empty: {}, placeholderMismatch: [] };
  for (const [lang, dict] of Object.entries(dicts)) {
    gaps.missing[lang] = refKeys.filter((k) => !(k in dict));
    gaps.extra[lang] = Object.keys(dict).filter((k) => !(k in ref));
    gaps.empty[lang] = Object.entries(dict).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k);
    if (lang !== reference) {
      for (const k of refKeys) {
        if (k in dict && placeholdersOf(ref[k]!).join() !== placeholdersOf(dict[k]!).join()) gaps.placeholderMismatch.push(`${lang}:${k}`);
      }
    }
  }
  return gaps;
}

export function hasGaps(g: TranslationGaps): boolean {
  return g.placeholderMismatch.length > 0 || [g.missing, g.extra, g.empty].some((m) => Object.values(m).some((l) => l.length > 0));
}

export function makeFormatters(lang: Lang) {
  // Intl constructors are costly and every useI18n() caller used to build its own set; the formatters are stateless.
  let cached = formatterCache.get(lang);
  if (!cached) formatterCache.set(lang, cached = buildFormatters(lang));
  return cached;
}

function buildFormatters(lang: Lang) {
  const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const pf = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const cf = new Intl.NumberFormat(locale, { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
  const df = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: PARAMS.timeZone });
  const mf = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', timeZone: PARAMS.timeZone });
  const tf = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: PARAMS.timeZone, timeZoneName: 'short' });
  const millions = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return {
    locale,
    number: (v: number) => nf.format(v),
    integer: (v: number) => nf0.format(v),
    percent: (v: number) => pf.format(v),
    yen: (v: number) => cf.format(v),
    /** Millions of yen: "186 百万円" / "¥186M". */
    yenCompact: (v: number) => (lang === 'ja' ? `${millions.format(v / 1_000_000)} 百万円` : `¥${millions.format(v / 1_000_000)}M`),
    date: (iso: string) => df.format(new Date(`${iso}T00:00:00+09:00`)),
    month: (d: Date) => mf.format(d),
    time: (d: Date) => tf.format(d),
  };
}
export type Formatters = ReturnType<typeof buildFormatters>;
const formatterCache = new Map<Lang, Formatters>();
