import { useEffect, useMemo, useState } from 'react';
import { Button, Slider, ToggleButton } from '@fluentui/react-components';
import { Next20Regular, Pause20Regular, Play20Regular, Previous20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { loc } from '../../state/text.ts';
import type { AnimScene, Timeline } from './scenes.ts';
import { formatClock, usePlayback } from './usePlayback.ts';
import { speak, stopSpeaking } from './speech.ts';

type Layout = 'split' | 'stacked' | 'theater';
const LAYOUTS: Layout[] = ['split', 'stacked', 'theater'];

/** Non-colour cue for the scene kind (NFR-A11Y-006): circle = intro, numbered square = step, star = effect. */
export function SceneShape({ kind, n }: { kind: AnimScene['kind'] | 'hook' | 'story' | 'payoff'; n?: number }) {
  return (
    <svg className={`uc-shape uc-shape-${kind}`} width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      {kind === 'intro' || kind === 'hook' ? <circle cx="20" cy="20" r="16" /> : null}
      {kind === 'step' ? <rect x="5" y="5" width="30" height="30" rx="4" /> : null}
      {kind === 'story' ? <path d="M20 4 L36 20 L20 36 L4 20 Z" /> : null}
      {kind === 'effect' || kind === 'payoff' ? <path d="M20 3 L25 15 L38 15 L27.5 23 L31.5 36 L20 28 L8.5 36 L12.5 23 L2 15 L15 15 Z" /> : null}
      {n !== undefined && <text x="20" y="25" textAnchor="middle" className="uc-shape-no">{n}</text>}
    </svg>
  );
}

/** FR-155 / FR-156 / FR-157: presentation animation of one use case. */
export function AnimationPlayer({ timeline, autoPlay, readAloud }: { timeline: Timeline<AnimScene>; autoPlay: boolean; readAloud: boolean }) {
  const { t, lang } = useI18n();
  const reduced = useReducedMotion();
  const [layout, setLayout] = useState<Layout>('split');
  const { scenes, totalMs } = timeline;
  const pb = usePlayback(scenes, totalMs, autoPlay && !reduced);
  const scene = scenes[pb.index];
  const kindLabel = (s: AnimScene) => (s.kind === 'step' ? t('uc.anim.step', { n: s.stepNo ?? 0 }) : s.kind === 'intro' ? t('uc.anim.intro') : t('uc.anim.effect'));
  const progress = useMemo(() => (scene ? Math.min(1, (pb.ms - scene.startMs) / scene.durationMs) : 0), [pb.ms, scene]);

  useEffect(() => {
    if (readAloud && pb.state === 'playing' && scene) speak(`${loc(scene.heading, lang)}. ${loc(scene.body, lang)}`, lang);
  }, [readAloud, pb.state, pb.index, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopSpeaking(), []);

  if (!scene) return null;
  const transcript = (
    <ol className="uc-transcript" aria-label={t('uc.anim.transcript')}>
      {scenes.map((s, i) => (
        <li key={i} aria-current={i === pb.index ? 'step' : undefined} className={i === pb.index ? 'current' : undefined}>
          <span className="uc-transcript-kind">{kindLabel(s)}</span>
          <strong>{loc(s.heading, lang)}</strong>
          <span>{loc(s.body, lang)}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <div
      className={`uc-player uc-layout-${layout}`}
      data-testid="uc-anim-player"
      data-anim-ready="true"
      data-state={pb.state}
      data-scene={pb.index}
      data-total-ms={totalMs}
    >
      <div className="toolbar" role="group" aria-label={t('uc.anim.layout')}>
        {LAYOUTS.map((l) => (
          <ToggleButton key={l} size="small" checked={layout === l} onClick={() => setLayout(l)}>{t(`uc.anim.layout.${l}`)}</ToggleButton>
        ))}
      </div>
      <div className="uc-player-body">
        <div className="uc-player-main">
          <div className={`uc-stage uc-stage-${scene.kind} ${reduced ? 'static' : 'moving'}`} key={reduced ? 'static' : pb.index} data-testid="uc-anim-stage">
            <div className="uc-stage-kind">
              <SceneShape kind={scene.kind} n={scene.stepNo} />
              <span>{kindLabel(scene)}</span>
              <span className="uc-stage-count">{t('uc.anim.sceneOf', { n: pb.index + 1, total: scenes.length })}</span>
            </div>
            <p className="uc-stage-heading">{loc(scene.heading, lang)}</p>
            <p className="uc-stage-body">{loc(scene.body, lang)}</p>
            <div className="uc-stage-track" aria-hidden="true">
              {scenes.map((_, i) => (
                <span key={i} className={`uc-stage-dot ${i < pb.index ? 'done' : i === pb.index ? 'now' : ''}`} />
              ))}
            </div>
            <div className="uc-stage-progress" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></div>
          </div>
          <p className="visually-hidden" aria-live="polite">{t('uc.anim.sceneOf', { n: pb.index + 1, total: scenes.length })} {loc(scene.heading, lang)}</p>
          <div className="toolbar uc-controls">
            <Button icon={<Previous20Regular />} disabled={pb.index === 0} onClick={pb.prev}>{t('uc.player.prev')}</Button>
            {pb.state === 'playing'
              ? <Button appearance="primary" icon={<Pause20Regular />} onClick={pb.pause}>{t('uc.player.pause')}</Button>
              : <Button appearance="primary" icon={<Play20Regular />} onClick={pb.play}>{t('uc.player.play')}</Button>}
            <Button icon={<Next20Regular />} disabled={pb.index >= scenes.length - 1} onClick={pb.next}>{t('uc.player.next')}</Button>
            <span className="uc-clock">{formatClock(pb.ms)} / {formatClock(totalMs)}</span>
          </div>
          <Slider
            className="uc-seek"
            min={0}
            max={totalMs}
            step={100}
            value={Math.round(pb.ms)}
            aria-label={t('uc.player.seek')}
            aria-valuetext={t('uc.anim.sceneOf', { n: pb.index + 1, total: scenes.length })}
            onChange={(_, d) => pb.seek(d.value)}
          />
          <div className="uc-scene-buttons" role="group" aria-label={t('uc.player.scenes')}>
            {scenes.map((s, i) => (
              <Button
                key={i}
                size="small"
                appearance={i === pb.index ? 'primary' : 'secondary'}
                aria-current={i === pb.index ? 'step' : undefined}
                aria-label={t('uc.player.goScene', { n: i + 1, name: loc(s.heading, lang) })}
                onClick={() => pb.goTo(i)}
              >
                {String(i + 1)}
              </Button>
            ))}
          </div>
        </div>
        {layout === 'theater' ? (
          <details className="uc-transcript-wrap">
            <summary>{t('uc.anim.transcript')}</summary>
            {transcript}
          </details>
        ) : (
          <div className="uc-transcript-wrap">
            <h3 className="subhead">{t('uc.anim.transcript')}</h3>
            {transcript}
          </div>
        )}
      </div>
    </div>
  );
}
