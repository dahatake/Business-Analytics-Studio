import { useMemo, useState } from 'react';
import { reloadAfterDeviceSave } from '../../data/deviceStorage.ts';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { Add20Regular, BotSparkle20Regular, Delete20Regular, Edit20Regular, Open20Regular, Settings20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { basePack } from '../../data/pack.ts';
import { importedPacks } from '../../data/packStore.ts';
import { useI18n } from '../../i18n/index.ts';
import { useLaunch } from '../../state/launch.ts';
import { useProjects, MAX_PROJECTS_PER_COMPANY, type WorkTarget } from '../../state/projects.ts';
import { hrefFor, navigate } from '../../state/router.ts';
import { LanguageToggle } from '../../ui/LanguageToggle.tsx';
import { AiSettingsDialog } from '../ai/AiConnectionForm.tsx';
import { generatePrefillFor, PackGenerateDialog, type PackGenTarget } from './PackGenerateDialog.tsx';
import type { PackGenInput } from './packGenerate.ts';
import { useProjectManagement } from './useProjectManagement.tsx';
import './project.css';

/**
 * Start-up step 2: choose the company and project to work on. The sample company with its demo project is always
 * offered first; registered companies follow. Choosing opens step 3, the project screen (main screen, /home).
 */
export function LaunchScreen() {
  const { t, tx } = useI18n();
  const companies = useProjects((s) => s.companies);
  const projects = useProjects((s) => s.projects);
  const lastProjectId = useProjects((s) => s.lastProjectId);
  const choose = useLaunch((s) => s.choose);
  const [companyName, setCompanyName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [importAfter, setImportAfter] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const management = useProjectManagement();
  const [gen, setGen] = useState<{ target: PackGenTarget; prefill: Partial<PackGenInput> | null } | null>(null);
  // Re-read when the generate dialog closes, so a pack saved there shows at once.
  const packs = useMemo(() => importedPacks(), [gen]);
  const generate = async (projectId: string) => setGen({ target: { kind: 'project', projectId }, prefill: await generatePrefillFor(projectId) });
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);

  const open =  (target: WorkTarget, path = '/home') => {
    choose();
    // Set the route before the target: a target with another customer pack reloads the page (main.tsx) at this URL.
    navigate(hrefFor(path));
    useProjects.getState().setTarget(target);
  };

  const create = () => {
    const { addCompany, addProject } = useProjects.getState();
    const name = companyName.trim();
    if (!name || !projectName.trim()) return setError(t('proj.err.required'));
    const existing = useProjects.getState().companies.find((c) => c.name === name);
    let companyId = existing?.id;
    if (!companyId) {
      const r = addCompany(name);
      if (!r.ok) return setError(t('proj.err.duplicateCompany'));
      companyId = r.id;
    }
    const r = addProject(companyId, projectName);
    if (!r.ok) {
      return setError(t(r.reason === 'limit' ? 'proj.err.limit' : r.reason === 'duplicate' ? 'proj.err.duplicateProject' : 'proj.err.required', { max: MAX_PROJECTS_PER_COMPANY }));
    }
    open({ kind: 'project', projectId: r.id }, importAfter ? '/data' : '/home');
  };

  const sampleCompany = basePack.isSample ? t('proj.launch.sampleCompany') : tx(basePack.company.name);

  return (
    <div className="launch">
      <header className="launch-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">{t('app.title')}</span>
        </div>
        <div className="proj-row launch-header-actions">
          <Button appearance="subtle" icon={<Settings20Regular />} onClick={() => setAiSettingsOpen(true)} data-testid="launch-ai-settings">{t('proj.gen.aiSettings')}</Button>
          <LanguageToggle />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="launch-main" data-testid="launch-screen">
        <h1 className="page-title">{t('proj.launch.title')}</h1>
        <p className="page-subtitle">{t('proj.launch.subtitle')}</p>

        <section className="launch-section" aria-labelledby="launch-sample">
          <h2 id="launch-sample" className="proj-h2">{t('proj.launch.sampleTitle')}</h2>
          <ul className="launch-list">
            <li className="launch-company" data-testid="launch-sample">
              <div className="launch-company-head">
                <span className="launch-company-name">{sampleCompany}</span>
                <span className="muted">{tx(basePack.company.industry)}</span>
                {basePack.isSample && <Badge appearance="tint" color="informative">{t('badge.samplePack')}</Badge>}
              </div>
              <ul className="launch-projects">
                <li>
                  <span className="launch-project-name">{t('proj.launch.demoProject')}</span>
                  <span className="muted">{t('proj.launch.demoBody')}</span>
                  <Button appearance="primary" icon={<Open20Regular />} onClick={() => open({ kind: 'demo' })} data-testid="launch-open-demo">
                    {t('proj.launch.open')}
                  </Button>
                </li>
              </ul>
            </li>
          </ul>
        </section>

        <section className="launch-section" aria-labelledby="launch-registered">
          <h2 id="launch-registered" className="proj-h2">{t('proj.launch.registeredTitle')}</h2>
          {companies.length === 0 ? <p className="muted">{t('proj.launch.noCompanies')}</p> : (
            <ul className="launch-list">
              {companies.map((c) => {
                const list = projects.filter((p) => p.companyId === c.id);
                return (
                  <li key={c.id} className="launch-company" data-testid={`launch-company-${c.name}`}>
                    <div className="launch-company-head">
                      <span className="launch-company-name">{c.name}</span>
                      <div className="proj-row launch-company-actions">
                        <Button icon={<Edit20Regular />} onClick={() => management.renameCompany(c)} aria-label={t('proj.projects.renameNamed', { name: c.name })}>{t('proj.rename')}</Button>
                        <Button icon={<Delete20Regular />} onClick={() => management.deleteCompany(c)} aria-label={t('proj.projects.deleteNamed', { name: c.name })}>{t('proj.delete')}</Button>
                      </div>
                    </div>
                    {list.length === 0 ? <p className="muted">{t('proj.target.noProjects')}</p> : (
                      <ul className="launch-projects">
                        {list.map((p) => (
                          <li key={p.id} data-testid={`launch-project-${p.id}`}>
                            <span className="launch-project-name">{p.name}</span>
                            {p.brief?.purpose && <span className="muted launch-project-purpose" data-testid={`launch-purpose-${p.id}`}>{p.brief.purpose}</span>}
                            <span className="muted">{t('proj.launch.step', { step: t(`proj.step.${p.step}`) })}</span>
                            <span className="proj-badges">
                              {packs[p.id] && <Badge appearance="tint" color="success">{t('proj.launch.packImported')}</Badge>}
                              {p.id === lastProjectId && <Badge appearance="outline">{t('proj.launch.last')}</Badge>}
                            </span>
                            <div className="proj-row">
                              <Button
                                appearance={p.id === lastProjectId ? 'primary' : 'secondary'}
                                icon={<Open20Regular />}
                                onClick={() => open({ kind: 'project', projectId: p.id })}
                                aria-label={t('proj.launch.openNamed', { name: `${c.name}-${p.name}` })}
                              >
                                {t('proj.launch.open')}
                              </Button>
                              <Button icon={<BotSparkle20Regular />} onClick={() => void generate(p.id)} aria-label={t(packs[p.id] ? 'proj.projects.refetchNamed' : 'proj.gen.buttonNamed', { name: `${c.name}-${p.name}` })} data-testid={`launch-generate-${p.id}`}>{t(packs[p.id] ? 'proj.ready.refetch' : 'proj.gen.buttonShort')}</Button>
                              <Button icon={<Edit20Regular />} onClick={() => management.renameProject(p)} aria-label={t('proj.projects.renameNamed', { name: `${c.name}-${p.name}` })}>{t('proj.rename')}</Button>
                              <Button icon={<Delete20Regular />} onClick={() => management.deleteProject(p)} aria-label={t('proj.projects.deleteNamed', { name: `${c.name}-${p.name}` })}>{t('proj.delete')}</Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {management.dialogs}
        <AiSettingsDialog open={aiSettingsOpen} onClose={() => setAiSettingsOpen(false)} />
        {gen && (
          <PackGenerateDialog
            open
            target={gen.target}
            prefill={gen.prefill}
            onClose={() => setGen(null)}
            onOpenProject={(projectId) => {
              open({ kind: 'project', projectId });
              // A pack saved for the project that is already active needs an explicit restart to be loaded (main.tsx).
              reloadAfterDeviceSave();
            }}
          />
        )}
        <section className="launch-section" aria-labelledby="launch-new">
          <h2 id="launch-new" className="proj-h2">{t('proj.launch.newTitle')}</h2>
          <form className="launch-form" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <Field label={t('proj.projects.companyName')} hint={t('proj.launch.companyHint')}>
              <Input value={companyName} onChange={(_, d) => setCompanyName(d.value)} list="launch-company-names" data-testid="launch-company-name" />
            </Field>
            <datalist id="launch-company-names">
              {companies.map((c) => <option key={c.id} value={c.name} />)}
            </datalist>
            <Field label={t('proj.projects.newProject')}>
              <Input value={projectName} onChange={(_, d) => setProjectName(d.value)} data-testid="launch-project-name" />
            </Field>
            <Checkbox checked={importAfter} onChange={(_, d) => setImportAfter(d.checked === true)} label={t('proj.launch.importAfter')} data-testid="launch-import-after" />
            {error && <MessageBar intent="error" role="alert"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            <div className="proj-row">
              <Button type="submit" appearance="primary" icon={<Add20Regular />} data-testid="launch-create">{t('proj.launch.create')}</Button>
              <Button icon={<BotSparkle20Regular />} onClick={() => setGen({ target: { kind: 'new', companyName, projectName }, prefill: null })} data-testid="launch-generate">{t('proj.gen.button')}</Button>
              <Button appearance="subtle" icon={<Sparkle20Regular />} onClick={() => open({ kind: 'demo' }, '/data')}>{t('proj.launch.howToPack')}</Button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
