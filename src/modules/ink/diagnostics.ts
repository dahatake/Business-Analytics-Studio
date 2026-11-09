/** Diagnostics hook for E2E and performance checks (window.__basInk, FR-095 / NFR-PERF-004). */
import type { InkSurface } from './surface.ts';

export interface InkDiagnostics {
  strokeCount: () => number;
  noteCount: () => number;
  linkCount: () => number;
  seed: (n: number) => Promise<number>;
  frameStats: () => ReturnType<InkSurface['frameStats']>;
  resetStats: () => void;
  flush: () => Promise<void>;
  lastCommitMs: () => number;
  ready: () => boolean;
}

declare global {
  interface Window {
    __basInk?: InkDiagnostics;
  }
}
