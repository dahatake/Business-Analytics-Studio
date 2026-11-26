import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLedger } from '../src/ai/client.ts';
import { AiReadiness, ConnectionActions, FoundryFields } from '../src/modules/ai/AiConnectionForm.tsx';
import { DecisionSettings } from '../src/modules/ai/DecisionSettings.tsx';
import { LiveNotice, TokenTable } from '../src/modules/ai/AiCommon.tsx';
import { summarizeTokens } from '../src/ai/tokenUsage.ts';
import type { ConnectionSaveResult } from '../src/modules/ai/relayClient.ts';
import { useAiSettings, type AiSettingsState } from '../src/modules/ai/settingsStore.ts';
import { useSettings } from '../src/state/settings.ts';

const initial = useAiSettings.getState();
const connection = { endpoint: 'https://resource.openai.azure.com', deployment: 'gpt-deployed', apiVersion: '2024-10-21' };
const save = vi.fn<AiSettingsState['saveConnection']>();
const button = () => screen.getByTestId<HTMLButtonElement>('ai-connection-save');
const consent = () => fireEvent.click(screen.getByTestId('ai-connection-consent'));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  localStorage.clear();
  useSettings.setState({ lang: 'en' });
  save.mockReset().mockResolvedValue({ ok: false, error: 'unauthorized', providerStatus: 401 });
  useAiSettings.setState({
    ...initial, ...connection, relayReachable: true, foundryKeySaved: true,
    relayConnection: connection, connectionVerifiedAt: '2026-11-10T00:00:00Z', saveConnection: save,
  });
});

afterEach(() => {
  cleanup();
  useAiSettings.setState(initial);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('concise Foundry service selection', () => {
  it('ignores a late resource check after the common connection changes', async () => {
    let finishOld: ((response: Response) => void) | undefined;
    let checks = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/relay/session')) return new Response('{"token":"test-token"}');
      checks++;
      if (checks === 1) return new Promise<Response>((resolve) => { finishOld = resolve; });
      return new Response(JSON.stringify({
        speech: 'available', vision: 'available', decision: 'available',
        deployments: [{ name: 'fresh-decision', model: 'Microsoft-Decision-1.1', version: '1', sku: 'Standard' }],
      }));
    }));
    render(<DecisionSettings />);
    await waitFor(() => expect(finishOld).toBeDefined());
    act(() => useAiSettings.setState({ relayConnection: { ...connection, endpoint: 'https://new-resource.openai.azure.com' } }));
    await screen.findByText('fresh-decision (Microsoft-Decision-1.1)');
    await act(async () => finishOld!(new Response('{"speech":"unavailable","vision":"unavailable","decision":"unavailable","deployments":[]}')));
    expect(screen.queryByTestId('ai-foundry-admin')).toBeNull();
    expect(screen.getByTestId<HTMLSelectElement>('ai-decision-deployment').disabled).toBe(false);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('connection test action', () => {
  it('lists the send consent in the readiness, since live sends need it (D-25)', () => {
    useAiSettings.setState({ provider: 'copilotSdk', copilotModel: 'gpt-5', liveEnabled: true, sendConsent: false });
    render(<AiReadiness />);
    const item = () => screen.getByTestId('ai-readiness-consent').textContent;
    expect(item()).toContain('To do');
    act(() => useAiSettings.setState({ sendConsent: true }));
    expect(item()).toContain('OK');
  });
  it('shows reported tokens, and "unknown" for any figure the provider did not report, with no price or cost shown', () => {
    useAiSettings.setState({ provider: 'copilotSdk', copilotModel: 'gpt-5', liveEnabled: true });
    const { rerender } = render(<><AiReadiness /><LiveNotice usage={{ inputTokens: 10, outputTokens: 20 }} /></>);
    expect(screen.queryByTestId('ai-price-request')).toBeNull();
    expect(screen.queryByTestId('ai-provider-cost-note')).toBeNull();
    expect(screen.getByTestId('ai-readiness').textContent).not.toContain('Unit price');
    expect(screen.getByTestId('ai-live-tokens').textContent).toBe('Tokens used: 30 (input 10 / output 20)');
    rerender(<LiveNotice usage={{ inputTokens: 10, outputTokens: null }} />);
    expect(screen.getByTestId('ai-live-tokens').textContent).toBe('Tokens used: unknown (input 10 / output unknown)');
    rerender(<><LiveNotice usage={{ inputTokens: null, outputTokens: null }} />
      <TokenTable summary={summarizeTokens([{ at: new Date().toISOString(), use: 'packBuild', inputTokens: null, outputTokens: null }])} /></>);
    expect(screen.getByTestId('ai-live-tokens').textContent).toContain('unknown');
    expect(screen.getByTestId('ai-tokens-total-value').textContent).toBe('unknown');
    expect(screen.queryByText('Cost')).toBeNull();
  });
  it('marks token lines and the total that include the app\'s estimate', () => {
    const at = new Date().toISOString();
    render(<TokenTable summary={summarizeTokens([
      { at, use: 'packBuild', inputTokens: 100, outputTokens: 50 },
      { at, use: 'packBuild', inputTokens: 80, outputTokens: 0, estimated: true },
    ])} />);
    expect(screen.getByTestId('ai-tokens-row').textContent).toContain('includes estimates');
    expect(screen.getByTestId('ai-tokens-total').textContent).toContain('includes estimates');
    expect(screen.getByTestId('ai-tokens-total-value').textContent).toBe('230');
  });
  it('labels non-pack stages by their use instead of treating them as pack-generation steps', () => {
    const at = new Date().toISOString();
    render(<TokenTable summary={summarizeTokens([
      { at, use: 'packBuild', stage: 'foundation', inputTokens: 10, outputTokens: 5 },
      { at, use: 'kpiOkrDraft', stage: 'kpiOkr:fill', inputTokens: 20, outputTokens: 5 },
      { at, use: 'kpiOkrScreen', stage: 'decision', inputTokens: 30, outputTokens: 5 },
    ])} />);
    expect(screen.getAllByTestId('ai-tokens-row').map((row) => row.querySelector('th')?.textContent)).toEqual([
      'Foundation (company, sites, products, customers, people, brand)',
      'KPI/OKR drafts',
      'KPI/OKR candidate pre-screening (Decision)',
    ]);
  });
  it.each<{ patch: Partial<AiSettingsState>; reason: string }>([
    { patch: { endpoint: 'https://other.example/api/projects/project' }, reason: 'project URL' },
    { patch: { endpoint: '' }, reason: 'HTTPS resource URL' },
    { patch: { deployment: '' }, reason: 'deployment name' },
    { patch: { apiVersion: 'invalid' }, reason: 'API version' },
    { patch: { relayReachable: false }, reason: 'relay process cannot be reached' },
    { patch: { authMethod: 'entraId' }, reason: 'Sign in with your Microsoft account first' },
    { patch: { authMethod: 'entraId', entra: { signedIn: true, account: 'u@example.com', tenantId: null, signIn: 'idle' } }, reason: 'Pick a Foundry resource' },
    { patch: { foundryKeySaved: false }, reason: 'First save the API key' },
  ])('keeps the button usable but refuses sending for $reason', ({ patch, reason }) => {
    useAiSettings.setState(patch);
    render(<ConnectionActions />);
    consent();
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(screen.getByTestId('ai-connection-blockers').textContent).toContain(reason);
    expect(save).not.toHaveBeenCalled();
    expect(useAiSettings.getState().relayConnection).toEqual(connection);
  });

  it('with Entra ID, hides manual connection fields and tests once signed in with a resource picked', async () => {
    useAiSettings.setState({
      authMethod: 'entraId', foundryKeySaved: false, entraTenantId: '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a',
      entra: { signedIn: true, account: 'u@example.com', tenantId: '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a', signIn: 'idle' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ instances: [], tenants: [] }), { status: 200 })));
    render(<FoundryFields />);
    for (const id of ['ai-endpoint', 'ai-deployment', 'ai-api-version', 'ai-foundry-key']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.getByTestId('ai-entra-account').textContent).toContain('u@example.com');
    consent();
    fireEvent.click(button());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it('restores manual fields and their values when switching back to API key authentication', () => {
    render(<FoundryFields />);
    expect(screen.getByTestId<HTMLInputElement>('ai-endpoint').value).toBe(connection.endpoint);
    fireEvent.click(screen.getByTestId('ai-auth-entra'));
    for (const id of ['ai-endpoint', 'ai-deployment', 'ai-api-version', 'ai-foundry-key']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    fireEvent.click(screen.getByTestId('ai-auth-apikey'));
    expect(screen.getByTestId<HTMLInputElement>('ai-endpoint').value).toBe(connection.endpoint);
    expect(screen.getByTestId<HTMLInputElement>('ai-deployment').value).toBe(connection.deployment);
    expect(screen.getByTestId<HTMLInputElement>('ai-api-version').value).toBe(connection.apiVersion);
    expect(screen.getByTestId('ai-foundry-key')).toBeTruthy();
  });

  it('asks Entra users to select a resource instead of editing hidden fields', () => {
    useAiSettings.setState({ authMethod: 'entraId', endpoint: '', deployment: '', entraTenantId: '' });
    render(<ConnectionActions />);
    expect(screen.getByTestId('ai-connection-validation').textContent).toContain('Pick a Foundry resource');
    fireEvent.click(button());
    const text = screen.getByTestId('ai-connection-blockers').textContent ?? '';
    expect(text).toContain('Pick a Foundry resource');
    expect(text).not.toContain('HTTPS resource URL');
    expect(save).not.toHaveBeenCalled();
  });

  it('lets a signed-in user select a Foundry resource and its chat deployment', async () => {
    const tenantId = '16b3c013-d300-468d-ac64-7eda0820b6d3';
    const instance = {
      id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/foundry',
      name: 'foundry', kind: 'AIServices', location: 'japaneast', resourceGroup: 'rg',
      subscriptionId: 'sub', subscriptionName: 'Subscription', tenantId,
      endpoint: 'https://foundry.openai.azure.com/openai/v1', keyAuthDisabled: false,
    };
    useAiSettings.setState({
      authMethod: 'entraId',
      entra: { signedIn: true, account: 'u@example.com', tenantId, signIn: 'idle' },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/relay/session')) return new Response(JSON.stringify({ token: 'test-token' }));
      if (String(url).endsWith('/relay/entra/tenants')) return new Response(JSON.stringify({ tenants: [{ tenantId, name: 'Test directory', signedIn: true }] }));
      if (String(url).endsWith('/relay/entra/instances')) return new Response(JSON.stringify({ instances: [instance], tenants: [] }));
      if (String(url).endsWith('/relay/entra/inspect')) return new Response(JSON.stringify({
        deployments: [{ name: 'gpt-6.2-sol', model: 'gpt-6.2-sol', version: '', sku: 'GlobalStandard' }],
        access: { canCall: true, canAssign: false },
      }));
      return new Response('{}', { status: 404 });
    }));
    render(<FoundryFields />);
    const select = await screen.findByTestId<HTMLSelectElement>('ai-entra-instance');
    expect(screen.getByText(/Standalone Azure OpenAI resources are not listed/)).toBeTruthy();
    fireEvent.change(select, { target: { value: instance.id } });
    await waitFor(() => expect(useAiSettings.getState()).toMatchObject({
      endpoint: instance.endpoint, entraTenantId: tenantId, deployment: 'gpt-6.2-sol', relayConnection: connection,
    }));
  });

  it('switches directories without retaining an old resource or allowing a late response to replace the selected list', async () => {
    const home = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
    const guest = '16b3c013-d300-468d-ac64-7eda0820b6d3';
    const resource = (tenantId: string, name: string) => ({
      id: `/subscriptions/${tenantId}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/${name}`,
      name, kind: 'AIServices', location: 'eastus', resourceGroup: 'rg', subscriptionId: tenantId,
      subscriptionName: name, tenantId, endpoint: `https://${name}.openai.azure.com/openai/v1`, keyAuthDisabled: false,
    });
    let finishHome!: (r: Response) => void;
    useAiSettings.setState({
      authMethod: 'entraId', entra: { signedIn: true, account: 'u@example.com', tenantId: home, signIn: 'idle' },
      endpoint: resource(home, 'home').endpoint, entraTenantId: home, deployment: 'old',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/relay/session')) return new Response(JSON.stringify({ token: 'test-token' }));
      if (String(url).endsWith('/relay/entra/tenants')) return new Response(JSON.stringify({ tenants: [
        { tenantId: home, name: 'Home', signedIn: true }, { tenantId: guest, name: 'Guest', signedIn: false },
      ] }));
      if (String(url).endsWith('/relay/entra/instances')) {
        const tenantId = (JSON.parse(String(init?.body)) as { tenantId: string }).tenantId;
        if (tenantId === home) return new Promise<Response>((resolve) => { finishHome = resolve; });
        return new Response(JSON.stringify({ instances: [resource(guest, 'guest')] }));
      }
      if (String(url).endsWith('/relay/entra/inspect')) return new Response(JSON.stringify({ deployments: [], access: { canCall: true, canAssign: false } }));
      return new Response('{}', { status: 404 });
    }));
    render(<FoundryFields />);
    await screen.findByText(`Guest (${guest})`);
    fireEvent.change(screen.getByTestId('ai-entra-directory'), { target: { value: guest } });
    await screen.findByText(/guest —/);
    await act(async () => finishHome(new Response(JSON.stringify({ instances: [resource(home, 'home')] }))));
    expect(screen.queryByText(/home —/)).toBeNull();
    expect(useAiSettings.getState()).toMatchObject({ endpoint: '', entraTenantId: '', deployment: '', relayConnection: connection });
    fireEvent.change(screen.getByTestId('ai-entra-instance'), { target: { value: resource(guest, 'guest').id } });
    expect(useAiSettings.getState()).toMatchObject({ endpoint: resource(guest, 'guest').endpoint, entraTenantId: guest });
  });

  it('allows a directory ID missing from the list and shows tenant sign-in failures', async () => {
    const home = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
    const guest = '16b3c013-d300-468d-ac64-7eda0820b6d3';
    useAiSettings.setState({ authMethod: 'entraId', entra: { signedIn: true, account: 'u@example.com', tenantId: home, signIn: 'idle' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/relay/session')) return new Response(JSON.stringify({ token: 'test-token' }));
      if (String(url).endsWith('/relay/entra/tenants')) return new Response(JSON.stringify({ tenants: [{ tenantId: home, name: 'Home', signedIn: true }] }));
      if (String(url).endsWith('/relay/entra/instances')) {
        const tenantId = (JSON.parse(String(init?.body)) as { tenantId: string }).tenantId;
        return tenantId === guest ? new Response(JSON.stringify({ error: 'interactionRequired' }), { status: 401 })
          : new Response(JSON.stringify({ instances: [] }));
      }
      return new Response('{}', { status: 404 });
    }));
    render(<FoundryFields />);
    fireEvent.change(screen.getByTestId('ai-entra-directory-id'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('ai-entra-directory-use'));
    expect(screen.getByTestId('ai-entra-msg').textContent).toContain('tenant ID is not valid');
    fireEvent.change(screen.getByTestId('ai-entra-directory-id'), { target: { value: guest } });
    fireEvent.click(screen.getByTestId('ai-entra-directory-use'));
    await waitFor(() => expect(screen.getByTestId('ai-entra-directory-signin').textContent).toContain('Additional sign-in required'));
    expect(screen.queryByTestId('ai-entra-empty')).toBeNull();
    expect(screen.getByTestId<HTMLSelectElement>('ai-entra-directory').value).toBe(guest);
  });

  it('ignores a late deployment inspection from the previous directory', async () => {
    const home = '25f92969-0cc7-4a5c-a2f9-6f9ce699cc6a';
    const guest = '16b3c013-d300-468d-ac64-7eda0820b6d3';
    const instance = {
      id: `/subscriptions/${home}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/home`,
      name: 'home', kind: 'AIServices', location: 'eastus', resourceGroup: 'rg', subscriptionId: home,
      subscriptionName: 'Home', tenantId: home, endpoint: 'https://home.openai.azure.com/openai/v1', keyAuthDisabled: false,
    };
    let finishInspect!: (r: Response) => void;
    useAiSettings.setState({ authMethod: 'entraId', entra: { signedIn: true, account: 'u@example.com', tenantId: home, signIn: 'idle' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/relay/session')) return new Response(JSON.stringify({ token: 'test-token' }));
      if (String(url).endsWith('/relay/entra/tenants')) return new Response(JSON.stringify({ tenants: [
        { tenantId: home, name: 'Home' }, { tenantId: guest, name: 'Guest' },
      ] }));
      if (String(url).endsWith('/relay/entra/instances')) {
        const tenantId = (JSON.parse(String(init?.body)) as { tenantId: string }).tenantId;
        return new Response(JSON.stringify({ instances: tenantId === home ? [instance] : [] }));
      }
      if (String(url).endsWith('/relay/entra/inspect')) return new Promise<Response>((resolve) => { finishInspect = resolve; });
      return new Response('{}', { status: 404 });
    }));
    render(<FoundryFields />);
    const select = await screen.findByTestId('ai-entra-instance');
    fireEvent.change(select, { target: { value: instance.id } });
    await waitFor(() => expect(finishInspect).toBeTypeOf('function'));
    fireEvent.change(screen.getByTestId('ai-entra-directory'), { target: { value: guest } });
    await act(async () => finishInspect(new Response(JSON.stringify({
      deployments: [{ name: 'old-deployment', model: 'gpt-6.2-sol', version: '', sku: 'Standard' }],
      access: { canCall: true, canAssign: false },
    }))));
    expect(useAiSettings.getState()).toMatchObject({ endpoint: '', entraTenantId: '', deployment: '' });
    expect(screen.queryByTestId('ai-entra-deployment')).toBeNull();
  });

  it('explains every missing prerequisite together, including consent, without sending', () => {
    useAiSettings.setState({ foundryKeySaved: false });
    render(<ConnectionActions />);
    fireEvent.click(button());
    const text = screen.getByTestId('ai-connection-blockers').textContent;
    for (const reason of ['No connection test was sent', 'API key', 'consent checkbox']) {
      expect(text).toContain(reason);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('has no price inputs or cost notices and permits a test after consent', async () => {
    render(<FoundryFields />);
    expect(screen.queryByTestId('ai-price-input')).toBeNull();
    expect(screen.queryByTestId('ai-price-output')).toBeNull();
    expect(screen.queryByTestId('ai-connection-test-cost')).toBeNull();
    consent();
    fireEvent.click(button());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it('allows a retry after correction, but requires fresh consent after editing the destination', async () => {
    useAiSettings.setState({ endpoint: 'https://other.example/api/projects/project' });
    render(<ConnectionActions />);
    consent();
    fireEvent.click(button());
    act(() => useAiSettings.getState().update({ endpoint: connection.endpoint }));
    fireEvent.click(button());
    expect(screen.getByTestId('ai-connection-blockers').textContent).toContain('consent checkbox');
    expect(save).not.toHaveBeenCalled();
    consent();
    fireEvent.click(button());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('ai-connection-msg').textContent).toContain('HTTP 401');
    expect(useAiSettings.getState().relayConnection).toEqual(connection);
  });

  it('previews the assembled project destination, uses v1 and requires fresh consent after editing', async () => {
    useAiSettings.setState({
      endpoint: ' https://resource.services.ai.azure.com/api/projects/GraphRecordingProject/ ',
      apiVersion: 'invalid',
    });
    render(<FoundryFields />);
    expect(screen.getByTestId('ai-connection-destination').textContent).toContain(
      'https://resource.services.ai.azure.com/openai/v1/chat/completions',
    );
    expect(screen.queryByTestId('ai-connection-validation')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('ai-api-version').disabled).toBe(true);
    consent();
    fireEvent.change(screen.getByTestId('ai-deployment'), { target: { value: 'another-deployment' } });
    fireEvent.click(button());
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-connection-blockers').textContent).toContain('consent checkbox');
    consent();
    fireEvent.click(button());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('ai-connection-msg').textContent).toContain('HTTP 401');
    expect(useAiSettings.getState().relayConnection).toEqual(connection);
  });

  it('keeps the daily quota even after the send interval expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    writeLedger(Array.from({ length: 30 }, () => ({
      at: new Date(Date.now() - 6000).toISOString(), use: 'connectionTest' as const,
      inputTokens: 30, outputTokens: 1,
    })));
    render(<ConnectionActions />);
    consent();
    fireEvent.click(button());
    expect(screen.getByTestId('ai-connection-blockers').textContent).toContain('daily quota or send interval');
    expect(save).not.toHaveBeenCalled();
  });

  it('permits retry once the send interval expires', async () => {
    vi.useFakeTimers();
    writeLedger([{ at: new Date().toISOString(), use: 'connectionTest', inputTokens: 30, outputTokens: 1 }]);
    render(<ConnectionActions />);
    consent();
    fireEvent.click(button());
    expect(save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(5000));
    fireEvent.click(button());
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('disables only during a pending test, prevents duplicates and clears consent after success', async () => {
    let resolve!: (result: ConnectionSaveResult) => void;
    save.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<ConnectionActions />);
    consent();
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => resolve({
      ok: true, connection, connectionVerifiedAt: new Date().toISOString(),
      usage: { inputTokens: 30, outputTokens: 1 },
    }));
    expect(button().disabled).toBe(false);
    expect(screen.getByTestId('ai-connection-msg').textContent).toContain('connection was saved');
    fireEvent.click(button());
    expect(screen.getByTestId('ai-connection-blockers').textContent).toContain('consent checkbox');
    expect(screen.queryByTestId('ai-connection-msg')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('shows Japanese guidance without sending an invalid destination', () => {
    useSettings.setState({ lang: 'ja' });
    useAiSettings.setState({ endpoint: 'https://other.example/api/projects/project' });
    render(<ConnectionActions />);
    fireEvent.click(button());
    const text = screen.getByTestId('ai-connection-blockers').textContent;
    expect(text).toContain('接続テストは送信していません');
    expect(text).toContain('プロジェクト用 URL');
    expect(text).toContain('同意チェック');
    expect(save).not.toHaveBeenCalled();
  });
});
