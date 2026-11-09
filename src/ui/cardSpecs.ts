import type { Entity, EntityKind, EntityOf } from '../data/schema.ts';
import { getEntity, entitiesOf, regionName, neighbors } from '../data/pack.ts';
import type { Formatters, MessageKey } from '../i18n/index.ts';
import type { LText } from '../data/schema.ts';
import { kpiProgress } from '../domain/kpi.ts';

export interface CardContext {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  tx: (text: LText) => string;
  fmt: Formatters;
}

export interface CardField<K extends EntityKind = EntityKind> {
  label: MessageKey;
  value: (e: EntityOf<K>, ctx: CardContext) => string;
  /** Hidden for an external audience even when the entity itself is shareable. */
  internal?: boolean;
}

export interface CardSpec<K extends EntityKind = EntityKind> {
  fields: CardField<K>[];
  /** Drill-through destination. `null` = no related screen, so references are not rendered as links. */
  route: ((e: EntityOf<K>) => string) | null;
}

const nameOf = (id: string, ctx: CardContext) => {
  const e = getEntity(id);
  return e ? ctx.tx(e.name) : '—';
};
const entityRoute = (e: Entity) => `/entity/${encodeURIComponent(e.id)}`;

type Specs = { [K in EntityKind]: CardSpec<K> };

/**
 * F-3.2.1 "target item list": every reference item in every screen is an entity of one of these kinds,
 * and this table defines what its detail card shows and where it drills through to.
 */
export const cardSpecs: Specs = {
  site: {
    route: entityRoute,
    fields: [
      { label: 'field.siteRole', value: (e, c) => c.t(`siteRole.${e.role}`) },
      { label: 'field.capacity', value: (e, c) => (e.capacityTPerMonth ? c.t('unit.tPerMonth', { value: c.fmt.integer(e.capacityTPerMonth) }) : '—') },
      { label: 'field.people', value: (e, c) => c.fmt.integer(entitiesOf('person').filter((p) => p.siteId === e.id).length) },
    ],
  },
  person: {
    route: entityRoute,
    fields: [
      { label: 'field.role', value: (e, c) => c.tx(e.role) },
      { label: 'field.ageBand', value: (e, c) => c.t(`ageBand.${e.ageBand}`) },
      { label: 'field.site', value: (e, c) => nameOf(e.siteId, c) },
    ],
  },
  customer: {
    route: entityRoute,
    fields: [
      { label: 'field.industry', value: (e, c) => c.tx(e.industry) },
      { label: 'field.region', value: (e, c) => { const r = regionName(e.regionId); return r ? c.tx(r) : '—'; } },
      { label: 'field.deals', value: (e, c) => c.fmt.integer(entitiesOf('deal').filter((d) => d.customerId === e.id).length) },
      { label: 'field.pipelineValue', internal: true, value: (e, c) => c.fmt.yenCompact(entitiesOf('deal').filter((d) => d.customerId === e.id).reduce((a, d) => a + d.valueJpy, 0)) },
    ],
  },
  product: {
    route: entityRoute,
    fields: [
      { label: 'field.category', value: (e, c) => c.tx(e.category) },
      { label: 'field.madeAt', value: (e, c) => nameOf(e.siteId, c) },
      { label: 'field.unitPrice', internal: true, value: (e, c) => c.fmt.yen(e.unitPriceJpy) },
    ],
  },
  deal: {
    route: entityRoute,
    fields: [
      { label: 'field.customer', value: (e, c) => nameOf(e.customerId, c) },
      { label: 'field.stage', value: (e, c) => c.t(`stage.${e.stage}`) },
      { label: 'field.value', internal: true, value: (e, c) => c.fmt.yenCompact(e.valueJpy) },
      { label: 'field.closeDate', value: (e, c) => c.fmt.date(e.closeDate) },
      { label: 'field.owner', value: (e, c) => nameOf(e.ownerId, c) },
    ],
  },
  deliverable: {
    route: entityRoute,
    fields: [
      { label: 'field.deal', value: (e, c) => nameOf(e.dealId, c) },
      { label: 'field.dueDate', value: (e, c) => c.fmt.date(e.dueDate) },
      { label: 'field.status', value: (e, c) => c.t(`deliverableStatus.${e.status}`) },
    ],
  },
  invoice: {
    route: entityRoute,
    fields: [
      { label: 'field.deliverable', value: (e, c) => nameOf(e.deliverableId, c) },
      { label: 'field.amount', internal: true, value: (e, c) => c.fmt.yen(e.amountJpy) },
      { label: 'field.issuedDate', value: (e, c) => c.fmt.date(e.issuedDate) },
      { label: 'field.status', value: (e, c) => c.t(`invoiceStatus.${e.status}`) },
    ],
  },
  issue: {
    route: entityRoute,
    fields: [
      { label: 'field.impact', value: (e, c) => c.t('unit.score5', { value: e.impact }) },
      { label: 'field.feasibility', value: (e, c) => c.t('unit.score5', { value: e.feasibility }) },
      { label: 'field.causes', value: (e, c) => e.causeIds.map((id) => nameOf(id, c)).join(c.t('list.separator')) },
    ],
  },
  cause: {
    route: entityRoute,
    fields: [
      { label: 'field.issues', value: (e, c) => entitiesOf('issue').filter((i) => i.causeIds.includes(e.id)).map((i) => c.tx(i.name)).join(c.t('list.separator')) || '—' },
    ],
  },
  solution: {
    route: entityRoute,
    fields: [
      { label: 'field.msProducts', value: (e, c) => e.msProducts.join(c.t('list.separator')) },
      { label: 'field.cost', internal: true, value: (e, c) => c.fmt.yenCompact(e.costJpy) },
      { label: 'field.annualBenefit', value: (e, c) => c.fmt.yenCompact(e.annualBenefitJpy) },
      { label: 'field.roi', value: (e, c) => c.fmt.percent((e.annualBenefitJpy - e.costJpy) / e.costJpy) },
    ],
  },
  kpi: {
    route: entityRoute,
    fields: [
      { label: 'field.actual', value: (e, c) => `${c.fmt.number(e.current)} ${c.tx(e.unit)}` },
      { label: 'field.target', value: (e, c) => `${c.fmt.number(e.target)} ${c.tx(e.unit)}` },
      { label: 'field.baseline', value: (e, c) => `${c.fmt.number(e.baseline)} ${c.tx(e.unit)}` },
      { label: 'field.direction', value: (e, c) => c.t(`direction.${e.direction}`) },
      { label: 'field.progress', value: (e, c) => c.fmt.percent(kpiProgress(e)) },
      { label: 'field.period', value: (e, c) => c.tx(e.period) },
    ],
  },
  initiative: {
    route: entityRoute,
    fields: [
      { label: 'field.period', value: (e, c) => `${c.fmt.date(e.start)} – ${c.fmt.date(e.end)}` },
      { label: 'field.progress', value: (e, c) => c.fmt.percent(e.progress) },
      { label: 'field.owner', value: (e, c) => nameOf(e.ownerId, c) },
    ],
  },
  supplier: {
    route: entityRoute,
    fields: [
      { label: 'field.region', value: (e, c) => { const r = regionName(e.regionId); return r ? c.tx(r) : '—'; } },
      { label: 'field.suppliesTo', value: (e, c) => neighbors(e.id).filter((n) => n.edge.type === 'supplies').map((n) => c.tx(n.entity.name)).join(c.t('list.separator')) },
    ],
  },
  // Sources have no screen of their own: shown as card-only references (F-3.2.3 "no link when there is no destination").
  source: {
    route: null,
    fields: [
      { label: 'field.publisher', value: (e, c) => c.tx(e.publisher) },
      { label: 'field.publishedDate', value: (e, c) => c.fmt.date(e.publishedDate) },
    ],
  },
};

export function specFor<K extends EntityKind>(kind: K): CardSpec<K> {
  return cardSpecs[kind] as CardSpec<K>;
}

export function routeFor(e: Entity): string | null {
  const spec = specFor(e.kind) as CardSpec;
  return spec.route ? spec.route(e as never) : null;
}

export function isHidden(e: Entity, audience: 'internal' | 'external'): boolean {
  return audience === 'external' && e.classification === 'internal';
}
