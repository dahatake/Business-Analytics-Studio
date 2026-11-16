/**
 * FR-322: drafts what a decision report leaves open, so the requirements definition is filled as far as logic
 * allows. Each gap becomes a decision with options, a recommended option, the reasons a strategy consultant
 * would give, and what would change the recommendation. Deterministic (no generative AI): the same report and
 * ratings always give the same drafts. Unconfirmed drafts are marked as inferred until the user confirms one.
 *
 * Methods:
 * - Links (option → issue, requirement → issue, KPI → requirement): IDF-weighted overlap of the terms in the
 *   report's own text; the shared terms are shown as the reason.
 * - Falsifiers: hypothesis-driven problem solving (Minto) and "what would have to be true"
 *   (Lafley, Martin, Rivkin & Siggelkow, "Bringing Science to the Art of Strategy", HBR 2012).
 * - Solution: SMAA rank acceptability, weighted issue coverage, complementarity and reversibility — start with
 *   the cheaper, easier-to-reverse option and learn (McGrath & MacMillan, "Discovery-Driven Planning", HBR 1995).
 * - Requirement types after ISO/IEC/IEEE 29148 (business, functional, non-functional).
 */
import type { DecisionReport, ReportStep } from '../../data/extensionSchemas.ts';
import type { Lang } from '../../i18n/core.ts';
import {
  emptyDecisionInputs, GATE_PLACEHOLDER, linkedIssues, rankAcceptability, rankIssues, rankOptions, reportGate, simulateGate,
  type DecisionInputs, type GateInputs,
} from './decisionSupport.ts';

type Bi = Record<Lang, string>;

export const DRAFT_KINDS = ['falsifier', 'optionIssue', 'solution', 'baseline', 'sampleSize', 'reqType', 'reqIssue', 'kpiReq'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export type Confidence = 'high' | 'medium' | 'low';

export interface DraftOption {
  id: string;
  label: string;
  /** Text that goes into the requirements definition when this option is used. */
  text: string;
  /** Linked ids for link decisions. */
  ids?: string[];
}

export interface DraftDecision {
  id: string;
  kind: DraftKind;
  step: ReportStep;
  /** The item the decision is about (quoted from the report). */
  subject: string;
  line: number;
  options: DraftOption[];
  recommended: string;
  confidence: Confidence;
  reasons: string[];
  /** What would change the recommendation. */
  flip: string;
}

/** Marks a drafted (unconfirmed) value in generated documents. */
export const INFERRED: Record<Lang, string> = { ja: '【推定】', en: '[INFERRED]' };
export const CONFIDENCE_LABEL: Record<Confidence, Bi> = {
  high: { ja: '高', en: 'high' }, medium: { ja: '中', en: 'medium' }, low: { ja: '低', en: 'low' },
};

export interface Resolved { option: DraftOption; origin: 'user' | 'inferred' }

/** The option in use: the user's choice when valid, else the recommendation (marked as inferred). */
export function resolve(d: DraftDecision, inputs: DecisionInputs): Resolved {
  const chosen = d.options.find((o) => o.id === inputs.choices?.[d.id]);
  return chosen ? { option: chosen, origin: 'user' } : { option: d.options.find((o) => o.id === d.recommended)!, origin: 'inferred' };
}

/* ---------- Term overlap ---------- */

const STOP = new Set(['to', 'be', 'as', 'is', 'gap', 'the', 'and', 'of', 'for', 'in', 'kpi']);
const TERM = /[\p{Script=Han}々〆]{2,}|[\p{Script=Katakana}ー]{2,}|[A-Za-z][A-Za-z0-9]+/gu;

/** Whole terms (shown as reasons) and kanji bigrams (to match compounds such as 開始条件 ~ 開始). */
export function termsOf(text: string): { whole: Set<string>; all: Set<string> } {
  const whole = new Set<string>();
  const all = new Set<string>();
  for (const m of text.matchAll(TERM)) {
    const w = m[0].toLowerCase();
    if (STOP.has(w)) continue;
    whole.add(w);
    all.add(w);
    if (/^[\p{Script=Han}々]{3,}$/u.test(w)) for (let i = 0; i + 2 <= w.length; i++) all.add(w.slice(i, i + 2));
  }
  return { whole, all };
}

interface Doc { id: string; text: string }
interface Match { id: string; score: number; shared: string[] }

class Matcher {
  private readonly idf = new Map<string, number>();
  constructor(corpus: string[]) {
    const df = new Map<string, number>();
    for (const t of corpus) for (const w of termsOf(t).all) df.set(w, (df.get(w) ?? 0) + 1);
    for (const [w, n] of df) this.idf.set(w, Math.log(1 + corpus.length / n));
  }
  private weight(ws: Set<string>) { let s = 0; for (const w of ws) s += this.idf.get(w) ?? 0; return s; }
  rank(text: string, candidates: Doc[]): Match[] {
    const a = termsOf(text);
    const wa = this.weight(a.all);
    return candidates.map((c) => {
      const b = termsOf(c.text);
      const common = new Set([...a.all].filter((w) => b.all.has(w)));
      const score = wa && common.size ? this.weight(common) / Math.sqrt(wa * this.weight(b.all)) : 0;
      const whole = [...a.whole].filter((w) => b.all.has(w));
      const shared = (whole.length ? whole : [...common]).sort((x, y) => (this.idf.get(y) ?? 0) - (this.idf.get(x) ?? 0)).slice(0, 5);
      return { id: c.id, score, shared };
    }).sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  }
}

/** Option text without its explicit issue references, so inference cannot copy them. */
const withoutIssueRefs = (s: string) => s.replace(/(?:課題|[Ii]ssues?)\s*(?:\d+\s*(?:[・、,，]|and|&)?\s*)+/g, ' ');

/* ---------- Building the drafts ---------- */

const pct = (x: number) => `${Math.round(x * 100)}%`;

function cleanCause(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/^(?:根本原因|主因|原因)は、?/, '').replace(/(?:にあると考えられる|にある|と考えられる|である|ことである)?。?$/, '').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

export interface Drafts {
  decisions: DraftDecision[];
  /** Effective option → issue links (explicit in the report, else the resolved draft). */
  optionIssues: Map<string, { ids: string[]; inferred: boolean }>;
}

export function buildDrafts(r: DecisionReport, inputs: DecisionInputs, lang: Lang = r.lang): Drafts {
  const L = (b: Bi) => b[lang];
  const issueNo = new Map(r.issues.map((i, n) => [i.id, n + 1]));
  const issueName = (id: string) => `${L({ ja: '課題', en: 'Issue' })} ${issueNo.get(id)}`;
  const reqId = (n: number) => `REQ-${String(n + 1).padStart(2, '0')}`;
  const issueText = (i: DecisionReport['issues'][number]) => [i.title, i.phenomenon, i.rootCause, i.impact, i.text].filter(Boolean).join(' ');
  const gapText = (g: DecisionReport['gaps'][number]) => [g.area, g.asIs, g.toBe, g.gap, g.action].filter(Boolean).join(' ');
  const kpiText = (k: DecisionReport['kpis'][number]) => [k.category, k.name, k.definition].filter(Boolean).join(' ');
  const matcher = new Matcher([
    ...r.issues.map(issueText), ...r.gaps.map(gapText), ...r.kpis.map(kpiText),
    ...r.options.map((o) => withoutIssueRefs(o.text)), ...r.openQuestions.map((q) => q.text),
  ]);
  const issueDocs: Doc[] = r.issues.map((i) => ({ id: i.id, text: issueText(i) }));
  const issueRows = rankIssues(r, inputs);
  const decisions: DraftDecision[] = [];
  const NONE: Bi = { ja: '該当なし', en: 'None' };

  /** A link decision: the top candidates, the top two together when close, and "none". */
  const linkDecision = (base: Omit<DraftDecision, 'options' | 'recommended' | 'confidence' | 'reasons' | 'flip'>, matches: Match[], name: (id: string) => string, why: Bi, flip: Bi): DraftDecision => {
    const hits = matches.filter((m) => m.score > 0).slice(0, 3);
    const options: DraftOption[] = hits.map((m) => ({ id: m.id, label: name(m.id), text: name(m.id), ids: [m.id] }));
    const [a, b] = hits;
    const both = a && b && b.score >= a.score * 0.7;
    if (both) options.unshift({ id: `${a.id}+${b.id}`, label: `${name(a.id)} + ${name(b.id)}`, text: `${name(a.id)}, ${name(b.id)}`, ids: [a.id, b.id] });
    options.push({ id: 'none', label: L(NONE), text: '—', ids: [] });
    const recommended = !a ? 'none' : both ? `${a.id}+${b.id}` : a.id;
    const margin = a ? (b ? a.score / Math.max(b.score, 1e-9) : Infinity) : 0;
    const confidence: Confidence = !a || a.score < 0.08 ? 'low' : margin >= 1.5 && a.score >= 0.15 ? 'high' : 'medium';
    const reasons = a
      ? [
        L(why),
        ...hits.slice(0, both ? 2 : 1).map((m) => L({
          ja: `${name(m.id)} と共通する語: ${m.shared.join('、') || '—'}（一致度 ${m.score.toFixed(2)}）`,
          en: `Shared with ${name(m.id)}: ${m.shared.join(', ') || '—'} (match ${m.score.toFixed(2)})`,
        })),
        ...(both ? [L({ ja: '上位 2 件の一致度が近い（7 割以上）ため、両方に結び付けます。', en: 'The top two match about equally (within 70%), so both are linked.' })] : []),
        ...(b && !both ? [L({ ja: `次点は ${name(b.id)}（一致度 ${b.score.toFixed(2)}）です。`, en: `Runner-up: ${name(b.id)} (match ${b.score.toFixed(2)}).` })] : []),
      ]
      : [L({ ja: '本文に共通する語がないため、結び付けを推定できません。', en: 'No shared terms, so no link can be inferred.' })];
    return { ...base, options, recommended, confidence, reasons, flip: L(flip) };
  };

  /* Step 1: falsifiers for issues the report states without one. */
  const topIssue = issueRows[0]?.id;
  for (const i of r.issues.filter((x) => !x.falsifier)) {
    const row = issueRows.find((x) => x.id === i.id)!;
    const stated = r.issues.some((x) => x.falsifier);
    const cause = cleanCause(i.rootCause);
    if (!cause) {
      // No stated cause: the hypothesis to test is that the problem is real and matters.
      decisions.push({
        id: `falsifier:${i.id}`, kind: 'falsifier', step: 'asis', subject: `${issueName(i.id)}: ${i.title}`, line: i.line,
        options: [
          { id: 'existence', label: L({ ja: '起きているかで否定する', en: 'Refute by occurrence' }), text: L({ ja: `案件の記録を数えて「${i.title}」がほとんど見られなければ、この課題は否定される。`, en: `If case records show "${i.title}" rarely occurs, this issue is refuted.` }) },
          { id: 'impact', label: L({ ja: '影響で否定する', en: 'Refute by impact' }), text: L({ ja: `「${i.title}」がある案件とない案件で、時間・品質・顧客の成果に差がなければ、この課題の優先度は下がる。`, en: `If cases with and without "${i.title}" do not differ in time, quality or customer outcome, this issue drops in priority.` }) },
        ],
        recommended: row.hypothesis ? 'existence' : 'impact', confidence: 'low',
        reasons: [
          L({ ja: '仮説は「何が分かれば誤りと言えるか」を先に決めないと、検証せずに施策へ進んでしまいます（仮説思考、Lafley ほか HBR 2012 の「何が真であれば」）。', en: 'Without stating what would prove a hypothesis wrong, teams move to action without testing it (hypothesis-driven work; "what would have to be true", Lafley et al., HBR 2012).' }),
          L({ ja: 'レポートに根本原因がないため、原因ではなく課題そのもの（起きているか・効いているか）を確かめます。根本原因は【要記入】のままです。', en: 'The report states no root cause, so the test targets the issue itself (does it occur, does it matter). The root cause stays to be filled.' }),
          row.hypothesis
            ? L({ ja: '根拠が仮説・要確認なので、まず起きていること自体を記録で確かめるのが最も安価です。', en: 'Its evidence is a hypothesis, so first confirming it occurs at all is cheapest.' })
            : L({ ja: '起きていることは事実として書かれているので、成果に効いているかを確かめます。', en: 'The report states it occurs as a fact, so test whether it affects outcomes.' }),
        ],
        flip: L({ ja: '根本原因が分かったら、原因を条件にした反証条件に置き換える。', en: 'Once a root cause is known, replace this with a cause-based falsifier.' }),
      });
      continue;
    }
    const options: DraftOption[] = [
      { id: 'condition', label: L({ ja: '条件で否定する', en: 'Refute by condition' }), text: L({ ja: `「${cause}」が当てはまらない案件でも、同程度に「${i.title}」が起きるなら、この根本原因は否定される。`, en: `If "${i.title}" occurs just as often where "${cause}" does not hold, this root cause is refuted.` }) },
      { id: 'compare', label: L({ ja: '比較で否定する', en: 'Refute by comparison' }), text: L({ ja: `「${i.title}」が多い案件と少ない案件を比べ、「${cause}」の有無に差がなければ、この根本原因は否定される。`, en: `If cases with more and fewer "${i.title}" do not differ in "${cause}", this root cause is refuted.` }) },
      { id: 'intervene', label: L({ ja: '試行で否定する', en: 'Refute by intervention' }), text: L({ ja: `「${cause}」を小さく取り除く試行をしても「${i.title}」が減らなければ、この根本原因は否定される。`, en: `If a small trial that removes "${cause}" does not reduce "${i.title}", this root cause is refuted.` }) },
    ];
    // A top-priority hypothesis drives the biggest commitment, so it earns the stronger (causal) test.
    const intervene = row.hypothesis && i.id === topIssue;
    decisions.push({
      id: `falsifier:${i.id}`, kind: 'falsifier', step: 'asis', subject: `${issueName(i.id)}: ${i.title}`, line: i.line,
      options, recommended: intervene ? 'intervene' : 'condition', confidence: 'medium',
      reasons: [
        L({ ja: '仮説は「何が分かれば誤りと言えるか」を先に決めないと、検証せずに施策へ進んでしまいます（仮説思考、Lafley ほか HBR 2012 の「何が真であれば」）。', en: 'Without stating what would prove a hypothesis wrong, teams move to action without testing it (hypothesis-driven work; "what would have to be true", Lafley et al., HBR 2012).' }),
        intervene
          ? L({ ja: `この課題は優先順位 1 位（スコア ${row.score.toFixed(1)}）で、根拠が仮説・要確認です。最大の投資を左右するため、相関ではなく因果を確かめる試行が見合います。`, en: `This issue ranks first (score ${row.score.toFixed(1)}) and rests on a hypothesis; it drives the largest commitment, so a causal trial is worth its cost.` })
          : L({ ja: '既存の案件記録だけで判定でき、最も安く早く確かめられます。', en: 'It can be checked with existing case records — the cheapest and fastest test.' }),
        ...(stated ? [L({ ja: 'レポート自身の反証条件と同じ文型です。', en: 'It follows the wording of the falsifier the report itself states.' })] : []),
      ],
      flip: L(intervene
        ? { ja: '試行の費用が大きい、または既存記録で原因の有無が判別できるなら「条件で否定する」を選ぶ。', en: 'If a trial is costly or records already show whether the cause is present, choose "refute by condition".' }
        : { ja: '既存の記録で原因の有無が判別できないなら「比較」か「試行」を選ぶ。', en: 'If records cannot show whether the cause is present, choose comparison or intervention.' }),
    });
  }

  /* Step 4: which issues each option addresses, when the report does not say. */
  const optionIssues = new Map<string, { ids: string[]; inferred: boolean }>();
  for (const o of r.options) {
    const explicit = linkedIssues(r, o.id);
    if (explicit.length) { optionIssues.set(o.id, { ids: explicit, inferred: false }); continue; }
    const d = linkDecision(
      { id: `optionIssue:${o.id}`, kind: 'optionIssue', step: 'solution', subject: `${o.label}. ${o.title}`, line: o.line },
      matcher.rank(withoutIssueRefs(`${o.title} ${o.text}`), issueDocs), issueName,
      { ja: 'レポートはこの選択肢が対応する課題を書いていません。選択肢と課題の本文に共通する語から推定します。', en: 'The report does not say which issues this option addresses; inferred from terms shared by the option and issue texts.' },
      { ja: '選択肢の作成者が別の課題を意図していたなら、その課題を選ぶ。', en: 'If the option was meant for another issue, choose that issue.' },
    );
    decisions.push(d);
    optionIssues.set(o.id, { ids: resolve(d, inputs).option.ids ?? [], inferred: true });
  }

  /* Step 4: the solution to adopt. */
  if (r.options.length) {
    const rows = rankOptions(r, inputs, issueRows, effectiveLinks(optionIssues));
    const acc = new Map(rankAcceptability(rows, inputs.optionWeights).map((a) => [a.id, a.first]));
    const info = rows.map((row) => ({
      row, ids: row.issues, first: acc.get(row.id) ?? 0, coverage: row.coverage,
      lightness: (row.ratings.ease.value + row.ratings.affordability.value) / 2,
    })).sort((a, b) => b.first - a.first || b.coverage - a.coverage);
    const [lead, next] = info;
    const name = (x: typeof lead) => `${x!.row.label}. ${x!.row.title}`;
    const options: DraftOption[] = info.slice(0, 4).map((x) => ({ id: x.row.id, label: name(x), text: name(x) }));
    const close = Boolean(next) && (lead!.first < 0.7 || lead!.first - next!.first < 0.1);
    const overlap = next ? lead!.ids.filter((id) => next.ids.includes(id)).length / Math.max(1, new Set([...lead!.ids, ...next.ids]).size) : 1;
    const complementary = Boolean(next) && lead!.ids.length > 0 && next!.ids.length > 0 && overlap < 0.5;
    let recommended = lead!.row.id;
    const reasons: string[] = [];
    const numbers = info.slice(0, 3).map((x) => L({
      ja: `${x.row.label}: 1 位になる確率 ${pct(x.first)}、課題の網羅 ${pct(x.coverage)}（${x.ids.map(issueName).join('・') || '対応する課題なし'}）、実行しやすさと投資の小ささ ${x.lightness.toFixed(1)}`,
      en: `${x.row.label}: P(first) ${pct(x.first)}, issue coverage ${pct(x.coverage)} (${x.ids.map(issueName).join(', ') || 'no linked issue'}), ease and affordability ${x.lightness.toFixed(1)}`,
    }));
    if (!close) {
      reasons.push(L({ ja: `${lead!.row.label} は重みと評価を揺らしても ${pct(lead!.first)} の確率で 1 位で、頑健です（SMAA）。`, en: `${lead!.row.label} ranks first in ${pct(lead!.first)} of perturbed weightings — a robust choice (SMAA).` }));
    } else if (complementary) {
      const [first, then] = [lead!, next!].sort((a, b) => b.lightness - a.lightness || b.coverage - a.coverage) as [typeof lead, typeof lead];
      const lighter = first!.lightness > then!.lightness;
      recommended = `${first!.row.id}>${then!.row.id}`;
      options.unshift({
        id: recommended,
        label: L({ ja: `${first!.row.label} を先行し、${then!.row.label} を次の段階で`, en: `${first!.row.label} first, then ${then!.row.label}` }),
        text: L({ ja: `${name(first)}（第 1 段階）→ ${name(then)}（第 2 段階）`, en: `${name(first)} (phase 1) → ${name(then)} (phase 2)` }),
      });
      reasons.push(
        L({ ja: `上位 2 案は僅差（${lead!.row.label} ${pct(lead!.first)} / ${next!.row.label} ${pct(next!.first)}）で、点数ではどちらとも決められません。`, en: `The top two are a close call (${lead!.row.label} ${pct(lead!.first)} / ${next!.row.label} ${pct(next!.first)}); the scores cannot decide.` }),
        L({ ja: `2 案が対応する課題はほとんど重ならず（重なり ${pct(overlap)}）、補い合います。片方を捨てると、もう片方の課題が残ります。`, en: `They address largely different issues (overlap ${pct(overlap)}), so they complement each other; dropping one leaves its issues open.` }),
        lighter
          ? L({ ja: `${first!.row.label} は実行しやすさと投資の小ささが上（${first!.lightness.toFixed(1)} 対 ${then!.lightness.toFixed(1)}）なので先に行い、その結果で ${then!.row.label} の前提を確かめてから投資します（Discovery-Driven Planning、リアル・オプション）。`, en: `${first!.row.label} is easier and cheaper (${first!.lightness.toFixed(1)} vs ${then!.lightness.toFixed(1)}), so it goes first and its results test ${then!.row.label}'s assumptions before that investment (discovery-driven planning; real options).` })
          : L({ ja: `実行しやすさと投資の小ささは同等（${first!.lightness.toFixed(1)}）なので、優先度で重み付けした課題をより多く解く ${first!.row.label}（${pct(first!.coverage)}）を先に行い、その結果で ${then!.row.label} の前提を確かめてから投資します（Discovery-Driven Planning、リアル・オプション）。`, en: `Ease and affordability are equal (${first!.lightness.toFixed(1)}), so ${first!.row.label}, which covers more of the priority-weighted issues (${pct(first!.coverage)}), goes first and its results test ${then!.row.label}'s assumptions before that investment (discovery-driven planning; real options).` }),
      );
    } else {
      const best = [lead!, next!].sort((a, b) => b.coverage - a.coverage || b.lightness - a.lightness)[0]!;
      recommended = best.row.id;
      reasons.push(
        L({ ja: `上位 2 案は僅差（${lead!.row.label} ${pct(lead!.first)} / ${next!.row.label} ${pct(next!.first)}）で、対応する課題も重なるため、どちらか一方を選びます。`, en: `The top two are close (${lead!.row.label} ${pct(lead!.first)} / ${next!.row.label} ${pct(next!.first)}) and address the same issues, so pick one.` }),
        L({ ja: `${best.row.label} は優先度で重み付けした課題をより多く解決し（${pct(best.coverage)}）、同点なら実行しやすい方を選びます。`, en: `${best.row.label} covers more of the priority-weighted issues (${pct(best.coverage)}); ties go to the easier option.` }),
      );
    }
    reasons.push(...numbers);
    decisions.push({
      id: 'solution', kind: 'solution', step: 'solution', subject: L({ ja: '採用する解決策', en: 'Solution to adopt' }), line: r.options[0]!.line,
      options, recommended, confidence: close ? 'medium' : 'high', reasons,
      flip: next
        ? L({ ja: `重みを見直して ${next.row.label} の 1 位になる確率が 70% を超える、または先行案の試行が合格基準に届かないときは見直す。`, en: `Revisit if, with revised weights, ${next.row.label} ranks first more than 70% of the time, or the first phase misses its trial gate.` })
        : L({ ja: '新しい選択肢が出たら見直す。', en: 'Revisit when a new option appears.' }),
    });
  }

  /* Step 3: how to get each KPI baseline, and the trial size. */
  const RECORDS = /記録|ログ|レポート|集計|システム|データ|CEHub|CRM|Closeout|record|log|report|system|data/i;
  for (const k of r.kpis) {
    const fromRecords = RECORDS.test(`${k.name} ${k.definition ?? ''}`);
    decisions.push({
      id: `baseline:${k.id}`, kind: 'baseline', step: 'kpi', subject: k.name, line: k.line,
      options: [
        { id: 'retro', label: L({ ja: '既存の記録から遡って測る', en: 'Measure retrospectively from records' }), text: L({ ja: '既存の記録から遡って測る', en: 'measured retrospectively from existing records' }) },
        { id: 'prospective', label: L({ ja: '試行前の期間に新たに測る', en: 'Measure prospectively before the trial' }), text: L({ ja: '試行前の期間に新たに測る', en: 'measured prospectively before the trial' }) },
        { id: 'proxy', label: L({ ja: '代わりの指標で当面測る', en: 'Use a proxy for now' }), text: L({ ja: '代わりの指標で当面測る（後で本来の指標に置き換える）', en: 'measured by a proxy for now (replaced later)' }) },
      ],
      recommended: fromRecords ? 'retro' : 'prospective', confidence: fromRecords ? 'medium' : 'low',
      reasons: [
        L({ ja: '基準値がないと試行の前後を比べられず、続けるか止めるかを判定できません（Discovery-Driven Planning）。', en: 'Without a baseline the trial cannot be compared before and after, so continue-or-stop cannot be decided (discovery-driven planning).' }),
        fromRecords
          ? L({ ja: 'KPI の名前か定義が記録・データに触れており、既存の記録から最も早く安く測れる見込みです。', en: 'The KPI name or definition refers to records or data, so existing records are the fastest and cheapest source.' })
          : L({ ja: 'KPI の定義が既存の記録に触れていないため、定義どおりに新たに測る方が確実です。', en: 'The definition does not refer to existing records, so measuring it anew is more reliable.' }),
      ],
      flip: L(fromRecords
        ? { ja: '記録に欠損や定義の違いが多ければ、新たに測る。', en: 'If records are incomplete or defined differently, measure anew.' }
        : { ja: '同じ値を記録したデータが見つかれば、遡って測る。', en: 'If records with the same measure exist, measure retrospectively.' }),
    });
  }
  const gate = reportGate(r);
  if (gate !== null) {
    const g: GateInputs = { gate, ...GATE_PLACEHOLDER, ...inputs.gate, effect: { ...GATE_PLACEHOLDER.effect, ...inputs.gate.effect } };
    const sim = simulateGate(g, { runs: 1000 });
    if (sim) {
      const enough = sim.curve.find((c) => c.correct >= 0.8);
      const max = sim.curve.at(-1)!;
      const nOption = (n: number, correct: number): DraftOption => ({
        id: `n-${n}`, label: L({ ja: `各期間 ${n} 件`, en: `${n} per period` }),
        text: L({ ja: `各期間 ${n} 件（正しく判定できる確率 ${pct(correct)}）`, en: `${n} per period (correct decision ${pct(correct)})` }),
      });
      const options: DraftOption[] = [];
      for (const c of [enough, sim.curve.find((x) => x.n === g.n) ?? { n: g.n, correct: sim.correct }, max]) {
        if (c && !options.some((o) => o.id === `n-${c.n}`)) options.push(nOption(c.n, c.correct));
      }
      options.push({
        id: 'redesign', label: L({ ja: '比較の設計を変える', en: 'Change the comparison design' }),
        text: L({ ja: '対照群を置く、または同じ種類の案件で前後を比べ、ばらつきを減らしてから件数を決める', en: 'add a control group or compare like-for-like cases to cut variance, then size the trial' }),
      });
      const recommended = enough && enough.n <= Math.max(2 * g.n, 40) ? `n-${enough.n}` : 'redesign';
      decisions.push({
        id: 'sampleSize', kind: 'sampleSize', step: 'kpi', subject: L({ ja: `試行の件数（合格基準 ${pct(gate)}）`, en: `Trial size (gate ${pct(gate)})` }), line: r.claims.find((c) => c.evidence === 'proposedTarget')?.line ?? 1,
        options, recommended, confidence: inputs.gate.effect ? 'medium' : 'low',
        reasons: [
          L({ ja: `件数が少ないと、効かないのに合格・効くのに不合格の誤判定が増えます。今の入力では各期間 ${g.n} 件で正しく判定できる確率は ${pct(sim.correct)}、${max.n} 件でも ${pct(max.correct)} です。`, en: `Small trials misjudge both ways. With the current inputs, ${g.n} per period decides correctly ${pct(sim.correct)} of the time; ${max.n} gives ${pct(max.correct)}.` }),
          recommended === 'redesign'
            ? L({ ja: '件数を増やすだけでは 80% に届かない、または必要な件数が現実的でないため、ばらつきを減らす設計の変更が先です。', en: 'More cases alone does not reach 80% (or needs an unrealistic number), so reduce variance first.' })
            : L({ ja: `80% に届く最小の件数は各期間 ${enough!.n} 件です。それ以上は判定の質がほとんど上がらず、試行が長くなります。`, en: `The smallest size reaching 80% is ${enough!.n} per period; more adds little and lengthens the trial.` }),
          ...(inputs.gate.effect ? [] : [L({ ja: '効果の見積もりは段 3 の仮の値です。見積もりを入れると推奨が変わることがあります。', en: 'The effect estimate is the step 3 placeholder; entering one may change the recommendation.' })]),
        ],
        flip: L({ ja: '効果の見積もり・ばらつき・件数を段 3 で変えると、推奨も変わる。', en: 'Changing the effect, variance or size in step 3 changes the recommendation.' }),
      });
    }
  }

  /* Step 2: requirement types (ISO/IEC/IEEE 29148). */
  const TYPE_WORDS: Record<'functional' | 'nonFunctional' | 'business', string> = {
    nonFunctional: 'ガバナンス|セキュリティ|保存|同意|権限|監査|プライバシ|個人情報|可用|性能|応答|信頼|レビュー|コンプライアンス|governance|security|privacy|retention|consent|audit|performance|availability',
    functional: '\\bIT\\b|データ|システム|追跡|\\bID\\b|検索|自動|ツール|基盤|連携|記録|画面|通知|data|system|track|search|automat|tool|platform|integrat',
    business: '戦略|配分|組織|人材|役割|体制|プロセス|業務|評価|方法論|説明|strategy|organi[sz]ation|role|process|people|capacity',
  };
  const wordsIn = (text: string, k: keyof typeof TYPE_WORDS) => [...new Set((text.match(new RegExp(TYPE_WORDS[k], 'gi')) ?? []).map((w) => w.toLowerCase()))];
  const TYPE_LABEL: Record<keyof typeof TYPE_WORDS, Bi> = {
    business: { ja: '業務の要求', en: 'Business requirement' },
    functional: { ja: '機能要求', en: 'Functional requirement' },
    nonFunctional: { ja: '非機能要求', en: 'Non-functional requirement' },
  };
  r.gaps.forEach((g, n) => {
    const text = gapText(g);
    const hits = (Object.keys(TYPE_WORDS) as (keyof typeof TYPE_WORDS)[]).map((k) => ({ k, words: wordsIn(text, k), area: wordsIn(g.area, k).length }));
    // Words in the area name count extra: the area names what the requirement is about.
    const score = (h: (typeof hits)[number]) => h.words.length + 2 * h.area;
    const ranked = [...hits].sort((a, b) => score(b) - score(a));
    const top = ranked[0]!;
    const second = ranked[1]!;
    const recommended = score(top) > 0 ? top.k : 'business';
    decisions.push({
      id: `reqType:${g.id}`, kind: 'reqType', step: 'tobe', subject: `${reqId(n)}: ${g.area}`, line: g.line,
      options: (['functional', 'nonFunctional', 'business'] as const).map((k) => ({ id: k, label: L(TYPE_LABEL[k]), text: L(TYPE_LABEL[k]) })),
      recommended, confidence: score(top) === 0 ? 'low' : score(top) >= score(second) + 2 ? 'high' : 'medium',
      reasons: [
        L({ ja: 'ISO/IEC/IEEE 29148 に従い、ソフトウェアが果たす機能（機能要求）、品質・制約（非機能要求）、ソフトウェアの外で業務・組織が満たすこと（業務の要求）に分けます。要求定義書では機能・非機能を開発の範囲、業務の要求を前提として扱います。', en: 'Per ISO/IEC/IEEE 29148: what the software does (functional), its qualities and constraints (non-functional), and what the business must do outside the software (business). Functional and non-functional define the build scope; business requirements are its context.' }),
        L({ ja: `手掛かりの語: ${ranked.filter((h) => h.words.length).map((h) => `${L(TYPE_LABEL[h.k])}（${h.words.slice(0, 4).join('、')}）`).join(' / ') || 'なし'}`, en: `Cue words: ${ranked.filter((h) => h.words.length).map((h) => `${L(TYPE_LABEL[h.k])} (${h.words.slice(0, 4).join(', ')})`).join(' / ') || 'none'}` }),
      ],
      flip: L({ ja: 'ソフトウェアで実現しない（運用や規程で満たす）なら業務の要求、システムの品質や制約として測るなら非機能要求を選ぶ。', en: 'Choose business if met by operations or policy rather than software; non-functional if it is measured as a system quality or constraint.' }),
    });
  });

  /* Step 5: requirement → issue, KPI → requirement. */
  r.gaps.forEach((g, n) => {
    decisions.push(linkDecision(
      { id: `reqIssue:${g.id}`, kind: 'reqIssue', step: 'deliverable', subject: `${reqId(n)}: ${g.area}`, line: g.line },
      matcher.rank(gapText(g), issueDocs), issueName,
      { ja: 'レポートは各領域のギャップがどの課題を解くかを書いていません。ギャップ（As-Is・To-Be・施策）と課題（現象・根本原因）の本文に共通する語から推定します。', en: 'The report does not say which issue each gap resolves; inferred from terms shared by the gap (as-is, to-be, action) and the issue (phenomenon, root cause).' },
      { ja: '要求が別の課題の根本原因を取り除くものなら、その課題を選ぶ。', en: 'If the requirement removes another issue\'s root cause, choose that issue.' },
    ));
  });
  const reqDocs: Doc[] = r.gaps.map((g, n) => ({ id: reqId(n), text: gapText(g) }));
  const measuring = new Set(r.gaps.map((g, n) => (/KPI|計測|測定|指標|measure|metric/i.test(g.area) ? reqId(n) : '')).filter(Boolean));
  for (const k of r.kpis) {
    const ranked = matcher.rank(kpiText(k), reqDocs);
    // A KPI measures the outcome a requirement delivers; the "KPI management" area matches every KPI, so it is a last resort.
    const outcome = ranked.filter((m) => !measuring.has(m.id));
    const ordered = outcome[0] && outcome[0].score >= (ranked[0]?.score ?? 0) * 0.5 ? [...outcome, ...ranked.filter((m) => measuring.has(m.id))] : ranked;
    const d = linkDecision(
      { id: `kpiReq:${k.id}`, kind: 'kpiReq', step: 'deliverable', subject: k.name, line: k.line },
      ordered, (id) => id,
      { ja: 'KPI は、それが測る成果を生む要求に結び付けます（計測の仕組みそのものの要求ではなく）。KPI の名前・定義と要求の本文に共通する語から推定します。', en: 'A KPI is linked to the requirement whose outcome it measures (not to the measurement mechanism); inferred from terms shared by the KPI and the requirement.' },
      { ja: 'この KPI が測る成果を生む要求が別にあるなら、その要求を選ぶ。', en: 'If another requirement produces the outcome this KPI measures, choose it.' },
    );
    if (measuring.size && ordered !== ranked) d.reasons.push(L({ ja: `${[...measuring].join('・')}（KPI・計測の領域）はすべての KPI と一致するため、成果の要求を優先しました。`, en: `${[...measuring].join(', ')} (the KPI/measurement area) matches every KPI, so outcome requirements come first.` }));
    decisions.push(d);
  }

  return { decisions, optionIssues };
}

/** Option → issue links to feed rankOptions: only the drafted ones (the report's own links are read there). */
export function effectiveLinks(optionIssues: Drafts['optionIssues']): Map<string, string[]> {
  return new Map([...optionIssues].filter(([, v]) => v.inferred).map(([k, v]) => [k, v.ids]));
}

/**
 * Validation against the report itself: hide the option → issue links the report states, infer them, and count
 * how many options get at least one stated issue (`hit`) and how many stated links are recovered (`found` of `stated`).
 */
export function linkRecall(r: DecisionReport): { checked: number; hit: number; stated: number; found: number } {
  const hidden = { ...r, options: r.options.map((o) => ({ ...o, text: withoutIssueRefs(o.text) })) };
  const { optionIssues } = buildDrafts(hidden, emptyDecisionInputs());
  let checked = 0, hit = 0, stated = 0, found = 0;
  for (const o of r.options) {
    const explicit = linkedIssues(r, o.id);
    if (!explicit.length) continue;
    checked++;
    const got = optionIssues.get(o.id)?.ids ?? [];
    const n = explicit.filter((id) => got.includes(id)).length;
    stated += explicit.length;
    found += n;
    if (n) hit++;
  }
  return { checked, hit, stated, found };
}
