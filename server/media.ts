import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { MEDIA_TEST_TIMEOUT_MS, mediaTestUrl, validateMedia, type MediaConnection, type MediaService } from '../src/ai/mediaConnection.ts';

export { MEDIA_SERVICES, MEDIA_TEST_TIMEOUT_MS, REGION, VISION_API_VERSION, isMediaService, mediaTestUrl, parseMediaEndpoint, validateMedia } from '../src/ai/mediaConnection.ts';
export type { MediaConnection, MediaInputError, MediaService } from '../src/ai/mediaConnection.ts';

/**
 * Relay side of the Azure AI Speech / Azure AI Vision connections (FR-324): the non-secret part is kept in media.json,
 * keys stay in the vault, and the saved check is sealed with HMAC so editing the file, changing the key or switching
 * accounts drops it back to "not verified". Validation rules are shared with the settings screen (src/ai/mediaConnection.ts).
 */

export const MEDIA_FILE = 'media.json';

export type SavedMedia = MediaConnection & { verifiedAt?: string; verification?: string };
/** The token or key is bound to this account, endpoint and resource, so another one never inherits the check. */
export function mediaSignature(service: MediaService, c: MediaConnection, at: string, key: string, account?: string): string {
  const fields: string[] = [service, c.auth, c.endpoint ?? '', c.region ?? '', at];
  if (c.auth === 'entraId') fields.push(c.tenantId, c.resourceId, account ?? '');
  return createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex');
}

export function publicMedia(c: SavedMedia | null) {
  if (!c) return null;
  return { auth: c.auth, endpoint: c.endpoint, region: c.region, tenantId: c.auth === 'entraId' ? c.tenantId : null, resourceId: c.auth === 'entraId' ? c.resourceId : null };
}

export function parseSavedMedia(service: MediaService, raw: unknown): SavedMedia | null {
  if (!raw || typeof raw !== 'object') return null;
  const { verifiedAt, verification, ...rest } = raw as Record<string, unknown>;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null));
  const r = validateMedia(service, clean);
  if (!r.ok) return null;
  return { ...r.value, ...(typeof verifiedAt === 'string' ? { verifiedAt } : {}), ...(typeof verification === 'string' ? { verification } : {}) };
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
export async function testMedia(service: MediaService, c: MediaConnection, credential: MediaCredential, doFetch: typeof fetch, signal?: AbortSignal):
  Promise<{ ok: true } | { ok: false; error: MediaTestError; providerStatus?: number }> {
  const timeout = AbortSignal.timeout(MEDIA_TEST_TIMEOUT_MS);
  const auth: Record<string, string> = credential.kind === 'key' ? { 'Ocp-Apim-Subscription-Key': credential.key } : { Authorization: `Bearer ${credential.token}` };
  let res: Response;
  try {
    res = await doFetch(mediaTestUrl(service, c), {
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
