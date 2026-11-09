/**
 * Concrete values for acceptance criteria that the request left open.
 * Keep values here (not inline) so tests and docs reference one source (mirrors the PARAM table in §3.3).
 */
export const PARAMS = {
  /** Sample "as of" date. All sample dates are relative to it so the demo is deterministic. */
  asOfDate: '2026-11-09',
  timeZone: 'Asia/Tokyo',

  /** F-3.2.1 / WCAG 1.4.13: hover-intent delay before a detail card opens, and grace period before it closes. */
  cardOpenDelayMs: 350,
  cardCloseDelayMs: 250,

  /** F-3.4.1 live feed. Normal simulated cadence and freshness thresholds (multiples of the interval). */
  liveFeedIntervalMs: 2_000,
  liveFeedFreshFactor: 2,
  liveFeedStaleFactor: 5,
  /** Agreed load condition for the latency measurement (events per second, duration) and budget (p95). */
  liveFeedLoadRatePerSec: 20,
  liveFeedLoadDurationMs: 8_000,
  liveFeedLatencyBudgetP95Ms: 100,
  liveFeedSampleWindow: 200,

  /** PARAM-014: relation graph hop range. */
  graphHopsMin: 1,
  graphHopsMax: 3,

  /** PARAM-015: executive summary sentence count range. */
  summarySentencesMin: 2,
  summarySentencesMax: 3,

  /** PARAM-018 / PARAM-019: contrast minimums (verified by axe in E2E). */
  contrastText: 4.5,
  contrastGraphics: 3,

  /** Opening sequence length (skippable; skipped entirely under reduced motion). */
  openingDurationMs: 4_500,

  /** F-3.1.2 portrait balance: each gender must cover at least this many age bands, and gender counts may differ by at most 1. */
  portraitMinAgeBandsPerGender: 4,
  portraitMaxGenderImbalance: 1,

  /** F-3.4.2 proposed usability-test targets (pending agreement; see docs/usability-test.md). */
  usabilityTaskSuccessRateTarget: 0.8,
  usabilityTaskTimeTargetSec: 90,
} as const;

export type Params = typeof PARAMS;
