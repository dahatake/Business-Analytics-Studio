import { useEffect, useRef, type KeyboardEvent } from 'react';
import {
  Button, Menu, MenuButton, MenuDivider, MenuGroup, MenuGroupHeader, MenuItem, MenuItemRadio, MenuList, MenuPopover, MenuTrigger,
  Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
} from '@fluentui/react-components';
import { ArrowDownload20Regular, Briefcase20Regular, CheckmarkCircle20Filled } from '@fluentui/react-icons';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { IMPROVEMENT_STEPS, useActiveProject, useProjects } from '../../state/projects.ts';
import { navigate, hrefFor, useRoute } from '../../state/router.ts';
import { ExportDialog } from './ExportDialog.tsx';
import { DraftDialog, StepTodoBand, useCheckContext } from './deliverablesUi.tsx';
import { evaluateStep, progressOf } from './deliverables.ts';
import { useProjTransient, useProjUi } from './stores.ts';
import './project.css';

export { StepTodoBand as StepBand };

/** FR-148 / FR-176: the work-target menu (demo or company → project) at the top of every screen. */
function WorkTargetMenu() {
  const { t, lang } = useI18n();
  const companies = useProjects((s) => s.companies);
  const projects = useProjects((s) => s.projects);
  const target = useProjects((s) => s.target);
  const setTarget = useProjects((s) => s.setTarget);
  const { project, company } = useActiveProject();
  const value = target.kind === 'demo' ? 'demo' : target.projectId;
  const label = target.kind === 'demo' || !project ? t('proj.target.demo') : `${company?.name ?? ''}-${project.name}`;
  return (
    <Menu
      checkedValues={{ target: [value] }}
      onCheckedValueChange={(_, d) => {
        const v = d.checkedItems[0];
        if (!v) return;
        setTarget(v === 'demo' ? { kind: 'demo' } : { kind: 'project', projectId: v });
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <MenuButton appearance="subtle" icon={<Briefcase20Regular />} data-testid="proj-target-menu" className="proj-target-button">
          <span className="proj-target-prefix">{t('proj.target.label')}</span>
          <span className="proj-target-name">{label}</span>
        </MenuButton>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItemRadio name="target" value="demo">{t('proj.target.demoItem', { company: loaded.pack.company.name[lang] })}</MenuItemRadio>
          {companies.map((c) => {
            const list = projects.filter((p) => p.companyId === c.id);
            return (
              <MenuGroup key={c.id}>
                <MenuDivider />
                <MenuGroupHeader>{c.name}</MenuGroupHeader>
                {list.length === 0 && <MenuItem disabled>{t('proj.target.noProjects')}</MenuItem>}
                {list.map((p) => (
                  <MenuItemRadio key={p.id} name="target" value={p.id}>{p.name}</MenuItemRadio>
                ))}
              </MenuGroup>
            );
          })}
          <MenuDivider />
          <MenuItem onClick={() => navigate(hrefFor('/projects'))}>{t('proj.target.manage')}</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/** FR-136 / G-006: the five improvement steps (PARAM-030), current step marked, keyboard operable, ≥ 44 px (PARAM-086). */
function Stepper() {
  const { t } = useI18n();
  const { step } = useActiveProject();
  const setStep = useProjects((s) => s.setStep);
  const ctx = useCheckContext();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = IMPROVEMENT_STEPS.indexOf(step);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? IMPROVEMENT_STEPS.length - 1 : -1;
    if (next < 0 || next >= IMPROVEMENT_STEPS.length) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };
  return (
    <nav className="proj-stepper" aria-label={t('proj.stepper.label')} data-testid="proj-stepper">
      <ol>
        {IMPROVEMENT_STEPS.map((s, i) => {
          const isCurrent = i === current;
          const complete = progressOf(evaluateStep(s, ctx)).complete;
          return (
            <li key={s} className={complete ? 'done' : undefined}>
              <button
                ref={(el) => { refs.current[i] = el; }}
                type="button"
                className="proj-step"
                aria-current={isCurrent ? 'step' : undefined}
                data-step={s}
                data-complete={complete}
                title={`${i + 1} ${t(`proj.step.${s}`)}${complete ? ` — ${t('dlv.status.done')}` : ''}`}
                onClick={() => setStep(s)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <span className="proj-step-num">{i + 1}</span>{' '}
                <span className={isCurrent ? 'proj-step-label' : 'visually-hidden'}>{t(`proj.step.${s}`)}</span>
                {complete && <><CheckmarkCircle20Filled aria-hidden className="proj-step-check" /><span className="visually-hidden">{t('dlv.status.done')}</span></>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ExportButton() {
  const { t } = useI18n();
  const openExport = useProjTransient((s) => s.openExport);
  return (
    <Button appearance="subtle" icon={<ArrowDownload20Regular />} aria-keyshortcuts="Control+Shift+E" onClick={() => openExport(null)} data-testid="proj-export-all">
      {t('proj.export.button')}
    </Button>
  );
}

export function TopBarSlot() {
  return (
    <div className="proj-topbar">
      <WorkTargetMenu />
      <Stepper />
      <ExportButton />
    </div>
  );
}

/** FR-267 / FR-144: on the main screen, the first launch asks whether to try the demo or start a real project. */
function FirstRunDialog() {
  const { t } = useI18n();
  const route = useRoute();
  const done = useProjUi((s) => s.firstRunDone);
  const setDone = useProjUi((s) => s.setFirstRunDone);
  const setTarget = useProjects((s) => s.setTarget);
  const open = route.path === '/home' && !done;
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) setDone(true); }}>
      <DialogSurface data-testid="proj-first-run">
        <DialogBody>
          <DialogTitle>{t('proj.firstRun.title')}</DialogTitle>
          <DialogContent>
            <p>{t('proj.firstRun.body')}</p>
            <ol className="proj-first-run-steps">
              <li>{t('proj.quick.company')}</li>
              <li>{t('proj.quick.project')}</li>
              <li>{t('proj.quick.analysis')}</li>
            </ol>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={() => { setTarget({ kind: 'demo' }); setDone(true); }}>{t('proj.firstRun.demo')}</Button>
            <Button appearance="secondary" onClick={() => { setDone(true); navigate(hrefFor('/projects')); }}>{t('proj.firstRun.real')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function Overlay() {
  const openExport = useProjTransient((s) => s.openExport);
  useEffect(() => {
    // FR-052: Ctrl+Shift+E opens the full export from anywhere.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        openExport(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openExport]);
  return (
    <>
      <ExportDialog />
      <FirstRunDialog />
      <DraftDialog />
    </>
  );
}
