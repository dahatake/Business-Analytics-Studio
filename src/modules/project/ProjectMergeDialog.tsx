import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody,
  Radio, RadioGroup, Textarea,
} from '@fluentui/react-components';
import { ArrowDownload20Regular } from '@fluentui/react-icons';
import { rebindLedgerScope } from '../../ai/client.ts';
import type { ImportedPackMeta } from '../../data/packStore.ts';
import { useI18n } from '../../i18n/index.ts';
import { planRelationMerge, useProjects, type Project, type ProjectRelation } from '../../state/projects.ts';
import { downloadText } from './common.tsx';
import { yyyymmdd } from './exportFormat.ts';
import { exportProject } from './projectFile.ts';
import { mergeBriefs, type MergeAssessment, type MergeReason } from './projectMerge.ts';

/** Saves the project file (FR-139), named after the company, the project and today's date. */
export function downloadProjectFile(projectId: string): boolean {
  const file = exportProject(projectId);
  if (!file) return false;
  downloadText(`${file.company.name}-${file.project.name}-project-${yyyymmdd(new Date())}.json`.replace(/[\\/:*?"<>|\s]+/g, '_'), JSON.stringify(file, null, 2), 'application/json');
  return true;
}

/** One line of evidence, as shown in the warning and kept in the merge record. */
export function useReasonText(): (r: MergeReason) => string {
  const { t, lang, fmt } = useI18n();
  return (r) => {
    if (r.kind === 'sameRelation') return t('proj.merge.reason.sameRelation');
    if (r.kind === 'text') return t('proj.merge.reason.text', { score: fmt.percent(r.similarity ?? 0) });
    return t(`proj.merge.reason.${r.kind}`, { items: r.items.map((i) => (lang === 'ja' ? i.ja : i.en)).join(t('ai.listSep')) });
  };
}

/** The project that stays by default: the one with a customer pack, otherwise the older one. */
export function defaultKeep(a: Project, b: Project, packs: Record<string, ImportedPackMeta>): Project {
  if (!!packs[a.id] !== !!packs[b.id]) return packs[a.id] ? a : b;
  return a.createdAt <= b.createdAt ? a : b;
}

/**
 * Folding one project into another, only after the user saw both side by side, chose which stays, checked the merged
 * purpose, read what will move and what will be deleted, and confirmed they agreed it with the customer.
 */
export function ProjectMergeDialog({ assessment, projects, relations, packs, onClose, onMerged }: {
  assessment: MergeAssessment | null;
  projects: Project[];
  relations: ProjectRelation[];
  packs: Record<string, ImportedPackMeta>;
  onClose: () => void;
  onMerged: (message: string) => void;
}) {
  const { t, fmt } = useI18n();
  const reasonText = useReasonText();
  const pa = projects.find((p) => p.id === assessment?.a);
  const pb = projects.find((p) => p.id === assessment?.b);
  const [keepId, setKeepId] = useState('');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = keepId === pb?.id ? pb : pa;
  const absorb = keep === pa ? pb : pa;
  const proposed = useMemo(
    () => (keep && absorb ? mergeBriefs(keep, absorb, t('proj.merge.heading', { name: absorb.name })) : {}),
    [keep, absorb, t],
  );

  useEffect(() => {
    if (!pa || !pb) return;
    setKeepId(defaultKeep(pa, pb, packs).id);
    setConfirmed(false);
    setError(null);
    // Only when another pair is opened; the store updates while the dialog is open must not reset the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessment?.a, assessment?.b]);
  useEffect(() => {
    if (!keep) return;
    setName(keep.name);
    setPurpose(proposed.purpose ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepId]);

  if (!assessment || !pa || !pb || !keep || !absorb) return null;
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const sentence = (r: ProjectRelation) => t(`proj.rel.sentence.${r.kind}`, { from: nameOf(r.from), to: nameOf(r.to) });
  const plan = planRelationMerge(relations, keep.id, absorb.id);
  const unset = <span className="muted">{t('proj.company.unset')}</span>;
  const packText = (p: Project) => (packs[p.id] ? t('proj.projects.packDone', { date: fmt.date(packs[p.id]!.importedAt.slice(0, 10)) }) : t('proj.projects.packNone'));
  const rows: [string, (p: Project) => ReactNode][] = [
    [t('proj.gen.field.purpose'), (p) => p.brief?.purpose || unset],
    [t('proj.gen.field.focus'), (p) => p.brief?.focus || unset],
    [t('proj.gen.field.asOf'), (p) => p.brief?.asOf || unset],
    [t('proj.gen.field.researchNote'), (p) => p.brief?.researchNote || unset],
    [t('proj.gen.field.materials'), (p) => (p.brief?.materialNames?.length ? p.brief.materialNames.join(t('ai.listSep')) : unset)],
    [t('proj.merge.col.pack'), packText],
    [t('proj.projects.created'), (p) => fmt.date(p.createdAt.slice(0, 10))],
  ];

  const merge = () => {
    const r = useProjects.getState().mergeProjects(keep.id, absorb.id, {
      name,
      brief: { ...proposed, purpose },
      reasons: assessment.reasons.map(reasonText),
      score: assessment.score,
      hadPack: !!packs[absorb.id],
    });
    if (!r.ok) {
      setError(t(r.reason === 'emptyName' ? 'proj.err.required' : r.reason === 'duplicate' ? 'proj.err.duplicateProject' : r.reason === 'notFound' ? 'proj.err.notFound' : 'proj.merge.err.invalid'));
      return;
    }
    rebindLedgerScope(absorb.id, keep.id);
    onMerged(t('proj.merge.done', { absorb: absorb.name, keep: name.trim(), moved: r.moved.length, dropped: r.dropped.length }));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className="proj-merge-surface" data-testid="proj-merge-dialog">
        <form onSubmit={(e) => { e.preventDefault(); if (confirmed) merge(); }}>
          <DialogBody>
            <DialogTitle>{t('proj.merge.title', { a: pa.name, b: pb.name })}</DialogTitle>
            <DialogContent className="proj-edit-form">
              <p>{t('proj.merge.lead', { score: fmt.percent(assessment.score) })}</p>
              <ul className="proj-merge-reasons" data-testid="proj-merge-dialog-reasons">
                {assessment.reasons.map((r) => <li key={r.kind}>{reasonText(r)}</li>)}
              </ul>

              <table className="data-table proj-merge-compare" data-testid="proj-merge-compare">
                <caption>{t('proj.merge.compareCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('proj.merge.col.item')}</th>
                    <th scope="col">{pa.name}</th>
                    <th scope="col">{pb.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, cell]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td className="proj-prewrap">{cell(pa)}</td>
                      <td className="proj-prewrap">{cell(pb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <Field label={t('proj.merge.keep')} hint={t('proj.merge.keepHint')}>
                <RadioGroup value={keep.id} onChange={(_, d) => setKeepId(d.value)} data-testid="proj-merge-keep">
                  {[pa, pb].map((p) => <Radio key={p.id} value={p.id} label={t('proj.merge.keepOption', { name: p.name, pack: packText(p) })} data-testid={`proj-merge-keep-${p.id}`} />)}
                </RadioGroup>
              </Field>
              <Field label={t('proj.merge.name')} required validationState={error ? 'error' : 'none'} validationMessage={error ?? undefined}>
                <Input value={name} onChange={(_, d) => { setName(d.value); setError(null); }} data-testid="proj-merge-name" />
              </Field>
              <Field label={t('proj.merge.purpose')} hint={t('proj.merge.purposeHint', { absorb: absorb.name })}>
                <Textarea value={purpose} onChange={(_, d) => setPurpose(d.value)} resize="vertical" rows={6} data-testid="proj-merge-purpose" />
              </Field>

              <h3 className="proj-h3">{t('proj.merge.effectsTitle')}</h3>
              <ul data-testid="proj-merge-effects">
                <li>{t('proj.merge.effect.inputs', { absorb: absorb.name, keep: keep.name })}</li>
                {plan.moved.length > 0 && <li>{t('proj.merge.effect.moved', { count: plan.moved.length, keep: keep.name })}</li>}
                {plan.dropped.map(({ relation, reason }) => (
                  <li key={relation.id} data-reason={reason}>{t(`proj.merge.effect.dropped.${reason}`, { relation: sentence(relation) })}</li>
                ))}
                <li>{t('proj.merge.effect.history', { keep: keep.name })}</li>
                <li className="proj-merge-loss">{t(packs[absorb.id] ? 'proj.merge.effect.packDeleted' : 'proj.merge.effect.dataDeleted', { absorb: absorb.name })}</li>
                <li>{t(packs[keep.id] ? 'proj.merge.effect.refetch' : 'proj.merge.effect.generate', { keep: keep.name })}</li>
              </ul>
              <div>
                <Button icon={<ArrowDownload20Regular />} onClick={() => downloadProjectFile(absorb.id)} data-testid="proj-merge-backup">
                  {t('proj.merge.backup', { name: absorb.name })}
                </Button>
              </div>
              <Checkbox checked={confirmed} onChange={(_, d) => setConfirmed(!!d.checked)} label={t('proj.merge.confirm')} data-testid="proj-merge-confirm" />
              {!confirmed && <MessageBar intent="info"><MessageBarBody>{t('proj.merge.confirmNeeded')}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button type="submit" appearance="primary" disabled={!confirmed} data-testid="proj-merge-submit">{t('proj.merge.submit', { absorb: absorb.name, keep: keep.name })}</Button>
              <Button type="button" onClick={onClose}>{t('proj.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
