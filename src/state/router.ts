import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
  hash: string;
}

const ROUTE_EVENT = 'bas:route';

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart = '/', queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path, segments: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(queryPart), hash: `#${raw}` };
}

export function hrefFor(path: string, query?: Record<string, string | undefined> | URLSearchParams): string {
  const qs = query instanceof URLSearchParams ? query : new URLSearchParams(
    Object.entries(query ?? {}).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
  );
  const s = qs.toString();
  return `#${path}${s ? `?${s}` : ''}`;
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  window.addEventListener(ROUTE_EVENT, cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener(ROUTE_EVENT, cb);
  };
}

let cachedHash = '';
let cachedRoute: Route = parseHash('');
function snapshot(): Route {
  if (window.location.hash !== cachedHash) {
    cachedHash = window.location.hash;
    cachedRoute = parseHash(cachedHash);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Target ids belong to the main screen, never to the persistent header or an overlay. */
export function focusRouteTarget(id: string) {
  const el = document.getElementById(id);
  if (!el || !document.getElementById('main')?.contains(el)) {
    console.warn(`Navigation target not found in the current screen: ${id}`);
    return;
  }
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'start', behavior: 'instant' });
}

/** Mount inside the screen's Suspense boundary, so lazy-loaded targets exist before focusing. */
export function useRouteTarget() {
  const route = useRoute();
  useEffect(() => {
    const target = route.query.get('target');
    if (!target) return;
    const raf = requestAnimationFrame(() => focusRouteTarget(target));
    return () => cancelAnimationFrame(raf);
  }, [route]);
}

/** A second click on the same URL must still return to the component; keep modified clicks native. */
export function revisitRouteTarget(e: MouseEvent<HTMLAnchorElement>) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute('href');
  if (href !== window.location.hash) return;
  const target = parseHash(href).query.get('target');
  if (target) {
    e.preventDefault();
    focusRouteTarget(target);
  }
}

/** Push a new history entry (drill-through). */
export function navigate(href: string) {
  window.location.hash = href.replace(/^#/, '');
}

/** Update the query of the current entry without a new history entry (search/filter typing). */
export function replaceQuery(updates: Record<string, string | undefined>) {
  const current = parseHash(window.location.hash);
  const q = new URLSearchParams(current.query);
  // A tab/filter change starts a new interaction; don't refocus a previous deep-link target.
  if (!Object.hasOwn(updates, 'target')) q.delete('target');
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  window.history.replaceState(window.history.state, '', hrefFor(current.path, q));
  window.dispatchEvent(new Event(ROUTE_EVENT));
}
