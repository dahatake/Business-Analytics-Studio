import { WorkIqError } from './workiq.ts';
import { WorkIqCliService, type McpSessionLike, type WorkIqCliServiceOptions } from './workiqCli.ts';

/**
 * Work IQ through Microsoft Foundry (user request 2026-11-25): the relay reaches the remote Work IQ MCP server
 * (https://workiq.svc.cloud.microsoft/mcp) through a project connection of the user's Foundry project, with the Responses
 * API's MCP tool. Foundry holds the connection and its delegated token (UserEntraToken, measured 2026-11-25: the
 * connection's audience must be the Work IQ application ID). The searches themselves are BAS's own plan (planned fan-out,
 * per-source searches, rerank, deep read, synthesized answers: WorkIqCliService), so this route only replaces the
 * transport: one `tools/call` becomes two Responses calls in which the model is forced to call that tool, every
 * approval request is checked against the exact arguments BAS asked for, and the raw tool output is read from the
 * `mcp_call` item (never the model's text). A call whose arguments differ is refused, never approved.
 *
 * Not used: the Foundry catalog tool "Copilot" (mcp_M365Copilot; documented as backward-compatibility only and
 * offering only a chat tool, no `retrieve`), and a Toolbox (tool search and governance help a model choose among many
 * tools; BAS chooses the tool and its arguments itself, and the toolbox's Work IQ tool is the A2A preview without
 * per-source hits). See docs/workiq-agentic-retrieval-study.md §19.
 */

export const WORKIQ_MCP_URL = 'https://workiq.svc.cloud.microsoft/mcp';
/** The Work IQ application (client) ID: the audience a Foundry UserEntraToken connection to Work IQ must have. */
export const WORKIQ_APP_ID = 'fdcc1f02-fc51-4226-8753-f668596af7f7';
export const FOUNDRY_PROJECT_SCOPE = 'https://ai.azure.com/.default';
const SERVER_LABEL = 'workiq';
/** After the tool ran, the model only needs to stop: the output is read from the mcp_call item. */
const AFTER_CALL_TOKENS = 16;
const TOOLS_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** `https://<account>.services.ai.azure.com/api/projects/<project>` → its parts, or null. */
export function parseProjectEndpoint(raw: unknown): { endpoint: string; account: string; project: string } | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = /^([a-z0-9][a-z0-9-]{0,62})\.services\.ai\.azure\.com$/i.exec(u.hostname);
  const path = /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/?$/.exec(u.pathname);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || !host || !path) return null;
  const account = host[1]!.toLowerCase();
  return { endpoint: `https://${account}.services.ai.azure.com/api/projects/${path[1]}`, account, project: path[1]! };
}

export const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface WorkIqConnectionCandidate {
  endpoint: string;
  project: string;
  connection: string;
  /** Why this connection cannot carry Work IQ (null: it can). */
  problem: 'auth' | 'audience' | null;
}

/**
 * The project connections that point at the Work IQ MCP server, among the projects of the saved Foundry resource.
 * Work IQ accepts only a UserEntraToken connection whose audience is the Work IQ app ID (measured 2026-11-25, §19.5).
 */
export function workIqCandidates(projects: { endpoint: string; name: string; connections: { name: string; target: string; authType: string; audience: string }[] }[], account: string): WorkIqConnectionCandidate[] {
  return projects.flatMap((p) => {
    const parsed = parseProjectEndpoint(p.endpoint);
    if (!parsed || parsed.account !== account.toLowerCase()) return [];
    return p.connections
      .filter((c) => c.target.replace(/\/+$/, '') === WORKIQ_MCP_URL && CONNECTION_NAME.test(c.name))
      .map((c) => ({
        endpoint: parsed.endpoint, project: parsed.project, connection: c.name,
        problem: c.authType !== 'UserEntraToken' ? 'auth' as const : c.audience.toLowerCase() !== WORKIQ_APP_ID ? 'audience' as const : null,
      }));
  });
}

export interface FoundryWorkIqTarget {
  /** Project endpoint (parseProjectEndpoint). */
  endpoint: string;
  /** Name of the project connection to the Work IQ MCP server. */
  connection: string;
  /** Model deployment that relays the tool calls (the saved Foundry connection's deployment). */
  deployment: string;
}

export interface FoundryTransportDeps {
  token: (signal?: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
}

/** Same JSON value regardless of key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(norm) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * The arguments the remote tool accepts. The CLI's local server takes `timeZone` on `retrieve`; the remote server's
 * schema does not list it (measured 2026-11-25), and the model then drops it, so an unchecked call would differ.
 */
export function argsForSchema(args: Json, schema: Json | undefined): Json {
  const props = isObj(schema?.properties) ? Object.keys(schema.properties) : null;
  return props ? Object.fromEntries(Object.entries(args).filter(([k]) => props.includes(k))) : args;
}

/** `mcp_call.output` as an MCP tool result: a JSON object is also offered as structured content. */
export function mcpResultFromOutput(output: unknown, error: unknown): Json {
  const text = typeof output === 'string' ? output : output === undefined || output === null ? '' : JSON.stringify(output);
  if (error) return { isError: true, content: [{ type: 'text', text: `${typeof error === 'string' ? error : JSON.stringify(error)}\n${text}`.trim() }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  // Plain text from Work IQ is an error message (e.g. "The caller tenant does not have a billing policy configured").
  if (!isObj(parsed)) return { isError: /\b(?:error|not|denied|forbidden|billing|policy|unauthori[sz]ed|failed)\b/i.test(text), content: [{ type: 'text', text }] };
  return { structuredContent: parsed, content: [{ type: 'text', text }] };
}

function httpError(status: number, body: unknown): WorkIqError {
  const code = isObj(body) && isObj(body.error) && typeof body.error.code === 'string' ? body.error.code : '';
  if (status === 401) return new WorkIqError('notSignedIn');
  if (status === 403) return new WorkIqError('workiqForbidden');
  if (status === 404) return new WorkIqError('notConfigured');
  if (status === 429) return new WorkIqError('workiqBusy');
  if (status === 408 || status === 504) return new WorkIqError('workiqTimeout');
  // Foundry reports a refusal by the tool server (billing policy, consent, license) as this generic code.
  if (code === 'tool_user_error') return new WorkIqError('workiqForbidden');
  if (code === 'context_length_exceeded') return new WorkIqError('workiqModelLimit');
  return new WorkIqError('workiqUnavailable');
}

/**
 * One MCP "session" over Foundry. Stateless (each call is its own pair of responses); `tools/list` is cached with the
 * input schemas, which decide which arguments are sent.
 */
export class FoundryMcpSession implements McpSessionLike {
  private schemas: Map<string, Json> | null = null;
  private closed = false;

  constructor(private readonly target: FoundryWorkIqTarget, private readonly connectionId: string, private readonly deps: FoundryTransportDeps) {}

  get alive(): boolean {
    return !this.closed;
  }

  close() {
    this.closed = true;
  }

  private tool(allowed?: string[]): Json {
    return { type: 'mcp', server_label: SERVER_LABEL, server_url: WORKIQ_MCP_URL, project_connection_id: this.connectionId, require_approval: 'always', ...(allowed ? { allowed_tools: allowed } : {}) };
  }

  private async responses(body: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const token = await this.deps.token(signal);
      const res = await (this.deps.fetch ?? fetch)(`${this.target.endpoint}/openai/v1/responses`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.target.deployment, store: true, ...body }),
      });
      const json = await res.json().catch(() => null) as unknown;
      if (!res.ok) throw httpError(res.status, json);
      if (!isObj(json)) throw new WorkIqError('badWorkiqResponse');
      return json;
    } catch (error) {
      if (error instanceof WorkIqError) throw error;
      if (controller.signal.aborted) throw new WorkIqError(signal?.aborted ? 'workiqUnavailable' : 'workiqTimeout');
      throw new WorkIqError('workiqUnavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async listTools(timeoutMs: number, signal?: AbortSignal): Promise<Map<string, Json>> {
    if (this.schemas) return this.schemas;
    const r = await this.responses({ input: 'List the tools only.', tool_choice: 'none', max_output_tokens: AFTER_CALL_TOKENS, tools: [this.tool()] }, timeoutMs, signal);
    const list = (Array.isArray(r.output) ? r.output : []).find((o) => isObj(o) && o.type === 'mcp_list_tools') as Json | undefined;
    if (!list) throw new WorkIqError('workiqUnavailable');
    if (list.error) throw new WorkIqError('workiqForbidden');
    const tools = (Array.isArray(list.tools) ? list.tools : []).filter(isObj);
    this.schemas = new Map(tools.flatMap((t) => (typeof t.name === 'string' ? [[t.name, isObj(t.input_schema) ? t.input_schema : {}] as [string, Json]] : [])));
    return this.schemas;
  }

  /** `tools/list` and `tools/call` like the CLI's MCP session; never rejects (errors come back as WorkIqError). */
  async request(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json | WorkIqError> {
    try {
      if (this.closed) throw new WorkIqError('workiqUnavailable');
      const schemas = await this.listTools(Math.min(timeoutMs, TOOLS_TIMEOUT_MS), signal);
      if (method === 'tools/list') return { tools: [...schemas].map(([name, inputSchema]) => ({ name, inputSchema })) };
      if (method !== 'tools/call' || typeof params.name !== 'string' || !isObj(params.arguments)) throw new WorkIqError('badWorkiqResponse');
      const name = params.name;
      if (!schemas.has(name)) throw new WorkIqError('workiqUnavailable');
      return await this.call(name, argsForSchema(params.arguments, schemas.get(name)), timeoutMs, signal);
    } catch (error) {
      return error instanceof WorkIqError ? error : new WorkIqError('workiqUnavailable');
    }
  }

  private async call(name: string, args: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json> {
    const tool = this.tool([name]);
    const first = await this.responses({
      instructions: 'You relay one tool call. Call the named tool exactly once with exactly the JSON arguments given (same keys and values, nothing added or removed), then reply only "done".',
      input: `Tool: ${name}\nArguments: ${JSON.stringify(args)}`,
      tool_choice: { type: 'mcp', server_label: SERVER_LABEL, name },
      tools: [tool],
    }, timeoutMs, signal);
    const out = (Array.isArray(first.output) ? first.output : []).filter(isObj);
    const requests = out.filter((o) => o.type === 'mcp_approval_request');
    const request = requests[0];
    let requested: unknown;
    try {
      requested = request && typeof request.arguments === 'string' ? JSON.parse(request.arguments) : undefined;
    } catch {
      requested = undefined;
    }
    // Only the one call BAS asked for is approved: same server, tool and arguments.
    if (requests.length !== 1 || request!.server_label !== SERVER_LABEL || request!.name !== name || !sameJson(requested, args)) {
      if (first.status === 'incomplete' && isObj(first.incomplete_details) && first.incomplete_details.reason === 'max_output_tokens') throw new WorkIqError('workiqModelLimit');
      throw new WorkIqError('badWorkiqResponse');
    }
    const second = await this.responses({
      previous_response_id: first.id, max_output_tokens: AFTER_CALL_TOKENS, tools: [tool],
      input: [{ type: 'mcp_approval_response', approval_request_id: request!.id, approve: true }],
    }, timeoutMs, signal);
    const call = (Array.isArray(second.output) ? second.output : []).find((o) => isObj(o) && o.type === 'mcp_call' && o.name === name) as Json | undefined;
    if (!call) throw new WorkIqError('badWorkiqResponse');
    return mcpResultFromOutput(call.output, call.error);
  }
}

export interface FoundryWorkIqServiceOptions extends Omit<WorkIqCliServiceOptions, 'openSession'> {
  target: () => FoundryWorkIqTarget | null;
  deps: FoundryTransportDeps;
}

/** The project connection by name: its resource ID, and whether it points at the Work IQ MCP server. */
export async function resolveConnection(target: FoundryWorkIqTarget, deps: FoundryTransportDeps, signal?: AbortSignal): Promise<string> {
  const token = await deps.token(signal);
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${target.endpoint}/connections/${encodeURIComponent(target.connection)}?api-version=v1`, {
      redirect: 'error', signal: signal ?? AbortSignal.timeout(TOOLS_TIMEOUT_MS), headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new WorkIqError('workiqUnavailable');
  }
  const body = await res.json().catch(() => null) as unknown;
  if (!res.ok) throw httpError(res.status, body);
  if (!isObj(body) || typeof body.id !== 'string') throw new WorkIqError('badWorkiqResponse');
  const targetUrl = typeof body.target === 'string' ? body.target.replace(/\/+$/, '') : '';
  if (targetUrl !== WORKIQ_MCP_URL) throw new WorkIqError('invalidSettings');
  return body.id;
}

/**
 * The CLI service's search plan over the Foundry transport. The connection is resolved once per session; the EULA
 * belongs to the CLI and is not part of this route.
 */
export class FoundryWorkIqService extends WorkIqCliService {
  constructor(opts: FoundryWorkIqServiceOptions) {
    super({
      ...opts,
      openSession: async (signal) => {
        const target = opts.target();
        if (!target) throw new WorkIqError('notConfigured');
        const id = await resolveConnection(target, opts.deps, signal);
        return new FoundryMcpSession(target, id, opts.deps);
      },
    });
  }
}
