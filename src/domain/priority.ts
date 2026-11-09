import type { EntityOf } from '../data/schema.ts';

export interface PriorityWeights {
  impact: number;
  feasibility: number;
}

export interface RankedIssue {
  issue: EntityOf<'issue'>;
  score: number;
  rank: number;
}

/** Weighted score on 0–100. Scores 1..5 are normalized to 0..1 so weights stay interpretable. */
export function priorityScore(issue: Pick<EntityOf<'issue'>, 'impact' | 'feasibility'>, w: PriorityWeights): number {
  const sum = w.impact + w.feasibility;
  if (sum <= 0) return 0;
  const n = (v: number) => (v - 1) / 4;
  return Math.round(((w.impact * n(issue.impact) + w.feasibility * n(issue.feasibility)) / sum) * 100);
}

export function rankIssues(issues: EntityOf<'issue'>[], w: PriorityWeights): RankedIssue[] {
  return issues
    .map((issue) => ({ issue, score: priorityScore(issue, w), rank: 0 }))
    .sort((a, b) => b.score - a.score || b.issue.impact - a.issue.impact || a.issue.id.localeCompare(b.issue.id))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
