import { describe, expect, it } from 'vitest';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, Geometry } from 'geojson';
import countriesTopo from 'world-atlas/countries-50m.json';
import { visibleLabels, labelWidthPx, type LabelCandidate } from '../src/screens/mapLabels.ts';
import { buildMapView, projectedVisible } from '../src/screens/MapScreen.tsx';

describe('national map country culling', () => {
  it('the lon/lat prefilter keeps exactly the countries the projected-bounds rule keeps', () => {
    const topo = countriesTopo as unknown as Topology<{ countries: GeometryCollection }>;
    const all = (feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>).features;
    const view = buildMapView(false);
    const exact = all.filter((f) => projectedVisible(view.geoPath, f));
    expect(view.visibleCountries.map((f) => f.id)).toEqual(exact.map((f) => f.id));
    expect(exact.length).toBeGreaterThan(3);
    expect(view.paths).toEqual(exact.map((f) => view.geoPath(f) ?? ''));
  });
});

const c = (id: string, x: number, y: number, priority: number, width = 100): LabelCandidate => ({ id, x, y, width, height: 16, priority });

describe('FR-035 map label LOD', () => {
  // Tokyo HQ and Yokohama DC sit about 10 map units apart.
  const tokyo = c('hq', 500, 300, 3);
  const yokohama = c('dc', 497, 310, 1);
  const far = c('plant', 100, 100, 2);

  it('hides the lower-priority label when two overlap at the fitted zoom, and shows both when zoomed in', () => {
    expect([...visibleLabels([tokyo, yokohama, far], 1)].sort()).toEqual(['hq', 'plant']);
    expect([...visibleLabels([tokyo, yokohama, far], 3)].sort()).toEqual(['dc', 'hq', 'plant']);
  });

  it('always shows the selected site', () => {
    expect(visibleLabels([tokyo, yokohama], 1, new Set(), 'dc').has('dc')).toBe(true);
  });

  it('uses hysteresis so a label does not flicker at the threshold (PARAM-023)', () => {
    // Find the first zoom where the DC label appears when zooming in.
    let kIn = 1;
    while (!visibleLabels([tokyo, yokohama], kIn).has('dc')) kIn += 0.01;
    // Slightly below that zoom, a label that is already visible stays visible...
    expect(visibleLabels([tokyo, yokohama], kIn - 0.02, new Set(['hq', 'dc'])).has('dc')).toBe(true);
    // ...while a label that was hidden does not appear yet.
    expect(visibleLabels([tokyo, yokohama], kIn - 0.02, new Set(['hq'])).has('dc')).toBe(false);
  });

  it('estimates label widths for Japanese and English', () => {
    expect(labelWidthPx('東京本社')).toBe(48);
    expect(labelWidthPx('Tokyo HQ')).toBe(58);
  });
});
