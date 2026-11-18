import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type ICachePlugin } from '@azure/msal-node';
import type { SecretVault } from './vault.ts';
import { ENTRA_HOST } from './workiq.ts';

/**
 * Microsoft Entra ID sign-in for Microsoft Foundry (user request 2026-11-18). The relay signs the user in once with the
 * OAuth 2.0 authorization code flow + PKCE (MSAL Node, loopback redirect on this PC) and keeps MSAL's token cache only
 * in the encrypted vault (AES-256-GCM, master key under Windows DPAPI), so later launches reuse the sign-in silently
 * until the refresh token expires or Conditional Access asks again. Access tokens never leave the relay.
 *
 * With the user's own delegated rights the relay lists Foundry resources (Azure Resource Graph), their deployments and
 * whether the user may call them (Microsoft.Authorization/permissions), and on explicit request assigns the
 * least-privilege data-plane role "Cognitive Services OpenAI User" on one resource.
 */

/** Azure CLI's public client (also Azure Identity's default for developer sign-in); BAS_ENTRA_CLIENT_ID overrides it. */
export const DEFAULT_ENTRA_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
export const ARM_HOST = 'management.azure.com';
/** BAS_RELAY_OUTBOUND_HOSTS must list both when it is set (the Foundry host is checked separately). */
export const ENTRA_OUTBOUND_HOSTS = [ENTRA_HOST, ARM_HOST] as const;
export const ARM_SCOPE = `https://${ARM_HOST}/.default`;
export const FOUNDRY_SCOPE = 'https://cognitiveservices.azure.com/.default';
/** Built-in role with exactly the inference data actions (Learn: "Role-based access control for Azure OpenAI"). */
export const OPENAI_USER_ROLE_ID = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd';
export const CHAT_DATA_ACTION = 'Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action';
/** "Cognitive Services Speech User": speech recognition and synthesis data actions only. */
export const SPEECH_USER_ROLE_ID = 'f2dc8367-1007-4938-bd23-fe263f013447';
export const SPEECH_DATA_ACTION = 'Microsoft.CognitiveServices/accounts/SpeechServices/unified-speech/frontend/action';
/** "Cognitive Services User": Azure AI Vision has no narrower built-in data-plane role (this one can also list keys). */
export const COGNITIVE_USER_ROLE_ID = 'a97b65f3-24c7-4388-baec-2e87135dc908';
export const VISION_DATA_ACTION = 'Microsoft.CognitiveServices/accounts/ComputerVision/imageanalysis:analyze/action';
const ROLE_WRITE_ACTION = 'Microsoft.Authorization/roleAssignments/write';
const STATE_FILE = 'entra.json';
const SIGN_IN_WAIT_MS = 15_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const ARM_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.CognitiveServices\/accounts\/[A-Za-z0-9_.-]{2,64}$/i;

export type EntraErrorCode =
  | 'notSignedIn' | 'interactionRequired' | 'signInPending' | 'signInFailed' | 'authFailed' | 'invalidResource' | 'invalidTenant'
  | 'armForbidden' | 'armError' | 'armTimeout' | 'roleAssignFailed';

export class EntraError extends Error {
  readonly code: EntraErrorCode;

  constructor(code: EntraErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface EntraAccountInfo {
  username: string;
  tenantId: string;
}

export type EntraSignIn = { status: 'idle' | 'pending' | 'signedIn' } | { status: 'failed'; error: EntraErrorCode };

export interface EntraToken {
  token: string;
  /** Object ID of the user in the token's tenant (differs per tenant for guests). */
  objectId: string;
  tenantId: string;
}

/** Token side of the sign-in (MSAL in the app; a stub in tests). */
export interface EntraTokens {
  account(): EntraAccountInfo | null;
  startSignIn(tenantId?: string): Promise<{ url: string | null }>;
  signInState(): EntraSignIn;
  signOut(): Promise<void>;
  token(scope: string, tenantId?: string, signal?: AbortSignal): Promise<EntraToken>;
}

export function isTenantId(v: unknown): v is string {
  return typeof v === 'string' && GUID.test(v);
}

export function isFoundryResourceId(v: unknown): v is string {
  return typeof v === 'string' && RESOURCE_ID.test(v);
}

interface SavedEntra {
  homeAccountId: string;
  username: string;
  tenantId: string;
}

function loadState(dir: string): SavedEntra | null {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<SavedEntra>;
    return typeof v.homeAccountId === 'string' && typeof v.username === 'string' && isTenantId(v.tenantId)
      ? { homeAccountId: v.homeAccountId, username: v.username, tenantId: v.tenantId } : null;
  } catch {
    return null;
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;margin:3rem"><h1>${title}</h1><p>${body}</p></body></html>`;
const SUCCESS_PAGE = page('サインインしました / Signed in', 'Business Analytics Studio に戻ってください。このタブは閉じてかまいません。<br>Return to Business Analytics Studio; you can close this tab.');
const ERROR_PAGE = page('サインインできませんでした / Sign-in failed', 'Business Analytics Studio に戻り、もう一度お試しください。<br>Return to Business Analytics Studio and try again.');

/**
 * MSAL Node public client. The serialized token cache (refresh tokens) is a vault secret; `entra.json` keeps only the
 * account name, home tenant and MSAL's account key so the settings can show who is signed in without decrypting.
 */
export class MsalEntraTokens implements EntraTokens {
  private readonly vault: SecretVault;
  private readonly writeState: (s: SavedEntra | null) => void;
  private readonly clientId: string;
  private pca: PublicClientApplication | null = null;
  private pending: { url: string | null; startedAt: number } | null = null;
  private state: EntraSignIn = { status: 'idle' };

  constructor(vault: SecretVault, writeState: (s: SavedEntra | null) => void, clientId: string = process.env.BAS_ENTRA_CLIENT_ID || DEFAULT_ENTRA_CLIENT_ID) {
    this.vault = vault;
    this.writeState = writeState;
    this.clientId = GUID.test(clientId) ? clientId : DEFAULT_ENTRA_CLIENT_ID;
  }

  private client(): PublicClientApplication {
    const vault = this.vault;
    const cachePlugin: ICachePlugin = {
      beforeCacheAccess: async (ctx) => {
        const saved = vault.get('entraTokenCache');
        if (saved) ctx.tokenCache.deserialize(saved);
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) vault.set('entraTokenCache', ctx.tokenCache.serialize());
      },
    };
    this.pca ??= new PublicClientApplication({
      auth: { clientId: this.clientId, authority: `https://${ENTRA_HOST}/organizations` },
      cache: { cachePlugin },
    });
    return this.pca;
  }

  account(): EntraAccountInfo | null {
    const s = loadState(this.vault.dir);
    return s ? { username: s.username, tenantId: s.tenantId } : null;
  }

  signInState(): EntraSignIn {
    if (this.state.status === 'pending' && this.pending && Date.now() - this.pending.startedAt > SIGN_IN_TTL_MS) {
      this.pending = null;
      this.state = { status: 'failed', error: 'signInFailed' };
    }
    return this.state;
  }

  async startSignIn(tenantId?: string): Promise<{ url: string | null }> {
    if (this.signInState().status === 'pending' && this.pending?.url) return { url: this.pending.url };
    const current = loadState(this.vault.dir);
    let resolveUrl: (url: string) => void = () => undefined;
    const urlReady = new Promise<string>((r) => { resolveUrl = r; });
    const pending: { url: string | null; startedAt: number } = { url: null, startedAt: Date.now() };
    this.pending = pending;
    this.state = { status: 'pending' };
    const flow = this.client().acquireTokenInteractive({
      scopes: [ARM_SCOPE],
      ...(tenantId ? { authority: `https://${ENTRA_HOST}/${tenantId}` } : {}),
      ...(tenantId && current ? { loginHint: current.username } : { prompt: 'select_account' }),
      // The settings screen opens this URL in the user's browser; the redirect comes back to MSAL's loopback listener.
      openBrowser: async (url) => {
        pending.url = url;
        resolveUrl(url);
      },
      successTemplate: SUCCESS_PAGE,
      errorTemplate: ERROR_PAGE,
    });
    flow.then((result) => {
      if (this.pending !== pending) return;
      this.pending = null;
      const a = result.account;
      if (!a || !isTenantId(a.tenantId) || (tenantId && result.tenantId.toLowerCase() !== tenantId.toLowerCase())
        || (tenantId && current && current.homeAccountId !== a.homeAccountId)) {
        this.state = { status: 'failed', error: 'signInFailed' };
        return;
      }
      // A guest sign-in to another tenant keeps the home account; a different user replaces it.
      const keep = current && current.homeAccountId === a.homeAccountId;
      this.writeState(keep ? current : { homeAccountId: a.homeAccountId, username: a.username, tenantId: homeTenant(a) });
      this.state = { status: 'signedIn' };
    }, () => {
      if (this.pending !== pending) return;
      this.pending = null;
      this.state = { status: 'failed', error: 'signInFailed' };
    });
    const url = await Promise.race([
      urlReady,
      flow.then(() => null, () => null),
      new Promise<null>((r) => setTimeout(() => r(null), SIGN_IN_WAIT_MS)),
    ]);
    if (url === null && this.signInState().status === 'failed') throw new EntraError('signInFailed');
    return { url };
  }

  async signOut(): Promise<void> {
    this.pending = null;
    this.state = { status: 'idle' };
    this.writeState(null);
    this.vault.delete('entraTokenCache');
    this.pca = null;
  }

  async token(scope: string, tenantId?: string): Promise<EntraToken> {
    const saved = loadState(this.vault.dir);
    if (!saved) throw new EntraError('notSignedIn');
    const pca = this.client();
    let account: AccountInfo | null = null;
    try {
      account = await pca.getTokenCache().getAccountByHomeId(saved.homeAccountId);
    } catch {
      account = null;
    }
    if (!account) throw new EntraError('notSignedIn');
    const targetTenant = (tenantId ?? saved.tenantId).toLowerCase();
    const profile = account.tenantProfiles?.get(targetTenant);
    if (profile) account = { ...account, ...profile };
    try {
      const r = await pca.acquireTokenSilent({
        account, scopes: [scope], authority: `https://${ENTRA_HOST}/${targetTenant}`,
        // MSAL keys cached tokens by account.tenantId before authority; an unseen tenant must use its refresh flow.
        forceRefresh: account.tenantId.toLowerCase() !== targetTenant,
      });
      if (!r.accessToken || r.tenantId.toLowerCase() !== targetTenant) throw new EntraError('authFailed');
      return { token: r.accessToken, objectId: r.uniqueId, tenantId: r.tenantId };
    } catch (error) {
      if (error instanceof EntraError) throw error;
      throw new EntraError(error instanceof InteractionRequiredAuthError ? 'interactionRequired' : 'authFailed');
    }
  }
}

function homeTenant(a: AccountInfo): string {
  const fromHome = a.homeAccountId.split('.')[1];
  return isTenantId(fromHome) ? fromHome : a.tenantId;
}

export function saveEntraState(dir: string, write: (dir: string, file: string, value: unknown) => void) {
  return (s: SavedEntra | null) => {
    if (s) write(dir, STATE_FILE, s);
    else rmSync(join(dir, STATE_FILE), { force: true });
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Azure Resource Manager (delegated, read-only except the explicit role assignment)                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface FoundryInstance {
  id: string;
  name: string;
  kind: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  subscriptionName: string;
  tenantId: string;
  /** `<origin>/openai/v1`, or null when the resource has no custom subdomain (Entra ID needs one). */
  endpoint: string | null;
  /** API keys are disabled on the resource: only Entra ID works. */
  keyAuthDisabled: boolean;
}

export interface FoundryTenant {
  tenantId: string;
  name: string;
  /** False when the tenant needs its own sign-in (MFA, Conditional Access, or a guest invitation not yet used). */
  signedIn: boolean;
}

export interface FoundryDeploymentInfo {
  name: string;
  model: string;
  version: string;
  sku: string;
}

export interface FoundryAccess {
  /** The user holds the chat-completions data action on this resource. */
  canCall: boolean;
  /** The user may create role assignments here (Owner / User Access Administrator / RBAC Administrator). */
  canAssign: boolean;
}

interface ArmDeps {
  tokens: EntraTokens;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

async function arm<T>(deps: ArmDeps, tenantId: string | undefined, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T | null }> {
  const acquired = await deps.tokens.token(ARM_SCOPE, tenantId, deps.signal);
  if (tenantId && acquired.tenantId.toLowerCase() !== tenantId.toLowerCase()) throw new EntraError('authFailed');
  const timeout = AbortSignal.timeout(ARM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await deps.fetch(`https://${ARM_HOST}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${acquired.token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
    });
  } catch {
    throw new EntraError(timeout.aborted ? 'armTimeout' : 'armError');
  }
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Service on the Foundry resource whose data-plane role is checked and granted (one shared sign-in, FR-328). */
export type EntraService = 'foundry' | 'speech' | 'vision';

/** Speech and Vision run on the same Foundry resource but need their own data-plane role. */
const SERVICES: Record<EntraService, { dataAction: string; roleId: string }> = {
  foundry: { dataAction: CHAT_DATA_ACTION, roleId: OPENAI_USER_ROLE_ID },
  speech: { dataAction: SPEECH_DATA_ACTION, roleId: SPEECH_USER_ROLE_ID },
  vision: { dataAction: VISION_DATA_ACTION, roleId: COGNITIVE_USER_ROLE_ID },
};

const INSTANCE_QUERY = [
  "resources | where type =~ 'microsoft.cognitiveservices/accounts' and kind =~ 'AIServices'",
  "| join kind=leftouter (resourcecontainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, subscriptionName = name) on subscriptionId",
  '| project id, name, kind, location, resourceGroup, subscriptionId, subscriptionName, tenantId,',
  '  endpoint = tostring(properties.endpoint), customSubDomain = tostring(properties.customSubDomainName), disableLocalAuth = tobool(properties.disableLocalAuth)',
  '| order by subscriptionName asc, name asc, id asc',
].join('\n');

interface GraphRow {
  id?: unknown; name?: unknown; kind?: unknown; location?: unknown; resourceGroup?: unknown; subscriptionId?: unknown;
  subscriptionName?: unknown; tenantId?: unknown; endpoint?: unknown; customSubDomain?: unknown; disableLocalAuth?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Entra ID tokens need the resource's custom subdomain; the Foundry v1 API is served on its Azure OpenAI host. */
function instanceEndpoint(row: GraphRow): string | null {
  const sub = str(row.customSubDomain).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(sub) ? `https://${sub}.openai.azure.com/openai/v1` : null;
}

/** ARM's account tenant list can be paged and need not include every directory where a user is a guest. */
export async function listFoundryTenants(deps: ArmDeps): Promise<FoundryTenant[]> {
  const account = deps.tokens.account();
  if (!account) throw new EntraError('notSignedIn');
  const tenants = new Map<string, FoundryTenant>();
  const visited = new Set<string>();
  let path = '/tenants?api-version=2022-12-01';
  while (path) {
    if (visited.has(path) || visited.size >= MAX_PAGES) throw new EntraError('armError');
    visited.add(path);
    const listed = await arm<{ value?: { tenantId?: unknown; displayName?: unknown; defaultDomain?: unknown }[]; nextLink?: unknown }>(deps, undefined, path);
    if (listed.status !== 200) throw new EntraError(listed.status === 401 || listed.status === 403 ? 'armForbidden' : 'armError');
    if (!Array.isArray(listed.body?.value)) throw new EntraError('armError');
    for (const t of listed.body.value) {
      if (!isTenantId(t.tenantId)) continue;
      const tenantId = t.tenantId.toLowerCase();
      tenants.set(tenantId, { tenantId, name: str(t.displayName) || str(t.defaultDomain) || tenantId, signedIn: false });
    }
    const next = listed.body.nextLink;
    if (next === undefined || next === null || next === '') break;
    if (typeof next !== 'string') throw new EntraError('armError');
    let url: URL;
    try { url = new URL(next); } catch { throw new EntraError('armError'); }
    if (url.protocol !== 'https:' || url.host !== ARM_HOST || url.pathname.toLowerCase() !== '/tenants' || url.username || url.password || url.hash) throw new EntraError('armError');
    path = `${url.pathname}${url.search}`;
  }
  const home = account.tenantId.toLowerCase();
  if (!tenants.has(home)) tenants.set(home, { tenantId: home, name: home, signedIn: false });
  return [...tenants.values()];
}

/** Foundry (AIServices) resources visible in one explicitly selected directory. */
export async function listFoundryInstancesForTenant(deps: ArmDeps, tenantId: string): Promise<FoundryInstance[]> {
  if (!deps.tokens.account()) throw new EntraError('notSignedIn');
  if (!isTenantId(tenantId)) throw new EntraError('invalidTenant');
  tenantId = tenantId.toLowerCase();
  const rows: GraphRow[] = [];
  const visited = new Set<string>();
  let skipToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await arm<{ data?: GraphRow[]; $skipToken?: unknown; resultTruncated?: unknown }>(deps, tenantId, '/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01', {
      method: 'POST', body: { query: INSTANCE_QUERY, options: { resultFormat: 'objectArray', $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) } },
    });
    if (r.status !== 200) throw new EntraError(r.status === 401 || r.status === 403 ? 'armForbidden' : 'armError');
    if (!Array.isArray(r.body?.data)) throw new EntraError('armError');
    rows.push(...r.body.data);
    const next = r.body.$skipToken;
    if (!next) {
      if (r.body.resultTruncated === true || r.body.resultTruncated === 'true') throw new EntraError('armError');
      break;
    }
    if (typeof next !== 'string' || visited.has(next) || page === MAX_PAGES - 1) throw new EntraError('armError');
    visited.add(next);
    skipToken = next;
  }
  const seen = new Set<string>();
  const instances: FoundryInstance[] = [];
  for (const row of rows) {
    const id = str(row.id);
    if (isTenantId(row.tenantId) && row.tenantId.toLowerCase() !== tenantId) continue;
    if (str(row.kind).toLowerCase() !== 'aiservices' || !isFoundryResourceId(id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    instances.push({
      id, name: str(row.name), kind: str(row.kind), location: str(row.location), resourceGroup: str(row.resourceGroup),
      subscriptionId: str(row.subscriptionId), subscriptionName: str(row.subscriptionName) || str(row.subscriptionId),
      tenantId, endpoint: instanceEndpoint(row), keyAuthDisabled: row.disableLocalAuth === true,
    });
  }
  return instances;
}

/** Backwards-compatible combined listing. */
export async function listFoundryInstances(deps: ArmDeps): Promise<{ instances: FoundryInstance[]; tenants: FoundryTenant[] }> {
  const tenantList = await listFoundryTenants(deps);
  const results = await Promise.all(tenantList.map(async (t) => {
    try {
      return { tenant: { ...t, signedIn: true }, instances: await listFoundryInstancesForTenant(deps, t.tenantId) };
    } catch (error) {
      if (error instanceof EntraError && (error.code === 'interactionRequired' || error.code === 'authFailed')) return { tenant: { ...t, signedIn: false }, instances: [] };
      throw error;
    }
  }));
  return { instances: results.flatMap((r) => r.instances), tenants: results.map((r) => r.tenant) };
}

const actionMatches = (pattern: string, action: string) =>
  new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(action);

/** Effective permission from ARM's permissions list (allowed by some entry, not excluded by that entry's not-list). */
export function permitted(perms: { actions?: string[]; notActions?: string[]; dataActions?: string[]; notDataActions?: string[] }[], action: string, data: boolean): boolean {
  return perms.some((p) => {
    const allow = (data ? p.dataActions : p.actions) ?? [];
    const deny = (data ? p.notDataActions : p.notActions) ?? [];
    return allow.some((a) => actionMatches(a, action)) && !deny.some((a) => actionMatches(a, action));
  });
}

async function resourcePermissions(deps: ArmDeps, resourceId: string, tenantId: string) {
  return arm<{ value?: { actions?: string[]; notActions?: string[]; dataActions?: string[]; notDataActions?: string[] }[] }>(
    deps, tenantId, `${resourceId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`);
}

/**
 * Whether the user may call one Speech or Vision resource (its data action) or grant themselves the role. Speech and
 * Vision have no deployments; an unreadable resource is reported like Foundry's.
 */
export async function inspectMediaResource(deps: ArmDeps, resourceId: string, tenantId: string, service: Exclude<EntraService, 'foundry'>): Promise<{ deployments: FoundryDeploymentInfo[]; access: FoundryAccess }> {
  if (!isFoundryResourceId(resourceId)) throw new EntraError('invalidResource');
  if (!isTenantId(tenantId)) throw new EntraError('invalidTenant');
  const permissions = await resourcePermissions(deps, resourceId, tenantId);
  if (permissions.status === 401 || permissions.status === 403) throw new EntraError('armForbidden');
  if (permissions.status !== 200) throw new EntraError('armError');
  const perms = permissions.body?.value ?? [];
  return { deployments: [], access: { canCall: permitted(perms, SERVICES[service].dataAction, true), canAssign: permitted(perms, ROLE_WRITE_ACTION, false) } };
}

/** Chat deployments of one resource and whether the user may call it or grant themselves the role. */
export async function inspectFoundryInstance(deps: ArmDeps, resourceId: string, tenantId: string): Promise<{ deployments: FoundryDeploymentInfo[]; access: FoundryAccess }> {
  if (!isFoundryResourceId(resourceId)) throw new EntraError('invalidResource');
  if (!isTenantId(tenantId)) throw new EntraError('invalidTenant');
  const [deployments, permissions] = await Promise.all([
    arm<{ value?: { name?: unknown; sku?: { name?: unknown }; properties?: { model?: { name?: unknown; version?: unknown }; provisioningState?: unknown; capabilities?: Record<string, unknown> } }[] }>(
      deps, tenantId, `${resourceId}/deployments?api-version=2024-10-01`),
    resourcePermissions(deps, resourceId, tenantId),
  ]);
  if (deployments.status === 403 || deployments.status === 401) throw new EntraError('armForbidden');
  if (deployments.status !== 200) throw new EntraError('armError');
  const list = (deployments.body?.value ?? [])
    .filter((d) => str(d.properties?.provisioningState).toLowerCase() === 'succeeded')
    // Embeddings, audio and image deployments cannot answer chat completions.
    .filter((d) => d.properties?.capabilities?.chatCompletion === 'true' || d.properties?.capabilities?.chatCompletion === undefined && d.properties?.capabilities?.embeddings !== 'true')
    .map((d) => ({ name: str(d.name), model: str(d.properties?.model?.name), version: str(d.properties?.model?.version), sku: str(d.sku?.name) }))
    .filter((d) => /^[A-Za-z0-9._-]{1,64}$/.test(d.name));
  const perms = permissions.status === 200 ? permissions.body?.value ?? [] : [];
  return { deployments: list, access: { canCall: permitted(perms, CHAT_DATA_ACTION, true), canAssign: permitted(perms, ROLE_WRITE_ACTION, false) } };
}

/**
 * Assigns the service's least-privilege role on one resource to the signed-in user (explicit request only):
 * "Cognitive Services OpenAI User", "Cognitive Services Speech User" or "Cognitive Services User" (Vision).
 */
export async function assignFoundryRole(deps: ArmDeps, resourceId: string, tenantId: string, service: EntraService = 'foundry'): Promise<void> {
  if (!isFoundryResourceId(resourceId)) throw new EntraError('invalidResource');
  if (!isTenantId(tenantId)) throw new EntraError('invalidTenant');
  const subscriptionId = RESOURCE_ID.exec(resourceId)![1]!;
  const { objectId } = await deps.tokens.token(ARM_SCOPE, tenantId, deps.signal);
  if (!GUID.test(objectId)) throw new EntraError('roleAssignFailed');
  const r = await arm<{ error?: { code?: unknown } }>(deps, tenantId, `${resourceId}/providers/Microsoft.Authorization/roleAssignments/${randomUUID()}?api-version=2022-04-01`, {
    method: 'PUT',
    body: { properties: { roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${SERVICES[service].roleId}`, principalId: objectId, principalType: 'User' } },
  });
  if (r.status === 200 || r.status === 201) return;
  if (r.status === 409 && r.body?.error?.code === 'RoleAssignmentExists') return;
  throw new EntraError(r.status === 403 ? 'armForbidden' : 'roleAssignFailed');
}
