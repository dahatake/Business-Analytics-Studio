import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Public-web material for customer pack generation (FR-311, D-12): a few pages of the company's official site, fetched by
 * the relay so the model reads real text with real URLs instead of recalling them. Only public inputs reach the network
 * (the URL the user typed and links found on that site); nothing from the app is sent.
 *
 * SSRF guards: https on port 443 only, no credentials; every hostname must resolve to public addresses only; same-host
 * redirects only (re-checked); text/html only; size, time and page caps. A DNS answer that changes between the check and
 * the connection (rebinding) is not fully excluded; the relay only serves this PC (C-01) and the caps bound the impact.
 */

export interface SitePage {
  url: string;
  title: string;
  description: string;
  /** `<meta name="theme-color">`, a brand colour hint. */
  themeColor: string | null;
  text: string;
  fetchedAt: string;
}

export type SiteErrorCode = 'invalidUrl' | 'privateAddress' | 'siteUnavailable' | 'siteTimeout' | 'notHtml' | 'tooLarge' | 'redirectNotAllowed' | 'outboundNotAllowed';

export class SiteError extends Error {
  readonly code: SiteErrorCode;

  constructor(code: SiteErrorCode) {
    super(code);
    this.code = code;
  }
}

/** PARAM-145 (D-12): pages read per run (the entry page + company, IR and detail pages found from it). */
export const SITE_MAX_PAGES = 6;
const MAX_BYTES = 1_500_000;
const PAGE_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 6_000;
const MAX_REDIRECTS = 3;

/**
 * Pages that usually hold company facts, most valuable first. Tier 0 are detail pages (outline, sites, figures,
 * data) that state HQ, plants and numbers; tier 1 the company/profile hubs that link them; then IR, business,
 * history and sustainability.
 */
const FACT_TIERS: RegExp[] = [
  /(overview|outline|gaiyo|gaiyou|facilities|locations?|jigyosho|kyoten|plants?|factor(y|ies)|kojo|offices?|figures|facts?|data)(\/|\.html?|$)/i,
  /(about|company|corporate|profile|kaisha|kigyo|kigyou|summary|information)/i,
  /(^|\/)(ir|investors?)(\/|$)|investor/i,
  /(business|jigyo|products?|solutions?|services?|network)/i,
  /(history|enkaku|message|philosophy|vision|brand|executives?|officers?|yakuin)/i,
  /(sustainability|csr|esg)/i,
];
/** Query parameters that only track clicks: dropped so the same page is read once. */
const TRACKING_PARAM = /^(padid|utm_[a-z]+|gclid|fbclid|ref|from|cid|_ga)$/i;

type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SiteDeps {
  fetch?: typeof fetch;
  lookup?: Lookup;
  now?: () => number;
  /** BAS_RELAY_OUTBOUND_HOSTS: when set, the host must be listed. */
  outboundHosts?: string[] | null;
}

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Loopback, private, link-local, CGNAT, multicast, reserved, documentation and unspecified ranges are not public. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(Number(address.split('.')[2]))))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && address.split('.')[2] === '100'))) return false;
    if (a === 203 && b === 0 && address.split('.')[2] === '113') return false;
    return true;
  }
  if (v === 6) {
    const s = address.toLowerCase();
    if (s === '::' || s === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^(fc|fd|fe[89ab]|ff)/.test(s)) return false;
    if (s.startsWith('2001:db8') || s.startsWith('64:ff9b') || s.startsWith('100:')) return false;
    return true;
  }
  return false;
}

/** Validates the URL the user typed (https, default port, no credentials). A bare domain gets https://. */
export function parseSiteUrl(raw: string): URL {
  const s = raw.trim();
  if (!s || s.length > 2048) throw new SiteError('invalidUrl');
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    throw new SiteError('invalidUrl');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port !== '' && u.port !== '443')) throw new SiteError('invalidUrl');
  if (isIP(u.hostname.replace(/^\[|\]$/g, '')) || !u.hostname.includes('.')) throw new SiteError('invalidUrl');
  u.hash = '';
  return u;
}

async function assertPublicHost(hostname: string, lookup: Lookup) {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new SiteError('siteUnavailable');
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new SiteError('privateAddress');
}

const sameSite = (a: string, b: string) => a === b || a.replace(/^www\./, '') === b.replace(/^www\./, '');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined) ?? null;

function meta(html: string, key: string): string {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if ((attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase() === key) return decode(attr(tag, 'content') ?? '').trim();
  }
  return '';
}

/** Readable text of a page: scripts, styles, navigation chrome and tags removed, whitespace collapsed. */
export function htmlToText(html: string): { title: string; description: string; themeColor: string | null; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const description = meta(html, 'description') || meta(html, 'og:description');
  const theme = meta(html, 'theme-color');
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|title|script|style|noscript|svg|template|iframe|nav|footer|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article|dt|dd|th|td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(body).split('\n').map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title, description, themeColor: /^#[0-9a-f]{6}$/i.test(theme) ? theme.toUpperCase() : null, text: text.slice(0, MAX_TEXT_CHARS) };
}

/** Same-site links whose path looks like company facts, by fact value then depth, tracking parameters removed. */
export function factLinks(html: string, base: URL, limit: number): string[] {
  return rankedLinks(html, base).map(([u]) => u).slice(0, limit);
}

const tierOf = (u: string) => FACT_TIERS.findIndex((re) => re.test(new URL(u).pathname));
/** The section a page sits in: '/a/b/' and '/a/b.html' are both in '/a/'. */
const sectionOf = (u: string) => new URL(u).pathname.replace(/\/$/, '').replace(/[^/]*$/, '');

function rankedLinks(html: string, base: URL): [string, number][] {
  const found = new Map<string, number>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi)) {
    const href = decode(m[2] ?? m[3] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port !== '' && u.port !== '443') || !sameSite(u.hostname, base.hostname) || /\.(pdf|zip|jpe?g|png|gif|svg|mp4|xlsx?|docx?|pptx?)$/i.test(u.pathname)) continue;
    const tier = FACT_TIERS.findIndex((re) => re.test(u.pathname));
    if (tier < 0) continue;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    const key = u.toString();
    if (key !== base.toString() && !found.has(key)) found.set(key, tier);
  }
  const depth = (s: string) => new URL(s).pathname.split('/').filter(Boolean).length;
  return [...found].sort((a, b) => a[1] - b[1] || depth(a[0]) - depth(b[0]));
}

/**
 * Decodes a page with its declared charset: the Content-Type header, else `<meta charset>` / `http-equiv` in the first
 * bytes (many Japanese corporate sites still use Shift_JIS or EUC-JP). Unknown labels fall back to UTF-8.
 */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta]) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase()).decode(bytes);
    } catch {
      // unknown label: try the next one
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * One page. Each hop is checked for public addresses. The entry page may follow a redirect to another public host (a
 * company that moved domains, e.g. .co.jp → .com); every other page must stay on the site the entry page ended on.
 */
async function fetchPage(start: URL, deps: Required<Pick<SiteDeps, 'fetch' | 'lookup'>> & { outboundHosts: string[] | null }, origin: URL | null): Promise<{ url: URL; html: string }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every request, not only the entry URL: https on 443, no credentials, no IP-literal host.
    if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443') || isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new SiteError(hop === 0 ? 'invalidUrl' : 'redirectNotAllowed');
    }
    await assertPublicHost(url.hostname, deps.lookup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await deps.fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'BusinessAnalyticsStudio/0.1 (+customer-pack research)' },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location) throw new SiteError('siteUnavailable');
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || next.username || next.password || (next.port !== '' && next.port !== '443') || isIP(next.hostname.replace(/^\[|\]$/g, ''))
          || (origin !== null && !sameSite(next.hostname, origin.hostname))) {
          throw new SiteError('redirectNotAllowed');
        }
        if (deps.outboundHosts && !deps.outboundHosts.some((h) => sameSite(h, next.hostname.toLowerCase()))) throw new SiteError('outboundNotAllowed');
        url = next;
        continue;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new SiteError('siteUnavailable');
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(res.headers.get('content-type') ?? '')) {
        await res.body.cancel().catch(() => undefined);
        throw new SiteError('notHtml');
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new SiteError('tooLarge');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return { url, html: decodeHtml(Buffer.concat(chunks), res.headers.get('content-type')) };
    } catch (err) {
      if (err instanceof SiteError) throw err;
      throw new SiteError(controller.signal.aborted ? 'siteTimeout' : 'siteUnavailable');
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SiteError('redirectNotAllowed');
}

/** Well-known fact pages tried when the entry page's HTML does not link them (menus built by JavaScript). */
const GUESSED_PATHS = ['company/profile/', 'company/', 'corporate/', 'about/', 'ir/'];
/** PARAM-145: fetch attempts per run (pages that fail do not count toward SITE_MAX_PAGES). */
const MAX_ATTEMPTS = 10;

/**
 * Best-first reading of the official site: the entry page (must succeed), then the most fact-dense candidate each time
 * (detail pages before hubs, hubs before IR/business/history/sustainability). Links found on every page read join the
 * candidates, so details one level below a hub (e.g. company/profile/facilities/) are reached.
 */
export async function fetchSitePages(rawUrl: string, deps: SiteDeps = {}): Promise<{ pages: SitePage[]; failed: { url: string; error: SiteErrorCode }[] }> {
  const start = parseSiteUrl(rawUrl);
  const outboundHosts = deps.outboundHosts ?? null;
  if (outboundHosts && !outboundHosts.some((h) => sameSite(h, start.hostname.toLowerCase()))) throw new SiteError('outboundNotAllowed');
  const d = { fetch: deps.fetch ?? fetch, lookup: deps.lookup ?? defaultLookup, outboundHosts };
  const now = deps.now ?? Date.now;
  const first = await fetchPage(start, d, null);
  const site = first.url;
  const pages: SitePage[] = [{ url: site.toString(), ...htmlToText(first.html), fetchedAt: new Date(now()).toISOString() }];
  const failed: { url: string; error: SiteErrorCode }[] = [];
  const seen = new Set<string>([site.toString(), start.toString()]);
  const queue = new Map<string, number>();
  const add = (url: string, score: number) => {
    if (!seen.has(url) && (!queue.has(url) || queue.get(url)! > score)) queue.set(url, score);
  };
  for (const [u, tier] of rankedLinks(first.html, site)) add(u, tier);
  // Guesses rank with the hubs; a real link to the same page keeps its own (possibly better) rank.
  for (const p of GUESSED_PATHS) add(new URL(p, new URL('./', site)).toString(), 1.5);
  const depth = (s: string) => new URL(s).pathname.split('/').filter(Boolean).length;
  // Spread the few pages over different sections: each page already read in the same section costs a tier; news costs two.
  const effective = (u: string, score: number) =>
    score + pages.filter((p) => sectionOf(p.url) === sectionOf(u)).length + (/\/news(room)?\//i.test(new URL(u).pathname) ? 2 : 0);
  let attempts = 0;
  while (pages.length < SITE_MAX_PAGES && attempts < MAX_ATTEMPTS && queue.size > 0) {
    const [next] = [...queue].map(([u, s]) => [u, effective(u, s)] as [string, number]).sort((a, b) => a[1] - b[1] || depth(a[0]) - depth(b[0]))[0]!;
    queue.delete(next);
    seen.add(next);
    attempts++;
    try {
      const page = await fetchPage(new URL(next), d, site);
      const url = page.url.toString();
      seen.add(url);
      if (pages.some((p) => p.url === url)) continue;
      pages.push({ url, ...htmlToText(page.html), fetchedAt: new Date(now()).toISOString() });
      for (const [u, tier] of rankedLinks(page.html, page.url)) add(u, tier);
    } catch (err) {
      failed.push({ url: next, error: err instanceof SiteError ? err.code : 'siteUnavailable' });
    }
  }
  return { pages, failed };
}

export { tierOf as factTier };