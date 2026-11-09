import { useMemo, useState } from 'react';
import { Badge, Button, Field, Radio, RadioGroup, Select, Spinner } from '@fluentui/react-components';
import { Play24Regular, ArrowClockwise24Regular, VideoClip24Regular, Sparkle24Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { useSettings } from '../../state/settings.ts';
import { PERSONA_VIEWS, personaLabel, type PersonaView } from '../../state/personas.ts';
import { useUseCases } from '../usecases/store.ts';
import { buildChapters, buildStory, CHAPTER_IDS, chapterPoints, chapterTitleKey, INTENSITIES, SHOW_PARAMS, type Intensity } from './model.ts';
import { generateStory, type GenerateResult } from './aiOutline.ts';
import { useShowRun, useShowSettings } from './store.ts';
import { ShortcutList } from './ShowPlayer.tsx';

const QUIZ = [1, 2, 3] as const;

export function ShowScreen() {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const useCases = useUseCases((s) => s.value);
  const start = useShowRun((s) => s.start);
  const { intensity, lastChapter, update } = useShowSettings();
  const chapters = useMemo(() => buildChapters(audience), [audience]);
  const lastIndex = CHAPTER_IDS.indexOf(lastChapter);

  return (
    <div className="screen screen-show">
      <PageHeader
        title={t('show.title')}
        subtitle={t('show.subtitle')}
        actions={(
          <>
            <Button appearance="primary" icon={<Play24Regular />} onClick={() => start({ kind: 'show' })} data-testid="show-start">{t('show.start')}</Button>
            {lastIndex > 0 && (
              <Button icon={<ArrowClockwise24Regular />} onClick={() => start({ kind: 'show', chapter: lastIndex })} data-testid="show-resume">
                {t('show.resume', { chapter: t(chapterTitleKey(lastChapter)) })}
              </Button>
            )}
            <Button icon={<VideoClip24Regular />} onClick={() => start({ kind: 'short' })} data-testid="show-short">{t('show.short.start')}</Button>
          </>
        )}
      />

      <Panel title={t('show.program.title')} rationale="show.program.why" testId="show-program">
        <ol className="show-program">
          {chapters.map((ch, i) => (
            <li key={ch.id}>
              <div className="show-program-head">
                <strong>{t(chapterTitleKey(ch.id))}</strong>
                {ch.empty && <Badge appearance="tint" color="warning">{t('show.program.empty')}</Badge>}
                <Button size="small" appearance="subtle" onClick={() => start({ kind: 'show', chapter: i })}>{t('show.program.startHere')}</Button>
              </div>
              <ul className="show-program-points">
                {chapterPoints(ch, lang).map((p) => <li key={p}>{p}</li>)}
              </ul>
            </li>
          ))}
        </ol>
        <p className="show-muted">{t('show.short.note', { seconds: SHOW_PARAMS.shortVideoMs / 1000 })}</p>
      </Panel>

      <Panel title={t('show.story.panel')} rationale="show.story.why" testId="show-story-panel">
        <p>{t('show.story.intro', { count: SHOW_PARAMS.storyTopSolutions })}</p>
        <ul className="show-persona-list">
          {PERSONA_VIEWS.map((p) => {
            const missing = buildStory(p, useCases, audience, lang).missing;
            return (
              <li key={p}>
                <Button appearance="primary" onClick={() => start({ kind: 'story', persona: p })} data-testid={`show-story-${p}`}>
                  {t('show.story.start', { persona: t(personaLabel(p)) })}
                </Button>
                <span className="show-muted">
                  {missing.length === 0 ? t('show.story.ready') : t('show.story.missingList', { items: missing.map((m) => t(`show.missingShort.${m}` as MessageKey)).join(lang === 'ja' ? '、' : ', ') })}
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <AiStoryPanel />

      <Panel title={t('show.intensity.title')} rationale="show.intensity.why">
        <RadioGroup
          value={intensity}
          onChange={(_, d) => update({ intensity: d.value as Intensity })}
          aria-label={t('show.intensity.title')}
          data-testid="show-intensity-radios"
        >
          {INTENSITIES.map((i) => (
            <Radio key={i} value={i} label={`${t(`show.intensity.${i}` as MessageKey)} — ${t(`show.intensityHelp.${i}` as MessageKey)}`} />
          ))}
        </RadioGroup>
        <p className="show-muted">{t('show.intensity.note')}</p>
      </Panel>

      <Panel title={t('show.shortcuts.title')}>
        <ShortcutList />
      </Panel>

      <QuizPanel />
    </div>
  );
}

/** FR-290: build a story with generative AI (always the labelled mock while C-03 is TBD). */
function AiStoryPanel() {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [persona, setPersona] = useState<PersonaView>('executive');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(GenerateResult & { lang: string }) | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    const r = await generateStory(lang, persona, audience);
    setResult({ ...r, lang });
    setBusy(false);
  };

  return (
    <Panel title={t('show.ai.title')} rationale="show.ai.why" testId="show-ai">
      <p>{t('show.ai.intro', { seconds: SHOW_PARAMS.aiTimeoutMs / 1000, tokens: SHOW_PARAMS.aiMaxOutputTokens })}</p>
      <div className="show-ai-form">
        <Field label={t('show.ai.persona')}>
          <Select value={persona} onChange={(_, d) => setPersona(d.value as PersonaView)}>
            {PERSONA_VIEWS.map((p) => <option key={p} value={p}>{t(personaLabel(p))}</option>)}
          </Select>
        </Field>
        <Button appearance="primary" icon={<Sparkle24Regular />} onClick={() => void run()} disabled={busy} data-testid="show-ai-generate">{t('show.ai.generate')}</Button>
      </div>
      {busy && <Spinner size="small" label={t('show.ai.busy')} />}
      {result && !result.ok && <p role="alert">{t(`show.ai.fail.${result.reason}` as MessageKey)}</p>}
      {result?.ok && (
        <div className="show-ai-result" data-testid="show-ai-result" aria-live="polite">
          <p>
            <Badge appearance="filled" color={result.res.mode === 'mock' ? 'warning' : 'success'} data-testid="show-ai-mode">
              {result.res.mode === 'mock' ? t('show.ai.mock') : t('show.ai.live')}
            </Badge>
            <span className="show-muted">{result.res.mode === 'mock' ? t('show.ai.mockNote') : ''}</span>
          </p>
          {result.res.blockedReasons.length > 0 && (
            <>
              <p>{t('show.ai.reasons')}</p>
              <ul data-testid="show-ai-reasons">
                {result.res.blockedReasons.map((r) => <li key={r}>{t(`show.ai.reason.${r}` as MessageKey)}</li>)}
              </ul>
            </>
          )}
          <pre className="show-ai-outline" lang={result.lang}>{result.res.text}</pre>
        </div>
      )}
    </Panel>
  );
}

/** FR-082 (MAY): a short AI-maturity quiz, kept local and never saved. */
function QuizPanel() {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const done = QUIZ.every((q) => answers[q] !== undefined);
  const score = QUIZ.reduce((a, q) => a + (answers[q] ?? 0), 0);
  const level = score <= 2 ? 'low' : score <= 4 ? 'mid' : 'high';
  return (
    <Panel title={t('show.quiz.title')} testId="show-quiz">
      {QUIZ.map((q) => (
        <Field key={q} label={t(`show.quiz.q.${q}` as MessageKey)}>
          <RadioGroup value={answers[q] === undefined ? '' : String(answers[q])} onChange={(_, d) => setAnswers((a) => ({ ...a, [q]: Number(d.value) }))}>
            {[0, 1, 2].map((v) => <Radio key={v} value={String(v)} label={t(`show.quiz.a.${v}` as MessageKey)} />)}
          </RadioGroup>
        </Field>
      ))}
      <p aria-live="polite">{done ? t(`show.quiz.level.${level}` as MessageKey, { score, max: QUIZ.length * 2 }) : t('show.quiz.pending')}</p>
    </Panel>
  );
}
