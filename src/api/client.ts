import { handleApiRequest } from './handler.ts';

/**
 * Calls the local API over HTTP (Vite dev/preview middleware). If no server answers
 * (e.g. the build is opened from a static host), the same handler runs in the browser.
 */
export async function apiGet<T>(path: string, params: Record<string, string | number>): Promise<{ status: number; body: T; via: 'http' | 'inline' }> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  try {
    const res = await fetch(`${path}?${qs}`, { headers: { Accept: 'application/json' } });
    if (res.headers.get('content-type')?.includes('application/json')) {
      return { status: res.status, body: (await res.json()) as T, via: 'http' };
    }
  } catch {
    // fall through to inline
  }
  const r = handleApiRequest(path, qs);
  return { status: r.status, body: r.body as T, via: 'inline' };
}
