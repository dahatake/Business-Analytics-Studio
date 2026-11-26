import { useEffect } from 'react';
import { hrefFor, useRoute } from '../state/router.ts';

/** The flow screen is now a view of the relations screen; old '/flows' links land on it with their query kept. */
export function FlowsRedirect() {
  const route = useRoute();
  useEffect(() => {
    const query = new URLSearchParams(route.query);
    if (query.get('view') === 'map' && !query.has('flowView')) query.set('flowView', 'map');
    query.set('view', 'flow');
    window.location.replace(hrefFor('/relations', query));
  }, [route]);
  return null;
}
