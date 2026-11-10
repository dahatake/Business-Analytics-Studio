import { MAX_PACK_FILE_BYTES, type FileReport, type InputDoc } from './packImport.ts';

/** A zip from Copilot holds pack.json and README.md; more JSON entries than this is not a pack. */
export const MAX_ZIP_JSON_ENTRIES = 20;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function isZipFile(name: string, type: string): boolean {
  return /\.zip$/i.test(name) || type === 'application/zip' || type === 'application/x-zip-compressed';
}

interface Entry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function centralDirectory(view: DataView): Entry[] {
  const minEocd = Math.max(0, view.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported');
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CENTRAL_SIG) throw new Error('corrupt central directory');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entries.push({
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
      name: decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Not awaited: the readable side must drain concurrently or the write blocks on backpressure.
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('entry is larger than its declared size');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

async function entryBytes(view: DataView, e: Entry): Promise<Uint8Array> {
  const p = e.localOffset;
  if (p + 30 > view.byteLength || view.getUint32(p, true) !== LOCAL_SIG) throw new Error('corrupt local header');
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  if (start + e.compressedSize > view.byteLength) throw new Error('entry runs past the end of the file');
  const raw = new Uint8Array(view.buffer, view.byteOffset + start, e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRaw(raw, e.size);
  throw new Error(`compression method ${e.method} is not supported`);
}

/**
 * Reads the JSON entries of a zip (stored or deflate, as Python's zipfile writes).
 * Each entry is named `<zip>/<entry>` so the import report shows where a pack came from.
 * Entries over MAX_PACK_FILE_BYTES are refused before inflating, which also blocks zip bombs.
 */
export async function readZipJson(zipName: string, data: ArrayBuffer): Promise<{ docs: InputDoc[]; rejected: FileReport[] }> {
  const docs: InputDoc[] = [];
  const rejected: FileReport[] = [];
  const view = new DataView(data);
  let entries: Entry[];
  try {
    entries = centralDirectory(view);
  } catch (err) {
    return { docs, rejected: [{ name: zipName, status: 'parseError', fragments: 0, detail: (err as Error).message }] };
  }
  const json = entries.filter((e) => /\.json$/i.test(e.name) && !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/'));
  if (!json.length) return { docs, rejected: [{ name: zipName, status: 'unrecognized', fragments: 0 }] };
  if (json.length > MAX_ZIP_JSON_ENTRIES) {
    return { docs, rejected: [{ name: zipName, status: 'unsupported', fragments: 0, detail: `more than ${MAX_ZIP_JSON_ENTRIES} JSON entries` }] };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const e of json) {
    const name = `${zipName}/${e.name}`;
    if (e.size > MAX_PACK_FILE_BYTES || e.size === 0xffffffff) { rejected.push({ name, status: 'tooLarge', fragments: 0 }); continue; }
    if (e.flags & 1) { rejected.push({ name, status: 'unsupported', fragments: 0, detail: 'encrypted entry' }); continue; }
    try {
      docs.push({ name, text: decoder.decode(await entryBytes(view, e)) });
    } catch (err) {
      rejected.push({ name, status: 'parseError', fragments: 0, detail: (err as Error).message });
    }
  }
  return { docs, rejected };
}
