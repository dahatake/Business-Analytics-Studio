/**
 * FR-326: industry archetypes for resource optimization. The customer's industry text (as entered by the user, or the
 * pack's company.industry) decides which resources and which demand the optimization looks at, and which assumptions
 * fill the numbers a pack rarely states (PARAM-159, PARAM-160).
 */
export const ARCHETYPES = [
  'manufacturing', 'retail', 'logistics', 'itServices', 'healthcare', 'construction', 'energy', 'finance', 'public', 'generic',
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** people: people's hours → work items. network: sites' capacity → regional demand (needs pack.optimization). */
export type Lens = 'people' | 'network';

export interface ArchetypeProfile {
  /** The lens an expert of the industry starts from when the data for it exists. */
  preferredLens: Lens;
  /** PARAM-159: productive hours per person per month and the utilization ceiling the plan should respect. */
  hoursPerPersonMonth: number;
  maxUtilization: number;
  /** PARAM-160: hours a month one work item of medium impact (3 of 5) needs when the pack states no effort. */
  effortBaseHours: number;
}

export const ARCHETYPE_PROFILES: Record<Archetype, ArchetypeProfile> = {
  manufacturing: { preferredLens: 'network', hoursPerPersonMonth: 150, maxUtilization: 0.85, effortBaseHours: 40 },
  retail: { preferredLens: 'network', hoursPerPersonMonth: 160, maxUtilization: 0.9, effortBaseHours: 32 },
  logistics: { preferredLens: 'network', hoursPerPersonMonth: 160, maxUtilization: 0.9, effortBaseHours: 32 },
  itServices: { preferredLens: 'people', hoursPerPersonMonth: 140, maxUtilization: 0.8, effortBaseHours: 60 },
  healthcare: { preferredLens: 'people', hoursPerPersonMonth: 150, maxUtilization: 0.85, effortBaseHours: 40 },
  construction: { preferredLens: 'people', hoursPerPersonMonth: 160, maxUtilization: 0.85, effortBaseHours: 60 },
  energy: { preferredLens: 'network', hoursPerPersonMonth: 150, maxUtilization: 0.85, effortBaseHours: 40 },
  finance: { preferredLens: 'people', hoursPerPersonMonth: 140, maxUtilization: 0.8, effortBaseHours: 40 },
  public: { preferredLens: 'people', hoursPerPersonMonth: 140, maxUtilization: 0.8, effortBaseHours: 40 },
  generic: { preferredLens: 'people', hoursPerPersonMonth: 140, maxUtilization: 0.8, effortBaseHours: 40 },
};

/** Keywords per archetype (Japanese and English). Short English tokens are matched as whole words. */
const KEYWORDS: Record<Exclude<Archetype, 'generic'>, (string | RegExp)[]> = {
  manufacturing: ['製造', 'メーカー', '機械', '精密', '精工', '部品', '化学', '素材', '鉄鋼', '金属', '自動車', '電子部品', '半導体', '機器', '工業', '食品', '製薬',
    /manufactur/i, /machinery/i, /industrial/i, /automotive/i, /chemical/i, /semiconductor/i, /materials/i, /precision/i, /\bfood\b/i, /pharma/i],
  retail: ['小売', '流通', '卸', '百貨店', 'スーパー', 'コンビニ', '通販', '消費財', /retail/i, /wholesale/i, /consumer goods/i, /\bstores?\b/i, /e-?commerce/i],
  logistics: ['物流', '運輸', '倉庫', '配送', '海運', '陸運', '航空貨物', /logistic/i, /transport/i, /shipping/i, /warehous/i, /freight/i],
  itServices: ['ソフトウェア', 'クラウド', '情報', 'システム', 'コンサル', '通信', /software/i, /cloud/i, /consult/i, /professional services/i, /information technology/i, /\bIT\b/, /\bAI\b/, /\bSaaS\b/i, /telecom/i],
  healthcare: ['医療', '病院', '介護', 'クリニック', 'ヘルスケア', /healthcare/i, /hospital/i, /clinic/i, /\bcare\b/i],
  construction: ['建設', '建築', '土木', 'ゼネコン', 'エンジニアリング', /construction/i, /engineering/i, /architect/i],
  energy: ['エネルギー', '電力', 'ガス', '公益', '石油', '発電', /energy/i, /utilit/i, /\bpower\b/i, /\boil\b/i, /\bgas\b/i],
  finance: ['金融', '銀行', '保険', '証券', 'リース', /bank/i, /insurance/i, /financ/i, /securities/i],
  public: ['自治体', '官公庁', '行政', '公共', '教育', '大学', '学校', /government/i, /public sector/i, /education/i, /university/i, /municipal/i],
};

export interface IndustryMatch {
  archetype: Archetype;
  /** The keywords that decided it (shown to the user so the classification can be checked). */
  matched: string[];
}

/**
 * Deterministic classification: the archetype with the most matching keywords wins; ties go to the earlier archetype in
 * ARCHETYPES (so "医療機器" — medical devices — is manufacturing, not healthcare). No match → generic.
 */
export function classifyIndustry(text: string | undefined | null): IndustryMatch {
  const source = (text ?? '').trim();
  if (!source) return { archetype: 'generic', matched: [] };
  let best: IndustryMatch = { archetype: 'generic', matched: [] };
  for (const archetype of ARCHETYPES) {
    if (archetype === 'generic') continue;
    const matched = KEYWORDS[archetype].flatMap((k) => {
      if (typeof k === 'string') return source.includes(k) ? [k] : [];
      const m = source.match(k);
      return m ? [m[0]] : [];
    });
    if (matched.length > best.matched.length) best = { archetype, matched };
  }
  return best;
}
