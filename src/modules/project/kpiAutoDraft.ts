import { aiLive, liveErrorCode, type AiRequest } from '../../ai/client.ts';
import { PER_USE_LIMITS, STEP_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { OkrExtension } from '../../data/extensionSchemas.ts';
import { loaded, packOrigin } from '../../data/pack.ts';
import type { CustomerPack } from '../../data/schema.ts';
import type { Lang } from '../../i18n/core.ts';
import { latestCompanyAnchor } from '../../state/companyAnchors.ts';
import { useProjects } from '../../state/projects.ts';
import {
  applyCopilotPick, applyKpiFill, applyMissingKpiDraftResponse, emptyKpiFields, kpiDraftPrompt, kpiFillPrompt, missingKpiDraftPrompt, missingKpiDrafts,
  openCandidates, parseKpiDraftResponse, provisionalFill, MAX_FILL_ROUNDS,
  type AddResult, type DraftPromptInput, type FillObjective, type FillResult, type KpiDrafts,
} from './kpiAdopt.ts';
import { packObjectiveDrafts } from './strategyPortal.ts';
import { kpisForScope, useKpiDrafts, useKpis, useObjectiveDrafts } from './stores.ts';

/**
 * D-46: Copilot drafts the project's KPIs/OKRs from what Work IQ found with the kpiOkrDraft use. The pick chooses
 * candidates (or, with none, proposes missing definitions); up to MAX_FILL_ROUNDS fill calls estimate every field the
 * material leaves empty and link each OKR to the objectives it serves; a labeled provisional rule sets whatever is
 * still empty, so no field stays blank. All of it writes drafts only: the user saves them.
 */

export type KpiOkrExt = Pick<OkrExtension, 'kpis' | 'objectives'> & Partial<Pick<OkrExtension, 'orgUnits'>>;

export function packOkrExt(pack: CustomerPack): KpiOkrExt {
  const parsed = OkrExtension.safeParse(pack.extensions?.okr);
  return parsed.success ? parsed.data : { kpis: [], objectives: [] };
}

/** Objectives an OKR may serve: the company's saved objectives, the pack's company-anchor drafts and FR-367 drafts. */
export function fillObjectives(companyId: string, pack: CustomerPack): FillObjective[] {
  let saved: FillObjective[] = [];
  try {
    saved = companyId ? latestCompanyAnchor(companyId)?.anchor.statedObjectives.map((o) => ({ id: o.id, text: o.text })) ?? [] : [];
  } catch { saved = []; }
  const all = [
    ...saved,
    ...packObjectiveDrafts(pack.extensions, saved.map((o) => o.id)).flatMap((o) => (o.id ? [{ id: o.id, text: o.text }] : [])),
    ...useObjectiveDrafts.getState().value.map((o) => ({ id: o.id, text: o.text })),
  ];
  return all.filter((o, i) => all.findIndex((x) => x.id === o.id) === i);
}

export interface KpiOkrTarget {
  scope: string;
  companyId: string;
  purpose: string;
}

/** The active project when its own Project pack is loaded (the only place the internal KPI/OKR candidates are). */
export function kpiOkrTarget(scope: string): KpiOkrTarget | null {
  if (packOrigin.kind !== 'imported' || packOrigin.projectId !== scope) return null;
  const { projects } = useProjects.getState();
  const project = projects.find((p) => p.id === scope);
  if (!project) return null;
  return { scope, companyId: project.companyId ?? '', purpose: project.brief?.purpose ?? '' };
}

const latestInput = (target: KpiOkrTarget, ext: KpiOkrExt, lang: Lang): DraftPromptInput => ({
  purpose: target.purpose, ext, lang,
  data: kpisForScope(useKpis.getState().value, target.scope),
  drafts: useKpiDrafts.getState().value,
});

export const kpiOkrRequest = (prompt: string, lang: Lang, scope: string): AiRequest => ({
  use: 'kpiOkrDraft', lang, prompt, scope, maxOutputTokens: PER_USE_LIMITS.kpiOkrDraft?.maxOutputTokens, timeoutMs: STEP_DRAFT_TIMEOUT_MS,
});

/** What the pick step would send now, or null when there is nothing to choose, propose or fill. */
export function kpiOkrPlanRequest(target: KpiOkrTarget, pack: CustomerPack, lang: Lang, today: string): AiRequest | null {
  const ext = packOkrExt(pack);
  const input = latestInput(target, ext, lang);
  const open = openCandidates(ext, input.data, input.drafts);
  if (open.kpis.length + open.objectives.length > 0) return kpiOkrRequest(kpiDraftPrompt(input), lang, target.scope);
  const missing = missingKpiDrafts(input);
  if (missing.kpis || missing.okrs) return kpiOkrRequest(missingKpiDraftPrompt(input, pack), lang, target.scope);
  const fill = kpiFillPrompt({ ...input, objectives: fillObjectives(target.companyId, pack), today });
  return fill ? kpiOkrRequest(fill, lang, target.scope) : null;
}

/** An answer cut off at the output cap varies with the model's reasoning, so one more attempt usually completes (D-44). */
async function once<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (signal.aborted || liveErrorCode(err) !== 'outputLimit') throw err;
    return call();
  }
}

export class KpiAnswerError extends Error {
  constructor(readonly step: 'pick' | 'fill') { super(`Copilot's ${step} answer could not be used`); }
}

/**
 * The fill on the drafts that read() returns: Copilot rounds while fields stay empty (more than MAX_FILL_DRAFTS drafts, or an
 * answer that left fields empty or unusable) and the last round filled something, then the provisional rule for the rest.
 * Each answer is applied to the drafts as they are when it arrives (the user may have edited one meanwhile). If no Copilot
 * round succeeds the error is returned with the provisional fill; an abort is thrown. Null when nothing needed filling.
 */
async function fillLoop(
  target: KpiOkrTarget, pack: CustomerPack, lang: Lang, today: string, signal: AbortSignal,
  read: () => KpiDrafts, write: (d: KpiDrafts) => void, stage?: string, alive: () => boolean = () => true,
): Promise<FillResult | null> {
  const ext = packOkrExt(pack);
  const objectives = fillObjectives(target.companyId, pack);
  let fields = 0;
  let okrs = 0;
  let rounds = 0;
  let error: unknown;
  let asked = false;
  while (rounds < MAX_FILL_ROUNDS) {
    const prompt = kpiFillPrompt({ purpose: target.purpose, ext, drafts: read(), objectives, lang, today });
    if (!prompt) break;
    asked = true;
    let r: FillResult;
    try {
      const result = await once(() => aiLive({ ...kpiOkrRequest(prompt, lang, target.scope), ...(stage ? { stage } : {}) }, signal), signal);
      if (!alive()) return null;
      try {
        r = applyKpiFill(result.text, read(), objectives);
      } catch {
        throw new KpiAnswerError('fill');
      }
    } catch (e) {
      if (signal.aborted || !alive()) throw e;
      error = e;
      break;
    }
    rounds++;
    write(r.drafts);
    fields += r.fields;
    okrs += r.okrs;
    if (r.fields + r.okrs === 0) break;
  }
  const rule = provisionalFill(read(), ext, lang, today);
  if (!asked && !rule.fields) return null;
  if (rule.fields) write(rule.drafts);
  const drafts = read();
  const remaining = drafts.kpis.reduce((n, d) => n + emptyKpiFields(d).length, 0);
  return { drafts, fields, okrs, remaining, provisional: rule.fields, rounds, ...(error ? { error } : {}) };
}

/**
 * The fill step on the stored drafts (the KPI panel); null when every draft is already complete or alive() turned false
 * (the user left the project), in which case nothing more is written.
 */
export async function fillKpiDrafts(
  target: KpiOkrTarget, pack: CustomerPack, lang: Lang, today: string, signal: AbortSignal, stage?: string, alive?: () => boolean,
): Promise<FillResult | null> {
  return fillLoop(target, pack, lang, today, signal, () => useKpiDrafts.getState().value, (d) => useKpiDrafts.getState().set(d), stage, alive);
}

export interface KpiOkrRun {
  drafts: KpiDrafts;
  pick: AddResult | null;
  rejected: number;
  fill: FillResult | null;
}

/** The all-step batch job: pick (or propose missing), then fill. Returns the drafts to save; nothing is stored here. */
export async function runKpiOkrDraft(
  target: KpiOkrTarget, pack: CustomerPack, lang: Lang, today: string, signal: AbortSignal, onStep?: (step: 'pick' | 'fill') => void,
): Promise<KpiOkrRun> {
  const ext = packOkrExt(pack);
  const before = latestInput(target, ext, lang);
  const open = openCandidates(ext, before.data, before.drafts);
  const missing = missingKpiDrafts(before);
  let drafts = before.drafts;
  let pick: AddResult | null = null;
  let rejected = 0;
  const proposeMissing = open.kpis.length + open.objectives.length === 0 && (missing.kpis || missing.okrs);
  if (open.kpis.length + open.objectives.length > 0 || proposeMissing) {
    onStep?.('pick');
    const prompt = proposeMissing ? missingKpiDraftPrompt(before, pack) : kpiDraftPrompt(before);
    const result = await once(() => aiLive({ ...kpiOkrRequest(prompt, lang, target.scope), stage: 'kpiOkr:pick' }, signal), signal);
    const latest = latestInput(target, ext, lang);
    try {
      if (proposeMissing) pick = applyMissingKpiDraftResponse(result.text, latest, pack);
      else {
        const parsed = parseKpiDraftResponse(result.text, latest);
        rejected = parsed.rejected.length;
        pick = applyCopilotPick(parsed, latest);
      }
    } catch {
      throw new KpiAnswerError('pick');
    }
    drafts = pick.drafts;
  }
  onStep?.('fill');
  const fill = await fillLoop(target, pack, lang, today, signal, () => drafts, (d) => { drafts = d; }, 'kpiOkr:fill');
  return { drafts, pick, rejected, fill };
}

/** For the batch plan: the current pack when it is the scope's own Project pack. */
export const scopePack = (scope: string): CustomerPack | null => (kpiOkrTarget(scope) ? loaded.pack : null);
