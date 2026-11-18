/**
 * Azure AI Speech and Azure AI Vision through the Microsoft Foundry connection (FR-324, FR-328), shared by the relay and
 * the settings screen. Microsoft Learn: a Foundry resource (kind AIServices) serves Azure OpenAI and Foundry Tools
 * (Speech, Vision, …) with one key and one custom subdomain; Speech and Vision are called on its
 * `<name>.cognitiveservices.azure.com` host, where Microsoft Entra ID tokens are accepted too. An Azure OpenAI resource
 * (kind OpenAI) shares the subdomain pattern but answers only OpenAI APIs, so only the live test proves the service.
 * Speech is tested with the free voices list, Vision with one Image Analysis 4.0 Read call (one billed transaction).
 */

export type MediaService = 'speech' | 'vision';
export const MEDIA_SERVICES: readonly MediaService[] = ['speech', 'vision'];
export const VISION_API_VERSION = '2024-02-01';
export const MEDIA_TEST_TIMEOUT_MS = 20_000;

/** Why the Foundry connection cannot carry Speech / Vision: none saved, or not an Azure resource host (APIM, proxy). */
export type MediaUnavailable = 'noConnection' | 'unsupportedHost';

const SUBDOMAIN = '([a-z0-9][a-z0-9-]{0,62})';
const FOUNDRY_HOSTS = [
  new RegExp(`^${SUBDOMAIN}\\.openai\\.azure\\.com$`),
  new RegExp(`^${SUBDOMAIN}\\.services\\.ai\\.azure\\.com$`),
  new RegExp(`^${SUBDOMAIN}\\.cognitiveservices\\.azure\\.com$`),
];

export function isMediaService(v: unknown): v is MediaService {
  return v === 'speech' || v === 'vision';
}

/** The resource's custom subdomain behind a Foundry endpoint (`<sub>.openai.azure.com`, `.services.ai.azure.com`, `.cognitiveservices.azure.com`). */
export function foundrySubdomain(foundryEndpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(foundryEndpoint);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port) return null;
  const host = u.hostname.toLowerCase();
  for (const re of FOUNDRY_HOSTS) {
    const m = re.exec(host);
    if (m) return m[1]!;
  }
  return null;
}

/** Where Speech and Vision are called for this Foundry endpoint, or null when it is not a Foundry resource host. */
export function foundryMediaEndpoint(foundryEndpoint: string): string | null {
  const sub = foundrySubdomain(foundryEndpoint);
  return sub ? `https://${sub}.cognitiveservices.azure.com` : null;
}

/** The read-only (Speech) or single-transaction (Vision) request that proves the service answers on the resource. */
export function mediaTestUrl(service: MediaService, endpoint: string): string {
  return service === 'vision'
    ? `${endpoint}/computervision/imageanalysis:analyze?api-version=${VISION_API_VERSION}&features=read`
    : `${endpoint}/tts/cognitiveservices/voices/list`;
}

/*
 * FR-329: once the Foundry connection and Speech on it are verified, the user may route Speech to a separate Azure AI
 * Speech resource instead. API key: a custom subdomain or a regional endpoint, or a region alone (voices are listed on
 * `<region>.tts.speech.microsoft.com`). Microsoft Entra ID: the custom subdomain only (regional endpoints accept keys
 * only), with the Foundry sign-in and tenant.
 */
export type SpeechRoute = 'foundry' | 'separate';
export type SeparateSpeech =
  | { auth: 'apiKey'; endpoint: string | null; region: string | null }
  | { auth: 'entraId'; endpoint: string; region: null };
export const SPEECH_INPUT_ERRORS = ['invalidBody', 'invalidEndpoint', 'invalidRegion', 'regionMismatch', 'customDomainRequired', 'invalidKey'] as const;
export type SpeechInputError = (typeof SPEECH_INPUT_ERRORS)[number];
export const MAX_SPEECH_KEY_LENGTH = 4096;

const REGION = /^[a-z][a-z0-9]{1,30}$/;
const CUSTOM_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.cognitiveservices\.azure\.com$/;
const REGIONAL_HOST = /^([a-z][a-z0-9]{1,30})\.api\.cognitive\.microsoft\.com$/;

/** An https origin of a custom subdomain or a regional endpoint (no path beyond `/`, credentials, port or query). */
export function parseSpeechEndpoint(v: unknown): { origin: string; custom: boolean; region: string | null } | null {
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

/** Validates the separate Speech connection (`key` is optional: a saved key is reused when it is omitted). */
export function validateSeparateSpeech(input: unknown): { ok: true; value: SeparateSpeech; key: string | null } | { ok: false; error: SpeechInputError } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalidBody' };
  const { auth, endpoint, region, key, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || (auth !== 'apiKey' && auth !== 'entraId')) return { ok: false, error: 'invalidBody' };
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  const parsed = empty(endpoint) ? null : parseSpeechEndpoint(endpoint);
  if (!empty(endpoint) && !parsed) return { ok: false, error: 'invalidEndpoint' };
  const r = typeof region === 'string' ? region.trim().toLowerCase() : null;
  if (!empty(region) && (!r || !REGION.test(r))) return { ok: false, error: 'invalidRegion' };
  if (parsed?.region && r && parsed.region !== r) return { ok: false, error: 'regionMismatch' };
  if (auth === 'entraId') {
    if (!empty(key) || !empty(region)) return { ok: false, error: 'invalidBody' };
    if (!parsed) return { ok: false, error: 'invalidEndpoint' };
    if (!parsed.custom) return { ok: false, error: 'customDomainRequired' };
    return { ok: true, value: { auth, endpoint: parsed.origin, region: null }, key: null };
  }
  if (!empty(key) && (typeof key !== 'string' || !key.trim() || key.trim().length > MAX_SPEECH_KEY_LENGTH || /[\r\n]/.test(key))) return { ok: false, error: 'invalidKey' };
  const finalRegion = r || parsed?.region || null;
  if (!parsed?.custom && !finalRegion) return { ok: false, error: 'invalidRegion' };
  return { ok: true, value: { auth, endpoint: parsed?.origin ?? null, region: finalRegion }, key: empty(key) ? null : (key as string).trim() };
}

/** The free voices list on the separate resource: its custom subdomain, or the regional text-to-speech host. */
export function separateSpeechTestUrl(c: SeparateSpeech): string {
  return c.endpoint && CUSTOM_HOST.test(new URL(c.endpoint).hostname)
    ? `${c.endpoint}/tts/cognitiveservices/voices/list`
    : `https://${c.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
}
