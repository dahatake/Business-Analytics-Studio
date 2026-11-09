import { z } from 'zod';
import type { BrandVariants } from '@fluentui/react-components';
import { LText } from '../../data/schema.ts';
import { contrastChecks, generateRamp, isHex, normalizeHex, RAMP_STEPS, type ContrastCheck, type Ramp, type RampResult, THEME_USES } from './color.ts';

/** Brand tone (FR-063): how strong the show effects are. */
export const BRAND_TONES = ['formal', 'friendly', 'energetic', 'calm'] as const;
export type BrandTone = (typeof BRAND_TONES)[number];

/** FR-122: brand research source priority. The last entry is the fallback when nothing could be researched. */
export const BRAND_SOURCE_PRIORITY = ['officialSite', 'brandGuide', 'pressKit', 'irReport', 'defaultTheme'] as const;
export type BrandSourceKind = (typeof BRAND_SOURCE_PRIORITY)[number];

const Hex = z.string().refine(isHex, { message: 'expected a hex colour such as #0F6CBD' });
/** Logo files live inside the pack (public/brand/). Remote URLs are refused (C-01: no external fetch at runtime). */
const LocalPath = z.string().min(1).refine((s) => !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('//') && !s.includes('..'), {
  message: 'logo must be a relative path inside the pack (for example brand/logo.svg)',
});

/** FR-061: logo usage conditions. */
export const LogoUsage = z.object({
  src: LocalPath,
  alt: LText,
  /** Minimum rendered width in CSS px. */
  minWidthPx: z.number().positive(),
  /** Clear space around the logo as a ratio of its height. */
  clearSpaceRatio: z.number().min(0).max(2),
  /** Backgrounds the logo may be placed on. */
  backgrounds: z.array(z.enum(['light', 'dark'])).min(1),
});
export type LogoUsage = z.infer<typeof LogoUsage>;

/** Brand profile: `extensions.brand` of a customer pack (files in public/brand/). */
export const BrandProfile = z.object({
  primary: Hex,
  /** Optional explicit brand text colour for light backgrounds (set by self-correction when the primary is too light). */
  foreground: Hex.optional(),
  logo: LogoUsage.optional(),
  /** FR-062: brand font family; fallbacks always end with the Fluent default stack. */
  fonts: z.object({ family: z.string().min(1), fallbacks: z.array(z.string().min(1)) }).optional(),
  tone: z.enum(BRAND_TONES).optional(),
  /** FR-122: where the brand came from. */
  source: z.object({ kind: z.enum(BRAND_SOURCE_PRIORITY), reference: z.string().optional(), fetchedAt: z.string().optional() }).optional(),
});
export type BrandProfile = z.infer<typeof BrandProfile>;

/** Fluent 2 default stack (FR-062 fallback). */
export const FLUENT_FONT_STACK = "'Segoe UI', 'Segoe UI Web (West European)', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif";
/** The template's built-in brand: the default theme (FR-122 fallback). */
export const DEFAULT_PRIMARY = '#1267B4';

/** Quote a family name for CSS when needed, and refuse characters that could break out of the declaration. */
export function cssFamily(name: string): string {
  const clean = name.replace(/["';{}<>\\]/g, '').trim();
  return /^[a-z-]+$/i.test(clean) ? clean : `'${clean}'`;
}

export function fontStack(fonts: BrandProfile['fonts'] | undefined): string {
  if (!fonts) return FLUENT_FONT_STACK;
  const names = [fonts.family, ...fonts.fallbacks].map(cssFamily).filter((n) => n && n !== "''");
  return [...names, FLUENT_FONT_STACK].join(', ');
}

export type BrandParse = { ok: true; profile: BrandProfile | null } | { ok: false; issues: string[] };

/** Read and validate `extensions.brand`. Missing → null (default theme). Invalid → issues (the default theme is used). */
export function parseBrand(extensions: Record<string, unknown> | undefined): BrandParse {
  const raw = extensions?.brand;
  if (raw === undefined) return { ok: true, profile: null };
  const r = BrandProfile.safeParse(raw);
  if (r.success) return { ok: true, profile: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${['brand', ...i.path].join('.')}: ${i.message}`) };
}

export interface BrandOverride {
  primary: string | null;
  tone: BrandTone | null;
  fontFamily: string | null;
}

export const NO_OVERRIDE: BrandOverride = { primary: null, tone: null, fontFamily: null };

export interface ResolvedBrand {
  origin: 'override' | 'pack' | 'default';
  primary: string;
  ramp: Ramp;
  variants: BrandVariants;
  primaryStep: RampResult['primaryStep'];
  corrections: RampResult['corrections'];
  checks: ContrastCheck[];
  /** FR-060: the brand text colours the theme actually uses (after correction). */
  applied: { lightForeground: string; darkForeground: string };
  tone: BrandTone;
  fonts: BrandProfile['fonts'];
  logo: LogoUsage | undefined;
  issues: string[];
}

export function toVariants(ramp: Ramp): BrandVariants {
  const v = {} as Record<number, string>;
  for (const s of RAMP_STEPS) v[s] = ramp[s];
  return v as unknown as BrandVariants;
}

/** Combine the pack's brand profile with the user's override (FR-064). The default theme stays untouched. */
export function resolveBrand(parse: BrandParse, override: BrandOverride, defaults: BrandVariants): ResolvedBrand {
  const profile = parse.ok ? parse.profile : null;
  const issues = parse.ok ? [] : parse.issues;
  const overridePrimary = override.primary && isHex(override.primary) ? normalizeHex(override.primary) : null;
  // A pack that fell back to the default theme (FR-122) keeps the template's hand-tuned ramp.
  const packIsDefault = profile?.source?.kind === 'defaultTheme' && isHex(profile.primary) && normalizeHex(profile.primary) === DEFAULT_PRIMARY;
  const origin: ResolvedBrand['origin'] = overridePrimary ? 'override' : profile && !packIsDefault ? 'pack' : 'default';
  const primary = overridePrimary ?? (profile ? normalizeHex(profile.primary) : DEFAULT_PRIMARY);
  const fonts = override.fontFamily ? { family: override.fontFamily, fallbacks: profile?.fonts?.fallbacks ?? [] } : profile?.fonts;
  const tone = override.tone ?? profile?.tone ?? 'formal';
  let ramp: Ramp, primaryStep: RampResult['primaryStep'], corrections: RampResult['corrections'];
  if (origin === 'default') {
    ramp = {} as Ramp;
    for (const s of RAMP_STEPS) ramp[s] = (defaults as unknown as Record<number, string>)[s]!;
    primaryStep = 80;
    corrections = [];
  } else {
    ({ ramp, primaryStep, corrections } = generateRamp(primary, origin === 'pack' ? profile?.foreground : undefined));
  }
  return {
    origin,
    primary,
    ramp,
    variants: origin === 'default' ? defaults : toVariants(ramp),
    primaryStep,
    corrections,
    checks: contrastChecks(primary),
    applied: { lightForeground: ramp[THEME_USES.lightForeground], darkForeground: ramp[THEME_USES.darkForeground] },
    tone,
    fonts,
    logo: profile?.logo,
    issues,
  };
}
