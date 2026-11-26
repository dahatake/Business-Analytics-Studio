import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Badge, Button, Checkbox, Field, Input, Link, MessageBar, MessageBarBody, Select, Spinner } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Save20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { aiLive, AiLiveError, preflight, readLedger } from '../../ai/client.ts';
import { OkrExtension } from '../../data/extensionSchemas.ts';
import { getEntity, loaded, packOrigin } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { useProjects } from '../../state/projects.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import { recordsOfJob, summarizeTokens, type TokenSummary } from '../../ai/tokenUsage.ts';
import { reasonKey, TokenTable } from '../ai/AiCommon.tsx';
import { AiProgress, type AiActivity } from '../ai/AiProgress.tsx';
import { openAiSettings } from '../ai/uiStore.ts';
import { DecisionUnavailable, decisionLive } from '../ai/decisionClient.ts';
import { isDecisionReady, useAiSettings } from '../ai/settingsStore.ts';
import '../ai/liveTransport.ts';
import { ScrollRegion } from './common.tsx';
import {
  addKpiDrafts, addOkrDrafts, applyCopilotPick, applyKpiScreen, applyMissingKpiDraftResponse, discardKpiDraft, discardOkrDraft, kpiAdoptState, kpiCandidateId, kpiDraftPrompt,
  kpiFillPrompt, kpiFillTargets, kpiScreenRequest, missingKpiDraftPrompt, missingKpiDrafts,
  objectiveCandidateId, okrAdoptState, openCandidates, parseKpiDraftResponse, saveAllDrafts, saveKpiDraft, saveOkrDraft,
  type AddResult, type KpiDraft, type KpiDrafts, type OkrDraft, type SaveError, type SaveResult,
} from './kpiAdopt.ts';
import { orgOf, type KpiField } from './kpiOkr.ts';
import { newId, type KpiData, type KpiOrg } from './model.ts';
import { fillKpiDrafts, fillObjectives, KpiAnswerError, kpiOkrRequest, kpiOkrTarget } from './kpiAutoDraft.ts';
import { kpisForScope, useKpiDrafts, useKpis } from './stores.ts';

/** Save errors are shared: saving an OKR draft can reveal missing fields on the KPI drafts it links to. */
const useDraftErrors = create<{ errors: SaveError[] }>()(() => ({ errors: [] }));

type CandidateExt = Parameters<typeof openCandidates>[0];
function candidateName(ext: CandidateExt, candidateId: string, lang: 'ja' | 'en'): string {
  const k = ext.kpis.find((x) => kpiCandidateId(x.id) === candidateId);
  const o = ext.objectives.find((x) => objectiveCandidateId(x.id) === candidateId);
  return k ? loc(k.name, lang) : o ? loc(o.objective, lang) : candidateId;
}
const setDraftErrors = (errors: SaveError[]) => useDraftErrors.setState({ errors });
const clearDraftErrors = (ids: readonly string[]) => useDraftErrors.setState((s) => ({ errors: s.errors.filter((e) => !ids.includes(e.draftId)) }));

const scrollToDrafts = (id: string) => requestAnimationFrame(() => {
  const el = document.getElementById(id);
  el?.scrollIntoView({ block: 'start' });
  el?.focus({ preventScroll: true });
});

interface DraftListProps {
  data: KpiData;
  commit: (next: KpiData) => void;
}

function useSave({ commit }: DraftListProps) {
  const setDrafts = useKpiDrafts((s) => s.set);
  const [saved, setSaved] = useState<number | null>(null);
  return {
    saved,
    apply: (r: SaveResult, ids: string[]) => {
      if (!r.ok) { setSaved(null); setDraftErrors([...useDraftErrors.getState().errors.filter((e) => !ids.includes(e.draftId)), ...r.errors]); return; }
      commit(r.data);
      setDrafts(r.drafts);
      clearDraftErrors(ids);
      setSaved(1);
    },
    saveAll: (data: KpiData, drafts: KpiDrafts) => {
      const r = saveAllDrafts(data, drafts);
      if (r.saved) { commit(r.data); setDrafts(r.drafts); }
      setDraftErrors(r.errors);
      setSaved(r.saved);
    },
  };
}

function DraftBadges({ by }: { by: 'user' | 'copilot' }) {
  const { t } = useI18n();
  return (
    <>
      <Badge appearance="filled" color="warning" data-draft="true">{t('proj.draft.badge')}</Badge>
      {by === 'copilot' && <Badge appearance="tint" color="brand" icon={<Sparkle20Regular />}>{t('proj.draft.copilot')}</Badge>}
    </>
  );
}

function CopilotNotes({ reason, unverified }: { reason?: string; unverified?: string[] }) {
  const { t, lang } = useI18n();
  return (
    <>
      {reason && <p className="muted">{t('proj.draft.reason', { reason })}</p>}
      {unverified?.length ? <MessageBar intent="warning"><MessageBarBody>{t('proj.draft.unverified', { nums: unverified.join(lang === 'ja' ? '、' : ', ') })}</MessageBarBody></MessageBar> : null}
    </>
  );
}

const KPI_FIELDS = ['name', 'unit', 'baseline', 'current', 'target', 'deadline'] as const;
const FIELD_TYPE: Record<KpiField, 'text' | 'number' | 'date'> = { name: 'text', unit: 'text', baseline: 'number', current: 'number', target: 'number', deadline: 'date' };

function KpiDraftCard({ d, props }: { d: KpiDraft; props: DraftListProps }) {
  const { t, lang } = useI18n();
  const setDrafts = useKpiDrafts((s) => s.set);
  const drafts = useKpiDrafts((s) => s.value);
  const allErrors = useDraftErrors((s) => s.errors);
  const errors = allErrors.filter((e) => e.draftId === d.id);
  const bad = new Set(errors.flatMap((e) => (e.kind === 'kpi' ? e.fields : [])));
  const { apply } = useSave(props);
  const name = d.name || t('proj.draft.untitled');
  const edit = (f: KpiField, value: string) => setDrafts((v) => ({
    ...v,
    kpis: v.kpis.map((x) => {
      if (x.id !== d.id) return x;
      // A value the user typed is theirs, no longer Copilot's estimate or a provisional value.
      const { [f]: _, ...estimated } = x.estimated ?? {};
      const { [f]: _p, ...provisional } = x.provisional ?? {};
      const { estimated: __, provisional: __p, ...rest } = x;
      return { ...rest, [f]: value, ...(Object.keys(estimated).length ? { estimated } : {}), ...(Object.keys(provisional).length ? { provisional } : {}) };
    }),
  }));
  const original = [
    d.original.target && t('proj.draft.orig.target', { v: d.original.target }),
    d.original.current && t('proj.draft.orig.current', { v: d.original.current }),
    d.original.period && t('proj.draft.orig.period', { v: d.original.period }),
  ].filter(Boolean).join(lang === 'ja' ? '、' : '; ');
  return (
    <section className="proj-draft" id={`proj-kpi-draft-${d.id}`} tabIndex={-1} aria-label={t('proj.draft.nameFor', { name })} data-testid={`proj-kpi-draft-${d.candidateId}`}>
      <div className="proj-okr-head"><DraftBadges by={d.by} /><strong>{name}</strong></div>
      {d.origin === 'proposed' && <Badge appearance="outline" color="warning">{t('sol.origin.proposed')}</Badge>}
      {original && <p className="muted">{t('proj.draft.original', { text: original })}</p>}
      {d.original.definition && <p className="muted">{t('proj.draft.orig.definition', { v: d.original.definition })}</p>}
      <CopilotNotes reason={d.reason} unverified={d.unverified} />
      {d.notes.length > 0 && <ul className="proj-draft-notes muted">{d.notes.map((n) => <li key={n}>{t(`proj.draft.note.${n}`)}</li>)}</ul>}
      {d.estimated && <MessageBar intent="info" data-testid={`proj-kpi-draft-estimated-${d.candidateId}`}><MessageBarBody>{t('proj.draft.estimatedNote')}</MessageBarBody></MessageBar>}
      {d.provisional && <MessageBar intent="warning" data-testid={`proj-kpi-draft-provisional-${d.candidateId}`}><MessageBarBody>{t('proj.draft.provisionalNote')}</MessageBarBody></MessageBar>}
      <div className="proj-kpi-fields">
        {KPI_FIELDS.map((f) => {
          const why = d.estimated?.[f];
          const rule = d.provisional?.[f];
          const hint = why ? t('proj.draft.estimated', { why }) : rule ? t('proj.draft.provisional', { why: t(`proj.draft.rule.${rule}`) }) : '';
          return (
            <Field key={f} label={t(`proj.kpi.${f}`)} {...(hint ? { hint } : {})}
              {...(bad.has(f) ? { validationState: 'error' as const, validationMessage: t(`proj.kpi.err.${f}`) } : {})}>
              <Input type={FIELD_TYPE[f]} value={d[f]} onChange={(_, v) => edit(f, v.value)} data-estimated={why ? 'true' : undefined} data-provisional={rule ? 'true' : undefined} />
            </Field>
          );
        })}
      </div>
      <div className="proj-row">
        <Button appearance="primary" icon={<Save20Regular />} aria-label={t('proj.draft.saveNamed', { name })} onClick={() => apply(saveKpiDraft(d.id, props.data, drafts), [d.id])}>{t('proj.save')}</Button>
        <Button icon={<Delete20Regular />} aria-label={t('proj.draft.discardNamed', { name })} onClick={() => { setDrafts((v) => discardKpiDraft(d.id, v)); clearDraftErrors([d.id]); }}>{t('proj.draft.discard')}</Button>
      </div>
    </section>
  );
}

/** FR-325: KPI drafts shown in the KPI panel, editable until the user saves (validated like the KPI form) or discards them. */
export function KpiDraftList(props: DraftListProps) {
  const { t } = useI18n();
  const drafts = useKpiDrafts((s) => s.value);
  const { saveAll, saved } = useSave(props);
  if (drafts.kpis.length === 0) return null;
  return (
    <div className="proj-drafts" data-testid="proj-kpi-drafts">
      <h3 className="proj-h3" id="proj-kpi-drafts" tabIndex={-1}>{t('proj.draft.kpiTitle', { n: drafts.kpis.length })}</h3>
      <p className="muted">{t('proj.draft.hint')}</p>
      {drafts.kpis.map((d) => <KpiDraftCard key={d.id} d={d} props={props} />)}
      {drafts.kpis.length + drafts.okrs.length > 1 && (
        <div className="proj-row"><Button icon={<Save20Regular />} onClick={() => saveAll(props.data, drafts)} data-testid="proj-drafts-save-all">{t('proj.draft.saveAll')}</Button></div>
      )}
      {saved !== null && saved > 1 && <p role="status">{t('proj.draft.saved', { n: saved })}</p>}
    </div>
  );
}

function OkrDraftCard({ o, props }: { o: OkrDraft; props: DraftListProps }) {
  const { t, lang } = useI18n();
  const setDrafts = useKpiDrafts((s) => s.set);
  const drafts = useKpiDrafts((s) => s.value);
  const allErrors = useDraftErrors((s) => s.errors);
  const errors = allErrors.filter((e) => e.draftId === o.id);
  const { apply } = useSave(props);
  const name = o.objective || t('proj.draft.untitled');
  const patch = (next: Partial<OkrDraft>) => setDrafts((v) => ({ ...v, okrs: v.okrs.map((x) => (x.id === o.id ? { ...x, ...next } : x)) }));
  const setKr = (i: number, next: Partial<OkrDraft['keyResults'][number]>) => patch({ keyResults: o.keyResults.map((kr, j) => (j === i ? { ...kr, ...next } : kr)) });
  const linkedDrafts = o.keyResults.map((kr) => kr.kpiId).filter((id) => drafts.kpis.some((d) => d.id === id));
  const scope = useKpiDrafts((s) => s.scope);
  const objectiveText = (id: string) => {
    const target = kpiOkrTarget(scope);
    return (target ? fillObjectives(target.companyId, loaded.pack) : []).find((x) => x.id === id)?.text ?? id;
  };
  return (
    <section className="proj-draft" id={`proj-okr-draft-${o.id}`} tabIndex={-1} aria-label={t('proj.draft.nameFor', { name })} data-testid={`proj-okr-draft-${o.candidateId}`}>
      <div className="proj-okr-head"><DraftBadges by={o.by} /><strong>{name}</strong></div>
      {o.origin === 'proposed' && <Badge appearance="outline" color="warning">{t('sol.origin.proposed')}</Badge>}
      <CopilotNotes reason={o.reason} unverified={o.unverified} />
      {o.objectiveEstimate && o.companyObjectiveIds.length > 0 && (
        <p className="muted" data-testid={`proj-okr-draft-objectives-${o.candidateId}`}>
          {t('proj.draft.objectiveEstimate', { objectives: o.companyObjectiveIds.map((id) => objectiveText(id)).join(lang === 'ja' ? '、' : '; '), why: o.objectiveEstimate })}
        </p>
      )}
      <Field label={t('proj.okr.objective')} {...(errors.some((e) => e.kind === 'objective') ? { validationState: 'error' as const, validationMessage: t('proj.draft.err.objective') } : {})}>
        <Input value={o.objective} onChange={(_, v) => patch({ objective: v.value })} />
      </Field>
      {o.keyResults.map((kr, i) => (
        <div key={kr.id} className="proj-draft-kr">
          <Field label={t('proj.okr.krText', { n: i + 1 })}><Input value={kr.text} onChange={(_, v) => setKr(i, { text: v.value })} /></Field>
          <Field label={t('proj.okr.krKpi', { n: i + 1 })}>
            <Select value={kr.kpiId} onChange={(_, v) => setKr(i, { kpiId: v.value })}>
              <option value="">{t('proj.okr.chooseKpi')}</option>
              {props.data.kpis.map((k) => <option key={k.id} value={k.id}>{loc(k.name, lang)}</option>)}
              {drafts.kpis.map((k) => <option key={k.id} value={k.id}>{t('proj.draft.kpiOption', { name: k.name || t('proj.draft.untitled') })}</option>)}
            </Select>
          </Field>
        </div>
      ))}
      {linkedDrafts.length > 0 && <p className="muted">{t('proj.draft.savesKpis', { n: linkedDrafts.length })}</p>}
      {errors.some((e) => e.kind === 'keyResult') && <p className="proj-error" role="alert">{t('proj.draft.err.keyResult')}</p>}
      {errors.some((e) => e.kind === 'link') && <p className="proj-error" role="alert">{t('proj.draft.err.link')}</p>}
      <div className="proj-row">
        <Button icon={<Add20Regular />} onClick={() => patch({ keyResults: [...o.keyResults, { id: newId('kr'), text: '', kpiId: '' }] })}>{t('proj.okr.addKr')}</Button>
        <Button appearance="primary" icon={<Save20Regular />} aria-label={t('proj.draft.saveNamed', { name })} onClick={() => apply(saveOkrDraft(o.id, props.data, drafts), [o.id, ...linkedDrafts])}>{t('proj.save')}</Button>
        <Button icon={<Delete20Regular />} aria-label={t('proj.draft.discardNamed', { name })} onClick={() => { setDrafts((v) => discardOkrDraft(o.id, v)); clearDraftErrors([o.id]); }}>{t('proj.draft.discard')}</Button>
      </div>
    </section>
  );
}

/** FR-325: OKR drafts shown in the OKR panel; saving one also saves the KPI drafts its key results link to. */
export function OkrDraftList(props: DraftListProps) {
  const { t } = useI18n();
  const drafts = useKpiDrafts((s) => s.value);
  if (drafts.okrs.length === 0) return null;
  return (
    <div className="proj-drafts" data-testid="proj-okr-drafts">
      <h3 className="proj-h3" id="proj-okr-drafts" tabIndex={-1}>{t('proj.draft.okrTitle', { n: drafts.okrs.length })}</h3>
      <p className="muted">{t('proj.draft.hint')}</p>
      {drafts.okrs.map((o) => <OkrDraftCard key={o.id} o={o} props={props} />)}
    </div>
  );
}

type Notice = { intent: 'success' | 'warning' | 'error'; text: string; settings?: boolean };

/** FR-341: the organisation a KPI/OKR belongs to; an estimated one is marked until the user confirms it. */
export function OrgBadge({ org, testId }: { org?: KpiOrg; testId: string }) {
  const { t } = useI18n();
  if (!org) return <span className="muted" data-testid={testId}>{t('proj.org.unset')}</span>;
  const label = `${t(`proj.org.level.${org.level}`)}${org.name ? `: ${org.name}` : ''}`;
  return (
    <span data-testid={testId} data-level={org.level}>
      <Badge appearance="outline" color="brand">{label}</Badge>
      {org.inferred && <Badge appearance="tint" color="warning" title={t('proj.org.inferredHint')}>{t('proj.org.inferred')}</Badge>}
    </span>
  );
}

/**
 * Internal KPIs/OKRs found by Work IQ (extensions.okr), shown as found. FR-325: selected items become KPI/OKR drafts,
 * and [Copilotでドラフト作成] lets the configured AI choose the candidates that fit the project purpose.
 */
export function PackOkrPanel({ data }: { data: KpiData }) {
  const { t, lang } = useI18n();
  const scope = useKpis((s) => s.scope);
  const drafts = useKpiDrafts((s) => s.value);
  const setDrafts = useKpiDrafts((s) => s.set);
  const purpose = useProjects((s) => s.projects.find((p) => p.id === scope)?.brief?.purpose ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<AiActivity>('generate');
  const [jobTokens, setJobTokens] = useState<TokenSummary | null>(null);
  const decisionReady = useAiSettings(isDecisionReady);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; abort.current?.abort(); };
  }, []);
  useEffect(() => { setSelected([]); setNotice(null); abort.current?.abort(); }, [scope]);

  if (packOrigin.kind !== 'imported' || packOrigin.projectId !== scope) return null;
  const parsed = OkrExtension.safeParse(loaded.pack.extensions?.okr);
  const ext = parsed.success ? parsed.data : { kpis: [], objectives: [] };
  const { kpis, objectives } = ext;
  const text = (v: Localizable | undefined) => (v === undefined ? '' : loc(v, lang));
  const toggle = (id: string, on: boolean) => setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)));
  const open = openCandidates(ext, data, drafts);
  const openCount = open.kpis.length + open.objectives.length;
  const input = { purpose, ext, data, drafts, lang };
  const missing = missingKpiDrafts(input);
  const hasMissing = missing.kpis || missing.okrs;
  const hasCandidates = kpis.length + objectives.length > 0;
  if (!hasCandidates && !hasMissing && !notice && !drafts.kpis.length && !drafts.okrs.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const target = kpiOkrTarget(scope);
  const fillTargets = kpiFillTargets({ drafts, objectives: target ? fillObjectives(target.companyId, loaded.pack) : [] });
  const fillCount = fillTargets.kpis.length + fillTargets.okrs.length;
  const request = kpiOkrRequest(kpiDraftPrompt(input), lang, scope);
  const missingRequest = { ...request, prompt: missingKpiDraftPrompt(input, loaded.pack) };

  const pickNotice = (before: KpiDrafts, r: AddResult, copilot: boolean, rejected = 0, screenNote = ''): Notice => {
    const kpiN = r.drafts.kpis.length - before.kpis.length;
    const okrN = r.drafts.okrs.length - before.okrs.length;
    const parts = [
      kpiN + okrN > 0 ? t('proj.adopt.added', { kpis: kpiN, okrs: okrN }) : t(copilot ? 'proj.adopt.copilotNone' : 'proj.adopt.none'),
      r.skipped ? t('proj.adopt.skipped', { n: r.skipped }) : '',
      rejected ? t('proj.adopt.rejected', { n: rejected }) : '',
      screenNote,
    ].filter(Boolean);
    return { intent: kpiN + okrN > 0 ? 'success' : 'warning', text: parts.join(' ') };
  };
  const report = (before: KpiDrafts, r: AddResult, copilot: boolean) => {
    const n = pickNotice(before, r, copilot);
    setNotice(n);
    const kpiN = r.drafts.kpis.length - before.kpis.length;
    const okrN = r.drafts.okrs.length - before.okrs.length;
    if (kpiN + okrN > 0) scrollToDrafts(okrN > 0 && kpiN === 0 ? 'proj-okr-drafts' : 'proj-kpi-drafts');
  };
  const add = (kind: 'kpi' | 'okr') => {
    const r = (kind === 'kpi' ? addKpiDrafts : addOkrDrafts)(selected, ext, data, drafts, lang);
    setDrafts(r.drafts);
    setSelected([]);
    report(drafts, r, false);
  };
  const errorDetail = (e: unknown) => e instanceof AiLiveError
    ? (e.cause as { code?: unknown } | undefined)?.code === 'contentFiltered' ? t('proj.adopt.contentFiltered')
      : `${e.reasons.map((r) => t(reasonKey(r))).join(', ')}${e.message ? `: ${e.message}` : ''}`
    : e instanceof KpiAnswerError ? t('proj.adopt.badAnswer') : e instanceof Error ? e.message : String(e);
  /** D-46: pick (or propose missing), then fill every empty field; mode 'fill' only fills the drafts already there. */
  const generate = async (mode: 'pick' | 'missing' | 'fill' = 'pick') => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    const pack = loaded.pack;
    const firstRequest = mode === 'missing' ? missingRequest : mode === 'fill' ? kpiOkrRequest(kpiFillPrompt({ ...input, objectives: target ? fillObjectives(target.companyId, pack) : [], today }) ?? '', lang, scope) : request;
    const since = new Date().toISOString();
    const stale = () => !alive.current || controller.signal.aborted || useKpis.getState().scope !== scope || loaded.pack !== pack;
    setBusy(true);
    setActivity('generate');
    setNotice(null);
    setJobTokens(null);
    let picked: Notice | null = null;
    try {
      const pf = preflight(firstRequest);
      if (!pf.allowed) throw new AiLiveError(pf.reasons, pf.budget.reasons.join(', '), pf.budget);
      if (mode !== 'fill') {
        // D-37: the Decision model screens out unrelated and duplicate candidates before chat chooses and words them.
        let screenedExt = input.ext;
        let screenNote = '';
        let chatRequest = firstRequest;
        const plan = mode === 'pick' && isDecisionReady(useAiSettings.getState()) ? kpiScreenRequest(input) : null;
        if (plan) {
          try {
            setActivity('decision');
            const answer = await decisionLive(plan.request, controller.signal);
            const outcome = applyKpiScreen(input.ext, plan, answer.answers);
            if (!outcome) throw new DecisionUnavailable('failed');
            screenedExt = outcome.ext;
            const names = outcome.excluded.slice(0, 5).map((x) => t('proj.adopt.screenItem', { name: candidateName(input.ext, x.candidateId, lang), why: t(`proj.adopt.screen.${x.why}`) })).join(t('ai.listSep'));
            screenNote = t('proj.adopt.screened', { kept: outcome.kept, excluded: outcome.excluded.length }) + (names ? ` ${t('proj.adopt.screenExcluded', { names })}` : '');
            chatRequest = { ...firstRequest, prompt: kpiDraftPrompt({ ...input, ext: screenedExt }) };
          } catch (e) {
            if (controller.signal.aborted) throw e;
            screenNote = t('proj.adopt.screenSkipped');
          }
        }
        const screenedOpen = openCandidates(screenedExt, data, drafts);
        if (mode === 'pick' && screenedOpen.kpis.length + screenedOpen.objectives.length === 0) {
          picked = { intent: 'warning', text: `${t('proj.adopt.copilotNone')} ${screenNote}`.trim() };
        } else {
          setActivity('generate');
          const result = await aiLive(chatRequest, controller.signal);
          if (stale()) return;
          // Apply to the latest state: the user may have adopted or saved items while Copilot was answering.
          const latest = { ...input, ext: mode === 'missing' ? input.ext : screenedExt, data: kpisForScope(useKpis.getState().value, scope), drafts: useKpiDrafts.getState().value };
          let r: AddResult;
          let rejected = 0;
          try {
            if (mode === 'missing') r = applyMissingKpiDraftResponse(result.text, latest, pack);
            else {
              const pick = parseKpiDraftResponse(result.text, latest);
              r = applyCopilotPick(pick, latest);
              rejected = pick.rejected.length;
            }
          } catch { throw new Error(t('proj.adopt.badAnswer')); }
          useKpiDrafts.getState().set(r.drafts);
          picked = pickNotice(latest.drafts, r, true, rejected, screenNote);
        }
      }
      if (!target) { if (picked) setNotice(picked); return; }
      // D-46: every field the material leaves empty gets Copilot's estimate, so each draft can be saved after review.
      setActivity('generate');
      let fillText = '';
      let fillIntent: Notice['intent'] = 'success';
      try {
        const fill = await fillKpiDrafts(target, pack, lang, today, controller.signal, 'kpiOkr:fill', () => !stale());
        if (stale()) return;
        if (fill) {
          if (fill.error && !fill.rounds && !picked && !fill.provisional) throw fill.error;
          fillText = [
            fill.rounds ? t('proj.adopt.filled', { fields: fill.fields, okrs: fill.okrs }) : '',
            fill.error ? t('proj.adopt.fillFailed', { detail: errorDetail(fill.error) }) : '',
            fill.provisional ? t('proj.adopt.provisional', { n: fill.provisional }) : '',
            fill.remaining ? t('proj.adopt.fillRemaining', { n: fill.remaining }) : '',
          ].filter(Boolean).join(' ');
          if (fill.error || fill.provisional || fill.remaining) fillIntent = 'warning';
        } else if (mode === 'fill') fillText = t('proj.adopt.fillNone');
      } catch (e) {
        if (stale()) return;
        if (!picked) throw e;
        fillText = t('proj.adopt.fillFailed', { detail: errorDetail(e) });
        fillIntent = 'warning';
      }
      const intent = picked?.intent === 'warning' || fillIntent === 'warning' ? 'warning' : 'success';
      setNotice({ intent, text: [picked?.text ?? '', fillText].filter(Boolean).join(' ') });
      if (useKpiDrafts.getState().value.kpis.length) scrollToDrafts('proj-kpi-drafts');
    } catch (e) {
      if (!alive.current || controller.signal.aborted || useKpis.getState().scope !== scope) return;
      const blocked = e instanceof AiLiveError && e.reasons.some((r) => r !== 'liveFailed') && (e.cause as { code?: unknown } | undefined)?.code !== 'contentFiltered';
      setNotice({ intent: 'error', text: `${picked ? `${picked.text} ` : ''}${t('proj.adopt.aiError')} ${errorDetail(e)}`, settings: blocked });
    } finally {
      abort.current = null;
      if (alive.current) {
        const summary = summarizeTokens(recordsOfJob(readLedger(), { scope, since, uses: ['kpiOkrDraft', 'kpiOkrScreen'] }));
        setJobTokens(summary.total.calls > 0 ? summary : null);
        setBusy(false);
      }
    }
  };  const stateBadges = (cid: string) => {
    const k = kpiAdoptState(cid, data, drafts);
    const o = okrAdoptState(cid, data, drafts);
    return (
      <>
        {k && <Badge size="small" appearance={k === 'adopted' ? 'tint' : 'outline'} color={k === 'adopted' ? 'success' : 'warning'} data-adopt={`kpi-${k}`}>{t(`proj.adopt.state.kpi.${k}`)}</Badge>}
        {o && <Badge size="small" appearance={o === 'adopted' ? 'tint' : 'outline'} color={o === 'adopted' ? 'success' : 'warning'} data-adopt={`okr-${o}`}>{t(`proj.adopt.state.okr.${o}`)}</Badge>}
      </>
    );
  };

  return (
    <Panel title={t(hasCandidates ? 'proj.packOkr.title' : 'proj.adopt.missingTitle')} rationale={hasCandidates ? 'proj.packOkr.why' : 'proj.adopt.missingWhy'} className="span-full" testId="proj-pack-okr">
      {hasMissing && (
        <div data-testid="proj-missing-drafts">
          <p>{t('proj.adopt.missingHint', { types: missing.kpis && missing.okrs ? 'KPI / OKR' : missing.kpis ? 'KPI' : 'OKR', })}</p>
          <Button appearance="primary" icon={busy ? <Spinner size="tiny" aria-hidden /> : <Sparkle20Regular />} disabled={busy} onClick={() => void generate('missing')} data-testid="proj-missing-copilot">{t('proj.adopt.missingGenerate')}</Button>
        </div>
      )}
      {hasCandidates && <>
      <div className="proj-adopt-bar" role="toolbar" aria-label={t('proj.adopt.toolbar')}>
        <span aria-live="polite">{t('proj.adopt.selected', { n: selected.length })}</span>
        <Button icon={<Add20Regular />} disabled={!selected.length} onClick={() => add('kpi')} data-testid="proj-adopt-kpi">{t('proj.adopt.toKpi')}</Button>
        <Button icon={<Add20Regular />} disabled={!selected.length} onClick={() => add('okr')} data-testid="proj-adopt-okr">{t('proj.adopt.toOkr')}</Button>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" aria-hidden /> : <Sparkle20Regular />} disabled={busy || openCount === 0} onClick={() => void generate()} data-testid="proj-adopt-copilot">{t('proj.adopt.copilot')}</Button>
      </div>
      <p className="muted" data-testid="proj-adopt-copilot-hint">{openCount ? t('proj.adopt.copilotHint', { n: openCount }) : t('proj.adopt.allAdopted')}</p>
      {openCount > 0 && decisionReady && <p className="muted" data-testid="proj-adopt-screen-hint">{t('proj.adopt.screenHint')}</p>}
      </>}
      {fillCount > 0 && (
        <div className="proj-row" data-testid="proj-fill-drafts">
          <Button icon={busy ? <Spinner size="tiny" aria-hidden /> : <Sparkle20Regular />} disabled={busy} onClick={() => void generate('fill')} data-testid="proj-fill-copilot">{t('proj.adopt.fill')}</Button>
          <span className="muted">{t('proj.adopt.fillHint', { n: fillCount })}</span>
        </div>
      )}
      {busy && <Button onClick={() => abort.current?.abort()}>{t('proj.cancel')}</Button>}
      {busy && <AiProgress stage="generate" activity={activity} testId="proj-adopt-progress" />}
      {notice && (
        <MessageBar intent={notice.intent} data-testid="proj-adopt-notice">
          <MessageBarBody>
            {notice.text}
            {notice.settings && <> <Link onClick={openAiSettings}>{t('proj.adopt.openSettings')}</Link></>}
          </MessageBarBody>
        </MessageBar>
      )}
      {jobTokens && <TokenTable summary={jobTokens} testId="proj-adopt-tokens" caption={t('ai.tokens.job')} />}
      {kpis.length > 0 && (
        <ScrollRegion label={t('proj.packOkr.kpis')}>
          <table className="data-table compact">
            <caption>{t('proj.packOkr.kpis')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('proj.adopt.selectCol')}</th>
                <th scope="col">{t('proj.kpi.name')}</th>
                <th scope="col">{t('proj.org.label')}</th>
                <th scope="col">{t('proj.packOkr.definition')}</th>
                <th scope="col">{t('proj.kpi.target')}</th>
                <th scope="col">{t('proj.kpi.current')}</th>
                <th scope="col">{t('proj.packOkr.period')}</th>
                <th scope="col">{t('proj.packOkr.owner')}</th>
                <th scope="col">{t('proj.packOkr.sources')}</th>
              </tr>
            </thead>
            <tbody>
              {kpis.map((k) => {
                const cid = kpiCandidateId(k.id);
                return (
                  <tr key={k.id}>
                    <td><Checkbox checked={selected.includes(cid)} onChange={(_, v) => toggle(cid, v.checked === true)} aria-label={t('proj.adopt.select', { name: text(k.name) })} data-testid={`proj-adopt-select-${k.id}`} /></td>
                    <th scope="row">{text(k.name)} {stateBadges(cid)}</th>
                    <td><OrgBadge org={orgOf(ext.orgUnits, k.orgUnitId)} testId={`proj-pack-kpi-org-${k.id}`} /></td>
                    <td>{text(k.definition)}</td>
                    <td>{[k.target, k.unit].filter(Boolean).join(' ')}</td>
                    <td>{k.current ?? t('proj.packOkr.unmeasured')}</td>
                    <td>{k.period ?? ''}</td>
                    <td>{text(k.owner)}</td>
                    <td>{fmtSources(k.sourceIds, lang)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {objectives.length > 0 && (
        <ul className="proj-okrs" aria-label={t('proj.packOkr.objectives')}>
          {objectives.map((o) => {
            const cid = objectiveCandidateId(o.id);
            return (
              <li key={o.id} className="proj-okr">
                <div className="proj-adopt-obj">
                  <Checkbox checked={selected.includes(cid)} onChange={(_, v) => toggle(cid, v.checked === true)} aria-label={t('proj.adopt.select', { name: text(o.objective) })} data-testid={`proj-adopt-select-${o.id}`} />
                  <div className="proj-okr-head">
                    <strong>{text(o.objective)}</strong>
                    {o.owner !== undefined && <span className="muted">{text(o.owner)}</span>}
                    <OrgBadge org={orgOf(ext.orgUnits, o.orgUnitId)} testId={`proj-pack-okr-org-${o.id}`} />
                    {stateBadges(cid)}
                  </div>
                </div>
                <ul>
                  {o.keyResults.map((kr, i) => (
                    <li key={i}>
                      {text(kr.text)}
                      {(kr.target || kr.period) && <span className="muted">{[kr.target, kr.period].filter(Boolean).join(' / ')}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function fmtSources(ids: readonly string[] | undefined, lang: Parameters<typeof loc>[1]): string {
  if (!ids?.length) return '';
  return ids.map((id) => getEntity(id)).filter((e) => e?.kind === 'source').map((e) => loc(e.name, lang)).join(', ');
}
