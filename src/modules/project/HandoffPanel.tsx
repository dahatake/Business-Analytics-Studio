import { useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { ArrowRight20Regular, CheckmarkCircle20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { PARAMS } from '../../config/params.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { IMPROVEMENT_STEPS, useProjects, type ImprovementStep } from '../../state/projects.ts';
import { hrefFor, navigate } from '../../state/router.ts';
import { Panel } from '../../ui/Panel.tsx';
import { ScrollRegion } from './common.tsx';
import { fieldKey, normalizeDeliverables, type AppCheckContext, type HandoffItem } from './deliverables.ts';
import { todayIn } from './deliverablesUi.tsx';
import { clearHandoff, confirmHandoff, handoffView, HandoffError, inheritedItems, type ItemChange } from './handoff.ts';
import { sectionKey } from './solutionDocs.ts';
import { useDeliverables, useProjUi } from './stores.ts';

const CHANGE_COLOR: Record<ItemChange, 'success' | 'warning' | 'danger' | 'informative'> = { same: 'success', changed: 'warning', removed: 'danger', added: 'informative' };
const MAX_ROWS = 12;

function ItemLabel({ item }: { item: HandoffItem }) {
  const { t } = useI18n();
  if (item.kind === 'field') {
    const [step = '', id = ''] = item.id.slice('field:'.length).split('.');
    return <>{t(fieldKey(step as ImprovementStep, id))}</>;
  }
  if (item.kind === 'section') return <>{t(sectionKey(item.label))}</>;
  return <>{item.label}</>;
}

function ItemRows({ items, testId }: { items: (HandoffItem & { change: ItemChange })[]; testId: string }) {
  const { t } = useI18n();
  const shown = items.slice(0, MAX_ROWS);
  return (
    <ScrollRegion label={t('dlv.handoff.items')}>
      <table className="data-table compact" data-testid={testId}>
        <caption className="visually-hidden">{t('dlv.handoff.items')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dlv.handoff.kind')}</th>
            <th scope="col">{t('dlv.handoff.item')}</th>
            <th scope="col">{t('dlv.handoff.state')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((i) => (
            <tr key={i.id} data-change={i.change}>
              <td>{t(`dlv.handoff.kind.${i.kind}` as MessageKey)}</td>
              <th scope="row"><ItemLabel item={i} /></th>
              <td><Badge size="small" appearance="tint" color={CHANGE_COLOR[i.change]}>{t(`dlv.handoff.change.${i.change}` as MessageKey)}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > MAX_ROWS && <p className="muted">{t('dlv.more', { n: items.length - MAX_ROWS })}</p>}
    </ScrollRegion>
  );
}

/**
 * Formal progression: the previous step's confirmed items are this step's inputs, and the user confirms this step
 * (all ToDos done, previous step current) to hand its items on. Viewing any step stays possible without confirming.
 */
export function HandoffPanel({ ctx, step }: { ctx: AppCheckContext; step: ImprovementStep }) {
  const { t, lang, fmt } = useI18n();
  const setStep = useProjects((s) => s.setStep);
  const [error, setError] = useState<string | null>(null);
  const view = handoffView(step, ctx, lang);
  const inherited = inheritedItems(step, ctx, lang);
  const index = IMPROVEMENT_STEPS.indexOf(step);
  const next = IMPROVEMENT_STEPS[index + 1];
  const date = (at: string) => fmt.date(todayIn(PARAMS.timeZone, new Date(at)));
  const changedInherited = inherited.items.filter((i) => i.change !== 'same').length;

  const confirm = () => {
    try {
      const by = useProjUi.getState().editor.trim();
      useDeliverables.getState().set((v) => confirmHandoff(normalizeDeliverables(v), step, ctx, lang, by, new Date().toISOString()));
      setError(null);
      if (next) {
        setStep(next);
        navigate(hrefFor('/step', { step: next }));
      }
    } catch (e) {
      setError(e instanceof HandoffError ? t(`dlv.handoff.blocked.${e.code}`) : e instanceof Error ? e.message : String(e));
    }
  };
  const undo = () => useDeliverables.getState().set((v) => clearHandoff(normalizeDeliverables(v), step));

  return (
    <Panel title={t('dlv.handoff.title')} className="span-full" testId="step-handoff" id="step-handoff">
      <p className="muted">{t('dlv.handoff.intro')}</p>
      {inherited.from && (
        <section aria-label={t('dlv.handoff.inherited')} data-testid="step-handoff-inherited">
          <h3 className="proj-h3">{t('dlv.handoff.inheritedFrom', { step: t(`proj.step.${inherited.from}`) })}</h3>
          {!inherited.record
            ? (
              <p data-testid="step-handoff-noinput">
                {t('dlv.handoff.noUpstream')}{' '}
                <a href={hrefFor('/step', { step: inherited.from, view: 'details' })}>{t('dlv.handoff.openUpstream', { step: t(`proj.step.${inherited.from}`) })}</a>
              </p>
            )
            : (
              <>
                <p className="muted">
                  {inherited.record.by
                    ? t('dlv.handoff.confirmedBy', { date: date(inherited.record.at), by: inherited.record.by })
                    : t('dlv.handoff.confirmedAnon', { date: date(inherited.record.at) })}
                  {' '}{t('dlv.handoff.inheritedCount', { n: inherited.items.filter((i) => i.change !== 'added').length })}
                </p>
                {changedInherited > 0 && <p role="alert" data-testid="step-handoff-upstream-changed">{t('dlv.handoff.upstreamEdited', { n: changedInherited })}</p>}
                {inherited.items.length === 0 ? <p className="muted">{t('dlv.handoff.noItems')}</p> : <ItemRows items={inherited.items} testId="step-handoff-inherited-items" />}
              </>
            )}
        </section>
      )}
      <section aria-label={t('dlv.handoff.this')}>
        <h3 className="proj-h3">{t('dlv.handoff.this')}</h3>
        <p>
          <Badge
            appearance="filled"
            color={view.status === 'current' ? 'success' : view.status === 'stale' ? 'warning' : 'informative'}
            data-testid="step-handoff-status"
            data-status={view.status}
          >
            {t(`dlv.handoff.status.${view.status}`)}
          </Badge>{' '}
          <span data-testid="step-handoff-todos">{t('dlv.handoff.todos', { done: view.todos.done, total: view.todos.total })}</span>
        </p>
        {view.record && (
          <p className="muted">
            {view.record.by
              ? t('dlv.handoff.confirmedBy', { date: date(view.record.at), by: view.record.by })
              : t('dlv.handoff.confirmedAnon', { date: date(view.record.at) })}
          </p>
        )}
        {view.status === 'stale' && (
          <MessageBar intent="warning" data-testid="step-handoff-stale">
            <MessageBarBody>
              {view.upstreamChanged && <span>{t('dlv.handoff.staleUpstream')} </span>}
              {view.changes.length > 0 && <span>{t('dlv.handoff.staleItems', { n: view.changes.length })} </span>}
              {!view.todos.complete && <span>{t('dlv.handoff.staleTodos')}</span>}
            </MessageBarBody>
          </MessageBar>
        )}
        {view.changes.length > 0 && <ItemRows items={view.changes} testId="step-handoff-changes" />}
        {view.blocker && <p data-testid="step-handoff-blocker">{t(`dlv.handoff.blocked.${view.blocker}`)}</p>}
        <div className="proj-row">
          <Button
            appearance="primary"
            icon={next ? <ArrowRight20Regular /> : <CheckmarkCircle20Regular />}
            disabled={!!view.blocker || view.status === 'current'}
            onClick={confirm}
            data-testid="step-handoff-confirm"
          >
            {next
              ? t(view.record ? 'dlv.handoff.reconfirmNext' : 'dlv.handoff.confirmNext', { step: t(`proj.step.${next}`) })
              : t(view.record ? 'dlv.handoff.reconfirmLast' : 'dlv.handoff.confirmLast')}
          </Button>
          {view.record && <Button icon={<Dismiss20Regular />} onClick={undo} data-testid="step-handoff-undo">{t('dlv.handoff.undo')}</Button>}
          {view.status === 'current' && next && <a href={hrefFor('/step', { step: next, view: 'details' })}>{t('dlv.handoff.goNext', { step: t(`proj.step.${next}`) })}</a>}
        </div>
        {error && <p role="alert">{error}</p>}
      </section>
    </Panel>
  );
}
