import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dropRejectedNulls, parseModelJson, parseModelOutput } from '../src/ai/modelJson.ts';
import { normalizePack } from '../src/data/packImport.ts';
import { samplePack } from '../src/data/sample.ts';
import { verifyPack } from '../src/data/verify.ts';
import { demoWorkflow } from '../src/modules/process/demo.ts';

describe('D-57 model JSON boundary', () => {
  const Schema = z.object({
    rate: z.number().positive().optional(),
    note: z.string().nullable(),
    name: z.string(),
    tags: z.array(z.string()).default([]),
    items: z.array(z.union([z.string(), z.object({ name: z.string(), form: z.enum(['a', 'b']).optional() })])),
  });

  it('treats a rejected null as left out, keeps an accepted null and still rejects a null required value', () => {
    const answer = { rate: null, note: null, name: 'x', tags: null, items: ['a', null, { name: 'b', form: null }, null] };
    const parsed = parseModelOutput(Schema, answer);
    expect(parsed.success && parsed.data).toEqual({ note: null, name: 'x', tags: [], items: ['a', { name: 'b' }] });
    expect(dropRejectedNulls(Schema, answer).dropped).toEqual(expect.arrayContaining([['rate'], ['tags'], ['items', 1], ['items', 2, 'form'], ['items', 3]]));
    expect(answer.rate).toBeNull();
    expect(parseModelOutput(Schema, { note: null, name: null, items: [] }).success).toBe(false);
  });

  it('reads a bare or fenced JSON answer', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```JSON {"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson(' [1] ')).toEqual([1]);
    expect(() => parseModelJson('not json')).toThrow(SyntaxError);
  });

  it('normalizes a generated or imported pack whose optional fields are null so it checks like the same pack without them', () => {
    const errors = (p: Record<string, unknown>) => verifyPack(normalizePack(p).pack).problems.filter((x) => x.severity === 'error');
    const baseline = structuredClone(samplePack) as unknown as Record<string, unknown>;
    baseline.extensions = { ...(baseline.extensions as object), workflow: demoWorkflow };
    const pack = structuredClone(baseline);
    const kpi = (pack.entities as Record<string, unknown>[]).find((e) => e.kind === 'kpi' && e.ownerId !== undefined)!;
    kpi.ownerId = null;
    pack.extensions = { ...(pack.extensions as object), workflow: { ...demoWorkflow, laborCostPerHourJpy: null, draftNote: null } };
    const before = verifyPack(pack).problems.filter((x) => x.severity === 'error').length;
    expect(before).toBeGreaterThan(verifyPack(baseline).problems.filter((x) => x.severity === 'error').length);
    expect(errors(pack)).toEqual(errors(baseline));
    expect(normalizePack(pack).notes).toContainEqual(expect.objectContaining({ code: 'nullDropped', count: 3 }));
  });
});

describe('every model answer passes the shared boundary (src/ai/modelJson.ts)', () => {
  const files = (readdirSync('src', { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ path: `src/${f.split(sep).join('/')}`, text: readFileSync(join('src', f), 'utf8') }))
    .filter((f) => f.path !== 'src/ai/modelJson.ts');
  /** Modules that call a model but validate only data that already passed the boundary (the loaded or normalized pack). */
  const NOT_MODEL_OUTPUT: Record<string, string> = {
    'src/modules/project/KpiAdoptUi.tsx': 'zod checks only the loaded pack OKR',
    'src/modules/project/kpiAutoDraft.ts': 'zod checks only the loaded pack OKR',
    'src/modules/project/PackGenerateDialog.tsx': 'zod checks only the user\'s news request',
    'src/modules/project/ProjectAlignmentDialog.tsx': 'zod checks only the loaded pack',
  };

  it('no module strips a ```json fence on its own', () => {
    expect(files.filter((f) => f.text.includes('```(?:json)?')).map((f) => f.path)).toEqual([]);
  });

  it('a module that reads a model answer and validates it with zod uses parseModelOutput', () => {
    const offenders = files.filter((f) => {
      const readsModel = /extractJson\(|aiLive\(|aiComplete\(|transport\.send\(/.test(f.text);
      const validates = /\.(safeParse|parse)\(/.test(f.text.replace(/(JSON|Date)\.parse\(/g, ''));
      return readsModel && validates && !f.text.includes('/ai/modelJson.ts') && !(f.path in NOT_MODEL_OUTPUT);
    });
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
