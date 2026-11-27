import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Link, MessageBar, MessageBarBody, Select, Spinner } from '@fluentui/react-components';
import { Checkmark20Regular, Dismiss20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { AiLiveError, preflight } from '../../ai/client.ts';
import { STEP_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { deviceStatus, flushDeviceStorage } from '../../data/deviceStorage.ts';
import { loaded, loadPack } from '../../data/pack.ts';
import type { LText } from '../../data/schema.ts';
import { useI18n, type Formatters, type Lang } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { commitPackChanges } from '../../state/packEdits.ts';
import { currentScope, IMPROVEMENT_STEPS, useActiveProject, useCurrentScope, type ImprovementStep } from '../../state/projects.ts';
import { setPortalReturn } from '../../state/portalReturn.ts';
import { hrefFor, revisitRouteTarget, useRoute } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { reasonKey, TokensInline } from '../ai/AiCommon.tsx';
import { AiProgress, type AiStage } from '../ai/AiProgress.tsx';
import { useAiSettings } from '../ai/settingsStore.ts';
import { openAiSettings } from '../ai/uiStore.ts';
import { ScrollRegion } from './common.tsx';
import type { AppCheckContext as CheckContext } from './deliverables.ts';
import { todayIn, todoHref, todoLabel, usePaybackLimit } from './deliverablesUi.tsx';
import { collectObjectives, objectiveDraftInput, storeObjectives, type ObjectiveProgress, type ObjectiveSearch } from './objectiveDraft.ts';
import {
  availableAxes, itemNames, overviewBaseline, overviewContext, overviewPrompt, proposalEntities, recommendedAxis, requestLiveOverview, strategyMap,
  useOverview, validateOverviewProposal, type OverviewAxis, type OverviewDraft, type OverviewProposal, type StrategyDrafts,
} from './overviewModel.ts';
import { BriefBody } from './StepBriefPanel.tsx';
import { buildStepBrief } from './stepBrief.ts';
import { stepDashboard } from './stepDashboard.ts';
import { useKpiDrafts, useObjectiveDrafts, useProjUi } from './stores.ts';
import { ObjectiveDialog } from './StrategyObjectiveDialog.tsx';
import {
  emptyDomId, nodeDetails, nodeDomId, packObjectiveDrafts, type DetailRow,
} from './strategyPortal.ts';
import { StrategyMapView, StrategyPreview, type Portal } from './StrategyMap.tsx';
import './overview.css';

type Details = Map<string, DetailRow[]>;

function ProposalBody({ proposal, ctx }: { proposal: OverviewProposal; ctx: CheckContext }) {
  const { t } = useI18n();
  const names = useMemo(() => itemNames(ctx), [ctx]);
  return (
    <div className="strategy-proposal">
      <p className="step-brief-answer">{proposal.answer}</p>
      <h3>{t('proj.dash.brief.findings')}</h3>
      <ol>{proposal.findings.map((f, i) => <li key={i}>{f.text}<Evidence ids={f.refs} names={names} /></li>)}</ol>
      <h3>{t('proj.dash.brief.actions')}</h3>
      <ol>{proposal.actions.map((f, i) => <li key={i}>{f.text}<Evidence ids={f.refs} names={names} /></li>)}</ol>
      <h3>{t('proj.dash.brief.caveats')}</h3>
      <ul>{proposal.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
      <p>{t('stg.axis')}: {t(`stg.axis.${proposal.axis}`)} — {proposal.axisReason}</p>
    </div>
  );
}

type Names = Map<string, (l: Lang) => string>;

function Evidence({ ids, names }: { ids: string[]; names?: Names }) {
  const { lang } = useI18n();
  return <span className="strategy-refs">{ids.map((id) => {
    return loaded.byId.has(id) ? <EntityRef key={id} id={id} /> : <span key={id}>{names?.get(id)?.(lang) ?? id}</span>;
  })}</span>;
}

const PATCH_FIELDS = ['description', 'kpiIds', 'issueIds', 'impact', 'feasibility'] as const;

/** fmt.date takes a JST calendar date, so derive it before adding the time. */
const stamp = (at: string, fmt: Formatters) => `${fmt.date(new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }))} ${fmt.time(new Date(at))}`;

function fieldText(value: unknown, names: Names, lang: Lang, unknown: string): string {
  if (Array.isArray(value)) return value.length ? value.map((id: string) => names.get(id)?.(lang) ?? id).join(lang === 'ja' ? '、' : ', ') : unknown;
  if (value && typeof value === 'object') return loc(value as LText, lang);
  return value === undefined || value === null || value === '' ? unknown : String(value);
}

function DraftDiff({ draft, ctx, stale }: { draft: OverviewDraft; ctx: CheckContext; stale: boolean }) {
  const { t, lang } = useI18n();
  const names = useMemo(() => itemNames(ctx), [ctx]);
  const replacements = new Map((stale ? [] : proposalEntities(draft.proposal, ctx)).map((e) => [e.id, e]));
  const preview = { ...ctx, pack: loadPack({ ...ctx.pack.pack, entities: ctx.pack.pack.entities.map((e) => replacements.get(e.id) ?? e) }) };
  const name = (id: string) => names.get(id)?.(lang) ?? id;
  const links = (xs: OverviewProposal['objectiveIssues']) => xs.length
    ? <ul>{xs.map((x) => <li key={`${x.objectiveId}-${x.issueId}`}>{name(x.objectiveId)} → {name(x.issueId)}: {x.reason}</li>)}</ul>
    : <p>{t('stg.noLinks')}</p>;
  return (
    <>
      <ProposalBody proposal={draft.proposal} ctx={ctx} />
      {!stale && <StrategyPreview map={strategyMap(preview, { objectiveIssues: draft.proposal.objectiveIssues }, draft.proposal.axis, lang)} />}
      <h3>{t('stg.before')} → {t('stg.after')}</h3>
      {!draft.proposal.patches.length && <p>{t('stg.noPatches')}</p>}
      {draft.proposal.patches.map((p) => {
        const e = ctx.pack.byId.get(p.id);
        if (!e) return null;
        const fields = PATCH_FIELDS.filter((k) => p[k] !== undefined);
        return (
          <section className="strategy-diff" key={p.id} data-testid="strategy-diff">
            <h4>{e.name[lang]}</h4>
            <table className="strategy-diff-table">
              <thead><tr><th scope="col">{t('stg.field')}</th><th scope="col">{t('stg.before')}</th><th scope="col">{t('stg.after')}</th></tr></thead>
              <tbody>{fields.map((k) => {
                const before = fieldText(e[k as keyof typeof e], names, lang, t('stg.unknown'));
                const after = fieldText(p[k], names, lang, t('stg.unknown'));
                return (
                  <tr key={k} className={before === after ? undefined : 'changed'}>
                    <th scope="row">{t(`stg.field.${k}`)}</th><td>{before}</td><td>{after}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            <p>{t('stg.reason')}: {p.reason}</p><Evidence ids={p.refs} names={names} />
          </section>
        );
      })}
      <h3>{t('stg.objectiveLinks')}</h3>
      <div className="strategy-diff-columns">
        <div><strong>{t('stg.before')}</strong>{links(useOverview.getState().value.objectiveIssues)}</div>
        <div><strong>{t('stg.after')}</strong>{links(draft.proposal.objectiveIssues)}</div>
      </div>
    </>
  );
}

/** Shared across the replacement overview and every improvement-step dashboard. */
export function StrategyOverview({ ctx: raw, step, analysis = false }: { ctx: CheckContext; step: ImprovementStep; analysis?: boolean }) {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const route = useRoute();
  const scope = useCurrentScope();
  const state = useOverview((s) => s.value);
  const set = useOverview((s) => s.set);
  const ctx = useMemo(() => overviewContext(raw, audience), [raw, audience]);
  const axes = useMemo(() => availableAxes(ctx), [ctx]);
  const recommended = useMemo(() => recommendedAxis(ctx), [ctx]);
  const axis = state.axis && axes.includes(state.axis) ? state.axis : recommended;
  const descending = state.descending !== false;
  // Serializes the whole pack and project data: computed when they change, not on every render.
  const baseline = useMemo(() => overviewBaseline(raw, state), [raw, state.objectiveIssues]);
  const draftKey = `${audience}:${step}`;
  const stepDraft = state.stepDrafts?.[draftKey];
  const sharedDraft = state.draft?.audience === audience ? state.draft : undefined;
  const [showShared, setShowShared] = useState(route.query.get('draft') === 'shared');
  const draft = showShared ? sharedDraft ?? stepDraft : stepDraft ?? sharedDraft;
  const kpiDrafts = useKpiDrafts((s) => s.value);
  const objectiveDrafts = useObjectiveDrafts((s) => s.value);
  const { company } = useActiveProject();
  const internal = audience === 'internal';
  // FR-350: unsaved drafts are internal working data, so the external view keeps showing confirmed data only.
  const drafts = useMemo((): StrategyDrafts => internal ? {
    objectives: [
      ...packObjectiveDrafts(loaded.pack.extensions, ctx.objectives.map((o) => o.id)).map((o) => ({ id: o.id!, text: o.text })),
      ...objectiveDrafts.map((o) => ({ id: o.id, text: o.text })),
    ],
    okrs: kpiDrafts.okrs.map((o) => ({ id: o.id, objective: o.objective.trim() || t('stg.untitled'), kpiIds: o.keyResults.map((kr) => kr.kpiId).filter(Boolean), objectiveIds: o.companyObjectiveIds })),
    kpis: kpiDrafts.kpis.map((k) => ({ id: k.id, name: k.name.trim() || t('stg.untitled') })),
    changed: draft ? draft.proposal.patches.map((p) => p.id) : [],
    objectiveIssues: draft?.proposal.objectiveIssues ?? [],
  } : {}, [internal, ctx, kpiDrafts, objectiveDrafts, draft, t]);
  const map = useMemo(() => strategyMap(ctx, internal ? state : { objectiveIssues: [] }, axis, lang, descending, drafts), [ctx, state, axis, lang, descending, internal, drafts]);
  // FR-381: each item's structured sub-data (key results, values, causes, sources, costs…) with links to the exact field.
  const details = useMemo((): Details => new Map(map.nodes.map((n) => [n.id, nodeDetails(n, ctx, lang, fmt, drafts)])), [map, ctx, lang, fmt, drafts]);
  const [objectiveDialog, setObjectiveDialog] = useState<{ draftId?: string } | null>(null);
  const [objectiveSaved, setObjectiveSaved] = useState(false);
  const portal = useMemo((): Portal => ({
    companyId: company?.id ?? '',
    canEditObjectives: internal && !!company,
    inert: internal ? [] : ['objective'],
    onObjective: (draftId) => setObjectiveDialog({ draftId }),
    onLeave: (label, domId) => {
      const q = new URLSearchParams(route.query);
      q.set('target', domId);
      setPortalReturn({ path: route.path, href: hrefFor(route.path, q), label });
    },
  }), [company, internal, route]);
  const storedDraft = objectiveDialog?.draftId ? objectiveDrafts.find((o) => o.id === objectiveDialog.draftId) ?? null : null;
  const objectiveDraft = storedDraft ? objectiveDraftInput(storedDraft) : objectiveDialog?.draftId
    ? packObjectiveDrafts(loaded.pack.extensions, ctx.objectives.map((o) => o.id)).find((o) => o.id === objectiveDialog.draftId) ?? null
    : null;
  const closeObjective = (savedId?: string, discarded?: boolean) => {
    const draftId = objectiveDialog?.draftId;
    if ((savedId || discarded) && draftId && objectiveDrafts.some((o) => o.id === draftId)) {
      useObjectiveDrafts.getState().set((list) => list.filter((o) => o.id !== draftId));
    }
    const returnTo = savedId ? nodeDomId(`objective:${savedId}`) : draftId && !discarded ? nodeDomId(`objective:draft:${draftId}`) : emptyDomId('objective');
    setObjectiveDialog(null);
    if (savedId) setObjectiveSaved(true);
    // Fluent restores focus to the opener; once the map re-renders the saved node replaces it, so focus that instead.
    requestAnimationFrame(() => requestAnimationFrame(() => (document.getElementById(returnTo) as (HTMLElement & SVGElement) | null)?.focus()));
  };
  const isStepDraft = !!draft && draft === stepDraft;
  const approved = state.approved?.audience === audience && state.approved.lang === lang ? state.approved : undefined;
  const stale = !!draft && (draft.baseline !== baseline || draft.lang !== lang);
  const [busy, setBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<{ stage: AiStage; startedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'draft' | 'approved' | null>(null);
  const latest = useRef({ raw, state, scope, audience, lang, step });
  latest.current = { raw, state, scope, audience, lang, step };
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; abort.current?.abort(); };
  }, []);
  useEffect(() => { abort.current?.abort(); setError(null); setSaved(null); }, [scope, audience, lang, step]);
  useEffect(() => { setShowShared(route.query.get('draft') === 'shared'); }, [route.query, scope, audience, step]);
  const current = () => {
    const x = latest.current;
    if (currentScope() !== scope || x.scope !== scope || x.audience !== audience || x.lang !== lang || x.step !== step || overviewBaseline(x.raw, useOverview.getState().value) !== baseline) throw new Error(t('stg.stale'));
  };
  const fail = (e: unknown) => {
    if (!alive.current) return;
    const message = e instanceof AiLiveError ? e.reasons.map((r) => t(reasonKey(r))).join(', ') + `: ${e.message}` : e instanceof Error ? e.message : String(e);
    setError(message);
  };
  const generate = async () => {
    setBusy(true); setError(null); setSaved(null);
    setGenerationProgress({ stage: 'generate', startedAt: Date.now() });
    const provider = useAiSettings.getState().provider;
    const previousDraft = JSON.stringify(useOverview.getState().value.stepDrafts?.[draftKey]);
    const request = { use: 'strategyOverview' as const, lang, prompt: overviewPrompt(ctx, audience === 'internal' ? state : { ...state, objectiveIssues: [] }, lang, audience, step), scope, timeoutMs: STEP_DRAFT_TIMEOUT_MS };
    try {
      const pf = preflight(request);
      if (!pf.allowed) throw new AiLiveError(pf.reasons, pf.budget.reasons.join(', '), pf.budget);
      if (!alive.current) return;
      current();
      if (useAiSettings.getState().provider !== provider) throw new Error(t('stg.stale'));
      abort.current = new AbortController();
      const result = await requestLiveOverview(request, ctx, lang, step, audience, abort.current.signal);
      if (alive.current) setGenerationProgress({ stage: 'verify', startedAt: Date.now() });
      current();
      if (!alive.current) return;
      if (JSON.stringify(useOverview.getState().value.stepDrafts?.[draftKey]) !== previousDraft) throw new Error(t('stg.draftChanged'));
      const proposal = result.proposal;
      set((v) => ({ ...v, stepDrafts: { ...v.stepDrafts, [draftKey]: { proposal, step, baseline, lang, audience, at: new Date().toISOString(), provider, inputTokens: result.inputTokens, outputTokens: result.outputTokens } } }));
      setShowShared(false);
      await flushDeviceStorage();
      if (deviceStatus() !== 'saved') throw new Error(t('device.error'));
    } catch (e) { fail(e); }
    finally { if (alive.current) { setBusy(false); setGenerationProgress(null); } }
  };
  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true); setError(null); setSaved(null);
    try {
      current();
      await flushDeviceStorage();
      if (deviceStatus() !== 'saved') throw new Error(t('device.error'));
      if (alive.current) setSaved('draft');
    } catch (e) { fail(e); }
    finally { if (alive.current) setBusy(false); }
  };
  const approve = async () => {
    if (!draft) return;
    setBusy(true); setError(null); setSaved(null);
    try {
      current();
      if (stale) throw new Error(t('stg.stale'));
      const proposal = validateOverviewProposal(draft.proposal, ctx, draft.step, draft.audience);
      const entities = proposalEntities(proposal, ctx);
      await commitPackChanges(entities.map((entity) => ({ op: 'upsert' as const, entity })), scope, raw.pack);
      if (currentScope() !== scope) throw new Error(t('stg.stale'));
      const value = useOverview.getState().value;
      const { [draftKey]: _stepDraft, ...remainingDrafts } = value.stepDrafts ?? {};
      const rest = isStepDraft ? { ...value, stepDrafts: remainingDrafts } : (() => { const { draft: _draft, ...remaining } = value; return remaining; })();
      const next = { ...rest, axis: proposal.axis, objectiveIssues: proposal.objectiveIssues };
      const approvedBaseline = overviewBaseline({ ...raw, pack: loaded }, next);
      set({ ...next, approved: { ...draft, baseline: approvedBaseline, by: useProjUi.getState().editor.trim() } });
      await flushDeviceStorage();
      if (deviceStatus() !== 'saved') throw new Error(t('device.error'));
      if (alive.current) setSaved('approved');
    } catch (e) { fail(e); }
    finally { if (alive.current) setBusy(false); }
  };
  const d = useMemo(() => stepDashboard(step, ctx), [step, ctx]);
  const [objectiveBusy, setObjectiveBusy] = useState(false);
  const [objectiveProgress, setObjectiveProgress] = useState<{ stage: AiStage; activity: ObjectiveProgress; startedAt: number } | null>(null);
  const [objectiveSearch, setObjectiveSearch] = useState<ObjectiveSearch | null>(null);
  const [objectiveResult, setObjectiveResult] = useState<{ registered: number; drafts: number; workIq: 'used' | 'failed' | 'off'; failedSections: number; withheld: number } | null>(null);
  const [objectiveError, setObjectiveError] = useState<string | null>(null);
  const fetchObjectives = async () => {
    setObjectiveBusy(true); setObjectiveResult(null); setObjectiveSearch(null); setObjectiveError(null);
    setObjectiveProgress({ stage: 'confirm', activity: 'generate', startedAt: Date.now() });
    abort.current = new AbortController();
    try {
      const c = await collectObjectives(loaded.pack, lang, abort.current.signal, todayIn(), (activity, search) => {
        if (alive.current) {
          if (search) setObjectiveSearch(search);
          setObjectiveProgress({ stage: 'generate', activity, startedAt: Date.now() });
        }
      });
      if (alive.current) setObjectiveProgress({ stage: 'verify', activity: 'generate', startedAt: Date.now() });
      const r = { ...c, ...storeObjectives(c) };
      await flushDeviceStorage();
      if (deviceStatus() !== 'saved') throw new Error(t('device.error'));
      if (!alive.current) return;
      setObjectiveResult({ registered: r.registered.length, drafts: r.drafts, workIq: !r.workIqUsed ? 'off' : r.workIqError || !r.workIqAnswers ? 'failed' : 'used', failedSections: r.workIqFailedSections, withheld: r.workIqWithheld });
    } catch (e) {
      if (!alive.current) return;
      const message = e instanceof AiLiveError ? e.reasons.map((r) => t(reasonKey(r))).join(', ') + `: ${e.message}` : e instanceof Error ? e.message : String(e);
      setObjectiveError(message === 'stale' ? t('stg.stale') : message);
    } finally { if (alive.current) { setObjectiveBusy(false); setObjectiveProgress(null); } }
  };
  const briefs = useMemo(() => (analysis ? IMPROVEMENT_STEPS.map((s) => buildStepBrief(stepDashboard(s, ctx), ctx, lang, audience)) : []), [analysis, ctx, lang, audience]);
  const limit = usePaybackLimit();
  const linked = new Set(map.links.flatMap((l) => [l.source, l.target]));
  const confirmed = map.nodes.filter((n) => n.draft !== 'new');
  const draftCount = map.nodes.length - confirmed.length;
  return (
    <>
      <Panel title={t('stg.next')} testId="strategy-next" className="span-full strategy-next">
        {d.next ? <a href={todoHref(d.next)} onClick={revisitRouteTarget}>{todoLabel(t, d.next.todo.id, limit)}</a> : <p>{t('stg.complete')}</p>}
      </Panel>
      <Panel title={t('stg.map')} rationale="stg.mapWhy" testId="strategy-panel" className="span-full">
        <div className="strategy-controls">
          <label>{t('stg.axis')}<Select aria-label={t('stg.axis')} data-testid="strategy-axis" value={axis} onChange={(_, data) => set((v) => ({ ...v, axis: data.value as OverviewAxis }))}>
            {axes.map((a) => <option key={a} value={a}>{t(`stg.axis.${a}`)}</option>)}
          </Select></label>
          <label>{t('stg.sort')}<Select aria-label={t('stg.sort')} data-testid="strategy-sort" value={descending ? 'desc' : 'asc'} onChange={(_, data) => set((v) => ({ ...v, descending: data.value === 'desc' }))}>
            <option value="desc">{t('stg.desc')}</option><option value="asc">{t('stg.asc')}</option>
          </Select></label>
          <Button icon={busy ? <Spinner size="tiny" aria-hidden /> : <Sparkle20Regular />} appearance="primary" onClick={() => void generate()} disabled={busy || !map.nodes.length} data-testid="strategy-optimize">{t('stg.optimize')}</Button>
          {internal && company && <Button icon={objectiveBusy ? <Spinner size="tiny" aria-hidden /> : <Sparkle20Regular />} onClick={() => void fetchObjectives()} disabled={objectiveBusy} data-testid="strategy-objectives-fetch">{t('stg.objFetch')}</Button>}
        </div>
        {generationProgress && <AiProgress stage={generationProgress.stage} startedAt={generationProgress.startedAt} elapsedKind="stage"
          limitMs={STEP_DRAFT_TIMEOUT_MS} testId="strategy-optimize-progress" />}
        {objectiveProgress && <AiProgress stage={objectiveProgress.stage} activity={objectiveProgress.activity} startedAt={objectiveProgress.startedAt}
          elapsedKind="stage" limitMs={objectiveProgress.activity === 'workiq' ? undefined : STEP_DRAFT_TIMEOUT_MS} testId="strategy-objectives-progress" />}
        {objectiveBusy && objectiveSearch && <p role="status" data-testid="strategy-objectives-search-status">
          {t(`stg.objFetchWorkIq.${!objectiveSearch.workIqUsed ? 'off' : objectiveSearch.workIqError || !objectiveSearch.workIqAnswers ? 'failed' : 'used'}`)}
          {' '}{objectiveSearch.workIqFailedSections > 0 && t('workiq.partialSearch', { n: objectiveSearch.workIqFailedSections })}
          {' '}{objectiveSearch.workIqWithheld > 0 && t('workiq.excludedMaterial')}
        </p>}
        {internal && company && <p className="muted">{t('stg.objFetchHint')}</p>}
        {objectiveResult && <p role="status" data-testid="strategy-objectives-result">{t('stg.objFetchDone', { registered: objectiveResult.registered, drafts: objectiveResult.drafts })} {t(`stg.objFetchWorkIq.${objectiveResult.workIq}`)}</p>}
        {objectiveResult && objectiveResult.failedSections > 0 && <p role="status">{t('workiq.partialSearch', { n: objectiveResult.failedSections })}</p>}
        {objectiveResult && objectiveResult.withheld > 0 && <p className="muted" role="status" data-testid="strategy-objectives-confidential">{t('workiq.excludedMaterial')}</p>}
        {objectiveError && <MessageBar intent="error" data-testid="strategy-objectives-error"><MessageBarBody>{t('stg.objFetchError', { message: objectiveError })}</MessageBarBody></MessageBar>}
        <p>{t('stg.recommended', { axis: t(`stg.axis.${recommended}`) })}</p>
        <p className="muted">{t(`stg.axisHint.${axis}`)}</p>
        <p className="muted">{t('stg.mapWhy')}</p>
        <p className="muted" data-testid="strategy-portal-hint">{t('stg.portal.hint')}</p>
        {draftCount > 0 && <p data-testid="strategy-drafts">{t('stg.draftsShown', { n: draftCount })}</p>}
        <StrategyMapView map={map} portal={portal} details={details} />
        {objectiveSaved && <p role="status" data-testid="strategy-objective-saved">{t('stg.obj.saved')}</p>}
        <p data-testid="strategy-gaps">{t('stg.gaps', { n: confirmed.filter((n) => !linked.has(n.id)).length })}</p>
        <details>
          <summary>{t('stg.details')}</summary>
          <ScrollRegion label={t('stg.links')}>
            <table className="data-table compact">
              <thead><tr><th>{t('stg.lane.objective')}</th><th>{t('stg.links')}</th></tr></thead>
              <tbody>{map.nodes.map((n) => <tr key={n.id}><th scope="row">{n.label}{n.draft && <> <Badge appearance="tint" color="warning" size="small">{t(n.draft === 'new' ? 'stg.badge.new' : 'stg.badge.changed')}</Badge></>}</th><td>{map.links.filter((l) => l.source === n.id || l.target === n.id).map((l) => {
                const a = map.nodes.find((x) => x.id === l.source)!, b = map.nodes.find((x) => x.id === l.target)!;
                return <div key={`${l.source}-${l.target}`}>{a.label} → {b.label}</div>;
              })}{!linked.has(n.id) && t('stg.noLinks')}</td></tr>)}</tbody>
            </table>
          </ScrollRegion>
        </details>
        <p className="muted">{t('stg.liveHint')} <Link inline className="text-action" onClick={openAiSettings}>{t('ai.nav.settings')}</Link></p>
        {error && <MessageBar intent="error" data-testid="strategy-error"><MessageBarBody>{t('stg.error', { message: error })}</MessageBarBody></MessageBar>}
        {saved && <p role="status" data-testid="strategy-saved">{t(saved === 'draft' ? 'stg.draftSaved' : 'stg.saved')}</p>}
        {objectiveDialog && company && <ObjectiveDialog key={objectiveDialog.draftId ?? ''} company={company} draft={objectiveDraft} note={storedDraft} onClose={closeObjective} />}
      </Panel>
      <Panel title={t('stg.issues')} testId="strategy-ranking" className="span-full">
        <ol>{map.nodes.filter((n) => n.lane === 'issue').map((n) => {
          const issue = ctx.pack.byId.get(n.ref)!;
          return <li key={n.id} data-issue={n.ref} data-score={n.score ?? 'unknown'} className="strategy-ranking-row">
            <EntityRef id={n.ref} /> — {t('stg.score')}: {n.score === null ? t('stg.unknown') : fmt.number(n.score)}
            <p>{issue.description[lang]}</p><Evidence ids={issue.sourceIds.filter((id) => ctx.pack.byId.has(id))} />
          </li>;
        })}</ol>
      </Panel>
      {draft && <Panel title={t('stg.draft')} testId="strategy-draft" className="span-full">
        <Badge appearance="tint" color="warning">{t('stg.draft')}</Badge>
        <p>{isStepDraft ? t('stg.stepDraft', { step: t(`proj.step.${step}`) }) : t('stg.sharedDraft')}</p>
        {stepDraft && sharedDraft && <Button size="small" onClick={() => setShowShared(isStepDraft)}>{t(isStepDraft ? 'stg.showShared' : 'stg.showStep')}</Button>}
        <p>{t('stg.at', { at: stamp(draft.at, fmt), provider: t(`ai.provider.${draft.provider}`) })}</p>
        {draft.inputTokens !== undefined && <TokensInline usage={{ inputTokens: draft.inputTokens, outputTokens: draft.outputTokens ?? null }} testId="strategy-draft-tokens" />}
        {stale && <p role="alert" data-testid="strategy-stale">{t('stg.stale')}</p>}
        <DraftDiff draft={draft} ctx={ctx} stale={stale} />
        <div className="strategy-controls">
          <Button disabled={busy} onClick={() => void saveDraft()} data-testid="strategy-save">{t('stg.saveDraft')}</Button>
          <Button appearance="primary" icon={<Checkmark20Regular />} disabled={busy || stale} onClick={() => void approve()} data-testid="strategy-confirm">{t('stg.confirm')}</Button>
          <Button icon={<Dismiss20Regular />} disabled={busy} onClick={() => set((v) => {
            if (isStepDraft) {
              const { [draftKey]: _draft, ...rest } = v.stepDrafts ?? {};
              return { ...v, stepDrafts: rest };
            }
            const { draft: _draft, ...rest } = v;
            return rest;
          })}>{t('stg.discard')}</Button>
        </div>
      </Panel>}
      {approved && <Panel title={t('stg.approved')} testId="strategy-approved" className="span-full">
        {approved.baseline !== baseline && <p>{t('stg.stale')}</p>}
        <p>{t('stg.at', { at: stamp(approved.at, fmt), provider: t(`ai.provider.${approved.provider}`) })}</p>
        <ProposalBody proposal={approved.proposal} ctx={ctx} />
      </Panel>}
      {analysis && <Panel title={t('stg.analysis')} testId="executive-summary" className="span-full">
        <p className="muted">{t('stg.analysisHint')}</p>
        {IMPROVEMENT_STEPS.map((s, i) => {
          const brief = briefs[i]!;
          return <details key={s} open={s === step}>
            <summary>{t(`proj.step.${s}`)} — {t(`proj.dash.brief.maturity.${brief.maturity}`)}</summary>
            <BriefBody content={brief} brief={brief} prefix={`strategy-brief-${s}`} />
          </details>;
        })}
      </Panel>}
    </>
  );
}
