import type { UsageRecord } from './budget.ts';
import { dictionaries, type Lang } from '../i18n/core.ts';

/** Token totals of a group of ledger records. Tokens are what the provider reported (or the app's estimate, counted apart). */
export interface TokenTotals {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Calls whose tokens are the app's estimate because the provider reported no usage. */
  estimatedCalls: number;
}

export interface TokenLine extends TokenTotals {
  use: string;
  /** Pack-generation step or another use's recorded stage; absent when no stage was recorded. */
  step?: string;
}

export interface TokenSummary {
  lines: TokenLine[];
  total: TokenTotals;
}

/** A stage name belongs to pack generation only for packBuild; other uses retain their own labels. */
export function tokenLineLabel(line: TokenLine, lang: Lang): string {
  const texts: Readonly<Record<string, string>> = dictionaries[lang];
  const stage = line.use === 'packBuild' && line.step ? texts[`proj.gen.step.${line.step}`] : undefined;
  return stage ?? texts[`ai.use.${line.use}`] ?? (line.use || dictionaries[lang]['ai.tokens.unavailable']);
}

/** Pack generation stages map to the dialog's steps; every fix round belongs to "verify", every re-run to its stage. */
export function stepOfStage(stage: string | undefined): string | undefined {
  if (!stage) return undefined;
  if (stage.startsWith('fix-')) return 'verify';
  const rerun = /^(foundation|business)-\d+$/.exec(stage);
  return rerun ? rerun[1] : stage;
}

const empty = (): TokenTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCalls: 0 });

function add(t: TokenTotals, r: Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'estimated'>) {
  const input = r.inputTokens !== null && Number.isFinite(r.inputTokens) && r.inputTokens >= 0 ? r.inputTokens : null;
  const output = r.outputTokens !== null && Number.isFinite(r.outputTokens) && r.outputTokens >= 0 ? r.outputTokens : null;
  t.calls++;
  t.inputTokens = t.inputTokens === null || input === null ? null : t.inputTokens + input;
  t.outputTokens = t.outputTokens === null || output === null ? null : t.outputTokens + output;
  t.totalTokens = t.totalTokens === null || input === null || output === null ? null : t.totalTokens + input + output;
  if (r.estimated) t.estimatedCalls++;
}

/** Per use and recorded stage in first-use order, plus the total. The total is always the sum of the lines. */
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

/** The records of one job run: the calls of a work target since the job started, optionally limited to the job's uses. */
export function recordsOfJob(records: readonly UsageRecord[], job: { scope: string | null; since: string; uses?: readonly string[] }): UsageRecord[] {
  return records.filter((r) => r.scope === (job.scope ?? undefined) && r.at >= job.since && (!job.uses || job.uses.includes(r.use)));
}
