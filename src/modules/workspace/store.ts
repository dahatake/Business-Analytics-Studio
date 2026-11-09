import { create } from 'zustand';
import { createScopedStore } from '../../state/projects.ts';
import { collapseExpanded, WS_PARAMS, type ExpandPosition, type Layout } from './layout.ts';
import { defaultLayout, isWsPersona, pushRecent, type RecentContext, type WsPersona } from './personas.ts';

export interface WorkspaceData {
  /** Last chosen persona view (first time: executive, §7 / A-13). */
  persona: WsPersona;
  /** Saved layout per persona (browser × persona, §7); per project through the scoped store (FR-138). */
  layouts: Partial<Record<WsPersona, Layout>>;
  recent: RecentContext[];
  /** FR-175: position of the expanded view (default PARAM-059). */
  expand?: ExpandPosition;
  /** FR-143: enlarge the active component (default on). */
  enlarge?: boolean;
}

const initial = (): WorkspaceData => ({ persona: 'executive', layouts: {}, recent: [] });

export const useWorkspace = createScopedStore<WorkspaceData>('workspace', initial);

function sane(d: WorkspaceData | null | undefined): WorkspaceData {
  if (!d || typeof d !== 'object' || !isWsPersona(d.persona)) return initial();
  return { ...d, layouts: d.layouts ?? {}, recent: Array.isArray(d.recent) ? d.recent.filter((r) => isWsPersona(r?.persona)) : [] };
}

const defaults = new Map<WsPersona, Layout>();

export function layoutOf(d: WorkspaceData, persona: WsPersona = sane(d).persona): Layout {
  const saved = sane(d).layouts[persona];
  if (saved && Array.isArray(saved.wins)) return saved;
  // Cached so selectors return a stable reference.
  if (!defaults.has(persona)) defaults.set(persona, defaultLayout(persona));
  return defaults.get(persona)!;
}

export function currentPersona(): WsPersona {
  return sane(useWorkspace.getState().value).persona;
}

export function setLayout(update: (l: Layout) => Layout) {
  useWorkspace.getState().set((prev) => {
    const d = sane(prev);
    return { ...d, layouts: { ...d.layouts, [d.persona]: update(layoutOf(d)) } };
  });
}

/** Records when a mode switch started, so the screen can report how long it took (PARAM-139). */
export const switchClock = { startedAt: 0 };

/** FR-015: switch the persona view; each persona keeps its own saved layout (NFR-UX-001). */
export function switchPersona(persona: WsPersona) {
  switchClock.startedAt = performance.now();
  useWorkspace.getState().set((prev) => {
    const d = sane(prev);
    return { ...d, persona, recent: pushRecent(d.recent, persona, Date.now(), WS_PARAMS.recentMax) };
  });
}

/** FR-110: back to the persona default. */
export function resetLayout() {
  useWorkspace.getState().set((prev) => {
    const d = sane(prev);
    const { [d.persona]: _dropped, ...rest } = d.layouts;
    return { ...d, layouts: rest };
  });
}

/** The expanded view is not kept across reloads (A-41). */
export function collapseAllExpanded() {
  const d = sane(useWorkspace.getState().value);
  const entries = Object.entries(d.layouts) as [WsPersona, Layout][];
  if (!entries.some(([, l]) => l.wins.some((w) => w.expandedFrom))) return;
  useWorkspace.getState().set({ ...d, layouts: Object.fromEntries(entries.map(([p, l]) => [p, collapseExpanded(l)])) });
}

export function usePersona(): WsPersona {
  return useWorkspace((s) => sane(s.value).persona);
}

export function useLayout(): Layout {
  return useWorkspace((s) => layoutOf(s.value));
}

const NO_RECENT: RecentContext[] = [];

export function useRecent(): RecentContext[] {
  return useWorkspace((s) => (Array.isArray(s.value?.recent) ? s.value.recent : NO_RECENT));
}

/** View state shared by hosted components, kept outside the windows so layout changes never lose it (NFR-UX-001). */
export const useHostState = create<{ chainSel: string | null; setChainSel: (id: string | null) => void }>()((set) => ({
  chainSel: null,
  setChainSel: (chainSel) => set({ chainSel }),
}));

export function useOptions(): { expand: ExpandPosition; enlarge: boolean } {
  const expand = useWorkspace((s) => s.value?.expand ?? WS_PARAMS.expandPosition);
  const enlarge = useWorkspace((s) => s.value?.enlarge ?? true);
  return { expand, enlarge };
}

export function setOptions(o: { expand?: ExpandPosition; enlarge?: boolean }) {
  useWorkspace.getState().set((prev) => ({ ...sane(prev), ...o }));
}