import type { Lang } from '../../i18n/index.ts';

/**
 * What a business analysis needs before the discussion screens are useful, checked by the app on the pack itself
 * (never the model's own "complete" claim). Each requirement names the screen it feeds, the generation stage that
 * builds it, how much is enough, and a ladder of differently worded Work IQ searches: when one wording finds nothing,
 * the next round asks with the vocabulary the organisation may actually use (scorecard, QBR, Power BI, playbook …).
 */
export type ReadinessKey = 'org' | 'locations' | 'customers' | 'workflow' | 'dataCatalog' | 'kpi' | 'engagements' | 'issues';
export type GenStageKey = 'a' | 'b';

export interface Requirement {
  key: ReadinessKey;
  stage: GenStageKey;
  /** Minimum count the check needs. */
  need: number;
  /** Search wordings for Work IQ, tried in order (one per round). */
  ladder: Record<Lang, string[]>;
}

type Pack = Record<string, unknown>;

export const REQUIREMENTS: readonly Requirement[] = [
  {
    key: 'org', stage: 'a', need: 2,
    ladder: {
      ja: ['主要な関係者の氏名と役職、組織図', 'チームのメンバー一覧と役割分担（責任者・マネージャー・担当者）', 'リーダーシップチームと各メンバーの担当範囲（RACI）'],
      en: ['key people with name and title, org chart', 'team member list and roles (lead, managers, owners)', 'leadership team and each member\'s area of responsibility (RACI)'],
    },
  },
  {
    key: 'locations', stage: 'a', need: 1,
    ladder: {
      ja: ['拠点・オフィスの所在地（都市と国）', 'チームが所属するオフィスと地域（リージョン）別の担当範囲', '関連する海外拠点・グローバルのハブ・センターの都市'],
      en: ['locations and offices (city and country)', 'offices the team works from and regional coverage', 'related global hubs and centres (cities)'],
    },
  },
  {
    key: 'customers', stage: 'a', need: 1,
    ladder: {
      ja: ['主要な顧客・顧客セグメントと業種', '最近対応した顧客の名前と業種', '顧客リスト・アカウント一覧・ターゲット顧客'],
      en: ['main customers and customer segments with industry', 'customers served recently with their industry', 'customer list, account list and target accounts'],
    },
  },
  {
    key: 'workflow', stage: 'a', need: 3,
    ladder: {
      ja: [
        '依頼の受付から成果物の引き渡しまでの業務手順と、次に引き継ぐチーム',
        '案件・エンゲージメントのライフサイクル（受付・準備・実施・フォローアップ）と各段階の担当',
        '他チームとの連携・エスカレーション・ハンドオフの手順書やプレイブック',
      ],
      en: [
        'work steps from request intake to delivery, and the team that takes over next',
        'engagement lifecycle (intake, preparation, delivery, follow-up) with the owner of each step',
        'hand-off, escalation and collaboration procedures or playbooks with other teams',
      ],
    },
  },
  {
    key: 'dataCatalog', stage: 'a', need: 3,
    ladder: {
      ja: [
        'チームが管理・利用するデータ、レポート、ダッシュボード、システム',
        'Power BI レポート、Excel のトラッカー、SharePoint リスト、CRM（Dynamics 365・Salesforce）の利用',
        '週次・月次の報告やパイプラインレビューで使う資料とデータの出どころ',
      ],
      en: [
        'data, reports, dashboards and systems the team owns or uses',
        'Power BI reports, Excel trackers, SharePoint lists and CRM (Dynamics 365, Salesforce) in use',
        'material used in weekly or monthly reporting and pipeline reviews, and where its data comes from',
      ],
    },
  },
  {
    key: 'kpi', stage: 'b', need: 2,
    ladder: {
      ja: ['KPI・OKR の定義と目標値・実績値', 'スコアカード、QBR、ビジネスレビュー資料にある指標と達成率', '年度の目標（ターゲット）、コミットメント、評価指標'],
      en: ['KPI and OKR definitions with targets and actuals', 'metrics and attainment in scorecards, QBRs and business reviews', 'fiscal-year targets, commitments and success measures'],
    },
  },
  {
    key: 'engagements', stage: 'b', need: 1,
    ladder: {
      ja: ['案件・提案・エンゲージメントの一覧と進捗', '実施したワークショップ・ブリーフィング・PoC の事例と件数', 'パイプライン、受注、成果物の納品状況'],
      en: ['list and status of deals, proposals and engagements', 'workshops, briefings and PoCs delivered with examples and counts', 'pipeline, wins and delivery status of deliverables'],
    },
  },
  {
    key: 'issues', stage: 'b', need: 1,
    ladder: {
      ja: ['課題・その原因・改善施策', '振り返り（レトロスペクティブ）やリスク管理表で挙がった問題点', '顧客や社内からのフィードバック・改善要望・エスカレーション'],
      en: ['issues, their causes and improvement initiatives', 'problems raised in retrospectives and risk registers', 'customer and internal feedback, improvement requests and escalations'],
    },
  },
];

export interface ReadinessItem {
  key: ReadinessKey;
  stage: GenStageKey;
  have: number;
  need: number;
  met: boolean;
}

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const ext = (p: Pack, k: string): Record<string, unknown> => {
  const e = p.extensions && typeof p.extensions === 'object' ? (p.extensions as Record<string, unknown>)[k] : undefined;
  return e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>) : {};
};

/** Counts on a raw stage answer or a saved pack (loose: works before validation). */
export function readinessCount(p: Pack, key: ReadinessKey): number {
  const ents = list(p.entities);
  const of = (...kinds: string[]) => ents.filter((e) => kinds.includes(String(e.kind))).length;
  switch (key) {
    case 'org': return of('person');
    case 'locations': return of('site');
    case 'customers': return of('customer');
    case 'workflow': {
      const stages = list(ext(p, 'workflow').stages);
      // A chain without any hand-off does not show who works next; count it as one step short.
      const linked = stages.some((s) => (Array.isArray(s.handoffTo) && s.handoffTo.length > 0) || (Array.isArray(s.next) && s.next.length > 0));
      return linked ? stages.length : Math.min(stages.length, 2);
    }
    case 'dataCatalog': return list(ext(p, 'dataCatalog').items).length;
    case 'kpi': {
      const okr = ext(p, 'okr');
      return of('kpi') + list(okr.kpis).length + list(okr.objectives).length;
    }
    case 'engagements': return of('deal', 'deliverable', 'initiative') + list(ext(p, 'engagements').items).length;
    case 'issues': return of('issue');
  }
}

export function readiness(p: Pack, stage?: GenStageKey): ReadinessItem[] {
  return REQUIREMENTS.filter((r) => !stage || r.stage === stage).map((r) => {
    const have = readinessCount(p, r.key);
    return { key: r.key, stage: r.stage, have, need: r.need, met: have >= r.need };
  });
}

/** Met requirements first, then how much there is: a re-run is kept only when it does not score lower. */
export function readinessScore(p: Pack, stage: GenStageKey): number {
  return readiness(p, stage).reduce((n, r) => n + (r.met ? 1000 : 0) + Math.min(r.have, r.need * 3), 0);
}

export function requirementOf(key: ReadinessKey): Requirement {
  return REQUIREMENTS.find((r) => r.key === key)!;
}
