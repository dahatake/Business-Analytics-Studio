import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Radio, RadioGroup, Select, Switch, Tab, TabList } from '@fluentui/react-components';
import { ArrowClockwise20Regular, ArrowCounterclockwise20Regular, Home20Regular, ZoomIn20Regular, ZoomOut20Regular } from '@fluentui/react-icons';
import { getEntity } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { replaceQuery, useRoute } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { cardController } from '../../ui/cardController.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { buildArchitecture, ARCH_MODES, type ArchMode } from './architecture.ts';
import { coreObjectChoice } from './coreObject.ts';
import { detectWebGL, ORBIT_STEP, ZOOM_STEP } from './engine.ts';
import { ancestry, labelText, objectById, TABS, type SceneModel, type SceneObject, type TabKey, type Vec3 } from './model.ts';
import { buildArchModel, buildKpiModel, buildMapModel, buildTwinModel, type ArchScene, type TwinScene, type KpiScene, type MapScene } from './models.ts';
import type { Quality, QualityChange } from './quality.ts';
import { dofBlockReason } from './dof.ts';
import { SCENE_BUILDERS } from './scenes.ts';
import { SceneView, type OverlayLabel, type SceneApi } from './SceneView.tsx';
import { Arch2D, Kpi2D, Map2D, TwinPlan2D } from './views2d.tsx';
import { ViewSwitch, type ViewMode } from './ViewSwitch.tsx';
import type { UnavailableReason } from './ContextualScene.tsx';
import './threed.css';

type QualityChoice = 'auto' | Quality;
const QUALITY_CHOICES: QualityChoice[] = ['auto', 'high', 'medium', 'low'];

const RATIONALE: Record<TabKey, MessageKey> = {
  twin: 'td.rationale.twin',
  map: 'td.rationale.map',
  kpi: 'td.rationale.kpi',
  arch: 'td.rationale.arch',
};

function labelPos(o: SceneObject, model: SceneModel): Vec3 {
  const [x, y, z] = o.position;
  if (o.kind === 'kpi' || (model.tab === 'map' && o.kind === 'site')) return [x, y * 2 + 0.9, z];
  if (o.kind === 'site') return [0, 9, 0];
  if (o.kind === 'layer') return [-15, y + 0.4, 0];
  return [x, y + o.size * 0.55 + 0.6, z];
}

/** /twin3d: digital twin, 3D map with flows, KPI towers and AsIs/ToBe architecture, each in 3D and 2D (FR-020/021/040/066/217). */
export function ThreeDScreen({ fixedTab, embedded = false, onUnavailable }: {
  fixedTab?: TabKey;
  embedded?: boolean;
  onUnavailable?: (reason: UnavailableReason) => void;
} = {}) {
  const { t, lang, fmt } = useI18n();
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const reducedMotion = useReducedMotion();
  const q = route.query;
  const tab: TabKey = fixedTab ?? ((TABS as string[]).includes(q.get('tab') ?? '') ? (q.get('tab') as TabKey) : 'twin');
  const archMode: ArchMode = q.get('arch') === 'asis' ? 'asis' : 'tobe';
  const [webgl] = useState(() => detectWebGL());
  const [engineFailed, setEngineFailed] = useState(false);
  const can3d = webgl && !engineFailed;
  const mode: ViewMode = can3d && (embedded ? q.get('mode') === '3d' : q.get('mode') !== '2d') ? '3d' : '2d';
  useEffect(() => {
    if (!can3d) onUnavailable?.(webgl ? 'engineFailed' : 'webglUnavailable');
  }, [can3d, webgl, onUnavailable]);
  const [qualityChoice, setQualityChoice] = useState<QualityChoice>('auto');
  const [currentQuality, setCurrentQuality] = useState<Quality>('high');
  const [autoNote, setAutoNote] = useState(false);
  const [cinematic, setCinematic] = useState(true);
  const [dof, setDof] = useState(false);
  const [dofAutoOff, setDofAutoOff] = useState(false);
  const [paused, setPaused] = useState(false);
  const [lod, setLod] = useState(0);
  const apiRef = useRef<SceneApi | null>(null);
  const helpId = useId();
  const fallbackId = useId();

  const core = useMemo(() => coreObjectChoice(undefined, audience), [audience]);
  const coreId = core.candidates.some((c) => c.id === q.get('core')) ? q.get('core')! : core.defaultId;
  const coreCandidate = core.candidates.find((c) => c.id === coreId);

  const model: SceneModel = useMemo(() => {
    switch (tab) {
      case 'map': return buildMapModel(undefined, audience);
      case 'kpi': return buildKpiModel(undefined, audience);
      case 'arch': return buildArchModel(buildArchitecture(archMode, undefined, audience));
      default: return buildTwinModel(coreCandidate, undefined, audience);
    }
  }, [tab, audience, archMode, coreCandidate]);

  const selected = objectById(model, q.get('sel'))?.id
    ?? (embedded ? model.objects.find((o) => o.entityId === q.get('sel'))?.id : undefined)
    ?? null;
  const selectedObj = objectById(model, selected);
  const text = useCallback((o: SceneObject) => labelText(o.label, t, lang), [t, lang]);
  const labels: OverlayLabel[] = useMemo(
    () => model.objects.filter((o) => o.labelLod !== undefined).map((o) => ({ id: o.id, text: text(o), lod: o.labelLod!, pos: labelPos(o, model) })),
    [model, text],
  );

  const select = (id: string | null) => {
    const object = objectById(model, id);
    replaceQuery({ sel: (embedded ? object?.entityId ?? id : id) ?? undefined });
  };
  const onPick = (id: string | null, anchor: Element) => {
    select(id);
    const o = objectById(model, id);
    if (o?.entityId && getEntity(o.entityId)) cardController.openNow(o.entityId, anchor, 'touch');
  };

  const onQuality = (qv: Quality, change: QualityChange) => {
    setCurrentQuality(qv);
    if (change?.reason === 'downgrade') setAutoNote(true);
    if (change?.reason === 'dofOff') {
      setDof(false);
      setDofAutoOff(true);
    }
  };
  const dofBlock = dofBlockReason({ quality: currentQuality, cinematic, reducedMotion });
  const changeDof = (on: boolean) => {
    setDof(on);
    setDofAutoOff(false);
  };
  const qualityPreset: Quality = qualityChoice === 'auto' ? 'high' : qualityChoice;
  const changeQuality = (v: QualityChoice) => {
    setQualityChoice(v);
    setCurrentQuality(v === 'auto' ? 'high' : v);
    setAutoNote(false);
  };

  const crumbs = ancestry(model, selected ?? model.rootId);
  const lodName = model.levelNames[Math.min(lod, model.levelNames.length - 1)]!;
  const title = t(`td.tab.${tab}`);
  const view2dTitle = t('td.view2dLabel', { name: title });
  const kindText = (o: SceneObject) => t(`td.kind.${o.kind}`);

  return (
    <div className={embedded ? 'screen-td td-embedded' : 'screen screen-td'}>
      {!embedded && (
        <>
          <PageHeader title={t('td.title')} subtitle={t('td.subtitle')} />
          <TabList selectedValue={tab} onTabSelect={(_, d) => replaceQuery({ tab: String(d.value), sel: undefined })} aria-label={t('td.tabs')}>
            {TABS.map((k) => <Tab key={k} value={k} data-testid={`td-tab-${k}`}>{t(`td.tab.${k}`)}</Tab>)}
          </TabList>
        </>
      )}

      {!can3d && !onUnavailable && (
        <MessageBar intent="warning" data-testid="td-fallback">
          <MessageBarBody id={fallbackId}>{t(webgl ? 'td.engineFailed' : 'td.webglUnavailable')}</MessageBarBody>
        </MessageBar>
      )}

      <div className="td-toolbar" role="group" aria-label={t('td.toolbar')}>
        {!embedded && <ViewSwitch mode={mode} onChange={(m) => replaceQuery({ mode: m === '2d' ? '2d' : undefined })} disabled3d={!can3d} reasonId={fallbackId} />}
        {tab === 'arch' && (
          <ArchSwitch value={archMode} onChange={(v) => replaceQuery({ arch: v === 'tobe' ? undefined : v, sel: undefined })} />
        )}
        {mode === '3d' && (
          <>
            <div className="td-control">
              <label htmlFor={`${helpId}-q`} className="td-control-label">{t('td.quality.label')}</label>
              <Select id={`${helpId}-q`} value={qualityChoice} onChange={(_, d) => changeQuality(d.value as QualityChoice)} data-testid="td-quality">
                {QUALITY_CHOICES.map((c) => <option key={c} value={c}>{t(`td.quality.${c}`)}</option>)}
              </Select>
            </div>
            <Switch checked={cinematic && !reducedMotion} disabled={reducedMotion} onChange={(_, d) => setCinematic(d.checked)} label={t('td.cinematic')} />
            <div className="td-control">
              <Switch
                checked={dof && !dofBlock}
                disabled={!!dofBlock}
                onChange={(_, d) => changeDof(d.checked)}
                label={t('td.dof')}
                aria-describedby={dofBlock ? `${helpId}-dof` : undefined}
                data-testid="td-dof"
              />
              {dofBlock && <span id={`${helpId}-dof`} className="td-help td-dof-reason" data-testid="td-dof-reason">{t(`td.dof.reason.${dofBlock}`)}</span>}
            </div>
            <Switch checked={paused || reducedMotion} disabled={reducedMotion} onChange={(_, d) => setPaused(d.checked)} label={t('td.pause')} />
            <div className="td-camera-buttons" role="group" aria-label={t('td.camera')}>
              <Button size="small" icon={<ArrowCounterclockwise20Regular />} aria-label={t('td.rotateLeft')} title={t('td.rotateLeft')} onClick={() => apiRef.current?.orbit(-ORBIT_STEP, 0)} />
              <Button size="small" icon={<ArrowClockwise20Regular />} aria-label={t('td.rotateRight')} title={t('td.rotateRight')} onClick={() => apiRef.current?.orbit(ORBIT_STEP, 0)} />
              <Button size="small" icon={<ZoomIn20Regular />} aria-label={t('td.zoomIn')} title={t('td.zoomIn')} onClick={() => apiRef.current?.zoom(ZOOM_STEP)} data-testid="td-zoom-in" />
              <Button size="small" icon={<ZoomOut20Regular />} aria-label={t('td.zoomOut')} title={t('td.zoomOut')} onClick={() => apiRef.current?.zoom(1 / ZOOM_STEP)} data-testid="td-zoom-out" />
              <Button size="small" icon={<Home20Regular />} aria-label={t('td.resetView')} title={t('td.resetView')} onClick={() => { select(null); apiRef.current?.home(); }} />
            </div>
          </>
        )}
      </div>

      <div className="td-layout">
        <Panel title={title} rationale={tab === 'twin' && (model as TwinScene).office ? 'td.rationale.office' : RATIONALE[tab]} className="td-main" testId="td-main">
          <nav aria-label={t('td.breadcrumb')} className="td-breadcrumb" data-testid="td-breadcrumb">
            <ol>
              {crumbs.map((c, i) => (
                <li key={c.id}>
                  <Button size="small" appearance="subtle" aria-current={i === crumbs.length - 1 ? 'location' : undefined} onClick={() => select(c.id === model.rootId ? null : c.id)}>
                    {text(c)}
                  </Button>
                </li>
              ))}
            </ol>
          </nav>
          {mode === '3d' ? (
            <>
              <SceneView
                key={tab}
                model={model}
                build={SCENE_BUILDERS[tab]}
                selected={selected}
                onPick={onPick}
                labels={labels}
                reducedMotion={reducedMotion}
                paused={paused}
                cinematic={cinematic}
                dof={dof}
                quality={qualityPreset}
                autoQuality={qualityChoice === 'auto'}
                onLod={setLod}
                onQuality={onQuality}
                onError={() => setEngineFailed(true)}
                apiRef={apiRef}
                label={t('td.canvasLabel', { name: title })}
                describedBy={`${helpId}-help`}
                minimapLabel={t('td.minimap')}
              />
              <p id={`${helpId}-help`} className="td-help">{t('td.help')}</p>
              <p role="status" className="td-status" data-testid="td-status">
                {t('td.status', { level: t(lodName), n: lod, quality: t(`td.quality.${currentQuality}`) })}
                {autoNote && qualityChoice === 'auto' && <span> {t('td.quality.autoLowered')}</span>}
                {dofAutoOff && <span data-testid="td-dof-auto-off"> {t('td.dof.autoOff')}</span>}
              </p>
            </>
          ) : (
            <div className="td-2d-wrap" data-testid="td-2d">
              {tab === 'twin' && <TwinPlan2D model={model} selected={selected} onPick={onPick} text={text} title={view2dTitle} />}
              {tab === 'map' && <Map2D model={model} selected={selected} onPick={onPick} text={text} title={view2dTitle} />}
              {tab === 'kpi' && <Kpi2D model={model} selected={selected} onPick={onPick} text={text} title={view2dTitle} percent={fmt.percent} />}
              {tab === 'arch' && <Arch2D model={model} selected={selected} onPick={onPick} text={text} title={view2dTitle} roleText={(r) => t(`td.arch.role.${r as 'product' | 'current' | 'painPoint'}`)} />}
            </div>
          )}
          <Legend tab={tab} office={(model as TwinScene).office} />
        </Panel>

        <div className="td-side">
          <Panel title={t('td.selection')} testId="td-selection">
            {selectedObj ? (
              <dl className="td-dl">
                <dt>{t('td.col.name')}</dt>
                <dd data-testid="td-selected-name">{selectedObj.entityId ? <EntityRef id={selectedObj.entityId} /> : text(selectedObj)}</dd>
                <dt>{t('td.col.kind')}</dt>
                <dd>{kindText(selectedObj)}</dd>
                {selectedObj.detail && (<><dt>{t('td.col.detail')}</dt><dd>{labelText(selectedObj.detail, t, lang)}</dd></>)}
                <ValueRows o={selectedObj} model={model} />
              </dl>
            ) : <p className="muted">{t('td.noSelection')}</p>}
          </Panel>
          {tab === 'twin' && (
            <Panel title={t('td.core.title')} rationale="td.core.rationale" testId="td-core">
              <p data-testid="td-core-name" className="td-core-name">
                {coreCandidate?.entityId ? <EntityRef id={coreCandidate.entityId} /> : coreCandidate ? labelText({ text: coreCandidate.name }, t, lang) : '—'}
              </p>
              {core.reason && <p className="td-reason" data-testid="td-core-reason">{labelText(core.reason, t, lang)}</p>}
              <label htmlFor={`${helpId}-core`} className="td-control-label">{t('td.core.change')}</label>
              <Select id={`${helpId}-core`} value={coreId} onChange={(_, d) => replaceQuery({ core: d.value === core.defaultId ? undefined : d.value, sel: undefined })} data-testid="td-core-select">
                {core.candidates.map((c) => <option key={c.id} value={c.id}>{labelText({ text: c.name }, t, lang)}</option>)}
              </Select>
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('td.core.compare')}>
                <table className="data-table compact td-core-table">
                  <caption>{t('td.core.compare')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('td.core.candidate')}</th>
                      <th scope="col">{t('td.col.kind')}</th>
                      {core.criteria.length > 0
                        ? core.criteria.map((c) => <th key={c.id} scope="col">{c.label}</th>)
                        : (<><th scope="col" className="num">{t('td.core.dealValue')}</th><th scope="col" className="num">{t('td.core.deals')}</th></>)}
                    </tr>
                  </thead>
                  <tbody>
                    {core.candidates.map((c) => (
                      <tr key={c.id} className={c.id === coreId ? 'selected' : ''}>
                        <th scope="row">{labelText({ text: c.name }, t, lang)}</th>
                        <td>{t(`td.core.kind.${c.kind}`)}</td>
                        {core.criteria.length > 0
                          ? core.criteria.map((cr) => <td key={cr.id}>{c.scores?.[cr.id] ?? '—'}</td>)
                          : (<><td className="num">{fmt.yenCompact(c.dealValueJpy)}</td><td className="num">{fmt.integer(c.dealCount)}</td></>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      </div>

      <Panel title={t('td.table.title', { name: title })} rationale="td.table.rationale" className="td-table-panel" testId="td-table">
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t('td.table.caption')}>
          <table className="data-table compact">
            <caption>{t('td.table.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('td.col.name')}</th>
                <th scope="col">{t('td.col.kind')}</th>
                <th scope="col">{t('td.col.parent')}</th>
                <th scope="col">{t('td.col.level')}</th>
                <th scope="col">{t('td.col.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {model.objects.map((o) => {
                const parent = objectById(model, o.parentId);
                return (
                  <tr key={o.id} className={o.id === selected ? 'selected' : ''}>
                    <th scope="row">
                      <Button size="small" appearance="subtle" aria-pressed={o.id === selected} data-td-select={o.id} onClick={() => select(o.id === model.rootId ? null : o.id)}>
                        {text(o)}
                      </Button>
                    </th>
                    <td>{kindText(o)}</td>
                    <td>{parent ? text(parent) : '—'}</td>
                    <td>{t(model.levelNames[Math.min(o.lod, model.levelNames.length - 1)]!)}</td>
                    <td><DetailCell o={o} model={model} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {tab === 'map' && <FlowTable model={model as MapScene} />}
      </Panel>
    </div>
  );
}

function ArchSwitch({ value, onChange }: { value: ArchMode; onChange: (v: ArchMode) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="td-viewswitch">
      <span id={id} className="td-control-label">{t('td.arch.switch')}</span>
      <RadioGroup layout="horizontal" value={value} aria-labelledby={id} onChange={(_, d) => onChange(d.value === 'asis' ? 'asis' : 'tobe')} data-testid="td-arch-switch">
        {ARCH_MODES.map((m) => <Radio key={m} value={m} label={t(`td.arch.${m}`)} />)}
      </RadioGroup>
    </div>
  );
}

function ValueRows({ o, model }: { o: SceneObject; model: SceneModel }) {
  const { t, tx, fmt } = useI18n();
  const e = o.entityId ? getEntity(o.entityId) : undefined;
  if (e?.kind === 'kpi') {
    return (
      <>
        <dt>{t('td.kpi.progress')}</dt><dd>{Number.isFinite(o.value) ? fmt.percent(o.value!) : '—'}</dd>
        <dt>{t('td.kpi.values')}</dt><dd>{t('td.kpi.valuesText', { baseline: fmt.number(e.baseline), current: fmt.number(e.current), target: fmt.number(e.target), unit: tx(e.unit) })}</dd>
      </>
    );
  }
  if (model.tab === 'map' && o.value !== undefined && o.level === 1) {
    return (<><dt>{t('td.map.volume')}</dt><dd>{t('unit.tPerMonth', { value: fmt.integer(o.value) })}</dd></>);
  }
  if (model.tab === 'arch' && o.kind === 'block') {
    const blk = (model as ArchScene).blocks.find((b) => b.id === o.id);
    if (!blk || blk.solutionIds.length === 0) return null;
    return (<><dt>{t('td.arch.solutions')}</dt><dd className="td-refs">{blk.solutionIds.map((s) => <EntityRef key={s} id={s} />)}</dd></>);
  }
  return null;
}

function DetailCell({ o, model }: { o: SceneObject; model: SceneModel }) {
  const { t, lang, fmt } = useI18n();
  const parts: string[] = [];
  if (o.detail) parts.push(labelText(o.detail, t, lang));
  if (model.tab === 'kpi' && o.kind === 'kpi') parts.push(t('td.kpi.progressText', { value: Number.isFinite(o.value) ? fmt.percent(o.value!) : '—' }));
  if (model.tab === 'map' && o.value !== undefined && o.level === 1) parts.push(t('unit.tPerMonth', { value: fmt.integer(o.value) }));
  if (model.tab === 'arch' && o.kind === 'layer') parts.push(t('td.arch.blockCount', { n: o.value ?? 0 }));
  if (model.tab === 'kpi' && o.kind === 'kpi') {
    const tw = (model as KpiScene).towers.find((x) => x.id === o.id);
    if (tw) parts.push(t(`td.kpi.status.${tw.status}`));
  }
  return <>{parts.join(' · ') || '—'}</>;
}

function FlowTable({ model }: { model: MapScene }) {
  const { t, tx, fmt } = useI18n();
  const name = (id: string) => {
    const e = getEntity(id);
    if (e) return tx(e.name);
    const o = model.objects.find((x) => x.id === `map-${id}`);
    return o && 'text' in o.label && typeof o.label.text !== 'string' ? tx(o.label.text) : id;
  };
  return (
    <table className="data-table compact td-flow-table">
      <caption>{t('td.map.flows')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('td.map.from')}</th>
          <th scope="col">{t('td.map.to')}</th>
          <th scope="col" className="num">{t('td.map.volume')}</th>
        </tr>
      </thead>
      <tbody>
        {model.flows.map((f) => (
          <tr key={f.id}>
            <th scope="row">{name(f.from)}</th>
            <td>{name(f.to)}</td>
            <td className="num">{t('unit.tPerMonth', { value: fmt.integer(f.valueT) })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Legend({ tab, office }: { tab: TabKey; office?: boolean }) {
  const { t } = useI18n();
  const all: Record<TabKey, { cls: string; key: MessageKey }[]> = {
    twin: office ? [
      { cls: 'step-machining', key: 'td.legend.stage' },
      { cls: 'twin-line', key: 'td.legend.team' },
      { cls: 'twin-piece', key: 'td.legend.workItem' },
    ] : [
      { cls: 'step-machining', key: 'td.legend.machine' },
      { cls: 'twin-line', key: 'td.legend.line' },
      { cls: 'twin-product', key: 'td.legend.product' },
      { cls: 'twin-piece', key: 'td.legend.piece' },
    ],
    map: [
      { cls: 'map-plant', key: 'td.legend.plant' },
      { cls: 'map-hq', key: 'td.legend.hq' },
      { cls: 'map-dc', key: 'td.legend.dc' },
      { cls: 'map-office', key: 'td.legend.office' },
      { cls: 'map-supplier', key: 'td.legend.supplier' },
      { cls: 'map-region', key: 'td.legend.region' },
      { cls: 'map-flow', key: 'td.legend.flow' },
    ],
    kpi: [
      { cls: 'status-achieved', key: 'td.kpi.status.achieved' },
      { cls: 'status-progressing', key: 'td.kpi.status.progressing' },
      { cls: 'status-regressed', key: 'td.kpi.status.regressed' },
      { cls: 'kpi-target', key: 'td.legend.target' },
    ],
    arch: [
      { cls: 'role-product', key: 'td.arch.role.product' },
      { cls: 'role-current', key: 'td.arch.role.current' },
      { cls: 'role-painPoint', key: 'td.arch.role.painPoint' },
    ],
  };
  const items = all[tab];
  return (
    <ul className="legend td-legend" aria-label={t('td.legend')}>
      {items.map((i) => <li key={i.key}><span className={`legend-swatch td-sw ${i.cls}`} aria-hidden />{t(i.key)}</li>)}
    </ul>
  );
}
