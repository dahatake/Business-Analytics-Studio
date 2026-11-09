import { create } from 'zustand';
import { PARAMS } from '../config/params.ts';
import { entitiesOf } from '../data/pack.ts';

export type FeedKind = 'order' | 'payment' | 'utilization' | 'kpi';

export interface FeedEvent {
  seq: number;
  kind: FeedKind;
  entityId: string;
  secondaryId?: string;
  value: number;
  /** Wall-clock time the simulated event was produced (shown as "updated at"). */
  at: number;
  /** performance.now() at production, used to measure produce→paint latency. */
  perf: number;
}

interface FeedState {
  events: FeedEvent[];
  paused: boolean;
  /** Events per second while a load test runs; null = normal cadence. */
  loadRate: number | null;
  latencies: number[];
  setPaused: (paused: boolean) => void;
  setLoadRate: (rate: number | null) => void;
  push: (e: FeedEvent) => void;
  recordLatency: (ms: number) => void;
  resetStats: () => void;
}

export const useFeed = create<FeedState>()((set) => ({
  events: [],
  paused: false,
  loadRate: null,
  latencies: [],
  setPaused: (paused) => set({ paused }),
  setLoadRate: (loadRate) => set({ loadRate }),
  push: (e) => set((s) => ({ events: [e, ...s.events].slice(0, 30) })),
  recordLatency: (ms) => set((s) => ({ latencies: [...s.latencies, ms].slice(-PARAMS.liveFeedSampleWindow) })),
  resetStats: () => set({ latencies: [] }),
}));

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export type Freshness = 'fresh' | 'stale' | 'stopped' | 'paused' | 'waiting';

export function freshness(lastAt: number | null, now: number, paused: boolean, intervalMs: number): Freshness {
  if (paused) return 'paused';
  if (lastAt === null) return 'waiting';
  const age = now - lastAt;
  if (age <= intervalMs * PARAMS.liveFeedFreshFactor) return 'fresh';
  if (age <= intervalMs * PARAMS.liveFeedStaleFactor) return 'stale';
  return 'stopped';
}

/** Deterministic pseudo-random sequence so demos and tests are repeatable. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGenerator(seed = 42) {
  const rnd = mulberry32(seed);
  const customers = entitiesOf('customer').filter((c) => c.classification === 'shareable');
  const products = entitiesOf('product');
  const invoices = entitiesOf('invoice');
  const plants = entitiesOf('site').filter((s) => s.role === 'plant');
  const kpis = entitiesOf('kpi').filter((k) => k.classification === 'shareable');
  let seq = 0;
  const pickFrom = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  return (): FeedEvent => {
    const r = rnd();
    seq += 1;
    const base = { seq, at: Date.now(), perf: performance.now() };
    if (r < 0.35) return { ...base, kind: 'order', entityId: pickFrom(customers).id, secondaryId: pickFrom(products).id, value: 10 + Math.floor(rnd() * 190) };
    if (r < 0.55) return { ...base, kind: 'payment', entityId: pickFrom(invoices).id, value: 0 };
    if (r < 0.8) return { ...base, kind: 'utilization', entityId: pickFrom(plants).id, value: 70 + Math.floor(rnd() * 28) };
    const k = pickFrom(kpis);
    return { ...base, kind: 'kpi', entityId: k.id, value: Math.round((k.current + (rnd() - 0.5) * Math.abs(k.target - k.baseline) * 0.1) * 10) / 10 };
  };
}

let timer: number | null = null;
let generator: (() => FeedEvent) | null = null;

/** Start/restart the simulation with the cadence implied by the current state. */
export function runFeed() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  const { paused, loadRate } = useFeed.getState();
  if (paused) return;
  generator ??= createGenerator();
  const interval = loadRate ? 1000 / loadRate : PARAMS.liveFeedIntervalMs;
  const tick = () => useFeed.getState().push(generator!());
  tick();
  timer = window.setInterval(tick, interval);
}

export function stopFeed() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

/** Hook for the agreed load test (e2e/livefeed.spec.ts) and manual checks from DevTools. */
export function exposeFeedDiagnostics() {
  (window as unknown as { __basFeed: unknown }).__basFeed = {
    startLoad(rate: number = PARAMS.liveFeedLoadRatePerSec) {
      useFeed.getState().resetStats();
      useFeed.getState().setLoadRate(rate);
      runFeed();
    },
    stopLoad() {
      useFeed.getState().setLoadRate(null);
      runFeed();
    },
    stats() {
      const l = useFeed.getState().latencies;
      return { count: l.length, p50: percentile(l, 50), p95: percentile(l, 95), max: Math.max(...l) };
    },
  };
}
