import type { BudgetDecision } from './budget.ts';

export type GateReason =
  | 'liveDisabled' // FR-132: the user has not explicitly enabled real connections
  | 'notConfirmed' // the user has not given broad send consent in AI settings
  | 'notConfigured' // no connection settings (endpoint/deployment/key held by the relay)
  | 'budget' // a safety limit refused (token cap, minimum interval, daily calls; see BudgetDecision.reasons)
  | 'inputTooLarge' // prompt plus context exceeds the relay limit for this use
  | 'liveFailed'; // the live call was attempted and failed (FR-283: fall back to the mock)

export interface GateInput {
  liveEnabled: boolean;
  sendConsent: boolean;
  configured: boolean;
  budget: BudgetDecision;
}

export interface GateDecision {
  /** true only when every condition holds. Otherwise the caller must use the mock. */
  allowed: boolean;
  reasons: GateReason[];
}

/** The single place that decides whether anything may leave the PC. */
export function evaluateGate(i: GateInput): GateDecision {
  const reasons: GateReason[] = [];
  if (!i.liveEnabled) reasons.push('liveDisabled');
  if (!i.sendConsent) reasons.push('notConfirmed');
  if (!i.configured) reasons.push('notConfigured');
  if (!i.budget.allowed) reasons.push('budget');
  return { allowed: reasons.length === 0, reasons };
}
