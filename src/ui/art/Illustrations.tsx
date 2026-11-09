import { useId, type ReactNode } from 'react';
import type { IllustrationSpec } from '../../data/schema.ts';

interface ArtProps {
  spec: IllustrationSpec;
  size?: number;
  label?: string;
}

function Frame({ hue, size, label, children }: { hue: number; size: number; label?: string | undefined; children: (ids: { metal: string; accent: string }) => ReactNode }) {
  const uid = useId().replace(/:/g, '');
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} {...a11y} className="art">
      <defs>
        <radialGradient id={`bg${uid}`} cx="50%" cy="30%" r="80%">
          <stop offset="0%" stopColor={`hsl(${hue} 70% 90%)`} />
          <stop offset="100%" stopColor={`hsl(${hue} 50% 70%)`} />
        </radialGradient>
        <linearGradient id={`metal${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 18% 92%)`} />
          <stop offset="55%" stopColor={`hsl(${hue} 14% 70%)`} />
          <stop offset="100%" stopColor={`hsl(${hue} 18% 50%)`} />
        </linearGradient>
        <linearGradient id={`accent${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 75% 58%)`} />
          <stop offset="100%" stopColor={`hsl(${hue} 70% 40%)`} />
        </linearGradient>
      </defs>
      <circle cx="60" cy="60" r="60" fill={`url(#bg${uid})`} />
      <ellipse cx="60" cy="100" rx="38" ry="6" fill="#000" opacity="0.12" />
      {children({ metal: `url(#metal${uid})`, accent: `url(#accent${uid})` })}
    </svg>
  );
}

function gearPath(cx: number, cy: number, teeth: number, rOuter: number, rInner: number): string {
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const corners = [a - step * 0.25, a - step * 0.12, a + step * 0.12, a + step * 0.25];
    const radii = [rInner, rOuter, rOuter, rInner];
    corners.forEach((c, k) => pts.push(`${(cx + radii[k]! * Math.cos(c)).toFixed(2)},${(cy + radii[k]! * Math.sin(c)).toFixed(2)}`));
  }
  return `M${pts.join(' L')} Z`;
}

/** F-3.1.3: illustrated product image chosen by motif. */
export function ProductArt({ spec, size = 48, label }: ArtProps) {
  const h = spec.hue;
  return (
    <Frame hue={h} size={size} label={label}>
      {({ metal, accent }) => {
        switch (spec.motif) {
          case 'motor':
            return (
              <g>
                <rect x="30" y="86" width="44" height="8" rx="2" fill={`hsl(${h} 20% 35%)`} />
                <rect x="26" y="44" width="52" height="40" rx="8" fill={metal} stroke={`hsl(${h} 20% 40%)`} />
                {[34, 42, 50, 58, 66].map((x) => <rect key={x} x={x} y="46" width="3" height="36" fill={`hsl(${h} 15% 55%)`} opacity="0.6" />)}
                <ellipse cx="78" cy="64" rx="6" ry="20" fill={accent} />
                <rect x="82" y="60" width="16" height="8" rx="2" fill={metal} stroke={`hsl(${h} 20% 40%)`} />
              </g>
            );
          case 'gear':
            return (
              <g>
                <path d={gearPath(60, 58, 12, 36, 28)} fill={metal} stroke={`hsl(${h} 25% 40%)`} strokeWidth="1.5" />
                <circle cx="60" cy="58" r="16" fill={accent} />
                <circle cx="60" cy="58" r="7" fill={`hsl(${h} 70% 90%)`} />
              </g>
            );
          case 'bearing':
            return (
              <g>
                <circle cx="60" cy="58" r="34" fill="none" stroke={metal} strokeWidth="11" />
                <circle cx="60" cy="58" r="34" fill="none" stroke={`hsl(${h} 25% 40%)`} strokeWidth="1" />
                {Array.from({ length: 9 }, (_, i) => {
                  const a = (i / 9) * Math.PI * 2;
                  return <circle key={i} cx={60 + 22 * Math.cos(a)} cy={58 + 22 * Math.sin(a)} r="5.5" fill={accent} />;
                })}
                <circle cx="60" cy="58" r="13" fill="none" stroke={metal} strokeWidth="8" />
              </g>
            );
          case 'valve':
            return (
              <g>
                <rect x="16" y="66" width="88" height="14" rx="3" fill={metal} stroke={`hsl(${h} 20% 40%)`} />
                <rect x="42" y="56" width="36" height="34" rx="5" fill={metal} stroke={`hsl(${h} 20% 40%)`} />
                <rect x="46" y="22" width="28" height="32" rx="4" fill={accent} />
                <path d="M74,30 Q90,30 92,44" stroke={`hsl(${h} 20% 30%)`} strokeWidth="2.5" fill="none" />
              </g>
            );
          case 'sensor':
            return (
              <g>
                <path d="M72,60 L112,42 L112,78 Z" fill={`hsl(${h} 80% 70%)`} opacity="0.45" />
                <rect x="24" y="38" width="52" height="44" rx="9" fill={metal} stroke={`hsl(${h} 20% 40%)`} />
                <circle cx="56" cy="60" r="13" fill={accent} />
                <circle cx="52" cy="56" r="4" fill="#fff" opacity="0.7" />
                <circle cx="32" cy="46" r="2.5" fill="#3DDC84" />
              </g>
            );
          case 'arm':
            return (
              <g strokeLinecap="round">
                <rect x="22" y="88" width="40" height="8" rx="3" fill={`hsl(${h} 20% 35%)`} />
                <path d="M42,88 L46,58" stroke={accent} strokeWidth="12" />
                <path d="M46,58 L80,40" stroke={metal} strokeWidth="10" />
                <circle cx="46" cy="58" r="8" fill={`hsl(${h} 20% 30%)`} />
                <circle cx="80" cy="40" r="6" fill={`hsl(${h} 20% 30%)`} />
                <path d="M84,42 L96,50 M84,38 L98,34" stroke={`hsl(${h} 20% 30%)`} strokeWidth="4" />
              </g>
            );
          default:
            return <circle cx="60" cy="58" r="26" fill={accent} />;
        }
      }}
    </Frame>
  );
}

/** F-3.1.3: illustrated customer image: a building plus an industry emblem. */
export function CustomerArt({ spec, size = 48, label }: ArtProps) {
  const h = spec.hue;
  const glyph = `hsl(${h} 60% 36%)`;
  const emblem = (() => {
    switch (spec.motif) {
      case 'car': return <g fill={glyph}><path d="M77,40 L80,34 L92,34 L95,40 Z" /><rect x="74" y="40" width="24" height="6" rx="2" /><circle cx="80" cy="47" r="2.5" /><circle cx="92" cy="47" r="2.5" /></g>;
      case 'cross': return <g fill={glyph}><rect x="83" y="29" width="6" height="18" rx="1" /><rect x="77" y="35" width="18" height="6" rx="1" /></g>;
      case 'bolt': return <path d="M88,27 L79,40 L86,40 L83,50 L94,35 L87,35 Z" fill={glyph} />;
      case 'chip': return <g stroke={glyph} strokeWidth="1.6"><rect x="79" y="31" width="14" height="14" rx="2" fill={glyph} /><path d="M82,28 v3 M86,28 v3 M90,28 v3 M82,45 v3 M86,45 v3 M90,45 v3 M76,34 h3 M76,38 h3 M76,42 h3 M93,34 h3 M93,38 h3 M93,42 h3" /></g>;
      case 'leaf': return <g><path d="M77,47 Q77,29 95,29 Q95,47 77,47 Z" fill={glyph} /><path d="M78,46 L93,31" stroke="#fff" strokeWidth="1.2" /></g>;
      case 'robot': return <g fill={glyph}><rect x="79" y="31" width="14" height="11" rx="3" /><rect x="81" y="43" width="10" height="5" rx="1.5" /><circle cx="83" cy="36" r="1.6" fill="#fff" /><circle cx="89" cy="36" r="1.6" fill="#fff" /><path d="M86,31 V27" stroke={glyph} strokeWidth="1.5" /></g>;
      default: return <circle cx="86" cy="38" r="7" fill={glyph} />;
    }
  })();
  return (
    <Frame hue={h} size={size} label={label}>
      {() => (
        <g>
          <rect x="74" y="60" width="22" height="40" fill={`hsl(${h} 28% 46%)`} />
          <rect x="26" y="40" width="48" height="60" fill={`hsl(${h} 32% 34%)`} />
          <rect x="24" y="36" width="52" height="6" rx="1.5" fill={`hsl(${h} 60% 55%)`} />
          {Array.from({ length: 15 }, (_, k) => {
            const r = Math.floor(k / 3), c = k % 3;
            return <rect key={k} x={32 + c * 13} y={48 + r * 9} width="8" height="5" rx="1" fill="#fff" opacity={(k * 7) % 3 === 0 ? 0.45 : 0.85} />;
          })}
          {[0, 1, 2].map((r) => <rect key={r} x="79" y={66 + r * 10} width="12" height="5" rx="1" fill="#fff" opacity="0.7" />)}
          <rect x="44" y="88" width="12" height="12" rx="1" fill={`hsl(${h} 50% 22%)`} />
          <circle cx="86" cy="38" r="16" fill="#fff" stroke={`hsl(${h} 60% 45%)`} strokeWidth="2" />
          {emblem}
        </g>
      )}
    </Frame>
  );
}

export const SUPPORTED_PRODUCT_MOTIFS = ['motor', 'gear', 'bearing', 'valve', 'sensor', 'arm'] as const;
export const SUPPORTED_CUSTOMER_MOTIFS = ['car', 'cross', 'bolt', 'chip', 'leaf', 'robot'] as const;
