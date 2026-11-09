import { useId } from 'react';
import type { PortraitSpec } from '../../data/schema.ts';

const SKIN: Record<PortraitSpec['skin'], [string, string]> = {
  light: ['#F5D5BC', '#E2B69A'],
  medium: ['#E2B48E', '#C9966F'],
  tan: ['#C68E64', '#A8724C'],
  deep: ['#8D5A3B', '#6E4329'],
};
const HAIR: Record<PortraitSpec['hairColor'], string> = {
  black: '#25252D',
  brown: '#6B4A2E',
  gray: '#9C9CA4',
  white: '#E8E8EC',
  auburn: '#8E3B2A',
};

export interface PortraitProps {
  spec: PortraitSpec;
  ageBand: '20s' | '30s' | '40s' | '50s' | '60s';
  gender: 'female' | 'male';
  size?: number;
  label?: string;
}

/** F-3.1.2: illustrated bust-up portrait, generated from data so every sample person has one. */
export function Portrait({ spec, ageBand, gender, size = 48, label }: PortraitProps) {
  const uid = useId().replace(/:/g, '');
  const [skin, skinShade] = SKIN[spec.skin];
  const hair = HAIR[spec.hairColor];
  const brow = spec.hairColor === 'white' ? '#9C9CA4' : hair;
  const outfit = `hsl(${spec.outfitHue} 38% 36%)`;
  const outfitLight = `hsl(${spec.outfitHue} 38% 46%)`;
  const older = ageBand === '50s' || ageBand === '60s';
  const oldest = ageBand === '60s';
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };

  return (
    <svg viewBox="0 0 120 120" width={size} height={size} {...a11y} className="art art-portrait">
      <defs>
        <radialGradient id={`bg${uid}`} cx="50%" cy="35%" r="75%">
          <stop offset="0%" stopColor={`hsl(${spec.outfitHue} 70% 88%)`} />
          <stop offset="100%" stopColor={`hsl(${spec.outfitHue} 45% 68%)`} />
        </radialGradient>
        <clipPath id={`clip${uid}`}><circle cx="60" cy="60" r="60" /></clipPath>
      </defs>
      <g clipPath={`url(#clip${uid})`}>
        <rect width="120" height="120" fill={`url(#bg${uid})`} />
        {spec.hair === 'long' && <path d="M36,50 Q32,96 42,118 L78,118 Q88,96 84,50 Z" fill={hair} />}
        <path d="M12,122 Q14,92 40,86 L80,86 Q106,92 108,122 Z" fill={outfit} />
        {gender === 'male' ? (
          <>
            <path d="M50,86 L60,106 L70,86 Z" fill="#F4F4F6" />
            <path d="M50,86 L57,112 L42,122 L38,90 Z" fill={outfitLight} />
            <path d="M70,86 L63,112 L78,122 L82,90 Z" fill={outfitLight} />
          </>
        ) : (
          <>
            <path d="M47,86 Q60,102 73,86 Z" fill="#F4F4F6" />
            <path d="M47,86 Q52,104 46,122 L38,122 L40,90 Z" fill={outfitLight} />
            <path d="M73,86 Q68,104 74,122 L82,122 L80,90 Z" fill={outfitLight} />
          </>
        )}
        <rect x="52" y="68" width="16" height="22" rx="7" fill={skinShade} />
        <ellipse cx="37.5" cy="56" rx="4" ry="6" fill={skinShade} />
        <ellipse cx="82.5" cy="56" rx="4" ry="6" fill={skinShade} />
        <ellipse cx="60" cy="52" rx="22" ry="26" fill={skin} />
        {spec.hair === 'short' && <path d="M37,50 Q36,24 60,24 Q84,24 83,50 Q78,36 60,35 Q44,35 37,50 Z" fill={hair} />}
        {spec.hair === 'crop' && <path d="M39,44 Q40,26 60,26 Q80,26 81,44 Q72,34 60,34 Q48,34 39,44 Z" fill={hair} />}
        {spec.hair === 'bob' && <path d="M35,64 Q31,24 60,24 Q89,24 85,64 L80,64 Q80,38 60,37 Q42,37 40,64 Z" fill={hair} />}
        {spec.hair === 'long' && <path d="M36,58 Q33,22 60,23 Q87,22 84,58 Q80,36 62,34 Q48,40 40,58 Z" fill={hair} />}
        {spec.hair === 'bun' && (
          <>
            <circle cx="60" cy="22" r="9" fill={hair} />
            <path d="M38,48 Q38,26 60,26 Q82,26 82,48 Q74,34 60,34 Q46,34 38,48 Z" fill={hair} />
          </>
        )}
        {spec.hair === 'receding' && (
          <>
            <path d="M37,54 Q36,38 43,32 L45,48 Z" fill={hair} />
            <path d="M83,54 Q84,38 77,32 L75,48 Z" fill={hair} />
            <path d="M46,30 Q60,25 74,30" stroke={hair} strokeWidth="2" fill="none" opacity="0.6" />
          </>
        )}
        <path d="M46,45 Q51,42.5 55,45" stroke={brow} strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <path d="M65,45 Q69,42.5 74,45" stroke={brow} strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <ellipse cx="51" cy="52" rx="2.2" ry="2.6" fill="#2A2A2E" />
        <ellipse cx="69" cy="52" rx="2.2" ry="2.6" fill="#2A2A2E" />
        <path d="M60,54 Q58,60 61,61" stroke={skinShade} strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <circle cx="46" cy="61" r="3.5" fill="#FF8A8A" opacity="0.18" />
        <circle cx="74" cy="61" r="3.5" fill="#FF8A8A" opacity="0.18" />
        {older && (
          <>
            <path d="M48,61 Q46.5,65 49,68.5" stroke={skinShade} strokeWidth="1.1" fill="none" opacity="0.8" />
            <path d="M72,61 Q73.5,65 71,68.5" stroke={skinShade} strokeWidth="1.1" fill="none" opacity="0.8" />
          </>
        )}
        {oldest && (
          <>
            <path d="M50,37 Q60,35 70,37" stroke={skinShade} strokeWidth="1" fill="none" opacity="0.7" />
            <path d="M43,51 L40.5,50 M43,53.5 L40.5,54.5 M77,51 L79.5,50 M77,53.5 L79.5,54.5" stroke={skinShade} strokeWidth="0.9" opacity="0.8" />
          </>
        )}
        {spec.beard && (
          <>
            <path d="M40,60 Q42,83 60,85 Q78,83 80,60 Q74,73 60,74 Q46,73 40,60 Z" fill={hair} opacity="0.92" />
            <path d="M52,64.5 Q60,61 68,64.5 Q60,66.5 52,64.5 Z" fill={hair} />
          </>
        )}
        <path d="M53,67 Q60,71.5 67,67" stroke={spec.beard ? '#F4E6E0' : '#9B3F3F'} strokeWidth="1.8" fill="none" strokeLinecap="round" />
        {spec.glasses && (
          <g stroke="#2E2E36" strokeWidth="1.6" fill="#FFFFFF" fillOpacity="0.1">
            <rect x="43.5" y="47" width="14.5" height="10.5" rx="4" />
            <rect x="62" y="47" width="14.5" height="10.5" rx="4" />
            <path d="M58,51 L62,51" fill="none" />
          </g>
        )}
      </g>
    </svg>
  );
}
