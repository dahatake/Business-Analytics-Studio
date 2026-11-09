import { describe, expect, it } from 'vitest';
import { handleApiRequest, resolveLang } from '../src/api/handler.ts';

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;
const call = (path: string, q: Record<string, string> = {}, accept?: string) => handleApiRequest(path, new URLSearchParams(q), accept);

/** Every string anywhere in a JSON value. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

describe('F-3.5.1 API responses in both languages', () => {
  const endpoints: [string, Record<string, string>][] = [
    ['/api/health', {}],
    ['/api/summary', {}],
    ['/api/kpis', {}],
    ['/api/optimize', { growth: '0.05', carbon: '10000' }],
    ['/api/optimize', { growth: '0.3' }],
    ['/api/nope', {}],
    ['/api/optimize', { growth: 'abc' }],
  ];

  it.each(endpoints)('%s %j answers in Japanese and English', (path, q) => {
    const ja = call(path, { ...q, lang: 'ja' });
    const en = call(path, { ...q, lang: 'en' });
    expect(ja.lang).toBe('ja');
    expect(en.lang).toBe('en');
    expect(ja.status).toBe(en.status);
    const enText = strings(en.body);
    expect(enText.filter((s) => JAPANESE.test(s))).toEqual([]);
    expect(strings(ja.body).some((s) => JAPANESE.test(s))).toBe(true);
  });

  it('localizes errors with the right status codes', () => {
    expect(call('/api/nope', { lang: 'en' }).status).toBe(404);
    const bad = call('/api/optimize', { lang: 'en', growth: '9' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('growth must be a number');
  });

  it('resolves language from the query, then Accept-Language, then defaults to Japanese', () => {
    expect(resolveLang('en', 'ja')).toBe('en');
    expect(resolveLang(null, 'en-US,en;q=0.9')).toBe('en');
    expect(resolveLang(null, 'fr-FR')).toBe('ja');
    expect(resolveLang(null, undefined)).toBe('ja');
  });

  it('hides confidential KPIs and values for an external audience', () => {
    const internal = call('/api/summary', { lang: 'en', audience: 'internal' }).body as { sentences: string[] };
    const external = call('/api/summary', { lang: 'en', audience: 'external' }).body as { sentences: string[] };
    expect(internal.sentences.join(' ')).toMatch(/¥/);
    expect(external.sentences.join(' ')).not.toMatch(/¥28/);
  });
});
