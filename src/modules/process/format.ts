import type { ArtifactForm } from '../../data/extensionSchemas.ts';
import type { Formatters, Lang } from '../../i18n/core.ts';
import type { MessageKey, Vars } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import type { PLoop } from './model.ts';

type T = (key: MessageKey, vars?: Vars) => string;

/** A duration in the unit a reader expects: minutes under an hour, hours under two days, otherwise days. */
export function duration(hours: number | null, t: T, fmt: Formatters): string {
  if (hours === null) return t('bp.unknown');
  if (hours < 1) return t('bp.unit.min', { n: fmt.integer(hours * 60) });
  if (hours < 48) return t('bp.unit.hours', { n: fmt.number(hours) });
  return t('bp.unit.days', { n: fmt.number(hours / 24) });
}

export function hoursMonth(h: number | null, t: T, fmt: Formatters): string {
  return h === null ? t('bp.unknown') : t('bp.unit.hoursMonth', { n: fmt.integer(h) });
}

/** "−63%" / "+12%"; a removed step reads as "−100%". */
export function signedPercent(d: number | null, fmt: Formatters): string {
  if (d === null) return '—';
  const p = fmt.percent(Math.abs(d));
  return d < 0 ? `−${p}` : d > 0 ? `+${p}` : p;
}

export const formKey = (f: ArtifactForm) => `bp.form.${f}` as MessageKey;

export function loopShort(l: PLoop, t: T, lang: Lang, fmt: Formatters): string {
  const kind = t(`bp.loop.${l.kind}`);
  if (l.cadence) return `${kind} · ${loc(l.cadence, lang)}`;
  if (l.ratePct !== null) return `${kind} · ${fmt.integer(l.ratePct)}%`;
  return kind;
}

export function loopText(l: PLoop, t: T, lang: Lang, fmt: Formatters): string {
  return [loopShort(l, t, lang, fmt), l.label ? loc(l.label, lang) : ''].filter(Boolean).join(': ');
}
