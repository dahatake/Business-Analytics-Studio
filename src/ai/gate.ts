import { C03_TABLE, isApprovedFor, type AiUse, type Provider } from './policy.ts';
import type { BudgetDecision } from './budget.ts';

export type GateReason =
  | 'c03NotApproved' // the per-use row in C-03 is TBD
  | 'liveDisabled' // FR-132: the user has not explicitly enabled real connections
  | 'notConfirmed' // the user has not confirmed purpose, content and cost for this send
  | 'notConfigured' // no connection settings (endpoint/deployment/key held by the relay)
  | 'noUnitPrice' // Copilot requires a premium-request price.
  | 'budget' // budget guard refused (see BudgetDecision.reasons)
  | 'personNotConfirmed' // FR-219: payload has "person" entities and the user did not confirm
  | 'liveFailed'; // the live call was attempted and failed (FR-283: fall back to the mock)

export interface GateInput {
  use: AiUse;
  /** The provider that would receive the call; the row must approve it (D-12). Omitted = any approved provider. */
  provider?: Provider;
  liveEnabled: boolean;
  userConfirmed: boolean;
  configured: boolean;
  hasUnitPrices: boolean;
  budget: BudgetDecision;
  personCount: number;
  personConfirmed: boolean;
}

export interface GateDecision {
  /** true only when every condition holds. Otherwise the caller must use the mock. */
  allowed: boolean;
  reasons: GateReason[];
}

/**
 * The single place that decides whether anything may leave the PC (C-03, FR-132, FR-219, NFR-SEC-002).
 * "Configured + authenticated + switch on" alone never allows a send (C-03). Since D-2, internal content is allowed.
 */
export function evaluateGate(i: GateInput, table = C03_TABLE): GateDecision {
  const reasons: GateReason[] = [];
  if (!isApprovedFor(table[i.use], i.provider)) reasons.push('c03NotApproved');
  if (!i.liveEnabled) reasons.push('liveDisabled');
  if (!i.userConfirmed) reasons.push('notConfirmed');
  if (!i.configured) reasons.push('notConfigured');
  if (i.provider !== 'foundry' && !i.hasUnitPrices) reasons.push('noUnitPrice');
  if (!i.budget.allowed) reasons.push('budget');
  if (i.personCount > 0 && !i.personConfirmed) reasons.push('personNotConfirmed');
  return { allowed: reasons.length === 0, reasons };
}
