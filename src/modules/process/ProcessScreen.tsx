import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody, Tab, TabList,
} from '@fluentui/react-components';
import { Add16Regular, ArrowUndo16Regular, DocumentArrowRight16Regular, Edit16Regular } from '@fluentui/react-icons';
import { useI18n, type T } from '../../i18n/index.ts';
import { useActiveProject } from '../../state/projects.ts';
import { replaceQuery, useRoute, useRouteTarget, hrefFor } from '../../state/router.ts';
import { loc } from '../../state/text.ts';
import { usePackVersion } from '../../state/packEdits.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import type { Formatters, Lang } from '../../i18n/core.ts';
import { normalizeDeliverables, setField } from '../project/deliverables.ts';
import { useDeliverables } from '../project/stores.ts';
import { buildProcess, layoutProcess, metricStatus, presentIn, totals, type ProcessView, type ProcState } from './model.ts';
import { ProcessMap, ZOOM_LEVELS, type ZoomLevel } from './ProcessMap.tsx';
import { StepSummary } from './HoverCard.tsx';
import { IoPanel, ReconcilePanel, ResourcePanel, StepTable, SummaryTiles, TimelinePanel } from './ProcessPanels.tsx';
import { StepEditor } from './StepEditor.tsx';
import { effectiveWorkflow, removeStage, saveWorkflow, setLaborRate, starterWorkflow, useProcessEdits } from './store.ts';
import { duration, hoursMonth } from './format.ts';
import './process.css';
import { ProcessAiPanel } from './ProcessAiPanel.tsx';
import { useSettings } from '../../state/settings.ts';

// The material flow (Sankey) and the system architecture keep their own view, loaded on demand.
const FlowsView = lazy(() => import('../../screens/Flows.tsx').then((m) => ({ default: m.Flows })));

type ViewState = ProcState | 'compare';
const VIEW_STATES: ViewState[] = ['asIs', 'toBe', 'compare'];
type Section = 'map' | 'table' | 'material';
const SECTIONS: Section[] = ['map', 'table', 'material'];

/** Step 1 reads the as-is, step 2 the to-be; later steps compare the two. */
const defaultState = (step: string): ViewState => (step === 'asis' ? 'asIs' : step === 'tobe' ? 'toBe' : 'compare');

/** The text written into the step deliverable ("current process" in step 1, "to-be process" in step 2). */
export function processSummary(v: ProcessView, state: ProcState, t: T, lang: Lang, fmt: Formatters): string {
  const x = totals(v, state);
  const lines: string[] = [];
  if (v.title) lines.push(loc(v.title, lang));
  for (const p of v.phases) {
    const steps = v.steps.filter((s) => s.phaseId === p.id && presentIn(s, state));
    if (!steps.length) continue;
    const items = steps.map((s) => {
      const lane = v.lanes.find((l) => l.id === s.laneId);
      return t('bp.sum.step', { name: loc(s.name, lang), lane: lane ? loc(lane.name, lang) || t('bp.lane.unassigned') : '', side: t(`bp.side.${lane?.side ?? 'internal'}`) });
    });
    lines.push(`${p.name ? loc(p.name, lang) : t('bp.phase.all')}: ${items.join(' → ')}`);
  }
  lines.push(t('bp.sum.totals', {
    lead: duration(x.leadHours, t, fmt), efficiency: x.efficiency === null ? t('bp.unknown') : fmt.percent(x.efficiency),
    effort: hoursMonth(x.effortHours, t, fmt), steps: x.steps, handoffs: x.handoffs, manual: x.manualArtifacts + x.hiddenWork,
  }));
  lines.push(t('bp.status.summary', {
    before: [...new Set(v.steps.flatMap((s) => metricStatus(s.asIs)))].map((s) => t(`bp.status.${s}`)).join(' / '),
    after: [...new Set(v.steps.flatMap((s) => metricStatus(s.toBe)))].map((s) => t(`bp.status.${s}`)).join(' / '),
  }));
  if (state === 'toBe') {
    const by = (c: string) => v.steps.filter((s) => s.change === c).map((s) => loc(s.name, lang));
    for (const c of ['remove', 'combine', 'new', 'improve'] as const) if (by(c).length) lines.push(`${t(`bp.change.${c}`)}: ${by(c).join(', ')}`);
    if (x.estimates) lines.push(t('bp.sum.hypotheses', { n: x.estimates }));
  }
  const loops = v.loops.filter((l) => l.state === 'both' || l.state === state);
  if (loops.length) lines.push(t('bp.sum.loops', { list: loops.map((l) => `${loc(v.byId.get(l.from)!.name, lang)} → ${loc(v.byId.get(l.to)!.name, lang)}`).join(', ') }));
  return lines.join('\n');
}

export function ProcessScreen() {
  const { t, lang, fmt } = useI18n();
  const route = useRoute();
  useRouteTarget();
  usePackVersion((s) => s.version);
  const stored = useProcessEdits((s) => s.value);
  const audience = useSettings((s) => s.audience);
  const { step } = useActiveProject();
  const { workflow, origin, stale } = effectiveWorkflow(stored);
  const view = useMemo(() => (workflow ? buildProcess(workflow) : null), [workflow]);
  const layout = useMemo(() => (view ? layoutProcess(view) : null), [view]);

  const q = route.query;
  const viewState: ViewState = (VIEW_STATES as string[]).includes(q.get('state') ?? '') ? (q.get('state') as ViewState) : defaultState(step);
  const section: Section = (SECTIONS as string[]).includes(q.get('tab') ?? '') ? (q.get('tab') as Section) : 'map';
  const level: ZoomLevel = (ZOOM_LEVELS as string[]).includes(q.get('level') ?? '') ? (q.get('level') as ZoomLevel) : 'overview';
  const selected = view?.byId.has(q.get('sel') ?? '') ? q.get('sel') : null;
  const state: ProcState = viewState === 'compare' ? 'toBe' : viewState;
  const critical = useMemo(() => new Set(view ? totals(view, state).path : []), [view, state]);

  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [written, setWritten] = useState<string | null>(null);
  const deliverables = useDeliverables((s) => s.value);
  const onLevel = useCallback((lv: ZoomLevel) => replaceQuery({ level: lv === 'overview' ? undefined : lv }), []);
  const onSelect = useCallback((id: string | null) => replaceQuery({ sel: id ?? undefined, ...(id && section !== 'map' ? { tab: undefined } : {}) }), [section]);

  const docStep = state === 'asIs' ? 'asis' : 'tobe';
  const docField = state === 'asIs' ? 'currentProcess' : 'toBeProcess';
  const existing = normalizeDeliverables(deliverables).docs[docStep]?.[docField]?.text.trim() ?? '';
  const writeSummary = () => {
    if (!view) return;
    const text = processSummary(view, state, t, lang, fmt);
    useDeliverables.getState().set((prev) => setField(normalizeDeliverables(prev), docStep, docField, { text, author: 'human', updatedAt: new Date().toISOString() }));
    setConfirmWrite(false);
    setWritten(docStep);
  };

  return (
    <div className="screen screen-process">
      <PageHeader
        title={t('bp.title')}
        subtitle={t('bp.subtitle')}
        actions={view ? (
          <div className="bp-actions">
            <Button icon={<Add16Regular />} onClick={() => setEditing({ id: null })} data-testid="bp-add-step">{t('bp.action.addStep')}</Button>
            {viewState !== 'compare' && (
              <Button icon={<DocumentArrowRight16Regular />} onClick={() => (existing ? setConfirmWrite(true) : writeSummary())} data-testid="bp-write-summary">
                {t(state === 'asIs' ? 'bp.action.writeAsIs' : 'bp.action.writeToBe')}
              </Button>
            )}
            {origin === 'edited' && <Button appearance="subtle" icon={<ArrowUndo16Regular />} onClick={() => useProcessEdits.getState().reset()} data-testid="bp-reset">{t('bp.action.reset')}</Button>}
          </div>
        ) : undefined}
      />

      {origin === 'demo' && <MessageBar intent="info" data-testid="bp-origin-demo"><MessageBarBody>{t('bp.origin.demo')}</MessageBarBody></MessageBar>}
      <ProcessAiPanel workflow={workflow} />
      {audience === 'internal' && workflow?.draftNote && <MessageBar intent="warning" data-testid="bp-draft-note"><MessageBarBody>{loc(workflow.draftNote, lang)}</MessageBarBody></MessageBar>}
      {origin === 'edited' && <MessageBar intent={stale ? 'warning' : 'info'} data-testid="bp-origin-edited"><MessageBarBody>{t(stale ? 'bp.origin.stale' : 'bp.origin.edited')}</MessageBarBody></MessageBar>}
      {written && (
        <MessageBar intent="success" data-testid="bp-written">
          <MessageBarBody>{t('bp.written')} <a href={hrefFor('/deliverables', { step: written, target: `dlv-field-${written === 'asis' ? 'currentProcess' : 'toBeProcess'}` })}>{t('bp.writtenOpen')}</a></MessageBarBody>
        </MessageBar>
      )}

      {!view || !layout ? (
        <Panel title={t('bp.empty.title')} testId="bp-empty">
          <p>{t('bp.empty.body')}</p>
          <Button appearance="primary" onClick={() => saveWorkflow(starterWorkflow(t('bp.empty.firstStep'), t('bp.empty.firstLane')))} data-testid="bp-start">{t('bp.empty.start')}</Button>
        </Panel>
      ) : (
        <>
          <div className="bp-statebar">
            <div role="radiogroup" aria-label={t('bp.state.label')} className="bp-states">
              {VIEW_STATES.map((s) => (
                <Button key={s} role="radio" aria-checked={viewState === s} appearance={viewState === s ? 'primary' : 'secondary'} onClick={() => replaceQuery({ state: s })} data-testid={`bp-state-${s}`}>
                  {t(`bp.stateTab.${s}`)}
                </Button>
              ))}
            </div>
            <p className="muted">{t(`bp.stateHelp.${viewState}`)}</p>
          </div>
          {!view.hasToBe && viewState !== 'asIs' && <MessageBar intent="info" data-testid="bp-no-tobe"><MessageBarBody>{t('bp.noToBe')}</MessageBarBody></MessageBar>}

          <SummaryTiles view={view} />

          <TabList selectedValue={section} onTabSelect={(_, d) => replaceQuery({ tab: d.value === 'map' ? undefined : String(d.value), section: undefined })} aria-label={t('bp.sections')}>
            <Tab value="map" data-testid="bp-tab-map">{t('bp.section.map')}</Tab>
            <Tab value="table" data-testid="bp-tab-table">{t('bp.section.table')}</Tab>
            <Tab value="material" data-testid="bp-tab-material">{t('bp.section.material')}</Tab>
          </TabList>

          {section === 'map' && (
            <>
              <div className={`bp-split ${selected ? 'has-detail' : ''}`}>
                <Panel title={view.title ? loc(view.title, lang) : t('bp.map.title')} rationale="bp.rationale.map" testId="bp-map-panel">
                  <ProcessMap view={view} layout={layout} state={state} compare={viewState === 'compare'} level={level} onLevel={onLevel} selected={selected} onSelect={onSelect} criticalIds={critical} />
                </Panel>
                {selected && (
                  <Panel
                    title={t('bp.detail.title')}
                    testId="bp-detail"
                    actions={<Button size="small" icon={<Edit16Regular />} onClick={() => setEditing({ id: selected })} data-testid="bp-edit-step">{t('bp.action.edit')}</Button>}
                  >
                    <StepSummary step={view.byId.get(selected)!} view={view} state={state} full />
                    <Button size="small" appearance="subtle" onClick={() => onSelect(null)}>{t('bp.detail.close')}</Button>
                  </Panel>
                )}
              </div>
              <div className="bp-panels">
                <TimelinePanel view={view} />
                <ReconcilePanel view={view} onSpans={(kpiSpans) => workflow && saveWorkflow({ ...workflow, kpiSpans })} />
                <ResourcePanel key={String(view.laborRate)} view={view} onRate={(rate) => workflow && saveWorkflow(setLaborRate(workflow, rate, lang))} />
                <IoPanel view={view} state={state} />
              </div>
            </>
          )}
          {section === 'table' && <StepTable view={view} onSelect={onSelect} />}
        </>
      )}
      {section === 'material' && <Suspense fallback={null}><FlowsView embedded /></Suspense>}

      {editing && workflow && (
        <StepEditor
          workflow={workflow}
          stageId={editing.id}
          defaultChange={state === 'toBe' && editing.id === null ? 'new' : 'keep'}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            saveWorkflow(next);
            setEditing(null);
          }}
          onDelete={editing.id ? () => {
            const next = removeStage(workflow, editing.id!);
            if (next) saveWorkflow(next);
            setEditing(null);
            replaceQuery({ sel: undefined });
          } : undefined}
        />
      )}
      {confirmWrite && (
        <Dialog open onOpenChange={(_, d) => { if (!d.open) setConfirmWrite(false); }}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{t('bp.confirm.title')}</DialogTitle>
              <DialogContent>{t('bp.confirm.body')}</DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setConfirmWrite(false)}>{t('bp.ed.cancel')}</Button>
                <Button appearance="primary" onClick={writeSummary} data-testid="bp-confirm-write">{t('bp.confirm.ok')}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}
