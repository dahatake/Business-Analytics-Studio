import type { ReactNode } from 'react';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
} from '@fluentui/react-components';
import { ArrowLeft20Regular } from '@fluentui/react-icons';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { hrefFor } from '../../state/router.ts';
import { useActiveProject, useProjects } from '../../state/projects.ts';
import './project.css';

/** FR-187: on analysis screens, a button that returns to the main screen. Other modules may reuse it. */
export function BackToHome() {
  const { t } = useI18n();
  return (
    <Button as="a" href={hrefFor('/home')} appearance="secondary" icon={<ArrowLeft20Regular />} data-testid="back-to-home">
      {t('proj.backHome')}
    </Button>
  );
}

/** A horizontally scrollable table wrapper that keyboard users can scroll (focusable region). */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  return <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>{children}</div>;
}

export function MockBadge() {
  const { t } = useI18n();
  return <Badge appearance="outline" color="warning">{t('proj.mock')}</Badge>;
}

/** FR-050: customer decisions (human) and AI suggestions are always told apart. */
export function AuthorBadge({ author, mock, decision }: { author: 'human' | 'ai' | 'sample'; mock?: boolean | undefined; decision?: boolean }) {
  const { t } = useI18n();
  if (author === 'sample') return <Badge appearance="tint" color="informative">{t('badge.sample')}</Badge>;
  return (
    <span className="proj-badges">
      <Badge appearance="filled" color={author === 'ai' ? 'important' : 'brand'}>{t(author === 'ai' ? 'proj.author.ai' : decision ? 'proj.author.human' : 'proj.author.person')}</Badge>
      {author === 'ai' && mock && <MockBadge />}
    </span>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel, testId }: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} modalType="alert" onOpenChange={(_, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface data-testid={testId}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>{body}</DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onConfirm}>{confirmLabel}</Button>
            <Button appearance="secondary" onClick={onCancel}>{t('proj.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Company and project names of the current work target (demo = sample pack company + "Demo"). */
export function useTargetNames(): { company: string; project: string; isDemo: boolean } {
  const { t, lang } = useI18n();
  const { project, company } = useActiveProject();
  const isDemo = useProjects((s) => s.target.kind === 'demo');
  if (isDemo || !project) return { company: loaded.pack.company.name[lang], project: t('proj.demo'), isDemo: true };
  return { company: company?.name ?? '', project: project.name, isDemo: false };
}

export function downloadText(fileName: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
