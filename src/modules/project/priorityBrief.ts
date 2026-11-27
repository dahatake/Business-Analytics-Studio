import { isQualifiedOut, rankedIssues, type CheckContext } from './deliverables.ts';
import { isProvisionalRating, projectTriage } from './issueTriage.ts';
import { analyzeCandidates, sourcesOf, STEP_METHODS, type PriorityCandidate, type PriorityInput, type PriorityMethodId, type PriorityStats, type PrioritySource, type PriorityStep } from './priorityAnalysis.ts';
import { stepDashboard } from './stepDashboard.ts';

/**
 * FR-358: the executive summary shown on each step screen. The wording comes from the dictionary (`proj.prio.*`);
 * this module only counts the project's own data and chooses which lines apply, so a summary never states more than the data supports.
 */

/** focus: act on this first. caution: the ranking is weak here. info: a bias to keep in mind. */
export type EmphasisTone = 'focus' | 'caution' | 'info';

export interface Emphasis {
  /** Message key suffix `proj.prio.emph.<id>`. */
  id: string;
  tone: EmphasisTone;
  vars: Record<string, number>;
}

export interface PriorityBrief {
  step: PriorityStep;
  stats: PriorityStats;
  /** Variables of `proj.prio.summary.<step>`. */
  vars: Record<string, number>;
  /** Up to the three best-ranked issues still being pursued. */
  candidates: PriorityCandidate[];
  emphasis: Emphasis[];
  methods: readonly PriorityMethodId[];
  sources: PrioritySource[];
}

const TOP = 3;

/**
 * The issues still being pursued, with whether each cites a source and is measured by a KPI (as the As-is step counts them).
 * FR-383: issues that Ansoff's table sets aside (monitor, review, drop) are not candidates for action and are left out.
 */
export function priorityInputs(c: CheckContext): PriorityInput[] {
  const asis = stepDashboard('asis', c).detail;
  const evidence = new Map((asis.step === 'asis' ? asis.issues : []).map((i) => [i.id, i]));
  const gated = new Set(projectTriage(c).gated);
  return rankedIssues(c.pack)
    .filter((i) => !isQualifiedOut(c.deliverables, i.id) && !gated.has(i.id))
    .map((i) => ({
      id: i.id, impact: i.impact, feasibility: i.feasibility, sourced: evidence.get(i.id)?.sourced ?? false, measured: evidence.get(i.id)?.measured ?? false,
      provisional: isProvisionalRating(i.description),
    }));
}

export function priorityBrief(step: PriorityStep, c: CheckContext): PriorityBrief {
  const dash = stepDashboard(step, c);
  const d = dash.detail;
  const { candidates, stats } = analyzeCandidates(priorityInputs(c));

  const tile = (id: string) => dash.tiles.find((t) => t.id === id);
  const open = (id: string) => { const t = tile(id); return t && t.total > 0 ? t.total - t.value : 0; };
  const vars: Record<string, number> = { n: stats.n, quick: stats.quickWin, big: stats.bigBet, unproven: stats.unproven };
  const emphasis: Emphasis[] = [];
  const push = (id: string, tone: EmphasisTone, v: Record<string, number> = {}) => { emphasis.push({ id, tone, vars: v }); };

  if (stats.n === 0) push('none', 'caution');
  else if (stats.n === 1) push('single', 'caution');

  switch (d.step) {
    case 'asis':
    case 'tobe': {
      if (d.step === 'tobe') {
        const uncovered = d.topIssues.filter((i) => i.useCaseIds.length === 0).length;
        vars.uncovered = uncovered;
        vars.top = d.topIssues.length;
        if (uncovered > 0) push('uncovered', 'focus', { n: uncovered });
      }
      // FR-383: Ansoff's table first — a pressing major issue outranks a quick win; set-aside issues are named, not ranked.
      const tri = projectTriage(c);
      if (tri.counts.act > 0) push('pressing', 'focus', { n: tri.counts.act });
      if (tri.gated.length > 0) push('gated', 'info', { n: tri.gated.length });
      if (stats.quickWin > 0) push('quickWin', 'focus', { n: stats.quickWin });
      else if (stats.bigBet > 0) push('bigBetOnly', 'caution', { n: stats.bigBet });
      if (stats.unproven > 0) push('unproven', 'caution', { n: stats.unproven });
      break;
    }
    case 'kpi': {
      const untracked = open('issuesTracked');
      vars.untracked = untracked;
      vars.proposed = d.kpis.filter((k) => k.origin === 'proposed').length;
      if (untracked > 0) push('untracked', 'focus', { n: untracked });
      if (vars.proposed > 0) push('proposedKpi', 'caution', { n: vars.proposed });
      break;
    }
    case 'solution': {
      const unsolved = d.issues.filter((i) => i.solutionIds.length === 0).length;
      const unestimated = d.solutions.filter((s) => s.contributions === 0).length;
      vars.unsolved = unsolved;
      vars.unestimated = unestimated;
      if (unsolved > 0) push('unsolved', 'focus', { n: unsolved });
      if (unestimated > 0) push('unestimated', 'caution', { n: unestimated });
      push('outside', 'info');
      break;
    }
    case 'deliverable': {
      const late = d.solutions.filter((s) => s.payback !== null && s.payback > d.paybackLimit).length;
      const noOwner = d.initiatives.filter((i) => !i.ownerId).length;
      vars.late = late;
      vars.noOwner = noOwner;
      vars.years = d.paybackLimit;
      if (late > 0) push('late', 'focus', { n: late, years: d.paybackLimit });
      if (noOwner > 0) push('noOwner', 'caution', { n: noOwner });
      push('outside', 'info');
      break;
    }
  }
  if (step !== 'solution' && step !== 'deliverable') push('anchor', 'info');

  const methods = STEP_METHODS[step];
  return { step, stats, vars, candidates: candidates.slice(0, TOP), emphasis, methods, sources: sourcesOf(methods) };
}
