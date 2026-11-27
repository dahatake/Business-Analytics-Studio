import { useMemo, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n/index.ts';
import { linkKey, measureFlows, transitionFlows, type Flow, type Scenario } from '../../domain/resourceModel.ts';

export type Selection = { type: 'pool' | 'demand'; id: string } | null;
export type View = 'before' | 'after' | 'timeline';

const W = 960;
const NODE_W = 248;
const ROW_H = 56;
const GAP = 10;
const TOP = 34;
const MAX_RIBBON = 22;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Props {
  scenario: Scenario;
  view: View;
  selected: Selection;
  onSelect: (s: Selection) => void;
  unit: string;
  share: number;
}

/**
 * FR-326: resources (left) → demand (right). Ribbon width is the allocated amount. Every link that exists today or in the
 * optimum is always rendered with a stable key, so switching the view animates widths instead of redrawing. Selecting a
 * node highlights its flows, the nodes at the other end and, dashed, pack-named owners that receive nothing.
 */
export function ResourceFlowMap({ scenario, view, selected, onSelect, unit, share }: Props) {
  const { t, tx, fmt } = useI18n();
  const { model } = scenario;
  const flows = useMemo(() => transitionFlows(scenario, view === 'timeline' ? share : view === 'before' ? 0 : 1), [scenario, view, share]);
  const metrics = useMemo(() => measureFlows(model, flows), [model, flows]);
  const rows = Math.max(model.pools.length, model.demands.length, 1);
  const H = TOP + rows * (ROW_H + GAP) + 8;
  const yOf = (index: number, count: number) => TOP + ((rows - count) * (ROW_H + GAP)) / 2 + index * (ROW_H + GAP);
  const poolY = new Map(model.pools.map((p, i) => [p.id, yOf(i, model.pools.length)]));
  const demandY = new Map(model.demands.map((d, j) => [d.id, yOf(j, model.demands.length)]));

  const allKeys = useMemo(() => {
    const keys = new Map<string, { poolId: string; demandId: string }>();
    for (const f of [...scenario.before, ...scenario.after]) keys.set(linkKey(f.poolId, f.demandId), f);
    return [...keys.values()];
  }, [scenario]);
  const qty = new Map(flows.map((f: Flow) => [linkKey(f.poolId, f.demandId), f.qty]));
  const maxQty = Math.max(1, ...scenario.before.map((f) => f.qty), ...scenario.after.map((f) => f.qty));

  const related = useMemo(() => {
    if (!selected) return null;
    const nodes = new Set<string>([selected.id]);
    const links = new Set<string>();
    const ownerLinks = new Set<string>();
    for (const f of flows) {
      if (f.poolId === selected.id || f.demandId === selected.id) {
        nodes.add(f.poolId); nodes.add(f.demandId); links.add(linkKey(f.poolId, f.demandId));
      }
    }
    for (const d of model.demands) {
      for (const owner of d.owners) {
        if (owner === selected.id || d.id === selected.id) {
          nodes.add(owner); nodes.add(d.id);
          const k = linkKey(owner, d.id);
          if (!links.has(k)) ownerLinks.add(k);
        }
      }
    }
    return { nodes, links, ownerLinks };
  }, [selected, flows, model.demands]);

  const nodeClass = (id: string) => {
    if (!related) return '';
    if (selected?.id === id) return ' is-selected';
    return related.nodes.has(id) ? ' is-related' : ' is-dim';
  };
  const keySelect = (e: KeyboardEvent, s: Selection) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected?.id === s?.id ? null : s); }
    if (e.key === 'Escape') onSelect(null);
  };
  const path = (y1: number, y2: number) => {
    const x1 = NODE_W, x2 = W - NODE_W, mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  };
  const viewLabel = t(view === 'timeline' ? 'ck.sim.time' : view === 'before' ? 'res.view.before' : 'res.view.after');

  return (
    <div className={`res-map${related ? ' has-selection' : ''}`} data-view={view}>
      {view === 'timeline' && <p data-testid="resource-period-metrics">{t('ck.sim.allocation', {
        served: fmt.number(metrics.served), need: fmt.number(metrics.need), unit, overloaded: metrics.overloaded,
      })}{metrics.costJpy !== undefined && ` · ${t('optimize.metric.cost')}: ${fmt.yen(metrics.costJpy)}`}</p>}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label={t('res.map.label', { view: viewLabel, pools: model.pools.length, demands: model.demands.length })}
        data-testid="resource-map"
        onKeyDown={(e) => { if (e.key === 'Escape') onSelect(null); }}
      >
        <text x={0} y={18} className="res-col-title">{t('res.map.pools')}</text>
        <text x={W} y={18} className="res-col-title" textAnchor="end">{t('res.map.demands')}</text>

        <g className="res-links" aria-hidden>
          {allKeys.map(({ poolId, demandId }) => {
            const k = linkKey(poolId, demandId);
            const q = qty.get(k) ?? 0;
            const y1 = (poolY.get(poolId) ?? 0) + ROW_H / 2, y2 = (demandY.get(demandId) ?? 0) + ROW_H / 2;
            const width = q ? Math.max(2, (q / maxQty) * MAX_RIBBON) : 0;
            const state = !related ? '' : related.links.has(k) ? ' is-related' : ' is-dim';
            return (
              <g key={k} className={`res-link${state}${q ? '' : ' is-empty'}`} data-testid={`resource-link-${poolId}--${demandId}`} data-qty={q}>
                <path className="res-ribbon" d={path(y1, y2)} style={{ strokeWidth: width }} />
                <path className="res-ribbon-flow" d={path(y1, y2)} style={{ strokeWidth: Math.min(3, width) }} />
              </g>
            );
          })}
          {related && [...related.ownerLinks].map((k) => {
            const [poolId, demandId] = k.split('|') as [string, string];
            const y1 = (poolY.get(poolId) ?? 0) + ROW_H / 2, y2 = (demandY.get(demandId) ?? 0) + ROW_H / 2;
            return <path key={`owner-${k}`} className="res-owner-link" d={path(y1, y2)} />;
          })}
        </g>

        {model.pools.map((p) => {
          const y = poolY.get(p.id)!;
          const cap = p.off ? 0 : Math.round(p.capacity.value);
          const load = metrics.load[p.id] ?? 0;
          const util = metrics.utilization[p.id] ?? 0;
          const over = util > 1 + 1e-9;
          const name = tx(p.name);
          const sel: Selection = { type: 'pool', id: p.id };
          return (
            <g
              key={p.id}
              className={`res-node res-pool${nodeClass(p.id)}${over ? ' is-over' : ''}${p.off ? ' is-off' : ''}`}
              transform={`translate(0 ${y})`}
              data-node={p.id}
            >
              <rect className="res-node-box" width={NODE_W} height={ROW_H} rx={8} />
              <text className="res-node-name" aria-hidden="true" x={12} y={21}>{clip(name, 24)}</text>
              <text className="res-node-meta" aria-hidden="true" x={12} y={40}>
                {p.off ? t('res.map.off') : `${fmt.integer(load)} / ${fmt.integer(cap)} ${unit}`}
              </text>
              <rect className="res-bar-track" x={12} y={ROW_H - 8} width={NODE_W - 24} height={4} rx={2} />
              <rect className="res-bar-fill" x={12} y={ROW_H - 8} width={(NODE_W - 24) * Math.min(1, cap ? load / cap : 0)} height={4} rx={2} />
              {Number.isFinite(util) && cap > 0 && (
                <text className="res-node-util" aria-hidden="true" x={NODE_W - 12} y={21} textAnchor="end">{fmt.percent(util)}</text>
              )}
              <rect
                className="res-node-hit" width={NODE_W} height={ROW_H} rx={8}
                role="button"
                tabIndex={0}
                aria-pressed={selected?.id === p.id}
                aria-label={t('res.map.poolAria', { name, capacity: fmt.integer(cap), load: fmt.integer(load), unit, util: Number.isFinite(util) ? fmt.percent(util) : '—' })}
                data-testid={`resource-node-${p.id}`}
                onClick={() => onSelect(selected?.id === p.id ? null : sel)}
                onKeyDown={(e) => keySelect(e, sel)}
              >
                <title>{name}</title>
              </rect>
            </g>
          );
        })}

        {model.demands.map((d) => {
          const y = demandY.get(d.id)!;
          const need = d.off ? 0 : Math.round(d.need.value);
          const served = Math.min(need, metrics.served_[d.id] ?? 0);
          const name = tx(d.name);
          const sel: Selection = { type: 'demand', id: d.id };
          const unmet = need > 0 && served < need;
          return (
            <g
              key={d.id}
              className={`res-node res-demand${nodeClass(d.id)}${unmet ? ' is-unmet' : ''}${d.off ? ' is-off' : ''}`}
              transform={`translate(${W - NODE_W} ${y})`}
              data-node={d.id}
            >
              <rect className="res-node-box" width={NODE_W} height={ROW_H} rx={8} />
              <text className="res-node-kind" aria-hidden="true" x={12} y={16}>{t(`res.kind.${d.kind}`)}</text>
              <text className="res-node-name" aria-hidden="true" x={12} y={33}>{clip(name, unmet ? 17 : 24)}</text>
              {unmet && <text className="res-node-unmet" aria-hidden="true" x={NODE_W - 12} y={33} textAnchor="end">{t('res.map.unmet')}</text>}
              <text className="res-node-meta" aria-hidden="true" x={NODE_W - 12} y={16} textAnchor="end">
                {d.off ? t('res.map.off') : `${fmt.integer(served)} / ${fmt.integer(need)}`}
              </text>
              <rect className="res-bar-track" x={12} y={ROW_H - 12} width={NODE_W - 24} height={6} rx={3} />
              <rect className="res-bar-fill" x={12} y={ROW_H - 12} width={(NODE_W - 24) * (need ? served / need : 0)} height={6} rx={3} />
              <rect
                className="res-node-hit" width={NODE_W} height={ROW_H} rx={8}
                role="button"
                tabIndex={0}
                aria-pressed={selected?.id === d.id}
                aria-label={`${t('res.map.demandAria', { name, need: fmt.integer(need), served: fmt.integer(served), unit })}${unmet ? ` — ${t('res.map.unmet')}` : ''}`}
                data-testid={`resource-node-${d.id}`}
                onClick={() => onSelect(selected?.id === d.id ? null : sel)}
                onKeyDown={(e) => keySelect(e, sel)}
              >
                <title>{name}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
