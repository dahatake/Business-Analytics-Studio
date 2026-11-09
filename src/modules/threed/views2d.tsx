import type { KeyboardEvent, ReactNode } from 'react';
import { wrap } from '../../ui/textWrap.ts';
import type { SceneModel, SceneObject } from './model.ts';
import { TWIN_PRODUCT_X, type ArchScene, type KpiScene, type MapScene, type TwinScene } from './models.ts';

export interface View2DProps {
  model: SceneModel;
  selected: string | null;
  onPick: (id: string, el: Element) => void;
  /** Resolved text of an object. */
  text: (o: SceneObject) => string;
  title: string;
}

function Hit({ id, label, selected, onPick, children, className }: { id: string; label: string; selected: boolean; onPick: View2DProps['onPick']; children: ReactNode; className?: string }) {
  const key = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(id, e.currentTarget);
    }
  };
  return (
    <g role="button" tabIndex={0} aria-label={label} aria-pressed={selected} data-td-id={id}
      className={`td-hit${selected ? ' selected' : ''} ${className ?? ''}`} onClick={(e) => onPick(id, e.currentTarget)} onKeyDown={key}>
      {children}
    </g>
  );
}

const byKind = (m: SceneModel, kind: SceneObject['kind']) => m.objects.filter((o) => o.kind === kind);

/** FR-020 2D drawing: plan view of the same plant (same ids, same selection). */
export function TwinPlan2D({ model, selected, onPick, text, title }: View2DProps) {
  const m = model as TwinScene;
  const { width, depth } = m.floor;
  const vb = `${-width / 2 - 2} ${-depth / 2 - 8} ${width + 4} ${depth + 12}`;
  const site = m.objects.find((o) => o.id === m.rootId)!;
  return (
    <svg className="td-2d td-plan" viewBox={vb} role="group" aria-label={title}>
      <Hit id={site.id} label={text(site)} selected={selected === site.id} onPick={onPick}>
        <rect x={-width / 2} y={-depth / 2} width={width} height={depth} className="td-floor" />
      </Hit>
      <rect x={-width / 2 + 1} y={-depth / 2 + 1} width={width - 2} height={depth - 2} className="td-wall" />
      <rect x={-width / 2} y={-depth / 2 - 5.5} width={6} height={5} className="td-office" />
      <text x={-width / 2 + 7} y={-depth / 2 - 2.2} className="td-svg-title">{text(site)}</text>
      {m.lines.map((line) => {
        const lo = model.objects.find((o) => o.id === line.id)!;
        return (
          <g key={line.id}>
            <Hit id={line.id} label={text(lo)} selected={selected === line.id} onPick={onPick}>
              <rect x={-19} y={line.z - 1} width={36} height={2} className="td-conveyor" />
              <text x={-19} y={line.z - 2.6} className="td-svg-small">{text(lo)}</text>
            </Hit>
            {line.machines.map((mc) => {
              const o = model.objects.find((x) => x.id === mc.id)!;
              return (
                <Hit key={mc.id} id={mc.id} label={text(o)} selected={selected === mc.id} onPick={onPick}>
                  <rect x={mc.x - 1.6} y={line.z - 1.5} width={3.2} height={3} rx={0.3} className={`td-machine step-${mc.step}`} />
                  <text x={mc.x} y={line.z + 2.6} textAnchor="middle" className="td-svg-tiny">{text(o)}</text>
                </Hit>
              );
            })}
          </g>
        );
      })}
      {byKind(model, 'product').map((p) => (
        <Hit key={p.id} id={p.id} label={text(p)} selected={selected === p.id} onPick={onPick}>
          <circle cx={TWIN_PRODUCT_X} cy={p.position[2]} r={1.2} className={`td-product${p.id === m.heroId ? ' hero' : ''}`} />
          <text x={width / 2 - 0.4} y={p.position[2] + 2.8} textAnchor="end" className="td-svg-tiny">{text(p)}</text>
        </Hit>
      ))}
    </svg>
  );
}

/** FR-021 2D map: the same sites and flows on a flat map. */
export function Map2D({ model, selected, onPick, text, title }: View2DProps) {
  const m = model as MapScene;
  const xs = m.outline.flat().map((p) => p[0]);
  const zs = m.outline.flat().map((p) => p[1]);
  const minX = Math.min(...xs, ...m.objects.map((o) => o.position[0])) - 2;
  const maxX = Math.max(...xs, ...m.objects.map((o) => o.position[0])) + 8;
  const minZ = Math.min(...zs) - 2;
  const maxZ = Math.max(...zs) + 2;
  return (
    <svg className="td-2d td-map2d" viewBox={`${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}`} role="group" aria-label={title}>
      {m.outline.map((ring, i) => <path key={i} d={`M${ring.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L')}Z`} className="td-land" />)}
      {m.flows.map((f) => {
        const [ax, , az] = f.fromPos;
        const [bx, , bz] = f.toPos;
        const cx = (ax + bx) / 2 - (bz - az) * 0.2;
        const cz = (az + bz) / 2 + (bx - ax) * 0.2;
        return <path key={f.id} d={`M${ax},${az} Q${cx},${cz} ${bx},${bz}`} className="td-flow2d" strokeWidth={0.12 + f.valueT / 260} />;
      })}
      {m.objects.filter((o) => o.level === 1).map((o) => {
        const [x, , z] = o.position;
        const shape = o.kind === 'site'
          ? <rect x={x - 0.7} y={z - 0.7} width={1.4} height={1.4} className="td-node site" />
          : o.kind === 'supplier'
            ? <path d={`M${x},${z - 0.9}L${x + 0.9},${z}L${x},${z + 0.9}L${x - 0.9},${z}Z`} className="td-node supplier" />
            : <circle cx={x} cy={z} r={0.7} className="td-node region" />;
        return (
          <Hit key={o.id} id={o.id} label={text(o)} selected={selected === o.id} onPick={onPick}>
            {shape}
            {o.kind === 'site' && <text x={x + 1.1} y={z + 0.35} className="td-svg-tiny">{text(o)}</text>}
          </Hit>
        );
      })}
    </svg>
  );
}

/** §7 KPI towers as horizontal bars in 2D (same order, same selection). */
export function Kpi2D({ model, selected, onPick, text, title, percent }: View2DProps & { percent: (v: number) => string }) {
  const m = model as KpiScene;
  const row = 40;
  const left = 230;
  const barW = 330;
  const h = m.towers.length * row + 36;
  return (
    <svg className="td-2d td-kpi2d" viewBox={`0 0 640 ${h}`} role="group" aria-label={title}>
      <line x1={left + barW} x2={left + barW} y1={8} y2={h - 18} className="td-target-line" />
      {m.towers.map((tw, i) => {
        const o = model.objects.find((x) => x.id === tw.id)!;
        const p = Number.isFinite(tw.progress) ? tw.progress : 0;
        const w = Math.max(2, Math.min(1.25, Math.max(0, p)) * barW);
        const y = 14 + i * row;
        const lines = wrap(text(o), 22);
        return (
          <g key={tw.id}>
            <Hit id={tw.id} label={`${text(o)} ${percent(p)}`} selected={selected === tw.id} onPick={onPick}>
              <rect x={0} y={y - 6} width={640} height={row - 4} className="td-row-hit" />
              <rect x={left} y={y} width={w} height={20} rx={3} className={`td-bar status-${tw.status}`} />
            </Hit>
            <g aria-hidden="true" className="td-nohit">
              {lines.slice(0, 2).map((ln, j) => <text key={j} x={left - 10} y={y + 10 + j * 14 - (lines.length > 1 ? 6 : 0)} textAnchor="end" className="td-svg-label">{ln}</text>)}
              <text x={left + w + 6} y={y + 15} className="td-svg-label">{percent(p)}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/** FR-040 2D block diagram (C4-like containers on layers). */
export function Arch2D({ model, selected, onPick, text, title, roleText }: View2DProps & { roleText: (role: string) => string }) {
  const m = model as ArchScene;
  const layers = [...m.objects.filter((o) => o.kind === 'layer')].reverse();
  const bw = 112;
  const bh = 62;
  const gap = 10;
  const left = 150;
  let y = 6;
  const bands = layers.map((l) => {
    const blocks = m.blocks.filter((b) => `arch-layer-${b.layer}` === l.id);
    const rows = Math.max(1, Math.ceil(blocks.length / 5));
    const band = { l, blocks, y, h: rows * (bh + gap) + gap };
    y += band.h + 6;
    return band;
  });
  const center = new Map<string, [number, number]>();
  bands.forEach((b) => b.blocks.forEach((blk, j) => center.set(blk.id, [left + gap + (j % 5) * (bw + gap) + bw / 2, b.y + gap + Math.floor(j / 5) * (bh + gap) + bh / 2])));
  return (
    <svg className="td-2d td-arch2d" viewBox={`0 0 ${left + 5 * (bw + gap) + gap} ${y}`} role="group" aria-label={title}>
      {bands.map((b) => (
        <g key={b.l.id}>
          <Hit id={b.l.id} label={text(b.l)} selected={selected === b.l.id} onPick={onPick}>
            <rect x={0} y={b.y} width={left + 5 * (bw + gap) + gap} height={b.h} rx={6} className="td-band" />
          </Hit>
          <g aria-hidden="true" className="td-nohit">
            {wrap(text(b.l), 11).map((ln, j) => <text key={j} x={10} y={b.y + 22 + j * 16} className="td-svg-label strong">{ln}</text>)}
          </g>
        </g>
      ))}
      {m.arch.links.map((l, i) => {
        const a = center.get(l.from);
        const c = center.get(l.to);
        return a && c ? <line key={i} x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} className="td-link2d" /> : null;
      })}
      {bands.flatMap((b) => b.blocks.map((blk) => {
        const o = model.objects.find((x) => x.id === blk.id)!;
        const [cx, cy] = center.get(blk.id)!;
        const lines = wrap(text(o), 8.5).slice(0, 2);
        return (
          <g key={blk.id}>
            <Hit id={blk.id} label={`${text(o)} ${roleText(blk.role)}`} selected={selected === blk.id} onPick={onPick}>
              <rect x={cx - bw / 2} y={cy - bh / 2} width={bw} height={bh} rx={blk.role === 'painPoint' ? 18 : 6} className={`td-block role-${blk.role}`} />
            </Hit>
            <g aria-hidden="true" className="td-nohit">
              {lines.map((ln, j) => <text key={j} x={cx} y={cy - 8 + j * 14 - (lines.length - 1) * 4} textAnchor="middle" className="td-block-text">{ln}</text>)}
              <text x={cx} y={cy + bh / 2 - 8} textAnchor="middle" className="td-block-role">{roleText(blk.role)}</text>
            </g>
          </g>
        );
      }))}
    </svg>
  );
}
