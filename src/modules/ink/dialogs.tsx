import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Spinner, Text,
} from '@fluentui/react-components';
import { ArrowDownload24Regular, DocumentPdf24Regular } from '@fluentui/react-icons';
import { loaded } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import type { AiResponse } from '../../ai/client.ts';

export function RenameDialog({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  useEffect(() => setName(initial), [initial, open]);
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(name);
          }}
        >
          <DialogBody>
            <DialogTitle>{t('ink.board.rename')}</DialogTitle>
            <DialogContent>
              <Field label={t('ink.board.name')}>
                <Input value={name} onChange={(_, d) => setName(d.value)} data-testid="ink-rename-input" />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose}>{t('ink.cancel')}</Button>
              <Button appearance="primary" type="submit">{t('ink.save')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

export function ConfirmDialog({ open, title, body, confirm, onClose, onConfirm }: { open: boolean; title: string; body: string; confirm: string; onClose: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>{body}</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{t('ink.cancel')}</Button>
            <Button appearance="primary" onClick={onConfirm}>{confirm}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** FR-098: pick any pack entity to place as a card. */
export function PickerDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const { t, tx } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...loaded.byId.values()]
      .filter((e) => !isHidden(e, audience))
      .filter((e) => !needle || e.name.ja.toLowerCase().includes(needle) || e.name.en.toLowerCase().includes(needle) || e.id.includes(needle))
      .slice(0, 60);
  }, [q, audience]);
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('ink.picker.title')}</DialogTitle>
          <DialogContent>
            <Field label={t('ink.picker.search')}>
              <Input value={q} onChange={(_, d) => setQ(d.value)} data-testid="ink-picker-search" />
            </Field>
            <Text size={200} role="status">{t('ink.picker.count', { count: results.length })}</Text>
            <ul className="ink-picker-list">
              {results.map((e) => (
                <li key={e.id}>
                  <Button appearance="subtle" className="ink-picker-item" onClick={() => onPick(e.id)}>
                    {tx(e.name)}
                    <span className="ink-picker-kind">{t(`kind.${e.kind}` as MessageKey)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{t('ink.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export interface ItemOption {
  id: string;
  label: string;
}

/** FR-096: connect two items without dragging. */
export function ConnectDialog({ open, items, onClose, onConnect }: { open: boolean; items: ItemOption[]; onClose: () => void; onConnect: (from: string, to: string) => void }) {
  const { t } = useI18n();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    if (!open) return;
    setFrom(items[0]?.id ?? '');
    setTo(items[1]?.id ?? '');
  }, [open, items]);
  const invalid = !from || !to || from === to;
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('ink.connect.title')}</DialogTitle>
          <DialogContent className="ink-connect">
            <Field label={t('ink.connect.from')}>
              <Select value={from} onChange={(_, d) => setFrom(d.value)} data-testid="ink-connect-from">
                {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
              </Select>
            </Field>
            <Field label={t('ink.connect.to')} validationMessage={from && from === to ? t('ink.connect.same') : undefined}>
              <Select value={to} onChange={(_, d) => setTo(d.value)} data-testid="ink-connect-to">
                {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
              </Select>
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{t('ink.cancel')}</Button>
            <Button appearance="primary" disabled={invalid} onClick={() => onConnect(from, to)}>{t('ink.connect.apply')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** FR-090: recognition result. The answer is a mock while the real service is blocked (C-07 / C-03). */
export function RecognizeDialog({ open, result, onClose, onAddNote }: { open: boolean; result: AiResponse | null; onClose: () => void; onAddNote: (text: string) => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('ink.hw.title')}</DialogTitle>
          <DialogContent>
            {!result ? <Spinner label={t('ink.hw.running')} /> : (
              <div className="ink-hw" data-testid="ink-hw-result">
                {result.mode === 'mock' && <Badge appearance="filled" color="warning">{t('ink.hw.mock')}</Badge>}
                <p>{result.text}</p>
                <Text size={200}>{t('ink.hw.blocked')}</Text>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{t('ink.close')}</Button>
            <Button appearance="primary" disabled={!result} onClick={() => result && onAddNote(result.text)}>{t('ink.hw.addNote')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export interface ExportPreview {
  imageDataUri: string;
  markdown: string;
  boards: number;
  pdfBytes: number;
}

/** FR-096: preview before exporting (PDF of all boards, Markdown of this board, summary pack of all boards). */
export function ExportDialog({ open, preview, onClose, onPdf, onMarkdown, onPack }: {
  open: boolean;
  preview: ExportPreview | null;
  onClose: () => void;
  onPdf: () => void;
  onMarkdown: () => void;
  onPack: () => void;
}) {
  const { t, fmt } = useI18n();
  const shown = preview ? preview.markdown.replace(/\(data:image\/png;base64,[^)]+\)/g, `(${t('ink.export.imageOmitted')})`) : '';
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 'min(960px, 96vw)' }}>
        <DialogBody>
          <DialogTitle>{t('ink.export.title')}</DialogTitle>
          <DialogContent>
            {!preview ? <Spinner label={t('ink.export.preparing')} /> : (
              <div className="ink-export" data-testid="ink-export-preview">
                <img src={preview.imageDataUri} alt={t('ink.export.imageAlt')} className="ink-export-image" />
                <Text size={200}>{t('ink.export.pdfInfo', { pages: preview.boards, size: fmt.integer(Math.ceil(preview.pdfBytes / 1024)) })}</Text>
                <h3 className="ink-export-h">{t('ink.export.mdPreview')}</h3>
                <pre className="ink-export-md" tabIndex={0} aria-label={t('ink.export.mdPreview')}>{shown}</pre>
              </div>
            )}
          </DialogContent>
          <DialogActions fluid className="ink-export-actions">
            <Button appearance="secondary" onClick={onClose}>{t('ink.close')}</Button>
            <Button icon={<ArrowDownload24Regular />} disabled={!preview} onClick={onMarkdown}>{t('ink.export.md')}</Button>
            <Button icon={<ArrowDownload24Regular />} disabled={!preview} onClick={onPack}>{t('ink.export.pack')}</Button>
            <Button appearance="primary" icon={<DocumentPdf24Regular />} disabled={!preview} onClick={onPdf} data-testid="ink-export-pdf">{t('ink.export.pdf')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
