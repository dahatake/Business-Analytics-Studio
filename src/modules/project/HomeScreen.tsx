import { useState } from 'react';
import { Badge, Button } from '@fluentui/react-components';
import { CheckmarkCircle20Filled, Circle20Regular, PanelRightExpand20Regular, PanelRightContract20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { PageHeader } from '../../ui/Panel.tsx';
import { hrefFor } from '../../state/router.ts';
import { useActiveProject, useProjects } from '../../state/projects.ts';
import { useAnalyses } from './stores.ts';
import './project.css';

/** h1 = "企業名-Project名" of the open or last opened project, else the screen name (FR-186). */
export function homeTitle(s: Pick<ReturnType<typeof useProjects.getState>, 'companies' | 'projects' | 'target' | 'lastProjectId'>): string | null {
  const id = s.target.kind === 'project' ? s.target.projectId : s.lastProjectId;
  const p = id ? s.projects.find((x) => x.id === id) : undefined;
  if (!p) return null;
  const c = s.companies.find((x) => x.id === p.companyId);
  return `${c?.name ?? ''}-${p.name}`;
}

/** FR-186: the main screen only walks through QuickStart (company → project → analysis). */
export function HomeScreen() {
  const { t } = useI18n();
  const companies = useProjects((s) => s.companies);
  const projects = useProjects((s) => s.projects);
  const target = useProjects((s) => s.target);
  const lastProjectId = useProjects((s) => s.lastProjectId);
  const setTarget = useProjects((s) => s.setTarget);
  const { step } = useActiveProject();
  const analyses = useAnalyses((s) => s.value.analyses);
  const [helpOpen, setHelpOpen] = useState(false);
  const title = homeTitle({ companies, projects, target, lastProjectId }) ?? t('proj.nav.home');
  const recent = [...projects].reverse().slice(0, 5);
  const inProject = target.kind === 'project';
  const done = [companies.length > 0, inProject, inProject && analyses.length > 0];

  const Status = ({ ok }: { ok: boolean }) => (ok
    ? <span className="proj-status ok"><CheckmarkCircle20Filled aria-hidden />{t('proj.quick.done')}</span>
    : <span className="proj-status"><Circle20Regular aria-hidden />{t('proj.quick.todo')}</span>);

  return (
    <div className={`proj-home${helpOpen ? ' help-open' : ''}`}>
      <div className="proj-home-main">
        <PageHeader
          title={title}
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
        <p className="proj-current-step" data-testid="proj-home-step">
          {t('proj.home.currentStep', { step: t(`proj.step.${step}`) })}
          {target.kind === 'demo' && <Badge appearance="tint" color="informative" className="proj-inline-badge">{t('proj.demo')}</Badge>}
        </p>
        <ol className="proj-quick" aria-label={t('proj.quick.label')}>
          <li className="proj-quick-step">
            <h2 className="proj-h2">{t('proj.quick.company')}</h2>
            <Status ok={done[0]!} />
            <p>{t('proj.quick.companyBody')}</p>
            <Button as="a" href={hrefFor('/projects')} appearance="primary">{t('proj.quick.companyGo')}</Button>
          </li>
          <li className="proj-quick-step">
            <h2 className="proj-h2">{t('proj.quick.project')}</h2>
            <Status ok={done[1]!} />
            <p>{t('proj.quick.projectBody')}</p>
            {recent.length > 0 ? (
              <ul className="proj-recent">
                {recent.map((p) => {
                  const c = companies.find((x) => x.id === p.companyId);
                  const active = target.kind === 'project' && target.projectId === p.id;
                  return (
                    <li key={p.id}>
                      <Button appearance={active ? 'primary' : 'secondary'} aria-pressed={active} onClick={() => setTarget({ kind: 'project', projectId: p.id })}>
                        {t('proj.quick.open', { name: `${c?.name ?? ''}-${p.name}` })}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Button as="a" href={hrefFor('/projects')} appearance="secondary">{t('proj.quick.projectGo')}</Button>
            )}
          </li>
          <li className="proj-quick-step">
            <h2 className="proj-h2">{t('proj.quick.analysis')}</h2>
            <Status ok={done[2]!} />
            <p>{t('proj.quick.analysisBody')}</p>
            <div className="proj-row">
              <Button as="a" href={hrefFor('/analysis')} appearance="primary">{t('proj.quick.analysisGo')}</Button>
              <Button as="a" href={hrefFor('/discussion')} appearance="secondary">{t('proj.quick.discussionGo')}</Button>
            </div>
          </li>
        </ol>
        <div className="proj-demo-line">
          <p>{t('proj.quick.demoBody')}</p>
          <Button appearance="secondary" aria-pressed={target.kind === 'demo'} onClick={() => setTarget({ kind: 'demo' })}>{t('proj.firstRun.demo')}</Button>
        </div>
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
