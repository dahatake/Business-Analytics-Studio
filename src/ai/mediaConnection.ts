/**
 * Azure AI Speech and Azure AI Vision connections (FR-324), shared by the relay and the settings screen so both apply
 * the same rules. Microsoft Learn: Entra ID tokens work only on a resource's custom subdomain
 * (`<name>.cognitiveservices.azure.com`); regional endpoints (`<region>.api.cognitive.microsoft.com`) accept keys only.
 * Speech is tested with the free voices list, Vision with one Image Analysis 4.0 Read call (one billed transaction).
 */

export type MediaService = 'speech' | 'vision';
export const MEDIA_SERVICES: readonly MediaService[] = ['speech', 'vision'];
export const VISION_API_VERSION = '2024-02-01';
export const MEDIA_TEST_TIMEOUT_MS = 20_000;

export type MediaConnection =
  | { auth: 'apiKey'; endpoint: string | null; region: string | null }
  | { auth: 'entraId'; endpoint: string; region: string | null; tenantId: string; resourceId: string };

export const MEDIA_INPUT_ERRORS = ['invalidBody', 'invalidEndpoint', 'invalidRegion', 'regionMismatch', 'customDomainRequired', 'invalidTenant', 'invalidResource'] as const;
export type MediaInputError = (typeof MEDIA_INPUT_ERRORS)[number];

/** Azure region names are lowercase letters and digits (eastus, japaneast, westus3). */
export const REGION = /^[a-z][a-z0-9]{1,30}$/;
const CUSTOM_HOST = /^([a-z0-9][a-z0-9-]{0,62})\.cognitiveservices\.azure\.com$/;
const REGIONAL_HOST = /^([a-z][a-z0-9]{1,30})\.api\.cognitive\.microsoft\.com$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.CognitiveServices\/accounts\/[A-Za-z0-9_.-]{2,64}$/i;

export function isMediaService(v: unknown): v is MediaService {
  return v === 'speech' || v === 'vision';
}

/** An https origin of a custom subdomain or a regional endpoint (no path beyond `/`, no credentials, no query). */
export function parseMediaEndpoint(v: unknown): { origin: string; custom: boolean; region: string | null } | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  const host = u.hostname.toLowerCase();
  if (CUSTOM_HOST.test(host)) return { origin: `https://${host}`, custom: true, region: null };
  const regional = REGIONAL_HOST.exec(host);
  return regional ? { origin: `https://${host}`, custom: false, region: regional[1]! } : null;
}

export function validateMedia(service: MediaService, input: unknown): { ok: true; value: MediaConnection } | { ok: false; error: MediaInputError } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalidBody' };
  const { auth, endpoint, region, tenantId, resourceId, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || (auth !== 'apiKey' && auth !== 'entraId')) return { ok: false, error: 'invalidBody' };
  const hasEndpoint = endpoint !== undefined && endpoint !== null && endpoint !== '';
  const parsed = hasEndpoint ? parseMediaEndpoint(endpoint) : null;
  if (hasEndpoint && !parsed) return { ok: false, error: 'invalidEndpoint' };
  const hasRegion = region !== undefined && region !== null && region !== '';
  const r = typeof region === 'string' ? region.trim().toLowerCase() : null;
  if (hasRegion && (!r || !REGION.test(r))) return { ok: false, error: 'invalidRegion' };
  if (parsed?.region && r && parsed.region !== r) return { ok: false, error: 'regionMismatch' };
  const finalRegion = r || parsed?.region || null;
  if (auth === 'entraId') {
    if (!parsed) return { ok: false, error: 'invalidEndpoint' };
    if (!parsed.custom) return { ok: false, error: 'customDomainRequired' };
    if (typeof tenantId !== 'string' || !GUID.test(tenantId)) return { ok: false, error: 'invalidTenant' };
    if (typeof resourceId !== 'string' || !RESOURCE_ID.test(resourceId)) return { ok: false, error: 'invalidResource' };
    return { ok: true, value: { auth, endpoint: parsed.origin, region: finalRegion, tenantId: tenantId.toLowerCase(), resourceId } };
  }
  if (tenantId !== undefined || resourceId !== undefined) return { ok: false, error: 'invalidBody' };
  // Speech with a key needs a custom subdomain or a region (voices are listed on `<region>.tts.speech.microsoft.com`);
  // Vision is always called on its endpoint.
  if (service === 'vision' && !parsed) return { ok: false, error: 'invalidEndpoint' };
  if (service === 'speech' && !parsed?.custom && !finalRegion) return { ok: false, error: 'invalidRegion' };
  return { ok: true, value: { auth, endpoint: parsed?.origin ?? null, region: finalRegion } };
}

/** The read-only (Speech) or single-transaction (Vision) request that proves the connection works. */
export function mediaTestUrl(service: MediaService, c: MediaConnection): string {
  if (service === 'vision') return `${c.endpoint}/computervision/imageanalysis:analyze?api-version=${VISION_API_VERSION}&features=read`;
  const custom = c.endpoint !== null && CUSTOM_HOST.test(new URL(c.endpoint).hostname);
  return custom ? `${c.endpoint}/tts/cognitiveservices/voices/list` : `https://${c.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
}
