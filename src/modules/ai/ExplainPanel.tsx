import { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, OverlayDrawer, Spinner,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import { aiComplete, readLedger, type AiRequest, type AiResponse } from '../../ai/client.ts';
import { useI18n } from '../../i18n/index.ts';
import { useRoute } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { LiveNotice, MockNotice } from './AiCommon.tsx';
import { buildExplanation, componentsForRoute, entitiesOfComponents } from './explain.ts';
import { usageSummary } from './ledger.ts';
import { liveReady, useAiSettings } from './settingsStore.ts';
import { useAiPanels } from './uiStore.ts';

type RunState = { status: 'idle' | 'loading' } | { status: 'done'; res: AiResponse };

/**
 * FR-274 / FR-277: "現状の説明" side panel. A saved AI-settings consent and enabled live connection allow
 * a live answer; otherwise a labelled mock answers.
 */
export function ExplainPanel() {
  const { t, lang } = useI18n();
  const open = useAiPanels((s) => s.open === 'explain');
  const setOpen = useAiPanels((s) => s.setOpen);
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const budget = useAiSettings((s) => s.monthlyBudgetJpy);
  const live = useAiSettings((s) => liveReady(s));
  const [state, setState] = useState<RunState>({ status: 'idle' });
  const runId = useRef(0);

  const components = componentsForRoute(route.path);
  const entities = entitiesOfComponents(components);
  const fallback = buildExplanation(entities, (e) => !isHidden(e, audience));

  useEffect(() => {
    if (!open) return;
    const id = ++runId.current;
    setState({ status: 'loading' });
    void (async () => {
      const ents = entitiesOfComponents(componentsForRoute(route.path));
      const req: AiRequest = { use: 'explain', lang, prompt: t('ai.explain.prompt'), entities: ents };
      const finish = (res: AiResponse) => {
        if (id === runId.current) setState({ status: 'done', res });
      };
      finish(await aiComplete(req));
    })();
  }, [open, route.path, lang, live, t]);

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
          <div className="ai-stack" data-testid="ai-explain-body">
            <p className="muted">{t('ai.explain.lead')}</p>
            <p className="ai-status" data-testid="ai-explain-status">
              <Badge appearance="tint" color={answeredLive ? 'success' : 'danger'}>{answeredLive ? t('ai.status.available') : t('ai.status.unavailable')}</Badge>
              <Badge appearance="outline" color={live ? 'success' : 'warning'} data-testid="ai-explain-mode">{live ? t('ai.live.badge') : t('ai.mock.badge')}</Badge>
              <span>{t('ai.explain.quota', { used: usage.todayCalls, limit: usage.dailyLimit })}</span>
            </p>
            {state.status === 'loading' && <Spinner size="tiny" label={t('ai.loading')} />}
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
        </DrawerBody>
      </OverlayDrawer>
    </>
  );
}