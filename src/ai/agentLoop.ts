/**
 * D-51: the agentic loop shared by every AI feature that must end with complete data.
 *
 * ask → verify → keep what passed → ask again only for what is still missing. The loop is deterministic code around the
 * model (the same plan / act / observe / repair cycle as Microsoft Agent Framework or a Copilot Studio agentic loop),
 * so it works the same over Copilot, Foundry and every other provider, and it needs no extra runtime.
 *
 * Guarantees: a unit that passed verification is never asked for again and never overwritten (no data loss); a repair
 * asks only for the missing units (fewer tokens, shorter answers, faster); the loop stops when nothing improved
 * (stall), when the round or token budget is used up, or when the caller aborts.
 */

export interface LoopAnswer {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type LoopStop = 'complete' | 'stalled' | 'maxRounds' | 'budget' | 'aborted' | 'failed';

export interface LoopRound {
  round: number;
  asked: string[];
  accepted: string[];
}

export interface AgentLoopOptions<V> {
  /** Every unit (field, task, section) the result must contain. */
  units: readonly string[];
  /** Units that are already complete and verified (for example from an earlier attempt). They are not asked for. */
  seed?: Record<string, V>;
  /** Asks the model for exactly these units. Round 1 may ask for all of them; later rounds are repairs. */
  ask: (pending: string[], round: number) => Promise<LoopAnswer>;
  /** Returns only the units of `pending` that the answer holds in a valid form. */
  verify: (answer: LoopAnswer, pending: string[]) => Record<string, V>;
  /** Rounds including the first. Default 3 (one answer and two repairs). */
  maxRounds?: number;
  /** Total tokens (input + output) after which no further repair is started. Omitted = no cap. */
  tokenBudget?: number;
  signal?: AbortSignal;
  onRound?: (round: LoopRound) => void;
}

export interface AgentLoopResult<V> {
  values: Record<string, V>;
  missing: string[];
  rounds: LoopRound[];
  answers: LoopAnswer[];
  inputTokens: number | null;
  outputTokens: number | null;
  stop: LoopStop;
  /** The error that ended the loop (a failed round), if any. The values gathered before it are kept. */
  error?: unknown;
}

const sum = (answers: LoopAnswer[], key: 'inputTokens' | 'outputTokens') => (
  answers.length && answers.every((a) => a[key] !== null) ? answers.reduce((n, a) => n + a[key]!, 0) : null
);

export async function runAgentLoop<V>(opts: AgentLoopOptions<V>): Promise<AgentLoopResult<V>> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 3);
  const values: Record<string, V> = { ...(opts.seed ?? {}) };
  const rounds: LoopRound[] = [];
  const answers: LoopAnswer[] = [];
  const pendingOf = () => opts.units.filter((id) => !(id in values));
  let stop: LoopStop = 'complete';
  let error: unknown;
  for (let round = 1; pendingOf().length > 0; round++) {
    if (opts.signal?.aborted) { stop = 'aborted'; break; }
    if (round > maxRounds) { stop = 'maxRounds'; break; }
    if (round > 1 && opts.tokenBudget !== undefined) {
      const used = (sum(answers, 'inputTokens') ?? 0) + (sum(answers, 'outputTokens') ?? 0);
      if (used >= opts.tokenBudget) { stop = 'budget'; break; }
    }
    const pending = pendingOf();
    let answer: LoopAnswer;
    try {
      answer = await opts.ask(pending, round);
    } catch (err) {
      // The first round has nothing to keep, so its error belongs to the caller; a repair error keeps the partial result.
      if (round === 1 && Object.keys(values).length === 0) throw err;
      stop = opts.signal?.aborted ? 'aborted' : 'failed';
      error = err;
      break;
    }
    answers.push(answer);
    const verified = opts.verify(answer, pending);
    const accepted = pending.filter((id) => id in verified && !(id in values));
    for (const id of accepted) values[id] = verified[id]!;
    const entry = { round, asked: pending, accepted };
    rounds.push(entry);
    opts.onRound?.(entry);
    if (accepted.length === 0 && round > 1) { stop = 'stalled'; break; }
  }
  const missing = pendingOf();
  return {
    values, missing, rounds, answers,
    inputTokens: sum(answers, 'inputTokens'), outputTokens: sum(answers, 'outputTokens'),
    stop: missing.length === 0 ? 'complete' : stop === 'complete' ? 'maxRounds' : stop,
    ...(error !== undefined ? { error } : {}),
  };
}

export interface ValidAnswer<T> {
  value: T;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 1 when the first answer was valid; 2 or more when a correction was needed. */
  rounds: number;
}

/**
 * For an answer that is one document (a JSON proposal, a summary) rather than a list of units: ask, parse, and when the
 * parser rejects the answer ask once more with the reason. The reason is the only thing added to the second prompt (the
 * rejected answer is not sent back), and the parser's own error is thrown if the correction is rejected too.
 */
export async function askUntilValid<T>(opts: {
  ask: (feedback: string | null, round: number) => Promise<LoopAnswer>;
  parse: (text: string) => T;
  maxRounds?: number;
  signal?: AbortSignal;
}): Promise<ValidAnswer<T>> {
  let lastError: unknown;
  const loop = await runAgentLoop<T>({
    units: ['answer'],
    maxRounds: opts.maxRounds ?? 2,
    signal: opts.signal,
    ask: (_pending, round) => opts.ask(round === 1 ? null : (lastError instanceof Error ? lastError.message : String(lastError)), round),
    verify: (answer): Record<string, T> => {
      try {
        return { answer: opts.parse(answer.text) };
      } catch (err) {
        lastError = err;
        return {} as Record<string, T>;
      }
    },
  });
  if (loop.missing.length) throw lastError ?? loop.error;
  return { value: loop.values.answer as T, text: loop.answers.at(-1)!.text, inputTokens: loop.inputTokens, outputTokens: loop.outputTokens, rounds: loop.rounds.length };
}

/** The sentence appended to a prompt when an earlier answer was rejected. */
export const repairNote = (reason: string) => `\nREPAIR: your previous answer was rejected (${reason.slice(0, 300)}). Answer again with one complete, valid answer in the required format.`;
