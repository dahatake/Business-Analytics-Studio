/** FR-298: moving a workspace component into its own window, on any display. Pure helpers (no DOM access). */
import { SETTINGS_STORAGE_KEY } from '../../state/settings.ts';
import { PROJECTS_STORAGE_KEY } from '../../state/projects.ts';
import { COMPONENT_IDS, type ComponentId } from './personas.ts';

export const POPOUT_SEGMENT = 'popout';
export const POPOUT_CHANNEL = 'bas.ws.popout';

export const POPOUT_PARAMS = {
  /** Share of the chosen display's available area the popup takes. */
  ratio: 0.8,
  minWidth: 480,
  minHeight: 360,
  /** Size used on the current screen when no display was chosen. */
  defaultWidth: 960,
  defaultHeight: 720,
  /** How often the workspace checks whether a popup was closed. */
  pollMs: 400,
} as const;

export const isComponentId = (v: unknown): v is ComponentId => typeof v === 'string' && (COMPONENT_IDS as readonly string[]).includes(v);

export function popoutHref(id: ComponentId): string {
  return `#/workspace/${POPOUT_SEGMENT}/${encodeURIComponent(id)}`;
}

/** `null` when the route is not a popout; `{ id: null }` for a popout of an unknown component. */
export function popoutRoute(segments: readonly string[]): { id: ComponentId | null } | null {
  if (segments[0] !== 'workspace' || segments[1] !== POPOUT_SEGMENT) return null;
  const id = segments[2];
  return { id: isComponentId(id) ? id : null };
}

/** The parts of a Window Management API `ScreenDetailed` we use. */
export interface ScreenLike {
  label?: string;
  width: number;
  height: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  isPrimary?: boolean;
}

export interface ScreenDetailsLike {
  screens: readonly ScreenLike[];
  currentScreen?: ScreenLike | null;
}

export interface Placement {
  left?: number;
  top?: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A popup centred on a display's available area (taskbars excluded), `ratio` of its size. */
export function placementOn(screen: ScreenLike, ratio: number = POPOUT_PARAMS.ratio): Placement {
  const aw = Math.max(1, Math.round(screen.availWidth));
  const ah = Math.max(1, Math.round(screen.availHeight));
  const width = clamp(Math.round(aw * ratio), Math.min(POPOUT_PARAMS.minWidth, aw), aw);
  const height = clamp(Math.round(ah * ratio), Math.min(POPOUT_PARAMS.minHeight, ah), ah);
  return {
    left: Math.round(screen.availLeft + (aw - width) / 2),
    top: Math.round(screen.availTop + (ah - height) / 2),
    width,
    height,
  };
}

/** No display chosen: let the browser place the popup on the current screen. */
export function defaultPlacement(): Placement {
  return { width: POPOUT_PARAMS.defaultWidth, height: POPOUT_PARAMS.defaultHeight };
}

export function popupFeatures(p: Placement): string {
  const parts = ['popup=yes', `width=${Math.round(p.width)}`, `height=${Math.round(p.height)}`];
  if (p.left !== undefined) parts.push(`left=${Math.round(p.left)}`);
  if (p.top !== undefined) parts.push(`top=${Math.round(p.top)}`);
  return parts.join(',');
}

export interface ScreenOption {
  index: number;
  /** Empty when the browser gives no label; the UI shows "Display n" instead. */
  label: string;
  width: number;
  height: number;
  primary: boolean;
  current: boolean;
  screen: ScreenLike;
}

export function screenOptions(details: ScreenDetailsLike): ScreenOption[] {
  const current = details.currentScreen ?? null;
  return details.screens.map((s, index) => ({
    index,
    label: (s.label ?? '').trim(),
    width: Math.round(s.width),
    height: Math.round(s.height),
    primary: !!s.isPrimary,
    current: current === s,
    screen: s,
  }));
}

// ---------- Popped-out state ----------

export type PoppedOut = readonly ComponentId[];

export const isPoppedOut = (s: PoppedOut, id: string): boolean => (s as readonly string[]).includes(id);

export function markPoppedOut(s: PoppedOut, id: ComponentId): PoppedOut {
  return isPoppedOut(s, id) ? s : [...s, id];
}

export function markReturned(s: PoppedOut, id: ComponentId): PoppedOut {
  return isPoppedOut(s, id) ? s.filter((x) => x !== id) : s;
}

// ---------- Messages between the workspace and its popups (BroadcastChannel) ----------

export type PopoutMessage =
  | { type: 'open'; id: ComponentId }
  | { type: 'closed'; id: ComponentId }
  | { type: 'close'; id: ComponentId }
  | { type: 'ping' };

export function parsePopoutMessage(data: unknown): PopoutMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as { type?: unknown; id?: unknown };
  if (m.type === 'ping') return { type: 'ping' };
  if ((m.type === 'open' || m.type === 'closed' || m.type === 'close') && isComponentId(m.id)) return { type: m.type, id: m.id };
  return null;
}

/** Which persisted store a `storage` event belongs to, so a popup can follow the main window. */
export function storageSyncTarget(key: string | null): 'settings' | 'projects' | null {
  if (key === SETTINGS_STORAGE_KEY) return 'settings';
  if (key === PROJECTS_STORAGE_KEY) return 'projects';
  return null;
}
