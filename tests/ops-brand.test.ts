import { describe, expect, it } from 'vitest';
import { contrastChecks, contrastRatio, CONTRAST_TEXT, CONTRAST_UI, DARK_BG, ensureContrast, generateRamp, hexToOklch, LIGHT_BG, luminance, normalizeHex, RAMP_STEPS, THEME_USES } from '../src/modules/ops/color.ts';
import { DEFAULT_PRIMARY, fontStack, FLUENT_FONT_STACK, NO_OVERRIDE, parseBrand, resolveBrand } from '../src/modules/ops/brand.ts';
import { DEFAULT_BRAND } from '../src/modules/ops/theme.ts';
import { INDUSTRY_PRESETS } from '../src/modules/ops/presets.ts';

const PRIMARIES = ['#0F6CBD', '#C239B3', '#FFE600', '#1A1F4D', '#00A86B', '#E81123', '#FFFFFF', '#000000', '#777777', '#7FBA00'];

describe('FR-059 brand ramp (PARAM-017)', () => {
  for (const primary of PRIMARIES) {
    it(`${primary}: 16 steps, strictly increasing luminance, includes the primary or its contrast correction`, () => {
      const { ramp, primaryStep, corrections } = generateRamp(primary);
      expect(Object.keys(ramp).map(Number)).toEqual([...RAMP_STEPS]);
      expect(RAMP_STEPS).toHaveLength(16);
      for (let i = 1; i < RAMP_STEPS.length; i++) {
        expect(luminance(ramp[RAMP_STEPS[i]!]), `${RAMP_STEPS[i]} > ${RAMP_STEPS[i - 1]}`).toBeGreaterThan(luminance(ramp[RAMP_STEPS[i - 1]!]));
      }
      const corrected = corrections.find((c) => c.step === primaryStep);
      if (corrected) expect(corrected.from === normalizeHex(primary) || corrections.some((c) => c.from === normalizeHex(primary))).toBe(true);
      else expect(ramp[primaryStep]).toBe(normalizeHex(primary));
    });
  }

  it('places the primary at the step closest in perceptual lightness', () => {
    const { primaryStep } = generateRamp('#0F6CBD');
    expect(primaryStep).toBe(80);
    expect(generateRamp('#FFE600').primaryStep).toBeGreaterThanOrEqual(140);
    expect(generateRamp('#1A1F4D').primaryStep).toBeLessThanOrEqual(40);
  });

  it('keeps the hue of the primary across the mid steps', () => {
    const { ramp } = generateRamp('#C239B3');
    const h = hexToOklch('#C239B3').h;
    for (const s of [50, 60, 90, 100, 110]) expect(Math.abs(hexToOklch(ramp[s as 50]).h - h)).toBeLessThan(6);
  });
});

describe('FR-060 contrast check and correction (PARAM-018/019)', () => {
  it('contrast ratio matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('ensureContrast reaches 4.5:1 on light and dark backgrounds with a minimal change', () => {
    for (const c of PRIMARIES) {
      for (const bg of [LIGHT_BG, DARK_BG]) {
        const fixed = ensureContrast(c, bg, CONTRAST_TEXT);
        expect(contrastRatio(fixed, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(CONTRAST_TEXT);
        if (contrastRatio(c, bg) >= CONTRAST_TEXT) expect(fixed).toBe(normalizeHex(c));
      }
    }
    // Minimal: the corrected yellow is close to the 4.5:1 boundary, not black.
    expect(contrastRatio(ensureContrast('#FFE600', LIGHT_BG, CONTRAST_TEXT), LIGHT_BG)).toBeLessThan(4.8);
  });

  it('the ramp steps used by the theme always pass (light text 80, dark text 120, dark UI 100)', () => {
    for (const c of PRIMARIES) {
      const { ramp } = generateRamp(c);
      expect(contrastRatio(ramp[THEME_USES.lightForeground], LIGHT_BG), c).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio('#FFFFFF', ramp[70]), c).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio(ramp[THEME_USES.darkForeground], DARK_BG), c).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio(ramp[THEME_USES.darkUi], DARK_BG), c).toBeGreaterThanOrEqual(CONTRAST_UI);
    }
  });

  it('a primary that fails at its own step is corrected (auto-correction of the brand foreground)', () => {
    // #2E86DE sits at step 80 but is too light for white backgrounds.
    expect(contrastRatio('#2E86DE', LIGHT_BG)).toBeLessThan(CONTRAST_TEXT);
    const { ramp, primaryStep, corrections } = generateRamp('#2E86DE');
    expect(primaryStep).toBe(80);
    expect(corrections.some((c) => c.step === 80 && c.from === '#2E86DE' && c.reason === 'lightText')).toBe(true);
    expect(contrastRatio(ramp[80], LIGHT_BG)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
  });

  it('500 random primaries: always monotonic and the theme steps always pass', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 500; n++) {
      const c = `#${[0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('')}`;
      const { ramp } = generateRamp(c);
      for (let i = 1; i < RAMP_STEPS.length; i++) expect(luminance(ramp[RAMP_STEPS[i]!]), c).toBeGreaterThan(luminance(ramp[RAMP_STEPS[i - 1]!]));
      expect(contrastRatio(ramp[80], LIGHT_BG), c).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio(ramp[120], DARK_BG), c).toBeGreaterThanOrEqual(CONTRAST_TEXT);
    }
  });

  it('reports failing checks for a low-contrast primary', () => {
    const checks = contrastChecks('#FFE600');
    expect(checks.find((c) => c.id === 'primaryOnLight')!.pass).toBe(false);
    expect(checks.find((c) => c.id === 'primaryOnDark')!.pass).toBe(true);
    expect(checks.filter((c) => c.min === CONTRAST_UI)).toHaveLength(2);
  });
});

describe('Brand profile (FR-061〜FR-064)', () => {
  it('no brand → the default theme ramp unchanged', () => {
    const r = resolveBrand(parseBrand(undefined), NO_OVERRIDE, DEFAULT_BRAND);
    expect(r.origin).toBe('default');
    expect(r.variants).toBe(DEFAULT_BRAND);
    expect(r.primary).toBe(DEFAULT_PRIMARY);
  });

  it('a default-theme brand from research keeps the template ramp (FR-122)', () => {
    const r = resolveBrand(parseBrand({ brand: { primary: DEFAULT_PRIMARY, source: { kind: 'defaultTheme' } } }), NO_OVERRIDE, DEFAULT_BRAND);
    expect(r.origin).toBe('default');
  });

  it('pack brand and override generate a new ramp; override wins', () => {
    const pack = parseBrand({ brand: { primary: '#00A86B', tone: 'calm', fonts: { family: 'Noto Sans JP', fallbacks: ['Meiryo'] } } });
    const p = resolveBrand(pack, NO_OVERRIDE, DEFAULT_BRAND);
    expect(p.origin).toBe('pack');
    expect(p.tone).toBe('calm');
    const o = resolveBrand(pack, { primary: '#c239b3', tone: 'energetic', fontFamily: null }, DEFAULT_BRAND);
    expect(o.origin).toBe('override');
    expect(o.primary).toBe('#C239B3');
    expect(o.tone).toBe('energetic');
    expect(o.variants[80]).not.toBe(p.variants[80]);
  });

  it('pack foreground is used as the light brand text when it passes', () => {
    const r = resolveBrand(parseBrand({ brand: { primary: '#FFE600', foreground: '#6B5E00' } }), NO_OVERRIDE, DEFAULT_BRAND);
    expect(r.applied.lightForeground).toBe('#6B5E00');
  });

  it('rejects invalid brands and remote logos (C-01), falling back to the default theme', () => {
    const bad = parseBrand({ brand: { primary: 'blue', logo: { src: 'https://example.com/logo.svg', alt: { ja: 'ロゴ', en: 'Logo' }, minWidthPx: 80, clearSpaceRatio: 0.5, backgrounds: ['light'] } } });
    expect(bad.ok).toBe(false);
    const r = resolveBrand(bad, NO_OVERRIDE, DEFAULT_BRAND);
    expect(r.origin).toBe('default');
    expect(r.issues.join(' ')).toMatch(/brand\.primary/);
    expect(r.issues.join(' ')).toMatch(/brand\.logo\.src/);
  });

  it('font stack keeps Fluent fallbacks and refuses CSS injection (FR-062)', () => {
    expect(fontStack(undefined)).toBe(FLUENT_FONT_STACK);
    const s = fontStack({ family: 'Noto Sans JP', fallbacks: ['Meiryo', "x'; } body { color: red"] });
    expect(s.startsWith("'Noto Sans JP', Meiryo, ")).toBe(true);
    expect(s.endsWith(FLUENT_FONT_STACK)).toBe(true);
    expect(s).not.toMatch(/[{};]/);
  });
});

describe('FR-103 industry presets (PARAM-016)', () => {
  it('has at least 5 presets with scene, camera path, icons and core object', () => {
    expect(INDUSTRY_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const id of ['manufacturing', 'retail', 'finance', 'healthcare', 'logistics']) expect(INDUSTRY_PRESETS.some((p) => p.id === id)).toBe(true);
    for (const p of INDUSTRY_PRESETS) {
      expect(p.sceneType && p.cameraPath && p.iconSet && p.coreObject.kind).toBeTruthy();
      expect(p.industry.en).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff]/);
    }
    expect(new Set(INDUSTRY_PRESETS.map((p) => p.id)).size).toBe(INDUSTRY_PRESETS.length);
  });
});
