import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCheckContext } from '../src/modules/project/deliverablesUi.tsx';
import { OutcomesWorkspace } from '../src/modules/project/OutcomesWorkspace.tsx';
import { useProjUi, useStrategy } from '../src/modules/project/stores.ts';
import { emptyStrategy } from '../src/modules/project/strategy.ts';
import { useProjects } from '../src/state/projects.ts';
import { useSettings } from '../src/state/settings.ts';
import { ExpectedOutcomesBar } from '../src/ui/ExpectedOutcomesBar.tsx';

vi.mock('../src/modules/ai/relayClient.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/ai/relayClient.ts')>(),
  relayFetch: vi.fn(() => new Promise(() => {})),
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  useSettings.setState({ lang: 'en', audience: 'internal' });
  useProjects.setState({ target: { kind: 'demo' } });
  useStrategy.getState().set(emptyStrategy());
  useProjUi.setState({ outcomesOpen: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('expected business outcomes: inline card row (FR-337)', () => {
  it('unfolds the outcomes as cards in place of a dialog and remembers the choice', () => {
    render(<ExpectedOutcomesBar />);
    const toggle = screen.getByTestId('outcomes-expand');
    const strip = screen.getByTestId('outcomes-strip');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(strip.id);
    expect(strip.getAttribute('data-open')).toBe('false');
    expect(strip.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('Collapse business outcomes');
    expect(strip.getAttribute('data-open')).toBe('true');
    expect(strip.hasAttribute('inert')).toBe(false);
    expect(useProjUi.getState().outcomesOpen).toBe(true);
    const items = strip.querySelectorAll('.outcome-strip-list > li');
    expect(items.length).toBeGreaterThan(1);
    expect(toggle.textContent).toContain(`${items.length} items`);
    expect(screen.getByTestId('outcome-kpi-kpi-lead-time').textContent).toContain('KPI outcome');
  });

  it('marks only the card whose values changed, announces it, then clears the mark', () => {
    vi.useFakeTimers();
    useProjUi.setState({ outcomesOpen: true });
    render(<ExpectedOutcomesBar />);
    expect(document.querySelectorAll('[data-change]').length).toBe(0);

    act(() => {
      useStrategy.getState().set({
        ...emptyStrategy(),
        contributions: [{
          id: 'c-test', solutionId: 'sol-demand-planning', kpiId: 'kpi-lead-time', lever: 'pilot volume', leverUnit: 'units',
          amount: { low: 10, mode: 10, high: 10 }, effectPerUnit: { low: 0.1, mode: 0.1, high: 0.1 },
          rampStart: '2026-01-01', fullEffect: '2026-11-01', basis: 'measured', evidence: 'pilot report',
        }],
      });
    });

    const changed = [...document.querySelectorAll<HTMLElement>('[data-change]')];
    expect(changed.map((el) => el.dataset.testid)).toContain('outcome-item-kpi-kpi-lead-time');
    expect(changed.every((el) => el.dataset.change === 'changed')).toBe(true);
    expect(screen.getByTestId('outcome-item-kpi-kpi-lead-time').textContent).toContain('Updated');
    expect(screen.getByRole('status').textContent).toMatch(/updated/);
    expect(screen.getByTestId('outcome-kpi-kpi-lead-time').textContent).toContain('Forecast available');

    act(() => { vi.advanceTimersByTime(3000); });
    expect(document.querySelectorAll('[data-change]').length).toBe(0);
  });
});

describe('expected business outcomes: compact cards linked to Step 2 (FR-382)', () => {
  function Step2() {
    return <OutcomesWorkspace ctx={useCheckContext()} />;
  }

  it('shows a one-line summary per card and links it to the outcome in the Step 2 (To-Be) view', () => {
    useProjUi.setState({ outcomesOpen: true });
    render(<ExpectedOutcomesBar />);
    const card = screen.getByTestId('outcome-kpi-kpi-lead-time');
    expect(card.tagName).toBe('A');
    const href = new URL(card.getAttribute('href')!.replace('#', ''), 'http://x');
    expect(href.pathname).toBe('/step');
    expect(href.searchParams.get('step')).toBe('tobe');
    expect(href.searchParams.get('view')).toBe('outcomes');
    expect(href.searchParams.get('outcome')).toBe('kpi-kpi-lead-time');
    // The detail (sources, contributions) is in the popup, not in the card itself.
    expect(card.textContent).not.toContain('Sources');
  });

  it('shows the same headline for an outcome on the bar and on Step 2, and Step 2 opens the selected one', () => {
    useProjUi.setState({ outcomesOpen: true });
    window.location.hash = '#/step?step=tobe&view=outcomes&outcome=kpi-kpi-lead-time';
    render(<><ExpectedOutcomesBar /><Step2 /></>);
    const barCards = [...document.querySelectorAll<HTMLElement>('.outcome-strip-list [data-testid$="-headline"]')];
    expect(barCards.length).toBeGreaterThan(1);
    for (const bar of barCards) {
      const key = bar.dataset.testid!.replace(/^outcome-/, '').replace(/-headline$/, '');
      expect(screen.getByTestId(`outcome-ws-${key}-headline`).textContent).toBe(bar.textContent);
    }
    expect(screen.getByTestId('outcome-detail').dataset.outcome).toBe('kpi-kpi-lead-time');
    expect(screen.getByTestId('outcome-ws-kpi-kpi-lead-time').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('simulation-workbench')).toBeTruthy();
  });
});
