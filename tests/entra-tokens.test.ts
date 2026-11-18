// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractionRequiredAuthError, PublicClientApplication, TokenCache, type AccountInfo, type AuthenticationResult } from '@azure/msal-node';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARM_SCOPE, FOUNDRY_SCOPE, MsalEntraTokens } from '../server/entra.ts';
import { SecretVault } from '../server/vault.ts';

const HOME = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
const GUEST = '16b3c013-d300-468d-ac64-7eda0820b6d3';
const HOME_OBJECT = '11111111-1111-4111-8111-111111111111';
const GUEST_OBJECT = '22222222-2222-4222-8222-222222222222';
const account: AccountInfo = {
  homeAccountId: `${HOME_OBJECT}.${HOME}`, environment: 'login.microsoftonline.com',
  tenantId: HOME, localAccountId: HOME_OBJECT, username: 'user@example.com',
  tenantProfiles: new Map([
    [HOME, { tenantId: HOME, localAccountId: HOME_OBJECT, username: 'user@example.com', isHomeTenant: true }],
    [GUEST, { tenantId: GUEST, localAccountId: GUEST_OBJECT, username: 'user@example.com', isHomeTenant: false }],
  ]),
};
const result = (tenantId: string): AuthenticationResult => ({
  authority: `https://login.microsoftonline.com/${tenantId}`, tenantId,
  uniqueId: tenantId === HOME ? HOME_OBJECT : GUEST_OBJECT,
  scopes: [ARM_SCOPE], account, idToken: '', idTokenClaims: {}, accessToken: `test-token-${tenantId}`,
  fromCache: true, expiresOn: new Date(Date.now() + 3600_000), tokenType: 'Bearer', correlationId: '',
});

let dir: string;
let tokens: MsalEntraTokens;
const silent = vi.spyOn(PublicClientApplication.prototype, 'acquireTokenSilent');
const cachedAccount = vi.spyOn(TokenCache.prototype, 'getAccountByHomeId');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bas-entra-test-'));
  writeFileSync(join(dir, 'entra.json'), JSON.stringify({
    homeAccountId: account.homeAccountId, username: account.username, tenantId: HOME,
  }));
  tokens = new MsalEntraTokens(new SecretVault(dir, { protector: null }), () => undefined);
  cachedAccount.mockResolvedValue(account);
  // MSAL chooses the cached token by account.tenantId, not the authority's tenant.
  silent.mockImplementation(async (request) => result(request.forceRefresh
    ? new URL(request.authority!).pathname.slice(1) : request.account.tenantId));
});

afterEach(() => {
  vi.resetAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => vi.restoreAllMocks());

describe('MSAL tenant token selection', () => {
  it.each([ARM_SCOPE, FOUNDRY_SCOPE])('uses the guest profile for %s without returning the home token', async (scope) => {
    expect(await tokens.token(scope, GUEST)).toEqual({
      token: `test-token-${GUEST}`, tenantId: GUEST, objectId: GUEST_OBJECT,
    });
    expect(silent).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ homeAccountId: account.homeAccountId, tenantId: GUEST, localAccountId: GUEST_OBJECT }),
      scopes: [scope], authority: `https://login.microsoftonline.com/${GUEST}`,
    }));
    expect(account.tenantId).toBe(HOME);
  });

  it('keeps using the home tenant cache when no tenant is specified', async () => {
    cachedAccount.mockResolvedValue({ ...account, tenantId: GUEST, localAccountId: GUEST_OBJECT });
    expect(await tokens.token(ARM_SCOPE)).toMatchObject({ tenantId: HOME, objectId: HOME_OBJECT });
    expect(silent.mock.calls[0]?.[0].forceRefresh).not.toBe(true);
  });

  it('bypasses the home token cache when the guest profile is not yet available', async () => {
    cachedAccount.mockResolvedValue({ ...account, tenantProfiles: undefined });
    expect(await tokens.token(ARM_SCOPE, GUEST)).toMatchObject({ tenantId: GUEST, objectId: GUEST_OBJECT });
    expect(silent).toHaveBeenCalledWith(expect.objectContaining({
      authority: `https://login.microsoftonline.com/${GUEST}`, forceRefresh: true,
    }));
  });

  it('rejects a token issued for a different tenant, including Foundry data-plane tokens', async () => {
    silent.mockResolvedValue(result(HOME));
    await expect(tokens.token(FOUNDRY_SCOPE, GUEST)).rejects.toMatchObject({ code: 'authFailed' });
  });

  it('preserves additional-sign-in and network failures instead of treating them as successful authentication', async () => {
    silent.mockRejectedValueOnce(new InteractionRequiredAuthError('interaction_required', 'Additional sign-in required'));
    await expect(tokens.token(ARM_SCOPE, GUEST)).rejects.toMatchObject({ code: 'interactionRequired' });
    silent.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(tokens.token(ARM_SCOPE, GUEST)).rejects.toMatchObject({ code: 'authFailed' });
  });
});
