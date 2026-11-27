import { DelayCostExtension } from '../../data/extensionSchemas.ts';
import { delayInputs, type DelayEntity } from './costOfDelay.ts';
import { isQualifiedOut, type CheckContext, type DelayEstimate, type Situation } from './deliverables.ts';
import { mulberry32, SIM_RUNS, triangular, triangularMean, type Range3 } from './simulate.ts';

/**
 * FR-383: what to do with each issue — respond now, plan a response, monitor, review periodically or drop — from its impact and
 * its urgency, as in Ansoff's strategic issue management (Strategic Management Journal 1(2), 1980, Table 5).
 *
 * - Urgency is not a 1–5 judgement. Ansoff determines it "by comparing estimates of the timing of the impact … and of the time
 *   needed" to respond. Slack = E[months until the impact] − E[months to respond]: ≤ 0 pressing (the response cannot finish
 *   in time even if it starts now), ≤ one planning cycle (PARAM-218) significant, more low. The time to respond is the Cost of
 *   Delay duration (person → material → initiatives); the time of impact comes only from a person or the material. Without both,
 *   the urgency stays unrated: it is never derived from a KPI deadline or filled with a default.
 * - The combination is non-compensatory: a high feasibility never lifts a low impact into action. Every row of Ansoff's table keeps
 *   a low-impact issue out of action (drop, review or monitor), so a low-impact issue is set aside even while its urgency is unrated.
 * - Growth (Kepner-Tregoe: seriousness, urgency, growth): whether the issue's KPIs moved the wrong way from baseline to current.
 *   Shown, and used to pick which issue's timing to estimate first; it does not change the disposition.
 *
 * No AI or web call. Each issue has its own seed, so adding an issue does not move another issue's numbers.
 */

export const IMPACT_LEVELS = ['low', 'significant', 'major'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];
export const URGENCY_LEVELS = ['low', 'significant', 'pressing'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];
export type AnsoffDisposition = 'act' | 'plan' | 'monitor' | 'review' | 'drop';
/** unassessed: impact significant or major, urgency not yet known (still a candidate for action). */
export type Disposition = AnsoffDisposition | 'unassessed';
export type Growth = 'worsening' | 'flat' | 'improving' | 'unknown';
export type ImpactTimeOrigin = 'human' | 'pack';
export type ResponseOrigin = 'human' | 'pack' | 'initiative';
export type TimingNeed = 'impact' | 'response' | 'both';

/** PARAM-217: an impact rating of 4 or more is major (the "high" of the impact × feasibility quadrants), 3 is significant, 1–2 low. */
export const IMPACT_THRESHOLDS = { major: 4, significant: 3 } as const;
/** PARAM-218 (provisional): one planning cycle in months; a response that can start within it is "significant", later "low". */
export const PLANNING_CYCLE_MONTHS = 12;
/**
 * PARAM-220 (provisional): the planning cycle once a person confirmed the business situation (FR-385, Watkins' STARS). A turnaround is
 * steered quarter by quarter, a realignment, accelerated growth or start-up half-yearly, sustaining success on the annual plan.
 */
export const SITUATION_CYCLE_MONTHS: Readonly<Record<Situation, number>> = { turnaround: 3, realignment: 6, acceleratedGrowth: 6, startUp: 6, sustainingSuccess: 12 };
const DEFAULT_SEED = 19800401;

/**
 * Ansoff (1980) Table 5, urgency × impact. Two cells name two responses ("drop or periodic review", "periodic review or monitoring");
 * the more attentive one is taken so that no issue is dropped on a tie.
 */
export const ANSOFF_TABLE: Readonly<Record<UrgencyLevel, Readonly<Record<ImpactLevel, AnsoffDisposition>>>> = {
  low: { low: 'drop', significant: 'review', major: 'monitor' },
  significant: { low: 'review', significant: 'monitor', major: 'plan' },
  pressing: { low: 'monitor', significant: 'monitor', major: 'act' },
};
export const DISPOSITION_ORDER: readonly Disposition[] = ['act', 'unassessed', 'plan', 'monitor', 'review', 'drop'];
/** The dispositions that keep an issue among the candidates for action (ranking, rank acceptability, Cost of Delay). */
export const ACTION_DISPOSITIONS: ReadonlySet<Disposition> = new Set<Disposition>(['act', 'unassessed', 'plan']);

/**
 * PARAM-219 (provisional): what each impact / feasibility rating means, so that people and Copilot rate on one scale (Kahneman et al.
 * 2016: shared rules reduce noise). Feasibility 1 is the uncontrollable issue of Jackson and Dutton (1988).
 */
export const RATING_ANCHORS: Readonly<Record<'impact' | 'feasibility', Readonly<Record<1 | 2 | 3 | 4 | 5, { ja: string; en: string }>>>> = {
  impact: {
    5: { ja: '会社全体の売上・利益・顧客・事業の継続、または中期計画の重点目標を左右する', en: 'Decides company-wide revenue, profit, customers or continuity, or a priority goal of the medium-term plan' },
    4: { ja: '1 つの事業・主要な顧客群・主要な KPI に大きく効く', en: 'Moves one business, a major customer group or a key KPI a lot' },
    3: { ja: '1 つの部門・業務の成果に効く', en: 'Moves the results of one department or process' },
    2: { ja: '一部の業務の手間や品質に効くが、成果への影響は小さい', en: 'Affects the effort or quality of some work, with little effect on results' },
    1: { ja: '影響は限られる、または確かでない', en: 'Limited or uncertain effect' },
  },
  feasibility: {
    5: { ja: '自部門の権限と今ある手段で、数か月以内に解決できる', en: 'Solvable within a few months with the team\'s own authority and existing means' },
    4: { ja: '自社の権限の中で、小さな投資・調整で解決できる', en: 'Solvable within the company\'s authority with a small investment or adjustment' },
    3: { ja: '部門をまたぐ調整か、中程度の投資が要る', en: 'Needs cross-department coordination or a moderate investment' },
    2: { ja: '大きな投資・組織の変更・社外の協力が要る', en: 'Needs a large investment, an organisational change or outside cooperation' },
    1: { ja: '自社では制御できない（規制・市場・他社しだい）', en: 'Outside the company\'s control (regulation, market or other firms)' },
  },
};

/** The anchors as one line of a generation rule ("impact: 5 = …; 4 = …"). */
export function ratingAnchorRule(lang: 'ja' | 'en'): string {
  const line = (kind: 'impact' | 'feasibility') => `${kind}: ${([5, 4, 3, 2, 1] as const).map((n) => `${n} = ${RATING_ANCHORS[kind][n][lang]}`).join(lang === 'ja' ? '／' : '; ')}`;
  return `${line('impact')}. ${line('feasibility')}.`;
}

const PROVISIONAL_MARKS = ['【仮評価】', '[Provisional rating]'];/** The generation rule marks a rating given without evidence (a provisional 3) in the issue description. */
export function isProvisionalRating(description: unknown): boolean {
  const texts = typeof description === 'string' ? [description] : description && typeof description === 'object' ? Object.values(description) : [];
  return texts.some((t) => typeof t === 'string' && PROVISIONAL_MARKS.some((m) => t.includes(m)));
}

export function impactLevel(impact: number): ImpactLevel {
  return impact >= IMPACT_THRESHOLDS.major ? 'major' : impact >= IMPACT_THRESHOLDS.significant ? 'significant' : 'low';
}

export function urgencyLevel(slackMonths: number, cycleMonths = PLANNING_CYCLE_MONTHS): UrgencyLevel {
  return slackMonths <= 0 ? 'pressing' : slackMonths <= cycleMonths ? 'significant' : 'low';
}

export function dispositionOf(impact: ImpactLevel, urgency: UrgencyLevel | null): Disposition {
  if (urgency) return ANSOFF_TABLE[urgency][impact];
  return impact === 'low' ? 'review' : 'unassessed';
}

/** Loose entity shape: works on a raw generated pack and on a loaded one. */
export interface TriageEntity extends DelayEntity {
  kpiIds?: unknown; description?: unknown; baseline?: unknown; current?: unknown; direction?: unknown;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Kepner-Tregoe growth from one KPI: did it move the wrong way between baseline and current? */
export function kpiTrend(k: Pick<TriageEntity, 'baseline' | 'current' | 'direction'>): Growth {
  const b = num(k.baseline);
  const c = num(k.current);
  if (b === null || c === null || (k.direction !== 'increase' && k.direction !== 'decrease')) return 'unknown';
  if (c === b) return 'flat';
  return (c > b) === (k.direction === 'increase') ? 'improving' : 'worsening';
}

/** Worsening if any KPI worsens; improving only if every KPI with a trend improves. */
export function combineGrowth(trends: readonly Growth[]): Growth {
  if (trends.includes('worsening')) return 'worsening';
  if (trends.includes('flat')) return 'flat';
  if (trends.includes('improving')) return 'improving';
  return 'unknown';
}

export interface TriageOptions {
  /** Raw extensions.delayCost (validated here; an invalid one is ignored). */
  extension?: unknown;
  /** Project data: a person's timing estimates by issue id (the Cost of Delay estimates). */
  estimates?: Readonly<Record<string, DelayEstimate>>;
  /** Issues left out entirely (qualified out). */
  excluded?: ReadonlySet<string>;
  /** FR-385: the planning cycle of the confirmed situation (default PARAM-218). */
  cycleMonths?: number;
  /** FR-385: issues the confirmed crux addresses; they come first within their disposition. */
  crux?: ReadonlySet<string>;
  runs?: number;
  seed?: number;
}

export interface TriageIssue {
  id: string;
  impact: number;
  feasibility: number;
  /** Today's impact × feasibility rank among the issues considered (1 = first). */
  ifRank: number;
  impactLevel: ImpactLevel;
  provisional: boolean;
  impactTime: Range3 | null;
  impactOrigin: ImpactTimeOrigin | null;
  response: Range3 | null;
  responseOrigin: ResponseOrigin | null;
  /** The initiatives of its solutions are finished: nothing left to start. */
  done: boolean;
  /** E[months until impact] − E[months to respond]; the latest start, in months from now, when positive. */
  slack: number | null;
  /** Share of runs in which the response finishes after the impact arrives. */
  pLate: number | null;
  urgency: UrgencyLevel | null;
  growth: Growth;
  /** KPIs that moved the wrong way. */
  worseningKpis: string[];
  disposition: Disposition;
  /** Position in the triage order (disposition, then the confirmed crux, then impact × feasibility). */
  order: number;
  inAction: boolean;
  /** FR-385: the confirmed crux addresses this issue. */
  crux: boolean;
  /** What is still needed to rate the urgency (null when rated). */
  need: TimingNeed | null;
}

export interface Triage {
  issues: TriageIssue[];
  counts: Record<Disposition, number>;
  /** Candidates for action, in triage order. */
  action: string[];
  /** Issues set aside by the table (monitor, review, drop). */
  gated: string[];
  /** Issues whose urgency is rated. */
  timed: number;
  worsening: number;
  /** The issue whose timing is worth estimating first: an unassessed one, worsening before not, major before significant. */
  next: { id: string; need: TimingNeed } | null;
  /** The planning cycle the urgency was rated with (months). */
  cycle: number;
  runs: number;
  seed: number;
}

function seedOf(base: number, id: string): number {
  let h = 2166136261 ^ base;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const emptyCounts = (): Record<Disposition, number> => ({ act: 0, unassessed: 0, plan: 0, monitor: 0, review: 0, drop: 0 });

export function analyzeTriage(entities: readonly TriageEntity[], opts: TriageOptions = {}): Triage {
  const runs = Math.max(1, Math.floor(opts.runs ?? SIM_RUNS));
  const seed = opts.seed ?? DEFAULT_SEED;
  const cycle = opts.cycleMonths ?? PLANNING_CYCLE_MONTHS;
  const cruxIds = opts.crux ?? new Set<string>();
  const delay = delayInputs(entities, { extension: opts.extension, ...(opts.estimates ? { estimates: opts.estimates } : {}), ...(opts.excluded ? { excluded: opts.excluded } : {}) });
  const ext = DelayCostExtension.safeParse(opts.extension);
  const stated = new Map(ext.success ? ext.data.items.map((i) => [i.issueId, i]) : []);
  const byId = new Map(entities.filter((e) => typeof e.id === 'string').map((e) => [e.id as string, e]));

  const rows = delay.map((d) => {
    const e = byId.get(d.id)!;
    const impact = e.impact as number;
    const level = impactLevel(impact);
    const human = opts.estimates?.[d.id]?.impactMonths;
    const pack = stated.get(d.id)?.impactMonths;
    const impactTime = human ?? pack ?? null;
    const impactOrigin: ImpactTimeOrigin | null = human ? 'human' : pack ? 'pack' : null;
    const response = d.done ? null : d.duration;
    const responseOrigin: ResponseOrigin | null = d.done ? 'initiative' : d.durationOrigin;

    let slack: number | null = null;
    let pLate: number | null = null;
    let urgency: UrgencyLevel | null = null;
    if (d.done) {
      urgency = 'low';
      pLate = 0;
      slack = impactTime ? round(triangularMean(impactTime), 2) : null;
    } else if (impactTime && response) {
      slack = round(triangularMean(impactTime) - triangularMean(response), 2);
      urgency = urgencyLevel(slack, cycle);
      const rng = mulberry32(seedOf(seed, d.id));
      let late = 0;
      for (let r = 0; r < runs; r += 1) {
        const i = triangular(impactTime, rng());
        if (triangular(response, rng()) > i) late += 1;
      }
      pLate = round(late / runs);
    }

    const kpiIds = Array.isArray(e.kpiIds) ? e.kpiIds.filter((x): x is string => typeof x === 'string') : [];
    const trends = kpiIds.map((id) => ({ id, g: byId.get(id)?.kind === 'kpi' ? kpiTrend(byId.get(id)!) : 'unknown' as Growth }));
    const disposition = dispositionOf(level, urgency);
    const need: TimingNeed | null = urgency ? null : !impactTime && !response ? 'both' : !impactTime ? 'impact' : 'response';
    return {
      id: d.id, impact, feasibility: e.feasibility as number, ifRank: d.ifRank, impactLevel: level, provisional: isProvisionalRating(e.description),
      impactTime, impactOrigin, response, responseOrigin, done: d.done, slack, pLate, urgency,
      growth: combineGrowth(trends.map((t) => t.g)), worseningKpis: trends.filter((t) => t.g === 'worsening').map((t) => t.id),
      disposition, order: 0, inAction: ACTION_DISPOSITIONS.has(disposition), crux: cruxIds.has(d.id), need,
    } satisfies TriageIssue;
  });

  const pos = (x: Disposition) => DISPOSITION_ORDER.indexOf(x);
  const issues = rows.sort((a, b) => pos(a.disposition) - pos(b.disposition) || Number(b.crux) - Number(a.crux) || a.ifRank - b.ifRank).map((r, i) => ({ ...r, order: i + 1 }));
  const counts = emptyCounts();
  for (const i of issues) counts[i.disposition] += 1;
  const levelRank = (l: ImpactLevel) => IMPACT_LEVELS.indexOf(l);
  const next = issues.filter((i) => i.disposition === 'unassessed')
    .sort((a, b) => Number(b.growth === 'worsening') - Number(a.growth === 'worsening') || levelRank(b.impactLevel) - levelRank(a.impactLevel) || a.ifRank - b.ifRank)[0];
  return {
    issues, counts,
    action: issues.filter((i) => i.inAction).map((i) => i.id),
    gated: issues.filter((i) => !i.inAction).map((i) => i.id),
    timed: issues.filter((i) => i.urgency !== null).length,
    worsening: issues.filter((i) => i.growth === 'worsening').length,
    next: next ? { id: next.id, need: next.need! } : null,
    cycle, runs, seed,
  };
}

/** What a Project pack keeps (extensions.priority.triage). */
export interface TriageSummary {
  counts: Record<Disposition, number>;
  act: string[];
  gated: string[];
  timed: number;
  worsening: number;
  next: { id: string; need: TimingNeed } | null;
}

export function summarizeTriage(t: Triage): TriageSummary {
  return { counts: t.counts, act: t.issues.filter((i) => i.disposition === 'act').map((i) => i.id), gated: t.gated, timed: t.timed, worsening: t.worsening, next: t.next };
}

const cache = new WeakMap<CheckContext, Triage>();

/**
 * The project's triage: its issues less those qualified out, with the people's timing estimates and the pack's stated timing,
 * the planning cycle of the confirmed situation and the issues of the confirmed crux (FR-385).
 */
export function projectTriage(ctx: CheckContext): Triage {
  let t = cache.get(ctx);
  if (!t) {
    const entities = [...ctx.pack.byId.values()] as TriageEntity[];
    const excluded = new Set(entities.filter((e) => e.kind === 'issue' && isQualifiedOut(ctx.deliverables, e.id as string)).map((e) => e.id as string));
    const situation = ctx.deliverables.situation?.type;
    t = analyzeTriage(entities, {
      extension: ctx.pack.pack.extensions?.delayCost, estimates: ctx.deliverables.delayEstimates ?? {}, excluded,
      ...(situation ? { cycleMonths: SITUATION_CYCLE_MONTHS[situation] } : {}),
      crux: new Set(ctx.deliverables.crux?.issueIds ?? []),
    });
    cache.set(ctx, t);
  }
  return t;
}
