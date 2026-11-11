import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLedger } from '../src/ai/client.ts';
import { ConnectionActions } from '../src/modules/ai/AiConnectionForm.tsx';
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
    priceInputPerM: '1000', priceOutputPerM: '4000', monthlyBudgetJpy: 100_000,
    relayConnection: connection, connectionVerifiedAt: '2026-11-10T00:00:00Z', saveConnection: save,
  });
});

afterEach(() => {
  cleanup();
  useAiSettings.setState(initial);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connection test action', () => {
  it.each<{ patch: Partial<AiSettingsState>; reason: string }>([
    { patch: { endpoint: 'https://resource.services.ai.azure.com/api/projects/project' }, reason: 'project URL' },
    { patch: { endpoint: '' }, reason: 'HTTPS resource URL' },
    { patch: { deployment: '' }, reason: 'deployment name' },
    { patch: { apiVersion: 'invalid' }, reason: 'API version' },
    { patch: { relayReachable: false }, reason: 'relay process cannot be reached' },
    { patch: { authMethod: 'entraId' }, reason: 'Entra ID sign-in' },
    { patch: { foundryKeySaved: false }, reason: 'First save the API key' },
    { patch: { priceInputPerM: '' }, reason: 'input and output unit prices' },
    { patch: { priceOutputPerM: '' }, reason: 'input and output unit prices' },
    { patch: { monthlyBudgetJpy: 0 }, reason: 'monthly budget' },
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

  it('explains every missing prerequisite together, including consent, without sending', () => {
    useAiSettings.setState({ foundryKeySaved: false, priceInputPerM: '' });
    render(<ConnectionActions />);
    fireEvent.click(button());
    const text = screen.getByTestId('ai-connection-blockers').textContent;
    for (const reason of ['No connection test was sent', 'API key', 'unit prices', 'consent checkbox']) {
      expect(text).toContain(reason);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('allows a retry after correction, but requires fresh consent after editing the destination', async () => {
    useAiSettings.setState({ endpoint: 'https://resource.services.ai.azure.com/api/projects/project' });
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

  it('keeps the daily quota even after the send interval expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    writeLedger(Array.from({ length: 30 }, () => ({
      at: new Date(Date.now() - 6000).toISOString(), use: 'connectionTest' as const,
      inputTokens: 30, outputTokens: 1, costJpy: 0.034,
    })));
    render(<ConnectionActions />);
    consent();
    fireEvent.click(button());
    expect(screen.getByTestId('ai-connection-blockers').textContent).toContain('daily quota or send interval');
    expect(save).not.toHaveBeenCalled();
  });

  it('permits retry once the send interval expires', async () => {
    vi.useFakeTimers();
    writeLedger([{ at: new Date().toISOString(), use: 'connectionTest', inputTokens: 30, outputTokens: 1, costJpy: 0.034 }]);
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
    useAiSettings.setState({ endpoint: 'https://resource.services.ai.azure.com/api/projects/project' });
    render(<ConnectionActions />);
    fireEvent.click(button());
    const text = screen.getByTestId('ai-connection-blockers').textContent;
    expect(text).toContain('接続テストは送信していません');
    expect(text).toContain('プロジェクト用 URL');
    expect(text).toContain('同意チェック');
    expect(save).not.toHaveBeenCalled();
  });
});
