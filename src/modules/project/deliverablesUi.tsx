import { useEffect, useId, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, ProgressBar, Spinner,
} from '@fluentui/react-components';
import {
  CheckmarkCircle20Filled, ChevronDown20Regular, ChevronUp20Regular, DocumentText20Regular, ErrorCircle20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import type { AiResponse } from '../../ai/client.ts';
import { PARAMS } from '../../config/params.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { IMPROVEMENT_STEPS, useActiveProject, useProjects, type ImprovementStep } from '../../state/projects.ts';
import { hrefFor, revisitRouteTarget } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { useUseCases } from '../usecases/store.ts';
import { MockBadge } from './common.tsx';
import { draftEntities, requestDeliverableDraft } from './deliverableDraft.ts';
import {
  applyDraft, evaluateStep, fieldKey, nextTodo, normalizeDeliverables, openFirst, PAYBACK_MAX_YEARS, paybackLimit, progressOf, resultKey, setSignOff, STEP_DEFS, todoKey, todoWhyKey,
  type CheckContext, type CheckRef, type TodoResult,
} from './deliverables.ts';
import { useAnalyses, useDeliverables, useDiscussion, useProjTransient, useProjUi, useScopeKpis } from './stores.ts';
import './project.css';

/** YYYY-MM-DD in the app's time zone. The demo is judged on the sample's "as of" date so it stays deterministic. */
export function todayIn(timeZone: string = PARAMS.timeZone, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function useCheckContext(): CheckContext {
  const discussion = useDiscussion((s) => s.value);
  const kpi = useScopeKpis();
  const analysis = useAnalyses((s) => s.value);
  const useCases = useUseCases((s) => s.value);
  const raw = useDeliverables((s) => s.value);
  const isDemo = useProjects((s) => s.target.kind === 'demo');
  return useMemo(() => ({
    pack: loaded, discussion, kpi, analysis, useCases, deliverables: normalizeDeliverables(raw), today: isDemo ? PARAMS.asOfDate : todayIn(),
  }), [discussion, kpi, analysis, useCases, raw, isDemo]);
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
export function todoHref(r: TodoResult): string {
  const [path = '/', query = ''] = r.todo.href.split('?');
  const q = new URLSearchParams(query);
  const field = r.outcome?.refs?.find((ref) => ref.type === 'field');
  if (field?.type === 'field') {
    return hrefFor('/deliverables', { step: field.step, target: `dlv-field-${field.id}` });
  }
  if (r.todo.kind === 'manual') {
    q.set('target', `dlv-sign-${r.todo.id}`);
  } else if (path === '/deliverables') {
    q.set('target', 'dlv-fields');
  } else if (path === '/analysis') {
    if (q.get('tab') === 'kpi') q.set('target', r.todo.id === 'kpi-okr' ? 'proj-okr-panel' : 'proj-kpi-panel');
    else q.set('target', 'proj-method-panel');
  } else if (path === '/relations') {
    q.set('view', 'table');
    q.set('target', 'relation-table');
  } else if (path === '/discussion') {
    q.set('target', r.outcome?.code === 'noThemes' ? 'proj-tree' : 'proj-canvas');
  } else if (path === '/usecases') {
    q.set('target', 'uc-list');
  } else if (path === '/plan') {
    q.set('target', r.todo.id === 'plan-schedule' ? 'gantt-panel' : 'plan-table');
  }
  return hrefFor(path, q);
}

function Refs({ refs }: { refs: CheckRef[] }) {
  const { t, lang } = useI18n();
  if (refs.length === 0) return null;
  const shown = refs.slice(0, MAX_REFS);
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
      {refs.length > MAX_REFS && <li className="muted">{t('dlv.more', { n: refs.length - MAX_REFS })}</li>}
    </ul>
  );
}

/** One exit criterion: auto-checked (verdict + evidence + where to fix it) or a person's sign-off (checkbox). */
export function TodoItem({ r, detailed = false }: { r: TodoResult; detailed?: boolean }) {
  const { t, fmt } = useI18n();
  const checkboxId = useId();
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
      {detailed && r.outcome && !r.outcome.ok && <Refs refs={r.outcome.refs ?? []} />}
      {!r.done && r.todo.kind === 'auto' && (
        <a className="dlv-fix" href={todoHref(r)} onClick={revisitRouteTarget} aria-label={t('dlv.fixLabel', { todo: label })}>
          {t('dlv.fix')}
        </a>
      )}
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
  const openDraft = useProjTransient((s) => s.openDraft);
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
        <span className="visually-hidden" role="status">{applied ? t('dlv.draft.applied', { n: applied.count }) : ''}</span>
        <div className="dlv-band-actions">
          <Button appearance="primary" icon={<Sparkle20Regular />} onClick={() => openDraft(step)} data-testid="dlv-draft">{t('dlv.draft.button')}</Button>
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
      </div>
      <div id={listId} ref={setList} className="dlv-band-scroll" hidden={collapsed} tabIndex={collapsed ? undefined : 0} role="region" aria-label={t('dlv.band.list', { step: stepName })}>
        <ul className="dlv-band-list">
          {openFirst(results).map((r) => <TodoItem key={r.todo.id} r={r} />)}
        </ul>
      </div>
    </section>
  );
}

type DraftState =
  | { status: 'working' }
  | { status: 'ready'; response: AiResponse; fields: Record<string, string> }
  | { status: 'error' };

/** "Draft with Copilot": preview the draft, then fill the deliverable (empty fields only unless the user says so). */
export function DraftDialog() {
  const { t, lang } = useI18n();
  const step = useProjTransient((s) => s.draftStep);
  const closeDraft = useProjTransient((s) => s.closeDraft);
  const audience = useSettings((s) => s.audience);
  const ctx = useCheckContext();
  const [state, setState] = useState<DraftState>({ status: 'working' });
  const [overwrite, setOverwrite] = useState(false);

  useEffect(() => {
    if (!step) return;
    let alive = true;
    setState({ status: 'working' });
    setOverwrite(false);
    requestDeliverableDraft({ step, ctx, lang, audience })
      .then((r) => { if (alive) setState({ status: 'ready', ...r }); })
      .catch(() => { if (alive) setState({ status: 'error' }); });
    return () => { alive = false; };
    // The draft is made once per opening, from the data at that moment.
  }, [step]);

  if (!step) return null;
  const doc = ctx.deliverables.docs[step] ?? {};
  const fields = STEP_DEFS[step].fields;
  const ready = state.status === 'ready' ? state : null;
  const willApply = ready ? fields.filter((f) => ready.fields[f.id] && (overwrite || !doc[f.id]?.text.trim())).length : 0;

  const apply = () => {
    if (!ready) return;
    let count = 0;
    useDeliverables.getState().set((v) => {
      const r = applyDraft(normalizeDeliverables(v), step, ready.fields, { overwrite, mock: ready.response.mode === 'mock', at: new Date().toISOString() });
      count = r.applied.length;
      return r.data;
    });
    closeDraft({ step, count });
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) closeDraft(); }}>
      <DialogSurface className="dlv-draft-surface" data-testid="dlv-draft-dialog">
        <DialogBody>
          <DialogTitle>{t('dlv.draft.title', { name: t(deliverableNameKey(step)) })}</DialogTitle>
          <DialogContent>
            {state.status === 'working' && <Spinner label={t('dlv.draft.working')} />}
            {state.status === 'error' && <p role="alert">{t('dlv.draft.failed')}</p>}
            {ready && (
              <>
                <p className="dlv-draft-note" data-testid="dlv-draft-mode" data-mode={ready.response.mode}>
                  {ready.response.mode === 'mock' && <MockBadge />} {t(ready.response.mode === 'mock' ? 'dlv.draft.mockNote' : 'dlv.draft.liveNote')}
                </p>
                <Caption1>{t('dlv.draft.grounding', { entities: draftEntities(ctx).length })}</Caption1>
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
                {willApply === 0 && <p role="status">{t('dlv.draft.none')}</p>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={!ready || willApply === 0} onClick={apply} data-testid="dlv-draft-apply">{t('dlv.draft.apply')}</Button>
            <Button appearance="secondary" onClick={() => closeDraft()}>{t('dlv.draft.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
