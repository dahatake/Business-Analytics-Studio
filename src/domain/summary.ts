import { entitiesOf, getEntity, loaded } from '../data/pack.ts';
import { makeFormatters, pick, translate, type Lang } from '../i18n/core.ts';
import { PARAMS } from '../config/params.ts';
import { kpiStatus } from './kpi.ts';
import { rankIssues, type PriorityWeights } from './priority.ts';

export const DEFAULT_WEIGHTS: PriorityWeights = { impact: 60, feasibility: 40 };

/** Executive summary in PARAM-015 sentences, from data only (deterministic, no AI). Respects the audience. */
export function executiveSummary(lang: Lang, audience: 'internal' | 'external', weights: PriorityWeights = DEFAULT_WEIGHTS): string[] {
  const fmt = makeFormatters(lang);
  const visible = <T extends { classification: string }>(xs: T[]) => xs.filter((x) => audience === 'internal' || x.classification === 'shareable');
  const sentences: string[] = [];

  const top = rankIssues(visible(entitiesOf('issue')), weights)[0];
  if (top) {
    const solution = visible(entitiesOf('solution')).find((s) => s.issueIds.includes(top.issue.id));
    sentences.push(solution
      ? translate(lang, 'summary.topIssue', { company: pick(lang, loaded.pack.company.name), issue: pick(lang, top.issue.name), score: top.score, solution: pick(lang, solution.name), benefit: fmt.yenCompact(solution.annualBenefitJpy) })
      : translate(lang, 'summary.topIssueNoSolution', { company: pick(lang, loaded.pack.company.name), issue: pick(lang, top.issue.name), score: top.score }));
  }

  const kpis = visible(entitiesOf('kpi'));
  const counts = { achieved: 0, progressing: 0, regressed: 0 };
  kpis.forEach((k) => { counts[kpiStatus(k)] += 1; });
  sentences.push(translate(lang, 'summary.kpis', { total: kpis.length, achieved: counts.achieved, progressing: counts.progressing, regressed: counts.regressed }));

  const overdue = visible(entitiesOf('invoice')).filter((i) => i.status === 'overdue');
  if (overdue.length > 0) {
    const first = overdue[0]!;
    const deliverable = getEntity(first.deliverableId);
    sentences.push(audience === 'internal'
      ? translate(lang, 'summary.overdue', { count: overdue.length, amount: fmt.yenCompact(overdue.reduce((a, i) => a + i.amountJpy, 0)), example: deliverable ? pick(lang, deliverable.name) : first.id })
      : translate(lang, 'summary.overdueExternal', { count: overdue.length }));
  }
  return sentences.slice(0, PARAMS.summarySentencesMax);
}
