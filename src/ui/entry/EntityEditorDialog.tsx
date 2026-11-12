import { useEffect, useMemo, useState } from 'react';
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Select, Textarea,
} from '@fluentui/react-components';
import { Add16Regular, Delete20Regular } from '@fluentui/react-icons';
import { entitiesOf, getEntity, loaded, packOrigin } from '../../data/pack.ts';
import type { Region } from '../../data/schema.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { commitPackChange, newEntityId, referencesTo, usePackVersion } from '../../state/packEdits.ts';
import { isHidden } from '../cardSpecs.ts';
import { ensureSource, hashOfSource, itemOfSource, type AttachmentItem } from '../../state/attachments.ts';
import { AttachmentField } from './AttachmentField.tsx';
import {
  blankEntity, FIELDS, fromForm, setLText, toForm, type EditableKind, type FieldErrors, type FieldSpec, type FormState,
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
}

/**
 * Data entry for customer-pack entities (issues, KPIs, the business chain, people, …).
 * Saved where the project's data lives: its own imported pack, or the per-target overlay on the base pack.
 */
export function EntityEditorDialog({ kind, id = null, onClose, onSaved, depth = 0 }: EntityEditorProps) {
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
      setFailure(t('entry.err.save', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
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
      setFailure(t('entry.err.save', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const options = (k: EditableKind, current: string[]) => entitiesOf(k)
    .filter((e) => e.id !== id && (!isHidden(e, audience) || current.includes(e.id)))
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
            {createButton(f.kind)}
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
              <Field label={t('field.name')} required validationState={vstate('name')} validationMessage={errMsg('name')}>
                <Input value={String(form.name ?? '')} onChange={(_, d) => set('name', d.value)} data-testid="entry-field-name" />
              </Field>
              <Field label={t('entry.field.description')} hint={t('entry.descriptionHint')}>
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
