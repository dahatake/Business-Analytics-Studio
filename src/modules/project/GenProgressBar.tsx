import type { CSSProperties } from 'react';
import { Spinner } from '@fluentui/react-components';
import { CheckmarkCircle16Filled, DismissCircle16Filled } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import type { CollectSource, StepId, StepStatus } from './packGenerate.ts';

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** Work IQ answers have taken minutes (3〜11 in logs/workiq-bench); after this the wait is explained. */
const WORKIQ_HINT_AFTER_SEC = 20;

/**
 * FR-311: the generation's progress as one bar made of the steps. Each segment's width is the step's share of a run
 * (stepSpans, from measured runs), so the filled length is the reported ratio; the running segment moves even while one
 * long call gives no intermediate ratio, and the time in the current step says that it is still working.
 */
export function GenProgressBar({ order, steps, spans, ratio, current, stepElapsed }: {
  order: StepId[];
  steps: Record<StepId, StepStatus>;
  spans: Record<StepId, [number, number]>;
  ratio: number;
  current: StepId | null;
  stepElapsed: number;
}) {
  const { t, fmt } = useI18n();
  const percent = fmt.percent(ratio);
  const label = current ? t(`proj.gen.stepShort.${current}`) : '';
  return (
    <div className="gen-bar-wrap">
      <div className="gen-bar-head" aria-hidden>
        <span className="gen-bar-percent" data-testid="gen-bar-percent">{percent}</span>
        {current && <span className="gen-bar-now">{label}</span>}
        {current && steps[current] === 'running' && <span className="gen-bar-time" data-testid="gen-step-elapsed">{t('proj.gen.stepElapsed', { elapsed: clock(stepElapsed) })}</span>}
      </div>
      <div
        className="gen-bar"
        role="progressbar"
        aria-label={t('proj.gen.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={current ? t('proj.gen.barValue', { percent, step: label }) : percent}
        data-testid="gen-progress-bar"
      >
        {order.map((s) => {
          const [a, b] = spans[s];
          const status = steps[s];
          const fill = status === 'done' || status === 'skipped' ? 1 : status === 'pending' ? 0 : Math.min(1, Math.max(0, (ratio - a) / (b - a || 1)));
          return (
            <span key={s} className="gen-seg" data-step={s} data-status={status} style={{ flexGrow: b - a } as CSSProperties}>
              <span className="gen-seg-fill" style={{ width: `${fill * 100}%` }} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** The collect step's reads, each with its own state, so a long Work IQ wait is not mistaken for a stall. */
export function CollectSources({ sources, waitingSec }: { sources: Partial<Record<CollectSource, StepStatus>>; waitingSec: number }) {
  const { t } = useI18n();
  const keys = (['site', 'news', 'workiq'] as CollectSource[]).filter((k) => sources[k]);
  if (!keys.length) return null;
  return (
    <div className="gen-sources">
      <ul className="gen-source-list" data-testid="gen-sources">
        {keys.map((k) => {
          const s = sources[k]!;
          return (
            <li key={k} className="gen-source" data-source={k} data-status={s}>
              {s === 'done' ? <CheckmarkCircle16Filled className="gen-ok" /> : s === 'failed' ? <DismissCircle16Filled className="gen-fail" /> : <Spinner size="extra-tiny" aria-hidden />}
              <span>{t(`proj.gen.src.${k}`)}</span>
              <span className="visually-hidden">{t(`proj.gen.srcState.${s === 'done' || s === 'failed' ? s : 'running'}`)}</span>
            </li>
          );
        })}
      </ul>
      {sources.workiq === 'running' && waitingSec >= WORKIQ_HINT_AFTER_SEC && <p className="muted gen-wait" data-testid="gen-wait-workiq">{t('proj.gen.waitWorkIq')}</p>}
    </div>
  );
}
