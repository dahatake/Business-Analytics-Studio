/**
 * Pure layout engine of the free-layout workspace (no React, no DOM).
 * Every rectangle is a ratio (0..1) of the work area, so a layout survives any screen size.
 */

/** Workspace PARAMs (§3.3). Kept here so the engine, the UI and the tests share one source. */
export const WS_PARAMS = {
  /** PARAM-033: area ratio of the active (operated) component. */
  activeScale: 1.5,
  /** PARAM-040: minimum target size (CSS px). */
  minTargetPx: 24,
  /** PARAM-041: move / minimize / restore / snap motion (ms). */
  motionMs: 200,
  /** PARAM-042: distance from an edge/corner that offers a snap candidate (CSS px). */
  snapPx: 32,
  /** PARAM-058: share of the canvas taken by the expanded view. */
  expandRatio: 0.75,
  /** PARAM-059: default position of the expanded view. */
  expandPosition: 'top' as ExpandPosition,
  /** PARAM-072: tolerance of a pinned component's ratios after the area changes (ratio points). */
  pinTolerance: 0.01,
  /** PARAM-073: header buttons always shown (upper limit). */
  maxHeaderButtons: 6,
  /** PARAM-074: upper limit of screen / dialog / menu transitions (ms). */
  transitionMaxMs: 500,
  /** PARAM-083 / PARAM-084: important and normal component sizes for the importance arrangement. */
  important: { w: 0.5, h: 0.5 },
  normal: { w: 0.3, h: 0.4 },
  /** PARAM-134 / PARAM-135: minimum window size (CSS px). */
  minWidthPx: 360,
  minHeightPx: 240,
  /** PARAM-136: components shown at the same time. */
  maxVisible: 4,
  /** PARAM-137: dimming of background components in the immersive view. */
  dimRatio: 0.6,
  /** PARAM-138: Main / Reference / Communication zones (share of the area). */
  zones: { main: 0.6, reference: 0.25, communication: 0.15 },
  /** PARAM-139: persona (mode) switch completes within (ms). */
  switchMaxMs: 1000,
  /** PARAM-140: recent task contexts. */
  recentMax: 5,
  /** PARAM-141: lower limit of the acrylic surface opacity. */
  acrylicMinOpacity: 0.8,
  /** PARAM-143: width of the top-centre hit range for layout templates (share of the area width). */
  templateZoneRatio: 0.4,
  /** PARAM-144: dwell time in the template hit range before the templates pop up (ms). */
  templateDwellMs: 300,
  /** Keyboard step for move/resize (share of the area). */
  keyStep: 0.05,
} as const;

export type ExpandPosition = 'top' | 'left' | 'right' | 'bottom';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Area { width: number; height: number }

/** Display states (glossary): normal / maximized / minimized / hidden / back. "Expanded" is a normal window with `expandedFrom`. */
export type WinState = 'normal' | 'maximized' | 'minimized' | 'hidden' | 'back';
/** Why a component is in the back: sent there by a maximize (FR-152/FR-013) or left out by a template (FR-305). */
export type BackReason = 'max' | 'template';

export interface Win {
  id: string;
  rect: Rect;
  state: WinState;
  pinned: boolean;
  /** Stacking order (higher = in front). */
  z: number;
  /** Logical clock of the last use, for "least recently used". */
  used: number;
  backReason?: BackReason;
  /** Set while expanded (FR-174): the rectangle to return to. */
  expandedFrom?: Rect;
}

export interface Layout {
  wins: Win[];
  /** Logical clock (no wall time, so the engine is deterministic). */
  seq: number;
}

const EPS = 1e-6;
const round = (v: number) => Math.round(v * 10000) / 10000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const rectOf = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Minimum window size as a ratio of the area (PARAM-134/135); at most the whole area. */
export function minRatio(area: Area): { w: number; h: number } {
  return {
    w: area.width > 0 ? Math.min(1, WS_PARAMS.minWidthPx / area.width) : 1,
    h: area.height > 0 ? Math.min(1, WS_PARAMS.minHeightPx / area.height) : 1,
  };
}

/** Never smaller than the minimum size, never outside the area. */
export function clampRect(r: Rect, area: Area): Rect {
  const min = minRatio(area);
  const w = round(clamp(Math.max(r.w, min.w), 0, 1));
  const h = round(clamp(Math.max(r.h, min.h), 0, 1));
  return { x: round(clamp(r.x, 0, 1 - w)), y: round(clamp(r.y, 0, 1 - h)), w, h };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

const inside = (r: Rect) => r.x >= -EPS && r.y >= -EPS && r.x + r.w <= 1 + EPS && r.y + r.h <= 1 + EPS;

/** Shown on screen and counted against PARAM-136 (pinned ones count; minimized, hidden and back do not). */
export const isShown = (w: Win) => w.state === 'normal' || w.state === 'maximized';

export function visibleCount(l: Layout): number {
  return l.wins.filter(isShown).length;
}

export function getWin(l: Layout, id: string): Win | undefined {
  return l.wins.find((w) => w.id === id);
}

function patch(l: Layout, id: string, f: (w: Win) => Win): Layout {
  return { ...l, wins: l.wins.map((w) => (w.id === id ? f(w) : w)) };
}

/** Bring to front and mark as most recently used. */
export function touch(l: Layout, id: string): Layout {
  const seq = l.seq + 1;
  return { seq, wins: l.wins.map((w) => (w.id === id ? { ...w, z: seq, used: seq } : w)) };
}

/** FR-296: more than PARAM-136 shown → minimize the least recently used (never squeeze). */
export function enforceMaxVisible(l: Layout, keep: string[] = []): Layout {
  let wins = l.wins;
  while (wins.filter(isShown).length > WS_PARAMS.maxVisible) {
    const candidates = wins.filter((w) => isShown(w) && !keep.includes(w.id));
    if (!candidates.length) break;
    const victim = [...candidates].sort((a, b) => Number(a.pinned) - Number(b.pinned) || a.used - b.used)[0]!;
    wins = wins.map((w) => (w.id === victim.id ? { ...w, state: 'minimized' as const, expandedFrom: undefined } : w));
  }
  return { ...l, wins };
}

/** Nearest position for `r` that is inside the area and overlaps none of `fixed`; null when there is no room. */
export function findPlacement(r: Rect, fixed: Rect[]): Rect | null {
  if (inside(r) && !fixed.some((f) => overlaps(r, f))) return r;
  const xs = new Set<number>([r.x, 0, 1 - r.w]);
  const ys = new Set<number>([r.y, 0, 1 - r.h]);
  for (const f of fixed) {
    xs.add(f.x - r.w); xs.add(f.x + f.w); xs.add(f.x); xs.add(f.x + f.w - r.w);
    ys.add(f.y - r.h); ys.add(f.y + f.h); ys.add(f.y); ys.add(f.y + f.h - r.h);
  }
  let best: Rect | null = null;
  let bestD = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const c = { x: round(x), y: round(y), w: r.w, h: r.h };
      if (!inside(c) || fixed.some((f) => overlaps(c, f))) continue;
      const d = Math.hypot(c.x - r.x, c.y - r.y);
      if (d < bestD - EPS) { best = c; bestD = d; }
    }
  }
  return best;
}

/**
 * FR-184 push-aside: `fixedIds` (the moved one) and pinned windows stay; every other shown window keeps its place
 * or moves the shortest distance to a free spot. Without room it is minimized, never squeezed (FR-296).
 */
export function resolveOverlaps(l: Layout, area: Area, fixedIds: string[] = []): Layout {
  // Expanded windows float above the others (FR-174) and take no part in the push-aside.
  const normal = (w: Win) => w.state === 'normal' && !w.expandedFrom;
  const fixed: Rect[] = l.wins.filter((w) => normal(w) && (fixedIds.includes(w.id) || w.pinned)).map((w) => w.rect);
  const placed = new Map<string, Win>();
  const order = l.wins.filter((w) => normal(w) && !fixedIds.includes(w.id) && !w.pinned).sort((a, b) => b.z - a.z);
  for (const w of order) {
    const r = clampRect(w.rect, area);
    const spot = findPlacement(r, fixed);
    if (spot) {
      fixed.push(spot);
      placed.set(w.id, { ...w, rect: spot });
    } else {
      placed.set(w.id, { ...w, state: 'minimized', expandedFrom: undefined });
    }
  }
  return { ...l, wins: l.wins.map((w) => placed.get(w.id) ?? w) };
}

/** Move (or resize) one window to `rect`; others are pushed aside (FR-184). */
export function moveWin(l: Layout, id: string, rect: Rect, area: Area): Layout {
  const w = getWin(l, id);
  if (!w) return l;
  let next = touch(patch(l, id, (x) => ({ ...x, rect: clampRect(rect, area), expandedFrom: undefined, state: x.state === 'maximized' ? 'normal' : x.state })), id);
  if (w.state === 'maximized') next = releaseMaxBack(next);
  return resolveOverlaps(next, area, [id]);
}

/** Keyboard alternative to dragging (NFR-A11Y-004): move by a step. */
export function nudge(l: Layout, id: string, dx: number, dy: number, area: Area): Layout {
  const w = getWin(l, id);
  if (!w) return l;
  return moveWin(l, id, { ...w.rect, x: w.rect.x + dx, y: w.rect.y + dy }, area);
}

/** Keyboard alternative to resizing: grow/shrink by a step, never below the minimum size. */
export function resizeBy(l: Layout, id: string, dw: number, dh: number, area: Area): Layout {
  const w = getWin(l, id);
  if (!w) return l;
  return moveWin(l, id, { ...w.rect, w: w.rect.w + dw, h: w.rect.h + dh }, area);
}

// ---------- Snap (FR-152) and templates (FR-305) ----------

export type SnapTarget = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'maximize' | 'template';

export const SNAP_RECTS: Record<Exclude<SnapTarget, 'maximize' | 'template'>, Rect> = {
  left: rectOf(0, 0, 0.5, 1),
  right: rectOf(0.5, 0, 0.5, 1),
  top: rectOf(0, 0, 1, 0.5),
  bottom: rectOf(0, 0.5, 1, 0.5),
  'top-left': rectOf(0, 0, 0.5, 0.5),
  'top-right': rectOf(0.5, 0, 0.5, 0.5),
  'bottom-left': rectOf(0, 0.5, 0.5, 0.5),
  'bottom-right': rectOf(0.5, 0.5, 0.5, 0.5),
};

/**
 * Snap candidate for a pointer at (px, py) CSS px inside the area (PARAM-042).
 * The centre PARAM-143 of the top edge offers layout templates; the rest of the top edge maximizes.
 */
export function snapTargetAt(px: number, py: number, area: Area): SnapTarget | null {
  const d = WS_PARAMS.snapPx;
  const l = px <= d, r = px >= area.width - d, t = py <= d, b = py >= area.height - d;
  if (t && l) return 'top-left';
  if (t && r) return 'top-right';
  if (b && l) return 'bottom-left';
  if (b && r) return 'bottom-right';
  if (l) return 'left';
  if (r) return 'right';
  if (b) return 'bottom';
  if (t) {
    const half = (area.width * WS_PARAMS.templateZoneRatio) / 2;
    return Math.abs(px - area.width / 2) <= half ? 'template' : 'maximize';
  }
  return null;
}

/** Preview rectangle of a snap candidate (FR-152); maximize previews the whole area. */
export function snapPreview(target: SnapTarget): Rect | null {
  if (target === 'template') return null;
  if (target === 'maximize') return rectOf(0, 0, 1, 1);
  return SNAP_RECTS[target];
}

export function applySnap(l: Layout, id: string, target: SnapTarget, area: Area): Layout {
  if (target === 'template') return l;
  if (target === 'maximize') return maximize(l, id);
  return moveWin(l, id, SNAP_RECTS[target], area);
}

/** PARAM-144: templates pop up only after dwelling in the hit range. */
export function templateDwell(since: number | null, inZone: boolean, now: number): { since: number | null; open: boolean } {
  if (!inZone) return { since: null, open: false };
  const start = since ?? now;
  return { since: start, open: now - start >= WS_PARAMS.templateDwellMs };
}

export type TemplateId = 'halves' | 'mainSide' | 'mainStack' | 'zones' | 'quarters';

export const TEMPLATES: Record<TemplateId, Rect[]> = {
  halves: [rectOf(0, 0, 0.5, 1), rectOf(0.5, 0, 0.5, 1)],
  mainSide: [rectOf(0, 0, 0.6, 1), rectOf(0.6, 0, 0.4, 1)],
  mainStack: [rectOf(0, 0, 0.6, 1), rectOf(0.6, 0, 0.4, 0.5), rectOf(0.6, 0.5, 0.4, 0.5)],
  /** PARAM-138: Main 60% / Reference 25% / Communication 15% of the area. */
  zones: [rectOf(0, 0, 0.6, 1), rectOf(0.6, 0, 0.4, 0.625), rectOf(0.6, 0.625, 0.4, 0.375)],
  quarters: [rectOf(0, 0, 0.5, 0.5), rectOf(0.5, 0, 0.5, 0.5), rectOf(0, 0.5, 0.5, 0.5), rectOf(0.5, 0.5, 0.5, 0.5)],
};
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

/**
 * FR-305: the dragged component takes the chosen slot; the remaining slots are filled in order by the other shown
 * components, front-most first. Components that do not get a slot go to the back (reason "template").
 */
export function applyTemplate(l: Layout, template: TemplateId, slot: number, draggedId: string, area: Area): Layout {
  const slots = TEMPLATES[template];
  if (!getWin(l, draggedId) || slot < 0 || slot >= slots.length) return l;
  let next = releaseAllMax(l);
  const others = next.wins.filter((w) => isShown(w) && w.id !== draggedId).sort((a, b) => b.z - a.z);
  const order = [slot, ...slots.map((_, i) => i).filter((i) => i !== slot)];
  const assign = new Map<string, Rect>([[draggedId, slots[slot]!]]);
  others.forEach((w, i) => {
    const s = order[i + 1];
    if (s !== undefined) assign.set(w.id, slots[s]!);
  });
  next = {
    ...next,
    wins: next.wins.map((w) => {
      const r = assign.get(w.id);
      if (r) return { ...w, rect: clampRect(r, area), state: 'normal', backReason: undefined, expandedFrom: undefined };
      if (isShown(w)) return { ...w, state: 'back', backReason: 'template', expandedFrom: undefined };
      return w;
    }),
  };
  next = touch(next, draggedId);
  return resolveOverlaps(next, area, [draggedId]);
}

/** The slot rectangles, in fill order starting from `slot` (for the preview). */
export function templateFillOrder(template: TemplateId, slot: number): number[] {
  return [slot, ...TEMPLATES[template].map((_, i) => i).filter((i) => i !== slot)];
}

// ---------- Display states (FR-013, FR-014, FR-151, FR-174, FR-295) ----------

function releaseMaxBack(l: Layout): Layout {
  return { ...l, wins: l.wins.map((w) => (w.state === 'back' && w.backReason === 'max' ? { ...w, state: 'normal', backReason: undefined } : w)) };
}

function releaseAllMax(l: Layout): Layout {
  return releaseMaxBack({ ...l, wins: l.wins.map((w) => (w.state === 'maximized' ? { ...w, state: 'normal' } : w)) });
}

export function maximizedId(l: Layout): string | null {
  return l.wins.find((w) => w.state === 'maximized')?.id ?? null;
}

/** Maximize: the others shown just before go to the back (reason "max"). */
export function maximize(l: Layout, id: string): Layout {
  if (!getWin(l, id)) return l;
  const base = releaseAllMax(l);
  const next = {
    ...base,
    wins: base.wins.map((w): Win => {
      if (w.id === id) return { ...w, state: 'maximized', backReason: undefined, expandedFrom: undefined };
      return isShown(w) ? { ...w, state: 'back', backReason: 'max' } : w;
    }),
  };
  return touch(next, id);
}

/**
 * Return a component to normal and bring it to the front (FR-013, dock / task list FR-014, FR-295).
 * Restoring the maximized one releases the maximize; restoring another one while maximized also releases it.
 */
export function restore(l: Layout, id: string, area: Area): Layout {
  const w = getWin(l, id);
  if (!w) return l;
  let next = releaseAllMax(l);
  next = patch(next, id, (x) => ({ ...x, state: 'normal', backReason: undefined }));
  next = touch(next, id);
  next = enforceMaxVisible(next, [id]);
  return resolveOverlaps(next, area, [id]);
}

export const bringToFront = restore;

export function minimize(l: Layout, id: string): Layout {
  if (!getWin(l, id)) return l;
  const base = getWin(l, id)!.state === 'maximized' ? releaseAllMax(l) : l;
  return patch(base, id, (w) => ({ ...w, state: 'minimized', backReason: undefined, rect: w.expandedFrom ?? w.rect, expandedFrom: undefined }));
}

export function hide(l: Layout, id: string): Layout {
  if (!getWin(l, id)) return l;
  const base = getWin(l, id)!.state === 'maximized' ? releaseAllMax(l) : l;
  return patch(base, id, (w) => ({ ...w, state: 'hidden', backReason: undefined, rect: w.expandedFrom ?? w.rect, expandedFrom: undefined }));
}

/** FR-215 */
export function togglePin(l: Layout, id: string): Layout {
  return patch(l, id, (w) => ({ ...w, pinned: !w.pinned }));
}

/** Rectangle of the expanded view (PARAM-058 at PARAM-059). */
export function expandRect(position: ExpandPosition = WS_PARAMS.expandPosition): Rect {
  const r = WS_PARAMS.expandRatio;
  switch (position) {
    case 'left': return rectOf(0, 0, r, 1);
    case 'right': return rectOf(round(1 - r), 0, r, 1);
    case 'bottom': return rectOf(0, round(1 - r), 1, r);
    default: return rectOf(0, 0, 1, r);
  }
}

/** FR-174: header double-click expands; the same operation restores the previous rectangle. */
export function toggleExpand(l: Layout, id: string, position: ExpandPosition = WS_PARAMS.expandPosition): Layout {
  const w = getWin(l, id);
  if (!w) return l;
  if (w.expandedFrom) return touch(patch(l, id, (x) => ({ ...x, rect: x.expandedFrom!, expandedFrom: undefined })), id);
  const base = w.state === 'maximized' ? releaseAllMax(l) : l;
  return touch(patch(base, id, (x) => ({ ...x, state: 'normal', expandedFrom: x.rect, rect: expandRect(position) })), id);
}

/** The expanded view is not saved (A-41): collapse before storing or after loading. */
export function collapseExpanded(l: Layout): Layout {
  if (!l.wins.some((w) => w.expandedFrom)) return l;
  return { ...l, wins: l.wins.map((w) => (w.expandedFrom ? { ...w, rect: w.expandedFrom, expandedFrom: undefined } : w)) };
}

/**
 * The work area changed size (FR-216): pinned components keep their ratios exactly; the others are clamped to the
 * minimum size and pushed aside, or minimized when there is no room.
 */
export function fitToArea(l: Layout, area: Area): Layout {
  const clamped = { ...l, wins: l.wins.map((w) => (w.pinned || w.expandedFrom ? w : { ...w, rect: clampRect(w.rect, area) })) };
  return enforceMaxVisible(resolveOverlaps(clamped, area));
}

/**
 * FR-143: the active component grows to PARAM-033 × its area, but only if it still fits inside the area without
 * covering another shown component. It grows from its top-left corner so the header stays under the pointer.
 * Returns null when it does not fit.
 */
export function enlargedRect(l: Layout, id: string): Rect | null {
  const w = getWin(l, id);
  if (!w || w.state !== 'normal' || w.expandedFrom) return null;
  const s = Math.sqrt(WS_PARAMS.activeScale);
  const nw = round(w.rect.w * s), nh = round(w.rect.h * s);
  if (nw > 1 + EPS || nh > 1 + EPS) return null;
  const r = { x: round(clamp(w.rect.x, 0, 1 - nw)), y: round(clamp(w.rect.y, 0, 1 - nh)), w: nw, h: nh };
  const others = l.wins.filter((o) => o.id !== id && o.state === 'normal');
  return others.some((o) => overlaps(r, o.rect)) ? null : r;
}

/** PARAM-083/084: one important component 0.5×0.5 and the others 0.3×0.4, tiled from the top-left. */
export function arrangeByImportance(l: Layout, importantId: string, area: Area): Layout {
  const { important: imp, normal: nor } = WS_PARAMS;
  const slots: Rect[] = [rectOf(imp.w, 0, nor.w, nor.h), rectOf(0, imp.h, nor.w, nor.h), rectOf(nor.w, imp.h, nor.w, nor.h), rectOf(nor.w * 2, imp.h, nor.w, nor.h)];
  let next = releaseAllMax(l);
  const others = next.wins.filter((w) => isShown(w) && w.id !== importantId).sort((a, b) => b.used - a.used);
  const assign = new Map<string, Rect>([[importantId, rectOf(0, 0, imp.w, imp.h)]]);
  others.slice(0, WS_PARAMS.maxVisible - 1).forEach((w, i) => assign.set(w.id, slots[i]!));
  next = {
    ...next,
    wins: next.wins.map((w): Win => {
      const r = assign.get(w.id);
      if (r) return { ...w, rect: clampRect(r, area), state: 'normal', backReason: undefined, expandedFrom: undefined };
      return isShown(w) ? { ...w, state: 'minimized', expandedFrom: undefined } : w;
    }),
  };
  next = touch(next, importantId);
  return resolveOverlaps(next, area, [importantId]);
}

/** Build a layout from a spec (persona defaults, FR-112). Later entries are in front. */
export function buildLayout(spec: { id: string; rect: Rect; state?: WinState }[]): Layout {
  const wins = spec.map((s, i): Win => ({ id: s.id, rect: s.rect, state: s.state ?? 'normal', pinned: false, z: i + 1, used: i + 1 }));
  return enforceMaxVisible({ wins, seq: spec.length });
}

/** Rectangle actually drawn: maximized fills the area; otherwise the stored ratios. */
export function displayRect(w: Win): Rect {
  return w.state === 'maximized' ? rectOf(0, 0, 1, 1) : w.rect;
}

/** Ratio rectangle → CSS px inside the area. */
export function toPx(r: Rect, area: Area): { left: number; top: number; width: number; height: number } {
  return { left: r.x * area.width, top: r.y * area.height, width: r.w * area.width, height: r.h * area.height };
}
