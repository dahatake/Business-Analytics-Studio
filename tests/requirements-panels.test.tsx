import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activatePack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { useAiSettings } from '../src/modules/ai/settingsStore.ts';
import { useCheckContext } from '../src/modules/project/deliverablesUi.tsx';
import { ChangeLogPanel, EvidencePanel, IssueSignalsPanel, RequirementLedgerPanel } from '../src/modules/project/RequirementsPanels.tsx';
import { SolutionDocsPanel } from '../src/modules/project/StrategyPanels.tsx';
import { normalizeStrategy, emptyStrategy } from '../src/modules/project/strategy.ts';
import { useStrategy } from '../src/modules/project/stores.ts';
import { useSettings } from '../src/state/settings.ts';

const ask = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/ai/relayClient.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/modules/ai/relayClient.ts')>()), askWorkIqSections: ask }));

function Panels() {
  const ctx = useCheckContext();
  return (
    <>
      <IssueSignalsPanel ctx={ctx} />
      <EvidencePanel ctx={ctx} />
      <SolutionDocsPanel ctx={ctx} />
      <RequirementLedgerPanel ctx={ctx} />
      <ChangeLogPanel ctx={ctx} />
    </>
  );
}

const stored = () => normalizeStrategy(useStrategy.getState().value);
const issue = samplePack.entities.find((e) => e.kind === 'issue')!;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useSettings.setState({ lang: 'en', audience: 'internal' });
  activatePack(samplePack, { kind: 'sample' });
  act(() => useStrategy.getState().set(emptyStrategy()));
  ask.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAiSettings.setState({ provider: 'foundry', workiq: null });
});

describe('requirement management panels', () => {
  it('records the frequency and severity of an issue and shows a rare but severe one as a hidden gem', () => {
    render(<Panels />);
    const row = within(screen.getByTestId(`sol-sig-row-${issue.id}`));
    fireEvent.change(row.getByTestId(`sol-sig-frequency-${issue.id}`), { target: { value: '1' } });
    expect(stored().signals).toBeUndefined();
    fireEvent.change(row.getByTestId(`sol-sig-severity-${issue.id}`), { target: { value: '5' } });
    expect(stored().signals?.[issue.id]).toMatchObject({ frequency: 1, severity: 5 });
    expect(screen.getByTestId('sol-sig-gems')).toBeDefined();
  });

  it('adds evidence by hand, keeps it, and removes it', () => {
    render(<Panels />);
    fireEvent.change(screen.getByTestId('sol-ev-manual-kind'), { target: { value: 'complaint' } });
    fireEvent.change(screen.getByTestId('sol-ev-manual-title'), { target: { value: 'Late delivery' } });
    fireEvent.change(screen.getByTestId('sol-ev-manual-summary'), { target: { value: 'Orders miss the promised date' } });
    fireEvent.click(screen.getByTestId('sol-ev-manual-add'));
    const item = stored().evidence![0]!;
    expect(item).toMatchObject({ kind: 'complaint', title: 'Late delivery', origin: 'manual' });
    const li = screen.getByTestId(`sol-ev-item-${item.id}`);
    expect(li.textContent).toContain('Late delivery');
    expect(screen.getAllByTestId(/^sol-doc-/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId(`sol-ev-remove-${item.id}`));
    expect(stored().evidence).toBeUndefined();
  });

  it('imports a file as evidence without keeping its rows', async () => {
    render(<Panels />);
    fireEvent.change(screen.getByTestId('sol-ev-file-kind'), { target: { value: 'evalData' } });
    const file = new File(['text,label\nsecret row,A\nother,B\nmore,A\n'], 'eval.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('text,label\nsecret row,A\nother,B\nmore,A\n') });
    fireEvent.change(screen.getByTestId('sol-ev-file'), { target: { files: [file] } });
    await waitFor(() => expect(stored().evidence?.[0]).toBeDefined());
    const e = stored().evidence![0]!;
    expect(e).toMatchObject({ kind: 'evalData', origin: 'file', data: { rows: 3, columns: ['text', 'label'], labels: { A: 2, B: 1 } } });
    expect(JSON.stringify(useStrategy.getState().value)).not.toContain('secret row');
  });

  it('asks Work IQ only after it is verified, and an adopted answer becomes evidence with its citations', async () => {
    const { rerender } = render(<Panels />);
    expect(screen.getByTestId('sol-ev-search-rules').hasAttribute('disabled')).toBe(true);
    act(() => useAiSettings.setState({ provider: 'copilotSdk', workiq: { method: 'cli', tenantId: null, clientId: null, account: null, signedIn: true, verifiedAt: '2026-11-19T00:00:00Z' } }));
    rerender(<Panels />);
    ask.mockResolvedValue([{ key: 'rules', question: 'q', answer: 'Availability 99.9% (SLA 4.2)', citations: [{ title: 'SLA.docx', url: 'https://example.com/sla' }], sensitivity: null, fetchedAt: '2026-11-19T00:00:00Z' }]);
    fireEvent.click(screen.getByTestId('sol-ev-search-rules'));
    await waitFor(() => expect(screen.getByTestId('sol-ev-candidates')).toBeDefined());
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ aspects: ['rules'], provider: 'copilotSdk', lang: 'en' }), undefined);
    expect(stored().evidence).toBeUndefined();
    fireEvent.click(screen.getByTestId('sol-ev-adopt-0'));
    expect(stored().evidence?.[0]).toMatchObject({ kind: 'policy', origin: 'workiq', summary: 'Availability 99.9% (SLA 4.2)', citations: [{ title: 'SLA.docx', url: 'https://example.com/sla' }] });
  });

  it('shows the error code when Work IQ fails and keeps nothing', async () => {
    act(() => useAiSettings.setState({ provider: 'copilotSdk', workiq: { method: 'cli', tenantId: null, clientId: null, account: null, signedIn: true, verifiedAt: '2026-11-19T00:00:00Z' } }));
    render(<Panels />);
    ask.mockRejectedValue(Object.assign(new Error('x'), { code: 'workiqUnavailable' }));
    fireEvent.click(screen.getByTestId('sol-ev-search-voice'));
    await waitFor(() => expect(screen.getByTestId('sol-ev-error').textContent).toContain('workiqUnavailable'));
    expect(stored().evidence).toBeUndefined();
  });

  it('writes a section with its author and time, and lists requirements in the ledger with decisions kept per id', () => {
    render(<Panels />);
    const sectionBox = screen.getAllByTestId(/^sol-doc-sol-.*-scope$/)[0]!;
    const solutionId = sectionBox.getAttribute('data-testid')!.replace(/^sol-doc-/, '').replace(/-scope$/, '');
    fireEvent.change(sectionBox, { target: { value: 'Scope: 12 sites by 2027-03-31' } });
    fireEvent.blur(sectionBox);
    expect(stored().sections[solutionId]?.scope).toBe('Scope: 12 sites by 2027-03-31');
    expect(stored().sectionMeta?.[solutionId]?.scope?.at).toMatch(/^\d{4}-/);
    expect(screen.getByTestId(`sol-doc-stamp-${solutionId}-scope`)).toBeDefined();

    const ledger = within(screen.getByTestId(`sol-ledger-${solutionId}`));
    const rows = ledger.getAllByTestId(new RegExp(`^sol-led-row-${solutionId}-BR-`));
    const id = rows[0]!.getAttribute('data-testid')!.replace(`sol-led-row-${solutionId}-`, '');
    fireEvent.change(ledger.getByTestId(`sol-led-priority-${id}`), { target: { value: 'must' } });
    fireEvent.change(ledger.getByTestId(`sol-led-status-${id}`), { target: { value: 'approved' } });
    expect(stored().ledger?.[solutionId]?.[id]).toMatchObject({ priority: 'must', status: 'approved' });
  });

  it('records a change with its reason, impact and approver', () => {
    render(<Panels />);
    expect(screen.getByTestId('sol-chg-add').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('sol-chg-subject'), { target: { value: 'BR-lead-time' } });
    fireEvent.change(screen.getByTestId('sol-chg-summary'), { target: { value: 'Target 10 → 9 days' } });
    fireEvent.change(screen.getByTestId('sol-chg-reason'), { target: { value: 'Board decision' } });
    fireEvent.change(screen.getByTestId('sol-chg-impact'), { target: { value: 'AC and test' } });
    fireEvent.change(screen.getByTestId('sol-chg-approver'), { target: { value: 'Director' } });
    fireEvent.click(screen.getByTestId('sol-chg-add'));
    expect(stored().changes?.[0]).toMatchObject({ subject: 'BR-lead-time', summary: 'Target 10 → 9 days', reason: 'Board decision', impact: 'AC and test', approver: 'Director' });
    expect(screen.getByTestId('sol-chg-list').textContent).toContain('Board decision');
  });
});
