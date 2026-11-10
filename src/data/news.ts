import { z } from 'zod';

export const NEWS_INTERVAL_MS = 5 * 60 * 1000;
export const NEWS_MAX_ITEMS = 10;

export const NewsRequest = z.object({
  company: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/)
    .refine((value) => value.replaceAll('"', ' ').trim().length > 0),
  lang: z.enum(['ja', 'en']),
}).strict();

const ArticleUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
});

export const NewsArticle = z.object({
  title: z.string().min(1).max(1000),
  url: ArticleUrl,
  source: z.string().min(1).max(300),
  publishedAt: z.iso.datetime(),
});

export const NewsFeed = z.object({
  company: z.string(),
  lang: z.enum(['ja', 'en']),
  provider: z.literal('Google News RSS'),
  fetchedAt: z.iso.datetime(),
  articles: z.array(NewsArticle).max(NEWS_MAX_ITEMS),
});

export type NewsArticle = z.infer<typeof NewsArticle>;
export type NewsFeed = z.infer<typeof NewsFeed>;
