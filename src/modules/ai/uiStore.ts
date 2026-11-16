import { create } from 'zustand';

export type AiPanel = 'explain' | 'review';

/** Which top-bar side panel is open (FR-274 explain, FR-278 Copilot analysis). */
export const useAiPanels = create<{ open: AiPanel | null; setOpen: (p: AiPanel | null) => void }>()((set) => ({
  open: null,
  setOpen: (open) => set({ open }),
}));

/** D-25: AI settings exist only as this one dialog; every entry point (nav, launch, projects, links) opens it. */
export const useAiSettingsDialog = create<{ open: boolean }>()(() => ({ open: false }));
export const openAiSettings = () => useAiSettingsDialog.setState({ open: true });
export const closeAiSettings = () => useAiSettingsDialog.setState({ open: false });
