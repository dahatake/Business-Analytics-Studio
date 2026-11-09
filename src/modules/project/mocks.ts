import { aiComplete, registerMock, type AiResponse } from '../../ai/client.ts';
import type { Entity } from '../../data/schema.ts';
import type { Lang } from '../../i18n/core.ts';
import type { Localizable } from '../../state/text.ts';
import { categoriesOf, type CategoryId } from './analysis.ts';
import { METHODS, type MethodId } from './model.ts';

const MARK_STRUCTURE = '[bas-proj:structure:';
const MARK_RECOMMEND = '[bas-proj:recommend]';

type Bi = { ja: string; en: string };
const DRAFTS: Record<MethodId, [CategoryId, Bi, number][]> = {
  swot: [
    ['strengths', { ja: '熟練した技術者による高い加工精度', en: 'High machining precision from skilled engineers' }, 4],
    ['weaknesses', { ja: '計画と在庫の情報が部門ごとに分かれている', en: 'Planning and inventory data are split across departments' }, 4],
    ['opportunities', { ja: '電動化で精密部品の需要が増えている', en: 'Electrification is raising demand for precision parts' }, 4],
    ['threats', { ja: 'エネルギー価格の変動', en: 'Volatile energy prices' }, 3],
  ],
  fiveForces: [
    ['rivalry', { ja: '国内の同業との価格競争', en: 'Price competition with domestic peers' }, 4],
    ['newEntrants', { ja: '設備投資が大きく参入は限られる', en: 'High capital needs limit new entrants' }, 2],
    ['substitutes', { ja: '樹脂部品への置き換え', en: 'Replacement by resin parts' }, 3],
    ['buyerPower', { ja: '大口顧客の値下げ要求', en: 'Price-down requests from large customers' }, 4],
    ['supplierPower', { ja: '特殊鋼の調達先が少ない', en: 'Few sources of special steel' }, 3],
  ],
  valueChain: [
    ['inbound', { ja: '材料の受け入れ検査', en: 'Incoming material inspection' }, 3],
    ['operations', { ja: '多品種少量の段取り替え', en: 'Changeovers for high-mix, low-volume runs' }, 2],
    ['outbound', { ja: '出荷の締め切り管理', en: 'Shipping cut-off management' }, 3],
    ['technology', { ja: '加工条件のノウハウ', en: 'Machining-condition know-how' }, 4],
  ],
  threeC: [
    ['customer', { ja: '短納期と品質の安定を求める', en: 'Customers want short lead times and stable quality' }, 4],
    ['competitor', { ja: '競合は価格で先行', en: 'Competitors lead on price' }, 4],
    ['company', { ja: '精度と対応力で優位', en: 'We lead on precision and responsiveness' }, 4],
  ],
  bsc: [
    ['financial', { ja: '売掛金の回収を早める', en: 'Collect receivables sooner' }, 3],
    ['customerView', { ja: '納期遵守率を上げる', en: 'Raise on-time delivery' }, 3],
    ['process', { ja: '検査を自動化する', en: 'Automate inspection' }, 2],
    ['learning', { ja: '技能の継承を仕組みにする', en: 'Make skills transfer systematic' }, 3],
  ],
};

const SUGGESTIONS: Bi[] = [
  { ja: '関係者で合意できる目標値と期限を先に決める。', en: 'Agree on a target value and a deadline with the stakeholders first.' },
  { ja: '小さな範囲で試行し、効果を KPI で確かめてから広げる。', en: 'Pilot on a small scope and confirm the effect with a KPI before scaling.' },
];

/** Deterministic, bilingual mock for FR-140 (analysis draft): one `category|text|score` line per item. */
function structureMock(prompt: string, lang: Lang): string {
  const start = prompt.indexOf(MARK_STRUCTURE);
  const method = start >= 0 ? prompt.slice(start + MARK_STRUCTURE.length).split(']')[0] : '';
  const rows = METHODS.includes(method as MethodId) ? DRAFTS[method as MethodId] : [];
  return rows.map(([c, text, score]) => `${c}|${text[lang]}|${score}`).join('\n');
}

/** Deterministic, bilingual mock for FR-050 AI suggestions: one suggestion per line. */
function recommendMock(lang: Lang): string {
  return SUGGESTIONS.map((s) => s[lang]).join('\n');
}

export interface DraftItem {
  category: CategoryId;
  text: Localizable;
  score: number;
}

/** Mock answers we recognise are kept bilingual, so switching the language still shows them translated. */
function bilingual(text: string, lang: Lang, known: Bi[]): Localizable {
  return known.find((k) => k[lang] === text) ?? text;
}
const KNOWN_DRAFTS: Bi[] = Object.values(DRAFTS).flatMap((rows) => rows.map((r) => r[1]));

export function parseDraft(method: MethodId, text: string, lang: Lang = 'ja'): DraftItem[] {
  const cats = categoriesOf(method) as readonly string[];
  return text.split('\n').flatMap((line) => {
    const [c, t, s] = line.split('|');
    if (!c || !t || !cats.includes(c)) return [];
    const score = Number(s);
    return [{ category: c as CategoryId, text: bilingual(t.trim(), lang, KNOWN_DRAFTS), score: Number.isFinite(score) ? score : 3 }];
  });
}

/** FR-140: ask for an analysis draft. Only through aiComplete (C-03 gate); answers are labelled as mock. */
export async function requestAnalysisDraft(method: MethodId, lang: Lang, entities: Entity[]): Promise<{ response: AiResponse; items: DraftItem[] }> {
  // Registered right before the call so another module's mock for the same use cannot answer this request.
  registerMock('structure', (req) => (req.prompt.includes(MARK_STRUCTURE) ? structureMock(req.prompt, req.lang) : `[mock] ${req.prompt.slice(0, 80)}`));
  const response = await aiComplete({ use: 'structure', lang, prompt: `${MARK_STRUCTURE}${method}] draft analysis`, entities });
  return { response, items: parseDraft(method, response.text, lang) };
}

/** FR-050: AI suggestions for a theme. */
export async function requestSuggestions(themeTitle: string, lang: Lang, entities: Entity[]): Promise<{ response: AiResponse; lines: Localizable[] }> {
  registerMock('recommend', (req) => (req.prompt.includes(MARK_RECOMMEND) ? recommendMock(req.lang) : `[mock] ${req.prompt.slice(0, 80)}`));
  const response = await aiComplete({ use: 'recommend', lang, prompt: `${MARK_RECOMMEND} ${themeTitle}`, entities });
  return { response, lines: response.text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => bilingual(l, lang, SUGGESTIONS)) };
}
