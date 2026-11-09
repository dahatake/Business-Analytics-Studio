import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type Ref } from 'react';
import { Select } from '@fluentui/react-components';
import {
  Previous20Regular, Next20Regular, Play20Regular, Pause20Regular, Speaker220Regular, SpeakerMute20Regular,
  FullScreenMaximize20Regular, FullScreenMinimize20Regular, ClosedCaption20Regular, Keyboard20Regular,
  TextBulletListLtr20Regular, Bot20Regular, Dismiss20Regular, ThumbLike20Regular, Lightbulb20Regular, QuestionCircle20Regular,
  Record20Regular, RecordStop20Regular,
} from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { loaded } from '../../data/pack.ts';
import { useSettings } from '../../state/settings.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { sound } from '../../audio/sound.ts';
import { useUseCases } from '../usecases/store.ts';
import {
  AutoHide, buildChapters, buildStory, CHAPTER_IDS, chapterPoints, chapterTitleKey, intensityProfile, INTENSITIES,
  SHORTCUTS, SHOW_PARAMS, shortVideoSceneMs, storySceneText, actionForKey, type ChapterId, type Intensity, type ShortcutAction,
} from './model.ts';
import { ChapterScene, StorySceneView } from './scenes.tsx';
import { enterFullscreen, exitFullscreen, useShowRun, useShowSettings, type Program } from './store.ts';
import {
  browserCaptureEnv, captureErrorReason, captureSupported, downloadBlob, pickRecordingMime, RECORD_IDLE, recordDialogOpen,
  recordLimitMs, recordReducer, recordStream, stopTracks, TAB_CAPTURE_OPTIONS, videoFileName, withAudioCodec, type ActiveRecording,
} from './recorder.ts';

interface Slide {
  id: string;
  title: string;
  points: string[];
  autoMs: number;
  render: (headingId: string, next: () => void) => ReactNode;
}

type SidePanel = 'narrator' | 'outline' | 'help' | null;

const REACTIONS = [
  { id: 'like', Icon: ThumbLike20Regular, label: 'show.react.like' },
  { id: 'idea', Icon: Lightbulb20Regular, label: 'show.react.idea' },
  { id: 'question', Icon: QuestionCircle20Regular, label: 'show.react.question' },
] as const;

function useSlides(program: Program): Slide[] {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const useCases = useUseCases((s) => s.value);
  return useMemo(() => {
    if (program.kind === 'story') {
      const story = buildStory(program.persona, useCases, audience, lang);
      return story.scenes.map((scene) => {
        const text = storySceneText(scene, story, lang);
        return {
          id: scene.id,
          title: text.title,
          points: text.lines,
          autoMs: 12_000,
          render: (headingId: string) => <StorySceneView scene={scene} story={story} headingId={headingId} title={text.title} lines={text.lines} />,
        };
      });
    }
    const chapters = buildChapters(audience);
    const shortMs = shortVideoSceneMs(chapters.length);
    return chapters.map((ch) => {
      const title = t(chapterTitleKey(ch.id));
      return {
        id: ch.id,
        title,
        points: chapterPoints(ch, lang),
        autoMs: program.kind === 'short' ? shortMs : ch.id === 'opening' ? SHOW_PARAMS.openingMs : SHOW_PARAMS.chapterMs,
        render: (headingId: string, next: () => void) => <ChapterScene chapter={ch} headingId={headingId} title={title} onSkip={next} />,
      };
    });
  }, [program, useCases, audience, lang, t]);
}

const FOCUSABLE = 'button:not([disabled]), [href], select, input, textarea, [tabindex]:not([tabindex="-1"])';

/** FR-016 / FR-077〜085 / FR-177〜178: the full-screen presentation layer. */
export function ShowPlayer({ program }: { program: Program }) {
  const { t, lang } = useI18n();
  const reduced = useReducedMotion();
  const { muted, setMuted } = useSettings();
  const stop = useShowRun((s) => s.stop);
  const settings = useShowSettings();
  const slides = useSlides(program);
  const initial = program.kind === 'show' && program.chapter !== undefined ? Math.min(program.chapter, slides.length - 1) : 0;
  const [index, setIndex] = useState(initial);
  const [playing, setPlaying] = useState(!reduced);
  const [panel, setPanel] = useState<SidePanel>(settings.narrator ? 'narrator' : null);
  const [barVisible, setBarVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(() => document.fullscreenElement !== null);
  const [reactions, setReactions] = useState<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const autoHide = useRef<AutoHide | null>(null);
  const leavingFullscreen = useRef(false);
  const headingId = useId();
  const profile = intensityProfile(settings.intensity, reduced);
  const slide = slides[Math.min(index, slides.length - 1)]!;
  const total = slides.length;

  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(total - 1, i))), [total]);
  const next = useCallback(() => setIndex((i) => Math.min(total - 1, i + 1)), [total]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // FR-081: save the short video as a file (Screen Capture API + MediaRecorder).
  const [rec, dispatchRec] = useReducer(recordReducer, RECORD_IDLE);
  const recRef = useRef(rec);
  recRef.current = rec;
  const activeRec = useRef<ActiveRecording | null>(null);
  const recTimer = useRef<number | undefined>(undefined);
  const recButtonRef = useRef<HTMLButtonElement>(null);
  const recDialogRef = useRef<HTMLDivElement>(null);
  const recDialogId = useId();
  const recDialogWasOpen = useRef(false);
  const unmounted = useRef(false);
  const sequenceMs = useMemo(() => slides.reduce((sum, s) => sum + s.autoMs, 0), [slides]);
  const companyName = loaded.pack.company.name[lang];
  const plannedFile = videoFileName(companyName, new Date(), pickRecordingMime(browserCaptureEnv().isTypeSupported) ?? 'video/webm');
  const dialogOpen = recordDialogOpen(rec);

  const openRecord = useCallback(() => {
    setPlaying(false);
    if (!captureSupported(browserCaptureEnv())) dispatchRec({ type: 'fail', reason: 'unsupported' });
    else dispatchRec({ type: 'open' });
  }, []);

  const stopRecording = useCallback(() => {
    window.clearTimeout(recTimer.current);
    dispatchRec({ type: 'stop' });
    activeRec.current?.stop();
  }, []);

  const beginRecording = useCallback(async () => {
    const env = browserCaptureEnv();
    const baseMime = pickRecordingMime(env.isTypeSupported);
    if (!env.getDisplayMedia || !env.isTypeSupported || !baseMime) {
      dispatchRec({ type: 'fail', reason: 'unsupported' });
      return;
    }
    dispatchRec({ type: 'confirm' });
    let stream: MediaStream;
    try {
      // Called from the click on "Start recording", so the request keeps its user activation.
      stream = await env.getDisplayMedia(TAB_CAPTURE_OPTIONS);
    } catch (err) {
      dispatchRec({ type: 'fail', reason: captureErrorReason(err) });
      return;
    }
    if (unmounted.current || recRef.current.status !== 'requesting') {
      stopTracks(stream);
      return;
    }
    const mime = withAudioCodec(baseMime, stream.getAudioTracks().length > 0, env.isTypeSupported);
    const name = companyName;
    dispatchRec({ type: 'granted' });
    setIndex(0);
    setPlaying(true);
    activeRec.current = recordStream(stream, mime, (result) => {
      window.clearTimeout(recTimer.current);
      activeRec.current = null;
      setPlaying(false);
      dispatchRec({ type: 'stop' });
      if (!result.ok) {
        dispatchRec({ type: 'fail', reason: 'failed' });
        return;
      }
      const fileName = videoFileName(name, new Date(), result.mime);
      downloadBlob(result.blob, fileName);
      dispatchRec({ type: 'saved', fileName });
    });
    recTimer.current = window.setTimeout(stopRecording, recordLimitMs(sequenceMs));
  }, [companyName, sequenceMs, stopRecording]);

  // Leaving the show while recording still saves what was recorded and releases the capture.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      window.clearTimeout(recTimer.current);
      activeRec.current?.stop();
    };
  }, []);

  const closeRecordDialog = useCallback(() => {
    const s = recRef.current.status;
    if (s === 'confirm') dispatchRec({ type: 'cancel' });
    else if (s === 'error') dispatchRec({ type: 'dismiss' });
  }, []);

  useEffect(() => {
    if (rec.status === 'confirm' || rec.status === 'error') {
      recDialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    } else if (rec.status === 'idle' || rec.status === 'recording') {
      if (recDialogWasOpen.current) recButtonRef.current?.focus();
    }
    recDialogWasOpen.current = recordDialogOpen(rec);
  }, [rec]);

  // NFR-A11Y-008: reduced motion never autoplays.
  useEffect(() => { if (reduced) setPlaying(false); }, [reduced]);

  // FR-057: remember the last chapter of the program.
  useEffect(() => {
    if (program.kind === 'show' && (CHAPTER_IDS as readonly string[]).includes(slide.id)) settings.update({ lastChapter: slide.id as ChapterId });
    stageRef.current?.focus({ preventScroll: true });
    if (profile.sfx) sound.play(slide.id === 'roi' && profile.decorations ? 'success' : 'tap');
  }, [slide.id]);

  useEffect(() => {
    if (!playing) return;
    if (index >= total - 1) {
      const id = window.setTimeout(() => setPlaying(false), slide.autoMs);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(next, slide.autoMs);
    return () => window.clearTimeout(id);
  }, [playing, index, total, slide.autoMs, next]);

  // FR-084: the control bar hides after PARAM-026 without activity.
  useEffect(() => {
    const ah = new AutoHide(setBarVisible);
    autoHide.current = ah;
    return () => ah.dispose();
  }, []);
  const activity = useCallback(() => autoHide.current?.activity(), []);

  // Make the rest of the app inert while the modal show is open.
  useEffect(() => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return;
    const changed: Element[] = [];
    for (const el of Array.from(parent.children)) {
      if (el !== root && !el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        changed.push(el);
      }
    }
    return () => changed.forEach((el) => el.removeAttribute('inert'));
  }, []);

  useEffect(() => {
    let sawFullscreen = document.fullscreenElement !== null && useShowRun.getState().enteredFullscreen;
    const onChange = () => {
      const fs = document.fullscreenElement !== null;
      setIsFullscreen(fs);
      if (fs) sawFullscreen = true;
      // Esc handled by the browser leaves fullscreen first: treat it as "exit the show".
      else if (sawFullscreen && !leavingFullscreen.current) {
        if (recRef.current.status === 'recording') stopRecording();
        else stop();
      }
      leavingFullscreen.current = false;
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [stop, stopRecording]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      leavingFullscreen.current = true;
      useShowRun.setState({ enteredFullscreen: false });
      await exitFullscreen();
    } else {
      const ok = await enterFullscreen();
      if (ok) useShowRun.setState({ enteredFullscreen: true });
    }
  }, []);

  const togglePanel = useCallback((p: Exclude<SidePanel, null>) => {
    setPanel((cur) => {
      const nextPanel = cur === p ? null : p;
      useShowSettings.getState().update({ narrator: nextPanel === 'narrator' });
      return nextPanel;
    });
  }, []);

  const run = useCallback((action: ShortcutAction) => {
    switch (action) {
      case 'help': togglePanel('help'); break;
      case 'outline': togglePanel('outline'); break;
      case 'narrator': togglePanel('narrator'); break;
      case 'prev': prev(); break;
      case 'next': next(); break;
      case 'first': go(0); break;
      case 'last': go(total - 1); break;
      case 'play': setPlaying((p) => !p); break;
      case 'mute': setMuted(!useSettings.getState().muted); break;
      case 'fullscreen': void toggleFullscreen(); break;
      case 'captions': useShowSettings.getState().update({ captions: !useShowSettings.getState().captions }); break;
      case 'exit': stop(); break;
    }
  }, [togglePanel, prev, next, go, total, setMuted, toggleFullscreen, stop]);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      activity();
      if (recordDialogOpen(recRef.current)) {
        const dialog = recDialogRef.current;
        if (e.key === 'Escape') { e.preventDefault(); closeRecordDialog(); return; }
        if (e.key === 'Tab' && dialog) {
          const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
          if (items.length === 0) { e.preventDefault(); return; }
          const first = items[0]!, last = items[items.length - 1]!;
          if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        }
        return;
      }
      if (e.key === 'Escape' && recRef.current.status === 'recording') { e.preventDefault(); stopRecording(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key !== 'Escape') return;
      }
      if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
      if (e.key === 'Tab') {
        const root = rootRef.current;
        if (!root) return;
        const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (items.length === 0) return;
        const first = items[0]!, last = items[items.length - 1]!;
        if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      const action = actionForKey(e.key);
      if (!action) return;
      e.preventDefault();
      run(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activity, run, closeRecordDialog, stopRecording]);

  const progressText = t('show.progress.value', { current: index + 1, total, title: slide.title });
  const captionsOn = settings.captions;

  return (
    <div
      ref={rootRef}
      className={`show-player intensity-${settings.intensity} ${reduced ? 'is-reduced' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={program.kind === 'story' ? t('show.story.dialog') : t('show.player.label')}
      data-testid="show-player"
      data-program={program.kind}
      style={{ ['--show-dur' as string]: `${profile.durationMs}ms` }}
      onPointerMove={activity}
      onPointerDown={activity}
    >
      <nav className="show-progress" aria-label={t('show.progress.label')}>
        <div className="show-progress-track" role="progressbar" aria-label={t('show.progress.label')} aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1} aria-valuetext={progressText}>
          <span className="show-progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
        </div>
        <ol className="show-markers">
          {slides.map((s, i) => (
            <li key={s.id}>
              <button type="button" className="show-marker" aria-current={i === index ? 'step' : undefined} onClick={() => go(i)} data-testid={`show-marker-${s.id}`}>
                <span className="show-marker-no">{i + 1}</span>
                <span className="show-marker-title">{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className={`show-main ${panel ? 'has-panel' : ''}`}>
        <section
          ref={stageRef}
          key={slide.id}
          tabIndex={-1}
          className={`show-stage show-anim-${profile.transition} ${profile.decorations ? 'show-decor' : ''}`}
          aria-labelledby={headingId}
          aria-roledescription={t('show.scene.roledescription')}
          data-testid="show-scene"
          data-scene={slide.id}
        >
          {slide.render(headingId, next)}
        </section>
        {panel === 'narrator' && (
          <aside className="show-side" aria-labelledby={`${headingId}-nav`} data-testid="show-narrator">
            <h2 id={`${headingId}-nav`} className="show-side-title">{t('show.narrator.title')}</h2>
            <p className="show-muted">{t('show.narrator.note')}</p>
            <ul className="show-points">
              {slide.points.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </aside>
        )}
        {panel === 'outline' && (
          <aside className="show-side" aria-labelledby={`${headingId}-outline`} data-testid="show-outline">
            <h2 id={`${headingId}-outline`} className="show-side-title">{t('show.outline.title')}</h2>
            <ol className="show-outline">
              {slides.map((s, i) => (
                <li key={s.id} aria-current={i === index ? 'step' : undefined}>
                  <button type="button" className="show-link" onClick={() => go(i)}>{s.title}</button>
                  <ul>{s.points.map((p) => <li key={p}>{p}</li>)}</ul>
                </li>
              ))}
            </ol>
          </aside>
        )}
        {panel === 'help' && (
          <aside className="show-side" aria-labelledby={`${headingId}-help`} data-testid="show-shortcuts">
            <h2 id={`${headingId}-help`} className="show-side-title">{t('show.shortcuts.title')}</h2>
            <ShortcutList />
          </aside>
        )}
      </div>

      <div className="show-lower-third" data-testid="show-lower-third">
        <p className="show-lt-chapter"><span className="show-lt-no">{t('show.progress.short', { current: index + 1, total })}</span>{slide.title}</p>
        <p className="show-lt-caption" aria-live="polite" data-testid="show-caption">{captionsOn ? slide.points[0] ?? '' : ''}</p>
      </div>

      <div
        className="show-controlbar"
        role="group"
        aria-label={t('show.controls.label')}
        data-testid="show-controlbar"
        data-visible={barVisible ? 'true' : 'false'}
        onFocus={() => autoHide.current?.pin(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) autoHide.current?.pin(false); }}
      >
        <CtlButton icon={<Previous20Regular />} label={t('show.controls.prev')} onClick={prev} disabled={index === 0} />
        <CtlButton icon={playing ? <Pause20Regular /> : <Play20Regular />} label={playing ? t('show.controls.pause') : t('show.controls.play')} onClick={() => setPlaying((p) => !p)} testId="show-play" />
        <CtlButton icon={<Next20Regular />} label={t('show.controls.next')} onClick={next} disabled={index === total - 1} testId="show-next" />
        <CtlButton icon={muted ? <SpeakerMute20Regular /> : <Speaker220Regular />} label={t('show.controls.mute')} pressed={muted} onClick={() => setMuted(!muted)} />
        <CtlButton icon={isFullscreen ? <FullScreenMinimize20Regular /> : <FullScreenMaximize20Regular />} label={t('show.controls.fullscreen')} pressed={isFullscreen} onClick={() => void toggleFullscreen()} />
        <CtlButton icon={<ClosedCaption20Regular />} label={t('show.controls.captions')} pressed={captionsOn} onClick={() => run('captions')} />
        <CtlButton icon={<Bot20Regular />} label={t('show.controls.narrator')} pressed={panel === 'narrator'} onClick={() => togglePanel('narrator')} testId="show-narrator-toggle" />
        <CtlButton icon={<TextBulletListLtr20Regular />} label={t('show.controls.outline')} pressed={panel === 'outline'} onClick={() => togglePanel('outline')} testId="show-outline-toggle" />
        <CtlButton icon={<Keyboard20Regular />} label={t('show.controls.shortcuts')} pressed={panel === 'help'} onClick={() => togglePanel('help')} testId="show-help-toggle" />
        {program.kind === 'short' && (
          rec.status === 'recording'
            ? <CtlButton buttonRef={recButtonRef} icon={<RecordStop20Regular />} label={t('show.record.stop')} onClick={stopRecording} testId="show-record-stop" />
            : <CtlButton buttonRef={recButtonRef} icon={<Record20Regular />} label={t('show.record.save')} onClick={openRecord} disabled={rec.status === 'requesting' || rec.status === 'saving'} testId="show-record" />
        )}
        <label className="show-intensity">
          <span>{t('show.intensity.label')}</span>
          <Select
            size="small"
            value={settings.intensity}
            onChange={(_, d) => settings.update({ intensity: d.value as Intensity })}
            data-testid="show-intensity"
          >
            {INTENSITIES.map((i) => <option key={i} value={i}>{t(`show.intensity.${i}` as MessageKey)}</option>)}
          </Select>
        </label>
        <span className="show-reactions" role="group" aria-label={t('show.react.label')}>
          {REACTIONS.map(({ id, Icon, label }) => (
            <button key={id} type="button" className="show-btn show-react" onClick={() => setReactions((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }))}>
              <Icon aria-hidden />
              <span>{t(label)}</span>
              <span className="show-react-count">{reactions[id] ?? 0}</span>
            </button>
          ))}
        </span>
        <CtlButton icon={<Dismiss20Regular />} label={t('show.controls.exit')} onClick={stop} testId="show-exit" />
      </div>

      {program.kind === 'short' && (
        <p className={`show-rec-status ${rec.status === 'recording' ? 'is-recording' : ''}`} role="status" data-testid="show-record-status">
          {rec.status === 'recording' && t('show.record.status.recording')}
          {rec.status === 'saving' && t('show.record.status.saving')}
          {rec.status === 'saved' && t('show.record.status.saved', { fileName: rec.fileName })}
        </p>
      )}

      {dialogOpen && (
        <div className="show-rec-backdrop">
          <div
            ref={recDialogRef}
            className="show-rec-dialog"
            role={rec.status === 'error' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby={`${recDialogId}-title`}
            aria-describedby={`${recDialogId}-desc`}
            data-testid="show-record-dialog"
            data-state={rec.status}
          >
            {rec.status === 'error' ? (
              <>
                <h2 id={`${recDialogId}-title`} className="show-rec-title">{t('show.record.error.title')}</h2>
                <div id={`${recDialogId}-desc`}>
                  <p data-testid="show-record-error" data-reason={rec.reason}>{t(`show.record.error.${rec.reason}` as MessageKey)}</p>
                  <p className="show-muted">{t('show.record.error.playback')}</p>
                </div>
                <div className="show-rec-actions">
                  <button type="button" className="show-btn show-btn-primary" onClick={closeRecordDialog} data-autofocus data-testid="show-record-close">{t('show.record.error.close')}</button>
                </div>
              </>
            ) : (
              <>
                <h2 id={`${recDialogId}-title`} className="show-rec-title">{t('show.record.dialog.title')}</h2>
                <ol id={`${recDialogId}-desc`} className="show-rec-steps">
                  <li>{t('show.record.dialog.step1')}</li>
                  <li>{t('show.record.dialog.step2')}</li>
                  <li>{t('show.record.dialog.step3', { seconds: Math.round(sequenceMs / 1000) })}</li>
                  <li>{t('show.record.dialog.step4', { fileName: plannedFile })}</li>
                </ol>
                <p className="show-muted">{t('show.record.dialog.privacy')}</p>
                {rec.status === 'requesting' && <p role="status">{t('show.record.requesting')}</p>}
                <div className="show-rec-actions">
                  <button type="button" className="show-btn show-btn-primary" onClick={() => void beginRecording()} disabled={rec.status === 'requesting'} data-autofocus data-testid="show-record-start">
                    <span className="show-btn-icon" aria-hidden><Record20Regular /></span>
                    <span>{t('show.record.dialog.start')}</span>
                  </button>
                  <button type="button" className="show-btn show-btn-outline" onClick={closeRecordDialog} disabled={rec.status === 'requesting'} data-testid="show-record-cancel">{t('show.record.dialog.cancel')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface CtlButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  testId?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

function CtlButton({ icon, label, onClick, pressed, disabled, testId, buttonRef }: CtlButtonProps) {
  return (
    <button ref={buttonRef} type="button" className="show-btn" onClick={onClick} aria-pressed={pressed} disabled={disabled} data-testid={testId}>
      <span className="show-btn-icon" aria-hidden>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/** FR-085: shortcut list (also shown on the /show screen). */
export function ShortcutList() {
  const { t } = useI18n();
  const keyLabel = (k: string) => (k === 'Space' ? t('show.key.space') : k === 'Esc' ? t('show.key.esc') : k);
  return (
    <dl className="show-shortcuts">
      {SHORTCUTS.map((s) => (
        <div key={s.action} className="show-shortcut">
          <dt>{s.keys.map((k) => <kbd key={k}>{keyLabel(k)}</kbd>)}</dt>
          <dd>{t(`show.shortcut.${s.action}` as MessageKey)}</dd>
        </div>
      ))}
    </dl>
  );
}
