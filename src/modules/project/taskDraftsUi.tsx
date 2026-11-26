import { useMemo, useState, type ReactElement } from 'react';
import { Badge, Button, Caption1 } from '@fluentui/react-components';
import { CheckmarkCircle16Filled, DocumentCheckmark16Regular, Person16Regular, Ruler16Regular, Sparkle16Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { PAYBACK_MAX_YEARS, resultKey, todoKey, type CheckContext, type TodoResult } from './deliverables.ts';
import { useProjTransient } from './stores.ts';
import { approveTaskDrafts, TaskApprovalError } from './taskDraftCommit.ts';
import {
  DATA_STATES, draftLines, normalizeTaskDrafts, taskDraftKey, taskStatuses, useTaskDrafts, type DataState, type TaskDraft, type TaskStatus,
} from './taskDrafts.ts';

/**
 * One vocabulary for where a value comes from, used on every component (Microsoft "UX design for agents": certainty and
 * reasoning visible, consistent; Fluent 2: never colour alone). Each state has its own icon and label; colour only reinforces.
 */
const ICONS: Record<DataState, ReactElement> = {
  evidence: <DocumentCheckmark16Regular />,
  estimate: <Sparkle16Regular />,
  provisional: <Ruler16Regular />,
  human: <Person16Regular />,
  confirmed: <CheckmarkCircle16Filled />,
};
const COLORS = { evidence: 'informative', estimate: 'brand', provisional: 'warning', human: 'subtle', confirmed: 'success' } as const;

export function DataStateBadge({ state, count, testId }: { state: DataState; count?: number; testId?: string }) {
  const { t } = useI18n();
  const label = t(`dlv.state.${state}` as MessageKey);
  return (
    <Badge size="medium" appearance="tint" color={COLORS[state]} icon={ICONS[state]} className={`dlv-state dlv-state-${state}`}
      title={t(`dlv.state.${state}.desc` as MessageKey)} data-testid={testId} data-state={state}>
      {count === undefined ? label : t('dlv.state.count', { label, n: count })}
    </Badge>
  );
}

/** The legend of the five states (shown wherever drafts are reviewed). */
export function DataStateLegend() {
  const { t } = useI18n();
  return (
    <dl className="dlv-state-legend" aria-label={t('dlv.state.legend')} data-testid="dlv-state-legend">
      {DATA_STATES.map((state) => (
        <div key={state}>
          <dt><DataStateBadge state={state} /></dt>
          <dd>{t(`dlv.state.${state}.desc` as MessageKey)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** How many values of a draft are in each state, as compact badges. */
export function DraftStateCounts({ draft, ctx, testId }: { draft: TaskDraft; ctx: CheckContext; testId?: string }) {
  const { lang } = useI18n();
  const counts = useMemo(() => {
    const out = new Map<DataState, number>();
    for (const line of draftLines(draft, ctx, lang)) out.set(line.state, (out.get(line.state) ?? 0) + 1);
    return out;
  }, [draft, ctx, lang]);
  return (
    <span className="dlv-state-counts" data-testid={testId}>
      {DATA_STATES.filter((s) => counts.has(s)).map((s) => <DataStateBadge key={s} state={s} count={counts.get(s)} />)}
    </span>
  );
}

type Statuses = Map<string, TaskStatus>;
type Drafts = Record<string, TaskDraft>;
type Shared = { ctx: CheckContext; raw: unknown; audience: string; drafts: Drafts; statuses: Statuses };
type TaskView = Pick<Shared, 'drafts' | 'statuses'>;
let shared: Shared | undefined;

/** Every task's draft status (one replay per data state, shared by all cards). */
export function useTaskStatuses(ctx: CheckContext): TaskView {
  const raw = useTaskDrafts((s) => s.value);
  const audience = useSettings((s) => s.audience);
  return useMemo(() => {
    if (shared && shared.ctx === ctx && shared.raw === raw && shared.audience === audience) return shared;
    const drafts = normalizeTaskDrafts(raw);
    shared = { ctx, raw, audience, drafts, statuses: taskStatuses(ctx, drafts, audience) };
    return shared;
  }, [ctx, raw, audience]);
}

export function approvalError(t: (k: MessageKey, v?: Record<string, string | number>) => string, value: unknown): string {
  if (value instanceof TaskApprovalError) {
    if (value.code === 'regress') return t('dlv.td.error.regress', { todos: value.detail.split(', ').map((id) => t(todoKey(id), { max: PAYBACK_MAX_YEARS })).join(', ') });
    return t(`dlv.td.error.${value.code}` as MessageKey);
  }
  return t('dlv.td.error.other', { detail: value instanceof Error ? value.message : String(value) });
}

/** The draft state of one task card: what approving its draft does, with approve and review buttons. */
export function TaskDraftLine({ r, ctx }: { r: TodoResult; ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const { drafts, statuses } = useTaskStatuses(ctx);
  const openTaskDraft = useProjTransient((s) => s.openTaskDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = statuses.get(r.todo.id);
  const draft = drafts[taskDraftKey(audience, r.todo.id)];
  const label = (id: string) => t(todoKey(id), { max: PAYBACK_MAX_YEARS });
  if (!status || status.state === 'none') return null;
  if (status.state === 'done') {
    return r.done ? <DataStateBadge state="confirmed" testId={`dlv-td-state-${r.todo.id}`} /> : null;
  }
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await approveTaskDrafts([r.todo.id], ctx, audience, lang);
    } catch (value) {
      setError(approvalError(t, value));
    } finally {
      setBusy(false);
    }
  };
  const caption = status.state === 'ready' ? t(status.requires.length ? 'dlv.td.readyWith' : 'dlv.td.ready', { n: status.requires.length })
    : status.state === 'viaOther' ? t('dlv.td.viaOther', { todo: label(status.by!) })
      : status.state === 'invalid' ? t('dlv.td.invalid')
        : t('dlv.td.open', { reason: status.outcome ? t(resultKey(status.outcome.code), status.outcome.vars) : '' });
  return (
    <div className="dlv-td" data-testid={`dlv-td-${r.todo.id}`} data-state={status.state}>
      {draft && <DraftStateCounts draft={draft} ctx={ctx} testId={`dlv-td-counts-${r.todo.id}`} />}
      <Caption1 className="dlv-td-caption" data-testid={`dlv-td-caption-${r.todo.id}`}>{caption}</Caption1>
      <div className="dlv-td-actions">
        {(status.state === 'ready' || status.state === 'open') && (
          <Button size="small" appearance="primary" disabled={busy} onClick={() => void approve()} aria-label={t('dlv.td.approveLabel', { todo: label(r.todo.id) })} data-testid={`dlv-td-approve-${r.todo.id}`}>
            {t('dlv.td.approve')}
          </Button>
        )}
        <Button size="small" disabled={busy} onClick={() => openTaskDraft(status.state === 'viaOther' ? status.by! : r.todo.id)}
          aria-label={t('dlv.td.reviewLabel', { todo: label(status.state === 'viaOther' ? status.by! : r.todo.id) })} data-testid={`dlv-td-review-${r.todo.id}`}>
          {t(status.state === 'viaOther' ? 'dlv.td.reviewOther' : 'dlv.td.review')}
        </Button>
      </div>
      {error && <p role="alert" className="dlv-td-error" data-testid={`dlv-td-error-${r.todo.id}`}>{error}</p>}
    </div>
  );
}
