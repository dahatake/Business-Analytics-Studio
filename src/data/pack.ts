import { z } from 'zod';
import { CustomerPack, Entity, type EntityKind, type EntityOf } from './schema.ts';
import { samplePack } from './sample.ts';

export type RelationType =
  | 'places' | 'includes' | 'produces' | 'billedAs' | 'owns' | 'causedBy' | 'resolves'
  | 'improves' | 'measuredBy' | 'implements' | 'madeAt' | 'worksAt' | 'accountableFor'
  | 'supplies' | 'citedFrom';

export interface Edge {
  source: string;
  target: string;
  type: RelationType;
}

export interface PackIssue {
  path: string;
  message: string;
}

export interface LoadedPack {
  pack: CustomerPack;
  byId: Map<string, Entity>;
  edges: Edge[];
  /** Entities rejected by validation (FR-102: invalid items are disabled, the rest still loads). */
  issues: PackIssue[];
}

/** Validate entity-by-entity so one bad item does not block the whole pack (FR-102). */
export function loadPack(raw: unknown): LoadedPack {
  const issues: PackIssue[] = [];
  const shell = CustomerPack.omit({ entities: true }).extend({ entities: z.array(z.unknown()) }).parse(raw);
  const entities: Entity[] = [];
  shell.entities.forEach((candidate, index) => {
    const result = Entity.safeParse(candidate);
    if (result.success) entities.push(result.data);
    else issues.push({ path: `entities[${index}]`, message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  });
  const byId = new Map(entities.map((e) => [e.id, e] as const));
  const edges = buildEdges(entities, shell.flows, byId, issues);
  return { pack: { ...shell, entities }, byId, edges, issues };
}

function buildEdges(entities: Entity[], flows: CustomerPack['flows'], byId: Map<string, Entity>, issues: PackIssue[]): Edge[] {
  const edges: Edge[] = [];
  const add = (source: string, target: string, type: RelationType) => {
    if (!byId.has(source) || !byId.has(target)) {
      issues.push({ path: `${source}->${target}`, message: `dangling reference (${type})` });
      return;
    }
    edges.push({ source, target, type });
  };
  for (const e of entities) {
    switch (e.kind) {
      case 'deal':
        add(e.customerId, e.id, 'places');
        e.productIds.forEach((p) => add(e.id, p, 'includes'));
        add(e.ownerId, e.id, 'owns');
        break;
      case 'deliverable': add(e.dealId, e.id, 'produces'); break;
      case 'invoice': add(e.deliverableId, e.id, 'billedAs'); break;
      case 'issue':
        e.causeIds.forEach((c) => add(e.id, c, 'causedBy'));
        e.kpiIds.forEach((k) => add(e.id, k, 'measuredBy'));
        break;
      case 'solution':
        e.issueIds.forEach((i) => add(e.id, i, 'resolves'));
        e.kpiIds.forEach((k) => add(e.id, k, 'improves'));
        break;
      case 'initiative': add(e.id, e.solutionId, 'implements'); break;
      case 'product': add(e.id, e.siteId, 'madeAt'); break;
      case 'person': add(e.id, e.siteId, 'worksAt'); break;
      case 'kpi': add(e.ownerId, e.id, 'accountableFor'); break;
      default: break;
    }
    e.sourceIds.forEach((s) => add(e.id, s, 'citedFrom'));
  }
  const supplied = new Set<string>();
  for (const f of flows) {
    const src = byId.get(f.source);
    if (src?.kind === 'supplier' && !supplied.has(`${f.source}|${f.target}`)) {
      supplied.add(`${f.source}|${f.target}`);
      add(f.source, f.target, 'supplies');
    }
  }
  return edges;
}

/** The active pack. A live binding: ctivatePack swaps it before the first render (FR-101). */
export let loaded: LoadedPack = loadPack(samplePack);

export function activatePack(raw: unknown): LoadedPack {
  loaded = loadPack(raw);
  return loaded;
}

export function entitiesOf<K extends EntityKind>(kind: K, data: LoadedPack = loaded): EntityOf<K>[] {
  return data.pack.entities.filter((e): e is EntityOf<K> => e.kind === kind);
}

export function getEntity(id: string, data: LoadedPack = loaded): Entity | undefined {
  return data.byId.get(id);
}

export function neighbors(id: string, data: LoadedPack = loaded): { entity: Entity; edge: Edge; direction: 'out' | 'in' }[] {
  const out: { entity: Entity; edge: Edge; direction: 'out' | 'in' }[] = [];
  for (const edge of data.edges) {
    if (edge.source === id) {
      const entity = data.byId.get(edge.target);
      if (entity) out.push({ entity, edge, direction: 'out' });
    } else if (edge.target === id) {
      const entity = data.byId.get(edge.source);
      if (entity) out.push({ entity, edge, direction: 'in' });
    }
  }
  return out;
}

/** Breadth-first neighborhood within `hops` (PARAM-014). Returns id → hop distance, including the focus at 0. */
export function neighborhoodDepths(focusId: string, hops: number, allow: (e: Entity) => boolean = () => true, data: LoadedPack = loaded): Map<string, number> {
  const depth = new Map([[focusId, 0]]);
  let frontier = [focusId];
  for (let h = 1; h <= hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of neighbors(id, data)) {
        if (!depth.has(n.entity.id) && allow(n.entity)) {
          depth.set(n.entity.id, h);
          next.push(n.entity.id);
        }
      }
    }
    frontier = next;
  }
  return depth;
}

export function neighborhood(focusId: string, hops: number, data: LoadedPack = loaded): Set<string> {
  return new Set(neighborhoodDepths(focusId, hops, () => true, data).keys());
}

/** The business chain customer → deal → deliverable → invoice (F-3.2.4). */
export function businessChain(customerId: string, data: LoadedPack = loaded) {
  const deals = entitiesOf('deal', data).filter((d) => d.customerId === customerId);
  return deals.map((deal) => {
    const deliverables = entitiesOf('deliverable', data).filter((d) => d.dealId === deal.id);
    return {
      deal,
      deliverables: deliverables.map((deliverable) => ({
        deliverable,
        invoices: entitiesOf('invoice', data).filter((i) => i.deliverableId === deliverable.id),
      })),
    };
  });
}

export function regionName(id: string, data: LoadedPack = loaded) {
  return data.pack.regions.find((r) => r.id === id)?.name;
}


