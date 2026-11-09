import { create } from 'zustand';
import type { PersonaView } from '../../state/personas.ts';
import { navigate } from '../../state/router.ts';
import { loadShowSettings, saveShowSettings, type ShowSettings } from './model.ts';

export type Program =
  | { kind: 'show'; chapter?: number }
  | { kind: 'short' }
  | { kind: 'story'; persona: PersonaView };

interface ShowRunState {
  program: Program | null;
  /** FR-016 / §7: the screen the presentation was started from; exiting returns there. */
  returnHash: string;
  /** Whether this app put the document into fullscreen (so Esc from the browser also ends the show). */
  enteredFullscreen: boolean;
  start: (program: Program) => void;
  stop: () => void;
}

interface ShowSettingsState extends ShowSettings {
  update: (patch: Partial<ShowSettings>) => void;
}

/** FR-057: intensity, last chapter and panel toggles survive reloads (browser-local, not project data). */
export const useShowSettings = create<ShowSettingsState>()((set, get) => ({
  ...loadShowSettings(),
  update: (patch) => {
    set(patch);
    const { intensity, lastChapter, narrator, captions } = get();
    saveShowSettings({ intensity, lastChapter, narrator, captions });
  },
}));

let returnFocus: HTMLElement | null = null;
/** A pending exit from the previous show; a new show waits for it so the two fullscreen changes never interleave. */
let pendingExit: Promise<void> = Promise.resolve();

/** Fullscreen API with a graceful fallback (the overlay already covers the viewport). */
export async function enterFullscreen(): Promise<boolean> {
  const el = document.documentElement;
  if (document.fullscreenElement) return true;
  if (typeof el.requestFullscreen !== 'function') return false;
  try {
    await el.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

export async function exitFullscreen() {
  if (!document.fullscreenElement || typeof document.exitFullscreen !== 'function') return;
  try {
    await document.exitFullscreen();
  } catch {
    // Already left (e.g. the browser handled Esc).
  }
}

export const useShowRun = create<ShowRunState>()((set, get) => ({
  program: null,
  returnHash: '',
  enteredFullscreen: false,
  start: (program) => {
    if (get().program) {
      set({ program });
      return;
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    set({ program, returnHash: window.location.hash || '#/', enteredFullscreen: false });
    // Called from the user's click/key, so the request keeps its user activation.
    void pendingExit.then(() => (get().program ? enterFullscreen() : false)).then((ok) => { if (ok && get().program) set({ enteredFullscreen: true }); });
  },
  stop: () => {
    const { program, returnHash } = get();
    if (!program) return;
    set({ program: null, enteredFullscreen: false });
    pendingExit = exitFullscreen();
    if (returnHash && window.location.hash !== returnHash) navigate(returnHash);
    const target = returnFocus;
    returnFocus = null;
    window.setTimeout(() => {
      if (target && target.isConnected) target.focus();
      else document.getElementById('main')?.focus();
    }, 0);
  },
}));
