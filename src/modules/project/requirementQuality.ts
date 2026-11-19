import type { Lang } from '../../i18n/core.ts';

/**
 * Requirement statement checks after ISO/IEC/IEEE 29148 (IPA requirements handbook p.14): a requirement must be
 * unambiguous, verifiable and singular. The checks are deterministic and conservative: they flag wording a person
 * should look at, never rewrite it.
 */
export type QualityCode = 'vague' | 'compound';

export interface QualityIssue {
  code: QualityCode;
  /** The vague word found (for `vague`). */
  term?: string;
  line: string;
}

/** Words that cannot be verified by themselves. */
const VAGUE_JA = [
  '使いやすい', '使い易い', '使いやすく', '見やすい', 'わかりやすい', '分かりやすい', '迅速', '速やか', '素早', '適切', '柔軟', '十分', '容易', '簡単', '簡便',
  '高速', '高品質', '快適', 'スムーズ', 'ユーザーフレンドリー', '効率的', '効果的', '最適', '可能な限り', 'できるだけ', '必要に応じて', '良好', '頻繁', '大量', '堅牢', '直感的',
];
const VAGUE_EN = [
  'easy', 'easily', 'fast', 'quick', 'quickly', 'user-friendly', 'user friendly', 'appropriate', 'appropriately', 'flexible', 'sufficient', 'adequate',
  'efficient', 'efficiently', 'as needed', 'as appropriate', 'if possible', 'where possible', 'optimal', 'robust', 'seamless', 'timely', 'reasonable', 'intuitive', 'etc',
];

const DATE_WORDS = /(?:19|20)\d{2}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*日)?|\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{1,2}\/\d{1,2}|FY\s?\d{2,4}|Q[1-4]/gi;

/** A number tied to a bound: "3 分以内", "99.9% 以上", "within 3 minutes", "≥ 95%", "at most 5". Dates do not count. */
const BOUNDED = new RegExp([
  String.raw`\d[\d,.]*\s*(?:%|％|秒|分|時間|日間?|週間?|か月|ヶ月|件|回|人|倍|台|ms|s|sec|min|h|hours?|days?|weeks?|months?|items?|times)?\s*(?:以内|以上|以下|未満|超|まで|毎|ごと|per|or (?:less|more|fewer)|or (?:higher|lower))`,
  String.raw`(?:within|at least|at most|no more than|no less than|under|over|below|above|every|each|<=?|>=?|≤|≥|＜|＞|以上|以下|未満|最大|最小|最低|少なくとも)\s*\d[\d,.]*`,
  String.raw`\d[\d,.]*\s*(?:%|％)`,
].join('|'), 'i');

export function hasBound(sentence: string): boolean {
  return BOUNDED.test(sentence.replace(DATE_WORDS, ' '));
}

const COMPOUND_JA = /(?:こと|する|できる|される)[、,]?\s*(?:かつ|ならびに|並びに|および|及び)\s*/;
const COMPOUND_EN = /\b(?:shall|must|should)\b[^.;]*\b(?:and|;)\s+(?:[a-z]+\s+){0,3}(?:shall|must|should)\b/i;

const PLACEHOLDER = /【要記入】|\[TO FILL\]/;

/** The statement behind a list line: no bullet and no ID prefix ("- BR-lead-time: …"). */
function bare(line: string): string {
  return line.replace(/^\s*(?:[-*・]\s*)?(?:[A-Z]{1,4}-[\w.-]+\s*[:：]\s*)?/, '').trim();
}

export function checkRequirementLine(line: string, lang: Lang): QualityIssue[] {
  const s = bare(line);
  if (!s || PLACEHOLDER.test(s)) return [];
  const out: QualityIssue[] = [];
  const terms = lang === 'ja' ? VAGUE_JA : VAGUE_EN;
  const lower = s.toLowerCase();
  const found = terms.find((w) => (lang === 'ja' ? s.includes(w) : new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i').test(lower)));
  if (found && !hasBound(s)) out.push({ code: 'vague', term: found, line: s });
  if ((lang === 'ja' ? COMPOUND_JA : COMPOUND_EN).test(s)) out.push({ code: 'compound', line: s });
  return out;
}

/** Checks every statement line of a section text; nested lines, headings, tables and notes are skipped. */
export function checkRequirementText(text: string, lang: Lang): QualityIssue[] {
  return text.split('\n').flatMap((raw) => {
    if (!raw.trim() || /^\s{2,}/.test(raw) || /^(?:#|\||>|※)/.test(raw.trim())) return [];
    return checkRequirementLine(raw, lang);
  });
}

/** Both languages: a field's text is written in either. */
export const checkAnyLanguage = (text: string): QualityIssue[] => {
  const ja = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  return checkRequirementText(text, ja ? 'ja' : 'en');
};
