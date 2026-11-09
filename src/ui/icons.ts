import type { FluentIcon } from '@fluentui/react-icons';
import {
  BuildingFactory16Regular, Person16Regular, Briefcase16Regular, Box16Regular, Handshake16Regular,
  BoxCheckmark16Regular, Receipt16Regular, Warning16Regular, BranchFork16Regular, Lightbulb16Regular,
  Gauge16Regular, CalendarLtr16Regular, VehicleTruck16Regular, BookOpen16Regular,
} from '@fluentui/react-icons';
import type { EntityKind } from '../data/schema.ts';

/** F-3.1.4: one Fluent System Icon per entity kind, used consistently in lists, cards, graph legend and nav. */
export const kindIcon: Record<EntityKind, FluentIcon> = {
  site: BuildingFactory16Regular,
  person: Person16Regular,
  customer: Briefcase16Regular,
  product: Box16Regular,
  deal: Handshake16Regular,
  deliverable: BoxCheckmark16Regular,
  invoice: Receipt16Regular,
  issue: Warning16Regular,
  cause: BranchFork16Regular,
  solution: Lightbulb16Regular,
  kpi: Gauge16Regular,
  initiative: CalendarLtr16Regular,
  supplier: VehicleTruck16Regular,
  source: BookOpen16Regular,
};

/** Categorical hues per kind for graph nodes (tested for ≥3:1 against the dark canvas). */
export const kindColor: Record<EntityKind, string> = {
  site: '#5CC8FF',
  person: '#F7A8C4',
  customer: '#FFB86B',
  product: '#8FD694',
  deal: '#FFD866',
  deliverable: '#B7E07E',
  invoice: '#F28B82',
  issue: '#FF9E80',
  cause: '#D7A7FF',
  solution: '#7EE0D2',
  kpi: '#9DB8FF',
  initiative: '#C6C6FF',
  supplier: '#E3C08D',
  source: '#C0C8D0',
};

/** Node shape per kind in SVG graphs, so kinds are distinguishable without color (NFR-A11Y-005). */
export const kindShape: Record<EntityKind, 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon'> = {
  site: 'square',
  person: 'circle',
  customer: 'hexagon',
  product: 'square',
  deal: 'diamond',
  deliverable: 'diamond',
  invoice: 'triangle',
  issue: 'triangle',
  cause: 'circle',
  solution: 'hexagon',
  kpi: 'circle',
  initiative: 'square',
  supplier: 'hexagon',
  source: 'circle',
};

