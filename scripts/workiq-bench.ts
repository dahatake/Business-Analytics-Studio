/**
 * Work IQ retrieval benchmark: does a Foundry IQ–style agentic retrieval layer (planned fan-out, one long-lived MCP
 * session, parallel subqueries, merge/dedupe/rerank, decomposition of compound asks) make the customer-pack Work IQ
 * route faster and its evidence more relevant? See docs/workiq-agentic-retrieval-study.md.
 *
 *   node scripts/workiq-bench.ts startup [--runs 3]
 *       Free: start-up phases of the CLI (npx route vs. the cached CLI started directly). tools/list only, no retrieval.
 *   node scripts/workiq-bench.ts run --project <pj-id> [--concurrency 4] [--max-calls 60] [--judge]
 *       Billed (Copilot Credits): runs the experiments with the inputs of that project's last generation report in
 *       device storage. --judge sends hit snippets to the saved Microsoft Foundry deployment (the D-14 packBuild route)
 *       for blind 0/1/2 relevance grades.
 *   node scripts/workiq-bench.ts report [<run.json>]
 *       Offline: metrics and the merge/rerank simulations from a saved run.
 *   node scripts/workiq-bench.ts pipeline --project <pj-id> [--rounds 3] [--provider foundry|copilotSdk] [--keep]
 *       Billed (Foundry or Copilot Credits + Work IQ): one real pack generation with that project's inputs through the relay's own
 *       handlers (/relay/ai, /relay/workiq/ask, /relay/site, /relay/news), as the dialog wires them. Saves timings and
 *       counts only; the pack itself is discarded. Not recorded in the app's usage ledger. `--keep` also writes the pack and
 *       the Work IQ answers to logs/workiq-bench/kept-*.json (internal data: delete it after the audit).
 *   node scripts/workiq-bench.ts recall [<kept.json>]
 *       Offline: how many of the proper names in each Work IQ section reach the pack (counts only are saved). The name
 *       match is crude (it also counts metadata words), so compare runs of the same input, never absolute values.
 *   node scripts/workiq-bench.ts fields --project <pj-id>
 *       Billed (4 Work IQ searches + 1 Foundry call): which facts about engagements (date, customer, status, money,
 *       progress …) the Microsoft 365 results state, per engagement. Saves counts only (docs/engagements-readiness-decision.md).
 *
 * Only metrics are written (logs/workiq-bench/, git-ignored): no retrieved text or titles; URLs are hashed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { foundryChatUrl, isFoundryV1, type FoundryConnection } from '../src/ai/foundry.ts';
import { REQUIREMENTS, type ReadinessKey } from '../src/modules/project/analysisReadiness.ts';
import { ASPECT_ITEMS, WORKIQ_ASPECTS, WORKIQ_SCOPED_ASPECTS, workIqAspectQuery, workIqTopicQuery, type WorkIqQuestion } from '../server/workiq.ts';
import { WorkIqCliService, workIqCliCommand, type WorkIqCliCommand } from '../server/workiqCli.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'logs', 'workiq-bench');
/** Same rule as server/relay.ts relayDir (that module needs Vite's TypeScript transform, so it is loaded only for the judge). */
const RELAY_DIR = process.env.BAS_RELAY_DIR ? resolve(ROOT, process.env.BAS_RELAY_DIR) : join(ROOT, '.bas-local');

/** The saved Foundry connection and key, read through the relay's own modules (loaded by Vite: full TypeScript). */
async function foundryAccess(): Promise<{ conn: FoundryConnection; key: string }> {
  const { createServer } = await import('vite');
  const server = await createServer({ root: ROOT, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false } });
  try {
    const relay = await server.ssrLoadModule('/server/relay.ts') as typeof import('../server/relay.ts');
    const vault = await server.ssrLoadModule('/server/vault.ts') as typeof import('../server/vault.ts');
    const conn = relay.loadConnection(RELAY_DIR);
    const key = new vault.SecretVault(RELAY_DIR).get('foundryKey');
    if (!conn || !key) throw new Error('Foundry is not configured in the relay');
    return { conn, key };
  } finally {
    await server.close();
  }
}
let access: Promise<{ conn: FoundryConnection; key: string }> | null = null;
const REQUEST_TIMEOUT_MS = 180_000;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const redact = (s: string) => s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<mail>').replace(/https?:\/\/\S+/g, '<url>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>').replace(/\s+/g, ' ').slice(0, 160);

/* ---------- A long-lived MCP stdio session with phase timings ---------- */

class Session {
  readonly marks: Record<string, number> = {};
  serverVersion: string | null = null;
  private child!: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 2;
  private readonly pending = new Map<number, (m: Json) => void>();
  private exited = false;

  static async open(cmd: WorkIqCliCommand): Promise<Session> {
    const s = new Session();
    const t0 = process.hrtime.bigint();
    s.child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: cmd.shell });
    s.child.stderr.on('data', () => {});
    s.child.stdin.on('error', () => {});
    s.child.on('exit', () => {
      s.exited = true;
      for (const r of s.pending.values()) r({ error: { message: 'process exited' } });
      s.pending.clear();
    });
    s.child.stdout.setEncoding('utf8');
    s.child.stdout.once('data', () => { s.marks.firstByteMs = ms(t0); });
    s.child.stdout.on('data', (chunk: string) => s.onData(chunk));
    const init = await s.raw(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bas-workiq-bench', version: '0.1.0' } }, REQUEST_TIMEOUT_MS);
    s.marks.initializeMs = ms(t0);
    if (!isObj(init.result)) throw new Error(`initialize failed: ${redact(JSON.stringify(init.error ?? init))}`);
    const info = isObj(init.result.serverInfo) ? init.result.serverInfo : {};
    s.serverVersion = typeof info.version === 'string' ? info.version : null;
    s.send({ method: 'notifications/initialized' });
    return s;
  }

  private send(m: Json) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!isObj(msg)) continue;
      if (typeof msg.method === 'string') {
        if (msg.id !== undefined) this.send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
        continue;
      }
      if (typeof msg.id === 'number') {
        const r = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        r?.(msg);
      }
    }
  }

  private raw(id: number, method: string, params: Json, timeoutMs: number): Promise<Json> {
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: { message: 'timeout' } }); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); res(m); });
      this.send({ id, method, params });
    });
  }

  request(method: string, params: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
    return this.raw(this.nextId++, method, params, timeoutMs);
  }

  close() {
    try { this.child.stdin.end(); } catch { /* closed */ }
    setTimeout(() => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      if (process.platform === 'win32' && this.child.pid) spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
      else this.child.kill();
    }, 2_000).unref();
  }
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

/* ---------- Retrieve payloads → metrics (text kept in memory only for the judge) ---------- */

interface Hit { h: string; type: string | null; score: number | null; chars: number; allowed: boolean; labeled: boolean; date: string | null; rank: number }
interface LiveHit extends Hit { title: string; text: string }

function retrievalPayload(result: Json): Json | null {
  const ok = (v: Json) => typeof v.markdown === 'string' || Array.isArray(v.retrievalHits) || Array.isArray(v.results);
  if (isObj(result.structuredContent)) {
    const sc = result.structuredContent;
    const inner = sc['application/vnd.ms-workiq.retrieval'];
    if (isObj(inner)) return inner;
    if (ok(sc)) return sc;
  }
  for (const c of Array.isArray(result.content) ? result.content : []) {
    if (!isObj(c) || typeof c.text !== 'string') continue;
    try {
      const v = JSON.parse(c.text) as unknown;
      if (isObj(v) && isObj(v['application/vnd.ms-workiq.retrieval'])) return v['application/vnd.ms-workiq.retrieval'] as Json;
      if (isObj(v) && ok(v)) return v;
    } catch { /* not JSON */ }
  }
  return null;
}

function metaOf(hit: Json): { title: string; date: string | null } {
  const meta = isObj(hit.resourceMetadata) ? hit.resourceMetadata : {};
  for (const v of Object.values(meta)) {
    if (!isObj(v)) continue;
    const title = v.title ?? v.subject ?? v.name ?? v.displayName;
    const date = v.occurrenceTime ?? v.sentTime ?? v.startTime ?? v.lastModifiedDateTime ?? v.createdDateTime;
    return { title: typeof title === 'string' ? title.trim().slice(0, 200) : '', date: typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date.slice(0, 10) : null };
  }
  return { title: '', date: null };
}

function analyse(msg: Json): { ok: boolean; error: string | null; stoppedReason: string | null; resultCount: number | null; payloadKeys: string[]; hitKeys: string[]; markdownChars: number; hits: LiveHit[] } {
  const empty = { stoppedReason: null, resultCount: null, payloadKeys: [], hitKeys: [], markdownChars: 0, hits: [] };
  if (isObj(msg.error)) return { ok: false, error: redact(String(msg.error.message ?? 'error')), ...empty };
  const result = isObj(msg.result) ? msg.result : {};
  const texts = (Array.isArray(result.content) ? result.content : []).filter(isObj).map((c) => String(c.text ?? ''));
  const payload = retrievalPayload(result);
  if (result.isError === true || !payload) return { ok: false, error: redact(texts.join(' ') || 'no payload'), ...empty };
  const hitKeys = new Set<string>();
  const hits: LiveHit[] = [];
  const seen = new Set<string>();
  const list = [...(Array.isArray(payload.results) ? payload.results : []), ...(Array.isArray(payload.retrievalHits) ? payload.retrievalHits : [])];
  for (const raw of list) {
    if (!isObj(raw) || typeof raw.webUrl !== 'string' || seen.has(raw.webUrl)) continue;
    seen.add(raw.webUrl);
    Object.keys(raw).forEach((k) => hitKeys.add(k));
    const allowed = raw.contentProtection === undefined || raw.contentProtection === 'allowed';
    const text = allowed && typeof raw.markdown === 'string' ? raw.markdown.trim() : '';
    const score = typeof raw.relevanceScore === 'number' ? raw.relevanceScore : typeof raw.score === 'number' ? raw.score : null;
    const { title, date } = metaOf(raw);
    hits.push({
      h: hash(raw.webUrl), type: typeof raw.entityType === 'string' ? raw.entityType : null, score, chars: text.length, allowed,
      labeled: isObj(raw.sensitivityLabel), date, rank: hits.length + 1, title, text,
    });
  }
  const stoppedReason = typeof payload.stoppedReason === 'string' ? payload.stoppedReason : null;
  return {
    ok: stoppedReason !== 'error', error: stoppedReason === 'error' ? redact(String(payload.errorCode ?? payload.error ?? 'error')) : null,
    stoppedReason, resultCount: typeof payload.resultCount === 'number' ? payload.resultCount : null,
    payloadKeys: Object.keys(payload), hitKeys: [...hitKeys], markdownChars: typeof payload.markdown === 'string' ? payload.markdown.length : 0, hits,
  };
}

/* ---------- Plans ---------- */

const ASPECT_KEYS = ASPECT_ITEMS;
/** The 8 section searches the bench was designed around; the organisation-scoped KPI searches (FR-341) need a unit. */
const BASE_ASPECTS = WORKIQ_ASPECTS.filter((a) => !WORKIQ_SCOPED_ASPECTS.includes(a));

interface Planned { id: string; exp: string; keys: readonly ReadinessKey[]; query: string; group?: string }

/** The compound gap topics of the report, split into single asks ("section: a、b、c" → a / b / c). */
export function decompose(topic: string, max = 4): string[] {
  const body = topic.replace(/^[a-zA-Z]+:\s*/, '').replace(/…$/, '');
  return body.split(/[、,;；]\s*|。\s*/).map((s) => s.trim()).filter((s) => s.length >= 4).slice(0, max);
}

/* ---------- Inputs from the project's last generation report ---------- */

function reportOf(projectId: string): Json {
  const db = new DatabaseSync(join(RELAY_DIR, 'device.sqlite'), { readOnly: true });
  const row = db.prepare('select value from records where key = ?').get(`bas.binary.pack.${projectId}`) as { value?: string } | undefined;
  db.close();
  if (!row?.value) throw new Error(`no saved pack for ${projectId}`);
  const find = (o: unknown): Json | null => {
    if (!isObj(o)) return null;
    if (o.generator === 'bas-pack-generate') return o;
    for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
    return null;
  };
  const g = find(JSON.parse(row.value));
  if (!g) throw new Error('no generation report in the saved pack');
  return g;
}

/* ---------- Foundry judge (blind: the judge never sees which experiment found a hit) ---------- */

async function judge(subject: string, need: string, hits: LiveHit[], lang: 'ja' | 'en'): Promise<Record<string, number>> {
  const { conn, key } = await (access ??= foundryAccess());
  const list = hits.map((x) => `[${x.h}] (${x.type ?? '?'}${x.date ? `, ${x.date}` : ''}) ${x.title}\n${x.text.slice(0, 700).replace(/\s+/g, ' ')}`).join('\n\n');
  const system = 'You grade enterprise search results for an analyst. For each result id, give 2 if it directly states facts that satisfy the information need for the subject, 1 if it is related background that partly helps, 0 if it does not help. Judge only from the text shown. Answer JSON only: {"grades":{"<id>":0|1|2}}.';
  const user = `${lang === 'ja' ? '対象' : 'Subject'}: ${subject}\n${lang === 'ja' ? '必要な情報' : 'Information need'}: ${need}\n\n${list}`;
  const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(isFoundryV1(conn.endpoint) ? { model: conn.deployment } : {}), max_completion_tokens: 4000, response_format: { type: 'json_object' } };
  const res = await fetch(foundryChatUrl(conn), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { ...(isFoundryV1(conn.endpoint) ? { Authorization: `Bearer ${key}` } : { 'api-key': key }), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: Json };
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as { grades?: Record<string, unknown> };
  const out: Record<string, number> = {};
  for (const x of hits) {
    const g = Number(parsed.grades?.[x.h]);
    if (g === 0 || g === 1 || g === 2) out[x.h] = g;
  }
  return out;
}

/* ---------- Commands ---------- */

function cachedCliEntry(): string | null {
  const base = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx');
  if (!existsSync(base)) return null;
  const found = readdirSync(base).map((d) => join(base, d, 'node_modules', '@microsoft', 'workiq', 'bin', 'workiq.js')).filter((p) => existsSync(p));
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

async function startup(runs: number) {
  const routes: { name: string; cmd: WorkIqCliCommand }[] = [{ name: 'npx', cmd: workIqCliCommand({}) }];
  const entry = cachedCliEntry();
  if (entry) routes.push({ name: 'direct', cmd: workIqCliCommand({ BAS_WORKIQ_CLI: entry }) });
  const rows: Json[] = [];
  for (let r = 0; r < runs; r++) {
    for (const route of routes) {
      const t0 = process.hrtime.bigint();
      const s = await Session.open(route.cmd);
      const tl = process.hrtime.bigint();
      const list = await s.request('tools/list', {});
      const listMs = ms(tl);
      s.close();
      const tools = isObj(list.result) && Array.isArray(list.result.tools) ? list.result.tools.length : 0;
      const row = { route: route.name, run: r + 1, firstByteMs: Math.round(s.marks.firstByteMs ?? 0), initializeMs: Math.round(s.marks.initializeMs ?? 0), toolsListMs: Math.round(listMs), totalMs: Math.round(ms(t0)), tools, version: s.serverVersion };
      rows.push(row);
      console.log(JSON.stringify(row));
      await new Promise((r2) => setTimeout(r2, 3_000));
    }
  }
  save('startup', { kind: 'startup', at: new Date().toISOString(), rows });
}

function save(prefix: string, data: Json): string {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(data, null, 1));
  console.log(`saved ${file}`);
  return file;
}

async function run(projectId: string, concurrency: number, maxCalls: number, withJudge: boolean) {
  const g = reportOf(projectId);
  const i = g.inputs as Json;
  const lang = i.lang === 'en' ? 'en' : 'ja';
  const q: WorkIqQuestion = {
    company: String(i.companyName), project: String(i.projectName), purpose: String(i.purpose), focus: String(i.focus ?? ''),
    asOf: new Date().toISOString().slice(0, 10), lang, timeZone: 'Asia/Tokyo', aspects: [], topics: [], expand: false,
  };
  const subject = `${q.project} (${q.company})`;

  // Plan: the 8 section searches + every ladder wording (what the follow-up rounds would ask, one round at a time).
  const plan: Planned[] = [
    ...BASE_ASPECTS.map((a) => ({ id: `aspect:${a}`, exp: 'fanout', keys: ASPECT_KEYS[a], query: workIqAspectQuery(q, a) })),
    ...REQUIREMENTS.flatMap((r) => r.ladder[lang].map((w, n) => ({ id: `ladder:${r.key}:${n}`, exp: 'fanout', keys: [r.key], query: workIqTopicQuery(q, w) }))),
  ];
  // Compound gap topics the model actually produced in that run (the longest three with ≥3 asks) vs. their single asks.
  const rounds = Array.isArray(g.collectionRounds) ? (g.collectionRounds as Json[]) : [];
  const compounds = [...new Set(rounds.flatMap((r) => (Array.isArray(r.topics) ? r.topics as string[] : [])))]
    .filter((t) => /^[a-zA-Z]+:/.test(t) && decompose(t, 99).length >= 3).sort((a, b) => b.length - a.length).slice(0, 3);
  compounds.forEach((t, n) => {
    plan.push({ id: `compound:${n}`, exp: 'compound', keys: [], query: workIqTopicQuery(q, t), group: `c${n}` });
    decompose(t).forEach((ask, k) => plan.push({ id: `single:${n}:${k}`, exp: 'decomposed', keys: [], query: workIqTopicQuery(q, ask), group: `c${n}` }));
  });
  const baselineCalls = BASE_ASPECTS.length + 4;
  if (plan.length + baselineCalls > maxCalls) throw new Error(`plan needs ${plan.length + baselineCalls} billed calls > --max-calls ${maxCalls}`);
  console.log(`billed retrieve calls planned: ${plan.length} (session) + ${baselineCalls} (baseline) = ${plan.length + baselineCalls}`);

  // A. Agentic layer: one session, all planned searches in parallel (bounded).
  const cmd = workIqCliCommand();
  const tA = process.hrtime.bigint();
  const session = await Session.open(cmd);
  const openMs = ms(tA);
  const live = new Map<string, LiveHit[]>();
  const tFan = process.hrtime.bigint();
  const calls = await pool(plan, concurrency, async (p) => {
    const start = ms(tFan);
    const t = process.hrtime.bigint();
    const msg = await session.request('tools/call', { name: 'retrieve', arguments: { query: p.query, strategy: 'grounding', timeZone: q.timeZone } });
    const latency = ms(t);
    const a = analyse(msg);
    live.set(p.id, a.hits);
    console.log(`${p.id.padEnd(22)} ${String(Math.round(latency)).padStart(6)} ms  hits ${String(a.hits.length).padStart(2)}  ${a.ok ? '' : `ERROR ${a.error}`}`);
    const { hits, ...rest } = a;
    return { ...p, queryChars: p.query.length, startMs: Math.round(start), latencyMs: Math.round(latency), ...rest, hits: hits.map(({ title: _t, text: _x, ...h }) => h) };
  });
  const fanoutWallMs = ms(tFan);
  session.close();

  // B. Current implementation, as the app runs it: a fresh CLI per batch, two at a time.
  const service = new WorkIqCliService({ timeoutMs: REQUEST_TIMEOUT_MS });
  const baseline: Json[] = [];
  for (const [name, extra] of [['sections', { aspects: [...BASE_ASPECTS] }], ['followup', { topics: REQUIREMENTS.slice(0, 4).map((r) => r.ladder[lang][0]!) }]] as [string, Partial<WorkIqQuestion>][]) {
    const t = process.hrtime.bigint();
    try {
      const out = await service.askSections({ ...q, ...extra });
      baseline.push({ name, wallMs: Math.round(ms(t)), sections: out.map((s) => ('error' in s ? { key: s.key, error: s.error } : { key: s.key, citations: s.citations.length, chars: s.answer.length, urls: s.citations.map((c) => hash(c.url)) })) });
    } catch (e) {
      baseline.push({ name, wallMs: Math.round(ms(t)), error: (e as { code?: string }).code ?? (e as Error).message });
    }
    console.log(`baseline ${name}: ${JSON.stringify(baseline.at(-1)).slice(0, 200)}`);
  }

  // C. Blind relevance grades from Foundry: per readiness item, and per compound topic.
  const grades: Record<string, Record<string, number>> = {};
  if (withJudge) {
    const needs = Object.fromEntries(REQUIREMENTS.map((r) => [r.key, r.ladder[lang].join(' / ')]));
    for (const r of REQUIREMENTS) {
      const pool2 = new Map<string, LiveHit>();
      for (const p of plan) if (p.keys.includes(r.key)) for (const h of live.get(p.id) ?? []) if (h.allowed && h.text) pool2.set(h.h, h);
      if (!pool2.size) continue;
      grades[r.key] = await judge(subject, needs[r.key]!, [...pool2.values()], lang);
      console.log(`judge ${r.key}: ${Object.keys(grades[r.key]!).length}/${pool2.size}`);
    }
    for (const [n, t] of compounds.entries()) {
      const pool2 = new Map<string, LiveHit>();
      for (const p of plan) if (p.group === `c${n}`) for (const h of live.get(p.id) ?? []) if (h.allowed && h.text) pool2.set(h.h, h);
      if (!pool2.size) continue;
      grades[`c${n}`] = await judge(subject, t, [...pool2.values()], lang);
      console.log(`judge c${n}: ${Object.keys(grades[`c${n}`]!).length}/${pool2.size}`);
    }
  }

  const file = save('run', {
    kind: 'run', at: new Date().toISOString(), cli: { version: session.serverVersion, route: cmd.args.includes('-y') ? 'npx' : 'direct' },
    concurrency, session: { openMs: Math.round(openMs), ...Object.fromEntries(Object.entries(session.marks).map(([k, v]) => [k, Math.round(v)])), fanoutWallMs: Math.round(fanoutWallMs) },
    compounds: compounds.map((t, n) => ({ group: `c${n}`, chars: t.length, asks: decompose(t, 99).length })),
    calls, baseline, grades,
  });
  report(file);
}

/* ---------- Report (offline) ---------- */

const SECTION_BUDGET = 6_000; // WORKIQ_SECTION_MAX_CHARS
const HEADER_CHARS = 120; // "[n] title (type, date) <url>" line per result in parseRetrieveResult

interface CallRec { id: string; exp: string; keys: readonly ReadinessKey[]; group?: string; latencyMs: number; startMs: number; ok: boolean; error: string | null; queryChars: number; payloadKeys: string[]; hitKeys: string[]; hits: Hit[] }

function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0; }
function pct(xs: number[], p: number) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : 0; }

/** The hits a section answer carries before parseRetrieveResult truncates it at the section budget. */
function truncated(hits: Hit[], budget = SECTION_BUDGET): Hit[] {
  const out: Hit[] = [];
  let used = 0;
  for (const h of hits) {
    if (used >= budget) break;
    out.push(h);
    used += HEADER_CHARS + h.chars + 2;
  }
  return out;
}

/** Reciprocal-rank fusion over the searches of one readiness item; Work IQ's own score breaks ties when present. */
function fuse(lists: Hit[][]): Hit[] {
  const score = new Map<string, { hit: Hit; s: number }>();
  for (const list of lists) list.forEach((h, r) => {
    const cur = score.get(h.h) ?? { hit: h, s: 0 };
    cur.s += 1 / (60 + r + 1) + (h.score ?? 0) * 1e-3;
    score.set(h.h, cur);
  });
  return [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.hit);
}

function evaluate(name: string, perKey: Map<ReadinessKey, Hit[]>, chars: number, grades: Record<string, Record<string, number>>) {
  const all = [...perKey.values()].flat();
  const unique = new Set(all.map((h) => h.h));
  let g2 = 0, g1 = 0, graded = 0, covered2 = 0, needMet = 0;
  const relevantUnique = new Set<string>();
  const directUnique = new Set<string>();
  for (const [key, hits] of perKey) {
    const gk = grades[key] ?? {};
    let k2 = 0, k1 = 0;
    for (const h of hits) {
      const g = gk[h.h];
      if (g === undefined) continue;
      graded++;
      if (g >= 1) { g1++; k1++; relevantUnique.add(h.h); }
      if (g === 2) { g2++; k2++; directUnique.add(h.h); }
    }
    if (k2 > 0) covered2++;
    const need = REQUIREMENTS.find((r) => r.key === key)?.need ?? 1;
    if (k1 >= need) needMet++;
  }
  return { name, included: all.length, unique: unique.size, duplicates: all.length - unique.size, chars, graded, relevant: g1, highly: g2, relevantUnique: relevantUnique.size, directUnique: directUnique.size, precision: graded ? +(g1 / graded).toFixed(2) : null, keysWithDirectEvidence: covered2, keysMeetingNeed: needMet };
}

function report(file?: string) {
  const path = file ?? readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.json')).sort().map((f) => join(OUT, f)).at(-1);
  if (!path) throw new Error('no run file');
  const run = JSON.parse(readFileSync(path, 'utf8')) as { calls: CallRec[]; grades: Record<string, Record<string, number>>; baseline: Json[]; session: Json; concurrency: number; compounds: Json[]; cli: Json };
  const startupFile = readdirSync(OUT).filter((f) => f.startsWith('startup-')).sort().at(-1);
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line(`# Work IQ bench report (${path.split(/[\\/]/).at(-1)})`);
  if (startupFile) {
    const st = JSON.parse(readFileSync(join(OUT, startupFile), 'utf8')) as { rows: { route: string; initializeMs: number; toolsListMs: number; totalMs: number }[] };
    line('\n## Start-up (tools/list only, not billed)');
    for (const route of [...new Set(st.rows.map((r) => r.route))]) {
      const rs = st.rows.filter((r) => r.route === route);
      line(`- ${route}: initialize median ${median(rs.map((r) => r.initializeMs))} ms, tools/list median ${median(rs.map((r) => r.toolsListMs))} ms, total median ${median(rs.map((r) => r.totalMs))} ms (n=${rs.length}; ${rs.map((r) => r.totalMs).join(', ')})`);
    }
  }
  const calls = run.calls;
  const fan = calls.filter((c) => c.exp === 'fanout');
  line(`\n## Latency (CLI ${String(run.cli.version)}, route ${String(run.cli.route)}, concurrency ${run.concurrency})`);
  line(`- session open ${String(run.session.openMs)} ms; fan-out of ${fan.length} searches wall ${String(run.session.fanoutWallMs)} ms`);
  const lat = calls.filter((c) => c.ok).map((c) => c.latencyMs);
  line(`- per-search latency (ok): median ${median(lat)} ms, p90 ${pct(lat, 0.9)} ms, max ${Math.max(...lat)} ms; errors ${calls.filter((c) => !c.ok).length}/${calls.length}`);
  for (const c of calls.filter((x) => !x.ok)) line(`  - ${c.id}: ${c.error}`);
  for (const b of run.baseline) {
    const secs = Array.isArray(b.sections) ? (b.sections as Json[]) : [];
    line(`- baseline ${String(b.name)} (fresh CLI, 2 at a time): wall ${String(b.wallMs)} ms, ${secs.length} sections, errors ${secs.filter((s) => s.error).length}${b.error ? `, failed: ${String(b.error)}` : ''}`);
  }
  const payloadKeys = [...new Set(calls.flatMap((c) => c.payloadKeys))];
  // Replays the measured fan-out latencies through a pool of n workers (assumes latency does not grow with n; measured
  // at 4 vs. the baseline's 2 it did not).
  const makespan = (lats: number[], n: number) => {
    const free = new Array(n).fill(0) as number[];
    for (const l of lats) { const i = free.indexOf(Math.min(...free)); free[i]! += l; }
    return Math.max(...free);
  };
  const fanLat = fan.map((c) => c.latencyMs);
  line(`- replay of the ${fan.length} fan-out latencies: ${[1, 2, 4, 6, 8].map((n) => `${n} at a time ${Math.round(makespan(fanLat, n) / 1000)} s`).join(', ')}; 8 section searches: ${[2, 4, 8].map((n) => `${n} at a time ${Math.round(makespan(fan.filter((c) => c.id.startsWith('aspect:')).map((c) => c.latencyMs), n) / 1000)} s`).join(', ')}`);
  const hitKeys = [...new Set(calls.flatMap((c) => c.hitKeys))];
  const scored = calls.flatMap((c) => c.hits).filter((h) => h.score !== null).length;
  line(`- payload keys: ${payloadKeys.join(', ')}; hit keys: ${hitKeys.join(', ')}; hits with a relevance score: ${scored}/${calls.flatMap((c) => c.hits).length}`);

  // Redundancy
  const byId = new Map(calls.map((c) => [c.id, c]));
  const aspectHits = BASE_ASPECTS.map((a) => byId.get(`aspect:${a}`)?.hits ?? []);
  const flatAspect = aspectHits.flat();
  line('\n## Redundancy');
  line(`- 8 section searches: ${flatAspect.length} hits, ${new Set(flatAspect.map((h) => h.h)).size} unique (${flatAspect.length ? Math.round(100 * (1 - new Set(flatAspect.map((h) => h.h)).size / flatAspect.length)) : 0}% duplicates)`);
  const fanHits = fan.flatMap((c) => c.hits);
  line(`- all ${fan.length} planned searches: ${fanHits.length} hits, ${new Set(fanHits.map((h) => h.h)).size} unique (${fanHits.length ? Math.round(100 * (1 - new Set(fanHits.map((h) => h.h)).size / fanHits.length)) : 0}% duplicates)`);

  // Selections under the same total character budget (8 × the section budget; text past a budget is cut, as in
  // parseRetrieveResult, so a hit counts only when it starts inside the budget).
  const keys = REQUIREMENTS.map((r) => r.key);
  const cost = (h: Hit) => HEADER_CHARS + h.chars + 2;
  const baselineSel = new Map<ReadinessKey, Hit[]>(keys.map((k) => [k, []]));
  let baselineChars = 0;
  BASE_ASPECTS.forEach((a, n) => {
    const t = truncated(aspectHits[n]!);
    baselineChars += Math.min(SECTION_BUDGET, t.reduce((s, h) => s + cost(h), 0));
    for (const k of ASPECT_KEYS[a]) baselineSel.get(k)!.push(...t);
  });
  const select = (lists: (k: ReadinessKey) => Hit[][], budget = SECTION_BUDGET) => {
    const taken = new Set<string>();
    const sel = new Map<ReadinessKey, Hit[]>();
    let chars = 0;
    for (const k of keys) {
      const picked: Hit[] = [];
      let used = 0;
      for (const h of fuse(lists(k))) {
        if (taken.has(h.h) || used >= budget) continue;
        taken.add(h.h);
        picked.push(h);
        used += cost(h);
      }
      chars += Math.min(budget, used);
      sel.set(k, picked);
    }
    return { sel, chars };
  };
  const mergeOnly = select((k) => BASE_ASPECTS.filter((a) => ASPECT_KEYS[a].includes(k)).map((a) => byId.get(`aspect:${a}`)?.hits ?? []));
  const planned = select((k) => fan.filter((c) => c.keys.includes(k)).map((c) => c.hits));
  const plannedWide = select((k) => fan.filter((c) => c.keys.includes(k)).map((c) => c.hits), 9_000);
  line('\n## Relevance at the same character budget (Foundry blind grades; 2 = directly answers, 1 = partly)');
  line('Item-level counts: a section that feeds two items (engagements → customers, engagements) is graded for both.');
  line('| selection | searches | hits | unique | duplicates | chars | relevant (≥1) | direct (2) | unique relevant docs | unique direct docs | precision | items with direct evidence | items meeting need |');
  line('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [sel, n] of [
    [evaluate('baseline: 8 sections, truncated, no dedupe', baselineSel, baselineChars, run.grades), 8],
    [evaluate('merge only: same 8 searches, dedupe + fused rank', mergeOnly.sel, mergeOnly.chars, run.grades), 8],
    [evaluate('planned fan-out: 32 searches, dedupe + fused rank', planned.sel, planned.chars, run.grades), fan.length],
    [evaluate('planned fan-out, 9,000 chars per item', plannedWide.sel, plannedWide.chars, run.grades), fan.length],
  ] as const) {
    line(`| ${sel.name} | ${n} | ${sel.included} | ${sel.unique} | ${sel.duplicates} | ${sel.chars} | ${sel.relevant} | ${sel.highly} | ${sel.relevantUnique} | ${sel.directUnique} | ${sel.precision} | ${sel.keysWithDirectEvidence}/8 | ${sel.keysMeetingNeed}/8 |`);
  }
  // Per ladder rung: what each wording adds that the section search did not find
  line('\n## Ladder wordings: new relevant evidence beyond the section searches');
  for (const r of REQUIREMENTS) {
    const g = run.grades[r.key] ?? {};
    const base = new Set(BASE_ASPECTS.filter((a) => ASPECT_KEYS[a].includes(r.key)).flatMap((a) => (byId.get(`aspect:${a}`)?.hits ?? []).map((h) => h.h)));
    const cells = [0, 1, 2].map((n) => {
      const c = byId.get(`ladder:${r.key}:${n}`);
      if (!c) return '-';
      if (!c.ok) return 'error';
      const fresh = c.hits.filter((h) => !base.has(h.h));
      return `${c.hits.length} hits, ${fresh.length} new, ${fresh.filter((h) => (g[h.h] ?? 0) >= 1).length} new relevant`;
    });
    line(`- ${r.key}: ${cells.join(' | ')}`);
  }
  // Compound vs decomposed
  line('\n## Compound gap topics vs. single asks');
  for (const c of run.compounds) {
    const grp = String(c.group);
    const g = run.grades[grp] ?? {};
    const comp = calls.filter((x) => x.group === grp && x.exp === 'compound');
    const single = calls.filter((x) => x.group === grp && x.exp === 'decomposed');
    const rel = (hs: Hit[]) => new Set(hs.filter((h) => (g[h.h] ?? 0) >= 1).map((h) => h.h)).size;
    const dir = (hs: Hit[]) => new Set(hs.filter((h) => g[h.h] === 2).map((h) => h.h)).size;
    const ch = comp.flatMap((x) => x.hits);
    const sh = single.flatMap((x) => x.hits);
    line(`- ${grp} (${String(c.chars)} chars, ${String(c.asks)} asks): compound ${comp.filter((x) => x.ok).length}/${comp.length} ok, ${new Set(ch.map((h) => h.h)).size} unique hits, ${rel(ch)} relevant, ${dir(ch)} direct, ${Math.max(0, ...comp.map((x) => x.latencyMs))} ms | singles ${single.filter((x) => x.ok).length}/${single.length} ok, ${new Set(sh.map((h) => h.h)).size} unique hits, ${rel(sh)} relevant, ${dir(sh)} direct, slowest ${Math.max(0, ...single.map((x) => x.latencyMs))} ms`);
  }
  const text = out.join('\n');
  console.log(text);
  writeFileSync(path.replace(/\.json$/, '.md'), `${text}\n`);
}

/* ---------- Needs: Agentic Retrieval effort levels on facts known to exist (ground truth in the saved pack) ---------- */

interface Need { id: string; kind: 'kpi' | 'engagement' | 'probe'; name: string; context: string; field: string; truth: string[] }

/** Number-like tokens a hit must contain to state the value ("$83.3M" → "83.3", "2026-06-09" → "2026-06-09"). */
function valueTokens(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  const dates = [...v.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
  if (dates.length) return dates;
  return [...v.normalize('NFKC').matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(/,/g, '')).filter((t) => t.length >= 2 || /\./.test(t));
}
const nameTerms = (n: string) => n.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4 && !['microsoft', 'innovation'].includes(t));

/** A hit states the fact when it contains the value and at least one distinctive word of the item's name. */
function states(hit: LiveHit, need: Need): boolean {
  const text = `${hit.title}\n${hit.text}`.normalize('NFKC').toLowerCase().replace(/(\d),(?=\d{3})/g, '$1');
  const terms = nameTerms(need.name);
  return need.truth.some((t) => text.includes(t.toLowerCase())) && (!terms.length || terms.some((t) => text.includes(t)));
}
const mentions = (hit: LiveHit, need: Need) => { const text = `${hit.title}\n${hit.text}`.toLowerCase(); const terms = nameTerms(need.name); return terms.length > 0 && terms.some((t) => text.includes(t)); };

function needsFromPack(projectId: string, max: number): { needs: Need[]; project: string; purpose: string } {
  const db = new DatabaseSync(join(RELAY_DIR, 'device.sqlite'), { readOnly: true });
  const row = db.prepare('select value from records where key = ?').get(`bas.binary.pack.${projectId}`) as { value?: string } | undefined;
  db.close();
  const pack = JSON.parse(row?.value ?? '{}') as Json;
  const ext = isObj(pack.extensions) ? pack.extensions : {};
  const gen = reportOf(projectId).inputs as Json;
  const en = (n: unknown) => (isObj(n) ? String(n.en ?? n.ja ?? '') : String(n ?? '')).trim();
  const okr = isObj(ext.okr) ? ext.okr : {};
  const units = new Map((Array.isArray(okr.orgUnits) ? okr.orgUnits : []).filter(isObj).map((u) => [String(u.id), en(u.name)]));
  const kpis = (Array.isArray(okr.kpis) ? okr.kpis : []).filter(isObj).flatMap((k, i): Need[] => {
    const truth = [...valueTokens(k.current), ...valueTokens(k.target)];
    return truth.length ? [{ id: `kpi-${i}`, kind: 'kpi', name: en(k.name), context: units.get(String(k.orgUnitId)) || String(gen.projectName), field: 'current value and target', truth }] : [];
  });
  const engs = (isObj(ext.engagements) && Array.isArray(ext.engagements.items) ? ext.engagements.items : []).filter(isObj).flatMap((x, i): Need[] => {
    const truth = valueTokens(x.period);
    return truth.length ? [{ id: `eng-${i}`, kind: 'engagement', name: en(x.name), context: String(x.customer ?? x.type ?? gen.projectName), field: 'date', truth }] : [];
  });
  const take = Math.ceil(max / 2);
  return { needs: [...kpis.slice(0, take), ...engs.slice(0, max - Math.min(take, kpis.length))], project: String(gen.projectName), purpose: String(gen.purpose) };
}

async function chat(system: string, user: string): Promise<Json> {
  const conn = JSON.parse(readFileSync(join(RELAY_DIR, 'connection.json'), 'utf8')) as { endpoint: string; deployment: string };
  const token = process.env.AZ_COG_TOKEN;
  if (!token) throw new Error('set AZ_COG_TOKEN (az account get-access-token --resource https://cognitiveservices.azure.com)');
  const res = await fetch(`${conn.endpoint.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(180_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: conn.deployment, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_completion_tokens: 2000, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const d = await res.json() as { choices?: { message?: { content?: string } }[] };
  return JSON.parse(d.choices?.[0]?.message?.content ?? '{}') as Json;
}

const PLAN_SYSTEM = 'You plan Microsoft 365 enterprise searches (Work IQ retrieve). Given a project and one information need, write 3 short, focused search queries that would find a document stating the fact: one natural question, one English keyword query (entity name + fact words + likely document types such as scorecard, dashboard, review, recap, newsletter), one variant with synonyms or the likely document context. Never include the value itself. Answer JSON only: {"queries":["...","...","..."]}.';
const JUDGE_SYSTEM = 'You check enterprise search results. For the information need, say whether any result text states the fact explicitly. If none does, write 2 new focused search queries (drill down or broaden; use what the results reveal, such as document names, teams or periods). Answer JSON only: {"sufficient":true|false,"queries":["...","..."]}.';

async function needs(projectId: string, max: number) {
  const { needs: list, project, purpose } = needsFromPack(projectId, max);
  if (!list.length) throw new Error('no facts with values in the saved pack');
  const session = await Session.open(workIqCliCommand());
  let calls = 0;
  const retrieve = async (query: string): Promise<LiveHit[]> => {
    calls++;
    const a = analyse(await session.request('tools/call', { name: 'retrieve', arguments: { query, strategy: 'grounding', timeZone: 'Asia/Tokyo' } }));
    return a.ok ? a.hits : [];
  };
  /** Reciprocal-rank fusion of several result lists (k = 60), deduplicated by URL. */
  const fuseHits = (lists: LiveHit[][]): LiveHit[] => {
    const score = new Map<string, { hit: LiveHit; s: number }>();
    for (const l of lists) l.forEach((h, r) => { const c = score.get(h.h); score.set(h.h, { hit: c?.hit ?? h, s: (c?.s ?? 0) + 1 / (61 + r) }); });
    return [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.hit);
  };
  const need = (n: Need) => `${n.name} (${n.context}): ${n.field}`;
  const run = async (n: Need) => {
    const t0 = Date.now();
    const minimal = await retrieve(`${n.name}: ${n.field}`);
    const graph = await retrieve(need(n));
    let planned: string[] = [];
    try { planned = ((await chat(PLAN_SYSTEM, `Project: ${project}\nPurpose: ${purpose.slice(0, 400)}\nNeed: ${need(n)}`)).queries as string[] ?? []).filter((q) => typeof q === 'string').slice(0, 3); } catch { planned = []; }
    const lowLists = await Promise.all(planned.map(retrieve));
    const low = fuseHits([graph, ...lowLists]);
    // Same number of searches without a model: is the gain the planning, or only the extra searches?
    const control = fuseHits([minimal, graph, await retrieve(n.name), await retrieve(`${n.name} ${n.field} report scorecard`)]);
    let medium = low;
    let retried = false;
    if (!low.slice(0, 10).some((h) => states(h, n))) {
      const shown = low.slice(0, 8).map((h, i) => `[${i + 1}] ${h.title}\n${h.text.slice(0, 600).replace(/\s+/g, ' ')}`).join('\n\n');
      try {
        const j = await chat(JUDGE_SYSTEM, `Project: ${project}\nNeed: ${need(n)}\n\n${shown || '(no results)'}`);
        const more = (Array.isArray(j.queries) ? j.queries : []).filter((q): q is string => typeof q === 'string').slice(0, 2);
        if (j.sufficient !== true && more.length) { retried = true; medium = fuseHits([low, ...(await Promise.all(more.map(retrieve)))]); }
      } catch { /* keep low */ }
    }
    const rank = (hs: LiveHit[]) => { const i = hs.findIndex((h) => states(h, n)); return i < 0 ? null : i + 1; };
    const prec = (hs: LiveHit[]) => { const top = hs.slice(0, 10); return top.length ? Math.round((100 * top.filter((h) => mentions(h, n)).length) / top.length) : 0; };
    return {
      id: n.id, kind: n.kind, queries: { minimal: 1, graph: 1, control: 4, low: 1 + planned.length, medium: 1 + planned.length + (retried ? 2 : 0) },
      found: { minimal: rank(minimal), graph: rank(graph), control: rank(control), low: rank(low), medium: rank(medium) },
      onTopicTop10: { minimal: prec(minimal), graph: prec(graph), control: prec(control), low: prec(low), medium: prec(medium) }, retried, sec: Math.round((Date.now() - t0) / 1000),
    };
  };
  const rows = await pool(list, 3, run);
  session.close();
  const levels = ['minimal', 'graph', 'control', 'low', 'medium'] as const;
  const sum = Object.fromEntries(levels.map((l) => [l, {
    found: rows.filter((r) => r.found[l] !== null).length,
    foundTop3: rows.filter((r) => (r.found[l] ?? 99) <= 3).length,
    onTopicTop10: Math.round(rows.reduce((a, r) => a + r.onTopicTop10[l], 0) / rows.length),
    searches: rows.reduce((a, r) => a + r.queries[l], 0),
  }]));
  const out = { kind: 'needs', at: new Date().toISOString(), needs: rows.length, byKind: { kpi: rows.filter((r) => r.kind === 'kpi').length, engagement: rows.filter((r) => r.kind === 'engagement').length }, workIqCalls: calls, sum, rows };
  console.log(JSON.stringify({ ...out, rows: undefined }, null, 1));
  for (const r of rows) console.log(r.id, JSON.stringify(r.found), r.retried ? 'retried' : '');
  save('needs', out);
}

/** The app's own follow-up path (WorkIqCliService.askSections with topics) against the former single search per topic. */
async function appNeeds(projectId: string, max: number) {
  const { needs: list, project, purpose } = needsFromPack(projectId, max);
  const gen = reportOf(projectId).inputs as Json;
  const q: WorkIqQuestion = { company: String(gen.companyName), project, purpose, focus: '', asOf: new Date().toISOString().slice(0, 10), lang: 'en', timeZone: 'Asia/Tokyo', aspects: [], topics: [], expand: false };
  const topicOf = (n: Need) => `${n.name}: ${n.field}`;
  const found = (text: string, n: Need) => states({ title: '', text } as LiveHit, n);
  const session = await Session.open(workIqCliCommand());
  const before = await pool(list, 4, async (n) => {
    const a = analyse(await session.request('tools/call', { name: 'retrieve', arguments: { query: workIqTopicQuery(q, topicOf(n)), strategy: 'grounding', timeZone: 'Asia/Tokyo' } }));
    return a.ok && a.hits.some((h) => states(h, n));
  });
  session.close();
  const svc = new WorkIqCliService();
  const after: boolean[] = [];
  try {
    for (let i = 0; i < list.length; i += 8) {
      const batch = list.slice(i, i + 8);
      const sections = await svc.askSections({ ...q, topics: batch.map(topicOf) });
      batch.forEach((n, j) => {
        const s = sections.find((x) => x.key === `topic-${j + 1}`);
        after.push(!!s && !('error' in s) && found(s.answer, n));
      });
    }
  } finally {
    svc.closeSession();
  }
  const out = { kind: 'needs-app', at: new Date().toISOString(), needs: list.length, before: before.filter(Boolean).length, after: after.filter(Boolean).length, rows: list.map((n, i) => ({ id: n.id, before: before[i], after: after[i] })) };
  console.log(JSON.stringify(out, null, 1));
  save('needs-app', out);
}

/* ---------- End-to-end: one real pack generation through the relay handlers (metrics only, nothing saved) ---------- */

/**
 * The values a deliverable needs, counted on the saved pack: "have/of". The same fields as the missing-data fill
 * (dataFill.ts findGaps) plus the KPI numbers, so a run that retrieves more can be judged by what reaches the pack.
 */
export function deliverableFacts(pack: Json): Json {
  const ents = (Array.isArray(pack.entities) ? pack.entities : []).filter(isObj) as Json[];
  const byId = new Map(ents.map((e) => [String(e.id), e]));
  const of = (k: string) => ents.filter((e) => e.kind === k);
  const has = (e: Json, f: string) => e[f] !== undefined && e[f] !== null && e[f] !== '';
  const num = (e: Json, f: string) => typeof e[f] === 'number' && Number.isFinite(e[f]);
  const owned = (e: Json) => (has(e, 'ownerId') && byId.get(String(e.ownerId))?.kind === 'person') || has(e, 'ownerRole');
  const count = (list: Json[], ok: (e: Json) => boolean) => `${list.filter(ok).length}/${list.length}`;
  const solutions = of('solution');
  const kpis = of('kpi');
  const inits = of('initiative');
  const sites = of('site');
  const plants = sites.filter((s) => s.role !== 'office');
  const products = of('product');
  const okr = isObj(pack.extensions) && isObj(pack.extensions.okr) ? pack.extensions.okr : {};
  const okrKpis = (Array.isArray(okr.kpis) ? okr.kpis : []).filter(isObj) as Json[];
  const missing = solutions.reduce((n, s) => n + (num(s, 'costJpy') ? 0 : 1) + (num(s, 'annualBenefitJpy') ? 0 : 1), 0)
    + [...kpis, ...inits].filter((e) => !owned(e)).length
    + sites.reduce((n, s) => n + (num(s, 'lat') ? 0 : 1) + (num(s, 'lon') ? 0 : 1), 0) + plants.filter((s) => !num(s, 'capacityTPerMonth')).length
    + products.reduce((n, p) => n + (num(p, 'unitPriceJpy') ? 0 : 1) + (has(p, 'siteId') ? 0 : 1), 0);
  return {
    solutionCost: count(solutions, (s) => num(s, 'costJpy')), solutionBenefit: count(solutions, (s) => num(s, 'annualBenefitJpy')),
    kpiOwner: count(kpis, owned), kpiNumbers: count(kpis, (k) => num(k, 'baseline') && num(k, 'target')),
    initiativeOwner: count(inits, owned), initiativeDates: count(inits, (x) => has(x, 'start') && has(x, 'end')),
    siteCoords: count(sites, (s) => num(s, 'lat') && num(s, 'lon')), plantCapacity: count(plants, (s) => num(s, 'capacityTPerMonth')),
    productPrice: count(products, (p) => num(p, 'unitPriceJpy')), productSite: count(products, (p) => has(p, 'siteId')),
    okrKpiTarget: count(okrKpis, (k) => has(k, 'target')), okrKpiCurrent: count(okrKpis, (k) => has(k, 'current')),
    missing,
  };
}

async function pipeline(projectId: string, rounds: number, provider: 'foundry' | 'copilotSdk' = 'foundry', keep = false) {
  const g = reportOf(projectId);
  const i = g.inputs as Json;
  const lang = i.lang === 'en' ? 'en' : 'ja';
  const { createServer } = await import('vite');
  const server = await createServer({ root: ROOT, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false } });
  try {
    const relay = await server.ssrLoadModule('/server/relay.ts') as typeof import('../server/relay.ts');
    const vaultMod = await server.ssrLoadModule('/server/vault.ts') as typeof import('../server/vault.ts');
    const newsMod = await server.ssrLoadModule('/server/news.ts') as typeof import('../server/news.ts');
    const cliMod = await server.ssrLoadModule('/server/workiqCli.ts') as typeof import('../server/workiqCli.ts');
    const gen = await server.ssrLoadModule('/src/modules/project/packGenerate.ts') as typeof import('../src/modules/project/packGenerate.ts');
    const budget = await server.ssrLoadModule('/src/ai/budget.ts') as typeof import('../src/ai/budget.ts');
    const policy = await server.ssrLoadModule('/src/ai/policy.ts') as typeof import('../src/ai/policy.ts');
    const ready = await server.ssrLoadModule('/src/modules/project/analysisReadiness.ts') as typeof import('../src/modules/project/analysisReadiness.ts');
    const vault = new vaultMod.SecretVault(RELAY_DIR);
    const token = relay.newRelayToken();
    const port = 4173;
    const workiqCli = new cliMod.WorkIqCliService();
    const ctx = { vault, token, config: relay.STRICT_RELAY_CONFIG, lastCall: new Map<string, number>(), news: new newsMod.NewsService(), workiq: relay.workIqServiceFor(vault), workiqCli };
    const post = async (path: string, body: unknown, signal: AbortSignal): Promise<Json> => {
      const r = await relay.handleRelay({
        method: 'POST', url: path, remoteAddress: '127.0.0.1', localPort: port, body: JSON.stringify(body),
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'x-bas-relay': token, 'content-type': 'application/json' },
      }, { ...ctx, signal });
      const b = (isObj(r.body) ? r.body : {}) as Json;
      if (r.status !== 200) throw Object.assign(new Error(`${path} ${r.status} ${String(b.error ?? '')} ${String(b.providerStatus ?? '')}`), { code: String(b.error ?? r.status) });
      return b;
    };
    const input = {
      companyName: String(i.companyName), projectName: String(i.projectName), purpose: String(i.purpose), asOf: new Date().toISOString().slice(0, 10), lang,
      industry: String(i.industry ?? ''), officialUrl: String(i.officialUrl ?? ''), focus: String(i.focus ?? ''), materials: [], researchNote: String(i.researchNote ?? ''),
      useNews: i.useNews === true, useWorkIq: true, workIqRounds: rounds,
    } as import('../src/modules/project/packGenerate.ts').PackGenInput;
    const t0 = Date.now();
    const marks: { at: number; step: string; status: string; round?: number }[] = [];
    let wiqMs = 0;
    let wiqCalls = 0;
    const shapes: Json[] = [];
    const gate: Json[] = [];
    const problems: Json[] = [];
    const sectionsKept: unknown[] = [];
    const r = await gen.generatePack(input, {
      provider,
      complete: async (prompt, signal, stage) => {
        // The app's own sending gate (src/ai/client.ts preflight): the same estimate and per-call limit as in the browser.
        const estimated = budget.estimateTokens(prompt);
        const limit = policy.PER_USE_LIMITS.packBuild?.maxInputTokens ?? Infinity;
        console.log(`${Math.round((Date.now() - t0) / 1000)} s call ${stage} (${prompt.length} chars, estimated ${estimated} tokens${estimated > limit ? ', BLOCKED IN THE APP' : ''})`);
        gate.push({ stage, chars: prompt.length, estimatedTokens: estimated, blockedInApp: estimated > limit, overRelayChars: prompt.length > (relay.MAX_AI_CHARS_BY_USE.packBuild ?? 0) });
        if (stage.startsWith('fix-')) {
          // Problems verify reported before this fix (codes and paths; quoted ids and values redacted).
          const head = lang === 'ja' ? '# 問題\n' : '# Problems\n';
          const from = prompt.indexOf(head);
          const block = from >= 0 ? prompt.slice(from + head.length, prompt.indexOf('\n# ', from + head.length)) : '';
          problems.push({ stage, list: block.split('\n').filter(Boolean).map((l) => l.replace(/"[^"]*"/g, '"…"').replace(/\(([a-z]+)-[^)]*\)/g, '($1-…)').slice(0, 160)) });
        }
        const b = await post('/relay/ai', { use: 'packBuild', provider, lang, prompt, maxOutputTokens: policy.PER_USE_LIMITS.packBuild?.maxOutputTokens, timeoutMs: policy.PACK_BUILD_TIMEOUT_MS }, signal);
        try {
          const a = JSON.parse(String(b.text ?? '{}')) as Json;
          const ents = Array.isArray(a.entities) ? (a.entities as Json[]) : [];
          const kinds = (k: string) => ents.filter((e) => e.kind === k).length;
          const okr = isObj(a.extensions) && isObj(a.extensions.okr) ? a.extensions.okr : {};
          shapes.push({ stage, readiness: stage.startsWith('fix-') ? undefined : ready.REQUIREMENTS.map((x) => `${x.key}:${ready.readinessCount(a, x.key)}`).join(' '),
            kpi: kinds('kpi'), okrKpis: Array.isArray(okr.kpis) ? okr.kpis.length : 0, okrObjectives: Array.isArray(okr.objectives) ? okr.objectives.length : 0,
            deal: kinds('deal'), initiative: kinds('initiative'), deliverable: kinds('deliverable'), customer: kinds('customer'), solution: kinds('solution'),
            remove: Array.isArray(a.remove) ? (a.remove as unknown[]).map((x) => String(x).replace(/^([a-z]+)-.*/, '$1-…')) : undefined,
            sections: isObj(a.sections) ? Object.fromEntries(Object.entries(a.sections).map(([k, v]) => [k, v === null ? null : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k2, v2]) => [k2, v2 === null ? null : Array.isArray(v2) ? `array(${v2.length})` : typeof v2])) : typeof v])) : undefined });
        } catch { shapes.push({ stage, unparsed: true }); }
        return { text: String(b.text ?? ''), inputTokens: Number(b.inputTokens ?? 0), outputTokens: Number(b.outputTokens ?? 0) };
      },
      fetchSite: (url, signal, terms) => post('/relay/site', { url, ...(terms?.length ? { terms } : {}) }, signal) as never,
      fetchNews: (company, l, signal) => post('/relay/news', { company, lang: l }, signal) as never,
      fetchWorkIq: async (q, signal) => {
        const t = Date.now();
        try {
          const b = await post('/relay/workiq/ask', { provider, ...q, aspects: q.aspects ?? [], topics: q.topics ?? [], timeZone: 'Asia/Tokyo' }, signal);
          const got = (Array.isArray(b.sections) ? b.sections : b) as never;
          if (keep) sectionsKept.push(got);
          return got;
        } finally {
          wiqMs += Date.now() - t;
          wiqCalls++;
        }
      },
    }, (e) => {
      marks.push({ at: Date.now() - t0, step: e.step, status: e.status, ...(e.collectRound ? { round: e.collectRound } : {}) });
      if (e.status !== 'running' || e.collectRound) console.log(`${Math.round((Date.now() - t0) / 1000)} s ${e.step} ${e.status}${e.collectRound ? ` round ${e.collectRound} unmet ${e.unmet?.length}` : ''}`);
    }, new AbortController().signal).catch((err: unknown) => {
      workiqCli.closeSession();
      console.log(`failed after ${Math.round((Date.now() - t0) / 1000)} s: ${(err as Error).message} ${String((err as { detail?: string }).detail ?? '')}`);
      throw err;
    });
    workiqCli.closeSession();
    const rep = r.report;
    const cites = rep.retrieved.filter((x) => x.kind === 'workiq').flatMap((x) => x.citations ?? []);
    const out = {
      kind: 'pipeline', at: new Date().toISOString(), rounds, wallSec: Math.round((Date.now() - t0) / 1000),
      llmSec: Math.round(rep.calls.reduce((n, c) => n + c.ms, 0) / 1000), workIqSec: Math.round(wiqMs / 1000), workIqRequests: wiqCalls,
      calls: rep.calls.map((c) => ({ stage: c.stage, sec: Math.round(c.ms / 1000), inputTokens: c.inputTokens, outputTokens: c.outputTokens })),
      steps: marks.filter((m) => m.status === 'done' || m.round).map((m) => ({ ...m, at: Math.round(m.at / 1000) })),
      workiqSources: rep.retrieved.filter((x) => x.kind === 'workiq').length, citations: cites.length, uniqueCitations: new Set(cites.map((c) => c.url)).size,
      retrievalErrors: rep.retrievalErrors.map((e) => `${e.what}:${e.error}`.slice(0, 60)),
      collectionRounds: (rep.collectionRounds ?? []).map((x) => ({ s: x.stage, r: x.round, unmet: x.unmet.length, topics: x.topics.length, newSrc: x.newSources.length, rerun: x.rerun, adopted: x.adopted, err: x.error })),
      stopReasons: rep.stopReasons, readinessMet: `${(rep.readiness ?? []).filter((x) => x.met).length}/${(rep.readiness ?? []).length}`,
      readiness: (rep.readiness ?? []).map((x) => `${x.key}:${x.have}/${x.need}`), verifyOk: r.verify.ok, entities: Array.isArray(r.pack.entities) ? r.pack.entities.length : 0,
      // What verify/prune removed and which cited sources were not the app's own (paths and causes only).
      removed: rep.removed.map((x) => `${x.path.replace(/^entities\.([a-z]+)-.*/, 'entities.$1-…')}: ${x.reason.slice(0, 90)}`),
      droppedSources: rep.droppedSources, ungrounded: rep.ungrounded.length, fixRounds: rep.fixRounds, shapes, gate, problems,
      blockedInApp: gate.filter((g) => g.blockedInApp).length, maxEstimatedTokens: Math.max(0, ...gate.map((g) => Number(g.estimatedTokens))),
      deliverable: deliverableFacts(r.pack),
    };
    console.log(JSON.stringify(out, null, 1));
    save('pipeline', out);
    // --keep: the pack and the Work IQ answers stay on this machine (logs/ is git-ignored) for the recall audit.
    if (keep) save('kept', { pack: r.pack, workiq: sectionsKept, report: rep });
  } finally {
    await server.close();
  }
}

/* ---------- Which engagement facts Microsoft 365 actually states (feasibility of the readiness options) ---------- */

const FACTS = ['name', 'dateOrPeriod', 'customerOrPartner', 'status', 'owner', 'count', 'money', 'progressPercent', 'outcome'] as const;

async function fields(projectId: string) {
  const g = reportOf(projectId);
  const i = g.inputs as Json;
  const lang = i.lang === 'en' ? 'en' : 'ja';
  const q: WorkIqQuestion = {
    company: String(i.companyName), project: String(i.projectName), purpose: String(i.purpose), focus: String(i.focus ?? ''),
    asOf: new Date().toISOString().slice(0, 10), lang, timeZone: 'Asia/Tokyo', aspects: [], topics: [], expand: false,
  };
  const queries = [workIqAspectQuery(q, 'engagements'), ...REQUIREMENTS.find((r) => r.key === 'engagements')!.ladder[lang].map((w) => workIqTopicQuery(q, w))];
  const session = await Session.open(workIqCliCommand());
  const hits = new Map<string, LiveHit>();
  const perQuery = await pool(queries, 4, async (query) => {
    const a = analyse(await session.request('tools/call', { name: 'retrieve', arguments: { query, strategy: 'grounding', timeZone: q.timeZone } }));
    for (const h of a.hits) if (h.allowed && h.text && !hits.has(h.h)) hits.set(h.h, h);
    return { ok: a.ok, hits: a.hits.length };
  });
  session.close();
  console.log(`searches ${queries.length}: ${perQuery.map((p) => (p.ok ? p.hits : 'error')).join(', ')}; unique readable hits ${hits.size}`);

  // Foundry lists what each text itself describes, with the facts it states; it never infers a value.
  const { conn, key } = await (access ??= foundryAccess());
  const list = [...hits.values()].map((x) => `[${x.h}] (${x.type ?? '?'}${x.date ? `, ${x.date}` : ''}) ${x.title}\n${x.text.slice(0, 1500).replace(/\s+/g, ' ')}`).join('\n\n');
  const system = [
    'You audit enterprise documents for an analyst. For each result id, list the distinct engagements the text itself describes: customer workshops, briefings, envisioning sessions, PoCs or pilots, deals or opportunities, programmes or initiatives, deliverables.',
    `For each, give type (workshop|briefing|poc|deal|programme|deliverable|other) and, for each fact, true only when the text states it explicitly for that engagement: ${FACTS.join(', ')}.`,
    'money means any amount of money (value, price, cost, budget, revenue, benefit). progressPercent means a stated percentage or fraction of completion. count means a stated number of sessions, participants or occurrences. outcome means a stated result or decision.',
    'Do not infer. Do not include general statements without a specific engagement. Answer JSON only: {"items":[{"id":"<result id>","type":"...","facts":{"name":true,...}}]}.',
  ].join(' ');
  const res = await fetch(foundryChatUrl(conn), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000),
    headers: { ...(isFoundryV1(conn.endpoint) ? { Authorization: `Bearer ${key}` } : { 'api-key': key }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: `Subject: ${q.project} (${q.company})\n\n${list}` }], ...(isFoundryV1(conn.endpoint) ? { model: conn.deployment } : {}), max_completion_tokens: 16_000, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`extraction HTTP ${res.status}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const items = ((JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as { items?: unknown }).items ?? []) as { id?: string; type?: string; facts?: Record<string, unknown> }[];
  const valid = items.filter((x) => typeof x.id === 'string' && hits.has(x.id));
  const has = (x: (typeof valid)[number], f: string) => x.facts?.[f] === true;
  const byType: Record<string, number> = {};
  for (const x of valid) byType[String(x.type ?? 'other')] = (byType[String(x.type ?? 'other')] ?? 0) + 1;
  const facts = Object.fromEntries(FACTS.map((f) => [f, valid.filter((x) => has(x, f)).length]));
  // What each target shape needs from the text (references to other entities aside).
  const shapes = {
    deal: valid.filter((x) => has(x, 'name') && has(x, 'money') && has(x, 'customerOrPartner') && has(x, 'dateOrPeriod') && has(x, 'owner')).length,
    initiativeWithSolution: valid.filter((x) => has(x, 'name') && has(x, 'dateOrPeriod') && has(x, 'progressPercent') && has(x, 'owner') && has(x, 'money')).length,
    initiativeRelaxed: valid.filter((x) => has(x, 'name') && has(x, 'dateOrPeriod') && has(x, 'owner')).length,
    activityRecord: valid.filter((x) => has(x, 'name') && (has(x, 'dateOrPeriod') || has(x, 'customerOrPartner') || has(x, 'status'))).length,
  };
  const out = { kind: 'fields', at: new Date().toISOString(), searches: perQuery, hits: hits.size, hitsWithEngagements: new Set(valid.map((x) => x.id)).size, engagements: valid.length, byType, facts, shapes };
  console.log(JSON.stringify(out, null, 1));
  save('fields', out);
}

/* ---------- Recall: which named facts of the Work IQ answers reach the pack ---------- */

const GENERIC = new Set(['FY27', 'FY26', 'Microsoft', 'Innovation', 'Hub', 'Work', 'IQ', 'SharePoint', 'Teams', 'Copilot', 'Meeting', 'Email', 'Outlook', 'PowerPoint', 'Excel', 'Word', 'Customer', 'Journey', 'Azure', 'AI', 'KPI', 'OKR', 'STU', 'SE', 'Japan']);

/** Distinct proper names in a text: Latin names, katakana words and Japanese company names. */
function namesIn(text: string): string[] {
  const out = new Set<string>();
  const clean = text.replace(/https?:\/\/\S*/g, ' ');
  for (const m of clean.matchAll(/\b[A-Z][A-Za-z0-9&.-]{2,}(?: [A-Z][A-Za-z0-9&.-]{2,}){0,2}/g)) {
    const t = m[0].replace(/[.-]+$/, '');
    if (!GENERIC.has(t) && !/^(?:FY|Q)\d/.test(t) && !/^(?:The|This|That|These|Those|And|For|With)\b/.test(t)) out.add(t);
  }
  for (const m of clean.matchAll(/[ァ-ヶー]{4,}/g)) out.add(m[0]);
  for (const m of clean.matchAll(/[\p{Script=Han}ぁ-んァ-ヶー]{2,12}(?:株式会社|ホールディングス|製鋼所|銀行|電力|工業|自動車|製作所|ガス|鉄道|商事|物産|生命|保険)/gu)) out.add(m[0]);
  return [...out];
}

/** Share of each section's names that appear anywhere in the pack outside its source entries (counts only are saved). */
function recall(file?: string) {
  const f = file ?? readdirSync(OUT).filter((n) => n.startsWith('kept-')).sort().pop();
  if (!f) throw new Error('no kept-*.json: run pipeline --keep first');
  const kept = JSON.parse(readFileSync(f.includes('/') || f.includes('\\') ? f : join(OUT, f), 'utf8')) as { pack: Json; workiq: unknown[] };
  const pack: Json = { ...kept.pack, entities: (Array.isArray(kept.pack.entities) ? kept.pack.entities as Json[] : []).filter((e) => e.kind !== 'source') };
  const ext = isObj(pack.extensions) ? { ...pack.extensions } : {};
  delete ext.collection;
  const haystack = JSON.stringify({ ...pack, extensions: ext }).toLowerCase();
  const sections = kept.workiq.flatMap((x) => (Array.isArray(x) ? x : [x])).filter(isObj) as Json[];
  const byKey = new Map<string, Set<string>>();
  for (const s of sections) {
    if (typeof s.answer !== 'string') continue;
    const key = String(s.key).replace(/^[ab]\d*-/, '');
    const set = byKey.get(key) ?? new Set<string>();
    for (const n of namesIn(s.answer)) set.add(n);
    byKey.set(key, set);
  }
  const rows = [...byKey].map(([key, names]) => {
    const list = [...names];
    const hit = list.filter((n) => haystack.includes(n.toLowerCase()));
    return { key, names: list.length, inPack: hit.length, recall: list.length ? Math.round((hit.length / list.length) * 100) : null, missed: list.filter((n) => !hit.includes(n)) };
  });
  const total = rows.reduce((a, r) => ({ names: a.names + r.names, inPack: a.inPack + r.inPack }), { names: 0, inPack: 0 });
  const kinds: Record<string, number> = {};
  for (const e of Array.isArray(kept.pack.entities) ? kept.pack.entities as Json[] : []) kinds[String(e.kind)] = (kinds[String(e.kind)] ?? 0) + 1;
  for (const r of rows) console.log(`${r.key.padEnd(28)} names=${String(r.names).padStart(3)} inPack=${String(r.inPack).padStart(3)} recall=${r.recall}%  missed: ${r.missed.slice(0, 12).join(' / ')}`);
  console.log(`TOTAL names=${total.names} inPack=${total.inPack} recall=${Math.round((total.inPack / Math.max(1, total.names)) * 100)}%`, JSON.stringify(kinds));
  save('recall', { kind: 'recall', file: f, total, kinds, rows: rows.map(({ missed, ...r }) => r) });
}

/* ---------- CLI ---------- */

const [cmdName, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
try {
  if (cmdName === 'startup') await startup(Number(flag('runs') ?? 3));
  else if (cmdName === 'run') {
    const project = flag('project');
    if (!project) throw new Error('--project <pj-id> is required');
    await run(project, Number(flag('concurrency') ?? 4), Number(flag('max-calls') ?? 60), rest.includes('--judge'));
  } else if (cmdName === 'pipeline') {
    const project = flag('project');
    if (!project) throw new Error('--project <pj-id> is required');
    await pipeline(project, Number(flag('rounds') ?? 3), flag('provider') === 'copilotSdk' ? 'copilotSdk' : 'foundry', rest.includes('--keep'));
  } else if (cmdName === 'fields') {
    const project = flag('project');
    if (!project) throw new Error('--project <pj-id> is required');
    await fields(project);
  } else if (cmdName === 'needs') {
    const project = flag('project');
    if (!project) throw new Error('--project <pj-id> is required');
    if (rest.includes('--app')) await appNeeds(project, Number(flag('max') ?? 24));
    else await needs(project, Number(flag('max') ?? 20));
  } else if (cmdName === 'recall') recall(rest[0]);
  else if (cmdName === 'report') report(rest[0]);
  else console.log('usage: node scripts/workiq-bench.ts startup [--runs 3] | run --project <pj-id> [--concurrency 4] [--max-calls 60] [--judge] | pipeline --project <pj-id> [--rounds 3] | fields --project <pj-id> | report [<run.json>]');
  process.exit(0);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
