import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Field, Select, Spinner } from '@fluentui/react-components';
import { ArrowDownload20Regular, Video20Regular } from '@fluentui/react-icons';
import { aiLive, preflight, type AiRequest, type LiveCall } from '../../ai/client.ts';
import { StoryOutput, StoryScenes } from '../../ai/storyOutput.ts';
import { getEntity } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { useUseCases } from '../usecases/store.ts';
import { downloadText } from '../project/common.tsx';
import { LiveNotice, MockNotice, reasonKey } from './AiCommon.tsx';
import { fetchStoryQuote, RelayError, type StoryQuote } from './relayClient.ts';
import { useAiSettings } from './settingsStore.ts';
import { liveStoryPrompt, sourceFromUseCase, sourcesFromSolutions, STORY_OUTPUT_TOKENS, storyMock, storyPrompt, storyState, useStories, type StoryVideo } from './story.ts';
import { storyHtml } from './storyHtml.ts';

function StoryPlayer({ video }: { video: StoryVideo }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const remaining = useRef(video.scenes[0]?.durationMs ?? 0);
  const deadline = useRef(0);
  useEffect(() => {
    if (reduced) { setPlaying(false); return; }
    if (!playing) return;
    deadline.current = performance.now() + remaining.current;
    const timer = window.setTimeout(() => {
      if (index + 1 >= video.scenes.length) {
        remaining.current = video.scenes[index]!.durationMs;
        setPlaying(false);
      } else {
        remaining.current = video.scenes[index + 1]!.durationMs;
        setIndex(index + 1);
      }
    }, remaining.current);
    return () => window.clearTimeout(timer);
  }, [playing, reduced, index, video.scenes]);
  return (
    <div className="ai-stack">
      <div className="ai-row">
        {!reduced && <Button onClick={() => {
          if (playing) remaining.current = Math.max(0, deadline.current - performance.now());
          setPlaying((value) => !value);
        }}>{t(playing ? 'ai.story.pause' : 'ai.story.play')}</Button>}
        <Button onClick={() => { setPlaying(false); setIndex(0); remaining.current = video.scenes[0]!.durationMs; }}>{t('ai.story.restart')}</Button>
      </div>
      <iframe title={t('ai.story.title')} srcDoc={storyHtml(video, { embedded: true, ...(reduced ? {} : { sceneIndex: index }) })}
        sandbox="" referrerPolicy="no-referrer" style={{ width: '100%', height: 560, border: 0 }} data-testid="ai-story-player" />
    </div>
  );
}

export function StoryVideoSection() {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const settings = useAiSettings();
  const useCases = useUseCases((s) => s.value);
  const stories = useStories((s) => s.value);
  const setStories = useStories((s) => s.set);
  const sources = useMemo(() => {
    if (useCases.length > 0) return useCases.map(sourceFromUseCase);
    return sourcesFromSolutions((id) => {
      const e = getEntity(id);
      return !!e && !isHidden(e, audience);
    });
  }, [useCases, audience]);
  const [selected, setSelected] = useState('');
  const source = sources.find((s) => s.id === selected) ?? sources[0];
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<StoryQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const request = useMemo<AiRequest | null>(() => source ? ({
    use: 'storyVideo', lang, prompt: liveStoryPrompt(source, lang), maxOutputTokens: STORY_OUTPUT_TOKENS, timeoutMs: 90_000,
  }) : null, [source, lang]);
  const call = useMemo<LiveCall | null>(() => request ? ({
    ...request, provider: 'foundry', context: '', maxOutputTokens: STORY_OUTPUT_TOKENS, timeoutMs: 90_000,
  }) : null, [request]);
  const pf = request ? preflight(request) : null;
  const liveAllowed = settings.provider === 'foundry' && !!pf?.allowed;
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!call || !liveAllowed) return;
    const controller = new AbortController();
    void fetchStoryQuote(call, controller.signal).then(setQuote).catch((err: unknown) => {
      if (!controller.signal.aborted) setQuoteError(err instanceof RelayError ? err.code : 'relayUnreachable');
    });
    return () => controller.abort();
  }, [call, liveAllowed, settings.relayConnection, revision]);
  useEffect(() => () => abort.current?.abort(), [request]);

  if (!source || !request) return <p>{t('ai.story.noSource')}</p>;
  const video = stories[source.id];
  const state = busy ? 'generating' : video?.lang !== lang && video ? 'stale' : storyState(video, source);
  const html = video?.scenes.length ? storyHtml(video) : null;
  const pricingError = (code: string) => {
    if (code === 'storyMonthlyCap') return t('ai.story.monthlyCap');
    if (code === 'storyCap') return t('ai.story.overCap');
    if (code === 'storyPricing') return t('ai.story.noPrice');
    return t('ai.story.failed', { code });
  };
  const save = (scenes: StoryVideo['scenes'], mode: 'mock' | 'live', spentJpy: number, estimateJpy: number) => {
    setStories((prev) => ({
      ...prev, [source.id]: {
        sourceId: source.id, sourceUpdatedAt: source.updatedAt, lang, scenes, createdAt: new Date().toISOString(),
        calls: mode === 'live' ? 1 : 0, spentJpy, estimateJpy, mode, status: 'latest',
      },
    }));
  };
  const generate = async () => {
    if (!quote || !liveAllowed || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await aiLive(request, controller.signal);
      const output = StoryOutput.parse(JSON.parse(result.text));
      if (!controller.signal.aborted) save(output.scenes, 'live', result.costJpy ?? quote.maximumJpy, quote.maximumJpy);
    } catch (err) {
      setError(controller.signal.aborted ? t('ai.story.abort.cancelled') : t('ai.story.failed', { code: err instanceof Error ? err.message : 'unknown' }));
    } finally {
      setBusy(false);
      abort.current = null;
      setRevision((value) => value + 1);
    }
  };

  return (
    <div className="ai-stack" data-testid="ai-story">
      <p className="muted">{t('ai.story.htmlLead')}</p>
      {useCases.length === 0 && <p className="muted">{t('ai.story.fromSolutions')}</p>}
      <Field label={t('ai.story.source')}>
        <Select disabled={busy} value={source.id} onChange={(_, d) => { setSelected(d.value); setError(null); }} data-testid="ai-story-source">
          {sources.map((s) => <option key={s.id} value={s.id}>{loc(s.title, lang)}</option>)}
        </Select>
      </Field>
      <div className="ai-status" data-testid="ai-story-estimate">
        {quote ? <span>{t('ai.story.estimate', { maximum: fmt.yen(Math.ceil(quote.maximumJpy)), remaining: fmt.yen(Math.floor(quote.remainingJpy)) })}</span>
          : <span>{quoteError ? pricingError(quoteError) : liveAllowed ? t('ai.loading') : t('ai.story.noPrice')}</span>}
      </div>
      {!liveAllowed && <ul>{pf?.reasons.map((reason) => <li key={reason}>{t(reasonKey(reason))}</li>)}</ul>}
      <div className="ai-row">
        <Button appearance="primary" icon={<Video20Regular />} disabled={!quote || !liveAllowed || busy} onClick={() => void generate()} data-testid="ai-story-generate-live">
          {t('ai.story.generateLive')}
        </Button>
        <Button disabled={busy} onClick={() => {
          setError(null);
          try {
            save(StoryScenes.parse(JSON.parse(storyMock(storyPrompt(source, lang, 'storyboard')))), 'mock', 0, 0);
          } catch (err) {
            setError(t('ai.story.failed', { code: err instanceof Error ? err.message : 'unknown' }));
          }
        }} data-testid="ai-story-generate">{t('ai.story.generateMock')}</Button>
        {busy && <Button onClick={() => abort.current?.abort()}>{t('ai.story.cancel')}</Button>}
        <Badge appearance="outline" data-testid="ai-story-state">{t(`ai.story.state.${state}`)}</Badge>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <Spinner size="tiny" label={t('ai.loading')} />}
      {video && !busy && <>
        {video.mode === 'live'
          ? <LiveNotice costJpy={video.spentJpy} />
          : <MockNotice reasons={[]}><p>{t('ai.usage.mockFree')}</p></MockNotice>}
        {html && <>
          <Button icon={<ArrowDownload20Regular />} onClick={() => downloadText(`story-${source.id.replace(/[^\w-]/g, '_')}.html`, html, 'text/html')} data-testid="ai-story-download">
            {t('ai.story.download')}
          </Button>
          <StoryPlayer key={`${video.sourceId}-${video.createdAt}`} video={video} />
        </>}
      </>}
    </div>
  );
}
