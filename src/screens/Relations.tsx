import { useMemo } from 'react';
import { Button, Label, Select, Slider, Tab, TabList } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { PARAMS } from '../config/params.ts';
import { getEntity, loaded, neighborhoodDepths, neighbors } from '../data/pack.ts';
import type { EntityKind } from '../data/schema.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor, replaceQuery, useRoute } from '../state/router.ts';
import { ChainDiagram } from '../charts/ChainDiagram.tsx';
import { ForceGraph } from '../charts/ForceGraph.tsx';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { isHidden, routeFor } from '../ui/cardSpecs.ts';
import { kindColor, kindIcon } from '../ui/icons.ts';

type View = 'chain' | 'graph' | 'table';
const VIEWS: View[] = ['chain', 'graph', 'table'];
const DEFAULT_FOCUS = 'cust-sakura-motors';
const LEGEND_KINDS: EntityKind[] = ['customer', 'deal', 'deliverable', 'invoice', 'product', 'person', 'site', 'issue', 'cause', 'solution', 'kpi', 'initiative', 'supplier', 'source'];

function SelectionPanel({ id }: { id: string | null }) {
  const { t } = useI18n();
  const audience = useSettings((s) => s.audience);
  const e = id ? getEntity(id) : undefined;
  if (!e || isHidden(e, audience)) return <p className="muted">{t('relations.noSelection')}</p>;
  const route = routeFor(e);
  const related = neighbors(e.id).filter((n) => !isHidden(n.entity, audience));
  return (
    <div className="selection-panel" data-testid="selection-panel">
      <p className="selection-title"><EntityRef id={e.id} image imageSize={40} /></p>
      <p className="muted">{t('relations.relatedCount', { count: related.length })}</p>
      {route && (
        <Button as="a" href={hrefFor(route)} appearance="primary" icon={<Open16Regular />}>{t('relations.openDetail')}</Button>
      )}
    </div>
  );
}

export function Relations() {
  const { t, tx } = useI18n();
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const view = (VIEWS as string[]).includes(route.query.get('view') ?? '') ? (route.query.get('view') as View) : 'chain';
  const sel = route.query.get('sel');
  const focusParam = route.query.get('focus') ?? DEFAULT_FOCUS;
  const focusEntity = getEntity(focusParam);
  const focus = focusEntity && !isHidden(focusEntity, audience) ? focusParam : DEFAULT_FOCUS;
  const hops = Math.min(PARAMS.graphHopsMax, Math.max(PARAMS.graphHopsMin, Number(route.query.get('hops') ?? 2) || 2));

  const visibleEntities = useMemo(() => loaded.pack.entities.filter((e) => !isHidden(e, audience)), [audience]);
  const depthOf = useMemo(() => neighborhoodDepths(focus, hops, (e) => !isHidden(e, audience)), [focus, hops, audience]);
  const egoEntities = useMemo(() => visibleEntities.filter((e) => depthOf.has(e.id)), [visibleEntities, depthOf]);
  const egoEdges = useMemo(() => loaded.edges.filter((e) => depthOf.has(e.source) && depthOf.has(e.target)), [depthOf]);
  const tableEdges = useMemo(() => loaded.edges.filter((e) => {
    const s = getEntity(e.source), tg = getEntity(e.target);
    return s && tg && !isHidden(s, audience) && !isHidden(tg, audience);
  }), [audience]);

  return (
    <div className="screen screen-relations">
      <PageHeader title={t('relations.title')} subtitle={t('relations.subtitle')} />
      <TabList selectedValue={view} onTabSelect={(_, d) => replaceQuery({ view: String(d.value) })} aria-label={t('relations.viewLabel')}>
        <Tab value="chain">{t('relations.view.chain')}</Tab>
        <Tab value="graph">{t('relations.view.graph')}</Tab>
        <Tab value="table">{t('relations.view.table')}</Tab>
      </TabList>

      {view === 'chain' && (
        <div className="split">
          <Panel title={t('relations.chainTitle')} rationale="visual.chain" testId="chain-panel">
            <ChainDiagram selected={sel} onSelect={(id) => replaceQuery({ sel: sel === id ? undefined : id })} />
          </Panel>
          <Panel title={t('relations.selection')}>
            <SelectionPanel id={sel} />
          </Panel>
        </div>
      )}

      {view === 'graph' && (
        <div className="split">
          <Panel title={t('relations.graphTitle')} rationale="visual.graph" testId="graph-panel">
            <div className="graph-controls">
              <div className="control">
                <Label htmlFor="focus-select">{t('relations.focus')}</Label>
                <Select id="focus-select" value={focus} onChange={(_, d) => replaceQuery({ focus: d.value })}>
                  {visibleEntities.map((e) => <option key={e.id} value={e.id}>{`${t(`kind.${e.kind}`)} · ${tx(e.name)}`}</option>)}
                </Select>
              </div>
              <div className="control">
                <Label htmlFor="hops">{t('relations.hops', { hops })}</Label>
                <Slider id="hops" min={PARAMS.graphHopsMin} max={PARAMS.graphHopsMax} step={1} value={hops} onChange={(_, d) => replaceQuery({ hops: String(d.value) })} />
              </div>
            </div>
            <ForceGraph entities={egoEntities} edges={egoEdges} focus={focus} depthOf={depthOf} onSelect={(id) => replaceQuery({ focus: id })} />
            <ul className="legend" aria-label={t('relations.legend')}>
              {LEGEND_KINDS.map((k) => {
                const Icon = kindIcon[k];
                return <li key={k}><span className="legend-swatch" style={{ background: kindColor[k] }} aria-hidden /><Icon aria-hidden /> {t(`kind.${k}`)}</li>;
              })}
            </ul>
          </Panel>
          <Panel title={t('relations.selection')}>
            <SelectionPanel id={focus} />
          </Panel>
        </div>
      )}

      {view === 'table' && (
        <Panel title={t('relations.tableTitle')} rationale="visual.relationTable" testId="relation-table">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th scope="col">{t('relations.col.from')}</th><th scope="col">{t('relations.col.relation')}</th><th scope="col">{t('relations.col.to')}</th></tr>
              </thead>
              <tbody>
                {tableEdges.map((e) => (
                  <tr key={`${e.source}-${e.type}-${e.target}`}>
                    <td><EntityRef id={e.source} /></td>
                    <td>{t(`relation.${e.type}`)}</td>
                    <td><EntityRef id={e.target} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

