/**
 * FR-159: name normalization so spelling variants of one data entity are treated as the same.
 * NFKC (full-width → half-width, half-width katakana → full-width), case folding, whitespace / hyphen /
 * underscore / middle-dot removal, and katakana long-vowel variants (サーバー = サーバ = サーバ-).
 */
export function normalizeName(raw: string): string {
  let s = raw.normalize('NFKC').toLowerCase();
  // A dash-like character right after katakana is a long-vowel mark written with the wrong character.
  s = s.replace(/([\u30A1-\u30FA])[\u2010-\u2015\u2212\-~\u301C]+/g, '$1\u30FC');
  // Long-vowel marks after katakana are optional in Japanese spelling (JIS Z 8301), so drop them.
  s = s.replace(/([\u30A1-\u30FA])\u30FC+/g, '$1');
  s = s.replace(/[\s\u3000\-_\u2010-\u2015\u2212\u30FB\uFF65./\\]+/g, '');
  return s;
}

/** Same normalization for identifiers (ids from a company catalog may differ only in case or separators). */
export const normalizeId = normalizeName;

/** Count characters as people see them (code points), not UTF-16 units. */
export function charLength(s: string): number {
  return Array.from(s).length;
}

/** Cut text to at most `max` characters, marking the cut with an ellipsis that counts toward the limit. */
export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s.trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}\u2026`;
}
