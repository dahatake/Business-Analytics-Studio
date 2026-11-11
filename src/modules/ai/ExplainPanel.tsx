import { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, OverlayDrawer, Spinner,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import { aiComplete, isUseApproved, preflight, readLedger, type AiRequest, type AiResponse } from '../../ai/client.ts';
import type { GateReason } from '../../ai/gate.ts';
import { useI18n } from '../../i18n/index.ts';
import { useRoute } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { LiveNotice, MockNotice, usePersonConfirm, useLiveConfirm } from './AiCommon.tsx';
import { buildExplanation, componentsForRoute, entitiesOfComponents } from './explain.ts';
import { usageSummary } from './ledger.ts';
import { liveReady, useAiSettings } from './settingsStore.ts';
import { useAiPanels } from './uiStore.ts';

type RunState = { status: 'idle' | 'loading' | 'cancelled' } | { status: 'done'; res: AiResponse };

/** Confirmation reasons are noise when something else (budget, interval, prices…) already blocks the send. */
const CONFIRM_REASONS = new Set<GateReason>(['notConfirmed', 'personNotConfirmed']);
function shownReasons(reasons: GateReason[]): GateReason[] {
  const other = reasons.filter((r) => !CONFIRM_REASONS.has(r));
  return other.length > 0 ? other : reasons;
}

/**
 * FR-274 / FR-277: "現状の説明" side panel. D-1 approved this use for Microsoft Foundry: when live is ready, a confirmation
 * built from preflight() comes first and only a confirmed send goes out. Otherwise a labelled mock answers.
 */
export function ExplainPanel() {
  const { t, lang } = useI18n();
  const open = useAiPanels((s) => s.open === 'explain');
  const setOpen = useAiPanels((s) => s.setOpen);
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const budget = useAiSettings((s) => s.monthlyBudgetJpy);
  const live = useAiSettings((s) => liveReady(s)) && isUseApproved('explain');
  const { dialog, confirm } = usePersonConfirm();
  const { dialog: liveDialog, confirmLive } = useLiveConfirm();
  const [state, setState] = useState<RunState>({ status: 'idle' });
  const runId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const components = componentsForRoute(route.path);
  const entities = entitiesOfComponents(components);
  const fallback = buildExplanation(entities, (e) => !isHidden(e, audience));

  useEffect(() => {
    if (!open) return;
    const id = ++runId.current;
    setState({ status: 'loading' });
    // A confirmation opened before the drawer took focus returns focus to the top bar, which leaves the drawer hidden from
    // assistive technology (Tabster modalizer). Moving focus back into the drawer re-activates it.
    const refocus = () => requestAnimationFrame(() => {
      const body = bodyRef.current;
      const drawer = body?.closest('[role="dialog"]');
      if (body && !drawer?.contains(document.activeElement)) body.focus();
    });
    void (async () => {
      const ents = entitiesOfComponents(componentsForRoute(route.path));
      const scope = t('ai.scope.screen', { path: route.path });
      const req: AiRequest = { use: 'explain', lang, prompt: t('ai.explain.prompt'), entities: ents };
      const finish = (res: AiResponse) => {
        if (id === runId.current) setState({ status: 'done', res: { ...res, blockedReasons: shownReasons(res.blockedReasons) } });
      };
      if (live) {
        const pf = preflight({ ...req, userConfirmed: true, personConfirmed: true });
        // Blocked for a reason a confirmation cannot fix (budget, interval…): answer with the mock, ask nothing.
        if (!pf.allowed) return finish(await aiComplete(req));
        const decision = await confirmLive({
          use: 'ai.use.explain', scope, itemCount: ents.length, internalCount: pf.internalCount, personCount: pf.personCount,
          estimatedCostJpy: pf.estimatedCostJpy, monthSpentJpy: pf.budget.monthSpentJpy, monthBudgetJpy: useAiSettings.getState().monthlyBudgetJpy,
        });
        if (id !== runId.current) return;
        refocus();
        if (!decision.ok) return setState({ status: 'cancelled' });
        return finish(await aiComplete({ ...req, userConfirmed: true, personConfirmed: decision.personConfirmed }));
      }
      const ok = await confirm(ents, scope);
      if (id !== runId.current) return;
      refocus();
      if (!ok) return setState({ status: 'cancelled' });
      finish(await aiComplete({ ...req, personConfirmed: true }));
    })();
  }, [open, route.path, lang, confirm, confirmLive, live, t]);

  const usage = usageSummary(readLedger(), new Date(), budget);
  const answeredLive = state.status === 'done' && state.res.mode === 'live';

  return (
    <>
      <OverlayDrawer
        open={open}
        position="end"
        size="medium"
        aria-label={t('ai.explain.title')}
        onOpenChange={(_, d) => setOpen(d.open ? 'explain' : null)}
        data-testid="ai-explain-panel"
      >
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('ai.close')} icon={<Dismiss24Regular />} onClick={() => setOpen(null)} />}>
            {t('ai.explain.title')}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className="ai-stack" ref={bodyRef} tabIndex={-1} data-testid="ai-explain-body">
            <p className="muted">{t('ai.explain.lead')}</p>
            <p className="ai-status" data-testid="ai-explain-status">
              <Badge appearance="tint" color={answeredLive ? 'success' : 'danger'}>{answeredLive ? t('ai.status.available') : t('ai.status.unavailable')}</Badge>
              <Badge appearance="outline" color={live ? 'success' : 'warning'} data-testid="ai-explain-mode">{live ? t('ai.live.badge') : t('ai.mock.badge')}</Badge>
              <span>{t('ai.explain.quota', { used: usage.todayCalls, limit: usage.dailyLimit })}</span>
            </p>
            {state.status === 'loading' && <Spinner size="tiny" label={t('ai.loading')} />}
            {state.status === 'cancelled' && <p role="status">{t('ai.person.cancelled')}</p>}
            {state.status === 'done' && state.res.mode === 'live' && (
              <LiveNotice costJpy={state.res.costJpy ?? null} usage={state.res.usage}>
                <p className="ai-answer" data-testid="ai-explain-answer">{state.res.text}</p>
              </LiveNotice>
            )}
            {state.status === 'done' && state.res.mode === 'mock' && (
              <MockNotice reasons={state.res.blockedReasons}>
                <p className="ai-answer" data-testid="ai-explain-answer">{state.res.text}</p>
              </MockNotice>
            )}
            <section aria-labelledby="ai-explain-fallback">
              <h3 id="ai-explain-fallback" className="ai-h3">{t('ai.explain.fallbackTitle')}</h3>
              <p className="muted">{t('ai.explain.fallbackLead')}</p>
              {fallback.issues.length === 0 && fallback.kpis.length === 0 && <p>{t('ai.explain.empty')}</p>}
              <ul className="ai-explain-list" data-testid="ai-explain-fallback">
                {fallback.issues.slice(0, 6).map(({ issue, solutions, kpis }) => (
                  <li key={issue.id}>
                    <div><span className="ai-label">{t('kind.issue')}</span> <EntityRef id={issue.id} /></div>
                    <div><span className="ai-label">{t('kind.solution')}</span> {solutions.length ? solutions.map((s) => <EntityRef key={s.id} id={s.id} />) : <span className="muted">{t('ai.explain.none')}</span>}</div>
                    <div><span className="ai-label">{t('ai.explain.contributes')}</span> {kpis.length ? kpis.map((k) => <EntityRef key={k.id} id={k.id} />) : <span className="muted">{t('ai.explain.none')}</span>}</div>
                  </li>
                ))}
                {fallback.issues.length === 0 && fallback.kpis.map(({ kpi, progress }) => (
                  <li key={kpi.id}>
                    <EntityRef id={kpi.id} /> <span>{t('ai.explain.progress', { progress: Math.round(progress * 100) })}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          {dialog}
          {liveDialog}
        </DrawerBody>
      </OverlayDrawer>
    </>
  );
}