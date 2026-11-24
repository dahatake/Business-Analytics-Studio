import type { EntityOf } from '../../data/schema.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../../state/projects.ts';
import { hrefFor } from '../../state/router.ts';
import { evaluateStep, hasNumber, isQualifiedOut, PAYBACK_MAX_YEARS, progressOf, rankedIssues, type CheckContext } from './deliverables.ts';
import { stepDashboard } from './stepDashboard.ts';

/**
 * FR-351: advice for each step, drawn from Mahan Khalsa and Randy Illig, "Let's Get Real or Let's Not Play":
 * qualify before solving, measure (how, now, wanted, the value of the difference), evidence over guesses, a solution has
 * no value of its own, check resources (time, people, money) and the decision process with the people who decide.
 *
 * Every item is a rule on the project's data, read from the same dashboard data the exit criteria use, so the advice
 * cannot disagree with them and disappears once the data is fixed. Nothing here calls an AI or invents a value; the only
 * numbers in a message are counts and the payback limit. Items that need a conversation, not data, are tone 'info'.
 */

export const ADVICE_PRINCIPLES = ['qualify', 'measure', 'evidence', 'quantify', 'noGuess', 'result', 'context', 'solution', 'resources', 'decision', 'inquiry'] as const;
export type AdvicePrinciple = (typeof ADVICE_PRINCIPLES)[number];

/** yellow: the data shows something to fix or check. info: a conversation or a hypothesis to keep in mind. green: nothing open. */
export type AdviceTone = 'yellow' | 'info' | 'green';

export interface AdviceItem {
  /** Message key suffix `proj.advice.item.<id>`. */
  id: string;
  tone: AdviceTone;
  principle: AdvicePrinciple;
  /** Where the user fixes it (hash path); null when the advice is a conversation. */
  href: string | null;
  /** Pack entity ids the advice is about (the screen shows the visible ones). */
  refs: string[];
  /** Counts and limits for the message; `step` is a step id and `status` a KPI definition status. */
  vars: Record<string, string | number>;
}

const ORDER: Record<AdviceTone, number> = { yellow: 0, green: 1, info: 2 };

export function discoveryAdvice(step: ImprovementStep, c: CheckContext): AdviceItem[] {
  const dash = stepDashboard(step, c);
  const d = dash.detail;
  const items: AdviceItem[] = [];
  const add = (id: string, tone: AdviceTone, principle: AdvicePrinciple, href: string | null, vars: AdviceItem['vars'] = {}, refs: string[] = []) => {
    items.push({ id, tone, principle, href, refs, vars });
  };
  const flag = (id: string, principle: AdvicePrinciple, href: string, n: number, refs: string[] = [], vars: AdviceItem['vars'] = {}) => {
    if (n > 0) add(id, 'yellow', principle, href, { n, ...vars }, refs);
  };
  const tile = (id: string) => dash.tiles.find((t) => t.id === id);
  const open = (tileId: string) => { const t = tile(tileId); return t && t.total > 0 ? t.total - t.value : 0; };
  const doc = hrefFor('/deliverables', { step, target: 'dlv-fields' });
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  const issues = rankedIssues(c.pack);
  const pursued = issues.filter((i) => !isQualifiedOut(c.deliverables, i.id));
  const out = issues.length - pursued.length;

  switch (d.step) {
    case 'asis': {
      const unqualified = d.issues.filter((i) => !i.verdict);
      flag('unqualified', 'qualify', hrefFor('/step', { step, target: 'step-dash-issues' }), unqualified.length, ids(unqualified));
      const unmeasured = d.issues.filter((i) => !i.measured);
      flag('unmeasured', 'measure', hrefFor('/relations', { view: 'table', target: 'relation-table' }), unmeasured.length, ids(unmeasured));
      const noBaseline = d.kpis.filter((k) => !Number.isFinite(k.baseline) || !Number.isFinite(k.current) || !k.period.ja.trim() || !k.period.en.trim() || k.target === k.baseline);
      flag('noBaseline', 'measure', hrefFor('/analysis', { tab: 'kpi', target: 'proj-kpi-panel' }), noBaseline.length, ids(noBaseline));
      const unsourced = d.issues.filter((i) => !i.sourced);
      flag('unsourced', 'evidence', hrefFor('/relations', { view: 'table', target: 'relation-table' }), unsourced.length + open('causesSourced'), ids(unsourced));
      const vague = Object.entries(c.deliverables.qualifications ?? {}).filter(([id, q]) => c.pack.byId.get(id)?.kind === 'issue' && !hasNumber(q.reason));
      flag('reasonNoNumber', 'quantify', hrefFor('/step', { step, target: 'step-dash-issues' }), vague.length, vague.map(([id]) => id));
      flag('mismatch', 'noGuess', hrefFor('/discussion', { target: 'proj-canvas' }), d.mismatches.length);
      if (issues.length > 0 && pursued.length === 0) add('allDeclined', 'info', 'qualify', null);
      break;
    }
    case 'tobe': {
      const uncovered = d.topIssues.filter((i) => i.useCaseIds.length === 0);
      flag('topUncovered', 'result', hrefFor('/usecases', { target: 'uc-list' }), uncovered.length, ids(uncovered));
      flag('thinUseCases', 'quantify', hrefFor('/usecases', { target: 'uc-list' }), d.useCases.filter((u) => u.steps < 3 || !u.hasEffect).length);
      if (d.objectives.length === 0) add('noObjectives', 'yellow', 'context', hrefFor('/projects', { target: 'proj-active' }));
      else if (!d.objectives.some((o) => o.linked)) add('objectivesUnlinked', 'yellow', 'context', hrefFor('/projects', { target: 'proj-active' }));
      const proposed = d.proposed.kpis.length + d.proposed.okrs.length;
      if (proposed > 0) add('proposedKpis', 'info', 'noGuess', hrefFor('/analysis', { tab: 'kpi', target: 'proj-kpi-panel' }), { n: proposed });
      break;
    }
    case 'kpi': {
      if (d.definition !== 'defined') add('definitionOpen', 'yellow', 'measure', hrefFor('/deliverables', { step, target: 'sol-def' }), { status: d.definition });
      const analysis = hrefFor('/analysis', { tab: 'kpi', target: 'proj-kpi-panel' });
      flag('kpiInvalid', 'measure', analysis, d.kpis.filter((k) => !k.valid).length);
      flag('kpiPast', 'quantify', analysis, d.kpis.filter((k) => !k.ahead).length);
      flag('untracked', 'measure', analysis, open('issuesTracked'));
      flag('okrUnaligned', 'context', hrefFor('/deliverables', { step, target: 'sol-def' }), open('okrsAligned'));
      flag('okrDangling', 'measure', hrefFor('/analysis', { tab: 'kpi', target: 'proj-okr-panel' }), open('okrsLinked'));
      const own = d.kpis.filter((k) => k.origin === 'proposed').length;
      if (own > 0) add('proposedKpi', 'info', 'noGuess', analysis, { n: own });
      break;
    }
    case 'solution': {
      const unsolved = d.issues.filter((i) => i.solutionIds.length === 0);
      flag('unsolved', 'solution', hrefFor('/relations', { view: 'table', target: 'relation-table' }), unsolved.length, ids(unsolved));
      const orphans = c.pack.pack.entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution' && e.issueIds.length > 0 && e.issueIds.every((id) => isQualifiedOut(c.deliverables, id)));
      flag('orphanSolution', 'solution', hrefFor('/deliverables', { step, target: 'sol-types' }), orphans.length, ids(orphans));
      flag('noContribution', 'quantify', hrefFor('/deliverables', { step, target: 'sol-types' }), d.solutions.filter((s) => s.contributions === 0).length);
      flag('gapOpen', 'quantify', hrefFor('/deliverables', { step, target: 'sol-sim' }), d.coverage.filter((r) => r.coverage !== undefined && r.coverage !== null && r.coverage < 1).length);
      flag('simWarnings', 'noGuess', hrefFor('/deliverables', { step, target: 'sol-sim' }), d.sims.filter((s) => s.warnings.length > 0).length);
      const inferred = d.solutions.filter((s) => !s.confirmed);
      if (inferred.length > 0) add('typesUnconfirmed', 'info', 'noGuess', hrefFor('/deliverables', { step, target: 'sol-types' }), { n: inferred.length }, ids(inferred));
      if (out > 0 && pursued.length > 0) add('declined', 'info', 'qualify', hrefFor('/step', { step: 'asis', target: 'step-dash-issues' }), { n: out });
      break;
    }
    case 'deliverable': {
      const unowned = d.initiatives.filter((i) => !i.ownerId);
      flag('noOwner', 'resources', hrefFor('/plan', { target: 'plan-table' }), unowned.length, ids(unowned));
      const conflicts = d.initiatives.filter((i) => i.conflict);
      flag('schedule', 'resources', hrefFor('/plan', { target: 'gantt-panel' }), conflicts.length, ids(conflicts));
      const late = d.solutions.filter((s) => s.payback !== null && s.payback > d.paybackLimit);
      flag('paybackOver', 'resources', hrefFor('/plan', { target: 'plan-table' }), late.length, ids(late), { years: d.paybackLimit });
      if (c.deliverables.criteria?.paybackMaxYears === undefined) add('paybackAssumed', 'info', 'resources', hrefFor('/deliverables', { step, target: 'dlv-criteria' }), { years: PAYBACK_MAX_YEARS });
      flag('chain', 'context', hrefFor('/deliverables', { step, target: 'sol-thread' }), d.gaps);
      if (tile('planDecisions')?.value === 0) add('noDecision', 'yellow', 'decision', hrefFor('/discussion', { target: 'proj-canvas' }));
      const docs = c.deliverables.docs.deliverable ?? {};
      if (!docs.ask?.text.trim()) add('noAsk', 'yellow', 'decision', hrefFor('/deliverables', { step, target: 'dlv-field-ask' }));
      if (!docs.raci?.text.trim()) add('noRaci', 'yellow', 'decision', hrefFor('/deliverables', { step, target: 'dlv-field-raci' }));
      break;
    }
  }

  // After the step's own rules: what applies to every step.
  if (step !== 'asis' && issues.length > 0 && pursued.length === 0) add('noPursued', 'info', 'qualify', hrefFor('/step', { step: 'asis', target: 'step-dash-issues' }));
  const byAi = Object.values(c.deliverables.docs[step] ?? {}).filter((v) => v.author === 'ai' && !v.approved && v.text.trim()).length;
  flag('aiUnconfirmed', 'noGuess', doc, byAi);
  flag('docVague', 'quantify', doc, dash.doc.vague);
  const previous = IMPROVEMENT_STEPS[IMPROVEMENT_STEPS.indexOf(step) - 1];
  if (previous && !progressOf(evaluateStep(previous, c)).complete) add('upstream', 'info', 'noGuess', hrefFor('/step', { step: previous }), { step: previous });
  const unsigned = dash.results.find((r) => r.todo.kind === 'manual' && !r.done);
  if (unsigned) add(`agree.${step}`, 'info', 'decision', hrefFor('/deliverables', { step, target: `dlv-sign-${unsigned.todo.id}` }));

  if (!items.some((i) => i.tone === 'yellow')) add('clear', 'green', 'inquiry', null);
  add(`ask.${step}`, 'info', 'inquiry', null);
  return items.sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
}
