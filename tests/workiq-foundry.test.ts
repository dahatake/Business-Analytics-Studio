// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SecretVault } from '../server/vault.ts';
import { STRICT_RELAY_CONFIG, foundryWorkIqServiceFor, handleRelay, newRelayToken, type RelayConfig, type RelayContext, type RelayRequest } from '../server/relay.ts';
import { EntraError, type EntraTokens } from '../server/entra.ts';
import { FoundryMcpSession, FoundryWorkIqService, WORKIQ_MCP_URL, argsForSchema, mcpResultFromOutput, parseProjectEndpoint, type FoundryWorkIqTarget } from '../server/workiqFoundry.ts';

const TOKEN = newRelayToken();
const PORT = 4189;
const TENANT = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
const PROJECT = 'https://bas-foundry.services.ai.azure.com/api/projects/bas-proj';
const CONN_ID = '/subscriptions/x/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/bas-foundry/projects/bas-proj/connections/workiq-mcp';
const TARGET: FoundryWorkIqTarget = { endpoint: PROJECT, connection: 'workiq-mcp', deployment: 'model-router' };
const req = (method: string, url: string, body?: unknown): RelayRequest => ({
  method, url, remoteAddress: '127.0.0.1', localPort: PORT,
  headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'x-bas-relay': TOKEN, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Retrieval payload shaped like the remote Work IQ `retrieve` answer (synthetic content). */
const RETRIEVAL = { 'application/vnd.ms-workiq.retrieval': {
  results: [{ markdown: 'On-time delivery 92% in FY26.', webUrl: 'https://contoso.sharepoint.com/ops.pptx', entityType: 'driveItem', contentProtection: 'allowed', resourceMetadata: { document: { title: 'Ops review' } } }],
  searchMetadata: { searchTerms: ['delivery'] },
} };

type Mode = 'ok' | 'drift' | 'billing' | 'outputLimit' | 'contextLimit' | 'partialLimit';
/**
 * A stub of the Foundry project endpoints: the connection lookup and the Responses API with an MCP tool (list, forced
 * call with an approval request, then the mcp_call after the approval). `sent` records what reached Foundry.
 */
function foundryStub(mode: () => Mode) {
  const sent: { url: string; body: Record<string, unknown> | null; auth: string | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    sent.push({ url: String(url), body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (String(url) === `${PROJECT}/connections/workiq-mcp?api-version=v1`) return Response.json({ id: CONN_ID, target: WORKIQ_MCP_URL });
    if (String(url) !== `${PROJECT}/openai/v1/responses` || !body) return new Response('{}', { status: 404 });
    if (body.tool_choice === 'none') {
      return Response.json({ id: 'r0', output: [{ type: 'mcp_list_tools', server_label: 'workiq', tools: [
        // The remote schema has no timeZone (measured 2026-11-25).
        { name: 'retrieve', input_schema: { properties: { query: {}, strategy: {}, capabilities: {} }, required: ['query'] } },
        { name: 'ask', input_schema: { properties: { question: {}, fileUrls: {}, conversationId: {}, timeZone: {} }, required: ['question'] } },
      ] }] });
    }
    if (Array.isArray(body.input)) {
      const approval = body.input[0] as Record<string, unknown>;
      return Response.json({ id: 'r2', status: 'incomplete', output: [{
        type: 'mcp_call', name: 'retrieve', server_label: 'workiq', approval_request_id: approval.approval_request_id,
        output: mode() === 'billing' ? 'The caller tenant does not have a billing policy configured for WorkIQ.\n' : JSON.stringify(RETRIEVAL),
      }] });
    }
    const choice = body.tool_choice as { name: string };
    const args = JSON.parse(String(body.input).split('Arguments: ')[1]!) as Record<string, unknown>;
    if (mode() === 'contextLimit' || (mode() === 'partialLimit' && JSON.stringify(args).includes('oversized-only'))) {
      return Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 });
    }
    if (mode() === 'outputLimit') return Response.json({ id: 'r1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    if (typeof body.max_output_tokens === 'number' && JSON.stringify(args).length > body.max_output_tokens) {
      return Response.json({ id: 'r1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    }
    const asked = mode() === 'drift' ? { ...args, query: 'something else' } : args;
    return Response.json({ id: 'r1', output: [{ type: 'mcp_approval_request', id: 'apr-1', server_label: 'workiq', name: choice.name, arguments: JSON.stringify(asked) }] });
  };
  return { fetch, sent };
}

describe('Work IQ through a Microsoft Foundry project connection (transport)', () => {
  it('parses only project endpoints and keeps only the arguments the remote tool accepts', () => {
    expect(parseProjectEndpoint(`${PROJECT}/`)).toEqual({ endpoint: PROJECT, account: 'bas-foundry', project: 'bas-proj' });
    for (const bad of ['http://bas-foundry.services.ai.azure.com/api/projects/p', 'https://evil.example/api/projects/p', `${PROJECT}?x=1`, 'https://a.services.ai.azure.com/openai/v1']) {
      expect(parseProjectEndpoint(bad)).toBeNull();
    }
    expect(argsForSchema({ query: 'q', strategy: 'grounding', timeZone: 'Asia/Tokyo' }, { properties: { query: {}, strategy: {} } })).toEqual({ query: 'q', strategy: 'grounding' });
    expect(mcpResultFromOutput('{"a":1}', null)).toMatchObject({ structuredContent: { a: 1 } });
    expect(mcpResultFromOutput('The caller tenant does not have a billing policy configured for WorkIQ.', null)).toMatchObject({ isError: true });
  });

  it('lets the model reproduce long search arguments before approving the exact tool call', async () => {
    const stub = foundryStub(() => 'ok');
    const session = new FoundryMcpSession(TARGET, CONN_ID, { token: async () => 'tok', fetch: stub.fetch });
    const query = `${'長い検索条件'.repeat(100)}末尾`;
    const result = await session.request('tools/call', { name: 'retrieve', arguments: { query, strategy: 'grounding' } }, 60_000);
    expect(result).toMatchObject({ structuredContent: RETRIEVAL });
    const call = stub.sent.find((s) => typeof s.body?.input === 'string' && s.body.tool_choice !== 'none')!;
    expect(String(call.body!.input)).toContain(query);
    expect(stub.sent.some((s) => Array.isArray(s.body?.input))).toBe(true);
    session.close();
  });

  it.each(['outputLimit', 'contextLimit'] as const)('reports a Foundry model limit (%s) without approving the call', async (mode) => {
    const stub = foundryStub(() => mode);
    const session = new FoundryMcpSession(TARGET, CONN_ID, { token: async () => 'tok', fetch: stub.fetch });
    const result = await session.request('tools/call', { name: 'retrieve', arguments: { query: 'long question' } }, 60_000);
    expect(result).toMatchObject({ code: 'workiqModelLimit' });
    expect(stub.sent.some((s) => Array.isArray(s.body?.input))).toBe(false);
    session.close();
  });

  it('approves only the exact call BAS asked for and reads the raw tool output, not the model text', async () => {
    let mode: Mode = 'ok';
    const stub = foundryStub(() => mode);
    const svc = new FoundryWorkIqService({ target: () => TARGET, deps: { token: async () => 'tok', fetch: stub.fetch } });
    await svc.verify();
    const calls = stub.sent.filter((s) => s.body && !Array.isArray(s.body.input) && s.body.tool_choice !== 'none');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ model: 'model-router', tool_choice: { type: 'mcp', server_label: 'workiq', name: 'retrieve' } });
    expect(calls[0]!.body!.tools).toEqual([expect.objectContaining({ server_url: WORKIQ_MCP_URL, project_connection_id: CONN_ID, require_approval: 'always', allowed_tools: ['retrieve'] })]);
    // timeZone is not in the remote schema, so it is not asked for (the approval would otherwise never match).
    expect(String(calls[0]!.body!.input)).not.toContain('timeZone');
    const approval = stub.sent.find((s) => Array.isArray(s.body?.input))!;
    expect(approval.body).toMatchObject({ previous_response_id: 'r1', input: [{ type: 'mcp_approval_response', approval_request_id: 'apr-1', approve: true }] });
    expect(stub.sent.every((s) => s.auth === 'Bearer tok')).toBe(true);

    // The model asked for other arguments: nothing is approved and the search fails.
    mode = 'drift';
    stub.sent.length = 0;
    svc.closeSession();
    await expect(new FoundryWorkIqService({ target: () => TARGET, deps: { token: async () => 'tok', fetch: stub.fetch } }).verify()).rejects.toMatchObject({ code: 'badWorkiqResponse' });
    expect(stub.sent.some((s) => Array.isArray(s.body?.input))).toBe(false);

    // Work IQ refused (no billing policy in the tenant): reported as a refusal, not as "no data".
    mode = 'billing';
    await expect(new FoundryWorkIqService({ target: () => TARGET, deps: { token: async () => 'tok', fetch: stub.fetch } }).verify()).rejects.toMatchObject({ code: 'workiqForbidden' });
  });
});

describe('Work IQ through Microsoft Foundry in the relay', () => {
  let dir: string;
  let vault: SecretVault;
  let mode: Mode;
  const config: RelayConfig = { ...STRICT_RELAY_CONFIG, testOutbound: true };
  const entra: EntraTokens = {
    account: () => ({ username: 'user@contoso.example', tenantId: TENANT }),
    startSignIn: async () => ({ url: null }),
    signInState: () => ({ status: 'signedIn' }),
    signOut: async () => {},
    token: async (scope) => {
      if (!scope) throw new EntraError('notSignedIn');
      return { token: scope.includes('ai.azure.com') ? 'project-token' : 'foundry-token', objectId: 'o', tenantId: TENANT };
    },
  };
  const verifiedReply: typeof fetch = async () => Response.json({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });

  beforeEach(() => {
    fs.mkdirSync(join(process.cwd(), '.bas-local'), { recursive: true });
    dir = mkdtempSync(join(process.cwd(), '.bas-local', 'unit-wiqf-'));
    vault = new SecretVault(join(dir, '.bas-local'), { protector: null });
    mode = 'ok';
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const setup = async (auth: 'entraId' | 'apiKey' = 'entraId', arm: typeof globalThis.fetch = async () => new Response('{}', { status: 404 })) => {
    const stub = foundryStub(() => mode);
    const fetch: typeof globalThis.fetch = (url, init) => (String(url).startsWith('https://management.azure.com/') ? arm(url, init)
      : String(url).includes('.openai.azure.com') ? verifiedReply(url, init) : stub.fetch(url, init));
    let clock = Date.parse('2026-11-25T00:00:00Z');
    const workiqFoundry = foundryWorkIqServiceFor(vault, entra, config, fetch, () => (clock += 10_000));
    const ctx: Partial<RelayContext> = { config, entra, fetch, workiqFoundry, now: () => Date.parse('2026-11-25T00:00:00Z') };
    const call = (r: RelayRequest) => handleRelay(r, { vault, token: TOKEN, ...ctx });
    if (auth === 'apiKey') {
      await call(req('PUT', '/relay/secrets/foundryKey', { value: 'sk-test-0123456789abcdefFAKEKEY' }));
      await call(req('PUT', '/relay/connection', { endpoint: 'https://bas-foundry.openai.azure.com/openai/v1', deployment: 'model-router' }));
    } else {
      expect((await call(req('PUT', '/relay/connection', { endpoint: 'https://bas-foundry.openai.azure.com/openai/v1', deployment: 'model-router', auth: 'entraId', tenantId: TENANT }))).status).toBe(200);
    }
    await call(req('PUT', '/relay/workiq', { method: 'cli' }));
    return { call, stub };
  };

  it('surfaces model limits through verification and Project retrieval', async () => {
    const { call } = await setup();
    await call(req('PUT', '/relay/workiq/foundry', { endpoint: PROJECT, connection: 'workiq-mcp' }));
    mode = 'outputLimit';
    expect(await call(req('POST', '/relay/workiq/foundry/verify', { provider: 'foundry' }))).toMatchObject({ status: 502, body: { error: 'workiqModelLimit' } });
    mode = 'ok';
    expect((await call(req('POST', '/relay/workiq/foundry/verify', { provider: 'foundry' }))).status).toBe(200);
    mode = 'contextLimit';
    const input = { provider: 'foundry', company: 'Contoso', project: 'Delivery', purpose: 'Reduce late deliveries', focus: '', asOf: '2026-11-25', lang: 'en', timeZone: 'Asia/Tokyo' };
    expect(await call(req('POST', '/relay/workiq/ask', input))).toMatchObject({ status: 502, body: { error: 'workiqModelLimit' } });
    expect(await call(req('POST', '/relay/workiq/ask', { ...input, topics: ['details'] }))).toMatchObject({ status: 502, body: { error: 'workiqModelLimit' } });
    mode = 'partialLimit';
    const partial = await call(req('POST', '/relay/workiq/ask', { ...input, topics: ['normal', 'oversized-only'] }));
    expect(partial.body).toMatchObject({ sections: [expect.objectContaining({ key: 'topic-1' }), { key: 'topic-2', error: 'workiqModelLimit' }] });
  });

  it('uses the Foundry route only after its own check passes, then turns the CLI route off until it is removed', async () => {
    const { call, stub } = await setup();
    expect((await call(req('PUT', '/relay/workiq/foundry', { endpoint: 'https://other.services.ai.azure.com/api/projects/p', connection: 'workiq-mcp' }))).body).toEqual({ error: 'invalidSettings' });
    const saved = await call(req('PUT', '/relay/workiq/foundry', { endpoint: PROJECT, connection: 'workiq-mcp' }));
    expect(saved.body).toMatchObject({ workiq: { method: 'cli', foundry: { endpoint: PROJECT, connection: 'workiq-mcp', verifiedAt: null } } });

    // A refused check (no billing policy) keeps the CLI route in use and changeable.
    mode = 'billing';
    expect(await call(req('POST', '/relay/workiq/foundry/verify', { provider: 'foundry' }))).toMatchObject({ status: 403, body: { error: 'workiqForbidden' } });
    // The refusal is kept so the settings screen can disable the Foundry route until the user asks to check again.
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ workiq: { method: 'cli', foundry: { verifiedAt: null, refusedAt: '2026-11-25T00:00:00.000Z' } } });
    expect((await call(req('PUT', '/relay/workiq', { method: 'cli' }))).status).toBe(200);
    expect((await call(req('PUT', '/relay/workiq/foundry', { endpoint: PROJECT, connection: 'workiq-mcp' }))).body).toMatchObject({ workiq: { foundry: { refusedAt: '2026-11-25T00:00:00.000Z' } } });

    mode = 'ok';
    const ok = await call(req('POST', '/relay/workiq/foundry/verify', { provider: 'foundry' }));
    expect(ok.body).toMatchObject({ workiq: { method: 'foundry', signedIn: true, verifiedAt: '2026-11-25T00:00:00.000Z', foundry: { refusedAt: null } } });
    expect(stub.sent.filter((s) => s.url.endsWith('/responses')).every((s) => s.auth === 'Bearer project-token')).toBe(true);
    // The CLI (and app) settings are off while the Foundry route is in use.
    for (const [m, p, b] of [['PUT', '/relay/workiq', { method: 'cli' }], ['POST', '/relay/workiq/verify', { provider: 'foundry' }], ['POST', '/relay/workiq/eula', { provider: 'foundry', accept: true }], ['DELETE', '/relay/workiq', undefined]] as const) {
      expect(await call(req(m, p, b))).toMatchObject({ status: 409, body: { error: 'workiqViaFoundry' } });
    }
    // Pack searches go through Foundry.
    const before = stub.sent.length;
    const ask = await call(req('POST', '/relay/workiq/ask', { provider: 'foundry', company: 'Contoso', project: 'Delivery', purpose: 'Reduce late deliveries', focus: '', asOf: '2026-11-25', lang: 'en', timeZone: 'Asia/Tokyo' }));
    expect(ask.status).toBe(200);
    expect(ask.body).toMatchObject({ citations: [{ url: 'https://contoso.sharepoint.com/ops.pptx' }] });
    expect(stub.sent.length).toBeGreaterThan(before);

    // Editing the saved route breaks its seal; removing it returns to the CLI.
    const path = join(vault.dir, 'workiq-foundry.json');
    const original = fs.readFileSync(path, 'utf8');
    fs.writeFileSync(path, original.replace('workiq-mcp', 'workiq-mcp2'));
    expect((await call(req('GET', '/relay/status'))).body).toMatchObject({ workiq: { method: 'cli' } });
    fs.writeFileSync(path, original);
    expect((await call(req('DELETE', '/relay/workiq/foundry'))).body).toMatchObject({ workiq: { method: 'cli' } });
    expect(((await call(req('GET', '/relay/status'))).body as { workiq: Record<string, unknown> }).workiq.foundry).toBeUndefined();
    expect((await call(req('PUT', '/relay/workiq', { method: 'cli' }))).status).toBe(200);
  });

  it('needs an Entra ID Foundry connection: an API-key connection cannot carry the user\'s Work IQ token', async () => {
    const { call } = await setup('apiKey');
    expect(await call(req('PUT', '/relay/workiq/foundry', { endpoint: PROJECT, connection: 'workiq-mcp' }))).toMatchObject({ status: 409, body: { error: 'foundryEntraRequired' } });
  });

  it('lists the Work IQ MCP connections of the saved Foundry resource from ARM and says why one cannot be used', async () => {
    const account = '/subscriptions/11111111-2222-4333-8444-555555555555/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/bas-foundry';
    const conn = (name: string, target: string, authType: string, audience?: string) => ({ name, properties: { target, authType, ...(audience ? { audience } : {}) } });
    const armCalls: string[] = [];
    const arm: typeof globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      armCalls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
      if (u.pathname === '/providers/Microsoft.ResourceGraph/resources') {
        return Response.json({ data: [
          { id: account, name: 'bas-foundry', kind: 'AIServices', customSubDomain: 'bas-foundry', tenantId: TENANT, subscriptionId: 's1', resourceGroup: 'rg', location: 'japaneast' },
          { id: '/subscriptions/11111111-2222-4333-8444-555555555555/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/other', name: 'other', kind: 'AIServices', customSubDomain: 'other', tenantId: TENANT, subscriptionId: 's1' },
        ] });
      }
      if (u.pathname === `${account}/projects`) {
        return Response.json({ value: [
          { id: `${account}/projects/bas-proj`, name: 'bas-foundry/bas-proj', properties: { endpoints: { 'AI Foundry API': PROJECT } } },
          { id: `${account}/projects/p2`, name: 'p2', properties: { endpoints: { 'AI Foundry API': 'https://bas-foundry.services.ai.azure.com/api/projects/p2' } } },
        ] });
      }
      if (u.pathname === `${account}/projects/bas-proj/connections`) {
        return Response.json({ value: [conn('workiq-mcp', WORKIQ_MCP_URL, 'UserEntraToken', 'fdcc1f02-fc51-4226-8753-f668596af7f7'), conn('other-mcp', 'https://example.com/mcp', 'UserEntraToken', 'x')] });
      }
      if (u.pathname === `${account}/projects/p2/connections`) return Response.json({ value: [conn('workiq-key', `${WORKIQ_MCP_URL}/`, 'UserEntraToken', '00000000-0000-0000-0000-000000000000')] });
      return new Response('{}', { status: 404 });
    };
    const { call, stub } = await setup('entraId', arm);
    const found = await call(req('POST', '/relay/workiq/foundry/discover'));
    expect(found).toMatchObject({ status: 200, body: { account: 'bas-foundry', projects: 2 } });
    expect((found.body as { candidates: unknown[] }).candidates).toEqual([
      { endpoint: PROJECT, project: 'bas-proj', connection: 'workiq-mcp', problem: null },
      { endpoint: 'https://bas-foundry.services.ai.azure.com/api/projects/p2', project: 'p2', connection: 'workiq-key', problem: 'audience' },
    ]);
    // Only ARM is read: nothing reaches a model or Work IQ, and the other resource's projects are not listed.
    expect(stub.sent).toEqual([]);
    expect(armCalls.some((c) => c.includes('/accounts/other/'))).toBe(false);
    expect((await call(req('GET', '/relay/workiq/foundry/discover'))).status).toBe(405);
  });

  it('cannot discover a Work IQ connection without an Entra ID Foundry connection', async () => {
    const { call } = await setup('apiKey');
    expect(await call(req('POST', '/relay/workiq/foundry/discover'))).toMatchObject({ status: 409, body: { error: 'foundryEntraRequired' } });
  });
});
