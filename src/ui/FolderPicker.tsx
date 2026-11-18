import { useCallback, useEffect, useId, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Spinner,
} from '@fluentui/react-components';
import { ArrowUp20Regular, Folder20Regular, FolderAdd20Regular, HardDrive20Regular } from '@fluentui/react-icons';
import type { DeviceFolderListing, FolderRootKind } from '../../scripts/lib/deviceProtocol.ts';
import { browseDeviceFolders, createDeviceFolder, DeviceStorageError } from '../data/deviceStorage.ts';
import { useI18n, type MessageKey } from '../i18n/index.ts';
import './folderPicker.css';

const separator = (path: string) => path.includes('\\') ? '\\' : '/';
const childPath = (parent: string, name: string) => parent.endsWith(separator(parent)) ? parent + name : parent + separator(parent) + name;

export function errorKey(error: unknown): MessageKey {
  const code = error instanceof DeviceStorageError ? error.code : typeof error === 'string' ? error : undefined;
  const known = ['locationInvalid', 'locationNetwork', 'locationSame', 'locationServed', 'locationNotWritable', 'locationHasData',
    'locationNoData', 'locationCorrupt', 'locationFixed', 'locationUnavailable', 'locationNameInvalid', 'locationUnreadable'];
  return code && known.includes(code) ? `settings.storage.err.${code}` as MessageKey : 'settings.storage.failed';
}

function rootLabel(kind: FolderRootKind, path: string, t: ReturnType<typeof useI18n>['t']) {
  return kind === 'drive' ? t('picker.root.drive', { path }) : t(`picker.root.${kind}`);
}

/**
 * FR-339: browses folders on the PC that runs the local BAS server. Browsers cannot reveal real folder paths
 * (showDirectoryPicker returns only a handle), and the database is written by the server, so the server lists folders.
 */
export function FolderPicker({ open, onCancel, onSelect }: {
  open: boolean;
  onCancel: () => void;
  onSelect: (listing: DeviceFolderListing) => void;
}) {
  const { t } = useI18n();
  const [listing, setListing] = useState<DeviceFolderListing | null>(null);
  const [typed, setTyped] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [name, setName] = useState('');
  const listId = useId();

  const go = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await browseDeviceFolders(path);
      setListing(next);
      setTyped(next.path);
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setListing(null);
    setName('');
    void go();
  }, [open, go]);

  const create = async () => {
    if (!listing || !name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const path = await createDeviceFolder(listing.path, name.trim());
      setName('');
      await go(path);
    } catch (e) {
      setError(errorKey(e));
      setLoading(false);
    }
  };

  const target = listing?.target;
  return (
    <Dialog open={open} modalType="modal" onOpenChange={(_, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface className="folder-picker" data-testid="folder-picker">
        <DialogBody>
          <DialogTitle>{t('picker.title')}</DialogTitle>
          <DialogContent className="folder-picker-content">
            <form className="folder-picker-path" onSubmit={(e) => { e.preventDefault(); void go(typed.trim()); }}>
              <Field label={t('picker.path')} className="folder-picker-path-field">
                <Input value={typed} onChange={(_, d) => setTyped(d.value)} data-testid="folder-picker-path" spellCheck={false} />
              </Field>
              <Button type="submit" disabled={loading || !typed.trim()} data-testid="folder-picker-go">{t('picker.go')}</Button>
              <Button icon={<ArrowUp20Regular />} disabled={loading || !listing?.parent}
                onClick={() => { if (listing?.parent) void go(listing.parent); }} data-testid="folder-picker-up">{t('picker.up')}</Button>
            </form>
            <div className="folder-picker-body">
              <nav aria-label={t('picker.places')} className="folder-picker-roots">
                <ul>
                  {listing?.roots.map((root) => (
                    <li key={`${root.kind}:${root.path}`}>
                      <Button appearance="subtle" icon={root.kind === 'drive' || root.kind === 'system' ? <HardDrive20Regular /> : <Folder20Regular />}
                        title={root.path} onClick={() => void go(root.path)} aria-current={root.path === listing.path ? 'location' : undefined}>
                        {rootLabel(root.kind, root.path, t)}
                      </Button>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="folder-picker-list">
                <h3 id={listId} className="folder-picker-heading">{listing ? t('picker.folders', { path: listing.path }) : t('picker.loading')}</h3>
                {loading && <Spinner size="tiny" label={t('picker.loading')} />}
                {listing && (listing.folders.length === 0
                  ? <p className="muted">{t('picker.empty')}</p>
                  : (
                    <ul aria-labelledby={listId} data-testid="folder-picker-folders">
                      {listing.folders.map((folder) => (
                        <li key={folder}>
                          <Button appearance="subtle" icon={<Folder20Regular />} onClick={() => void go(childPath(listing.path, folder))}>{folder}</Button>
                        </li>
                      ))}
                    </ul>
                  ))}
                {listing?.truncated && <p className="muted">{t('picker.truncated')}</p>}
              </div>
            </div>
            <form className="folder-picker-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
              <Field label={t('picker.newFolder')}>
                <Input value={name} onChange={(_, d) => setName(d.value)} data-testid="folder-picker-new-name" />
              </Field>
              <Button type="submit" icon={<FolderAdd20Regular />} disabled={loading || !listing || !name.trim()} data-testid="folder-picker-create">{t('picker.create')}</Button>
            </form>
            <div aria-live="polite" data-testid="folder-picker-status">
              {error && <MessageBar intent="error"><MessageBarBody>{t(error)}</MessageBarBody></MessageBar>}
              {target?.error && <MessageBar intent="warning"><MessageBarBody>{t(errorKey(target.error))}</MessageBarBody></MessageBar>}
              {target?.hasData && !target.error && <MessageBar intent="info"><MessageBarBody>{t('picker.hasData')}</MessageBarBody></MessageBar>}
              {target?.warnings.map((w) => (
                <MessageBar key={w} intent="warning"><MessageBarBody>{t(`settings.storage.warn.${w}`)}</MessageBarBody></MessageBar>
              ))}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={loading || !listing || Boolean(target?.error)}
              onClick={() => { if (listing) onSelect(listing); }} data-testid="folder-picker-select">{t('picker.select')}</Button>
            <Button onClick={onCancel}>{t('picker.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
