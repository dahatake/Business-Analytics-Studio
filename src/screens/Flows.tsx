import { useEffect, useMemo, useRef, useState } from 'react';
import { Tab, TabList } from '@fluentui/react-components';
import * as d3 from 'd3';
import { sankey, sankeyLinkHorizontal, sankeyJustify, type SankeyNode, type SankeyLink } from 'd3-sankey';
import { getEntity, loaded, regionName } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion, motionMs } from '../state/motion.ts';
import { attachCardTrigger } from '../ui/cardController.ts';
import { kindColor } from '../ui/icons.ts';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { cardController } from '../ui/cardController.ts';
import { hrefFor, navigate, replaceQuery, useRoute } from '../state/router.ts';
import { WorkflowExtension } from '../data/extensionSchemas.ts';
import { loc } from '../state/text.ts';
import { ContextualScene } from '../modules/threed/ContextualScene.tsx';
import { WorkflowFields, WorkflowMap, WorkflowSources } from './WorkflowMap.tsx';

interface N { id: string; label: string; color: string; isEntity: boolean }
interface L { source: string; target: string; value: number }

const W = 960, H = 520;

/** The work and material flow body; `embedded` drops the page header when shown as a tab of the relations screen. */
export function Flows({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, tx, fmt } = useI18n();
  const route = useRoute();
  const showingArchitecture = route.query.get('section') === 'architecture';
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);

  const graph = useMemo(() => {
    const ids = [...new Set(loaded.pack.flows.flatMap((f) => [f.source, f.target]))];
    const nodes: N[] = ids.map((id) => {
      const e = getEntity(id);
      if (e) return { id, label: tx(e.name), color: kindColor[e.kind], isEntity: true };
      const r = regionName(id);
      return { id, label: r ? tx(r) : id, color: '#C9D1D9', isEntity: false };
    });
    const links: L[] = loaded.pack.flows.map((f) => ({ source: f.source, target: f.target, value: f.valueT }));
    return { nodes, links };
  }, [tx]);

  useEffect(() => {
    // A pack without flows (e.g. imported or generated from customer material) has nothing to lay out.
    if (showingArchitecture || !svgRef.current || graph.nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    const layout = sankey<N, L>().nodeId((d) => d.id).nodeAlign(sankeyJustify).nodeWidth(16).nodePadding(18).extent([[8, 28], [W - 8, H - 8]]);
    const { nodes, links } = layout({ nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) });

    const lastX = d3.max(nodes, (n) => n.x0!) ?? 0;
    const isLast = (n: SankeyNode<N, L>) => n.x0! >= lastX - 1;
    const stages = [t('flows.stage.supplier'), t('flows.stage.plant'), t('flows.stage.dc'), t('flows.stage.region')];
    const xs = [...new Set(nodes.map((n) => n.x0!))].sort((a, b) => a - b);
    svg.select('g.stages').selectAll('text').data(xs).join('text')
      .attr('x', (x, i) => (i === xs.length - 1 ? x + 16 : x)).attr('y', 16)
      .attr('text-anchor', (_, i) => (i === xs.length - 1 ? 'end' : 'start'))
      .text((_, i) => stages[i] ?? '');

    const linkSel = svg.select('g.links').selectAll<SVGPathElement, SankeyLink<N, L>>('path').data(links).join('path')
      .attr('class', 'sankey-link')
      .attr('d', sankeyLinkHorizontal())
      .attr('stroke', (d) => (d.source as SankeyNode<N, L>).color)
      .attr('stroke-width', (d) => Math.max(1, d.width ?? 1));
    linkSel.selectAll('title').data((d) => [d]).join('title')
      .text((d) => t('flows.linkTitle', { from: (d.source as N).label, to: (d.target as N).label, value: fmt.integer(d.value) }));
    linkSel.attr('stroke-dasharray', function () { const len = this.getTotalLength(); return `${len} ${len}`; })
      .attr('stroke-dashoffset', function () { return this.getTotalLength(); })
      .transition().duration(motionMs(reduced, 1200)).delay((_, i) => (reduced ? 0 : i * 40)).ease(d3.easeCubicInOut)
      .attr('stroke-dashoffset', 0);

    const nodeSel = svg.select('g.nodes').selectAll<SVGGElement, SankeyNode<N, L>>('g').data(nodes, (d) => d.id).join((enter) => {
      const g = enter.append('g');
      g.append('rect');
      g.append('text');
      return g;
    });
    nodeSel.attr('class', (d) => `sankey-node ${d.isEntity ? 'is-entity' : ''}`)
      .attr('data-entity-ref', (d) => (d.isEntity ? d.id : null))
      .attr('tabindex', (d) => (d.isEntity ? 0 : null))
      .attr('role', (d) => (d.isEntity ? 'link' : 'img'))
      .attr('aria-label', (d) => t('flows.nodeAria', { name: d.label, value: fmt.integer(d.value ?? 0) }))
      .on('pointerenter.hl', (_, d) => setHover(d.id))
      .on('pointerleave.hl', () => setHover(null))
      .on('focus.hl', (_, d) => setHover(d.id))
      .on('blur.hl', () => setHover(null));
    nodeSel.select('rect').attr('x', (d) => d.x0!).attr('y', (d) => d.y0!).attr('width', (d) => d.x1! - d.x0!).attr('height', (d) => Math.max(2, d.y1! - d.y0!)).attr('rx', 3).attr('fill', (d) => d.color);
    nodeSel.select('text')
      .attr('x', (d) => (isLast(d) ? d.x0! - 8 : d.x1! + 8)).attr('y', (d) => (d.y0! + d.y1!) / 2).attr('dy', '0.35em')
      .attr('text-anchor', (d) => (isLast(d) ? 'end' : 'start'))
      .text((d) => `${d.label} · ${fmt.integer(d.value ?? 0)} t`);
    const detach: (() => void)[] = [];
    nodeSel.filter((d) => d.isEntity).each(function (d) { detach.push(attachCardTrigger(this, d.id, () => navigate(hrefFor(`/entity/${d.id}`)))); });
    return () => detach.forEach((f) => f());
  }, [graph, reduced, t, fmt, showingArchitecture]);

  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current).select('g.links').selectAll<SVGPathElement, SankeyLink<N, L>>('path')
      .classed('dim', (d) => hover !== null && (d.source as N).id !== hover && (d.target as N).id !== hover)
      .classed('on', (d) => hover !== null && ((d.source as N).id === hover || (d.target as N).id === hover));
  }, [hover, showingArchitecture]);

  const total = d3.sum(loaded.pack.flows.filter((f) => getEntity(f.source)?.kind === 'supplier'), (f) => f.valueT);
  const workflow = useMemo(() => {
    const r = WorkflowExtension.safeParse(loaded.pack.extensions?.workflow);
    return r.success ? r.data : null;
  }, []);
  // A sales or service organisation has a work chain but no material flow; show only what the pack has.
  const workOnly = workflow !== null && graph.nodes.length === 0;

  return (
    <div className={embedded ? 'flows-embedded' : 'screen screen-flows'}>
      {!embedded && <PageHeader
        title={workOnly ? t('flows.work.title') : t('flows.title')}
        subtitle={workOnly ? t('flows.work.subtitle', { count: workflow.stages.length }) : t('flows.subtitle', { total: fmt.integer(total) })}
      />}
      <TabList
        selectedValue={showingArchitecture ? 'architecture' : 'flow'}
        onTabSelect={(_, data) => {
          cardController.closeNow();
          replaceQuery({ section: data.value === 'architecture' ? 'architecture' : undefined });
        }}
        aria-label={t('flows.sections')}
        data-testid="flow-sections"
      >
        <Tab value="flow">{t('flows.section.flow')}</Tab>
        <Tab value="architecture">{t('td.tab.arch')}</Tab>
      </TabList>
      {showingArchitecture ? <ContextualScene tab="arch" /> : <>
      {workflow && <WorkflowPanel workflow={workflow} />}
      {!workOnly && (<>
      <Panel title={t('flows.panel')} rationale="visual.sankey" testId="sankey-panel">
        {graph.nodes.length === 0 && <p className="muted" data-testid="flows-empty">{t('flows.empty')}</p>}
        <div className="chart-scroll" hidden={graph.nodes.length === 0}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="sankey" role="group" aria-label={t('flows.aria')} style={{ minWidth: 760 }}>
            <g className="stages axis-label" />
            <g className="links" />
            <g className="nodes" />
          </svg>
        </div>
      </Panel>
      <Panel title={t('flows.tableTitle')} rationale="visual.flowTable">
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th scope="col">{t('relations.col.from')}</th><th scope="col">{t('relations.col.to')}</th><th scope="col" className="num">{t('flows.volume')}</th></tr></thead>
            <tbody>
              {loaded.pack.flows.map((f) => (
                <tr key={`${f.source}-${f.target}`}>
                  <td>{getEntity(f.source) ? <EntityRef id={f.source} /> : tx(regionName(f.source)!)}</td>
                  <td>{getEntity(f.target) ? <EntityRef id={f.target} /> : tx(regionName(f.target)!)}</td>
                  <td className="num">{t('unit.tPerMonth', { value: fmt.integer(f.valueT) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      </>)}
      </>}
    </div>
  );
}

function WorkflowPanel({ workflow }: { workflow: WorkflowExtension }) {
  const { t, lang } = useI18n();
  const route = useRoute();
  const view = route.query.get('flowView') === 'map' ? 'map' : 'list';
  const nameOf = new Map(workflow.stages.map((s) => [s.id, loc(s.name, lang)]));
  return (
    <Panel title={t('flows.work.panel')} rationale={view === 'map' ? 'visual.workflow' : undefined} testId="workflow-panel">
      <TabList
        selectedValue={view}
        onTabSelect={(_, data) => replaceQuery({ flowView: data.value === 'map' ? 'map' : undefined })}
        aria-label={t('flows.work.views')}
        data-testid="workflow-views"
      >
        <Tab value="list">{t('flows.work.view.list')}</Tab>
        <Tab value="map">{t('flows.work.view.map')}</Tab>
      </TabList>
      {view === 'map' ? <WorkflowMap workflow={workflow} /> : (
        <>
          <p className="muted">{t('flows.work.hint')}</p>
          <ol className="workflow-stages" data-testid="workflow-stages">
            {workflow.stages.map((s, i) => {
              const next = [...s.next.map((id) => nameOf.get(id) ?? id), ...(s.handoffTo ?? []).map((h) => loc(h, lang))];
              return (
                <li key={s.id} className="workflow-stage" data-testid={`workflow-stage-${s.id}`}>
                  <h3>{i + 1}. {loc(s.name, lang)}{s.team && <span className="muted"> · {loc(s.team, lang)}</span>}</h3>
                  <WorkflowFields stage={s} />
                  {next.length > 0 && <p data-testid="workflow-next"><strong>{t('flows.work.next')}</strong> → {next.join(' / ')}</p>}
                  <WorkflowSources stage={s} />
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Panel>
  );
}

