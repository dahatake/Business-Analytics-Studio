import { useI18n } from '../../i18n/index.ts';
import { hrefFor } from '../../state/router.ts';
import type { ImprovementStep } from '../../state/projects.ts';

export function SimulationLink({ step, tab, target }: { step: ImprovementStep; tab?: string; target?: string }) {
  const { t } = useI18n();
  const section = tab ?? (step === 'asis' || step === 'tobe' ? 'issues' : step === 'kpi' ? 'kpi' : 'solutions');
  return <a className="span-full" data-testid="simulation-link" id={target} href={hrefFor('/optimize', { tab: section, step })}>{t('ck.sim.open')}</a>;
}
