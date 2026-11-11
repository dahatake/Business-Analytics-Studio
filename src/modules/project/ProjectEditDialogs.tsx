import { useEffect, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Textarea,
} from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { useProjects, type Company, type Project } from '../../state/projects.ts';

/** The shared company profile: entered once, used by every project's pack generation. */
export function CompanyEditDialog({ company, onClose }: { company: Company | null; onClose: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [officialUrl, setOfficialUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!company) return;
    setName(company.name);
    setIndustry(company.industry ?? '');
    setOfficialUrl(company.officialUrl ?? '');
    setNotes(company.notes ?? '');
    setError(null);
  }, [company]);
  const save = () => {
    if (!company) return;
    const s = useProjects.getState();
    const r = s.renameCompany(company.id, name);
    if (!r.ok) return setError(t(r.reason === 'emptyName' ? 'proj.err.required' : r.reason === 'notFound' ? 'proj.err.notFound' : 'proj.err.duplicateCompany'));
    s.updateCompanyProfile(company.id, { industry, officialUrl, notes });
    onClose();
  };
  return (
    <Dialog open={company !== null} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface data-testid="proj-company-dialog">
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <DialogBody>
            <DialogTitle>{t('proj.company.editTitle', { name: company?.name ?? '' })}</DialogTitle>
            <DialogContent className="proj-edit-form">
              <p className="muted">{t('proj.company.editLead')}</p>
              <Field label={t('proj.projects.companyName')} required validationState={error ? 'error' : 'none'} validationMessage={error ?? undefined}>
                <Input value={name} onChange={(_, d) => { setName(d.value); setError(null); }} data-testid="proj-company-edit-name" />
              </Field>
              <Field label={t('proj.gen.field.industry')}>
                <Input value={industry} onChange={(_, d) => setIndustry(d.value)} data-testid="proj-company-edit-industry" />
              </Field>
              <Field label={t('proj.gen.field.officialUrl')} hint={t('proj.gen.officialUrlHint')}>
                <Input type="url" value={officialUrl} placeholder="https://www.example.co.jp" onChange={(_, d) => setOfficialUrl(d.value)} data-testid="proj-company-edit-url" />
              </Field>
              <Field label={t('proj.company.notes')} hint={t('proj.company.notesHint')}>
                <Textarea value={notes} onChange={(_, d) => setNotes(d.value)} resize="vertical" rows={4} data-testid="proj-company-edit-notes" />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button type="submit" appearance="primary" data-testid="proj-company-edit-save">{t('proj.save')}</Button>
              <Button type="button" onClick={onClose}>{t('proj.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/** Everything the project is about; pack generation and re-fetching start from these values. */
export function ProjectEditDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const { t } = useI18n();
  const companies = useProjects((s) => s.companies);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [focus, setFocus] = useState('');
  const [asOf, setAsOf] = useState('');
  const [researchNote, setResearchNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setPurpose(project.brief?.purpose ?? '');
    setFocus(project.brief?.focus ?? '');
    setAsOf(project.brief?.asOf ?? '');
    setResearchNote(project.brief?.researchNote ?? '');
    setError(null);
  }, [project]);
  const save = () => {
    if (!project) return;
    const s = useProjects.getState();
    const r = s.renameProject(project.id, name);
    if (!r.ok) return setError(t(r.reason === 'emptyName' ? 'proj.err.required' : r.reason === 'notFound' ? 'proj.err.notFound' : 'proj.err.duplicateProject'));
    s.updateProjectBrief(project.id, { purpose, focus, asOf, researchNote });
    onClose();
  };
  const company = project ? companies.find((c) => c.id === project.companyId)?.name ?? '' : '';
  return (
    <Dialog open={project !== null} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface data-testid="proj-edit-dialog">
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <DialogBody>
            <DialogTitle>{t('proj.edit.title', { name: `${company} / ${project?.name ?? ''}` })}</DialogTitle>
            <DialogContent className="proj-edit-form">
              <p className="muted">{t('proj.edit.lead')}</p>
              <Field label={t('proj.projects.projectName')} required validationState={error ? 'error' : 'none'} validationMessage={error ?? undefined}>
                <Input value={name} onChange={(_, d) => { setName(d.value); setError(null); }} data-testid="proj-edit-name" />
              </Field>
              <Field label={t('proj.gen.field.purpose')} hint={t('proj.gen.purposeHint')}>
                <Textarea value={purpose} onChange={(_, d) => setPurpose(d.value)} resize="vertical" rows={5} data-testid="proj-edit-purpose" />
              </Field>
              <Field label={t('proj.gen.field.focus')}>
                <Input value={focus} onChange={(_, d) => setFocus(d.value)} data-testid="proj-edit-focus" />
              </Field>
              <Field label={t('proj.gen.field.asOf')}>
                <Input type="date" value={asOf} onChange={(_, d) => setAsOf(d.value)} data-testid="proj-edit-asof" />
              </Field>
              <Field label={t('proj.gen.field.researchNote')} hint={t('proj.gen.researchNoteHint')}>
                <Textarea value={researchNote} onChange={(_, d) => setResearchNote(d.value)} resize="vertical" rows={3} data-testid="proj-edit-note" />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button type="submit" appearance="primary" data-testid="proj-edit-save">{t('proj.save')}</Button>
              <Button type="button" onClick={onClose}>{t('proj.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
