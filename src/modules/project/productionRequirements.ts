/**
 * FR-378: the production requirements definition of one solution, `{solution}-Production-Requirements-Definision.md`.
 * Structure after ISO/IEC/IEEE 29148:2018 (purpose, scope, stakeholders, business requirements, solution requirements,
 * non-functional requirements, acceptance, traceability) with one section per software action. Each kind of action
 * has the points its specialists check before production:
 * - prompt for Microsoft 365 Copilot: goal, context, expectations and source of the prompt, where the inputs come from,
 *   how it runs (by hand, Cowork, Autopilot), review and evaluation;
 * - agent: goal and done criteria, autonomy, tools and permissions, loop limits, human approval points, fallback,
 *   evaluation, tracing (Microsoft Design, "UX design for agents", 2025; HAX guidelines, Amershi et al. 2019);
 * - application: users and roles, use cases and screens, API, data model, permissions, non-functional targets;
 * - data integration (ETL/ELT): sources, targets, method, freshness, data contract, quality rules, idempotency, lineage;
 * - visualisation: decisions supported, measure definitions, grain, model, refresh, row-level security, layout;
 * - machine learning: problem framing, label and prediction time, baseline, metric and pass mark, leakage, drift.
 * Values come only from the project data; anything the data does not state is marked "to fill" and listed at the end.
 */
import type { Entity, EntityOf } from '../../data/schema.ts';
import { makeFormatters, translate, type Lang } from '../../i18n/core.ts';
import { personaLabel } from '../../state/personas.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { isDevType, type ActionDef, type ActionType, type ScheduledAction, addWeeks } from './actionPlan.ts';
import type { CheckContext } from './deliverables.ts';
import { catalogOf, systemsOf } from './docInputs.ts';
import type { RankedRow, ScoreKey } from './whatIf.ts';
import { SCORE_KEYS } from './whatIf.ts';

type Bi = { ja: string; en: string };
const b = (ja: string, en: string): Bi => ({ ja, en });

export const ACTION_LABEL: Record<ActionType, Bi> = {
  copilotPrompt: b('Microsoft 365 Copilot・Cowork・Autopilot 用のプロンプト', 'Prompt for Microsoft 365 Copilot, Cowork or Autopilot'),
  agent: b('エージェントのループを持つ AI エージェントの開発', 'AI agent with an agentic loop'),
  app: b('UI・API・データベースを備えたアプリケーションの開発', 'Application with UI, API and database'),
  dataPipeline: b('データ連携（ETL/ELT・連携フロー）の開発', 'Data integration (ETL/ELT, integration flows)'),
  analytics: b('データの可視化（レポート・ダッシュボード）', 'Data visualisation (reports, dashboards)'),
  mlModel: b('機械学習モデルの開発', 'Machine-learning model'),
  process: b('業務プロセスの変更', 'Business process change'),
  change: b('組織・人材の変更と定着化', 'People, organisation and adoption'),
  investment: b('設備・資産への投資', 'Investment in equipment or assets'),
  sourcing: b('外部の調達・提携', 'External sourcing or partnership'),
};

const PREFIX: Record<ActionType, string> = {
  copilotPrompt: 'PR', agent: 'AG', app: 'AP', dataPipeline: 'DP', analytics: 'BI', mlModel: 'ML', process: 'PC', change: 'CH', investment: 'IV', sourcing: 'SO',
};

export interface ProductionDocInput {
  solution: EntityOf<'solution'>;
  actions: ActionDef[];
  schedule: ScheduledAction[];
  ctx: Pick<CheckContext, 'pack' | 'kpi' | 'useCases' | 'today' | 'strategy'>;
  lang: Lang;
  company: string;
  project: string;
  planStart: string;
  /** The what-if row of the solution in the scenario that chose it, when the solution was ranked. */
  priority?: { row: RankedRow; scenario: string; of: number };
  visible: (id: string) => boolean;
}

export interface ProductionDoc {
  fileTitle: string;
  markdown: string;
  /** Items the data could not fill. */
  toFill: string[];
  requirementIds: string[];
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function buildProductionDoc(input: ProductionDocInput): ProductionDoc {
  const { solution: s, ctx, lang } = input;
  const L = (x: Bi) => x[lang];
  const fmt = makeFormatters(lang);
  const TO_FILL = L(b('【要記入】', '[TO FILL]'));
  const name = (e: { name: Localizable }) => loc(e.name, lang);
  const ent = <K extends Entity['kind']>(id: string, kind: K) => {
    const e = ctx.pack.byId.get(id);
    return e?.kind === kind && input.visible(id) ? (e as EntityOf<K>) : undefined;
  };
  const toFill: string[] = [];
  const reqIds: string[] = [];
  const fill = (where: string, v: string | null | undefined) => {
    if (v && v.trim()) {
      if (v.includes(TO_FILL)) toFill.push(where);
      return v;
    }
    toFill.push(where);
    return TO_FILL;
  };

  const issues = s.issueIds.map((id) => ent(id, 'issue')).filter((x): x is EntityOf<'issue'> => !!x);
  const causes = [...new Set(issues.flatMap((i) => i.causeIds))].map((id) => ent(id, 'cause')).filter((x): x is EntityOf<'cause'> => !!x);
  const sources = [...new Set(issues.flatMap((i) => i.sourceIds))].map((id) => ent(id, 'source')).filter((x): x is EntityOf<'source'> => !!x);
  const projectKpis = ctx.kpi.kpis.filter((k) => s.kpiIds.includes(k.id));
  const packKpis = s.kpiIds.map((id) => ent(id, 'kpi')).filter((x): x is EntityOf<'kpi'> => !!x && !projectKpis.some((k) => k.id === x.id));
  const kpis = [
    ...projectKpis.map((k) => ({ id: k.id, name: loc(k.name, lang), unit: loc(k.unit, lang), baseline: k.baseline, current: k.current, target: k.target, deadline: k.deadline as string | undefined })),
    ...packKpis.map((k) => ({ id: k.id, name: name(k), unit: loc(k.unit, lang), baseline: k.baseline, current: k.current, target: k.target, deadline: undefined as string | undefined })),
  ];
  const okrs = ctx.kpi.okrs.filter((o) => o.keyResults.some((kr) => s.kpiIds.includes(kr.kpiId)));
  const useCases = ctx.useCases.filter((u) => u.origin === 'registered' && (u.relatedIds.includes(s.id) || s.issueIds.some((id) => u.relatedIds.includes(id))));
  const inits = ctx.pack.pack.entities.filter((e): e is EntityOf<'initiative'> => e.kind === 'initiative' && e.solutionId === s.id && input.visible(e.id));
  const personName = (id?: string) => {
    const p = id ? ent(id, 'person') : undefined;
    return p ? name(p) : undefined;
  };
  const owners = [...new Set(inits.map((i) => personName(i.ownerId) ?? (i.ownerRole ? loc(i.ownerRole, lang) : undefined)).filter((x): x is string => !!x))];
  const personas = [...new Set(useCases.map((u) => translate(lang, personaLabel(u.persona))))];
  const systems = systemsOf(ctx.pack);
  const catalog = catalogOf(ctx.pack).slice(0, 12);
  const contributions = (ctx.strategy?.contributions ?? []).filter((c) => c.solutionId === s.id);
  const internal = s.classification === 'internal';
  const dev = input.actions.filter((a) => isDevType(a.type));
  const paren = (a: string, b: string) => (lang === 'ja' ? `${a}（${b}）` : `${a} (${b})`);
  const list = (xs: string[]) => (xs.length ? xs.join(lang === 'ja' ? '、' : ', ') : '');
  const kpiLine = (k: (typeof kpis)[number]) => L(b(
    `${k.name}: ${fmt.number(k.baseline)} → ${fmt.number(k.target)} ${k.unit}（現在 ${fmt.number(k.current)}${k.deadline ? `、期限 ${k.deadline}` : ''}）`,
    `${k.name}: ${fmt.number(k.baseline)} → ${fmt.number(k.target)} ${k.unit} (now ${fmt.number(k.current)}${k.deadline ? `, by ${k.deadline}` : ''})`,
  ));
  const solText = loc(s.description, lang);
  const solName = name(s);

  const out: string[] = [];
  const h = (level: number, text: string) => { if (out[out.length - 1] !== '') out.push(''); out.push(`${'#'.repeat(level)} ${text}`, ''); };
  const p = (...lines: string[]) => out.push(...lines);

  out.push(`# ${solName} — ${L(b('本番開発の要求定義書', 'Production requirements definition'))}`, '');
  p(L(b(
    `> Business Analytics Studio が ${ctx.today} に Project のデータから作成したドラフトです。${TO_FILL} はデータに根拠がない項目で、本番の開発を始める前に記入して合意してください。数値・日付・責任者は推定していません。`,
    `> Draft generated by Business Analytics Studio on ${ctx.today} from the project data. ${TO_FILL} marks what the data does not state; fill and agree it before production work starts. No number, date or owner has been estimated.`,
  )));

  h(2, L(b('0. 文書情報', '0. Document information')));
  p(`| ${L(b('項目', 'Item'))} | ${L(b('内容', 'Value'))} |`);
  p('|---|---|');
  p(`| ${L(b('企業', 'Company'))} | ${cell(input.company)} |`);
  p(`| ${L(b('Project', 'Project'))} | ${cell(input.project)} |`);
  p(`| ${L(b('解決策', 'Solution'))} | ${cell(solName)} (\`${s.id}\`) |`);
  p(`| ${L(b('状態', 'Status'))} | ${L(b('ドラフト（未承認）', 'Draft (not approved)'))} |`);
  p(`| ${L(b('機密区分', 'Classification'))} | ${internal ? L(b('社外秘（internal）', 'Internal')) : L(b('共有可（shareable）', 'Shareable'))} |`);
  p(`| ${L(b('構成の基準', 'Structure'))} | ISO/IEC/IEEE 29148:2018 |`);

  h(2, L(b('1. 目的と背景', '1. Purpose and background')));
  p(fill(L(b('1. 目的', '1. Purpose')), solText));
  if (issues.length) {
    p('', L(b('解決する課題（影響度・実現性は 1〜5）:', 'Issues it solves (impact and feasibility 1–5):')));
    for (const i of issues) p(`- ${name(i)} — ${loc(i.description, lang)} (${L(b('影響度', 'impact'))} ${i.impact}, ${L(b('実現性', 'feasibility'))} ${i.feasibility})`);
  } else p(fill(L(b('1. 課題', '1. Issues')), ''));
  if (causes.length) p('', `${L(b('根本原因', 'Root causes'))}: ${list(causes.map(name))}`);

  h(2, L(b('2. 対応策の種類と範囲', '2. Kinds of action and scope')));
  p(`| ${L(b('対応策', 'Action'))} | ${L(b('本書の対象', 'In this document'))} | ${L(b('推定の理由', 'Why'))} |`);
  p('|---|---|---|');
  for (const a of input.actions) {
    const why = a.origin === 'user' ? L(b('利用者が設定', 'Set by a person')) : a.reason === 'type' ? L(b('解決策の種類', 'Solution type')) : a.reason === 'adoption' ? L(b('ソフトウェアの定着化（Kotter, HBR 1995）', 'Adoption of software (Kotter, HBR 1995)')) : a.reason === 'default' ? L(b('デジタルの解決策の既定', 'Default for a digital solution')) : lang === 'ja' ? `「${a.reason}」` : `"${a.reason}"`;
    p(`| ${cell(L(ACTION_LABEL[a.type]))} | ${isDevType(a.type) ? L(b('対象', 'Yes')) : L(b('対象外（計画で扱う）', 'No (in the plan)'))} | ${cell(why)} |`);
  }
  p('', `${L(b('範囲外', 'Out of scope'))}: ${fill(L(b('2. 範囲外', '2. Out of scope')), '')}`);

  h(2, L(b('3. 利害関係者', '3. Stakeholders')));
  p(`- ${L(b('施策の責任者', 'Initiative owners'))}: ${fill(L(b('3. 責任者', '3. Owners')), list(owners))}`);
  p(`- ${L(b('利用者（ペルソナ）', 'Users (personas)'))}: ${fill(L(b('3. 利用者', '3. Users')), list(personas))}`);
  p(`- ${L(b('承認者（スポンサー）', 'Approver (sponsor)'))}: ${fill(L(b('3. 承認者', '3. Sponsor')), '')}`);

  h(2, L(b('4. 業務要求', '4. Business requirements')));
  if (kpis.length) {
    for (const k of kpis) { reqIds.push(`BR-${k.id}`); p(`- **BR-${k.id}** ${kpiLine(k)}`); }
  } else p(`- ${fill(L(b('4. 業務要求（KPI）', '4. Business requirement (KPI)')), '')}`);
  for (const o of okrs) p(`- ${L(b('目標（OKR）', 'Objective (OKR)'))}: ${loc(o.objective, lang)} — ${o.keyResults.filter((kr) => s.kpiIds.includes(kr.kpiId)).map((kr) => loc(kr.text, lang)).join(' / ')}`);

  h(2, L(b('5. 対応策ごとの要求', '5. Requirements per action')));
  if (dev.length === 0) p(L(b('この解決策にはソフトウェアの対応策がありません。', 'This solution has no software action.')));
  const consumers = input.actions.filter((a) => ['analytics', 'mlModel', 'agent', 'copilotPrompt', 'app'].includes(a.type)).map((a) => L(ACTION_LABEL[a.type]));
  const m365 = sources.filter((x) => x.origin === 'm365').map((x) => name(x));
  const catalogLine = (pick: (c: (typeof catalog)[number]) => string | undefined) => list(catalog.map((c) => {
    const v = pick(c);
    return v ? `${c.name}: ${v}` : '';
  }).filter(Boolean));
  const mlFraming = /予測|forecast/i.test(`${solName} ${solText}`) ? L(b('時系列の予測', 'Time-series forecasting'))
    : /検査|inspection|画像|image|vision/i.test(`${solName} ${solText} ${s.msProducts.join(' ')}`) ? L(b('画像の分類（良品・不良品の判定）', 'Image classification (pass / fail)'))
      : /異常|anomal/i.test(`${solName} ${solText}`) ? L(b('異常の検知', 'Anomaly detection'))
        : /最適化|optimi/i.test(`${solName} ${solText}`) ? L(b('数理最適化（予測を入力にした計画の最適化）', 'Mathematical optimisation (planning with forecasts as input)')) : '';
  const kpiTargets = list(kpis.map((k) => `${k.name} ${fmt.number(k.target)} ${k.unit}`));
  const kpiNow = list(kpis.map((k) => `${k.name} ${fmt.number(k.current)} ${k.unit}`));

  const sections: Record<ActionType, [Bi, string | null][]> = {
    copilotPrompt: [
      [b('目的と利用者', 'Goal and users'), solText ? `${solText}${personas.length ? ` — ${list(personas)}` : ''}` : null],
      [b('入力データの出どころ（ファイル・サイト・メール・会議）', 'Where the inputs come from (files, sites, mail, meetings)'), list(m365)],
      [b('プロンプト（目標・文脈・期待する出力・情報源の 4 要素）', 'Prompt (goal, context, expectations, source)'), solText && issues.length
        ? L(b(`目標: ${solName}。文脈: ${list(issues.map(name))}。期待する出力: ${TO_FILL}。情報源: ${list(m365) || TO_FILL}。`, `Goal: ${solName}. Context: ${list(issues.map(name))}. Expectations: ${TO_FILL}. Source: ${list(m365) || TO_FILL}.`))
        : null],
      [b('出力の形式と保存先', 'Output format and where it is saved'), null],
      [b('実行のしかた（手動・Cowork・Autopilot の自動実行と頻度）', 'How it runs (by hand, Cowork, Autopilot schedule and frequency)'), null],
      [b('人の確認（誰が何を見て採用するか）', 'Human review (who adopts the output, checking what)'), list(owners)],
      [b('評価（正確さ・採用率の基準と測り方）', 'Evaluation (accuracy and adoption, and how they are measured)'), kpiTargets ? L(b(`業務の指標: ${kpiTargets}`, `Business measures: ${kpiTargets}`)) : null],
      [b('権限と秘密度ラベル', 'Permissions and sensitivity labels'), internal ? L(b('社外秘の情報を含む。Copilot は利用者のアクセス権の範囲だけを読む。秘密度ラベルを確認する。', 'Contains internal information. Copilot reads only what the user may access; check sensitivity labels.')) : null],
    ],
    agent: [
      [b('目標と完了の条件', 'Goal and done criteria'), solText && kpiTargets ? `${solText} — ${kpiTargets}` : solText || null],
      [b('自律度（提案だけ／承認後に実行／自動で実行）', 'Autonomy (suggest only / act after approval / act automatically)'), null],
      [b('ツール・アクションと権限（読み取りと書き込みを分ける）', 'Tools and actions with permissions (separate read and write)'), list(systems) ? L(b(`接続の候補（現行のシステム）: ${list(systems)}`, `Candidate connections (current systems): ${list(systems)}`)) : null],
      [b('ループの上限（最大の反復回数・時間・費用・停止の条件）', 'Loop limits (max iterations, time, cost, stop conditions)'), null],
      [b('根拠にする知識と記憶（参照先・保持期間）', 'Knowledge and memory (what it reads, retention)'), list(sources.map(name))],
      [b('人の承認点と禁止する操作（ガードレール）', 'Human approval points and forbidden operations (guardrails)'), null],
      [b('失敗したときの扱い（やり直し・人への引き継ぎ）', 'Failure handling (retry, hand-over to a person)'), null],
      [b('評価（タスクの成功率・ツール呼び出しの正しさ・根拠への忠実さ）と合格基準', 'Evaluation (task success, tool-call correctness, groundedness) and pass marks'), null],
      [b('監視とログ（処理の追跡・監査）', 'Monitoring and logs (tracing, audit)'), null],
      [b('責任ある AI（公平性・透明性・プライバシー・確からしさの表示）', 'Responsible AI (fairness, transparency, privacy, showing certainty)'), null],
    ],
    app: [
      [b('利用者と役割', 'Users and roles'), list(personas)],
      [b('ユースケースと画面', 'Use cases and screens'), list(useCases.map((u) => paren(loc(u.name, lang), u.steps.map((x) => loc(x.title, lang)).join(' → '))))],
      [b('API（外部連携と認証の方式）', 'API (integrations and authentication)'), list(systems) ? L(b(`連携の候補: ${list(systems)}`, `Candidate integrations: ${list(systems)}`)) : null],
      [b('データモデル（主なエンティティと保持期間）', 'Data model (main entities and retention)'), list(catalog.map((c) => c.name))],
      [b('権限（ロールごとの操作）', 'Permissions (operations per role)'), null],
      [b('非機能（可用性・応答時間・同時利用者数）', 'Non-functional (availability, response time, concurrent users)'), null],
      [b('監査ログ・運用・移行', 'Audit log, operations, migration'), null],
    ],
    dataPipeline: [
      [b('ソース（システム・データ・所有者）', 'Sources (systems, data, owners)'), list([...systems, ...catalog.map((c) => (c.owner ? paren(c.name, c.owner) : c.name))])],
      [b('ターゲット（格納先と使う側）', 'Targets (store and consumers)'), consumers.length ? L(b(`使う側: ${list(consumers)}。格納先: ${TO_FILL}`, `Consumers: ${list(consumers)}. Store: ${TO_FILL}`)) : null],
      [b('方式（ETL／ELT、バッチ／ストリーム）', 'Method (ETL / ELT, batch / stream)'), null],
      [b('頻度と鮮度の約束（SLA）', 'Frequency and freshness (SLA)'), null],
      [b('データ契約（スキーマ・型・必須項目）', 'Data contract (schema, types, required fields)'), catalogLine((c) => (c.columns?.length ? c.columns.slice(0, 12).join(', ') : undefined))],
      [b('品質のルール（完全性・一意性・妥当性・適時性）', 'Quality rules (completeness, uniqueness, validity, timeliness)'), catalogLine((c) => c.quality)],
      [b('変換のルール', 'Transformation rules'), null],
      [b('冪等性・再実行・遅れて届くデータの扱い', 'Idempotency, re-runs, late-arriving data'), null],
      [b('系譜（リネージ）と監視', 'Lineage and monitoring'), null],
      [b('個人情報・秘密度・ライセンス', 'Personal data, sensitivity, licence'), catalogLine((c) => [c.personalData, c.license].filter(Boolean).join(' / ') || undefined)],
    ],
    analytics: [
      [b('支える意思決定と利用者', 'Decisions supported and users'), issues.length ? `${list(issues.map(name))}${personas.length ? ` — ${list(personas)}` : ''}` : null],
      [b('指標の定義（名前・単位・計算・目標）', 'Measure definitions (name, unit, calculation, target)'), list(kpis.map(kpiLine))],
      [b('切り口と粒度（期間・拠点・製品など）', 'Dimensions and grain (period, site, product…)'), null],
      [b('データモデル（ファクトとディメンション）', 'Data model (facts and dimensions)'), null],
      [b('更新の頻度', 'Refresh frequency'), null],
      [b('行レベルのセキュリティ', 'Row-level security'), null],
      [b('画面の構成', 'Layout'), L(b('最も重要な数値を左上に置き、1 画面で結論が分かるようにする。図ごとに同じデータの表を用意する（Power BI のダッシュボード設計のヒント）。', 'Put the most important number top-left and make the conclusion readable on one screen; give every visual a data table (Power BI dashboard design tips).'))],
      [b('アクセシビリティ', 'Accessibility'), L(b('色だけで意味を伝えない。キーボードで操作でき、強制カラーモードでも区別できる（WCAG 2.2 AA）。', 'Never rely on colour alone; keyboard operable and distinguishable in forced-colours mode (WCAG 2.2 AA).'))],
    ],
    mlModel: [
      [b('問題の定式化', 'Problem framing'), mlFraming],
      [b('予測する対象（ラベル）と予測の時点', 'What is predicted (label) and when'), null],
      [b('ベースライン（今のやり方の成績）', 'Baseline (how well it is done today)'), kpiNow ? L(b(`現在の業務の値: ${kpiNow}`, `Current business values: ${kpiNow}`)) : null],
      [b('評価指標と合格の基準（業務の KPI との対応）', 'Metric and pass mark (link to the business KPI)'), kpiTargets ? L(b(`業務の目標: ${kpiTargets}。モデルの指標と合格の値: ${TO_FILL}`, `Business target: ${kpiTargets}. Model metric and pass mark: ${TO_FILL}`)) : null],
      [b('学習データ（期間・件数・ラベルの作り方）', 'Training data (period, volume, how labels are made)'), list(catalog.map((c) => c.name)) ? L(b(`候補（関連を確認する）: ${list(catalog.map((c) => c.name))}`, `Candidates (confirm relevance): ${list(catalog.map((c) => c.name))}`)) : null],
      [b('データの分割とリークの防止', 'Data split and leakage prevention'), null],
      [b('説明可能性', 'Explainability'), null],
      [b('再学習とドリフトの監視', 'Retraining and drift monitoring'), null],
      [b('推論の方式（バッチ／リアルタイム）と応答時間', 'Inference (batch / real time) and latency'), null],
      [b('責任ある AI（公平性・人の確認）', 'Responsible AI (fairness, human review)'), null],
    ],
    process: [], change: [], investment: [], sourcing: [],
  };

  dev.forEach((a, i) => {
    h(3, `5.${i + 1} ${L(ACTION_LABEL[a.type])}`);
    p(`| ID | ${L(b('観点', 'Point'))} | ${L(b('要求', 'Requirement'))} |`);
    p('|---|---|---|');
    sections[a.type].forEach(([label, value], n) => {
      const id = `${PREFIX[a.type]}-${String(n + 1).padStart(2, '0')}`;
      reqIds.push(id);
      p(`| ${id} | ${cell(L(label))} | ${cell(fill(`${id} ${L(label)}`, value))} |`);
    });
  });

  h(2, L(b('6. 共通の非機能要求', '6. Common non-functional requirements')));
  p(`- ${L(b('セキュリティと機密区分', 'Security and classification'))}: ${internal ? L(b('社外秘として扱い、社外に送らない。', 'Treat as internal; never send outside the company.')) : fill(L(b('6. セキュリティ', '6. Security')), '')}`);
  p(`- ${L(b('可用性・性能', 'Availability and performance'))}: ${fill(L(b('6. 可用性・性能', '6. Availability and performance')), '')}`);
  p(`- ${L(b('アクセシビリティ', 'Accessibility'))}: WCAG 2.2 AA`);
  if (dev.some((a) => a.type === 'agent' || a.type === 'mlModel' || a.type === 'copilotPrompt')) {
    p(`- ${L(b('AI の出力の表示', 'Showing AI output'))}: ${L(b('AI が作った内容と分かるように示し、根拠・確からしさを見られ、人が編集・却下できる（HAX ガイドライン G1・G2・G9・G11）。', 'Label AI-generated content, show its basis and certainty, and let people edit or reject it (HAX guidelines G1, G2, G9, G11).'))}`);
  }

  h(2, L(b('7. 受入基準', '7. Acceptance criteria')));
  if (kpis.length) for (const k of kpis) { reqIds.push(`AC-${k.id}`); p(`- **AC-${k.id}** ${L(b(`${k.name} が ${k.deadline ?? TO_FILL} までに ${fmt.number(k.target)} ${k.unit} に達する（測り方: ${TO_FILL}）`, `${k.name} reaches ${fmt.number(k.target)} ${k.unit} by ${k.deadline ?? TO_FILL} (measured by: ${TO_FILL})`))}`); }
  else p(`- ${fill(L(b('7. 受入基準', '7. Acceptance criteria')), '')}`);
  if (kpis.some((k) => !k.deadline)) toFill.push(L(b('7. KPI の期限', '7. KPI deadline')));
  for (const k of kpis) toFill.push(L(b(`7. ${k.name} の測り方`, `7. How ${k.name} is measured`)));

  h(2, L(b('8. 優先度の根拠', '8. Why this priority')));
  if (input.priority) {
    const { row, scenario, of } = input.priority;
    p(L(b(
      `シナリオ「${scenario}」で ${of} 件中 ${row.rank} 位（優先度 ${fmt.number(Math.round(row.priority))}）。${row.funded ? '予算と着手できる件数の範囲で選ばれている。' : '予算か着手できる件数の範囲外。'}`,
      `Rank ${row.rank} of ${of} in scenario "${scenario}" (priority ${fmt.number(Math.round(row.priority))}). ${row.funded ? 'Within the budget and the number of items the team can start.' : 'Outside the budget or the number of items the team can start.'}`,
    )));
    p('', `| ${L(b('基準', 'Criterion'))} | ${L(b('評価（1〜5）', 'Score (1–5)'))} | ${L(b('出どころ', 'Origin'))} |`);
    p('|---|---|---|');
    const origin = { data: b('データ', 'Data'), rule: b('規則による推定', 'Rule'), unrated: b('未評価（中立の 3）', 'Not rated (neutral 3)'), user: b('利用者', 'Person') };
    const crit: Record<ScoreKey, Bi> = {
      value: b('価値・インパクト', 'Value / impact'), alignment: b('戦略との整合', 'Strategic alignment'), confidence: b('確信度', 'Confidence'),
      execution: b('実行のしやすさ', 'Ease of execution'), option: b('可逆性・選択肢の価値', 'Reversibility / option value'), urgency: b('時間的な切迫度', 'Time criticality'), size: b('規模', 'Size'),
    };
    for (const k of SCORE_KEYS) p(`| ${L(crit[k])} | ${row.scores[k].value} | ${L(origin[row.scores[k].origin])} |`);
  } else p(L(b('優先度のシミュレーションの対象外です。', 'Not ranked in the what-if.')));

  h(2, L(b('9. 実行計画', '9. Plan')));
  const mine = input.schedule.filter((x) => x.solutionId === s.id);
  if (mine.length) {
    p(`| ${L(b('対応策', 'Action'))} | ${L(b('開始', 'Start'))} | ${L(b('終了', 'End'))} | ${L(b('週', 'Weeks'))} | ${L(b('先に終える対応策', 'After'))} |`);
    p('|---|---|---|---|---|');
    for (const x of mine) {
      const after = x.dependsOn.map((k) => L(ACTION_LABEL[k.split(':').pop() as ActionType]));
      p(`| ${cell(L(ACTION_LABEL[x.type]))} | ${addWeeks(input.planStart, x.startWeek)} | ${addWeeks(input.planStart, x.endWeek)} | ${x.weeks} | ${cell(list(after) || '—')} |`);
    }
    p('', L(b('期間は目安の既定値（PARAM-215）か利用者の見積もりです。', 'Durations are planning defaults (PARAM-215) or a person\'s estimate.')));
  } else p(fill(L(b('9. 実行計画', '9. Plan')), ''));

  h(2, L(b('10. 前提・制約・リスク', '10. Assumptions, constraints and risks')));
  p(`- ${L(b('費用', 'Cost'))}: ${s.costJpy !== undefined ? fmt.number(s.costJpy) + L(b(' 円', ' JPY')) : fill(L(b('10. 費用', '10. Cost')), '')}`);
  p(`- ${L(b('年間の効果', 'Annual benefit'))}: ${s.annualBenefitJpy !== undefined ? fmt.number(s.annualBenefitJpy) + L(b(' 円', ' JPY')) : fill(L(b('10. 年間の効果', '10. Annual benefit')), '')}`);
  for (const c of contributions) p(`- ${L(b('効果の見積もり', 'Effect estimate'))}: ${c.lever} (${c.leverUnit}) — ${c.evidence || TO_FILL}`);
  p(`- ${L(b('主なリスク', 'Main risks'))}: ${fill(L(b('10. リスク', '10. Risks')), '')}`);

  h(2, L(b('11. 追跡表', '11. Traceability')));
  p(`| ${L(b('課題', 'Issue'))} | KPI | ${L(b('業務要求', 'Business req.'))} | ${L(b('対応策の要求', 'Action requirements'))} |`);
  p('|---|---|---|---|');
  const actionReqs = reqIds.filter((id) => !id.startsWith('BR-') && !id.startsWith('AC-'));
  for (const i of issues.length ? issues : [undefined]) {
    const ks = kpis.filter((k) => !i || i.kpiIds.includes(k.id) || kpis.length === 1);
    p(`| ${cell(i ? name(i) : '—')} | ${cell(list(ks.map((k) => k.name)) || '—')} | ${list(ks.map((k) => `BR-${k.id}`)) || '—'} | ${list(actionReqs) || '—'} |`);
  }

  h(2, L(b('12. 未決事項', '12. Open items')));
  if (toFill.length === 0) p(L(b('なし', 'None')));
  else for (const x of [...new Set(toFill)]) p(`- [ ] ${x}`);

  h(2, L(b('出典', 'References')));
  p('- ISO/IEC/IEEE 29148:2018 Systems and software engineering — Requirements engineering. https://www.iso.org/standard/72089.html');
  p('- Microsoft Design (2025). UX design for agents. https://microsoft.design/articles/ux-design-for-agents/');
  p('- Amershi, S. et al. (2019). Guidelines for Human-AI Interaction. CHI 2019. https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/');
  p('- Microsoft Learn. Tips for designing a great Power BI dashboard. https://learn.microsoft.com/power-bi/create-reports/service-dashboards-design-tips');
  p('- Kotter, J. P. (1995). Leading Change: Why Transformation Efforts Fail. Harvard Business Review. https://hbr.org/1995/05/leading-change-why-transformation-efforts-fail-2');
  out.push('');
  return { fileTitle: solName, markdown: out.join('\n'), toFill: [...new Set(toFill)], requirementIds: reqIds };
}
