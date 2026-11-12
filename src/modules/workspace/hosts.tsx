import { useMemo, type ComponentType } from 'react';
import type { FluentIcon } from '@fluentui/react-icons';
import {
  TextBulletListSquare16Regular, Grid16Regular, TextNumberListLtr16Regular, Gauge16Regular, Flowchart16Regular,
  GanttChart16Regular, Map16Regular, ArrowFlowDiagonalUpRight16Regular,
} from '@fluentui/react-icons';
import { entitiesOf } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { rankIssues } from '../../domain/priority.ts';
import { DEFAULT_WEIGHTS, executiveSummary } from '../../domain/summary.ts';
import { KpiGauge } from '../../charts/KpiGauge.tsx';
import { PriorityMatrix } from '../../charts/PriorityMatrix.tsx';
import { ChainDiagram } from '../../charts/ChainDiagram.tsx';
import { Plan } from '../../screens/Plan.tsx';
import { MapScreen } from '../../screens/MapScreen.tsx';
import { Flows } from '../../screens/Flows.tsx';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { isHidden } from '../../ui/cardSpecs.ts';
import type { ComponentId } from './personas.ts';
import { useHostState } from './store.ts';
import { usePackVersion } from '../../state/packEdits.ts';
import { EntryBar } from '../../ui/entry/EntryBar.tsx';

function useRanked() {
  const audience = useSettings((s) => s.audience);
  const version = usePackVersion((s) => s.version);
  // version: re-read the live pack after an entry is saved.
  return useMemo(() => rankIssues(entitiesOf('issue').filter((i) => !isHidden(i, audience)), DEFAULT_WEIGHTS), [audience, version]);
}

function SummaryHost() {
  const { lang, t } = useI18n();
  const audience = useSettings((s) => s.audience);
  const version = usePackVersion((s) => s.version);
  const summary = useMemo(() => executiveSummary(lang, audience), [lang, audience, version]);
  return (
    <>
      <EntryBar kinds={['issue', 'kpi', 'solution']} testId="entry-bar-summary" />
      <p className="muted entry-note">{t('entry.summaryNote')}</p>
      <ol className="summary-list">
        {summary.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    </>
  );
}

function MatrixHost() {
  return (
    <>
      <EntryBar kinds={['issue']} testId="entry-bar-matrix" />
      <PriorityMatrix ranked={useRanked()} />
    </>
  );
}

function RankingHost() {
  const { t } = useI18n();
  const ranked = useRanked();
  return (
    <>
      <EntryBar kinds={['issue']} testId="entry-bar-ranking" />
      <ol className="ranking" aria-label={t('ws.comp.ranking')}>
        {ranked.map((r) => (
          <li key={r.issue.id} className="ranking-row" data-rank={r.rank}>
            <span className="ranking-rank" aria-hidden>{r.rank}</span>
            <EntityRef id={r.issue.id} />
            <span className="ranking-score">
              <span className="ranking-bar" style={{ width: `${r.score}%` }} aria-hidden />
              <span>{t('priority.score', { score: r.score })}</span>
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function KpiHost() {
  const audience = useSettings((s) => s.audience);
  usePackVersion((s) => s.version);
  const kpis = entitiesOf('kpi').filter((k) => !isHidden(k, audience));
  return (
    <>
      <EntryBar kinds={['kpi']} testId="entry-bar-kpi" />
      <div className="kpi-grid">
        {kpis.map((k) => <KpiGauge key={k.id} kpi={k} />)}
      </div>
    </>
  );
}

function ChainHost() {
  const { chainSel, setChainSel } = useHostState();
  return (
    <>
      <EntryBar kinds={['customer', 'deal', 'deliverable', 'invoice']} selectedId={chainSel} testId="entry-bar-chain" />
      <ChainDiagram selected={chainSel} onSelect={(id) => setChainSel(chainSel === id ? null : id)} />
    </>
  );
}

export interface HostedComponent {
  label: MessageKey;
  Icon: FluentIcon;
  /** Colour of the drag handle (FR-183); decorative only, never used for text. */
  accent: string;
  View: ComponentType;
}

/** Existing app views reused as workspace components; the data views carry an entry bar to add and edit pack data. */
export const COMPONENTS: Record<ComponentId, HostedComponent> = {
  summary: { label: 'ws.comp.summary', Icon: TextBulletListSquare16Regular, accent: '#4F9CF9', View: SummaryHost },
  matrix: { label: 'ws.comp.matrix', Icon: Grid16Regular, accent: '#B57BFF', View: MatrixHost },
  ranking: { label: 'ws.comp.ranking', Icon: TextNumberListLtr16Regular, accent: '#F2A93B', View: RankingHost },
  kpi: { label: 'ws.comp.kpi', Icon: Gauge16Regular, accent: '#4CC38A', View: KpiHost },
  chain: { label: 'ws.comp.chain', Icon: Flowchart16Regular, accent: '#3FC1C9', View: ChainHost },
  plan: { label: 'ws.comp.plan', Icon: GanttChart16Regular, accent: '#F06A8A', View: Plan },
  map: { label: 'ws.comp.map', Icon: Map16Regular, accent: '#8BC34A', View: MapScreen },
  flows: { label: 'ws.comp.flows', Icon: ArrowFlowDiagonalUpRight16Regular, accent: '#FF8A65', View: Flows },
};
