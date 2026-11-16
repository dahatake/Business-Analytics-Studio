/** FR-090 (SHOULD): local mock until the Azure AI Vision integration is available under C-07. */
import type { AiResponse } from '../../ai/client.ts';
import { translate, type Lang } from '../../i18n/core.ts';
import { strokeStats, type Stroke } from './model.ts';

export async function recognizeHandwriting(strokes: Stroke[], lang: Lang): Promise<AiResponse> {
  const { strokes: count } = strokeStats(strokes);
  return {
    mode: 'mock',
    text: translate(lang, 'ink.hw.mockText', { count }),
    blockedReasons: [],
    withheldIds: [],
    context: '',
  };
}
