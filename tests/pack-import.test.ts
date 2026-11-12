import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CustomerPack, Entity } from '../src/data/schema.ts';
import { samplePack } from '../src/data/sample.ts';
import { activatePack, loadPack } from '../src/data/pack.ts';
import { COLLECTION_SECTIONS, CollectionReport, collectionPresence } from '../src/data/collection.ts';
import { ArchitectureExtension, CoreObjectExtension, GlossaryEntrySchema } from '../src/data/extensionSchemas.ts';
import { GraphExtensionSchema, graphExtensionFor } from '../src/modules/graph/extensions.ts';
import { BrandProfile } from '../src/modules/ops/brand.ts';
import { CatalogItem } from '../src/modules/usecases/catalogSchema.ts';
import { catalogForScope } from '../src/modules/usecases/catalog.ts';
import { scopedKey } from '../src/state/projects.ts';
import { buildArchitecture } from '../src/modules/threed/architecture.ts';
import { coreObjectChoice } from '../src/modules/threed/coreObject.ts';
import { parseGlossary } from '../src/modules/project/discussion.ts';
import { verifyPack } from '../src/data/verify.ts';
import { verifyPack as cliVerifyPack } from '../scripts/lib/verify.ts';
import {
  analyzeImport, buildFixPrompt, extractJson, FIX_PROMPT_MAX_PROBLEMS, isReadableFile, normalizePack, preparePackLogo,
} from '../src/data/packImport.ts';
import {
  deleteImportedPack, importedPackMeta, loadImportedPack, PACK_INDEX_KEY, saveImportedPack, setMemoryPackStore, type ImportedPackMeta,
} from '../src/data/packStore.ts';
import { promptSection } from '../src/modules/project/packPrompt.ts';

/** The built-in sample leaves sourceIds of some numbers empty (bas build adds them); give them the report as source. */
const sourcedSample = { ...samplePack, entities: samplePack.entities.map((e) => (e.sourceIds.length ? e : { ...e, sourceIds: ['src-annual-report'] })) };

const fence = (v: unknown) => `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;

describe('logo permission at import', () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=', 'base64'));
  const pack = {
    ...sourcedSample,
    extensions: { brand: { primary: '#1267B4', fonts: { family: 'Example', fallbacks: [] }, logo: { src: 'brand/logo.png', alt: { ja: 'ロゴ', en: 'Logo' } } } },
  };
  it('removes the logo without approval while retaining other brand information', () => {
    const result = preparePackLogo(pack, false, png);
    expect(result.extensions).toEqual({ brand: { primary: '#1267B4', fonts: { family: 'Example', fallbacks: [] } } });
    expect(pack.extensions.brand.logo).toBeDefined();
  });
  it('embeds an approved logo and preserves it through validation and reload', () => {
    const result = preparePackLogo(pack, true, png);
    const brand = BrandProfile.parse((result.extensions as { brand: unknown }).brand);
    expect(brand.logo?.image).toMatch(/^data:image\/png;base64,/);
    expect(BrandProfile.parse(loadPack(JSON.parse(JSON.stringify(result))).pack.extensions?.brand).logo?.image).toBe(brand.logo?.image);
    expect(preparePackLogo(result, true)).toEqual(result);
  });
  it('rejects missing and unsupported images rather than persisting a broken logo', () => {
    expect(() => preparePackLogo(pack, true)).toThrow('not found');
    expect(() => preparePackLogo(pack, true, new TextEncoder().encode('<svg/>'))).toThrow('PNG, JPEG or WebP');
  });
  it('allows an approved image even when no brand was researched', () => {
    const result = preparePackLogo({ ...sourcedSample, extensions: {} }, true, png);
    expect(BrandProfile.parse((result.extensions as { brand: unknown }).brand).logo?.image).toMatch(/^data:image\/png/);
  });
});

/** The sample pack as Microsoft 365 Copilot would answer it: prose + PART 1 (pack fields + sources) + entity PARTs. */
function copilotAnswers(pack = sourcedSample, perPart = 40): string[] {
  const sources = pack.entities.filter((e) => e.kind === 'source');
  const rest = pack.entities.filter((e) => e.kind !== 'source');
  const chunks: unknown[][] = [];
  for (let i = 0; i < rest.length; i += perPart) chunks.push(rest.slice(i, i + perPart));
  const total = chunks.length + 1;
  const { entities: _e, ...head } = pack;
  return [
    `資料の一覧\n| 資料名 | 種類 |\n|---|---|\n| 統合報告書 | PDF |\n\n${fence({ part: `1/${total}`, ...head, entities: sources })}\n続きは『続けて』と送ってください（PART 1/${total}）`,
    ...chunks.map((c, i) => `PART ${i + 2}\n${fence({ part: `${i + 2}/${total}`, entities: c })}`),
  ];
}

describe('extractJson (FR-302: a pasted Copilot answer)', () => {
  it('reads only ```json blocks and ignores prose and other code blocks', () => {
    const text = 'はい、作成しました。\n```json\n{"a":1}\n```\n説明\n```python\nprint(1)\n```\n```\n[{"kind":"cause"}]\n```';
    const r = extractJson(text);
    expect(r.values).toEqual([{ a: 1 }, [{ kind: 'cause' }]]);
    expect(r.errors).toEqual([]);
  });

  it('reads a plain JSON file and the outermost object of free text', () => {
    expect(extractJson('\uFEFF{"x":true}').values).toEqual([{ x: true }]);
    expect(extractJson('結果は {"x": 2} です').values).toEqual([{ x: 2 }]);
    expect(extractJson('no json here').values).toEqual([]);
  });

  it('reports a broken block instead of silently dropping it', () => {
    const r = extractJson('```json\n{"a":1,}\n```');
    expect(r.values).toEqual([]);
    expect(r.errors[0]).toMatch(/^block 1: /);
  });
});

describe('analyzeImport: split → merge → normalize → verify (FR-302, FR-303)', () => {
  it('a pack answered in PARTs merges back to the same pack and passes the CLI verify', () => {
    const answers = copilotAnswers();
    expect(answers.length).toBeGreaterThan(2);
    // Out of order and split over a file and a paste.
    const a = analyzeImport([{ name: 'part2.txt', text: answers.slice(1).join('\n\n') }, { name: 'part1.json', text: answers[0]! }]);
    expect(a.files.map((f) => f.status)).toEqual(['used', 'used']);
    expect(a.notes).toEqual([]);
    expect(a.verify?.ok).toBe(true);
    expect(a.canImport).toBe(true);
    expect(a.summary?.entities).toBe(samplePack.entities.length);
    expect(new Set((a.pack!.entities as { id: string }[]).map((e) => e.id))).toEqual(new Set(samplePack.entities.map((e) => e.id)));
    expect(a.pack!.optimization).toEqual(samplePack.optimization);
    expect(a.pack).not.toHaveProperty('part');
    // Same verdict as the CLI: one implementation (FR-303).
    expect(cliVerifyPack).toBe(verifyPack);
    expect(cliVerifyPack(a.pack).ok).toBe(true);
  });

  it('flags missing PARTs and keeps the first value when PARTs disagree', () => {
    const answers = copilotAnswers();
    const conflicting = answers[1]!.replace(/"entities"/, '"isSample": false, "entities"');
    const a = analyzeImport([{ name: 'answer', text: [answers[0], conflicting].join('\n') }]);
    expect(a.notes.find((n) => n.code === 'partMissing')?.count).toBe(answers.length - 2);
    expect(a.notes.find((n) => n.code === 'conflict')?.detail).toBe('isSample');
    expect(a.pack!.isSample).toBe(true);
    expect(a.canImport).toBe(false);
  });

  describe('collection audit regressions', () => {
    const report = () => ({
      asOf: '2026-11-10', webSearch: 'blocked', webSearchReason: 'Disabled by policy',
      sections: COLLECTION_SECTIONS.map((key) => ({
        key, status: 'partial', sourceIds: ['src-annual-report'], missingFields: ['scope not confirmed'],
        reason: 'Only supplied material', nextAction: 'Ask the data owner',
      })),
    });
    const analyze = (raw: unknown) => analyzeImport([{ name: 'answer.json', text: JSON.stringify(raw) }]);
    const extensions = () => ({
      brand: { primary: '#1267B4' },
      dataCatalog: { items: [{ name: 'Orders', columns: ['orderId'], url: 'https://example.com/dictionary' }] },
      glossary: [{ term: 'OTD', definition: 'On time delivery' }],
      graph: { relations: [{ source: 'site-nagoya', target: 'kpi-otd', semantic: 'measurement' }] },
      architecture: { asIs: [{ layer: 'data', name: 'ERP actual' }], toBe: [{ layer: 'experience', name: 'Approved portal' }] },
      coreObject: { candidates: [{ name: 'Selected product', summary: 'Sourced candidate' }], reason: 'Documented choice' },
      collection: report(),
    });

    it('keeps URL, locator and access date through normalization, load and export; unknown publication dates stay unknown', () => {
      const raw = {
        ...sourcedSample,
        entities: sourcedSample.entities.map((e) => {
          if (e.kind !== 'source') return e;
          const { publishedDate: _date, ...source } = e;
          return { ...source, url: 'https://example.com/ir', locator: 'page 7', accessedDate: '2026-11-10', origin: 'web' };
        }),
      };
      const result = analyze(raw);
      expect(result.canImport).toBe(true);
      const exported = JSON.parse(JSON.stringify(loadPack(result.pack).pack));
      const source = exported.entities.find((e: { kind: string }) => e.kind === 'source');
      expect(source).toMatchObject({ url: 'https://example.com/ir', locator: 'page 7', accessedDate: '2026-11-10', origin: 'web' });
      expect(source).not.toHaveProperty('publishedDate');
      const invalid = structuredClone(raw);
      delete (invalid.entities.find((e) => e.kind === 'source') as { url?: string }).url;
      expect(analyze(invalid).canImport).toBe(false);
    });

    it('all six extensions and the report survive split answers and are consumed by their screen models', () => {
      const ext = extensions();
      const text = [
        fence({ part: '1/3', ...sourcedSample, isSample: false, extensions: { brand: ext.brand, dataCatalog: ext.dataCatalog, graph: ext.graph } }),
        fence({ part: '2/3', extensions: { dataCatalog: { items: [{ name: 'Invoices' }] }, glossary: ext.glossary, architecture: ext.architecture } }),
        fence({ part: '3/3', extensions: { coreObject: ext.coreObject, collection: ext.collection } }),
      ].join('\n');
      const result = analyzeImport([{ name: 'answer', text }]);
      expect(result.verify?.problems.filter((p) => p.severity === 'error')).toEqual([]);
      expect(result.canImport).toBe(true);
      const data = loadPack(result.pack);
      expect(graphExtensionFor(data).ext.relations).toHaveLength(1);
      expect(buildArchitecture('asis', data).layers.flatMap((l) => l.blocks).map((b) => b.label)).toContainEqual({ text: 'ERP actual' });
      expect(coreObjectChoice(data).candidates[0]?.name).toBe('Selected product');
      expect(parseGlossary(data.pack.extensions?.glossary)).toHaveLength(1);
      expect(CollectionReport.parse(data.pack.extensions?.collection).sections).toHaveLength(COLLECTION_SECTIONS.length);
      expect(collectionPresence(data.pack)).toMatchObject({ brand: true, dataCatalog: true, glossary: true, graph: true, architecture: true, coreObject: true });

      localStorage.removeItem(scopedKey('pj-audit', 'catalog.import'));
      try {
        activatePack(result.pack, { kind: 'imported', projectId: 'pj-audit' });
        expect(catalogForScope(null, 'pj-audit')?.items.map((i) => i.name)).toEqual(['Orders', 'Invoices']);
        expect(catalogForScope(null, 'pj-other')).toBeNull();
        localStorage.setItem(scopedKey('pj-audit', 'catalog.import'), 'null');
        expect(catalogForScope(null, 'pj-audit')).toBeNull();
      } finally {
        localStorage.removeItem(scopedKey('pj-audit', 'catalog.import'));
        activatePack(samplePack, { kind: 'sample' });
      }
    });

    it.each([
      ['dataCatalog', { items: [{ columns: ['x'] }] }],
      ['glossary', [{ term: 'missing definition' }]],
      ['graph', { relations: [{ source: 'site-missing', target: 'site-nagoya', semantic: 'dependency' }] }],
      ['graph', { layers: { 'site-missing': 'operations' } }],
      ['architecture', { asIs: [{ layer: 'not-a-layer', name: 'ERP' }] }],
      ['coreObject', { candidates: 'not an array' }],
      ['collection', { asOf: 'not-a-date' }],
    ])('rejects invalid %s instead of silently ignoring it', (key, value) => {
      const result = analyze({ ...sourcedSample, extensions: { [key as string]: value } });
      expect(result.canImport).toBe(false);
      expect(result.verify?.problems.some((p) => p.code === 'EXTENSION_SCHEMA')).toBe(true);
    });

    it('distinguishes no report, empty extension, and a partial/blocked report without fabricating completeness', () => {
      const pack = CustomerPack.parse({ ...sourcedSample, extensions: { graph: { relations: [] }, dataCatalog: { items: [] } } });
      expect(collectionPresence(pack)).toMatchObject({ graph: false, dataCatalog: false, site: true });
      expect(analyze({ ...sourcedSample, extensions: { collection: report() } }).canImport).toBe(true);
      const missing = report();
      missing.sections.pop();
      expect(analyze({ ...sourcedSample, extensions: { collection: missing } }).canImport).toBe(false);
      const falseClaim = report();
      falseClaim.sections[0]!.status = 'complete';
      expect(analyze({ ...sourcedSample, extensions: { collection: falseClaim } }).canImport).toBe(false);
    });

    it('rejects conflicting/missing parts and malformed blocks even when remaining entities are valid', () => {
      const good = fence({ ...sourcedSample, part: '1/2' });
      expect(analyzeImport([{ name: 'a', text: good }]).canImport).toBe(false);
      expect(analyzeImport([{ name: 'a', text: `${good}\n${fence({ part: '2/3', entities: [] })}` }]).canImport).toBe(false);
      expect(analyze({ ...sourcedSample, part: '1/not-known' }).canImport).toBe(false);
      expect(analyze({ ...sourcedSample, regions: 'unreadable' }).canImport).toBe(false);
      expect(analyzeImport([{ name: 'a', text: `${fence(sourcedSample)}\n${fence({ entities: 'unreadable' })}` }]).canImport).toBe(false);
      expect(analyzeImport([{ name: 'a', text: `${fence(sourcedSample)}\n\`\`\`json\n{"entities": [}\n\`\`\`` }]).canImport).toBe(false);
      const conflict = `${fence({ ...sourcedSample, extensions: { brand: { primary: '#1267B4' } } })}\n${fence({ extensions: { brand: { primary: '#000000' } } })}`;
      expect(analyzeImport([{ name: 'a', text: conflict }]).canImport).toBe(false);
    });

    it('rejects conflicting region ids, incorrect flow kinds and incorrect matrix dimensions', () => {
      expect(verifyPack({ ...sourcedSample, regions: [...sourcedSample.regions, sourcedSample.regions[0]] }).ok).toBe(false);
      expect(analyze({ ...sourcedSample, regions: [...sourcedSample.regions, { ...sourcedSample.regions[0], name: { ja: '異なる地域', en: 'Different region' } }] }).canImport).toBe(false);
      expect(analyze({ ...sourcedSample, flows: [{ source: 'kpi-otd', target: 'site-nagoya', valueT: 1 }] }).canImport).toBe(false);
      expect(analyze({ ...sourcedSample, optimization: { ...sourcedSample.optimization, transportCostPerT: [[1]] } }).canImport).toBe(false);
      expect(analyze({ ...sourcedSample, optimization: { ...sourcedSample.optimization, regionDemandT: [1] } }).canImport).toBe(false);
      expect(analyze({ ...sourcedSample, flows: [{ source: 'site-nagoya', target: 'site-osaka', valueT: 1, sourceIds: ['kpi-otd'] }] }).canImport).toBe(false);
    });
  });

  it('drops exact duplicates (Copilot repeats items when continuing) but reports conflicting ids', () => {
    const kpi = sourcedSample.entities.find((e) => e.kind === 'kpi')!;
    const answers = copilotAnswers();
    const repeat = fence({ entities: [kpi] });
    const ok = analyzeImport([{ name: 'a', text: [...answers, repeat].join('\n') }]);
    expect(ok.notes.find((n) => n.code === 'duplicateDropped')?.count).toBe(1);
    expect(ok.verify?.ok).toBe(true);
    const changed = fence({ entities: [{ ...kpi, current: kpi.current + 1 }] });
    const bad = analyzeImport([{ name: 'a', text: [...answers, changed].join('\n') }]);
    expect(bad.verify?.problems.some((p) => p.code === 'DUPLICATE_ID' && p.entityId === kpi.id)).toBe(true);
    expect(bad.canImport).toBe(false);
  });

  it('a pack without optimization, flows and regions still loads (FR-241) — nothing is invented', () => {
    const sources = samplePack.entities.filter((e) => e.kind === 'source' || e.kind === 'cause');
    const a = analyzeImport([{ name: 'min.json', text: JSON.stringify({ company: samplePack.company, entities: sources }) }]);
    expect(a.verify?.ok).toBe(true);
    expect(a.pack).not.toHaveProperty('optimization');
    expect(a.pack!.flows).toEqual([]);
    expect(a.pack!.regions).toEqual([]);
    expect(a.pack!.isSample).toBe(false);
    expect(a.notes.map((n) => n.code)).toEqual(expect.arrayContaining(['packIdGenerated', 'isSampleDefaulted', 'regionsDefaulted', 'flowsDefaulted']));
    expect(loadPack(a.pack).pack.optimization).toBeUndefined();
  });

  it('unreadable inputs are listed and skipped; the rest can still be imported', () => {
    const answers = copilotAnswers();
    const a = analyzeImport(
      [{ name: 'memo.txt', text: '議事録のメモ' }, { name: 'broken.json', text: '{"packId": ' }, { name: 'pack.txt', text: answers.join('\n') }],
      [{ name: 'report.xlsx', status: 'unsupported', fragments: 0 }],
    );
    expect(a.files.map((f) => [f.name, f.status])).toEqual([
      ['report.xlsx', 'unsupported'], ['memo.txt', 'unrecognized'], ['broken.json', 'parseError'], ['pack.txt', 'used'],
    ]);
    expect(a.canImport).toBe(true);
    expect(isReadableFile('report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false);
    expect(isReadableFile('answer.md', '')).toBe(true);
  });

  it('nothing usable → no pack and no import', () => {
    const a = analyzeImport([{ name: 'x', text: 'こんにちは' }]);
    expect(a.pack).toBeNull();
    expect(a.canImport).toBe(false);
  });
});

describe('normalizePack fixes the shape, never the facts', () => {
  it('fills languages, parses numbers, adds world/type, defaults classification to internal and author to ai', () => {
    const raw = {
      packId: 'p-1',
      company: { name: 'Contoso', industry: { ja: '製造' } },
      isSample: false,
      regions: [{ id: 'region-east', name: '東日本' }],
      flows: [],
      entities: [
        { id: 'src-plan', kind: 'source', name: '中期経営計画', description: { en: 'Mid-term plan' }, sourceIds: [], publisher: 'Contoso', publishedDate: '2026-04-01' },
        { id: 'site-a', kind: 'site', name: 'A 工場', description: '主力工場', sourceIds: ['src-plan'], role: 'plant', lat: '35.1', lon: '136.9', capacityTPerMonth: '1,200' },
        { id: 'cust-x', kind: 'customer', name: 'X 社', description: '顧客', sourceIds: [], industry: '自動車', regionId: 'region-east' },
      ],
    };
    const { pack, notes } = normalizePack(raw);
    const [src, site, cust] = pack.entities as Record<string, unknown>[];
    expect(pack.company).toEqual({ name: { ja: 'Contoso', en: 'Contoso' }, industry: { ja: '製造', en: '製造' } });
    expect(src!.description).toEqual({ ja: 'Mid-term plan', en: 'Mid-term plan' });
    expect([src!.world, src!.type, site!.world, site!.type, cust!.type]).toEqual(['digital', 'data', 'real', 'site', 'organization']);
    expect([site!.lat, site!.lon, site!.capacityTPerMonth]).toEqual([35.1, 136.9, 1200]);
    expect([site!.classification, site!.author]).toEqual(['internal', 'ai']);
    expect(cust!.illustration).toMatchObject({ motif: 'generic' });
    expect(Object.fromEntries(notes.map((n) => [n.code, n.count]))).toMatchObject({ numberParsed: 3, worldTypeFilled: 3, classificationDefaulted: 3, authorDefaulted: 3, illustrationFilled: 1 });
    expect(raw.entities[1]!.lat).toBe('35.1');
    expect(verifyPack(pack).ok).toBe(true);
  });

  it('a number without a source stays an error (A-76 (1)); the fix prompt carries cause and action', () => {
    const kpi = { ...samplePack.entities.find((e) => e.kind === 'kpi')!, sourceIds: undefined };
    const owner = samplePack.entities.find((e) => e.id === kpi.ownerId)!;
    const site = samplePack.entities.find((e) => e.kind === 'site' && e.id === (owner as { siteId: string }).siteId)!;
    const a = analyzeImport([{ name: 'a', text: fence({ company: samplePack.company, entities: [kpi, owner, site, ...samplePack.entities.filter((e) => e.kind === 'source')] }) }]);
    expect(a.canImport).toBe(false);
    const missing = a.verify!.problems.find((p) => p.code === 'MISSING_SOURCE');
    expect(missing?.entityId).toBe(kpi.id);
    const ja = buildFixPrompt(a.verify!.problems, 'ja');
    expect(ja).toContain('問題のある項目だけを直し');
    expect(ja).toContain(`[MISSING_SOURCE] ${missing!.path} (${kpi.id})`);
    expect(ja).toContain(`action: ${missing!.action}`);
    expect(buildFixPrompt(a.verify!.problems, 'en')).toContain('Change only the items with a problem');
  });

  it('the fix prompt is capped and skips problems that resolve once another item is fixed', () => {
    const problems = Array.from({ length: FIX_PROMPT_MAX_PROBLEMS + 5 }, (_, i) => ({ severity: 'error' as const, code: 'DANGLING_REF' as const, path: `entities[${i}].x`, cause: 'c', action: 'a' }));
    problems.push({ severity: 'error', code: 'DANGLING_REF', path: 'dep', cause: 'c', action: 'a', dependsOn: 'entities[0]' } as never);
    const text = buildFixPrompt(problems, 'en');
    expect(text).toContain(`Problems (${FIX_PROMPT_MAX_PROBLEMS + 5}; the first ${FIX_PROMPT_MAX_PROBLEMS})`);
    expect(text).not.toContain('] dep');
  });
});

describe('real people need no invented personal attributes (privacy)', () => {
  it('a person without ageBand, gender and portrait is valid', () => {
    const person = samplePack.entities.find((e) => e.kind === 'person')!;
    const { ageBand: _a, gender: _g, portrait: _p, ...rest } = person as Record<string, unknown>;
    expect(Entity.safeParse(rest).success).toBe(true);
  });
});

describe('packStore: per-project storage, all or nothing (FR-302)', () => {
  const meta = (projectId: string): ImportedPackMeta => ({
    projectId, packId: 'p', company: samplePack.company, isSample: false, entities: 1, importedAt: '2026-11-09T00:00:00Z', files: ['a.json'],
  });
  beforeEach(() => {
    localStorage.clear();
    setMemoryPackStore();
  });

  it('saves, loads and deletes one pack per project', async () => {
    await saveImportedPack(meta('pj-1'), { packId: 'one' });
    await saveImportedPack(meta('pj-2'), { packId: 'two' });
    expect(importedPackMeta('pj-1')?.files).toEqual(['a.json']);
    expect(await loadImportedPack('pj-2')).toEqual({ packId: 'two' });
    await deleteImportedPack('pj-1');
    expect(importedPackMeta('pj-1')).toBeNull();
    expect(await loadImportedPack('pj-1')).toBeNull();
    expect(await loadImportedPack('pj-2')).toEqual({ packId: 'two' });
  });

  it('restores the previous pack when the index cannot be written', async () => {
    await saveImportedPack(meta('pj-1'), { packId: 'old' });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === PACK_INDEX_KEY) throw new Error('QuotaExceededError');
      return original.call(this, key, value);
    };
    try {
      await expect(saveImportedPack(meta('pj-1'), { packId: 'new' })).rejects.toThrow('QuotaExceededError');
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(await loadImportedPack('pj-1')).toEqual({ packId: 'old' });
  });
});

describe('the Microsoft 365 Copilot prompt stays in step with the schema', () => {
  const doc = readFileSync(resolve(process.cwd(), 'docs/copilot-customer-pack-prompt.md'), 'utf8');
  const sections = { ja: promptSection(doc, 'ja'), en: promptSection(doc, 'en') };
  /** Decorative fields BAS fills itself; the prompt tells Copilot not to write them. */
  const notAsked = new Set(['illustration']);

  it.each(['ja', 'en'] as const)('%s prompt names every kind, every field and the world/type of each kind', (lang) => {
    const text = sections[lang];
    expect(text.length).toBeGreaterThan(1000);
    // Keep each copyable stage within our 8,000-character prompt budget.
    expect(text.length).toBeLessThan(8000);
    const worldType = new Map(samplePack.entities.map((e) => [e.kind, `${e.world}/${e.type}`] as const));
    for (const option of Entity.options) {
      const kind = String(option.shape.kind.value);
      const line = text.split('\n').find((l) => l.startsWith(`- ${kind} (`) || l.startsWith(`- ${kind}（`));
      expect(line, `${lang}: line for ${kind}`).toBeDefined();
      expect(line, `${lang}: world/type of ${kind}`).toContain(worldType.get(option.shape.kind.value as never)!);
      for (const field of Object.keys(option.shape)) {
        if (notAsked.has(field)) continue;
        expect(text, `${lang}: field ${kind}.${field}`).toContain(field);
      }
    }
    for (const field of ['packId', 'company', 'isSample', 'regions', 'flows', 'optimization', 'regionDemandT', 'currentAllocation']) expect(text).toContain(field);
    for (const key of COLLECTION_SECTIONS) expect(text).toContain(key);
    for (const schema of [ArchitectureExtension, CoreObjectExtension, GlossaryEntrySchema, GraphExtensionSchema, BrandProfile, CatalogItem, CollectionReport]) {
      for (const key of Object.keys(schema.shape)) {
        if (key !== 'logo') expect(text, `${lang}: extension field ${key}`).toContain(key);
      }
    }
    // Two stages keep internal terms out of Bing queries before anything is sent (FR-308):
    // the web research prompt takes only public inputs; the pack prompt never searches the web.
    const research = promptSection(doc, lang, 'research');
    expect(research.length).toBeGreaterThan(500);
    expect(research.length).toBeLessThan(8000);
    expect(research.match(/\{\{[^}]*\}\}/g), `${lang}: research inputs are public only`).toHaveLength(3);
    expect(research).not.toMatch(/Project|\/ (で|to) /);
    for (const word of ['blocked', 'URL', 'Bing', 'W1']) expect(research, `${lang} research: ${word}`).toContain(word);
    for (const word of ['zip', 'pack.json', 'README.md', 'blocked', 'Bing', 'W1', 'json.loads', 'PART', 'notRequested']) expect(text, `${lang}: ${word}`).toContain(word);
    expect(text).toContain('notApplicable');
    expect(text).toContain('missingFields');
  });

  it.each(['ja', 'en'] as const)('%s prompt asks for every property of docs/pack.schema.json except the declared decorative exclusions', (lang) => {
    const text = sections[lang];
    const schema: unknown = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/pack.schema.json'), 'utf8'));
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const props = (node as { properties?: unknown }).properties;
      if (props && typeof props === 'object') for (const key of Object.keys(props)) names.add(key);
      for (const value of Object.values(node)) walk(value);
    };
    walk(schema);
    // Generated by BAS for display (FR-241); asking Copilot would invent a real person's appearance.
    const excluded = new Set(['ja', 'en', 'skin', 'hair', 'hairColor', 'glasses', 'beard', 'outfitHue', 'motif', 'hue']);
    const missing = [...names].filter((n) => !excluded.has(n) && !text.includes(n));
    expect(names.size).toBeGreaterThan(50);
    expect(missing, `${lang}: schema properties the prompt never asks for`).toEqual([]);
    for (const parent of ['portrait', 'illustration']) expect(text, `${lang}: exclusion of ${parent} is stated`).toContain(parent);
  });
});
