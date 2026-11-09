import { describe, expect, it } from 'vitest';
import {
  WS_PARAMS, TEMPLATES, applySnap, applyTemplate, arrangeByImportance, buildLayout, clampRect, enforceMaxVisible,
  enlargedRect, expandRect, fitToArea, getWin, hide, isShown, maximize, minimize, moveWin, nudge, overlaps, rectOf,
  resizeBy, restore, snapTargetAt, templateDwell, templateFillOrder, toggleExpand, togglePin, visibleCount, type Area,
  type Layout,
} from '../src/modules/workspace/layout.ts';
import { PERSONA_DEFAULTS, WS_PERSONAS, defaultLayout, pushRecent } from '../src/modules/workspace/personas.ts';

const AREA: Area = { width: 1000, height: 640 };

const shownRects = (l: Layout) => l.wins.filter((w) => w.state === 'normal' && !w.expandedFrom).map((w) => ({ id: w.id, r: w.rect }));

function noOverlaps(l: Layout) {
  const rs = shownRects(l);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) expect(overlaps(rs[i]!.r, rs[j]!.r), `${rs[i]!.id} × ${rs[j]!.id}`).toBe(false);
  }
}

function inArea(l: Layout) {
  for (const { r } of shownRects(l)) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-6);
  }
}

const four = () => buildLayout([
  { id: 'a', rect: rectOf(0, 0, 0.5, 0.5) },
  { id: 'b', rect: rectOf(0.5, 0, 0.5, 0.5) },
  { id: 'c', rect: rectOf(0, 0.5, 0.5, 0.5) },
  { id: 'd', rect: rectOf(0.5, 0.5, 0.5, 0.5) },
]);

describe('workspace PARAMs', () => {
  it('mirror the PARAM table', () => {
    expect(WS_PARAMS.minWidthPx).toBe(360);
    expect(WS_PARAMS.minHeightPx).toBe(240);
    expect(WS_PARAMS.maxVisible).toBe(4);
    expect(WS_PARAMS.snapPx).toBe(32);
    expect(WS_PARAMS.templateZoneRatio).toBe(0.4);
    expect(WS_PARAMS.templateDwellMs).toBe(300);
    expect(WS_PARAMS.pinTolerance).toBe(0.01);
    expect(WS_PARAMS.expandRatio).toBe(0.75);
    expect(WS_PARAMS.expandPosition).toBe('top');
    expect(WS_PARAMS.activeScale).toBe(1.5);
    expect(WS_PARAMS.motionMs).toBe(200);
    expect(WS_PARAMS.transitionMaxMs).toBe(500);
    expect(WS_PARAMS.dimRatio).toBe(0.6);
    expect(WS_PARAMS.acrylicMinOpacity).toBe(0.8);
    expect(WS_PARAMS.zones).toEqual({ main: 0.6, reference: 0.25, communication: 0.15 });
    expect(WS_PARAMS.important).toEqual({ w: 0.5, h: 0.5 });
    expect(WS_PARAMS.normal).toEqual({ w: 0.3, h: 0.4 });
    expect(WS_PARAMS.switchMaxMs).toBe(1000);
    expect(WS_PARAMS.recentMax).toBe(5);
    expect(WS_PARAMS.maxHeaderButtons).toBe(6);
    expect(WS_PARAMS.minTargetPx).toBe(24);
  });
});

describe('minimum size clamp (PARAM-134/135, FR-296)', () => {
  it('never smaller than 360×240 px and never outside the area', () => {
    const r = clampRect(rectOf(0.9, 0.95, 0.1, 0.1), AREA);
    expect(r.w * AREA.width).toBeGreaterThanOrEqual(360 - 0.1);
    expect(r.h * AREA.height).toBeGreaterThanOrEqual(240 - 0.1);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });

  it('a tiny area gives the whole area', () => {
    expect(clampRect(rectOf(0.2, 0.2, 0.1, 0.1), { width: 300, height: 200 })).toEqual(rectOf(0, 0, 1, 1));
  });

  it('resizing by keyboard stops at the minimum', () => {
    let l = four();
    for (let i = 0; i < 20; i++) l = resizeBy(l, 'a', -WS_PARAMS.keyStep, -WS_PARAMS.keyStep, AREA);
    const a = getWin(l, 'a')!.rect;
    expect(a.w * AREA.width).toBeGreaterThanOrEqual(360 - 0.1);
    expect(a.h * AREA.height).toBeGreaterThanOrEqual(240 - 0.1);
  });
});

describe('max 4 visible (PARAM-136, FR-296)', () => {
  it('extra components are minimized, not squeezed', () => {
    const l = buildLayout(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, rect: rectOf(0, 0, 0.5, 0.5) })));
    expect(visibleCount(l)).toBe(4);
    expect(l.wins.filter((w) => w.state === 'minimized').map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('restoring a fifth minimizes the least recently used one', () => {
    let l = buildLayout([...four().wins.map((w) => ({ id: w.id, rect: w.rect })), { id: 'e', rect: rectOf(0, 0, 0.5, 0.5), state: 'minimized' as const }]);
    expect(visibleCount(l)).toBe(4);
    l = restore(l, 'e', AREA);
    expect(getWin(l, 'e')!.state).toBe('normal');
    expect(visibleCount(l)).toBeLessThanOrEqual(4);
    noOverlaps(l);
  });

  it('pinned components count but are minimized last', () => {
    let l = togglePin(four(), 'a');
    l = { ...l, wins: [...l.wins, { id: 'e', rect: rectOf(0, 0, 0.3, 0.3), state: 'normal', pinned: false, z: 99, used: 99 }] };
    l = enforceMaxVisible(l, ['e']);
    expect(getWin(l, 'a')!.state).toBe('normal');
    expect(visibleCount(l)).toBe(4);
  });

  it('every persona default shows at most 4 and nothing overlaps', () => {
    for (const p of WS_PERSONAS) {
      const l = defaultLayout(p);
      expect(visibleCount(l), p).toBeLessThanOrEqual(4);
      noOverlaps(l);
      inArea(l);
      expect(l.wins.every((w) => !w.pinned)).toBe(true);
    }
  });
});

describe('snap (PARAM-042, FR-152) and templates (PARAM-143/144, FR-305)', () => {
  it('offers candidates only within 32 px of an edge or corner', () => {
    expect(snapTargetAt(32, 300, AREA)).toBe('left');
    expect(snapTargetAt(33, 300, AREA)).toBeNull();
    expect(snapTargetAt(AREA.width - 32, 300, AREA)).toBe('right');
    expect(snapTargetAt(AREA.width - 33, 300, AREA)).toBeNull();
    expect(snapTargetAt(500, AREA.height - 32, AREA)).toBe('bottom');
    expect(snapTargetAt(500, AREA.height - 33, AREA)).toBeNull();
    expect(snapTargetAt(10, 10, AREA)).toBe('top-left');
    expect(snapTargetAt(AREA.width - 5, 10, AREA)).toBe('top-right');
    expect(snapTargetAt(5, AREA.height - 5, AREA)).toBe('bottom-left');
    expect(snapTargetAt(AREA.width - 5, AREA.height - 5, AREA)).toBe('bottom-right');
  });

  it('the centre 40% of the top edge offers templates; the rest maximizes', () => {
    expect(snapTargetAt(500, 10, AREA)).toBe('template');
    expect(snapTargetAt(300, 10, AREA)).toBe('template');
    expect(snapTargetAt(700, 10, AREA)).toBe('template');
    expect(snapTargetAt(299, 10, AREA)).toBe('maximize');
    expect(snapTargetAt(701, 10, AREA)).toBe('maximize');
    expect(snapTargetAt(500, 33, AREA)).toBeNull();
  });

  it('templates pop up only after a 300 ms dwell', () => {
    let s = templateDwell(null, true, 1000);
    expect(s.open).toBe(false);
    s = templateDwell(s.since, true, 1299);
    expect(s.open).toBe(false);
    s = templateDwell(s.since, true, 1300);
    expect(s.open).toBe(true);
    expect(templateDwell(s.since, false, 1400)).toEqual({ since: null, open: false });
  });

  it('snapping places the component and pushes the others aside', () => {
    const l = applySnap(four(), 'd', 'left', AREA);
    expect(getWin(l, 'd')!.rect).toEqual(rectOf(0, 0, 0.5, 1));
    noOverlaps(l);
    inArea(l);
  });

  it('snapping to the top (outside the centre) maximizes', () => {
    const l = applySnap(four(), 'a', 'maximize', AREA);
    expect(getWin(l, 'a')!.state).toBe('maximized');
  });

  it('fills the slots in order: the dragged one in the chosen slot, then the others front-most first', () => {
    const base = four(); // z: a=1, b=2, c=3, d=4
    const l = applyTemplate(base, 'mainStack', 1, 'a', AREA);
    expect(templateFillOrder('mainStack', 1)).toEqual([1, 0, 2]);
    expect(getWin(l, 'a')!.rect).toEqual(TEMPLATES.mainStack[1]);
    expect(getWin(l, 'd')!.rect).toEqual(TEMPLATES.mainStack[0]);
    expect(getWin(l, 'c')!.rect).toEqual(TEMPLATES.mainStack[2]);
    expect(getWin(l, 'b')!.state).toBe('back');
    expect(getWin(l, 'b')!.backReason).toBe('template');
    expect(visibleCount(l)).toBe(3);
    noOverlaps(l);
  });

  it('a back component returns only from the task list (restore)', () => {
    let l = applyTemplate(four(), 'halves', 0, 'a', AREA);
    expect(getWin(l, 'c')!.state).toBe('back');
    l = restore(l, 'c', AREA);
    expect(getWin(l, 'c')!.state).toBe('normal');
    noOverlaps(l);
  });
});

describe('push-aside (FR-184)', () => {
  it('never leaves overlaps, whatever the move', () => {
    const targets = [rectOf(0.25, 0.25, 0.5, 0.5), rectOf(0.1, 0.6, 0.4, 0.4), rectOf(0.6, 0, 0.4, 1), rectOf(0, 0, 1, 0.5), rectOf(0.4, 0.4, 0.6, 0.6)];
    for (const id of ['a', 'b', 'c', 'd']) {
      for (const r of targets) {
        const l = moveWin(four(), id, r, AREA);
        noOverlaps(l);
        inArea(l);
        expect(visibleCount(l)).toBeLessThanOrEqual(4);
      }
    }
  });

  it('keyboard nudges move by one step and push the neighbour', () => {
    const base = buildLayout([{ id: 'a', rect: rectOf(0, 0, 0.4, 0.4) }, { id: 'b', rect: rectOf(0.45, 0, 0.4, 0.4) }]);
    const l = nudge(base, 'a', WS_PARAMS.keyStep * 2, 0, AREA);
    expect(getWin(l, 'a')!.rect.x).toBeCloseTo(0.1, 5);
    noOverlaps(l);
  });

  it('pinned components are not moved by others (FR-215/216)', () => {
    const base = togglePin(four(), 'b');
    const l = moveWin(base, 'a', rectOf(0.3, 0, 0.5, 0.5), AREA);
    expect(getWin(l, 'b')!.rect).toEqual(rectOf(0.5, 0, 0.5, 0.5));
    expect(getWin(l, 'b')!.state).toBe('normal');
  });
});

describe('pin keeps its ratios within 1% when the area changes (PARAM-072, FR-216)', () => {
  it('for several screen sizes', () => {
    const base = togglePin(buildLayout([{ id: 'p', rect: rectOf(0.13, 0.21, 0.37, 0.41) }, { id: 'q', rect: rectOf(0.6, 0.6, 0.4, 0.4) }]), 'p');
    for (const area of [{ width: 1920, height: 1000 }, { width: 1280, height: 640 }, { width: 900, height: 600 }, { width: 2560, height: 1300 }]) {
      const l = fitToArea(base, area);
      const r = getWin(l, 'p')!.rect;
      expect(Math.abs(r.x - 0.13)).toBeLessThanOrEqual(WS_PARAMS.pinTolerance);
      expect(Math.abs(r.y - 0.21)).toBeLessThanOrEqual(WS_PARAMS.pinTolerance);
      expect(Math.abs(r.w - 0.37)).toBeLessThanOrEqual(WS_PARAMS.pinTolerance);
      expect(Math.abs(r.h - 0.41)).toBeLessThanOrEqual(WS_PARAMS.pinTolerance);
    }
  });

  it('unpinned components are clamped and rearranged without overlaps', () => {
    const l = fitToArea(four(), { width: 800, height: 600 });
    noOverlaps(l);
    inArea(l);
    for (const { r } of shownRects(l)) expect(r.w * 800).toBeGreaterThanOrEqual(360 - 0.1);
  });
});

describe('expand 75% and restore (PARAM-058/059, FR-174/175)', () => {
  it('double-click expands to 75% at the top by default and again restores', () => {
    const base = four();
    const before = getWin(base, 'c')!.rect;
    const l = toggleExpand(base, 'c');
    expect(getWin(l, 'c')!.rect).toEqual(rectOf(0, 0, 1, 0.75));
    expect(getWin(l, 'c')!.expandedFrom).toEqual(before);
    const back = toggleExpand(l, 'c');
    expect(getWin(back, 'c')!.rect).toEqual(before);
    expect(getWin(back, 'c')!.expandedFrom).toBeUndefined();
  });

  it('honours the configured position', () => {
    expect(expandRect('left')).toEqual(rectOf(0, 0, 0.75, 1));
    expect(expandRect('right')).toEqual(rectOf(0.25, 0, 0.75, 1));
    expect(expandRect('bottom')).toEqual(rectOf(0, 0.25, 1, 0.75));
  });
});

describe('display states (FR-013, FR-014, FR-151, FR-295, FR-297)', () => {
  it('maximize sends the others to the back and restoring brings them back', () => {
    let l = maximize(four(), 'b');
    expect(getWin(l, 'b')!.state).toBe('maximized');
    expect(l.wins.filter((w) => w.id !== 'b').every((w) => w.state === 'back' && w.backReason === 'max')).toBe(true);
    expect(visibleCount(l)).toBe(1);
    l = restore(l, 'b', AREA);
    expect(l.wins.every((w) => w.state === 'normal')).toBe(true);
  });

  it('minimize and hide; the dock restores and brings to front', () => {
    let l = minimize(four(), 'a');
    expect(getWin(l, 'a')!.state).toBe('minimized');
    l = hide(l, 'b');
    expect(getWin(l, 'b')!.state).toBe('hidden');
    expect(isShown(getWin(l, 'b')!)).toBe(false);
    l = restore(l, 'a', AREA);
    const a = getWin(l, 'a')!;
    expect(a.state).toBe('normal');
    expect(a.z).toBe(Math.max(...l.wins.map((w) => w.z)));
  });

  it('restoring another component while one is maximized releases the maximize', () => {
    let l = minimize(four(), 'd');
    l = maximize(l, 'a');
    l = restore(l, 'd', AREA);
    expect(getWin(l, 'a')!.state).toBe('normal');
    expect(getWin(l, 'd')!.state).toBe('normal');
  });
});

describe('active enlargement ×1.5 only if it fits (PARAM-033, FR-143)', () => {
  it('grows by 1.5× area when there is room', () => {
    const l = buildLayout([{ id: 'a', rect: rectOf(0, 0, 0.4, 0.4) }]);
    const r = enlargedRect(l, 'a')!;
    expect((r.w * r.h) / (0.4 * 0.4)).toBeCloseTo(1.5, 2);
  });

  it('does not grow when it would cover another component', () => {
    expect(enlargedRect(four(), 'a')).toBeNull();
  });
});

describe('importance arrangement (PARAM-083/084)', () => {
  it('important 0.5×0.5, others 0.3×0.4 (clamped to the minimum size), no overlaps', () => {
    const big: Area = { width: 2000, height: 1200 };
    const l = arrangeByImportance(four(), 'c', big);
    expect(getWin(l, 'c')!.rect).toEqual(rectOf(0, 0, 0.5, 0.5));
    const others = l.wins.filter((w) => w.id !== 'c' && w.state === 'normal');
    for (const w of others) expect([w.rect.w, w.rect.h]).toEqual([0.3, 0.4]);
    noOverlaps(l);
  });
});

describe('reset to persona defaults (FR-110, FR-112)', () => {
  it('a default layout is restored exactly after changes', () => {
    const d = defaultLayout('executive');
    const changed = minimize(moveWin(togglePin(d, 'summary'), 'summary', rectOf(0.2, 0.2, 0.5, 0.5), AREA), 'kpi');
    expect(changed).not.toEqual(d);
    expect(defaultLayout('executive')).toEqual(d);
    expect(d.wins.map((w) => w.id).sort()).toEqual(PERSONA_DEFAULTS.executive.map((s) => s.id).sort());
  });

  it('the executive default follows §7 (summary on top, matrix in the main area, ranking beside)', () => {
    const d = defaultLayout('executive');
    const summary = getWin(d, 'summary')!.rect, matrix = getWin(d, 'matrix')!.rect, ranking = getWin(d, 'ranking')!.rect;
    expect(summary.y).toBe(0);
    expect(matrix.y).toBeGreaterThan(summary.y);
    expect(ranking.x).toBeGreaterThanOrEqual(matrix.x + matrix.w);
  });

  it('zones Main / Reference / Communication take 60 / 25 / 15% of the area', () => {
    const [main, ref, comm] = TEMPLATES.zones;
    expect(main!.w * main!.h).toBeCloseTo(0.6, 5);
    expect(ref!.w * ref!.h).toBeCloseTo(0.25, 5);
    expect(comm!.w * comm!.h).toBeCloseTo(0.15, 5);
  });
});

describe('recent task contexts (PARAM-140, FR-298)', () => {
  it('keeps at most 5, most recent first, without duplicates', () => {
    let list = pushRecent([], 'executive', 1);
    for (const [i, p] of (['business', 'it', 'field', 'facilitator', 'executive', 'it'] as const).entries()) list = pushRecent(list, p, i + 2);
    expect(list.length).toBeLessThanOrEqual(5);
    expect(list[0]!.persona).toBe('it');
    expect(new Set(list.map((r) => r.persona)).size).toBe(list.length);
  });
});
