import type { Entity } from '../data/schema.ts';

export interface OutboundSelection {
  /** Entities that may be sent. */
  included: Entity[];
  /** Ids withheld. Empty since D-2 (internal may be sent); kept so callers can show what was withheld if a rule returns. */
  excludedIds: string[];
  /** Number of internal entities in the request, retained for diagnostics. */
  internalCount: number;
  /** Number of person entities in the request. AI settings consent covers these request contents (D-26). */
  personCount: number;
}

/**
 * What may leave the PC. D-2 (user, 2026-11-09): internal information may be sent externally, which amends Q-055.
 * AI settings consent covers all data included in a request; unrelated local data is not included.
 */
export function selectOutbound(entities: Entity[], byId: Map<string, Entity>): OutboundSelection {
  const included = [...entities];
  const internalCount = included.filter((e) => e.classification === 'internal' || e.sourceIds.some((s) => byId.get(s)?.classification === 'internal')).length;
  return { included, excludedIds: [], internalCount, personCount: included.filter((e) => e.kind === 'person').length };
}

/** Plain-text context for prompts, built only from an OutboundSelection. */
export function toPromptContext(sel: OutboundSelection, lang: 'ja' | 'en'): string {
  return sel.included.map((e) => `- [${e.kind}] ${e.name[lang]}: ${e.description[lang]}`).join('\n');
}
