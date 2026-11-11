import type { UsageRecord } from './budget.ts';

/** Token totals of a group of ledger records. Tokens are what the provider reported (or the app's estimate, counted apart). */
export interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** null when any call in the group has an unknown price (Foundry): unknown is never treated as free. */
  costJpy: number | null;
  /** Calls whose tokens are the app's estimate because the provider reported no usage. */
  estimatedCalls: number;
}

export interface TokenLine extends TokenTotals {
  use: string;
  /** Pack generation step: 'foundation' | 'business' | 'verify' (all fix rounds); absent for other uses. */
  step?: string;
}

export interface TokenSummary {
  lines: TokenLine[];
  total: TokenTotals;
}

/** Pack generation stages map to the dialog's steps; every fix round belongs to "verify". */
export function stepOfStage(stage: string | undefined): string | undefined {
  if (!stage) return undefined;
  return stage.startsWith('fix-') ? 'verify' : stage;
}

const empty = (): TokenTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costJpy: 0, estimatedCalls: 0 });

function add(t: TokenTotals, r: Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'costJpy' | 'estimated'>) {
  const input = Number.isFinite(r.inputTokens) && r.inputTokens > 0 ? r.inputTokens : 0;
  const output = Number.isFinite(r.outputTokens) && r.outputTokens > 0 ? r.outputTokens : 0;
  t.calls++;
  t.inputTokens += input;
  t.outputTokens += output;
  t.totalTokens += input + output;
  t.costJpy = t.costJpy === null || r.costJpy === null ? null : t.costJpy + r.costJpy;
  if (r.estimated) t.estimatedCalls++;
}

/** Per use (and pack-generation step) in the order first used, plus the total. The total is always the sum of the lines. */
export function summarizeTokens(records: readonly UsageRecord[]): TokenSummary {
  const lines = new Map<string, TokenLine>();
  const total = empty();
  const ordered = [...records].sort((a, b) => a.at.localeCompare(b.at));
  for (const r of ordered) {
    const step = stepOfStage(r.stage);
    const key = `${r.use}\u0000${step ?? ''}`;
    let line = lines.get(key);
    if (!line) {
      line = { use: r.use, ...(step ? { step } : {}), ...empty() };
      lines.set(key, line);
    }
    add(line, r);
    add(total, r);
  }
  return { lines: [...lines.values()], total };
}

/** The ledger records of one work target ('demo' or a project id). Records without a scope are app-level or older. */
export function recordsOfScope(records: readonly UsageRecord[], scope: string): UsageRecord[] {
  return records.filter((r) => r.scope === scope);
}
