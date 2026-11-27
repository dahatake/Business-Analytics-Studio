import { runAgentLoop, type LoopAnswer, type LoopStop } from '../../ai/agentLoop.ts';
import { aiComplete, aiLive, registerMock, type AiRequest } from '../../ai/client.ts';
import { DELIVERABLE_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import type { Entity, EntityOf } from '../../data/schema.ts';
import type { Lang } from '../../i18n/core.ts';
import { createScopedStore } from '../../state/projects.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { computeAnalysis } from './analysis.ts';
import {
  ISSUE_CONTROLS, ISSUE_FRAMES, setCrux, setFraming, setSituation, SITUATIONS,
  type CheckContext, type CruxJudgment, type DeliverableData, type IssueControl, type IssueFrame, type IssueFraming, type Situation,
} from './deliverables.ts';
import { isProvisionalRating, kpiTrend, projectTriage, SITUATION_CYCLE_MONTHS, type Growth, type Triage } from './issueTriage.ts';

/**
 * FR-385: the issue diagnosis a partner makes before ranking, as data a person confirms.
 *
 * - Business situation (Watkins, "Picking the Right Transition Strategy", HBR 2009: start-up, turnaround, accelerated growth,
 *   realignment, sustaining success). Once confirmed it sets the planning cycle of the urgency (PARAM-220).
 * - Crux (Rumelt 2011 / 2022): the one point that is both the most important and surmountable. BAS computes the causes shared by
 *   two or more issues kept for action; Copilot proposes the crux among them (or a hypothesis); it orders the triage.
 * - Per issue: the decision question (Minto's situation → complication → question), the role that decides, the day-one hypothesis
 *   and what would falsify it, threat or opportunity and how far it is controllable (Jackson and Dutton 1988; Thomas et al. 1993).
 *
 * Copilot always drafts every part: what an answer leaves out is asked for again on its own (D-51), and what is still open is a
 * labelled BAS placeholder ("rule"), never silently filled. Nothing is confirmed until a person approves; a person's own judgment
 * is never overwritten by approving a draft. No personal name is sent; the owner must be a role.
 */

export const DIAGNOSIS_MARK = '[bas-proj:diagnosis]';
export type DraftOrigin = 'ai' | 'rule';
export type DiagnosisPart = 'situation' | 'crux' | `issue:${string}`;

export interface SharedCause {
  causeId: string;
  issueIds: string[];
  /** Sum of the impact ratings of the issues it explains. */
  impactSum: number;
  /** Issues among them that Ansoff's table says to respond to now. */
  pressing: number;
  sourced: boolean;
}

export interface IssueEvidence {
  id: string;
  impact: number;
  feasibility: number;
  provisional: boolean;
  disposition: Triage['issues'][number]['disposition'];
  urgency: Triage['issues'][number]['urgency'];
  growth: Growth;
  causeIds: string[];
  kpiIds: string[];
  sourceCount: number;
}

export interface KpiTrendRow { id: string; trend: Growth }

export interface DiagnosisEvidence {
  triage: Triage;
  issues: IssueEvidence[];
  kpis: KpiTrendRow[];
  trendCounts: Record<Growth, number>;
  /** The SWOT position of the first SWOT analysis with items (analysis.ts), or null. */
  swot: { analysisId: string; strategy: 'aggressive' | 'diversify' | 'turnaround' | 'defensive' } | null;
  shared: SharedCause[];
}

const kindOf = <K extends Entity['kind']>(ctx: CheckContext, kind: K) => [...ctx.pack.byId.values()].filter((e): e is EntityOf<K> => e.kind === kind);

/** The data a person needs to judge the situation, the crux and each issue (the issues kept for action, visible to the audience). */
export function diagnosisEvidence(ctx: CheckContext, audience: 'internal' | 'external' = 'internal'): DiagnosisEvidence {
  const triage = projectTriage(ctx);
  const visible = (id: string) => { const e = ctx.pack.byId.get(id); return !!e && !isHidden(e, audience); };
  const issues: IssueEvidence[] = triage.issues.filter((i) => i.inAction && visible(i.id)).map((i) => {
    const e = ctx.pack.byId.get(i.id) as EntityOf<'issue'>;
    return {
      id: i.id, impact: i.impact, feasibility: i.feasibility, provisional: isProvisionalRating(e.description), disposition: i.disposition,
      urgency: i.urgency, growth: i.growth,
      causeIds: e.causeIds.filter((c) => ctx.pack.byId.get(c)?.kind === 'cause' && visible(c)),
      kpiIds: e.kpiIds.filter((k) => ctx.pack.byId.get(k)?.kind === 'kpi' && visible(k)),
      sourceCount: e.sourceIds.filter((s) => ctx.pack.byId.get(s)?.kind === 'source').length,
    };
  });
  const kpis = kindOf(ctx, 'kpi').filter((k) => visible(k.id)).map((k) => ({ id: k.id, trend: kpiTrend(k) }));
  const trendCounts: Record<Growth, number> = { worsening: 0, flat: 0, improving: 0, unknown: 0 };
  for (const k of kpis) trendCounts[k.trend] += 1;
  const swotAnalysis = ctx.analysis.analyses.find((a) => a.method === 'swot' && a.items.length > 0);
  const insight = swotAnalysis ? computeAnalysis(swotAnalysis).insight : null;
  const pressing = new Set(triage.issues.filter((i) => i.disposition === 'act').map((i) => i.id));
  const byCause = new Map<string, string[]>();
  for (const i of issues) for (const c of i.causeIds) byCause.set(c, [...(byCause.get(c) ?? []), i.id]);
  const impactOf = new Map(issues.map((i) => [i.id, i.impact]));
  const shared = [...byCause.entries()].filter(([, ids]) => ids.length >= 2).map(([causeId, issueIds]) => ({
    causeId, issueIds,
    impactSum: issueIds.reduce((n, id) => n + (impactOf.get(id) ?? 0), 0),
    pressing: issueIds.filter((id) => pressing.has(id)).length,
    sourced: ((ctx.pack.byId.get(causeId) as EntityOf<'cause'>).sourceIds ?? []).some((s) => ctx.pack.byId.get(s)?.kind === 'source'),
  })).sort((a, b) => b.pressing - a.pressing || b.impactSum - a.impactSum || b.issueIds.length - a.issueIds.length || a.causeId.localeCompare(b.causeId));
  return {
    triage, issues, kpis, trendCounts, shared,
    swot: swotAnalysis && insight?.kind === 'swot' ? { analysisId: swotAnalysis.id, strategy: insight.strategy } : null,
  };
}

/** Cross-checks between judgments and data, shown next to the judgment (a person decides; nothing is changed). */
export type FramingWarning = 'controlVsFeasibility' | 'opportunityWorsening' | 'provisionalRating';
export function framingWarnings(f: Pick<IssueFraming, 'frame' | 'control'>, i: Pick<IssueEvidence, 'feasibility' | 'growth' | 'provisional'>): FramingWarning[] {
  const out: FramingWarning[] = [];
  if ((f.control === 'none' && i.feasibility >= 4) || (f.control === 'full' && i.feasibility <= 2)) out.push('controlVsFeasibility');
  if (f.frame === 'opportunity' && i.growth === 'worsening') out.push('opportunityWorsening');
  if (i.provisional) out.push('provisionalRating');
  return out;
}

/* ---------- What Copilot sees ---------- */

interface ContextKpi { name: string; unit: string; baseline: number; current: number; target: number; direction: string; trend: Growth; ownerRole?: string }
interface ContextIssue {
  id: string; name: string; description: string; impact: number; feasibility: number; provisional: boolean;
  disposition: string; urgency: string | null; growth: Growth; causes: { id: string; name: string }[]; kpis: ContextKpi[]; sources: number;
}
export interface DiagnosisContext {
  lang: Lang;
  company: { name: string; industry: string };
  situations: readonly Situation[];
  kpiTrend: Record<Growth, number>;
  swot: string | null;
  triage: { act: number; plan: number; unassessed: number; setAside: number };
  sharedCauses: { id: string; name: string; issueIds: string[]; impactSum: number }[];
  issues: ContextIssue[];
}

export function diagnosisContext(ctx: CheckContext, lang: Lang, audience: 'internal' | 'external' = 'internal'): DiagnosisContext {
  const ev = diagnosisEvidence(ctx, audience);
  const name = (id: string) => loc(ctx.pack.byId.get(id)!.name, lang);
  const issues = ev.issues.map((i): ContextIssue => {
    const e = ctx.pack.byId.get(i.id) as EntityOf<'issue'>;
    return {
      id: i.id, name: name(i.id), description: loc(e.description, lang), impact: i.impact, feasibility: i.feasibility, provisional: i.provisional,
      disposition: i.disposition, urgency: i.urgency, growth: i.growth,
      causes: i.causeIds.map((id) => ({ id, name: name(id) })),
      kpis: i.kpiIds.map((id) => {
        const k = ctx.pack.byId.get(id) as EntityOf<'kpi'>;
        return {
          name: name(id), unit: loc(k.unit, lang), baseline: k.baseline, current: k.current, target: k.target, direction: k.direction, trend: kpiTrend(k),
          ...(k.ownerRole ? { ownerRole: loc(k.ownerRole, lang) } : {}),
        };
      }),
      sources: i.sourceCount,
    };
  });
  return {
    lang,
    company: { name: loc(ctx.pack.pack.company.name, lang), industry: loc(ctx.pack.pack.company.industry, lang) },
    situations: SITUATIONS, kpiTrend: ev.trendCounts, swot: ev.swot?.strategy ?? null,
    triage: { act: ev.triage.counts.act, plan: ev.triage.counts.plan, unassessed: ev.triage.counts.unassessed, setAside: ev.triage.gated.length },
    sharedCauses: ev.shared.map((s) => ({ id: s.causeId, name: name(s.causeId), issueIds: s.issueIds, impactSum: s.impactSum })),
    issues,
  };
}

const SITUATION_TEXT: Record<Situation, { ja: string; en: string }> = {
  startUp: { ja: '新しい事業・製品・組織を立ち上げる（資源と体制を組み立てる）', en: 'launching a new business, product or unit (assembling resources and capabilities)' },
  turnaround: { ja: '深刻な問題を抱えた事業を立て直す（すばやく手を打つ）', en: 'rescuing a business in serious trouble (acting fast)' },
  acceleratedGrowth: { ja: '伸びている事業を拡大する（仕組みと人を拡張する）', en: 'expanding a growing business (scaling structures and people)' },
  realignment: { ja: '問題に向かいつつあるのに組織が認識していない事業を立て直す（変える必要を納得させる）', en: 'revitalising a business drifting into trouble that people do not see (making the case for change)' },
  sustainingSuccess: { ja: '成功している事業の活力を保ち、次の段階へ進める', en: 'preserving the vitality of a successful business and taking it to the next level' },
};

export function diagnosisPrompt(c: DiagnosisContext, only?: readonly string[]): string {
  const ja = c.lang === 'ja';
  const situations = SITUATIONS.map((s) => `- ${s}: ${SITUATION_TEXT[s][c.lang]} (${ja ? '計画周期' : 'planning cycle'} ${SITUATION_CYCLE_MONTHS[s]} ${ja ? 'か月' : 'months'})`).join('\n');
  const lines = ja ? [
    DIAGNOSIS_MARK,
    'あなたは戦略コンサルティングのパートナーです。順位をつける前の課題の診断を、CONTEXT だけを根拠に下書きします。人が確認して確定します。',
    '次の形の JSON オブジェクト 1 つだけで答える（説明文・コードブロックなし）:',
    '{"situation":{"type":"<下の 5 つのどれか>","reason":"根拠（CONTEXT の KPI の推移・SWOT・区分を引用）"},',
    ' "crux":{"causeId":"<CONTEXT の原因の id。新しい仮説なら null>","name":"核心（短い名前）","issueIds":["<CONTEXT の課題 id>"],"reason":"なぜ最も重要か","addressable":"なぜ克服できるか"},',
    ' "issues":{"<課題 id>":{"question":"答えるべき意思決定の問い（？で終わる）","owner":"決める人の役職","hypothesis":"初期仮説（問いへの暫定の答え）","falsifier":"仮説が誤りだと分かる証拠","frame":"threat か opportunity","control":"full・partial・none のどれか","reason":"frame と control の根拠"}}}',
    '事業の状況（Watkins 2009 の STARS）:', situations,
    'crux（Rumelt）: 最も大きな前進をもたらし、かつ克服できる 1 点。sharedCauses（2 件以上の課題に共通する原因）を優先して検討する。',
    'frame（Jackson & Dutton 1988）: threat = 損失が見込まれ自社の制御が弱い、opportunity = 利得が見込まれ自社が制御できる。control は自社の権限と手段で動かせる度合い。',
    '規則: CONTEXT の issues のすべての id に issues の項目を書く。owner は役職で、人名を書かない。CONTEXT にない数値・固有名を作らない。推測は仮説と書く。日本語で書く。',
  ] : [
    DIAGNOSIS_MARK,
    'You are a strategy consulting partner. Draft the diagnosis of the issues before they are ranked, using only CONTEXT. A person reviews and confirms it.',
    'Answer with exactly one JSON object (no prose, no code block):',
    '{"situation":{"type":"<one of the five below>","reason":"evidence (cite KPI trends, SWOT and dispositions from CONTEXT)"},',
    ' "crux":{"causeId":"<a cause id from CONTEXT, or null for a new hypothesis>","name":"the crux (short name)","issueIds":["<issue ids from CONTEXT>"],"reason":"why it matters most","addressable":"why it can be overcome"},',
    ' "issues":{"<issue id>":{"question":"the decision question to answer (ending with ?)","owner":"the deciding role","hypothesis":"day-one answer to the question","falsifier":"evidence that would show the hypothesis wrong","frame":"threat or opportunity","control":"full, partial or none","reason":"why this frame and control"}}}',
    'Business situations (Watkins 2009, STARS):', situations,
    'Crux (Rumelt): the one point that promises the greatest progress and can be overcome. Consider sharedCauses (causes shared by two or more issues) first.',
    'Frame (Jackson & Dutton 1988): threat = loss expected and little control; opportunity = gain expected and control. control is how far the company\'s own authority and means can move it.',
    'Rules: write an issues entry for every issue id in CONTEXT. owner is a role, never a personal name. Do not invent numbers or names absent from CONTEXT; mark guesses as hypotheses. Write in English.',
  ];
  if (only?.length) lines.push(ja
    ? `REPAIR: 他の部分は受け付け済み。同じ形の JSON で、次の部分だけを完全に書く: ${only.join(', ')}（issue:<id> は issues のその id）`
    : `REPAIR: the other parts are accepted. Answer with the same JSON shape holding only these parts, each complete: ${only.join(', ')} (issue:<id> is that id under issues)`);
  lines.push(`CONTEXT: ${JSON.stringify(c)}`);
  return lines.join('\n');
}

export function diagnosisRequest(c: DiagnosisContext, scope?: string): AiRequest {
  return { use: 'deliverableDraft', lang: c.lang, prompt: diagnosisPrompt(c), sendEntityContext: false, timeoutMs: DELIVERABLE_DRAFT_TIMEOUT_MS, ...(scope ? { scope } : {}) };
}

/* ---------- Checking an answer ---------- */

export interface DraftSituation { type: Situation; reason: string; origin: DraftOrigin }
export interface DraftCrux { causeId?: string; name: string; issueIds: string[]; reason: string; addressable: string; origin: DraftOrigin }
export interface DraftFraming { question: string; owner: string; hypothesis: string; falsifier: string; frame: IssueFrame; control: IssueControl; reason: string; origin: DraftOrigin }
export interface DiagnosisDraft {
  situation: DraftSituation;
  crux: DraftCrux;
  issues: Record<string, DraftFraming>;
}

function parseJson(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  for (const s of [t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    try {
      const v = JSON.parse(s) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* try the next form */ }
  }
  return null;
}
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null);
const oneOf = <T extends string>(x: unknown, list: readonly T[]): T | null => (typeof x === 'string' && (list as readonly string[]).includes(x) ? x as T : null);

export interface DiagnosisRules {
  issueIds: ReadonlySet<string>;
  causeIds: ReadonlySet<string>;
  /** Personal names that must not appear as an owner. */
  people: readonly string[];
}

export function diagnosisRules(ctx: CheckContext, c: DiagnosisContext): DiagnosisRules {
  return {
    issueIds: new Set(c.issues.map((i) => i.id)),
    causeIds: new Set(kindOf(ctx, 'cause').map((x) => x.id)),
    people: kindOf(ctx, 'person').flatMap((p) => [p.name.ja, p.name.en]).map((n) => n.trim()).filter((n) => n.length >= 2),
  };
}

/** The parts of `pending` the answer holds in a valid form. */
export function verifyDiagnosis(text: string, pending: readonly string[], rules: DiagnosisRules): Partial<Record<string, DraftSituation | DraftCrux | DraftFraming>> {
  const root = parseJson(text);
  if (!root) return {};
  const out: Partial<Record<string, DraftSituation | DraftCrux | DraftFraming>> = {};
  if (pending.includes('situation')) {
    const s = obj(root.situation);
    const type = oneOf(s?.type, SITUATIONS);
    const reason = str(s?.reason);
    if (type && reason) out.situation = { type, reason, origin: 'ai' };
  }
  if (pending.includes('crux')) {
    const c = obj(root.crux);
    const issueIds = Array.isArray(c?.issueIds) ? [...new Set(c.issueIds.filter((id): id is string => typeof id === 'string' && rules.issueIds.has(id)))] : [];
    const name = str(c?.name);
    const reason = str(c?.reason);
    const addressable = str(c?.addressable);
    const causeId = typeof c?.causeId === 'string' && rules.causeIds.has(c.causeId) ? c.causeId : undefined;
    if (name && reason && addressable && issueIds.length) out.crux = { ...(causeId ? { causeId } : {}), name, issueIds, reason, addressable, origin: 'ai' };
  }
  const issues = obj(root.issues) ?? {};
  for (const unit of pending) {
    if (!unit.startsWith('issue:')) continue;
    const f = obj(issues[unit.slice(6)]);
    const question = str(f?.question);
    const owner = str(f?.owner);
    const hypothesis = str(f?.hypothesis);
    const falsifier = str(f?.falsifier);
    const reason = str(f?.reason);
    const frame = oneOf(f?.frame, ISSUE_FRAMES);
    const control = oneOf(f?.control, ISSUE_CONTROLS);
    const named = owner !== null && rules.people.some((p) => owner.includes(p));
    if (question && /[?？]$/.test(question) && owner && !named && hypothesis && falsifier && reason && frame && control) {
      out[unit] = { question, owner, hypothesis, falsifier, frame, control, reason, origin: 'ai' };
    }
  }
  return out;
}

/* ---------- BAS placeholders (labelled; for what the model left open, and for the mock) ---------- */

const RULE_NOTE = { ja: 'BAS の規則による仮置き（要確認）', en: 'BAS placeholder from a rule (to confirm)' };

export function ruleSituation(c: DiagnosisContext): DraftSituation {
  const ja = c.lang === 'ja';
  const t = c.kpiTrend;
  const trended = t.worsening + t.flat + t.improving;
  const facts = ja
    ? `KPI の推移: 悪化 ${t.worsening}・変化なし ${t.flat}・改善 ${t.improving}。SWOT: ${c.swot ?? 'なし'}。即応 ${c.triage.act} 件。`
    : `KPI trends: ${t.worsening} worsening, ${t.flat} flat, ${t.improving} improving. SWOT: ${c.swot ?? 'none'}. ${c.triage.act} to respond to now.`;
  let type: Situation;
  if (c.issues.length === 0 && trended === 0) type = 'startUp';
  else if (trended === 0) type = 'realignment';
  else if (t.worsening / trended >= 0.5) type = c.swot === 'turnaround' || c.swot === 'defensive' || c.triage.act > 0 ? 'turnaround' : 'realignment';
  else if (t.worsening > 0) type = 'realignment';
  else type = c.swot === 'aggressive' ? 'acceleratedGrowth' : 'sustainingSuccess';
  return { type, reason: `${facts} ${RULE_NOTE[c.lang]}`, origin: 'rule' };
}

export function ruleCrux(c: DiagnosisContext): DraftCrux {
  const ja = c.lang === 'ja';
  const shared = c.sharedCauses[0];
  if (shared) {
    return {
      causeId: shared.id, name: shared.name, issueIds: shared.issueIds,
      reason: ja ? `${shared.issueIds.length} 件の課題に共通し、影響度の合計（${shared.impactSum}）が最も大きい原因。${RULE_NOTE.ja}` : `Shared by ${shared.issueIds.length} issues, with the largest total impact (${shared.impactSum}). ${RULE_NOTE.en}`,
      addressable: ja ? '原因に手を打てば複数の課題が同時に動くため、まず確かめる価値がある（仮説）。' : 'Acting on one cause moves several issues at once, so it is worth checking first (hypothesis).',
      origin: 'rule',
    };
  }
  const top = c.issues[0];
  const cause = top?.causes[0];
  return {
    ...(cause ? { causeId: cause.id } : {}), name: cause?.name ?? top?.name ?? (ja ? '未特定' : 'Not identified'), issueIds: top ? [top.id] : [],
    reason: ja ? `共通する原因がないため、着手順の最初の課題の原因を仮に置いた。${RULE_NOTE.ja}` : `No cause is shared, so the cause of the first issue in the order is a placeholder. ${RULE_NOTE.en}`,
    addressable: ja ? '実現性の評価に基づく（要確認）。' : 'Based on the feasibility rating (to confirm).',
    origin: 'rule',
  };
}

export function ruleFraming(i: ContextIssue, lang: Lang): DraftFraming {
  const ja = lang === 'ja';
  const k = i.kpis[0];
  const goal = k ? (ja ? `${k.name}を${k.target}${k.unit}にする` : `bring ${k.name} to ${k.target} ${k.unit}`) : (ja ? '解決する' : 'solve it');
  const causes = i.causes.map((x) => x.name);
  return {
    question: ja ? `「${i.name}」について、${goal}ために、どの原因から手を打つか？` : `To ${goal}, which cause of "${i.name}" should we act on first?`,
    owner: k?.ownerRole ?? (ja ? '課題の責任者（役職は要確認）' : 'Issue owner (role to be confirmed)'),
    hypothesis: causes.length
      ? (ja ? `真因は「${causes.join('」「')}」で、ここに手を打てば改善する（仮説）。` : `The root cause is ${causes.map((n) => `"${n}"`).join(', ')}; acting on it improves the issue (hypothesis).`)
      : (ja ? '原因は未特定（仮説を立てる必要がある）。' : 'The cause is not identified yet (a hypothesis is needed).'),
    falsifier: k
      ? (ja ? `施策の後も ${k.name} が ${k.current}${k.unit} から改善しない。` : `${k.name} does not improve from ${k.current} ${k.unit} after the action.`)
      : (ja ? '施策の後も課題の状況が変わらない。' : 'The situation does not change after the action.'),
    frame: 'threat',
    control: i.feasibility >= 4 ? 'full' : i.feasibility >= 2 ? 'partial' : 'none',
    reason: ja ? `課題は現状の損失として書かれ、制御の度合いは実現性 ${i.feasibility} から置いた。${RULE_NOTE.ja}` : `The issue is stated as a current loss; control is set from feasibility ${i.feasibility}. ${RULE_NOTE.en}`,
    origin: 'rule',
  };
}

export function ruleDiagnosis(c: DiagnosisContext): DiagnosisDraft {
  return { situation: ruleSituation(c), crux: ruleCrux(c), issues: Object.fromEntries(c.issues.map((i) => [i.id, ruleFraming(i, c.lang)])) };
}

/** The deterministic answer used when no live connection is allowed (labelled mock in the UI) and by tests. */
export function diagnosisMockAnswer(prompt: string): string {
  const at = prompt.indexOf('CONTEXT: ');
  if (at < 0) return '{}';
  try {
    const c = JSON.parse(prompt.slice(at + 'CONTEXT: '.length)) as DiagnosisContext;
    const d = ruleDiagnosis(c);
    return JSON.stringify({ situation: d.situation, crux: d.crux, issues: d.issues });
  } catch {
    return '{}';
  }
}
registerMock('deliverableDraft', (req) => diagnosisMockAnswer(req.prompt), (req) => req.prompt.startsWith(DIAGNOSIS_MARK));

/* ---------- Drafting ---------- */

export interface DiagnosisRun extends DiagnosisDraft {
  /** Parts filled by a BAS placeholder because the model left them open after the repairs. */
  placeholders: string[];
  stop: LoopStop;
  rounds: number;
  mock: boolean;
}

export const diagnosisUnits = (c: DiagnosisContext): string[] => ['situation', 'crux', ...c.issues.map((i) => `issue:${i.id}`)];

/** D-51: ask, keep what passed, ask again only for what is missing; what is still open becomes a labelled placeholder. */
export async function draftDiagnosis(
  c: DiagnosisContext, rules: DiagnosisRules, ask: (prompt: string, round: number) => Promise<LoopAnswer & { mock?: boolean }>, signal?: AbortSignal,
): Promise<DiagnosisRun> {
  let mock = false;
  const loop = await runAgentLoop<DraftSituation | DraftCrux | DraftFraming>({
    units: diagnosisUnits(c),
    maxRounds: 3,
    signal,
    ask: async (pending, round) => {
      const answer = await ask(round === 1 ? diagnosisPrompt(c) : diagnosisPrompt(c, pending), round);
      if (answer.mock) mock = true;
      return answer;
    },
    verify: (answer, pending) => verifyDiagnosis(answer.text, pending, rules) as Record<string, DraftSituation | DraftCrux | DraftFraming>,
  });
  const rule = ruleDiagnosis(c);
  const v = loop.values;
  const asOrigin = <T extends { origin: DraftOrigin }>(x: T): T => (mock ? { ...x, origin: 'rule' } : x);
  return {
    situation: asOrigin((v.situation as DraftSituation | undefined) ?? rule.situation),
    crux: asOrigin((v.crux as DraftCrux | undefined) ?? rule.crux),
    issues: Object.fromEntries(c.issues.map((i) => [i.id, asOrigin((v[`issue:${i.id}`] as DraftFraming | undefined) ?? rule.issues[i.id]!)])),
    placeholders: loop.missing,
    stop: loop.stop,
    rounds: loop.rounds.length,
    mock,
  };
}

/** The all-step batch: live only; a failed first call fails the job, a failed repair keeps what passed and fills the rest by rule. */
export function requestLiveDiagnosis(c: DiagnosisContext, rules: DiagnosisRules, request: AiRequest, signal?: AbortSignal): Promise<DiagnosisRun> {
  return draftDiagnosis(c, rules, (prompt, round) => aiLive({ ...request, prompt, ...(request.stage && round > 1 ? { stage: `${request.stage}:repair${round - 1}` } : {}) }, signal), signal);
}

/** From the panel: live when allowed, otherwise the labelled mock. */
export function requestDiagnosis(c: DiagnosisContext, rules: DiagnosisRules, scope?: string): Promise<DiagnosisRun> {
  const request = diagnosisRequest(c, scope);
  return draftDiagnosis(c, rules, async (prompt) => {
    const r = await aiComplete({ ...request, prompt });
    return { text: r.text, inputTokens: r.usage?.inputTokens ?? null, outputTokens: r.usage?.outputTokens ?? null, mock: r.mode === 'mock' };
  });
}

/* ---------- Saved drafts and approval ---------- */

export interface SavedDiagnosis extends DiagnosisRun {
  lang: Lang;
  at: string;
  /** Changes when the data Copilot saw change (the draft is then flagged as stale). */
  baseline: string;
}

export function diagnosisBaseline(c: DiagnosisContext): string {
  const s = JSON.stringify(c);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Audience → the latest draft. */
export const useDiagnosisDrafts = createScopedStore<Record<string, SavedDiagnosis>>('proj.diagnosisDrafts', () => ({}));

const human = (x: { origin: string } | undefined) => x?.origin === 'human';

/**
 * Writes the drafted parts into the confirmed data. With `force` false (approve all), a part a person already judged is kept;
 * approving one part (`force` true) is the person's explicit choice and replaces it.
 */
export function approveDiagnosis(data: DeliverableData, draft: DiagnosisDraft, parts: readonly DiagnosisPart[], meta: { by: string; at: string }, force = false): DeliverableData {
  let next = data;
  for (const part of parts) {
    if (part === 'situation') {
      if (force || !human(next.situation)) next = setSituation(next, { type: draft.situation.type, reason: draft.situation.reason, origin: draft.situation.origin, ...meta });
    } else if (part === 'crux') {
      const c = draft.crux;
      const value: CruxJudgment = { ...(c.causeId ? { causeId: c.causeId } : {}), name: c.name, issueIds: c.issueIds, reason: c.reason, addressable: c.addressable, origin: c.origin, ...meta };
      if (c.issueIds.length && (force || !human(next.crux))) next = setCrux(next, value);
    } else {
      const id = part.slice(6);
      const f = draft.issues[id];
      if (f && (force || !human(next.framings?.[id]))) next = setFraming(next, id, { ...f, ...meta });
    }
  }
  return next;
}

export const allParts = (draft: DiagnosisDraft): DiagnosisPart[] => ['situation', 'crux', ...Object.keys(draft.issues).map((id) => `issue:${id}` as const)];

/** Kept for typing the panel's edits. */
export type { CruxJudgment, IssueFraming, Situation };
