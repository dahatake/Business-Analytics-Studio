import { aiComplete, registerMock, type AiRequest, type AiResponse } from '../../ai/client.ts';
import { loaded, type LoadedPack } from '../../data/pack.ts';
import type { Entity } from '../../data/schema.ts';
import { pick, translate, type Lang, type MessageKey } from '../../i18n/core.ts';
import { PERSONA_VIEWS, type PersonaView } from '../../state/personas.ts';
import type { Audience } from '../../state/settings.ts';
import { buildChapters, chapterPoints, chapterTitleKey, rankSolutions, solutionReasons, SHOW_PARAMS } from './model.ts';

/**
 * FR-290 mock: a deterministic outline built from the pack only, in the requested language.
 * The persona and audience travel in the prompt so the mock answers the same request the live model would get.
 */
export function buildOutline(lang: Lang, persona: PersonaView, audience: Audience, data: LoadedPack = loaded): string {
  const lines: string[] = [];
  lines.push(`# ${translate(lang, 'show.outline.heading', { persona: translate(lang, `persona.${persona}` as MessageKey) })}`);
  buildChapters(audience, data).forEach((ch, i) => {
    lines.push(`${i + 1}. ${translate(lang, chapterTitleKey(ch.id))}: ${chapterPoints(ch, lang)[0] ?? ''}`);
  });
  lines.push(`## ${translate(lang, 'show.outline.top', { count: SHOW_PARAMS.storyTopSolutions })}`);
  const top = rankSolutions(audience, data).slice(0, SHOW_PARAMS.storyTopSolutions);
  if (top.length === 0) lines.push(`- ${translate(lang, 'show.missing.solutions')}`);
  top.forEach((item, i) => {
    lines.push(`- ${i + 1}. ${pick(lang, item.solution.name)}: ${solutionReasons(item, persona, lang, data).join(' / ')}`);
  });
  return lines.join('\n');
}

export function presentationPrompt(persona: PersonaView, audience: Audience): string {
  return [
    'Create a presentation story outline (chapters: opening, issue ranking, before/after, ROI, KPIs, solutions, next actions).',
    `persona: ${persona}`,
    `audience: ${audience}`,
    `maxOutputTokens: ${SHOW_PARAMS.aiMaxOutputTokens}`,
  ].join('\n');
}

export function parsePrompt(prompt: string): { persona: PersonaView; audience: Audience } {
  const p = /persona:\s*(\w+)/.exec(prompt)?.[1];
  const a = /audience:\s*(\w+)/.exec(prompt)?.[1];
  return {
    persona: PERSONA_VIEWS.includes(p as PersonaView) ? p as PersonaView : 'executive',
    audience: a === 'internal' ? 'internal' : 'external',
  };
}

export function presentationMock(req: AiRequest): string {
  const { persona, audience } = parsePrompt(req.prompt);
  return buildOutline(req.lang, persona, audience);
}

registerMock('presentation', presentationMock);

export type GenerateResult = { ok: true; res: AiResponse } | { ok: false; reason: 'timeout' | 'error' };

/** FR-290: one request with the PARAM-127 wait limit and the PARAM-132 output cap. */
export async function generateStory(lang: Lang, persona: PersonaView, audience: Audience, timeoutMs: number = SHOW_PARAMS.aiTimeoutMs): Promise<GenerateResult> {
  const top = rankSolutions(audience).slice(0, SHOW_PARAMS.storyTopSolutions);
  const entities: Entity[] = top.flatMap((t) => (t.issue ? [t.solution, t.issue] : [t.solution]));
  // `maxOutputTokens` is carried for the live relay (PARAM-132); the shared AiRequest type does not declare it yet.
  const req = { use: 'presentation' as const, lang, prompt: presentationPrompt(persona, audience), entities, maxOutputTokens: SHOW_PARAMS.aiMaxOutputTokens };
  let timer = 0;
  const timeout = new Promise<GenerateResult>((resolve) => { timer = window.setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs); });
  try {
    return await Promise.race([aiComplete(req).then((res): GenerateResult => ({ ok: true, res })), timeout]);
  } catch {
    return { ok: false, reason: 'error' };
  } finally {
    window.clearTimeout(timer);
  }
}
