/**
 * FR-090 (SHOULD): handwriting recognition. The real recognizer (Azure AI Vision Read) is BLOCKED by C-07 / C-03,
 * so the request goes through aiComplete (use 'import'), which answers with this registered mock. The UI labels it.
 */
import { aiComplete, registerMock, type AiResponse } from '../../ai/client.ts';
import { translate, type Lang } from '../../i18n/core.ts';
import { strokeStats, type Stroke } from './model.ts';

export const HANDWRITING_MARKER = 'ink.handwriting:';

const isHandwritingRequest = (req: { prompt: string }) => req.prompt.startsWith(HANDWRITING_MARKER);

/** Prompt sent for recognition (stroke geometry summary only; no images or entity data). */
export function handwritingPrompt(strokes: Stroke[]): string {
  const st = strokeStats(strokes);
  return `${HANDWRITING_MARKER} strokes=${st.strokes} points=${st.points}`;
}

/**
 * Registered right before each call. Only prompts carrying our marker get the ink mock; anything else falls back to
 * the generic mock text, so another module's 'import' calls are not answered with handwriting text.
 */
function ensureMock(): void {
  // A matcher keeps this mock to handwriting prompts, so other modules' 'import' mocks are not replaced.
  registerMock('import', (req) => {
    const count = Number(/strokes=(\d+)/.exec(req.prompt)?.[1] ?? 0);
    return translate(req.lang, 'ink.hw.mockText', { count });
  }, isHandwritingRequest);
}

export async function recognizeHandwriting(strokes: Stroke[], lang: Lang): Promise<AiResponse> {
  ensureMock();
  return aiComplete({ use: 'import', lang, prompt: handwritingPrompt(strokes) });
}
