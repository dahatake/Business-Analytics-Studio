import type { MergeDismissal, Project, ProjectBrief, ProjectRelation } from '../../state/projects.ts';
import { similarity, SUGGEST_THRESHOLD } from './projectRelations.ts';

/** PARAM-151: evidence score (0..1) from which two projects are flagged as possibly the same business issue. */
export const MERGE_WARN_THRESHOLD = 0.5;
/** PARAM-153: a pair judged "different issues" is flagged again only when its score grew by at least this much. */
export const REWARN_MARGIN = 0.25;
/** PARAM-154: two pack items are the same when their normalised names overlap this much (character bigrams). */
export const ITEM_MATCH_MIN = 0.6;

/** PARAM-152: points per piece of evidence and the cap per kind; the score is their sum, at most 1. */
export const EVIDENCE_POINTS = {
  sameRelation: { each: 0.5, cap: 0.5 },
  theme: { each: 0.25, cap: 0.5 },
  issue: { each: 0.25, cap: 0.5 },
  kpi: { each: 0.2, cap: 0.4 },
  solution: { each: 0.15, cap: 0.3 },
  data: { each: 0.1, cap: 0.2 },
  text: { each: 1, cap: 0.4 },
} as const;
export type ReasonKind = keyof typeof EVIDENCE_POINTS;

/**
 * Business themes a project can be about. Different words for one theme ("解約率を下げる" / "顧客離反を防ぐ" /
 * "churn") meet here, which the wording overlap alone misses. Latin terms match at word starts.
 */
export const BUSINESS_THEMES: { id: string; ja: string; en: string; terms: string[] }[] = [
  { id: 'revenue', ja: '売上・受注', en: 'revenue and orders', terms: ['売上', '売り上げ', '受注', '収益', '業績', 'クォータ', 'revenue', 'bookings', 'quota', 'sales growth'] },
  { id: 'pipeline', ja: '商談・案件管理', en: 'pipeline and opportunities', terms: ['商談', '案件', 'パイプライン', '引き合い', '見込み客', 'リード', 'pipeline', 'opportunit', 'deal', 'lead'] },
  { id: 'forecast', ja: '予測・計画', en: 'forecasting and planning', terms: ['予測', '見通し', 'フォーキャスト', '予算', '計画', 'forecast', 'budget', 'planning'] },
  { id: 'retention', ja: '顧客維持・解約', en: 'retention and churn', terms: ['解約', '離反', 'チャーン', '継続率', '更新率', 'リテンション', '契約更新', 'churn', 'retention', 'renewal'] },
  { id: 'satisfaction', ja: '顧客満足・体験', en: 'customer satisfaction', terms: ['顧客満足', '満足度', 'nps', 'csat', '顧客体験', 'クレーム', '苦情', 'satisfaction', 'complaint', 'customer experience'] },
  { id: 'engagement', ja: '顧客接点・エンゲージメント', en: 'customer engagement', terms: ['顧客接点', 'エンゲージメント', '訪問', '面談', 'ブリーフィング', 'デモ', 'ワークショップ', 'イベント', 'engagement', 'briefing', 'workshop', 'demo', 'event'] },
  { id: 'partner', ja: 'パートナー連携', en: 'partners', terms: ['パートナー', '協業', '代理店', 'partner', 'reseller', 'alliance'] },
  { id: 'productivity', ja: '生産性・業務効率', en: 'productivity and efficiency', terms: ['生産性', '効率', '工数', '自動化', '省力', '手作業', 'productivity', 'efficien', 'automat', 'manual work'] },
  { id: 'cost', ja: 'コスト', en: 'cost', terms: ['コスト', '費用', '経費', '原価', 'cost', 'expense', 'spend'] },
  { id: 'data', ja: 'データ活用・可視化', en: 'data and reporting', terms: ['データ', 'ダッシュボード', '可視化', 'レポート', '分析', 'power bi', 'dashboard', 'report', 'analytic', 'visuali'] },
  { id: 'talent', ja: '人材・育成', en: 'people and skills', terms: ['人材', '育成', '採用', '離職', 'スキル', '研修', 'トレーニング', 'オンボーディング', 'hiring', 'talent', 'skill', 'training', 'onboarding'] },
  { id: 'supply', ja: '在庫・供給', en: 'inventory and supply', terms: ['在庫', '欠品', '供給', '調達', 'サプライ', 'inventory', 'stock', 'supply', 'procurement'] },
  { id: 'quality', ja: '品質', en: 'quality', terms: ['品質', '不良', '不具合', '歩留', 'quality', 'defect'] },
  { id: 'leadtime', ja: 'リードタイム・納期', en: 'lead time and delivery', terms: ['リードタイム', '納期', '遅延', '待ち時間', 'lead time', 'delivery', 'delay', 'turnaround'] },
  { id: 'ai', ja: 'AI・Copilot 活用', en: 'AI and Copilot', terms: ['生成ai', '人工知能', '機械学習', 'エージェント', 'copilot', 'ai', 'genai', 'generative', 'llm', 'agent'] },
  { id: 'security', ja: 'セキュリティ・ガバナンス', en: 'security and governance', terms: ['セキュリティ', 'ガバナンス', 'コンプライアンス', '情報漏えい', '権限', 'security', 'governance', 'compliance'] },
  { id: 'marketing', ja: 'マーケティング・認知', en: 'marketing and awareness', terms: ['マーケティング', '認知', 'ブランド', '集客', 'キャンペーン', 'marketing', 'brand', 'campaign', 'awareness'] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const themeMatchers = BUSINESS_THEMES.map((th) => ({
  id: th.id,
  test: (text: string) => th.terms.some((term) => (/^[\x20-\x7e]+$/.test(term)
    ? new RegExp(`(?<![a-z0-9])${escapeRe(term)}${term.length <= 3 ? '(?![a-z0-9])' : ''}`).test(text)
    : text.includes(term))),
}));

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

/** The themes found in the project's name, purpose and focus. */
export function themesOf(p: Project): string[] {
  const text = norm([p.name, p.brief?.purpose, p.brief?.focus].filter(Boolean).join(' '));
  return themeMatchers.filter((m) => m.test(text)).map((m) => m.id);
}

export interface NamedItem { ja: string; en: string; key: string }
/** What a project's customer pack says the project is about: its KPIs/OKRs, issues and causes, solutions and data. */
export interface PackEvidence { kpi: NamedItem[]; issue: NamedItem[]; solution: NamedItem[]; data: NamedItem[] }
export const EMPTY_EVIDENCE: PackEvidence = { kpi: [], issue: [], solution: [], data: [] };

const keyOf = (s: string) => norm(s).replace(/[^\p{L}\p{N}]+/gu, '');

function named(v: unknown): NamedItem | null {
  if (typeof v === 'string') return v.trim() ? { ja: v, en: v, key: keyOf(v) } : null;
  if (v && typeof v === 'object') {
    const o = v as { ja?: unknown; en?: unknown };
    const ja = typeof o.ja === 'string' ? o.ja : typeof o.en === 'string' ? o.en : '';
    const en = typeof o.en === 'string' ? o.en : ja;
    return ja.trim() ? { ja, en, key: keyOf(ja) } : null;
  }
  return null;
}

const uniq = (items: (NamedItem | null)[]) => {
  const seen = new Set<string>();
  return items.filter((i): i is NamedItem => !!i && !!i.key && !seen.has(i.key) && !!seen.add(i.key));
};

/** Reads a stored pack leniently (it was validated when saved); anything unexpected is skipped. */
export function packEvidence(pack: unknown): PackEvidence {
  if (!pack || typeof pack !== 'object') return EMPTY_EVIDENCE;
  const p = pack as { entities?: unknown; extensions?: Record<string, unknown> };
  const entities = Array.isArray(p.entities) ? (p.entities as { kind?: unknown; name?: unknown }[]) : [];
  const of = (...kinds: string[]) => entities.filter((e) => kinds.includes(String(e?.kind))).map((e) => named(e.name));
  const okr = p.extensions?.okr as { objectives?: { objective?: unknown; keyResults?: { text?: unknown }[] }[] } | undefined;
  const okrItems = Array.isArray(okr?.objectives)
    ? okr.objectives.flatMap((o) => [named(o?.objective), ...(Array.isArray(o?.keyResults) ? o.keyResults.map((k) => named(k?.text)) : [])])
    : [];
  const catalog = p.extensions?.dataCatalog as { items?: { name?: unknown }[] } | undefined;
  const data = Array.isArray(catalog?.items) ? catalog.items.map((i) => named(i?.name)) : [];
  return { kpi: uniq([...of('kpi'), ...okrItems]), issue: uniq(of('issue', 'cause')), solution: uniq(of('solution', 'initiative')), data: uniq(data) };
}

function bigramSet(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Same item when the normalised names are equal, or one contains the other, or their bigrams overlap enough. */
export function sameItem(a: NamedItem, b: NamedItem): boolean {
  if (a.key === b.key) return true;
  if (a.key.length >= 3 && b.key.length >= 3 && (a.key.includes(b.key) || b.key.includes(a.key))) return true;
  const x = bigramSet(a.key);
  const y = bigramSet(b.key);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return common / (x.size + y.size - common) >= ITEM_MATCH_MIN;
}

const sharedItems = (a: NamedItem[], b: NamedItem[]) => a.filter((x) => b.some((y) => sameItem(x, y)));

export interface MergeReason {
  kind: ReasonKind;
  points: number;
  /** Shared themes (ids), pack items, or nothing for the relation; `similarity` for the wording. */
  items: NamedItem[];
  similarity?: number;
}

export interface MergeAssessment { a: string; b: string; score: number; reasons: MergeReason[] }

export interface AssessContext {
  relations: ProjectRelation[];
  evidence: ReadonlyMap<string, PackEvidence>;
  /** Themes or items every project (of three or more) shares say nothing about a pair; they are left out. */
  commonThemes?: ReadonlySet<string>;
  commonItems?: Partial<Record<'kpi' | 'issue' | 'solution' | 'data', NamedItem[]>>;
}

const themeItem = (id: string): NamedItem => {
  const th = BUSINESS_THEMES.find((x) => x.id === id)!;
  return { ja: th.ja, en: th.en, key: id };
};

const points = (kind: ReasonKind, n: number) => Math.min(EVIDENCE_POINTS[kind].cap, EVIDENCE_POINTS[kind].each * n);

/**
 * How strongly the evidence says two projects are one business issue told twice: a "same issue" relation people
 * registered, shared business themes, the same KPIs, issues, solutions or data in their customer packs, and
 * overlapping wording. Deterministic and local: nothing is sent anywhere.
 */
export function assessPair(a: Project, b: Project, ctx: AssessContext): MergeAssessment {
  const reasons: MergeReason[] = [];
  if (ctx.relations.some((r) => r.kind === 'same' && ((r.from === a.id && r.to === b.id) || (r.from === b.id && r.to === a.id)))) {
    reasons.push({ kind: 'sameRelation', points: points('sameRelation', 1), items: [] });
  }
  const tb = new Set(themesOf(b));
  const themes = themesOf(a).filter((id) => tb.has(id) && !ctx.commonThemes?.has(id));
  if (themes.length) reasons.push({ kind: 'theme', points: points('theme', themes.length), items: themes.map(themeItem) });
  const ea = ctx.evidence.get(a.id);
  const eb = ctx.evidence.get(b.id);
  if (ea && eb) {
    for (const kind of ['issue', 'kpi', 'solution', 'data'] as const) {
      const common = ctx.commonItems?.[kind] ?? [];
      const shared = sharedItems(ea[kind], eb[kind]).filter((x) => !common.some((c) => sameItem(x, c)));
      if (shared.length) reasons.push({ kind, points: points(kind, shared.length), items: shared });
    }
  }
  const sim = similarity(a, b);
  if (sim >= SUGGEST_THRESHOLD) reasons.push({ kind: 'text', points: points('text', sim), items: [], similarity: sim });
  const score = Math.min(1, reasons.reduce((s, r) => s + r.points, 0));
  return { a: a.id, b: b.id, score, reasons: reasons.sort((x, y) => y.points - x.points) };
}

/** Themes and pack items present in every project of the company, once there are three or more to compare. */
export function commonContext(projects: Project[], evidence: ReadonlyMap<string, PackEvidence>): Pick<AssessContext, 'commonThemes' | 'commonItems'> {
  const commonThemes = new Set<string>();
  if (projects.length >= 3) {
    const lists = projects.map(themesOf);
    for (const id of lists[0] ?? []) if (lists.every((l) => l.includes(id))) commonThemes.add(id);
  }
  const packs = projects.map((p) => evidence.get(p.id)).filter((e): e is PackEvidence => !!e);
  const commonItems: AssessContext['commonItems'] = {};
  if (packs.length >= 3) {
    for (const kind of ['kpi', 'issue', 'solution', 'data'] as const) {
      commonItems[kind] = packs[0]![kind].filter((x) => packs.every((e) => e[kind].some((y) => sameItem(x, y))));
    }
  }
  return { commonThemes, commonItems };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface MergeWarnings {
  warnings: MergeAssessment[];
  /** Pairs people judged different and whose evidence has not grown enough since (PARAM-153). */
  dismissed: { dismissal: MergeDismissal; assessment: MergeAssessment }[];
}

/**
 * Pairs to flag, strongest first, leaving out those people already judged different (until new evidence appears) and
 * those they linked as dependent or correlated, which says they are two projects on purpose.
 */
export function mergeWarnings(projects: Project[], relations: ProjectRelation[], evidence: ReadonlyMap<string, PackEvidence>, dismissals: MergeDismissal[]): MergeWarnings {
  const ctx: AssessContext = { relations, evidence, ...commonContext(projects, evidence) };
  const byPair = new Map(dismissals.map((d) => [pairKey(d.a, d.b), d]));
  const kept = new Set(relations.filter((r) => r.kind !== 'same').map((r) => pairKey(r.from, r.to)));
  const warnings: MergeAssessment[] = [];
  const dismissed: MergeWarnings['dismissed'] = [];
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      if (kept.has(pairKey(projects[i]!.id, projects[j]!.id))) continue;
      const assessment = assessPair(projects[i]!, projects[j]!, ctx);
      const d = byPair.get(pairKey(assessment.a, assessment.b));
      if (d && assessment.score < d.score + REWARN_MARGIN) dismissed.push({ dismissal: d, assessment });
      else if (assessment.score >= MERGE_WARN_THRESHOLD) warnings.push(assessment);
    }
  }
  return { warnings: warnings.sort((x, y) => y.score - x.score), dismissed };
}

const joinText = (keep: string | undefined, absorb: string | undefined, heading: string) => {
  const k = keep?.trim();
  const a = absorb?.trim();
  if (!a || a === k) return k;
  if (!k) return a;
  if (k.includes(a)) return k;
  return `${k}\n\n${heading}\n${a}`;
};

/**
 * The inputs of the merged project, proposed for the user to confirm: the kept project's texts first, the absorbed
 * one's added under a heading naming it (nothing is dropped), sources switched on if either used them, and the
 * attached file names combined.
 */
export function mergeBriefs(keep: Project, absorb: Project, heading: string): ProjectBrief {
  const k = keep.brief ?? {};
  const a = absorb.brief ?? {};
  const focus = [...new Set([k.focus, a.focus].map((f) => f?.trim()).filter((f): f is string => !!f))].join(' / ');
  const out: ProjectBrief = {
    purpose: joinText(k.purpose, a.purpose, heading),
    focus,
    asOf: k.asOf ?? a.asOf,
    researchNote: joinText(k.researchNote, a.researchNote, heading),
    useNews: k.useNews === undefined && a.useNews === undefined ? undefined : k.useNews !== false || a.useNews !== false,
    useWorkIq: k.useWorkIq === undefined && a.useWorkIq === undefined ? undefined : !!(k.useWorkIq || a.useWorkIq),
    workIqRounds: k.workIqRounds === undefined && a.workIqRounds === undefined ? undefined : Math.max(k.workIqRounds ?? 0, a.workIqRounds ?? 0),
    materialNames: [...new Set([...(k.materialNames ?? []), ...(a.materialNames ?? [])])],
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as ProjectBrief;
}
