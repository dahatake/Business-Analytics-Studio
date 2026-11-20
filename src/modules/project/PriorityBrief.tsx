import { useMemo } from 'react';
import { Badge } from '@fluentui/react-components';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import type { CheckContext } from './deliverables.ts';
import { priorityBrief, type EmphasisTone } from './priorityBrief.ts';
import './advice.css';

const TONE_COLOR: Record<EmphasisTone, 'danger' | 'warning' | 'informative'> = { focus: 'danger', caution: 'warning', info: 'informative' };

/** FR-358: executive summary of prioritisation aids for the step, from the project's data and a fixed list of sources (no AI, no web). */
export function PriorityBriefPanel({ step, ctx }: { step: ImprovementStep; ctx: CheckContext }) {
  const { t } = useI18n();
  const brief = useMemo(() => priorityBrief(step, ctx), [step, ctx]);
  const key = (suffix: string) => `proj.prio.${suffix}` as MessageKey;
  return (
    <Panel title={t('proj.prio.title')} testId="step-priority" className="span-full">
      <p className="muted">{t('proj.prio.lead')}</p>
      <section className="prio-block" aria-labelledby={`prio-sum-${step}`}>
        <h4 id={`prio-sum-${step}`} className="prio-label">{t('proj.prio.summaryLabel')}</h4>
        <p className="prio-summary" data-testid="step-priority-summary"><strong>{t(key(`summary.${step}`), brief.vars)}</strong></p>
      </section>
      <section className="prio-block" aria-labelledby={`prio-emph-${step}`}>
        <h4 id={`prio-emph-${step}`} className="prio-label">{t('proj.prio.emphasisLabel')}</h4>
        <ul className="step-advice-list">
          {brief.emphasis.map((e) => (
            <li key={e.id} className="step-advice-item" data-testid={`step-priority-emph-${e.id}`} data-tone={e.tone}>
              <Badge size="small" appearance="tint" color={TONE_COLOR[e.tone]}>{t(key(`tone.${e.tone}`))}</Badge>
              <p className="step-advice-text">{t(key(`emph.${e.id}`), e.vars)}</p>
            </li>
          ))}
        </ul>
      </section>
      {brief.candidates.length > 0 && (
        <section className="prio-block" aria-labelledby={`prio-cand-${step}`}>
          <h4 id={`prio-cand-${step}`} className="prio-label">{t('proj.prio.candidatesLabel')}</h4>
          <ol className="prio-candidates" data-testid="step-priority-candidates">
            {brief.candidates.map((c) => (
              <li key={c.id} data-quadrant={c.quadrant}>
                <EntityRef id={c.id} />
                <Badge size="small" appearance="outline">{t(key(`quadrant.${c.quadrant}`))}</Badge>
                <span className="muted">{t('proj.prio.candidate', { impact: c.impact, feasibility: c.feasibility, score: c.score })}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="prio-block" aria-labelledby={`prio-crit-${step}`}>
        <h4 id={`prio-crit-${step}`} className="prio-label">{t('proj.prio.critiqueLabel')}</h4>
        <p data-testid="step-priority-critique">{t(key(`critique.${step}`))}</p>
      </section>
      <section className="prio-block" aria-labelledby={`prio-meth-${step}`}>
        <h4 id={`prio-meth-${step}`} className="prio-label">{t('proj.prio.methodsLabel')}</h4>
        <ul className="prio-methods" data-testid="step-priority-methods">
          {brief.methods.map((m) => (
            <li key={m} data-method={m}>
              <details>
                <summary>{t(key(`method.${m}.name`))}</summary>
                <p><strong>{t('proj.prio.use')}</strong>{': '}{t(key(`method.${m}.use`))}</p>
                <p><strong>{t('proj.prio.limit')}</strong>{': '}{t(key(`method.${m}.limit`))}</p>
              </details>
            </li>
          ))}
        </ul>
      </section>
      <section className="prio-block" aria-labelledby={`prio-src-${step}`}>
        <h4 id={`prio-src-${step}`} className="prio-label">{t('proj.prio.sourcesLabel')}</h4>
        <ul className="prio-sources" data-testid="step-priority-sources">
          {brief.sources.map((s) => (
            <li key={s.id} data-source={s.id}>
              <Badge size="small" appearance="outline">{t(key(`kind.${s.kind}`))}</Badge>
              {' '}
              {s.url
                ? <a href={s.url} target="_blank" rel="noopener noreferrer" lang="en" title={t('proj.prio.external')}>{s.cite}</a>
                : <span lang="en">{s.cite}</span>}
            </li>
          ))}
        </ul>
      </section>
    </Panel>
  );
}
