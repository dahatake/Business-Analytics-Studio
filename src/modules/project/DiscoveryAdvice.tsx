import { useMemo } from 'react';
import { Badge } from '@fluentui/react-components';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import type { ImprovementStep } from '../../state/projects.ts';
import { revisitRouteTarget } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import type { CheckContext } from './deliverables.ts';
import { discoveryAdvice, type AdviceTone } from './discoveryAdvice.ts';
import './advice.css';

const TONE_COLOR: Record<AdviceTone, 'warning' | 'informative' | 'success'> = { yellow: 'warning', info: 'informative', green: 'success' };
const MAX_REFS = 3;

/** FR-351: Khalsa-based advice for the step, computed from the data (no AI) and worded from counts only. */
export function DiscoveryAdvicePanel({ step, ctx }: { step: ImprovementStep; ctx: CheckContext }) {
  const { t } = useI18n();
  const audience = useSettings((s) => s.audience);
  const items = useMemo(() => discoveryAdvice(step, ctx), [step, ctx]);
  const yellow = items.filter((i) => i.tone === 'yellow').length;
  return (
    <Panel title={t('proj.advice.title')} testId="step-advice" className="span-full">
      <p className="muted">{t('proj.advice.lead')}</p>
      {yellow > 0 && <p data-testid="step-advice-summary" data-yellow={yellow}>{t('proj.advice.summary', { n: yellow })}</p>}
      <ul className="step-advice-list">
        {items.map((item) => {
          const vars = {
            ...item.vars,
            ...(typeof item.vars.step === 'string' ? { step: t(`proj.step.${item.vars.step}` as MessageKey) } : {}),
            ...(typeof item.vars.status === 'string' ? { status: t(`sol.def.status.${item.vars.status}` as MessageKey) } : {}),
          };
          const refs = item.refs.filter((id) => {
            const e = ctx.pack.byId.get(id);
            return !e || !isHidden(e, audience);
          });
          return (
            <li key={item.id} className="step-advice-item" data-testid={`step-advice-${item.id}`} data-tone={item.tone} data-principle={item.principle}>
              <div className="step-advice-head">
                <Badge size="small" appearance="tint" color={TONE_COLOR[item.tone]}>{t(`proj.advice.tone.${item.tone}` as MessageKey)}</Badge>
                <Badge size="small" appearance="outline">{t(`proj.advice.principle.${item.principle}` as MessageKey)}</Badge>
              </div>
              <p className="step-advice-text">{t(`proj.advice.item.${item.id}` as MessageKey, vars)}</p>
              {refs.length > 0 && (
                <span className="step-advice-refs">
                  {refs.slice(0, MAX_REFS).map((id) => <EntityRef key={id} id={id} />)}
                  {refs.length > MAX_REFS && <span className="muted">{t('dlv.more', { n: refs.length - MAX_REFS })}</span>}
                </span>
              )}
              {item.href && <a href={item.href} onClick={revisitRouteTarget} data-testid={`step-advice-go-${item.id}`}>{t('proj.advice.go')}</a>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
