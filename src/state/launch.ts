import { create } from 'zustand';
import { SKIP_OPENING_ONCE_KEY } from '../data/deviceStorage.ts';

/**
 * Start-up sequence: 1) opening (splash, app name only, FR-076) → 2) choose a company and project (LaunchScreen)
 * → 3) the project screen. The choice is made once per browser session.
 */
export type LaunchStage = 'opening' | 'select' | 'app';

export const LAUNCH_CHOSEN_KEY = 'bas.launchChosen';
const chosen = () => sessionStorage.getItem(LAUNCH_CHOSEN_KEY) === '1';
const skipOpening = () => {
  const skip = sessionStorage.getItem(SKIP_OPENING_ONCE_KEY) === '1';
  sessionStorage.removeItem(SKIP_OPENING_ONCE_KEY);
  return skip;
};

interface LaunchState {
  stage: LaunchStage;
  finishOpening: () => void;
  choose: () => void;
  /** Back to the selection screen (the work-target menu offers it). */
  reopen: () => void;
}

export const useLaunch = create<LaunchState>()((set) => ({
  stage: skipOpening() ? (chosen() ? 'app' : 'select') : 'opening',
  finishOpening: () => {
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
