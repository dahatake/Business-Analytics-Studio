import { create } from 'zustand';
import { PARAMS } from '../config/params.ts';

export type CardVia = 'hover' | 'focus' | 'touch';

export interface OpenCard {
  entityId: string;
  trigger: Element;
  via: CardVia;
}

interface CardState {
  open: OpenCard | null;
  show: (card: OpenCard) => void;
  hide: () => void;
}

export const useCardStore = create<CardState>()((set) => ({
  open: null,
  show: (open) => set({ open }),
  hide: () => set({ open: null }),
}));

export const CARD_ID = 'bas-detail-card';

let openTimer: number | null = null;
let closeTimer: number | null = null;
let lastPointerWasTouch = false;

const clear = () => {
  if (openTimer !== null) window.clearTimeout(openTimer);
  if (closeTimer !== null) window.clearTimeout(closeTimer);
  openTimer = closeTimer = null;
};

export const cardController = {
  openNow(entityId: string, trigger: Element, via: CardVia) {
    clear();
    useCardStore.getState().show({ entityId, trigger, via });
  },
  scheduleOpen(entityId: string, trigger: Element) {
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    closeTimer = null;
    const current = useCardStore.getState().open;
    if (current?.trigger === trigger) return;
    if (openTimer !== null) window.clearTimeout(openTimer);
    openTimer = window.setTimeout(() => cardController.openNow(entityId, trigger, 'hover'), PARAMS.cardOpenDelayMs);
  },
  scheduleClose() {
    if (openTimer !== null) window.clearTimeout(openTimer);
    openTimer = null;
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => useCardStore.getState().hide(), PARAMS.cardCloseDelayMs);
  },
  /** Called when the pointer enters the card itself (WCAG 1.4.13 "hoverable"). */
  keepOpen() {
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    closeTimer = null;
  },
  closeNow() {
    clear();
    useCardStore.getState().hide();
  },
  isOpenFor(trigger: Element) {
    return useCardStore.getState().open?.trigger === trigger;
  },
};

/** Handlers shared by React triggers and d3-created SVG triggers. */
export function triggerHandlers(entityId: string) {
  return {
    onPointerEnter(e: PointerEvent | React.PointerEvent) {
      lastPointerWasTouch = e.pointerType === 'touch';
      if (e.pointerType !== 'touch') cardController.scheduleOpen(entityId, e.currentTarget as Element);
    },
    onPointerLeave(e: PointerEvent | React.PointerEvent) {
      if (e.pointerType !== 'touch') cardController.scheduleClose();
    },
    onPointerDown(e: PointerEvent | React.PointerEvent) {
      lastPointerWasTouch = e.pointerType === 'touch';
    },
    onFocus(e: FocusEvent | React.FocusEvent) {
      const el = e.currentTarget as Element;
      if (el.matches(':focus-visible')) cardController.openNow(entityId, el, 'focus');
    },
    onBlur(e: FocusEvent | React.FocusEvent) {
      const next = e.relatedTarget as Node | null;
      if (next && document.getElementById(CARD_ID)?.contains(next)) return;
      if (useCardStore.getState().open?.via === 'focus') cardController.closeNow();
    },
    /** Touch: the first tap opens the card instead of navigating; the card offers the "Open" action. */
    onClick(e: MouseEvent | React.MouseEvent) {
      const el = e.currentTarget as Element;
      if (lastPointerWasTouch && !cardController.isOpenFor(el)) {
        e.preventDefault();
        cardController.openNow(entityId, el, 'touch');
        return true;
      }
      return false;
    },
    onKeyDown(e: KeyboardEvent | React.KeyboardEvent) {
      if (e.key === 'Escape' && useCardStore.getState().open) {
        e.stopPropagation();
        cardController.closeNow();
      }
    },
  };
}

/** Attach trigger behaviour to a non-React element (d3 SVG nodes). Returns a detach function. */
export function attachCardTrigger(el: Element, entityId: string, onActivate?: () => void): () => void {
  const h = triggerHandlers(entityId);
  const click = (e: Event) => {
    const consumed = h.onClick(e as MouseEvent);
    if (!consumed && onActivate) onActivate();
  };
  const key = (e: Event) => {
    const ke = e as KeyboardEvent;
    h.onKeyDown(ke);
    if ((ke.key === 'Enter' || ke.key === ' ') && onActivate) {
      ke.preventDefault();
      onActivate();
    }
  };
  const pairs: [string, EventListener][] = [
    ['pointerenter', h.onPointerEnter as EventListener],
    ['pointerleave', h.onPointerLeave as EventListener],
    ['pointerdown', h.onPointerDown as EventListener],
    ['focus', h.onFocus as EventListener],
    ['blur', h.onBlur as EventListener],
    ['click', click],
    ['keydown', key],
  ];
  pairs.forEach(([t, fn]) => el.addEventListener(t, fn));
  el.setAttribute('aria-haspopup', 'dialog');
  return () => pairs.forEach(([t, fn]) => el.removeEventListener(t, fn));
}
