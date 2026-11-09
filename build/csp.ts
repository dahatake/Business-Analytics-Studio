import type { Plugin } from 'vite';

/**
 * Content Security Policy (D-5, approved by the user 2026-11-09; proposal P-05 ⑥ plus the two required exceptions).
 * - style-src 'unsafe-inline': Fluent UI (Griffel) inserts <style> elements and React sets style attributes.
 * - img-src data: blob:: ink PNG export, illustrations and recorded/exported files.
 * No external origins: the map uses bundled TopoJSON and all AI traffic goes through the same-origin relay.
 *
 * For an Azure deployment, BAS_CSP_CONNECT_SRC may add exact origins (comma-separated, https only, no wildcards).
 */
export interface CspOptions {
  extraConnectSrc?: string[];
}

export function parseConnectSrc(raw: string | undefined): string[] {
  if (!raw) return [];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const origin of list) {
    if (origin.includes('*')) throw new Error(`BAS_CSP_CONNECT_SRC: wildcards are not allowed (${origin})`);
    const u = new URL(origin);
    if (u.protocol !== 'https:' || u.origin !== origin) throw new Error(`BAS_CSP_CONNECT_SRC: use exact https origins (${origin})`);
  }
  return list;
}

export function buildCsp(opts: CspOptions = {}, forHeader = false): string {
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    ['media-src', ["'self'", 'blob:']],
    ['connect-src', ["'self'", ...(opts.extraConnectSrc ?? [])]],
    ['worker-src', ["'self'", 'blob:']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
  ];
  // frame-ancestors is ignored in <meta>, so it is only sent as a header.
  if (forHeader) directives.push(['frame-ancestors', ["'none'"]]);
  return directives.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/** Adds the CSP to the production build (meta tag) and to the preview server (header). The dev server is left alone (HMR). */
export function cspPlugin(env: Record<string, string | undefined> = process.env): Plugin {
  const opts: CspOptions = { extraConnectSrc: parseConnectSrc(env.BAS_CSP_CONNECT_SRC) };
  return {
    name: 'bas-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.server) return html;
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${buildCsp(opts)}" />`);
      },
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', buildCsp(opts, true));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
      });
    },
  };
}
