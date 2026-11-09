import { useRef, useState } from 'react';
import { Badge, Button, Field, Input, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { Add20Regular, ArrowDownload20Regular, ArrowUpload20Regular, Delete20Regular, Edit20Regular, Open20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { MAX_PROJECTS_PER_COMPANY, useProjects, type AddProjectResult, type Company, type Project } from '../../state/projects.ts';
import { BackToHome, ConfirmDialog, downloadText, ScrollRegion } from './common.tsx';
import { exportProject, importProject, type ProjectFile } from './projectFile.ts';
import { yyyymmdd } from './exportFormat.ts';
import './project.css';

type Pending = { kind: 'company'; item: Company } | { kind: 'project'; item: Project } | null;

/** FR-137〜FR-139: register companies, manage up to PARAM-031 projects each, export/import a project with its ids. */
export function ProjectsScreen() {
  const { t, fmt } = useI18n();
  const companies = useProjects((s) => s.companies);
  const projects = useProjects((s) => s.projects);
  const target = useProjects((s) => s.target);
  const { addCompany, addProject, renameCompany, renameProject, deleteCompany, deleteProject, setTarget } = useProjects.getState();
  const [companyName, setCompanyName] = useState('');
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="screen proj-screen">
      <PageHeader
        title={t('proj.title')}
        subtitle={t('proj.projects.subtitle', { max: MAX_PROJECTS_PER_COMPANY })}
        actions={(
          <>
            <BackToHome />
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
          activeId={target.kind === 'project' ? target.projectId : null}
          onAddProject={(name) => addProject(c.id, name)}
          onRenameCompany={(name) => renameCompany(c.id, name)}
          onDeleteCompany={() => setPending({ kind: 'company', item: c })}
          onRenameProject={renameProject}
          onDeleteProject={(p) => setPending({ kind: 'project', item: p })}
          onOpen={(p) => setTarget({ kind: 'project', projectId: p.id })}
          onExport={onExport}
          date={fmt.date}
        />
      ))}
      <ConfirmDialog
        open={pending !== null}
        title={t(pending?.kind === 'company' ? 'proj.projects.deleteCompanyTitle' : 'proj.projects.deleteProjectTitle')}
        body={pending ? t(pending.kind === 'company' ? 'proj.projects.deleteCompanyBody' : 'proj.projects.deleteProjectBody', { name: pending.item.name }) : ''}
        confirmLabel={t('proj.delete')}
        onConfirm={() => {
          if (pending?.kind === 'company') deleteCompany(pending.item.id);
          else if (pending?.kind === 'project') deleteProject(pending.item.id);
          setPending(null);
        }}
        onCancel={() => setPending(null)}
        testId="proj-delete-confirm"
      />
    </div>
  );
}

function CompanyPanel({ company, projects, activeId, onAddProject, onRenameCompany, onDeleteCompany, onRenameProject, onDeleteProject, onOpen, onExport, date }: {
  company: Company;
  projects: Project[];
  activeId: string | null;
  onAddProject: (name: string) => AddProjectResult;
  onRenameCompany: (name: string) => void;
  onDeleteCompany: () => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (p: Project) => void;
  onOpen: (p: Project) => void;
  onExport: (p: Project) => void;
  date: (iso: string) => string;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const full = projects.length >= MAX_PROJECTS_PER_COMPANY;

  const add = () => {
    const r = onAddProject(name);
    if (r.ok) {
      setName('');
      setError(null);
    } else {
      setError(t(r.reason === 'limit' ? 'proj.err.limit' : r.reason === 'duplicate' ? 'proj.err.duplicateProject' : r.reason === 'emptyName' ? 'proj.err.required' : 'proj.err.noCompany', { max: MAX_PROJECTS_PER_COMPANY }));
    }
  };
  const startRename = (id: string, current: string) => {
    setRenaming(id);
    setRenameValue(current);
  };
  const commitRename = () => {
    if (!renaming || !renameValue.trim()) return setRenaming(null);
    if (renaming === company.id) onRenameCompany(renameValue);
    else onRenameProject(renaming, renameValue);
    setRenaming(null);
  };

  return (
    <Panel
      title={company.name}
      className="span-full"
      testId={`proj-company-${company.name}`}
      actions={(
        <>
          <Badge appearance="tint">{t('proj.projects.count', { count: projects.length, max: MAX_PROJECTS_PER_COMPANY })}</Badge>
          <Button size="small" icon={<Edit20Regular />} onClick={() => startRename(company.id, company.name)}>{t('proj.rename')}</Button>
          <Button size="small" icon={<Delete20Regular />} onClick={onDeleteCompany}>{t('proj.delete')}</Button>
        </>
      )}
    >
      {renaming === company.id && (
        <form className="proj-form-row" onSubmit={(e) => { e.preventDefault(); commitRename(); }}>
          <Field label={t('proj.projects.companyName')}><Input value={renameValue} onChange={(_, d) => setRenameValue(d.value)} /></Field>
          <Button type="submit" appearance="primary">{t('proj.save')}</Button>
          <Button onClick={() => setRenaming(null)}>{t('proj.cancel')}</Button>
        </form>
      )}
      <ScrollRegion label={t('proj.projects.tableCaption', { company: company.name })}>
        <table className="data-table">
          <caption>{t('proj.projects.tableCaption', { company: company.name })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('proj.projects.projectName')}</th>
              <th scope="col">{t('proj.projects.step')}</th>
              <th scope="col">{t('proj.projects.created')}</th>
              <th scope="col">{t('proj.projects.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <tr><td colSpan={4} className="empty">{t('proj.projects.noProjects')}</td></tr>
            )}
            {projects.map((p) => (
              <tr key={p.id} className={activeId === p.id ? 'selected' : undefined}>
                <th scope="row">
                  {renaming === p.id ? (
                    <form className="proj-form-row" onSubmit={(e) => { e.preventDefault(); commitRename(); }}>
                      <Input aria-label={t('proj.projects.projectName')} value={renameValue} onChange={(_, d) => setRenameValue(d.value)} />
                      <Button type="submit" size="small" appearance="primary">{t('proj.save')}</Button>
                    </form>
                  ) : p.name}
                  {activeId === p.id && <Badge appearance="filled" color="brand" className="proj-inline-badge">{t('proj.projects.open')}</Badge>}
                </th>
                <td>{t(`proj.step.${p.step}`)}</td>
                <td>{date(p.createdAt.slice(0, 10))}</td>
                <td>
                  <div className="proj-row">
                    <Button size="small" appearance="primary" icon={<Open20Regular />} onClick={() => onOpen(p)} aria-label={t('proj.projects.openNamed', { name: p.name })}>{t('proj.projects.openShort')}</Button>
                    <Button size="small" icon={<Edit20Regular />} onClick={() => startRename(p.id, p.name)} aria-label={t('proj.projects.renameNamed', { name: p.name })}>{t('proj.rename')}</Button>
                    <Button size="small" icon={<ArrowDownload20Regular />} onClick={() => onExport(p)} aria-label={t('proj.projects.exportNamed', { name: p.name })}>{t('proj.projects.exportShort')}</Button>
                    <Button size="small" icon={<Delete20Regular />} onClick={() => onDeleteProject(p)} aria-label={t('proj.projects.deleteNamed', { name: p.name })}>{t('proj.delete')}</Button>
                  </div>
                </td>
              </tr>
            ))}
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
        <Button type="submit" appearance="primary" icon={<Add20Regular />} disabled={full}>{t('proj.projects.addProject')}</Button>
      </form>
    </Panel>
  );
}
