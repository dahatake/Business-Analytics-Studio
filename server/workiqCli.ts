import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKIQ_ITEM_MAX_CHARS, WORKIQ_MAX_ANSWER_CHARS, WORKIQ_SECTION_MAX_CHARS } from '../src/ai/policy.ts';
import { isConfidentialLabel } from '../src/ai/sensitivity.ts';
import { appendAiPromptSuffix } from '../src/ai/promptSuffix.ts';
import { REQUIREMENTS } from '../src/modules/project/analysisReadiness.ts';
import { WORKIQ_SCOPED_ASPECTS, WORKIQ_TIMEOUT_MS, WorkIqError, workIqPlan, type WorkIqAnswer, type WorkIqCitation, type WorkIqErrorCode, type WorkIqQuestion, type WorkIqSectionAnswer, type WorkIqSource } from './workiq.ts';

/**
 * D-14 (user, 2026-11-11), second route: Microsoft's own Work IQ CLI (`@microsoft/workiq`) as a local MCP stdio server.
 * When the tenant cannot enable Work IQ for a custom app registration (no admin consent for the REST route), the CLI
 * still reaches `https://workiq.svc.cloud.microsoft/mcp` with Microsoft's published client and the user's Windows
 * (WAM) or browser sign-in. The relay only speaks MCP to it: `retrieve` (grounding, read-only) for the Project pack
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
  // Windows keeps npm next to node.exe; the macOS/Linux distributions keep it in lib/ beside bin/node.
  const npxCli = [join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'), join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')].find((p) => existsSync(p));
  if (npxCli) return { command: execPath, args: [npxCli, '-y', WORKIQ_CLI_PACKAGE, 'mcp'], shell: false };
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
 * A result whose `contentProtection` is not explicitly "allowed" keeps its citation in a single answer,
 * but its text is not passed on and it is not selected for merged grounding or a deep read.
 */
export function parseRetrieveResult(result: unknown, question: string, fetchedAt: string, maxChars = WORKIQ_MAX_ANSWER_CHARS, excludeConfidential = false): WorkIqAnswer {
  const { markdown: top, entries } = readRetrieve(result);
  const seen = new Set<string>();
  const citations: WorkIqCitation[] = [];
  const labels: string[] = [];
  const sections: string[] = [];
  const withheld = new Set<string>();
  if (top) sections.push(top);
  for (const e of entries) {
    if (excludeConfidential && isConfidentialLabel(e.label)) {
      withheld.add(e.url?.href ?? e.title);
      continue;
    }
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
  return { question, answer, citations, sensitivity: labels.length ? labels.join(', ').slice(0, 100) : null, fetchedAt, ...(withheld.size ? { withheld: withheld.size } : {}) };
}

interface RetrieveEntry {
  url: URL | null;
  title: string;
  kind: string;
  date: string | null;
  label: string | null;
  /** Text passed on (empty when contentProtection is not "allowed", and for documented `retrievalHits`). */
  body: string;
  allowed: boolean;
  /** From `results[]` (has its own text and heading) rather than citation-only `retrievalHits[]`. */
  result: boolean;
}

/** The `retrieve` payload as entries in Work IQ's order; tool errors and the EULA gate are thrown as WorkIqError. */
function readRetrieve(result: unknown): { markdown: string; entries: RetrieveEntry[]; terms: string[] } {
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
    const allowed = hit.contentProtection === 'allowed' || (!isResult && hit.contentProtection === undefined);
    return {
      url, title: title ?? url?.hostname ?? '', kind: typeof hit.entityType === 'string' ? hit.entityType.slice(0, 40) : '', date, label: label || null,
      body: isResult && allowed && typeof hit.markdown === 'string' ? hit.markdown.trim() : '', result: isResult, allowed,
    };
  };
  const meta = isObj(payload.searchMetadata) ? payload.searchMetadata : {};
  const results = Array.isArray(payload.results) ? payload.results : null;
  return {
    markdown: !results && typeof payload.markdown === 'string' ? payload.markdown.trim() : '',
    entries: results ? results.filter(isObj).map((h) => entry(h, true))
      : (Array.isArray(payload.retrievalHits) ? payload.retrievalHits : []).filter(isObj).map((h) => entry(h, false)),
    terms: Array.isArray(meta.searchTerms) ? meta.searchTerms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim().toLowerCase()) : [],
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
/** A source that matches every search term weighs as much as one more first place in a search (RRF 1/(k+1)). */
const RERANK_WEIGHT = 1 / (RRF_K + 1);

/** Search terms of a query when Work IQ reports none: Latin words, katakana and kanji runs. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}|[ァ-ヶー]{2,}|[一-龯々]{2,}/g) ?? [])];
}

/**
 * Local L2 rerank (Agentic Retrieval's semantic ranker, as far as the CLI allows): Work IQ gives no score, but each
 * `retrieve` answer names the terms it searched (`searchMetadata.searchTerms`, seen 2026-11-15) and each result has its
 * own text. The share of the item's terms, weighted by rarity across all candidates, that a source's title and text
 * contain. Ties of RRF are common once the same concept is searched source by source (first in mail and first in files
 * score alike), and the item budget keeps only the first sources.
 */
export function termCoverage(text: string, terms: readonly string[], idf: (t: string) => number): number {
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  let have = 0;
  let all = 0;
  for (const t of terms) {
    const w = idf(t);
    all += w;
    if (lower.includes(t)) have += w;
  }
  return all > 0 ? have / all : 0;
}

/**
 * Foundry IQ–style merge of a planned fan-out (docs/workiq-agentic-retrieval-study.md). Work IQ returns no relevance
 * score, so the searches of each readiness item are fused by reciprocal rank. Identical passages go to the
 * highest-ranking item; complementary passages of the same source stay with the searches that found them.
 * Organisation-scoped sections retain their own evidence. Within an item, sources are reranked by termCoverage,
 * then share the character budget so one long excerpt cannot crowd out every other source.
 */
export function mergeByItem(items: ItemSearches[], fetchedAt: string, maxChars = WORKIQ_SECTION_MAX_CHARS, excludeConfidential = false): WorkIqSectionAnswer[] {
  type Candidate = RetrieveEntry & { id: string; passages: Map<string, { text: string; items: Set<number> }> };
  const best = new Map<string, Candidate>();
  const scores = new Map<string, number[]>();
  const answered = items.map(() => 0);
  const firstError = items.map((): WorkIqErrorCode | null => null);
  const terms = items.map(() => new Set<string>());
  const withheld = items.map(() => new Set<string>());
  items.forEach((item, i) => item.results.forEach((r) => {
    const code = retrieveError(r);
    if (code) {
      firstError[i] ??= code;
      return;
    }
    answered[i]!++;
    const read = readRetrieve(r);
    for (const t of read.terms) terms[i]!.add(t);
    const list: (RetrieveEntry & { id: string })[] = read.markdown ? [{ id: `md:${read.markdown}`, url: null, title: '', kind: '', date: null, label: null, body: read.markdown, result: true, allowed: true }] : [];
    for (const e of read.entries) {
      // FR-369: a confidential source is left out on its own, so the General sources of the same search still count.
      if (excludeConfidential && isConfidentialLabel(e.label)) withheld[i]!.add(e.url?.href ?? e.title);
      else if (e.url && e.allowed) list.push({ ...e, id: e.url.href });
    }
    const ranked = new Set<string>();
    list.forEach((c) => {
      const sc = scores.get(c.id) ?? items.map(() => 0);
      if (!ranked.has(c.id)) {
        sc[i]! += 1 / (RRF_K + ranked.size + 1);
        ranked.add(c.id);
      }
      scores.set(c.id, sc);
      const source = best.get(c.id) ?? { ...c, passages: new Map<string, { text: string; items: Set<number> }>() };
      source.label ??= c.label;
      const key = c.body.replace(/\s+/g, ' ').trim();
      const passage = source.passages.get(key) ?? { text: c.body, items: new Set<number>() };
      passage.items.add(i);
      source.passages.set(key, passage);
      best.set(c.id, source);
    });
  }));
  const scoped = items.map((item) => WORKIQ_SCOPED_ASPECTS.some((a) => a === item.key));
  const textOf = (c: Pick<RetrieveEntry, 'title' | 'body'>) => `${c.title}\n${c.body}`.toLowerCase();
  const pool = [...best.values()].map((c) => textOf({ ...c, body: [...c.passages.values()].map((p) => p.text).join('\n') }));
  const df = new Map<string, number>();
  const idf = (t: string) => {
    if (!df.has(t)) df.set(t, pool.filter((x) => x.includes(t)).length);
    return Math.log(1 + pool.length / (1 + df.get(t)!));
  };
  return items.map((item, i): WorkIqSectionAnswer => {
    if (answered[i] === 0) return { key: item.key, error: firstError[i] ?? 'workiqUnavailable' };
    const itemTerms = terms[i]!.size ? [...terms[i]!] : queryTerms(item.queries.join(' '));
    const mine = [...best.values()].flatMap((c) => {
      const passages = [...c.passages.values()].filter((p) => {
        if (!p.items.has(i)) return false;
        if (scoped[i]) return true;
        const peers = [...p.items].filter((n) => !scoped[n]);
        const owner = peers.reduce((a, b) => scores.get(c.id)![b]! > scores.get(c.id)![a]! ? b : a, peers[0]!);
        return owner === i;
      }).map((p) => p.text);
      if (!passages.length) return [];
      const distinct = passages.filter((p, n) => !passages.some((other, k) => k !== n && other.length > p.length && other.includes(p)));
      const body = distinct.join('\n\n');
      return [{ ...c, body, fragments: distinct, score: scores.get(c.id)![i]! + RERANK_WEIGHT * termCoverage(textOf({ ...c, body }), itemTerms, idf) }];
    }).sort((a, b) => b.score - a.score);
    const selected: { source: typeof mine[number]; head: string }[] = [];
    let used = 0;
    let cited = 0;
    for (const c of mine) {
      if (selected.length >= MAX_CITATIONS) break;
      const head = c.url ? heading(cited + 1, c, c.url.href) : '';
      const minimum = head.length + (head && c.body ? 1 : 0) + Math.min(c.body.length, 160) + (selected.length ? 2 : 0);
      if (used + minimum > maxChars) continue;
      selected.push({ source: c, head });
      if (c.url) cited++;
      used += minimum;
    }
    const overhead = selected.reduce((n, { source, head }) => n + head.length + (head && source.body ? 1 : 0), Math.max(0, selected.length - 1) * 2);
    const budgets = textBudgets(selected.map(({ source }) => source.body.length), Math.max(0, maxChars - overhead));
    const text = selected.map(({ source, head }, n) => {
      const body = clipPassages(source.fragments, budgets[n]!);
      return head && body ? `${head}\n${body}` : head || body;
    }).join('\n\n');
    const citations = selected.flatMap(({ source: c }) => c.url ? [{ title: c.title, url: c.url.href }] : []);
    const labels = [...new Set(selected.flatMap(({ source: c }) => c.label ? [c.label] : []))];
    return {
      key: item.key, question: item.queries.join('\n').slice(0, 2_000), searches: item.wordings,
      answer: text, citations, sensitivity: labels.length ? labels.join(', ').slice(0, 100) : null, fetchedAt,
      ...(withheld[i]!.size ? { withheld: withheld[i]!.size } : {}),
    };
  });
}

/** Water-fill the budget: short passages release their unused share to the longer ones. */
function textBudgets(lengths: readonly number[], budget: number): number[] {
  const out = lengths.map(() => 0);
  let remaining = budget;
  while (remaining > 0) {
    const pending = lengths.flatMap((length, i) => length > out[i]! ? [i] : []);
    if (!pending.length) break;
    const share = Math.max(1, Math.floor(remaining / pending.length));
    for (const i of pending) {
      const take = Math.min(share, lengths[i]! - out[i]!, remaining);
      out[i]! += take;
      remaining -= take;
    }
  }
  return out;
}

function clipPassages(passages: readonly string[], budget: number): string {
  const kept = passages.filter(Boolean).slice(0, Math.floor((budget + 2) / 3));
  const sizes = textBudgets(kept.map((p) => p.length), Math.max(0, budget - Math.max(0, kept.length - 1) * 2));
  return kept.map((p, i) => clipText(p, sizes[i]!)).join('\n\n');
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
/** What the search plan needs from an MCP session: the CLI's own process, or the Foundry transport. */
export interface McpSessionLike {
  readonly alive: boolean;
  request(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json | WorkIqError>;
  close(): void;
}

export class McpSession implements McpSessionLike {
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
  /**
   * Opens the MCP session another way than starting the CLI (server/workiqFoundry.ts: Work IQ through a Microsoft
   * Foundry project connection). The search plan, rerank, deep reads and answers stay the same.
   */
  openSession?: (signal?: AbortSignal) => Promise<McpSessionLike>;
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
 * time kept the per-search latency of two (median 12 s) and halved the wall time. Measured 2026-11-15 on a real project:
 * six at a time answered 12 searches in 26 s with no failure (9–17 s each), eight at a time failed 2 of 8 at Work IQ's
 * 30 s limit. A pack search starts at four, climbs to six while searches stay fast, and halves after a transient failure.
 */
export const WORKIQ_CLI_CONCURRENCY = 4;
export const WORKIQ_CLI_MAX_CONCURRENCY = 6;
const WORKIQ_CLI_MIN_CONCURRENCY = 2;
/** A search slower than this shows no room for one more in flight (the 4-at-a-time searches took 8–15 s). */
const FAST_SEARCH_MS = 15_000;

/** Additive increase, multiplicative decrease of the searches in flight (as TCP does for its window). */
export class AdaptiveLimit {
  limit: number;
  readonly min: number;
  readonly max: number;
  readonly fastMs: number;
  private streak = 0;
  constructor(start = WORKIQ_CLI_CONCURRENCY, min = WORKIQ_CLI_MIN_CONCURRENCY, max = WORKIQ_CLI_MAX_CONCURRENCY, fastMs = FAST_SEARCH_MS) {
    this.limit = start;
    this.min = min;
    this.max = max;
    this.fastMs = fastMs;
  }

  /** One finished attempt: a transient failure halves the limit; `limit` fast successes in a row raise it by one. */
  record(ok: boolean, ms: number) {
    if (!ok) {
      this.limit = Math.max(this.min, Math.floor(this.limit / 2));
      this.streak = 0;
    } else if (ms > this.fastMs) {
      this.streak = 0;
    } else if (++this.streak >= this.limit) {
      this.limit = Math.min(this.max, this.limit + 1);
      this.streak = 0;
    }
  }
}

/** Like inPool, with at most `lim.limit` in flight, read again whenever one finishes. */
export function inAdaptivePool<T, R>(items: readonly T[], lim: AdaptiveLimit, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (!items.length) return Promise.resolve(out);
  return new Promise((resolve, reject) => {
    let next = 0;
    let running = 0;
    let done = 0;
    const pump = () => {
      while (running < Math.max(1, lim.limit) && next < items.length) {
        const i = next++;
        running++;
        fn(items[i]!, i).then((r) => {
          out[i] = r;
          running--;
          if (++done === items.length) resolve(out);
          else pump();
        }, reject);
      }
    };
    pump();
  });
}

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
/**
 * Observed 2026-11-13 with @microsoft/workiq 1.0.0: a `workiq mcp` process sometimes lists only its local tools
 * (accept_eula, ask, list_agents, get_debug_link) and never adds `retrieve` later in the same process (polled for 2
 * minutes, no list_changed notification), while a fresh process often has it. Two more starts are tried; then the
 * searches go through `ask`.
 */
const TOOL_RESTARTS = 2;
const TOOLS_LIST_TIMEOUT_MS = 30_000;
/** `ask` is a Microsoft 365 Copilot chat turn (about 60–100 s each), so it gets a longer timeout than `retrieve`. */
const ASK_TIMEOUT_MS = 240_000;
const MAX_ASK_CITATIONS = 20;

type SearchTool = 'retrieve' | 'ask';

/** The project behind a pack search, given to `ask` so Copilot reads a short search in its context. */
export type AskContext = Pick<WorkIqQuestion, 'purpose' | 'focus' | 'asOf'>;

function askBackground(ctx: AskContext | undefined, lang: 'ja' | 'en'): string {
  if (!ctx) return '';
  return lang === 'ja'
    ? `\n背景（質問の解釈にだけ使い、背景そのものは答えに書かない）: Project の目的: ${ctx.purpose}${ctx.focus ? `、重点: ${ctx.focus}` : ''}。基準日: ${ctx.asOf}。基準日に近い情報を優先し、各事実の日付を書いてください。`
    : `\nBackground (only for reading the request; do not repeat it in the answer): project purpose: ${ctx.purpose}${ctx.focus ? `; focus: ${ctx.focus}` : ''}. As of ${ctx.asOf}. Prefer information close to that date and give each fact its date.`;
}

/**
 * The `ask` request for one planned search: facts with their source, from Microsoft 365 only. With the project context
 * (Agentic Retrieval's query planning with conversation history), a short search such as "KPI and OKR definitions"
 * is read as being about this project's purpose and date rather than in general.
 */
export function workIqAskQuestion(query: string, lang: 'ja' | 'en', ctx?: AskContext): string {
  return lang === 'ja'
    ? `私がアクセスできる Microsoft 365 の情報（メール・会議・Teams のチャット・OneDrive と SharePoint のファイル）から、次の件について事実だけを箇条書きで答えてください。各事実に根拠の文書・会議・メールの名前・日付・リンクを付け、推測や一般論は書かず、見つからなければ「見つからない」と書いてください。\n対象: ${query}${askBackground(ctx, lang)}`
    : `From the Microsoft 365 information I can access (mail, meetings, Teams chats, OneDrive and SharePoint files), list only facts about the following, each with the name, date and link of the document, meeting or mail behind it. Do not guess or generalise; write "not found" when nothing is found.\nSubject: ${query}${askBackground(ctx, lang)}`;
}

/**
 * Deep read (Agentic Retrieval's iterative search, done with the CLI's own `ask` and its `fileUrls`): after the planned
 * searches, the best-ranked Microsoft 365 files of the purpose and the readiness items are given to `ask`, which reads
 * them whole and extracts the figures, dates and owners a search excerpt or a Copilot summary leaves out. Purpose first
 * (the project's own question), then the items whose facts are figures. One `ask` takes about a minute; four run at once.
 */
export const MAX_DEEP_READS = 4;
export const DEEP_READ_FILES = 3;
export const DEEP_READ_MAX_CHARS = 3_000;
export const DEEP_READ_ORDER: readonly string[] = ['purpose', 'kpi', 'engagements', 'issues', 'workflow', 'dataCatalog', 'customers', 'org', 'locations'];

/**
 * A OneDrive or SharePoint document link (`ask` reads files, not mail, meetings or site pages). PDF and HTML files are
 * left out: on 2026-11-15 Copilot answered "cannot read" for a PDF and an HTML file given as `fileUrls` (both opened
 * through `_layouts/15/viewer.aspx`), and read a .docx (`Doc.aspx`) in the same test.
 */
export function isM365FileUrl(raw: string): boolean {
  const url = httpsUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.sharepoint.com') && host !== 'onedrive.live.com' && host !== '1drv.ms') return false;
  const path = decodeURIComponent(url.pathname);
  return /\.(docx?|pptx?|xlsx?|txt|md|csv|loop|vsdx?)$/i.test(path) || /\/:[wpxo]:\//i.test(path) || /\/Doc\d?\.aspx$/i.test(path) || host === '1drv.ms';
}

/** Which sections get a deep read, and of which files: each file is read once, for the first section in DEEP_READ_ORDER that cites it. */
export function deepReadPlan(sections: readonly WorkIqSectionAnswer[], max = MAX_DEEP_READS, perRead = DEEP_READ_FILES): { key: string; files: string[] }[] {
  const used = new Set<string>();
  const out: { key: string; files: string[] }[] = [];
  for (const key of DEEP_READ_ORDER) {
    if (out.length >= max) break;
    const s = sections.find((x) => x.key === key);
    if (!s || 'error' in s) continue;
    const files = s.citations.map((c) => c.url).filter((u) => isM365FileUrl(u) && !used.has(u)).slice(0, perRead);
    if (!files.length) continue;
    for (const f of files) used.add(f);
    out.push({ key, files });
  }
  return out;
}

/** What a deep read extracts: the project purpose for `purpose`, the readiness wordings for an item. */
export function workIqDeepReadQuestion(key: string, q: WorkIqQuestion): string {
  const ja = q.lang === 'ja';
  const req = REQUIREMENTS.find((r) => r.key === key);
  const need = req ? req.ladder[q.lang].join(ja ? '／' : ' / ') : `${q.purpose}${q.focus ? (ja ? `（重点: ${q.focus}）` : ` (focus: ${q.focus})`) : ''}`;
  return ja
    ? `添付したファイルだけを読み、「${q.project}」（${q.company}）について、次に当たる記述を箇条書きで抜き出してください。数値は単位と期間、日付、担当、固有名を落とさないでください。各項目の末尾に根拠のファイル名を付けてください。書かれていないことは推測せず、該当が無ければ「見つからない」とだけ書いてください。\n知りたいこと: ${need}${askBackground(q, 'ja')}`
    : `Read only the attached files and list, as bullets, what they say about "${q.project}" (${q.company}) on the following. Keep figures with unit and period, dates, owners and names. End each bullet with the file name it comes from. Do not guess; if nothing applies, write only "not found".\nWhat to find: ${need}${askBackground(q, 'en')}`;
}

/**
 * The second turn of a deep read that found nothing (Agentic Retrieval's "search again when the first pass is not
 * enough", in the same `ask` conversation so Copilot keeps the question and the files). On 2026-11-15 a deep read of two
 * files answered "not found"; this turn on its conversationId found the figure in an HTML report it could not read as a
 * file, with its link.
 */
export function workIqDeepReadFollowUp(lang: 'ja' | 'en'): string {
  return lang === 'ja'
    ? '添付したファイルには書かれていなかったので、添付以外の、私がアクセスできる Microsoft 365 の情報（メール・会議・Teams のチャット・OneDrive と SharePoint のファイル）から同じ点を探してください。各事実に根拠の名前・日付・リンクを付け、推測せず、見つからなければ「見つからない」とだけ書いてください。'
    : 'The attached files do not state it. Look for the same points in the other Microsoft 365 information I can access (mail, meetings, Teams chats, OneDrive and SharePoint files). Give each fact the name, date and link behind it; do not guess; if nothing is found, write only "not found".';
}

/** The facts a deep-read `ask` answered, without the summary note; empty for "not found" or no answer. */
export function deepReadText(result: Json | WorkIqError): string {
  if (result instanceof WorkIqError) return '';
  const payload = retrievalPayload(result);
  const text = (typeof payload?.markdown === 'string' ? payload.markdown : '').replace(/^\s*(?:（Work IQ ask[^）\n]*）|\(Microsoft 365 Copilot summary[^)\n]*\))\s*/, '').trim();
  return !text || /^(?:見つからない|notfound)[。.]?$/i.test(text.replace(/[\s「」"]+/g, '')) ? '' : text;
}

/** The `ask` conversation a result belongs to (askAsRetrieval keeps it), to ask a follow-up in it. */
function conversationOf(result: Json | WorkIqError): string | null {
  if (result instanceof WorkIqError) return null;
  const id = retrievalPayload(result)?.conversationId;
  return typeof id === 'string' && /^[\w-]{1,200}$/.test(id) ? id : null;
}

/** A deep-read answer put first in its section, the search results after it within the item budget. */
export function withDeepRead(section: WorkIqSectionAnswer, files: readonly string[], result: Json | WorkIqError, lang: 'ja' | 'en', maxChars = WORKIQ_ITEM_MAX_CHARS, followUp = false): WorkIqSectionAnswer {
  if ('error' in section) return section;
  const code = retrieveError(result);
  const read = { files: files.length, ...(followUp ? { followUp: true } : {}) };
  if (code) return { ...section, deepRead: { ...read, error: code } };
  const payload = retrievalPayload(result as Json);
  const text = deepReadText(result);
  if (!text) return { ...section, deepRead: read };
  const titled = files.map((f) => `- ${section.citations.find((c) => c.url === f)?.title || new URL(f).pathname.split('/').pop()} <${f}>`);
  const head = followUp
    ? (lang === 'ja' ? `重点資料の精読（上位のファイル ${files.length} 件に無かったため、同じ会話で Microsoft 365 全体から探した事実）:` : `Deep read (not in the top ${files.length} files, so asked again over all of Microsoft 365 in the same conversation):`)
    : (lang === 'ja' ? `重点資料の精読（Work IQ ask が上位のファイル ${files.length} 件を読んで抜き出した事実）:` : `Deep read (facts Work IQ ask extracted from the top ${files.length} files):`);
  const body = clipText([head, ...titled, text].join('\n'), DEEP_READ_MAX_CHARS);
  const rest = clipText(section.answer, Math.max(0, maxChars - body.length - 2));
  const citations = [...section.citations];
  for (const h of Array.isArray(payload?.retrievalHits) ? payload.retrievalHits.filter(isObj) : []) {
    const url = httpsUrl(h.webUrl);
    if (!url || citations.length >= MAX_CITATIONS || citations.some((c) => c.url === url.href)) continue;
    citations.push({ title: hitMeta(h).title ?? url.hostname, url: url.href });
  }
  return { ...section, answer: rest ? `${body}\n\n${rest}` : body, citations, deepRead: read };
}

function clipText(s: string, n: number): string {
  if (n <= 0) return '';
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

export const ANSWER_MAX_CHARS = 4_000;

/**
 * Markdown links reduced to their titles and numbered citation markers dropped; the URLs are kept as citations. On
 * 2026-11-19 a live KPI answer was 18,172 characters, mostly ~200-character SharePoint links, and its second KPI
 * started at character 2,527; without the links it was 7,372 and started at 1,650. The same live answers also began
 * with the tail of a link (`://aka.ms/…)`) and repeated paragraphs that differed only in their citation markers; both
 * are dropped (6,661 characters).
 */
export function withoutInlineLinks(text: string): string {
  const plain = text
    .replace(/\s*\[\^?\d+\]\(https:\/\/[^\s)]+\)/g, '')
    .replace(/\[([^\]\n]{1,200})\]\(https:\/\/[^\s)]+\)/g, '$1')
    // Work IQ's own answer text also holds links cut in the middle (2026-11-20: `…&Defaul.com/personal/…`); a cut link
    // is dropped with its label, as is any URL left bare.
    .replace(/\[([^\]\n]{1,200})\]\(https?:\/\/\S*/g, '$1')
    .replace(/https?:\/\/\S*/g, '')
    .replace(/\S*(?:sourcedoc=|_layouts\/|%7B[0-9A-F]{4}|&file=)\S*/gi, '')
    .replace(/[\x21-\x7E]{60,}/g, '')
    .replace(/^(?:[:/)\]][^\n]*\n)+/, '')
    .replace(/^[\s、,。.)\]:/]+/, '');
  const seen = new Set<string>();
  return plain.split(/\n\s*\n/).filter((p) => {
    const k = p.replace(/\s+/g, ' ').trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join('\n\n').trim();
}

/**
 * Microsoft 365 Copilot's synthesized answer (`ask`, WORKIQ_ANSWER_ASPECTS) put first in its section, with the links it
 * cites added to the citations and removed from the text. A failed or "not found" answer leaves the section as it was;
 * a section whose searches all failed is kept from the answer alone.
 */
export function withAnswer(section: WorkIqSectionAnswer, result: Json | WorkIqError, lang: 'ja' | 'en', fetchedAt: string, maxChars = WORKIQ_ITEM_MAX_CHARS): WorkIqSectionAnswer {
  if (retrieveError(result)) return section;
  const text = withoutInlineLinks(deepReadText(result));
  if (!text) return section;
  const payload = retrievalPayload(result as Json);
  const head = lang === 'ja' ? 'Microsoft 365 Copilot の回答（Work IQ ask。根拠のリンクは引用に記録）:' : 'Microsoft 365 Copilot answer (Work IQ ask; the links behind it are in the citations):';
  const base = 'error' in section ? { key: section.key, question: '', answer: '', citations: [] as WorkIqCitation[], sensitivity: null, fetchedAt } : section;
  const answerBudget = Math.min(maxChars, Math.max(ANSWER_MAX_CHARS, maxChars - base.answer.length - (base.answer ? 2 : 0)));
  const body = clipText(`${head}\n${text}`, answerBudget);
  const rest = clipText(base.answer, Math.max(0, maxChars - body.length - 2));
  const citations = [...base.citations];
  for (const h of Array.isArray(payload?.retrievalHits) ? payload.retrievalHits.filter(isObj) : []) {
    const url = httpsUrl(h.webUrl);
    if (!url || citations.length >= MAX_CITATIONS || citations.some((c) => c.url === url.href)) continue;
    citations.push({ title: hitMeta(h).title ?? url.hostname, url: url.href });
  }
  return { ...base, answer: rest ? `${body}\n\n${rest}` : body, citations };
}

/**
 * An `ask` answer in the `retrieve` payload shape, so the merge and the generator read both alike: the answer text is
 * the top-level markdown (marked as a Copilot summary) and every https link it cites becomes a citation-only hit.
 */
export function askAsRetrieval(result: unknown, lang: 'ja' | 'en'): Json | WorkIqError {
  if (!isObj(result)) return new WorkIqError('badWorkiqResponse');
  if (needsEula(result)) return new WorkIqError('workiqEulaRequired');
  const sc = isObj(result.structuredContent) ? result.structuredContent : {};
  const answer = (typeof sc.answer === 'string' && sc.answer.trim() ? sc.answer : texts(result).join('\n')).trim();
  if (result.isError === true) return errorFromText(answer);
  const hits: Json[] = [];
  const seen = new Set<string>();
  for (const m of answer.matchAll(/(?:\[([^\]\n]{1,200})\]\()?(https:\/\/[^\s)<>"'\]]+)\)?/g)) {
    const url = httpsUrl(m[2]);
    if (!url || seen.has(url.href) || hits.length >= MAX_ASK_CITATIONS) continue;
    seen.add(url.href);
    const title = m[1]?.replace(/^\^?\d+$/, '').trim();
    hits.push({ webUrl: url.href, ...(title ? { resourceMetadata: { document: { title } } } : {}) });
  }
  const note = lang === 'ja' ? '（Work IQ ask による Microsoft 365 Copilot の要約回答）' : '(Microsoft 365 Copilot summary via Work IQ ask)';
  const conversationId = typeof sc.conversationId === 'string' ? sc.conversationId : undefined;
  return { structuredContent: { [RETRIEVAL_KEY]: { markdown: answer ? `${note}\n${answer}` : '', retrievalHits: hits, stoppedReason: 'completed', ...(conversationId ? { conversationId } : {}) } } };
}

/** One Work IQ CLI call at a time per relay, like the REST route. */
export class WorkIqCliService {
  private readonly command: () => WorkIqCliCommand;
  private readonly doSpawn: SpawnLike | undefined;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly readConfig: (cmd: WorkIqCliCommand) => Promise<WorkIqCliConfig | null>;
  private readonly sessionIdleMs: number;
  private readonly retryDelayMs: number;
  private readonly openCustom: ((signal?: AbortSignal) => Promise<McpSessionLike>) | undefined;
  private busy = false;
  private lastVerification = -Infinity;
  private session: McpSessionLike | null = null;
  private opening: Promise<McpSessionLike> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The search tool of the current session (startSearchSession). */
  private searchTool: SearchTool = 'retrieve';

  constructor(opts: WorkIqCliServiceOptions = {}) {
    this.readConfig = opts.config ?? ((cmd) => workIqCliConfig(cmd));
    this.command = opts.command ?? (() => workIqCliCommand());
    this.doSpawn = opts.spawn;
    this.openCustom = opts.openSession;
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

  private async call(name: string, args: Json, signal?: AbortSignal): Promise<Json> {
    if (!this.openCustom) return callMcpTool(this.command(), name, args, signal, this.timeoutMs, this.doSpawn);
    const s = await this.openCustom(signal);
    try {
      const r = await s.request('tools/call', { name, arguments: args }, this.timeoutMs, signal);
      if (r instanceof WorkIqError) throw r;
      return r;
    } finally {
      s.close();
    }
  }

  private async retrieve(query: string, timeZone: string, signal?: AbortSignal, excludeConfidential = false): Promise<WorkIqAnswer> {
    const result = await this.call('retrieve', { query, strategy: 'grounding', timeZone }, signal);
    return parseRetrieveResult(result, query, new Date(this.now()).toISOString(), undefined, excludeConfidential);
  }

  /** Evidence about the customer for the pack (Foundry writes from it). */
  ask(question: WorkIqQuestion, signal?: AbortSignal): Promise<WorkIqAnswer> {
    return this.run(() => this.retrieve(workIqRetrieveQuery(question), question.timeZone, signal, question.excludeConfidential === true));
  }

  /** The pack-search session: reused while alive, started once when several searches need it at the same moment. */
  private openSession(signal?: AbortSignal): Promise<McpSessionLike> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.session?.alive) return Promise.resolve(this.session);
    this.opening ??= this.startSearchSession(signal)
      .then((s) => (this.session = s))
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  /**
   * Starts `workiq mcp` and checks which search tool it offers (tools/list): a process without `retrieve` is restarted
   * up to TOOL_RESTARTS times, then `ask` is used. A server that cannot list its tools is assumed to have `retrieve`.
   */
  private async startSearchSession(signal?: AbortSignal): Promise<McpSessionLike> {
    for (let start = 0; ; start++) {
      const s = this.openCustom ? await this.openCustom(signal) : await McpSession.open(this.command(), this.doSpawn ?? (spawn as unknown as SpawnLike), this.timeoutMs, signal);
      const listed = await s.request('tools/list', {}, Math.min(this.timeoutMs, TOOLS_LIST_TIMEOUT_MS), signal);
      const names = listed instanceof WorkIqError || !Array.isArray(listed.tools) ? null
        : listed.tools.flatMap((t) => (isObj(t) && typeof t.name === 'string' ? [t.name] : []));
      if (!names || names.includes('retrieve')) {
        this.searchTool = 'retrieve';
        return s;
      }
      if (start >= TOOL_RESTARTS || signal?.aborted) {
        this.searchTool = names.includes('ask') ? 'ask' : 'retrieve';
        return s;
      }
      s.close();
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
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

  /**
   * One search in the session (`retrieve`, or `ask` when the process lacks it), tried up to twice more after a transient
   * failure (a dead session is restarted). With `files`, a deep read: `ask` with those `fileUrls` and `query` as the
   * whole question, whichever search tool the session has; with `conversationId`, a further turn of that `ask`
   * conversation. `sources` limits a `retrieve` to those Microsoft 365 sources. Each attempt is reported to `limit`.
   */
  private async retrieveInSession(query: string, timeZone: string, lang: 'ja' | 'en', signal?: AbortSignal, retries: number = RETRY_BACKOFF.length, opts: { ctx?: AskContext; files?: readonly string[]; conversationId?: string; sources?: readonly WorkIqSource[]; limit?: AdaptiveLimit; ask?: boolean } = {}): Promise<Json | WorkIqError> {
    for (let attempt = 0; ; attempt++) {
      let r: Json | WorkIqError;
      const t0 = Date.now();
      try {
        const s = await this.openSession(signal);
        if (opts.files || opts.conversationId || opts.ask || this.searchTool === 'ask') {
          const args = opts.conversationId ? { question: appendAiPromptSuffix(query), conversationId: opts.conversationId }
            : opts.files ? { question: appendAiPromptSuffix(query), fileUrls: [...opts.files] } : { question: appendAiPromptSuffix(workIqAskQuestion(query, lang, opts.ctx)) };
          const answer = await s.request('tools/call', { name: 'ask', arguments: args }, Math.max(this.timeoutMs, ASK_TIMEOUT_MS), signal);
          r = answer instanceof WorkIqError ? answer : askAsRetrieval(answer, lang);
        } else {
          const capabilities = opts.sources?.length ? { capabilities: opts.sources.map((name) => ({ name })) } : {};
          r = await s.request('tools/call', { name: 'retrieve', arguments: { query, strategy: 'grounding', timeZone, ...capabilities } }, this.timeoutMs, signal);
        }
      } catch (error) {
        r = error instanceof WorkIqError ? error : new WorkIqError('workiqUnavailable');
      }
      const code = retrieveError(r);
      if (!code || RETRIED.has(code)) opts.limit?.record(!code, Date.now() - t0);
      if (attempt >= retries || !code || !RETRIED.has(code) || signal?.aborted) return r;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * RETRY_BACKOFF[attempt]!));
    }
  }

  /**
   * The pack searches (server/workiq.ts workIqPlan): the requested sections, with `expand` every readiness ladder
   * wording and the purpose concepts as well (through `retrieve`, the first concepts also once per Microsoft 365 source),
   * and the follow-up topics. They run four to six at a time (AdaptiveLimit) in one MCP session that
   * stays open between the calls of a generation. Without `expand` each search is its own section, as before; with it,
   * the searches of each readiness item are merged into one section (mergeByItem) and the purpose searches into a
   * `purpose` section. When the session has to use `ask`, the ladder wordings are left out (each `ask` already answers
   * broadly and takes about a minute). A section that fails is reported in its place; sign-in, permission and EULA
   * failures stop the run because every other section would fail the same way. With `expand`, the top files of the
   * purpose and up to three readiness items are then read in full (deepReadPlan), and a read that finds nothing is
   * asked again over all of Microsoft 365 in its conversation; every `ask` carries the project purpose and date as background.
   */
  askSections(question: WorkIqQuestion, signal?: AbortSignal): Promise<WorkIqSectionAnswer[]> {
    return this.run(async () => {
      let raw: (Json | WorkIqError)[];
      let plan: ReturnType<typeof workIqPlan>;
      try {
        try {
          await this.openSession(signal);
        } catch {
          // Reported by the searches below, which try to start the session again.
        }
        plan = workIqPlan(question, { ladder: this.searchTool === 'retrieve', sources: this.searchTool === 'retrieve', answers: this.searchTool === 'retrieve', topicWordings: this.searchTool === 'retrieve' });
        const limit = new AdaptiveLimit();
        // A synthesized answer takes about a minute, so it neither counts toward the fast streak nor is retried long.
        raw = await inAdaptivePool(plan, limit, async (p) => {
          if (p.kind !== 'answer') return this.retrieveInSession(p.query, question.timeZone, question.lang, signal, undefined, { ctx: question, sources: p.sources, limit });
          const first = await this.retrieveInSession(p.query, question.timeZone, question.lang, signal, 1, { ctx: question, ask: true });
          if (!p.alt || signal?.aborted || (!retrieveError(first) && withoutInlineLinks(deepReadText(first)))) return first;
          // An answer that failed or came back empty is asked once more as English keywords (the wording Work IQ's planner keeps whole).
          const second = await this.retrieveInSession(p.alt, question.timeZone, question.lang, signal, 0, { ctx: question, ask: true });
          return retrieveError(second) ? first : second;
        });
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
      if (codes.every((c) => c !== null)) {
        // A process whose searches all failed is not reused: the next call starts a fresh one (and checks its tools).
        this.closeSession();
        throw new WorkIqError(codes[0]!);
      }
      const fetchedAt = new Date(this.now()).toISOString();
      const exclude = question.excludeConfidential === true;
      const single = (i: number): WorkIqSectionAnswer => {
        const r = raw[i]!;
        const key = plan[i]!.key;
        if (codes[i]) return { key, error: codes[i]! };
        return { key, ...parseRetrieveResult(r, plan[i]!.query, fetchedAt, WORKIQ_SECTION_MAX_CHARS, exclude) };
      };
      // A follow-up topic searched with several wordings is one section, its results fused by reciprocal rank.
      const topicKeys = [...new Set(plan.flatMap((p) => (p.kind === 'topic' ? [p.key] : [])))];
      const topicSections = (): WorkIqSectionAnswer[] => topicKeys.map((key) => {
        const idx = plan.flatMap((p, i) => (p.kind === 'topic' && p.key === key ? [i] : []));
        if (idx.length === 1) return single(idx[0]!);
        return mergeByItem([{ key, queries: idx.map((i) => plan[i]!.query), wordings: [], results: idx.map((i) => raw[i]!) }], fetchedAt, WORKIQ_SECTION_MAX_CHARS, exclude)[0]!;
      });
      if (!question.expand) return [...plan.flatMap((p, i) => (p.kind === 'topic' ? [] : [single(i)])), ...topicSections()];
      const items: ItemSearches[] = REQUIREMENTS.map((req) => {
        const idx = plan.flatMap((p, i) => (p.kind !== 'answer' && p.kind !== 'scoped' && p.items.includes(req.key) ? [i] : []));
        return { key: req.key, queries: idx.map((i) => plan[i]!.query), wordings: idx.flatMap((i) => (plan[i]!.wording ? [plan[i]!.wording!] : [])), results: idx.map((i) => raw[i]!) };
      });
      const purposeIdx = plan.flatMap((p, i) => (p.kind === 'purpose' ? [i] : []));
      if (purposeIdx.length) items.push({ key: 'purpose', queries: purposeIdx.map((i) => plan[i]!.query), wordings: [], results: purposeIdx.map((i) => raw[i]!) });
      // FR-341: the organisation-scoped KPI searches (question and keywords) are one section per organisation.
      for (const a of question.aspects.filter((x) => WORKIQ_SCOPED_ASPECTS.includes(x))) {
        const idx = plan.flatMap((p, i) => (p.kind === 'scoped' && (p.key === a || p.key === `${a}-en`) ? [i] : []));
        items.push({ key: a, queries: idx.map((i) => plan[i]!.query), wordings: [], results: idx.map((i) => raw[i]!) });
      }
      const merged = mergeByItem(items, fetchedAt, WORKIQ_ITEM_MAX_CHARS, exclude);
      const reads = deepReadPlan(merged);
      if (reads.length) {
        let answers: { result: Json | WorkIqError; followUp: boolean }[];
        try {
          // One retry: a deep read adds depth to sections that already have results, so it never holds the run up long.
          // A read that finds nothing is asked again, once, in its own conversation (turns of one conversation never overlap).
          answers = await inPool(reads, WORKIQ_CLI_CONCURRENCY, async (d) => {
            const first = await this.retrieveInSession(workIqDeepReadQuestion(d.key, question), question.timeZone, question.lang, signal, 1, { files: d.files });
            const conversationId = retrieveError(first) || deepReadText(first) || signal?.aborted ? null : conversationOf(first);
            if (!conversationId) return { result: first, followUp: false };
            const next = await this.retrieveInSession(workIqDeepReadFollowUp(question.lang), question.timeZone, question.lang, signal, 1, { conversationId });
            return retrieveError(next) ? { result: first, followUp: false } : { result: next, followUp: true };
          });
        } finally {
          this.keepSessionIdle();
        }
        if (signal?.aborted) {
          this.closeSession();
          throw new WorkIqError('workiqUnavailable');
        }
        reads.forEach((d, n) => {
          const i = merged.findIndex((s) => s.key === d.key);
          merged[i] = withDeepRead(merged[i]!, d.files, answers[n]!.result, question.lang, WORKIQ_ITEM_MAX_CHARS, answers[n]!.followUp);
        });
      }
      plan.forEach((p, i) => {
        if (p.kind !== 'answer') return;
        // An aspect that feeds two readiness items (engagements: customers and engagements) answers both.
        for (const item of p.items) {
          const at = merged.findIndex((s) => s.key === item);
          if (at >= 0) merged[at] = withAnswer(merged[at]!, raw[i]!, question.lang, fetchedAt);
        }
      });
      return [...merged, ...topicSections()];
    });
  }

  /** Proves retrieval with at least one Microsoft 365 source URL; nothing retrieved is returned or saved. */
  verify(signal?: AbortSignal): Promise<void> {
    if (this.now() - this.lastVerification < 5_000) return Promise.reject(new WorkIqError('workiqBusy'));
    this.lastVerification = this.now();
    return this.run(async () => {
      let r: Json | WorkIqError;
      try {
        r = await this.retrieveInSession(WORKIQ_CLI_VERIFY_QUERY, 'UTC', 'en', signal, 0);
      } finally {
        this.closeSession();
      }
      if (r instanceof WorkIqError) throw r;
      const result = parseRetrieveResult(r, WORKIQ_CLI_VERIFY_QUERY, new Date(this.now()).toISOString());
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
