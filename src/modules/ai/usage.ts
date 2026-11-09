import { translate, type Lang, type MessageKey } from '../../i18n/core.ts';

/** PARAM-122: input characters for the generative-AI usage analysis (FR-284). */
export const USAGE_MAX_CHARS = 8000;
/** PARAM-121: timeout of one analysis call (FR-285). */
export const USAGE_TIMEOUT_MS = 60_000;

export class TimeoutError extends Error {
  constructor() {
    super('timeout');
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

const RULES: { key: MessageKey; words: string[] }[] = [
  { key: 'ai.usage.cat.chat', words: ['問い合わせ', '質問', 'faq', 'inquiry', 'question', 'support'] },
  { key: 'ai.usage.cat.document', words: ['請求', '書類', '帳票', '伝票', 'invoice', 'document', 'form', 'ocr'] },
  { key: 'ai.usage.cat.forecast', words: ['予測', '需要', '見込み', 'forecast', 'demand', 'predict'] },
  { key: 'ai.usage.cat.summary', words: ['会議', '議事録', '報告', 'meeting', 'minutes', 'report'] },
  { key: 'ai.usage.cat.quality', words: ['品質', '不良', '検査', 'quality', 'defect', 'inspection'] },
  { key: 'ai.usage.cat.drafting', words: ['メール', '提案書', '文書作成', 'email', 'proposal', 'draft'] },
];

/** Mock for use 'aiUsageAnalysis': keyword rules over the (already capped) text, strongest category first. */
export function usageMock(lang: Lang, text: string): string {
  const s = text.normalize('NFKC').toLowerCase();
  const scored = RULES.map((r) => ({ key: r.key, hits: r.words.reduce((n, w) => n + s.split(w).length - 1, 0) }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (scored.length === 0) return translate(lang, 'ai.usage.none');
  return scored.map((r) => translate(lang, 'ai.usage.line', { area: translate(lang, r.key), hits: r.hits })).join('\n');
}
