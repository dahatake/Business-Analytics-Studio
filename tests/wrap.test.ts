import { describe, expect, it } from 'vitest';
import { emWidth, wrap } from '../src/ui/textWrap.ts';
import { samplePack } from '../src/data/sample.ts';

describe('diagram label wrapping (WCAG 2.5.3: never truncate visible names)', () => {
  it('keeps every character of every sample name, in both languages', () => {
    for (const e of samplePack.entities) {
      for (const text of [e.name.ja, e.name.en]) {
        const lines = wrap(text, 14);
        expect(lines.join('').trim()).toBe(text);
      }
    }
  });

  it('respects the width budget for Latin and CJK text', () => {
    for (const text of ['First mass-production lot for the EV drive unit', '受注から出荷までのリードタイムを短縮する施策']) {
      for (const line of wrap(text, 14)) expect(emWidth(line.trimEnd())).toBeLessThanOrEqual(14);
    }
  });

  it('fits chain-diagram names in two lines', () => {
    const chainKinds = new Set(['customer', 'deal', 'deliverable', 'invoice']);
    for (const e of samplePack.entities.filter((x) => chainKinds.has(x.kind))) {
      expect(wrap(e.name.ja, 14).length, e.name.ja).toBeLessThanOrEqual(2);
      expect(wrap(e.name.en, 14).length, e.name.en).toBeLessThanOrEqual(2);
    }
  });
});

