import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, ToggleButton } from '@fluentui/react-components';
import { ArrowRotateClockwise20Regular, ArrowRotateCounterclockwise20Regular, ZoomIn20Regular, ZoomOut20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { DETAILS, detailFor, ZOOM_FOR, ZOOM_MAX, ZOOM_MIN, type Cluster, type DataEntity, type Detail, type EntityRelation } from './catalogModel.ts';
import { truncateChars } from './normalize.ts';
import { layoutViewer, navOrder } from './viewerLayout.ts';
import { Viewer3D } from './Viewer3D.tsx';

const W = 900;
const H = 560;
const SCALE = 0.72;
const MAX_COLUMN_LABELS = 5;

/**
 * FR-169〜171 / NFR-A11Y-007 / NFR-UX-012: the data viewer component (2D SVG or 3D three.js) with progressive
 * detail (clusters → entities → columns), relations, selection synchronized with the caller's table, keyboard
 * operation, and a 2D fallback when WebGL is unavailable. Reusable on other screens (workspace component).
 */
export function DataViewer({ entities, relations, clusters, selectedId, onSelect, initialZoom, simplified, webgl }: {
  entities: DataEntity[];
  relations: EntityRelation[];
  clusters: Cluster[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  initialZoom: number;
  simplified: boolean;
  webgl: boolean;
}) {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(initialZoom);
  const [detail, setDetail] = useState<Detail>(() => detailFor(initialZoom, 'clusters', simplified));
  const [rotateBy, setRotateBy] = useState({ n: 0, rad: 0 });
  const box = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const layout = useMemo(() => layoutViewer(clusters), [clusters]);
  const order = useMemo(() => navOrder(clusters, entities), [clusters, entities]);
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const columnsOf = useCallback((id: string) => byId.get(id)?.columns.length ?? 0, [byId]);
  const can3d = webgl && !failed;
  const view = can3d ? mode : '2d';

  const applyZoom = useCallback((z: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
    setZoom(next);
    setDetail((prev) => detailFor(next, prev, simplified));
  }, [simplified]);
  useEffect(() => setDetail((prev) => detailFor(zoom, prev, simplified)), [simplified]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12) * 100) / 100));
        setDetail((prev) => detailFor(next, prev, simplified));
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [simplified]);

  const step = (by: number) => {
    if (order.length === 0) return;
    const i = selectedId ? order.indexOf(selectedId) : -1;
    const next = order[(i + by + order.length) % order.length]!;
    onSelect(next);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown') step(1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') step(-1);
    else if (k === 'Home' && order[0]) onSelect(order[0]);
    else if (k === 'End' && order.length > 0) onSelect(order[order.length - 1]!);
    else if (k === '+' || k === '=') applyZoom(zoom * 1.25);
    else if (k === '-' || k === '_') applyZoom(zoom / 1.25);
    else if (k === '0') applyZoom(1);
    else if ((k === 'r' || k === 'R') && view === '3d') setRotateBy((r) => ({ n: r.n + 1, rad: e.shiftKey ? -Math.PI / 6 : Math.PI / 6 }));
    else return;
    e.preventDefault();
  };

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const selCluster = selectedId ? clusters.find((c) => c.entityIds.includes(selectedId)) : undefined;
  const clusterName = (c: Cluster | undefined) => (c ? (c.label === null ? t('uc.viewer.unassigned') : loc(c.label, lang)) : '');
  const focus = selectedId && detail !== 'clusters' ? layout.entities.get(selectedId) : undefined;
  const fx = focus?.x ?? 0;
  const fy = focus?.y ?? 0;
  const sx = (x: number) => W / 2 + (x - fx) * zoom * SCALE;
  const sy = (y: number) => H / 2 + (y - fy) * zoom * SCALE;

  return (
    <div className="uc-viewer" data-testid="uc-viewer" data-mode={view} data-detail={detail} data-selected={selectedId ?? ''} data-simplified={simplified ? 'true' : 'false'} data-webgl={can3d ? 'true' : 'false'}>
      <div className="toolbar uc-viewer-tools">
        <div role="group" aria-label={t('uc.viewer.mode')} className="toggle-group">
          <ToggleButton size="small" checked={view === '2d'} onClick={() => setMode('2d')}>{t('uc.viewer.2d')}</ToggleButton>
          <ToggleButton size="small" checked={view === '3d'} disabled={!can3d} onClick={() => setMode('3d')}>{t('uc.viewer.3d')}</ToggleButton>
        </div>
        <div role="group" aria-label={t('uc.viewer.detail')} className="toggle-group">
          {DETAILS.map((d) => (
            <ToggleButton key={d} size="small" checked={detail === d} disabled={simplified && d === 'columns'} onClick={() => { setZoom(ZOOM_FOR[d]); setDetail(d); }}>
              {t(`uc.viewer.level.${d}`)}
            </ToggleButton>
          ))}
        </div>
        <Button size="small" icon={<ZoomIn20Regular />} onClick={() => applyZoom(zoom * 1.25)}>{t('uc.viewer.zoomIn')}</Button>
        <Button size="small" icon={<ZoomOut20Regular />} onClick={() => applyZoom(zoom / 1.25)}>{t('uc.viewer.zoomOut')}</Button>
        {view === '3d' && (
          <>
            <Button size="small" icon={<ArrowRotateCounterclockwise20Regular />} onClick={() => setRotateBy((r) => ({ n: r.n + 1, rad: -Math.PI / 6 }))}>{t('uc.viewer.rotateLeft')}</Button>
            <Button size="small" icon={<ArrowRotateClockwise20Regular />} onClick={() => setRotateBy((r) => ({ n: r.n + 1, rad: Math.PI / 6 }))}>{t('uc.viewer.rotateRight')}</Button>
          </>
        )}
      </div>
      {!can3d && <p className="uc-notice" role="note" data-testid="uc-viewer-fallback">{t('uc.viewer.noWebgl')}</p>}
      {simplified && <p className="uc-notice" role="note" data-testid="uc-viewer-simplified">{t('uc.viewer.simplified', { entities: 300, columns: 3000 })}</p>}
      <div
        ref={box}
        className="uc-viewer-box"
        tabIndex={0}
        role="group"
        aria-roledescription={t('uc.viewer.roledesc')}
        aria-label={t('uc.viewer.label')}
        aria-describedby={helpId}
        onKeyDown={onKeyDown}
      >
        {view === '3d' ? (
          <Viewer3D
            layout={layout}
            relations={relations}
            detail={detail}
            selectedId={selectedId}
            columnsOf={columnsOf}
            zoom={zoom}
            rotateBy={rotateBy}
            simplified={simplified}
            onSelect={onSelect}
            onFail={() => setFailed(true)}
          />
        ) : (
          <svg className="uc-viewer-2d" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
            {clusters.map((c, ci) => {
              const p = layout.clusters.get(c.id)!;
              const isSel = c === selCluster;
              if (detail === 'clusters') {
                const r = (14 + 7 * Math.sqrt(c.entityIds.length)) * Math.max(1, zoom * 0.8);
                return (
                  <g key={c.id} className={`uc-v-cluster hue-${ci % 8} ${isSel ? 'sel' : ''}`} onClick={() => { if (c.entityIds[0]) onSelect(c.entityIds[0]); applyZoom(ZOOM_FOR.entities); }}>
                    <circle cx={sx(p.x)} cy={sy(p.y)} r={r} />
                    <text x={sx(p.x)} y={sy(p.y) + r + 16} textAnchor="middle">{truncateChars(clusterName(c), 16)}</text>
                    <text x={sx(p.x)} y={sy(p.y) + 5} textAnchor="middle" className="uc-v-count">{c.entityIds.length}</text>
                  </g>
                );
              }
              const rr = (layout.clusterRadius.get(c.id) ?? 30) * zoom * SCALE;
              return (
                <g key={c.id} className={`uc-v-cluster outline hue-${ci % 8} ${isSel ? 'sel' : ''}`}>
                  <circle cx={sx(p.x)} cy={sy(p.y)} r={rr} />
                  <text x={sx(p.x)} y={sy(p.y) - rr - 6} textAnchor="middle">{truncateChars(clusterName(c), 20)}</text>
                </g>
              );
            })}
            {detail !== 'clusters' && relations.map((r) => {
              const a = layout.entities.get(r.a);
              const b = layout.entities.get(r.b);
              if (!a || !b) return null;
              const on = r.a === selectedId || r.b === selectedId;
              return <line key={`${r.a}|${r.b}`} className={`uc-v-rel ${on ? 'on' : ''}`} x1={sx(a.x)} y1={sy(a.y)} x2={sx(b.x)} y2={sy(b.y)} />;
            })}
            {detail !== 'clusters' && entities.map((e) => {
              const p = layout.entities.get(e.id);
              if (!p) return null;
              const sel = e.id === selectedId;
              const showLabel = !simplified || sel;
              const ci = clusters.findIndex((c) => c.entityIds.includes(e.id));
              return (
                <g key={e.id} className={`uc-v-entity hue-${ci % 8} ${sel ? 'sel' : ''}`} onClick={() => onSelect(e.id)} data-entity-node={e.id}>
                  {sel && <circle className="uc-v-halo" cx={sx(p.x)} cy={sy(p.y)} r={19} />}
                  <rect x={sx(p.x) - (sel ? 11 : 8)} y={sy(p.y) - (sel ? 11 : 8)} width={sel ? 22 : 16} height={sel ? 22 : 16} rx={3} />
                  {showLabel && <text x={sx(p.x)} y={sy(p.y) + 26} textAnchor="middle" className={sel ? 'strong' : undefined}>{truncateChars(loc(e.name, lang), 14)}</text>}
                  {detail === 'columns' && !simplified && e.columns.slice(0, MAX_COLUMN_LABELS).map((c, k) => (
                    <text key={c.name} x={sx(p.x) + 14} y={sy(p.y) + 40 + k * 13} className="uc-v-col">{truncateChars(c.name, 16)}</text>
                  ))}
                  {detail === 'columns' && !simplified && e.columns.length > MAX_COLUMN_LABELS && (
                    <text x={sx(p.x) + 14} y={sy(p.y) + 40 + MAX_COLUMN_LABELS * 13} className="uc-v-col">{`+${e.columns.length - MAX_COLUMN_LABELS}`}</text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <p id={helpId} className="muted uc-viewer-help">{view === '3d' ? t('uc.viewer.help3d') : t('uc.viewer.help')}</p>
      <p className="uc-viewer-caption" aria-live="polite" data-testid="uc-viewer-caption">
        {t(`uc.viewer.level.${detail}`)} · {selected ? t('uc.viewer.selected', { name: loc(selected.name, lang), cluster: clusterName(selCluster) }) : t('uc.viewer.noneSelected')}
      </p>
    </div>
  );
}
