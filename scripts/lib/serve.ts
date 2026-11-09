/**
 * Minimal static server for a built app folder (FR-128 launch, FR-105 offline package, FR-141 start scripts).
 * Binds to 127.0.0.1 only. No dependencies: this file is copied into offline packages and run with `node serve.ts`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

export interface Served {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export function startServer(dir: string, port = 4180, host = '127.0.0.1'): Promise<Served> {
  const root = resolve(dir);
  if (!existsSync(join(root, 'index.html'))) return Promise.reject(new Error(`No index.html in ${root}. Build first (npm run build, or bas build <customer>).`));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const target = existsSync(file) && statSync(file).isFile() ? file : null;
    if (!target) {
      // The app routes with the URL hash; unknown files are 404 (so data/pack.json falls back to the built-in sample).
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(target).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      ok({ server, url: `http://${host}:${actual}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer(arg('dir', 'app'), Number(arg('port', '4180')))
    .then((s) => console.log(`Business Analytics Studio: ${s.url}  (Ctrl+C to stop)`))
    .catch((e: Error) => {
      console.error(`Could not start: ${e.message}`);
      process.exit(1);
    });
}
