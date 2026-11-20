import { z } from 'zod';

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

const ServiceAvailability = z.enum(['available', 'unavailable', 'unknown']);
export const FoundryServices = z.object({
  speech: ServiceAvailability,
  vision: ServiceAvailability,
  decision: ServiceAvailability,
  deployments: z.array(z.object({ name: z.string(), model: z.string(), version: z.string(), sku: z.string() })),
});
export type FoundryServicesInfo = z.infer<typeof FoundryServices>;

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

/** Legacy relay status only. New settings always use the shared Foundry connection. */
export type SpeechRoute = 'foundry' | 'separate';
