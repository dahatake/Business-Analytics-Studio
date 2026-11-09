import { describe, expect, it } from 'vitest';
import { dofActive, dofAllowed, dofBlockReason, focusDistance } from '../src/modules/threed/dof.ts';
import { DOWNGRADE_ORDER, nextDowngrade, QualityController } from '../src/modules/threed/quality.ts';
import { tdEn } from '../src/i18n/modules/td.en.ts';

describe('FR-067 depth of field enable rule', () => {
  const ok = { quality: 'high', cinematic: true, reducedMotion: false } as const;

  it('allowed only for High + cinematic effects + full motion', () => {
    expect(dofAllowed(ok)).toBe(true);
    expect(dofBlockReason(ok)).toBeNull();
    expect(dofBlockReason({ ...ok, quality: 'medium' })).toBe('quality');
    expect(dofBlockReason({ ...ok, quality: 'low' })).toBe('quality');
    expect(dofBlockReason({ ...ok, cinematic: false })).toBe('cinematic');
    expect(dofBlockReason({ ...ok, reducedMotion: true })).toBe('reducedMotion');
  });

  it('reduced motion is reported first, then quality', () => {
    expect(dofBlockReason({ quality: 'low', cinematic: false, reducedMotion: true })).toBe('reducedMotion');
    expect(dofBlockReason({ quality: 'low', cinematic: false, reducedMotion: false })).toBe('quality');
  });

  it('is off by default (must be requested) and never on when blocked', () => {
    expect(dofActive(false, ok)).toBe(false);
    expect(dofActive(true, ok)).toBe(true);
    expect(dofActive(true, { ...ok, reducedMotion: true })).toBe(false);
    expect(dofActive(true, { ...ok, quality: 'medium' })).toBe(false);
  });

  it('every block reason has a message', () => {
    for (const r of ['quality', 'cinematic', 'reducedMotion']) expect(tdEn[`td.dof.reason.${r}` as keyof typeof tdEn]).toBeTruthy();
  });
});

describe('FR-067 focus distance', () => {
  it('is the distance from the camera to the focus point', () => {
    expect(focusDistance([0, 0, 0], [3, 4, 0], 0.1, 1000)).toBeCloseTo(5);
    expect(focusDistance([1, 2, 3], [1, 2, 13], 0.1, 1000)).toBeCloseTo(10);
  });

  it('stays inside the clip range', () => {
    expect(focusDistance([0, 0, 0], [0, 0, 0], 0.1, 1000)).toBe(0.1);
    expect(focusDistance([0, 0, 0], [5000, 0, 0], 0.1, 1000)).toBe(1000);
    expect(focusDistance([0, 0, 0], [Number.NaN, 0, 0], 0.1, 1000)).toBe(0.1);
  });
});

describe('FR-067/069 downgrade order: DOF first, then the preset', () => {
  it('order', () => {
    expect(DOWNGRADE_ORDER).toEqual(['dof', 'quality']);
    expect(nextDowngrade({ dofActive: true, quality: 'high', auto: true })).toBe('dof');
    expect(nextDowngrade({ dofActive: false, quality: 'high', auto: true })).toBe('quality');
    expect(nextDowngrade({ dofActive: false, quality: 'low', auto: true })).toBeNull();
    expect(nextDowngrade({ dofActive: true, quality: 'high', auto: false })).toBe('dof');
    expect(nextDowngrade({ dofActive: false, quality: 'high', auto: false })).toBeNull();
  });

  it('after 2 s below 45 fps DOF goes off; the preset drops only after another 2 s', () => {
    const q = new QualityController('high', true);
    let dof = true;
    const changes: string[] = [];
    for (let t = 0; t <= 6000; t += 500) {
      const c = q.sample(30, t, dof);
      if (c?.reason === 'dofOff') dof = false;
      if (c) changes.push(`${t}:${c.reason}:${c.to}`);
    }
    expect(changes[0]).toBe('2000:dofOff:high');
    expect(changes[1]).toBe('4500:downgrade:medium');
  });

  it('DOF is not dropped before the 2 s hold, and a good sample restarts the timer', () => {
    const q = new QualityController('high', true);
    for (let t = 0; t < 2000; t += 500) expect(q.sample(30, t, true)).toBeNull();
    q.sample(50, 1900, true);
    for (let t = 2400; t < 4400; t += 500) expect(q.sample(30, t, true)).toBeNull();
    expect(q.sample(30, 4400, true)?.reason).toBe('dofOff');
    expect(q.current).toBe('high');
  });

  it('manual quality still drops DOF but never the preset', () => {
    const q = new QualityController('high', false);
    let dof = true;
    const reasons: string[] = [];
    for (let t = 0; t <= 10_000; t += 500) {
      const c = q.sample(20, t, dof);
      if (c) reasons.push(c.reason);
      if (c?.reason === 'dofOff') dof = false;
    }
    expect(reasons).toEqual(['dofOff']);
    expect(q.current).toBe('high');
  });

  it('without DOF the controller behaves as before', () => {
    const q = new QualityController('high', true);
    for (let t = 0; t < 2000; t += 500) q.sample(30, t);
    expect(q.sample(30, 2000)).toEqual({ from: 'high', to: 'medium', reason: 'downgrade' });
  });
});
