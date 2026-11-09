import { create } from 'zustand';
import { createScopedStore } from '../../state/projects.ts';
import { initialBoards, type BoardMeta, type Stroke } from './model.ts';

/** FR-086: board list per project (metadata only; strokes live in IndexedDB). */
export const useBoards = createScopedStore<BoardMeta[]>('ink.boards', () => initialBoards());

/** The selected board per project. */
export const useActiveBoard = createScopedStore<string | null>('ink.active', () => null);

/** FR-091: on-screen annotation strokes, kept per route (path) and per project. */
export const useScreenInk = createScopedStore<Record<string, Stroke[]>>('ink.screen', () => ({}));

/** Cap of on-screen annotation strokes per route, so localStorage stays small. */
export const SCREEN_INK_MAX = 2000;

interface OverlayState {
  active: boolean;
  setActive: (v: boolean) => void;
}

export const useInkOverlay = create<OverlayState>()((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
