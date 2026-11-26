import { useEffect } from 'react';
import { hrefFor, useRoute } from '../state/router.ts';

/** The material flow is a tab of the business process screen (FR-380); old '/flows' links land on it with section and mode kept. */
export function FlowsRedirect() {
  const route = useRoute();
  useEffect(() => {
    const query = new URLSearchParams();
    for (const key of ['section', 'mode', 'arch', 'sel']) {
      const value = route.query.get(key);
      if (value) query.set(key, value);
    }
    query.set('tab', 'material');
    window.location.replace(hrefFor('/process', query));
  }, [route]);
  return null;
}