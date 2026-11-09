/**
 * FR-035 (2D progressive display) for the site map: labels that would overlap are hidden by priority and reappear
 * as the user zooms in. A label that is shown stays shown until the overlap exceeds the hysteresis band
 * (PARAM-023: 10 %), so labels do not flicker at the zoom threshold. Hidden labels keep their accessible name and
 * remain in the site table (NFR-A11Y-003).
 */
export interface LabelCandidate {
  id: string;
  /** Marker position in map units (before zoom). */
  x: number;
  y: number;
  /** Approximate label size in screen pixels (constant under zoom: labels are counter-scaled). */
  width: number;
  height: number;
  /** Higher wins. */
  priority: number;
}

export const LABEL_HYSTERESIS = 0.1;

interface Box { left: number; top: number; right: number; bottom: number }

function boxOf(c: LabelCandidate, k: number, grow: number): Box {
  const x = c.x * k + 14;
  const y = c.y * k - c.height / 2;
  const gw = c.width * grow;
  const gh = c.height * grow;
  return { left: x - gw, top: y - gh, right: x + c.width + gw, bottom: y + c.height + gh };
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Greedy placement by priority. Labels already visible are tested with a box shrunk by the hysteresis band (they
 * survive small overlaps); new labels need a box grown by the band (they appear only with clear space).
 */
export function visibleLabels(candidates: readonly LabelCandidate[], k: number, previouslyVisible: ReadonlySet<string> = new Set(), selected?: string): Set<string> {
  const order = [...candidates].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || b.priority - a.priority || a.id.localeCompare(b.id));
  const placed: Box[] = [];
  const visible = new Set<string>();
  for (const c of order) {
    const box = boxOf(c, k, previouslyVisible.has(c.id) ? -LABEL_HYSTERESIS / 2 : LABEL_HYSTERESIS / 2);
    if (c.id === selected || !placed.some((p) => overlaps(p, box))) {
      visible.add(c.id);
      placed.push(boxOf(c, k, 0));
    }
  }
  return visible;
}

/** Rough label width: full-width characters ≈ 1 em, others ≈ 0.6 em, at the 12 px label font. */
export function labelWidthPx(text: string, fontPx = 12): number {
  let em = 0;
  for (const ch of text) em += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.6;
  return Math.ceil(em * fontPx);
}
