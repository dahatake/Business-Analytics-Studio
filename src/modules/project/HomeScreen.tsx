import { useState } from 'react';
import { Badge, Button } from '@fluentui/react-components';
import { PanelRightExpand20Regular, PanelRightContract20Regular } from '@fluentui/react-icons';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { PageHeader } from '../../ui/Panel.tsx';
import { useActiveProject, useProjects } from '../../state/projects.ts';
import { useTargetNames } from './common.tsx';
import { useCheckContext } from './deliverablesUi.tsx';
import { StrategyOverview } from './StrategyOverview.tsx';
import './project.css';

/**
 * FR-186: the project's main screen shows the project's whole workflow (objective → OKR → KPI → issue → solution,
 * the next action and each step's brief). Choosing a company or project happens on the launch screen, the target
 * menu and the companies-and-projects screen, not here. h1 = "company-project" of the open target.
 */
export function HomeScreen() {
  const { t } = useI18n();
  const { step } = useActiveProject();
  const isDemo = useProjects((s) => s.target.kind === 'demo');
  const names = useTargetNames();
  const ctx = useCheckContext();
  const [helpOpen, setHelpOpen] = useState(false);
  const company = isDemo && loaded.pack.isSample ? t('proj.launch.sampleCompany') : names.company;

  return (
    <div className={`proj-home${helpOpen ? ' help-open' : ''}`}>
      <div className="screen screen-overview proj-home-main">
        <PageHeader
          title={`${company}-${names.project}`}
          subtitle={t('proj.home.subtitle')}
          actions={(
            <Button
              appearance="secondary"
              icon={helpOpen ? <PanelRightContract20Regular /> : <PanelRightExpand20Regular />}
              aria-expanded={helpOpen}
              aria-controls="proj-help"
              onClick={() => setHelpOpen(!helpOpen)}
              data-testid="proj-help-toggle"
            >
              {t('proj.help.toggle')}
            </Button>
          )}
        />
        <p className="proj-current-step span-full" data-testid="proj-home-step">
          {t('proj.home.currentStep', { step: t(`proj.step.${step}`) })}
          {isDemo && <Badge appearance="tint" color="informative" className="proj-inline-badge">{t('proj.demo')}</Badge>}
        </p>
        <StrategyOverview ctx={ctx} step={step} analysis />
      </div>
      {/* FR-266 / FR-268: supplementary help on the right; closed by default; falls below on narrow screens. */}
      <aside id="proj-help" className="proj-help" aria-label={t('proj.help.label')} hidden={!helpOpen} data-testid="proj-help">
        <section>
          <h2 className="proj-h2">{t('proj.help.firstTitle')}</h2>
          <p>{t('proj.help.firstBody')}</p>
          <ol>
            <li>{t('proj.help.first1')}</li>
            <li>{t('proj.help.first2')}</li>
            <li>{t('proj.help.first3')}</li>
          </ol>
        </section>
        <section>
          <h2 className="proj-h2">{t('proj.help.packTitle')}</h2>
          <p>{t('proj.help.packBody')}</p>
        </section>
      </aside>
    </div>
  );
}
