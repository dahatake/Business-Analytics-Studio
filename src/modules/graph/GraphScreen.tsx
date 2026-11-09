import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Field, Radio, RadioGroup, Switch, Tab, TabList, Toolbar, ToolbarButton, ToolbarDivider, Tooltip } from '@fluentui/react-components';
import {
  ArrowDown16Regular, ArrowLeft16Regular, ArrowRight16Regular, ArrowUp16Regular, FullScreenMaximize16Regular,
  FullScreenMinimize16Regular, ZoomFit16Regular, ZoomIn16Regular, ZoomOut16Regular,
} from '@fluentui/react-icons';
import { loaded } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { replaceQuery, useRoute } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { isHidden } from '../../ui/cardSpecs.ts';
import { kindColor, kindIcon } from '../../ui/icons.ts';
import { cardController } from '../../ui/cardController.ts';
import { graphExtensionFor, SEMANTICS } from './extensions.ts';
import {
  HIGHLIGHT_MS, LEVELS, MAX_LABELS, MAX_NODES, panBy, selectLevel, SEMANTIC_DASH, zoomBy, type ArrowKey, type WorldFilter,
} from './model.ts';
import { buildScene, type GraphView, type SceneNode } from './scene.ts';
import { FORMATS } from './layout.ts';
import { Diagram2D } from './Diagram2D.tsx';
import { Diagram3D } from './Diagram3D.tsx';
import { InfoCard, type InfoCardData } from './InfoCard.tsx';
import { SuitabilityPanel } from './SuitabilityPanel.tsx';
import './graph.css';

type Tabs = GraphView | 'criteria';
const TABS: Tabs[] = ['relations', 'twin', 'spatial', 'criteria'];
const WORLDS: WorldFilter[] = ['both', 'real', 'digital'];
const LEGEND_KINDS = ['site', 'person', 'customer', 'product', 'deal', 'deliverable', 'invoice', 'issue', 'cause', 'solution', 'kpi', 'initiative', 'supplier', 'source'] as const;

const pick = <T extends string>(v: string | null, all: readonly T[], d: T): T => ((all as readonly string[]).includes(v ?? '') ? (v as T) : d);

export function GraphScreen() {
  const { t, tx, fmt } = useI18n();
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const tab = pick(route.query.get('view'), TABS, 'relations');
  const view: GraphView = tab === 'criteria' ? 'relations' : tab;
  const format = pick(route.query.get('format'), FORMATS, 'graph');
  const level = pick(route.query.get('level'), LEVELS, 'element');
  const world = pick(route.query.get('world'), WORLDS, 'both');
  const showTwins = route.query.get('twins') === '1';
  const sel = route.query.get('sel');

  const ext = useMemo(() => graphExtensionFor(loaded), []);
  const visible = useCallback((e: Parameters<typeof isHidden>[0]) => !isHidden(e, audience), [audience]);
  const selEntity = sel ? loaded.byId.get(sel) : undefined;
  const selected = selEntity && visible(selEntity) ? selEntity.id : null;

  const [highlight, setHighlight] = useState<string | null>(null);
  const [centreRequest, setCentreRequest] = useState<{ id: string; n: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [card, setCard] = useState<InfoCardData | null>(null);
  const [fullscreen, setFullscreen] = useState<'native' | 'fallback' | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(800);

  const scene = useMemo(() => buildScene({
    data: loaded, ext, view, level, world, showTwins, selected, pinned: highlight ? [highlight] : [], visible, t, tx, fmtNumber: (n) => fmt.integer(n),
  }), [ext, view, level, world, showTwins, selected, highlight, visible, t, tx, fmt]);

  // Reset the camera when the representation changes (semantic zoom changes meaning, not just scale).
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setCard(null);
  }, [view, level, world, format]);

  const zoomRef = useRef({ zoom, level, selected });
  zoomRef.current = { zoom, level, selected };
  const zoomStep = useCallback((dir: 1 | -1) => {
    const { zoom: z, level: l, selected: s } = zoomRef.current;
    const nz = zoomBy(z, dir);
    const nl = selectLevel(l, nz, !!s);
    if (nl !== l) {
      zoomRef.current = { zoom: 1, level: nl, selected: s };
      replaceQuery({ level: nl });
    } else {
      zoomRef.current = { ...zoomRef.current, zoom: nz };
      setZoom(nz);
    }
  }, []);
  const fit = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const panStep = (key: ArrowKey) => setPan((p) => panBy(p, key));

  // FR-248: highlight for PARAM-089 and centre.
  const timer = useRef<number | null>(null);
  const locate = (id: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setHighlight(id);
    setCentreRequest((c) => ({ id, n: (c?.n ?? 0) + 1 }));
    timer.current = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  };
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  // FR-246 diagram-only fullscreen (Fullscreen API, CSS fallback).
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement && document.fullscreenElement === stageRef.current) setFullscreen('native');
      else setFullscreen((f) => (f === 'native' ? null : f));
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = async () => {
    const el = stageRef.current;
    if (!el) return;
    if (fullscreen === 'fallback') { setFullscreen(null); return; }
    if (fullscreen === 'native') {
      try { await document.exitFullscreen(); } catch { /* already left */ }
      setFullscreen(null);
      return;
    }
    if (document.fullscreenEnabled && typeof el.requestFullscreen === 'function') {
      try {
        await el.requestFullscreen();
        setFullscreen('native');
        return;
      } catch {
        /* fall through to the CSS fallback */
      }
    }
    setFullscreen('fallback');
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);

  const onStageKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      panStep(e.key as ArrowKey);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomStep(1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomStep(-1); }
    else if (e.key === '0') { e.preventDefault(); fit(); }
    else if (e.key === 'Escape') {
      if (card) { setCard(null); e.stopPropagation(); }
      else if (fullscreen === 'fallback') setFullscreen(null);
    }
  };

  const select = (id: string) => { if (level !== 'overview') replaceQuery({ sel: id }); };
  const clusterAction = (n: SceneNode): InfoCardData['action'] => (n.role === 'cluster' && level === 'overview'
    ? { label: t('graph.card.showElements'), run: () => { setCard(null); replaceQuery({ level: 'element' }); } }
    : undefined);

  const viewTitle: Record<GraphView, MessageKey> = { relations: 'graph.view.relations', twin: 'graph.view.twin', spatial: 'graph.view.spatial' };
  const rationale: Record<GraphView, MessageKey> = { relations: 'graph.why.relations', twin: 'graph.why.twin', spatial: 'graph.why.spatial' };

  return (
    <div className="screen screen-graph">
      <PageHeader title={t('graph.title')} subtitle={t('graph.subtitle')} />
      <TabList selectedValue={tab} onTabSelect={(_, d) => { cardController.closeNow(); replaceQuery({ view: String(d.value) }); }} aria-label={t('graph.viewLabel')}>
        {TABS.map((v) => <Tab key={v} value={v}>{t(`graph.tab.${v}`)}</Tab>)}
      </TabList>

      {tab === 'criteria' ? <SuitabilityPanel ext={ext.ext} /> : (
        <>
          <div className="graph-controls-bar">
            <Field label={t('graph.format')}>
              <RadioGroup layout="horizontal" value={format} onChange={(_, d) => replaceQuery({ format: d.value })} data-testid="graph-format">
                {FORMATS.map((f) => <Radio key={f} value={f} label={t(`graph.format.${f}`)} />)}
              </RadioGroup>
            </Field>
            <Field label={t('graph.level')}>
              <RadioGroup layout="horizontal" value={level} onChange={(_, d) => replaceQuery({ level: d.value })} data-testid="graph-level">
                {LEVELS.map((l) => <Radio key={l} value={l} label={t(`graph.level.${l}`)} />)}
              </RadioGroup>
            </Field>
            {view !== 'spatial' && (
              <Field label={t('graph.world')}>
                <RadioGroup layout="horizontal" value={world} onChange={(_, d) => replaceQuery({ world: d.value })} data-testid="graph-world">
                  {WORLDS.map((w) => <Radio key={w} value={w} label={t(`graph.world.${w}`)} />)}
                </RadioGroup>
              </Field>
            )}
            {view === 'relations' && (
              <Switch checked={showTwins} label={t('graph.showTwins')} onChange={(_, d) => replaceQuery({ twins: d.checked ? '1' : undefined })} data-testid="graph-twins" />
            )}
          </div>

          <div className="split">
            <Panel title={t(viewTitle[view])} rationale={rationale[view]} testId="graph-panel">
              <div
                ref={stageRef}
                className={`graph-stage ${fullscreen === 'fallback' ? 'graph-stage--fallback' : ''}`}
                data-testid="graph-stage"
                data-format={format}
                data-level={level}
                data-view={view}
                data-zoom={zoom.toFixed(4)}
                data-pan-x={pan.x}
                data-pan-y={pan.y}
                data-fullscreen={fullscreen ?? undefined}
                onKeyDown={onStageKey}
              >
                <Toolbar aria-label={t('graph.toolbar')} size="small" className="graph-toolbar">
                  <Tooltip content={t('graph.zoomOut')} relationship="label"><ToolbarButton icon={<ZoomOut16Regular />} onClick={() => zoomStep(-1)} data-testid="graph-zoom-out" /></Tooltip>
                  <Tooltip content={t('graph.zoomIn')} relationship="label"><ToolbarButton icon={<ZoomIn16Regular />} onClick={() => zoomStep(1)} data-testid="graph-zoom-in" /></Tooltip>
                  <Tooltip content={t('graph.fit')} relationship="label"><ToolbarButton icon={<ZoomFit16Regular />} onClick={fit} /></Tooltip>
                  <ToolbarDivider />
                  <Tooltip content={t('graph.pan.left')} relationship="label"><ToolbarButton icon={<ArrowLeft16Regular />} onClick={() => panStep('ArrowLeft')} /></Tooltip>
                  <Tooltip content={t('graph.pan.up')} relationship="label"><ToolbarButton icon={<ArrowUp16Regular />} onClick={() => panStep('ArrowUp')} /></Tooltip>
                  <Tooltip content={t('graph.pan.down')} relationship="label"><ToolbarButton icon={<ArrowDown16Regular />} onClick={() => panStep('ArrowDown')} /></Tooltip>
                  <Tooltip content={t('graph.pan.right')} relationship="label"><ToolbarButton icon={<ArrowRight16Regular />} onClick={() => panStep('ArrowRight')} /></Tooltip>
                  <ToolbarDivider />
                  <ToolbarButton
                    icon={fullscreen ? <FullScreenMinimize16Regular /> : <FullScreenMaximize16Regular />}
                    aria-pressed={fullscreen !== null}
                    onClick={() => void toggleFullscreen()}
                    data-testid="graph-fullscreen"
                  >
                    {fullscreen ? t('graph.fullscreen.exit') : t('graph.fullscreen.enter')}
                  </ToolbarButton>
                  <span className="graph-zoom-readout" aria-live="polite">{t('graph.zoomReadout', { value: fmt.integer(Math.round(zoom * 100)) })}</span>
                </Toolbar>
                {format === '3d' ? (
                  <Diagram3D scene={scene} zoom={zoom} pan={pan} onZoomStep={zoomStep} highlight={highlight} centreRequest={centreRequest} onCard={setCard} onSelect={select} />
                ) : (
                  <Diagram2D
                    scene={scene} format={format} zoom={zoom} pan={pan} onPan={setPan} onZoomStep={zoomStep} highlight={highlight}
                    centreRequest={centreRequest} card={card} onCard={setCard} onSelect={select} clusterAction={clusterAction}
                  />
                )}
                {card && <InfoCard card={card} onClose={() => setCard(null)} stageWidth={stageWidth} />}
                <p id="graph-keys-help" className="graph-help muted">{t(format === '3d' ? 'graph.help.keys3d' : 'graph.help.keys')}</p>
              </div>
            </Panel>
            <Panel title={t('graph.side.title')}>
              <SidePanel stats={{ nodes: scene.nodes.length, edges: scene.edges.length, labels: scene.labelled.size, aggregated: scene.aggregated }} view={view} selected={selected} extInfo={{ fromPack: ext.fromPack, issues: ext.issues }} />
            </Panel>
          </div>

          <Panel title={t('graph.table.title')} rationale="graph.why.table" testId="graph-table">
            <p className="muted">{t('graph.table.hint')}</p>
            <div className="table-scroll graph-table-scroll">
              <table className="data-table compact" data-testid="graph-node-table">
                <caption>{t('graph.table.nodes', { count: scene.nodes.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('graph.col.name')}</th>
                    <th scope="col">{t('graph.col.kind')}</th>
                    <th scope="col">{t('graph.col.group')}</th>
                    <th scope="col" className="num">{t('graph.col.relations')}</th>
                  </tr>
                </thead>
                <tbody>
                  {scene.nodes.map((n) => {
                    const e = n.entityId ? loaded.byId.get(n.entityId) : undefined;
                    return (
                      <tr key={n.id} className={highlight === n.id ? 'selected' : ''} onClick={() => locate(n.id)} data-row-for={n.id}>
                        <th scope="row"><button type="button" className="graph-row-button">{n.label}</button></th>
                        <td>{e ? t(`kind.${e.kind}`) : t(`graph.role.${n.role}`)}</td>
                        <td>{scene.lanes.find((l) => l.lane === n.lane)?.label ?? ''}</td>
                        <td className="num">{fmt.integer(n.degree)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <table className="data-table compact" data-testid="graph-edge-table">
                <caption>{t('graph.table.edges', { count: scene.edges.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('graph.col.from')}</th>
                    <th scope="col">{t('graph.col.relation')}</th>
                    <th scope="col">{t('graph.col.meaning')}</th>
                    <th scope="col">{t('graph.col.to')}</th>
                  </tr>
                </thead>
                <tbody>
                  {scene.edges.map((e) => (
                    <tr key={e.id} onClick={() => locate(e.source)} data-row-for={e.id}>
                      <td>{scene.nodes.find((n) => n.id === e.source)?.label ?? e.source}</td>
                      <th scope="row"><button type="button" className="graph-row-button">{e.label}</button></th>
                      <td>{e.flow ? t(`graph.flow.${e.flow}`) : e.twin ? t(`graph.twin.${e.twin}`) : e.semantic ? t(`graph.sem.${e.semantic}`) : e.contains ? t('graph.sp.contains') : t('graph.edge.bundleShort')}</td>
                      <td>{scene.nodes.find((n) => n.id === e.target)?.label ?? e.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function SidePanel({ stats, view, selected, extInfo }: {
  stats: { nodes: number; edges: number; labels: number; aggregated: number };
  view: GraphView;
  selected: string | null;
  extInfo: { fromPack: boolean; issues: string[] };
}) {
  const { t, fmt } = useI18n();
  return (
    <div className="graph-side">
      <dl className="graph-stats">
        <div><dt>{t('graph.stat.nodes')}</dt><dd>{t('graph.stat.ofMax', { value: fmt.integer(stats.nodes), max: fmt.integer(MAX_NODES) })}</dd></div>
        <div><dt>{t('graph.stat.edges')}</dt><dd>{fmt.integer(stats.edges)}</dd></div>
        <div><dt>{t('graph.stat.labels')}</dt><dd>{t('graph.stat.ofMax', { value: fmt.integer(stats.labels), max: fmt.integer(MAX_LABELS) })}</dd></div>
        {stats.aggregated > 0 && <div><dt>{t('graph.stat.aggregated')}</dt><dd>{fmt.integer(stats.aggregated)}</dd></div>}
      </dl>
      {selected && (
        <p className="graph-selected">{t('graph.selected')} <EntityRef id={selected} /></p>
      )}
      <h3 className="graph-side-h">{t('graph.legend.kinds')}</h3>
      <ul className="legend graph-legend">
        {LEGEND_KINDS.map((k) => {
          const Icon = kindIcon[k];
          return <li key={k}><span className="legend-swatch" style={{ background: kindColor[k] }} aria-hidden /><Icon aria-hidden /> {t(`kind.${k}`)}</li>;
        })}
      </ul>
      <p className="muted graph-shape-note">{t('graph.legend.shapes')}</p>
      <h3 className="graph-side-h">{view === 'relations' ? t('graph.legend.semantics') : t('graph.legend.flows')}</h3>
      <ul className="graph-line-legend">
        {view === 'relations' && SEMANTICS.map((s) => (
          <li key={s}><LineSample dash={SEMANTIC_DASH[s]} /> {t(`graph.sem.${s}`)}</li>
        ))}
        {view === 'relations' && <li><LineSample dash="2 2" /> {t('graph.legend.twin')}</li>}
        {view === 'twin' && (
          <>
            <li><LineSample dash="6 3" /> {t('graph.flow.data')}</li>
            <li><LineSample dash="" /> {t('graph.flow.control')}</li>
          </>
        )}
        {view === 'spatial' && <li><LineSample dash="" /> {t('graph.sp.contains')}</li>}
      </ul>
      <p className="muted graph-ext-status" data-testid="graph-ext-status">
        {extInfo.fromPack ? t('graph.ext.fromPack') : t('graph.ext.derived')}
        {extInfo.issues.length > 0 && ` ${t('graph.ext.issues', { count: extInfo.issues.length })}`}
      </p>
    </div>
  );
}

function LineSample({ dash }: { dash: string }) {
  return (
    <svg width="36" height="10" aria-hidden="true" className="graph-line-sample">
      <line x1="2" y1="5" x2="34" y2="5" strokeDasharray={dash} />
    </svg>
  );
}
