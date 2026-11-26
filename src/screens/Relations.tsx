import { Suspense, lazy, useCallback, useMemo } from 'react';
import { Button, Label, MessageBar, MessageBarBody, Select, Slider, Tab, TabList } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { PARAMS } from '../config/params.ts';
import { getEntity, loaded, neighborhoodDepths } from '../data/pack.ts';
import { allowedEdges, analyzeEntity, degrees, newsExclusion, type EvidenceKind } from '../data/relationAnalysis.ts';
import type { Entity, EntityKind } from '../data/schema.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor, replaceQuery, useRoute } from '../state/router.ts';
import { ChainDiagram } from '../charts/ChainDiagram.tsx';
import { ForceGraph } from '../charts/ForceGraph.tsx';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { isHidden, routeFor } from '../ui/cardSpecs.ts';
import { kindColor, kindIcon } from '../ui/icons.ts';
import { EntityEditorDialog } from '../ui/entry/EntityEditorDialog.tsx';
import { isEditableKind } from '../ui/entry/entitySpecs.ts';
import { usePackVersion } from '../state/packEdits.ts';

type View = 'chain' | 'graph' | 'table' | 'flow';
type Allow = (e: Entity) => boolean;
const VIEWS: View[] = ['chain', 'graph', 'table', 'flow'];
// Work flow and material flow are another view of the same data, so they live here and load on demand.
const FlowsView = lazy(() => import('./Flows.tsx').then((m) => ({ default: m.Flows })));
const DEFAULT_FOCUS = 'cust-sakura-motors';
/** Kinds that anchor the business problem; a generated pack rarely contains the sample customer. */
const FOCUS_KINDS: EntityKind[] = ['issue', 'customer', 'kpi', 'initiative'];
const EVIDENCE_KINDS: EvidenceKind[] = ['internal', 'm365', 'public'];
const GROUP_LIMIT = 6;

function defaultFocus(visible: Allow): string {
  const degree = degrees(allowedEdges(visible));
  const own = getEntity(DEFAULT_FOCUS);
  // The sample's curated customer stays the default only while it still has non-news connections.
  if (own && visible(own) && (degree.get(own.id) ?? 0) > 0) return DEFAULT_FOCUS;
  const candidates = loaded.pack.entities.filter((e) => visible(e) && e.kind !== 'source');
  for (const kind of FOCUS_KINDS) {
    const best = candidates.filter((e) => e.kind === kind).sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0];
    if (best) return best.id;
  }
  return candidates.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0]?.id ?? DEFAULT_FOCUS;
}
const LEGEND_KINDS: EntityKind[] = ['customer', 'deal', 'deliverable', 'invoice', 'product', 'person', 'site', 'issue', 'cause', 'solution', 'kpi', 'initiative', 'supplier', 'source'];

function RefList({ ids }: { ids: string[] }) {
  const { t } = useI18n();
  return (
    <ul className="selection-refs">
      {ids.slice(0, GROUP_LIMIT).map((id) => <li key={id}><EntityRef id={id} /></li>)}
      {ids.length > GROUP_LIMIT && <li className="muted">{t('relations.more', { count: ids.length - GROUP_LIMIT })}</li>}
    </ul>
  );
}

function SelectionPanel({ id, allow }: { id: string | null; allow: Allow }) {
  const { t } = useI18n();
  const e = id ? getEntity(id) : undefined;
  const a = useMemo(() => (e ? analyzeEntity(e.id, allow) : null), [e, allow]);
  if (!e || !a) return <p className="muted">{t('relations.noSelection')}</p>;
  const route = routeFor(e);
  const related = a.groups.reduce((n, g) => n + g.ids.length, 0) + a.evidence.length + a.citedBy.length;
  return (
    <div className="selection-panel" data-testid="selection-panel">
      <p className="selection-title"><EntityRef id={e.id} image imageSize={40} /></p>
      <p className="muted">{t('relations.relatedCount', { count: related })}</p>
      {a.degree > 0 && <p className="muted" data-testid="selection-rank">{t('relations.rank', { rank: a.rank, total: a.ranked })}</p>}
      {route && (
        <Button as="a" href={hrefFor(route)} appearance="primary" icon={<Open16Regular />}>{t('relations.openDetail')}</Button>
      )}

      <section className="selection-section" data-testid="selection-links">
        <h3>{t('relations.analysis.links')}</h3>
        {a.groups.length === 0
          ? <p className="muted">{t('relations.analysis.noLinks')}</p>
          : a.groups.map((g) => (
            <div key={`${g.direction}:${g.type}`}>
              <p className="selection-group">{t(g.direction === 'out' ? 'relations.dir.out' : 'relations.dir.in', { relation: t(`relation.${g.type}`), count: g.ids.length })}</p>
              <RefList ids={g.ids} />
            </div>
          ))}
      </section>

      <section className="selection-section" data-testid="selection-evidence">
        <h3>{t('relations.analysis.evidence')}</h3>
        {e.kind === 'source' ? (
          <>
            <p className="muted">{t('relations.analysis.citedBy', { count: a.citedBy.length })}</p>
            <RefList ids={a.citedBy} />
          </>
        ) : a.evidence.length === 0 ? (
          <p className="muted">{t('relations.analysis.noEvidence')}</p>
        ) : (
          EVIDENCE_KINDS.map((k) => {
            const ids = a.evidence.filter((x) => x.kind === k).map((x) => x.id);
            return ids.length === 0 ? null : (
              <div key={k}>
                <p className="selection-group">{t(`relations.evidence.${k}`, { count: ids.length })}</p>
                <RefList ids={ids} />
              </div>
            );
          })
        )}
      </section>

      <section className="selection-section" data-testid="selection-gaps">
        <h3>{t('relations.analysis.gaps')}</h3>
        {a.gaps.length === 0
          ? <p className="muted">{t('relations.analysis.noGaps')}</p>
          : <ul>{a.gaps.map((g) => <li key={g} data-gap={g}>{t(`relations.gap.${g}`)}</li>)}</ul>}
      </section>
    </div>
  );
}

export function Relations() {
  const { t, tx } = useI18n();
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const packVersion = usePackVersion((s) => s.version);
  const edit = getEntity(route.query.get('edit') ?? '');
  const editingEntity = edit && isEditableKind(edit.kind) && !isHidden(edit, audience) ? edit : null;
  const editingKind = editingEntity && isEditableKind(editingEntity.kind) ? editingEntity.kind : null;
  const create = route.query.get('create');
  const creatingKind = create && isEditableKind(create) ? create : null;
  const view = (VIEWS as string[]).includes(route.query.get('view') ?? '') ? (route.query.get('view') as View) : 'chain';
  const sel = route.query.get('sel');
  const focusParam = route.query.get('focus') ?? '';
  // News-feed headlines, and items that rest on them alone, are left out of every view on this screen.
  const allow = useCallback<Allow>((e) => !isHidden(e, audience), [audience]);
  const excluded = useMemo(() => newsExclusion((e) => audience === 'internal' || e.classification !== 'internal'), [audience]);
  const focusEntity = getEntity(focusParam);
  const fallback = useMemo(() => defaultFocus(allow), [allow]);
  const focus = focusEntity && allow(focusEntity) ? focusParam : fallback;
  const hops = Math.min(PARAMS.graphHopsMax, Math.max(PARAMS.graphHopsMin, Number(route.query.get('hops') ?? 2) || 2));

  const visibleEntities = useMemo(() => loaded.pack.entities.filter(allow), [allow, packVersion]);
  const depthOf = useMemo(() => neighborhoodDepths(focus, hops, allow), [focus, hops, allow, packVersion]);
  const egoEntities = useMemo(() => visibleEntities.filter((e) => depthOf.has(e.id)), [visibleEntities, depthOf]);
  const egoEdges = useMemo(() => loaded.edges.filter((e) => depthOf.has(e.source) && depthOf.has(e.target)), [depthOf]);
  const tableEdges = useMemo(() => allowedEdges(allow), [allow, packVersion]);

  return (
    <div className="screen screen-relations">
      {(editingKind || creatingKind) && <EntityEditorDialog kind={editingKind ?? creatingKind} id={editingEntity?.id} focusField={route.query.get('field')} onClose={() => replaceQuery({ edit: undefined, field: undefined, create: undefined })} />}
      <PageHeader title={t('relations.title')} subtitle={t('relations.subtitle')} />
      {excluded.headlines + excluded.derived > 0 && (
        <MessageBar intent="info" data-testid="news-excluded">
          <MessageBarBody>{t('relations.newsExcluded', { headlines: excluded.headlines, derived: excluded.derived })}</MessageBarBody>
        </MessageBar>
      )}
      <TabList selectedValue={view} onTabSelect={(_, d) => replaceQuery({ view: String(d.value), section: undefined })} aria-label={t('relations.viewLabel')}>
        <Tab value="chain">{t('relations.view.chain')}</Tab>
        <Tab value="graph">{t('relations.view.graph')}</Tab>
        <Tab value="table">{t('relations.view.table')}</Tab>
        <Tab value="flow">{t('nav.flows')}</Tab>
      </TabList>

      {view === 'flow' && (
        <Suspense fallback={null}><FlowsView embedded /></Suspense>
      )}

      {view === 'chain' && (
        <div className="split">
          <Panel title={t('relations.chainTitle')} rationale="visual.chain" testId="chain-panel">
            <ChainDiagram selected={sel} onSelect={(id) => replaceQuery({ sel: sel === id ? undefined : id })} />
          </Panel>
          <Panel title={t('relations.selection')}>
            <SelectionPanel id={sel} allow={allow} />
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
            <SelectionPanel id={focus} allow={allow} />
          </Panel>
        </div>
      )}

      {view === 'table' && (
        <Panel title={t('relations.tableTitle')} rationale="visual.relationTable" testId="relation-table" id="relation-table">
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
