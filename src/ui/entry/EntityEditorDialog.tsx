import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Select, Textarea,
} from '@fluentui/react-components';
import { Add16Regular, Delete20Regular } from '@fluentui/react-icons';
import { entitiesOf, getEntity, loaded, packOrigin } from '../../data/pack.ts';
import type { EntityKind, Region } from '../../data/schema.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { commitPackChange, newEntityId, referencesTo, usePackVersion } from '../../state/packEdits.ts';
import { SharedDataInUseError } from '../../data/packStore.ts';
import { useActiveProject, useProjects } from '../../state/projects.ts';
import { isHidden } from '../cardSpecs.ts';
import { ensureSource, hashOfSource, itemOfSource, type AttachmentItem } from '../../state/attachments.ts';
import { askWorkIqSections, type WorkIqProvider } from '../../modules/ai/relayClient.ts';
import { useAiSettings, workIqReady } from '../../modules/ai/settingsStore.ts';
import { FormDraftReview } from '../../modules/project/FormDraftReview.tsx';
import { requestFormDraft, type EntityDraftContext, type EntityDraftField, type FormDraftRequest } from '../../modules/project/formDraft.ts';
import { AttachmentField } from './AttachmentField.tsx';
import {
  blankEntity, FIELDS, fromForm, isEditableKind, setLText, toForm, type EditableKind, type FieldErrors, type FieldSpec, type FormState,
} from './entitySpecs.ts';
import './entry.css';

const NEW_REGION = '__new__';

export interface EntityEditorProps {
  /** Kind to create, or the kind of `id` when editing. null = closed. */
  kind: EditableKind | null;
  /** Existing entity to edit; absent = create. */
  id?: string | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
  /** Nested editors (creating a referenced item) get distinct test ids. */
  depth?: number;
  focusField?: string | null;
}

/**
 * Data entry for customer-pack entities (issues, KPIs, the business chain, people, …).
 * Saved where the project's data lives: its own imported pack, or the per-target overlay on the base pack.
 */
export function EntityEditorDialog({ kind, id = null, onClose, onSaved, depth = 0, focusField = null }: EntityEditorProps) {
  const { t, tx, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  usePackVersion((s) => s.version);
  const existing = id ? getEntity(id) : undefined;
  const [base, setBase] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nested, setNested] = useState<{ kind: EditableKind; field: FieldSpec } | null>(null);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const { project, company } = useActiveProject();
  const ai = useAiSettings();
  const workIqOk = workIqReady(ai);
  const [useWorkIq, setUseWorkIq] = useState(project?.brief?.useWorkIq === true);
  const [workIqNote, setWorkIqNote] = useState<string | null>(null);

  useEffect(() => {
    if (!kind) return;
    const raw = existing ? (structuredClone(existing) as unknown as Record<string, unknown>) : blankEntity(kind, newEntityId(kind));
    setBase(raw);
    setForm(toForm(kind, raw, lang));
    setAttachments((Array.isArray(raw.sourceIds) ? (raw.sourceIds as string[]) : []).map(itemOfSource).filter((x): x is AttachmentItem => x !== null));
    setErrors({});
    setFailure(null);
    setConfirmDelete(false);
    // Reset only when another entity is opened, not on every pack change.
  }, [kind, id]);

  useEffect(() => {
    if (!kind || !focusField) return;
    const timer = window.setTimeout(() => {
      const field = document.querySelector(`[data-testid="entry-field-${CSS.escape(focusField)}"]`);
      const control = field instanceof HTMLElement && (field.matches('input, select, textarea, button') ? field : field.querySelector<HTMLElement>('input, select, textarea, button'));
      if (control instanceof HTMLElement) {
        control.focus();
        control.scrollIntoView({ block: 'center' });
      }
    }, 100);
    return () => window.clearTimeout(timer);
  }, [kind, id, focusField]);

  const set = (key: string, value: FormState[string]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };
  const errMsg = (key: string) => (errors[key] ? t(`entry.err.${errors[key]}` as MessageKey) : undefined);
  const vstate = (key: string) => (errors[key] ? 'error' as const : 'none' as const);

  const save = async () => {
    if (!kind || !base) return;
    let region: Region | undefined;
    let values = form;
    if (FIELDS[kind].some((f) => f.type === 'region') && form.regionId === NEW_REGION) {
      const name = typeof form.regionName === 'string' ? form.regionName.trim() : '';
      if (!name) return setErrors({ ...errors, regionName: 'required' });
      region = { id: newEntityId('region'), name: setLText(undefined, name, lang) };
      values = { ...form, regionId: region.id };
    }
    const { entity, errors: found } = fromForm(kind, base, values, lang);
    setErrors(found);
    if (!entity) return;
    setBusy(true);
    try {
      // Attachments become pack sources first; the entity then cites them next to its other sources.
      const attached: string[] = [];
      for (const a of attachments) attached.push(await ensureSource(a, form.shareable === 'true'));
      const others = entity.sourceIds.filter((sid) => hashOfSource(getEntity(sid)) === null);
      entity.sourceIds = [...others, ...attached.filter((sid, i) => attached.indexOf(sid) === i)];
      await commitPackChange({ op: 'upsert', entity, region });
      onSaved?.(entity.id);
      onClose();
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(false);
    }
  };

  /** FR-342: shared company data another project still cites is named, not reported as a raw error. */
  const failureOf = (err: unknown) => {
    if (!(err instanceof SharedDataInUseError)) return t('entry.err.save', { message: err instanceof Error ? err.message : String(err) });
    const { projects } = useProjects.getState();
    return t('entry.err.sharedInUse', {
      projects: err.uses.map((u) => projects.find((p) => p.id === u.projectId)?.name ?? u.projectId).join(t('ai.listSep')),
      ids: [...new Set(err.uses.flatMap((u) => u.ids))].join(t('ai.listSep')),
    });
  };
  const refs = id ? referencesTo(id) : [];
  const remove = async () => {
    if (!id) return;
    if (!confirmDelete) return setConfirmDelete(true);
    setBusy(true);
    try {
      await commitPackChange({ op: 'delete', id });
      onClose();
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(false);
    }
  };

  const options = (k: EntityKind, current: string[]) => entitiesOf(k)
    .filter((e) => e.id !== id && (k !== 'source' || hashOfSource(e) === null) && (!isHidden(e, audience) || current.includes(e.id)))
    .map((e) => ({ id: e.id, label: isHidden(e, audience) ? t('entry.restricted') : tx(e.name) }));

  const renderField = (f: FieldSpec) => {
    const value = form[f.key];
    const testId = `entry-field-${f.key}`;
    const createButton = (k: EditableKind) => (
      <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => setNested({ kind: k, field: f })} data-testid={`entry-new-${f.key}`}>
        {t('entry.createNew', { kind: t(`kind.${k}`) })}
      </Button>
    );
    switch (f.type) {
      case 'ltext':
        return (
          <Field key={f.key} label={t(f.label)} required={f.required} validationState={vstate(f.key)} validationMessage={errMsg(f.key)}>
            <Input value={String(value ?? '')} onChange={(_, d) => set(f.key, d.value)} data-testid={testId} />
          </Field>
        );
      case 'number':
        return (
          <Field key={f.key} label={t(f.label)} required validationState={vstate(f.key)} validationMessage={errMsg(f.key)}>
            <Input type="number" value={String(value ?? '')} min={f.min} max={f.max} step={f.step ?? 'any'} onChange={(_, d) => set(f.key, d.value)} data-testid={testId} />
          </Field>
        );
      case 'date':
        return (
          <Field key={f.key} label={t(f.label)} required validationState={vstate(f.key)} validationMessage={errMsg(f.key)}>
            <Input type="date" value={String(value ?? '')} onChange={(_, d) => set(f.key, d.value)} data-testid={testId} />
          </Field>
        );
      case 'enum':
        return (
          <Field key={f.key} label={t(f.label)}>
            <Select value={String(value ?? '')} onChange={(_, d) => set(f.key, d.value)} data-testid={testId}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
            </Select>
          </Field>
        );
      case 'ref': {
        const list = options(f.kind, [String(value ?? '')]);
        return (
          <div key={f.key} className="entry-ref">
            <Field label={t(f.label)} required validationState={vstate(f.key)} validationMessage={errMsg(f.key)}>
              <Select value={String(value ?? '')} onChange={(_, d) => set(f.key, d.value)} data-testid={testId}>
                <option value="">{t('entry.none')}</option>
                {list.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </Field>
            {createButton(f.kind)}
          </div>
        );
      }
      case 'refs': {
        const ids = Array.isArray(value) ? value : [];
        const list = options(f.kind, ids);
        const toggle = (rid: string, on: boolean) => set(f.key, on ? [...ids, rid] : ids.filter((x) => x !== rid));
        return (
          <fieldset key={f.key} className="entry-refs" data-testid={testId}>
            <legend>{t(f.label)}{f.min ? ' *' : ''}</legend>
            {list.length === 0 && <p className="muted">{t('entry.noItems')}</p>}
            <div className="entry-refs-list">
              {list.map((o) => (
                <Checkbox key={o.id} label={o.label} checked={ids.includes(o.id)} onChange={(_, d) => toggle(o.id, d.checked === true)} data-testid={`${testId}-${o.id}`} />
              ))}
            </div>
            {errors[f.key] && <p className="entry-error" role="alert">{errMsg(f.key)}</p>}
            {isEditableKind(f.kind) && createButton(f.kind)}
          </fieldset>
        );
      }
      case 'region':
        return (
          <div key={f.key} className="entry-ref">
            <Field label={t(f.label)} required validationState={vstate(f.key)} validationMessage={errMsg(f.key)}>
              <Select value={String(value ?? '')} onChange={(_, d) => set(f.key, d.value)} data-testid={testId}>
                <option value="">{t('entry.none')}</option>
                {loaded.pack.regions.map((r) => <option key={r.id} value={r.id}>{tx(r.name)}</option>)}
                <option value={NEW_REGION}>{t('entry.region.new')}</option>
              </Select>
            </Field>
            {value === NEW_REGION && (
              <Field label={t('entry.region.name')} required validationState={vstate('regionName')} validationMessage={errMsg('regionName')}>
                <Input value={String(form.regionName ?? '')} onChange={(_, d) => set('regionName', d.value)} data-testid="entry-field-regionName" />
              </Field>
            )}
          </div>
        );
      case 'list':
        return (
          <Field key={f.key} label={t(f.label)} hint={t('entry.listHint')}>
            <Input value={String(value ?? '')} onChange={(_, d) => set(f.key, d.value)} data-testid={testId} />
          </Field>
        );
    }
  };

  const kindLabel = kind ? t(`kind.${kind}`) : '';

  const draftOptions = (k: EntityKind) => entitiesOf(k)
    .filter((e) => e.id !== id && !isHidden(e, audience))
    .slice(0, 60)
    .map((e) => ({ value: e.id, label: tx(e.name) }));

  /** Every input the model may fill, with the only values it may choose for choice fields. */
  const draftFields = (): EntityDraftField[] => {
    if (!kind) return [];
    const text = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const fields: EntityDraftField[] = [
      { key: 'name', label: t('field.name'), type: 'text', required: true, current: text('name') },
      { key: 'description', label: t('entry.field.description'), type: 'longtext', current: text('description') },
    ];
    for (const f of FIELDS[kind]) {
      const base = { key: f.key, label: t(f.label), current: form[f.key] ?? (f.type === 'refs' ? [] : '') };
      if (f.type === 'ltext') fields.push({ ...base, type: 'text', required: f.required });
      else if (f.type === 'number') fields.push({ ...base, type: 'number', min: f.min, max: f.max });
      else if (f.type === 'date' || f.type === 'list') fields.push({ ...base, type: f.type });
      else if (f.type === 'enum') fields.push({ ...base, type: 'enum', options: f.options.map((o) => ({ value: o.value, label: t(o.label) })) });
      else if (f.type === 'ref') fields.push({ ...base, type: 'ref', options: draftOptions(f.kind) });
      else if (f.type === 'region') fields.push({ ...base, type: 'ref', options: loaded.pack.regions.map((r) => ({ value: r.id, label: tx(r.name) })) });
      else if (f.kind !== 'source') fields.push({ ...base, type: 'refs', required: !!f.min, options: draftOptions(f.kind) });
    }
    return fields;
  };

  const draftRequest: FormDraftRequest<'entity'> = async (onProgress) => {
    setWorkIqNote(null);
    const evidence: { text: string; source: string }[] = [];
    if (useWorkIq && workIqOk && (ai.provider === 'foundry' || ai.provider === 'copilotSdk')) {
      onProgress('workiq');
      try {
        const sections = await askWorkIqSections({
          company: company?.name ?? '', project: project?.name ?? '', purpose: project?.brief?.purpose ?? '', focus: project?.brief?.focus ?? '',
          asOf: project?.brief?.asOf ?? new Date().toISOString().slice(0, 10), lang, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          provider: ai.provider as WorkIqProvider, aspects: [], topics: [[kindLabel, form.name, form.description].filter((x) => typeof x === 'string' && x).join(' ')],
        });
        for (const s of sections) if ('answer' in s && s.answer.trim()) evidence.push({ text: s.answer.slice(0, 1500), source: s.citations.slice(0, 3).map((c) => c.title).join(', ') || 'Work IQ' });
        const withheld = sections.some((s) => 'error' in s ? s.error === 'confidentialNotAllowed' : (s.withheld ?? 0) > 0);
        const failed = sections.filter((s) => 'error' in s && s.error !== 'confidentialNotAllowed').length;
        const notes = [failed ? t('workiq.partialSearch', { n: failed }) : '', withheld ? t('workiq.excludedMaterial') : '', !evidence.length ? t('entry.draft.workIqEmpty') : ''].filter(Boolean);
        if (notes.length) setWorkIqNote(notes.join(' '));
      } catch {
        setWorkIqNote(t('entry.draft.workIqFailed'));
      }
    }
    const context: EntityDraftContext = {
      kind: kindLabel, company: company?.name ?? '', project: project?.name ?? '', purpose: project?.brief?.purpose ?? '', focus: project?.brief?.focus ?? '',
      fields: draftFields(), ...(evidence.length ? { evidence } : {}),
    };
    onProgress('generate');
    return requestFormDraft('entity', context, lang);
  };

  const draftValueLabel = (key: string, value: string | string[]) => {
    const f = draftFields().find((x) => x.key === key);
    const name = (v: string) => f?.options?.find((o) => o.value === v)?.label ?? v;
    return Array.isArray(value) ? value.map(name).join(t('ai.listSep')) : name(value);
  };

  const title = existing ? t('entry.titleEdit', { kind: kindLabel, name: tx(existing.name) }) : t('entry.titleNew', { kind: kindLabel });
  const where = useMemo(() => (packOrigin.kind === 'imported' ? 'entry.where.imported' : 'entry.where.overlay'), []);

  return (
    <Dialog open={kind !== null} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface data-testid={depth ? `entry-dialog-${depth}` : 'entry-dialog'} className="entry-surface">
        <form onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void save(); }}>
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent className="entry-form">
              <p className="muted">{t(where)}</p>
              {kind && (
                <div className="entry-wide entry-draft">
                  {workIqOk && (
                    <Checkbox label={t('entry.draft.useWorkIq')} checked={useWorkIq} onChange={(_, d) => setUseWorkIq(d.checked === true)} data-testid="entry-draft-workiq" />
                  )}
                  {workIqNote && <p className="muted" role="status" data-testid="entry-draft-workiq-note">{workIqNote}</p>}
                  <FormDraftReview
                    kind="entity"
                    testId="entry-draft"
                    baseline={`${kind}:${id ?? ''}`}
                    request={draftRequest}
                    preview={(d) => (
                      <dl className="dlv-form-draft-fields">
                        {Object.entries(d.values).map(([key, value]) => (
                          <Fragment key={key}>
                            <dt>{draftFields().find((x) => x.key === key)?.label ?? key}</dt>
                            <dd>{draftValueLabel(key, value)}</dd>
                          </Fragment>
                        ))}
                      </dl>
                    )}
                    onApprove={(d) => { for (const [key, value] of Object.entries(d.values)) set(key, value); }}
                  />
                </div>
              )}
              <Field label={t('field.name')} required validationState={vstate('name')} validationMessage={errMsg('name')}>
                <Input value={String(form.name ?? '')} onChange={(_, d) => set('name', d.value)} data-testid="entry-field-name" />
              </Field>
              <Field className="entry-wide" label={t('entry.field.description')} hint={t('entry.descriptionHint')}>
                <Textarea value={String(form.description ?? '')} onChange={(_, d) => set('description', d.value)} resize="vertical" rows={2} data-testid="entry-field-description" />
              </Field>
              {kind && FIELDS[kind].map(renderField)}
              <AttachmentField
                items={attachments}
                onAdd={(add) => setAttachments((cur) => [...cur, ...add.filter((a) => !cur.some((x) => x.hash === a.hash))])}
                onRemove={(it) => setAttachments((cur) => cur.filter((x) => x.hash !== it.hash))}
                testId={depth ? `entry-att-${depth}` : 'entry-att'}
              />
              <Checkbox
                label={t('entry.field.shareable')}
                checked={form.shareable === 'true'}
                onChange={(_, d) => set('shareable', d.checked === true ? 'true' : '')}
                data-testid="entry-field-shareable"
              />
              {existing && existing.author !== 'human' && <p className="muted">{t('entry.authorNote')}</p>}
              {failure && <MessageBar intent="error"><MessageBarBody>{failure}</MessageBarBody></MessageBar>}
              {existing && refs.length > 0 && confirmDelete && (
                <MessageBar intent="warning"><MessageBarBody>{t('entry.err.referenced', { count: refs.length, list: refs.slice(0, 5).map((r) => (getEntity(r) ? tx(getEntity(r)!.name) : r)).join(', ') })}</MessageBarBody></MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              {existing && (
                <Button
                  type="button"
                  icon={<Delete20Regular />}
                  disabled={busy || (confirmDelete && refs.length > 0)}
                  onClick={() => void remove()}
                  data-testid="entry-delete"
                >
                  {t(confirmDelete && refs.length === 0 ? 'entry.deleteConfirm' : 'entry.delete')}
                </Button>
              )}
              <Button type="submit" appearance="primary" disabled={busy} data-testid="entry-save">{t('entry.save')}</Button>
              <Button type="button" onClick={onClose}>{t('entry.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
        {nested && (
          <EntityEditorDialog
            kind={nested.kind}
            depth={depth + 1}
            onClose={() => setNested(null)}
            onSaved={(newId) => {
              const f = nested.field;
              if (f.type === 'refs') set(f.key, [...(Array.isArray(form[f.key]) ? (form[f.key] as string[]) : []), newId]);
              else set(f.key, newId);
            }}
          />
        )}
      </DialogSurface>
    </Dialog>
  );
}
