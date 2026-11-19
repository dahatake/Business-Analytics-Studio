import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, MessageBar, MessageBarBody, Radio, RadioGroup,
} from '@fluentui/react-components';
import type { CompanyLayerDiff, CompanyMergePolicy } from '../../data/packLayers.ts';
import { importedPacks } from '../../data/packStore.ts';
import { useI18n } from '../../i18n/index.ts';
import { useProjects } from '../../state/projects.ts';
import type { ProjectPackPreview } from './projectFile.ts';

/** FR-346: what an import does to the company's shared data, and the user's choice for same-id conflicts. */
export function SharedDataMerge({ diff, companyId, companyName, policy, onPolicy }: {
  diff: CompanyLayerDiff | null;
  companyId: string | undefined;
  companyName: string;
  policy: CompanyMergePolicy;
  onPolicy: (policy: CompanyMergePolicy) => void;
}) {
  const { t } = useI18n();
  const projects = useProjects((s) => s.projects);
  if (!diff) return <p data-testid="pack-shared">{t('proj.pack.sharedNew')}</p>;
  const packs = importedPacks();
  const sharing = projects.filter((p) => p.companyId === companyId && packs[p.id]).length;
  return (
    <div data-testid="pack-shared">
      <p>{t('proj.pack.sharedSummary', { company: companyName, projects: sharing, added: diff.added.length, identical: diff.identical, differing: diff.differing.length })}</p>
      {diff.differingOther.length > 0 && <p>{t('proj.pack.sharedOther', { items: diff.differingOther.map((k) => t(`proj.pack.sharedPart.${k}`)).join(t('ai.listSep')) })}</p>}
      {(diff.differing.length > 0 || diff.differingOther.length > 0) && (
        <Field label={t('proj.pack.sharedPolicy')}>
          <RadioGroup value={policy} onChange={(_, d) => onPolicy(d.value as CompanyMergePolicy)} data-testid="pack-shared-policy">
            <Radio value="keep" label={t('proj.pack.sharedKeep')} />
            <Radio value="incoming" label={t('proj.pack.sharedIncoming')} />
          </RadioGroup>
        </Field>
      )}
      {diff.possibleDuplicates.length > 0 && (
        <MessageBar intent="warning"><MessageBarBody>
          {t('proj.pack.sharedDuplicates', { count: diff.possibleDuplicates.length, items: diff.possibleDuplicates.map((d) => `${d.id} ≈ ${d.existingId}`).join(t('ai.listSep')) })}
        </MessageBarBody></MessageBar>
      )}
    </div>
  );
}

/** FR-346: nothing is written before the user saw where the company and the project go and what they contain. */
export function ProjectPackImportDialog({ preview, onApply, onCancel }: {
  preview: ProjectPackPreview | null;
  onApply: (policy: CompanyMergePolicy) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<CompanyMergePolicy>('keep');
  const [busy, setBusy] = useState(false);
  if (!preview) return null;
  const { counts } = preview;
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onCancel(); }}>
      <DialogSurface data-testid="proj-pack-import-dialog">
        <DialogBody>
          <DialogTitle>{t('proj.packFile.title')}</DialogTitle>
          <DialogContent className="proj-edit-form">
            <dl className="meta-list">
              <div><dt>{t('proj.packFile.company')}</dt><dd data-testid="proj-pack-import-company">{preview.companyName}</dd></div>
              <div><dt>{t('proj.packFile.project')}</dt><dd data-testid="proj-pack-import-project">{preview.projectName}</dd></div>
            </dl>
            <p data-testid="proj-pack-import-match" data-match={preview.companyMatch}>{t(`proj.packFile.match.${preview.companyMatch}`)}</p>
            {preview.legacy && <MessageBar intent="info"><MessageBarBody>{t('proj.packFile.legacy')}</MessageBarBody></MessageBar>}
            <p data-testid="proj-pack-import-counts">{t('proj.packFile.counts', counts)}</p>
            {(counts.internal > 0 || counts.people > 0) && (
              <MessageBar intent="warning"><MessageBarBody>{t('proj.packFile.sensitive', counts)}</MessageBarBody></MessageBar>
            )}
            <h3 className="proj-h2">{t('proj.pack.sharedTitle')}</h3>
            <SharedDataMerge diff={preview.sharedDiff} companyId={preview.companyId} companyName={preview.companyName} policy={policy} onPolicy={setPolicy} />
            {preview.anchorSkipped && <p>{t('proj.anchor.importSkipped')}</p>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy} onClick={() => { setBusy(true); onApply(policy); }} data-testid="proj-pack-import-apply">{t('proj.packFile.apply')}</Button>
            <Button disabled={busy} onClick={onCancel}>{t('proj.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
