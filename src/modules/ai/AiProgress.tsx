import { useEffect, useState } from 'react';
import { ProgressBar, Spinner } from '@fluentui/react-components';
import { CheckmarkCircle20Filled } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import './ai.css';

export type AiStage = 'confirm' | 'generate' | 'verify';
const STAGES: readonly AiStage[] = ['confirm', 'generate', 'verify'];

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Progress of one non-streaming AI call (Fluent 2 ProgressBar guidance): one determinate bar over the real stages that
 * never moves backwards, a stage list, and the elapsed time as a sign of life. The provider reports no partial
 * progress, so no remaining time is guessed; the automatic time limit is stated instead.
 */
export function AiProgress({ stage, startedAt, limitMs, testId = 'ai-progress' }: {
  stage: AiStage;
  /** When the request was sent (ms epoch); the elapsed time is shown from then. */
  startedAt?: number;
  limitMs?: number;
  testId?: string;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const index = STAGES.indexOf(stage);
  const elapsed = startedAt === undefined ? null : Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="ai-progress" data-testid={testId} data-stage={stage}>
      <p className="ai-progress-now" role="status">{t(`ai.progress.now.${stage}`)}</p>
      <ProgressBar value={index / STAGES.length} thickness="large" aria-label={t('ai.progress.label')} data-testid={`${testId}-bar`} />
      <p className="muted" data-testid={`${testId}-status`}>
        {t('ai.progress.status', { done: index, total: STAGES.length })}
        {elapsed !== null && <> {t('ai.progress.elapsed', { elapsed: clock(elapsed) })}</>}
      </p>
      <ol className="ai-progress-steps">
        {STAGES.map((s, i) => {
          const status = i < index ? 'done' : i === index ? 'running' : 'pending';
          return (
            <li key={s} data-step={s} data-status={status}>
              {status === 'done' ? <CheckmarkCircle20Filled className="ai-progress-ok" /> : status === 'running' ? <Spinner size="extra-tiny" /> : <span className="ai-progress-dot" aria-hidden />}
              <span>{t(`ai.progress.step.${s}`)}</span>
            </li>
          );
        })}
      </ol>
      {stage === 'generate' && limitMs !== undefined && <p className="muted">{t('ai.progress.limit', { minutes: Math.round(limitMs / 60_000) })}</p>}
    </div>
  );
}
