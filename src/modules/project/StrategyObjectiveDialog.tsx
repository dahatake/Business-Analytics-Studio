import { useEffect, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Select, Textarea,
} from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { latestCompanyAnchor } from '../../state/companyAnchors.ts';
import { useProjects, type Company } from '../../state/projects.ts';
import { todayIn } from './deliverablesUi.tsx';
import type { ObjectiveDraft } from './objectiveDraft.ts';
import { appendObjective, type ObjectiveBasis, type ObjectiveField, type ObjectiveInput, type ObjectiveScope } from './strategyPortal.ts';

const SCOPES: ObjectiveScope[] = ['legalEntity', 'group', 'business', 'department'];
const BASES: ObjectiveBasis[] = ['published', 'customerStated'];

const blank = (today: string): ObjectiveInput => ({
  text: '', horizon: '', basis: 'customerStated', scope: 'legalEntity', scopeName: '',
  source: { title: '', type: 'internal', url: '', locator: '', accessedDate: today, excerpt: '' },
});

/**
 * FR-347: company objectives have no form of their own (the company anchor is edited as JSON), so the strategy map adds
 * one in a popup. Every objective keeps a source (company anchor schema), and saving creates a new anchor version.
 */
export function ObjectiveDialog({ company, draft, note = null, onClose }: {
  company: Company; draft: ObjectiveInput | null; note?: ObjectiveDraft | null; onClose: (savedId?: string, discarded?: boolean) => void;
}) {
  const { t } = useI18n();
  const today = todayIn();
  const [form, setForm] = useState<ObjectiveInput>(() => draft ? { ...draft, source: { ...draft.source, accessedDate: draft.source.accessedDate || today } } : blank(today));
  const [errors, setErrors] = useState<ObjectiveField[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { setErrors([]); setFailure(null); }, [draft]);
  const set = (patch: Partial<ObjectiveInput>) => setForm((f) => ({ ...f, ...patch }));
  const setSource = (patch: Partial<ObjectiveInput['source']>) => setForm((f) => ({ ...f, source: { ...f.source, ...patch } }));
  const err = (field: ObjectiveField) => errors.includes(field) ? { validationState: 'error' as const, validationMessage: t(`stg.obj.err.${field}`) } : {};
  const save = () => {
    // A published objective cites a public document (with its URL); a customer statement cites an internal record.
    const input = { ...form, source: { ...form.source, type: form.basis === 'published' ? 'public' as const : 'internal' as const } };
    try {
      const result = appendObjective(latestCompanyAnchor(company.id)?.anchor ?? null, input, company.name, today);
      if (!result.ok) { setErrors(result.errors); return; }
      const saved = useProjects.getState().setCompanyAnchor(company.id, result.anchor);
      if (!saved.ok) throw new Error(saved.reason);
      onClose(result.id);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface aria-describedby="stg-obj-lead">
        <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }} data-testid="strategy-objective-dialog">
          <DialogBody>
            <DialogTitle>{t(draft ? 'stg.obj.titleDraft' : 'stg.obj.title')}</DialogTitle>
            <DialogContent className="proj-edit-form">
              <p id="stg-obj-lead" className="muted">{t('stg.obj.lead', { company: company.name })}</p>
              {draft && <p className="muted">{t('stg.obj.fromDraft')}</p>}
              {note && (
                <MessageBar intent="warning" data-testid="strategy-objective-tier">
                  <MessageBarBody>
                    <strong>{t(`stg.obj.tier.${note.tier}`)}</strong> {note.reason}
                    {note.unverified.length > 0 && <> {t('stg.obj.unverified', { numbers: note.unverified.join(', ') })}</>}
                    {note.evidence.length > 0 && <ul>{note.evidence.map((e) => <li key={e.ref}>{e.title}{e.excerpt && <> — “{e.excerpt}”</>}</li>)}</ul>}
                  </MessageBarBody>
                </MessageBar>
              )}
              <Field label={t('stg.obj.text')} required {...err('text')}>
                <Textarea value={form.text} onChange={(_, d) => set({ text: d.value })} data-testid="strategy-objective-text" />
              </Field>
              <Field label={t('stg.obj.horizon')} hint={t('stg.obj.horizonHint')} required {...err('horizon')}>
                <Input value={form.horizon} onChange={(_, d) => set({ horizon: d.value })} data-testid="strategy-objective-horizon" />
              </Field>
              <Field label={t('stg.obj.basis')}>
                <Select value={form.basis} onChange={(_, d) => set({ basis: d.value as ObjectiveBasis })} data-testid="strategy-objective-basis">
                  {BASES.map((b) => <option key={b} value={b}>{t(`proj.anchor.basis.${b}`)}</option>)}
                </Select>
              </Field>
              <Field label={t('stg.obj.scope')}>
                <Select value={form.scope} onChange={(_, d) => set({ scope: d.value as ObjectiveScope })}>
                  {SCOPES.map((s) => <option key={s} value={s}>{t(`proj.anchor.scope.${s}`)}</option>)}
                </Select>
              </Field>
              {form.scope !== 'legalEntity' && (
                <Field label={t('stg.obj.scopeName')}>
                  <Input value={form.scopeName} onChange={(_, d) => set({ scopeName: d.value })} />
                </Field>
              )}
              <h3 className="proj-h3">{t('stg.obj.source')}</h3>
              <p className="muted">{t(form.basis === 'published' ? 'stg.obj.sourcePublished' : 'stg.obj.sourceStated')}</p>
              <Field label={t('stg.obj.sourceTitle')} required {...err('title')}>
                <Input value={form.source.title} onChange={(_, d) => setSource({ title: d.value })} data-testid="strategy-objective-source" />
              </Field>
              <Field label={t('stg.obj.url')} required={form.basis === 'published'} {...err('url')}>
                <Input type="url" value={form.source.url} onChange={(_, d) => setSource({ url: d.value })} data-testid="strategy-objective-url" />
              </Field>
              <Field label={t('stg.obj.locator')} hint={t('stg.obj.locatorHint')} required {...err('locator')}>
                <Input value={form.source.locator} onChange={(_, d) => setSource({ locator: d.value })} data-testid="strategy-objective-locator" />
              </Field>
              <Field label={t('stg.obj.accessed')} required {...err('accessedDate')}>
                <Input type="date" value={form.source.accessedDate} onChange={(_, d) => setSource({ accessedDate: d.value })} />
              </Field>
              <Field label={t('stg.obj.excerpt')}>
                <Textarea value={form.source.excerpt} onChange={(_, d) => setSource({ excerpt: d.value })} />
              </Field>
              {errors.length > 0 && <p className="proj-error" role="alert" data-testid="strategy-objective-errors">{t('stg.obj.invalid')}</p>}
              {failure && <MessageBar intent="error"><MessageBarBody>{t('proj.anchor.storageError')} {failure}</MessageBarBody></MessageBar>}
              <p className="muted">{t('stg.obj.version')}</p>
            </DialogContent>
            <DialogActions>
              <Button type="submit" appearance="primary" data-testid="strategy-objective-save">{t('proj.save')}</Button>
              <Button onClick={() => onClose()}>{t('proj.cancel')}</Button>
              {note && <Button onClick={() => onClose(undefined, true)} data-testid="strategy-objective-discard">{t('stg.obj.discard')}</Button>}
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
