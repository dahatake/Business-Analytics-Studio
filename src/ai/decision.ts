/**
 * D-44: Microsoft Foundry `Microsoft-Decision-1.1` for closed judgements (gates, filters, ranking) that the chat model used
 * to make inside generated text. Shared by the relay and the browser; nothing here sends data.
 * API: POST <resource>/providers/microsoft/v1/systemone with `model` = deployment name, `state` and typed `questions`.
 */

export const DECISION_MODEL = 'Microsoft-Decision-1.1';
export const DECISION_PATH = '/providers/microsoft/v1/systemone';
export const DECISION_TIMEOUT_MS = 30_000;
export const DECISION_TEST_TIMEOUT_MS = 30_000;
/** Questions per request; one request carries every candidate so the state is billed once. */
export const DECISION_MAX_QUESTIONS = 64;
/** Characters of JSON state; well under the model's 32,768-token input per question. */
export const DECISION_MAX_STATE_CHARS = 24_000;
export const DECISION_MAX_INSTRUCTION_CHARS = 600;
export const DECISION_MAX_CRITERION_CHARS = 300;
/** The decision uses the app records in its ledger (never sent to /relay/ai). */
export const DECISION_USES = ['kpiOkrScreen'] as const;
export type DecisionUse = (typeof DECISION_USES)[number];
/** Ledger label of the synthetic connection test (not a request use). */
export const DECISION_TEST_USE = 'decisionTest';

/**
 * Azure Retail Prices API, meter "Decision 1.1 Gl 1M Tokens" (Global, JPY, effective 2026-11-01): one rate for every
 * billed token. Used only to record an estimate in the app ledger; the Azure invoice is authoritative.
 */
export const DECISION_PRICE = {
  jpyPerMTokens: 6.64566,
  meter: 'Decision 1.1 Gl 1M Tokens',
  effective: '2026-11-01',
  source: 'https://prices.azure.com/api/retail/prices?currencyCode=JPY&$filter=meterName eq \'Decision 1.1 Gl 1M Tokens\'',
} as const;

export const decisionCostJpy = (inputTokens: number, outputTokens: number) => ((inputTokens + outputTokens) * DECISION_PRICE.jpyPerMTokens) / 1_000_000;

export interface DecisionConnection {
  /** Foundry resource origin, e.g. https://name.services.ai.azure.com */
  endpoint: string;
  deployment: string;
}

export const DECISION_INPUT_ERRORS = ['invalidBody', 'invalidEndpoint', 'invalidDeployment', 'invalidKey'] as const;
export type DecisionInputError = (typeof DECISION_INPUT_ERRORS)[number];

const HOST = /^[a-z0-9][a-z0-9-]{1,62}\.(services\.ai|cognitiveservices)\.azure\.com$/;
const DEPLOYMENT = /^[A-Za-z0-9._-]{1,64}$/;

export function parseDecisionEndpoint(endpoint: unknown, allowTestHttp = false): string | null {
  if (typeof endpoint !== 'string' || endpoint.length > 512) return null;
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { return null; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  const test = allowTestHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!test && (url.protocol !== 'https:' || url.port || !HOST.test(url.hostname))) return null;
  return url.origin;
}

/** Body of PUT /relay/decision: the key may be omitted to keep the saved one. */
export function validateDecisionConnection(input: unknown, allowTestHttp = false):
  { ok: true; value: DecisionConnection; key: string | null } | { ok: false; error: DecisionInputError } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalidBody' };
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => !['endpoint', 'deployment', 'key'].includes(k))) return { ok: false, error: 'invalidBody' };
  const endpoint = parseDecisionEndpoint(o.endpoint, allowTestHttp);
  if (!endpoint) return { ok: false, error: 'invalidEndpoint' };
  if (typeof o.deployment !== 'string' || !DEPLOYMENT.test(o.deployment.trim())) return { ok: false, error: 'invalidDeployment' };
  if (o.key !== undefined && (typeof o.key !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(o.key.trim()))) return { ok: false, error: 'invalidKey' };
  return { ok: true, value: { endpoint, deployment: o.deployment.trim() }, key: typeof o.key === 'string' ? o.key.trim() : null };
}

export const decisionUrl = (c: DecisionConnection) => `${c.endpoint}${DECISION_PATH}`;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface DecisionRequest {
  use: DecisionUse;
  state: Record<string, unknown>;
  questions: Record<string, NoulQuestion>;
}

const QUESTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Only `noul` questions are accepted: the app thresholds probabilities and never lets the model pick ids itself. */
export function validateDecisionRequest(input: unknown): DecisionRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => !['use', 'state', 'questions'].includes(k))) return null;
  if (!(DECISION_USES as readonly unknown[]).includes(o.use)) return null;
  if (!o.state || typeof o.state !== 'object' || Array.isArray(o.state)) return null;
  if (JSON.stringify(o.state).length > DECISION_MAX_STATE_CHARS) return null;
  if (!o.questions || typeof o.questions !== 'object' || Array.isArray(o.questions)) return null;
  const entries = Object.entries(o.questions as Record<string, unknown>);
  if (entries.length < 1 || entries.length > DECISION_MAX_QUESTIONS) return null;
  const questions: Record<string, NoulQuestion> = {};
  for (const [name, q] of entries) {
    if (!QUESTION_NAME.test(name) || !q || typeof q !== 'object' || Array.isArray(q)) return null;
    const { type, instructions, criteria, ...rest } = q as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || type !== 'noul' || !text(instructions, DECISION_MAX_INSTRUCTION_CHARS)) return null;
    let c: NoulQuestion['criteria'];
    if (criteria !== undefined) {
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return null;
      const { true: yes, false: no, ...more } = criteria as Record<string, unknown>;
      if (Object.keys(more).length > 0 || !text(yes, DECISION_MAX_CRITERION_CHARS) || !text(no, DECISION_MAX_CRITERION_CHARS)) return null;
      c = { true: yes as string, false: no as string };
    }
    questions[name] = { type: 'noul', instructions: instructions as string, ...(c ? { criteria: c } : {}) };
  }
  return { use: o.use as DecisionUse, state: o.state as Record<string, unknown>, questions };
}

export interface DecisionResult {
  /** Probability that each question is true, by question name. */
  answers: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Every asked question must come back as a finite probability; anything missing, extra or malformed is rejected. */
export function parseDecisionAnswers(raw: unknown, names: readonly string[]): DecisionResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { answers, usage } = raw as { answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const got = answers as Record<string, unknown>;
  if (Object.keys(got).length !== names.length) return null;
  const out: Record<string, number> = {};
  for (const name of names) {
    const a = got[name] as { type?: unknown; noul?: unknown } | undefined;
    if (!a || a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) return null;
    out[name] = a.noul;
  }
  if (!count(usage?.input_tokens) || !count(usage?.output_tokens)) return null;
  return { answers: out, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/** Synthetic connection test: no business data; the answer must be a valid probability. */
export const DECISION_TEST_REQUEST: Omit<DecisionRequest, 'use'> = {
  state: { note: 'Connection test. No business data is included.', statement: 'The sky is usually blue on a clear day.' },
  questions: { test: { type: 'noul', instructions: 'Is the statement true?' } },
};
