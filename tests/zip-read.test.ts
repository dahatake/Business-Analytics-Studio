import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { analyzeImport, MAX_PACK_FILE_BYTES } from '../src/data/packImport.ts';
import { isZipFile, readZipJson } from '../src/data/zipRead.ts';

interface ZipInput { name: string; data: Buffer | string; deflate?: boolean; declaredSize?: number }

/** Minimal zip writer (what Python's zipfile produces: local headers, central directory, EOCD). */
function makeZip(files: ZipInput[]): ArrayBuffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name, 'utf8');
    const size = f.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, cd, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const sourced = { ...samplePack, entities: samplePack.entities.map((e) => (e.sourceIds.length ? e : { ...e, sourceIds: ['src-annual-report'] })) };
const packJson = JSON.stringify(sourced, null, 2);
const readme = '# Sources\n- 統合報告書 https://example.com/ir\n';

describe('zip import (FR-307: the single Copilot prompt returns <packId>.zip)', () => {
  it.each([false, true])('reads pack.json from a zip (deflate=%s), ignores README.md and imports it', async (deflate) => {
    const zip = makeZip([{ name: 'pack.json', data: packJson, deflate }, { name: 'README.md', data: readme, deflate }]);
    const r = await readZipJson('contoso.zip', zip);
    expect(r.rejected).toEqual([]);
    expect(r.docs.map((d) => d.name)).toEqual(['contoso.zip/pack.json']);
    expect(JSON.parse(r.docs[0]!.text)).toEqual(JSON.parse(packJson));
    const a = analyzeImport(r.docs, r.rejected);
    expect(a.files).toEqual([{ name: 'contoso.zip/pack.json', status: 'used', fragments: 1 }]);
    expect(a.canImport).toBe(true);
    expect(a.summary?.entities).toBe(sourced.entities.length);
  });

  it('a zip without JSON is unrecognized; a non-zip is a parse error', async () => {
    expect((await readZipJson('notes.zip', makeZip([{ name: 'README.md', data: readme }]))).rejected)
      .toEqual([{ name: 'notes.zip', status: 'unrecognized', fragments: 0 }]);
    const bad = await readZipJson('fake.zip', new TextEncoder().encode('{"packId":"x"}').buffer as ArrayBuffer);
    expect(bad.docs).toEqual([]);
    expect(bad.rejected[0]).toMatchObject({ name: 'fake.zip', status: 'parseError' });
  });

  it('refuses entries over the size limit before inflating, and entries that inflate past their declared size', async () => {
    const big = makeZip([{ name: 'pack.json', data: '{}', declaredSize: MAX_PACK_FILE_BYTES + 1 }]);
    expect((await readZipJson('big.zip', big)).rejected).toEqual([{ name: 'big.zip/pack.json', status: 'tooLarge', fragments: 0 }]);
    const bomb = makeZip([{ name: 'pack.json', data: Buffer.alloc(100_000, 0x20), deflate: true, declaredSize: 10 }]);
    const r = await readZipJson('bomb.zip', bomb);
    expect(r.docs).toEqual([]);
    expect(r.rejected[0]).toMatchObject({ name: 'bomb.zip/pack.json', status: 'parseError' });
  });

  it('keeps PART files from one zip together with other inputs', async () => {
    const { entities, ...head } = sourced;
    const zip = makeZip([
      { name: 'part-1.json', data: JSON.stringify({ part: '1/2', ...head, entities: entities.slice(0, 10) }), deflate: true },
      { name: 'part-2.json', data: JSON.stringify({ part: '2/2', entities: entities.slice(10) }), deflate: true },
    ]);
    const r = await readZipJson('parts.zip', zip);
    const a = analyzeImport(r.docs, r.rejected);
    expect(a.canImport).toBe(true);
    expect(a.summary?.entities).toBe(entities.length);
  });

  it('recognises zips by extension or MIME type', () => {
    expect(isZipFile('Contoso.ZIP', '')).toBe(true);
    expect(isZipFile('download', 'application/zip')).toBe(true);
    expect(isZipFile('pack.json', 'application/json')).toBe(false);
  });
});
