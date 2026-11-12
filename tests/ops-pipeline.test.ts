import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { samplePack } from '../src/data/sample.ts';
import { CustomerPack } from '../src/data/schema.ts';
import { verifyPack, type ProblemCode } from '../scripts/lib/verify.ts';
import { selfCorrect, MAX_ROUNDS } from '../scripts/lib/selfcorrect.ts';
import { cacheAge, CACHE_DAYS, research, researchOfficialSite, slugify } from '../scripts/lib/research.ts';
import { appendTiming, isoWithOffset, ISO_WITH_OFFSET, Timer, type TimingEntry } from '../scripts/lib/timing.ts';
import { packJsonSchema, validateJsonSchema } from '../scripts/lib/schema.ts';
import { generateDraft, researchSourceId } from '../scripts/lib/generate.ts';
import { run, workIqCheck } from '../scripts/bas.ts';
import { contrastRatio } from '../src/modules/ops/color.ts';

const TMP = resolve('.bas-local', `test-ops-${process.pid}`);
const clone = <T>(v: T): T => structuredClone(v);
type J = Record<string, any>;

/** A valid generated pack: the sample after self-correction (every number has a source). */
function validPack(): J {
  const cache = research('Contoso Robotics', { industry: 'logistics' }, new Date('2026-11-09T10:00:00+09:00'));
  const draft = generateDraft(cache, { customer: 'Contoso Robotics', industry: 'logistics', lang: 'en', templateVersion: '0.1.0' });
  return selfCorrect(draft, { defaultSourceId: researchSourceId(cache.slug), today: '2026-11-09' }).pack;
}

const idx = (pack: J, id: string) => (pack.entities as J[]).findIndex((e) => e.id === id);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('FR-127 verify', () => {
  it('the generated pack passes and lists internal items as warnings', () => {
    const r = verifyPack(validPack());
    expect(r.ok, JSON.stringify(r.problems.filter((p) => p.severity === 'error').slice(0, 3))).toBe(true);
    const internal = r.problems.filter((p) => p.code === 'INTERNAL');
    expect(internal.length).toBe(r.stats.internal);
    expect(internal.length).toBeGreaterThan(0);
    expect(r.stats.elapsedMs).toBeLessThan(60_000);
  });

  const broken: [ProblemCode, (p: J) => void][] = [
    ['SCHEMA', (p) => { delete p.company; }],
    ['ENTITY_SCHEMA', (p) => { p.entities[idx(p, 'site-nagoya')].name.en = ''; }],
    ['DUPLICATE_ID', (p) => { p.entities.push({ ...clone(p.entities[idx(p, 'cause-tacit-knowledge')]) }); }],
    ['DANGLING_REF', (p) => { p.entities[idx(p, 'deal-sakura-ev')].customerId = 'cust-nobody'; }],
    ['MISSING_SOURCE', (p) => { p.entities[idx(p, 'kpi-engagement')].sourceIds = []; }],
    ['SOURCE_KIND', (p) => { p.entities[idx(p, 'kpi-engagement')].sourceIds = ['site-nagoya']; }],
    ['BRAND_SCHEMA', (p) => { p.extensions.brand = { primary: 'not-a-colour' }; }],
    ['BRAND_CONTRAST', (p) => { p.extensions.brand = { primary: '#FFE600' }; }],
  ];
  for (const [code, breakIt] of broken) {
    it(`detects ${code} with a cause and a next action`, () => {
      const p = validPack();
      breakIt(p);
      const r = verifyPack(p);
      expect(r.ok).toBe(false);
      const hit = r.problems.find((x) => x.code === code);
      expect(hit, JSON.stringify(r.problems.slice(0, 3))).toBeTruthy();
      expect(hit!.cause.length).toBeGreaterThan(5);
      expect(hit!.action.length).toBeGreaterThan(5);
      expect(hit!.path).toBeTruthy();
    });
  }

  it('a reference to a disabled item points to the item to fix first', () => {
    const p = validPack();
    p.entities[idx(p, 'site-nagoya')].name.en = '';
    const dep = verifyPack(p).problems.filter((x) => x.dependsOn);
    expect(dep.length).toBeGreaterThan(0);
    expect(dep[0]!.cause).toMatch(/disabled by its own error/);
  });

  it('D-16: verifies evidence, customer references and context without requiring amounts or progress', () => {
    const p = validPack();
    const sourceId = p.entities.find((e: J) => e.kind === 'source').id;
    const item = { id: 'engagement-test', name: 'Workshop', status: 'Delivered', sourceIds: [sourceId] };
    p.extensions.engagements = { items: [item] };
    expect(verifyPack(p).ok).toBe(true);
    for (const [bad, code] of [
      [{ ...item, sourceIds: [] }, 'EXTENSION_SCHEMA'],
      [{ ...item, sourceIds: ['site-nagoya'] }, 'SOURCE_KIND'],
      [{ ...item, customerId: sourceId }, 'DANGLING_REF'],
      [{ ...item, status: undefined }, 'EXTENSION_SCHEMA'],
    ] as const) {
      p.extensions.engagements = { items: [bad] };
      expect(verifyPack(p).problems).toContainEqual(expect.objectContaining({ severity: 'error', code, path: expect.stringContaining('extensions.engagements') }));
    }
    p.extensions.engagements = { items: [item, item] };
    expect(verifyPack(p).problems).toContainEqual(expect.objectContaining({ severity: 'error', code: 'DUPLICATE_ID' }));
    p.extensions.engagements = { items: [{ ...item, name: p.entities.find((e: J) => e.kind === 'deal').name }] };
    const duplicateName = verifyPack(p);
    expect(duplicateName.ok).toBe(true);
    expect(duplicateName.problems).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'EXTENSION_SCHEMA', cause: expect.stringContaining('same name') }));
  });
});

describe('FR-126 self-correction', () => {
  it('fixes only the invalid items within PARAM-006 rounds', () => {
    const p = validPack();
    const before = clone(p);
    const nagoya = idx(p, 'site-nagoya');
    const kpi = idx(p, 'kpi-engagement');
    const deal = idx(p, 'deal-sakura-ev');
    p.entities[nagoya].name.en = '';
    p.entities[nagoya].sourceIds = [];
    p.entities[kpi].sourceIds = [];
    p.entities[deal].productIds = [...p.entities[deal].productIds, 'prod-ghost'];
    p.extensions.brand = { primary: '#FFE600' };
    const r0 = selfCorrect(p, { defaultSourceId: 'src-research-contoso-robotics' });
    const r = { ...r0, pack: r0.pack as J };
    expect(r.final.ok, JSON.stringify(r.final.problems.filter((x) => x.severity === 'error'))).toBe(true);
    expect(r.rounds).toBeGreaterThanOrEqual(2); // the repaired site reveals its missing source in round 2
    expect(r.rounds).toBeLessThanOrEqual(MAX_ROUNDS);
    const touched = new Set([nagoya, kpi, deal]);
    (before.entities as J[]).forEach((e, i) => {
      if (!touched.has(i)) expect(r.pack.entities[i], e.id).toEqual(e);
    });
    expect(r.pack.entities[nagoya].name.en).toBe(r.pack.entities[nagoya].name.ja);
    expect(r.pack.entities[kpi].sourceIds).toEqual(['src-research-contoso-robotics']);
    expect(r.pack.entities[deal].productIds).toEqual(before.entities[deal].productIds);
    expect(contrastRatio(r.pack.extensions.brand.foreground, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(r.pack.extensions.brand.primary).toBe('#FFE600');
    expect(r.pack.flows).toEqual(before.flows);
    expect(r.pack.optimization).toEqual(before.optimization);
  });

  it('stops after PARAM-006 rounds and leaves unfixable problems reported', () => {
    const p = validPack();
    p.entities[idx(p, 'deal-sakura-ev')].customerId = 'cust-nobody';
    const r0 = selfCorrect(p, { defaultSourceId: 'src-x' });
    const r = { ...r0, pack: r0.pack as J };
    expect(r.rounds).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(r.final.ok).toBe(false);
    expect(r.final.problems.some((x) => x.code === 'DANGLING_REF')).toBe(true);
    expect(r.pack.entities[idx(r.pack, 'deal-sakura-ev')].customerId).toBe('cust-nobody');
  });

  it('the generated draft from the sample needs exactly one round (sources linked)', () => {
    const cache = research('Fabrikam', {}, new Date('2026-11-09T00:00:00Z'));
    const draft = generateDraft(cache, { customer: 'Fabrikam', industry: 'manufacturing', lang: 'ja', templateVersion: '0.1.0' });
    const r = selfCorrect(draft, { defaultSourceId: researchSourceId(cache.slug) });
    expect(r.rounds).toBe(1);
    expect(r.final.ok).toBe(true);
    expect(CustomerPack.parse(r.pack).company.name.en).toBe('Fabrikam');
  });
});

describe('FR-121〜FR-123 research cache', () => {
  it('records each blocked source with its reason and "sample used"', () => {
    const c = research('Contoso', { industry: 'retail', lang: 'en' }, new Date('2026-11-09T10:00:00+09:00'));
    expect(c.sources.map((s) => s.id)).toEqual(['workiq', 'web', 'llm', 'sample']);
    for (const s of c.sources.slice(0, 3)) {
      expect(s.status).toBe('blocked');
      expect(s.reason).toMatch(/C-03/);
      expect(s.reason).toMatch(/C-07/);
    }
    expect(c.usedSample).toBe(true);
    expect(c.fetchedAt).toMatch(ISO_WITH_OFFSET);
    expect(c.brand.priority[0]).toBe('officialSite');
    expect(c.brand.chosen).toBe('defaultTheme');
    expect(c.classification).toBe('internal');
  });

  it('fetches only the supplied public site, records page sources, and uses an observed brand colour', async () => {
    const requested: string[] = [];
    const fetch = (async (input: URL | string | Request) => {
      requested.push(String(input));
      return new Response('<html><head><title>Contoso</title><meta name="theme-color" content="#123456"></head><body>Official information</body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as typeof globalThis.fetch;
    const now = new Date('2026-11-09T10:00:00+09:00');
    const c = await researchOfficialSite('Contoso', { officialUrl: 'https://contoso.example/' }, now, {
      fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      now: () => now.getTime(),
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => new URL(url).hostname === 'contoso.example')).toBe(true);
    expect(c.sources.find((s) => s.id === 'web')).toMatchObject({ status: 'used', integration: 'web-research' });
    expect(c.webPages.length).toBeGreaterThan(0);
    expect(c.webPages.length).toBeLessThanOrEqual(6);
    expect(c.brand).toMatchObject({
      chosen: 'officialSite',
      profile: { primary: '#123456', source: { kind: 'officialSite', reference: 'https://contoso.example/' } },
    });
    expect(c.usedSample).toBe(true);
  });

  it('rejects an invalid URL explicitly rather than silently falling back to sample data', async () => {
    await expect(researchOfficialSite('Contoso', { officialUrl: 'http://intranet/' })).rejects.toMatchObject({ code: 'invalidUrl' });
  });

  it('expires after 30 days (PARAM-004)', () => {
    const fetched = '2026-10-01T09:00:00.000+09:00';
    const at = (days: number) => new Date(Date.parse(fetched) + days * 86_400_000);
    expect(CACHE_DAYS).toBe(30);
    expect(cacheAge(fetched, at(29)).expired).toBe(false);
    expect(cacheAge(fetched, at(30)).expired).toBe(false);
    expect(cacheAge(fetched, at(30.01)).expired).toBe(true);
    expect(cacheAge(fetched, at(31)).ageDays).toBe(31);
  });

  it('slugifies customer names for folders', () => {
    expect(slugify('Contoso Robotics, Inc.')).toBe('contoso-robotics-inc');
    expect(slugify('サンプル商事')).toBe('サンプル商事');
    expect(() => slugify('  ')).toThrow(/Customer name is empty/);
  });
});

describe('FR-129 timing log', () => {
  it('writes ISO timestamps with the time-zone offset and appends', async () => {
    expect(isoWithOffset(new Date())).toMatch(ISO_WITH_OFFSET);
    const file = join(TMP, 'logs', 'timing.json');
    const t = new Timer('build', 'contoso');
    await t.step('copyTemplate', () => 1);
    await t.step('verify', async () => 2);
    appendTiming(file, t.entries);
    appendTiming(file, t.entries);
    const all = JSON.parse(readFileSync(file, 'utf8')) as TimingEntry[];
    expect(all).toHaveLength(4);
    for (const e of all) {
      expect(e.startedAt).toMatch(ISO_WITH_OFFSET);
      expect(e.endedAt).toMatch(ISO_WITH_OFFSET);
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
      expect(e).toMatchObject({ command: 'build', customer: 'contoso', ok: true });
    }
  });
});

describe('FR-118 JSON Schema', () => {
  const schema = packJsonSchema('0.1.0');

  it('docs/pack.schema.json is up to date with the zod schema', () => {
    const file = readFileSync('docs/pack.schema.json', 'utf8').replace(/\r\n/g, '\n');
    const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
    expect(JSON.parse(file)).toEqual(packJsonSchema(version));
  });

  it('D-16: exports the optional engagement structure and requires a name and evidence', () => {
    const p = validPack();
    const sourceId = p.entities.find((e: J) => e.kind === 'source').id;
    p.extensions.engagements = { items: [{ id: 'engagement-test', name: 'Workshop', status: 'Delivered', sourceIds: [sourceId] }] };
    expect(validateJsonSchema(schema, p)).toEqual([]);
    p.extensions.engagements.items[0].sourceIds = [];
    expect(validateJsonSchema(schema, p).some((e) => e.includes('engagements.items[0].sourceIds'))).toBe(true);
    p.extensions.engagements.items[0].sourceIds = [sourceId];
    delete p.extensions.engagements.items[0].name;
    expect(validateJsonSchema(schema, p).some((e) => e.includes('missing name'))).toBe(true);
  });

  it('accepts what zod accepts (sample and generated packs) and rejects what zod rejects', () => {
    expect(validateJsonSchema(schema, samplePack)).toEqual([]);
    expect(validateJsonSchema(schema, validPack())).toEqual([]);
    const bad = clone(samplePack) as J;
    bad.entities[0].lat = 'north';
    delete bad.isSample;
    expect(CustomerPack.safeParse(bad).success).toBe(false);
    const errors = validateJsonSchema(schema, bad);
    expect(errors.some((e) => e.includes('isSample'))).toBe(true);
    expect(errors.some((e) => e.startsWith('$.entities[0]'))).toBe(true);
  });
});

describe('FR-120 CLI end to end (in-process)', () => {
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) };
  const dirs = () => ['--template', join(TMP, 'template'), '--work', join(TMP, 'work'), '--cache', join(TMP, 'cache'), '--logs', join(TMP, 'logs')];

  beforeAll(() => {
    mkdirSync(join(TMP, 'template', 'data'), { recursive: true });
    writeFileSync(join(TMP, 'template', 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(TMP, 'template', 'data', 'pack.json'), '{"stale":true}');
  });

  it('research → build → verify → package, with timing and feedback logs', async () => {
    expect(await run(['research', 'Contoso Robotics', '--industry', 'logistics', '--lang', 'en', ...dirs()], io)).toBe(0);
    expect(existsSync(join(TMP, 'cache', 'contoso-robotics', 'research.json'))).toBe(true);
    expect(existsSync(join(TMP, 'cache', 'contoso-robotics', 'customer-research.md'))).toBe(true);
    expect(await run(['build', 'Contoso Robotics', '--industry', 'logistics', '--lang', 'en', ...dirs()], io)).toBe(0);
    const packFile = join(TMP, 'work', 'contoso-robotics', 'data', 'pack.json');
    const pack = JSON.parse(readFileSync(packFile, 'utf8')) as J;
    expect(pack.company.name.en).toBe('Contoso Robotics');
    expect(pack.extensions.ops.preset).toBe('logistics');
    expect(existsSync(join(TMP, 'work', 'contoso-robotics', 'index.html'))).toBe(true);
    expect(await run(['verify', packFile, ...dirs()], io)).toBe(0);
    expect(await run(['package', 'Contoso Robotics', ...dirs()], io)).toBe(0);
    for (const f of ['app/index.html', 'app/data/pack.json', 'serve.ts', 'device.ts', 'deviceProtocol.ts', 'start.ps1', 'start.sh', 'start.command', 'README.txt']) {
      expect(existsSync(join(TMP, 'work', 'contoso-robotics-package', f)), f).toBe(true);
    }
    const offline = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { startServer } from './serve.ts';
      const app = await startServer('app', 0);
      try {
        const origin = new URL(app.url).origin;
        const session = await (await fetch(origin + '/device/session', {method:'POST', headers:{origin}})).json();
        const headers = {origin, 'content-type':'application/json', 'x-bas-device':session.token};
        const saved = await fetch(origin + '/device/state', {method:'POST', headers,
          body:JSON.stringify({changes:[{key:'bas.scope.demo.offline',value:'"offline package"',expected:0}]})});
        assert.equal(saved.status, 200);
        const state = await (await fetch(origin + '/device/state', {headers})).json();
        assert.equal(state.records['bas.scope.demo.offline'].value, '"offline package"');
      } finally { await app.close(); }
    `], {
      cwd: join(TMP, 'work', 'contoso-robotics-package'), encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, BAS_DEVICE_DIR: join(TMP, 'offline-device') },
    });
    expect(offline.status, offline.stderr).toBe(0);
    expect(await run(['feedback', 'Map needs a legend', ...dirs()], io)).toBe(0);
    const fb = readFileSync(join(TMP, 'logs', 'improvements.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as J);
    expect(fb.at(-1)).toMatchObject({ text: 'Map needs a legend' });
    const timing = JSON.parse(readFileSync(join(TMP, 'logs', 'timing.json'), 'utf8')) as TimingEntry[];
    expect(timing.map((e) => e.step)).toEqual(expect.arrayContaining(['research', 'copyTemplate', 'generate', 'selfCorrect', 'verify', 'package', 'feedback']));
    expect(timing.find((e) => e.step === 'copyTemplate')!.durationMs).toBeLessThan(30_000);
  });

  it('build proposes re-research for an expired cache (FR-123)', async () => {
    lines.length = 0;
    expect(await run(['research', 'Old Corp', '--now', '2026-09-01T09:00:00+09:00', ...dirs()], io)).toBe(0);
    expect(await run(['build', 'Old Corp', '--now', '2026-11-09T09:00:00+09:00', ...dirs()], io)).toBe(0);
    expect(lines.join('\n')).toMatch(/over 30, PARAM-004\).*re-run research/s);
  });

  it('build without a template gives the next action', async () => {
    lines.length = 0;
    expect(await run(['build', 'Contoso', '--template', join(TMP, 'none'), '--work', join(TMP, 'work'), '--cache', join(TMP, 'cache'), '--logs', join(TMP, 'logs')], io)).toBe(1);
    expect(lines.join('\n')).toMatch(/npm run build/);
  });

  it('verify on a broken pack exits 1 (separate process)', () => {
    const p = validPack();
    p.entities[idx(p, 'kpi-engagement')].sourceIds = [];
    p.extensions.brand = { primary: '#FFE600' };
    const file = join(TMP, 'broken.json');
    writeFileSync(file, JSON.stringify(p));
    const r = spawnSync(process.execPath, ['scripts/bas.ts', 'verify', file, '--logs', join(TMP, 'logs')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/MISSING_SOURCE/);
    expect(r.stdout).toMatch(/BRAND_CONTRAST/);
    expect(r.stdout).toMatch(/action:/);
    writeFileSync(file, '{ not json');
    const r2 = spawnSync(process.execPath, ['scripts/bas.ts', 'verify', file, '--logs', join(TMP, 'logs')], { encoding: 'utf8' });
    expect(r2.status).toBe(1);
    expect(r2.stdout).toMatch(/PARSE/);
  });
});

describe('D-14 workiq check (first-time Work IQ CLI check)', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
  };
  const command = () => ({ command: 'node', args: ['npx-cli.js', '-y', '@microsoft/workiq@1', 'mcp'], shell: false });

  it('passes when the CLI starts with retrieve, shows the signed-in account and the next steps, and runs no tool', async () => {
    const { lines, io } = capture();
    const list = async () => ({ name: 'WorkIQ', version: '1.0.0', tools: ['ask', 'retrieve', 'accept_eula'] });
    expect(await workIqCheck(io, 'ja', 60_000, { command, list, config: async () => ({ account: 'user@contoso.example', eulaAccepted: true }) })).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('retrieve: あり');
    expect(text).toContain('user@contoso.example');
    expect(text).toContain('同意済み（I-accept-EULA=true）');
    expect(text).toContain('EULA への同意もしていません');
    expect(text).toContain('Work IQ の情報取得を検証');
  });

  it('fails with a concrete next action when the CLI is missing, times out or lacks retrieve', async () => {
    const fail = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
    for (const [code, hint] of [['workiqCliMissing', 'BAS_WORKIQ_CLI'], ['workiqTimeout', 'auth login'], ['workiqUnavailable', 'workiq.svc.cloud.microsoft']] as const) {
      const { lines, io } = capture();
      expect(await workIqCheck(io, 'en', 60_000, { command, list: fail(code), config: async () => null })).toBe(1);
      expect(lines.join('\n')).toContain(hint);
    }
    const { lines, io } = capture();
    const noRetrieve = async () => ({ name: 'WorkIQ', version: '1.0.0', tools: ['ask'] });
    expect(await workIqCheck(io, 'en', 60_000, { command, list: noRetrieve, config: async () => null })).toBe(1);
    expect(lines.join('\n')).toContain('retrieve: missing');
  });
});
