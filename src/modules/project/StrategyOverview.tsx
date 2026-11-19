import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Link, MessageBar, MessageBarBody, Select, Spinner } from '@fluentui/react-components';
import { Checkmark20Regular, Dismiss20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { aiLive, AiLiveError, preflight } from '../../ai/client.ts';
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
import { wrap } from '../../ui/textWrap.ts';
import { reasonKey } from '../ai/AiCommon.tsx';
import { useAiSettings } from '../ai/settingsStore.ts';
import { openAiSettings } from '../ai/uiStore.ts';
import { ScrollRegion } from './common.tsx';
import type { AppCheckContext as CheckContext } from './deliverables.ts';
import { todoHref, todoLabel, usePaybackLimit } from './deliverablesUi.tsx';
import {
  availableAxes, itemNames, overviewBaseline, overviewContext, overviewPrompt, parseOverviewResponse, proposalEntities, recommendedAxis, strategyMap,
  useOverview, validateOverviewProposal, type OverviewAxis, type OverviewDraft, type OverviewProposal, type StrategyDrafts, type StrategyMap, type StrategyNode,
} from './overviewModel.ts';
import { BriefBody } from './StepBriefPanel.tsx';
import { buildStepBrief } from './stepBrief.ts';
import { stepDashboard } from './stepDashboard.ts';
import { useKpiDrafts, useProjUi } from './stores.ts';
import { ObjectiveDialog } from './StrategyObjectiveDialog.tsx';
import {
  emptyDestination, emptyDomId, laneDomId, laneHref, nodeDestination, nodeDomId, packObjectiveDrafts, type Destination, type Lane,
} from './strategyPortal.ts';
import './overview.css';

const LANES = ['objective', 'okr', 'kpi', 'issue', 'solution'] as const;
const WIDTH = 250, NODE_WIDTH = 216;

/** FR-349: how the map's items open their input/check places; absent on read-only previews (no duplicate ids). */
interface Portal {
  companyId: string;
  canEditObjectives: boolean;
  /** Lanes with nowhere to go for this audience stay plain text. */
  inert: readonly Lane[];
  onObjective: (draftId?: string) => void;
  onLeave: (label: string, domId: string) => void;
}

const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
const laneNameId = (lane: Lane) => `stg-lane-name-${lane}`;

/** Without `label` the name comes from the visible text (WCAG 2.5.3); `describedBy` adds the lane. */
function SvgAction({ id, label, describedBy, dest, portal, leaveLabel, children }: {
  id: string; label?: string; describedBy?: string; dest: Destination; portal: Portal; leaveLabel: string; children: React.ReactNode;
}) {
  if (dest.kind === 'link') {
    return <a id={id} href={dest.href} aria-label={label} aria-describedby={describedBy} onClick={(e) => { if (plainClick(e)) portal.onLeave(leaveLabel, id); }}>{children}</a>;
  }
  const open = () => portal.onObjective(dest.draftId);
  return (
    <g id={id} role="button" tabIndex={0} aria-label={label} aria-describedby={describedBy} aria-haspopup="dialog" onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>{children}</g>
  );
}

function StrategyVisual({ map, portal }: { map: StrategyMap; portal?: Portal }) {
  const { t, fmt } = useI18n();
  const layout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number; h: number; lines: string[] }>();
    let height = 130;
    LANES.forEach((lane, col) => {
      let y = 48;
      map.nodes.filter((n) => n.lane === lane).forEach((n) => {
        const lines = wrap(n.label, 17);
        const h = Math.max(70, lines.length * 18 + 36 + (n.draft === 'changed' ? 18 : 0));
        positions.set(n.id, { x: 12 + col * WIDTH, y, h, lines });
        y += h + 20;
      });
      height = Math.max(height, y);
    });
    return { positions, height };
  }, [map]);
  const live = (lane: Lane) => portal && !portal.inert.includes(lane) ? portal : undefined;
  const laneName = (lane: Lane) => t(`stg.lane.${lane}`);
  const node = (n: StrategyNode) => {
    const pos = layout.positions.get(n.id)!;
    const score = n.score === null ? t('stg.unknown') : `${t('stg.score')}: ${fmt.number(n.score)}`;
    const body = (
      <g key={n.id} transform={`translate(${pos.x},${pos.y})`} data-node={n.id} data-lane={n.lane} data-draft={n.draft}>
        <rect width={NODE_WIDTH} height={pos.h} rx={8} className={`strategy-node ${n.lane}${n.draft === 'new' ? ' is-draft' : ''}`} />
        <text x={10} y={22} className="strategy-label">{pos.lines.map((line, i) => <tspan key={i} x={10} dy={i ? 18 : 0}>{line}</tspan>)}</text>
        {n.draft === 'changed' && <text x={10} y={pos.h - 28} className="strategy-draft-badge">{t('stg.badge.changed')}</text>}
        {n.draft === 'new'
          ? <text x={10} y={pos.h - 10} className="strategy-draft-badge">{t('stg.badge.new')}</text>
          : <text x={10} y={pos.h - 10} className="strategy-score">{score}</text>}
      </g>
    );
    const p = live(n.lane);
    if (!p) return body;
    return (
      <SvgAction key={n.id} id={nodeDomId(n.id)} describedBy={laneNameId(n.lane)}
        dest={nodeDestination(n, p.companyId, p.canEditObjectives)} portal={p} leaveLabel={n.label}>{body}</SvgAction>
    );
  };
  return (
    <ScrollRegion label={t('stg.map')}>
      <svg className="strategy-map" viewBox={`0 0 ${WIDTH * LANES.length} ${layout.height}`} role={portal ? 'group' : 'img'} aria-label={t('stg.map')} data-testid={portal ? 'strategy-map' : 'strategy-map-preview'}>
        <title>{t('stg.map')}</title>
        <desc>{t('stg.mapWhy')}</desc>
        {map.links.map((l) => {
          const a = layout.positions.get(l.source)!;
          const b = layout.positions.get(l.target)!;
          const x = a.x + NODE_WIDTH, y = a.y + a.h / 2, by = b.y + b.h / 2;
          const mid = (x + b.x) / 2;
          return <path key={`${l.source}-${l.target}`} data-source={l.source} data-target={l.target} data-draft={l.draft ? 'true' : undefined} className={`strategy-link${l.direct ? ' direct' : ''}${l.draft ? ' draft' : ''}`} d={`M${x},${y} C${mid},${y} ${mid},${by} ${b.x},${by}`} />;
        })}
        {/* Each lane's heading, empty slot and items stay together so keyboard order follows the columns. */}
        {LANES.map((lane, col) => {
          const x = 12 + col * WIDTH;
          const p = live(lane);
          const header = <text id={p ? laneNameId(lane) : undefined} x={x} y={24} className="strategy-lane">{laneName(lane)}</text>;
          const empty = !map.nodes.some((n) => n.lane === lane);
          return (
            <g key={lane}>
              {p
                ? <SvgAction id={laneDomId(lane)} dest={{ kind: 'link', href: laneHref(lane, p.companyId) }} portal={p} leaveLabel={laneName(lane)}>
                  <rect x={x - 4} y={2} width={NODE_WIDTH} height={32} rx={6} className="strategy-hit" />{header}
                </SvgAction>
                : header}
              {empty && (p
                ? <SvgAction id={emptyDomId(lane)} describedBy={laneNameId(lane)} dest={emptyDestination(lane, p.companyId, p.canEditObjectives)} portal={p} leaveLabel={laneName(lane)}>
                  <g data-empty={lane}>
                    <rect x={x} y={48} width={NODE_WIDTH} height={56} rx={8} className="strategy-node strategy-slot" />
                    <text x={x + 10} y={70} className="strategy-empty">{t('stg.empty')}</text>
                    <text x={x + 10} y={92} className="strategy-score">{t('stg.portal.add')}</text>
                  </g>
                </SvgAction>
                : <text x={x} y={68} className="strategy-empty">{t('stg.empty')}</text>)}
              {map.nodes.filter((n) => n.lane === lane).map(node)}
            </g>
          );
        })}
      </svg>
    </ScrollRegion>
  );
}

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
      {!stale && <StrategyVisual map={strategyMap(preview, { objectiveIssues: draft.proposal.objectiveIssues }, draft.proposal.axis, lang)} />}
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
  const axes = availableAxes(ctx);
  const recommended = recommendedAxis(ctx);
  const axis = state.axis && axes.includes(state.axis) ? state.axis : recommended;
  const descending = state.descending !== false;
  const baseline = overviewBaseline(raw, state);
  const draftKey = `${audience}:${step}`;
  const stepDraft = state.stepDrafts?.[draftKey];
  const sharedDraft = state.draft?.audience === audience ? state.draft : undefined;
  const [showShared, setShowShared] = useState(route.query.get('draft') === 'shared');
  const draft = showShared ? sharedDraft ?? stepDraft : stepDraft ?? sharedDraft;
  const kpiDrafts = useKpiDrafts((s) => s.value);
  const { company } = useActiveProject();
  const internal = audience === 'internal';
  // FR-350: unsaved drafts are internal working data, so the external view keeps showing confirmed data only.
  const drafts = useMemo((): StrategyDrafts => internal ? {
    objectives: packObjectiveDrafts(loaded.pack.extensions, ctx.objectives.map((o) => o.id)).map((o) => ({ id: o.id!, text: o.text })),
    okrs: kpiDrafts.okrs.map((o) => ({ id: o.id, objective: o.objective.trim() || t('stg.untitled'), kpiIds: o.keyResults.map((kr) => kr.kpiId).filter(Boolean), objectiveIds: o.companyObjectiveIds })),
    kpis: kpiDrafts.kpis.map((k) => ({ id: k.id, name: k.name.trim() || t('stg.untitled') })),
    changed: draft ? draft.proposal.patches.map((p) => p.id) : [],
    objectiveIssues: draft?.proposal.objectiveIssues ?? [],
  } : {}, [internal, ctx, kpiDrafts, draft, t]);
  const map = useMemo(() => strategyMap(ctx, internal ? state : { objectiveIssues: [] }, axis, lang, descending, drafts), [ctx, state, axis, lang, descending, internal, drafts]);
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
  const objectiveDraft = objectiveDialog?.draftId
    ? packObjectiveDrafts(loaded.pack.extensions, ctx.objectives.map((o) => o.id)).find((o) => o.id === objectiveDialog.draftId) ?? null
    : null;
  const closeObjective = (savedId?: string) => {
    const returnTo = savedId ? nodeDomId(`objective:${savedId}`) : objectiveDialog?.draftId ? nodeDomId(`objective:draft:${objectiveDialog.draftId}`) : emptyDomId('objective');
    setObjectiveDialog(null);
    if (savedId) setObjectiveSaved(true);
    // Fluent restores focus to the opener; once the map re-renders the saved node replaces it, so focus that instead.
    requestAnimationFrame(() => requestAnimationFrame(() => (document.getElementById(returnTo) as (HTMLElement & SVGElement) | null)?.focus()));
  };
  const isStepDraft = !!draft && draft === stepDraft;
  const approved = state.approved?.audience === audience && state.approved.lang === lang ? state.approved : undefined;
  const stale = !!draft && (draft.baseline !== baseline || draft.lang !== lang);
  const [busy, setBusy] = useState(false);
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
    const provider = useAiSettings.getState().provider;
    const previousDraft = JSON.stringify(useOverview.getState().value.stepDrafts?.[draftKey]);
    const request = { use: 'strategyOverview' as const, lang, prompt: overviewPrompt(ctx, audience === 'internal' ? state : { ...state, objectiveIssues: [] }, lang, audience, step), scope };
    try {
      const pf = preflight(request);
      if (!pf.allowed) throw new AiLiveError(pf.reasons, pf.budget.reasons.join(', '), pf.budget);
      if (!alive.current) return;
      current();
      if (useAiSettings.getState().provider !== provider) throw new Error(t('stg.stale'));
      abort.current = new AbortController();
      const result = await aiLive(request, abort.current.signal);
      current();
      if (!alive.current) return;
      if (JSON.stringify(useOverview.getState().value.stepDrafts?.[draftKey]) !== previousDraft) throw new Error(t('stg.draftChanged'));
      const proposal = parseOverviewResponse(result.text, ctx, lang, step, audience);
      set((v) => ({ ...v, stepDrafts: { ...v.stepDrafts, [draftKey]: { proposal, step, baseline, lang, audience, at: new Date().toISOString(), provider, costJpy: result.costJpy } } }));
      setShowShared(false);
      await flushDeviceStorage();
      if (deviceStatus() !== 'saved') throw new Error(t('device.error'));
    } catch (e) { fail(e); }
    finally { if (alive.current) setBusy(false); }
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
          <Button icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />} appearance="primary" onClick={() => void generate()} disabled={busy || !map.nodes.length} data-testid="strategy-optimize">{t('stg.optimize')}</Button>
        </div>
        <p>{t('stg.recommended', { axis: t(`stg.axis.${recommended}`) })}</p>
        <p className="muted">{t(`stg.axisHint.${axis}`)}</p>
        <p className="muted">{t('stg.mapWhy')}</p>
        <p className="muted" data-testid="strategy-portal-hint">{t('stg.portal.hint')}</p>
        {draftCount > 0 && <p data-testid="strategy-drafts">{t('stg.draftsShown', { n: draftCount })}</p>}
        <StrategyVisual map={map} portal={portal} />
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
        <p className="muted">{t('stg.budget')}</p>
        {error && <MessageBar intent="error" data-testid="strategy-error"><MessageBarBody>{t('stg.error', { message: error })}</MessageBarBody></MessageBar>}
        {saved && <p role="status" data-testid="strategy-saved">{t(saved === 'draft' ? 'stg.draftSaved' : 'stg.saved')}</p>}
        {objectiveDialog && company && <ObjectiveDialog key={objectiveDialog.draftId ?? ''} company={company} draft={objectiveDraft} onClose={closeObjective} />}
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
        {IMPROVEMENT_STEPS.map((s) => {
          const dash = stepDashboard(s, ctx), brief = buildStepBrief(dash, ctx, lang, audience);
          return <details key={s} open={s === step}>
            <summary>{t(`proj.step.${s}`)} — {t(`proj.dash.brief.maturity.${brief.maturity}`)}</summary>
            <BriefBody content={brief} brief={brief} prefix={`strategy-brief-${s}`} />
          </details>;
        })}
      </Panel>}
    </>
  );
}
