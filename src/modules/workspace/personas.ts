import { buildLayout, rectOf, type Layout, type Rect, type WinState } from './layout.ts';

/** Components the workspace can host: existing app views, reused read-only. */
export const COMPONENT_IDS = ['summary', 'matrix', 'ranking', 'kpi', 'chain', 'plan', 'map', 'flows'] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

/** FR-015 persona views (§7) plus the facilitator, whose default is the presentation (it can still use a workspace). */
export const WS_PERSONAS = ['executive', 'business', 'it', 'field', 'facilitator'] as const;
export type WsPersona = (typeof WS_PERSONAS)[number];

export const isWsPersona = (v: unknown): v is WsPersona => typeof v === 'string' && (WS_PERSONAS as readonly string[]).includes(v);

// Zones (PARAM-138): Main = left 60% of the area, Reference = right column top (25% of the area),
// Communication = right column bottom (15% of the area).
const MAIN = rectOf(0, 0, 0.6, 1);
const MAIN_TOP = rectOf(0, 0, 0.6, 0.375);
const MAIN_BELOW = rectOf(0, 0.375, 0.6, 0.625);
const REFERENCE = rectOf(0.6, 0, 0.4, 0.625);
const COMMUNICATION = rectOf(0.6, 0.625, 0.4, 0.375);

type Spec = { id: ComponentId; rect: Rect; state?: WinState }[];

/** §7 table: default layout and default representations per persona (FR-112). Extra components start minimized. */
export const PERSONA_DEFAULTS: Record<WsPersona, Spec> = {
  // Executive summary on top, 2×2 matrix in the main area, ranking table beside, KPI (tower) in communication.
  executive: [
    { id: 'kpi', rect: COMMUNICATION },
    { id: 'ranking', rect: REFERENCE },
    { id: 'summary', rect: MAIN_TOP },
    { id: 'matrix', rect: MAIN_BELOW },
    { id: 'chain', rect: MAIN, state: 'minimized' },
  ],
  // Issue → solution analysis in the main area, issue table beside, Gantt below.
  business: [
    { id: 'plan', rect: COMMUNICATION },
    { id: 'ranking', rect: REFERENCE },
    { id: 'chain', rect: MAIN },
    { id: 'matrix', rect: MAIN, state: 'minimized' },
  ],
  // Structure / dependencies in the main area, flows beside, KPI below; the plan is one click away.
  it: [
    { id: 'kpi', rect: COMMUNICATION },
    { id: 'flows', rect: REFERENCE },
    { id: 'chain', rect: MAIN },
    { id: 'plan', rect: MAIN, state: 'minimized' },
  ],
  // Map (places) in the main area, flows of goods beside, Gantt below.
  field: [
    { id: 'plan', rect: COMMUNICATION },
    { id: 'flows', rect: REFERENCE },
    { id: 'map', rect: MAIN },
    { id: 'kpi', rect: MAIN, state: 'minimized' },
  ],
  // Central work area with the summary on top; KPI and priorities at hand.
  facilitator: [
    { id: 'kpi', rect: COMMUNICATION },
    { id: 'matrix', rect: REFERENCE },
    { id: 'summary', rect: MAIN_TOP },
    { id: 'chain', rect: MAIN_BELOW },
  ],
};

/** FR-110: the persona's default layout (no pins, nothing expanded, nothing in the back). */
export function defaultLayout(persona: WsPersona): Layout {
  return buildLayout(PERSONA_DEFAULTS[persona]);
}

export interface RecentContext { persona: WsPersona; at: number }

/** FR-298: most recent first, no duplicates, at most PARAM-140. */
export function pushRecent(list: RecentContext[], persona: WsPersona, at: number, max = 5): RecentContext[] {
  return [{ persona, at }, ...list.filter((r) => r.persona !== persona)].slice(0, max);
}
