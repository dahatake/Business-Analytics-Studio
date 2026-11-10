export interface FoundryConnection {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

export const DEFAULT_FOUNDRY_API_VERSION = '2024-10-21';
export const CONNECTION_TEST_PROMPT = 'Reply with OK only. This is a connection test; no business data is included.';
export const CONNECTION_TEST_MAX_TOKENS = 256;
export const CONNECTION_TEST_TIMEOUT_MS = 30_000;
export const CONNECTION_INPUT_ERRORS = ['invalidBody', 'invalidEndpoint', 'projectEndpoint', 'invalidDeployment', 'invalidApiVersion'] as const;
export type ConnectionInputError = (typeof CONNECTION_INPUT_ERRORS)[number];
export const FOUNDRY_ERRORS = [
  'dnsFailure', 'networkError', 'tlsError', 'unauthorized', 'forbidden', 'deploymentNotFound',
  'invalidApiRequest', 'providerBusy', 'providerError', 'badProviderResponse', 'timeout', 'aborted',
] as const;
export type FoundryError = (typeof FOUNDRY_ERRORS)[number];

export function isFoundryV1(endpoint: string): boolean {
  return endpoint.endsWith('/openai/v1');
}

export function parseFoundryConnection(input: unknown, allowTestHttp = false):
  { ok: true; value: FoundryConnection } | { ok: false; error: ConnectionInputError } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalidBody' };
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => !['endpoint', 'deployment', 'apiVersion'].includes(k))) return { ok: false, error: 'invalidBody' };
  const { endpoint, deployment, apiVersion = DEFAULT_FOUNDRY_API_VERSION } = o;
  if (typeof endpoint !== 'string' || endpoint.length > 512) return { ok: false, error: 'invalidEndpoint' };
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { return { ok: false, error: 'invalidEndpoint' }; }
  const test = allowTestHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!test && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    return { ok: false, error: 'invalidEndpoint' };
  }
  if (url.pathname.startsWith('/api/projects/')) return { ok: false, error: 'projectEndpoint' };
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '' && path !== '/openai/v1') return { ok: false, error: 'invalidEndpoint' };
  if (typeof deployment !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(deployment)) return { ok: false, error: 'invalidDeployment' };
  if (typeof apiVersion !== 'string' || (path === '' && !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(apiVersion))) {
    return { ok: false, error: 'invalidApiVersion' };
  }
  return { ok: true, value: { endpoint: url.origin + path, deployment, apiVersion: path ? DEFAULT_FOUNDRY_API_VERSION : apiVersion } };
}

export function foundryChatUrl(c: FoundryConnection): string {
  return isFoundryV1(c.endpoint)
    ? `${c.endpoint}/chat/completions`
    : `${c.endpoint}/openai/deployments/${encodeURIComponent(c.deployment)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion)}`;
}
