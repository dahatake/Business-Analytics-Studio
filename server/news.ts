import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { NEWS_INTERVAL_MS, NEWS_MAX_ITEMS, NewsArticle, NewsRequest, type NewsFeed } from '../src/data/news.ts';

export const NEWS_HOST = 'news.google.com';
const MAX_BYTES = 1024 * 1024;
const MAX_CACHE = 50;
const MAX_PENDING = 10;
const TIMEOUT_MS = 10_000;

export class NewsError extends Error {
  readonly code: 'newsUnavailable' | 'invalidNewsFeed' | 'newsTimeout' | 'newsBusy';

  constructor(code: NewsError['code']) {
    super(code);
    this.code = code;
  }
}

const Rss = z.object({
  rss: z.object({ channel: z.object({ item: z.array(z.unknown()).default([]) }) }),
});
const Item = z.object({
  title: z.string(),
  link: z.string(),
  pubDate: z.string(),
  source: z.string(),
});

/** Read metadata only; never render RSS descriptions or fetch article bodies. */
export function parseNews(xml: string): NewsArticle[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new NewsError('invalidNewsFeed');
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (_name, path) => path === 'rss.channel.item',
  });
  const rss = Rss.safeParse(parser.parse(xml));
  if (!rss.success) throw new NewsError('invalidNewsFeed');
  const urls = new Set<string>();
  const titles = new Set<string>();
  const articles: NewsArticle[] = [];
  for (const raw of rss.data.rss.channel.item) {
    const item = Item.safeParse(raw);
    if (!item.success) continue;
    const { title, link, pubDate, source } = item.data;
    const published = Date.parse(pubDate);
    if (!Number.isFinite(published)) continue;
    const article = NewsArticle.safeParse({ title, url: link, source, publishedAt: new Date(published).toISOString() });
    if (!article.success) continue;
    const titleKey = title.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
    if (urls.has(link) || titles.has(titleKey)) continue;
    urls.add(link);
    titles.add(titleKey);
    articles.push(article.data);
  }
  if (rss.data.rss.channel.item.length && !articles.length) throw new NewsError('invalidNewsFeed');
  return articles.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, NEWS_MAX_ITEMS);
}

export class NewsService {
  private readonly cache = new Map<string, NewsFeed>();
  private readonly pending = new Map<string, Promise<NewsFeed>>();
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(doFetch: typeof fetch = fetch, now: () => number = Date.now) {
    this.doFetch = doFetch;
    this.now = now;
  }

  async get(company: string, lang: 'ja' | 'en', topic?: string): Promise<NewsFeed> {
    const input = NewsRequest.parse({ company, lang, ...(topic ? { topic, topicConfirmed: true } : {}) });
    const key = JSON.stringify(input);
    const cached = this.cache.get(key);
    if (cached && this.now() - Date.parse(cached.fetchedAt) < NEWS_INTERVAL_MS) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= MAX_PENDING) throw new NewsError('newsBusy');
    const request = this.retrieve(input.company, input.lang, input.topic);
    this.pending.set(key, request);
    try {
      const feed = await request;
      this.cache.delete(key);
      this.cache.set(key, feed);
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      return feed;
    } finally {
      this.pending.delete(key);
    }
  }

  private async retrieve(company: string, lang: 'ja' | 'en', topic?: string): Promise<NewsFeed> {
    const url = new URL(`https://${NEWS_HOST}/rss/search`);
    url.search = new URLSearchParams({
      q: `"${company.replaceAll('"', ' ')}"${topic ? ` "${topic.replaceAll('"', ' ')}"` : ''}`,
      hl: lang === 'ja' ? 'ja' : 'en-US',
      gl: lang === 'ja' ? 'JP' : 'US',
      ceid: lang === 'ja' ? 'JP:ja' : 'US:en',
    }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.doFetch(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new NewsError('newsUnavailable');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new NewsError('invalidNewsFeed');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const articles = parseNews(Buffer.concat(chunks).toString('utf8'));
      return { company, lang, provider: 'Google News RSS', fetchedAt: new Date(this.now()).toISOString(), articles, ...(topic ? { topic } : {}) };
    } catch (error) {
      if (controller.signal.aborted) throw new NewsError('newsTimeout');
      if (error instanceof NewsError) throw error;
      throw new NewsError('newsUnavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}
