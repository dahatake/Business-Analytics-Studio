import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { jstMonth } from '../src/ai/budget.ts';
import { STORY_CAP_JPY, STORY_MONTHLY_CAP_JPY, STORY_SAFETY_FACTOR, STORY_SYSTEM_PROMPT } from '../src/ai/storyOutput.ts';
import type { FoundryConnection } from '../src/ai/foundry.ts';
import { replaceFileSync } from './files.ts';

const Pricing = z.object({
  endpoint: z.string(),
  deployment: z.string().min(1),
  model: z.string().regex(/^(?:gpt(?:-\d+(?:\.\d+)?)?-chat-latest|model-router)$/),
  inputPerM: z.number().finite().positive(),
  outputPerM: z.number().finite().positive(),
  source: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      /^(?:[a-z0-9-]+\.)*(?:microsoft\.com|azure\.com)$/.test(url.hostname);
  }),
  expiresAt: z.iso.datetime(),
}).strict();
const Allocations = z.record(z.string().regex(/^\d{4}-\d{2}$/), z.number().finite().nonnegative());

export class StoryBudgetError extends Error {
  constructor(readonly code: 'storyPricing' | 'storyCap' | 'storyMonthlyCap' | 'storyBudgetUnavailable') {
    super(code);
  }
}

/** The same Foundry resource may be saved with or without the `/openai/v1` path; prices bind to the HTTPS origin. */
function sameResource(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase();
  } catch {
    return false;
  }
}

/** Rate ceilings in JPY, including exchange-rate/tax allowance; never guessed from a deployment alias. */
export function storyQuote(dir: string, conn: FoundryConnection, prompt: string, context: string, outputTokens: number, now: number) {
  let pricing: z.infer<typeof Pricing>;
  try {
    pricing = Pricing.parse(JSON.parse(readFileSync(join(dir, 'story-pricing.json'), 'utf8')));
  } catch {
    throw new StoryBudgetError('storyPricing');
  }
  if (!sameResource(pricing.endpoint, conn.endpoint) || pricing.deployment !== conn.deployment || Date.parse(pricing.expiresAt) <= now) {
    throw new StoryBudgetError('storyPricing');
  }
  // UTF-8 bytes bound byte-level text tokens; reserve additional chat-envelope overhead, not a CJK heuristic.
  const inputTokens = Buffer.byteLength(`${STORY_SYSTEM_PROMPT}${prompt}\n\n${context}`, 'utf8') + 1024;
  const maximumJpy = Math.ceil((inputTokens * pricing.inputPerM + outputTokens * pricing.outputPerM) / 1_000_000 * STORY_SAFETY_FACTOR * 100) / 100;
  if (!Number.isFinite(maximumJpy) || maximumJpy > STORY_CAP_JPY) throw new StoryBudgetError('storyCap');
  let allocations: z.infer<typeof Allocations>;
  try {
    const file = join(dir, 'story-budget.json');
    allocations = existsSync(file) ? Allocations.parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
  } catch {
    throw new StoryBudgetError('storyBudgetUnavailable');
  }
  const month = jstMonth(new Date(now));
  const allocatedJpy = allocations[month] ?? 0;
  if (allocatedJpy + maximumJpy > STORY_MONTHLY_CAP_JPY) throw new StoryBudgetError('storyMonthlyCap');
  return { maximumJpy, allocatedJpy, remainingJpy: STORY_MONTHLY_CAP_JPY - allocatedJpy, source: pricing.source, expiresAt: pricing.expiresAt, inputTokens, pricing, allocations, month };
}

/** Persist the entire reservation before sending. Failures/timeouts keep it; no refunds or automatic retries. */
export function reserveStory(dir: string, conn: FoundryConnection, prompt: string, context: string, outputTokens: number, now: number) {
  const lock = join(dir, 'story-budget.lock');
  try {
    mkdirSync(lock);
  } catch {
    throw new StoryBudgetError('storyBudgetUnavailable');
  }
  try {
    const quote = storyQuote(dir, conn, prompt, context, outputTokens, now);
    quote.allocations[quote.month] = Math.round((quote.allocatedJpy + quote.maximumJpy) * 100) / 100;
    const temporary = join(dir, `story-budget-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(quote.allocations), { mode: 0o600, flag: 'wx' });
      replaceFileSync(temporary, join(dir, 'story-budget.json'));
    } finally {
      rmSync(temporary, { force: true });
    }
    return quote;
  } finally {
    rmdirSync(lock);
  }
}
