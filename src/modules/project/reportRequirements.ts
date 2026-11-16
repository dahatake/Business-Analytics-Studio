/**
 * FR-321/FR-322: a software requirements definition drafted from an imported decision report alone
 * (extensions.decisionReport) and the user's ratings. Deterministic: the text is quoted from the report and the
 * order comes from the decision support model. What the report leaves open is drafted by logic (reportDrafts.ts)
 * and marked as inferred until the user confirms it; facts that logic cannot supply (baseline values, owners,
 * answers to open questions) are marked to be filled ([TO FILL]). Every item cites its report line.
 */
import type { DecisionReport } from '../../data/extensionSchemas.ts';
import type { Lang } from '../../i18n/core.ts';
import {
  emptyDecisionInputs, GATE_PLACEHOLDER, rankAcceptability, rankIssues, rankOptions, rankQuestions, reportGate, simulateGate,
  type DecisionInputs, type GateInputs,
} from './decisionSupport.ts';
import { buildDrafts, CONFIDENCE_LABEL, effectiveLinks, INFERRED, resolve, type DraftDecision } from './reportDrafts.ts';
import { TO_FILL } from './solutionDocs.ts';

type Bi = Record<Lang, string>;

export const REQ_SECTIONS = ['purpose', 'issues', 'solution', 'requirements', 'scope', 'acceptance', 'assumptions', 'risks', 'open', 'decisions', 'trace'] as const;
export type ReqSection = (typeof REQ_SECTIONS)[number];

const TITLES: Record<ReqSection, Bi> = {
  purpose: { ja: '目的と背景', en: 'Purpose and background' },
  issues: { ja: '解決する課題（優先順位順）', en: 'Problems to solve (by priority)' },
  solution: { ja: '採用する解決策', en: 'Chosen solution' },
  requirements: { ja: '要求（あるべき姿）', en: 'Requirements (to-be)' },
  scope: { ja: '範囲と段階', en: 'Scope and phases' },
  acceptance: { ja: '受入基準（KPI と試行の判定）', en: 'Acceptance criteria (KPIs and trial gate)' },
  assumptions: { ja: '前提', en: 'Assumptions' },
  risks: { ja: 'リスクと対策', en: 'Risks and mitigations' },
  open: { ja: '未決事項（聞く順）', en: 'Open questions (ask in this order)' },
  decisions: { ja: '判断事項と推奨（理由）', en: 'Decisions and recommendations (rationale)' },
  trace: { ja: '追跡表', en: 'Traceability' },
};

export interface ReqItem { id: string; text: string; line: number }
export interface ReqDraft {
  title: string;
  sections: { id: ReqSection; title: string; body: string }[];
  requirements: ReqItem[];
  /** Number of [TO FILL] markers: facts the report and logic cannot supply. */
  toFill: number;
  /** Drafted decisions the user has not confirmed (their recommendation is used, marked as inferred). */
  toConfirm: number;
  decisions: DraftDecision[];
}

const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export function buildReportRequirements(r: DecisionReport, inputs: DecisionInputs = emptyDecisionInputs(), lang: Lang = r.lang): ReqDraft {
  const L = (b: Bi) => b[lang];
  const fill = (b: Bi) => `${TO_FILL[lang]} ${L(b)}`;
  const at = (line: number) => (lang === 'ja' ? `（L${line}）` : ` (L${line})`);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const issueName = (id: string) => `${L({ ja: '課題', en: 'Issue' })} ${issueNo.get(id)}`;

  const { decisions, optionIssues } = buildDrafts(r, inputs, lang);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  /** The effective option of a drafted decision and its text, marked as inferred unless the user chose it. */
  const use = (id: string) => {
    const d = byId.get(id);
    if (!d) return undefined;
    const res = resolve(d, inputs);
    return { ...res, marked: res.origin === 'inferred' ? `${INFERRED[lang]} ${res.option.text}` : res.option.text };
  };
  const inferredTag = L({ ja: '（推定）', en: ' (inferred)' });

  const issues = rankIssues(r, inputs);
  const issueNo = new Map(r.issues.map((i, n) => [i.id, n + 1]));
  const options = rankOptions(r, inputs, issues, effectiveLinks(optionIssues));
  const acc = new Map(rankAcceptability(options, inputs.optionWeights).map((a) => [a.id, a.first]));

  const purpose = [
    `${L({ ja: '出典', en: 'Source' })}: ${r.title}${r.asOf ? ` (${r.asOf})` : ''}`,
    r.target ? `${L({ ja: '対象', en: 'Target' })}: ${r.target}` : fill({ ja: '対象の業務・組織', en: 'target business and organization' }),
    r.positioning ? `${L({ ja: '位置付け', en: 'Positioning' })}: ${r.positioning}` : '',
    L({ ja: `状態: 草案。業務分析レポートから決定的に作成しました。${INFERRED.ja} は論理的に推定した下書きで、段ごとの判断事項で確認すると外れます。承認には人の確認が必要です。`, en: `Status: draft generated deterministically from the business analysis report. ${INFERRED.en} marks drafts inferred by logic; confirming them in each step's decisions removes the mark. Approval requires human review.` }),
  ].filter(Boolean);

  const issueLines = issues.map((row) => {
    const i = r.issues.find((x) => x.id === row.id)!;
    return [
      `${issueName(i.id)}: ${i.title}${at(i.line)} — ${L({ ja: 'スコア', en: 'score' })} ${row.score.toFixed(1)}`,
      `  - ${L({ ja: '根本原因', en: 'Root cause' })}: ${i.rootCause ?? fill({ ja: '根本原因', en: 'root cause' })}`,
      `  - ${L({ ja: '反証条件', en: 'Falsifier' })}: ${i.falsifier ?? use(`falsifier:${i.id}`)?.marked ?? fill({ ja: '反証条件（何が分かればこの課題でないと言えるか）', en: 'falsifier (what would show this is not the problem)' })}`,
    ].join('\n');
  });

  const sol = use('solution');
  const chosenIds = sol ? sol.option.id.split('>') : [];
  const chosen = options.filter((o) => chosenIds.includes(o.id));
  const addressed = [...new Set(chosen.flatMap((o) => o.issues))];
  const addressedInferred = chosen.some((o) => o.inferredIssues);
  const solution = !sol
    ? fill({ ja: '採用する解決策（レポートに選択肢がない）', en: 'chosen solution (the report lists no options)' })
    : [
      `${sol.marked}${at(r.options.find((o) => o.id === chosenIds[0])?.line ?? r.options[0]!.line)} — ${L({ ja: '1 位になる確率', en: 'probability of ranking first' })}: ${chosen.map((o) => `${o.label} ${pct(acc.get(o.id) ?? 0)}`).join(' / ')}`,
      addressed.length
        ? `${L({ ja: '対応する課題', en: 'Addresses' })}: ${addressed.map(issueName).join(', ')}${addressedInferred ? inferredTag : ''}`
        : fill({ ja: '対応する課題', en: 'issues addressed' }),
      L({ ja: '理由は「判断事項と推奨」を参照。', en: 'See "Decisions and recommendations" for the rationale.' }),
      ...options.filter((o) => !chosenIds.includes(o.id)).map((o) => `${L({ ja: '不採用の候補', en: 'Not chosen' })}: ${o.label}. ${o.title}`),
    ].filter(Boolean).join('\n\n');

  const requirements: ReqItem[] = r.gaps.map((g, n) => {
    const id = `REQ-${String(n + 1).padStart(2, '0')}`;
    const u = inputs.gaps[g.id];
    const level = u?.current !== undefined && u.target !== undefined ? ` [${L({ ja: '成熟度', en: 'maturity' })} ${u.current} → ${u.target}]` : '';
    return { id, line: g.line, text: `${g.area}: ${g.toBe ?? fill({ ja: 'あるべき姿', en: 'to-be state' })}${level}` };
  });
  const reqBody = requirements.length
    ? requirements.map((q, n) => {
      const g = r.gaps[n]!;
      const type = use(`reqType:${g.id}`);
      return [
        `${q.id}: ${q.text}${at(q.line)}`,
        type ? `  - ${L({ ja: '種類', en: 'Type' })}: ${type.marked}` : '',
        g.asIs ? `  - ${L({ ja: '現状', en: 'As-is' })}: ${g.asIs}` : '',
        g.action ? `  - ${L({ ja: '施策', en: 'Action' })}: ${g.action}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n')
    : fill({ ja: '要求（レポートにギャップ分析がない）', en: 'requirements (the report has no gap analysis)' });

  const scope = r.roadmap.length
    ? r.roadmap.map((p) => [`${p.title}${at(p.line)}`, ...(['actions', 'deliverables', 'owners'] as const).map((f) => (p[f] ? `  - ${L({ ja: { actions: '施策', deliverables: '成果物', owners: '責任者' }[f], en: { actions: 'Actions', deliverables: 'Deliverables', owners: 'Owners' }[f] })}: ${p[f]}` : ''))].filter(Boolean).join('\n')).join('\n')
    : fill({ ja: '範囲と段階', en: 'scope and phases' });

  const baseline = (id: string) => {
    const s = inputs.kpiBaseline[id];
    if (s === 'measured') return L({ ja: '基準値は測定済み', en: 'baseline measured' });
    const how = use(`baseline:${id}`);
    const value = s === 'partial' ? fill({ ja: '基準値の測定（一部のみ）', en: 'baseline measurement (partial)' }) : fill({ ja: '基準値', en: 'baseline value' });
    return how ? `${value}（${L({ ja: '測り方', en: 'method' })}: ${how.marked}）` : value;
  };
  const gate = reportGate(r);
  const g: GateInputs = { gate: gate ?? 0.2, ...GATE_PLACEHOLDER, ...inputs.gate, effect: { ...GATE_PLACEHOLDER.effect, ...inputs.gate.effect } };
  const sim = inputs.gate.effect ? simulateGate(g, { runs: 1000 }) : null;
  const size = use('sampleSize');
  const acceptance = [
    ...r.kpis.map((k) => `${k.name}${at(k.line)}: ${k.definition ?? fill({ ja: '定義', en: 'definition' })} — ${baseline(k.id)}`),
    gate !== null
      ? `${L({ ja: '試行の合格基準', en: 'Trial gate' })}: ${pct(gate)} (${L({ ja: 'レポート', en: 'report' })})`
      : fill({ ja: '試行の合格基準', en: 'trial pass criterion' }),
    sim
      ? `${L({ ja: '判定の確からしさ（段 3 の入力）', en: 'Decision accuracy (step 3 inputs)' })}: ${pct(sim.correct)} (n=${g.n})`
      : fill({ ja: '効果の見積もり（段 3 で試行の判定を確かめる）', en: 'effect estimate (check the trial gate in step 3)' }),
    size ? `${L({ ja: '試行の件数', en: 'Trial size' })}: ${size.marked}` : '',
  ].filter(Boolean);

  const risks = r.risks.map((x) => {
    const u = inputs.risks[x.id];
    const rated = u?.likelihood !== undefined && u.impact !== undefined ? ` [${u.likelihood} × ${u.impact}]` : '';
    return `${x.name}${rated}${at(x.line)}: ${x.mitigation ?? fill({ ja: '対策', en: 'mitigation' })}`;
  });

  const open = rankQuestions(r, inputs).map((q) => `${TO_FILL[lang]} ${q.text}${at(r.openQuestions.find((x) => x.id === q.id)!.line)}`);

  const decisionLines = decisions.map((d) => {
    const res = resolve(d, inputs);
    const rec = d.options.find((o) => o.id === d.recommended)!;
    const status = res.origin === 'inferred'
      ? L({ ja: `${INFERRED.ja} 推奨を仮に採用（未確認）`, en: `${INFERRED.en} recommendation applied (unconfirmed)` })
      : res.option.id === d.recommended
        ? L({ ja: '推奨を確認済み', en: 'recommendation confirmed' })
        : L({ ja: `推奨（${rec.label}）と異なる選択`, en: `chose differently from the recommendation (${rec.label})` });
    return [
      `${d.subject}${at(d.line)}: ${res.option.label} — ${status}, ${L({ ja: '確度', en: 'confidence' })} ${L(CONFIDENCE_LABEL[d.confidence])}`,
      ...d.reasons.map((x) => `  - ${x}`),
      `  - ${L({ ja: '見直す条件', en: 'Revisit if' })}: ${d.flip}`,
    ].join('\n');
  });

  const reqIssues = (gapId: string) => {
    const x = use(`reqIssue:${gapId}`);
    if (!x?.option.ids?.length) return '—';
    return `${x.option.ids.map((id) => `I${issueNo.get(id)}`).join(', ')}${x.origin === 'inferred' ? inferredTag : ''}`;
  };
  const kpiReqs = (kpiId: string) => {
    const x = use(`kpiReq:${kpiId}`);
    if (!x?.option.ids?.length) return '—';
    return `${x.option.ids.join(', ')}${x.origin === 'inferred' ? inferredTag : ''}`;
  };
  const head = `| ID | ${L({ ja: '種類', en: 'Kind' })} | ${L({ ja: '内容', en: 'Item' })} | ${L({ ja: '関連', en: 'Related' })} | ${L({ ja: 'レポートの行', en: 'Report line' })} |\n|---|---|---|---|---|`;
  const rows = [
    ...r.issues.map((i) => [`I${issueNo.get(i.id)}`, L({ ja: '課題', en: 'Issue' }), i.title, options.filter((o) => o.issues.includes(i.id)).map((o) => `${o.label}${o.inferredIssues ? inferredTag : ''}`).join(', ') || '—', i.line]),
    ...options.map((o) => [o.label, L({ ja: '解決策', en: 'Solution' }), o.title, o.issues.length ? `${o.issues.map((id) => `I${issueNo.get(id)}`).join(', ')}${o.inferredIssues ? inferredTag : ''}` : '—', r.options.find((x) => x.id === o.id)!.line]),
    ...requirements.map((q, n) => [q.id, L({ ja: '要求', en: 'Requirement' }), q.text, reqIssues(r.gaps[n]!.id), q.line]),
    ...r.kpis.map((k, n) => [`K${n + 1}`, 'KPI', k.name, kpiReqs(k.id), k.line]),
  ].map((c) => `| ${c.map((x) => cell(String(x))).join(' | ')} |`);
  const traceNote = decisions.some((d) => /^(optionIssue|reqIssue|kpiReq):/.test(d.id))
    ? L({ ja: '「（推定）」の関連は、レポート本文に共通する語から推定した結び付けです（解決策 → 課題、要求 → 課題、KPI → 要求）。段 4・段 5 の判断事項で確認してください。', en: '"(inferred)" links are drafted from terms shared in the report text (solution → issue, requirement → issue, KPI → requirement). Confirm them in the step 4 and step 5 decisions.' })
    : '';

  const bodies: Record<ReqSection, string> = {
    purpose: purpose.join('\n\n'),
    issues: issueLines.length ? issueLines.join('\n') : fill({ ja: '課題', en: 'problems' }),
    solution,
    requirements: reqBody,
    scope,
    acceptance: bullets(acceptance),
    assumptions: r.assumptions.length ? bullets(r.assumptions.map((a) => `${a.text}${at(a.line)}`)) : fill({ ja: '前提', en: 'assumptions' }),
    risks: risks.length ? bullets(risks) : fill({ ja: 'リスク', en: 'risks' }),
    open: open.length ? bullets(open) : L({ ja: '未決事項はありません。', en: 'No open questions.' }),
    decisions: decisionLines.length ? decisionLines.map((x) => `- ${x}`).join('\n') : L({ ja: '判断事項はありません。', en: 'No decisions to make.' }),
    trace: [[head, ...rows].join('\n'), traceNote].filter(Boolean).join('\n\n'),
  };
  const sections = REQ_SECTIONS.map((id) => ({ id, title: L(TITLES[id]), body: bodies[id] }));
  const markdown = sections.map((s) => s.body).join('\n');
  return {
    title: `${r.title} — ${L({ ja: 'ソフトウェア要求定義書（草案）', en: 'Software requirements definition (draft)' })}`,
    sections,
    requirements,
    toFill: markdown.split(TO_FILL[lang]).length - 1,
    toConfirm: decisions.filter((d) => resolve(d, inputs).origin === 'inferred').length,
    decisions,
  };
}

export function reportRequirementsMarkdown(d: ReqDraft): string {
  return [`# ${d.title}`, ...d.sections.map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.body}`)].join('\n\n') + '\n';
}
