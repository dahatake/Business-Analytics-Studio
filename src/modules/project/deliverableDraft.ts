import { aiComplete, registerMock, type AiResponse } from '../../ai/client.ts';
import type { Entity, EntityOf } from '../../data/schema.ts';
import { makeFormatters, translate, type Lang, type MessageKey } from '../../i18n/core.ts';
import { personaLabel } from '../../state/personas.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { computeAnalysis } from './analysis.ts';
import { describeInsight } from './analysisText.ts';
import { fieldHintKey, fieldKey, paybackLimit, paybackYears, rankedIssues, SCHEDULE_LAG_MAX, STEP_DEFS, type CheckContext } from './deliverables.ts';

/**
 * "Draft with Copilot": a draft of each step's deliverable, grounded only in the customer pack and the project data.
 * The request goes through aiComplete (C-03 gate) under its own use `deliverableDraft`, so approving another use never
 * turns drafts live by accident (docs/decision-guide.md D-9). While the use is not approved for live sending, the
 * registered deterministic mock below answers and the UI labels the result as mock (FR-011).
 */

const MARK = '[bas-proj:deliverable:';
const TOP_ISSUES = 3;

type Audience = 'internal' | 'external';
type Bi = { ja: string; en: string };

/** One text per language; picks the active one. */
const L = (lang: Lang, b: Bi) => b[lang];

export interface DraftInput {
  step: ImprovementStep;
  ctx: CheckContext;
  lang: Lang;
  audience: Audience;
}

function visibleOf(ctx: CheckContext, audience: Audience) {
  const show = (e: Entity) => audience === 'internal' || e.classification === 'shareable';
  const of = <K extends Entity['kind']>(kind: K) => ctx.pack.pack.entities.filter((e): e is EntityOf<K> => e.kind === kind && show(e));
  const get = (id: string) => {
    const e = ctx.pack.byId.get(id);
    return e && show(e) ? e : undefined;
  };
  return { of, get, show };
}

const bullets = (lines: string[]) => lines.filter(Boolean).map((l) => `- ${l}`).join('\n');

/** Deterministic draft of every field of the step (both languages share the same facts). */
export function buildDraft({ step, ctx, lang, audience }: DraftInput): Record<string, string> {
  const fmt = makeFormatters(lang);
  const v = visibleOf(ctx, audience);
  const name = (e: { name: Localizable }) => loc(e.name, lang);
  const issues = rankedIssues(ctx.pack).filter(v.show);
  const top = issues.slice(0, TOP_ISSUES);
  const kpisOf = (i: EntityOf<'issue'>) => i.kpiIds.map(v.get).filter((e): e is EntityOf<'kpi'> => e?.kind === 'kpi');
  const causesOf = (i: EntityOf<'issue'>) => i.causeIds.map(v.get).filter((e): e is EntityOf<'cause'> => e?.kind === 'cause');
  const sourcesOf = (e: Entity) => e.sourceIds.map(v.get).filter((s): s is EntityOf<'source'> => s?.kind === 'source').map(name);
  const solutionsOf = (i: EntityOf<'issue'>) => v.of('solution').filter((s) => s.issueIds.includes(i.id));
  const roleOf = (personId: string) => {
    const p = v.get(personId);
    return p?.kind === 'person' ? loc(p.role, lang) : L(lang, { ja: '（未定）', en: '(to be named)' });
  };
  const deadlineOf = (k: EntityOf<'kpi'>) => ctx.kpi.kpis.find((p) => p.id === k.id)?.deadline ?? loc(k.period, lang);
  const num = (n: number, unit: Localizable) => `${fmt.number(n)} ${loc(unit, lang)}`;
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const topKpis = uniq(top.flatMap(kpisOf));

  switch (step) {
    case 'define': {
      const rest = issues.slice(TOP_ISSUES);
      return {
        problem: bullets(top.map((i) => {
          const k = kpisOf(i)[0];
          const gap = k ? L(lang, { ja: `（${name(k)}: 現状 ${num(k.current, k.unit)}、目標 ${num(k.target, k.unit)}）`, en: ` (${name(k)}: now ${num(k.current, k.unit)}, target ${num(k.target, k.unit)})` }) : '';
          return `${name(i)}: ${loc(i.description, lang)}${gap}`;
        })),
        impact: bullets(top.map((i) => {
          const benefit = solutionsOf(i).reduce((a, s) => a + s.annualBenefitJpy, 0);
          return L(lang, {
            ja: `${name(i)}: 影響度 ${i.impact}/5、解決した場合の年間効果の見込み ${fmt.yenCompact(benefit)}`,
            en: `${name(i)}: impact ${i.impact}/5, expected annual benefit if solved ${fmt.yenCompact(benefit)}`,
          });
        })),
        scopeIn: bullets([
          L(lang, { ja: `優先度の上位 ${top.length} 課題（影響度 60・実現性 40 の重み）`, en: `The top ${top.length} issues by priority (weights: impact 60, feasibility 40)` }),
          ...top.map(name),
        ]),
        scopeOut: rest.length
          ? bullets([L(lang, { ja: '今回は扱わない（次の段階で再評価）', en: 'Not in this phase (re-assess in the next phase)' }), ...rest.map(name)])
          : L(lang, { ja: '対象外の課題はなし（すべての課題を扱う）', en: 'No issue is out of scope (all issues are covered)' }),
        sponsor: bullets(uniq(topKpis.map((k) => k.ownerId)).map((id) => L(lang, {
          ja: `${roleOf(id)}（KPI「${topKpis.filter((k) => k.ownerId === id).map(name).join('」「')}」の責任者）`,
          en: `${roleOf(id)} (accountable for ${topKpis.filter((k) => k.ownerId === id).map(name).join(', ')})`,
        }))),
        hypotheses: bullets(top.flatMap((i) => causesOf(i).map((c) => {
          const src = sourcesOf(c);
          return L(lang, {
            ja: `【仮説】${name(i)} ← ${name(c)}: ${loc(c.description, lang)}${src.length ? `（出典: ${src.join('、')}）` : '（出典なし・要確認）'}`,
            en: `[Hypothesis] ${name(i)} ← ${name(c)}: ${loc(c.description, lang)}${src.length ? ` (source: ${src.join(', ')})` : ' (no source, to be checked)'}`,
          });
        }))),
        success: bullets(topKpis.map((k) => L(lang, {
          ja: `${name(k)} を ${num(k.baseline, k.unit)} から ${num(k.target, k.unit)} にする（期限 ${deadlineOf(k)}）`,
          en: `${name(k)} from ${num(k.baseline, k.unit)} to ${num(k.target, k.unit)} (by ${deadlineOf(k)})`,
        }))),
      };
    }
    case 'asis': {
      const deals = v.of('deal').length;
      const deliverables = v.of('deliverable').length;
      const invoices = v.of('invoice');
      const overdue = invoices.filter((i) => i.status === 'overdue').length;
      const analyses = ctx.analysis.analyses.map((a) => `${loc(a.title, lang)}: ${describeInsight(computeAnalysis(a), (k, vars) => translate(lang, k, vars))}`);
      const causes = uniq(top.flatMap(causesOf));
      const unsourced = causes.filter((c) => sourcesOf(c).length === 0);
      const internal = ctx.pack.pack.entities.filter((e) => e.classification === 'internal').length;
      const solutions = uniq(top.flatMap(solutionsOf));
      const inits = v.of('initiative').filter((i) => solutions.some((s) => s.id === i.solutionId));
      const span = inits.length ? `${inits.map((i) => i.start).sort()[0]} – ${inits.map((i) => i.end).sort().at(-1)}` : '—';
      return {
        currentProcess: bullets([
          L(lang, { ja: `受注 ${deals} 件 → 納品 ${deliverables} 件 → 請求 ${invoices.length} 件（うち支払期限の超過 ${overdue} 件）`, en: `${deals} deals → ${deliverables} deliveries → ${invoices.length} invoices (${overdue} overdue)` }),
          ...causes.map((c) => `${name(c)}: ${loc(c.description, lang)}`),
        ]),
        evidence: bullets([
          ...topKpis.map((k) => {
            const src = sourcesOf(k);
            return L(lang, {
              ja: `${name(k)}: 基準 ${num(k.baseline, k.unit)} → 現状 ${num(k.current, k.unit)}（${loc(k.period, lang)}${src.length ? `、出典: ${src.join('、')}` : ''}）`,
              en: `${name(k)}: baseline ${num(k.baseline, k.unit)} → now ${num(k.current, k.unit)} (${loc(k.period, lang)}${src.length ? `, source: ${src.join(', ')}` : ''})`,
            });
          }),
          ...analyses,
        ]),
        rootCause: bullets(top.map((i) => L(lang, {
          ja: `${name(i)}: 真因の候補は「${causesOf(i).map(name).join('」「') || '未特定'}」。なぜなぜで 1 段深め、現場で確かめるまでは仮説として扱う`,
          en: `${name(i)}: candidate root cause "${causesOf(i).map(name).join('", "') || 'not identified'}". Ask "why" once more and treat it as a hypothesis until checked on site`,
        }))),
        dataGaps: bullets([
          ...causes.map((c) => L(lang, { ja: `「${name(c)}」を裏づける件数・時間・金額のデータ`, en: `Counts, hours or amounts that back "${name(c)}"` })),
          ...unsourced.map((c) => L(lang, { ja: `「${name(c)}」の出典（現在なし）`, en: `A source for "${name(c)}" (none yet)` })),
          internal > 0 && audience === 'internal' ? L(lang, { ja: `社外秘の項目 ${internal} 件は、社外と共有する前に扱いを確認する`, en: `Confirm how to handle the ${internal} internal items before sharing outside` }) : '',
        ]),
        constraints: bullets([
          L(lang, { ja: `予算: 上位課題の解決策の投資額は合計 ${fmt.yenCompact(solutions.reduce((a, s) => a + s.costJpy, 0))}`, en: `Budget: the solutions for the top issues need ${fmt.yenCompact(solutions.reduce((a, s) => a + s.costJpy, 0))} in total` }),
          L(lang, { ja: `期間: 関連する施策の期間は ${span}`, en: `Time: the related initiatives run ${span}` }),
          L(lang, { ja: `体制: KPI の責任者 ${uniq(topKpis.map((k) => k.ownerId)).length} 名が兼務で対応する前提`, en: `People: ${uniq(topKpis.map((k) => k.ownerId)).length} KPI owners work on this alongside their jobs` }),
        ]),
      };
    }
    case 'kpi': {
      const allKpis = v.of('kpi');
      const projectNames = new Map(ctx.kpi.kpis.map((k) => [k.id, k]));
      const trees = ctx.kpi.okrs.length
        ? ctx.kpi.okrs.map((o) => `${loc(o.objective, lang)} → ${o.keyResults.map((kr) => { const k = projectNames.get(kr.kpiId); return k ? loc(k.name, lang) : kr.kpiId; }).join(' / ')}`)
        : issues.map((i) => `${name(i)} → ${kpisOf(i).map(name).join(' / ') || '—'}`);
      const dir = (k: EntityOf<'kpi'>) => L(lang, k.direction === 'decrease' ? { ja: '減らす', en: 'lower is better' } : { ja: '増やす', en: 'higher is better' });
      return {
        kpiTree: bullets(trees),
        formula: bullets(allKpis.map((k) => L(lang, { ja: `${name(k)}: ${loc(k.description, lang)}（単位 ${loc(k.unit, lang)}、${dir(k)}）`, en: `${name(k)}: ${loc(k.description, lang)} (unit ${loc(k.unit, lang)}, ${dir(k)})` }))),
        dataSource: bullets(allKpis.map((k) => {
          const src = sourcesOf(k);
          return `${name(k)}: ${src.length ? src.join(L(lang, { ja: '、', en: ', ' })) : L(lang, { ja: '出典なし（取得元を決める）', en: 'no source (decide where it comes from)' })}`;
        })),
        frequency: bullets(allKpis.map((k) => `${name(k)}: ${loc(k.period, lang)}`)),
        owner: bullets(allKpis.map((k) => `${name(k)}: ${roleOf(k.ownerId)}`)),
      };
    }
    case 'usecase': {
      const ucs = ctx.useCases.filter((u) => u.origin === 'registered');
      const kpiName = (id: string) => {
        const e = v.get(id);
        if (e?.kind === 'kpi') return `${name(e)} ${num(e.target, e.unit)}`;
        const p = ctx.kpi.kpis.find((k) => k.id === id);
        return p ? `${loc(p.name, lang)} ${num(p.target, p.unit)}` : null;
      };
      const solutions = uniq(ucs.flatMap((u) => u.relatedIds.map(v.get).filter((e): e is EntityOf<'solution'> => e?.kind === 'solution')));
      const internalUcs = ucs.filter((u) => u.relatedIds.some((id) => ctx.pack.byId.get(id)?.classification === 'internal')).length;
      return {
        actors: bullets(uniq(ucs.map((u) => u.persona)).map((p) => `${translate(lang, personaLabel(p) as MessageKey)}: ${ucs.filter((u) => u.persona === p).map((u) => loc(u.name, lang)).join(L(lang, { ja: '、', en: ', ' }))}`)),
        scenario: bullets(ucs.map((u) => `${loc(u.name, lang)}: ${u.steps.map((s) => loc(s.title, lang)).join(' → ')}`)),
        acceptance: bullets(ucs.map((u) => {
          const targets = u.relatedIds.map(kpiName).filter((x): x is string => x !== null);
          const effect = u.effect ? loc(u.effect, lang) : L(lang, { ja: '効果は未記入', en: 'effect not written' });
          return targets.length
            ? L(lang, { ja: `${loc(u.name, lang)}: ${effect}（KPI ${targets.join('、')} に達したら合格）`, en: `${loc(u.name, lang)}: ${effect} (accepted when KPI ${targets.join(', ')} is reached)` })
            : `${loc(u.name, lang)}: ${effect}`;
        })),
        dataNeeds: bullets(solutions.map((s) => `${name(s)}: ${s.msProducts.join(', ')}`)),
        risks: bullets([
          L(lang, { ja: '現場の操作の負荷が増えないこと（試行で手順を数える）', en: 'Field work must not get heavier (count the steps in the pilot)' }),
          L(lang, { ja: '必要なデータがそろうまで効果を測れない（現状分析のデータの不足を参照）', en: 'The effect cannot be measured until the data is in place (see the as-is data gaps)' }),
          internalUcs > 0 && audience === 'internal' ? L(lang, { ja: `社外秘の項目に関わるユースケース ${internalUcs} 件は共有の範囲に注意`, en: `${internalUcs} use cases touch internal items; watch the sharing scope` }) : '',
        ]),
      };
    }
    case 'plan': {
      const inits = [...v.of('initiative')].sort((a, b) => a.start.localeCompare(b.start));
      const solutions = v.of('solution');
      const solName = (id: string) => { const s = v.get(id); return s ? name(s) : '—'; };
      const cost = solutions.reduce((a, s) => a + s.costJpy, 0);
      const benefit = solutions.reduce((a, s) => a + s.annualBenefitJpy, 0);
      const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
      const lagging = inits.filter((i) => {
        const span = day(i.end) - day(i.start);
        if (span <= 0 || ctx.today <= i.start) return false;
        const expected = Math.min(1, (day(ctx.today) - day(i.start)) / span);
        return expected - i.progress > SCHEDULE_LAG_MAX;
      });
      const kpiOwnerOf = (solutionId: string) => {
        const s = v.get(solutionId);
        const k = s?.kind === 'solution' ? s.kpiIds.map(v.get).find((e) => e?.kind === 'kpi') : undefined;
        return k?.kind === 'kpi' ? roleOf(k.ownerId) : roleOf('');
      };
      const next = inits.find((i) => i.progress === 0 && i.start >= ctx.today) ?? inits.find((i) => i.progress < 1);
      const solOrInit = (id: string) => {
        const e = v.get(id);
        return e ? name(e) : id;
      };
      return {
        roadmap: bullets(inits.map((i) => L(lang, {
          ja: `${i.start}〜${i.end} ${name(i)}（${solName(i.solutionId)}、進捗 ${fmt.percent(i.progress)}${i.dependsOn.length ? `、前提: ${i.dependsOn.map(solOrInit).join('、')}` : ''}）`,
          en: `${i.start} – ${i.end} ${name(i)} (${solName(i.solutionId)}, ${fmt.percent(i.progress)} done${i.dependsOn.length ? `, after: ${i.dependsOn.map(solOrInit).join(', ')}` : ''})`,
        }))),
        businessCase: bullets([
          ...solutions.map((s) => L(lang, {
            ja: `${name(s)}: 投資 ${fmt.yenCompact(s.costJpy)}、年間効果 ${fmt.yenCompact(s.annualBenefitJpy)}、回収 ${fmt.number(s.costJpy / s.annualBenefitJpy)} 年（構築期間を含め ${fmt.number(paybackYears(s, inits))} 年）`,
            en: `${name(s)}: invest ${fmt.yenCompact(s.costJpy)}, annual benefit ${fmt.yenCompact(s.annualBenefitJpy)}, payback ${fmt.number(s.costJpy / s.annualBenefitJpy)} years (${fmt.number(paybackYears(s, inits))} years with the build period)`,
          })),
          L(lang, { ja: `合計: 投資 ${fmt.yenCompact(cost)}、年間効果 ${fmt.yenCompact(benefit)}（回収の上限は構築期間を含め ${fmt.number(paybackLimit(ctx.deliverables))} 年）`, en: `Total: invest ${fmt.yenCompact(cost)}, annual benefit ${fmt.yenCompact(benefit)} (payback limit ${fmt.number(paybackLimit(ctx.deliverables))} years, build period included)` }),
        ]),
        raci: bullets(inits.map((i) => L(lang, {
          ja: `${name(i)}: 実行責任（R）${roleOf(i.ownerId)} / 説明責任（A）${kpiOwnerOf(i.solutionId)} / 相談（C）IT 部門 / 報告（I）経営会議`,
          en: `${name(i)}: Responsible ${roleOf(i.ownerId)} / Accountable ${kpiOwnerOf(i.solutionId)} / Consulted IT / Informed executive meeting`,
        }))),
        risks: bullets([
          ...inits.filter((i) => i.dependsOn.length).map((i) => L(lang, { ja: `${name(i)} は前提の施策が遅れると連鎖して遅れる`, en: `${name(i)} slips if the initiative it depends on slips` })),
          ...lagging.map((i) => L(lang, { ja: `${name(i)} は予定より遅れている（進捗 ${fmt.percent(i.progress)}、${ctx.today} 時点）`, en: `${name(i)} is behind schedule (${fmt.percent(i.progress)} done as of ${ctx.today})` })),
          L(lang, { ja: '効果は KPI で確かめ、試行の結果が出るまで展開の投資を確定しない', en: 'Confirm the effect with the KPIs; do not commit the rollout budget before the pilot results' }),
        ]),
        ask: bullets([
          L(lang, { ja: `投資総額 ${fmt.yenCompact(cost)} の承認`, en: `Approve the total investment of ${fmt.yenCompact(cost)}` }),
          next ? L(lang, { ja: `次の施策「${name(next)}」の開始（${next.start}）`, en: `Start the next initiative "${name(next)}" (${next.start})` }) : '',
          L(lang, { ja: 'KPI の目標値と期限の確定', en: 'Fix the KPI targets and deadlines' }),
        ]),
      };
    }
  }
}

export function draftToText(fields: Record<string, string>): string {
  return Object.entries(fields).map(([id, text]) => `### ${id}\n${text}`).join('\n\n');
}

/** Reads "### fieldId" sections (the format asked from the model, and produced by the mock). Unknown ids are dropped. */
export function parseDraftText(step: ImprovementStep, text: string): Record<string, string> {
  const known = new Set(STEP_DEFS[step].fields.map((f) => f.id));
  const out: Record<string, string> = {};
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current && known.has(current)) {
      const body = buf.join('\n').trim();
      if (body) out[current] = body;
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{2,3}\s*([A-Za-z]+)\s*$/.exec(line.trim());
    if (m) {
      flush();
      current = m[1]!;
      buf = [];
    } else if (current) buf.push(line);
  }
  flush();
  return out;
}

/** The live prompt: what to write, the fields and the project data that is not in the entity context. */
export function draftPrompt(input: DraftInput): string {
  const { step, ctx, lang } = input;
  const tr = (k: MessageKey) => translate(lang, k);
  const fields = STEP_DEFS[step].fields.map((f) => `- ${f.id}: ${tr(fieldKey(step, f.id))} — ${tr(fieldHintKey(step, f.id))}`).join('\n');
  const project = {
    decisions: ctx.discussion.records.filter((r) => r.kind === 'decision').map((r) => loc(r.text, lang)),
    kpis: ctx.kpi.kpis.map((k) => ({ name: loc(k.name, lang), baseline: k.baseline, current: k.current, target: k.target, deadline: k.deadline })),
    useCases: ctx.useCases.filter((u) => u.origin === 'registered').map((u) => ({ name: loc(u.name, lang), effect: u.effect ? loc(u.effect, lang) : '', steps: u.steps.length })),
  };
  return [
    `${MARK}${step}]`,
    `Write a draft of "${tr(`dlv.${step}.name` as MessageKey)}" in ${lang === 'ja' ? 'Japanese' : 'English'}.`,
    'Use only the context entities and the project data below. Mark hypotheses as such and include numbers, units and dates where the data has them.',
    'Answer with one section per field, each starting with a line "### <fieldId>". Fields:',
    fields,
    `Project data: ${JSON.stringify(project)}`,
  ].join('\n');
}

let pending: DraftInput | null = null;

/** Entities the draft is grounded in (what a live model would receive, after redaction by the gate). */
export function draftEntities(ctx: CheckContext): Entity[] {
  const kinds = new Set(['issue', 'cause', 'kpi', 'solution', 'initiative', 'source']);
  return ctx.pack.pack.entities.filter((e) => kinds.has(e.kind));
}

export async function requestDeliverableDraft(input: DraftInput): Promise<{ response: AiResponse; fields: Record<string, string> }> {
  pending = input;
  // The use's only mock; registering again replaces it.
  registerMock('deliverableDraft', () => (pending ? draftToText(buildDraft(pending)) : ''));
  try {
    const response = await aiComplete({ use: 'deliverableDraft', lang: input.lang, prompt: draftPrompt(input), entities: draftEntities(input.ctx) });
    return { response, fields: parseDraftText(input.step, response.text) };
  } finally {
    pending = null;
  }
}
