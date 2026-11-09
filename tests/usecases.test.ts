import { beforeEach, describe, expect, it } from 'vitest';
import { loaded } from '../src/data/pack.ts';
import { PERSONA_VIEWS } from '../src/state/personas.ts';
import { useProjects } from '../src/state/projects.ts';
import { locAll } from '../src/state/text.ts';
import { charLength, normalizeName, truncateChars } from '../src/modules/usecases/normalize.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { deriveCandidates, openCandidates } from '../src/modules/usecases/derive.ts';
import {
  ANIMATION_READY_MS, buildAnimation, buildStoryboard, fitDurations, MAX_TELOP_CHARS, SCENE_MS, sceneIndexAt,
  STORYBOARD_TARGET_MS, STORYBOARD_TOLERANCE_MS,
} from '../src/modules/usecases/scenes.ts';
import { generateMockApp, MOCK_MAX_SCREENS, MOCK_MIN_SCREENS } from '../src/modules/usecases/mockapp.ts';
import { madeState, MAX_USECASE_STEPS, STORY_STYLES, useUseCases, type UseCase } from '../src/modules/usecases/store.ts';
import {
  buildClusters, deriveDataModel, detailFor, isSimplified, linkKey, VIEWER_MAX_COLUMNS, VIEWER_MAX_ENTITIES, type DataEntity,
} from '../src/modules/usecases/catalogModel.ts';
import {
  countByCategory, enrichEntities, MAX_CATALOG_BYTES, MAX_CATALOG_ITEMS, parseCatalogFile, parseCsv, reconcile, type CatalogItem,
} from '../src/modules/usecases/catalog.ts';
import { addMissingToTodos, toggleLink } from '../src/modules/usecases/links.ts';

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/;

const uc = (steps: number, extra: Partial<UseCase> = {}): UseCase => ({
  id: `uc-t${steps}`,
  name: 'Ship faster',
  summary: 'Answer delivery dates at once',
  persona: 'business',
  steps: Array.from({ length: steps }, (_, i) => ({ title: `Step heading number ${i + 1} that is quite long`, description: `Do thing ${i + 1}` })),
  effect: 'Lead time 16 to 10 days',
  relatedIds: [],
  origin: 'registered',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});

describe('name normalization (FR-159)', () => {
  it('merges width, case, whitespace, hyphen and katakana long-vowel variants', () => {
    expect(normalizeName('Customer-Master')).toBe(normalizeName('customer master'));
    expect(normalizeName('ＣＵＳＴＯＭＥＲ　ＭＡＳＴＥＲ')).toBe(normalizeName('customer_master'));
    expect(normalizeName('サーバー')).toBe(normalizeName('サーバ'));
    expect(normalizeName('カスタマーマスター')).toBe(normalizeName('カスタママスタ'));
    expect(normalizeName('ｶｽﾀﾏｰ')).toBe(normalizeName('カスタマー'));
    expect(normalizeName('データ-')).toBe(normalizeName('データ'));
    expect(normalizeName('受注 データ')).toBe(normalizeName('受注・データ'));
    expect(normalizeName('Order')).not.toBe(normalizeName('Orders x'));
  });

  it('counts and truncates by characters', () => {
    expect(charLength('受注🙂')).toBe(3);
    expect(truncateChars('abcdefghij', 5)).toBe('abcd…');
    expect(charLength(truncateChars('あ'.repeat(40), 20))).toBe(20);
    expect(truncateChars('short', 20)).toBe('short');
  });
});

describe('demo seeds (FR-180, PARAM-060)', () => {
  const seeds = demoUseCases();
  it('has at least two registered use cases per persona view', () => {
    for (const p of PERSONA_VIEWS) expect(seeds.filter((s) => s.persona === p).length, p).toBeGreaterThanOrEqual(2);
    expect(seeds.every((s) => s.origin === 'registered')).toBe(true);
    expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length);
  });

  it('is bilingual and the English text has no Japanese', () => {
    for (const s of seeds) {
      const texts = [s.name, s.summary, ...(s.effect ? [s.effect] : []), ...s.steps.flatMap((x) => [x.title, x.description])];
      for (const t of texts) {
        expect(typeof t).toBe('object');
        if (typeof t === 'object') {
          expect(t.ja.trim()).not.toBe('');
          expect(JAPANESE.test(t.en), t.en).toBe(false);
        }
      }
      expect(s.steps.length).toBeLessThanOrEqual(MAX_USECASE_STEPS);
    }
  });

  it('references existing pack entities', () => {
    for (const s of seeds) for (const id of s.relatedIds) expect(loaded.byId.has(id), id).toBe(true);
  });

  it('demo starts from the seeds, a new project starts empty', () => {
    localStorage.clear();
    useProjects.setState({ companies: [], projects: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'define' });
    expect(useUseCases.getState().value.length).toBe(seeds.length);
    const c = useProjects.getState().addCompany('Co');
    if (!c.ok) throw new Error();
    const p = useProjects.getState().addProject(c.id, 'P');
    if (!p.ok) throw new Error();
    useProjects.getState().setTarget({ kind: 'project', projectId: p.id });
    expect(useUseCases.getState().value).toEqual([]);
    useUseCases.getState().set([uc(2)]);
    useProjects.getState().setTarget({ kind: 'demo' });
    expect(useUseCases.getState().value.some((u) => u.id === 'uc-t2')).toBe(false);
  });
});

describe('derived candidates (FR-158)', () => {
  it('derives one unsaved candidate per solution with bilingual steps', () => {
    const c = deriveCandidates();
    expect(c.length).toBe(loaded.pack.entities.filter((e) => e.kind === 'solution').length);
    for (const x of c) {
      expect(x.origin).toBe('derived');
      expect(x.steps.length).toBeGreaterThan(0);
      expect(x.steps.length).toBeLessThanOrEqual(MAX_USECASE_STEPS);
      for (const s of x.steps) for (const t of [s.title, s.description]) if (typeof t === 'object') expect(JAPANESE.test(t.en)).toBe(false);
    }
  });

  it('hides a candidate once it is registered and offers it again after deletion', () => {
    const first = deriveCandidates()[0]!;
    const registered = { ...first, id: 'uc-x', origin: 'registered' as const };
    expect(openCandidates([registered]).some((c) => c.derivedFrom === first.derivedFrom)).toBe(false);
    expect(openCandidates([]).some((c) => c.derivedFrom === first.derivedFrom)).toBe(true);
  });
});

describe('animation scene builder (FR-155, PARAM-047/048)', () => {
  it('builds intro → one scene per step → effect at 5 s each', () => {
    const tl = buildAnimation(uc(3));
    expect(tl.scenes.map((s) => s.kind)).toEqual(['intro', 'step', 'step', 'step', 'effect']);
    expect(tl.scenes.every((s) => s.durationMs === SCENE_MS)).toBe(true);
    expect(SCENE_MS).toBe(5000);
    expect(tl.totalMs).toBe(5 * SCENE_MS);
    expect(tl.scenes[2]!.stepNo).toBe(2);
    expect(sceneIndexAt(tl.scenes, 0)).toBe(0);
    expect(sceneIndexAt(tl.scenes, 5000)).toBe(1);
    expect(sceneIndexAt(tl.scenes, 24_999)).toBe(4);
  });

  it('omits the effect scene when there is no effect', () => {
    expect(buildAnimation(uc(1, { effect: undefined })).scenes.map((s) => s.kind)).toEqual(['intro', 'step']);
  });

  it('is fast enough to be playable within PARAM-048 even at 20 steps', () => {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) buildAnimation(uc(MAX_USECASE_STEPS));
    expect((performance.now() - t0) / 100).toBeLessThan(ANIMATION_READY_MS / 100);
  });

  it('tracks staleness after the use case is edited', () => {
    const u = uc(1);
    expect(madeState(u, undefined)).toBe('none');
    expect(madeState(u, { createdAt: '2026-11-02T00:00:00.000Z' })).toBe('latest');
    expect(madeState({ ...u, updatedAt: '2026-11-03T00:00:00.000Z' }, { createdAt: '2026-11-02T00:00:00.000Z' })).toBe('stale');
  });
});

describe('storyboard (FR-163〜166, PARAM-052/053/054)', () => {
  it('fits the total to about 30 s for any number of steps and every style', () => {
    for (const style of STORY_STYLES) {
      for (const n of [0, 1, 3, 8, MAX_USECASE_STEPS]) {
        const tl = buildStoryboard(uc(n), style);
        expect(Math.abs(tl.totalMs - STORYBOARD_TARGET_MS), `${style} ${n}`).toBeLessThanOrEqual(STORYBOARD_TOLERANCE_MS);
        expect(tl.scenes.reduce((a, s) => a + s.durationMs, 0)).toBe(tl.totalMs);
        expect(tl.scenes.every((s) => s.durationMs > 0)).toBe(true);
      }
    }
  });

  it('fitDurations scales weights and handles odd input', () => {
    const d = fitDurations([1, 2, 3]);
    expect(d.reduce((a, b) => a + b, 0)).toBe(30_000);
    expect(d[2]!).toBeGreaterThan(d[0]!);
    expect(fitDurations([]).length).toBe(0);
    expect(fitDurations([0, Number.NaN, -1]).reduce((a, b) => a + b, 0)).toBe(30_000);
  });

  it('is centred on the user story and keeps every telop within 20 characters', () => {
    const long = uc(4, { name: 'あ'.repeat(50), effect: 'Effect text that is definitely longer than twenty characters' });
    const tl = buildStoryboard(long, 'bold');
    expect(tl.scenes.map((s) => s.kind)).toEqual(['hook', 'story', 'step', 'step', 'step', 'step', 'payoff']);
    for (const s of tl.scenes) for (const t of locAll(s.telop)) expect(charLength(t)).toBeLessThanOrEqual(MAX_TELOP_CHARS);
    for (const s of tl.scenes) expect(s.elements.length).toBeGreaterThan(0);
    const story = tl.scenes[1]!.subtitle;
    expect(typeof story === 'object' && story.en.startsWith('As ')).toBe(true);
    for (const seed of demoUseCases()) {
      const sb = buildStoryboard(seed, 'cinematic');
      for (const s of sb.scenes) {
        for (const t of locAll(s.telop)) expect(charLength(t)).toBeLessThanOrEqual(MAX_TELOP_CHARS);
        for (const field of [s.heading, s.subtitle, s.telop]) if (typeof field === 'object') expect(JAPANESE.test(field.en), field.en).toBe(false);
      }
    }
  });

  it('minimal style uses fewer moving elements than bold', () => {
    const a = buildStoryboard(uc(3), 'minimal').scenes.reduce((n, s) => n + s.elements.length, 0);
    const b = buildStoryboard(uc(3), 'bold').scenes.reduce((n, s) => n + s.elements.length, 0);
    expect(a).toBeLessThan(b);
  });
});

describe('mini mock app (FR-043, PARAM-022)', () => {
  it('generates between 1 and 3 screens', () => {
    for (const n of [0, 1, 2, 3, 5, 6, MAX_USECASE_STEPS]) {
      const screens = generateMockApp(uc(n));
      expect(screens.length, String(n)).toBeGreaterThanOrEqual(MOCK_MIN_SCREENS);
      expect(screens.length, String(n)).toBeLessThanOrEqual(MOCK_MAX_SCREENS);
      expect(screens.some((s) => s.kind === 'form')).toBe(true);
      expect(screens.find((s) => s.kind === 'form')!.fields.length).toBeGreaterThan(0);
    }
    expect(generateMockApp(uc(1)).length).toBe(1);
    expect(generateMockApp(uc(4)).map((s) => s.kind)).toEqual(['list', 'form']);
    expect(generateMockApp(uc(8)).map((s) => s.kind)).toEqual(['list', 'form', 'summary']);
  });
});

describe('data entities (FR-159 / FR-172 / FR-160)', () => {
  const seeds = demoUseCases();
  const model = deriveDataModel(seeds);

  it('derives entities from record kinds, data-typed entities and issue/solution references, merging variants', () => {
    const ids = model.entities.map((e) => e.id);
    for (const id of ['de-order', 'de-invoice', 'de-deliverable', 'de-kpi-record', 'de-inventory', 'de-power-usage']) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    // "受注" from the deal kind and from issue text is one entity; "請求" text merges into the invoice kind.
    expect(ids.filter((x) => x === 'de-order').length).toBe(1);
    const invoice = model.entities.find((e) => e.id === 'de-invoice')!;
    expect(invoice.sourceIds).toContain('inv-2026-064');
    expect(invoice.sourceIds).toContain('issue-cash');
  });

  it('keeps columns from record attributes (FR-172)', () => {
    const invoice = model.entities.find((e) => e.id === 'de-invoice')!;
    const cols = invoice.columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'amountJpy', 'issuedDate', 'status']));
    expect(cols).not.toContain('classification');
  });

  it('derives entity × use case links from related ids and text', () => {
    expect(model.derivedLinks.has(linkKey('de-invoice', 'uc-demo-biz-invoice'))).toBe(true);
    expect(model.derivedLinks.has(linkKey('de-kpi-record', 'uc-demo-exec-cash'))).toBe(true);
    expect(model.derivedLinks.has(linkKey('de-power-usage', 'uc-demo-field-energy'))).toBe(true);
    expect(model.relations.length).toBeGreaterThan(0);
  });

  it('toggles explicit links', () => {
    const a = toggleLink([], 'de-order', 'uc-1');
    expect(a).toEqual([{ entityId: 'de-order', useCaseId: 'uc-1' }]);
    expect(toggleLink(a, 'de-order', 'uc-1')).toEqual([]);
  });

  it('clusters by use case and by domain', () => {
    const byUc = buildClusters(model.entities, model.derivedLinks, seeds, 'usecase');
    expect(byUc.flatMap((c) => c.entityIds).sort()).toEqual(model.entities.map((e) => e.id).sort());
    const withDomain = model.entities.map((e, i) => ({ ...e, domain: i % 2 ? 'Sales' : undefined }));
    const byDomain = buildClusters(withDomain, model.derivedLinks, seeds, 'domain');
    expect(byDomain.map((c) => c.label)).toContain('Sales');
    expect(byDomain[byDomain.length - 1]!.label).toBeNull();
  });
});

describe('data viewer limits and detail (FR-169 / FR-171)', () => {
  it('switches to the simplified display beyond PARAM-055 / PARAM-056', () => {
    expect(isSimplified(VIEWER_MAX_ENTITIES, VIEWER_MAX_COLUMNS)).toBe(false);
    expect(isSimplified(VIEWER_MAX_ENTITIES + 1, 0)).toBe(true);
    expect(isSimplified(10, VIEWER_MAX_COLUMNS + 1)).toBe(true);
  });

  it('chooses the level of detail with hysteresis', () => {
    expect(detailFor(1, 'clusters')).toBe('clusters');
    expect(detailFor(1.4, 'clusters')).toBe('clusters');
    expect(detailFor(1.5, 'clusters')).toBe('entities');
    expect(detailFor(1.4, 'entities')).toBe('entities');
    expect(detailFor(1.2, 'entities')).toBe('clusters');
    expect(detailFor(3, 'entities')).toBe('columns');
    expect(detailFor(2.8, 'columns')).toBe('columns');
    expect(detailFor(2.5, 'columns')).toBe('entities');
    expect(detailFor(4, 'entities', true)).toBe('entities');
  });
});

describe('company data catalog import (FR-161, PARAM-050/051)', () => {
  it('parses CSV with quotes, columns and a BOM', () => {
    expect(parseCsv('\uFEFFname,description\r\n"Order, main","say ""hi"""\n')).toEqual([['name', 'description'], ['Order, main', 'say "hi"']]);
    const r = parseCatalogFile('c.csv', 'id,name,description,columns,domain,url\nC-1,受注,Orders,order_id;customer_id,Sales,https://example.com/a\n', 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.catalog.items[0]).toMatchObject({ id: 'C-1', name: '受注', columns: ['order_id', 'customer_id'], domain: 'Sales', url: 'https://example.com/a' });
  });

  it('parses JSON arrays and {items}', () => {
    const a = parseCatalogFile('c.json', JSON.stringify([{ name: 'Order', columns: [{ name: 'id' }, 'total'] }]), 10);
    expect(a.ok && a.catalog.items[0]!.columns).toEqual(['id', 'total']);
    const b = parseCatalogFile('c.json', JSON.stringify({ items: [{ name: 'X', id: 'x' }] }), 10);
    expect(b.ok && b.catalog.items.length).toBe(1);
  });

  it('rejects files over the size and count limits, and unreadable files', () => {
    expect(parseCatalogFile('a.csv', 'name\nx', MAX_CATALOG_BYTES + 1)).toMatchObject({ ok: false, error: 'tooLarge' });
    const many = `name\n${Array.from({ length: MAX_CATALOG_ITEMS + 1 }, (_, i) => `n${i}`).join('\n')}`;
    expect(parseCatalogFile('a.csv', many, many.length)).toMatchObject({ ok: false, error: 'tooMany' });
    const exactly = `name\n${Array.from({ length: MAX_CATALOG_ITEMS }, (_, i) => `n${i}`).join('\n')}`;
    expect(parseCatalogFile('a.csv', exactly, exactly.length).ok).toBe(true);
    expect(parseCatalogFile('a.json', '{oops', 5)).toMatchObject({ ok: false, error: 'format' });
    expect(parseCatalogFile('a.json', '{"x":1}', 5)).toMatchObject({ ok: false, error: 'format' });
    expect(parseCatalogFile('a.csv', 'id,description\n1,x', 5)).toMatchObject({ ok: false, error: 'noName' });
    expect(parseCatalogFile('a.csv', '', 0)).toMatchObject({ ok: false, error: 'empty' });
  });

  it('skips bad rows and reports them; a file of only bad rows is rejected', () => {
    const r = parseCatalogFile('a.csv', 'name,url\nGood,https://ok.example\n,https://x.example\nBadUrl,ftp://x.example\nScript,javascript:alert(1)\n', 50);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.catalog.items.map((i) => i.name)).toEqual(['Good']);
      expect(r.rowErrors.map((e) => e.row)).toEqual([2, 3, 4]);
      expect(r.rowErrors[0]!.field).toBe('name');
      expect(r.rowErrors[1]!.field).toBe('url');
    }
    expect(parseCatalogFile('a.csv', 'name\n \n""\n', 10).ok).toBe(false);
  });
});

describe('reconciliation (FR-161)', () => {
  const ent = (id: string, ja: string, en: string, cols: string[] = []): DataEntity => ({
    id, name: { ja, en }, description: { ja, en }, keys: [normalizeName(ja), normalizeName(en), normalizeName(id)], sourceIds: [], columns: cols.map((name) => ({ name, source: 'pack' })),
  });
  const entities = [
    ent('de-order', '受注', 'Order', ['id', 'total']),
    ent('de-customer', 'カスタマー', 'Customer'),
    ent('de-invoice', '請求書', 'Invoice', ['id', 'amount']),
    ent('de-site', '拠点', 'Site'),
    ent('de-server', 'サーバー', 'Server'),
  ];
  const items: CatalogItem[] = [
    { name: 'ＯＲＤＥＲ', columns: ['ID', 'Total'] },
    { name: 'カスタマ' },
    { name: 'Billing document', id: 'DE-INVOICE' },
    { name: 'Invoice copy', id: 'zzz', columns: [] },
    { name: 'サーバ', columns: ['host'] },
    { name: 'Warehouse' },
  ];

  it('sorts every pair into match / difference / BAS only / catalog only', () => {
    const rows = reconcile(entities, items);
    const cat = (name: string) => rows.find((r) => r.item?.name === name)?.category;
    expect(cat('ＯＲＤＥＲ')).toBe('match');
    expect(cat('カスタマ')).toBe('match');
    expect(cat('Billing document')).toBe('difference');
    expect(rows.find((r) => r.item?.name === 'Billing document')!.reasons).toEqual(['name']);
    expect(cat('Invoice copy')).toBe('catalogOnly');
    expect(cat('サーバ')).toBe('match');
    expect(cat('Warehouse')).toBe('catalogOnly');
    expect(rows.filter((r) => r.category === 'basOnly').map((r) => r.entity!.id)).toEqual(['de-site']);
    expect(countByCategory(rows)).toEqual({ match: 3, difference: 1, basOnly: 1, catalogOnly: 2 });
  });

  it('reports column differences and enriches entities with catalog columns and domain', () => {
    const rows = reconcile(entities, [{ name: 'Order', columns: ['id', 'customer'], domain: 'Sales' }]);
    expect(rows[0]).toMatchObject({ category: 'difference', reasons: ['columns'] });
    const enriched = enrichEntities(entities, rows);
    const order = enriched.find((e) => e.id === 'de-order')!;
    expect(order.domain).toBe('Sales');
    expect(order.columns).toContainEqual({ name: 'customer', source: 'catalog' });
    expect(order.columns.filter((c) => c.name === 'id').length).toBe(1);
  });

  it('with no catalog every entity is BAS only', () => {
    expect(countByCategory(reconcile(entities, []))).toEqual({ match: 0, difference: 0, basOnly: entities.length, catalogOnly: 0 });
  });
});

describe('ToDo bulk add (FR-162)', () => {
  beforeEach(() => localStorage.clear());
  it('adds BAS-only entities with the entity and related use cases in the text, idempotently', () => {
    const seeds = demoUseCases();
    const model = deriveDataModel(seeds);
    const invoice = model.entities.find((e) => e.id === 'de-invoice')!;
    const order = model.entities.find((e) => e.id === 'de-order')!;
    const linked = seeds.filter((s) => model.derivedLinks.has(linkKey(invoice.id, s.id)));
    const missing = [{ entity: invoice, useCases: linked }, { entity: order, useCases: [] }];
    const first = addMissingToTodos([], missing);
    expect(first.added).toBe(2);
    const todo = first.next[0]!;
    expect(typeof todo.name === 'object' && todo.name.ja.includes('請求書') && todo.name.en.includes('Invoice')).toBe(true);
    expect(typeof todo.description === 'object' && todo.description.en.includes('Automate invoice to cash')).toBe(true);
    expect(typeof todo.description === 'object' && JAPANESE.test(todo.description.en)).toBe(false);
    const second = addMissingToTodos(first.next, missing);
    expect(second.added).toBe(0);
    expect(second.next.length).toBe(2);
  });
});
