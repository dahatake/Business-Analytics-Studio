import type { Entity } from '../data/schema.ts';

export interface OutboundSelection {
  /** Entities that may be sent. */
  included: Entity[];
  /** Ids withheld. Empty since D-2 (internal may be sent); kept so callers can show what was withheld if a rule returns. */
  excludedIds: string[];
  /** Number of internal entities included, shown in the send confirmation for transparency (D-2). */
  internalCount: number;
  /** Number of "person" entities included: FR-219 requires an explicit confirmation before sending/exporting them. */
  personCount: number;
}

/**
 * What may leave the PC. D-2 (user, 2026-11-09): internal information may be sent externally, which amends Q-055.
 * Two rules remain: the user sees how many internal and person items are included before sending, and person data
 * needs the FR-219 confirmation (enforced by the gate).
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
