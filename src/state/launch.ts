import { create } from 'zustand';

/**
 * Start-up sequence: 1) opening (splash, app name only, FR-076) → 2) choose a company and project (LaunchScreen)
 * → 3) the project screen. The choice is made once per browser session, like the opening.
 */
export type LaunchStage = 'opening' | 'select' | 'app';

export const LAUNCH_CHOSEN_KEY = 'bas.launchChosen';
export const OPENING_SEEN_KEY = 'bas.openingSeen';

const chosen = () => sessionStorage.getItem(LAUNCH_CHOSEN_KEY) === '1';
const openingSeen = () => sessionStorage.getItem(OPENING_SEEN_KEY) === '1';

interface LaunchState {
  stage: LaunchStage;
  finishOpening: () => void;
  choose: () => void;
  /** Back to the selection screen (the work-target menu offers it). */
  reopen: () => void;
}

export const useLaunch = create<LaunchState>()((set) => ({
  stage: chosen() ? 'app' : openingSeen() ? 'select' : 'opening',
  finishOpening: () => {
    sessionStorage.setItem(OPENING_SEEN_KEY, '1');
    set((s) => ({ stage: s.stage === 'opening' ? (chosen() ? 'app' : 'select') : s.stage }));
  },
  choose: () => {
    sessionStorage.setItem(LAUNCH_CHOSEN_KEY, '1');
    set({ stage: 'app' });
  },
  reopen: () => {
    sessionStorage.removeItem(LAUNCH_CHOSEN_KEY);
    set({ stage: 'select' });
  },
}));
