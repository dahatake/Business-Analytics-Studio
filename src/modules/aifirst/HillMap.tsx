import type { KeyboardEvent } from 'react';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { LOOP_STEPS, STAGES, stageIndex, type AreaView, type Stage } from './model.ts';

/**
 * FR-386: the hill seen from above. Contour lines are the stages (outer P0 → summit P4), each business area climbs its own
 * trail (its own angle), and each marker is the area's loop in four parts. A staircase or an arrow would say "one road,
 * in order"; a contour map shows several heights at once, progress ahead of the position, and that the summit is a state
 * of climbing (the loop keeps turning), not a finish line.
 */

const W = 800;
const H = 600;
const CX = W / 2;
const CY = H / 2;
/** Inner and outer radius of each stage's band. */
export const BANDS: Record<Stage, [number, number]> = { p0: [214, 268], p1: [166, 214], p2: [120, 166], p3: [74, 120], p4: [0, 74] };
const STEP_ARC: Record<(typeof LOOP_STEPS)[number], [number, number]> = { run: [-90, 0], observe: [0, 90], evaluate: [90, 180], improve: [180, 270] };

const rad = (deg: number) => (deg * Math.PI) / 180;
const polar = (r: number, deg: number): [number, number] => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg))];

/** A closed contour line that wobbles a little, so the rings read as terrain rather than a target. */
function contour(r: number, k: number): string {
  if (r <= 0) return '';
  const pts: string[] = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * 2 * Math.PI;
    const rr = r + 3.2 * Math.sin(3 * a + k) + 2.2 * Math.sin(5 * a + 2 * k);
    pts.push(`${(CX + rr * Math.cos(a)).toFixed(1)},${(CY + rr * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = [cx + r * Math.cos(rad(from)), cy + r * Math.sin(rad(from))];
  const [x2, y2] = [cx + r * Math.cos(rad(to)), cy + r * Math.sin(rad(to))];
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

/** Where an area stands: deeper into its band the more of the band's gate it has met. */
export function markerRadius(a: Pick<AreaView, 'position' | 'fraction' | 'summit'>): number {
  if (a.summit) return 26;
  const [inner, outer] = BANDS[a.position];
  const span = outer - inner;
  return outer - Math.min(0.85, Math.max(0.15, a.fraction)) * span;
}

export const areaAngle = (i: number, n: number) => -90 + ((i + 0.5) * 360) / Math.max(n, 1);
const mid = (s: Stage) => (s === 'p4' ? 40 : (BANDS[s][0] + BANDS[s][1]) / 2);
type SvgKey = KeyboardEvent<SVGGElement>;

export function HillMap({ areas, selected, onSelect }: { areas: AreaView[]; selected: string | null; onSelect: (id: string) => void }) {
  const { t, lang } = useI18n();
  const key = (id: string) => (e: SvgKey) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  };
  return (
    <svg className="aif-map" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={t('aif.map.title')} data-testid="aif-map-svg">
      <defs>
        <marker id="aif-summit-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="aif-summit-arrowhead" />
        </marker>
      </defs>
      {STAGES.map((s, i) => (
        <path key={s} d={contour(BANDS[s][1], i * 1.7)} className={`aif-band aif-band-${s}`} data-stage={s} />
      ))}
      <path d={arc(CX, CY, 40, -60, 230)} className="aif-summit-loop" markerEnd="url(#aif-summit-arrow)" aria-hidden="true" />
      <text x={CX} y={CY + 4} textAnchor="middle" className="aif-summit-label">{t('aif.map.summit')}</text>
      {STAGES.map((s) => {
        const [, outer] = BANDS[s];
        const y = CY - outer + (s === 'p4' ? 18 : 20);
        return <text key={s} x={CX} y={y} textAnchor="middle" className="aif-stage-label" data-stage-label={s}>{t(`aif.stage.${s}`)}</text>;
      })}
      {areas.map((a, i) => {
        const angle = areaAngle(i, areas.length);
        const r = markerRadius(a);
        const [x, y] = polar(r, angle);
        const climbs = stageIndex(a.target) > stageIndex(a.position) && !a.summit;
        const [tx, ty] = polar(mid(a.target), angle);
        const [lx, ly] = polar(r + 30, angle);
        const anchor = Math.cos(rad(angle)) > 0.3 ? 'start' : Math.cos(rad(angle)) < -0.3 ? 'end' : 'middle';
        const name = loc(a.name, lang);
        const short = name.length > 18 ? `${name.slice(0, 17)}…` : name;
        const isSel = a.id === selected;
        const loopState = a.loop.closed ? t('aif.loop.closed') : t('aif.loop.openShort', { n: LOOP_STEPS.filter((s) => a.loop.steps[s]).length });
        return (
          <g key={a.id} className={`aif-area${isSel ? ' is-selected' : ''}`} data-area={a.id} data-position={a.position}>
            {climbs && <line x1={x} y1={y} x2={tx} y2={ty} className="aif-trail" aria-hidden="true" />}
            {a.ahead.map((s) => {
              const [ax, ay] = polar(mid(s), angle);
              return <circle key={s} cx={ax} cy={ay} r={4} className="aif-ahead" data-ahead={s} aria-hidden="true" />;
            })}
            <g
              role="button" tabIndex={0} aria-pressed={isSel}
              aria-label={t('aif.map.label', {
                name, stage: t(`aif.stage.${a.position}`), target: t(`aif.stage.${a.target}`), loop: loopState,
                basis: t(`aif.areaBasis.${a.basis}`),
              })}
              onClick={() => onSelect(a.id)} onKeyDown={key(a.id)} className="aif-marker" data-testid={`aif-marker-${a.id}`}
            >
              <circle cx={x} cy={y} r={24} className="aif-marker-hit" />
              {isSel && <circle cx={x} cy={y} r={21} className="aif-marker-focus" />}
              {LOOP_STEPS.map((s) => (
                <path key={s} d={arc(x, y, 14, STEP_ARC[s][0] + 8, STEP_ARC[s][1] - 8)} className={a.loop.steps[s] ? 'aif-loop-on' : 'aif-loop-off'} data-step={s} />
              ))}
              <circle cx={x} cy={y} r={6} className={a.basis === 'evidence' ? 'aif-basis-evidence' : 'aif-basis-mixed'} />
            </g>
            <text x={lx} y={ly + 4} textAnchor={anchor} className="aif-area-label" aria-hidden="true">{short}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** The loop of one area in large: four arcs (run → observe → evaluate → improve) that come back to the start. */
export function LoopDiagram({ area }: { area: AreaView }) {
  const { t } = useI18n();
  const S = 240;
  const c = S / 2;
  const r = 74;
  return (
    <svg className="aif-loop" viewBox={`0 0 ${S} ${S}`} role="img" data-testid="aif-loop-svg"
      aria-label={t('aif.loop.aria', { steps: LOOP_STEPS.map((s) => `${t(`aif.loop.${s}`)}: ${t(area.loop.steps[s] ? 'aif.loop.done' : 'aif.loop.todo')}`).join(', ') })}>
      <defs>
        <marker id="aif-loop-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="aif-loop-arrowhead" />
        </marker>
      </defs>
      {LOOP_STEPS.map((s) => {
        const [from, to] = STEP_ARC[s];
        const midDeg = (from + to) / 2;
        const [lx, ly] = [c + (r + 34) * Math.cos(rad(midDeg)), c + (r + 34) * Math.sin(rad(midDeg))];
        return (
          <g key={s} data-step={s} data-done={area.loop.steps[s]}>
            <path d={arc(c, c, r, from + 6, to - 10)} className={area.loop.steps[s] ? 'aif-bigloop-on' : 'aif-bigloop-off'} markerEnd="url(#aif-loop-arrow)" />
            <text x={lx} y={ly} textAnchor="middle" className="aif-loop-label">{t(`aif.loop.${s}`)}</text>
          </g>
        );
      })}
      <text x={c} y={c - 4} textAnchor="middle" className="aif-loop-center">{t('aif.loop.iterations', { n: area.loop.iterations })}</text>
      <text x={c} y={c + 16} textAnchor="middle" className="aif-loop-trend">{t(`aif.trend.${area.loop.trend}`)}</text>
    </svg>
  );
}

/** Scores of the area's evaluations over time (0–100): the slope is the climb. */
export function ScoreTrend({ area }: { area: AreaView }) {
  const { t, lang, fmt } = useI18n();
  const ev = area.loop.evaluations;
  if (!ev.length) return null;
  const W = 400;
  const H = 150;
  const pad = { l: 64, r: 56, t: 18, b: 28 };
  const x = (i: number) => pad.l + (ev.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (ev.length - 1));
  const y = (v: number) => pad.t + ((100 - v) * (H - pad.t - pad.b)) / 100;
  const metric = loc(ev[ev.length - 1]!.metric, lang);
  return (
    <svg className="aif-trend" viewBox={`0 0 ${W} ${H}`} role="img" data-testid="aif-trend-svg"
      aria-label={t('aif.eval.chart', { metric, list: ev.map((e) => `${fmt.date(e.date)} ${fmt.number(e.score)}`).join(', ') })}>
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="aif-trend-grid" />
          <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="aif-trend-axis">{v}</text>
        </g>
      ))}
      <polyline points={ev.map((e, i) => `${x(i)},${y(e.score)}`).join(' ')} className="aif-trend-line" />
      {ev.map((e, i) => (
        <g key={`${e.date}-${i}`}>
          <circle cx={x(i)} cy={y(e.score)} r={4} className="aif-trend-dot" />
          <text x={x(i)} y={y(e.score) - 8} textAnchor="middle" className="aif-trend-value">{fmt.number(e.score)}</text>
          <text x={x(i)} y={H - 8} textAnchor="middle" className="aif-trend-axis">{e.date}</text>
        </g>
      ))}
    </svg>
  );
}
