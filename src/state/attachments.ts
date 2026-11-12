import { binaryKeys, readDeviceBinary, writeDeviceBinary } from '../data/deviceStorage.ts';
import { getEntity, loaded } from '../data/pack.ts';
import type { Entity, LText } from '../data/schema.ts';
import {
  fitMedia, isMediaType, MAX_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_CHARS, sniffAttachment, type AttachmentType, type MediaCapability, type MediaPart, type SniffResult,
} from '../ai/attachments.ts';
import { commitPackChange, newEntityId } from './packEdits.ts';

/**
 * Attached files. The bytes are stored once per content (SHA-256) in the device binary store, so the same file attached
 * twice — or in another project — is reused. In the customer pack an attachment is a `source` entity whose locator is
 * `attachment:sha256:<hash>`; entities cite it in `sourceIds` and discussion themes list it in `relatedIds`.
 */
export const ATTACHMENT_PREFIX = 'bas.binary.att.';
export const ATTACHMENT_LOCATOR = 'attachment:sha256:';
const HASH = /^[0-9a-f]{64}$/;

export interface StoredAttachment {
  name: string;
  mimeType: AttachmentType;
  size: number;
  /** base64 */
  data: string;
  addedAt: string;
}

export interface AttachmentItem {
  hash: string;
  name: string;
  mimeType: AttachmentType;
  size: number;
  /** The pack source entity, once saved. */
  sourceId?: string;
}

export type AddFileResult = { ok: true; item: AttachmentItem; reused: boolean } | { ok: false; name: string; reason: Exclude<SniffResult, { ok: true }>['reason'] | 'storage' };

const attachmentKey = (hash: string) => `${ATTACHMENT_PREFIX}${hash}`;

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isStored(v: unknown): v is StoredAttachment {
  const o = v as Partial<StoredAttachment> | null;
  return !!o && typeof o.name === 'string' && typeof o.mimeType === 'string' && typeof o.size === 'number' && typeof o.data === 'string';
}

export function readAttachment(hash: string): StoredAttachment | null {
  if (!HASH.test(hash)) return null;
  try {
    const v = readDeviceBinary(attachmentKey(hash));
    return isStored(v) ? v : null;
  } catch {
    return null;
  }
}

type Meta = Omit<StoredAttachment, 'data'>;
const metaCache = new Map<string, Meta>();

/** Name, type and size for display, without keeping the bytes (content-addressed records never change). Storing and
 * restoring check the store itself. */
export function attachmentMeta(hash: string): Meta | null {
  const hit = metaCache.get(hash);
  if (hit) return hit;
  const s = readAttachment(hash);
  if (!s) return null;
  const meta = { name: s.name, mimeType: s.mimeType, size: s.size, addedAt: s.addedAt };
  metaCache.set(hash, meta);
  return meta;
}

/** Store a file the user picked. Its type comes from its bytes; the same content is stored only once. */
export async function addAttachmentFile(file: File): Promise<AddFileResult> {
  if (file.size === 0) return { ok: false, name: file.name, reason: 'empty' };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, name: file.name, reason: 'tooLarge' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffAttachment(bytes, file.name);
  if (!sniffed.ok) return { ok: false, name: file.name, reason: sniffed.reason };
  const hash = await sha256Hex(bytes);
  const existing = readAttachment(hash);
  if (existing) return { ok: true, item: { hash, name: file.name, mimeType: existing.mimeType, size: existing.size, ...sourceFor(hash) }, reused: true };
  const stored: StoredAttachment = { name: file.name, mimeType: sniffed.mimeType, size: bytes.length, data: toBase64(bytes), addedAt: new Date().toISOString() };
  try {
    await writeDeviceBinary(attachmentKey(hash), stored);
  } catch {
    return { ok: false, name: file.name, reason: 'storage' };
  }
  return { ok: true, item: { hash, name: file.name, mimeType: sniffed.mimeType, size: bytes.length, ...sourceFor(hash) }, reused: false };
}

export const hashOfSource = (e: Entity | undefined): string | null =>
  e?.kind === 'source' && e.locator?.startsWith(ATTACHMENT_LOCATOR) ? e.locator.slice(ATTACHMENT_LOCATOR.length) : null;

function sourceFor(hash: string): { sourceId?: string } {
  const s = loaded.pack.entities.find((e) => hashOfSource(e) === hash);
  return s ? { sourceId: s.id } : {};
}

/** An attachment source of the active pack as an item (null for other ids or when the bytes are not on this PC). */
export function itemOfSource(id: string): AttachmentItem | null {
  const e = getEntity(id);
  const hash = hashOfSource(e);
  if (!e || !hash) return null;
  const stored = attachmentMeta(hash);
  return { hash, name: stored?.name ?? e.name.ja, mimeType: stored?.mimeType ?? 'text/plain', size: stored?.size ?? 0, sourceId: id };
}

/** Attachments that can be attached again: sources in this pack first, then files stored on this PC by other projects. */
export function existingAttachments(): AttachmentItem[] {
  const fromPack = loaded.pack.entities.filter((e) => hashOfSource(e) !== null).map((e) => itemOfSource(e.id)).filter((x): x is AttachmentItem => x !== null);
  const seen = new Set(fromPack.map((x) => x.hash));
  const stored = binaryKeys(ATTACHMENT_PREFIX).map((k) => k.slice(ATTACHMENT_PREFIX.length)).filter((h) => HASH.test(h) && !seen.has(h)).flatMap((hash) => {
    const s = attachmentMeta(hash);
    return s ? [{ hash, name: s.name, mimeType: s.mimeType, size: s.size }] : [];
  });
  return [...fromPack, ...stored];
}

const mediaLabel: Record<string, LText> = {
  'application/pdf': { ja: 'PDF', en: 'PDF' },
};

/** The source entity for an attachment, created in the pack on first use (shareable only when the user said so). */
export async function ensureSource(item: AttachmentItem, shareable: boolean): Promise<string> {
  const existing = item.sourceId && getEntity(item.sourceId) ? item.sourceId : sourceFor(item.hash).sourceId;
  if (existing) return existing;
  const today = new Date().toISOString().slice(0, 10);
  const kindLabel = mediaLabel[item.mimeType] ?? (isMediaType(item.mimeType) ? { ja: '画像', en: 'Image' } : { ja: 'テキスト', en: 'Text' });
  const sizeKb = Math.max(1, Math.round(item.size / 1024));
  const entity = {
    id: newEntityId('source'),
    kind: 'source',
    name: { ja: item.name, en: item.name },
    description: { ja: `添付ファイル（${kindLabel.ja}・${sizeKb} KB）`, en: `Attached file (${kindLabel.en}, ${sizeKb} KB)` },
    world: 'real',
    type: 'data',
    classification: shareable ? 'shareable' : 'internal',
    author: 'human',
    sourceIds: [],
    publisher: { ja: '添付ファイル', en: 'Attached file' },
    accessedDate: today,
    locator: `${ATTACHMENT_LOCATOR}${item.hash}`,
  } as unknown as Entity;
  await commitPackChange({ op: 'upsert', entity });
  return entity.id;
}

export const sourceIdsOf = (ids: readonly string[]) => ids.filter((id) => hashOfSource(getEntity(id)) !== null);

/** Open the stored bytes in a new tab (images and PDF render in the browser; text shows as text). */
export function openAttachment(hash: string): boolean {
  const s = readAttachment(hash);
  if (!s) return false;
  const bytes = Uint8Array.from(atob(s.data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: s.mimeType.startsWith('text/') ? `${s.mimeType};charset=utf-8` : s.mimeType }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export interface AiAttachmentPlan {
  /** Sent natively to the model. */
  media: MediaPart[];
  /** Text files put into the prompt, each cut to MAX_TEXT_ATTACHMENT_CHARS. */
  text: string;
  /** Names not sent: the model does not read the type, a limit was reached, or the bytes are not on this PC. */
  skipped: string[];
}

/** Counts for the screen, from metadata only: what would be sent natively, as text, or not at all. */
export function summarizeForAi(items: readonly AttachmentItem[], cap: MediaCapability | null): { media: number; text: number; skipped: string[] } {
  const present = items.filter((i) => attachmentMeta(i.hash) !== null);
  const missing = items.filter((i) => !present.includes(i)).map((i) => i.name);
  const fit = fitMedia(present.filter((i) => isMediaType(i.mimeType)), cap);
  return { media: fit.send.length, text: present.filter((i) => !isMediaType(i.mimeType)).length, skipped: [...missing, ...fit.skipped.map((i) => i.name)] };
}

/** What of these attachments the selected model can receive. Text is always readable; media follows the capability. */
export function planAttachmentsForAi(items: readonly AttachmentItem[], cap: MediaCapability | null): AiAttachmentPlan {
  const loadedItems = items.map((i) => ({ i, s: readAttachment(i.hash) }));
  const texts: string[] = [];
  const skipped: string[] = [];
  const media: { name: string; mimeType: string; size: number; data: string }[] = [];
  for (const { i, s } of loadedItems) {
    if (!s) skipped.push(i.name);
    else if (isMediaType(s.mimeType)) media.push({ name: i.name, mimeType: s.mimeType, size: s.size, data: s.data });
    else {
      const bytes = Uint8Array.from(atob(s.data), (c) => c.charCodeAt(0));
      const body = new TextDecoder().decode(bytes);
      texts.push(`--- ${i.name} (${s.mimeType}) ---\n${body.length > MAX_TEXT_ATTACHMENT_CHARS ? `${body.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n[…]` : body}`);
    }
  }
  const fit = fitMedia(media, cap);
  skipped.push(...fit.skipped.map((m) => m.name));
  return { media: fit.send.map((m) => ({ name: m.name, mimeType: m.mimeType as MediaPart['mimeType'], data: m.data })), text: texts.join('\n\n'), skipped };
}

/** Attachments referenced by a project's stored data (for the project file). */
export function attachmentHashesIn(value: unknown): string[] {
  const found = new Set<string>();
  const re = /attachment:sha256:([0-9a-f]{64})/g;
  for (const m of JSON.stringify(value ?? null).matchAll(re)) if (m[1]) found.add(m[1]);
  return [...found];
}

export async function restoreAttachment(hash: string, stored: StoredAttachment): Promise<void> {
  if (!HASH.test(hash) || readAttachment(hash)) return;
  const bytes = Uint8Array.from(atob(stored.data), (c) => c.charCodeAt(0));
  if (bytes.length !== stored.size || (await sha256Hex(bytes)) !== hash) return;
  const sniffed = sniffAttachment(bytes, stored.name);
  if (!sniffed.ok || sniffed.mimeType !== stored.mimeType) return;
  await writeDeviceBinary(attachmentKey(hash), stored);
}
