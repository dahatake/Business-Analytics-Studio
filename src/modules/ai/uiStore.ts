import { create } from 'zustand';

export type AiPanel = 'explain' | 'review';

/** Which top-bar side panel is open (FR-274 explain, FR-278 Copilot analysis). */
export const useAiPanels = create<{ open: AiPanel | null; setOpen: (p: AiPanel | null) => void }>()((set) => ({
  open: null,
  setOpen: (open) => set({ open }),
}));

/** D-25: settings (一般 / AI 設定) exist as one set of tabs; every entry point (nav, launch, projects, links) opens it. */
export type SettingsTab = 'general' | 'ai';
export const useSettingsDialog = create<{ open: boolean; tab: SettingsTab }>()(() => ({ open: false, tab: 'general' }));
export const openSettings = (tab: SettingsTab = 'general') => useSettingsDialog.setState({ open: true, tab });
export const setSettingsTab = (tab: SettingsTab) => useSettingsDialog.setState({ tab });
export const closeSettings = () => useSettingsDialog.setState({ open: false });
export const openAiSettings = () => openSettings('ai');
