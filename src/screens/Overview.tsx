import { useMemo, useRef, useState } from 'react';
import { Badge, Label, Slider } from '@fluentui/react-components';
import { PARAMS } from '../config/params.ts';
import { useReducedMotion } from '../state/motion.ts';
import { useFlip } from '../ui/useFlip.ts';
import { entitiesOf, loaded } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { rankIssues } from '../domain/priority.ts';
import { DEFAULT_WEIGHTS, executiveSummary } from '../domain/summary.ts';
import { KpiGauge } from '../charts/KpiGauge.tsx';
import { PriorityMatrix } from '../charts/PriorityMatrix.tsx';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { isHidden } from '../ui/cardSpecs.ts';

const ROW_KEY = 'ranking';

export function Overview() {
  const { t, tx, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const issues = useMemo(() => entitiesOf('issue').filter((i) => !isHidden(i, audience)), [audience]);
  const ranked = useMemo(() => rankIssues(issues, weights), [issues, weights]);
  useFlip(listRef, reduced, [ranked.map((r) => r.issue.id).join(ROW_KEY)]);
  const summary = useMemo(() => executiveSummary(lang, audience, weights), [lang, audience, weights]);
  const kpis = entitiesOf('kpi').filter((k) => !isHidden(k, audience));

  return (
    <div className="screen screen-overview">
      <PageHeader
        title={t('overview.title')}
        subtitle={t('overview.subtitle', { company: tx(loaded.pack.company.name), date: fmt.date(PARAMS.asOfDate) })}
      />
      <Panel title={t('overview.summary')} rationale="visual.summary" className="span-full" testId="executive-summary">
        <ol className="summary-list">
          {summary.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        <Badge appearance="outline" color="informative">{t('overview.summaryNote')}</Badge>
      </Panel>
      <Panel title={t('overview.kpis')} rationale="visual.kpi" className="span-full" testId="kpi-panel">
        <div className="kpi-grid">
          {kpis.map((k) => <KpiGauge key={k.id} kpi={k} />)}
        </div>
      </Panel>
      <Panel title={t('overview.priority')} rationale="visual.priority" testId="priority-panel">
        <PriorityMatrix ranked={ranked} />
        <div className="weights">
          <div className="weight">
            <Label htmlFor="w-impact">{t('priority.weightImpact', { value: weights.impact })}</Label>
            <Slider id="w-impact" min={0} max={100} step={5} value={weights.impact} onChange={(_, d) => setWeights((w) => ({ ...w, impact: d.value }))} />
          </div>
          <div className="weight">
            <Label htmlFor="w-feas">{t('priority.weightFeasibility', { value: weights.feasibility })}</Label>
            <Slider id="w-feas" min={0} max={100} step={5} value={weights.feasibility} onChange={(_, d) => setWeights((w) => ({ ...w, feasibility: d.value }))} />
          </div>
        </div>
      </Panel>
      <Panel title={t('overview.ranking')} rationale="visual.ranking" testId="ranking-panel">
        <ol className="ranking" ref={listRef} aria-label={t('overview.ranking')}>
          {ranked.map((r) => (
            <li key={r.issue.id} className="ranking-row" data-flip-key={r.issue.id} data-rank={r.rank}>
              <span className="ranking-rank" aria-hidden>{r.rank}</span>
              <EntityRef id={r.issue.id} />
              <span className="ranking-score">
                <span className="ranking-bar" style={{ width: `${r.score}%` }} aria-hidden />
                <span>{t('priority.score', { score: r.score })}</span>
              </span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
