/** FR-298 runtime: opening popups, tracking which components are popped out, and keeping popups in sync. */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useSettings } from '../../state/settings.ts';
import { useProjects } from '../../state/projects.ts';
import type { ComponentId } from './personas.ts';
import {
  POPOUT_CHANNEL, POPOUT_PARAMS, markPoppedOut, markReturned, parsePopoutMessage, popoutHref, popupFeatures,
  storageSyncTarget, type Placement, type PopoutMessage, type PoppedOut, type ScreenDetailsLike,
} from './popout.ts';

/** In-memory: popups do not outlive the session that opened them, and they announce themselves after a reload. */
export const usePopouts = create<{ ids: PoppedOut }>()(() => ({ ids: [] }));

const windows = new Map<ComponentId, Window>();
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(POPOUT_CHANNEL);
  return channel;
}

function post(m: PopoutMessage) {
  getChannel()?.postMessage(m);
}

function update(f: (s: PoppedOut) => PoppedOut) {
  usePopouts.setState((s) => {
    const ids = f(s.ids);
    return ids === s.ids ? s : { ids };
  });
}

type WindowWithScreens = Window & { getScreenDetails?: () => Promise<ScreenDetailsLike> };

/** Window Management API (multi-screen placement) is available. */
export function hasWindowManagement(): boolean {
  return typeof window !== 'undefined' && 'getScreenDetails' in window && typeof (window as WindowWithScreens).getScreenDetails === 'function';
}

/** Asks for the displays; the browser may show a permission prompt, so call it only from a user action. */
export async function getScreenDetails(): Promise<ScreenDetailsLike> {
  const fn = (window as WindowWithScreens).getScreenDetails;
  if (!fn) throw new Error('unsupported');
  return fn.call(window);
}

/** True when the browser already granted the permission (no prompt will be shown). */
export async function screensAlreadyGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'window-management' as PermissionName });
    return status?.state === 'granted';
  } catch {
    return false;
  }
}

/** Opens (or focuses) the popup of a component; `null` when the browser blocked it. */
export function openPopout(id: ComponentId, placement: Placement): Window | null {
  const existing = windows.get(id);
  if (existing && !existing.closed) {
    existing.focus();
    return existing;
  }
  const url = `${window.location.pathname}${window.location.search}${popoutHref(id)}`;
  const w = window.open(url, `bas-ws-${id}`, popupFeatures(placement));
  if (!w) return null;
  windows.set(id, w);
  update((s) => markPoppedOut(s, id));
  return w;
}

/** Closes the popup and shows the component in the workspace again. */
export function bringBack(id: ComponentId) {
  const w = windows.get(id);
  windows.delete(id);
  if (w && !w.closed) w.close();
  post({ type: 'close', id });
  update((s) => markReturned(s, id));
}

/** Main window: follow popups opening and closing (BroadcastChannel, plus polling `closed` as a fallback). */
export function usePopoutHost(onReturned: (id: ComponentId) => void) {
  const cb = useRef(onReturned);
  cb.current = onReturned;
  useEffect(() => {
    const returned = (id: ComponentId) => {
      windows.delete(id);
      const was = usePopouts.getState().ids;
      update((s) => markReturned(s, id));
      if (was !== usePopouts.getState().ids) cb.current(id);
    };
    const ch = getChannel();
    const onMessage = (e: MessageEvent) => {
      const m = parsePopoutMessage(e.data);
      if (m?.type === 'open') update((s) => markPoppedOut(s, m.id));
      else if (m?.type === 'closed') returned(m.id);
    };
    ch?.addEventListener('message', onMessage);
    // Popups opened before a reload of this window announce themselves again.
    post({ type: 'ping' });
    const timer = window.setInterval(() => {
      for (const [id, w] of windows) if (w.closed) returned(id);
    }, POPOUT_PARAMS.pollMs);
    return () => {
      ch?.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };
  }, []);
}

/** Popup window: announce itself, obey "bring back", and follow language, theme and project changes of the main window. */
export function usePopoutGuest(id: ComponentId | null) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.wsPopout = 'true';
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return;
      const target = storageSyncTarget(e.key);
      if (target === 'settings' || e.key === null) void useSettings.persist.rehydrate();
      if (target === 'projects' || e.key === null) void useProjects.persist.rehydrate();
    };
    window.addEventListener('storage', onStorage);
    const ch = getChannel();
    const onMessage = (e: MessageEvent) => {
      const m = parsePopoutMessage(e.data);
      if (!id || !m) return;
      if (m.type === 'ping') post({ type: 'open', id });
      else if (m.type === 'close' && m.id === id) window.close();
    };
    const onHide = () => { if (id) post({ type: 'closed', id }); };
    ch?.addEventListener('message', onMessage);
    window.addEventListener('pagehide', onHide);
    if (id) post({ type: 'open', id });
    return () => {
      delete root.dataset.wsPopout;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', onHide);
      ch?.removeEventListener('message', onMessage);
    };
  }, [id]);
}
