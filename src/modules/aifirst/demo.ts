import type { AiPlatformExtension } from '../../data/extensionSchemas.ts';

const at = '2026-11-20';
const by = 'IT/AI-CoE';

/**
 * FR-386: the sample company's AI platform. Uneven on purpose, as real platforms are (AI Maturity Assessment: "readiness
 * is rarely even across pillars"): Copilot is standard while code scanning is missing although people already build with
 * GitHub Copilot (an order contradiction), and each business area stands at its own height with its own loop.
 */
export const demoAiPlatform: AiPlatformExtension = {
  capabilities: [
    { id: 'outcomes', level: 2, basis: 'evidence', note: { ja: '主要 KPI の基準値をパックで管理', en: 'Main KPI baselines are kept in the pack' }, at, by },
    { id: 'coe', level: 1, basis: 'selfReport', note: { ja: '情報システム部に AI 推進の兼務チーム', en: 'A part-time AI team in IT' }, at, by },
    { id: 'identity', level: 3, basis: 'evidence', note: { ja: '全社員に多要素認証と条件付きアクセス', en: 'MFA and Conditional Access for all staff' }, at, by },
    { id: 'oversharing', level: 1, basis: 'evidence', note: { ja: 'パイロット部門のサイトで過剰共有を是正', en: 'Oversharing fixed on the pilot sites' }, at, by },
    { id: 'evals', level: 1, basis: 'selfReport', note: { ja: '技能伝承で熟練者の採点基準を試行', en: 'Expert rubric piloted for skills transfer' }, at, by },
    { id: 'copilot', level: 2, basis: 'evidence', note: { ja: '製造部門 300 人に展開、利用状況レポートあり', en: 'Rolled out to 300 people in manufacturing, usage report' }, at, by },
    { id: 'devGuardrails', level: 0, basis: 'evidence', note: { ja: '生成コードのスキャンは未導入', en: 'No scanning of generated code yet' }, at, by },
    { id: 'registry', level: 0, basis: 'selfReport', note: { ja: '作ったエージェントの一覧はない', en: 'No list of the agents people built' }, at, by },
    { id: 'vibeCoding', level: 1, basis: 'selfReport', note: { ja: '現場の有志が GitHub Copilot で試作', en: 'Volunteers prototype with GitHub Copilot' }, at, by },
    { id: 'dataProducts', level: 1, basis: 'evidence', note: { ja: '受注・在庫を Fabric に統合（需要予測の範囲）', en: 'Orders and stock unified in Fabric (demand planning scope)' }, at, by },
    { id: 'grounding', level: 1, basis: 'selfReport', note: { ja: '技能伝承の検索を試行', en: 'Search for skills transfer piloted' }, at, by },
    { id: 'modelRouting', level: 0, basis: 'selfReport', at, by },
    { id: 'delegation', level: 0, basis: 'selfReport', at, by },
  ],
  areas: [
    {
      id: 'area-skills', name: { ja: '技能伝承（熟練者のノウハウを現場で使う）', en: 'Skills transfer (experts\' know-how on the floor)' },
      solutionIds: ['sol-knowledge-copilot'], approach: 'adoption',
      checks: [
        { id: 'rubric', met: true, basis: 'evidence', note: { ja: '熟練者 5 人が作った採点基準（20 問）', en: 'Rubric of 20 questions by 5 experts' }, at, by },
        { id: 'sponsor', met: true, basis: 'evidence', note: { ja: '製造本部長', en: 'Head of manufacturing' }, at, by },
        { id: 'adoption', met: true, basis: 'evidence', note: { ja: '利用者 120 人／週', en: '120 users a week' }, at, by },
        { id: 'kpiLink', met: true, basis: 'selfReport', note: { ja: '定着率アンケートと突き合わせ中', en: 'Being matched with the retention survey' }, at, by },
        { id: 'built', met: true, basis: 'evidence', note: { ja: 'Copilot Studio のエージェントを公開', en: 'Copilot Studio agent published' }, at, by },
      ],
      evaluations: [
        { date: '2026-06-30', score: 62, metric: { ja: '熟練者の採点基準での正答率（%）', en: 'Correct answers on the expert rubric (%)' } },
        { date: '2026-08-31', score: 71, metric: { ja: '熟練者の採点基準での正答率（%）', en: 'Correct answers on the expert rubric (%)' } },
        { date: '2026-10-31', score: 78, metric: { ja: '熟練者の採点基準での正答率（%）', en: 'Correct answers on the expert rubric (%)' } },
      ],
    },
    {
      id: 'area-demand', name: { ja: '需要予測と生産計画', en: 'Demand forecasting and production planning' },
      solutionIds: ['sol-demand-planning'], approach: 'first',
      checks: [
        { id: 'sponsor', met: true, basis: 'evidence', note: { ja: '生産管理部長', en: 'Head of production control' }, at, by },
        { id: 'dataProduct', met: true, basis: 'evidence', note: { ja: '受注・在庫のデータ製品（Fabric）', en: 'Orders and stock data product (Fabric)' }, at, by },
      ],
      evaluations: [],
    },
    {
      id: 'area-inspection', name: { ja: 'AI 外観検査', en: 'AI visual inspection' },
      solutionIds: ['sol-vision-inspection'], approach: 'first',
      checks: [
        { id: 'rubric', met: true, basis: 'evidence', note: { ja: '検査員の判定基準（限度見本 40 種）', en: 'Inspectors\' criteria (40 limit samples)' }, at, by },
        { id: 'sponsor', met: true, basis: 'evidence', note: { ja: '品質保証部長', en: 'Head of quality assurance' }, at, by },
        { id: 'adoption', met: true, basis: 'selfReport', note: { ja: 'パイロットラインの検査員 8 人', en: '8 inspectors on the pilot line' }, at, by },
        { id: 'built', met: true, basis: 'evidence', note: { ja: 'パイロットラインで稼働', en: 'Running on the pilot line' }, at, by },
      ],
      evaluations: [
        { date: '2026-09-15', score: 88, metric: { ja: '熟練検査員との判定一致率（%）', en: 'Agreement with expert inspectors (%)' } },
        { date: '2026-11-10', score: 86, metric: { ja: '熟練検査員との判定一致率（%）', en: 'Agreement with expert inspectors (%)' } },
      ],
    },
    {
      id: 'area-invoice', name: { ja: '請求と入金消込', en: 'Invoicing and payment matching' },
      solutionIds: ['sol-e-invoice'], approach: 'adoption', checks: [], evaluations: [],
    },
    {
      id: 'area-energy', name: { ja: 'エネルギーの見える化', en: 'Energy visibility' },
      solutionIds: ['sol-energy-twin'], checks: [], evaluations: [],
    },
  ],
};
