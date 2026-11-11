import { entitiesOf, getEntity, loaded, type LoadedPack } from '../../data/pack.ts';
import { appStorage as localStorage } from '../../data/deviceStorage.ts';
import type { EntityOf } from '../../data/schema.ts';
import { makeFormatters, pick, translate, type Lang, type MessageKey } from '../../i18n/core.ts';
import { rankIssues, type PriorityWeights, type RankedIssue } from '../../domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../../domain/summary.ts';
import { kpiProgress, kpiStatus, type KpiStatus } from '../../domain/kpi.ts';
import { optimize } from '../../domain/optimize.ts';
import type { PersonaView } from '../../state/personas.ts';
import type { Audience } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import type { UseCase } from '../usecases/store.ts';

type Issue = EntityOf<'issue'>;
type Solution = EntityOf<'solution'>;
type Kpi = EntityOf<'kpi'>;
type Initiative = EntityOf<'initiative'>;

/** Timing and limits of the show (§3.3 PARAM table). */
export const SHOW_PARAMS = {
  /** PARAM-011 / PARAM-012: the program opening lasts 15–30 s (skippable). */
  openingMinMs: 15_000,
  openingMaxMs: 30_000,
  openingMs: 18_000,
  /** Auto-advance per chapter while playing (facilitators usually pause; this is the "program" pace). */
  chapterMs: 30_000,
  /** PARAM-013: short-video mode lasts about 60 s. */
  shortVideoMs: 60_000,
  /** PARAM-026: the control bar hides after 3 s without activity. */
  controlBarHideMs: 3_000,
  /** PARAM-061: first story scene within 2 s of the start. */
  storyFirstSceneMs: 2_000,
  /** PARAM-062: number of priority solutions in a persona story. */
  storyTopSolutions: 3,
  /** PARAM-127 / PARAM-132: FR-290 response wait and output cap. */
  aiTimeoutMs: 90_000,
  aiMaxOutputTokens: 4_000,
  /** PARAM-021: no flashing more than 3 times per second (the show never flashes at all). */
  maxFlashesPerSec: 3,
} as const;

/** FR-077: the program structure, in order. */
export const CHAPTER_IDS = ['opening', 'issues', 'beforeAfter', 'roi', 'kpis', 'solutions', 'next'] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

export const chapterTitleKey = (id: ChapterId) => `show.chapter.${id}` as MessageKey;
export const chapterEmptyKey = (id: ChapterId) => `show.empty.${id}` as MessageKey;

export interface RankedSolution {
  solution: Solution;
  /** Priority score (0–100) of the highest-priority issue the solution resolves. */
  score: number;
  issue: Issue | undefined;
  /** (annual benefit − cost) / cost. */
  roi: number;
  paybackMonths: number;
}

export interface BeforeAfterMetric {
  id: 'totalCost' | 'co2' | 'leadTime';
  before: number;
  after: number;
}

export type Chapter =
  | { id: 'opening'; empty: false }
  | { id: 'issues'; empty: boolean; ranked: RankedIssue[] }
  | { id: 'beforeAfter'; empty: boolean; metrics: BeforeAfterMetric[] }
  | { id: 'roi'; empty: boolean; items: RankedSolution[]; totalCostJpy: number; totalBenefitJpy: number }
  | { id: 'kpis'; empty: boolean; kpis: { kpi: Kpi; status: KpiStatus; progress: number }[] }
  | { id: 'solutions'; empty: boolean; items: RankedSolution[] }
  | { id: 'next'; empty: boolean; initiatives: Initiative[] };

export const isVisibleTo = (audience: Audience) => (e: { classification: string }) => audience === 'internal' || e.classification === 'shareable';

/** Solutions ordered by the priority of the issue they resolve, then by ROI. Internal items are dropped for an external audience. */
export function rankSolutions(audience: Audience, data: LoadedPack = loaded, weights: PriorityWeights = DEFAULT_WEIGHTS): RankedSolution[] {
  const visible = isVisibleTo(audience);
  const ranked = rankIssues(entitiesOf('issue', data).filter(visible), weights);
  const byIssue = new Map(ranked.map((r) => [r.issue.id, r] as const));
  return entitiesOf('solution', data).filter(visible).map((solution) => {
    const issues = solution.issueIds.map((id) => byIssue.get(id)).filter((r): r is RankedIssue => r !== undefined).sort((a, b) => b.score - a.score);
    return {
      solution,
      score: issues[0]?.score ?? 0,
      issue: issues[0]?.issue,
      roi: (solution.annualBenefitJpy - solution.costJpy) / solution.costJpy,
      paybackMonths: (solution.costJpy / solution.annualBenefitJpy) * 12,
    };
  }).sort((a, b) => b.score - a.score || b.roi - a.roi || a.solution.id.localeCompare(b.solution.id));
}

/** FR-077 / FR-079: every chapter of the program, built from the pack. Empty chapters are explicit, never silently dropped. */
export function buildChapters(audience: Audience, data: LoadedPack = loaded): Chapter[] {
  const visible = isVisibleTo(audience);
  const ranked = rankIssues(entitiesOf('issue', data).filter(visible), DEFAULT_WEIGHTS).slice(0, 5);

  let metrics: BeforeAfterMetric[] = [];
  try {
    const r = data.pack.optimization ? optimize(data.pack.optimization, { demandGrowth: 0, carbonPriceJpyPerT: 10_000 }) : null;
    if (r?.feasible) {
      metrics = [
        { id: 'totalCost', before: r.beforeMetrics.totalCostJpy, after: r.afterMetrics.totalCostJpy },
        { id: 'co2', before: r.beforeMetrics.co2T, after: r.afterMetrics.co2T },
        { id: 'leadTime', before: r.beforeMetrics.avgLeadTimeDays, after: r.afterMetrics.avgLeadTimeDays },
      ];
    }
  } catch {
    metrics = [];
  }

  const solutions = rankSolutions(audience, data);
  const roiItems = [...solutions].sort((a, b) => b.roi - a.roi || a.solution.id.localeCompare(b.solution.id));
  const kpis = entitiesOf('kpi', data).filter(visible).map((kpi) => ({ kpi, status: kpiStatus(kpi), progress: kpiProgress(kpi) }));
  const initiatives = entitiesOf('initiative', data).filter(visible).filter((i) => i.progress < 1)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)).slice(0, 5);

  return [
    { id: 'opening', empty: false },
    { id: 'issues', empty: ranked.length === 0, ranked },
    { id: 'beforeAfter', empty: metrics.length === 0, metrics },
    {
      id: 'roi', empty: roiItems.length === 0, items: roiItems,
      totalCostJpy: roiItems.reduce((a, s) => a + s.solution.costJpy, 0),
      totalBenefitJpy: roiItems.reduce((a, s) => a + s.solution.annualBenefitJpy, 0),
    },
    { id: 'kpis', empty: kpis.length === 0, kpis },
    { id: 'solutions', empty: solutions.length === 0, items: solutions },
    { id: 'next', empty: initiatives.length === 0, initiatives },
  ];
}

const pct = (lang: Lang, before: number, after: number) => makeFormatters(lang).percent(before === 0 ? 0 : (after - before) / before);

/** FR-080 navigator / FR-078 captions: deterministic talking points of a chapter (no AI). The first point is the caption. */
export function chapterPoints(ch: Chapter, lang: Lang): string[] {
  const fmt = makeFormatters(lang);
  if (ch.empty) return [translate(lang, chapterEmptyKey(ch.id))];
  switch (ch.id) {
    case 'opening':
      return [translate(lang, 'show.points.opening', { count: CHAPTER_IDS.length - 1 })];
    case 'issues': {
      const top = ch.ranked[0]!;
      return [
        translate(lang, 'show.points.issuesTop', { issue: pick(lang, top.issue.name), score: top.score }),
        translate(lang, 'show.points.issuesCount', { count: ch.ranked.length }),
      ];
    }
    case 'beforeAfter': {
      const cost = ch.metrics.find((m) => m.id === 'totalCost')!;
      const co2 = ch.metrics.find((m) => m.id === 'co2')!;
      return [
        translate(lang, 'show.points.baCost', { before: fmt.yenCompact(cost.before), after: fmt.yenCompact(cost.after), pct: pct(lang, cost.before, cost.after) }),
        translate(lang, 'show.points.baCo2', { pct: pct(lang, co2.before, co2.after) }),
      ];
    }
    case 'roi': {
      const best = ch.items[0]!;
      return [
        translate(lang, 'show.points.roiTotal', { cost: fmt.yenCompact(ch.totalCostJpy), benefit: fmt.yenCompact(ch.totalBenefitJpy) }),
        translate(lang, 'show.points.roiBest', { solution: pick(lang, best.solution.name), months: fmt.integer(best.paybackMonths) }),
      ];
    }
    case 'kpis': {
      const counts = { achieved: 0, progressing: 0, regressed: 0 };
      ch.kpis.forEach((k) => { counts[k.status] += 1; });
      const out = [translate(lang, 'show.points.kpis', { total: ch.kpis.length, ...counts })];
      const worst = ch.kpis.find((k) => k.status === 'regressed');
      if (worst) out.push(translate(lang, 'show.points.kpiWorst', { kpi: pick(lang, worst.kpi.name) }));
      return out;
    }
    case 'solutions': {
      const top = ch.items[0]!;
      return [
        translate(lang, 'show.points.solTop', { solution: pick(lang, top.solution.name), issue: top.issue ? pick(lang, top.issue.name) : '—' }),
        translate(lang, 'show.points.solCount', { count: ch.items.length }),
      ];
    }
    case 'next': {
      const first = ch.initiatives[0]!;
      return [
        translate(lang, 'show.points.nextFirst', { initiative: pick(lang, first.name), date: fmt.date(first.start) }),
        translate(lang, 'show.points.nextCount', { count: ch.initiatives.length }),
      ];
    }
  }
}

/* ---------- FR-177〜179 persona story ---------- */

export type MissingKind = 'solutions' | 'kpis' | 'usecases';

export type StoryScene =
  | { kind: 'title'; id: 'title' }
  | { kind: 'solution'; id: string; rank: number; item: RankedSolution; reasons: string[] }
  | { kind: 'kpis'; id: 'kpis'; kpis: Kpi[] }
  | { kind: 'usecases'; id: 'usecases'; useCases: UseCase[] }
  | { kind: 'missing'; id: string; what: MissingKind }
  | { kind: 'closing'; id: 'closing' };

export interface Story {
  persona: PersonaView;
  top: RankedSolution[];
  scenes: StoryScene[];
  missing: MissingKind[];
}

const joinList = (lang: Lang, xs: string[]) => xs.join(lang === 'ja' ? '、' : ', ');

/** Why this solution matters to this persona (FR-177). Always starts with the issue it resolves. */
export function solutionReasons(item: RankedSolution, persona: PersonaView, lang: Lang, data: LoadedPack = loaded): string[] {
  const fmt = makeFormatters(lang);
  const out: string[] = [];
  if (item.issue) out.push(translate(lang, 'show.reason.issue', { issue: pick(lang, item.issue.name), score: item.score }));
  const names = (ids: string[]) => ids.map((id) => getEntity(id, data)).filter((e) => e !== undefined).map((e) => pick(lang, e.name));
  switch (persona) {
    case 'executive':
      out.push(translate(lang, 'show.reason.executive', { benefit: fmt.yenCompact(item.solution.annualBenefitJpy), cost: fmt.yenCompact(item.solution.costJpy), months: fmt.integer(item.paybackMonths) }));
      break;
    case 'business': {
      const causes = item.issue ? names(item.issue.causeIds) : [];
      if (causes.length) out.push(translate(lang, 'show.reason.business', { causes: joinList(lang, causes) }));
      break;
    }
    case 'it':
      if (item.solution.msProducts.length) out.push(translate(lang, 'show.reason.it', { products: joinList(lang, item.solution.msProducts) }));
      break;
    case 'field': {
      const kpis = names(item.solution.kpiIds);
      if (kpis.length) out.push(translate(lang, 'show.reason.field', { kpis: joinList(lang, kpis) }));
      break;
    }
  }
  return out;
}

/** FR-177〜179: scenes generated on the fly (never saved). Missing material becomes an explicit scene that says what to add. */
export function buildStory(persona: PersonaView, useCases: UseCase[], audience: Audience, lang: Lang, data: LoadedPack = loaded): Story {
  const top = rankSolutions(audience, data).slice(0, SHOW_PARAMS.storyTopSolutions);
  const visible = isVisibleTo(audience);
  const kpiIds = [...new Set(top.flatMap((s) => [...s.solution.kpiIds, ...(s.issue?.kpiIds ?? [])]))];
  const kpis = kpiIds.map((id) => getEntity(id, data)).filter((e): e is Kpi => e?.kind === 'kpi' && visible(e));
  const mine = useCases.filter((u) => u.persona === persona).slice(0, 3);
  const missing: MissingKind[] = [];
  const scenes: StoryScene[] = [{ kind: 'title', id: 'title' }];
  if (top.length === 0) {
    missing.push('solutions');
    scenes.push({ kind: 'missing', id: 'missing-solutions', what: 'solutions' });
  } else {
    top.forEach((item, i) => scenes.push({ kind: 'solution', id: `sol-${item.solution.id}`, rank: i + 1, item, reasons: solutionReasons(item, persona, lang, data) }));
  }
  if (kpis.length === 0) {
    missing.push('kpis');
    scenes.push({ kind: 'missing', id: 'missing-kpis', what: 'kpis' });
  } else {
    scenes.push({ kind: 'kpis', id: 'kpis', kpis });
  }
  if (mine.length === 0) {
    missing.push('usecases');
    scenes.push({ kind: 'missing', id: 'missing-usecases', what: 'usecases' });
  } else {
    scenes.push({ kind: 'usecases', id: 'usecases', useCases: mine });
  }
  scenes.push({ kind: 'closing', id: 'closing' });
  return { persona, top, scenes, missing };
}

/** One-line text of a story scene, for the outline view and captions (NFR-A11Y-008). */
export function storySceneText(scene: StoryScene, story: Story, lang: Lang): { title: string; lines: string[] } {
  const persona = translate(lang, `persona.${story.persona}` as MessageKey);
  switch (scene.kind) {
    case 'title':
      return { title: translate(lang, 'show.story.title', { persona }), lines: [translate(lang, 'show.story.subtitle', { count: story.top.length })] };
    case 'solution':
      return { title: translate(lang, 'show.story.solution', { rank: scene.rank, solution: pick(lang, scene.item.solution.name) }), lines: scene.reasons };
    case 'kpis':
      return { title: translate(lang, 'show.story.kpis'), lines: scene.kpis.map((k) => pick(lang, k.name)) };
    case 'usecases':
      return { title: translate(lang, 'show.story.usecases', { persona }), lines: scene.useCases.map((u) => loc(u.name, lang)) };
    case 'missing':
      return { title: translate(lang, 'show.story.missingTitle'), lines: [translate(lang, `show.missing.${scene.what}` as MessageKey)] };
    case 'closing':
      return { title: translate(lang, 'show.story.closing'), lines: [translate(lang, 'show.story.closingText')] };
  }
}

/* ---------- FR-083 intensity ---------- */

export const INTENSITIES = ['executive', 'showcase', 'entertainment'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export interface IntensityProfile {
  transition: 'none' | 'fade' | 'slide' | 'zoom';
  durationMs: number;
  /** Transition sounds (only when the user has unmuted). */
  sfx: boolean;
  /** Spotlight / staggered bars. Never changes type size, contrast or the amount of text. */
  decorations: boolean;
}

/** Intensity changes only motion and sound; reduced motion always wins (instant scene changes). */
export function intensityProfile(intensity: Intensity, reduced: boolean): IntensityProfile {
  const base: Record<Intensity, IntensityProfile> = {
    executive: { transition: 'fade', durationMs: 250, sfx: false, decorations: false },
    showcase: { transition: 'slide', durationMs: 450, sfx: true, decorations: false },
    entertainment: { transition: 'zoom', durationMs: 700, sfx: true, decorations: true },
  };
  const p = base[intensity];
  return reduced ? { ...p, transition: 'none', durationMs: 0, decorations: false } : p;
}

/* ---------- FR-084 control bar auto-hide (pure) ---------- */

export function barVisibleAt(lastActivityMs: number, nowMs: number, pinned: boolean, delayMs: number = SHOW_PARAMS.controlBarHideMs): boolean {
  return pinned || nowMs - lastActivityMs < delayMs;
}

export interface TimerApi {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

/** Hides after `delayMs` without activity; any activity shows it again. While pinned (focus inside the bar) it never hides. */
export class AutoHide {
  visible = true;
  private timer: number | null = null;
  private pinned = false;

  constructor(
    private readonly onChange: (visible: boolean) => void,
    private readonly delayMs: number = SHOW_PARAMS.controlBarHideMs,
    private readonly timers: TimerApi = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) },
  ) {
    this.schedule();
  }

  private setVisible(v: boolean) {
    if (v === this.visible) return;
    this.visible = v;
    this.onChange(v);
  }

  private schedule() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.pinned ? null : this.timers.set(() => {
      this.timer = null;
      this.setVisible(false);
    }, this.delayMs);
  }

  activity() {
    this.setVisible(true);
    this.schedule();
  }

  pin(on: boolean) {
    this.pinned = on;
    this.activity();
  }

  dispose() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/* ---------- FR-057 show settings ---------- */

export const SHOW_SETTINGS_KEY = 'bas.show.settings';

export interface ShowSettings {
  intensity: Intensity;
  lastChapter: ChapterId;
  narrator: boolean;
  captions: boolean;
}

export const DEFAULT_SHOW_SETTINGS: ShowSettings = { intensity: 'showcase', lastChapter: 'opening', narrator: false, captions: true };

export function loadShowSettings(storage: Pick<Storage, 'getItem'> = localStorage): ShowSettings {
  try {
    const raw = JSON.parse(storage.getItem(SHOW_SETTINGS_KEY) ?? '{}') as Partial<ShowSettings>;
    return {
      intensity: INTENSITIES.includes(raw.intensity as Intensity) ? raw.intensity as Intensity : DEFAULT_SHOW_SETTINGS.intensity,
      lastChapter: CHAPTER_IDS.includes(raw.lastChapter as ChapterId) ? raw.lastChapter as ChapterId : DEFAULT_SHOW_SETTINGS.lastChapter,
      narrator: typeof raw.narrator === 'boolean' ? raw.narrator : DEFAULT_SHOW_SETTINGS.narrator,
      captions: typeof raw.captions === 'boolean' ? raw.captions : DEFAULT_SHOW_SETTINGS.captions,
    };
  } catch {
    return { ...DEFAULT_SHOW_SETTINGS };
  }
}

export function saveShowSettings(s: ShowSettings, storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(SHOW_SETTINGS_KEY, JSON.stringify(s));
}

/* ---------- FR-085 shortcuts ---------- */

export type ShortcutAction = 'help' | 'prev' | 'next' | 'play' | 'mute' | 'fullscreen' | 'exit' | 'narrator' | 'outline' | 'captions' | 'first' | 'last';

export const SHORTCUTS: { keys: string[]; action: ShortcutAction }[] = [
  { keys: ['?'], action: 'help' },
  { keys: ['←', 'PageUp'], action: 'prev' },
  { keys: ['→', 'PageDown'], action: 'next' },
  { keys: ['Space'], action: 'play' },
  { keys: ['M'], action: 'mute' },
  { keys: ['F'], action: 'fullscreen' },
  { keys: ['Esc'], action: 'exit' },
  { keys: ['N'], action: 'narrator' },
  { keys: ['O'], action: 'outline' },
  { keys: ['C'], action: 'captions' },
  { keys: ['Home'], action: 'first' },
  { keys: ['End'], action: 'last' },
];

/** Map a keyboard event key to a show action (case-insensitive letters). */
export function actionForKey(key: string): ShortcutAction | null {
  switch (key) {
    case '?': return 'help';
    case 'ArrowLeft': case 'PageUp': return 'prev';
    case 'ArrowRight': case 'PageDown': return 'next';
    case ' ': case 'Spacebar': return 'play';
    case 'Escape': case 'Esc': return 'exit';
    case 'Home': return 'first';
    case 'End': return 'last';
    default: break;
  }
  switch (key.toLowerCase()) {
    case 'm': return 'mute';
    case 'f': return 'fullscreen';
    case 'n': return 'narrator';
    case 'o': return 'outline';
    case 'c': return 'captions';
    default: return null;
  }
}

/** FR-081: per-scene duration of the short-video mode (≈ PARAM-013 in total). */
export function shortVideoSceneMs(sceneCount: number): number {
  return Math.round(SHOW_PARAMS.shortVideoMs / Math.max(1, sceneCount));
}
