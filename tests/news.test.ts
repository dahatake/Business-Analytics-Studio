// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewsError, NewsService, parseNews } from '../server/news.ts';
import { NEWS_INTERVAL_MS, NEWS_MAX_ITEMS, NewsFeed, NewsRequest } from '../src/data/news.ts';

const item = (title = 'Acme expands', link = 'https://news.google.com/rss/articles/one', date = 'Tue, 10 Nov 2026 10:00:00 GMT') =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><source url="https://publisher.example">Publisher</source></item>`;
const rss = (items: string) => `<rss version="2.0"><channel><title>News search</title>${items}</channel></rss>`;
const response = () => new Response(rss(item()));

afterEach(() => vi.useRealTimers());

describe('news normalization', () => {
  it('extracts metadata, decodes entities, deduplicates URLs/titles and sorts newest first', () => {
    const articles = parseNews(rss(
      item('Acme &amp; partners') +
      item('Duplicate URL') +
      item('Acme &amp; partners', 'https://news.google.com/rss/articles/two') +
      item('Newest', 'https://news.google.com/rss/articles/three', 'Wed, 11 Nov 2026 10:00:00 GMT'),
    ));
    expect(articles).toEqual([
      { title: 'Newest', url: 'https://news.google.com/rss/articles/three', source: 'Publisher', publishedAt: '2026-11-11T10:00:00.000Z' },
      { title: 'Acme & partners', url: 'https://news.google.com/rss/articles/one', source: 'Publisher', publishedAt: '2026-11-10T10:00:00.000Z' },
    ]);
  });

  it('limits the number of articles, supports one article and distinguishes empty from invalid feeds', () => {
    expect(parseNews(rss(Array.from({ length: 20 }, (_, n) => item(`News ${n}`, `https://example.com/${n}`)).join('')))).toHaveLength(NEWS_MAX_ITEMS);
    expect(parseNews(rss(item()))).toHaveLength(1);
    expect(parseNews(rss(''))).toEqual([]);
    for (const xml of ['not xml', '<html>Unavailable</html>', '<rss><channel>', '<!DOCTYPE rss><rss/>', '<!ENTITY x "x"><rss/>']) {
      expect(() => parseNews(xml)).toThrow(NewsError);
    }
  });

  it('rejects unsafe article links and invalid metadata without treating a broken feed as empty', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com']) {
      expect(() => parseNews(rss(item('Unsafe', link)))).toThrow('invalidNewsFeed');
    }
    expect(() => parseNews(rss(item('Bad date', 'https://example.com', 'not a date')))).toThrow('invalidNewsFeed');
    expect(parseNews(rss(item('Unsafe', 'javascript:alert(1)') + item()))).toHaveLength(1);
  });

  it('validates company names, languages and response metadata', () => {
    expect(NewsRequest.safeParse({ company: ' ', lang: 'ja' }).success).toBe(false);
    expect(NewsRequest.safeParse({ company: '"""', lang: 'ja' }).success).toBe(false);
    expect(NewsRequest.safeParse({ company: 'a'.repeat(201), lang: 'ja' }).success).toBe(false);
    expect(NewsRequest.safeParse({ company: 'Acme\ninjected', lang: 'en' }).success).toBe(false);
    expect(NewsRequest.safeParse({ company: 'Acme', lang: 'fr' }).success).toBe(false);
    expect(NewsRequest.safeParse({ company: 'Acme', lang: 'en', endpoint: 'https://example.com' }).success).toBe(false);
  });
});

describe('news retrieval', () => {
  it('uses only the fixed HTTPS host and quoted company search, without project data or redirects', async () => {
    const doFetch = vi.fn<typeof fetch>().mockResolvedValue(response());
    const service = new NewsService(doFetch, () => Date.parse('2026-11-10T12:00:00Z'));
    const feed = await service.get(' Acme & Sons ', 'ja');
    const [target, init] = doFetch.mock.calls[0]!;
    const url = new URL(String(target));
    expect(url.origin).toBe('https://news.google.com');
    expect(url.pathname).toBe('/rss/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: '"Acme & Sons"', hl: 'ja', gl: 'JP', ceid: 'JP:ja' });
    expect(init?.redirect).toBe('error');
    expect(NewsFeed.parse(feed)).toMatchObject({ company: 'Acme & Sons', lang: 'ja', provider: 'Google News RSS' });
  });

  it('coalesces requests, caches for exactly five minutes and isolates company/language', async () => {
    let now = 0;
    const doFetch = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const service = new NewsService(doFetch, () => now);
    await Promise.all([service.get('Acme', 'en'), service.get('Acme', 'en')]);
    expect(doFetch).toHaveBeenCalledTimes(1);
    now = NEWS_INTERVAL_MS - 1;
    await service.get('Acme', 'en');
    expect(doFetch).toHaveBeenCalledTimes(1);
    now++;
    await service.get('Acme', 'en');
    await service.get('Other', 'en');
    await service.get('Acme', 'ja');
    expect(doFetch).toHaveBeenCalledTimes(4);
  });

  it('evicts old cache entries at the bounded capacity', async () => {
    const doFetch = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const service = new NewsService(doFetch);
    for (let n = 0; n < 51; n++) await service.get(`Company ${n}`, 'en');
    await service.get('Company 50', 'en');
    expect(doFetch).toHaveBeenCalledTimes(51);
    await service.get('Company 0', 'en');
    expect(doFetch).toHaveBeenCalledTimes(52);
  });

  it('surfaces provider and parse errors, and does not cache failures', async () => {
    const doFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('<html>bad</html>'))
      .mockResolvedValueOnce(response());
    const service = new NewsService(doFetch);
    await expect(service.get('Acme', 'en')).rejects.toThrow('newsUnavailable');
    await expect(service.get('Acme', 'en')).rejects.toThrow('invalidNewsFeed');
    expect((await service.get('Acme', 'en')).articles).toHaveLength(1);
  });

  it('bounds response size', async () => {
    const service = new NewsService(vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1))));
    await expect(service.get('Acme', 'en')).rejects.toThrow('invalidNewsFeed');
  });

  it('times out a stalled provider and bounds concurrent distinct searches', async () => {
    vi.useFakeTimers();
    const doFetch = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const service = new NewsService(doFetch);
    const pending = Array.from({ length: 10 }, (_, n) => service.get(`Company ${n}`, 'en'));
    const results = Promise.all(pending.map((p) => expect(p).rejects.toThrow('newsTimeout')));
    await expect(service.get('Overflow', 'en')).rejects.toThrow('newsBusy');
    await vi.advanceTimersByTimeAsync(10_000);
    await results;
  });
});
