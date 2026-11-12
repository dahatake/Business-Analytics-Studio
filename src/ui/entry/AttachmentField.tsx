import { useRef, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Select, Spinner } from '@fluentui/react-components';
import { Attach16Regular, Dismiss16Regular, Open16Regular } from '@fluentui/react-icons';
import { isMediaType, MAX_ATTACHMENT_BYTES, type AttachmentType, type MediaCapability } from '../../ai/attachments.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { mediaCapability, useAiSettings } from '../../modules/ai/settingsStore.ts';
import { addAttachmentFile, existingAttachments, openAttachment, type AddFileResult, type AttachmentItem } from '../../state/attachments.ts';
import './entry.css';

type MaybeAsync = void | Promise<void>;

/** The picker offers what the app accepts; the bytes decide in the end (src/ai/attachments.ts). */
export const ATTACHMENT_ACCEPT = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'text/*', 'application/json',
].join(',');

const TYPE_LABEL: Record<AttachmentType, string> = {
  'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/webp': 'WEBP', 'image/heic': 'HEIC', 'image/heif': 'HEIF', 'application/pdf': 'PDF',
  'text/plain': 'TXT', 'text/markdown': 'Markdown', 'text/csv': 'CSV', 'text/tab-separated-values': 'TSV', 'application/json': 'JSON', 'text/html': 'HTML',
};
export const typeLabel = (t: string) => TYPE_LABEL[t as AttachmentType] ?? t;
const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** What the selected AI reads natively, for the hint under the picker. */
export function useMediaCapability(): MediaCapability | null {
  return useAiSettings((s) => mediaCapability(s));
}

export interface AttachmentFieldProps {
  items: AttachmentItem[];
  onAdd: (items: AttachmentItem[]) => MaybeAsync;
  onRemove: (item: AttachmentItem) => MaybeAsync;
  /** Test id prefix, e.g. `entry-att` or `proj-att`. */
  testId: string;
  disabled?: boolean;
}

/**
 * Attach files (FR: data entry by attachment). New files are typed by their bytes and stored once per content; files
 * already on this PC (in this pack or another project) can be attached again without picking the file.
 */
export function AttachmentField({ items, onAdd, onRemove, testId, disabled }: AttachmentFieldProps) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const cap = useMediaCapability();
  const provider = useAiSettings((s) => s.provider);
  const current = new Set(items.map((i) => i.hash));
  const reusable = existingAttachments().filter((x) => !current.has(x.hash));

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const results: AddFileResult[] = [];
      for (const f of Array.from(files)) results.push(await addAttachmentFile(f));
      const ok = results.flatMap((r) => (r.ok && !current.has(r.item.hash) ? [r.item] : []));
      setErrors(results.flatMap((r) => (r.ok ? [] : [t(`entry.att.err.${r.reason}` as MessageKey, { name: r.name, max: sizeLabel(MAX_ATTACHMENT_BYTES) })])));
      setNotes(results.flatMap((r) => (r.ok && r.reused ? [t('entry.att.reused', { name: r.item.name })] : [])));
      if (ok.length) await onAdd(ok);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const readable = (i: AttachmentItem) => !isMediaType(i.mimeType) || (cap?.types.includes(i.mimeType) ?? false);

  return (
    <fieldset className="entry-refs entry-att" data-testid={testId}>
      <legend>{t('entry.att.legend')}</legend>
      {items.length === 0 ? <p className="muted">{t('entry.att.none')}</p> : (
        <ul className="entry-att-list">
          {items.map((i) => (
            <li key={i.hash} data-testid={`${testId}-item`}>
              <span className="entry-att-name">{i.name}</span>
              <span className="muted">{typeLabel(i.mimeType)}{i.size ? ` · ${sizeLabel(i.size)}` : ''}</span>
              {!readable(i) && <span className="entry-att-warn">{t('entry.att.notForAi')}</span>}
              <Button size="small" appearance="subtle" icon={<Open16Regular />} aria-label={t('entry.att.open', { name: i.name })} title={t('entry.att.open', { name: i.name })} onClick={() => { if (!openAttachment(i.hash)) setErrors([t('entry.att.err.missing', { name: i.name })]); }} />
              {!disabled && <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={t('entry.att.remove', { name: i.name })} title={t('entry.att.remove', { name: i.name })} onClick={() => void onRemove(i)} data-testid={`${testId}-remove`} />}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="entry-att-actions">
          <input ref={input} type="file" multiple accept={ATTACHMENT_ACCEPT} hidden onChange={(e) => void pick(e.currentTarget.files)} data-testid={`${testId}-input`} />
          <Button size="small" icon={busy ? <Spinner size="extra-tiny" /> : <Attach16Regular />} disabled={busy} onClick={() => input.current?.click()} data-testid={`${testId}-pick`}>{t('entry.att.add')}</Button>
          {reusable.length > 0 && (
            <Select
              size="small"
              value=""
              aria-label={t('entry.att.reuse')}
              onChange={(_, d) => { const it = reusable.find((x) => x.hash === d.value); if (it) void onAdd([it]); }}
              data-testid={`${testId}-reuse`}
            >
              <option value="">{t('entry.att.reuse')}</option>
              {reusable.map((x) => <option key={x.hash} value={x.hash}>{`${x.name} (${typeLabel(x.mimeType)})`}</option>)}
            </Select>
          )}
        </div>
      )}
      <p className="muted entry-note">
        {t('entry.att.formats')}{' '}
        {cap ? t('entry.att.aiReads', { provider: t(`entry.att.provider.${provider}` as MessageKey), types: cap.types.map(typeLabel).join(', '), files: cap.maxFiles }) : t('entry.att.aiTextOnly')}
      </p>
      {notes.map((n) => <p key={n} className="muted entry-note" role="status">{n}</p>)}
      {errors.length > 0 && <MessageBar intent="warning"><MessageBarBody>{errors.map((e) => <div key={e}>{e}</div>)}</MessageBarBody></MessageBar>}
    </fieldset>
  );
}
