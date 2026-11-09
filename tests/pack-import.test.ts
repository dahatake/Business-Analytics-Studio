import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Entity } from '../src/data/schema.ts';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { verifyPack } from '../src/data/verify.ts';
import { verifyPack as cliVerifyPack } from '../scripts/lib/verify.ts';
import {
  analyzeImport, buildFixPrompt, extractJson, FIX_PROMPT_MAX_PROBLEMS, isReadableFile, normalizePack,
} from '../src/data/packImport.ts';
import {
  deleteImportedPack, importedPackMeta, loadImportedPack, PACK_INDEX_KEY, saveImportedPack, setMemoryPackStore, type ImportedPackMeta,
} from '../src/data/packStore.ts';
import { promptSection } from '../src/modules/project/packPrompt.ts';

/** The built-in sample leaves sourceIds of some numbers empty (bas build adds them); give them the report as source. */
const sourcedSample = { ...samplePack, entities: samplePack.entities.map((e) => (e.sourceIds.length ? e : { ...e, sourceIds: ['src-annual-report'] })) };

const fence = (v: unknown) => `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;

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
    // Well inside the chat input limit of Microsoft 365 Copilot.
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
  });
});
