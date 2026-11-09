import { create } from 'zustand';

export type AiPanel = 'explain' | 'review';

/** Which top-bar side panel is open (FR-274 explain, FR-278 Copilot analysis). */
export const useAiPanels = create<{ open: AiPanel | null; setOpen: (p: AiPanel | null) => void }>()((set) => ({
  open: null,
  setOpen: (open) => set({ open }),
}));
