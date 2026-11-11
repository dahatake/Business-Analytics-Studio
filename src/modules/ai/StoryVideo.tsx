import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Field, Select, Spinner } from '@fluentui/react-components';
import { Pause20Regular, Play20Regular, Video20Regular } from '@fluentui/react-icons';
import { aiComplete } from '../../ai/client.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { useUseCases } from '../usecases/store.ts';
import { MockNotice } from './AiCommon.tsx';
import {
  runStoryGeneration, sourceFromUseCase, sourcesFromSolutions,
  storyInputTokens, storyPrompt, storyState, useStories, type StoryEstimate, type StoryScene, type StoryVideo,
} from './story.ts';

/** HTML/CSS/SVG playback of a storyboard (no video file). Never autoplays; reduced motion shows all scenes statically. */
function StoryPlayer({ video }: { video: StoryVideo }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!playing || reduced) return;
    const scene = video.scenes[index];
    if (!scene) {
      setPlaying(false);
      setIndex(0);
      return;
    }
    timer.current = window.setTimeout(() => setIndex((i) => i + 1), scene.durationMs);
    return () => window.clearTimeout(timer.current);
  }, [playing, index, reduced, video.scenes]);

  const scenes: StoryScene[] = reduced || !playing ? video.scenes : video.scenes.slice(index, index + 1);
  return (
    <div className="ai-story" data-testid="ai-story-player">
      {!reduced && (
        <Button icon={playing ? <Pause20Regular /> : <Play20Regular />} onClick={() => setPlaying((p) => !p)}>
          {playing ? t('ai.story.pause') : t('ai.story.play')}
        </Button>
      )}
      <ol className={`ai-story-scenes ${playing && !reduced ? 'is-playing' : ''}`} aria-live={playing ? 'polite' : 'off'}>
        {scenes.map((s, i) => (
          <li key={`${s.title}-${i}`} className={`ai-scene ai-scene-${s.role}`}>
            <svg className="ai-scene-art" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="26" className="ai-scene-ring" />
              <circle cx="32" cy="32" r={s.role === 'opening' ? 10 : s.role === 'closing' ? 18 : 14} className="ai-scene-dot" />
            </svg>
            <div>
              <p className="ai-scene-title">{s.title}</p>
              <p className="ai-scene-text">{s.narration}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** FR-291 / FR-292: story video from a use case, with an estimate before generating and the PARAM-128 cap. */
export function StoryVideoSection() {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const useCases = useUseCases((s) => s.value);
  const stories = useStories((s) => s.value);
  const setStories = useStories((s) => s.set);
  const sources = useMemo(() => {
    if (useCases.length > 0) return useCases.map(sourceFromUseCase);
    return sourcesFromSolutions((id) => {
      const e = loaded.byId.get(id);
      return !!e && !isHidden(e, audience);
    });
  }, [useCases, audience]);
  const [selected, setSelected] = useState('');
  const source = sources.find((s) => s.id === selected) ?? sources[0];
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const cancelled = useRef(false);

  if (!source) return <p>{t('ai.story.noSource')}</p>;
  // This use is mock-only under C-03 and does not incur provider charges.
  const estimate: StoryEstimate = { ok: true, inputTokens: storyInputTokens(source, lang), perCallJpy: 0, totalJpy: 0 };
  const video = stories[source.id];
  const state = busy ? 'generating' : storyState(video, source);

  const generate = async () => {
    if (!estimate.ok) return;
    cancelled.current = false;
    setBusy(true);
    const result = await runStoryGeneration(estimate, async (step) => {
      const res = await aiComplete({ use: 'storyVideo', lang, prompt: storyPrompt(source, lang, step) });
      setReasons(res.blockedReasons);
      // Mock answers are free and do not enter the provider usage ledger.
      return res.text && res.text !== '[]' ? { text: res.text, costJpy: estimate.perCallJpy } : null;
    }, () => cancelled.current);
    let scenes: StoryScene[] = [];
    try {
      scenes = JSON.parse(result.outputs.storyboard ?? '[]') as StoryScene[];
      const timings = JSON.parse(result.outputs.animation ?? '[]') as number[];
      scenes = scenes.map((s, i) => ({ ...s, durationMs: timings[i] ?? s.durationMs }));
    } catch {
      scenes = [];
    }
    setStories((prev) => ({
      ...prev,
      [source.id]: {
        sourceId: source.id, sourceUpdatedAt: source.updatedAt, lang, scenes, createdAt: new Date().toISOString(),
        calls: result.calls, spentJpy: result.spentJpy, estimateJpy: estimate.totalJpy,
        status: result.status === 'done' ? 'latest' : 'aborted', ...(result.reason ? { abortReason: result.reason } : {}),
      },
    }));
    setBusy(false);
  };

  return (
    <div className="ai-stack" data-testid="ai-story">
      <p className="muted">{t('ai.story.mockLead')}</p>
      {useCases.length === 0 && <p className="muted">{t('ai.story.fromSolutions')}</p>}
      <Field label={t('ai.story.source')}>
        <Select value={source.id} onChange={(_, d) => setSelected(d.value)} data-testid="ai-story-source">
          {sources.map((s) => <option key={s.id} value={s.id}>{loc(s.title, lang)}</option>)}
        </Select>
      </Field>
      <div className="ai-status" data-testid="ai-story-estimate">
        <span>{t('ai.usage.mockFree')}</span>
      </div>
      <div className="ai-row">
        <Button appearance="primary" icon={<Video20Regular />} disabled={!estimate.ok || busy} onClick={() => void generate()} data-testid="ai-story-generate">
          {t('ai.story.generateMock')}
        </Button>
        {busy && <Button onClick={() => { cancelled.current = true; }}>{t('ai.story.cancel')}</Button>}
        <Badge appearance="outline" data-testid="ai-story-state">{t(`ai.story.state.${state}`)}</Badge>
      </div>
      {busy && <Spinner size="tiny" label={t('ai.loading')} />}
      {video && !busy && (
        <>
          <MockNotice reasons={reasons.length ? reasons : ['c03NotApproved']}>
            <p className="muted">{t('ai.story.spent', { calls: video.calls, spent: fmt.yen(Math.ceil(video.spentJpy)) })}</p>
            {video.status === 'aborted' && <p role="status">{t(`ai.story.abort.${video.abortReason ?? 'budget'}`)}</p>}
          </MockNotice>
          {video.scenes.length > 0 && <StoryPlayer video={video} />}
        </>
      )}
    </div>
  );
}
