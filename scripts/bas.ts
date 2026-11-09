/**
 * Business Analytics Studio generation pipeline (FR-120): research → build → verify → launch / package.
 * Run with Node ≥ 22.18 (type stripping): `node scripts/bas.ts <command> [args]`. `node scripts/bas.ts help` lists commands.
 * No network access: external research/LLM sources are BLOCKED by C-03/C-07 and recorded as "sample used".
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCatalog, requirementIds } from '../src/modules/ops/catalog.ts';
import { INDUSTRY_PRESETS, findPreset, DEFAULT_PRESET_ID } from '../src/modules/ops/presets.ts';
import { generateDraft, researchSourceId } from './lib/generate.ts';
import { cacheAge, CACHE_DAYS, readCache, research, slugify, writeCache } from './lib/research.ts';
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

  research <customer> [--industry <preset>] [--lang ja|en]   cache research in research-cache/<customer>/ (FR-121〜123)
  build <customer> [--industry] [--lang] [--template dist] [--refresh]
                                                             copy the template to work/<customer>/, generate and self-correct the pack (FR-124〜126, FR-130)
  verify <pack.json>                                         acceptance check with cause and action per problem (FR-127); exit 1 on errors
  launch <customer> [--port 4180]                            serve work/<customer>/ on 127.0.0.1 (FR-128)
  package <customer>                                         offline package work/<customer>-package/ (FR-105)
  serve [--dir dist] [--port 4180]                           serve any built folder on 127.0.0.1 (start scripts, FR-141)
  feedback "<text>"                                          record an improvement request in logs/improvements.jsonl (FR-131)
  schema [--check]                                           write docs/pack.schema.json from the zod schema (FR-118)
  presets                                                    list industry presets (FR-103)
  integrations check|list|impact <id>                        check docs/integration-catalog.md (FR-199, NFR-SEC-006, NFR-OPS-001)

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
  switch (command) {
    case 'help':
    case '--help':
      io.out(HELP);
      return 0;

    case 'research': {
      const customer = requireCustomer(s.customer);
      const cache = await timer.step('research', () => research(customer, { industry: s.industry, lang: s.lang }, s.now));
      const file = await timer.step('writeCache', () => writeCache(s.cache, cache));
      io.out(`research ${customer}: cache written to ${file}`);
      for (const src of cache.sources) io.out(`  ${src.id.padEnd(7)} ${src.status.padEnd(9)} ${src.reason}`);
      io.out(`  brand   ${cache.brand.chosen} (${cache.brand.profile.primary}); priority ${cache.brand.priority.join(' > ')}`);
      io.out(`  expires ${cache.expiresAt} (${CACHE_DAYS} days, PARAM-004)`);
      return 0;
    }

    case 'build': {
      const customer = requireCustomer(s.customer);
      const slug = slugify(customer);
      if (!findPreset(s.industry)) throw new UsageError(`Unknown industry preset "${s.industry}". Run: node scripts/bas.ts presets`);
      let cache = readCache(s.cache, slug);
      if (!cache || args.flags.refresh) {
        if (!cache) io.out(`No research cache for "${customer}"; running research first (UC-1).`);
        cache = await timer.step('research', () => research(customer, { industry: s.industry, lang: s.lang }, s.now));
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
        writePackageStarters(dest, customer);
      });
      io.out(`package ${customer}: ${dest}`);
      io.out('  contents: app/ (built app + data/pack.json), serve.ts, start.ps1, start.sh, start.command, README.txt');
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

    default:
      throw new UsageError(`Unknown command "${command}". Run: node scripts/bas.ts help`);
  }
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
Do not share this folder outside the agreed audience: it contains customer information (C-02).
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
