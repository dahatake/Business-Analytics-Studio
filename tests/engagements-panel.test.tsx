import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activatePack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { EngagementsPanel } from '../src/modules/project/EngagementsPanel.tsx';
import { useAnalyses } from '../src/modules/project/stores.ts';
import { useSettings } from '../src/state/settings.ts';

const source = samplePack.entities.find((e) => e.kind === 'source')!;
const customer = samplePack.entities.find((e) => e.kind === 'customer')!;
const pack = {
  ...samplePack,
  extensions: { engagements: { items: [{
    id: 'engagement-test', name: { ja: '顧客ワークショップ', en: 'Customer workshop' }, type: 'workshop',
    customerId: customer.id, status: 'Delivered', owner: 'Team lead', count: '20 participants',
    outcome: 'Follow-up agreed', sourceIds: [source.id],
  }] } },
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  useSettings.setState({ lang: 'en', audience: 'internal' });
  useAnalyses.setState({ scope: 'pj-engagements' });
  activatePack(pack, { kind: 'imported', projectId: 'pj-engagements' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  activatePack(samplePack, { kind: 'sample' });
  useAnalyses.setState({ scope: 'demo' });
  useSettings.setState({ audience: 'internal' });
});

describe('sourced engagement records', () => {
  it.each(['ja', 'en'] as const)('shows facts and provenance in the analysis panel (%s)', (lang) => {
    useSettings.setState({ lang });
    render(<EngagementsPanel />);
    const table = within(screen.getByTestId('proj-engagements'));
    expect(table.getByText(lang === 'ja' ? '顧客ワークショップ' : 'Customer workshop')).toBeDefined();
    expect(table.getByText(customer.name[lang])).toBeDefined();
    expect(table.getByText(source.name[lang])).toBeDefined();
    expect(table.getByText('Delivered')).toBeDefined();
    expect(table.getByText('Team lead')).toBeDefined();
    expect(table.getByText('20 participants')).toBeDefined();
    expect(table.getByText('Follow-up agreed')).toBeDefined();
    expect(table.queryAllByRole('textbox')).toHaveLength(0);
    expect(table.getByRole('table').textContent).not.toContain('0%');
  });

  it('hides internal records for an external audience and prevents cross-project display', () => {
    render(<EngagementsPanel />);
    expect(screen.getByTestId('proj-engagements')).toBeDefined();
    act(() => useSettings.setState({ audience: 'external' }));
    expect(screen.queryByTestId('proj-engagements')).toBeNull();
    act(() => {
      useSettings.setState({ audience: 'internal' });
      useAnalyses.setState({ scope: 'pj-other' });
    });
    expect(screen.queryByTestId('proj-engagements')).toBeNull();
    act(() => useAnalyses.setState({ scope: 'pj-engagements' }));
    expect(screen.getByTestId('proj-engagements')).toBeDefined();
  });

  it('leaves legacy packs unchanged and reports malformed records instead of showing an empty success', () => {
    activatePack(samplePack, { kind: 'imported', projectId: 'pj-engagements' });
    const { rerender } = render(<EngagementsPanel />);
    expect(screen.queryByTestId('proj-engagements')).toBeNull();
    activatePack({ ...pack, extensions: { engagements: { items: [{ id: 'broken' }] } } }, { kind: 'imported', projectId: 'pj-engagements' });
    rerender(<EngagementsPanel />);
    expect(screen.getByText(/invalid structure/)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
