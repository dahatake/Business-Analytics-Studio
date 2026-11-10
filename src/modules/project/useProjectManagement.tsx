import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input,
} from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { useProjects, type Company, type Project } from '../../state/projects.ts';
import { ConfirmDialog } from './common.tsx';

type Item = { kind: 'company'; item: Company } | { kind: 'project'; item: Project };
type Pending = Item & { action: 'rename' | 'delete' };

export function useProjectManagement() {
  const { t } = useI18n();
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const projects = useProjects((s) => s.projects);
  const companies = useProjects((s) => s.companies);
  const close = () => setPending(null);
  const start = (action: Pending['action'], item: Item) => {
    setName(item.item.name);
    setError(null);
    setPending({ ...item, action });
  };
  const save = () => {
    if (!pending) return;
    const state = useProjects.getState();
    const result = pending.kind === 'company'
      ? state.renameCompany(pending.item.id, name)
      : state.renameProject(pending.item.id, name);
    if (result.ok) close();
    else setError(t(result.reason === 'emptyName' ? 'proj.err.required'
      : result.reason === 'notFound' ? 'proj.err.notFound'
      : pending.kind === 'company' ? 'proj.err.duplicateCompany' : 'proj.err.duplicateProject'));
  };
  const qualifiedName = pending?.kind === 'project'
    ? `${companies.find((c) => c.id === pending.item.companyId)?.name ?? ''} / ${pending.item.name}`
    : pending?.item.name ?? '';

  return {
    renameCompany: (item: Company) => start('rename', { kind: 'company', item }),
    renameProject: (item: Project) => start('rename', { kind: 'project', item }),
    deleteCompany: (item: Company) => start('delete', { kind: 'company', item }),
    deleteProject: (item: Project) => start('delete', { kind: 'project', item }),
    dialogs: (
      <>
        <Dialog open={pending?.action === 'rename'} onOpenChange={(_, d) => { if (!d.open) close(); }}>
          <DialogSurface data-testid="proj-rename-dialog">
            <form onSubmit={(e) => { e.preventDefault(); save(); }}>
              <DialogBody>
                <DialogTitle>{t('proj.projects.renameNamed', { name: qualifiedName })}</DialogTitle>
                <DialogContent>
                  <Field
                    label={t(pending?.kind === 'company' ? 'proj.projects.companyName' : 'proj.projects.projectName')}
                    validationState={error ? 'error' : 'none'}
                    validationMessage={error ?? undefined}
                  >
                    <Input value={name} onChange={(_, d) => { setName(d.value); setError(null); }} />
                  </Field>
                </DialogContent>
                <DialogActions>
                  <Button type="submit" appearance="primary">{t('proj.save')}</Button>
                  <Button type="button" onClick={close}>{t('proj.cancel')}</Button>
                </DialogActions>
              </DialogBody>
            </form>
          </DialogSurface>
        </Dialog>
        <ConfirmDialog
          open={pending?.action === 'delete'}
          title={t(pending?.kind === 'company' ? 'proj.projects.deleteCompanyTitle' : 'proj.projects.deleteProjectTitle')}
          body={pending ? t(pending.kind === 'company' ? 'proj.projects.deleteCompanyBody' : 'proj.projects.deleteProjectBody', {
            name: qualifiedName,
            count: projects.filter((p) => p.companyId === pending.item.id).length,
          }) : ''}
          confirmLabel={t('proj.delete')}
          onConfirm={() => {
            if (pending?.kind === 'company') useProjects.getState().deleteCompany(pending.item.id);
            else if (pending?.kind === 'project') useProjects.getState().deleteProject(pending.item.id);
            close();
          }}
          onCancel={close}
          testId="proj-delete-confirm"
        />
      </>
    ),
  };
}
