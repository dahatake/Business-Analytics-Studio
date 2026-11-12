import { Badge, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { EngagementsExtension } from '../../data/extensionSchemas.ts';
import { loaded, packOrigin } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import { ScrollRegion } from './common.tsx';
import { useAnalyses } from './stores.ts';

export function EngagementsPanel() {
  const { t, lang } = useI18n();
  const scope = useAnalyses((s) => s.scope);
  const audience = useSettings((s) => s.audience);
  if (audience === 'external' || packOrigin.kind !== 'imported' || packOrigin.projectId !== scope) return null;
  const raw = loaded.pack.extensions?.engagements;
  if (raw === undefined) return null;
  const parsed = EngagementsExtension.safeParse(raw);
  if (parsed.success && parsed.data.items.length === 0) return null;
  return (
    <Panel title={t('proj.engagements.title')} rationale="proj.engagements.why" className="span-full" testId="proj-engagements">
      <Badge appearance="tint" color="danger">{t('badge.internal')}</Badge>
      {!parsed.success ? (
        <MessageBar intent="error"><MessageBarBody>{t('proj.engagements.invalid')}</MessageBarBody></MessageBar>
      ) : (
        <ScrollRegion label={t('proj.engagements.title')}>
          <table className="data-table compact">
            <caption>{t('proj.engagements.count', { n: parsed.data.items.length })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('proj.kpi.name')}</th>
                <th scope="col">{t('proj.engagements.type')}</th>
                <th scope="col">{t('proj.packOkr.period')}</th>
                <th scope="col">{t('proj.engagements.customer')}</th>
                <th scope="col">{t('proj.engagements.status')}</th>
                <th scope="col">{t('proj.packOkr.owner')}</th>
                <th scope="col">{t('proj.engagements.quantity')}</th>
                <th scope="col">{t('proj.engagements.outcome')}</th>
                <th scope="col">{t('proj.packOkr.sources')}</th>
              </tr>
            </thead>
            <tbody>
              {parsed.data.items.map((item) => {
                const customer = item.customerId ? loaded.byId.get(item.customerId) : undefined;
                return (
                  <tr key={item.id}>
                    <th scope="row">{loc(item.name, lang)}</th>
                    <td>{item.type ? t(`proj.engagements.type.${item.type}`) : ''}</td>
                    <td>{item.period}</td>
                    <td>{customer?.kind === 'customer' ? loc(customer.name, lang) : item.customer}</td>
                    <td>{item.status}</td>
                    <td>{item.owner}</td>
                    <td>{item.count}</td>
                    <td>{item.outcome}</td>
                    <td>{item.sourceIds.map((id) => {
                      const source = loaded.byId.get(id);
                      return source?.kind === 'source' ? loc(source.name, lang) : id;
                    }).join(', ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Panel>
  );
}
