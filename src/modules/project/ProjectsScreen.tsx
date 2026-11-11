import { useMemo, useRef, useState } from 'react';
import { reloadAfterDeviceSave } from '../../data/deviceStorage.ts';
import { Badge, Button, Field, Input, MessageBar, MessageBarBody, Textarea } from '@fluentui/react-components';
import { Add20Regular, ArrowDownload20Regular, ArrowUpload20Regular, BotSparkle20Regular, Delete20Regular, Edit20Regular, Open20Regular, Settings20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { MAX_PROJECTS_PER_COMPANY, useProjects, type AddProjectResult, type Company, type Project, type ProjectRelation } from '../../state/projects.ts';
import { hrefFor, navigate } from '../../state/router.ts';
import { AiSettingsDialog } from '../ai/AiConnectionForm.tsx';
import { BackToHome, downloadText, ScrollRegion } from './common.tsx';
import { generatePrefillFor, PackGenerateDialog, type PackGenTarget } from './PackGenerateDialog.tsx';
import type { PackGenInput } from './packGenerate.ts';
import { importedPacks, type ImportedPackMeta } from '../../data/packStore.ts';
import { CompanyEditDialog, ProjectEditDialog } from './ProjectEditDialogs.tsx';
import { ProjectRelationsPanel } from './ProjectRelationsPanel.tsx';
import { exportProject, importProject, type ProjectFile } from './projectFile.ts';
import { yyyymmdd } from './exportFormat.ts';
import { useProjectManagement } from './useProjectManagement.tsx';
import './project.css';

/** FR-137〜FR-139: register companies, manage up to PARAM-031 projects each, export/import a project with its ids. */
export function ProjectsScreen() {
  const { t, fmt } = useI18n();
  const companies = useProjects((s) => s.companies);
  const projects = useProjects((s) => s.projects);
  const relations = useProjects((s) => s.relations);
  const target = useProjects((s) => s.target);
  const { addCompany, addProject, setTarget } = useProjects.getState();
  const [companyName, setCompanyName] = useState('');
  const [companyError, setCompanyError] = useState<string | null>(null);
  const management = useProjectManagement();
  const [gen, setGen] = useState<{ target: PackGenTarget; prefill: Partial<PackGenInput> | null } | null>(null);
  const [editCompany, setEditCompany] = useState<Company | null>(null);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [message, setMessage] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Re-read when the generate dialog closes, so a pack saved there shows at once.
  const packs = useMemo(() => importedPacks(), [gen]);

  const onAddCompany = () => {
    const r = addCompany(companyName);
    if (r.ok) {
      setCompanyName('');
      setCompanyError(null);
    } else setCompanyError(t(r.reason === 'emptyName' ? 'proj.err.required' : 'proj.err.duplicateCompany'));
  };

  const onImport = async (file: File) => {
    const outcome = importProject(await file.text());
    if (outcome.ok) setMessage({ intent: 'success', text: t('proj.projects.imported', { name: outcome.name }) });
    else setMessage({ intent: 'error', text: t(`proj.projects.importError.${outcome.error}`) });
  };

  const onExport = (p: Project) => {
    const file: ProjectFile | null = exportProject(p.id);
    if (!file) return;
    const c = companies.find((x) => x.id === p.companyId);
    downloadText(`${c?.name ?? 'company'}-${p.name}-project-${yyyymmdd(new Date())}.json`.replace(/[\\/:*?"<>|\s]+/g, '_'), JSON.stringify(file, null, 2), 'application/json');
  };

  const onGenerate = async (p: Project) => {
    setGen({ target: { kind: 'project', projectId: p.id }, prefill: await generatePrefillFor(p.id) });
  };

  return (
    <div className="screen proj-screen">
      <PageHeader
        title={t('proj.title')}
        subtitle={t('proj.projects.subtitle', { max: MAX_PROJECTS_PER_COMPANY })}
        actions={(
          <>
            <BackToHome />
            <Button icon={<Settings20Regular />} onClick={() => setAiSettingsOpen(true)} data-testid="proj-ai-settings">{t('proj.gen.aiSettings')}</Button>
            <Button icon={<ArrowUpload20Regular />} onClick={() => fileRef.current?.click()}>{t('proj.projects.import')}</Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="visually-hidden"
              tabIndex={-1}
              aria-label={t('proj.projects.import')}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImport(f);
                e.target.value = '';
              }}
              data-testid="proj-project-import"
            />
          </>
        )}
      />
      {message && (
        <MessageBar intent={message.intent} className="span-full" role="status"><MessageBarBody>{message.text}</MessageBarBody></MessageBar>
      )}
      <Panel title={t('proj.projects.addCompany')} className="span-full">
        <form className="proj-form-row" onSubmit={(e) => { e.preventDefault(); onAddCompany(); }}>
          <Field label={t('proj.projects.companyName')} validationMessage={companyError ?? undefined} validationState={companyError ? 'error' : 'none'}>
            <Input value={companyName} onChange={(_, d) => setCompanyName(d.value)} data-testid="proj-company-name" />
          </Field>
          <Button type="submit" appearance="primary" icon={<Add20Regular />}>{t('proj.projects.addCompanyButton')}</Button>
        </form>
      </Panel>
      {companies.length === 0 && <p className="muted span-full">{t('proj.projects.empty')}</p>}
      {companies.map((c) => (
        <CompanyPanel
          key={c.id}
          company={c}
          projects={projects.filter((p) => p.companyId === c.id)}
          relations={relations.filter((r) => r.companyId === c.id)}
          packs={packs}
          activeId={target.kind === 'project' ? target.projectId : null}
          onAddProject={(name, purpose) => addProject(c.id, name, purpose.trim() ? { purpose } : undefined)}
          onEditCompany={() => setEditCompany(c)}
          onDeleteCompany={() => management.deleteCompany(c)}
          onEditProject={setEditProject}
          onDeleteProject={management.deleteProject}
          onOpen={(p) => setTarget({ kind: 'project', projectId: p.id })}
          onGenerate={(p) => void onGenerate(p)}
          onExport={onExport}
          date={fmt.date}
        />
      ))}
      {management.dialogs}
      <CompanyEditDialog company={editCompany} onClose={() => setEditCompany(null)} />
      <ProjectEditDialog project={editProject} onClose={() => setEditProject(null)} />
      <AiSettingsDialog open={aiSettingsOpen} onClose={() => setAiSettingsOpen(false)} />
      {gen && (
        <PackGenerateDialog
          open
          target={gen.target}
          prefill={gen.prefill}
          onClose={() => setGen(null)}
          onOpenProject={(projectId) => {
            navigate(hrefFor('/home'));
            setTarget({ kind: 'project', projectId });
            // A pack saved for the project that is already active needs an explicit restart to be loaded (main.tsx).
            reloadAfterDeviceSave();
          }}
        />
      )}
    </div>
  );
}

function CompanyPanel({ company, projects, relations, packs, activeId, onAddProject, onEditCompany, onDeleteCompany, onEditProject, onDeleteProject, onOpen, onGenerate, onExport, date }: {
  company: Company;
  projects: Project[];
  relations: ProjectRelation[];
  packs: Record<string, ImportedPackMeta>;
  activeId: string | null;
  onAddProject: (name: string, purpose: string) => AddProjectResult;
  onEditCompany: () => void;
  onDeleteCompany: () => void;
  onEditProject: (p: Project) => void;
  onDeleteProject: (p: Project) => void;
  onOpen: (p: Project) => void;
  onGenerate: (p: Project) => void;
  onExport: (p: Project) => void;
  date: (iso: string) => string;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState<string | null>(null);
  const full = projects.length >= MAX_PROJECTS_PER_COMPANY;

  const add = () => {
    const r = onAddProject(name, purpose);
    if (r.ok) {
      setName('');
      setPurpose('');
      setError(null);
    } else {
      setError(t(r.reason === 'limit' ? 'proj.err.limit' : r.reason === 'duplicate' ? 'proj.err.duplicateProject' : r.reason === 'emptyName' ? 'proj.err.required' : 'proj.err.noCompany', { max: MAX_PROJECTS_PER_COMPANY }));
    }
  };
  return (
    <Panel
      title={company.name}
      className="span-full"
      testId={`proj-company-${company.name}`}
      actions={(
        <>
          <Badge appearance="tint">{t('proj.projects.count', { count: projects.length, max: MAX_PROJECTS_PER_COMPANY })}</Badge>
          <Button size="small" icon={<Edit20Regular />} onClick={onEditCompany} aria-label={t('proj.company.editNamed', { name: company.name })} data-testid="proj-company-edit">{t('proj.company.edit')}</Button>
          <Button size="small" icon={<Delete20Regular />} onClick={onDeleteCompany} aria-label={t('proj.projects.deleteNamed', { name: company.name })}>{t('proj.delete')}</Button>
        </>
      )}
    >
      <section className="proj-company-info" aria-labelledby={`proj-company-h-${company.id}`} data-testid="proj-company-profile">
        <h3 id={`proj-company-h-${company.id}`} className="proj-h2">{t('proj.company.title')}</h3>
        <dl className="proj-brief">
          <dt>{t('proj.gen.field.industry')}</dt><dd>{company.industry || <span className="muted">{t('proj.company.unset')}</span>}</dd>
          <dt>{t('proj.gen.field.officialUrl')}</dt>
          <dd>{company.officialUrl ? <a href={company.officialUrl} target="_blank" rel="noreferrer noopener">{company.officialUrl}</a> : <span className="muted">{t('proj.company.unset')}</span>}</dd>
          <dt>{t('proj.company.notes')}</dt><dd className="proj-prewrap">{company.notes || <span className="muted">{t('proj.company.unset')}</span>}</dd>
        </dl>
        <p className="muted">{t('proj.company.shared')}</p>
      </section>

      <h3 className="proj-h2">{t('proj.projects.tableCaption', { company: company.name })}</h3>
      <ScrollRegion label={t('proj.projects.tableCaption', { company: company.name })}>
        <table className="data-table proj-table">
          <caption>{t('proj.projects.tableCaption', { company: company.name })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('proj.projects.projectName')}</th>
              <th scope="col">{t('proj.projects.inputs')}</th>
              <th scope="col">{t('proj.projects.step')}</th>
              <th scope="col">{t('proj.projects.created')}</th>
              <th scope="col">{t('proj.projects.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <tr><td colSpan={5} className="empty">{t('proj.projects.noProjects')}</td></tr>
            )}
            {projects.map((p) => {
              const pack = packs[p.id];
              return (
                <tr key={p.id} className={activeId === p.id ? 'selected' : undefined} data-testid={`proj-row-${p.id}`}>
                  <th scope="row">
                    {p.name}
                    {activeId === p.id && <Badge appearance="filled" color="brand" className="proj-inline-badge">{t('proj.projects.open')}</Badge>}
                    <div>
                      <Badge appearance="tint" color={pack ? 'success' : 'informative'} data-testid={`proj-pack-${p.id}`} data-has-pack={pack ? 'true' : 'false'}>
                        {pack ? t('proj.projects.packDone', { date: date(pack.importedAt.slice(0, 10)) }) : t('proj.projects.packNone')}
                      </Badge>
                    </div>
                  </th>
                  <td><BriefView project={p} /></td>
                  <td>{t(`proj.step.${p.step}`)}</td>
                  <td>{date(p.createdAt.slice(0, 10))}</td>
                  <td>
                    <div className="proj-row">
                      <Button size="small" appearance="primary" icon={<Open20Regular />} onClick={() => onOpen(p)} aria-label={t('proj.projects.openNamed', { name: p.name })}>{t('proj.projects.openShort')}</Button>
                      <Button
                        size="small"
                        icon={<BotSparkle20Regular />}
                        onClick={() => onGenerate(p)}
                        aria-label={t(pack ? 'proj.projects.refetchNamed' : 'proj.gen.buttonNamed', { name: `${company.name}-${p.name}` })}
                        data-testid={`proj-generate-${p.id}`}
                      >
                        {t(pack ? 'proj.ready.refetch' : 'proj.gen.buttonShort')}
                      </Button>
                      <Button size="small" icon={<Edit20Regular />} onClick={() => onEditProject(p)} aria-label={t('proj.edit.named', { name: p.name })} data-testid={`proj-edit-${p.id}`}>{t('proj.edit.short')}</Button>
                      <Button size="small" icon={<ArrowDownload20Regular />} onClick={() => onExport(p)} aria-label={t('proj.projects.exportNamed', { name: p.name })}>{t('proj.projects.exportShort')}</Button>
                      <Button size="small" icon={<Delete20Regular />} onClick={() => onDeleteProject(p)} aria-label={t('proj.projects.deleteNamed', { name: p.name })}>{t('proj.delete')}</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      <form className="proj-form-row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Field
          label={t('proj.projects.newProject')}
          validationMessage={error ?? (full ? t('proj.err.limit', { max: MAX_PROJECTS_PER_COMPANY }) : undefined)}
          validationState={error || full ? 'error' : 'none'}
        >
          <Input value={name} onChange={(_, d) => setName(d.value)} disabled={full} data-testid={`proj-project-name-${company.name}`} />
        </Field>
        <Field label={t('proj.projects.newPurpose')} hint={t('proj.projects.newPurposeHint')} className="grow">
          <Textarea value={purpose} onChange={(_, d) => setPurpose(d.value)} disabled={full} resize="vertical" rows={2} data-testid={`proj-project-purpose-${company.name}`} />
        </Field>
        <Button type="submit" appearance="primary" icon={<Add20Regular />} disabled={full}>{t('proj.projects.addProject')}</Button>
      </form>
      <ProjectRelationsPanel company={company} projects={projects} relations={relations} />
    </Panel>
  );
}

/** Every input of the project, as entered; empty ones are named so it is clear what is still missing. */
function BriefView({ project }: { project: Project }) {
  const { t } = useI18n();
  const b = project.brief ?? {};
  const unset = <span className="muted">{t('proj.company.unset')}</span>;
  return (
    <dl className="proj-brief" data-testid={`proj-brief-${project.id}`}>
      <dt>{t('proj.gen.field.purpose')}</dt>
      <dd className="proj-prewrap" data-testid={`proj-brief-purpose-${project.id}`}>{b.purpose || <span className="proj-missing">{t('proj.projects.purposeMissing')}</span>}</dd>
      <dt>{t('proj.gen.field.focus')}</dt><dd>{b.focus || unset}</dd>
      <dt>{t('proj.gen.field.asOf')}</dt><dd>{b.asOf || unset}</dd>
      <dt>{t('proj.gen.field.materials')}</dt><dd>{b.materialNames?.length ? b.materialNames.join(t('ai.listSep')) : unset}</dd>
      <dt>{t('proj.projects.sources')}</dt>
      <dd>
        {b.useNews === undefined && b.useWorkIq === undefined ? unset : [
          t(b.useNews === false ? 'proj.projects.newsOff' : 'proj.projects.newsOn'),
          b.useWorkIq ? t('proj.projects.workIqOn', { rounds: b.workIqRounds ?? '—' }) : t('proj.projects.workIqOff'),
        ].join(t('ai.listSep'))}
      </dd>
      <dt>{t('proj.gen.field.researchNote')}</dt><dd className="proj-prewrap">{b.researchNote || unset}</dd>
    </dl>
  );
}
