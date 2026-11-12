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
import { ContextualScene } from '../modules/threed/ContextualScene.tsx';

const W = 760, H = 640;
const JAPAN_ID = '392';

const topo = countriesTopo as unknown as Topology<{ countries: GeometryCollection }>;
const countries = feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>;
const japan = countries.features.find((f) => String(f.id) === JAPAN_ID) as Feature<Geometry>;

/** Japan-only packs keep the detailed national view; any site abroad switches to the world map. */
export const inJapan = (s: { lat: number; lon: number }) => s.lat >= 20 && s.lat <= 46.5 && s.lon >= 122 && s.lon <= 154;

export interface MapView {
  projection: d3.GeoProjection;
  geoPath: d3.GeoPath;
  visibleCountries: Feature<Geometry, { name: string }>[];
  /** Path data parallel to visibleCountries, built once: zooming re-renders the map and must not re-project 50m outlines. */
  paths: string[];
  japanOutline: string;
}

/** The exact rule: a country is drawn when its projected bounds overlap the map. */
export function projectedVisible(geoPath: d3.GeoPath, f: Feature<Geometry>) {
  const [[x0, y0], [x1, y1]] = geoPath.bounds(f);
  return x1 > 0 && x0 < W && y1 > 0 && y0 < H && Number.isFinite(x0);
}

function lonLatBox(g: Geometry | null): [number, number, number, number] | null {
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return null;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let lon0 = Infinity, lat0 = Infinity, lon1 = -Infinity, lat1 = -Infinity;
  for (const poly of polys) for (const ring of poly) for (const [lon, lat] of ring) {
    if (lon! < lon0) lon0 = lon!;
    if (lon! > lon1) lon1 = lon!;
    if (lat! < lat0) lat0 = lat!;
    if (lat! > lat1) lat1 = lat!;
  }
  return Number.isFinite(lon0) ? [lon0, lat0, lon1, lat1] : null;
}

/** Degrees added around the visible area so great-circle edges between vertices can never be cut off wrongly. */
const PREFILTER_MARGIN_DEG = 2;

/**
 * Same result as filtering with projectedVisible, but Mercator maps longitude and latitude independently, so countries
 * whose vertices all lie well outside the visible lon/lat rectangle are skipped without projecting their outlines.
 */
export function visibleOnMercator(projection: d3.GeoProjection, geoPath: d3.GeoPath, features: Feature<Geometry, { name: string }>[]) {
  const [lonMin, latMax] = projection.invert!([0, 0])!;
  const [lonMax, latMin] = projection.invert!([W, H])!;
  return features.filter((f) => {
    const box = lonLatBox(f.geometry);
    if (box && box[2] - box[0] < 180) {
      const [lon0, lat0, lon1, lat1] = box;
      if (lon1 < lonMin - PREFILTER_MARGIN_DEG || lon0 > lonMax + PREFILTER_MARGIN_DEG
        || lat1 < latMin - PREFILTER_MARGIN_DEG || lat0 > latMax + PREFILTER_MARGIN_DEG) return false;
    }
    return projectedVisible(geoPath, f);
  });
}

export function buildMapView(world: boolean): MapView {
  const projection = world
    ? d3.geoNaturalEarth1().fitExtent([[10, 10], [W - 10, H - 10]], { type: 'Sphere' } as unknown as Feature)
    : d3.geoMercator().fitExtent([[30, 20], [W - 30, H - 20]], {
      type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[129.5, 31], [142.5, 41.5]] },
    } as Feature);
  const geoPath = d3.geoPath(projection);
  const visibleCountries = world ? countries.features : visibleOnMercator(projection, geoPath, countries.features);
  const paths = visibleCountries.map((f) => geoPath(f) ?? '');
  return { projection, geoPath, visibleCountries, paths, japanOutline: !world && japan ? geoPath(japan) ?? '' : '' };
}

const mapViews = new Map<boolean, MapView>();
/** The projection and outlines depend only on the static atlas and the view, so each view is built once per session. */
function mapView(world: boolean): MapView {
  let view = mapViews.get(world);
  if (!view) mapViews.set(world, view = buildMapView(world));
  return view;
}

type Site = EntityOf<'site'>;
const ROLE_SHAPE: Record<Site['role'], d3.SymbolType> = { hq: d3.symbolStar, plant: d3.symbolSquare, dc: d3.symbolDiamond, office: d3.symbolCircle };

export function MapScreen() {
  const { t } = useI18n();
  return (
    <div className="screen screen-map">
      <PageHeader title={t('map.title')} subtitle={t('map.subtitle')} />
      <ContextualScene tab="map">
        <MapContents />
      </ContextualScene>
    </div>
  );
}

function MapContents() {
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
  const ROLE_PRIORITY = { hq: 3, plant: 2, dc: 1, office: 1 } as const;
  const sites = entitiesOf('site');
  const world = sites.some((s) => !inJapan(s));
  const { projection, visibleCountries, paths, japanOutline } = useMemo(() => mapView(world), [world]);
  // On the world map, countries with a site are highlighted (Japan on the national map).
  const siteKey = sites.map((s) => `${s.lon},${s.lat}`).join(';');
  const homeIds = useMemo(() => new Set(world
    ? countries.features.filter((f) => sites.some((s) => d3.geoContains(f, [s.lon, s.lat]))).map((f) => String(f.id))
    : [JAPAN_ID]), [world, siteKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const roles = [...new Set(sites.map((s) => s.role))];

  const flowLines = useMemo(() => loaded.pack.flows
    .filter((f) => getEntity(f.source)?.kind === 'site' && getEntity(f.target)?.kind === 'site')
    .map((f) => {
      const s = getEntity(f.source) as Site, tg = getEntity(f.target) as Site;
      return { key: `${f.source}-${f.target}`, value: f.valueT, a: projection([s.lon, s.lat])!, b: projection([tg.lon, tg.lat])! };
    }), [projection]);

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
              {visibleCountries.map((f, i) => (
                <path key={String(f.id)} d={paths[i]} className={homeIds.has(String(f.id)) ? 'geo-land home' : 'geo-land'} />
              ))}
              {!world && japan && <path d={japanOutline} className="geo-outline" />}
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
            {(roles.length ? roles : (['hq', 'plant', 'dc'] as const)).map((r) => (
              <li key={r}><svg width="14" height="14" aria-hidden><path transform="translate(7,7)" d={d3.symbol(ROLE_SHAPE[r], 60)() ?? ''} className="geo-site-mark" /></svg> {t(`siteRole.${r}`)}</li>
            ))}
            {flowLines.length > 0 && <li><span className="legend-line" aria-hidden /> {t('map.flowLegend')}</li>}
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
  );
}

