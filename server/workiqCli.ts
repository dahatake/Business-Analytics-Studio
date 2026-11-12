import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKIQ_ITEM_MAX_CHARS, WORKIQ_MAX_ANSWER_CHARS, WORKIQ_SECTION_MAX_CHARS } from '../src/ai/policy.ts';
import { REQUIREMENTS } from '../src/modules/project/analysisReadiness.ts';
import { WORKIQ_TIMEOUT_MS, WorkIqError, workIqPlan, type WorkIqAnswer, type WorkIqCitation, type WorkIqErrorCode, type WorkIqQuestion, type WorkIqSectionAnswer } from './workiq.ts';

/**
 * D-14 (user, 2026-11-11), second route: Microsoft's own Work IQ CLI (`@microsoft/workiq`) as a local MCP stdio server.
 * When the tenant cannot enable Work IQ for a custom app registration (no admin consent for the REST route), the CLI
 * still reaches `https://workiq.svc.cloud.microsoft/mcp` with Microsoft's published client and the user's Windows
 * (WAM) or browser sign-in. The relay only speaks MCP to it: `retrieve` (grounding, read-only) for the customer pack
 * and the verification, and `accept_eula` when the user presses the button for it. BAS never sees a token.
 *
 * Contract: learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/retrieve (structuredContent →
 * application/vnd.ms-workiq.retrieval: markdown, retrievalHits[].webUrl, stoppedReason) and github.com/microsoft/work-iq.
 */

export const WORKIQ_CLI_PACKAGE = '@microsoft/workiq@1';
export const WORKIQ_EULA_URL = 'https://github.com/microsoft/work-iq';
const RETRIEVAL_KEY = 'application/vnd.ms-workiq.retrieval';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_CITATIONS = 30;
const STOP_GRACE_MS = 2_000;

export interface WorkIqCliCommand {
  command: string;
  args: string[];
  /** Only for the `npx.cmd` fallback on Windows; the command line is fixed (no user input). */
  shell: boolean;
}

/**
 * How the relay starts the CLI's MCP server. `BAS_WORKIQ_CLI` points at an installed `workiq` executable (or a .js/.mjs
 * entry run with this Node); otherwise npm's own npx next to this Node runs the pinned package, as VS Code does.
 */
export function workIqCliCommand(env: Record<string, string | undefined> = process.env, execPath = process.execPath, platform: NodeJS.Platform = process.platform): WorkIqCliCommand {
  const override = env.BAS_WORKIQ_CLI?.trim();
  if (override) {
    return /\.[cm]?js$/i.test(override) ? { command: execPath, args: [override, 'mcp'], shell: false } : { command: override, args: ['mcp'], shell: false };
  }
  const npxCli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (existsSync(npxCli)) return { command: execPath, args: [npxCli, '-y', WORKIQ_CLI_PACKAGE, 'mcp'], shell: false };
  return platform === 'win32'
    ? { command: 'npx.cmd', args: ['-y', WORKIQ_CLI_PACKAGE, 'mcp'], shell: true }
    : { command: 'npx', args: ['-y', WORKIQ_CLI_PACKAGE, 'mcp'], shell: false };
}

/* ---------- Query (built from structured fields, as for the REST route) ---------- */

/** A search request, not a prompt: `retrieve` returns evidence and Foundry writes the pack from it. */
export function workIqRetrieveQuery(q: WorkIqQuestion): string {
  return q.lang === 'ja'
    ? `顧客「${q.company}」に関するメール・会議・Teams・ファイルの事実（Project「${q.project}」、目的: ${q.purpose}${q.focus ? `、重点: ${q.focus}` : ''}、${q.asOf} 時点）: 企業の概要、取引関係、関係者の役割、課題、KPI と数値、商談・提案・成果物`
    : `Facts about the customer "${q.company}" in mail, meetings, Teams and files (project "${q.project}", purpose: ${q.purpose}${q.focus ? `; focus: ${q.focus}` : ''}; as of ${q.asOf}): company overview, relationships, roles, issues, KPIs and figures, deals, proposals and deliverables`;
}

export const WORKIQ_CLI_VERIFY_QUERY = 'My most recent Microsoft 365 file, meeting or email';

/* ---------- Tool results ---------- */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function texts(result: Json): string[] {
  return Array.isArray(result.content)
    ? result.content.filter((c): c is Json => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string)
    : [];
}

/** The EULA gate answers with plain text (no isError) that points at accept_eula. */
function needsEula(result: Json): boolean {
  return texts(result).some((t) => /accept_eula|\bEULA\b/i.test(t));
}

function retrievalPayload(result: Json): Json | null {
  const isPayload = (v: Json) => typeof v.markdown === 'string' || Array.isArray(v.retrievalHits) || Array.isArray(v.results);
  if (isObj(result.structuredContent)) {
    const sc = result.structuredContent;
    if (isObj(sc[RETRIEVAL_KEY])) return sc[RETRIEVAL_KEY] as Json;
    if (isPayload(sc)) return sc;
  }
  for (const t of texts(result)) {
    try {
      const v = JSON.parse(t) as unknown;
      if (isObj(v) && isObj(v[RETRIEVAL_KEY])) return v[RETRIEVAL_KEY] as Json;
      if (isObj(v) && isPayload(v)) return v;
    } catch {
      // not JSON
    }
  }
  return null;
}

function errorFromText(text: string): WorkIqError {
  if (/\b401\b|unauthori[sz]ed|sign[- ]?in|login|authenticat|token/i.test(text)) return new WorkIqError('notSignedIn');
  if (/\b403\b|forbidden|consent|denied|policy|licen[cs]e|not (?:enabled|subscribed)|billing/i.test(text)) return new WorkIqError('workiqForbidden');
  if (/\b429\b|throttl|too many/i.test(text)) return new WorkIqError('workiqBusy');
  if (/time[d ]?out|\b504\b/i.test(text)) return new WorkIqError('workiqTimeout');
  return new WorkIqError('workiqUnavailable');
}

function hitMeta(hit: Json): { title: string | null; date: string | null } {
  const meta = isObj(hit.resourceMetadata) ? hit.resourceMetadata : {};
  for (const v of Object.values(meta)) {
    if (isObj(v)) {
      const title = v.title ?? v.subject ?? v.name ?? v.displayName;
      const date = v.occurrenceTime ?? v.sentTime ?? v.startTime ?? v.lastModifiedDateTime ?? v.createdDateTime;
      return {
        title: typeof title === 'string' && title.trim() ? title.trim().replace(/\s+/g, ' ').slice(0, 200) : null,
        date: typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date.slice(0, 10) : null,
      };
    }
  }
  return { title: null, date: null };
}

function httpsUrl(v: unknown): URL | null {
  if (typeof v !== 'string') return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/**
 * `retrieve` result → the same answer shape as the REST route. Two payload shapes are read:
 * - documented (learn.microsoft.com …/work-iq/mcp/retrieve): top-level `markdown` with `[^hN]` refs and `retrievalHits[]`;
 * - observed from @microsoft/workiq 1.0.x (2026-11-11): `results[]`, each with its own `markdown`, `webUrl`,
 *   `resourceMetadata`, `sensitivityLabel` and `contentProtection`.
 * A result whose `contentProtection` is not "allowed" keeps its citation but its text is not passed on.
 */
export function parseRetrieveResult(result: unknown, question: string, fetchedAt: string, maxChars = WORKIQ_MAX_ANSWER_CHARS): WorkIqAnswer {
  const { markdown: top, entries } = readRetrieve(result);
  const seen = new Set<string>();
  const citations: WorkIqCitation[] = [];
  const labels: string[] = [];
  const sections: string[] = [];
  if (top) sections.push(top);
  for (const e of entries) {
    if (e.label && !labels.includes(e.label)) labels.push(e.label);
    if (!e.url || seen.has(e.url.href) || citations.length >= MAX_CITATIONS) continue;
    seen.add(e.url.href);
    citations.push({ title: e.title, url: e.url.href });
    if (!e.result) continue;
    const head = heading(citations.length, e, e.url.href);
    sections.push(e.body ? `${head}\n${e.body}` : head);
  }
  const markdown = sections.join('\n\n');
  const answer = markdown.length > maxChars ? `${markdown.slice(0, maxChars)}…` : markdown;
  return { question, answer, citations, sensitivity: labels.length ? labels.join(', ').slice(0, 100) : null, fetchedAt };
}

interface RetrieveEntry {
  url: URL | null;
  title: string;
  kind: string;
  date: string | null;
  label: string | null;
  /** Text passed on (empty when contentProtection is not "allowed", and for documented `retrievalHits`). */
  body: string;
  /** From `results[]` (has its own text and heading) rather than citation-only `retrievalHits[]`. */
  result: boolean;
}

/** The `retrieve` payload as entries in Work IQ's order; tool errors and the EULA gate are thrown as WorkIqError. */
function readRetrieve(result: unknown): { markdown: string; entries: RetrieveEntry[] } {
  if (!isObj(result)) throw new WorkIqError('badWorkiqResponse');
  const payload = retrievalPayload(result);
  if (!payload && needsEula(result)) throw new WorkIqError('workiqEulaRequired');
  if (result.isError === true) throw errorFromText([...texts(result), payload ? String(payload.error ?? payload.errorCode ?? '') : ''].join('\n'));
  if (!payload) throw new WorkIqError('badWorkiqResponse');
  if (payload.stoppedReason === 'error') throw errorFromText(`${String(payload.errorCode ?? '')} ${String(payload.error ?? '')}`);
  const entry = (hit: Json, isResult: boolean): RetrieveEntry => {
    const url = httpsUrl(hit.webUrl);
    const { title, date } = hitMeta(hit);
    const label = isObj(hit.sensitivityLabel) && typeof hit.sensitivityLabel.displayName === 'string' ? hit.sensitivityLabel.displayName.trim() : '';
    const allowed = hit.contentProtection === undefined || hit.contentProtection === 'allowed';
    return {
      url, title: title ?? url?.hostname ?? '', kind: typeof hit.entityType === 'string' ? hit.entityType.slice(0, 40) : '', date, label: label || null,
      body: isResult && allowed && typeof hit.markdown === 'string' ? hit.markdown.trim() : '', result: isResult,
    };
  };
  return {
    markdown: typeof payload.markdown === 'string' ? payload.markdown.trim() : '',
    entries: [
      ...(Array.isArray(payload.retrievalHits) ? payload.retrievalHits : []).filter(isObj).map((h) => entry(h, false)),
      ...(Array.isArray(payload.results) ? payload.results : []).filter(isObj).map((h) => entry(h, true)),
    ],
  };
}

function heading(n: number, e: Pick<RetrieveEntry, 'title' | 'kind' | 'date'>, url: string): string {
  return `[${n}] ${e.title}${e.kind ? ` (${e.kind}${e.date ? `, ${e.date}` : ''})` : e.date ? ` (${e.date})` : ''} <${url}>`;
}

/** The error a `tools/call` answer stands for, or null when it carries a usable payload. */
function retrieveError(r: Json | WorkIqError): WorkIqErrorCode | null {
  if (r instanceof WorkIqError) return r.code;
  try {
    readRetrieve(r);
    return null;
  } catch (error) {
    return error instanceof WorkIqError ? error.code : 'badWorkiqResponse';
  }
}

/** The searches that feed one readiness item: their `retrieve` answers in plan order, and the ladder wordings among them. */
export interface ItemSearches {
  key: string;
  queries: string[];
  wordings: string[];
  results: (Json | WorkIqError)[];
}

const RRF_K = 60;

/**
 * Foundry IQ–style merge of a planned fan-out (docs/workiq-agentic-retrieval-study.md). Work IQ returns no relevance
 * score, so the searches of each readiness item are fused by reciprocal rank; a source found for several items goes to
 * the one where it ranks highest, and is sent once (59 % of the hits of the 32 planned searches were duplicates in the
 * study). Each item keeps its best sources within `maxChars`, in the same "[n] title (kind, date) <url>" form as a
 * single search. An item whose searches all failed is reported as `{ key, error }`.
 */
export function mergeByItem(items: ItemSearches[], fetchedAt: string, maxChars = WORKIQ_SECTION_MAX_CHARS): WorkIqSectionAnswer[] {
  type Candidate = RetrieveEntry & { id: string };
  const best = new Map<string, Candidate>();
  const scores = new Map<string, number[]>();
  const answered = items.map(() => 0);
  const firstError = items.map((): WorkIqErrorCode | null => null);
  items.forEach((item, i) => item.results.forEach((r) => {
    const code = retrieveError(r);
    if (code) {
      firstError[i] ??= code;
      return;
    }
    answered[i]!++;
    const read = readRetrieve(r);
    const list: Candidate[] = read.markdown ? [{ id: `md:${read.markdown}`, url: null, title: '', kind: '', date: null, label: null, body: read.markdown, result: true }] : [];
    for (const e of read.entries) if (e.url && !list.some((c) => c.id === e.url!.href)) list.push({ ...e, id: e.url.href });
    list.forEach((c, rank) => {
      const sc = scores.get(c.id) ?? items.map(() => 0);
      sc[i]! += 1 / (RRF_K + rank + 1);
      scores.set(c.id, sc);
      const prev = best.get(c.id);
      // Each search returns its own excerpt of a source: keep the longest, and any sensitivity label seen.
      if (!prev) best.set(c.id, c);
      else if (c.body.length > prev.body.length) best.set(c.id, { ...c, label: c.label ?? prev.label });
      else if (!prev.label && c.label) prev.label = c.label;
    });
  }));
  const owner = new Map([...scores].map(([id, sc]) => [id, sc.indexOf(Math.max(...sc))]));
  return items.map((item, i): WorkIqSectionAnswer => {
    if (answered[i] === 0) return { key: item.key, error: firstError[i] ?? 'workiqUnavailable' };
    const mine = [...scores].filter(([id]) => owner.get(id) === i).sort((a, b) => b[1][i]! - a[1][i]!).map(([id]) => best.get(id)!);
    const parts: string[] = [];
    const citations: WorkIqCitation[] = [];
    const labels: string[] = [];
    let used = 0;
    for (const c of mine) {
      if (used >= maxChars) break;
      let part = c.body;
      if (c.url) {
        if (citations.length >= MAX_CITATIONS) continue;
        citations.push({ title: c.title, url: c.url.href });
        part = c.result ? (c.body ? `${heading(citations.length, c, c.url.href)}\n${c.body}` : heading(citations.length, c, c.url.href)) : '';
      }
      if (c.label && !labels.includes(c.label)) labels.push(c.label);
      if (part) {
        parts.push(part);
        used += part.length + 2;
      }
    }
    const text = parts.join('\n\n');
    return {
      key: item.key, question: item.queries.join('\n').slice(0, 2_000), searches: item.wordings,
      answer: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text, citations, sensitivity: labels.length ? labels.join(', ').slice(0, 100) : null, fetchedAt,
    };
  });
}

/* ---------- A minimal MCP stdio client (newline-delimited JSON-RPC 2.0) ---------- */

export type SpawnLike = (command: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean; shell: boolean }) => ChildProcessWithoutNullStreams;

function stopProcess(child: ChildProcessWithoutNullStreams) {
  try {
    child.stdin.end();
  } catch {
    // already closed
  }
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      // npx → node → workiq.exe: end the whole tree by its process ID.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      child.kill();
    }
  }, STOP_GRACE_MS);
  timer.unref();
}

/** Starts the server, initializes, calls one tool and stops it. */
export function callMcpTool(cmd: WorkIqCliCommand, name: string, args: Json, signal?: AbortSignal, timeoutMs = WORKIQ_TIMEOUT_MS, doSpawn: SpawnLike = spawn as unknown as SpawnLike): Promise<Json> {
  return mcpRequest(cmd, 'tools/call', { name, arguments: args }, signal, timeoutMs, doSpawn);
}

export interface McpServerInfo {
  name: string | null;
  version: string | null;
  tools: string[];
}

/**
 * Starts the server and lists its tools without calling any (no Work IQ retrieval, so nothing is billed). Used by
 * `node scripts/bas.ts workiq check` to show that the CLI starts, signs in and reaches the Work IQ service.
 */
export async function listMcpTools(cmd: WorkIqCliCommand, signal?: AbortSignal, timeoutMs = WORKIQ_TIMEOUT_MS, doSpawn: SpawnLike = spawn as unknown as SpawnLike): Promise<McpServerInfo> {
  let info: Json = {};
  const result = await mcpRequest(cmd, 'tools/list', {}, signal, timeoutMs, doSpawn, (init) => { info = init; });
  const server = isObj(info.serverInfo) ? info.serverInfo : {};
  return {
    name: typeof server.name === 'string' ? server.name : null,
    version: typeof server.version === 'string' ? server.version : null,
    tools: Array.isArray(result.tools) ? result.tools.filter(isObj).map((t) => t.name).filter((n): n is string => typeof n === 'string') : [],
  };
}

/** Starts the server, initializes, sends one request and stops it. */
async function mcpRequest(cmd: WorkIqCliCommand, method: string, params: Json, signal: AbortSignal | undefined, timeoutMs: number, doSpawn: SpawnLike, onInit?: (result: Json) => void): Promise<Json> {
  const [first] = await mcpRequests(cmd, [{ method, params }], signal, timeoutMs, doSpawn, 1, onInit);
  if (first instanceof WorkIqError) throw first;
  return first!;
}

/** Live sessions, ended with the relay process (npx → node → workiq would otherwise outlive it on Windows). */
const liveSessions = new Set<McpSession>();
let exitHookInstalled = false;
function endSessionsOnExit() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const s of liveSessions) s.kill();
  });
}

/**
 * One running `workiq mcp` process: initialized once, then any number of requests (ids 2, 3 …). Starting the CLI and
 * signing in costs about 10 s every time (docs/workiq-agentic-retrieval-study.md), so the pack searches of one
 * generation share a session. Requests never reject: an error answer, a timeout, an abort or the process ending becomes
 * a WorkIqError in its place.
 */
export class McpSession {
  initResult: Json = {};
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (value: Json | WorkIqError) => void>();
  private nextId = 2;
  private buffer = '';
  private ended: WorkIqError | null = null;
  private stopped = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.on('error', (e: NodeJS.ErrnoException) => this.end(new WorkIqError(e.code === 'ENOENT' ? 'workiqCliMissing' : 'workiqUnavailable')));
    child.on('exit', (code) => this.end(new WorkIqError(code === 9009 || code === 127 ? 'workiqCliMissing' : 'workiqUnavailable')));
    child.stdin.on('error', () => {});
    // stderr can carry account names and request IDs: read and drop it (NFR-SEC-012).
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    liveSessions.add(this);
    endSessionsOnExit();
  }

  /** Starts the server and initializes it. Start-up failures (missing CLI, failed initialize, timeout, abort) reject. */
  static async open(cmd: WorkIqCliCommand, doSpawn: SpawnLike, timeoutMs: number, signal?: AbortSignal): Promise<McpSession> {
    if (signal?.aborted) throw new WorkIqError('workiqUnavailable');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = doSpawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: cmd.shell });
    } catch {
      throw new WorkIqError('workiqCliMissing');
    }
    const session = new McpSession(child);
    const init = await session.send(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'business-analytics-studio', version: '0.1.0' } }, timeoutMs, signal);
    if (init instanceof WorkIqError) {
      session.close();
      throw init.code === 'workiqCliMissing' || init.code === 'workiqTimeout' ? init : new WorkIqError('workiqUnavailable');
    }
    session.initResult = init;
    session.write({ method: 'notifications/initialized' });
    return session;
  }

  get alive(): boolean {
    return this.ended === null;
  }

  request(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json | WorkIqError> {
    return this.send(this.nextId++, method, params, timeoutMs, signal);
  }

  close() {
    this.end(new WorkIqError('workiqUnavailable'));
  }

  /** Synchronous stop for process exit. */
  kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      if (process.platform === 'win32' && this.child.pid) execFileSync('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else this.child.kill();
    } catch {
      // already gone
    }
  }

  private end(error: WorkIqError) {
    if (this.ended === null) this.ended = error;
    for (const settle of [...this.pending.values()]) settle(this.ended);
    this.pending.clear();
    if (!this.stopped) {
      this.stopped = true;
      liveSessions.delete(this);
      stopProcess(this.child);
    }
  }

  private write(m: Json) {
    if (this.ended === null) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  private send(id: number, method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json | WorkIqError> {
    if (this.ended) return Promise.resolve(this.ended);
    if (signal?.aborted) return Promise.resolve(new WorkIqError('workiqUnavailable'));
    return new Promise((resolve) => {
      const settle = (value: Json | WorkIqError) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => settle(new WorkIqError('workiqTimeout')), timeoutMs);
      const onAbort = () => settle(new WorkIqError('workiqUnavailable'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, settle);
      this.write({ id, method, params });
    });
  }

  private read(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        const v = JSON.parse(line) as unknown;
        if (!isObj(v)) continue;
        msg = v;
      } catch {
        continue; // a stray non-protocol line
      }
      if (typeof msg.method === 'string') {
        // Server → client requests (elicitation, roots, sampling): this client offers none of them.
        if (msg.id !== undefined) this.write({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const settle = this.pending.get(msg.id);
      if (!settle) continue;
      if (isObj(msg.error)) settle(errorFromText(String(msg.error.message ?? '')));
      else settle(isObj(msg.result) ? msg.result : new WorkIqError('badWorkiqResponse'));
    }
    if (this.buffer.length > MAX_STDOUT_BYTES) this.end(new WorkIqError('badWorkiqResponse'));
  }
}

/** Runs `fn` over the items with at most `n` in flight; results keep the input order. */
async function inPool<T, R>(items: readonly T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

/**
 * Starts the server once, initializes, sends the requests (at most `concurrency` in flight) and stops it. Each request
 * settles on its own: an error answer or a request still open at the timeout becomes a WorkIqError in its place.
 * Start-up failures reject the whole call, and so does a call in which no request was answered.
 */
export async function mcpRequests(cmd: WorkIqCliCommand, requests: { method: string; params: Json }[], signal: AbortSignal | undefined, timeoutMs: number, doSpawn: SpawnLike, concurrency = 2, onInit?: (result: Json) => void): Promise<(Json | WorkIqError)[]> {
  if (signal?.aborted) throw new WorkIqError('workiqUnavailable');
  if (requests.length === 0) return [];
  const deadline = Date.now() + timeoutMs;
  const session = await McpSession.open(cmd, doSpawn, timeoutMs, signal);
  try {
    onInit?.(session.initResult);
    const results = await inPool(requests, concurrency, (r) => session.request(r.method, r.params, Math.max(1, deadline - Date.now()), signal));
    if (signal?.aborted) throw new WorkIqError('workiqUnavailable');
    if (results.every((r) => r instanceof WorkIqError)) throw results[0];
    return results;
  } finally {
    session.close();
  }
}

/* ---------- Service ---------- */

export interface WorkIqCliConfig {
  account: string | null;
  /** `I-accept-EULA=true` in the CLI's persisted config (written by accept_eula / `workiq accept-eula`). */
  eulaAccepted: boolean;
}

/** The CLI's persisted defaults (`workiq config show`). Null when the CLI cannot run. */
export function workIqCliConfig(cmd: WorkIqCliCommand, timeoutMs = 120_000): Promise<WorkIqCliConfig | null> {
  const args = cmd.args.at(-1) === 'mcp' ? [...cmd.args.slice(0, -1), 'config', 'show'] : [...cmd.args, 'config', 'show'];
  return new Promise((resolve) => {
    execFile(cmd.command, args, { encoding: 'utf8', windowsHide: true, shell: cmd.shell, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== 'string') return resolve(null);
      const m = /^defaultAccount=(\S+@\S+)$/m.exec(stdout);
      resolve({ account: m ? m[1]!.slice(0, 320) : null, eulaAccepted: /^I-accept-EULA=true\s*$/im.test(stdout) });
    });
  });
}

export interface WorkIqCliServiceOptions {
  command?: () => WorkIqCliCommand;
  spawn?: SpawnLike;
  now?: () => number;
  timeoutMs?: number;
  /** Reads the CLI's persisted config (tests inject one). */
  config?: (cmd: WorkIqCliCommand) => Promise<WorkIqCliConfig | null>;
  /** How long the pack-search session stays open after its last search (follow-up rounds come after a model call). */
  sessionIdleMs?: number;
  /** Base pause before a retry of a transient search failure (the second retry waits 4×). */
  retryDelayMs?: number;
}

/**
 * Searches in flight in the pack-search session. Measured 2026-11-12 (docs/workiq-agentic-retrieval-study.md): four at a
 * time kept the per-search latency of two (median 12 s) and halved the wall time.
 */
export const WORKIQ_CLI_CONCURRENCY = 4;
export const WORKIQ_SESSION_IDLE_MS = 300_000;
/**
 * Failures worth trying again in the same session: Work IQ's generic "An error occurred invoking 'retrieve'" (seen after
 * about 30 s on 4 % of the searches in the study, the same search succeeding later), throttling and a search still open
 * at the timeout. D-15: two more tries, after 1× and 4× the retry delay, because one follow-up search still failed after
 * a single retry. Sign-in, policy and EULA failures are never retried (learn.microsoft.com …/work-iq/mcp/retrieve).
 */
const RETRIED: ReadonlySet<WorkIqErrorCode> = new Set(['workiqUnavailable', 'workiqBusy', 'workiqTimeout']);
const RETRY_BACKOFF = [1, 4] as const;
const FATAL: ReadonlySet<WorkIqErrorCode> = new Set(['notSignedIn', 'workiqForbidden', 'workiqEulaRequired', 'workiqCliMissing']);

/** One Work IQ CLI call at a time per relay, like the REST route. */
export class WorkIqCliService {
  private readonly command: () => WorkIqCliCommand;
  private readonly doSpawn: SpawnLike | undefined;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly readConfig: (cmd: WorkIqCliCommand) => Promise<WorkIqCliConfig | null>;
  private readonly sessionIdleMs: number;
  private readonly retryDelayMs: number;
  private busy = false;
  private lastVerification = -Infinity;
  private session: McpSession | null = null;
  private opening: Promise<McpSession> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WorkIqCliServiceOptions = {}) {
    this.readConfig = opts.config ?? ((cmd) => workIqCliConfig(cmd));
    this.command = opts.command ?? (() => workIqCliCommand());
    this.doSpawn = opts.spawn;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? WORKIQ_TIMEOUT_MS;
    this.sessionIdleMs = opts.sessionIdleMs ?? WORKIQ_SESSION_IDLE_MS;
    this.retryDelayMs = opts.retryDelayMs ?? 2_000;
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new WorkIqError('workiqBusy');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private call(name: string, args: Json, signal?: AbortSignal) {
    return callMcpTool(this.command(), name, args, signal, this.timeoutMs, this.doSpawn);
  }

  private async retrieve(query: string, timeZone: string, signal?: AbortSignal): Promise<WorkIqAnswer> {
    const result = await this.call('retrieve', { query, strategy: 'grounding', timeZone }, signal);
    return parseRetrieveResult(result, query, new Date(this.now()).toISOString());
  }

  /** Evidence about the customer for the pack (Foundry writes from it). */
  ask(question: WorkIqQuestion, signal?: AbortSignal): Promise<WorkIqAnswer> {
    return this.run(() => this.retrieve(workIqRetrieveQuery(question), question.timeZone, signal));
  }

  /** The pack-search session: reused while alive, started once when several searches need it at the same moment. */
  private openSession(signal?: AbortSignal): Promise<McpSession> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.session?.alive) return Promise.resolve(this.session);
    this.opening ??= McpSession.open(this.command(), this.doSpawn ?? (spawn as unknown as SpawnLike), this.timeoutMs, signal)
      .then((s) => (this.session = s))
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  /** Ends the pack-search session now (settings changed, a fatal failure, or the caller is done). */
  closeSession() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.session?.close();
    this.session = null;
  }

  private keepSessionIdle() {
    if (!this.session) return;
    this.idleTimer = setTimeout(() => this.closeSession(), this.sessionIdleMs);
    this.idleTimer.unref?.();
  }

  /** One `retrieve` in the session, tried up to twice more after a transient failure (a dead session is restarted). */
  private async retrieveInSession(query: string, timeZone: string, signal?: AbortSignal): Promise<Json | WorkIqError> {
    for (let attempt = 0; ; attempt++) {
      let r: Json | WorkIqError;
      try {
        const s = await this.openSession(signal);
        r = await s.request('tools/call', { name: 'retrieve', arguments: { query, strategy: 'grounding', timeZone } }, this.timeoutMs, signal);
      } catch (error) {
        r = error instanceof WorkIqError ? error : new WorkIqError('workiqUnavailable');
      }
      const code = retrieveError(r);
      if (attempt >= RETRY_BACKOFF.length || !code || !RETRIED.has(code) || signal?.aborted) return r;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * RETRY_BACKOFF[attempt]!));
    }
  }

  /**
   * The pack searches (server/workiq.ts workIqPlan): the requested sections, with `expand` every readiness ladder
   * wording as well, and the follow-up topics. They run four at a time in one MCP session that stays open between the
   * calls of a generation. Without `expand` each search is its own section, as before; with it, the searches of each
   * readiness item are merged into one section (mergeByItem). A section that fails is reported in its place; sign-in,
   * permission and EULA failures stop the run because every other section would fail the same way.
   */
  askSections(question: WorkIqQuestion, signal?: AbortSignal): Promise<WorkIqSectionAnswer[]> {
    return this.run(async () => {
      const plan = workIqPlan(question);
      let raw: (Json | WorkIqError)[];
      try {
        raw = await inPool(plan, WORKIQ_CLI_CONCURRENCY, (p) => this.retrieveInSession(p.query, question.timeZone, signal));
      } finally {
        this.keepSessionIdle();
      }
      if (signal?.aborted) {
        this.closeSession();
        throw new WorkIqError('workiqUnavailable');
      }
      const codes = raw.map(retrieveError);
      const fatal = codes.find((c) => c !== null && FATAL.has(c));
      if (fatal) {
        this.closeSession();
        throw new WorkIqError(fatal);
      }
      if (codes.every((c) => c !== null)) throw new WorkIqError(codes[0]!);
      const fetchedAt = new Date(this.now()).toISOString();
      const single = (i: number): WorkIqSectionAnswer => {
        const r = raw[i]!;
        const key = plan[i]!.key;
        if (codes[i]) return { key, error: codes[i]! };
        return { key, ...parseRetrieveResult(r, plan[i]!.query, fetchedAt, WORKIQ_SECTION_MAX_CHARS) };
      };
      if (!question.expand) return plan.map((_, i) => single(i));
      const items: ItemSearches[] = REQUIREMENTS.map((req) => {
        const idx = plan.flatMap((p, i) => (p.items.includes(req.key) ? [i] : []));
        return { key: req.key, queries: idx.map((i) => plan[i]!.query), wordings: idx.flatMap((i) => (plan[i]!.wording ? [plan[i]!.wording!] : [])), results: idx.map((i) => raw[i]!) };
      });
      return [...mergeByItem(items, fetchedAt, WORKIQ_ITEM_MAX_CHARS), ...plan.flatMap((p, i) => (p.kind === 'topic' ? [single(i)] : []))];
    });
  }

  /** Proves retrieval with at least one Microsoft 365 source URL; nothing retrieved is returned or saved. */
  verify(signal?: AbortSignal): Promise<void> {
    if (this.now() - this.lastVerification < 5_000) return Promise.reject(new WorkIqError('workiqBusy'));
    this.lastVerification = this.now();
    return this.run(async () => {
      const result = await this.retrieve(WORKIQ_CLI_VERIFY_QUERY, 'UTC', signal);
      if (result.citations.length === 0) throw new WorkIqError('workiqNoGrounding');
    });
  }

  /**
   * Only after the user pressed the EULA button with the EULA link shown next to it. Success means the CLI persisted
   * the acceptance (`I-accept-EULA=true`), not merely that the tool answered.
   */
  acceptEula(signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      const result = await this.call('accept_eula', { eulaUrl: WORKIQ_EULA_URL }, signal);
      if (result.isError === true) throw errorFromText(texts(result).join('\n'));
      const config = await this.readConfig(this.command());
      if (config && !config.eulaAccepted) throw new WorkIqError('workiqEulaRequired');
    });
  }
}
