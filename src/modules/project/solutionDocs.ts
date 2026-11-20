import type { Entity, EntityOf } from '../../data/schema.ts';
import { isRuleKind, isVoiceKind, type EvidenceKind } from '../../data/extensionSchemas.ts';
import { makeFormatters, translate, type Lang, type MessageKey } from '../../i18n/core.ts';
import { personaLabel } from '../../state/personas.ts';
import { loc, type Localizable } from '../../state/text.ts';
import type { CatalogItem } from '../usecases/catalogSchema.ts';
import type { DeliverableData } from './deliverables.ts';
import { catalogOf, evidenceViews, glossaryOf, systemsOf, type EvidenceView } from './docInputs.ts';
import { checkRequirementText, type QualityIssue } from './requirementQuality.ts';
import { reqId } from './requirementsModel.ts';
import { isSystemType, type StrategyContext, type StrategyThread, type ThreadSolution, type DeliverableKind } from './strategy.ts';

/**
 * The final deliverable of each solution (FR-315). A digital solution ends in a requirements definition (structure after
 * ISO/IEC/IEEE 29148: business requirements traced to key results, functional requirements from use cases, non-functional
 * requirements, acceptance criteria tied to KPI targets, a traceability matrix). A prompt or an AI agent ends in a
 * specification of what a generative AI is told and what it may do (IPA requirements handbook 5.3, 5.4, 8.4, 8.5).
 * Other changes end in the plan that fits them, because not every business problem is solved by a system. Sections are
 * generated deterministically from the linked data; what the data cannot say is marked "to fill" and keeps the
 * deliverable incomplete until a person writes it. Requirement ids follow what the requirement is about (BR-<kpi>,
 * FR-<use case>), never its position, so a reference from outside keeps pointing at the same requirement.
 */

const SYSTEM_HEAD = ['purpose', 'scope', 'stakeholders', 'glossary', 'businessReq'];
const SYSTEM_TAIL = ['constraints', 'acceptance', 'benefits', 'risks', 'rtm'];

export const SECTIONS: Record<DeliverableKind, string[]> = {
  requirements: [...SYSTEM_HEAD, 'functionalReq', 'nonFunctionalReq', 'dataReq', ...SYSTEM_TAIL],
  promptSpec: [...SYSTEM_HEAD, 'promptElements', 'copilotPrompt', 'copilotAttachments', 'promptContext', 'reviewProcedure', 'promptEval', 'promptVersion', ...SYSTEM_TAIL],
  agentSpec: [
    ...SYSTEM_HEAD, 'functionalReq', 'roleSplit', 'uncertainty', 'fallback', 'dataReq', 'dataSupply', 'evaluation', 'monitoring', 'logging', 'nonFunctionalReq',
    ...SYSTEM_TAIL,
  ],
  processPlan: ['purpose', 'scope', 'stakeholders', 'asisTobe', 'changes', 'roles', 'transition', 'benefits', 'risks', 'rtm'],
  changePlan: ['purpose', 'scope', 'stakeholders', 'policyChange', 'impact', 'changeApproach', 'governance', 'benefits', 'risks', 'rtm'],
  investmentPlan: ['purpose', 'scope', 'stakeholders', 'investment', 'businessCase', 'procurement', 'benefits', 'risks', 'rtm'],
  sourcingPlan: ['purpose', 'scope', 'stakeholders', 'sourcingScope', 'selection', 'contract', 'benefits', 'risks', 'rtm'],
};

/** Sections whose lines are requirement statements: they are checked for vague and compound wording. */
const QUALITY_SECTIONS: ReadonlySet<string> = new Set(['businessReq', 'functionalReq', 'nonFunctionalReq', 'dataReq', 'acceptance', 'constraints', 'roleSplit', 'fallback', 'monitoring', 'logging']);

export const TO_FILL: Record<Lang, string> = { ja: '【要記入】', en: '[TO FILL]' };
export const hasToFill = (text: string) => text.includes(TO_FILL.ja) || text.includes(TO_FILL.en);

export const sectionKey = (id: string) => `sol.sec.${id}` as MessageKey;
export const kindKey = (kind: DeliverableKind) => `sol.kind.${kind}` as MessageKey;

export interface DocContext extends StrategyContext {
  deliverables: DeliverableData;
  today: string;
  /** The data dictionary imported for this project; the pack's own is used when absent. */
  catalog?: CatalogItem[];
}

export interface DocSection {
  id: string;
  text: string;
  /** Written by a person (overrides the generated text). */
  edited: boolean;
  /** Still has "to fill" parts. */
  open: boolean;
  /** Vague or compound statements found in the text (29148: unambiguous, singular). */
  quality: QualityIssue[];
}

/** One requirement of the document with the data it stands on (handbook table 9). */
export interface ReqItem {
  id: string;
  section: string;
  text: string;
  /** What it comes from: the KPI, use case, rule or voice. */
  source: string;
  /** How it is verified by default; a person can replace it in the ledger. */
  verification: string;
}

export interface SolutionDoc {
  solutionId: string;
  kind: DeliverableKind;
  sections: DocSection[];
  items: ReqItem[];
  complete: boolean;
  /** No vague or compound statement is left in the requirement sections. */
  clean: boolean;
}

type Bi = { ja: string; en: string };
const bullets = (lines: string[]) => lines.filter(Boolean).map((l) => `- ${l}`).join('\n');

/* ---------- Checklists taken from the handbook, used for drafts and for the sections that cannot be generated ---------- */

/** Handbook table 19: what an AI's uncertainty must be specified by. */
const UNCERTAINTY: Bi[] = [
  { ja: '精度: どの評価データで、どの指標を、どの水準以上にするか', en: 'Accuracy: on which evaluation data, by which metric, at or above which level' },
  { ja: '信頼区間: 評価結果のばらつきをどう扱うか', en: 'Confidence interval: how the spread of results is handled' },
  { ja: '確信度: AI が自分の出力にどの程度自信を持つかをどう扱うか', en: 'Confidence: how the AI\'s own certainty in an output is used' },
  { ja: '誤分類: どの種類の誤りを特に避けるか', en: 'Errors: which kind of mistake must be avoided most' },
  { ja: 'ハルシネーション: 事実と異なる出力の検知・抑制・対応', en: 'Hallucination: detecting, limiting and handling output that is not true' },
  { ja: '想定外の入力（OOD）: 想定外の入力にどう振る舞うか', en: 'Out-of-distribution input: how unexpected input is handled' },
  { ja: '継続的評価と再評価条件: 運用後の劣化とモデル・データ・プロンプト変更の確認', en: 'Continuous evaluation and re-evaluation: how decay and changes of model, data or prompt are checked' },
];

/** Handbook table 20: what the AI does when it is unsure, with the handbook's example as the starting proposal. */
const FALLBACKS: Bi[] = [
  { ja: '確信度が低いとき: 自動処理せず人の確認に回す（しきい値を決める）', en: 'Confidence is low: do not process automatically; route to a person (set the threshold)' },
  { ja: '入力が不十分なとき: 追加情報を求める', en: 'Input is insufficient: ask for more information' },
  { ja: '入力が想定外のとき: 処理を停止し、例外として記録する', en: 'Input is unexpected: stop and record an exception' },
  { ja: '高リスク業務のとき: AI の出力は参考情報にとどめ、最終判断は人が行う', en: 'High-risk work: the output is reference only; a person decides' },
  { ja: '根拠が不明なとき: 回答を生成せず、参照資料が足りないと表示する', en: 'No ground found: do not answer; show that reference material is missing' },
  { ja: '解釈が複数あるとき: 候補と前提を示し、人に選ばせる', en: 'Several readings: show candidates and assumptions; let a person choose' },
  { ja: 'ハルシネーションの疑いがあるとき: 原資料との照合を必須にする', en: 'Possible hallucination: require checking against the source' },
  { ja: 'セキュリティ上の疑義があるとき: 応答を拒否し、ログを残す', en: 'Security concern: refuse and keep a log' },
];

/** Handbook table 21: what a good prompt contains. */
const PROMPT_PARTS: { key: string; label: Bi; hint: Bi }[] = [
  { key: 'role', label: { ja: '役割', en: 'Role' }, hint: { ja: 'AI にどの立場で作業させるか', en: 'the position the AI works from' } },
  { key: 'input', label: { ja: '入力', en: 'Input' }, hint: { ja: 'どの情報を参照させるか', en: 'which information it may use' } },
  { key: 'limits', label: { ja: '制約', en: 'Constraints' }, hint: { ja: '何をしてはいけないか', en: 'what it must not do' } },
  { key: 'format', label: { ja: '出力形式', en: 'Output format' }, hint: { ja: '表・箇条書き・文章・JSON など', en: 'table, list, prose, JSON …' } },
  { key: 'criteria', label: { ja: '評価基準', en: 'Evaluation criteria' }, hint: { ja: '何を満たせばよい出力とするか', en: 'what makes an output good' } },
  { key: 'confirm', label: { ja: '確認事項', en: 'Confirmations' }, hint: { ja: '不明点・前提・リスクを明示させる', en: 'have it state unknowns, assumptions and risks' } },
  { key: 'grounds', label: { ja: '根拠', en: 'Grounds' }, hint: { ja: '出典や判断理由を示させる', en: 'have it cite sources and reasons' } },
];

/** Handbook table 29: what is recorded about each dataset. */
const DATA_ATTRS: { key: 'owner' | 'provenance' | 'license' | 'personalData' | 'quality' | 'updateFrequency' | 'retention'; label: Bi }[] = [
  { key: 'provenance', label: { ja: '出所', en: 'Provenance' } },
  { key: 'owner', label: { ja: '所有者', en: 'Owner' } },
  { key: 'license', label: { ja: '利用条件', en: 'Terms of use' } },
  { key: 'personalData', label: { ja: '個人情報', en: 'Personal data' } },
  { key: 'quality', label: { ja: '品質', en: 'Quality' } },
  { key: 'updateFrequency', label: { ja: '更新頻度', en: 'Update frequency' } },
  { key: 'retention', label: { ja: '保存・削除', en: 'Retention and deletion' } },
];

const ROLE_SPLIT: Bi[] = [
  { ja: 'AI が自動で処理・判断する範囲', en: 'What the AI processes or decides on its own' },
  { ja: 'AI が候補や推奨を示すだけの範囲', en: 'What the AI only suggests' },
  { ja: '人の確認・承認が必要な範囲と、エスカレーションの条件', en: 'What needs a person\'s check or approval, and when to escalate' },
  { ja: '利用者が異議を申し立てる方法', en: 'How a user can object' },
  { ja: '誤りが起きたときの責任者と対応', en: 'Who is accountable and what happens when it is wrong' },
];

/** Categories of non-functional requirements and the evidence that can fill each (handbook 12, 13). */
const NFR_CATEGORIES: { id: string; label: Bi; kinds: EvidenceKind[]; numeric?: boolean }[] = [
  { id: 'performance', label: { ja: '性能', en: 'Performance' }, kinds: ['sla'], numeric: true },
  { id: 'availability', label: { ja: '可用性', en: 'Availability' }, kinds: ['sla'], numeric: true },
  { id: 'security', label: { ja: 'セキュリティ', en: 'Security' }, kinds: ['security'] },
  { id: 'privacy', label: { ja: '個人情報', en: 'Privacy' }, kinds: ['privacy'] },
  { id: 'operations', label: { ja: '運用保守', en: 'Operations' }, kinds: ['operations'] },
  { id: 'migration', label: { ja: '移行・連携', en: 'Migration and integration' }, kinds: ['system'] },
];

/** The points a draft of this section should cover; empty when the section has no checklist. */
export function sectionGuide(id: string, lang: Lang): string[] {
  const L = (b: Bi) => b[lang];
  switch (id) {
    case 'nonFunctionalReq': return NFR_CATEGORIES.map((c) => L(c.label));
    case 'uncertainty': return UNCERTAINTY.map(L);
    case 'fallback': return FALLBACKS.map(L);
    case 'roleSplit': return ROLE_SPLIT.map(L);
    case 'promptElements': return PROMPT_PARTS.map((p) => `${L(p.label)}: ${L(p.hint)}`);
    case 'dataSupply': return DATA_ATTRS.map((a) => L(a.label));
    case 'evaluation': return [L({ ja: '評価データの出典・件数・偏り', en: 'Source, size and bias of the evaluation data' }), L({ ja: '指標と許容水準（AI を使わない案との比較を含む）', en: 'Metrics and accepted levels, compared with a solution without AI' })];
    case 'monitoring': return [L({ ja: '運用後に監視する指標と頻度', en: 'What is watched after launch, and how often' }), L({ ja: '再評価・停止の条件', en: 'When to re-evaluate or stop' })];
    case 'logging': return [L({ ja: '参照した文書・生成時刻・担当者の修正有無を残すか', en: 'Whether the documents used, the time and the person\'s edits are kept' }), L({ ja: '保存期間と閲覧者', en: 'Retention and who may read the log' })];
    default: return [];
  }
}

/** The data dictionary entries a solution names (all of them when the dictionary is small). */
function relevantCatalog(s: EntityOf<'solution'>, ucs: DocContext['useCases'], c: DocContext, lang: Lang): CatalogItem[] {
  const catalog = c.catalog?.length ? c.catalog : catalogOf(c.pack);
  const dataNeeds = c.deliverables.docs.solution?.dataNeeds?.text.trim() ?? '';
  const pool = [dataNeeds, loc(s.description, lang), ...ucs.flatMap((u) => [loc(u.summary, lang), ...u.steps.map((st) => loc(st.description, lang))])].join('\n').toLowerCase();
  return catalog.filter((it) => pool.includes(it.name.toLowerCase())).concat(catalog.length <= 8 ? catalog.filter((it) => !pool.includes(it.name.toLowerCase())) : []).slice(0, 20);
}

/** A file the person attaches in Microsoft 365 Copilot, built from the project data (never written by the model). */
export interface AttachmentCandidate {
  id: string;
  file: string;
  description: string;
  content: string;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/**
 * Attachments for a prompt run in Microsoft 365 Copilot: the linked KPIs, issues and causes, use cases, data dictionary,
 * glossary and evidence. `show` hides what may not leave the company (external audience); project-only data (use cases,
 * evidence) is left out then.
 */
export function attachmentCandidates(
  s: EntityOf<'solution'>, ts: ThreadSolution, c: DocContext, lang: Lang, show: (e: Entity) => boolean = () => true, internal = true,
): AttachmentCandidate[] {
  const L = (b: Bi) => b[lang];
  const visible = (id: string) => {
    const e = c.pack.byId.get(id);
    return e && show(e) ? e : undefined;
  };
  const out: AttachmentCandidate[] = [];
  const kpis = ts.kpiIds.map((id) => c.kpi.kpis.find((k) => k.id === id)).filter((k): k is NonNullable<typeof k> => !!k && (internal || !!visible(k.id)));
  if (kpis.length) {
    out.push({
      id: 'kpis', file: 'kpi.csv',
      description: L({ ja: `KPI の基準値・現在値・目標値・期限（${kpis.length} 件）`, en: `KPI baseline, current, target and deadline (${kpis.length})` }),
      content: csv([
        lang === 'ja' ? ['KPI', '単位', '基準値', '現在値', '目標値', '期限'] : ['KPI', 'Unit', 'Baseline', 'Current', 'Target', 'Deadline'],
        ...kpis.map((k) => [loc(k.name, lang), loc(k.unit, lang), k.baseline, k.current, k.target, k.deadline]),
      ]),
    });
  }
  const issues = s.issueIds.map(visible).filter((e): e is EntityOf<'issue'> => e?.kind === 'issue');
  if (issues.length) {
    const name = (id: string) => {
      const e = visible(id);
      return e && 'name' in e ? loc(e.name as Localizable, lang) : '';
    };
    out.push({
      id: 'issues', file: 'issues.md',
      description: L({ ja: `課題・原因・出典（${issues.length} 件）`, en: `Issues, causes and sources (${issues.length})` }),
      content: [
        L({ ja: '# 課題と原因', en: '# Issues and causes' }),
        ...issues.flatMap((i) => {
          const causes = i.causeIds.map(visible).filter((e): e is EntityOf<'cause'> => e?.kind === 'cause');
          const sources = i.sourceIds.map(name).filter(Boolean);
          return [
            '', `## ${loc(i.name, lang)}`, '', loc(i.description, lang),
            ...(causes.length ? ['', L({ ja: '原因:', en: 'Causes:' }), ...causes.map((x) => `- ${loc(x.name, lang)}: ${loc(x.description, lang)}`)] : []),
            ...(sources.length ? ['', `${L({ ja: '出典', en: 'Sources' })}: ${sources.join(', ')}`] : []),
          ];
        }),
      ].join('\n'),
    });
  }
  const ucs = internal ? c.useCases.filter((u) => ts.useCaseIds.includes(u.id)) : [];
  if (ucs.length) {
    out.push({
      id: 'usecases', file: 'usecases.md',
      description: L({ ja: `ユースケースと手順（${ucs.length} 件）`, en: `Use cases and steps (${ucs.length})` }),
      content: [
        L({ ja: '# ユースケース', en: '# Use cases' }),
        ...ucs.flatMap((u) => ['', `## ${loc(u.name, lang)}`, '', loc(u.summary, lang), '', ...u.steps.map((st, n) => `${n + 1}. ${loc(st.title, lang)}${loc(st.description, lang) ? ` — ${loc(st.description, lang)}` : ''}`)]),
      ].join('\n'),
    });
  }
  const catalog = relevantCatalog(s, internal ? c.useCases.filter((u) => ts.useCaseIds.includes(u.id)) : [], c, lang);
  if (catalog.length) {
    out.push({
      id: 'catalog', file: 'data-dictionary.csv',
      description: L({ ja: `データ辞書（${catalog.length} 件）`, en: `Data dictionary (${catalog.length})` }),
      content: csv([
        [L({ ja: '名前', en: 'Name' }), L({ ja: '説明', en: 'Description' }), ...DATA_ATTRS.map((a) => L(a.label))],
        ...catalog.map((it) => [it.name, it.description ?? '', ...DATA_ATTRS.map((a) => it[a.key] ?? '')]),
      ]),
    });
  }
  const terms = glossaryOf(c.pack, lang);
  if (terms.length) {
    out.push({
      id: 'glossary', file: 'glossary.csv',
      description: L({ ja: `用語集（${terms.length} 語）`, en: `Glossary (${terms.length} terms)` }),
      content: csv([[L({ ja: '用語', en: 'Term' }), L({ ja: '定義', en: 'Definition' })], ...terms.map((g) => [g.term, g.definition])]),
    });
  }
  const evidence = internal ? evidenceViews(c.pack, c.strategy, lang).filter((e) => isRuleKind(e.kind) || isVoiceKind(e.kind) || ['law', 'standard', 'policy', 'aiPolicy'].includes(e.kind)) : [];
  if (evidence.length) {
    out.push({
      id: 'evidence', file: 'evidence.md',
      description: L({ ja: `規程・利用者の声などの根拠（${evidence.length} 件）`, en: `Rules, user voices and other evidence (${evidence.length})` }),
      content: [
        L({ ja: '# 根拠', en: '# Evidence' }),
        ...evidence.flatMap((e) => ['', `## ${e.title}`, '', e.summary, ...(e.sources.length ? ['', `${L({ ja: '出典', en: 'Sources' })}: ${e.sources.join(', ')}`] : [])]),
      ].join('\n'),
    });
  }
  return out;
}

/** The attachments a "copilotAttachments" section names (one file name per line; deleting a line drops the file). */
export function chosenAttachments(sectionText: string, candidates: AttachmentCandidate[]): AttachmentCandidate[] {
  return candidates.filter((a) => sectionText.includes(a.file));
}
export const attachmentLines = (list: AttachmentCandidate[]) => bullets(list.map((a) => `${a.file} — ${a.description}`));

export function buildSolutionDoc(s: EntityOf<'solution'>, ts: ThreadSolution, thread: StrategyThread, c: DocContext, lang: Lang): SolutionDoc {
  const L = (b: Bi) => b[lang];
  const fill = (b: Bi) => `${TO_FILL[lang]} ${L(b)}`;
  const fmt = makeFormatters(lang);
  const get = (id: string) => c.pack.byId.get(id);
  const name = (e: { name: Localizable }) => loc(e.name, lang);
  const sep = L({ ja: '、', en: ', ' });
  const kpis = ts.kpiIds.map((id) => c.kpi.kpis.find((k) => k.id === id)).filter((k): k is NonNullable<typeof k> => !!k);
  const kpiName = (k: { name: Localizable }) => loc(k.name, lang);
  const unit = (k: { unit: Localizable }) => loc(k.unit, lang);
  const issues = s.issueIds.map(get).filter((e): e is EntityOf<'issue'> => e?.kind === 'issue');
  const ucs = c.useCases.filter((u) => ts.useCaseIds.includes(u.id));
  const inits = ts.initiativeIds.map(get).filter((e): e is EntityOf<'initiative'> => e?.kind === 'initiative').sort((a, b) => a.start.localeCompare(b.start));
  const contributions = c.strategy.contributions.filter((x) => x.solutionId === s.id);
  const system = isSystemType(ts.type);
  const evidence = evidenceViews(c.pack, c.strategy, lang);
  const systems = systemsOf(c.pack);
  const terms = glossaryOf(c.pack, lang);
  const items: ReqItem[] = [];
  const addItem = (item: ReqItem) => items.push(item);
  const from = (e: EvidenceView) => e.sources.length ? L({ ja: `出典: ${e.sources.join(sep)}`, en: `Source: ${e.sources.join(sep)}` }) : '';
  const role = (id: string) => {
    const p = get(id);
    return p?.kind === 'person' ? loc(p.role, lang) : '';
  };
  const okrsOf = (kpiId: string) => thread.okrs.filter((o) => o.kpiIds.includes(kpiId));
  const okrText = (id: string) => {
    const o = c.kpi.okrs.find((x) => x.id === id);
    return o ? loc(o.objective, lang) : id;
  };
  const objText = (id: string) => c.objectives.find((o) => o.id === id)?.text ?? id;
  const sim = (kpiId: string) => thread.sims.find((x) => x.kpiId === kpiId);
  const doc = (step: string, field: string) => c.deliverables.docs[step]?.[field]?.text.trim() ?? '';
  const pct = (n: number) => fmt.percent(n);
  const num = (n: number) => fmt.number(Math.round(n * 100) / 100);

  const chain = kpis.flatMap((k) => {
    const okrs = okrsOf(k.id);
    if (!okrs.length) return [L({ ja: `KPI「${kpiName(k)}」（OKR 未接続）`, en: `KPI "${kpiName(k)}" (no OKR)` })];
    return okrs.map((o) => {
      const objs = o.objectiveIds.map(objText);
      const head = objs.length ? L({ ja: `会社目標「${objs.join('」「')}」→ `, en: `Company objective "${objs.join('", "')}" → ` }) : L({ ja: '（会社目標 未接続）→ ', en: '(no company objective) → ' });
      return `${head}${L({ ja: `OKR「${okrText(o.id)}」→ KPI「${kpiName(k)}」`, en: `OKR "${okrText(o.id)}" → KPI "${kpiName(k)}"` })}`;
    });
  });

  const benefits = bullets(kpis.map((k) => {
    const r = sim(k.id);
    const src = (k.sourceIds ?? []).map(get).filter((e): e is EntityOf<'source'> => e?.kind === 'source').map(name);
    const forecast = r
      ? L({ ja: `期限時点の予測 P10 ${num(r.p10)} / P50 ${num(r.p50)} / P90 ${num(r.p90)} ${unit(k)}、達成確率 ${pct(r.probability)}`, en: `forecast at deadline P10 ${num(r.p10)} / P50 ${num(r.p50)} / P90 ${num(r.p90)} ${unit(k)}, probability ${pct(r.probability)}` })
      : L({ ja: '効果の見積りなし', en: 'no contribution estimate' });
    return L({
      ja: `${kpiName(k)}: ${num(k.current)} → ${num(k.target)} ${unit(k)}（期限 ${k.deadline}）。${forecast}。測定元: ${src.join(sep) || TO_FILL.ja}`,
      en: `${kpiName(k)}: ${num(k.current)} → ${num(k.target)} ${unit(k)} (by ${k.deadline}). ${forecast}. Measured from: ${src.join(sep) || TO_FILL.en}`,
    });
  }).concat(contributions.map((x) => L({
    ja: `施策の量: ${x.lever || TO_FILL.ja} を ${num(x.amount.low)}〜${num(x.amount.high)}（最頻 ${num(x.amount.mode)}）${x.leverUnit}、単位当たり効果 ${num(x.effectPerUnit.mode)}（根拠: ${x.basis}${x.evidence ? `、${x.evidence}` : ''}）`,
    en: `Lever: ${x.lever || TO_FILL.en} ${num(x.amount.low)}–${num(x.amount.high)} (likely ${num(x.amount.mode)}) ${x.leverUnit}, effect per unit ${num(x.effectPerUnit.mode)} (basis: ${x.basis}${x.evidence ? `, ${x.evidence}` : ''})`,
  })))) || fill({ ja: 'KPI と効果の見積りをつなぐ', en: 'link a KPI and estimate the contribution' });

  const risks = bullets([
    ...kpis.flatMap((k) => (sim(k.id)?.warnings ?? []).map((w) => L({
      ja: `${kpiName(k)}: ${({ overlap: '複数の解決策が同じ KPI に効果を計上（二重計上の恐れ）', overclaim: '効果がギャップの 1.5 倍超（過大見積りの恐れ）', assumptionOnly: '効果の根拠が仮定のみ', afterDeadline: '効果の立ち上がりが KPI 期限に間に合わない', invalidRange: '見積りの範囲が不正' } as const)[w]}`,
      en: `${kpiName(k)}: ${({ overlap: 'several solutions claim this KPI (possible double counting)', overclaim: 'effect exceeds 1.5× the gap (possible over-claim)', assumptionOnly: 'the effect rests on assumptions only', afterDeadline: 'the effect starts after the KPI deadline', invalidRange: 'an estimate range is invalid' } as const)[w]}`,
    }))),
    ...inits.filter((i) => i.dependsOn.length).map((i) => L({ ja: `${name(i)} は前提の施策が遅れると遅れる`, en: `${name(i)} slips if what it depends on slips` })),
    doc('deliverable', 'risks') ? doc('deliverable', 'risks') : '',
  ]) || fill({ ja: '前提が外れた場合の影響と対策', en: 'impact and response if an assumption fails' });

  const brId = (k: { id: string }) => reqId('BR', k.id);
  const acId = (k: { id: string }) => reqId('AC', k.id);
  const frId = (u: { id: string }) => reqId('FR', u.id);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

  const rtmHead = L({ ja: '| 会社目標 | OKR | KPI（目標） | 要求 ID | 予測 P50 | ユースケース・施策 | 本書の節 |', en: '| Company objective | OKR | KPI (target) | Requirement IDs | Forecast P50 | Use case / initiative | Section |' });
  const rtmRows = kpis.flatMap((k) => {
    const okrs = okrsOf(k.id);
    const r = sim(k.id);
    const linked = [...ucs.map((u) => loc(u.name, lang)), ...inits.map(name)].join(sep) || '—';
    const ids = system ? [brId(k), acId(k), ...ucs.map(frId)].join(', ') : '—';
    const section = translate(lang, sectionKey(system ? 'businessReq' : 'benefits'));
    return (okrs.length ? okrs : [{ id: '', objectiveIds: [] as string[] }]).map((o) => `| ${o.objectiveIds.map(objText).join(sep) || '—'} | ${o.id ? okrText(o.id) : '—'} | ${kpiName(k)} (${num(k.target)} ${unit(k)}) | ${ids} | ${r ? num(r.p50) : '—'} | ${linked} | ${section} |`);
  });
  const rtm = rtmRows.length ? [rtmHead, '|---|---|---|---|---|---|---|', ...rtmRows].join('\n') : fill({ ja: 'KPI につなぐとトレーサビリティ表ができる', en: 'link a KPI to build the traceability matrix' });

  const people = [...new Set(inits.map((i) => role(i.ownerId)).filter(Boolean))];
  const kpiOwners = [...new Set(kpis.map((k) => {
    const pk = get(k.id);
    return pk?.kind === 'kpi' ? role(pk.ownerId) : '';
  }).filter(Boolean))];
  const personas = [...new Set(ucs.map((u) => translate(lang, personaLabel(u.persona) as MessageKey)))];

  /* ---- Requirements with stable ids, and the sections that read evidence the project already holds ---- */
  const okrLine = (k: { id: string }) => okrsOf(k.id).map((o) => okrText(o.id)).join(sep);
  const brLines = kpis.map((k) => {
    const text = L({
      ja: `${kpiName(k)} を ${num(k.current)} から ${num(k.target)} ${unit(k)} にする（期限 ${k.deadline}${okrsOf(k.id).length ? `、KR: ${okrLine(k)}` : ''}）`,
      en: `move ${kpiName(k)} from ${num(k.current)} to ${num(k.target)} ${unit(k)} (by ${k.deadline}${okrsOf(k.id).length ? `; KR: ${okrLine(k)}` : ''})`,
    });
    addItem({ id: brId(k), section: 'businessReq', text, source: L({ ja: `KPI「${kpiName(k)}」`, en: `KPI "${kpiName(k)}"` }), verification: L({ ja: 'KPI の実績値を測定する', en: 'measure the KPI actual' }) });
    return `${brId(k)}: ${text}`;
  });
  const acLines = kpis.map((k) => {
    const r = sim(k.id);
    const text = L({
      ja: `${k.deadline} 時点で ${kpiName(k)} が ${num(k.target)} ${unit(k)} に達する${r ? `（見積りの達成確率 ${pct(r.probability)}）` : ''}`,
      en: `${kpiName(k)} reaches ${num(k.target)} ${unit(k)} by ${k.deadline}${r ? ` (estimated probability ${pct(r.probability)})` : ''}`,
    });
    addItem({ id: acId(k), section: 'acceptance', text, source: L({ ja: `KPI「${kpiName(k)}」の目標`, en: `Target of KPI "${kpiName(k)}"` }), verification: L({ ja: `${k.deadline} の KPI 実績と目標の比較`, en: `compare the KPI actual with the target at ${k.deadline}` }) });
    return `${acId(k)}: ${text}`;
  });
  const useCaseLines = ucs.flatMap((u) => {
    addItem({ id: frId(u), section: 'functionalReq', text: loc(u.name, lang), source: L({ ja: `ユースケース「${loc(u.name, lang)}」`, en: `Use case "${loc(u.name, lang)}"` }), verification: L({ ja: 'ユースケースの手順を通しで実行して確かめる', en: 'run the use case steps end to end' }) });
    return [`${frId(u)}: ${loc(u.name, lang)}`, ...u.steps.map((st, n) => `  ${n + 1}. ${loc(st.title, lang)}`)];
  });
  const kindLabel = (k: EvidenceKind) => translate(lang, `sol.ev.kind.${k}` as MessageKey);
  const voiceLines = evidence.filter((e) => isVoiceKind(e.kind)).map((e) => {
    const stat = [e.count !== undefined ? L({ ja: `${e.count} 件`, en: `${e.count} cases` }) : '', e.severity !== undefined ? L({ ja: `重大度 ${e.severity}/5`, en: `severity ${e.severity}/5` }) : ''].filter(Boolean).join(sep);
    const text = L({ ja: `${kindLabel(e.kind)}「${e.title}」${e.summary ? `: ${e.summary}` : ''}${stat ? `（${stat}）` : ''} — 要求として扱うか判断する`, en: `${kindLabel(e.kind)} "${e.title}"${e.summary ? `: ${e.summary}` : ''}${stat ? ` (${stat})` : ''} — decide whether to treat it as a requirement` });
    addItem({ id: reqId('VC', e.id), section: 'functionalReq', text, source: from(e) || kindLabel(e.kind), verification: L({ ja: '要求にした場合は、同じ声が減ったかを確かめる', en: 'if adopted, check that the same voice decreases' }) });
    return `${reqId('VC', e.id)}: ${text}`;
  });

  const hasDigit = (text: string) => /\d/.test(text);
  const covered = new Set<string>();
  const nfrLines: string[] = [];
  for (const e of evidence.filter((x) => isRuleKind(x.kind))) {
    const cats = NFR_CATEGORIES.filter((cat) => cat.kinds.includes(e.kind) && (!cat.numeric || hasDigit(e.summary)));
    if (!cats.length) continue;
    cats.forEach((cat) => covered.add(cat.id));
    const text = `[${cats.map((cat) => L(cat.label)).join('/')}] ${e.title}${e.summary ? `: ${e.summary}` : ''}${from(e) ? `（${from(e)}）` : ''}`;
    addItem({ id: reqId('NFR', e.id), section: 'nonFunctionalReq', text, source: from(e) || kindLabel(e.kind), verification: L({ ja: '性能・運用の試験または規程への適合確認', en: 'performance or operations test, or a conformance check against the rule' }) });
    nfrLines.push(`${reqId('NFR', e.id)}: ${text}`);
  }
  for (const sys of systems) {
    covered.add('migration');
    const text = L({ ja: `[移行・連携] 現行システム「${sys}」との連携・移行（方式・期間・データ量を決める）`, en: `[Migration and integration] integrate with or migrate from the current system "${sys}" (decide method, period and data volume)` });
    addItem({ id: `NFR-mig-${slug(sys)}`, section: 'nonFunctionalReq', text, source: L({ ja: '現行システム構成（architecture.asIs）', en: 'Current systems (architecture.asIs)' }), verification: L({ ja: '移行・連携の試験', en: 'migration and integration test' }) });
    nfrLines.push(`NFR-mig-${slug(sys)}: ${text}`);
  }
  const uncovered = NFR_CATEGORIES.filter((cat) => !covered.has(cat.id));
  const nonFunctionalReq = [
    bullets(nfrLines),
    uncovered.length ? bullets([fill({ ja: `${uncovered.map((cat) => cat.label.ja).join('・')}の要求（数値で）`, en: `${uncovered.map((cat) => cat.label.en).join(', ')} requirements (with numbers)` })]) : '',
  ].filter(Boolean).join('\n');

  const relevant = relevantCatalog(s, ucs, c, lang);
  const attrText = (it: CatalogItem) => DATA_ATTRS.filter((a) => it[a.key]).map((a) => `${L(a.label)}: ${it[a.key]}`);
  const dataLines = relevant.map((it) => {
    const id = reqId('DR', it.id ?? slug(it.name));
    const attrs = attrText(it);
    const text = `${it.name}${it.description ? `（${it.description}）` : ''}${attrs.length ? ` — ${attrs.join(sep)}` : ''}`;
    addItem({ id, section: 'dataReq', text, source: L({ ja: 'データ辞書（dataCatalog）', en: 'Data dictionary (dataCatalog)' }), verification: L({ ja: 'データの取得・品質・権利の確認', en: 'check that the data can be obtained, its quality and its rights' }) });
    return `${id}: ${text}`;
  });
  const integrationLines = systems.map((sys) => {
    const text = L({ ja: `現行システム「${sys}」と連携し、または置き換える`, en: `integrate with or replace the current system "${sys}"` });
    addItem({ id: `IF-${slug(sys)}`, section: 'dataReq', text, source: L({ ja: '現行システム構成（architecture.asIs）', en: 'Current systems (architecture.asIs)' }), verification: L({ ja: '連携試験', en: 'integration test' }) });
    return `IF-${slug(sys)}: ${text}`;
  });
  const rules = evidence.filter((e) => ['law', 'standard', 'policy', 'aiPolicy'].includes(e.kind));
  const ruleLines = rules.map((e) => {
    const text = L({ ja: `${kindLabel(e.kind)}「${e.title}」に従う${e.summary ? `（${e.summary}）` : ''}${from(e) ? `。${from(e)}` : ''}`, en: `Comply with ${kindLabel(e.kind)} "${e.title}"${e.summary ? ` (${e.summary})` : ''}${from(e) ? `. ${from(e)}` : ''}` });
    addItem({ id: reqId('CN', e.id), section: 'constraints', text, source: from(e) || kindLabel(e.kind), verification: L({ ja: '規程への適合レビュー（法務・監査）', en: 'conformance review (legal, audit)' }) });
    return `${reqId('CN', e.id)}: ${text}`;
  });
  const evalLines = evidence.filter((e) => e.kind === 'evalData').map((e) => {
    const labels = e.data?.labels ? Object.entries(e.data.labels).map(([k, v]) => `${k} ${v}`).join(sep) : '';
    return L({
      ja: `評価データ「${e.title}」${e.data ? `: ${e.data.rows} 件、列 ${e.data.columns.slice(0, 8).join(sep) || '—'}${labels ? `、ラベル分布 ${labels}` : ''}` : ''}${from(e) ? `。${from(e)}` : ''}`,
      en: `Evaluation data "${e.title}"${e.data ? `: ${e.data.rows} rows, columns ${e.data.columns.slice(0, 8).join(sep) || '—'}${labels ? `, label distribution ${labels}` : ''}` : ''}${from(e) ? `. ${from(e)}` : ''}`,
    });
  });
  const fillAll = (list: Bi[]) => bullets(list.map(fill));
  const dataSupply = relevant.length
    ? bullets(relevant.map((it) => {
      const missing = DATA_ATTRS.filter((a) => !it[a.key]).map((a) => L(a.label));
      return `${it.name}: ${attrText(it).join(sep) || '—'}${missing.length ? ` ${fill({ ja: `不足: ${missing.join(sep)}`, en: `missing: ${missing.join(', ')}` })}` : ''}`;
    }))
    : bullets([fill({ ja: '利用するデータごとの出所・所有者・利用条件・個人情報・品質・更新頻度・保存と削除（データ辞書に登録すると、ここに出ます）', en: 'for each dataset: provenance, owner, terms of use, personal data, quality, update frequency, retention (register it in the data dictionary and it appears here)' })]);
  const monitoring = bullets([
    doc('kpi', 'dataSource') ? L({ ja: `測定元: ${doc('kpi', 'dataSource')}`, en: `Measured from: ${doc('kpi', 'dataSource')}` }) : '',
    doc('kpi', 'frequency') ? L({ ja: `確認の頻度: ${doc('kpi', 'frequency')}`, en: `Frequency: ${doc('kpi', 'frequency')}` }) : '',
    doc('kpi', 'owner') ? L({ ja: `確認の責任者: ${doc('kpi', 'owner')}`, en: `Owner: ${doc('kpi', 'owner')}` }) : '',
    fill({ ja: 'AI の出力品質・入力データの分布変化の監視、再評価と停止の条件', en: 'monitoring of output quality and input drift, and the conditions to re-evaluate or stop' }),
  ]);
  const aiStakeholders = ts.type === 'digital' ? [] : [
    fill({ ja: 'AI の出力を使う人・確認する人、データの管理者、事故時の対応者', en: 'who uses and who checks the AI output, who manages the data, who responds to an incident' }),
    fill({ ja: '法務・セキュリティ・監査の確認者', en: 'legal, security and audit reviewers' }),
  ];

  const gen: Record<string, string> = {
    purpose: [
      loc(s.description, lang),
      chain.length ? bullets(chain) : fill({ ja: '会社目標と OKR・KPI へのつながり', en: 'the link to company objectives, OKRs and KPIs' }),
    ].filter(Boolean).join('\n\n'),
    scope: bullets([
      ...issues.map((i) => L({ ja: `対象の課題: ${name(i)}`, en: `Issue addressed: ${name(i)}` })),
      doc('asis', 'scopeIn') ? L({ ja: `範囲: ${doc('asis', 'scopeIn')}`, en: `In scope: ${doc('asis', 'scopeIn')}` }) : '',
      doc('asis', 'scopeOut') ? L({ ja: `対象外: ${doc('asis', 'scopeOut')}`, en: `Out of scope: ${doc('asis', 'scopeOut')}` }) : fill({ ja: '対象外とすること', en: 'what is out of scope' }),
    ]),
    stakeholders: bullets([
      kpiOwners.length ? L({ ja: `効果の責任者（KPI オーナー）: ${kpiOwners.join(sep)}`, en: `Benefit owners (KPI owners): ${kpiOwners.join(sep)}` }) : fill({ ja: '効果の責任者', en: 'benefit owner' }),
      people.length ? L({ ja: `実行責任者: ${people.join(sep)}`, en: `Delivery owners: ${people.join(sep)}` }) : '',
      personas.length ? L({ ja: `利用者: ${personas.join(sep)}`, en: `Users: ${personas.join(sep)}` }) : '',
      ...aiStakeholders,
    ]),
    glossary: terms.length
      ? bullets(terms.slice(0, 40).map((g) => `${g.term}: ${g.definition}`))
      : L({ ja: '（用語集がありません。解釈が分かれる言葉を用語集に登録すると、ここに出ます。）', en: '(No glossary. Terms that could be read two ways appear here once they are in the glossary.)' }),
    businessReq: bullets(brLines) || fill({ ja: '業務要求（KPI につなぐ）', en: 'business requirements (link KPIs)' }),
    functionalReq: ucs.length
      ? bullets([...useCaseLines, ...voiceLines])
      : [bullets(voiceLines), bullets([fill({ ja: 'ユースケースを登録すると機能要求になる', en: 'register use cases to derive functional requirements' })])].filter(Boolean).join('\n'),
    nonFunctionalReq,
    dataReq: bullets([
      s.msProducts.length ? L({ ja: `利用する製品: ${s.msProducts.join(', ')}`, en: `Products: ${s.msProducts.join(', ')}` }) : '',
      ...dataLines,
      ...integrationLines,
      doc('solution', 'dataNeeds'),
    ]) || fill({ ja: '必要なデータと連携先', en: 'data and integrations needed' }),
    constraints: bullets([
      L({ ja: `予算: ${fmt.yenCompact(s.costJpy)}`, en: `Budget: ${fmt.yenCompact(s.costJpy)}` }),
      inits.length ? L({ ja: `期間: ${inits[0]!.start}〜${inits.map((i) => i.end).sort().at(-1)}`, en: `Period: ${inits[0]!.start} – ${inits.map((i) => i.end).sort().at(-1)}` }) : '',
      doc('asis', 'constraints'),
      ...ruleLines,
    ]),
    acceptance: bullets(acLines.concat(doc('solution', 'acceptance') ? [doc('solution', 'acceptance')] : [])) || fill({ ja: '受け入れ条件（KPI の目標値）', en: 'acceptance criteria (KPI targets)' }),
    promptElements: bullets(PROMPT_PARTS.map((p) => {
      const known = p.key === 'input' && relevant.length ? relevant.map((it) => it.name).join(sep)
        : p.key === 'limits' && rules.length ? rules.map((e) => e.title).join(sep)
          : p.key === 'criteria' && kpis.length ? kpis.map(acId).join(', ') : '';
      return known ? `${L(p.label)}: ${known}` : fill({ ja: `${p.label.ja}: ${p.hint.ja}`, en: `${p.label.en}: ${p.hint.en}` });
    })),
    promptContext: bullets([...relevant.map((it) => `${it.name}${it.description ? `: ${it.description}` : ''}`)]) || fill({ ja: 'AI に参照させるデータ・文書とその最新性', en: 'the data and documents the AI may use, and how current they are' }),
    copilotPrompt: fill({ ja: 'Microsoft 365 Copilot に貼り付けるプロンプトの全文（役割・添付ファイル名を挙げた入力・制約・出力形式・評価基準・確認事項・根拠）', en: 'the full prompt pasted into Microsoft 365 Copilot (role, input naming the attached files, constraints, output format, evaluation criteria, confirmations, grounds)' }),
    copilotAttachments: attachmentLines(attachmentCandidates(s, ts, c, lang)) || fill({ ja: '添付するファイル（KPI・課題・ユースケース・データ辞書などを登録すると候補が出ます）', en: 'files to attach (candidates appear once KPIs, issues, use cases or a data dictionary exist)' }),
    reviewProcedure: fillAll([
      { ja: '出力を確認する人と手順、確認なしに使ってよい範囲', en: 'who reviews the output, how, and what may be used without review' },
      { ja: '利用してはいけない場面・入力してはいけない情報', en: 'situations and information the prompt must not be used for' },
    ]),
    promptEval: bullets([...evalLines, fill({ ja: '評価基準・評価結果の記録（同じ入力で複数回試した結果を含む）', en: 'evaluation criteria and recorded results (including repeated runs on the same input)' })]),
    promptVersion: fillAll([{ ja: 'プロンプトの版・変更の承認者・評価結果の保存先（変更したら再評価する）', en: 'prompt version, who approves a change, and where results are kept (re-evaluate on change)' }]),
    roleSplit: fillAll(ROLE_SPLIT),
    uncertainty: fillAll(UNCERTAINTY),
    fallback: fillAll(FALLBACKS),
    dataSupply,
    evaluation: bullets([...evalLines, fill({ ja: '評価の指標と許容水準（AI を使わない案との比較を含む）', en: 'metrics and accepted levels (including a comparison with a solution without AI)' })]),
    monitoring,
    logging: fillAll([{ ja: '残す記録（参照した文書・生成時刻・担当者の修正有無）と保存期間・閲覧者', en: 'what is recorded (documents used, time, the person\'s edits), retention and who may read it' }]),
    benefits,
    risks,
    rtm,

    asisTobe: [
      doc('asis', 'currentProcess') ? L({ ja: `現状: ${doc('asis', 'currentProcess')}`, en: `As-is: ${doc('asis', 'currentProcess')}` }) : fill({ ja: '現状の業務', en: 'current process' }),
      doc('tobe', 'toBeProcess') ? L({ ja: `あるべき姿: ${doc('tobe', 'toBeProcess')}`, en: `To-be: ${doc('tobe', 'toBeProcess')}` }) : fill({ ja: 'あるべき業務', en: 'target process' }),
    ].join('\n\n'),
    changes: bullets(contributions.map((x) => `${x.lever || TO_FILL[lang]}: ${num(x.amount.mode)} ${x.leverUnit}`)) || fill({ ja: '変える業務と量', en: 'what changes and by how much' }),
    roles: bullets([...kpiOwners.map((r) => L({ ja: `説明責任: ${r}`, en: `Accountable: ${r}` })), ...people.map((r) => L({ ja: `実行責任: ${r}`, en: `Responsible: ${r}` }))]) || fill({ ja: '役割と責任', en: 'roles and responsibilities' }),
    transition: bullets(inits.map((i) => `${i.start}〜${i.end} ${name(i)}`)) || fill({ ja: '移行の段階と日付', en: 'transition stages and dates' }),
    policyChange: [
      fill({ ja: '変更する制度・規程・評価・組織（現行 → 変更後）', en: 'policies, rules, evaluation or organisation to change (current → new)' }),
      bullets(contributions.map((x) => `${x.lever}: ${num(x.amount.mode)} ${x.leverUnit}`)),
    ].filter(Boolean).join('\n'),
    impact: fill({ ja: '対象者（人数・職種）と、処遇・働き方への影響', en: 'who is affected (headcount, roles) and how pay or work changes' }),
    changeApproach: [
      fill({ ja: '変革の進め方（Kotter の 8 段階）', en: 'how the change is led (Kotter\'s eight steps)' }),
      L({ ja: '危機感の共有 → 推進チーム → ビジョン → 伝達 → 障害の除去 → 短期の成果 → 成果の活用 → 定着', en: 'urgency → guiding coalition → vision → communication → remove obstacles → short-term wins → build on gains → anchor in culture' }),
    ].join('\n'),
    governance: fill({ ja: '承認手続き（取締役会・労使協議・規程改定・届出）と日程', en: 'approvals (board, works council, rule changes, filings) and dates' }),
    investment: bullets([
      L({ ja: `投資額: ${fmt.yenCompact(s.costJpy)}`, en: `Investment: ${fmt.yenCompact(s.costJpy)}` }),
      ...inits.map((i) => `${name(i)} (${i.start}〜${i.end})`),
    ]),
    businessCase: s.annualBenefitJpy > 0
      ? L({ ja: `投資 ${fmt.yenCompact(s.costJpy)}、年間効果 ${fmt.yenCompact(s.annualBenefitJpy)}、単純回収 ${num(s.costJpy / s.annualBenefitJpy)} 年`, en: `Invest ${fmt.yenCompact(s.costJpy)}, annual benefit ${fmt.yenCompact(s.annualBenefitJpy)}, simple payback ${num(s.costJpy / s.annualBenefitJpy)} years` })
      : fill({ ja: '年間効果の金額', en: 'annual benefit in yen' }),
    procurement: fill({ ja: '調達方法（見積り・入札・リース）と日程', en: 'procurement route (quotes, tender, lease) and dates' }),
    sourcingScope: fill({ ja: '外部に任せる範囲と社内に残す範囲', en: 'what is sourced out and what stays in house' }),
    selection: fill({ ja: '選定基準と候補', en: 'selection criteria and candidates' }),
    contract: fill({ ja: '契約形態と SLA（KPI に連動させる）', en: 'contract type and SLA (tied to the KPIs)' }),
  };
  const own = c.strategy.sections[s.id] ?? {};
  const sections: DocSection[] = SECTIONS[ts.deliverable].map((id) => {
    const edited = !!own[id]?.trim();
    const text = edited ? own[id]! : gen[id] ?? fill({ ja: '', en: '' });
    return { id, text, edited, open: hasToFill(text), quality: QUALITY_SECTIONS.has(id) ? checkRequirementText(text, lang) : [] };
  });
  const present = new Set(sections.map((x) => x.id));
  // The sections a person writes for an AI (no generated data behind them) are one requirement each.
  const AI_ITEM: Record<string, Bi> = {
    roleSplit: { ja: '人と AI の役割分担と責任の確認', en: 'review of the split of roles and accountability' },
    uncertainty: { ja: '評価データでの精度・誤り・想定外入力の試験', en: 'tests of accuracy, errors and unexpected input on evaluation data' },
    fallback: { ja: '迷ったとき・想定外のときの振る舞いの試験', en: 'tests of behaviour when unsure or given unexpected input' },
    evaluation: { ja: '評価の実施と結果の記録', en: 'run the evaluation and record the result' },
    monitoring: { ja: '運用後の監視指標の測定と再評価', en: 'measure the monitored indicators and re-evaluate' },
    logging: { ja: '記録が残ることの確認', en: 'check that the record is kept' },
    promptElements: { ja: '同じ入力での複数回の出力の確認', en: 'check the output over repeated runs of the same input' },
  };
  for (const [id, verification] of Object.entries(AI_ITEM)) {
    const sec = sections.find((x) => x.id === id);
    if (sec) addItem({ id: `AI-${id}`, section: id, text: sec.text.split('\n').slice(0, 12).join('\n'), source: L({ ja: 'AI 時代の要求管理ハンドブック', en: 'IPA requirements handbook' }), verification: L(verification) });
  }
  const seen = new Set<string>();
  const docItems = items.filter((i) => present.has(i.section) && !seen.has(i.id) && !!seen.add(i.id));
  return { solutionId: s.id, kind: ts.deliverable, sections, items: docItems, complete: sections.every((x) => !x.open), clean: sections.every((x) => x.quality.length === 0) };
}

export function solutionDocMarkdown(d: SolutionDoc, title: string, lang: Lang): string {
  return [
    `# ${title}`,
    '',
    ...d.sections.flatMap((s, i) => [`## ${i + 1}. ${translate(lang, sectionKey(s.id))}`, '', s.text, '']),
  ].join('\n');
}
