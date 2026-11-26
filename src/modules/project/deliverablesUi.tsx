import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, ProgressBar,
} from '@fluentui/react-components';
import {
  CheckmarkCircle20Filled, ChevronDown20Regular, ChevronUp20Regular, DatabaseSearch20Regular, DocumentText20Regular, ErrorCircle20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { AiLiveError, preflight, type AiResponse } from '../../ai/client.ts';
import { PARAMS } from '../../config/params.ts';
import { loaded, packOrigin } from '../../data/pack.ts';
import { useI18n, type Lang, type MessageKey } from '../../i18n/index.ts';
import { currentScope, IMPROVEMENT_STEPS, useActiveProject, useProjects, type ImprovementStep } from '../../state/projects.ts';
import { hrefFor, revisitRouteTarget } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { commitPackChanges, usePackVersion } from '../../state/packEdits.ts';
import { loc } from '../../state/text.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { useUseCases } from '../usecases/store.ts';
import { catalogForScope, useCatalogImport } from '../usecases/catalog.ts';
import { reasonKey, TokensInline } from '../ai/AiCommon.tsx';
import { AiProgress, type AiActivity, type AiStage } from '../ai/AiProgress.tsx';
import { DELIVERABLE_DRAFT_TIMEOUT_MS } from '../../ai/policy.ts';
import { aiRequestFits } from '../../ai/client.ts';
import { MockBadge } from './common.tsx';
import { draftEntities, draftRequest, requestDeliverableDraft } from './deliverableDraft.ts';
import { fillChanges, fillRequest, findGaps, mergeFills, previewFillContext, requestFill, savedProposals, type FillProposal } from './dataFill.ts';
import { FillProposalList } from './DataFillPanel.tsx';
import {
  applyDraft, evaluateStep, threadOf, fieldKey, nextTodo, normalizeDeliverables, openFirst, PAYBACK_MAX_YEARS, paybackLimit, progressOf, resultKey, setSignOff, STEP_DEFS, todoKey, todoWhyKey,
  type AppCheckContext, type CheckContext, type CheckRef, type TodoResult,
} from './deliverables.ts';
import { kpisForScope, useAnalyses, useDeliverables, useDiscussion, useFieldDrafts, useKpis, useProjTransient, useProjUi, useStrategy, type SavedFieldDraft } from './stores.ts';
import { gapCount, normalizeStrategy } from './strategy.ts';
import { TaskDraftLine, useTaskStatuses } from './taskDraftsUi.tsx';
import { latestCompanyAnchor } from '../../state/companyAnchors.ts';
import './project.css';

/** YYYY-MM-DD in the app's time zone. The demo is judged on the sample's "as of" date so it stays deterministic. */
export function todayIn(timeZone: string = PARAMS.timeZone, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Every component that reads the check context in the same state gets the same object, so the per-context caches
 * (threadOf, evaluateStep) compute the strategy thread and step checks once instead of once per component.
 */
let sharedCheckContext: { deps: readonly unknown[]; ctx: AppCheckContext } | undefined;

export function useCheckContext(): AppCheckContext {
  const packVersion = usePackVersion((s) => s.version);
  const discussion = useDiscussion((s) => s.value);
  const kpiValue = useKpis((s) => s.value);
  const kpiScope = useKpis((s) => s.scope);
  const analysis = useAnalyses((s) => s.value);
  const useCases = useUseCases((s) => s.value);
  const raw = useDeliverables((s) => s.value);
  const rawStrategy = useStrategy((s) => s.value);
  const isDemo = useProjects((s) => s.target.kind === 'demo');
  const { project, company } = useActiveProject();
  const companyId = company?.id ?? '';
  const anchorVersion = company?.anchorRef?.version;
  const alignments = project?.alignments;
  const storedCatalog = useCatalogImport((s) => s.value);
  const catalogScope = useCatalogImport((s) => s.scope);
  const deps = [loaded, packOrigin, packVersion, discussion, kpiValue, kpiScope, analysis, useCases, raw, rawStrategy, isDemo, companyId, anchorVersion, alignments, storedCatalog, catalogScope];
  return useMemo(() => {
    const shared = sharedCheckContext;
    if (shared && shared.deps.length === deps.length && shared.deps.every((d, i) => Object.is(d, deps[i]))) return shared.ctx;
    const catalog = catalogForScope(storedCatalog, catalogScope)?.items;
    const ctx: AppCheckContext = {
      pack: loaded, discussion, kpi: kpisForScope(kpiValue, kpiScope), analysis, useCases, deliverables: normalizeDeliverables(raw), today: isDemo ? PARAMS.asOfDate : todayIn(),
      strategy: normalizeStrategy(rawStrategy), objectives: companyObjectives(companyId),
      projectObjectiveIds: [...new Set((alignments ?? []).filter((a) => a.kind !== 'unaligned').flatMap((a) => a.objectiveIds))],
      ...(catalog?.length ? { catalog } : {}),
    };
    sharedCheckContext = { deps, ctx };
    return ctx;
  }, deps);
}

/**
 * The check context for read-only status bands shown on every screen (the stepper and the expected outcomes). While someone types, the bands keep the
 * last results and re-evaluate in an interruptible background render, so judging every step never delays a keystroke.
 * Never use it where a control shows the data (inputs, sign-off checkboxes): it would show the old value after a change.
 */
export function useDeferredCheckContext(): AppCheckContext {
  return useDeferredValue(useCheckContext());
}

/** The company's stated objectives (company anchor), the top of the company → OKR → KPI → solution chain. */
export function companyObjectives(companyId: string): { id: string; text: string }[] {
  if (!companyId) return [];
  try {
    return latestCompanyAnchor(companyId)?.anchor.statedObjectives.map((o) => ({ id: o.id, text: o.text })) ?? [];
  } catch {
    return [];
  }
}

/**
 * Company objective → OKR → KPI → solution in one line, with the number of breaks; links to the full chain.
 * The band shows it as text: the band overlays scrolled content, and a link there would obscure targets beneath it.
 */
export function StrategySummary({ ctx, link = true }: { ctx: CheckContext; link?: boolean }) {
  const { t } = useI18n();
  const thread = threadOf(ctx);
  const gaps = gapCount(thread);
  const body = (
    <>
      <span>{t('sol.thread.compact', { objectives: thread.objectives.length, okrs: thread.okrs.length, kpis: thread.kpis.length, solutions: thread.solutions.length })}</span>
      {' '}
      <Badge size="small" appearance="tint" color={gaps ? 'warning' : 'success'} data-testid="sol-summary-gaps">
        {gaps ? t('sol.thread.summaryGaps', { n: gaps }) : t('sol.thread.summaryOk')}
      </Badge>
    </>
  );
  return link ? (
    <a className="sol-summary" href={`${hrefFor('/deliverables', { step: 'kpi' })}#sol-thread`} title={t('sol.thread.open')} data-testid="sol-summary">
      {body}
    </a>
  ) : (
    <span className="sol-summary" data-testid="sol-summary">{body}</span>
  );
}

export const deliverableNameKey = (step: ImprovementStep) => `dlv.${step}.name` as MessageKey;
export const todoLabel = (t: (k: MessageKey, v?: Record<string, string | number>) => string, id: string, max: number = PAYBACK_MAX_YEARS) => t(todoKey(id), { max });
/** The project's payback hurdle (its own criterion, else the default). */
export const usePaybackLimit = () => useDeliverables((s) => paybackLimit(normalizeDeliverables(s.value)));

function signOffNow(todoId: string, checked: boolean) {
  const by = useProjUi.getState().editor.trim();
  useDeliverables.getState().set((v) => setSignOff(normalizeDeliverables(v), todoId, checked ? { at: new Date().toISOString(), by } : null));
}

const MAX_REFS = 5;

/** Prefer the first failing field; otherwise open the exact tab/component where the work is done. */
/** Strategy checks open the panel where the gap is fixed, not the document fields. */
const STRATEGY_TARGETS: Record<string, string> = {
  'kpi-definition': 'sol-def',
  'kpi-company': 'sol-def',
  'sol-type': 'sol-types',
  'sol-contribution': 'sol-types',
  'sol-target': 'sol-sim',
  'dlv-trace': 'sol-thread',
  'dlv-docs': 'sol-docs',
};

export function todoHref(r: TodoResult): string {
  const [path = '/', query = ''] = r.todo.href.split('?');
  const q = new URLSearchParams(query);
  const field = r.outcome?.refs?.find((ref) => ref.type === 'field');
  if (field?.type === 'field') {
    return hrefFor('/deliverables', { step: field.step, target: `dlv-field-${field.id}` });
  }
  if (r.todo.id === 'plan-payback') {
    return hrefFor('/deliverables', { step: 'deliverable', target: 'dlv-criteria' });
  }
  const entity = r.outcome?.refs?.find((ref) => ref.type === 'entity');
  if (['plan-coverage', 'plan-schedule', 'plan-owner'].includes(r.todo.id)) {
    const query: Record<string, string> = { view: 'table', target: 'relation-table' };
    if (r.todo.id === 'plan-coverage' && r.outcome?.code === 'noSolutions') {
      query.create = 'solution';
      query.field = 'name';
    } else if (r.todo.id !== 'plan-coverage' && entity?.type === 'entity' && loaded.byId.get(entity.id)?.kind === 'initiative') {
      query.edit = entity.id;
      query.field = r.todo.id === 'plan-owner' ? 'ownerId' : 'start';
    } else {
      query.create = 'initiative';
      query.field = 'solutionId';
    }
    return hrefFor('/relations', query);
  }
  if ((r.todo.id === 'asis-baseline' || r.todo.id === 'kpi-direction') && entity?.type === 'entity') {
    return hrefFor('/relations', { view: 'table', target: 'relation-table', edit: entity.id, field: r.todo.id === 'asis-baseline' ? 'baseline' : 'target' });
  }
  if (r.todo.kind === 'manual') {
    q.set('target', `dlv-sign-${r.todo.id}`);
  } else if (path === '/deliverables') {
    q.set('target', STRATEGY_TARGETS[r.todo.id] ?? 'dlv-fields');
  } else if (path === '/projects') {
    q.set('target', 'proj-active');
  } else if (path === '/analysis') {
    if (q.get('tab') === 'kpi') q.set('target', r.todo.id === 'kpi-okr' ? 'proj-okr-panel' : 'proj-kpi-panel');
    else q.set('target', 'proj-method-panel');
  } else if (path === '/relations') {
    q.set('view', 'table');
    q.set('target', 'relation-table');
    const fields: Record<string, string> = {
      'define-sources': 'sourceIds', 'define-causes': 'causeIds', 'define-kpi-link': 'kpiIds',
      'asis-cause-evidence': r.outcome?.code === 'noCauses' ? 'causeIds' : 'sourceIds',
    };
    if (fields[r.todo.id] && entity?.type === 'entity') {
      q.set('edit', entity.id);
      q.set('field', fields[r.todo.id]!);
    } else if (fields[r.todo.id] && r.outcome?.code === 'noIssues') {
      q.set('create', 'issue');
    }
  } else if (path === '/discussion') {
    q.set('target', r.outcome?.code === 'noThemes' ? 'proj-tree' : 'proj-canvas');
  } else if (path === '/usecases') {
    q.set('target', 'uc-list');
  } else if (path === '/plan') {
    q.set('target', r.todo.id === 'plan-schedule' ? 'gantt-panel' : 'plan-table');
  } else if (path === '/step') {
    q.set('target', 'step-dash-issues');
  }
  return hrefFor(path, q);
}

export function Refs({ refs, limit = MAX_REFS }: { refs: CheckRef[]; limit?: number }) {
  const { t, lang } = useI18n();
  if (refs.length === 0) return null;
  const shown = refs.slice(0, limit);
  return (
    <ul className="dlv-refs">
      {shown.map((r, i) => (
        <li key={i}>
          {r.type === 'entity' && <EntityRef id={r.id} />}
          {r.type === 'text' && <span>{loc(r.text, lang)}</span>}
          {r.type === 'field' && (
            <a className="dlv-field-ref" href={hrefFor('/deliverables', { step: r.step, target: `dlv-field-${r.id}` })} onClick={revisitRouteTarget}>
              {t(fieldKey(r.step, r.id))}
            </a>
          )}
        </li>
      ))}
      {refs.length > limit && <li className="muted">{t('dlv.more', { n: refs.length - limit })}</li>}
    </ul>
  );
}

function approveTask(id: string) {
  const audience = useSettings.getState().audience;
  const key = `${audience}:${id}`;
  useDeliverables.getState().set((value) => {
    const data = normalizeDeliverables(value);
    const item = data.recommendations?.[key] ?? (audience === 'internal' ? data.recommendations?.[id] : undefined);
    if (!item?.draft) return data;
    return {
      ...data,
      recommendations: { ...data.recommendations, [key]: {
        approved: { ...item.draft, at: new Date().toISOString(), by: useProjUi.getState().editor.trim() },
      } },
    };
  });
}

/** One exit criterion: auto-checked (verdict + evidence + where to fix it) or a person's sign-off (checkbox). */
export function TodoItem({ r, detailed = false }: { r: TodoResult; detailed?: boolean }) {
  const { t, fmt } = useI18n();
  const checkboxId = useId();
  const ctx = useCheckContext();
  const { drafts: taskDrafts } = useTaskStatuses(ctx);
  const audience = useSettings((s) => s.audience);
  const openResolution = useProjTransient((s) => s.openResolution);
  const recommendation = useDeliverables((s) => s.value.recommendations?.[`${audience}:${r.todo.id}`] ?? (audience === 'internal' ? s.value.recommendations?.[r.todo.id] : undefined));
  const label = todoLabel(t, r.todo.id, usePaybackLimit());
  const status = <span className="visually-hidden">{t(r.done ? 'dlv.status.done' : 'dlv.status.todo')}</span>;
  const kind = <Badge size="small" appearance="outline" color={r.todo.kind === 'auto' ? 'informative' : 'brand'} className="dlv-kind">{t(r.todo.kind === 'auto' ? 'dlv.kind.auto' : 'dlv.kind.manual')}</Badge>;
  const caption = r.todo.kind === 'manual'
    ? (r.signOff
      ? (r.signOff.by ? t('dlv.signedOff', { date: fmt.date(todayIn(PARAMS.timeZone, new Date(r.signOff.at))), by: r.signOff.by }) : t('dlv.signedOffAnon', { date: fmt.date(todayIn(PARAMS.timeZone, new Date(r.signOff.at))) }))
      : t('dlv.waiting'))
    : t(resultKey(r.outcome!.code), r.outcome!.vars);
  return (
    <li className={`dlv-todo ${r.done ? 'done' : ''}`} data-testid={`dlv-todo-${r.todo.id}`} data-done={r.done} data-kind={r.todo.kind}>
      <div className="dlv-todo-main">
        {r.todo.kind === 'manual' ? (
          <Checkbox checked={r.done} onChange={(_, d) => signOffNow(r.todo.id, d.checked === true)} label={label} id={detailed ? `dlv-sign-${r.todo.id}` : checkboxId} data-testid={`dlv-sign-${r.todo.id}`} />
        ) : (
          <span className="dlv-todo-auto">
            {r.done ? <CheckmarkCircle20Filled className="dlv-ok" aria-hidden /> : <ErrorCircle20Regular className="dlv-ng" aria-hidden />}
            {status}
            <span className="dlv-todo-label">{label}</span>
          </span>
        )}
      </div>
      <div className="dlv-todo-meta">
        {kind}
        <Caption1 className="dlv-todo-caption" data-testid={`dlv-result-${r.todo.id}`}>{caption}</Caption1>
      </div>
      {detailed && <p className="dlv-todo-why">{t(todoWhyKey(r.todo.id))}</p>}
      {detailed && r.outcome && !r.outcome.ok && <Refs refs={r.outcome.refs ?? []} limit={Infinity} />}
      {detailed && recommendation?.approved && (
        <div data-testid={`dlv-task-approved-${r.todo.id}`}>
          <strong>{t('dlv.task.approved')}</strong>{' '}{recommendation.approved.mock && <MockBadge />}
          <p className="muted">{t('dlv.task.historical')}</p>
          <p className="proj-prewrap">{recommendation.approved.text}</p>
        </div>
      )}
      {detailed && recommendation?.draft && !taskDrafts[`${audience}:${r.todo.id}`] && (
        <div data-testid={`dlv-task-draft-${r.todo.id}`}>
          <strong>{t('dlv.task.draft')}</strong>{' '}{recommendation.draft.mock && <MockBadge />}
          <p className="proj-prewrap">{recommendation.draft.text}</p>
          <Button size="small" onClick={() => approveTask(r.todo.id)}>{t('dlv.task.approve')}</Button>
        </div>
      )}
      {!r.done && r.todo.kind === 'auto' && (
        <div className="dlv-todo-actions">
          <a className="dlv-fix" href={todoHref(r)} onClick={revisitRouteTarget} aria-label={t('dlv.fixLabel', { todo: label })}>
            {t('dlv.fix')}
          </a>
          <Button size="small" icon={<Sparkle20Regular />} onClick={() => openResolution(r.todo.id)} aria-label={t('dlv.resolve.label', { todo: label })} data-testid={`dlv-resolve-${r.todo.id}`}>
            {t('dlv.resolve.button')}
          </Button>
        </div>
      )}
      {!detailed && (
        <a
          href={hrefFor('/deliverables', { step: Object.values(STEP_DEFS).find((def) => def.todos.some((todo) => todo.id === r.todo.id))?.step, task: r.todo.id, target: 'dlv-task-workbench' })}
          onClick={revisitRouteTarget}
          aria-label={t('dlv.task.simLabel', { todo: label })}
        >
          {t('dlv.task.simulate')}
        </a>
      )}
      <TaskDraftLine r={r} ctx={ctx} />
    </li>
  );
}

/**
 * In automatic mode the to-do list opens only while the fixed area above the work area, list included, takes at most
 * this share of the window height (the work area keeps at least 65 %). Measured with Playwright: the band head ends at
 * 173 px and the open list is 142 px, so the border is a ~900 px tall viewport, clear of common sizes: 1920×1080 at
 * 100 % (33 %) opens; 1440×900 (40 %), 1920×1080 at 125 % (43 %) and 1366×768 stay closed.
 */
export const BAND_MAX_SHARE = 0.35;
/** List height used until the list has been seen once (measured: the define step, desktop density). */
export const BAND_LIST_HEIGHT_GUESS = 142;
let lastListHeight = BAND_LIST_HEIGHT_GUESS;

/** Pure rule behind automatic mode: open the list only if the head's bottom plus the list fits in BAND_MAX_SHARE of the window. */
export const shouldAutoExpand = (headBottom: number, listHeight: number, viewportHeight: number) =>
  viewportHeight > 0 && headBottom + listHeight <= BAND_MAX_SHARE * viewportHeight;

function useRoomForList(head: HTMLElement | null, list: HTMLElement | null): boolean {
  const [room, setRoom] = useState(false);
  useEffect(() => {
    if (!head) return;
    const measure = () => {
      if (list && !list.hidden && list.offsetHeight > 0) lastListHeight = list.offsetHeight;
      setRoom(shouldAutoExpand(head.getBoundingClientRect().bottom + window.scrollY, lastListHeight, window.innerHeight));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(head);
    if (list) ro?.observe(list);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, [head, list]);
  return room;
}

/** Wide to-do band under the live bar: the current step's exit criteria, judged live from the data. */
export function StepTodoBand() {
  const { t } = useI18n();
  const { step } = useActiveProject();
  const ctx = useCheckContext();
  const results = useMemo(() => evaluateStep(step, ctx), [step, ctx]);
  const p = progressOf(results);
  const next = nextTodo(results);
  const maxYears = usePaybackLimit();
  const preference = useProjUi((s) => s.todoCollapsed);
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const room = useRoomForList(head, list);
  const collapsed = preference ?? !room;
  const setCollapsed = useProjUi((s) => s.setTodoCollapsed);
  const openBatchDraft = useProjTransient((s) => s.openBatchDraft);
  const openTaskReview = useProjTransient((s) => s.openTaskReview);
  const { statuses } = useTaskStatuses(ctx);
  const awaiting = [...statuses.values()].filter((s) => s.state === 'ready' || s.state === 'open' || s.state === 'viaOther');
  const awaitingHere = awaiting.filter((s) => s.step === step).length;
  const applied = useProjTransient((s) => s.draftApplied);
  const listId = useId();
  const n = IMPROVEMENT_STEPS.indexOf(step) + 1;
  const stepName = t(`proj.step.${step}`);
  return (
    <section className="dlv-band" aria-label={t('dlv.band.label')} data-testid="dlv-band" data-step={step} data-complete={p.complete}>
      <div className="dlv-band-head" ref={setHead}>
        <div className="dlv-band-title">
          <strong>{t('dlv.band.step', { n, total: IMPROVEMENT_STEPS.length, step: stepName })}</strong>
          <span className="dlv-band-deliverable">{t('dlv.band.deliverable', { name: t(deliverableNameKey(step)) })}</span>
        </div>
        <div className="dlv-band-progress">
          <ProgressBar value={p.total ? p.done / p.total : 0} thickness="large" color={p.complete ? 'success' : 'brand'} aria-hidden className="dlv-progressbar" />
          <span data-testid="dlv-progress">{p.complete ? t('dlv.band.complete') : t('dlv.band.progress', { done: p.done, total: p.total })}</span>
          {awaitingHere > 0 && <span className="dlv-band-awaiting" data-testid="dlv-band-awaiting">{t('dlv.td.awaiting', { n: awaitingHere })}</span>}
        </div>
        {next && (
          <a
            className="dlv-band-next"
            href={todoHref(next)}
            onClick={revisitRouteTarget}
            data-testid="dlv-next"
            data-todo={next.todo.id}
          >
            <span className="dlv-band-next-lead">{t('dlv.band.next')}</span>
            <span className="dlv-band-next-text">{todoLabel(t, next.todo.id, maxYears)}</span>
          </a>
        )}
        <span className="visually-hidden" role="status">{applied ? [
          t('dlv.draft.applied', { n: applied.count }),
          applied.filled !== undefined ? t('dlv.fill.applied', { n: applied.filled }) : '',
          applied.skipped ? t('dlv.fill.skipped', { n: applied.skipped }) : '',
        ].filter(Boolean).join(' ') : ''}</span>
        <div className="dlv-band-actions">
          <Button appearance="primary" className="dlv-batch-button" icon={<Sparkle20Regular />} onClick={openBatchDraft} data-testid="dlv-draft">{t('dlv.batch.button')}</Button>
          {awaiting.length > 0 && <Button appearance="secondary" icon={<CheckmarkCircle20Filled />} onClick={openTaskReview} data-testid="dlv-td-open-review">{t('dlv.td.openReview', { n: awaiting.length })}</Button>}
          <Button as="a" appearance="secondary" icon={<DocumentText20Regular />} href={hrefFor('/deliverables', { step })} data-testid="dlv-open">{t('dlv.band.open')}</Button>
          <Button
            appearance="subtle"
            icon={collapsed ? <ChevronDown20Regular /> : <ChevronUp20Regular />}
            aria-expanded={!collapsed}
            aria-controls={listId}
            onClick={() => setCollapsed(!collapsed)}
            data-testid="dlv-band-toggle"
          >
            {t(collapsed ? 'dlv.band.expand' : 'dlv.band.collapse')}
          </Button>
        </div>
        <StrategySummary ctx={ctx} link={false} />
      </div>
      <div id={listId} ref={setList} className="dlv-band-scroll" hidden={collapsed} tabIndex={collapsed ? undefined : 0} role="region" aria-label={t('dlv.band.list', { step: stepName })}>
        <ul className="dlv-band-list">
          {openFirst(results).map((r) => <TodoItem key={r.todo.id} r={r} />)}
        </ul>
      </div>
    </section>
  );
}

type DraftTextMap = Record<string, string>;
type DraftState =
  | { status: 'idle' }
  | { status: 'working'; stage: AiStage; startedAt?: number; activity?: AiActivity; part?: { current: number; total: number }; retry?: boolean }
  | { status: 'ready'; response: AiResponse; fields: DraftTextMap; tasks: DraftTextMap; at: string; fills: FillProposal[]; fillError?: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

function sameFieldDraft(saved: SavedFieldDraft | undefined, ready: { fields: DraftTextMap; at: string }, lang: Lang): boolean {
  return !!saved && saved.lang === lang && saved.at === ready.at && JSON.stringify(saved.fields) === JSON.stringify(ready.fields);
}

/** "Draft with Copilot": preview the draft, then fill the deliverable (empty fields only unless the user says so). */
export function DraftDialog() {
  const { t, lang } = useI18n();
  const step = useProjTransient((s) => s.draftStep);
  const closeDraft = useProjTransient((s) => s.closeDraft);
  const audience = useSettings((s) => s.audience);
  const ctx = useCheckContext();
  const scope = useDeliverables((s) => s.scope);
  const savedDraft = useFieldDrafts((s) => step ? s.value[`${audience}:${step}`] : undefined);
  const [state, setState] = useState<DraftState>({ status: 'idle' });
  const [overwrite, setOverwrite] = useState(false);
  const [fillOn, setFillOn] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const missing = useMemo(() => findGaps(ctx, audience).length, [ctx, audience]);
  const abortRef = useRef<AbortController | null>(null);
  const cancel = () => abortRef.current?.abort();
  // Closing the dialog or switching the target stops the request instead of leaving it running unseen.
  const close = () => {
    cancel();
    closeDraft();
  };
  useEffect(() => cancel, []);

  useEffect(() => {
    cancel();
    const saved = step ? useFieldDrafts.getState().value[`${audience}:${step}`] : undefined;
    setState(saved && saved.lang === lang ? {
      status: 'ready',
      response: { mode: 'live', text: '', blockedReasons: [], withheldIds: [], context: '' },
      fields: saved.fields,
      tasks: {},
      at: saved.at,
      fills: savedProposals(saved.fills),
    } : { status: 'idle' });
    setOverwrite(false);
    setApplyError(null);
  }, [step, scope, audience, lang]);

  const generate = async () => {
    if (!step || state.status === 'working') return;
    const saved = useFieldDrafts.getState().value[`${audience}:${step}`];
    const originalDraft = saved ? { ...saved, fields: { ...saved.fields } } : undefined;
    const taskDrafts = () => {
      const recommendations = normalizeDeliverables(useDeliverables.getState().value).recommendations;
      return JSON.stringify(STEP_DEFS[step].todos.map((todo) => recommendations?.[`${audience}:${todo.id}`]?.draft ?? null));
    };
    const originalTasks = taskDrafts();
    const draftsUnchanged = () => {
      const current = useFieldDrafts.getState().value[`${audience}:${step}`];
      return (originalDraft ? sameFieldDraft(current, originalDraft, originalDraft.lang) : !current) && taskDrafts() === originalTasks;
    };
    const targetCurrent = () => useDeliverables.getState().scope === scope
      && useProjTransient.getState().draftStep === step
      && useSettings.getState().audience === audience
      && useSettings.getState().lang === lang;
    const gaps = fillOn ? findGaps(ctx, audience) : [];
    const fillReq = gaps.length ? fillRequest(ctx, lang, audience, gaps) : null;
    const firstInput = { step, ctx, lang, audience };
    const request = draftRequest(firstInput);
    const pf = preflight(request);
    const fillPf = fillReq ? preflight(fillReq) : null;
    if (!pf.allowed || (fillPf && !fillPf.allowed)) {
      setState({ status: 'error', message: [...new Set([...pf.reasons, ...(fillPf?.reasons ?? [])])].map((r) => t(reasonKey(r))).join(' ') });
      return;
    }
    if (!aiRequestFits(request, pf.context) || (fillReq && fillPf && !aiRequestFits(fillReq, fillPf.context))) {
      setState({ status: 'error', message: t('dlv.draft.tooLarge') });
      return;
    }
    setState({ status: 'working', stage: 'generate', activity: fillReq ? 'fill' : 'generate', startedAt: Date.now() });
    const controller = new AbortController();
    try {
      if (!targetCurrent()) return;
      if (!draftsUnchanged()) {
        setState({ status: 'error', message: t('dlv.draft.changed') });
        return;
      }
      abortRef.current = controller;
      setState({ status: 'working', stage: 'generate', activity: fillReq ? 'fill' : 'generate', startedAt: Date.now() });
      // Missing data first, so the deliverable text is written from the filled (and labelled) values.
      let proposals: FillProposal[] = [];
      let fillError: string | undefined;
      let input = firstInput;
      if (fillReq) {
        try {
          proposals = await requestFill(fillReq, gaps, ctx, audience, controller.signal);
          input = { ...firstInput, ctx: previewFillContext(ctx, proposals, new Date().toISOString()) };
        } catch (error) {
          if (controller.signal.aborted) throw error;
          proposals = [];
          fillError = t('dlv.fill.failed', { detail: error instanceof AiLiveError ? error.reasons.map((r) => t(reasonKey(r))).join(' ') || error.message : error instanceof Error ? error.message : String(error) });
        }
      }
      const r = await requestDeliverableDraft(input, input.ctx === ctx ? request : draftRequest(input), controller.signal, (progress) => {
        if (!controller.signal.aborted && targetCurrent()) setState({
          status: 'working', stage: 'generate', activity: progress.part ?? 'generate', startedAt: Date.now(),
          ...(progress.total > 1 ? { part: { current: progress.current, total: progress.total } } : {}), retry: progress.retry,
        });
      });
      if (targetCurrent()) {
        if (!draftsUnchanged()) {
          setState({ status: 'error', message: t('dlv.draft.changed') });
          return;
        }
        const at = new Date().toISOString();
        useDeliverables.getState().set((value) => {
          const data = normalizeDeliverables(value);
          const recommendations = { ...data.recommendations };
          for (const [id, text] of Object.entries(r.tasks)) {
            const key = `${audience}:${id}`;
            recommendations[key] = { ...recommendations[key], draft: { text, mock: r.response.mode === 'mock', at } };
          }
          return { ...data, recommendations };
        });
        useFieldDrafts.getState().set((value) => ({ ...value, [`${audience}:${step}`]: { fields: r.fields, lang, at, ...(proposals.length ? { fills: proposals } : {}) } }));
        setState({ status: 'ready', ...r, at, fills: proposals, ...(fillError ? { fillError } : {}) });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (targetCurrent()) setState({ status: 'cancelled' });
      } else if (targetCurrent()) {
        const message = error instanceof AiLiveError
          ? error.reasons.includes('liveFailed')
            ? t('dlv.draft.liveFailed', { detail: error.message })
            : error.reasons.map((r) => t(reasonKey(r))).join(' ')
          : error instanceof Error ? error.message : String(error);
        setState({ status: 'error', message });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  if (!step) return null;
  const doc = ctx.deliverables.docs[step] ?? {};
  const fields = STEP_DEFS[step].fields;
  const ready = state.status === 'ready' ? state : null;
  const draftChanged = !!ready && !sameFieldDraft(savedDraft, ready, lang);
  const willApply = ready ? fields.filter((f) => ready.fields[f.id] && (overwrite || !doc[f.id]?.text.trim())).length : 0;
  const simulation = ready ? evaluateStep(step, {
    ...ctx,
    deliverables: applyDraft(ctx.deliverables, step, ready.fields, { overwrite, mock: ready.response.mode === 'mock', at: new Date().toISOString() }).data,
  }) : [];
  const before = evaluateStep(step, ctx);
  const changes = simulation.filter((after, i) => after.todo.kind === 'auto' && after.done !== before[i]?.done);

  const apply = async () => {
    if (!ready || applying) return;
    if (!sameFieldDraft(useFieldDrafts.getState().value[`${audience}:${step}`], ready, lang)) {
      setState({ status: 'error', message: t('dlv.draft.changed') });
      return;
    }
    let filled = 0;
    let skipped = 0;
    if (ready.fills.length) {
      setApplying(true);
      setApplyError(null);
      try {
        // Against the data as it is now: a field filled meanwhile is skipped, never overwritten.
        const live = { ...ctx, pack: loaded, deliverables: normalizeDeliverables(useDeliverables.getState().value) };
        const plan = fillChanges(live, ready.fills, new Date().toISOString());
        await commitPackChanges(plan.changes, currentScope(), live.pack);
        useDeliverables.getState().set((v) => mergeFills(normalizeDeliverables(v), plan.fills));
        filled = Object.keys(plan.fills).length;
        skipped = plan.skipped.length;
      } catch (error) {
        setApplyError(t('dlv.fill.applyFailed', { detail: error instanceof Error ? error.message : String(error) }));
        return;
      } finally {
        setApplying(false);
      }
    }
    let count = 0;
    useDeliverables.getState().set((v) => {
      const r = applyDraft(normalizeDeliverables(v), step, ready.fields, { overwrite, mock: ready.response.mode === 'mock', at: new Date().toISOString() });
      count = r.applied.length;
      return r.data;
    });
    useFieldDrafts.getState().set((value) => {
      const key = `${audience}:${step}`;
      const saved = value[key];
      if (!sameFieldDraft(saved, ready, lang)) return value;
      const next = { ...value };
      delete next[key];
      return next;
    });
    closeDraft({ step, count, ...(ready.fills.length ? { filled, skipped } : {}) });
  };

  const discard = () => {
    if (!ready || !sameFieldDraft(useFieldDrafts.getState().value[`${audience}:${step}`], ready, lang)) {
      setState({ status: 'error', message: t('dlv.draft.changed') });
      return;
    }
    useFieldDrafts.getState().set((value) => {
      const next = { ...value };
      delete next[`${audience}:${step}`];
      return next;
    });
    setState({ status: 'idle' });
  };

  return (
    <>
    <Dialog open onOpenChange={(_, d) => { if (!d.open) close(); }}>
      <DialogSurface className="dlv-draft-surface" data-testid="dlv-draft-dialog">
        <DialogBody>
          <DialogTitle>{t('dlv.draft.title', { name: t(deliverableNameKey(step)) })}</DialogTitle>
          <DialogContent>
            {state.status === 'working' && <AiProgress stage={state.stage} activity={state.activity} startedAt={state.startedAt} limitMs={DELIVERABLE_DRAFT_TIMEOUT_MS}
              detail={[state.part ? t('ai.progress.part', state.part) : '', state.retry ? t('ai.progress.retry') : ''].filter(Boolean).join(' ')}
              testId="dlv-draft-progress" />}
            {state.status === 'cancelled' && <p role="status" data-testid="dlv-draft-cancelled">{t('ai.progress.cancelled')}</p>}
            {state.status === 'error' && <p role="alert">{t('dlv.draft.failed')} {state.message}</p>}
            {state.status !== 'working' && (
              <div className="dlv-fill-option">
                <Checkbox
                  checked={fillOn && missing > 0}
                  disabled={missing === 0}
                  onChange={(_, d) => setFillOn(d.checked === true)}
                  label={<span className="dlv-fill-option-label"><DatabaseSearch20Regular aria-hidden />{missing ? t('dlv.fill.option', { n: missing }) : t('dlv.fill.optionNone')}</span>}
                  data-testid="dlv-fill-toggle"
                />
                <Caption1 className="muted">{t('dlv.fill.optionHint')}</Caption1>
              </div>
            )}
            {(state.status === 'idle' || state.status === 'error' || state.status === 'cancelled') && <Button appearance="primary" onClick={() => void generate()} data-testid="dlv-draft-generate">{t('dlv.draft.generate')}</Button>}
            {ready && (
              <>
                <p className="dlv-draft-note" data-testid="dlv-draft-mode" data-mode={ready.response.mode}>
                  {ready.response.mode === 'mock' && <MockBadge />} {t(ready.response.mode === 'mock' ? 'dlv.draft.mockNote' : 'dlv.draft.liveNote')}
                </p>
                {ready.response.mode === 'live' && ready.response.usage && <TokensInline usage={ready.response.usage} testId="dlv-draft-tokens" />}
                <p className="muted">{t('dlv.draft.savedNote')}</p>
                <p className="muted">{t('dlv.draft.savedAt', { at: ready.at })}</p>
                {draftChanged && <p role="alert" data-testid="dlv-draft-changed">{t('dlv.draft.changed')}</p>}
                <Button onClick={() => void generate()} data-testid="dlv-draft-regenerate">{t('dlv.draft.regenerate')}</Button>
                <Caption1>{t('dlv.draft.grounding', { entities: draftEntities(ctx, audience).length })}</Caption1>
                {ready.fillError && <p role="alert" data-testid="dlv-fill-failed">{ready.fillError}</p>}
                {ready.fills.length > 0 && <FillProposalList proposals={ready.fills} />}
                <h3>{t('dlv.task.title')}</h3>
                <p>{t('dlv.task.note')}</p>
                <ul className="dlv-todo-list">
                  {before.map((r) => {
                    const item = ctx.deliverables.recommendations?.[`${audience}:${r.todo.id}`] ?? (audience === 'internal' ? ctx.deliverables.recommendations?.[r.todo.id] : undefined);
                    return (
                      <li key={r.todo.id} data-testid={`dlv-task-preview-${r.todo.id}`}>
                        <strong>{todoLabel(t, r.todo.id)}</strong>{' '}
                        {item?.draft && (
                          <>
                            <Badge appearance="outline">{t('dlv.task.draft')}</Badge>
                            <p className="proj-prewrap">{item.draft.text}</p>
                            <Refs refs={r.outcome?.refs ?? []} limit={Infinity} />
                            <Button size="small" onClick={() => approveTask(r.todo.id)} data-testid={`dlv-task-approve-${r.todo.id}`}>{t('dlv.task.approve')}</Button>
                          </>
                        )}
                        {!item?.draft && item?.approved && <Badge appearance="tint">{t('dlv.task.approved')}</Badge>}
                        {!item?.draft && !item?.approved && <p role="status">{t('dlv.task.missing')}</p>}
                      </li>
                    );
                  })}
                </ul>
                <h3>{t('dlv.task.simTitle')}</h3>
                <p>{t('dlv.task.simNote')}</p>
                {changes.length === 0 && <p>{t('dlv.task.simUnchanged')}</p>}
                <ul data-testid="dlv-task-simulation">
                  {changes.map((after) => (
                    <li key={after.todo.id}>{todoLabel(t, after.todo.id)}: {t(before.find((r) => r.todo.id === after.todo.id)?.done ? 'dlv.status.done' : 'dlv.status.todo')} → {t(after.done ? 'dlv.status.done' : 'dlv.status.todo')}</li>
                  ))}
                </ul>
                <a href={hrefFor('/deliverables', { step: 'solution', target: 'sol-sim' })} onClick={() => closeDraft()}>{t('dlv.task.simLink')}</a>
                <dl className="dlv-draft-fields">
                  {fields.map((f) => {
                    const text = ready.fields[f.id];
                    const kept = !overwrite && !!doc[f.id]?.text.trim();
                    return (
                      <div key={f.id} className="dlv-draft-field" data-testid={`dlv-draft-field-${f.id}`}>
                        <dt>{t(fieldKey(step, f.id))}</dt>
                        <dd>
                          {kept && <Caption1 className="dlv-kept">{t('dlv.draft.keep')}</Caption1>}
                          <pre className="dlv-pre">{text ?? '—'}</pre>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                <Checkbox checked={overwrite} onChange={(_, d) => setOverwrite(d.checked === true)} label={t('dlv.draft.overwrite')} />
                {willApply === 0 && !ready.fills.length && <p role="status">{t('dlv.draft.none')}</p>}
                {applyError && <p role="alert" data-testid="dlv-fill-apply-error">{applyError}</p>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {state.status === 'working' && state.stage === 'generate'
              ? <Button onClick={cancel} data-testid="dlv-draft-cancel">{t('ai.progress.cancel')}</Button>
              : <Button appearance="primary" disabled={!ready || draftChanged || applying || (willApply === 0 && !ready.fills.length)} onClick={() => void apply()} data-testid="dlv-draft-apply">{t('dlv.draft.apply')}</Button>}
            {ready && <Button disabled={draftChanged} onClick={discard} data-testid="dlv-draft-discard">{t('dlv.draft.discard')}</Button>}
            <Button appearance="secondary" onClick={close}>{t('dlv.draft.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
    </>
  );
}
