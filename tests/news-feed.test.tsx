import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEWS_INTERVAL_MS } from '../src/data/news.ts';
import { activatePack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { relayFetch } from '../src/modules/ai/relayClient.ts';
import { useFeed } from '../src/state/feed.ts';
import { useProjects } from '../src/state/projects.ts';
import { useSettings } from '../src/state/settings.ts';
import { NewsFeedBar } from '../src/ui/NewsFeedBar.tsx';

vi.mock('../src/modules/ai/relayClient.ts', () => ({ relayFetch: vi.fn() }));
const fetchNews = vi.mocked(relayFetch);
const message = () => within(screen.getByTestId('news-feed').querySelector<HTMLElement>('.live-feed-message')!);
const answer = (company = 'Acme', lang = 'en', articles = true) => new Response(JSON.stringify({
  company, lang, provider: 'Google News RSS', fetchedAt: new Date().toISOString(),
  articles: articles ? [{
    title: `${company} announcement`, source: 'Test Publisher',
    url: `https://example.com/${company}`, publishedAt: '2026-11-10T10:00:00.000Z',
  }] : [],
}));

beforeEach(() => {
  fetchNews.mockReset();
  useSettings.setState({ lang: 'en' });
  useFeed.setState({ paused: false });
  useProjects.setState({
    companies: [{ id: 'a', name: 'Acme', createdAt: '' }, { id: 'b', name: 'Other', createdAt: '' }],
    projects: [
      { id: 'pa', companyId: 'a', name: 'A project', createdAt: '', step: 'define' },
      { id: 'pb', companyId: 'b', name: 'B project', createdAt: '', step: 'define' },
    ],
    target: { kind: 'project', projectId: 'pa' },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  activatePack(samplePack, { kind: 'sample' });
});

describe('company news display', () => {
  it('fetches the registered company rather than the sample pack, and displays provenance and safe links', async () => {
    fetchNews.mockResolvedValue(answer());
    render(<NewsFeedBar />);
    const article = await message().findByRole('link', { name: 'Acme announcement' });
    expect(article.getAttribute('href')).toBe('https://example.com/Acme');
    expect(article.getAttribute('rel')).toBe('noopener noreferrer');
    expect(message().getByText('Test Publisher')).toBeDefined();
    expect(document.querySelector('time')?.dateTime).toBe('2026-11-10T10:00:00.000Z');
    expect(JSON.parse(String(fetchNews.mock.calls[0]![1]?.body))).toEqual({ company: 'Acme', lang: 'en' });
  });

  it('does not contact an external service for the fictional demo', () => {
    useProjects.setState({ target: { kind: 'demo' } });
    render(<NewsFeedBar />);
    expect(screen.getByText(/No external news search/)).toBeDefined();
    expect(fetchNews).not.toHaveBeenCalled();
  });

  it('uses the real base pack for a non-sample demo', async () => {
    activatePack({ ...samplePack, isSample: false, company: { ...samplePack.company, name: { ja: '企業', en: ' Real Company ' } } });
    useProjects.setState({ target: { kind: 'demo' } });
    fetchNews.mockResolvedValue(answer('Real Company'));
    render(<NewsFeedBar />);
    await message().findByRole('link', { name: 'Real Company announcement' });
    expect(JSON.parse(String(fetchNews.mock.calls[0]![1]?.body)).company).toBe('Real Company');
  });

  it('clears previous articles and aborts in-flight work on company or language changes', async () => {
    let resolve!: (value: Response) => void;
    fetchNews.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockImplementation(async (_url, init) => {
      const { company, lang } = JSON.parse(String(init?.body)) as { company: string; lang: string };
      return answer(company, lang);
    });
    render(<NewsFeedBar />);
    const signal = fetchNews.mock.calls[0]![1]?.signal;
    act(() => useProjects.getState().setTarget({ kind: 'project', projectId: 'pb' }));
    await message().findByRole('link', { name: 'Other announcement' });
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(answer()));
    expect(screen.queryByText('Acme announcement')).toBeNull();
    act(() => useSettings.getState().setLang('ja'));
    await waitFor(() => expect(fetchNews).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchNews.mock.calls[2]![1]?.body))).toEqual({ company: 'Other', lang: 'ja' });
  });

  it('shows empty results, failures, retries and retains last successful metadata after refresh failure', async () => {
    fetchNews.mockResolvedValueOnce(answer('Acme', 'en', false))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce(new Response('{}', { status: 502 }));
    render(<NewsFeedBar />);
    await screen.findByText('No news found for this company.');
    fireEvent.click(screen.getByTestId('news-refresh'));
    await screen.findByText('Refresh failed. Showing previously fetched news.');
    fireEvent.click(screen.getByTestId('news-refresh'));
    await message().findByRole('link', { name: 'Acme announcement' });
    fireEvent.click(screen.getByTestId('news-refresh'));
    await screen.findByText('Refresh failed. Showing previously fetched news.');
    expect(message().getByRole('link', { name: 'Acme announcement' })).toBeDefined();
    expect(screen.getByTestId('news-freshness').textContent).toBe('Fetch failed');
  });

  it('makes malformed responses and initial errors visible, without simulation fallbacks', async () => {
    fetchNews.mockResolvedValueOnce(answer('Wrong Company'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ articles: [] })));
    render(<NewsFeedBar />);
    await screen.findByText(/News could not be fetched/);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('news-refresh'));
    await waitFor(() => expect(fetchNews).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/News could not be fetched/)).toBeDefined();
  });

  it('polls at five-minute intervals, pauses/resumes and cleans up on unmount', async () => {
    vi.useFakeTimers();
    fetchNews.mockImplementation(async () => answer());
    let unmount!: () => void;
    await act(async () => { ({ unmount } = render(<NewsFeedBar />)); });
    expect(fetchNews).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(NEWS_INTERVAL_MS - 1); });
    expect(fetchNews).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchNews).toHaveBeenCalledTimes(2);
    act(() => useFeed.getState().setPaused(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(NEWS_INTERVAL_MS * 2); });
    expect(fetchNews).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('news-freshness').textContent).toBe('Paused');
    await act(async () => useFeed.getState().setPaused(false));
    expect(fetchNews).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(NEWS_INTERVAL_MS * 2); });
    expect(fetchNews).toHaveBeenCalledTimes(3);
  });
});
