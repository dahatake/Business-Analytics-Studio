import { hrefFor } from '../../state/router.ts';

/** The simulation workbench lives in Step 2 (To-Be) under the business outcomes view (FR-382 replaced the `/optimize` screen). */
export const SIM_TABS = ['time', 'issues', 'kpi', 'solutions', 'task'] as const;
export type SimTab = typeof SIM_TABS[number];

export interface SimulationLinkOptions {
  /** Workbench section. */
  tab?: SimTab;
  /** Step whose tasks and priorities the workbench evaluates (default: To-Be). */
  step?: string;
  task?: string;
  target?: string;
  /** Selected outcome, `<kind>-<id>`. */
  outcome?: string;
}

export function simulationQuery({ tab, step, task, target, outcome }: SimulationLinkOptions): Record<string, string | undefined> {
  return { step: 'tobe', view: 'outcomes', outcome, sim: tab, simStep: step && step !== 'tobe' ? step : undefined, task, target };
}

export function simulationHref(options: SimulationLinkOptions = {}): string {
  return hrefFor('/step', simulationQuery(options));
}

/** "path?query" form for stored links (step dashboards keep links as strings). */
export function simulationPath(options: SimulationLinkOptions = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(simulationQuery(options))) if (value) query.set(key, value);
  return `/step?${query}`;
}

/** Click target of an outcome card in the business outcomes bar. */
export function outcomeHref(key: string): string {
  return simulationHref({ outcome: key, target: 'outcome-detail' });
}
