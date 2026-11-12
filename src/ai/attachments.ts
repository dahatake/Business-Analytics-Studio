/**
 * File attachments the app accepts as input, decided by the bytes (file signature), not the extension, and limited to
 * what generative AI models can read:
 * - Media sent natively: JPEG/PNG/GIF/WEBP/HEIC/HEIF images and PDF (GitHub Copilot models report the exact set in
 *   `capabilities.limits.vision.supported_media_types`; Azure OpenAI chat completions document JPEG/PNG/GIF/WEBP).
 * - Text read as UTF-8 and put into the prompt: plain text, Markdown, CSV/TSV, JSON, HTML.
 * Office documents are zip containers the model APIs do not accept; they are refused with a conversion hint.
 * Shared by the browser and the relay (no DOM or Node APIs).
 */

export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'application/json', 'text/html'] as const;
export type TextType = (typeof TEXT_TYPES)[number];
export type AttachmentType = MediaType | TextType;

/** Per file. GitHub Copilot models report 3 MiB as `max_prompt_image_size`; all stored bytes load at app start. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Media bytes in one AI request (relay body limit is derived from it). */
export const MAX_REQUEST_MEDIA_BYTES = 8 * 1024 * 1024;
/** Media files in one AI request (Azure OpenAI documents 10 images per request; Copilot models report fewer). */
export const MAX_REQUEST_MEDIA_FILES = 10;
/** Characters of one text attachment placed in the prompt. */
export const MAX_TEXT_ATTACHMENT_CHARS = 12_000;

/** Azure OpenAI / Foundry chat completions with a vision deployment (Microsoft Learn "Use vision-enabled chat models"). */
export const FOUNDRY_MEDIA: MediaCapability = {
  types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  maxFiles: MAX_REQUEST_MEDIA_FILES,
  maxBytes: MAX_ATTACHMENT_BYTES,
};

export interface MediaCapability {
  types: readonly MediaType[];
  maxFiles: number;
  maxBytes: number;
}

export type SniffResult =
  | { ok: true; mimeType: AttachmentType; kind: 'media' | 'text' }
  | { ok: false; reason: 'empty' | 'tooLarge' | 'office' | 'unsupported' };

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

const TEXT_BY_EXT: Record<string, TextType> = {
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  html: 'text/html', htm: 'text/html',
};

/** The type of a file from its first bytes; text needs valid UTF-8 without NUL. `name` only refines the text subtype. */
export function sniffAttachment(bytes: Uint8Array, name: string): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'tooLarge' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ok: true, mimeType: 'image/jpeg', kind: 'media' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, mimeType: 'image/png', kind: 'media' };
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return { ok: true, mimeType: 'image/gif', kind: 'media' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { ok: true, mimeType: 'image/webp', kind: 'media' };
  if (ascii(bytes, 0, 5) === '%PDF-') return { ok: true, mimeType: 'application/pdf', kind: 'media' };
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (['heic', 'heix', 'heim', 'heis'].includes(brand)) return { ok: true, mimeType: 'image/heic', kind: 'media' };
    if (['mif1', 'msf1', 'heif'].includes(brand)) return { ok: true, mimeType: 'image/heif', kind: 'media' };
    return { ok: false, reason: 'unsupported' };
  }
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    return { ok: false, reason: /^(docx?|xlsx?|pptx?|odt|ods|odp)$/.test(ext) ? 'office' : 'unsupported' };
  }
  if (bytes.includes(0)) return { ok: false, reason: 'unsupported' };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true, mimeType: TEXT_BY_EXT[ext] ?? 'text/plain', kind: 'text' };
}

export const isMediaType = (t: string): t is MediaType => (MEDIA_TYPES as readonly string[]).includes(t);

/** The media types a GitHub Copilot model reports; models without a vision report (e.g. `auto`) take text only. */
export function copilotMediaCapability(caps: unknown): MediaCapability | null {
  const c = caps as { supports?: { vision?: unknown }; limits?: { vision?: { supported_media_types?: unknown; max_prompt_images?: unknown; max_prompt_image_size?: unknown } } } | undefined;
  const v = c?.limits?.vision;
  if (c?.supports?.vision !== true || !v || !Array.isArray(v.supported_media_types)) return null;
  const types = v.supported_media_types.filter((t): t is MediaType => typeof t === 'string' && isMediaType(t));
  if (!types.length) return null;
  const maxFiles = typeof v.max_prompt_images === 'number' && v.max_prompt_images > 0 ? Math.min(v.max_prompt_images, MAX_REQUEST_MEDIA_FILES) : 1;
  const maxBytes = typeof v.max_prompt_image_size === 'number' && v.max_prompt_image_size > 0 ? Math.min(v.max_prompt_image_size, MAX_ATTACHMENT_BYTES) : MAX_ATTACHMENT_BYTES;
  return { types, maxFiles, maxBytes };
}

/** Media sent with an AI request: base64 bytes, the sniffed type and the file name shown to the model. */
export interface MediaPart {
  name: string;
  mimeType: MediaType;
  data: string;
}

export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** Which parts a capability accepts, in order, within its file count and size limits. */
export function fitMedia<T extends { mimeType: string; size: number }>(parts: readonly T[], cap: MediaCapability | null): { send: T[]; skipped: T[] } {
  const send: T[] = [];
  const skipped: T[] = [];
  let total = 0;
  for (const p of parts) {
    const ok = cap !== null && isMediaType(p.mimeType) && cap.types.includes(p.mimeType) && p.size <= cap.maxBytes
      && send.length < cap.maxFiles && total + p.size <= MAX_REQUEST_MEDIA_BYTES;
    if (ok) {
      send.push(p);
      total += p.size;
    } else skipped.push(p);
  }
  return { send, skipped };
}

/** Relay-side check of the parts a client sent (never trust the browser's type). */
export function validateMediaParts(raw: unknown, cap: MediaCapability | null): MediaPart[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0 || cap === null || raw.length > cap.maxFiles) return null;
  const parts: MediaPart[] = [];
  let total = 0;
  for (const p of raw as unknown[]) {
    const o = p as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || Object.keys(o).some((k) => !['name', 'mimeType', 'data'].includes(k))) return null;
    const { name, mimeType, data } = o;
    if (typeof name !== 'string' || name.length < 1 || name.length > 200 || typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    if (typeof mimeType !== 'string' || !isMediaType(mimeType) || !cap.types.includes(mimeType)) return null;
    const size = base64Bytes(data);
    total += size;
    if (size > cap.maxBytes || total > MAX_REQUEST_MEDIA_BYTES) return null;
    const head = Uint8Array.from(atob(data.slice(0, 24)), (c) => c.charCodeAt(0));
    const sniffed = sniffAttachment(head, name);
    if (!sniffed.ok || sniffed.mimeType !== mimeType) return null;
    parts.push({ name, mimeType, data });
  }
  return parts;
}
