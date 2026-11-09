import { describe, expect, it } from 'vitest';
import { loadPack, loaded, entitiesOf, neighborhoodDepths } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { EntityKind } from '../src/data/schema.ts';
import { PARAMS } from '../src/config/params.ts';
import { SUPPORTED_CUSTOMER_MOTIFS, SUPPORTED_PRODUCT_MOTIFS } from '../src/ui/art/Illustrations.tsx';
import { cardSpecs } from '../src/ui/cardSpecs.ts';
import { kindColor, kindIcon, kindShape } from '../src/ui/icons.ts';

describe('sample pack integrity', () => {
  it('validates against the schema with no disabled items and no dangling references', () => {
    expect(loaded.issues).toEqual([]);
    expect(loaded.pack.entities.length).toBe(samplePack.entities.length);
  });

  it('ids are unique', () => {
    const ids = samplePack.entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('an invalid entity is disabled while the rest still loads (FR-102)', () => {
    const broken = structuredClone(samplePack) as unknown as { entities: Record<string, unknown>[] };
    broken.entities[0] = { ...broken.entities[0], name: { ja: '', en: 'x' } };
    const result = loadPack(broken);
    expect(result.issues.some((i) => i.path === 'entities[0]')).toBe(true);
    expect(result.pack.entities.length).toBe(samplePack.entities.length - 1);
  });

  it('the business chain customer → deal → deliverable → invoice is connected (F-3.2.4)', () => {
    const depth = neighborhoodDepths('cust-sakura-motors', 3);
    expect(depth.get('deal-sakura-ev')).toBe(1);
    expect(depth.get('dlv-sakura-ev-proto')).toBe(2);
    expect(depth.get('inv-2026-101')).toBe(3);
  });

  it('optimization input is consistent (shapes, current allocation meets demand within capacity)', () => {
    const o = samplePack.optimization;
    const P = o.plants.length, R = o.regionDemandT.length;
    for (const m of [o.transportCostPerT, o.leadTimeDays, o.co2TransportPerT, o.currentAllocation]) {
      expect(m.length).toBe(P);
      m.forEach((row) => expect(row.length).toBe(R));
    }
    o.regionDemandT.forEach((d, j) => expect(o.currentAllocation.reduce((a, row) => a + row[j]!, 0)).toBe(d));
    o.plants.forEach((p, i) => expect(o.currentAllocation[i]!.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(p.capacityT));
    expect(samplePack.regions.length).toBe(R);
  });

  it('flows conserve volume at every intermediate node', () => {
    const inflow = new Map<string, number>(), outflow = new Map<string, number>();
    for (const f of samplePack.flows) {
      outflow.set(f.source, (outflow.get(f.source) ?? 0) + f.valueT);
      inflow.set(f.target, (inflow.get(f.target) ?? 0) + f.valueT);
    }
    for (const [node, inV] of inflow) if (outflow.has(node)) expect(outflow.get(node), node).toBe(inV);
  });
});

describe('F-3.1.2 / F-3.1.3 / F-3.1.4 imagery and icons', () => {
  it('every customer and product has a supported illustration', () => {
    for (const c of entitiesOf('customer')) expect(SUPPORTED_CUSTOMER_MOTIFS as readonly string[]).toContain(c.illustration.motif);
    for (const p of entitiesOf('product')) expect(SUPPORTED_PRODUCT_MOTIFS as readonly string[]).toContain(p.illustration.motif);
  });

  it('portraits are balanced across age and gender', () => {
    const people = entitiesOf('person');
    const byGender = (g: 'female' | 'male') => people.filter((p) => p.gender === g);
    const f = byGender('female'), m = byGender('male');
    expect(Math.abs(f.length - m.length)).toBeLessThanOrEqual(PARAMS.portraitMaxGenderImbalance);
    expect(new Set(f.map((p) => p.ageBand)).size).toBeGreaterThanOrEqual(PARAMS.portraitMinAgeBandsPerGender);
    expect(new Set(m.map((p) => p.ageBand)).size).toBeGreaterThanOrEqual(PARAMS.portraitMinAgeBandsPerGender);
    // Every age band has at least one woman and one man.
    for (const band of ['20s', '30s', '40s', '50s', '60s'] as const) {
      expect(f.some((p) => p.ageBand === band), `female ${band}`).toBe(true);
      expect(m.some((p) => p.ageBand === band), `male ${band}`).toBe(true);
    }
  });

  it('every entity kind has a card spec, an icon, a color and a non-color shape', () => {
    for (const kind of EntityKind.options) {
      expect(cardSpecs[kind], kind).toBeDefined();
      expect(kindIcon[kind], kind).toBeDefined();
      expect(kindColor[kind], kind).toMatch(/^#[0-9A-F]{6}$/i);
      expect(kindShape[kind], kind).toBeDefined();
    }
  });

  it('kind colors keep ≥3:1 contrast against the dark canvas (PARAM-019)', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const bg = lum('#292929');
    for (const [kind, color] of Object.entries(kindColor)) {
      const ratio = (lum(color) + 0.05) / (bg + 0.05);
      expect(ratio, kind).toBeGreaterThanOrEqual(PARAMS.contrastGraphics);
    }
  });

  it('only sources have no drill-through destination (rendered as non-links)', () => {
    const noRoute = Object.entries(cardSpecs).filter(([, s]) => s.route === null).map(([k]) => k);
    expect(noRoute).toEqual(['source']);
  });
});
