/**
 * FR-373: production entry of the portable package (`runtime/node server/main.mjs`). It serves the built app, the relay,
 * device storage and the local API on 127.0.0.1 from one process, keeps all data outside the extracted folder and
 * applies the customer's proxy and certificates (FR-372) before any outbound call.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildCsp, parseConnectSrc } from '../build/csp.ts';
import { createDeviceService } from '../scripts/lib/device.ts';
import { serveStatic } from '../scripts/lib/serve.ts';
import { handleApiRequest } from '../src/api/handler.ts';
import { describeNetwork } from './network.ts';
import { newRelayToken, relayConfigFromEnv, relayMiddleware, startNetwork } from './relay.ts';
import { SecretVault } from './vault.ts';

export const APP_ID = 'business-analytics-studio';
export const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 4300 + i);
const INSTANCE_FILE = 'instance.json';
export const NETWORK_FILE = 'network.json';

export interface LaunchOptions {
  appDir: string;
  dataDir: string;
  /** True when the folder was given explicitly; Settings then cannot move it (as BAS_DEVICE_DIR in the dev server). */
  dataDirFixed: boolean;
  ports: number[];
  open: boolean;
  networkFiles: string[];
}

export class LaunchError extends Error {}

/** Per-user data folder, never inside the extracted package: a new version can replace the folder without losing data. */
export function defaultDataDir(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'BusinessAnalyticsStudio');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'BusinessAnalyticsStudio');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'BusinessAnalyticsStudio');
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env, mainDir = dirname(resolve(process.argv[1] ?? '.'))): LaunchOptions | 'help' {
  const root = resolve(mainDir, '..');
  let appDir = env.BAS_APP_DIR ? resolve(env.BAS_APP_DIR) : join(root, 'app');
  let dataDir = env.BAS_DATA_DIR ? resolve(env.BAS_DATA_DIR) : null;
  let ports = DEFAULT_PORTS;
  let open = env.BAS_NO_OPEN !== '1';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new LaunchError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--help' || arg === '-h') return 'help';
    else if (arg === '--no-open') open = false;
    else if (arg === '--app-dir') appDir = resolve(value());
    else if (arg === '--data-dir') dataDir = resolve(value());
    else if (arg === '--port') {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new LaunchError('--port must be 0-65535');
      ports = [port];
    } else throw new LaunchError(`unknown option ${arg}`);
  }
  const resolvedData = dataDir ?? defaultDataDir(env);
  return { appDir, dataDir: resolvedData, dataDirFixed: dataDir !== null, ports, open, networkFiles: [join(root, NETWORK_FILE), join(resolvedData, NETWORK_FILE)] };
}

const NETWORK_KEYS = { proxy: 'BAS_PROXY', pacUrl: 'BAS_PAC_URL', noProxy: 'BAS_NO_PROXY', systemCa: 'BAS_SYSTEM_CA' } as const;

/**
 * Reads `network.json` (next to the launcher for an IT-distributed setting, else in the data folder) into BAS_* variables.
 * Variables already set win, so a one-off `set BAS_PROXY=...` still overrides the file.
 */
export function applyNetworkFile(files: string[], env: Record<string, string | undefined> = process.env): string | null {
  const file = files.find((f) => existsSync(f));
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new LaunchError(`${file}: not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LaunchError(`${file}: expected an object`);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith('$') || key.startsWith('_')) continue;
    if (!Object.hasOwn(NETWORK_KEYS, key)) throw new LaunchError(`${file}: unknown key "${key}" (use ${Object.keys(NETWORK_KEYS).join(', ')})`);
    const name = NETWORK_KEYS[key as keyof typeof NETWORK_KEYS];
    let text: string;
    if (key === 'systemCa') {
      if (typeof value !== 'boolean') throw new LaunchError(`${file}: "systemCa" must be true or false`);
      text = value ? '1' : '0';
    } else if (key === 'noProxy' && Array.isArray(value) && value.every((v) => typeof v === 'string')) text = value.join(',');
    else if (typeof value === 'string') text = value;
    else throw new LaunchError(`${file}: "${key}" must be a string`);
    if (env[name] === undefined || env[name] === '') env[name] = text;
  }
  return file;
}

interface Instance { pid: number; port: number; id: string }

async function probe(port: number, id: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    const body = await r.json() as { app?: unknown; id?: unknown };
    return body.app === APP_ID && body.id === id;
  } catch {
    return false;
  }
}

/** The URL of a BAS already running for this data folder, so a second double-click reuses it instead of a second writer. */
export async function runningInstance(dataDir: string): Promise<string | null> {
  const file = join(dataDir, INSTANCE_FILE);
  if (!existsSync(file)) return null;
  try {
    const inst = JSON.parse(readFileSync(file, 'utf8')) as Instance;
    if (Number.isInteger(inst.port) && typeof inst.id === 'string' && await probe(inst.port, inst.id)) return `http://127.0.0.1:${inst.port}/`;
  } catch { /* stale or broken file: start a new instance */ }
  return null;
}

function listen(server: Server, ports: number[]): Promise<number> {
  return new Promise((done, fail) => {
    const tryAt = (i: number) => {
      const port = ports[i]!;
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && i + 1 < ports.length) tryAt(i + 1);
        else fail(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        done(typeof address === 'object' && address ? address.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryAt(0);
  });
}

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] = platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* the URL is printed as well */ }
}

function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith('/api/')) return next();
  const url = new URL(req.url, 'http://127.0.0.1');
  const result = handleApiRequest(url.pathname, url.searchParams, req.headers['accept-language']);
  res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Language': result.lang, 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result.body));
}

export interface Running {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

/** Starts everything; the caller owns the process (signals, exit). Tests call this with a temp folder and port 0. */
export async function startApp(opts: LaunchOptions, env: Record<string, string | undefined> = process.env, log: (line: string) => void = console.log): Promise<Running | { reused: string }> {
  if (!existsSync(join(opts.appDir, 'index.html'))) throw new LaunchError(`app not found: ${opts.appDir}`);
  mkdirSync(opts.dataDir, { recursive: true });
  const reused = await runningInstance(opts.dataDir);
  if (reused) return { reused };

  const config = relayConfigFromEnv(env);
  const csp = buildCsp({ extraConnectSrc: parseConnectSrc(env.BAS_CSP_CONNECT_SRC) }, true);
  const network = await startNetwork(opts.dataDir, env, (line) => log(line));
  const vault = new SecretVault(opts.dataDir);
  const relay = relayMiddleware(vault, newRelayToken(), config);
  const device = createDeviceService(opts.dataDir, false, { servedRoots: [opts.appDir], fixed: opts.dataDirFixed });
  const id = randomBytes(16).toString('hex');

  const server = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ app: APP_ID, id }));
      return;
    }
    relay(req, res, () => device.handle(req, res, () => apiMiddleware(req, res, () => serveStatic(opts.appDir, req, res))));
  });
  // Long AI drafts run up to 300 s (D-41); Node's default request timeout would cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  const port = await listen(server, opts.ports);
  const instanceFile = join(opts.dataDir, INSTANCE_FILE);
  writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, port, id } satisfies Instance));
  const url = `http://127.0.0.1:${port}/`;
  log(`Business Analytics Studio: ${url}`);
  log(`  データ / data: ${opts.dataDir}`);
  log(`  ネットワーク / network: ${describeNetwork(network)}`);
  let closed = false;
  const close = () => new Promise<void>((done) => {
    if (closed) return done();
    closed = true;
    try {
      const inst = JSON.parse(readFileSync(instanceFile, 'utf8')) as Instance;
      if (inst.id === id) rmSync(instanceFile, { force: true });
    } catch { /* already gone */ }
    device.close();
    server.closeAllConnections();
    server.close(() => done());
  });
  return { url, port, server, close };
}

const HELP = `Business Analytics Studio
  start.cmd / start.command / start.sh [options]
  --data-dir <folder>  データの保存先 / data folder (default: ${defaultDataDir()})
  --port <n>           待ち受けポート / port (default: 4300-4309, then any free port)
  --no-open            ブラウザーを開かない / do not open the browser
  --app-dir <folder>   アプリの場所 / built app folder (default: ../app)
Network: network.json next to start.cmd or in the data folder, or BAS_PROXY / BAS_PAC_URL / BAS_NO_PROXY / BAS_SYSTEM_CA / HTTPS_PROXY.`;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === 'help') {
    console.log(HELP);
    return;
  }
  const file = applyNetworkFile(opts.networkFiles);
  if (file) console.log(`  network.json: ${file}`);
  const started = await startApp(opts);
  if ('reused' in started) {
    console.log(`Business Analytics Studio は起動済みです / already running: ${started.reused}`);
    if (opts.open) openBrowser(started.reused);
    return;
  }
  console.log('  このウィンドウを閉じると終了します / Close this window (or press Ctrl+C) to stop.');
  if (opts.open) openBrowser(started.url);
  const stop = () => void started.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (/[\\/]server[\\/]main\.(m?js|ts)$/.test(entry)) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`起動できませんでした / Could not start: ${message}`);
    process.exit(1);
  });
}
