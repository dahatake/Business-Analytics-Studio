import { useState } from 'react';
import {
  Badge, Button, DrawerBody, DrawerFooter, DrawerHeader, DrawerHeaderTitle, Field, MessageBar, MessageBarBody, OverlayDrawer, Spinner, Textarea,
} from '@fluentui/react-components';
import { ArrowUndo20Regular, Delete20Regular, Dismiss24Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { aiComplete, readLedger } from '../../ai/client.ts';
import { useI18n } from '../../i18n/index.ts';
import { useRoute } from '../../state/router.ts';
import { MockNotice, usePersonConfirm } from './AiCommon.tsx';
import { componentsForRoute, entitiesOfComponents } from './explain.ts';
import { usageSummary } from './ledger.ts';
import { commitApply, overrideKey, parseProposals, reviewPrompt, undoLastApply, useAiOverrides, type Proposal } from './review.ts';
import { isConfigured, useAiSettings } from './settingsStore.ts';
import { useAiPanels } from './uiStore.ts';

type Notice =
  | { kind: 'applied'; count: number }
  | { kind: 'undone' }
  | { kind: 'applyFailed'; reason: 'nothing' | 'empty' }
  | { kind: 'runFailed' }
  | { kind: 'cancelled' };

/** FR-278〜FR-281, FR-283, NFR-COST-001: "Copilot で分析実行" panel. */
export function ReviewPanel() {
  const { t, lang, fmt } = useI18n();
  const open = useAiPanels((s) => s.open === 'review');
  const setOpen = useAiPanels((s) => s.setOpen);
  const route = useRoute();
  const settings = useAiSettings();
  const configured = isConfigured(settings);
  const overrides = useAiOverrides((s) => s.value);
  const { dialog, confirm } = usePersonConfirm();
  const [running, setRunning] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  const components = componentsForRoute(route.path);
  const usage = usageSummary(readLedger(), new Date(), settings.monthlyBudgetJpy);

  const run = async () => {
    setNotice(null);
    const entities = entitiesOfComponents(components);
    if (!(await confirm(entities, t('ai.scope.screen', { path: route.path })))) {
      setNotice({ kind: 'cancelled' });
      return;
    }
    setRunning(true);
    try {
      const res = await aiComplete({ use: 'review', lang, prompt: reviewPrompt(lang, route.path, components), entities, personConfirmed: true });
      const parsed = parseProposals(res.text, components);
      setReasons(res.blockedReasons);
      if (!parsed) setNotice({ kind: 'runFailed' });
      setProposals(parsed);
    } catch {
      setNotice({ kind: 'runFailed' });
    } finally {
      setRunning(false);
    }
  };

  const update = (id: string, patch: Partial<Proposal>) =>
    setProposals((ps) => ps?.map((p) => (p.componentId === id ? { ...p, ...patch } : p)) ?? null);

  const apply = () => {
    if (!proposals) return;
    const r = commitApply(route.path, proposals);
    if (!r.ok) return setNotice({ kind: 'applyFailed', reason: r.reason });
    setProposals(proposals.map((p) => (r.appliedIds.includes(p.componentId) ? { ...p, status: 'applied' } : p)));
    setNotice({ kind: 'applied', count: r.appliedIds.length });
  };

  const undo = () => {
    if (!undoLastApply()) return;
    // §3.4: undoing an apply returns the proposals to "editing".
    setProposals((ps) => ps?.map((p) => (p.status === 'applied' ? { ...p, status: 'editing' } : p)) ?? null);
    setNotice({ kind: 'undone' });
  };

  const applied = components.filter((c) => overrides.overrides[overrideKey(route.path, c.id)]);
  const monthStop = usage.monthLevel === 'stop';

  return (
    <>
      <OverlayDrawer
        open={open}
        position="end"
        size="large"
        aria-label={t('ai.review.title')}
        onOpenChange={(_, d) => setOpen(d.open ? 'review' : null)}
        data-testid="ai-review-panel"
      >
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('ai.close')} icon={<Dismiss24Regular />} onClick={() => setOpen(null)} />}>
            {t('ai.review.title')}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className="ai-stack">
            <p className="muted">{t('ai.review.lead', { count: components.length })}</p>
            <p className="ai-status">
              <span data-testid="ai-review-budget">{t('ai.review.budget', { spent: fmt.yen(usage.monthSpentJpy), budget: fmt.yen(usage.monthBudgetJpy) })}</span>
              {usage.monthLevel !== 'ok' && <Badge appearance="tint" color={monthStop ? 'danger' : 'warning'}>{t(`ai.level.${usage.monthLevel}`)}</Badge>}
            </p>
            {!configured && <MessageBar intent="info"><MessageBarBody>{t('ai.review.notConfigured')}</MessageBarBody></MessageBar>}
            <div>
              <Button appearance="primary" icon={<Sparkle20Regular />} onClick={() => void run()} disabled={running} data-testid="ai-review-run">
                {proposals ? t('ai.review.rerun') : t('ai.review.run')}
              </Button>
            </div>
            {running && <Spinner size="tiny" label={t('ai.loading')} />}
            {notice && (
              <MessageBar intent={notice.kind === 'applied' || notice.kind === 'undone' ? 'success' : notice.kind === 'cancelled' ? 'info' : 'error'} role="status" data-testid="ai-review-notice">
                <MessageBarBody>
                  {notice.kind === 'applied' && t('ai.review.applied', { count: notice.count })}
                  {notice.kind === 'undone' && t('ai.review.undone')}
                  {notice.kind === 'applyFailed' && t(notice.reason === 'empty' ? 'ai.review.applyEmpty' : 'ai.review.applyNothing')}
                  {notice.kind === 'runFailed' && t('ai.review.runFailed')}
                  {notice.kind === 'cancelled' && t('ai.person.cancelled')}
                </MessageBarBody>
              </MessageBar>
            )}
            {proposals && (
              <MockNotice reasons={reasons}>
                <p className="muted">{configured ? t('ai.review.mockRan') : t('ai.review.mockRanNotConfigured')}</p>
              </MockNotice>
            )}
            {proposals?.map((p) => (
              <section key={p.componentId} className="ai-proposal" aria-labelledby={`ai-prop-${p.componentId}`} data-testid={`ai-proposal-${p.componentId}`} data-status={p.status}>
                <div className="ai-proposal-head">
                  <h3 id={`ai-prop-${p.componentId}`} className="ai-h3">{t(p.label)}</h3>
                  <Badge appearance="outline">{t(`ai.proposal.${p.status}`)}</Badge>
                </div>
                {p.status === 'discarded' ? (
                  <Button size="small" onClick={() => update(p.componentId, { status: 'proposed', text: p.original })}>{t('ai.review.restore')}</Button>
                ) : (
                  <>
                    <Field label={t('ai.review.proposalLabel')}>
                      <Textarea
                        value={p.text}
                        resize="vertical"
                        disabled={p.status === 'applied'}
                        onChange={(_, d) => update(p.componentId, { text: d.value, status: 'editing' })}
                      />
                    </Field>
                    {p.status !== 'applied' && (
                      <Button size="small" icon={<Delete20Regular />} onClick={() => update(p.componentId, { status: 'discarded' })}>{t('ai.review.discard')}</Button>
                    )}
                  </>
                )}
              </section>
            ))}
            {applied.length > 0 && (
              <section aria-labelledby="ai-applied-title" data-testid="ai-applied">
                <h3 id="ai-applied-title" className="ai-h3">{t('ai.review.appliedTitle')}</h3>
                <ul className="ai-applied-list">
                  {applied.map((c) => (
                    <li key={c.id}><strong>{t(c.label)}</strong>{t('ai.colon')}{overrides.overrides[overrideKey(route.path, c.id)]!.text}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button appearance="primary" onClick={apply} disabled={!proposals || proposals.every((p) => p.status === 'discarded' || p.status === 'applied')} data-testid="ai-review-apply">
            {t('ai.review.apply')}
          </Button>
          <Button icon={<ArrowUndo20Regular />} onClick={undo} disabled={overrides.undo.length === 0} data-testid="ai-review-undo">
            {t('ai.review.undo')}
          </Button>
        </DrawerFooter>
      </OverlayDrawer>
      {dialog}
    </>
  );
}
