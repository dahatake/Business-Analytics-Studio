import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { loaded } from '../../data/pack.ts';
import { createScopedStore } from '../../state/projects.ts';
import { demoAnalyses } from './analysis.ts';
import { demoDiscussion, DiscussionEditor, type ChangeEntry, type Lens } from './discussion.ts';
import { demoKpis } from './kpiOkr.ts';
import type { AnalysisData, DiscussionData, KpiData } from './model.ts';
import { useUseCases, type UseCase } from '../usecases/store.ts';
import { UseCaseImportUndo } from './useCaseImport.ts';

/** Project-scoped data (G-007): the demo scope starts from the sample pack, new projects start empty. */
export const useDiscussion = createScopedStore<DiscussionData>('proj.discussion', (scope) => (scope === 'demo' ? demoDiscussion() : { themes: [], records: [] }));
export const useChangeHistory = createScopedStore<ChangeEntry[]>('proj.history', () => []);
export const useKpis = createScopedStore<KpiData>('proj.kpi', (scope) => (scope === 'demo' ? demoKpis(loaded.pack) : { kpis: [], okrs: [] }));
export const useAnalyses = createScopedStore<AnalysisData>('proj.analysis', (scope) => (scope === 'demo' ? demoAnalyses(loaded.pack) : { analyses: [], activeId: null }));

/** Device-level preferences of this module (not project data). */
interface ProjUiState {
  editor: string;
  editMode: boolean;
  lens: Lens;
  analysisLayout: 'split' | 'results' | 'stacked';
  firstRunDone: boolean;
  setEditor: (v: string) => void;
  setEditMode: (v: boolean) => void;
  setLens: (v: Lens) => void;
  setAnalysisLayout: (v: ProjUiState['analysisLayout']) => void;
  setFirstRunDone: (v: boolean) => void;
}

export const useProjUi = create<ProjUiState>()(
  persist(
    (set) => ({
      editor: '',
      editMode: true,
      lens: 'business',
      analysisLayout: 'split',
      firstRunDone: false,
      setEditor: (editor) => set({ editor }),
      setEditMode: (editMode) => set({ editMode }),
      setLens: (lens) => set({ lens }),
      setAnalysisLayout: (analysisLayout) => set({ analysisLayout }),
      setFirstRunDone: (firstRunDone) => set({ firstRunDone }),
    }),
    { name: 'bas.proj.ui', version: 1, storage: createJSONStorage(() => localStorage) },
  ),
);

/** Transient UI state shared by the top bar, the overlay and the screens. */
interface ProjTransient {
  exportOpen: boolean;
  exportThemeId: string | null;
  selectedThemeId: string | null;
  /** Bumped on every undo-stack change so buttons re-render. */
  undoVersion: number;
  openExport: (themeId?: string | null) => void;
  closeExport: () => void;
  selectTheme: (id: string | null) => void;
}

export const useProjTransient = create<ProjTransient>()((set) => ({
  exportOpen: false,
  exportThemeId: null,
  selectedThemeId: null,
  undoVersion: 0,
  openExport: (themeId = null) => set({ exportOpen: true, exportThemeId: themeId }),
  closeExport: () => set({ exportOpen: false }),
  selectTheme: (selectedThemeId) => set({ selectedThemeId }),
}));

/** One editor (undo stack + history) per scope; rebuilt when the work target changes so projects never share undo. */
let editor: DiscussionEditor | null = null;
let editorScope = '';

export function discussionEditor(): DiscussionEditor {
  const { scope, value } = useDiscussion.getState();
  if (!editor || editorScope !== scope) {
    editor = new DiscussionEditor(value, useChangeHistory.getState().value);
    editorScope = scope;
  } else if (editor.value !== value) {
    // The store changed outside the editor (e.g. reset): adopt it as the new baseline.
    editor.reset(value, useChangeHistory.getState().value);
  }
  return editor;
}

function sync(ed: DiscussionEditor) {
  useDiscussion.getState().set(ed.value);
  useChangeHistory.getState().set(ed.history);
  useProjTransient.setState((s) => ({ undoVersion: s.undoVersion + 1 }));
}

const who = () => useProjUi.getState().editor.trim();

export function commitDiscussion(next: DiscussionData, op: Parameters<DiscussionEditor['apply']>[2], target: Parameters<DiscussionEditor['apply']>[3], label: Parameters<DiscussionEditor['apply']>[4]) {
  const ed = discussionEditor();
  ed.apply(next, who(), op, target, label);
  sync(ed);
}

export function undoDiscussion() {
  const ed = discussionEditor();
  if (!ed.stack.canUndo) return;
  ed.undo(who());
  sync(ed);
}

export function redoDiscussion() {
  const ed = discussionEditor();
  if (!ed.stack.canRedo) return;
  ed.redo(who());
  sync(ed);
}

/* ---------- Use cases restored from an export (I-1): written via the usecases store, undoable ---------- */

const ucImportUndo = new UseCaseImportUndo();
const bump = () => useProjTransient.setState((s) => ({ undoVersion: s.undoVersion + 1 }));

export function commitUseCaseImport(next: UseCase[]) {
  const { scope, value, set } = useUseCases.getState();
  if (next === value) return;
  set(ucImportUndo.commit(scope, value, next));
  bump();
}

export function canUndoUseCaseImport(): boolean {
  const { scope, value } = useUseCases.getState();
  return ucImportUndo.canUndo(scope, value);
}

export function undoUseCaseImport() {
  const { scope, value, set } = useUseCases.getState();
  const prev = ucImportUndo.undo(scope, value);
  if (prev) set(prev);
  bump();
}
