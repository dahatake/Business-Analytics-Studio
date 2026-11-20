import { rankIssues, type PriorityWeights } from '../../domain/priority.ts';
import type { EntityOf } from '../../data/schema.ts';

/**
 * FR-358: prioritisation aids for every step and for the Project pack run.
 *
 * Nothing here calls an AI or the web. The sources are a fixed, reviewed catalogue (each one can be opened and read by a person);
 * the numbers are counts over the project's own issues, rated 1–5 on impact and feasibility.
 */

export type SourceKind = 'hbr' | 'design' | 'paper' | 'book' | 'practice';

export interface PrioritySource {
  id: string;
  kind: SourceKind;
  /** Bibliographic line; language-neutral on purpose (titles are quoted as published). */
  cite: string;
  /** Absent when the work has no stable public page (the citation alone locates it). */
  url?: string;
}

export const PRIORITY_SOURCES: readonly PrioritySource[] = [
  { id: 'brown2008', kind: 'hbr', cite: 'Tim Brown, "Design Thinking", Harvard Business Review, June 2008', url: 'https://hbr.org/2008/06/design-thinking' },
  { id: 'porter2008', kind: 'hbr', cite: 'Michael E. Porter, "The Five Competitive Forces That Shape Strategy", Harvard Business Review, January 2008', url: 'https://hbr.org/2008/01/the-five-competitive-forces-that-shape-strategy' },
  { id: 'kaplanNorton1992', kind: 'hbr', cite: 'Robert S. Kaplan and David P. Norton, "The Balanced Scorecard: Measures That Drive Performance", Harvard Business Review, January–February 1992', url: 'https://hbr.org/1992/01/the-balanced-scorecard-measures-that-drive-performance-2' },
  { id: 'kaplanNorton2000', kind: 'hbr', cite: 'Robert S. Kaplan and David P. Norton, "Having Trouble with Your Strategy? Then Map It", Harvard Business Review, September–October 2000', url: 'https://hbr.org/2000/09/having-trouble-with-your-strategy-then-map-it' },
  { id: 'christensen2016', kind: 'hbr', cite: 'Clayton M. Christensen, Taddy Hall, Karen Dillon and David S. Duncan, "Know Your Customers\' Jobs to Be Done", Harvard Business Review, September 2016', url: 'https://hbr.org/2016/09/know-your-customers-jobs-to-be-done' },
  { id: 'lovallo2003', kind: 'hbr', cite: 'Dan Lovallo and Daniel Kahneman, "Delusions of Success: How Optimism Undermines Executives\' Decisions", Harvard Business Review, July 2003', url: 'https://hbr.org/2003/07/delusions-of-success-how-optimism-undermines-executives-decisions' },
  { id: 'kahneman2011', kind: 'hbr', cite: 'Daniel Kahneman, Dan Lovallo and Olivier Sibony, "Before You Make That Big Decision…", Harvard Business Review, June 2011', url: 'https://hbr.org/2011/06/the-big-idea-before-you-make-that-big-decision' },
  { id: 'dschool', kind: 'design', cite: 'Hasso Plattner Institute of Design at Stanford (d.school), "Design Thinking Bootleg"', url: 'https://dschool.stanford.edu/resources/design-thinking-bootleg' },
  { id: 'ideo', kind: 'design', cite: 'IDEO.org, "The Field Guide to Human-Centered Design", 2015', url: 'https://www.designkit.org/' },
  { id: 'buehler1994', kind: 'paper', cite: 'Roger Buehler, Dale Griffin and Michael Ross, "Exploring the \'planning fallacy\'", Journal of Personality and Social Psychology 67(3), 1994, 366–381', url: 'https://doi.org/10.1037/0022-3514.67.3.366' },
  { id: 'tversky1974', kind: 'paper', cite: 'Amos Tversky and Daniel Kahneman, "Judgment under Uncertainty: Heuristics and Biases", Science 185(4157), 1974, 1124–1131', url: 'https://doi.org/10.1126/science.185.4157.1124' },
  { id: 'rittel1973', kind: 'paper', cite: 'Horst W. J. Rittel and Melvin M. Webber, "Dilemmas in a general theory of planning", Policy Sciences 4, 1973, 155–169', url: 'https://doi.org/10.1007/BF01405730' },
  { id: 'khalsa1999', kind: 'book', cite: 'Mahan Khalsa and Randy Illig, "Let\'s Get Real or Let\'s Not Play", 1999' },
  { id: 'rice', kind: 'practice', cite: 'Intercom, "RICE: Simple prioritization for product managers" (practitioner blog, not peer reviewed)', url: 'https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/' },
];

export const PRIORITY_METHODS = {
  qualify: ['khalsa1999'],
  impactEffort: ['dschool', 'ideo', 'rice'],
  framing: ['rittel1973', 'brown2008'],
  jobs: ['christensen2016', 'ideo'],
  anchoring: ['tversky1974', 'kahneman2011'],
  forces: ['porter2008'],
  scorecard: ['kaplanNorton1992', 'kaplanNorton2000'],
  outsideView: ['lovallo2003', 'kahneman2011', 'buehler1994'],
} as const satisfies Record<string, readonly string[]>;
export type PriorityMethodId = keyof typeof PRIORITY_METHODS;

export const PRIORITY_STEPS = ['asis', 'tobe', 'kpi', 'solution', 'deliverable'] as const;
export type PriorityStep = (typeof PRIORITY_STEPS)[number];

/** The methods worth reading at each step, most useful first. */
export const STEP_METHODS: Record<PriorityStep, readonly PriorityMethodId[]> = {
  asis: ['qualify', 'impactEffort', 'framing', 'jobs', 'anchoring'],
  tobe: ['jobs', 'impactEffort', 'forces', 'anchoring'],
  kpi: ['scorecard', 'qualify', 'anchoring'],
  solution: ['impactEffort', 'outsideView', 'anchoring'],
  deliverable: ['outsideView', 'qualify', 'impactEffort'],
};

export const sourceById = (id: string): PrioritySource => {
  const s = PRIORITY_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown priority source: ${id}`);
  return s;
};

export const sourcesOf = (methods: readonly PriorityMethodId[]): PrioritySource[] =>
  [...new Set(methods.flatMap((m) => PRIORITY_METHODS[m]))].map(sourceById);

/** Impact × feasibility quadrant. "High" is 4 or more on the 1–5 scale. */
export type Quadrant = 'quickWin' | 'bigBet' | 'fillIn' | 'reconsider';
export const HIGH_RATING = 4;

export function quadrantOf(impact: number, feasibility: number): Quadrant {
  const hi = impact >= HIGH_RATING;
  const easy = feasibility >= HIGH_RATING;
  return hi ? (easy ? 'quickWin' : 'bigBet') : easy ? 'fillIn' : 'reconsider';
}

export interface PriorityInput {
  id: string;
  impact: number;
  feasibility: number;
  /** Cites a source. */
  sourced: boolean;
  /** Is measured by at least one KPI. */
  measured: boolean;
}

export interface PriorityCandidate extends PriorityInput {
  rank: number;
  score: number;
  quadrant: Quadrant;
}

export interface PriorityStats {
  n: number;
  quickWin: number;
  bigBet: number;
  fillIn: number;
  reconsider: number;
  /** Candidates whose rating rests on no source or no measurement: rank them after finding evidence. */
  unproven: number;
}

export interface PriorityAnalysis {
  version: 1;
  basis: 'pack';
  stats: PriorityStats;
  /** Ranked by the weighted score (impact 60 / feasibility 40), best first. */
  candidates: PriorityCandidate[];
  methods: PriorityMethodId[];
  sourceIds: string[];
}

export const PRIORITY_WEIGHTS: PriorityWeights = { impact: 60, feasibility: 40 };

export function analyzeCandidates(inputs: PriorityInput[]): { candidates: PriorityCandidate[]; stats: PriorityStats } {
  const byId = new Map(inputs.map((i) => [i.id, i]));
  const ranked = rankIssues(
    inputs.map((i) => ({ id: i.id, impact: i.impact, feasibility: i.feasibility }) as EntityOf<'issue'>),
    PRIORITY_WEIGHTS,
  );
  const candidates = ranked.map((r) => {
    const i = byId.get(r.issue.id)!;
    return { ...i, rank: r.rank, score: r.score, quadrant: quadrantOf(i.impact, i.feasibility) };
  });
  const count = (q: Quadrant) => candidates.filter((c) => c.quadrant === q).length;
  return {
    candidates,
    stats: {
      n: candidates.length,
      quickWin: count('quickWin'),
      bigBet: count('bigBet'),
      fillIn: count('fillIn'),
      reconsider: count('reconsider'),
      unproven: candidates.filter((c) => !c.sourced || !c.measured).length,
    },
  };
}

/** The analysis run on the issues a Project pack run has just produced. */
export function analyzePackPriority(entities: readonly { kind?: unknown; id?: unknown; impact?: unknown; feasibility?: unknown; sourceIds?: unknown; kpiIds?: unknown }[]): PriorityAnalysis {
  const inputs: PriorityInput[] = entities.flatMap((e) =>
    e.kind === 'issue' && typeof e.id === 'string' && typeof e.impact === 'number' && typeof e.feasibility === 'number'
      ? [{
        id: e.id, impact: e.impact, feasibility: e.feasibility,
        sourced: Array.isArray(e.sourceIds) && e.sourceIds.length > 0,
        measured: Array.isArray(e.kpiIds) && e.kpiIds.length > 0,
      }]
      : []);
  const { candidates, stats } = analyzeCandidates(inputs);
  const methods: PriorityMethodId[] = ['qualify', 'impactEffort', 'anchoring'];
  return { version: 1, basis: 'pack', stats, candidates, methods, sourceIds: sourcesOf(methods).map((s) => s.id) };
}
