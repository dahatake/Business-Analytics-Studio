import { loaded } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useActiveProject } from '../state/projects.ts';
import { PageHeader } from '../ui/Panel.tsx';
import { useCheckContext } from '../modules/project/deliverablesUi.tsx';
import { StrategyOverview } from '../modules/project/StrategyOverview.tsx';

export function Overview() {
  const { t, tx } = useI18n();
  const { step } = useActiveProject();
  const ctx = useCheckContext();
  return (
    <div className="screen screen-overview">
      <PageHeader title={t('stg.title')} subtitle={tx(loaded.pack.company.name)} />
      <StrategyOverview ctx={ctx} step={step} analysis />
    </div>
  );
}
