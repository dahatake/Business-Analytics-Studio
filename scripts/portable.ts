/**
 * FR-373: builds the portable zip — Node runtime + built app + bundled server — that a customer extracts and starts with
 * start.cmd (Windows) or start.command (macOS) with no install and no admin rights.
 *
 *   node scripts/portable.ts [--target win-x64,win-arm64,mac-arm64] [--node 26.12.1] [--out release] [--skip-build] [--no-copilot]
 *
 * Reproducible inputs: the Node version (checked against nodejs.org SHASUMS256.txt), package-lock.json (server
 * dependencies are installed with `npm ci` from the lockfile's own closure) and SOURCE_DATE_EPOCH for zip timestamps.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { configureNetwork } from '../server/network.ts';

const ROOT = resolve(dirname(process.argv[1] ?? '.'), '..');
const NAME = 'BusinessAnalyticsStudio';
/** FR-374: the customer guide on GitHub Pages (source: site/guide.md). */
export const GUIDE_URL = 'https://dahatake.github.io/Business-Analytics-Studio/guide.html';
/** Server imports left to node_modules: native or large packages that bundle poorly. Everything else is in main.mjs. */
const EXTERNALS = ['@azure/msal-node', '@github/copilot-sdk', 'fast-xml-parser', 'undici', 'zod'];

interface Target { id: string; os: 'win32' | 'darwin' | 'linux'; cpu: 'x64' | 'arm64'; node: string; archive: 'zip' | 'tar.gz' }
export const TARGETS: Record<string, Target> = {
  'win-x64': { id: 'win-x64', os: 'win32', cpu: 'x64', node: 'win-x64', archive: 'zip' },
  'win-arm64': { id: 'win-arm64', os: 'win32', cpu: 'arm64', node: 'win-arm64', archive: 'zip' },
  'mac-arm64': { id: 'mac-arm64', os: 'darwin', cpu: 'arm64', node: 'darwin-arm64', archive: 'tar.gz' },
  'mac-x64': { id: 'mac-x64', os: 'darwin', cpu: 'x64', node: 'darwin-x64', archive: 'tar.gz' },
  'linux-x64': { id: 'linux-x64', os: 'linux', cpu: 'x64', node: 'linux-x64', archive: 'tar.gz' },
  'linux-arm64': { id: 'linux-arm64', os: 'linux', cpu: 'arm64', node: 'linux-arm64', archive: 'tar.gz' },
};

function hostTarget(): string {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

interface Options { targets: Target[]; node: string; out: string; build: boolean; copilot: boolean }

export function parsePortableArgs(argv: string[]): Options {
  const opts: Options = { targets: [TARGETS[hostTarget()]!], node: process.versions.node, out: join(ROOT, 'release'), build: true, copilot: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i] ?? '';
    if (arg === '--target') {
      opts.targets = value().split(',').map((t) => {
        const target = TARGETS[t.trim()];
        if (!target) throw new Error(`unknown target ${t} (use ${Object.keys(TARGETS).join(', ')})`);
        return target;
      });
    } else if (arg === '--node') {
      opts.node = value().replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+$/.test(opts.node)) throw new Error('--node needs a version like 26.12.1');
    } else if (arg === '--out') opts.out = resolve(value());
    else if (arg === '--skip-build') opts.build = false;
    else if (arg === '--no-copilot') opts.copilot = false;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function run(cmd: string, args: string[], cwd = ROOT): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.signal})`);
}

/** npm through its JS entry, so no shell is needed for the Windows npm.cmd shim. */
function npm(args: string[], cwd = ROOT): void {
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .find((p) => p && /npm-cli\.js$/.test(p) && existsSync(p));
  if (!cli) throw new Error('npm-cli.js not found next to this Node');
  run(process.execPath, [cli, ...args], cwd);
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/* ---------- 1. server bundle ---------- */

async function bundleServer(outDir: string, externals: string[]): Promise<string> {
  const { build } = await import('vite');
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    build: {
      ssr: join(ROOT, 'server', 'main.ts'),
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      copyPublicDir: false,
      rolldownOptions: {
        external: (id: string) => EXTERNALS.some((e) => id === e || id.startsWith(`${e}/`)),
        output: { entryFileNames: 'main.mjs', format: 'es', codeSplitting: false },
      },
    },
    ssr: { noExternal: true, target: 'node' },
  });
  const file = join(outDir, 'main.mjs');
  const code = readFileSync(file, 'utf8');
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const bare = new Set<string>();
  const imports = [/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];
  for (const re of imports) for (const m of code.matchAll(re)) if (!/^[./]/.test(m[1]!)) bare.add(m[1]!);
  const unexpected = [...bare].filter((s) => !builtins.has(s) && !EXTERNALS.some((e) => s === e || s.startsWith(`${e}/`)));
  if (unexpected.length) throw new Error(`server bundle imports packages that are not shipped: ${unexpected.join(', ')}`);
  const missing = externals.filter((e) => e !== '@github/copilot-sdk' && !bare.has(e));
  if (missing.length) throw new Error(`server bundle no longer imports ${missing.join(', ')}; update EXTERNALS`);
  return file;
}

/* ---------- 2. server node_modules from the lockfile ---------- */

interface LockEntry { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; dev?: boolean; [k: string]: unknown }
interface Lock { name: string; version: string; lockfileVersion: number; packages: Record<string, LockEntry> }

/** Lockfile entries reachable from `roots`, resolved the way Node resolves nested node_modules. */
export function lockClosure(lock: Lock, roots: string[]): Record<string, LockEntry> {
  const out: Record<string, LockEntry> = {};
  const find = (from: string, name: string): string | null => {
    const parts = from ? from.split('/node_modules/') : [];
    for (let n = parts.length; n >= 0; n--) {
      const base = parts.slice(0, n).join('/node_modules/');
      const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (lock.packages[key]) return key;
    }
    return null;
  };
  const queue = roots.map((r) => {
    const key = find('', r);
    if (!key) throw new Error(`${r} is not in package-lock.json`);
    return key;
  });
  while (queue.length) {
    const key = queue.pop()!;
    if (out[key]) continue;
    const entry = lock.packages[key]!;
    out[key] = entry;
    const deps = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const name of Object.keys(deps)) {
      const found = find(key, name);
      if (found) queue.push(found);
      else if (!entry.optionalDependencies?.[name] && !entry.peerDependencies?.[name]) throw new Error(`${name} (needed by ${key}) is not in package-lock.json`);
    }
  }
  return out;
}

function installServerModules(target: Target, workDir: string, roots: string[]): string {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Lock;
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const dependencies = Object.fromEntries(roots.map((r) => [r, rootPkg.dependencies[r]!]));
  const packages: Record<string, LockEntry> = { '': { name: `${NAME.toLowerCase()}-server`, version: '0.0.0', dependencies } };
  for (const [key, entry] of Object.entries(lockClosure(lock, roots))) {
    const { dev: _dev, devOptional: _devOptional, ...rest } = entry;
    packages[key] = rest;
  }
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: `${NAME.toLowerCase()}-server`, version: '0.0.0', private: true, type: 'module', dependencies }, null, 2));
  writeFileSync(join(workDir, 'package-lock.json'), JSON.stringify({ name: `${NAME.toLowerCase()}-server`, version: '0.0.0', lockfileVersion: lock.lockfileVersion, requires: true, packages }, null, 2));
  const platform = [`--os=${target.os}`, `--cpu=${target.cpu}`, ...(target.os === 'linux' ? ['--libc=glibc'] : [])];
  npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...platform], workDir);
  return join(workDir, 'node_modules');
}

/* ---------- 3. Node runtime ---------- */

async function download(url: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function nodeRuntime(target: Target, version: string, cacheDir: string): Promise<string> {
  const base = `node-v${version}-${target.node}`;
  const file = `${base}.${target.archive}`;
  const extracted = join(cacheDir, base);
  if (existsSync(join(extracted, '.verified'))) return extracted;
  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, file);
  const dist = `https://nodejs.org/dist/v${version}`;
  const sums = (await download(`${dist}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
  if (!expected) throw new Error(`${file} is not listed in ${dist}/SHASUMS256.txt`);
  if (!existsSync(archive) || sha256(readFileSync(archive)) !== expected) {
    console.log(`  downloading ${dist}/${file}`);
    writeFileSync(archive, await download(`${dist}/${file}`));
  }
  if (sha256(readFileSync(archive)) !== expected) throw new Error(`${file}: SHA-256 does not match SHASUMS256.txt`);
  rmSync(extracted, { recursive: true, force: true });
  // bsdtar (Windows 10+, macOS) reads both zip and tar.gz; GNU tar on a Linux build host (CI) does not read zip.
  if (target.archive === 'zip' && process.platform === 'linux') execFileSync('unzip', ['-q', '-o', archive, '-d', cacheDir], { stdio: 'inherit' });
  else execFileSync('tar', ['-xf', archive, '-C', cacheDir], { stdio: 'inherit' });
  writeFileSync(join(extracted, '.verified'), expected);
  return extracted;
}

/** Only what the app runs: node itself and npm (npx starts the Work IQ CLI); docs, headers and corepack are dropped. */
function runtimeFilter(target: Target) {
  return (rel: string) => {
    const p = rel.split(sep).join('/');
    if (target.os === 'win32') return p === 'node.exe' || p === 'LICENSE' || p === 'node_modules' || p.startsWith('node_modules/npm');
    return p === 'bin' || p === 'bin/node' || p === 'LICENSE' || p === 'lib' || p === 'lib/node_modules' || p.startsWith('lib/node_modules/npm');
  };
}

/* ---------- 4. launchers and readme ---------- */

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

function startCmd(): string {
  return crlf(`@echo off
setlocal
chcp 65001 >nul
title Business Analytics Studio
"%~dp0runtime\\node.exe" --use-system-ca "%~dp0server\\main.mjs" %*
if errorlevel 1 (
  echo.
  echo 起動できませんでした。上のメッセージを確認してください。 / Could not start. See the message above.
  pause
)
`);
}

function startUnix(): string {
  return `#!/bin/sh
cd "$(dirname "$0")" || exit 1
./runtime/bin/node --use-system-ca ./server/main.mjs "$@"
status=$?
if [ $status -ne 0 ]; then
  printf '\\n起動できませんでした。上のメッセージを確認してください。 / Could not start. See the message above.\\n'
  printf 'Enter キーで閉じます / Press Enter to close.'
  read -r _
fi
exit $status
`;
}

const NETWORK_EXAMPLE = `{
  "$comment": "network.json にリネームすると有効になります。通常は不要です (OS のプロキシ設定と証明書を自動で使います)。 Rename to network.json to use it; normally not needed.",
  "proxy": "system",
  "noProxy": [],
  "systemCa": true
}
`;

function readme(version: string, nodeVersion: string, target: Target, copilot: boolean): string {
  const win = target.os === 'win32';
  const start = win ? 'start.cmd' : target.os === 'darwin' ? 'start.command' : 'start.sh';
  const text = `Business Analytics Studio ${version} (${target.id})
================================================

■ 起動
1. この zip を任意のフォルダー（例: ドキュメント）に展開します。${win ? `
   インターネットから受け取った zip は、展開前に右クリック →［プロパティ］→［許可する］にチェックすると、
   起動時のセキュリティ警告を避けられます。` : ''}
2. ${start} を${win ? 'ダブルクリック' : target.os === 'darwin' ? 'ダブルクリック' : 'ターミナルで実行'}します。${target.os === 'darwin' ? `
   「開発元を検証できません」と表示されたら、ターミナルで次を実行してから、もう一度ダブルクリックします
   （macOS 15 以降は右クリック →［開く］では開けません）:
     xattr -dr com.apple.quarantine <展開したフォルダー>
   または［システム設定］→［プライバシーとセキュリティ］→［このまま開く］を選びます。` : ''}
3. ブラウザーが http://127.0.0.1:4300/ を開きます。黒いウィンドウを閉じると終了します。
   インストールと管理者権限は不要です。2 回目の起動は、起動中の画面をもう一度開きます。

■ データの保存先（展開フォルダーとは別。新しい版に置き換えても残ります）
${win ? '   %LOCALAPPDATA%\\BusinessAnalyticsStudio' : target.os === 'darwin' ? '   ~/Library/Application Support/BusinessAnalyticsStudio' : '   ~/.local/share/BusinessAnalyticsStudio'}
   別の場所を使うとき: ${start} --data-dir <フォルダー>
   API キーなどの秘密情報は、このフォルダーに OS の保護機能で暗号化して保存します。

■ AI（すべてお客様ご自身のリソースを使います）
- Microsoft Foundry / Azure OpenAI: アプリの［AI 設定］で Entra ID サインインまたはキーを設定します。
- GitHub Copilot: ${copilot ? '［AI 設定］で選ぶと、GitHub アカウントでのサインインを案内します。' : 'この版には含まれていません。'}
- Work IQ (Microsoft 365): 初回利用時に npx で Work IQ CLI を取得します（npm レジストリへの接続が必要です）。

■ ネットワーク（プロキシと証明書）
既定で OS の設定を自動で使います。
- プロキシ: Windows のインターネット オプション / macOS のネットワーク設定（PAC・WPAD を含む）、
  または環境変数 HTTPS_PROXY / HTTP_PROXY / NO_PROXY。
- 社内のルート証明書: OS の証明書ストアを信頼します（TLS 検査を行うプロキシ向け）。
確認:［AI 設定］→［ネットワークを確認］で、経路と各接続先への到達を表示します。
変更したいとき: network.example.json を network.json にリネームして編集します（このフォルダーか、データの保存先）。
  "proxy": "system" | "direct" | "auto" | "http://proxy.example.com:8080" | "http://user:pass@proxy:8080" | "socks5://host:1080"
  "pacUrl": "http://proxy.example.com/proxy.pac"
  "noProxy": ["*.internal.example.com", "10.0.0.0/8"]
  "systemCa": true | false
環境変数 BAS_PROXY / BAS_PAC_URL / BAS_NO_PROXY / BAS_SYSTEM_CA でも指定できます（network.json より優先）。
NTLM / Kerberos 認証だけを受け付けるプロキシには対応していません。接続先を許可リストに加えるか、
基本認証のプロキシ URL を指定してください。

■ うまく起動しないとき
- 「ポートが使用中」: 4300〜4309 の空いているポートを順に使います。すべて使用中のときは --port <番号> で指定してください。
- 会社のポリシー（AppLocker など）でユーザー フォルダーのプログラム実行が禁止されている場合は、IT 部門に
  runtime${win ? '\\node.exe' : '/bin/node'} の許可を依頼してください。
- オプション一覧: ${start} --help
- 画面付きの手順書: ${GUIDE_URL}

■ 内容
runtime/  Node.js ${nodeVersion}（公式配布物。LICENSE 同梱）
app/      アプリ本体（ブラウザーで動作）
server/   ローカル サーバー（127.0.0.1 のみで待ち受け。外部からは接続できません）
SHA256SUMS.txt  各ファイルのハッシュ
`;
  return win ? crlf(text) : text;
}

/* ---------- 5. zip ---------- */

interface ZipFile { name: string; data: Buffer; mode: number }

function dosTime(date: Date): { time: number; day: number } {
  const y = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((y - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Plain zip (no zip64: each file and the archive stay under 4 GB). Unix modes are kept so start.command stays executable. */
export function writeZip(files: ZipFile[], date: Date): Buffer {
  const { time, day } = dosTime(date);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = deflateRawSync(f.data, { level: 9 });
    const store = deflated.length >= f.data.length;
    const body = store ? f.data : deflated;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | f.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset > 0xffffffff || files.length > 0xffff) throw new Error('package too large for a plain zip');
  return Buffer.concat([...locals, dir, end]);
}

function listFiles(dir: string, keep: (rel: string) => boolean = () => true, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(base, full);
    if (!keep(rel)) continue;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue; // node's bin/npm and bin/npx links; the app runs npx-cli.js directly
    if (st.isDirectory()) out.push(...listFiles(full, keep, base));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/* ---------- main ---------- */

function version(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim();
  return sha ? `${pkg.version}+${sha}` : pkg.version;
}

async function main(): Promise<void> {
  const opts = parsePortableArgs(process.argv.slice(2));
  // Downloads use the same proxy and certificate detection as the app, so the packager works behind the same proxies.
  await configureNetwork({ installGlobal: true });
  const ver = version();
  const date = new Date(process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now());
  const work = join(ROOT, '.bas-local', 'portable');
  if (opts.build) npm(['run', 'build']);
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('dist/index.html is missing; run npm run build');
  const roots = EXTERNALS.filter((e) => opts.copilot || e !== '@github/copilot-sdk');
  console.log('bundling the server');
  const mainFile = await bundleServer(join(work, 'server'), roots);
  mkdirSync(opts.out, { recursive: true });

  for (const target of opts.targets) {
    console.log(`packaging ${target.id}`);
    const top = `${NAME}-${ver.replace('+', '-')}-${target.id}`;
    const runtime = await nodeRuntime(target, opts.node, join(work, 'node-cache'));
    const modules = installServerModules(target, join(work, `deps-${target.id}`), roots);
    const files: ZipFile[] = [];
    const add = (name: string, data: Buffer, mode = 0o644) => files.push({ name: `${top}/${name}`, data, mode });
    const addTree = (dir: string, prefix: string, keep?: (rel: string) => boolean) => {
      for (const file of listFiles(dir, keep)) {
        const rel = relative(dir, file).split(sep).join('/');
        const exec = (statSync(file).mode & 0o111) !== 0 && target.os !== 'win32';
        add(`${prefix}/${rel}`, readFileSync(file), exec || rel === 'bin/node' ? 0o755 : 0o644);
      }
    };
    addTree(runtime, 'runtime', runtimeFilter(target));
    addTree(join(ROOT, 'dist'), 'app');
    add('server/main.mjs', readFileSync(mainFile));
    add('server/package.json', Buffer.from('{ "type": "module", "private": true }\n'));
    addTree(modules, 'server/node_modules', (rel) => !rel.split(sep).includes('.bin') && basename(rel) !== '.package-lock.json');
    if (target.os === 'win32') add('start.cmd', Buffer.from(startCmd(), 'utf8'));
    else add(target.os === 'darwin' ? 'start.command' : 'start.sh', Buffer.from(startUnix(), 'utf8'), 0o755);
    add('README.txt', Buffer.from(readme(ver, opts.node, target, opts.copilot), 'utf8'));
    add('network.example.json', Buffer.from(NETWORK_EXAMPLE, 'utf8'));
    add('VERSION.txt', Buffer.from(`${ver}\nnode ${opts.node}\n${target.id}\n`, 'utf8'));
    const sums = files.map((f) => `${sha256(f.data)}  ${f.name.slice(top.length + 1)}`).join('\n') + '\n';
    add('SHA256SUMS.txt', Buffer.from(sums, 'utf8'));
    const zip = writeZip(files, date);
    const zipPath = join(opts.out, `${top}.zip`);
    writeFileSync(zipPath, zip);
    writeFileSync(`${zipPath}.sha256`, `${sha256(zip)}  ${basename(zipPath)}\n`);
    console.log(`  ${zipPath} (${(zip.length / 1024 / 1024).toFixed(1)} MB, ${files.length} files)`);
  }
}

if (/[\\/]scripts[\\/]portable\.ts$/.test(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

