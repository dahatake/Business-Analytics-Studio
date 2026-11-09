import doc from '../../../docs/copilot-customer-pack-prompt.md?raw';
import type { Lang } from '../../i18n/index.ts';

/** The Microsoft 365 Copilot prompt (docs/copilot-customer-pack-prompt.md is the single source). */
export const PROMPT_DOC: string = doc;

export function promptSection(source: string, lang: Lang): string {
  const m = new RegExp(`<!-- prompt:${lang}:start -->([\\s\\S]*?)<!-- prompt:${lang}:end -->`).exec(source);
  return (m?.[1] ?? '').replace(/\r\n/g, '\n').trim();
}

export function copilotPrompt(lang: Lang): string {
  return promptSection(PROMPT_DOC, lang);
}
