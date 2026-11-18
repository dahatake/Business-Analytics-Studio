import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { MEDIA_TEST_TIMEOUT_MS, mediaTestUrl, validateSeparateSpeech, type MediaService, type SeparateSpeech, type SpeechRoute } from '../src/ai/mediaConnection.ts';

export {
  MEDIA_SERVICES, MEDIA_TEST_TIMEOUT_MS, VISION_API_VERSION, foundryMediaEndpoint, foundrySubdomain, isMediaService, mediaTestUrl, separateSpeechTestUrl, validateSeparateSpeech,
} from '../src/ai/mediaConnection.ts';
export type { MediaService, MediaUnavailable, SeparateSpeech, SpeechRoute } from '../src/ai/mediaConnection.ts';

/**
 * Relay side of Speech / Vision through the Microsoft Foundry connection (FR-324, FR-328): no endpoint or key of their
 * own. media.json keeps only each service's last successful check, sealed with HMAC over the Foundry connection it was
 * made with, so changing the Foundry endpoint, key, tenant or Entra account drops it back to "not verified".
 */

export const MEDIA_FILE = 'media.json';

/** The Foundry connection fields a check depends on. */
export interface MediaSource { foundryEndpoint: string; auth: 'apiKey' | 'entraId'; tenantId: string | null; endpoint: string }
export interface SavedMediaCheck { verifiedAt: string; verification: string }

export function mediaSignature(service: MediaService, s: MediaSource, at: string, key: string, account?: string): string {
  const fields: string[] = ['foundry', service, s.foundryEndpoint, s.endpoint, s.auth, s.tenantId ?? '', at];
  if (s.auth === 'entraId') fields.push(account ?? '');
  return createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex');
}

/** Earlier per-service connections (endpoint, region, own key) are not checks of the Foundry connection and are ignored. */
export function parseSavedMedia(raw: unknown): SavedMediaCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const { verifiedAt, verification } = raw as Record<string, unknown>;
  return typeof verifiedAt === 'string' && Number.isFinite(Date.parse(verifiedAt)) && typeof verification === 'string' ? { verifiedAt, verification } : null;
}
export type MediaTestError = 'unauthorized' | 'forbidden' | 'invalidApiRequest' | 'providerBusy' | 'providerError' | 'badProviderResponse' | 'timeout' | 'networkError' | 'aborted';

let blankPng: Buffer | null = null;

/** A white 64×64 RGB PNG (Image Analysis needs at least 50×50 pixels). */
export function blankTestImage(): Buffer {
  if (blankPng) return blankPng;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const size = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0xff)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  blankPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return blankPng;
}

export type MediaCredential = { kind: 'key'; key: string } | { kind: 'bearer'; token: string };

/** Runs the connection test. The answer body is only shape-checked, never returned (it can be large). */
export function testMedia(service: MediaService, endpoint: string, credential: MediaCredential, doFetch: typeof fetch, signal?: AbortSignal) {
  return testMediaAt(service, mediaTestUrl(service, endpoint), credential, doFetch, signal);
}

/* FR-329: Speech on a separate resource. speech.json keeps the route, the non-secret connection and its sealed check. */

export const SPEECH_FILE = 'speech.json';
export interface SavedSpeech { route: SpeechRoute; connection: SeparateSpeech | null; tenantId: string | null; verifiedAt: string | null; verification: string | null }
export const NO_SAVED_SPEECH: SavedSpeech = { route: 'foundry', connection: null, tenantId: null, verifiedAt: null, verification: null };

/** Bound to the separate key, or for Entra ID to the tenant and signed-in account, so neither a new key nor another account inherits it. */
export function separateSpeechSignature(c: SeparateSpeech, tenantId: string | null, at: string, key: string, account?: string): string {
  const fields: string[] = ['separateSpeech', c.auth, c.endpoint ?? '', c.region ?? '', at];
  if (c.auth === 'entraId') fields.push(tenantId ?? '', account ?? '');
  return createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex');
}

/** Anything malformed reads as "use the Foundry connection" with no separate connection. */
export function parseSavedSpeech(raw: unknown): SavedSpeech {
  if (!raw || typeof raw !== 'object') return NO_SAVED_SPEECH;
  const o = raw as Record<string, unknown>;
  const c = o.connection && typeof o.connection === 'object' ? (o.connection as Record<string, unknown>) : null;
  const v = c ? validateSeparateSpeech({ auth: c.auth, endpoint: c.endpoint, ...(c.auth === 'apiKey' ? { region: c.region } : {}) }) : null;
  const connection = v?.ok ? v.value : null;
  const tenantId = typeof o.tenantId === 'string' ? o.tenantId : null;
  const checked = connection && typeof o.verifiedAt === 'string' && Number.isFinite(Date.parse(o.verifiedAt)) && typeof o.verification === 'string';
  return {
    route: o.route === 'separate' && connection ? 'separate' : 'foundry', connection, tenantId,
    verifiedAt: checked ? (o.verifiedAt as string) : null, verification: checked ? (o.verification as string) : null,
  };
}

export async function testMediaAt(service: MediaService, url: string, credential: MediaCredential, doFetch: typeof fetch, signal?: AbortSignal):
  Promise<{ ok: true } | { ok: false; error: MediaTestError; providerStatus?: number }> {
  const timeout = AbortSignal.timeout(MEDIA_TEST_TIMEOUT_MS);
  const auth: Record<string, string> = credential.kind === 'key' ? { 'Ocp-Apim-Subscription-Key': credential.key } : { Authorization: `Bearer ${credential.token}` };
  let res: Response;
  try {
    res = await doFetch(url, {
      method: service === 'vision' ? 'POST' : 'GET',
      headers: service === 'vision' ? { ...auth, 'Content-Type': 'application/octet-stream' } : auth,
      body: service === 'vision' ? new Uint8Array(blankTestImage()) : undefined,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    return { ok: false, error: signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'networkError' };
  }
  if (!res.ok) {
    const error: MediaTestError = res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 429 ? 'providerBusy'
      : res.status === 400 || res.status === 404 ? 'invalidApiRequest' : 'providerError';
    return { ok: false, error, providerStatus: res.status };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: 'badProviderResponse' };
  }
  const valid = service === 'speech' ? Array.isArray(body) : !!body && typeof body === 'object' && 'modelVersion' in body;
  return valid ? { ok: true } : { ok: false, error: 'badProviderResponse' };
}

