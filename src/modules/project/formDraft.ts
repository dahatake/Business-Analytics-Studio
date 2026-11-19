import { z } from 'zod';
import { aiComplete, registerMock, type AiRequest, type AiResponse } from '../../ai/client.ts';
import type { Entity } from '../../data/schema.ts';
import type { Lang } from '../../i18n/core.ts';
import { validRange } from './simulate.ts';

/**
 * "Draft with Copilot" for single-item forms (use case, KPI contribution, deliverable section). The answer is only a
 * proposal: the form shows it next to the current input and nothing is written until the person approves it.
 * Without a live connection the answer is a deterministic, labelled mock built from the same context.
 */

export type FormDraftKind = 'usecase' | 'contribution' | 'section';
const MARK = '[bas-proj:form:';

const text = z.string().trim();
const Range = z.object({ low: z.number(), mode: z.number(), high: z.number() }).refine(validRange);

export const FORM_DRAFT_SCHEMAS = {
  usecase: z.object({
    name: text.min(1),
    summary: text.default(''),
    effect: text.default(''),
    steps: z.array(z.object({ title: text.min(1), description: text.default('') })).min(1).max(8),
  }),
  contribution: z.object({
    lever: text.min(1),
    leverUnit: text.default(''),
    amount: Range,
    effectPerUnit: Range,
    evidence: text.default(''),
  }),
  section: z.object({ text: text.min(1) }),
} as const;

export type FormDraft = { [K in FormDraftKind]: z.infer<(typeof FORM_DRAFT_SCHEMAS)[K]> };

export interface UseCaseDraftContext {
  name: string;
  summary: string;
  /** Inputs from the previous step: the ranked issues of the current-state analysis. */
  issues: string[];
  persona: string;
}
export interface ContributionDraftContext {
  solution: string;
  kpi: { name: string; unit: string; current: number; target: number; deadline: string };
  lever: string;
}
export interface SectionDraftContext {
  solution: string;
  document: string;
  section: string;
  current: string;
  /** Facts from earlier steps the section can cite (KPI, contribution, use case). */
  facts: string[];
  /** The points this kind of section must cover (handbook tables), in order. */
  guide?: string[];
  /** Material found for this section (Work IQ answer, imported file): quote it with its source, never go beyond it. */
  evidence?: { text: string; source: string }[];
}
export type FormDraftContext = { usecase: UseCaseDraftContext; contribution: ContributionDraftContext; section: SectionDraftContext };

const SHAPE: Record<FormDraftKind, string> = {
  usecase: '{"name": string, "summary": string, "effect": string, "steps": [{"title": string, "description": string}] (1-8 steps)}',
  contribution: '{"lever": string, "leverUnit": string, "amount": {"low": number, "mode": number, "high": number}, "effectPerUnit": {"low": number, "mode": number, "high": number}, "evidence": string} (low <= mode <= high; amount x effectPerUnit is the change of the KPI)',
  section: '{"text": string}',
};

export function formDraftPrompt<K extends FormDraftKind>(kind: K, context: FormDraftContext[K], lang: Lang): string {
  const language = lang === 'ja' ? 'Japanese' : 'English';
  const sectionRules = kind === 'section'
    ? ['Cover every point of CONTEXT.guide in order, one statement per line; each statement must be verifiable (a number, a bound or a yes/no check).',
      'Use CONTEXT.evidence only as it is written and name its source; where evidence is missing, write the point as an open question instead of inventing it.']
    : [];
  return [
    `${MARK}${kind}]`,
    `Draft the ${kind} described by CONTEXT for a business improvement project. Write in ${language}.`,
    'Build on the given inputs from earlier steps; do not invent company facts. Mark any assumption as an assumption.',
    ...sectionRules,
    `Answer with one JSON object only, shaped ${SHAPE[kind]}.`,
    `CONTEXT: ${JSON.stringify(context)}`,
  ].join('\n');
}

const contextOf = (prompt: string): unknown => {
  const at = prompt.indexOf('CONTEXT: ');
  if (at < 0) return null;
  try {
    return JSON.parse(prompt.slice(at + 'CONTEXT: '.length));
  } catch {
    return null;
  }
};

const round = (v: number) => Number(v.toPrecision(3));

/** Deterministic drafts from the context, so the flow can be tried and tested without a live model. */
export function mockFormDraft<K extends FormDraftKind>(kind: K, context: FormDraftContext[K], lang: Lang): FormDraft[K] {
  const ja = lang === 'ja';
  if (kind === 'usecase') {
    const c = context as UseCaseDraftContext;
    const issue = c.issues[0] ?? (ja ? '現状の課題' : 'the current issue');
    const draft: FormDraft['usecase'] = {
      name: c.name.trim() || (ja ? `${issue}を解消する業務` : `Resolve: ${issue}`),
      summary: c.summary.trim() || (ja ? `現状分析で最優先とされた「${issue}」を、担当者が日々の業務の中で解消できる状態にする。` : `Let the team resolve "${issue}", the top issue of the current-state analysis, in their daily work.`),
      effect: ja ? `「${issue}」に関わる手戻りと待ち時間を減らす(仮説・要検証)` : `Less rework and waiting caused by "${issue}" (assumption, to be verified)`,
      steps: ja
        ? [
          { title: '状況をつかむ', description: `「${issue}」に関わる最新の状況を一か所で確かめる。` },
          { title: '判断する', description: '優先度と影響を見て、対応の順番を決める。' },
          { title: '実行して記録する', description: '対応した結果を記録し、次の判断に使う。' },
        ]
        : [
          { title: 'See the situation', description: `Check the latest state related to "${issue}" in one place.` },
          { title: 'Decide', description: 'Order the responses by priority and impact.' },
          { title: 'Act and record', description: 'Record the result and use it for the next decision.' },
        ],
    };
    return draft as FormDraft[K];
  }
  if (kind === 'contribution') {
    const c = context as ContributionDraftContext;
    const gap = c.kpi.target - c.kpi.current;
    const per = gap === 0 ? 1 : round(gap / 10);
    const effect = [per * 0.5, per, per * 1.5].map(round).sort((a, b) => a - b) as [number, number, number];
    const draft: FormDraft['contribution'] = {
      lever: c.lever.trim() || (ja ? `${c.solution}を使う業務の件数` : `Work items handled with ${c.solution}`),
      leverUnit: ja ? '件/月' : 'items/month',
      amount: { low: 5, mode: 10, high: 15 },
      effectPerUnit: { low: effect[0], mode: effect[1], high: effect[2] },
      evidence: ja
        ? `仮説: 10 件で「${c.kpi.name}」の目標との差 (${round(gap)} ${c.kpi.unit}) が埋まると仮定。実績で確かめる。`
        : `Assumption: 10 items close the gap of "${c.kpi.name}" (${round(gap)} ${c.kpi.unit}). Verify with actuals.`,
    };
    return draft as FormDraft[K];
  }
  const c = context as SectionDraftContext;
  const facts = c.facts.slice(0, 4).map((f) => `- ${f}`).join('\n');
  const guide = (c.guide ?? []).map((g) => `- ${g}`).join('\n');
  const evidence = (c.evidence ?? []).slice(0, 3).map((e) => `- ${e.text} (${e.source})`).join('\n');
  const head = `${c.solution}: ${c.section}`;
  const body = ja
    ? `${c.document}の「${c.section}」の下書きです。前のステップで確定した内容に基づきます。`
    : `Draft of "${c.section}" in the ${c.document}, based on what the earlier steps confirmed.`;
  const draft: FormDraft['section'] = { text: [head, body, facts, evidence, guide, c.current.trim() ? (ja ? `現在の記述: ${c.current.trim()}` : `Current text: ${c.current.trim()}`) : ''].filter(Boolean).join('\n') };
  return draft as FormDraft[K];
}

/** Strict parse of a model answer: the first JSON object in the text, checked against the form's rules. */
export function parseFormDraft<K extends FormDraftKind>(kind: K, answer: string): FormDraft[K] | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = FORM_DRAFT_SCHEMAS[kind].safeParse(value);
  return parsed.success ? (parsed.data as FormDraft[K]) : null;
}

const isFormDraft = (req: AiRequest) => req.prompt.startsWith(MARK);
function formMock(req: AiRequest): string {
  const kind = req.prompt.slice(MARK.length).split(']')[0] as FormDraftKind;
  const context = contextOf(req.prompt);
  if (!(kind in FORM_DRAFT_SCHEMAS) || !context) return '{}';
  return JSON.stringify(mockFormDraft(kind, context as FormDraftContext[typeof kind], req.lang));
}

export interface FormDraftResult<K extends FormDraftKind> {
  response: AiResponse;
  draft: FormDraft[K] | null;
}
export type FormDraftRequest<K extends FormDraftKind> = () => Promise<FormDraftResult<K>>;

export async function requestFormDraft<K extends FormDraftKind>(kind: K, context: FormDraftContext[K], lang: Lang, entities: Entity[] = []): Promise<FormDraftResult<K>> {
  registerMock('deliverableDraft', formMock, isFormDraft);
  const response = await aiComplete({ use: 'deliverableDraft', lang, prompt: formDraftPrompt(kind, context, lang), entities });
  return { response, draft: parseFormDraft(kind, response.text) };
}
