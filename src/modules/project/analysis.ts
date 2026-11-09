import type { CustomerPack, EntityOf } from '../../data/schema.ts';
import { kpiProgress } from '../../domain/kpi.ts';
import type { Analysis, AnalysisData, AnalysisItem, MethodId } from './model.ts';

/** Category ids of every method. Names only (general frameworks; no copyrighted text). */
export const METHOD_CATEGORIES = {
  swot: ['strengths', 'weaknesses', 'opportunities', 'threats'],
  fiveForces: ['rivalry', 'newEntrants', 'substitutes', 'buyerPower', 'supplierPower'],
  valueChain: ['inbound', 'operations', 'outbound', 'marketing', 'service', 'infrastructure', 'hr', 'technology', 'procurement'],
  threeC: ['customer', 'competitor', 'company'],
  bsc: ['financial', 'customerView', 'process', 'learning'],
} as const satisfies Record<MethodId, readonly string[]>;

export type CategoryId = (typeof METHOD_CATEGORIES)[MethodId][number];

/** Item scores use a 1–5 scale; weights 0–5 (0 = ignore). */
export const SCORE_MIN = 1;
export const SCORE_MAX = 5;
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 5;

export interface CategoryResult {
  id: CategoryId;
  /** Weighted mean of the item scores; null when the category has no weighted item. */
  score: number | null;
  weight: number;
  count: number;
}

export type Insight =
  | { kind: 'swot'; internal: number; external: number; strategy: 'aggressive' | 'diversify' | 'turnaround' | 'defensive' }
  | { kind: 'fiveForces'; intensity: number | null; attractiveness: number | null; strongest: CategoryId | null }
  | { kind: 'valueChain'; strongest: CategoryId | null; weakest: CategoryId | null }
  | { kind: 'threeC'; advantage: number | null; customer: number | null }
  | { kind: 'bsc'; weakest: CategoryId | null; spread: number | null };

export interface AnalysisResult {
  method: MethodId;
  categories: CategoryResult[];
  /** Weighted mean of category scores (null for SWOT, whose result is the position). */
  overall: number | null;
  insight: Insight;
}

export function categoriesOf(method: MethodId): readonly CategoryId[] {
  return METHOD_CATEGORIES[method];
}

export function categoryWeight(a: Pick<Analysis, 'weights'>, id: string): number {
  const w = a.weights[id];
  return typeof w === 'number' && Number.isFinite(w) ? w : 1;
}

/** Weighted mean of the item scores. Items with weight 0 are ignored. */
export function categoryScore(items: AnalysisItem[], category: string): number | null {
  let sum = 0;
  let wsum = 0;
  for (const i of items) {
    if (i.category !== category || !(i.weight > 0)) continue;
    sum += i.score * i.weight;
    wsum += i.weight;
  }
  return wsum > 0 ? sum / wsum : null;
}

function weightedMean(cats: CategoryResult[]): number | null {
  let sum = 0;
  let wsum = 0;
  for (const c of cats) {
    if (c.score === null || !(c.weight > 0)) continue;
    sum += c.score * c.weight;
    wsum += c.weight;
  }
  return wsum > 0 ? sum / wsum : null;
}

function extreme(cats: CategoryResult[], dir: 1 | -1): CategoryId | null {
  let best: CategoryResult | null = null;
  for (const c of cats) {
    if (c.score === null || !(c.weight > 0)) continue;
    if (!best || (c.score - (best.score ?? 0)) * dir > 0) best = c;
  }
  return best?.id ?? null;
}

const scoreOf = (cats: CategoryResult[], id: CategoryId) => cats.find((c) => c.id === id)?.score ?? null;

/** FR-134: pure and synchronous, so a parameter change shows its result immediately (PARAM-032: ≤ 2 s). */
export function computeAnalysis(a: Pick<Analysis, 'method' | 'items' | 'weights'>): AnalysisResult {
  const categories: CategoryResult[] = categoriesOf(a.method).map((id) => ({
    id,
    score: categoryScore(a.items, id),
    weight: categoryWeight(a, id),
    count: a.items.filter((i) => i.category === id).length,
  }));
  const overall = weightedMean(categories);
  const weighted = (id: CategoryId) => {
    const c = categories.find((x) => x.id === id);
    return c && c.score !== null ? c.score * c.weight : 0;
  };
  switch (a.method) {
    case 'swot': {
      const internal = weighted('strengths') - weighted('weaknesses');
      const external = weighted('opportunities') - weighted('threats');
      const strategy = internal >= 0 ? (external >= 0 ? 'aggressive' : 'diversify') : external >= 0 ? 'turnaround' : 'defensive';
      return { method: a.method, categories, overall: null, insight: { kind: 'swot', internal, external, strategy } };
    }
    case 'fiveForces':
      return {
        method: a.method,
        categories,
        overall,
        insight: { kind: 'fiveForces', intensity: overall, attractiveness: overall === null ? null : SCORE_MAX + SCORE_MIN - overall, strongest: extreme(categories, 1) },
      };
    case 'valueChain':
      return { method: a.method, categories, overall, insight: { kind: 'valueChain', strongest: extreme(categories, 1), weakest: extreme(categories, -1) } };
    case 'threeC': {
      const company = scoreOf(categories, 'company');
      const competitor = scoreOf(categories, 'competitor');
      return {
        method: a.method,
        categories,
        overall,
        insight: { kind: 'threeC', advantage: company !== null && competitor !== null ? company - competitor : null, customer: scoreOf(categories, 'customer') },
      };
    }
    case 'bsc': {
      const scored = categories.filter((c) => c.score !== null && c.weight > 0).map((c) => c.score as number);
      return {
        method: a.method,
        categories,
        overall,
        insight: { kind: 'bsc', weakest: extreme(categories, -1), spread: scored.length ? Math.max(...scored) - Math.min(...scored) : null },
      };
    }
  }
}

export interface ItemIssue {
  itemId: string;
  field: 'text' | 'score' | 'weight';
}

/** FR-046 style validation of analysis parameters. */
export function validateItems(items: AnalysisItem[]): ItemIssue[] {
  const out: ItemIssue[] = [];
  for (const i of items) {
    const text = typeof i.text === 'string' ? i.text : i.text.ja;
    if (!text.trim()) out.push({ itemId: i.id, field: 'text' });
    if (!Number.isFinite(i.score) || i.score < SCORE_MIN || i.score > SCORE_MAX) out.push({ itemId: i.id, field: 'score' });
    if (!Number.isFinite(i.weight) || i.weight < WEIGHT_MIN || i.weight > WEIGHT_MAX) out.push({ itemId: i.id, field: 'weight' });
  }
  return out;
}

export const clampScore = (v: number) => Math.min(SCORE_MAX, Math.max(SCORE_MIN, v));

export function newAnalysis(method: MethodId, title: Analysis['title'], id: string, at: string): Analysis {
  return { id, method, title, items: [], weights: Object.fromEntries(categoriesOf(method).map((c) => [c, 1])), createdAt: at, updatedAt: at };
}

/* ---------- Demo analyses, derived from the customer pack ---------- */

const DEMO_AT = '2026-11-09T09:00:00+09:00';

function kindOf<K extends 'kpi' | 'site' | 'issue' | 'solution'>(pack: CustomerPack, kind: K) {
  return pack.entities.filter((e) => e.kind === kind) as EntityOf<K>[];
}

const BSC_BY_KPI: Record<string, CategoryId> = {
  'kpi-dso': 'financial',
  'kpi-otd': 'customerView',
  'kpi-lead-time': 'process',
  'kpi-defect': 'process',
  'kpi-engagement': 'learning',
};

/** The demo scope starts with a SWOT and a balanced scorecard built from the pack; new projects start empty. */
export function demoAnalyses(pack: CustomerPack): AnalysisData {
  const items: AnalysisItem[] = [];
  let n = 0;
  const add = (category: CategoryId, text: AnalysisItem['text'], score: number) => items.push({ id: `ai-demo-${++n}`, category, text, score: clampScore(Math.round(score * 10) / 10), weight: 1, author: 'sample' });
  kindOf(pack, 'site').filter((s) => s.role === 'plant').forEach((s) => add('strengths', s.name, 4));
  kindOf(pack, 'issue').forEach((i) => add('weaknesses', i.name, i.impact));
  kindOf(pack, 'solution').forEach((s) => add('opportunities', s.name, s.annualBenefitJpy >= s.costJpy ? 4 : 3));
  add('threats', { ja: '原材料価格の上昇', en: 'Rising raw-material prices' }, 4);
  add('threats', { ja: '海外競合の低価格攻勢', en: 'Low-price push by overseas competitors' }, 3);
  const swot: Analysis = {
    id: 'an-demo-swot', method: 'swot', title: { ja: 'SWOT 分析（お手本パックから作成）', en: 'SWOT analysis (from the sample pack)' },
    items, weights: { strengths: 1, weaknesses: 1, opportunities: 1, threats: 1 }, createdAt: DEMO_AT, updatedAt: DEMO_AT,
  };
  const bscItems: AnalysisItem[] = kindOf(pack, 'kpi').map((k, i) => {
    const p = kpiProgress(k);
    const score = Number.isNaN(p) ? 3 : clampScore(Math.round((1 + 4 * Math.max(0, Math.min(1, p))) * 10) / 10);
    return { id: `ai-demo-bsc-${i + 1}`, category: BSC_BY_KPI[k.id] ?? 'process', text: k.name, score, weight: 1, author: 'sample' as const };
  });
  const bsc: Analysis = {
    id: 'an-demo-bsc', method: 'bsc', title: { ja: 'バランスト・スコアカード（KPI の達成度から作成）', en: 'Balanced scorecard (from KPI progress)' },
    items: bscItems, weights: { financial: 1, customerView: 1, process: 1, learning: 1 }, createdAt: DEMO_AT, updatedAt: DEMO_AT,
  };
  return { analyses: [swot, bsc], activeId: swot.id };
}
