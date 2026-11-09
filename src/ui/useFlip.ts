import { useLayoutEffect, useRef, type RefObject } from 'react';

/** FLIP reorder animation: DOM order stays the reading order, only the visual move is animated. */
export function useFlip(container: RefObject<HTMLElement | null>, reduced: boolean, deps: unknown[]) {
  const previous = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const next = new Map<string, number>();
    el.querySelectorAll<HTMLElement>('[data-flip-key]').forEach((child) => {
      const key = child.dataset.flipKey!;
      const top = child.getBoundingClientRect().top;
      const old = previous.current.get(key);
      if (!reduced && old !== undefined && Math.abs(old - top) > 0.5 && typeof child.animate === 'function') {
        child.animate([{ transform: `translateY(${old - top}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.33, 0, 0.1, 1)' });
      }
      next.set(key, top);
    });
    previous.current = next;
  }, deps);
}

