import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import countriesTopo from 'world-atlas/countries-50m.json';
import { Button, Switch } from '@fluentui/react-components';
import { Add16Regular, Subtract16Regular, ZoomFit24Regular } from '@fluentui/react-icons';
import { entitiesOf, getEntity, loaded } from '../data/pack.ts';
import type { EntityOf } from '../data/schema.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion, motionMs } from '../state/motion.ts';
import { replaceQuery, useRoute } from '../state/router.ts';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { SvgEntityNode } from '../ui/SvgEntityNode.tsx';
import { labelWidthPx, visibleLabels } from './mapLabels.ts';
import { useSettings } from '../state/settings.ts';
import { isHidden } from '../ui/cardSpecs.ts';

const W = 760, H = 640;
const JAPAN_ID = '392';

const topo = countriesTopo as unknown as Topology<{ countries: GeometryCollection }>;
const countries = feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>;
const japan = countries.features.find((f) => String(f.id) === JAPAN_ID) as Feature<Geometry>;

const projection = d3.geoMercator().fitExtent([[30, 20], [W - 30, H - 20]], {
  type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[129.5, 31], [142.5, 41.5]] },
} as Feature);
const geoPath = d3.geoPath(projection);
const visibleCountries = countries.features.filter((f) => {
  const [[x0, y0], [x1, y1]] = geoPath.bounds(f);
  return x1 > 0 && x0 < W && y1 > 0 && y0 < H && Number.isFinite(x0);
});

type Site = EntityOf<'site'>;
const ROLE_SHAPE: Record<Site['role'], d3.SymbolType> = { hq: d3.symbolStar, plant: d3.symbolSquare, dc: d3.symbolDiamond };

export function MapScreen() {
  const { t, tx, fmt } = useI18n();
  const reduced = useReducedMotion();
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const sel = route.query.get('sel');
  const showFlows = route.query.get('flows') !== '0';
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [k, setK] = useState(1);
  const labelsRef = useRef<Set<string>>(new Set());
  const ROLE_PRIORITY = { hq: 3, plant: 2, dc: 1 } as const;
  const sites = entitiesOf('site');

  const flowLines = useMemo(() => loaded.pack.flows
    .filter((f) => getEntity(f.source)?.kind === 'site' && getEntity(f.target)?.kind === 'site')
    .map((f) => {
      const s = getEntity(f.source) as Site, tg = getEntity(f.target) as Site;
      return { key: `${f.source}-${f.target}`, value: f.valueT, a: projection([s.lon, s.lat])!, b: projection([tg.lon, tg.lat])! };
    }), []);

  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([1, 6]).translateExtent([[0, 0], [W, H]])
      .on('zoom', (ev) => {
        d3.select(viewportRef.current).attr('transform', ev.transform.toString());
        setK(ev.transform.k);
      });
    zoomRef.current = zoom;
    svg.call(zoom);
    return () => { svg.on('.zoom', null); };
  }, []);

  const zoomBy = (factor: number) => {
    if (!zoomRef.current) return;
    d3.select(svgRef.current!).transition().duration(motionMs(reduced, 400)).call(zoomRef.current.scaleBy, factor);
  };
  const reset = () => {
    if (!zoomRef.current) return;
    d3.select(svgRef.current!).transition().duration(motionMs(reduced, 400)).call(zoomRef.current.transform, d3.zoomIdentity);
  };
  const width = d3.scaleSqrt().domain([0, 400]).range([1, 9]);
  const selected = sel ? getEntity(sel) : undefined;

  return (
    <div className="screen screen-map">
      <PageHeader title={t('map.title')} subtitle={t('map.subtitle')} />
      <div className="split">
        <Panel
          title={t('map.panel')}
          rationale="visual.map"
          testId="map-panel"
          actions={(
            <>
              <Switch checked={showFlows} onChange={(_, d) => replaceQuery({ flows: d.checked ? undefined : '0' })} label={t('map.showFlows')} />
              <Button size="small" icon={<Add16Regular />} onClick={() => zoomBy(1.5)}>{t('map.zoomIn')}</Button>
              <Button size="small" icon={<Subtract16Regular />} onClick={() => zoomBy(1 / 1.5)}>{t('map.zoomOut')}</Button>
              <Button size="small" icon={<ZoomFit24Regular />} onClick={reset}>{t('map.reset')}</Button>
            </>
          )}
        >
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="geo-map" role="group" aria-label={t('map.aria')}>
            <rect width={W} height={H} className="geo-sea" />
            <g ref={viewportRef}>
              {visibleCountries.map((f) => (
                <path key={String(f.id)} d={geoPath(f) ?? ''} className={String(f.id) === JAPAN_ID ? 'geo-land home' : 'geo-land'} />
              ))}
              {japan && <path d={geoPath(japan) ?? ''} className="geo-outline" />}
              {showFlows && (
                <g className="geo-flows" aria-hidden>
                  {flowLines.map((l) => {
                    const mid: [number, number] = [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2 - 30];
                    return <path key={l.key} d={`M${l.a[0]},${l.a[1]} Q${mid[0]},${mid[1]} ${l.b[0]},${l.b[1]}`} strokeWidth={width(l.value) / k} className="geo-flow" />;
                  })}
                </g>
              )}
              {(() => {
                // FR-035: hide overlapping labels by priority; zooming in reveals them (with hysteresis).
                const shown = sites.filter((s) => !isHidden(s, audience));
                const next = visibleLabels(shown.map((s) => {
                  const [x, y] = projection([s.lon, s.lat])!;
                  return { id: s.id, x, y: y + (s.role === 'hq' ? -10 : 8), width: labelWidthPx(tx(s.name)), height: 16, priority: ROLE_PRIORITY[s.role] };
                }), k, labelsRef.current, sel ?? undefined);
                labelsRef.current = next;
                return null;
              })()}
              {sites.filter((s) => !isHidden(s, audience)).map((s) => {
                const [x, y] = projection([s.lon, s.lat])!;
                return (
                  <SvgEntityNode
                    key={s.id}
                    id={s.id}
                    label={`${t(`siteRole.${s.role}`)}: ${tx(s.name)}`}
                    transform={`translate(${x},${y}) scale(${1 / k})`}
                    selected={sel === s.id}
                    className={`geo-site role-${s.role} ${sel === s.id ? 'selected' : ''}`}
                    onActivate={() => replaceQuery({ sel: sel === s.id ? undefined : s.id })}
                  >
                    <circle r="18" className="geo-site-halo" />
                    <path d={d3.symbol(ROLE_SHAPE[s.role], 220)() ?? ''} className="geo-site-mark" />
                    {labelsRef.current.has(s.id) && <text x="14" y={s.role === 'hq' ? -10 : 8} className="geo-site-label" data-label-for={s.id}>{tx(s.name)}</text>}
                  </SvgEntityNode>
                );
              })}
            </g>
          </svg>
          <ul className="legend" aria-label={t('map.legend')}>
            <li><svg width="14" height="14" aria-hidden><path transform="translate(7,7)" d={d3.symbol(d3.symbolStar, 60)() ?? ''} className="geo-site-mark" /></svg> {t('siteRole.hq')}</li>
            <li><svg width="14" height="14" aria-hidden><path transform="translate(7,7)" d={d3.symbol(d3.symbolSquare, 60)() ?? ''} className="geo-site-mark" /></svg> {t('siteRole.plant')}</li>
            <li><svg width="14" height="14" aria-hidden><path transform="translate(7,7)" d={d3.symbol(d3.symbolDiamond, 60)() ?? ''} className="geo-site-mark" /></svg> {t('siteRole.dc')}</li>
            <li><span className="legend-line" aria-hidden /> {t('map.flowLegend')}</li>
          </ul>
        </Panel>
        <div className="stack">
          <Panel title={t('map.selected')} testId="map-selection">
            {selected && selected.kind === 'site' && !isHidden(selected, audience) ? (
              <div className="site-detail">
                <p><EntityRef id={selected.id} /></p>
                <h3 className="subhead">{t('map.peopleHere')}</h3>
                <ul className="ref-list">
                  {entitiesOf('person').filter((p) => p.siteId === selected.id).map((p) => <li key={p.id}><EntityRef id={p.id} image /></li>)}
                </ul>
                <h3 className="subhead">{t('map.productsHere')}</h3>
                <ul className="ref-list">
                  {entitiesOf('product').filter((p) => p.siteId === selected.id).map((p) => <li key={p.id}><EntityRef id={p.id} image /></li>)}
                </ul>
              </div>
            ) : <p className="muted">{t('map.noSelection')}</p>}
          </Panel>
          <Panel title={t('map.tableTitle')} rationale="visual.mapTable">
            <table className="data-table compact">
              <thead><tr><th scope="col">{t('field.name')}</th><th scope="col">{t('field.siteRole')}</th><th scope="col">{t('field.capacity')}</th></tr></thead>
              <tbody>
                {sites.filter((s) => !isHidden(s, audience)).map((s) => (
                  <tr key={s.id}>
                    <td><EntityRef id={s.id} /></td>
                    <td>{t(`siteRole.${s.role}`)}</td>
                    <td className="num">{s.capacityTPerMonth ? t('unit.tPerMonth', { value: fmt.integer(s.capacityTPerMonth) }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}

