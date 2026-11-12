import { Badge } from '@fluentui/react-components';
import { C03_TABLE, approvedProviders, isApproved, type AiUse } from '../../ai/policy.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { hrefFor } from '../../state/router.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import './ai.css';

const APPROVED_DATA_KEYS: Partial<Record<AiUse, MessageKey>> = {
  explain: 'ai.policy.data.explain',
  connectionTest: 'ai.policy.data.connectionTest',
  packBuild: 'ai.policy.data.packBuild',
  alignmentProposal: 'ai.policy.data.alignmentProposal',
};

export function AiPolicyScreen() {
  const { t } = useI18n();
  const uses = Object.keys(C03_TABLE) as AiUse[];

  return (
    <div className="screen ai-screen" data-testid="ai-policy-screen">
      <PageHeader title={t('ai.policy.title')} subtitle={t('ai.policy.subtitle')} />
      <Panel title={t('ai.policy.introTitle')} testId="ai-policy-intro">
        <p>{t('ai.policy.intro')}</p>
      </Panel>
      <Panel title={t('ai.c03.title')} testId="ai-policy-rules">
        <div className="ai-table-wrap" tabIndex={0} role="region" aria-label={t('ai.c03.title')}>
          <table className="data-table">
            <caption className="visually-hidden">{t('ai.c03.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ai.policy.use')}</th>
                <th scope="col">{t('ai.policy.provider')}</th>
                <th scope="col">{t('ai.policy.data')}</th>
                <th scope="col">{t('ai.policy.cost')}</th>
                <th scope="col">{t('ai.policy.status')}</th>
              </tr>
            </thead>
            <tbody>
              {uses.map((use) => {
                const row = C03_TABLE[use];
                const approved = isApproved(row);
                const providers = approvedProviders(row);
                const dataKey = APPROVED_DATA_KEYS[use];
                const cost = !approved
                  ? t('ai.policy.costNone')
                  : providers.includes('foundry') && providers.includes('copilotSdk')
                    ? t('ai.policy.costBoth')
                    : providers.includes('foundry')
                      ? t('ai.policy.costFoundry')
                      : t('ai.policy.costCopilot');
                return (
                  <tr key={use} data-use={use} data-approved={approved}>
                    <th scope="row">{t(`ai.use.${use}`)}</th>
                    <td>{approved ? providers.map((provider) => t(`ai.provider.${provider}`)).join(t('ai.listSep')) : t('ai.c03.tbd')}</td>
                    <td>{approved && dataKey ? t(dataKey) : t('ai.policy.pending')}</td>
                    <td>{cost}</td>
                    <td>
                      <Badge appearance="tint" color={approved ? 'success' : 'danger'}>
                        {t(approved ? 'ai.policy.allowed' : 'ai.policy.blocked')}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <p><a href={hrefFor('/ai-settings')}>{t('ai.policy.settings')}</a></p>
    </div>
  );
}
