import { useEffect, useState } from 'react';
import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { ArrowUndo20Regular, Dismiss20Regular, Lightbulb20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { useRoute } from '../../state/router.ts';
import './mocks.ts';
import './liveTransport.ts';
import { componentsForRoute } from './explain.ts';
import { appliedForRoute, undoLastApply, useAiOverrides } from './review.ts';
import { useAiSettings } from './settingsStore.ts';
import { useAiPanels } from './uiStore.ts';
import { ExplainPanel } from './ExplainPanel.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import './ai.css';

/** Global mounts of the 'ai' module: top-bar buttons for FR-274 and FR-278, and their side panels. */
export function TopBarSlot() {
  const { t } = useI18n();
  const open = useAiPanels((s) => s.open);
  const setOpen = useAiPanels((s) => s.setOpen);
  return (
    <>
      <Button appearance="subtle" icon={<Lightbulb20Regular />} aria-pressed={open === 'explain'} onClick={() => setOpen(open === 'explain' ? null : 'explain')} data-testid="ai-explain-button">
        {t('ai.explain.button')}
      </Button>
      <Button appearance="subtle" icon={<Sparkle20Regular />} aria-pressed={open === 'review'} onClick={() => setOpen(open === 'review' ? null : 'review')} data-testid="ai-review-button">
        {t('ai.review.button')}
      </Button>
    </>
  );
}

/** D-4: while live mode is on, a dismissible app-level reminder that rights and contracts are assumed settled. */
function LiveBanner() {
  const { t } = useI18n();
  const liveEnabled = useAiSettings((s) => s.liveEnabled);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!liveEnabled) setDismissed(false);
  }, [liveEnabled]);
  if (!liveEnabled || dismissed) return null;
  return (
    <MessageBar intent="warning" layout="multiline" data-testid="ai-d4-banner">
      <MessageBarBody>
        <MessageBarTitle>{t('ai.d4.bannerTitle')}</MessageBarTitle>
        {t('ai.d4.body')}
      </MessageBarBody>
      <MessageBarActions containerAction={<Button appearance="transparent" aria-label={t('ai.d4.dismiss')} icon={<Dismiss20Regular />} onClick={() => setDismissed(true)} />} />
    </MessageBar>
  );
}

/**
 * I-2: applied "Copilot proposals" are shown on the screen they target as a marker plus a before → after diff. Pack
 * values are never replaced (FR-050, FR-115/116).
 */
function AppliedNotice() {
  const { t, fmt } = useI18n();
  const route = useRoute();
  const overrides = useAiOverrides((s) => s.value);
  const diffs = appliedForRoute(overrides, route.path);
  if (diffs.length === 0) return null;
  const labels = new Map(componentsForRoute(route.path).map((c) => [c.id, c.label]));
  return (
    <section className="ai-applied-notice" aria-labelledby="ai-applied-notice-title" data-testid="ai-applied-notice">
      <div className="ai-status">
        <h2 id="ai-applied-notice-title" className="ai-h3">{t('ai.applied.title', { count: diffs.length })}</h2>
        <Button size="small" icon={<ArrowUndo20Regular />} onClick={() => undoLastApply()} disabled={overrides.undo.length === 0} data-testid="ai-applied-undo">
          {t('ai.review.undo')}
        </Button>
      </div>
      <details>
        <summary>{t('ai.applied.toggle')}</summary>
        <ul className="ai-applied-list" data-testid="ai-applied-diff">
          {diffs.map((d) => {
            const label = labels.get(d.componentId);
            return (
              <li key={d.componentId} data-component={d.componentId}>
                <strong>{label ? t(label) : d.componentId}</strong>
                <span className="muted">{t('ai.applied.at', { date: fmt.date(d.appliedAt.slice(0, 10)) })}</span>
                <div className="ai-diff">
                  <del className="ai-diff-before"><span className="visually-hidden">{t('ai.applied.before')}</span>{d.before ?? t('ai.applied.beforeNone')}</del>
                  <span aria-hidden="true">→</span>
                  <ins className="ai-diff-after"><span className="visually-hidden">{t('ai.applied.after')}</span>{d.after}</ins>
                </div>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

export function Overlay() {
  const refreshRelay = useAiSettings((s) => s.refreshRelay);
  useEffect(() => {
    void refreshRelay();
  }, [refreshRelay]);
  return (
    <>
      <div className="ai-float">
        <LiveBanner />
        <AppliedNotice />
      </div>
      <ExplainPanel />
      <ReviewPanel />
    </>
  );
}