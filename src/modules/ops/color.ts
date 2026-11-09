/**
 * Colour maths for the brand ramp (FR-059, PARAM-017) and contrast checks (FR-060, PARAM-018/019).
 * Pure functions: shared by the app (theme) and the generation pipeline CLI (verify, self-correction).
 */

export type Rgb = { r: number; g: number; b: number };
export type Oklch = { l: number; c: number; h: number };

/** PARAM-017 */
export const RAMP_STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160] as const;
export type RampStep = (typeof RAMP_STEPS)[number];
export type Ramp = Record<RampStep, string>;

/** PARAM-018 (text) and PARAM-019 (large text / UI components). */
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_UI = 3;

/** Backgrounds the brand foreground is checked against: Fluent light/dark neutral background 1. */
export const LIGHT_BG = '#FFFFFF';
export const DARK_BG = '#292929';
/** Fluent's text colour on brand backgrounds (colorNeutralForegroundOnBrand). */
export const ON_BRAND = '#FFFFFF';

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(value: string): boolean {
  return HEX.test(value.trim());
}

export function normalizeHex(value: string): string {
  const m = HEX.exec(value.trim());
  if (!m) throw new Error(`Not a hex colour: ${value}`);
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return `#${h.toUpperCase()}`;
}

export function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(hex).slice(1);
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** sRGB → OKLCH (perceptual lightness, chroma, hue in degrees). */
export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = hexToRgb(hex);
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToLinear({ l: L, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

const inGamut = (c: Rgb) => [c.r, c.g, c.b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH → hex, reducing chroma (keeping lightness and hue) until the colour fits sRGB. */
export function oklchToHex(color: Oklch): string {
  let lin = oklchToLinear(color);
  if (!inGamut(lin)) {
    let lo = 0, hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid; else hi = mid;
    }
    lin = oklchToLinear({ ...color, c: lo });
  }
  return rgbToHex({ r: toGamma(Math.max(0, lin.r)), g: toGamma(Math.max(0, lin.g)), b: toGamma(Math.max(0, lin.b)) });
}

/** Move a colour's perceptual lightness (same hue and chroma) to the given OKLCH L. */
export function withLightness(hex: string, l: number): string {
  return oklchToHex({ ...hexToOklch(hex), l: Math.min(1, Math.max(0, l)) });
}

/**
 * Smallest lightness change that gives `fg` at least `ratio` against `bg` (FR-060 auto-correction).
 * Darkens on light backgrounds and lightens on dark ones. Returns the colour unchanged when it already passes.
 */
export function ensureContrast(fg: string, bg: string, ratio: number): string {
  const color = normalizeHex(fg);
  if (contrastRatio(color, bg) >= ratio) return color;
  const base = hexToOklch(color);
  const darken = luminance(bg) > 0.18;
  let lo = darken ? 0 : base.l, hi = darken ? base.l : 1;
  let best = darken ? '#000000' : '#FFFFFF';
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const candidate = oklchToHex({ ...base, l: mid });
    if (contrastRatio(candidate, bg) >= ratio) {
      best = candidate;
      if (darken) lo = mid; else hi = mid;
    } else if (darken) hi = mid; else lo = mid;
  }
  return best;
}

/** Perceptual lightness target of each step: even OKLCH-L steps from near-black to near-white. */
export const STEP_LIGHTNESS: Record<RampStep, number> = Object.fromEntries(
  RAMP_STEPS.map((s, i) => [s, 0.12 + (i * (0.95 - 0.12)) / (RAMP_STEPS.length - 1)]),
) as Record<RampStep, number>;

/** Steps the app theme uses as brand text/UI colours (see src/App.tsx and Fluent's createLight/DarkTheme). */
export const THEME_USES = {
  /** light theme: colorBrandForeground1 / colorBrandBackground (white text on it). */
  lightForeground: 80,
  /** dark theme: colorBrandForeground1 (App override). */
  darkForeground: 120,
  /** dark theme: compound brand (UI components, 3:1). */
  darkUi: 100,
} as const satisfies Record<string, RampStep>;

export interface RampResult {
  ramp: Ramp;
  /** The step that holds the exact primary colour (it may later be corrected for contrast). */
  primaryStep: RampStep;
  /** Steps changed by the contrast auto-correction, with their value before correction. */
  corrections: { step: RampStep; from: string; to: string; reason: 'lightText' | 'darkText' | 'darkUi' | 'order' }[];
}

/**
 * FR-059: 16-step ramp (PARAM-017) from the primary colour, with the primary's hue and (gamut-limited) chroma. A mid-tone
 * primary sits at step 80 (Fluent's brand step), other primaries at the closest step; lightness is even on each side.
 * FR-060: the steps the theme uses as text/UI colours are corrected to reach PARAM-018/019, and the ramp is kept
 * strictly increasing in luminance. `foreground`, when given and valid, is used as the light-theme brand text.
 */
export function generateRamp(primary: string, foreground?: string): RampResult {
  const p = normalizeHex(primary);
  const base = hexToOklch(p);
  // Mid-tone primaries anchor at step 80 (Fluent's brand background/text step); others at the closest fixed step.
  const anchor: RampStep = base.l >= 0.4 && base.l <= 0.7
    ? 80
    : RAMP_STEPS.reduce((best, s) => (Math.abs(STEP_LIGHTNESS[s] - base.l) < Math.abs(STEP_LIGHTNESS[best] - base.l) ? s : best), RAMP_STEPS[0]);
  const ai = RAMP_STEPS.indexOf(anchor);
  const last = RAMP_STEPS.length - 1;
  const lMin = Math.min(STEP_LIGHTNESS[10], base.l), lMax = Math.max(STEP_LIGHTNESS[160], base.l);
  const ramp = {} as Ramp;
  RAMP_STEPS.forEach((s, i) => {
    const l = i < ai ? lMin + ((base.l - lMin) * i) / ai : i > ai ? base.l + ((lMax - base.l) * (i - ai)) / (last - ai) : base.l;
    ramp[s] = oklchToHex({ l, c: base.c, h: base.h });
  });
  const primaryStep = anchor;
  ramp[primaryStep] = p;
  const corrections: RampResult['corrections'] = [];
  const set = (step: RampStep, value: string, reason: RampResult['corrections'][number]['reason']) => {
    if (value !== ramp[step]) corrections.push({ step, from: ramp[step], to: value, reason });
    ramp[step] = value;
  };
  const lf = THEME_USES.lightForeground;
  if (foreground && isHex(foreground) && contrastRatio(normalizeHex(foreground), LIGHT_BG) >= CONTRAST_TEXT) set(lf, normalizeHex(foreground), 'lightText');
  set(lf, ensureContrast(ramp[lf], LIGHT_BG, CONTRAST_TEXT), 'lightText');
  set(THEME_USES.darkUi, ensureContrast(ramp[THEME_USES.darkUi], DARK_BG, CONTRAST_UI), 'darkUi');
  set(THEME_USES.darkForeground, ensureContrast(ramp[THEME_USES.darkForeground], DARK_BG, CONTRAST_TEXT), 'darkText');
  enforceOrder(ramp, (step, value) => set(step, value, 'order'));
  return { ramp, primaryStep, corrections };
}

/** Keep luminance strictly increasing. Steps up to the light-text step are only darkened, later steps only lightened. */
function enforceOrder(ramp: Ramp, set: (step: RampStep, value: string) => void) {
  const pivot = RAMP_STEPS.indexOf(THEME_USES.lightForeground);
  const margin = (y: number) => Math.max(1e-4, y * 0.03);
  for (let i = pivot - 1; i >= 0; i--) {
    const s = RAMP_STEPS[i]!, next = RAMP_STEPS[i + 1]!;
    const yn = luminance(ramp[next]);
    if (luminance(ramp[s]) >= yn) set(s, adjustToLuminance(ramp[s], yn - margin(yn), 'below'));
  }
  for (let i = pivot + 1; i < RAMP_STEPS.length; i++) {
    const s = RAMP_STEPS[i]!, prev = RAMP_STEPS[i - 1]!;
    const yp = luminance(ramp[prev]);
    if (luminance(ramp[s]) <= yp) set(s, adjustToLuminance(ramp[s], Math.min(1, yp + margin(yp)), 'above'));
  }
}

function adjustToLuminance(hex: string, target: number, side: 'below' | 'above'): string {
  const base = hexToOklch(hex);
  let lo = 0, hi = 1;
  let best = side === 'below' ? '#000000' : '#FFFFFF';
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const c = oklchToHex({ ...base, l: mid });
    const y = luminance(c);
    if (side === 'below') {
      if (y <= target) { best = c; lo = mid; } else hi = mid;
    } else if (y >= target) { best = c; hi = mid; } else lo = mid;
  }
  return best;
}

export interface ContrastCheck {
  id: 'primaryOnLight' | 'primaryOnDark' | 'onBrandText' | 'primaryUiLight' | 'primaryUiDark';
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  pass: boolean;
}

/** FR-060: checks of the brand primary as text (4.5:1) and as a UI colour (3:1) on the app's backgrounds. */
export function contrastChecks(primary: string): ContrastCheck[] {
  const p = normalizeHex(primary);
  const mk = (id: ContrastCheck['id'], fg: string, bg: string, min: number): ContrastCheck => {
    const ratio = contrastRatio(fg, bg);
    return { id, fg, bg, ratio, min, pass: ratio >= min };
  };
  return [
    mk('primaryOnLight', p, LIGHT_BG, CONTRAST_TEXT),
    mk('primaryOnDark', p, DARK_BG, CONTRAST_TEXT),
    mk('onBrandText', ON_BRAND, p, CONTRAST_TEXT),
    mk('primaryUiLight', p, LIGHT_BG, CONTRAST_UI),
    mk('primaryUiDark', p, DARK_BG, CONTRAST_UI),
  ];
}
