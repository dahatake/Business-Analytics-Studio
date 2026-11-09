import { useCallback, useEffect, useRef, useState } from 'react';
import { sceneIndexAt } from './scenes.ts';

export type PlayState = 'playing' | 'paused' | 'ended';

/** Shared timeline clock for the use-case animation and the storyboard (FR-156 / FR-164). */
export function usePlayback(scenes: { startMs: number; durationMs: number }[], totalMs: number, autoPlay: boolean) {
  const [ms, setMs] = useState(0);
  const [state, setState] = useState<PlayState>(autoPlay && totalMs > 0 ? 'playing' : 'paused');
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (state !== 'playing') {
      last.current = null;
      return;
    }
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = last.current === null ? 0 : now - last.current;
      last.current = now;
      setMs((m) => {
        const next = m + dt;
        if (next >= totalMs) {
          setState('ended');
          return totalMs;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [state, totalMs]);

  const index = Math.max(0, sceneIndexAt(scenes, Math.min(ms, Math.max(0, totalMs - 1))));
  const seek = useCallback((to: number) => {
    const clamped = Math.max(0, Math.min(totalMs, to));
    setMs(clamped);
    setState((s) => (clamped >= totalMs ? 'ended' : s === 'ended' ? 'paused' : s));
  }, [totalMs]);
  const goTo = useCallback((i: number) => {
    const s = scenes[Math.max(0, Math.min(scenes.length - 1, i))];
    if (s) seek(s.startMs);
  }, [scenes, seek]);
  const play = useCallback(() => {
    setMs((m) => (m >= totalMs ? 0 : m));
    setState('playing');
  }, [totalMs]);
  const pause = useCallback(() => setState((s) => (s === 'playing' ? 'paused' : s)), []);

  return { ms, state, index, seek, goTo, play, pause, next: () => goTo(index + 1), prev: () => goTo(index - 1) };
}

export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
