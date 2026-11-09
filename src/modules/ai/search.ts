import type { Entity, EntityKind } from '../../data/schema.ts';
import { translate, type Lang } from '../../i18n/core.ts';
import { locAll } from '../../state/text.ts';
import type { UseCase } from '../usecases/store.ts';

/** FR-017 local full-text search over pack entities and use cases, in both languages. Nothing leaves the PC. */
export interface SearchDoc {
  id: string;
  type: 'entity' | 'usecase';
  kind?: EntityKind;
  fields: { text: string; weight: number }[];
}

export interface SearchHit {
  id: string;
  type: 'entity' | 'usecase';
  score: number;
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/;
export const NAME_WEIGHT = 3;
export const BODY_WEIGHT = 1;
export const PHRASE_BONUS = 2;

export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/** Latin/digit words as-is; Japanese runs as character bigrams (single characters when the run is one long). */
export function tokenize(raw: string): string[] {
  const s = normalize(raw);
  const out: string[] = [];
  for (const m of s.matchAll(/[a-z0-9]+|[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]+/g)) {
    const w = m[0];
    if (!CJK.test(w)) out.push(w);
    else if (w.length === 1) out.push(w);
    else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
  }
  return out;
}

export function buildIndex(entities: Entity[], useCases: UseCase[]): SearchDoc[] {
  const docs: SearchDoc[] = entities.map((e) => ({
    id: e.id,
    type: 'entity',
    kind: e.kind,
    fields: [
      { text: `${e.name.ja}\n${e.name.en}`, weight: NAME_WEIGHT },
      { text: `${e.description.ja}\n${e.description.en}`, weight: BODY_WEIGHT },
    ],
  }));
  for (const u of useCases) {
    docs.push({
      id: u.id,
      type: 'usecase',
      fields: [
        { text: locAll(u.name).join('\n'), weight: NAME_WEIGHT },
        { text: [...locAll(u.summary), ...u.steps.flatMap((s) => [...locAll(s.title), ...locAll(s.description)])].join('\n'), weight: BODY_WEIGHT },
      ],
    });
  }
  return docs;
}

/**
 * Ranking: every query token found in a field adds the field weight (names count three times the body), and the whole
 * query appearing verbatim adds a phrase bonus. Ties are broken by id so results are deterministic.
 */
export function search(docs: SearchDoc[], query: string, limit = 20): SearchHit[] {
  const q = normalize(query).trim();
  const tokens = [...new Set(tokenize(q))];
  if (tokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const d of docs) {
    let score = 0;
    for (const f of d.fields) {
      const text = normalize(f.text);
      const fieldTokens = new Set(tokenize(text));
      for (const t of tokens) if (fieldTokens.has(t) || (!CJK.test(t) && text.includes(t))) score += f.weight;
      if (q.length > 1 && text.includes(q)) score += f.weight * PHRASE_BONUS;
    }
    if (score > 0) hits.push({ id: d.id, type: d.type, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** PARAM-123: question+answer pairs carried as conversation context. */
export const CHAT_CONTEXT_PAIRS = 5;

export interface ChatTurn {
  q: string;
  a: string;
  citations: string[];
  reasons: string[];
}

export function contextWindow<T>(history: T[], pairs = CHAT_CONTEXT_PAIRS): T[] {
  return pairs <= 0 ? [] : history.slice(-pairs);
}

/** Prompt with the last PARAM-123 pairs and the new question. */
export function chatPrompt(question: string, history: ChatTurn[]): string {
  const past = contextWindow(history).map((t) => `Q: ${t.q}\nA: ${t.a}`).join('\n');
  return past ? `${past}\nQ: ${question}` : `Q: ${question}`;
}

/** Number of past pairs contained in a chat prompt. */
export function pairsInPrompt(prompt: string): number {
  return Math.max(0, (prompt.match(/^Q: /gm) ?? []).length - 1);
}

/** Mock for use 'chat': grounded only in the outbound context (shareable hits), with the context size stated. */
export function chatMock(lang: Lang, prompt: string, context: string): string {
  const lines = context.split('\n').filter(Boolean).slice(0, 3).map((l) => l.replace(/^- \[[a-z]+\] /, ''));
  const pairs = pairsInPrompt(prompt);
  if (lines.length === 0) return `${translate(lang, 'ai.chat.noHits')} ${translate(lang, 'ai.chat.contextUsed', { pairs })}`;
  return [translate(lang, 'ai.chat.answerIntro', { count: lines.length }), ...lines.map((l) => `• ${l}`), translate(lang, 'ai.chat.contextUsed', { pairs })].join('\n');
}
