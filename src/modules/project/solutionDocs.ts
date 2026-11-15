import type { EntityOf } from '../../data/schema.ts';
import { makeFormatters, translate, type Lang, type MessageKey } from '../../i18n/core.ts';
import { personaLabel } from '../../state/personas.ts';
import { loc, type Localizable } from '../../state/text.ts';
import type { DeliverableData } from './deliverables.ts';
import type { StrategyContext, StrategyThread, ThreadSolution, DeliverableKind } from './strategy.ts';

/**
 * The final deliverable of each solution (FR-315). A digital solution ends in a requirements definition (structure after
 * ISO/IEC/IEEE 29148: business requirements traced to key results, functional requirements from use cases, non-functional
 * requirements, acceptance criteria tied to KPI targets, a traceability matrix). Other changes end in the plan that fits
 * them, because not every business problem is solved by a system. Sections are generated deterministically from the
 * linked data; what the data cannot say is marked "to fill" and keeps the deliverable incomplete until a person writes it.
 */

export const SECTIONS: Record<DeliverableKind, string[]> = {
  requirements: ['purpose', 'scope', 'stakeholders', 'businessReq', 'functionalReq', 'nonFunctionalReq', 'dataReq', 'constraints', 'acceptance', 'benefits', 'risks', 'rtm'],
  processPlan: ['purpose', 'scope', 'stakeholders', 'asisTobe', 'changes', 'roles', 'transition', 'benefits', 'risks', 'rtm'],
  changePlan: ['purpose', 'scope', 'stakeholders', 'policyChange', 'impact', 'changeApproach', 'governance', 'benefits', 'risks', 'rtm'],
  investmentPlan: ['purpose', 'scope', 'stakeholders', 'investment', 'businessCase', 'procurement', 'benefits', 'risks', 'rtm'],
  sourcingPlan: ['purpose', 'scope', 'stakeholders', 'sourcingScope', 'selection', 'contract', 'benefits', 'risks', 'rtm'],
};

export const TO_FILL: Record<Lang, string> = { ja: '【要記入】', en: '[TO FILL]' };
export const hasToFill = (text: string) => text.includes(TO_FILL.ja) || text.includes(TO_FILL.en);

export const sectionKey = (id: string) => `sol.sec.${id}` as MessageKey;
export const kindKey = (kind: DeliverableKind) => `sol.kind.${kind}` as MessageKey;

export interface DocContext extends StrategyContext {
  deliverables: DeliverableData;
  today: string;
}

export interface DocSection {
  id: string;
  text: string;
  /** Written by a person (overrides the generated text). */
  edited: boolean;
  /** Still has "to fill" parts. */
  open: boolean;
}

export interface SolutionDoc {
  solutionId: string;
  kind: DeliverableKind;
  sections: DocSection[];
  complete: boolean;
}

type Bi = { ja: string; en: string };
const bullets = (lines: string[]) => lines.filter(Boolean).map((l) => `- ${l}`).join('\n');

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

  const rtmHead = L({ ja: '| 会社目標 | OKR | KPI（目標） | 予測 P50 | ユースケース・施策 | 本書の節 |', en: '| Company objective | OKR | KPI (target) | Forecast P50 | Use case / initiative | Section |' });
  const rtmRows = kpis.flatMap((k) => {
    const okrs = okrsOf(k.id);
    const r = sim(k.id);
    const items = [...ucs.map((u) => loc(u.name, lang)), ...inits.map(name)].join(sep) || '—';
    const section = translate(lang, sectionKey(ts.deliverable === 'requirements' ? 'businessReq' : 'benefits'));
    return (okrs.length ? okrs : [{ id: '', objectiveIds: [] as string[] }]).map((o) => `| ${o.objectiveIds.map(objText).join(sep) || '—'} | ${o.id ? okrText(o.id) : '—'} | ${kpiName(k)} (${num(k.target)} ${unit(k)}) | ${r ? num(r.p50) : '—'} | ${items} | ${section} |`);
  });
  const rtm = rtmRows.length ? [rtmHead, '|---|---|---|---|---|---|', ...rtmRows].join('\n') : fill({ ja: 'KPI につなぐとトレーサビリティ表ができる', en: 'link a KPI to build the traceability matrix' });

  const people = [...new Set(inits.map((i) => role(i.ownerId)).filter(Boolean))];
  const kpiOwners = [...new Set(kpis.map((k) => {
    const pk = get(k.id);
    return pk?.kind === 'kpi' ? role(pk.ownerId) : '';
  }).filter(Boolean))];
  const personas = [...new Set(ucs.map((u) => translate(lang, personaLabel(u.persona) as MessageKey)))];

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
    ]),
    businessReq: bullets(kpis.map((k, i) => L({
      ja: `BR-${i + 1}: ${kpiName(k)} を ${num(k.current)} から ${num(k.target)} ${unit(k)} にする（期限 ${k.deadline}${okrsOf(k.id).length ? `、KR: ${okrsOf(k.id).map((o) => okrText(o.id)).join(sep)}` : ''}）`,
      en: `BR-${i + 1}: move ${kpiName(k)} from ${num(k.current)} to ${num(k.target)} ${unit(k)} (by ${k.deadline}${okrsOf(k.id).length ? `; KR: ${okrsOf(k.id).map((o) => okrText(o.id)).join(sep)}` : ''})`,
    }))) || fill({ ja: '業務要求（KPI につなぐ）', en: 'business requirements (link KPIs)' }),
    functionalReq: bullets(ucs.flatMap((u, i) => [
      `FR-${i + 1}: ${loc(u.name, lang)}`,
      ...u.steps.map((st, n) => `  ${n + 1}. ${loc(st.title, lang)}`),
    ])) || fill({ ja: 'ユースケースを登録すると機能要求になる', en: 'register use cases to derive functional requirements' }),
    nonFunctionalReq: fill({ ja: '性能・可用性・セキュリティ・個人情報・運用保守・移行の要求（数値で）', en: 'performance, availability, security, privacy, operations and migration requirements (with numbers)' }),
    dataReq: bullets([
      s.msProducts.length ? L({ ja: `利用する製品: ${s.msProducts.join(', ')}`, en: `Products: ${s.msProducts.join(', ')}` }) : '',
      doc('solution', 'dataNeeds'),
    ]) || fill({ ja: '必要なデータと連携先', en: 'data and integrations needed' }),
    constraints: bullets([
      L({ ja: `予算: ${fmt.yenCompact(s.costJpy)}`, en: `Budget: ${fmt.yenCompact(s.costJpy)}` }),
      inits.length ? L({ ja: `期間: ${inits[0]!.start}〜${inits.map((i) => i.end).sort().at(-1)}`, en: `Period: ${inits[0]!.start} – ${inits.map((i) => i.end).sort().at(-1)}` }) : '',
      doc('asis', 'constraints'),
    ]),
    acceptance: bullets(kpis.map((k, i) => {
      const r = sim(k.id);
      return L({
        ja: `AC-${i + 1}: ${k.deadline} 時点で ${kpiName(k)} が ${num(k.target)} ${unit(k)} に達する${r ? `（見積りの達成確率 ${pct(r.probability)}）` : ''}`,
        en: `AC-${i + 1}: ${kpiName(k)} reaches ${num(k.target)} ${unit(k)} by ${k.deadline}${r ? ` (estimated probability ${pct(r.probability)})` : ''}`,
      });
    }).concat(doc('solution', 'acceptance') ? [doc('solution', 'acceptance')] : [])) || fill({ ja: '受け入れ条件（KPI の目標値）', en: 'acceptance criteria (KPI targets)' }),
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
  const sections = SECTIONS[ts.deliverable].map((id) => {
    const edited = !!own[id]?.trim();
    const text = edited ? own[id]! : gen[id] ?? fill({ ja: '', en: '' });
    return { id, text, edited, open: hasToFill(text) };
  });
  return { solutionId: s.id, kind: ts.deliverable, sections, complete: sections.every((x) => !x.open) };
}

export function solutionDocMarkdown(d: SolutionDoc, title: string, lang: Lang): string {
  return [
    `# ${title}`,
    '',
    ...d.sections.flatMap((s, i) => [`## ${i + 1}. ${translate(lang, sectionKey(s.id))}`, '', s.text, '']),
  ].join('\n');
}
