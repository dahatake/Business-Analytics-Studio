import { useEffect, useState } from 'react';
import { ProgressBar, Spinner } from '@fluentui/react-components';
import { CheckmarkCircle20Filled } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import './ai.css';

export type AiStage = 'confirm' | 'generate' | 'verify';
export type AiActivity = 'generate' | 'workiq' | 'decision' | 'fill' | 'fields' | 'tasks';
const STAGES: readonly AiStage[] = ['confirm', 'generate', 'verify'];

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Progress of one non-streaming AI call (Fluent 2 ProgressBar guidance): one determinate bar over the real stages that
 * never moves backwards, a stage list, and the elapsed time as a sign of life. The provider reports no partial
 * progress, so no remaining time is guessed; the automatic time limit is stated instead.
 */
export function AiProgress({ stage, activity = 'generate', startedAt, elapsedKind, limitMs, detail, result = 'save', testId = 'ai-progress' }: {
  stage: AiStage;
  activity?: AiActivity;
  /** When the request was sent (ms epoch); the elapsed time is shown from then. */
  startedAt?: number;
  elapsedKind?: 'send' | 'start' | 'stage';
  limitMs?: number;
  detail?: string;
  result?: 'save' | 'process';
  testId?: string;
}) {
  const { t } = useI18n();
  const [mountedAt] = useState(() => Date.now());
  const start = startedAt ?? mountedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [start]);
  const index = STAGES.indexOf(stage);
  const elapsed = Math.max(0, Math.floor((now - start) / 1000));
  const timeKey = elapsedKind ?? (startedAt === undefined ? 'start' : 'send');
  const currentLabel = stage === 'generate' && activity !== 'generate'
    ? t(`ai.progress.activity.${activity}`)
    : stage === 'verify' && result === 'process' ? t('ai.progress.now.process') : t(`ai.progress.now.${stage}`);
  return (
    <div className="ai-progress" data-testid={testId} data-stage={stage} data-activity={activity}>
      <p className="ai-progress-now" role="status">{currentLabel}</p>
      {detail && <p className="muted" data-testid={`${testId}-detail`}>{detail}</p>}
      <ProgressBar value={index / STAGES.length} thickness="large" aria-label={t('ai.progress.label')}
        aria-valuetext={t('ai.progress.status', { done: index, total: STAGES.length })} data-testid={`${testId}-bar`} />
      <p className="muted" data-testid={`${testId}-status`}>
        {t('ai.progress.status', { done: index, total: STAGES.length })}
        {' '}{t(`ai.progress.time.${timeKey}`, { elapsed: clock(elapsed) })}
      </p>
      <ol className="ai-progress-steps">
        {STAGES.map((s, i) => {
          const status = i < index ? 'done' : i === index ? 'running' : 'pending';
          const label = s === 'generate' && activity !== 'generate'
            ? t('ai.progress.step.work')
            : s === 'verify' && result === 'process' ? t('ai.progress.step.process') : t(`ai.progress.step.${s}`);
          return (
            <li key={s} data-step={s} data-status={status}>
              {status === 'done' ? <CheckmarkCircle20Filled className="ai-progress-ok" aria-hidden /> : status === 'running' ? <Spinner size="extra-tiny" aria-hidden /> : <span className="ai-progress-dot" aria-hidden />}
              <span>{label} <span className="visually-hidden">{t(`ai.progress.stepStatus.${status}`)}</span></span>
            </li>
          );
        })}
      </ol>
      {stage === 'generate' && <p className="muted">{limitMs !== undefined
        ? t('ai.progress.limit', { minutes: limitMs / 60_000 })
        : t('ai.progress.unknown')}</p>}
    </div>
  );
}
