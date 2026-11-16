import { useMemo, useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { Dismiss20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { DEFAULT_LIVE_TIMEOUT_MS } from '../../ai/client.ts';
import { useI18n } from '../../i18n/index.ts';
import { currentScope, useCurrentScope } from '../../state/projects.ts';
import { hrefFor, revisitRouteTarget } from '../../state/router.ts';
import { useSettings, type Audience } from '../../state/settings.ts';
import { Panel } from '../../ui/Panel.tsx';
import { LiveNotice, MockNotice } from '../ai/AiCommon.tsx';
import { AiProgress, type AiStage } from '../ai/AiProgress.tsx';
import { liveReady, useAiSettings } from '../ai/settingsStore.ts';
import type { AppCheckContext } from './deliverables.ts';
import { stepBriefContext } from './overviewModel.ts';
import { stepDashboard, type StepDashboard } from './stepDashboard.ts';
import { buildStepBrief, factText, requestStepBrief, setStepBrief, useStepBriefs, type BriefContent, type StepBrief } from './stepBrief.ts';

/** SCQA and the pyramid below the answer; shared by the rule-based and the generated brief. */
export function BriefBody({ content, brief, prefix }: { content: BriefContent; brief?: StepBrief; prefix: string }) {
  const { t, lang } = useI18n();
  const byId = new Map((brief?.facts ?? []).map((f) => [f.id, f]));
  return (
    <div className="step-brief-body">
      <p className="step-brief-answer" data-testid={`${prefix}-answer`}>{content.answer}</p>
      <dl className="step-brief-scq">
        <div><dt>{t('proj.dash.brief.situation')}</dt><dd>{content.situation}</dd></div>
        <div><dt>{t('proj.dash.brief.complication')}</dt><dd>{content.complication}</dd></div>
        <div><dt>{t('proj.dash.brief.question')}</dt><dd>{content.question}</dd></div>
      </dl>
      {content.findings.length > 0 && (
        <section>
          <h3 className="step-dash-subhead">{t('proj.dash.brief.findings')}</h3>
          <ol className="step-brief-list" data-testid={`${prefix}-findings`}>
            {content.findings.map((f, i) => {
              const facts = (brief?.findingFacts[i] ?? []).map((id) => byId.get(id)).filter((x) => !!x);
              return (
                <li key={i}>
                  <span>{f}</span>
                  {facts.length > 0 && (
                    <ul className="step-brief-facts" aria-label={t('proj.dash.brief.evidence')}>
                      {facts.map((x) => <li key={x.id} data-fact={x.id}>{`${x.label[lang]}: ${factText(x, lang)}`}</li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {content.actions.length > 0 && (
        <section>
          <h3 className="step-dash-subhead">{t('proj.dash.brief.actions')}</h3>
          <ol className="step-brief-list" data-testid={`${prefix}-actions`}>{content.actions.map((a, i) => <li key={i}>{a}</li>)}</ol>
        </section>
      )}
      {content.caveats.length > 0 && (
        <section>
          <h3 className="step-dash-subhead">{t('proj.dash.brief.caveats')}</h3>
          <ul className="step-brief-caveats muted" data-testid={`${prefix}-caveats`}>{content.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

/**
 * FR-319: the step's executive summary. The rule-based brief (every figure from the fact ledger) is always shown;
 * "Generate with Copilot" adds a generated version next to it, labelled live or mock, dated, checked figure by
 * figure against the ledger and marked out of date when the data changes (HAX G1, G2, G9, G11, G15).
 */
/** The calendar date (JST, as \mt.date\ expects) of an ISO timestamp. */
const jstDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);

export function StepBriefPanel({ d, ctx, audience }: { d: StepDashboard; ctx: AppCheckContext; audience: Audience }) {
  const { t, lang, fmt } = useI18n();
  const scope = useCurrentScope();
  const briefCtx = useMemo(() => stepBriefContext(ctx, audience), [ctx, audience]);
  const brief = useMemo(() => buildStepBrief(audience === 'external' ? stepDashboard(d.step, briefCtx) : d, briefCtx, lang, audience), [d, briefCtx, lang, audience]);
  const key = `${audience}:${d.step}`;
  const generated = useStepBriefs((s) => s.value[key]);
  const live = useAiSettings((s) => liveReady(s));
  const [progress, setProgress] = useState<{ stage: AiStage; startedAt?: number } | null>(null);
  const busy = progress !== null;
  const [cancelled, setCancelled] = useState(false);

  const generate = async () => {
    setProgress({ stage: 'generate', startedAt: Date.now() });
    setCancelled(false);
    try {
      if (currentScope() !== scope || useSettings.getState().audience !== audience || useSettings.getState().lang !== lang) {
        setCancelled(true);
        return;
      }
      setProgress({ stage: 'generate', startedAt: Date.now() });
      const result = await requestStepBrief(brief, briefCtx, lang);
      if (currentScope() !== scope || useSettings.getState().audience !== audience || useSettings.getState().lang !== lang) {
        setCancelled(true);
        return;
      }
      setStepBrief(key, result);
    } finally {
      setProgress(null);
    }
  };

  const stale = !!generated && (generated.hash !== brief.hash || generated.lang !== lang);
  return (
    <Panel title={t('proj.dash.brief.title')} testId="step-dash-brief" className="span-full">
      <div className="step-brief">
        <div className="step-brief-col" data-testid="step-dash-brief-rule">
          <div className="step-brief-head">
            <Badge appearance="tint" color="informative">{t('proj.dash.brief.rule')}</Badge>
            <Badge appearance="outline" color={brief.maturity === 'agreed' ? 'success' : brief.maturity === 'evidenced' ? 'brand' : 'warning'} data-testid="step-dash-brief-maturity" data-maturity={brief.maturity}>
              {t(`proj.dash.brief.maturity.${brief.maturity}`)}
            </Badge>
            <span className="muted">{t('proj.dash.brief.ruleHint', { n: brief.facts.length })}</span>
          </div>
          <p className="muted" data-testid="step-dash-brief-maturity-hint">{t(`proj.dash.brief.maturity.${brief.maturity}Hint`)}</p>
          {brief.openSteps.length > 0 && (
            <p className="step-brief-open" data-testid="step-dash-brief-open">
              {t('proj.dash.brief.openSteps')}{' '}
              {brief.openSteps.map((s, i) => (
                <span key={s}>
                  {i > 0 && t('proj.dash.brief.sep')}
                  <a href={hrefFor('/step', { step: s })} onClick={revisitRouteTarget} data-step={s}>{t(`proj.step.${s}`)}</a>
                </span>
              ))}
            </p>
          )}
          <BriefBody content={brief} brief={brief} prefix="step-dash-brief" />
          <details className="step-chart-data" data-testid="step-dash-brief-ledger">
            <summary>{t('proj.dash.brief.ledger', { n: brief.facts.length })}</summary>
            <table className="data-table compact">
              <thead><tr><th scope="col">{t('proj.dash.brief.fact')}</th><th scope="col" className="num">{t('proj.dash.brief.value')}</th></tr></thead>
              <tbody>{brief.facts.map((f) => <tr key={f.id} data-fact={f.id}><th scope="row">{f.label[lang]}</th><td className="num">{factText(f, lang)}</td></tr>)}</tbody>
            </table>
          </details>
        </div>
        <div className="step-brief-col" data-testid="step-dash-brief-ai-col">
          <div className="step-brief-head">
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={busy} onClick={() => void generate()} data-testid="step-dash-brief-generate">
              {t(generated ? 'proj.dash.brief.regenerate' : 'proj.dash.brief.generate')}
            </Button>
          </div>
          <p className="muted">{t(live ? 'proj.dash.brief.liveHint' : 'proj.dash.brief.mockHint')}</p>
          {progress && <AiProgress stage={progress.stage} startedAt={progress.startedAt} limitMs={live ? DEFAULT_LIVE_TIMEOUT_MS : undefined} testId="step-dash-brief-progress" />}
          {cancelled && <p className="muted" data-testid="step-dash-brief-cancelled">{t('proj.dash.brief.cancelled')}</p>}
          {generated && (
            <div className="step-brief-ai" data-testid="step-dash-brief-ai" data-mode={generated.mode} data-stale={stale}>
              {generated.mode === 'mock'
                ? <MockNotice reasons={generated.blockedReasons} />
                : <LiveNotice costJpy={generated.costJpy ?? null} {...(generated.usage ? { usage: generated.usage } : {})} />}
              <div className="step-brief-meta">
                <span className="muted" data-testid="step-dash-brief-at">{t('proj.dash.brief.at', { at: `${fmt.date(jstDate(generated.at))} ${fmt.time(new Date(generated.at))}` })}</span>
                {stale && <Badge appearance="filled" color="warning" data-testid="step-dash-brief-stale">{t('proj.dash.brief.stale')}</Badge>}
                <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} onClick={() => setStepBrief(key, null)} data-testid="step-dash-brief-dismiss">
                  {t('proj.dash.brief.dismiss')}
                </Button>
              </div>
              {generated.check.unverified.length > 0 ? (
                <MessageBar intent="warning" data-testid="step-dash-brief-unverified">
                  <MessageBarBody>{t('proj.dash.brief.unverified', { list: generated.check.unverified.join(', ') })}</MessageBarBody>
                </MessageBar>
              ) : (
                <p className="step-brief-verified" data-testid="step-dash-brief-verified">{t('proj.dash.brief.verified', { n: generated.check.checked })}</p>
              )}
              <BriefBody content={generated.content} prefix="step-dash-brief-ai" />
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
