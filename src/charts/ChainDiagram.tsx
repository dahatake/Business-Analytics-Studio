import { useMemo } from 'react';
import * as d3 from 'd3';
import type { Entity, EntityKind } from '../data/schema.ts';
import { entitiesOf, loaded } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { isHidden } from '../ui/cardSpecs.ts';
import { usePackVersion } from '../state/packEdits.ts';
import { kindColor } from '../ui/icons.ts';
import { SvgEntityNode } from '../ui/SvgEntityNode.tsx';
import { wrap } from '../ui/textWrap.ts';

const COLUMNS = ['customer', 'deal', 'deliverable', 'invoice'] as const satisfies readonly EntityKind[];
const COL_W = 240, NODE_W = 200, NODE_H = 40, ROW_H = 50, TOP = 40, LINE_EM = 14;

interface LaidOut { e: Entity; x: number; y: number }

/** Upstream and downstream ids along the chain, for highlight. */
export function chainOf(id: string): Set<string> {
  const result = new Set([id]);
  const chainEdges = loaded.edges.filter((e) => e.type === 'places' || e.type === 'produces' || e.type === 'billedAs');
  const walk = (start: string, dir: 'up' | 'down') => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of chainEdges) {
        const next = dir === 'down' ? (e.source === cur ? e.target : null) : (e.target === cur ? e.source : null);
        if (next && !result.has(next)) { result.add(next); stack.push(next); }
      }
    }
  };
  walk(id, 'down');
  walk(id, 'up');
  return result;
}

/** F-3.2.4: business relationship as lanes customer → deal → deliverable → invoice. */
export function ChainDiagram({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const { t, tx } = useI18n();
  const audience = useSettings((s) => s.audience);
  const version = usePackVersion((s) => s.version);

  const { nodes, links, height } = useMemo(() => {
    const visible = <T extends Entity>(xs: T[]) => xs.filter((x) => !isHidden(x, audience));
    const order: Record<(typeof COLUMNS)[number], Entity[]> = { customer: [], deal: [], deliverable: [], invoice: [] };
    for (const c of visible(entitiesOf('customer'))) {
      order.customer.push(c);
      for (const d of visible(entitiesOf('deal')).filter((d) => d.customerId === c.id)) {
        order.deal.push(d);
        for (const v of visible(entitiesOf('deliverable')).filter((v) => v.dealId === d.id)) {
          order.deliverable.push(v);
          order.invoice.push(...visible(entitiesOf('invoice')).filter((i) => i.deliverableId === v.id));
        }
      }
    }
    const maxRows = Math.max(...COLUMNS.map((k) => order[k].length));
    const height = TOP + maxRows * ROW_H + 10;
    const pos = new Map<string, LaidOut>();
    COLUMNS.forEach((k, ci) => {
      const list = order[k];
      const offset = ((maxRows - list.length) * ROW_H) / 2;
      list.forEach((e, ri) => pos.set(e.id, { e, x: 10 + ci * COL_W, y: TOP + offset + ri * ROW_H }));
    });
    const links = loaded.edges
      .filter((e) => (e.type === 'places' || e.type === 'produces' || e.type === 'billedAs') && pos.has(e.source) && pos.has(e.target))
      .map((e) => ({ edge: e, s: pos.get(e.source)!, t: pos.get(e.target)! }));
    return { nodes: [...pos.values()], links, height };
  }, [audience, version]);

  const highlight = selected ? chainOf(selected) : null;
  const link = d3.linkHorizontal<{ source: [number, number]; target: [number, number] }, [number, number]>();

  return (
    <div className="chain-scroll">
      <svg viewBox={`0 0 ${10 + COLUMNS.length * COL_W} ${height}`} className="chain-diagram" role="group" aria-label={t('relations.chainAria')} style={{ minWidth: 880 }}>
        {COLUMNS.map((k, ci) => (
          <text key={k} className="lane-title" x={10 + ci * COL_W} y={20}>{t(`kind.${k}`)}{ci < COLUMNS.length - 1 ? '  →' : ''}</text>
        ))}
        <g className="chain-links">
          {links.map(({ edge, s, t: tg }) => (
            <path
              key={`${edge.source}-${edge.target}`}
              className={`chain-link ${highlight ? (highlight.has(edge.source) && highlight.has(edge.target) ? 'on' : 'dim') : ''}`}
              d={link({ source: [s.x + NODE_W, s.y + NODE_H / 2], target: [tg.x, tg.y + NODE_H / 2] }) ?? ''}
            />
          ))}
        </g>
        {nodes.map(({ e, x, y }) => (
          <SvgEntityNode
            key={e.id}
            id={e.id}
            label={`${t(`kind.${e.kind}`)}: ${tx(e.name)}`}
            transform={`translate(${x},${y})`}
            selected={selected === e.id}
            className={highlight ? (highlight.has(e.id) ? 'on' : 'dim') : ''}
            onActivate={() => onSelect(e.id)}
          >
            <rect width={NODE_W} height={NODE_H} rx={8} className="chain-node" style={{ ['--kind' as string]: kindColor[e.kind] }} />
            <rect width={4} height={NODE_H - 12} x={6} y={6} rx={2} fill={kindColor[e.kind]} />
            {/* Full name, wrapped (never truncated) so the visible text stays part of the accessible name (WCAG 2.5.3). */}
            <text x={16} y={NODE_H / 2} className="chain-node-label">
              {wrap(tx(e.name), LINE_EM).map((line, i, lines) => (
                <tspan key={i} x={16} dy={i === 0 ? `${0.35 - (lines.length - 1) * 0.6}em` : '1.2em'}>{line}</tspan>
              ))}
            </text>
          </SvgEntityNode>
        ))}
      </svg>
    </div>
  );
}

