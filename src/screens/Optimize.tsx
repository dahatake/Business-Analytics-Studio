import { useEffect } from 'react';
import { simulationQuery, SIM_TABS } from '../modules/project/simulationHref.ts';
import { hrefFor, useRoute } from '../state/router.ts';

/** FR-382: the simulation workbench moved into Step 2 (To-Be); old '/optimize' links land there with their section and context kept. */
export function OptimizeRedirect() {
  const route = useRoute();
  useEffect(() => {
    const q = route.query;
    const query = simulationQuery({
      // The old screen opened on time/resources; keep that rather than following the selected KPI.
      tab: SIM_TABS.find((tab) => tab === q.get('tab')) ?? 'time',
      step: q.get('step') ?? undefined,
      task: q.get('task') ?? undefined,
      target: q.get('target') ?? undefined,
    });
    for (const key of ['growth', 'carbon']) query[key] = q.get(key) ?? undefined;
    window.location.replace(hrefFor('/step', query));
  }, [route]);
  return null;
}
