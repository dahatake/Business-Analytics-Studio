/**
 * Business Analytics Studio generation pipeline (FR-120): research → build → verify → launch / package.
 * Run with Node ≥ 22.18 (type stripping): `node scripts/bas.ts <command> [args]`. `node scripts/bas.ts help` lists commands.
 * Public research only runs for a user-supplied official URL; LLM and internal-data sources remain gated by C-03.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCatalog, requirementIds } from '../src/modules/ops/catalog.ts';
import { INDUSTRY_PRESETS, findPreset, DEFAULT_PRESET_ID } from '../src/modules/ops/presets.ts';
import { generateDraft, researchSourceId } from './lib/generate.ts';
import { cacheAge, CACHE_DAYS, readCache, research, researchOfficialSite, slugify, writeCache } from './lib/research.ts';
import { packJsonSchema } from './lib/schema.ts';
import { MAX_ROUNDS, selfCorrect } from './lib/selfcorrect.ts';
import { startServer } from './lib/serve.ts';
import { appendTiming, isoWithOffset, Timer } from './lib/timing.ts';
import { formatProblem, verifyPack, type VerifyResult } from './lib/verify.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** PARAM-005 (s), PARAM-020 (s), PARAM-001 (min). */
export const COPY_LIMIT_MS = 30_000;
export const VERIFY_LIMIT_MS = 60_000;
export const BUILD_TO_LAUNCH_LIMIT_MS = 6 * 60_000;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}
const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

/** FR-130: input variables come from flags first, then environment variables, then defaults. */
function settings(args: Args) {
  const flag = (k: string) => (typeof args.flags[k] === 'string' ? (args.flags[k] as string) : undefined);
  const env = process.env;
  const dir = (k: string, e: string, d: string) => resolve(flag(k) ?? env[e] ?? join(ROOT, d));
  const lang = flag('lang') ?? env.BAS_LANG ?? 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new UsageError(`--lang must be ja or en (got "${lang}").`);
  return {
    customer: args.positional[1] ?? flag('customer') ?? env.BAS_CUSTOMER,
    officialUrl: flag('official-url'),
    industry: flag('industry') ?? env.BAS_INDUSTRY ?? DEFAULT_PRESET_ID,
    lang: lang as 'ja' | 'en',
    template: dir('template', 'BAS_TEMPLATE', 'dist'),
    work: dir('work', 'BAS_WORK_DIR', 'work'),
    cache: dir('cache', 'BAS_CACHE_DIR', 'research-cache'),
    logs: dir('logs', 'BAS_LOG_DIR', 'logs'),
    now: flag('now') ?? env.BAS_NOW ? new Date(String(flag('now') ?? env.BAS_NOW)) : new Date(),
    port: Number(flag('port') ?? env.BAS_LAUNCH_PORT ?? 4180),
  };
}

class UsageError extends Error {}

export function templateVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
}

function requireCustomer(c: string | undefined): string {
  if (!c?.trim()) throw new UsageError('Customer name is missing. Example: node scripts/bas.ts build "Contoso" (or set BAS_CUSTOMER).');
  return c.trim();
}

function printVerify(io: Io, label: string, r: VerifyResult) {
  const errors = r.problems.filter((p) => p.severity === 'error');
  const warnings = r.problems.filter((p) => p.severity === 'warning');
  io.out(`verify ${label}: ${r.ok ? 'PASS' : 'FAIL'} — ${errors.length} error(s), ${warnings.length} warning(s); ${r.stats.validEntities}/${r.stats.entities} items valid, ${r.stats.internal} internal; ${r.stats.elapsedMs} ms (limit ${VERIFY_LIMIT_MS / 1000} s, PARAM-020)`);
  for (const p of [...errors, ...warnings]) io.out(formatProblem(p));
  if (!r.ok) io.out('Items with errors are disabled when the app loads the pack (FR-102); the rest still works.');
  if (r.stats.elapsedMs > VERIFY_LIMIT_MS) io.out(`[WARN ] verify took longer than ${VERIFY_LIMIT_MS / 1000} s (PARAM-020).`);
}

const HELP = `Business Analytics Studio pipeline (FR-120)

  research <customer> [--official-url <https-url>] [--industry <preset>] [--lang ja|en]
                                                             read up to six same-site pages from the URL you supply; no search engine, internal data or images
  build <customer> [--official-url <https-url>] [--industry] [--lang] [--template dist] [--refresh]
                                                             optionally refresh public research from the URL you supply, then build and verify (FR-123〜126, FR-130)
  verify <pack.json>                                         acceptance check with cause and action per problem (FR-127); exit 1 on errors
  launch <customer> [--port 4180]                            serve work/<customer>/ on 127.0.0.1 (FR-128)
  package <customer>                                         offline package work/<customer>-package/ (FR-105)
  serve [--dir dist] [--port 4180]                           serve any built folder on 127.0.0.1 (start scripts, FR-141)
  feedback "<text>"                                          record an improvement request in logs/improvements.jsonl (FR-131)
  schema [--check]                                           write docs/pack.schema.json from the zod schema (FR-118)
  presets                                                    list industry presets (FR-103)
  integrations check|list|impact <id>                        check docs/integration-catalog.md (FR-199, NFR-SEC-006, NFR-OPS-001)
  workiq check [--timeout 300] [--lang ja|en]                check that the Work IQ CLI starts, signs in and offers "retrieve" (D-14);
                                                             no Work IQ search is run (nothing billed) and the EULA is not accepted

Variables (FR-130): flags win over BAS_CUSTOMER, BAS_INDUSTRY, BAS_LANG, BAS_TEMPLATE, BAS_WORK_DIR, BAS_CACHE_DIR, BAS_LOG_DIR.
Every command appends step durations to logs/timing.json (FR-129).`;

export async function run(argv: string[], io: Io = consoleIo): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positional[0] ?? 'help';
  let s: ReturnType<typeof settings>;
  try {
    s = settings(args);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const timer = new Timer(command, s.customer ?? null);
  try {
    const code = await dispatch(command, args, s, timer, io);
    return code;
  } catch (e) {
    if (e instanceof UsageError) { io.err(`Error: ${e.message}`); return 2; }
    io.err(`Error: ${(e as Error).message}`);
    return 1;
  } finally {
    if (command !== 'help') appendTiming(join(s.logs, 'timing.json'), timer.entries);
  }
}

async function dispatch(command: string, args: Args, s: ReturnType<typeof settings>, timer: Timer, io: Io): Promise<number> {
  const collectResearch = (customer: string) => s.officialUrl
    ? researchOfficialSite(customer, { industry: s.industry, lang: s.lang, officialUrl: s.officialUrl }, s.now)
    : research(customer, { industry: s.industry, lang: s.lang }, s.now);
  switch (command) {
    case 'help':
    case '--help':
      io.out(HELP);
      return 0;

    case 'research': {
      const customer = requireCustomer(s.customer);
      const cache = await timer.step('research', () => collectResearch(customer));
      const file = await timer.step('writeCache', () => writeCache(s.cache, cache));
      io.out(`research ${customer}: cache written to ${file}`);
      for (const src of cache.sources) io.out(`  ${src.id.padEnd(7)} ${src.status.padEnd(9)} ${src.reason}`);
      for (const page of cache.webPages) io.out(`  page    ${page.url} (${page.fetchedAt})`);
      io.out(`  brand   ${cache.brand.chosen} (${cache.brand.profile.primary}); priority ${cache.brand.priority.join(' > ')}`);
      io.out(`  expires ${cache.expiresAt} (${CACHE_DAYS} days, PARAM-004)`);
      return 0;
    }

    case 'build': {
      const customer = requireCustomer(s.customer);
      const slug = slugify(customer);
      if (!findPreset(s.industry)) throw new UsageError(`Unknown industry preset "${s.industry}". Run: node scripts/bas.ts presets`);
      let cache = readCache(s.cache, slug);
      if (!cache || args.flags.refresh || s.officialUrl) {
        if (!cache) io.out(`No research cache for "${customer}"; running research first (UC-1).`);
        cache = await timer.step('research', () => collectResearch(customer));
        writeCache(s.cache, cache);
      } else {
        const age = cacheAge(cache.fetchedAt, s.now);
        if (age.expired) io.out(`[WARN ] Research cache is ${age.ageDays} days old (over ${CACHE_DAYS}, PARAM-004). Proposal: re-run research — node scripts/bas.ts research "${customer}" (or build --refresh).`);
      }
      const dest = join(s.work, slug);
      if (!existsSync(join(s.template, 'index.html'))) throw new Error(`Template build not found at ${s.template}. Next action: run "npm run build" (or pass --template <dir>).`);
      const copyStart = performance.now();
      await timer.step('copyTemplate', () => {
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(s.template, dest, { recursive: true });
        rmSync(join(dest, 'data', 'pack.json'), { force: true });
      });
      const copyMs = Math.round(performance.now() - copyStart);
      io.out(`copy template ${s.template} → ${dest}: ${copyMs} ms (limit ${COPY_LIMIT_MS / 1000} s, PARAM-005)${copyMs > COPY_LIMIT_MS ? ' [WARN] over the limit' : ''}`);
      const draft = await timer.step('generate', () => generateDraft(cache, { customer, industry: s.industry, lang: s.lang, templateVersion: templateVersion() }));
      const corrected = await timer.step('selfCorrect', () => selfCorrect(draft, { defaultSourceId: researchSourceId(slug), today: isoWithOffset(s.now).slice(0, 10) }));
      io.out(`generate: author=${cache.usedSample ? 'sample (research unavailable)' : 'ai'}; self-correction ${corrected.rounds}/${MAX_ROUNDS} round(s), ${corrected.fixes.length} item(s) fixed (FR-126)`);
      const byRound = new Map<number, number>();
      for (const f of corrected.fixes) byRound.set(f.round, (byRound.get(f.round) ?? 0) + 1);
      for (const [round, n] of byRound) io.out(`  round ${round}: ${n} fix(es), e.g. ${corrected.fixes.find((f) => f.round === round)!.path} — ${corrected.fixes.find((f) => f.round === round)!.note}`);
      await timer.step('writePack', () => {
        mkdirSync(join(dest, 'data'), { recursive: true });
        writeFileSync(join(dest, 'data', 'pack.json'), `${JSON.stringify(corrected.pack, null, 2)}\n`);
      });
      const final = await timer.step('verify', () => verifyPack(corrected.pack));
      printVerify(io, join(dest, 'data', 'pack.json'), final);
      io.out(`build ${customer}: ${final.ok ? 'ready' : 'FAILED'} in ${timer.total()} ms. Next: node scripts/bas.ts launch "${customer}"`);
      return final.ok ? 0 : 1;
    }

    case 'verify': {
      const file = args.positional[1];
      if (!file) throw new UsageError('Pass the pack file: node scripts/bas.ts verify work/<customer>/data/pack.json');
      const result = await timer.step('verify', (): VerifyResult => {
        if (!existsSync(file)) return { ok: false, problems: [{ severity: 'error', code: 'PARSE', path: file, cause: 'file not found', action: 'Check the path, or run build first.' }], stats: { entities: 0, validEntities: 0, internal: 0, elapsedMs: 0 } };
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'));
        } catch (e) {
          return { ok: false, problems: [{ severity: 'error', code: 'PARSE', path: file, cause: `not valid JSON (${(e as Error).message})`, action: 'Fix the JSON syntax (an editor with JSON validation shows the position).' }], stats: { entities: 0, validEntities: 0, internal: 0, elapsedMs: 0 } };
        }
        return verifyPack(raw);
      });
      printVerify(io, file, result);
      return result.ok ? 0 : 1;
    }

    case 'launch':
    case 'serve': {
      let dir: string;
      if (command === 'launch') {
        const customer = requireCustomer(s.customer);
        dir = join(s.work, slugify(customer));
        if (!existsSync(join(dir, 'data', 'pack.json'))) throw new Error(`No built pack in ${dir}. Next action: node scripts/bas.ts build "${customer}"`);
      } else {
        dir = resolve(typeof args.flags.dir === 'string' ? args.flags.dir : join(ROOT, 'dist'));
      }
      const served = await timer.step('launch', () => startServer(dir, s.port));
      io.out(`Business Analytics Studio is running: ${served.url}  (folder ${dir}; Ctrl+C to stop)`);
      return 0;
    }

    case 'package': {
      const customer = requireCustomer(s.customer);
      const slug = slugify(customer);
      const app = join(s.work, slug);
      const packFile = join(app, 'data', 'pack.json');
      if (!existsSync(packFile)) throw new Error(`No built pack in ${app}. Next action: node scripts/bas.ts build "${customer}"`);
      const check = await timer.step('verify', () => verifyPack(JSON.parse(readFileSync(packFile, 'utf8'))));
      if (!check.ok) {
        printVerify(io, packFile, check);
        throw new Error('The pack does not pass verify; fix it before packaging.');
      }
      const dest = join(s.work, `${slug}-package`);
      await timer.step('package', () => {
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
        cpSync(app, join(dest, 'app'), { recursive: true });
        cpSync(join(ROOT, 'scripts', 'lib', 'serve.ts'), join(dest, 'serve.ts'));
        cpSync(join(ROOT, 'scripts', 'lib', 'device.ts'), join(dest, 'device.ts'));
        cpSync(join(ROOT, 'scripts', 'lib', 'deviceProtocol.ts'), join(dest, 'deviceProtocol.ts'));
        writePackageStarters(dest, customer);
      });
      io.out(`package ${customer}: ${dest}`);
      io.out('  contents: app/ (built app + data/pack.json), serve.ts, device.ts, deviceProtocol.ts, start.ps1, start.sh, start.command, README.txt');
      io.out('  needs only Node.js on the target PC; no npm install, no network, serves on 127.0.0.1 (FR-105).');
      return 0;
    }

    case 'feedback': {
      const text = args.positional.slice(1).join(' ').trim();
      if (!text) throw new UsageError('Write the request: node scripts/bas.ts feedback "the map needs a legend"');
      const file = join(s.logs, 'improvements.jsonl');
      await timer.step('feedback', () => {
        mkdirSync(s.logs, { recursive: true });
        appendFileSync(file, `${JSON.stringify({ at: isoWithOffset(s.now), templateVersion: templateVersion(), customer: s.customer ?? null, text })}\n`);
      });
      io.out(`Recorded in ${file} (FR-131).`);
      return 0;
    }

    case 'schema': {
      const file = join(ROOT, 'docs', 'pack.schema.json');
      const text = `${JSON.stringify(packJsonSchema(templateVersion()), null, 2)}\n`;
      if (args.flags.check) {
        const same = existsSync(file) && readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === text;
        io.out(same ? `${file} is up to date.` : `${file} is out of date. Next action: node scripts/bas.ts schema`);
        return same ? 0 : 1;
      }
      await timer.step('schema', () => writeFileSync(file, text));
      io.out(`Wrote ${file} (FR-118).`);
      return 0;
    }

    case 'presets': {
      for (const p of INDUSTRY_PRESETS) io.out(`${p.id.padEnd(14)} scene=${p.sceneType} camera=${p.cameraPath} icons=${p.iconSet} core=${p.coreObject.kind}/${p.coreObject.type}`);
      return 0;
    }

    case 'integrations': {
      const sub = args.positional[1] ?? 'check';
      const file = typeof args.flags.file === 'string' ? resolve(args.flags.file) : join(ROOT, 'docs', 'integration-catalog.md');
      const { rows, problems } = await timer.step(`integrations-${sub}`, () => checkCatalog(readFileSync(file, 'utf8'), s.now));
      if (sub === 'list') {
        for (const r of rows) io.out(`${r.id.padEnd(14)} ${r.status.padEnd(8)} ${r.direction.padEnd(13)} ${r.type.padEnd(8)} ${r.gate.padEnd(18)} checked ${r.lastChecked}  ${r.name}`);
        return 0;
      }
      if (sub === 'impact') {
        const id = args.positional[2];
        const row = rows.find((r) => r.id === id);
        if (!row) throw new UsageError(`Unknown integration "${id ?? ''}". Known: ${rows.map((r) => r.id).join(', ')}`);
        io.out(`${row.id} (${row.name}, status ${row.status}) affects: ${requirementIds(row).join(', ')}`);
        io.out(`  gate: ${row.gate}; degrade: ${row.degrade}`);
        return 0;
      }
      const errors = problems.filter((p) => p.severity === 'error');
      const warnings = problems.filter((p) => p.severity === 'warning');
      io.out(`integrations check ${file}: ${errors.length ? 'FAIL' : 'PASS'} — ${rows.length} integration(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
      for (const p of [...errors, ...warnings]) {
        io.out(`[${p.severity === 'error' ? 'ERROR' : 'WARN '}] ${p.code} ${p.rowId ?? '-'}${p.column ? `.${p.column}` : ''}: ${p.message}${p.impact.length ? `\n        impact: ${p.impact.join(', ')}` : ''}`);
      }
      return errors.length ? 1 : 0;
    }

    case 'workiq': {
      const sub = args.positional[1] ?? 'check';
      if (sub !== 'check') throw new UsageError(`Unknown workiq subcommand "${sub}". Run: node scripts/bas.ts workiq check`);
      const timeoutSec = Number(args.flags.timeout ?? 300);
      if (!Number.isFinite(timeoutSec) || timeoutSec < 10) throw new UsageError('--timeout must be a number of seconds (10 or more).');
      return await timer.step('workiq-check', () => workIqCheck(io, s.lang, timeoutSec * 1000));
    }

    default:
      throw new UsageError(`Unknown command "${command}". Run: node scripts/bas.ts help`);
  }
}

/**
 * D-14: first-time check of the Work IQ CLI route. Starts `workiq mcp` once and lists its tools (no `retrieve` call, so
 * no Work IQ search and no charge; the EULA is never accepted here). Exit 0 when BAS can use the route.
 */
export async function workIqCheck(io: Io, lang: 'ja' | 'en', timeoutMs: number, deps: {
  command?: () => import('../server/workiqCli.ts').WorkIqCliCommand;
  list?: typeof import('../server/workiqCli.ts').listMcpTools;
  config?: typeof import('../server/workiqCli.ts').workIqCliConfig;
} = {}): Promise<number> {
  const cli = await import('../server/workiqCli.ts');
  const ja = lang === 'ja';
  const say = (jaText: string, enText: string) => io.out(ja ? jaText : enText);
  const cmd = (deps.command ?? cli.workIqCliCommand)();
  const shown = [cmd.command, ...cmd.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const manual = `npx -y ${cli.WORKIQ_CLI_PACKAGE}`;
  say('Work IQ CLI の確認（BAS の「この PC の Work IQ CLI」方式。接続先が Microsoft Foundry のときだけ使います）',
    'Work IQ CLI check (the "Work IQ CLI on this PC" route of BAS; used only with Microsoft Foundry)');
  say(`[1/3] Node.js ${process.versions.node}: OK`, `[1/3] Node.js ${process.versions.node}: OK`);
  say(`[2/3] 起動するコマンド: ${shown}`, `[2/3] Command: ${shown}`);
  say('      CLI を起動しています。初回はダウンロードと Microsoft 365 へのサインインで数十秒〜数分かかります。',
    '      Starting the CLI. The first run downloads it and signs in to Microsoft 365, which can take from seconds to minutes.');
  say('      サインインの画面が出たら、Work IQ を使う Microsoft 365 の職場アカウントでサインインしてください。',
    '      If a sign-in window appears, sign in with the Microsoft 365 work account you want to use for Work IQ.');
  let info: import('../server/workiqCli.ts').McpServerInfo;
  try {
    info = await (deps.list ?? cli.listMcpTools)(cmd, undefined, timeoutMs);
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'workiqUnavailable';
    say(`      NG: ${code}`, `      FAILED: ${code}`);
    if (code === 'workiqCliMissing') {
      say('次にすること: Node.js 22.18 以降（npm と npx を含む）を入れ直してターミナルを開き直すか、Work IQ CLI を入れて環境変数 BAS_WORKIQ_CLI にその workiq のパスを設定してから、もう一度実行してください。',
        'Next action: reinstall Node.js 22.18 or later (with npm and npx) and open a new terminal, or install the Work IQ CLI and set BAS_WORKIQ_CLI to its workiq program, then run this again.');
    } else if (code === 'workiqTimeout') {
      say(`次にすること: サインインが終わっていない可能性があります。「${manual} auth login」を実行してサインインしてから、もう一度実行してください（--timeout 600 で待ち時間を延ばせます）。`,
        `Next action: the sign-in may not have finished. Run "${manual} auth login", sign in, then run this again (--timeout 600 waits longer).`);
    } else {
      say(`次にすること: CLI が途中で終了しました。社内プロキシで registry.npmjs.org・login.microsoftonline.com・workiq.svc.cloud.microsoft に接続できるか確認し、「${manual} auth login」でサインインしてから、もう一度実行してください。`,
        `Next action: the CLI stopped. Check that registry.npmjs.org, login.microsoftonline.com and workiq.svc.cloud.microsoft are reachable through your proxy, sign in with "${manual} auth login", then run this again.`);
    }
    return 1;
  }
  const hasRetrieve = info.tools.includes('retrieve');
  say(`      OK: ${info.name ?? 'Work IQ'} ${info.version ?? ''} が起動し、ツール ${info.tools.length} 個を確認しました（retrieve: ${hasRetrieve ? 'あり' : 'なし'}）。`,
    `      OK: ${info.name ?? 'Work IQ'} ${info.version ?? ''} started with ${info.tools.length} tool(s) (retrieve: ${hasRetrieve ? 'available' : 'missing'}).`);
  const config = await (deps.config ?? cli.workIqCliConfig)(cmd);
  const account = config?.account ?? null;
  const eula = config?.eulaAccepted === true;
  say(`[3/3] CLI のサインイン アカウント: ${account ?? '（未保存。BAS の接続検証のときに CLI がサインインを求めます）'}`,
    `[3/3] CLI sign-in account: ${account ?? '(none saved yet; the CLI asks you to sign in during the BAS connection test)'}`);
  say(`      EULA への同意: ${eula ? '同意済み（I-accept-EULA=true）' : '未同意（BAS の画面で同意します）'}`,
    `      EULA: ${eula ? 'accepted (I-accept-EULA=true)' : 'not accepted yet (accept it in BAS)'}`);
  if (!hasRetrieve) {
    say('次にすること: この組織では Work IQ の retrieve ツールが提供されていません（公開プレビュー・テナントの方針による）。管理者に Work IQ MCP の提供状況を確認してください。BAS は retrieve がないと Work IQ を使えません。',
      'Next action: this organisation does not offer the Work IQ "retrieve" tool (public preview / tenant policy). Ask your administrator about Work IQ MCP. BAS cannot use Work IQ without it.');
    return 1;
  }
  say('この確認では Work IQ の検索（課金の対象）は行わず、EULA への同意もしていません。', 'This check ran no Work IQ search (nothing billed) and did not accept the EULA.');
  say('次にすること（BAS の画面）:', 'Next steps (in BAS):');
  say('  1. run.cmd で BAS を起動し、最初の画面の「AI 設定」ボタン（またはメニューの「AI の接続設定」）を開きます。', '  1. Start BAS with run.cmd and open "AI settings" on the first screen (or "AI connection settings" in the menu).');
  say('  2. 接続先で Microsoft Foundry を選び、エンドポイント・デプロイ名・API キーを入れて「接続をテストして保存」を押します。', '  2. Choose Microsoft Foundry, enter the endpoint, deployment and API key, and press "Test connection and save".');
  say('  3. 「Work IQ」の欄で「この PC の Work IQ CLI」を選び、「Work IQ CLI を使う」を押します。', '  3. In "Work IQ", choose "Work IQ CLI on this PC" and press "Use the Work IQ CLI".');
  say(`  4. EULA（${cli.WORKIQ_EULA_URL}）を読み、ご自身で同意する場合だけチェックして「Work IQ の EULA に同意」を押します。${eula ? '（この PC では同意済みのため不要）' : ''}`,
    `  4. Read the EULA (${cli.WORKIQ_EULA_URL}); only if you accept it yourself, tick the box and press "Accept the Work IQ EULA".${eula ? ' (Already accepted on this PC.)' : ''}`);
  say('  5. 課金の可能性に同意して「Work IQ の情報取得を検証」を押し、検証日時が表示されれば完了です。', '  5. Agree to the possible charge and press "Verify Work IQ retrieval". It is done when the verification time is shown.');
  return 0;
}

function writePackageStarters(dest: string, customer: string) {
  const ps1 = `# Start ${customer} (Business Analytics Studio, offline package). Needs Node.js >= 22.18; no admin rights, no network.
param([int]$Port = 4180)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error 'Node.js was not found. Install Node.js LTS (22.18 or later), then run this script again.'; exit 1 }
node serve.ts --dir app --port $Port
`;
  const sh = `#!/bin/sh
# Start ${customer} (Business Analytics Studio, offline package). Needs Node.js >= 22.18; no admin rights, no network.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js was not found. Install Node.js LTS (22.18 or later), then run this script again." >&2; exit 1; }
exec node serve.ts --dir app --port "\${1:-4180}"
`;
  writeFileSync(join(dest, 'start.ps1'), ps1);
  writeFileSync(join(dest, 'start.sh'), sh, { mode: 0o755 });
  writeFileSync(join(dest, 'start.command'), sh, { mode: 0o755 });
  writeFileSync(join(dest, 'README.txt'), `Business Analytics Studio — ${customer}

Start (no installation, no network; the app runs on http://127.0.0.1:4180/):
  Windows:  right-click start.ps1 > Run with PowerShell   (or: powershell -ExecutionPolicy Bypass -File start.ps1)
  macOS:    double-click start.command
  Linux:    sh start.sh

Requires Node.js 22.18 or later. The customer pack is app/data/pack.json; replace it to show another customer (no rebuild).
Project data, imported packs and boards are saved in .bas-local/device.sqlite, shared across ports and browsers in this package.
For legacy browser-only data, open the updated app once at its original URL and browser profile to migrate it.
Stop all servers before backing up the whole .bas-local folder. Migration backups and original browser data are managed separately from project deletion.
Do not share this folder outside the agreed audience: it contains customer information (C-02).
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
