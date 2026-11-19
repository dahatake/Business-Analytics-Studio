import { create } from 'zustand';

/** FR-347: where "back to the strategy map" returns to (the clicked node is the route target, so focus lands on it). */
export interface PortalReturn { path: string; href: string; label: string }

const KEY = 'bas.portalReturn';

function read(): PortalReturn | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as PortalReturn | null;
    return v && typeof v.path === 'string' && typeof v.href === 'string' && typeof v.label === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Per tab and session: navigation state, not project data. */
export const usePortalReturn = create<{ value: PortalReturn | null }>()(() => ({ value: typeof sessionStorage === 'undefined' ? null : read() }));

export function setPortalReturn(value: PortalReturn | null) {
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage unavailable: the in-memory state still works for this page */ }
  usePortalReturn.setState({ value });
}
