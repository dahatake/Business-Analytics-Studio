import { useEffect, useRef } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowCounterclockwise20Regular, Dismiss20Regular, Pause20Regular, Play20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { loc } from '../../state/text.ts';
import { SceneShape } from './AnimationPlayer.tsx';
import type { MotionElement, StoryScene, Timeline } from './scenes.ts';
import type { StoryStyle } from './store.ts';
import { speak, stopSpeaking } from './speech.ts';
import { formatClock, usePlayback } from './usePlayback.ts';

function Element({ el, i }: { el: MotionElement; i: number }) {
  const shape = (() => {
    switch (el.kind) {
      case 'persona': return <><circle cx="30" cy="20" r="11" /><path d="M10 56 C10 38 50 38 50 56 Z" /></>;
      case 'data': return <><ellipse cx="30" cy="14" rx="20" ry="7" /><path d="M10 14 V46 C10 54 50 54 50 46 V14" /></>;
      case 'arrow': return <path d="M6 30 H44 M34 18 L48 30 L34 42" strokeWidth="6" fill="none" />;
      case 'spark': return <path d="M30 4 L35 25 L56 30 L35 35 L30 56 L25 35 L4 30 L25 25 Z" />;
      case 'kpi': return <><rect x="8" y="34" width="10" height="20" /><rect x="25" y="22" width="10" height="32" /><rect x="42" y="8" width="10" height="46" /></>;
      case 'check': return <path d="M8 32 L24 48 L52 14" strokeWidth="8" fill="none" />;
    }
  })();
  return (
    <svg className={`uc-sb-el uc-motion-${el.motion}`} style={{ animationDelay: `${i * 180}ms` }} width="60" height="60" viewBox="0 0 60 60" aria-hidden="true" focusable="false">
      {shape}
    </svg>
  );
}

/** FR-164 / FR-165: full-screen, ~30 s, animation-centred playback with captions and an emphasis telop. */
export function StoryPlayer({ timeline, style, readAloud, onClose }: { timeline: Timeline<StoryScene>; style: StoryStyle; readAloud: boolean; onClose: () => void }) {
  const { t, lang } = useI18n();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { scenes, totalMs } = timeline;
  const pb = usePlayback(scenes, totalMs, !reduced);
  const scene = scenes[pb.index]!;

  useEffect(() => {
    const el = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => undefined);
    return () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
      stopSpeaking();
      opener?.focus?.();
    };
  }, []);
  useEffect(() => {
    if (readAloud && pb.state === 'playing') speak(loc(scene.subtitle, lang), lang);
  }, [readAloud, pb.state, pb.index, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const kindLabel = scene.kind === 'step' ? t('uc.anim.step', { n: scene.stepNo ?? 0 }) : t(`uc.sb.kind.${scene.kind}`);
  return (
    <div
      ref={ref}
      className={`uc-sb-player uc-style-${style} ${reduced ? 'static' : 'moving'}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('uc.sb.playerTitle')}
      data-testid="uc-sb-player"
      data-total-ms={totalMs}
      data-state={pb.state}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        else if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); if (pb.state === 'playing') pb.pause(); else pb.play(); }
        else if (e.key === 'Tab') {
          const items = ref.current?.querySelectorAll<HTMLElement>('button');
          if (!items || items.length === 0) return;
          const first = items[0]!;
          const last = items[items.length - 1]!;
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}
    >
      <div className="uc-sb-frame" key={reduced ? 'static' : pb.index}>
        <div className="uc-sb-kind"><SceneShape kind={scene.kind} n={scene.stepNo} /><span>{kindLabel}</span></div>
        <div className="uc-sb-elements">{scene.elements.map((el, i) => <Element key={i} el={el} i={i} />)}</div>
        <p className="uc-sb-telop" data-testid="uc-sb-telop">{loc(scene.telop, lang)}</p>
        <p className="uc-sb-heading">{loc(scene.heading, lang)}</p>
        <p className="uc-sb-caption" aria-live="polite">{loc(scene.subtitle, lang)}</p>
      </div>
      <div className="uc-sb-bar">
        <div className="uc-sb-progress" role="progressbar" aria-label={t('uc.player.seek')} aria-valuemin={0} aria-valuemax={Math.round(totalMs / 1000)} aria-valuenow={Math.round(pb.ms / 1000)} aria-valuetext={`${formatClock(pb.ms)} / ${formatClock(totalMs)}`}>
          <span style={{ width: `${(pb.ms / totalMs) * 100}%` }} />
        </div>
        <div className="toolbar">
          {pb.state === 'playing'
            ? <Button icon={<Pause20Regular />} onClick={pb.pause}>{t('uc.player.pause')}</Button>
            : <Button icon={<Play20Regular />} onClick={pb.play}>{t('uc.player.play')}</Button>}
          <Button icon={<ArrowCounterclockwise20Regular />} onClick={() => { pb.seek(0); pb.play(); }}>{t('uc.player.restart')}</Button>
          <Button disabled={pb.index === 0} onClick={pb.prev}>{t('uc.player.prev')}</Button>
          <Button disabled={pb.index >= scenes.length - 1} onClick={pb.next}>{t('uc.player.next')}</Button>
          <span className="uc-clock">{formatClock(pb.ms)} / {formatClock(totalMs)}</span>
          <Button ref={closeRef} icon={<Dismiss20Regular />} onClick={onClose}>{t('uc.player.close')}</Button>
        </div>
      </div>
    </div>
  );
}
