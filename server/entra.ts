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
const ROLE_WRITE_ACTION = 'Microsoft.Authorization/roleAssignments/write';
const STATE_FILE = 'entra.json';
const SIGN_IN_WAIT_MS = 15_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const ARM_TIMEOUT_MS = 30_000;
const MAX_TENANTS = 25;

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
      if (!a || !isTenantId(a.tenantId)) {
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
    try {
      const r = await pca.acquireTokenSilent({ account, scopes: [scope], authority: `https://${ENTRA_HOST}/${tenantId ?? saved.tenantId}` });
      if (!r.accessToken) throw new EntraError('authFailed');
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
  const { token } = await deps.tokens.token(ARM_SCOPE, tenantId, deps.signal);
  const timeout = AbortSignal.timeout(ARM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await deps.fetch(`https://${ARM_HOST}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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

const INSTANCE_QUERY = [
  "resources | where type =~ 'microsoft.cognitiveservices/accounts' and kind =~ 'AIServices'",
  "| join kind=leftouter (resourcecontainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, subscriptionName = name) on subscriptionId",
  '| project id, name, kind, location, resourceGroup, subscriptionId, subscriptionName, tenantId,',
  '  endpoint = tostring(properties.endpoint), customSubDomain = tostring(properties.customSubDomainName), disableLocalAuth = tobool(properties.disableLocalAuth)',
  '| order by subscriptionName asc, name asc',
].join('\n');

interface GraphRow {
  id?: unknown; name?: unknown; kind?: unknown; location?: unknown; resourceGroup?: unknown; subscriptionId?: unknown;
  subscriptionName?: unknown; tenantId?: unknown; endpoint?: unknown; customSubDomain?: unknown; disableLocalAuth?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Entra ID tokens need the resource's custom subdomain; the v1 API is served on its Azure OpenAI host. */
function instanceEndpoint(row: GraphRow): string | null {
  const sub = str(row.customSubDomain).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(sub) ? `https://${sub}.openai.azure.com/openai/v1` : null;
}

/** Foundry (AIServices) resources the signed-in user can read, across every tenant that signs in silently. */
export async function listFoundryInstances(deps: ArmDeps): Promise<{ instances: FoundryInstance[]; tenants: FoundryTenant[] }> {
  const account = deps.tokens.account();
  if (!account) throw new EntraError('notSignedIn');
  const listed = await arm<{ value?: { tenantId?: unknown; displayName?: unknown; defaultDomain?: unknown }[] }>(deps, undefined, '/tenants?api-version=2022-12-01');
  if (listed.status !== 200) throw new EntraError(listed.status === 401 || listed.status === 403 ? 'armForbidden' : 'armError');
  const tenantList = (listed.body?.value ?? [])
    .filter((t) => isTenantId(t.tenantId))
    .map((t) => ({ tenantId: (t.tenantId as string).toLowerCase(), name: str(t.displayName) || str(t.defaultDomain) || (t.tenantId as string) }))
    .slice(0, MAX_TENANTS);
  if (!tenantList.some((t) => t.tenantId === account.tenantId.toLowerCase())) tenantList.unshift({ tenantId: account.tenantId.toLowerCase(), name: account.tenantId });
  const results = await Promise.all(tenantList.map(async (t) => {
    try {
      const r = await arm<{ data?: GraphRow[] }>(deps, t.tenantId, '/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01', {
        method: 'POST', body: { query: INSTANCE_QUERY, options: { resultFormat: 'objectArray', $top: 1000 } },
      });
      if (r.status !== 200) return { tenant: { ...t, signedIn: true }, rows: [] as GraphRow[] };
      return { tenant: { ...t, signedIn: true }, rows: r.body?.data ?? [] };
    } catch (error) {
      if (error instanceof EntraError && (error.code === 'interactionRequired' || error.code === 'authFailed')) return { tenant: { ...t, signedIn: false }, rows: [] };
      throw error;
    }
  }));
  const seen = new Set<string>();
  const instances: FoundryInstance[] = [];
  for (const { tenant, rows } of results) {
    for (const row of rows) {
      const id = str(row.id);
      if (str(row.kind).toLowerCase() !== 'aiservices' || !isFoundryResourceId(id) || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      instances.push({
        id, name: str(row.name), kind: str(row.kind), location: str(row.location), resourceGroup: str(row.resourceGroup),
        subscriptionId: str(row.subscriptionId), subscriptionName: str(row.subscriptionName) || str(row.subscriptionId),
        tenantId: isTenantId(row.tenantId) ? row.tenantId.toLowerCase() : tenant.tenantId, endpoint: instanceEndpoint(row), keyAuthDisabled: row.disableLocalAuth === true,
      });
    }
  }
  return { instances, tenants: results.map((r) => r.tenant) };
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

/** Chat deployments of one resource and whether the user may call it or grant themselves the role. */
export async function inspectFoundryInstance(deps: ArmDeps, resourceId: string, tenantId: string): Promise<{ deployments: FoundryDeploymentInfo[]; access: FoundryAccess }> {
  if (!isFoundryResourceId(resourceId)) throw new EntraError('invalidResource');
  if (!isTenantId(tenantId)) throw new EntraError('invalidTenant');
  const [deployments, permissions] = await Promise.all([
    arm<{ value?: { name?: unknown; sku?: { name?: unknown }; properties?: { model?: { name?: unknown; version?: unknown }; provisioningState?: unknown; capabilities?: Record<string, unknown> } }[] }>(
      deps, tenantId, `${resourceId}/deployments?api-version=2024-10-01`),
    arm<{ value?: { actions?: string[]; notActions?: string[]; dataActions?: string[]; notDataActions?: string[] }[] }>(
      deps, tenantId, `${resourceId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`),
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

/** Assigns "Cognitive Services OpenAI User" on one resource to the signed-in user (explicit request only). */
export async function assignFoundryRole(deps: ArmDeps, resourceId: string, tenantId: string): Promise<void> {
  if (!isFoundryResourceId(resourceId)) throw new EntraError('invalidResource');
  if (!isTenantId(tenantId)) throw new EntraError('invalidTenant');
  const subscriptionId = RESOURCE_ID.exec(resourceId)![1]!;
  const { objectId } = await deps.tokens.token(ARM_SCOPE, tenantId, deps.signal);
  if (!GUID.test(objectId)) throw new EntraError('roleAssignFailed');
  const r = await arm<{ error?: { code?: unknown } }>(deps, tenantId, `${resourceId}/providers/Microsoft.Authorization/roleAssignments/${randomUUID()}?api-version=2022-04-01`, {
    method: 'PUT',
    body: { properties: { roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${OPENAI_USER_ROLE_ID}`, principalId: objectId, principalType: 'User' } },
  });
  if (r.status === 200 || r.status === 201) return;
  if (r.status === 409 && r.body?.error?.code === 'RoleAssignmentExists') return;
  throw new EntraError(r.status === 403 ? 'armForbidden' : 'roleAssignFailed');
}
