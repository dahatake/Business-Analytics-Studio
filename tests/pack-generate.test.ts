// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CopilotError, CopilotService, type CopilotSdk, type SdkSession } from '../server/copilot.ts';
import { decodeHtml, factLinks, fetchSitePages, htmlToText, isPublicAddress, parseSiteUrl, SiteError } from '../server/site.ts';
import { CollectionReport } from '../src/data/collection.ts';
import { verifyPack } from '../src/data/verify.ts';
import {
  applyFix, generatePack, missingRequired, numbersIn, packSpec, PackGenError, pruneInvalid, stageAPrompt, type GenDeps, type PackGenInput, type ProgressEvent,
} from '../src/modules/project/packGenerate.ts';

const NOW = new Date('2026-11-10T03:00:00Z');
const lt = (s: string) => ({ ja: s, en: s });
const base = (id: string, kind: string, world: string, type: string, sourceIds: string[], extra: Record<string, unknown> = {}) => ({
  id, kind, name: lt(id), description: lt(`${id} desc`), world, type, classification: 'shareable', author: 'ai', sourceIds, ...extra,
});

const input = (extra: Partial<PackGenInput> = {}): PackGenInput => ({
  companyName: 'Contoso 製作所', projectName: '納期改善', purpose: '納期遅延を減らす', asOf: '2026-11-10', lang: 'ja',
  industry: '製造', officialUrl: 'https://www.contoso.example', focus: '', researchNote: '',
  materials: [{ name: 'kpi.csv', text: '納期遵守率 baseline 92 current 94 target 98 (%), 2026年度' }],
  useNews: true, ...extra,
});

const stageA = {
  packId: 'contoso-mfg', company: { name: { ja: 'Contoso 製作所', en: 'Contoso Manufacturing' }, industry: lt('製造') }, isSample: false,
  regions: [{ id: 'region-kanto', name: lt('関東') }],
  entities: [
    base('site-tokyo', 'site', 'real', 'site', ['source-web-1'], { role: 'hq', lat: 35.68, lon: 139.76, capacityTPerMonth: 0 }),
    base('product-gear', 'product', 'real', 'thing', ['source-web-1'], { category: lt('部品'), siteId: 'site-tokyo', unitPriceJpy: 12000 }),
    base('person-ceo', 'person', 'real', 'person', ['source-web-1'], { role: lt('社長'), siteId: 'site-tokyo' }),
    // Invented by the model: must be dropped, and what relies on it removed.
    base('source-fake', 'source', 'digital', 'data', [], { publisher: lt('x'), url: 'https://invented.example/', accessedDate: '2026-11-10', origin: 'web' }),
    base('product-ghost', 'product', 'real', 'thing', ['source-fake'], { category: lt('部品'), siteId: 'site-tokyo', unitPriceJpy: 999 }),
  ],
  extensions: { glossary: [{ term: lt('納期'), definition: lt('約束した引き渡し日') }], collection: { bogus: true } },
};
const stageB = {
  entities: [
    base('kpi-otd', 'kpi', 'digital', 'metric', ['source-doc-1'], {
      unit: lt('%'), baseline: 92, current: 94, target: 98, direction: 'increase', scale: 'ratio', period: lt('2026年度'), ownerId: 'person-ceo',
    }),
    base('cause-plan', 'cause', 'real', 'event', ['source-doc-1']),
    base('issue-delay', 'issue', 'real', 'event', ['source-doc-1'], { impact: 4, feasibility: 3, causeIds: ['cause-plan', 'cause-missing'], kpiIds: ['kpi-otd'] }),
    base('initiative-bad', 'initiative', 'real', 'operation', ['source-doc-1'], {
      solutionId: 'solution-missing', start: '2026-12-01', end: '2027-03-31', progress: 0, dependsOn: [], ownerId: 'person-ceo',
    }),
  ],
  gaps: [{ section: 'deal', missing: ['受注台帳'], nextAction: '受注台帳を添付する' }],
};

const sitePage = {
  url: 'https://www.contoso.example/', title: 'Contoso 製作所', description: '精密部品メーカー', themeColor: '#0F6CBD',
  text: '主力製品 ギア 単価 12,000円', fetchedAt: '2026-11-10T02:59:00.000Z',
};

function deps(answers: unknown[], extra: Partial<GenDeps> = {}): GenDeps & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    provider: 'foundry',
    model: 'gpt-test',
    now: () => NOW,
    complete: async (prompt) => {
      prompts.push(prompt);
      const a = answers[Math.min(i++, answers.length - 1)];
      return { text: typeof a === 'string' ? a : JSON.stringify(a), costJpy: 10, inputTokens: 1000, outputTokens: 500 };
    },
    fetchSite: async () => ({ pages: [sitePage], failed: [{ url: 'https://www.contoso.example/ir/', error: 'siteTimeout' }] }),
    fetchNews: async () => ({ provider: 'Google News RSS', fetchedAt: '2026-11-10T02:59:30.000Z', articles: [{ title: 'Contoso が新工場', url: 'https://news.example/a', source: '日刊', publishedAt: '2026-10-01T00:00:00Z' }] }),
    ...extra,
  };
}

describe('FR-311 pack generation (D-12)', () => {
  it('lists missing required fields', () => {
    expect(missingRequired({ companyName: ' ', projectName: 'p', purpose: '', asOf: '2026-13-45x' })).toEqual(['companyName', 'purpose', 'asOf']);
    expect(missingRequired({ companyName: 'a', projectName: 'p', purpose: 'x', asOf: '2026-11-10' })).toEqual([]);
  });

  it('reuses the field specification of the Microsoft 365 prompt and lists only app-made source ids', () => {
    expect(packSpec('ja')).toContain('# パック全体');
    expect(packSpec('ja')).not.toContain('# 届け方');
    expect(packSpec('en')).toContain('# Pack');
    const p = stageAPrompt(input(), []);
    expect(p).toContain('source エンティティと extensions.collection は作らない');
    expect(p).toContain('納期遅延を減らす');
  });

  it('generates, drops invented sources, fixes only failing items, prunes the rest, and the result verifies', async () => {
    const events: ProgressEvent[] = [];
    const d = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }]);
    const r = await generatePack(input(), d, (e) => events.push(e), new AbortController().signal);

    expect(verifyPack(r.pack).ok).toBe(true);
    const ids = (r.pack.entities as { id: string; kind: string }[]).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['source-web-1', 'source-news-1', 'source-doc-1', 'site-tokyo', 'product-gear', 'kpi-otd', 'issue-delay']));
    expect(ids).not.toContain('source-fake');
    expect(ids).not.toContain('product-ghost');
    expect(ids).not.toContain('initiative-bad');
    const issue = (r.pack.entities as Record<string, unknown>[]).find((e) => e.id === 'issue-delay')!;
    expect(issue.causeIds).toEqual(['cause-plan']); // the dangling id is taken out; the valid issue stays
    const web = (r.pack.entities as Record<string, unknown>[]).find((e) => e.id === 'source-web-1')!;
    expect(web).toMatchObject({ url: 'https://www.contoso.example/', accessedDate: '2026-11-10', origin: 'web' });

    expect(r.report.droppedSources).toEqual(['source-fake']);
    expect(r.report.removed.map((x) => x.path)).toContain('entities.product-ghost');
    expect(r.report.fixRounds).toBe(3);
    expect(r.report.calls.map((c) => c.stage)).toEqual(['foundation', 'business', 'fix-1', 'fix-2', 'fix-3']);
    expect(r.report.costJpy).toBe(50);
    expect(r.report.retrievalErrors).toEqual([{ what: 'site', url: 'https://www.contoso.example/ir/', error: 'siteTimeout' }]);
    expect(r.report.ungrounded).toEqual([]); // 12,000 is on the page, 92/94/98 in kpi.csv
    expect(r.report.inputs.materials[0]).toMatchObject({ name: 'kpi.csv', text: expect.stringContaining('納期遵守率') });

    const ext = r.pack.extensions as Record<string, unknown>;
    const collection = CollectionReport.parse(ext.collection);
    expect(collection.webSearch).toBe('searched');
    expect(collection.sections).toHaveLength(24);
    expect(collection.sections.every((s) => s.status !== 'complete')).toBe(true);
    expect(collection.sections.find((s) => s.key === 'deal')).toMatchObject({ status: 'unavailable', missingFields: ['受注台帳'], nextAction: '受注台帳を添付する' });
    // No account from the model: the verifier's required sourced fields are listed instead.
    expect(collection.sections.find((s) => s.key === 'invoice')).toMatchObject({ status: 'unavailable', missingFields: ['amountJpy', 'deliverableId'], nextAction: expect.stringContaining('amountJpy・deliverableId') });
    expect((ext.generation as { provider: string }).provider).toBe('foundry');
    expect(r.pack.isSample).toBe(false);

    expect(d.prompts[0]).toContain('source-web-1');
    expect(d.prompts[0]).toContain('主力製品 ギア 単価 12,000円');
    expect(d.prompts[1]).toContain('site-tokyo'); // stage B sees the foundation ids
    expect(d.prompts[2]).toContain('initiative-bad');
    expect(events.at(-1)).toMatchObject({ step: 'finalize', status: 'done', ratio: 1 });
    expect(events.map((e) => e.ratio)).toEqual([...events.map((e) => e.ratio)].sort((a, b) => a - b));
  });

  it('stops after the stages when the pack already verifies (no fix call)', async () => {
    const clean = { ...stageA, entities: stageA.entities.filter((e) => !['source-fake', 'product-ghost'].includes(e.id)) };
    const d = deps([clean, { entities: [stageB.entities[0], stageB.entities[1]] }]);
    const r = await generatePack(input(), d, () => {}, new AbortController().signal);
    expect(r.report.fixRounds).toBe(0);
    expect(d.prompts).toHaveLength(2);
    expect(r.report.removed).toEqual([]);
  });

  it('reports numbers the cited text does not contain', async () => {
    const odd = { ...stageA, entities: [stageA.entities[0], { ...stageA.entities[1], unitPriceJpy: 34567 }] };
    const r = await generatePack(input(), deps([odd, { entities: [] }]), () => {}, new AbortController().signal);
    expect(r.report.ungrounded).toEqual([{ id: 'product-gear', field: 'unitPriceJpy', value: 34567 }]);
  });

  it('works without public material and records that no web material was requested', async () => {
    const d = deps([{ ...stageA, entities: [base('cause-a', 'cause', 'real', 'event', ['source-doc-1'])] }, { entities: [] }]);
    const r = await generatePack(input({ officialUrl: '', useNews: false }), d, () => {}, new AbortController().signal);
    expect(CollectionReport.parse((r.pack.extensions as Record<string, unknown>).collection).webSearch).toBe('notRequested');
    expect((r.pack.entities as { id: string }[]).map((e) => e.id)).toEqual(['source-doc-1', 'cause-a']);
  });

  it('fails without saving anything when the model gives no JSON, a call fails, or the user cancels', async () => {
    await expect(generatePack(input(), deps(['すみません、作れません']), () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'noAnswer' });
    const failing = deps([stageA], { complete: async () => { throw new Error('relay 503 notSignedIn'); } });
    await expect(generatePack(input(), failing, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'callFailed', detail: 'relay 503 notSignedIn' });
    const ac = new AbortController();
    const slow = deps([stageA], { complete: async () => { ac.abort(); throw new Error('aborted'); } });
    await expect(generatePack(input(), slow, () => {}, ac.signal)).rejects.toBeInstanceOf(PackGenError);
    await expect(generatePack(input(), slow, () => {}, ac.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a fix answer cannot replace app-made sources or the collection report', () => {
    const pack = { entities: [base('source-web-1', 'source', 'digital', 'data', []), base('cause-a', 'cause', 'real', 'event', [])], extensions: { glossary: [] } };
    const next = applyFix(pack, {
      replace: [{ ...base('source-web-1', 'source', 'digital', 'data', []), url: 'https://evil.example' }],
      remove: ['source-web-1', 'cause-a'],
      sections: { extensions: { collection: { x: 1 }, glossary: null }, entities: [] },
    }, new Set(['source-web-1']));
    expect((next.entities as { id: string; url?: string }[])).toEqual([expect.objectContaining({ id: 'source-web-1' })]);
    expect((next.entities as { url?: string }[])[0]!.url).toBeUndefined();
    expect(next.extensions).toEqual({});
  });

  it('prune removes an entity whose required reference is gone, and then what depended on it', () => {
    const pack = {
      packId: 'p', company: { name: lt('c'), industry: lt('i') }, isSample: false, regions: [], flows: [],
      entities: [
        base('source-doc-1', 'source', 'digital', 'data', [], { publisher: lt('c') }),
        base('person-a', 'person', 'real', 'person', ['source-doc-1'], { role: lt('r'), siteId: 'site-missing' }),
        base('kpi-a', 'kpi', 'digital', 'metric', ['source-doc-1'], { unit: lt('%'), baseline: 1, current: 2, target: 3, direction: 'increase', scale: 'ratio', period: lt('y'), ownerId: 'person-a' }),
        base('cause-a', 'cause', 'real', 'event', ['source-doc-1']),
      ],
    };
    const r = pruneInvalid(pack, NOW);
    expect(r.verify.ok).toBe(true);
    expect((r.pack.entities as { id: string }[]).map((e) => e.id)).toEqual(['source-doc-1', 'cause-a']);
    expect(r.removed.map((x) => x.path)).toEqual(['entities.person-a', 'entities.kpi-a']);
  });

  it('reads numbers in Japanese and English notation', () => {
    expect(numbersIn('売上 3.5億円、従業員 1,200 名、12万トン')).toEqual(expect.arrayContaining([350_000_000, 1200, 120_000]));
    expect(numbersIn('revenue 2.4B')).toEqual(expect.arrayContaining([2_400_000_000]));
  });
});

describe('official-site reader guards (server/site.ts)', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const html = (body: string, extra = '') => `<html><head><title>Contoso</title><meta name="description" content="部品 &amp; 装置"><meta name="theme-color" content="#0f6cbd">${extra}</head><body><nav>menu</nav><script>evil()</script>${body}</body></html>`;
  const page = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

  it('accepts https on 443 only, never credentials, IP literals or other ports', () => {
    expect(parseSiteUrl('contoso.example').toString()).toBe('https://contoso.example/');
    for (const bad of ['http://contoso.example', 'https://user:pw@contoso.example', 'https://10.0.0.1/', 'https://contoso.example:8443/', 'file:///etc/passwd', 'https://localhost/']) {
      expect(() => parseSiteUrl(bad), bad).toThrow(SiteError);
    }
  });

  it('classifies private, loopback, link-local and mapped addresses as not public', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });

  it('refuses a host resolving to a private address before any request', async () => {
    let fetched = 0;
    await expect(fetchSitePages('https://intranet.contoso.example', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
      fetch: (async () => { fetched++; return page(''); }) as typeof fetch,
    })).rejects.toMatchObject({ code: 'privateAddress' });
    expect(fetched).toBe(0);
  });

  it('follows same-site redirects only and reads linked company pages', async () => {
    const urls: string[] = [];
    const doFetch = (async (u: URL | string) => {
      const url = String(u);
      urls.push(url);
      if (url === 'https://contoso.example/') return new Response(null, { status: 301, headers: { location: 'https://www.contoso.example/' } });
      if (url === 'https://www.contoso.example/') return page(html('<p>トップ</p><a href="/company/">会社概要</a><a href="https://other.example/about">外部</a><a href="/ir/report.pdf">PDF</a><a href="/news/">ニュース</a>'));
      if (url === 'https://www.contoso.example/company/') return page(html('<h1>会社概要</h1><p>資本金 3.5億円</p>'));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await fetchSitePages('https://contoso.example', { fetch: doFetch, lookup: publicLookup, now: () => NOW.getTime() });
    expect(r.pages.map((p) => p.url)).toEqual(['https://www.contoso.example/', 'https://www.contoso.example/company/']);
    expect(r.pages[0]).toMatchObject({ title: 'Contoso', description: '部品 & 装置', themeColor: '#0F6CBD' });
    expect(r.pages[0]!.text).not.toContain('evil');
    expect(r.pages[0]!.text).not.toContain('menu');
    expect(r.pages[1]!.text).toContain('資本金 3.5億円');
    expect(urls.some((u) => u.includes('other.example') || u.endsWith('.pdf') || u.includes('/news/'))).toBe(false);

    const offSite = (async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } })) as unknown as typeof fetch;
    await expect(fetchSitePages('https://contoso.example', { fetch: offSite, lookup: publicLookup })).rejects.toMatchObject({ code: 'redirectNotAllowed' });
    const notHtml = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(fetchSitePages('https://contoso.example', { fetch: notHtml, lookup: publicLookup })).rejects.toMatchObject({ code: 'notHtml' });
  });

  it('the entry page may move to another public host (domain change); linked pages may not leave it; private targets stay blocked', async () => {
    const lookup = async (h: string) => [{ address: h === 'internal.contoso.example' ? '10.0.0.8' : '93.184.216.34', family: 4 }];
    const moved = (async (u: URL | string) => {
      const url = String(u);
      if (url === 'https://www.contoso.co.example/') return new Response(null, { status: 302, headers: { location: 'https://www.contoso.example/ja/' } });
      if (url === 'https://www.contoso.example/ja/') return page(html('<a href="/ja/company/profile/">概要</a>'));
      if (url === 'https://www.contoso.example/ja/company/profile/') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await fetchSitePages('https://www.contoso.co.example/', { fetch: moved, lookup });
    expect(r.pages.map((p) => p.url)).toEqual(['https://www.contoso.example/ja/']);
    expect(r.failed[0]).toEqual({ url: 'https://www.contoso.example/ja/company/profile/', error: 'redirectNotAllowed' });
    const toInternal = (async () => new Response(null, { status: 302, headers: { location: 'https://internal.contoso.example/' } })) as unknown as typeof fetch;
    await expect(fetchSitePages('https://www.contoso.co.example/', { fetch: toInternal, lookup })).rejects.toMatchObject({ code: 'privateAddress' });
    await expect(fetchSitePages('https://www.contoso.co.example/', { fetch: moved, lookup, outboundHosts: ['www.contoso.co.example'] })).rejects.toMatchObject({ code: 'outboundNotAllowed' });
  });

  it('ranks profile and IR pages first, tries well-known paths when the menu is not in the HTML, and drops tracking parameters', async () => {
    expect(factLinks('<a href="/sustainability/?padid=1">s</a><a href="/ir/">ir</a><a href="/company/profile/?utm_source=x">p</a>', new URL('https://contoso.example/'), 5))
      .toEqual(['https://contoso.example/company/profile/', 'https://contoso.example/ir/', 'https://contoso.example/sustainability/']);
    const urls: string[] = [];
    const jsMenu = (async (u: URL | string) => {
      urls.push(String(u));
      if (String(u) === 'https://contoso.example/jp/') return page(html('<div id="menu"></div>'));
      if (String(u) === 'https://contoso.example/jp/company/profile/') return page(html('<p>本社 東京都</p>'));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await fetchSitePages('https://contoso.example/jp/', { fetch: jsMenu, lookup: publicLookup });
    expect(r.pages.map((p) => p.url)).toEqual(['https://contoso.example/jp/', 'https://contoso.example/jp/company/profile/']);
    expect(urls.length).toBeLessThanOrEqual(1 + 10);
  });

  it('reads detail pages found on hubs, sites before officers, and spreads the pages over sections', async () => {
    const site: Record<string, string> = {
      'https://contoso.example/': '<a href="/company/">c</a><a href="/sustainability/">s</a>',
      'https://contoso.example/company/': '<a href="/company/facilities/">f</a><a href="/company/executives/a.html">a</a><a href="/company/executives/b.html">b</a><a href="/company/executives/c.html">c</a>',
      'https://contoso.example/company/facilities/': '<p>本社 東京 工場 名古屋</p>',
    };
    const doFetch = (async (u: URL | string) => (site[String(u)] !== undefined ? page(html(site[String(u)]!)) : page(html('<p>x</p>')))) as typeof fetch;
    const r = await fetchSitePages('https://contoso.example/', { fetch: doFetch, lookup: publicLookup });
    const read = r.pages.map((p) => p.url);
    expect(read.indexOf('https://contoso.example/company/facilities/')).toBeGreaterThan(0);
    expect(read.indexOf('https://contoso.example/company/facilities/')).toBeLessThan(read.findIndex((u) => u.includes('/executives/')) >>> 0);
    expect(read.filter((u) => u.includes('/executives/')).length).toBeLessThanOrEqual(2);
    expect(read).toHaveLength(6);
  });

  it('extracts text and fact links deterministically', () => {
    expect(htmlToText('<title>A &amp; B</title><style>x{}</style><p>こんにちは&#x3002;</p>')).toMatchObject({ title: 'A & B', text: 'こんにちは。' });
    expect(factLinks('<a href="/about">a</a><a href="/about/history/">h</a><a href="mailto:x@y">m</a>', new URL('https://contoso.example/'), 4))
      .toEqual(['https://contoso.example/about', 'https://contoso.example/about/history/']);
  });
});

describe('GitHub Copilot adapter (server/copilot.ts)', () => {
  function fakeSdk(opts: { signedIn?: boolean; answer?: string; usage?: Record<string, unknown>[]; hang?: boolean } = {}) {
    const created: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    let aborted = 0;
    class Client {
      constructor(public options: Record<string, unknown>) {}
      async start() {}
      async stop() { return []; }
      async getAuthStatus() { return { isAuthenticated: opts.signedIn ?? true, login: 'octocat' }; }
      async listModels() { return [{ id: 'gpt-5', name: 'GPT-5', billing: { multiplier: 1 } }, { id: 'claude-opus', name: 'Opus', billing: { multiplier: 10 } }]; }
      async createSession(config: Record<string, unknown>): Promise<SdkSession> {
        created.push(config);
        const handlers: ((e: { data: Record<string, unknown> }) => void)[] = [];
        return {
          sessionId: `s${created.length}`,
          on: (_t, h) => { handlers.push(h); return () => {}; },
          sendAndWait: async () => {
            if (opts.hang) await new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 10ms')), 10));
            for (const u of opts.usage ?? []) handlers.forEach((h) => h({ data: u }));
            return { data: { content: opts.answer ?? '{"ok":true}' } };
          },
          abort: async () => { aborted++; },
          disconnect: async () => {},
        };
      }
      async deleteSession(id: string) { deleted.push(id); }
    }
    return { sdk: { CopilotClient: Client } as unknown as CopilotSdk, created, deleted, get aborted() { return aborted; } };
  }

  it('reports sign-in and models', async () => {
    const f = fakeSdk();
    expect(await new CopilotService(async () => f.sdk).status()).toEqual({
      available: true, authenticated: true, login: 'octocat', models: [{ id: 'gpt-5', name: 'GPT-5', multiplier: 1 }, { id: 'claude-opus', name: 'Opus', multiplier: 10 }],
    });
    expect(await new CopilotService(async () => { throw new Error('no module'); }).status()).toMatchObject({ available: false, error: 'sdkUnavailable' });
    expect(await new CopilotService(async () => fakeSdk({ signedIn: false }).sdk).status()).toMatchObject({ authenticated: false, error: 'notSignedIn' });
  });

  it('runs a tool-less session with the given system prompt, counts premium requests and deletes the session', async () => {
    const f = fakeSdk({ usage: [{ inputTokens: 100, outputTokens: 50, cost: 10 }] });
    const r = await new CopilotService(async () => f.sdk).complete({ model: 'claude-opus', system: 'SYS', prompt: 'P', timeoutMs: 1000 });
    expect(r).toEqual({ text: '{"ok":true}', inputTokens: 100, outputTokens: 50, premiumRequests: 10 });
    expect(f.created[0]).toMatchObject({ model: 'claude-opus', availableTools: [], systemMessage: { mode: 'replace', content: 'SYS' }, enableSessionStore: false });
    const permission = (f.created[0]!.onPermissionRequest as () => { kind: string })();
    expect(permission.kind).toBe('reject');
    expect(f.deleted).toEqual(['s1']);
  });

  it('falls back to the model multiplier when no cost is reported, and maps failures', async () => {
    const f = fakeSdk({ usage: [{ inputTokens: 1, outputTokens: 1 }] });
    expect((await new CopilotService(async () => f.sdk).complete({ model: 'claude-opus', system: 'S', prompt: 'P', timeoutMs: 1000 })).premiumRequests).toBe(10);
    await expect(new CopilotService(async () => fakeSdk({ signedIn: false }).sdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000 }))
      .rejects.toEqual(new CopilotError('notSignedIn'));
    await expect(new CopilotService(async () => fakeSdk().sdk).complete({ model: 'nope', system: 'S', prompt: 'P', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'unknownModel' });
    const slow = fakeSdk({ hang: true });
    await expect(new CopilotService(async () => slow.sdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    expect(slow.aborted).toBe(1);
    expect(slow.deleted).toEqual(['s1']);
    await expect(new CopilotService(async () => fakeSdk({ answer: ' ' }).sdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'emptyAnswer' });
  });
});

describe('D-12 review fixes', () => {
  const NOW2 = new Date('2026-11-10T03:00:00Z');
  const l = (s: string) => ({ ja: s, en: s });
  const ent = (id: string, kind: string, world: string, type: string, sourceIds: string[], extra: Record<string, unknown> = {}) => ({
    id, kind, name: l(id), description: l(id), world, type, classification: 'shareable', author: 'ai', sourceIds, ...extra,
  });
  const shell = (entities: unknown[]) => ({ packId: 'p', company: { name: l('c'), industry: l('i') }, isSample: false, regions: [], flows: [], entities });

  it('prune removes every bad reference of one list at once and keeps the valid ones (no index shift)', () => {
    const src = ent('source-web-1', 'source', 'digital', 'data', [], { publisher: l('p') });
    for (const order of [['source-web-1', 'x', 'y'], ['x', 'y', 'source-web-1'], ['x', 'source-web-1', 'y']]) {
      const r = pruneInvalid(shell([src, ent('cause-a', 'cause', 'real', 'event', order)]), NOW2);
      expect(r.verify.ok, order.join(',')).toBe(true);
      expect((r.pack.entities as { id: string; sourceIds: string[] }[]).find((e) => e.id === 'cause-a')?.sourceIds).toEqual(['source-web-1']);
    }
  });

  it('Copilot: a cancel while the session is being created sends nothing', async () => {
    const ac = new AbortController();
    let sent = 0;
    let deleted = 0;
    class Client {
      async start() {}
      async stop() { return []; }
      async getAuthStatus() { return { isAuthenticated: true }; }
      async listModels() { return [{ id: 'gpt-5', name: 'GPT-5' }]; }
      async createSession(): Promise<SdkSession> {
        ac.abort();
        return { sessionId: 's1', on: () => () => {}, sendAndWait: async () => { sent++; return { data: { content: '{}' } }; }, abort: async () => {}, disconnect: async () => {} };
      }
      async deleteSession() { deleted++; }
    }
    await expect(new CopilotService(async () => ({ CopilotClient: Client }) as unknown as CopilotSdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000, signal: ac.signal }))
      .rejects.toMatchObject({ code: 'aborted' });
    expect(sent).toBe(0);
    expect(deleted).toBe(1);
  });

  it('site: links to other ports or with credentials are never followed; Shift_JIS pages are decoded', async () => {
    expect(factLinks('<a href="https://contoso.example:8443/company/">p</a><a href="https://u:p@contoso.example/about/">c</a><a href="/ir/">ir</a>', new URL('https://contoso.example/'), 5))
      .toEqual(['https://contoso.example/ir/']);
    const sjis = new Uint8Array([0x89, 0xef, 0x8e, 0xd0, 0x8a, 0x54, 0x97, 0x76]); // 会社概要
    expect(decodeHtml(sjis, 'text/html; charset=Shift_JIS')).toBe('会社概要');
    const meta = Buffer.concat([Buffer.from('<meta charset="shift_jis"><p>'), Buffer.from(sjis)]);
    expect(decodeHtml(meta, 'text/html')).toContain('会社概要');
    expect(decodeHtml(Buffer.from('日本'), 'text/html; charset=bogus-label')).toBe('日本');
  });
});
