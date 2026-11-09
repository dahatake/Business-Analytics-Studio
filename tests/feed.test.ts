import { describe, expect, it } from 'vitest';
import { freshness, percentile, createGenerator } from '../src/state/feed.ts';
import { PARAMS } from '../src/config/params.ts';
import { getEntity } from '../src/data/pack.ts';

describe('F-3.4.1 live feed logic', () => {
  const I = PARAMS.liveFeedIntervalMs;

  it('classifies freshness by age relative to the interval', () => {
    expect(freshness(null, 0, false, I)).toBe('waiting');
    expect(freshness(1000, 1000 + I, false, I)).toBe('fresh');
    expect(freshness(1000, 1000 + I * PARAMS.liveFeedFreshFactor + 1, false, I)).toBe('stale');
    expect(freshness(1000, 1000 + I * PARAMS.liveFeedStaleFactor + 1, false, I)).toBe('stopped');
    expect(freshness(1000, 1000 + I * 100, true, I)).toBe('paused');
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 95)).toBeNaN();
    expect(percentile([5], 95)).toBe(5);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
  });

  it('the simulated generator is deterministic and only references shareable, existing entities', () => {
    const a = createGenerator(7), b = createGenerator(7);
    for (let i = 0; i < 200; i++) {
      const x = a(), y = b();
      expect({ ...x, at: 0, perf: 0 }).toEqual({ ...y, at: 0, perf: 0 });
      const e = getEntity(x.entityId);
      expect(e, x.entityId).toBeDefined();
      expect(e!.classification).toBe('shareable');
      if (x.secondaryId) expect(getEntity(x.secondaryId)).toBeDefined();
    }
  });
});
