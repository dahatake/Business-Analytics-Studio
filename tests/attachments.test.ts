import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copilotMediaCapability, FOUNDRY_MEDIA, fitMedia, MAX_ATTACHMENT_BYTES, sniffAttachment, validateMediaParts, type MediaCapability,
} from '../src/ai/attachments.ts';
import { CopilotError, CopilotService, type CopilotSdk, type SdkSession } from '../server/copilot.ts';
import { exportProject, importProject } from '../src/modules/project/projectFile.ts';
import { scopedKey, useProjects } from '../src/state/projects.ts';

const store = new Map<string, unknown>();
vi.mock('../src/data/deviceStorage.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/deviceStorage.ts')>()),
  readDeviceBinary: (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null),
  writeDeviceBinary: async (k: string, v: unknown) => { store.set(k, v); },
  binaryKeys: (p: string) => [...store.keys()].filter((k) => k.startsWith(p)),
}));

const {
  addAttachmentFile, attachmentHashesIn, planAttachmentsForAi, restoreAttachment, readAttachment, sha256Hex, summarizeForAi, toBase64,
} = await import('../src/state/attachments.ts');

const bytes = (...parts: (number[] | string)[]) => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
  return new Uint8Array(out);
};
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR', [1, 2, 3, 4]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF');
const GIF = bytes('GIF89a', [1, 0, 1, 0]);
const WEBP = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ');
const PDF = bytes('%PDF-1.7\n%\xe2\xe3\n');
const HEIC = bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0]);
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], [20, 0, 0, 0]);
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => toBase64(b);

describe('attachment type detection (by content, not by name)', () => {
  it('recognizes the media formats the models read from their signatures', () => {
    expect(sniffAttachment(PNG, 'x.bin')).toMatchObject({ ok: true, mimeType: 'image/png', kind: 'media' });
    expect(sniffAttachment(JPEG, 'x')).toMatchObject({ mimeType: 'image/jpeg' });
    expect(sniffAttachment(GIF, 'x')).toMatchObject({ mimeType: 'image/gif' });
    expect(sniffAttachment(WEBP, 'x')).toMatchObject({ mimeType: 'image/webp' });
    expect(sniffAttachment(PDF, 'report.txt')).toMatchObject({ mimeType: 'application/pdf' });
    expect(sniffAttachment(HEIC, 'x')).toMatchObject({ mimeType: 'image/heic' });
  });

  it('points Office files to a conversion and rejects other binaries, empty and oversized files', () => {
    expect(sniffAttachment(ZIP, 'plan.docx')).toEqual({ ok: false, reason: 'office' });
    expect(sniffAttachment(OLE, 'old.xls')).toEqual({ ok: false, reason: 'office' });
    expect(sniffAttachment(ZIP, 'archive.zip')).toEqual({ ok: false, reason: 'unsupported' });
    expect(sniffAttachment(bytes('ab', [0], 'cd'), 'a.txt')).toEqual({ ok: false, reason: 'unsupported' });
    expect(sniffAttachment(bytes([0xc3, 0x28]), 'bad.txt')).toEqual({ ok: false, reason: 'unsupported' });
    expect(sniffAttachment(new Uint8Array(), 'a.txt')).toEqual({ ok: false, reason: 'empty' });
    expect(sniffAttachment(new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 'a.txt')).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('takes UTF-8 text and uses the extension only for the text subtype', () => {
    expect(sniffAttachment(utf8('a,b\n1,2'), 'data.CSV')).toMatchObject({ ok: true, mimeType: 'text/csv', kind: 'text' });
    expect(sniffAttachment(utf8('# 議事録'), 'notes.md')).toMatchObject({ mimeType: 'text/markdown' });
    expect(sniffAttachment(utf8('plain'), 'noext')).toMatchObject({ mimeType: 'text/plain' });
  });
});

describe('model capabilities and limits', () => {
  const vision = (types: string[], images?: number, size?: number) => ({
    supports: { vision: true }, limits: { vision: { supported_media_types: types, max_prompt_images: images, max_prompt_image_size: size } },
  });

  it('reads what a Copilot model reports; models without vision take text only', () => {
    expect(copilotMediaCapability(vision(['image/png', 'application/pdf', 'video/mp4'], 5, 1000))).toEqual({ types: ['image/png', 'application/pdf'], maxFiles: 5, maxBytes: 1000 });
    expect(copilotMediaCapability(vision(['image/png'], 50, 99 * MAX_ATTACHMENT_BYTES))).toMatchObject({ maxFiles: 10, maxBytes: MAX_ATTACHMENT_BYTES });
    expect(copilotMediaCapability(vision(['image/png']))).toMatchObject({ maxFiles: 1 });
    expect(copilotMediaCapability({ supports: { vision: false }, limits: vision(['image/png']).limits })).toBeNull();
    expect(copilotMediaCapability(undefined)).toBeNull();
    expect(copilotMediaCapability(vision(['video/mp4']))).toBeNull();
  });

  it('fits parts to the type, per-file size and count limits in order', () => {
    const cap: MediaCapability = { types: ['image/png', 'application/pdf'], maxFiles: 2, maxBytes: 100 };
    const parts = [
      { n: 'a', mimeType: 'image/png', size: 10 }, { n: 'gif', mimeType: 'image/gif', size: 10 }, { n: 'big', mimeType: 'application/pdf', size: 101 },
      { n: 'b', mimeType: 'application/pdf', size: 50 }, { n: 'c', mimeType: 'image/png', size: 1 },
    ];
    const fit = fitMedia(parts, cap);
    expect(fit.send.map((p) => p.n)).toEqual(['a', 'b']);
    expect(fit.skipped.map((p) => p.n)).toEqual(['gif', 'big', 'c']);
    expect(fitMedia(parts, null).send).toEqual([]);
    expect(fitMedia([{ mimeType: 'application/pdf', size: 10 }], FOUNDRY_MEDIA).send).toEqual([]);
  });

  it('the relay re-checks parts: declared type must match the bytes, no PDF for Foundry, bounded count and fields', () => {
    const png = { name: 'p.png', mimeType: 'image/png', data: b64(PNG) };
    expect(validateMediaParts(undefined, FOUNDRY_MEDIA)).toEqual([]);
    expect(validateMediaParts([png], FOUNDRY_MEDIA)).toEqual([png]);
    expect(validateMediaParts([{ ...png, mimeType: 'image/jpeg' }], FOUNDRY_MEDIA)).toBeNull();
    expect(validateMediaParts([{ name: 'r.pdf', mimeType: 'application/pdf', data: b64(PDF) }], FOUNDRY_MEDIA)).toBeNull();
    expect(validateMediaParts([{ ...png, data: 'not base64!' }], FOUNDRY_MEDIA)).toBeNull();
    expect(validateMediaParts([{ ...png, extra: 1 }], FOUNDRY_MEDIA)).toBeNull();
    expect(validateMediaParts([], FOUNDRY_MEDIA)).toBeNull();
    expect(validateMediaParts([png], null)).toBeNull();
    expect(validateMediaParts([png, png], { ...FOUNDRY_MEDIA, maxFiles: 1 })).toBeNull();
  });
});

describe('attachment store (content-addressed, on this PC)', () => {
  beforeEach(() => store.clear());
  const file = (b: Uint8Array, name: string) => new File([b as Uint8Array<ArrayBuffer>], name);

  it('stores a file once per content and reports reuse; refuses Office files', async () => {
    const first = await addAttachmentFile(file(PNG, 'chart.png'));
    expect(first).toMatchObject({ ok: true, reused: false, item: { mimeType: 'image/png', size: PNG.length } });
    const again = await addAttachmentFile(file(PNG, 'copy-of-chart.png'));
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(store.size).toBe(1);
    if (!first.ok) throw new Error('stored');
    expect(first.item.hash).toBe(await sha256Hex(PNG));
    expect(await addAttachmentFile(file(ZIP, 'plan.pptx'))).toEqual({ ok: false, name: 'plan.pptx', reason: 'office' });
  });

  it('plans what a model receives: text in the prompt (cut), media natively, the rest named as skipped', async () => {
    const add = async (b: Uint8Array, name: string) => { const r = await addAttachmentFile(file(b, name)); if (!r.ok) throw new Error(name); return r.item; };
    const png = await add(PNG, 'chart.png');
    const pdf = await add(PDF, 'report.pdf');
    const csv = await add(utf8(`h\n${'x'.repeat(13_000)}`), 'data.csv');
    const missing = { hash: 'f'.repeat(64), name: 'gone.png', mimeType: 'image/png' as const, size: 1 };
    const items = [png, pdf, csv, missing];

    const foundry = planAttachmentsForAi(items, FOUNDRY_MEDIA);
    expect(foundry.media.map((m) => m.name)).toEqual(['chart.png']);
    expect(foundry.media[0]!.data).toBe(b64(PNG));
    expect(foundry.text).toContain('--- data.csv (text/csv) ---');
    expect(foundry.text.length).toBeLessThan(12_100);
    expect(foundry.skipped.sort()).toEqual(['gone.png', 'report.pdf']);
    expect(summarizeForAi(items, FOUNDRY_MEDIA)).toEqual({ media: 1, text: 1, skipped: ['gone.png', 'report.pdf'] });

    const textOnly = planAttachmentsForAi(items, null);
    expect(textOnly.media).toEqual([]);
    expect(textOnly.text).toContain('data.csv');
  });

  it('restores attachments from a project file only when the bytes match their hash and type', async () => {
    const hash = await sha256Hex(PNG);
    const good = { name: 'p.png', mimeType: 'image/png' as const, size: PNG.length, data: b64(PNG), addedAt: '2025-01-01T00:00:00Z' };
    await restoreAttachment('0'.repeat(64), good);
    expect(store.size).toBe(0);
    await restoreAttachment(hash, { ...good, mimeType: 'image/jpeg' });
    expect(store.size).toBe(0);
    await restoreAttachment(hash, good);
    expect(readAttachment(hash)).toEqual(good);
    expect(attachmentHashesIn({ a: [{ locator: `attachment:sha256:${hash}` }], b: `attachment:sha256:${hash}` })).toEqual([hash]);
  });
});

describe('GitHub Copilot adapter with attachments', () => {
  const vision = { supports: { vision: true }, limits: { vision: { supported_media_types: ['image/png', 'application/pdf'], max_prompt_images: 1, max_prompt_image_size: 1000 } } };
  const sdk = (sent: unknown[]) => ({
    CopilotClient: class {
      async start() {}
      async stop() { return []; }
      async getAuthStatus() { return { isAuthenticated: true, login: 'octocat' }; }
      async listModels() { return [{ id: 'eyes', name: 'Eyes', capabilities: vision }, { id: 'text', name: 'Text', capabilities: { supports: { vision: false } } }]; }
      async createSession(): Promise<SdkSession> {
        return { sessionId: 's', on: () => () => {}, sendAndWait: async (m: unknown) => { sent.push(m); return { data: { content: 'ok' } }; }, abort: async () => {}, disconnect: async () => {} };
      }
      async deleteSession() {}
    },
  }) as unknown as CopilotSdk;
  const pdf = { name: 'r.pdf', mimeType: 'application/pdf' as const, data: b64(PDF) };
  const png = { name: 'p.png', mimeType: 'image/png' as const, data: b64(PNG) };
  const base = { system: 'S', prompt: 'P', timeoutMs: 1000 };

  it('reports the media capability of each model and sends files as blob attachments only when the model reads them', async () => {
    const sent: unknown[] = [];
    const service = new CopilotService(async () => sdk(sent));
    const models = (await service.status()).models;
    expect(models.find((m) => m.id === 'eyes')!.media).toEqual({ types: ['image/png', 'application/pdf'], maxFiles: 1, maxBytes: 1000 });
    expect(models.find((m) => m.id === 'text')!.media).toBeUndefined();

    await service.complete({ ...base, model: 'eyes', media: [pdf] });
    expect(sent[0]).toEqual({ prompt: 'P', attachments: [{ type: 'blob', data: pdf.data, mimeType: 'application/pdf', displayName: 'r.pdf' }] });
    for (const [model, media] of [['text', [pdf]], ['eyes', [pdf, png]], ['auto', [png]]] as const) {
      await expect(service.complete({ ...base, model, media: [...media] }), model).rejects.toEqual(new CopilotError('unsupportedAttachment'));
    }
    expect(sent).toHaveLength(1);
  });
});

describe('project file carries the attached bytes', () => {
  beforeEach(() => store.clear());

  it('exports the files the project cites and restores only those whose bytes match their hash', async () => {
    const r = await addAttachmentFile(new File([PNG as Uint8Array<ArrayBuffer>], 'chart.png'));
    if (!r.ok) throw new Error('stored');
    const s = useProjects.getState();
    const c = s.addCompany('Attach Co');
    if (!c.ok) throw new Error();
    const p = s.addProject(c.id, 'Evidence');
    if (!p.ok) throw new Error();
    const discussion = { themes: [{ id: 't', relatedIds: ['src-x'] }], records: [], packEdits: { locator: `attachment:sha256:${r.item.hash}` } };
    localStorage.setItem(scopedKey(p.id, 'proj.discussion'), JSON.stringify(discussion));
    const file = JSON.parse(JSON.stringify(exportProject(p.id)));
    expect(Object.keys(file.attachments)).toEqual([r.item.hash]);
    expect(file.attachments[r.item.hash]).toMatchObject({ name: 'chart.png', mimeType: 'image/png', size: PNG.length });

    s.deleteProject(p.id);
    store.clear();
    expect(importProject(JSON.stringify(file)).ok).toBe(true);
    await vi.waitFor(() => expect(readAttachment(r.item.hash)?.data).toBe(b64(PNG)));

    s.deleteProject(p.id);
    store.clear();
    const tampered = structuredClone(file);
    tampered.attachments[r.item.hash].data = b64(JPEG);
    tampered.attachments[r.item.hash].size = JPEG.length;
    expect(importProject(JSON.stringify(tampered)).ok).toBe(true);
    await new Promise((done) => setTimeout(done, 50));
    expect(store.size).toBe(0);
  });
});
