import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POPOUT_PARAMS, defaultPlacement, isComponentId, isPoppedOut, markPoppedOut, markReturned, parsePopoutMessage,
  placementOn, popoutHref, popoutRoute, popupFeatures, screenOptions, storageSyncTarget, type ScreenLike,
} from '../src/modules/workspace/popout.ts';
import { bringBack, hasWindowManagement, openPopout, usePopouts } from '../src/modules/workspace/popoutRuntime.ts';
import { parseHash } from '../src/state/router.ts';
import { SETTINGS_STORAGE_KEY } from '../src/state/settings.ts';
import { PROJECTS_STORAGE_KEY, scopedKey } from '../src/state/projects.ts';

const LAPTOP: ScreenLike = { label: 'Built-in', width: 1920, height: 1080, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040, isPrimary: true };
const EXTERNAL: ScreenLike = { label: 'External', width: 2560, height: 1440, availLeft: 1920, availTop: -200, availWidth: 2560, availHeight: 1400 };

describe('workspace popout routes (FR-298)', () => {
  it('builds and parses the popout route of a component', () => {
    expect(popoutHref('matrix')).toBe('#/workspace/popout/matrix');
    expect(popoutRoute(parseHash(popoutHref('matrix')).segments)).toEqual({ id: 'matrix' });
  });

  it('tells the normal workspace, other screens and unknown components apart', () => {
    expect(popoutRoute(['workspace'])).toBeNull();
    expect(popoutRoute(['board', 'popout', 'matrix'])).toBeNull();
    expect(popoutRoute(['workspace', 'popout', 'nope'])).toEqual({ id: null });
    expect(popoutRoute(['workspace', 'popout'])).toEqual({ id: null });
    expect(isComponentId('kpi')).toBe(true);
    expect(isComponentId(42)).toBe(false);
  });
});

describe('popup placement on a display', () => {
  it('centres the popup on the available area of the chosen display', () => {
    expect(placementOn(EXTERNAL)).toEqual({ left: 1920 + 256, top: -200 + 140, width: 2048, height: 1120 });
    expect(placementOn(LAPTOP)).toEqual({ left: 192, top: 104, width: 1536, height: 832 });
  });

  it('keeps a minimum size but never exceeds the display', () => {
    const small: ScreenLike = { width: 500, height: 400, availLeft: 10, availTop: 20, availWidth: 500, availHeight: 400 };
    const p = placementOn(small);
    expect(p.width).toBe(POPOUT_PARAMS.minWidth);
    expect(p.height).toBe(POPOUT_PARAMS.minHeight);
    expect(p.left! + p.width).toBeLessThanOrEqual(10 + 500);
    const tiny: ScreenLike = { width: 300, height: 200, availLeft: 0, availTop: 0, availWidth: 300, availHeight: 200 };
    expect(placementOn(tiny)).toEqual({ left: 0, top: 0, width: 300, height: 200 });
    expect(placementOn(LAPTOP, 1)).toEqual({ left: 0, top: 0, width: 1920, height: 1040 });
  });

  it('formats window.open features, with a position only when a display was chosen', () => {
    expect(popupFeatures(placementOn(EXTERNAL))).toBe('popup=yes,width=2048,height=1120,left=2176,top=-60');
    expect(popupFeatures(defaultPlacement())).toBe(`popup=yes,width=${POPOUT_PARAMS.defaultWidth},height=${POPOUT_PARAMS.defaultHeight}`);
  });

  it('lists displays with label, size, primary and current marks', () => {
    const opts = screenOptions({ screens: [LAPTOP, { ...EXTERNAL, label: '  ' }], currentScreen: LAPTOP });
    expect(opts.map(({ screen: _s, ...o }) => o)).toEqual([
      { index: 0, label: 'Built-in', width: 1920, height: 1080, primary: true, current: true },
      { index: 1, label: '', width: 2560, height: 1440, primary: false, current: false },
    ]);
  });
});

describe('popped-out state', () => {
  it('adds and removes components without duplicates and keeps the reference when unchanged', () => {
    const a = markPoppedOut([], 'map');
    expect(a).toEqual(['map']);
    expect(markPoppedOut(a, 'map')).toBe(a);
    expect(isPoppedOut(a, 'map')).toBe(true);
    expect(isPoppedOut(a, 'kpi')).toBe(false);
    const b = markPoppedOut(a, 'kpi');
    expect(markReturned(b, 'map')).toEqual(['kpi']);
    expect(markReturned(a, 'kpi')).toBe(a);
  });

  it('accepts only well-formed messages between windows', () => {
    expect(parsePopoutMessage({ type: 'open', id: 'chain' })).toEqual({ type: 'open', id: 'chain' });
    expect(parsePopoutMessage({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(parsePopoutMessage({ type: 'closed', id: 'evil' })).toBeNull();
    expect(parsePopoutMessage({ type: 'other', id: 'chain' })).toBeNull();
    expect(parsePopoutMessage('open')).toBeNull();
    expect(parsePopoutMessage(null)).toBeNull();
  });

  it('follows only the stores that carry language, theme and project scope', () => {
    expect(storageSyncTarget(SETTINGS_STORAGE_KEY)).toBe('settings');
    expect(storageSyncTarget(PROJECTS_STORAGE_KEY)).toBe('projects');
    expect(storageSyncTarget(scopedKey('demo', 'workspace'))).toBeNull();
    expect(storageSyncTarget(null)).toBeNull();
  });
});

describe('popout runtime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    usePopouts.setState({ ids: [] });
  });

  it('opens the component route in a placed popup and marks it popped out until brought back', () => {
    const fake = { closed: false, close: vi.fn(), focus: vi.fn() } as unknown as Window;
    const spy = vi.spyOn(window, 'open').mockReturnValue(fake);
    expect(openPopout('plan', placementOn(EXTERNAL))).toBe(fake);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/#\/workspace\/popout\/plan$/), 'bas-ws-plan', 'popup=yes,width=2048,height=1120,left=2176,top=-60');
    expect(usePopouts.getState().ids).toEqual(['plan']);
    // A second request focuses the same window instead of opening another.
    openPopout('plan', defaultPlacement());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fake.focus).toHaveBeenCalled();
    bringBack('plan');
    expect(fake.close).toHaveBeenCalled();
    expect(usePopouts.getState().ids).toEqual([]);
  });

  it('does not mark a component popped out when the popup is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPopout('kpi', defaultPlacement())).toBeNull();
    expect(usePopouts.getState().ids).toEqual([]);
  });

  it('detects the Window Management API', () => {
    expect(hasWindowManagement()).toBe(false);
    (window as unknown as { getScreenDetails: () => Promise<unknown> }).getScreenDetails = async () => ({ screens: [] });
    expect(hasWindowManagement()).toBe(true);
    delete (window as unknown as { getScreenDetails?: unknown }).getScreenDetails;
  });
});
