import { useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody,
  Radio, RadioGroup,
} from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { personaLabel } from '../../state/personas.ts';
import { loc } from '../../state/text.ts';
import { defaultChoices, unresolvedIds, type CandidateStatus, type UseCaseCandidate, type UseCaseChoices } from './useCaseImport.ts';

const STATUS_COLOR: Record<CandidateStatus, 'brand' | 'warning' | 'informative'> = { new: 'brand', changed: 'warning', identical: 'informative' };

/** I-1: use cases found in a restored export are offered as candidates; nothing is overwritten without a choice. */
export function UseCaseImportDialog({ candidates, onApply, onSkip }: {
  candidates: UseCaseCandidate[] | null;
  onApply: (choices: UseCaseChoices) => void;
  onSkip: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={!!candidates} onOpenChange={(_, d) => { if (!d.open) onSkip(); }}>
      {candidates ? <Surface candidates={candidates} onApply={onApply} onSkip={onSkip} /> : <DialogSurface aria-label={t('proj.ucImport.title')} />}
    </Dialog>
  );
}

function Surface({ candidates, onApply, onSkip }: { candidates: UseCaseCandidate[]; onApply: (c: UseCaseChoices) => void; onSkip: () => void }) {
  const { t, lang } = useI18n();
  const [choices, setChoices] = useState<UseCaseChoices>(() => defaultChoices(candidates));
  const pending = unresolvedIds(candidates, choices);
  const count = (s: CandidateStatus) => candidates.filter((c) => c.status === s).length;
  const choose = (id: string, v: UseCaseChoices[string]) => setChoices((p) => ({ ...p, [id]: v }));
  const sep = lang === 'ja' ? '、' : ', ';

  return (
    <DialogSurface className="proj-uc-import-surface" data-testid="proj-uc-import-dialog" aria-describedby="proj-uc-import-intro">
      <DialogBody>
        <DialogTitle>{t('proj.ucImport.title')}</DialogTitle>
        <DialogContent>
          <p id="proj-uc-import-intro">{t('proj.ucImport.intro', { new: count('new'), changed: count('changed'), identical: count('identical') })}</p>
          <ul className="proj-uc-import-list">
            {candidates.map((c) => {
              const id = c.incoming.id;
              const nameId = `proj-uc-cand-name-${id}`;
              const currentName = c.current ? loc(c.current.name, lang) : '';
              const incomingName = loc(c.incoming.name, lang);
              return (
                <li key={id} className="proj-uc-import-item" data-testid={`proj-uc-cand-${id}`} data-status={c.status}>
                  <div className="proj-uc-import-head">
                    <span id={nameId} className="proj-uc-import-name">{incomingName}</span>
                    <Badge appearance="tint" color={STATUS_COLOR[c.status]} data-testid={`proj-uc-cand-status-${id}`}>{t(`proj.ucImport.status.${c.status}`)}</Badge>
                  </div>
                  <p className="proj-uc-import-meta">{t('proj.ucImport.persona', { persona: t(personaLabel(c.incoming.persona)) })}</p>
                  {c.status === 'new' && (
                    <Checkbox
                      checked={choices[id] === 'add'}
                      onChange={(_, d) => choose(id, d.checked ? 'add' : 'skip')}
                      label={t('proj.ucImport.add')}
                      aria-describedby={nameId}
                      data-testid={`proj-uc-cand-add-${id}`}
                    />
                  )}
                  {c.status === 'changed' && (
                    <>
                      <p className="proj-uc-import-meta">{t('proj.ucImport.changedFields', { fields: c.changedFields.map((f) => t(`proj.ucImport.field.${f}`)).join(sep) })}</p>
                      {currentName !== incomingName && <p className="proj-uc-import-meta">{t('proj.ucImport.currentName', { name: currentName })}</p>}
                      <RadioGroup
                        aria-labelledby={nameId}
                        value={choices[id] ?? ''}
                        onChange={(_, d) => choose(id, d.value === 'replace' ? 'replace' : 'keep')}
                        data-testid={`proj-uc-cand-choice-${id}`}
                      >
                        <Radio value="replace" label={t('proj.ucImport.replace')} />
                        <Radio value="keep" label={t('proj.ucImport.keep')} />
                      </RadioGroup>
                    </>
                  )}
                  {c.status === 'identical' && <p className="proj-uc-import-meta">{t('proj.ucImport.identicalNote')}</p>}
                </li>
              );
            })}
          </ul>
          {pending.length > 0 && (
            <MessageBar intent="warning" layout="multiline" data-testid="proj-uc-import-pending">
              <MessageBarBody>{t('proj.ucImport.pending', { count: pending.length })}</MessageBarBody>
            </MessageBar>
          )}
        </DialogContent>
        <DialogActions>
          <Button appearance="primary" disabled={pending.length > 0} onClick={() => onApply(choices)} data-testid="proj-uc-import-apply">{t('proj.ucImport.apply')}</Button>
          <Button appearance="secondary" onClick={onSkip} data-testid="proj-uc-import-skip">{t('proj.ucImport.skip')}</Button>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  );
}
