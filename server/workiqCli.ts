import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKIQ_MAX_ANSWER_CHARS, WORKIQ_SECTION_MAX_CHARS } from '../src/ai/policy.ts';
import { WORKIQ_TIMEOUT_MS, WorkIqError, workIqSearches, type WorkIqAnswer, type WorkIqCitation, type WorkIqQuestion, type WorkIqSectionAnswer } from './workiq.ts';

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
  if (!isObj(result)) throw new WorkIqError('badWorkiqResponse');
  const payload = retrievalPayload(result);
  if (!payload && needsEula(result)) throw new WorkIqError('workiqEulaRequired');
  if (result.isError === true) throw errorFromText([...texts(result), payload ? String(payload.error ?? payload.errorCode ?? '') : ''].join('\n'));
  if (!payload) throw new WorkIqError('badWorkiqResponse');
  if (payload.stoppedReason === 'error') throw errorFromText(`${String(payload.errorCode ?? '')} ${String(payload.error ?? '')}`);
  const seen = new Set<string>();
  const citations: WorkIqCitation[] = [];
  const labels: string[] = [];
  const sections: string[] = [];
  const addLabel = (hit: Json) => {
    const label = isObj(hit.sensitivityLabel) && typeof hit.sensitivityLabel.displayName === 'string' ? hit.sensitivityLabel.displayName.trim() : '';
    if (label && !labels.includes(label)) labels.push(label);
  };
  const cite = (hit: Json): WorkIqCitation | null => {
    const url = httpsUrl(hit.webUrl);
    if (!url || seen.has(url.href) || citations.length >= MAX_CITATIONS) return null;
    seen.add(url.href);
    const c = { title: hitMeta(hit).title ?? url.hostname, url: url.href };
    citations.push(c);
    return c;
  };

  if (typeof payload.markdown === 'string' && payload.markdown.trim()) sections.push(payload.markdown.trim());
  for (const hit of Array.isArray(payload.retrievalHits) ? payload.retrievalHits : []) {
    if (!isObj(hit)) continue;
    addLabel(hit);
    cite(hit);
  }
  for (const hit of Array.isArray(payload.results) ? payload.results : []) {
    if (!isObj(hit)) continue;
    addLabel(hit);
    const c = cite(hit);
    if (!c) continue;
    const { date } = hitMeta(hit);
    const kind = typeof hit.entityType === 'string' ? hit.entityType.slice(0, 40) : '';
    const head = `[${citations.length}] ${c.title}${kind ? ` (${kind}${date ? `, ${date}` : ''})` : date ? ` (${date})` : ''} <${c.url}>`;
    const allowed = hit.contentProtection === undefined || hit.contentProtection === 'allowed';
    const body = allowed && typeof hit.markdown === 'string' ? hit.markdown.trim() : '';
    sections.push(body ? `${head}\n${body}` : head);
  }
  const markdown = sections.join('\n\n');
  const answer = markdown.length > maxChars ? `${markdown.slice(0, maxChars)}…` : markdown;
  return { question, answer, citations, sensitivity: labels.length ? labels.join(', ').slice(0, 100) : null, fetchedAt };
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

/**
 * Starts the server once, initializes, sends the requests (ids 2…n+1, at most `concurrency` in flight) and stops it.
 * Each request settles on its own: an error answer or a request still open at the timeout becomes a WorkIqError in its
 * place. Start-up failures (missing CLI, failed initialize, abort before any answer) reject the whole call.
 */
export async function mcpRequests(cmd: WorkIqCliCommand, requests: { method: string; params: Json }[], signal: AbortSignal | undefined, timeoutMs: number, doSpawn: SpawnLike, concurrency = 2, onInit?: (result: Json) => void): Promise<(Json | WorkIqError)[]> {
  if (signal?.aborted) throw new WorkIqError('workiqUnavailable');
  if (requests.length === 0) return [];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = doSpawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: cmd.shell });
  } catch {
    throw new WorkIqError('workiqCliMissing');
  }
  const results: (Json | WorkIqError | undefined)[] = requests.map(() => undefined);
  return await new Promise<(Json | WorkIqError)[]>((resolve, reject) => {
    let settled = false;
    let initialized = false;
    let buffer = '';
    let size = 0;
    let nextIndex = 0;
    let done = 0;
    const finish = (error: WorkIqError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stopProcess(child);
      // Before any answer arrived, the failure belongs to the whole call (as with one request).
      if (error && done === 0) return reject(error);
      resolve(results.map((r) => r ?? error ?? new WorkIqError('workiqUnavailable')));
    };
    const timer = setTimeout(() => finish(new WorkIqError('workiqTimeout')), timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopProcess(child);
      reject(new WorkIqError('workiqUnavailable'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const send = (m: Json) => {
      if (!settled) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    };
    const sendNext = () => {
      if (nextIndex >= requests.length) return;
      const i = nextIndex++;
      send({ id: i + 2, method: requests[i]!.method, params: requests[i]!.params });
    };
    const settle = (i: number, value: Json | WorkIqError) => {
      if (results[i] !== undefined) return;
      results[i] = value;
      done++;
      if (done === requests.length) return finish(null);
      sendNext();
    };
    child.on('error', (e: NodeJS.ErrnoException) => finish(new WorkIqError(e.code === 'ENOENT' ? 'workiqCliMissing' : 'workiqUnavailable')));
    child.on('exit', (code) => finish(new WorkIqError(code === 9009 || code === 127 ? 'workiqCliMissing' : 'workiqUnavailable')));
    child.stdin.on('error', () => {});
    // stderr can carry account names and request IDs: read and drop it (NFR-SEC-012).
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_STDOUT_BYTES * Math.max(1, requests.length)) return finish(new WorkIqError('badWorkiqResponse'));
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
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
          if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
          continue;
        }
        if (msg.id === 1 && !initialized) {
          if (msg.error) return finish(new WorkIqError('workiqUnavailable'));
          initialized = true;
          if (isObj(msg.result)) onInit?.(msg.result);
          send({ method: 'notifications/initialized' });
          for (let k = 0; k < Math.max(1, concurrency); k++) sendNext();
        } else if (typeof msg.id === 'number' && msg.id >= 2 && msg.id < requests.length + 2) {
          const i = msg.id - 2;
          if (isObj(msg.error)) settle(i, errorFromText(String(msg.error.message ?? '')));
          else if (!isObj(msg.result)) settle(i, new WorkIqError('badWorkiqResponse'));
          else settle(i, msg.result);
          if (settled) return;
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'business-analytics-studio', version: '0.1.0' } } });
  });
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
}

/** One Work IQ CLI call at a time per relay, like the REST route. */
export class WorkIqCliService {
  private readonly command: () => WorkIqCliCommand;
  private readonly doSpawn: SpawnLike | undefined;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly readConfig: (cmd: WorkIqCliCommand) => Promise<WorkIqCliConfig | null>;
  private busy = false;
  private lastVerification = -Infinity;

  constructor(opts: WorkIqCliServiceOptions = {}) {
    this.readConfig = opts.config ?? ((cmd) => workIqCliConfig(cmd));
    this.command = opts.command ?? (() => workIqCliCommand());
    this.doSpawn = opts.spawn;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? WORKIQ_TIMEOUT_MS;
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

  /**
   * One `retrieve` per section and follow-up topic in a single MCP session (sign-in and EULA checks happen once).
   * Two searches run at a time; the timeout grows with the number of searches. A section that fails is reported in
   * its place; sign-in, permission and EULA failures stop the run because every other section would fail the same way.
   */
  askSections(question: WorkIqQuestion, signal?: AbortSignal): Promise<WorkIqSectionAnswer[]> {
    return this.run(async () => {
      const searches = workIqSearches(question);
      const timeout = this.timeoutMs * Math.max(1, Math.ceil(searches.length / 2));
      const raw = await mcpRequests(this.command(), searches.map((s) => ({ method: 'tools/call', params: { name: 'retrieve', arguments: { query: s.query, strategy: 'grounding', timeZone: question.timeZone } } })),
        signal, timeout, this.doSpawn ?? (spawn as unknown as SpawnLike), 2);
      const fetchedAt = new Date(this.now()).toISOString();
      const out: WorkIqSectionAnswer[] = searches.map((s, i) => {
        const r = raw[i]!;
        if (r instanceof WorkIqError) return { key: s.key, error: r.code };
        try {
          return { key: s.key, ...parseRetrieveResult(r, s.query, fetchedAt, WORKIQ_SECTION_MAX_CHARS) };
        } catch (error) {
          return { key: s.key, error: error instanceof WorkIqError ? error.code : 'badWorkiqResponse' };
        }
      });
      const fatal = out.find((s): s is { key: string; error: string } => 'error' in s && ['notSignedIn', 'workiqForbidden', 'workiqEulaRequired', 'workiqCliMissing'].includes(s.error));
      if (fatal) throw new WorkIqError(fatal.error as WorkIqError['code']);
      if (out.every((s) => 'error' in s)) throw new WorkIqError((out[0] as { error: string }).error as WorkIqError['code']);
      return out;
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
