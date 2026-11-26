import { useEffect, useRef } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components';
import { useI18n } from '../i18n/index.ts';
import { hrefFor, useRoute } from '../state/router.ts';
import { closeSettings, openSettings, useSettingsDialog } from '../modules/ai/uiStore.ts';
import { SettingsTabs } from './SettingsTabs.tsx';
import '../modules/ai/ai.css';

/**
 * The settings as a dialog, so the launch screen (before a project is chosen) and the pack generator (unsaved input)
 * keep their state while settings are changed. It shows the same tabs as the /settings screen.
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface
        className="ai-settings-dialog settings-dialog"
        style={{ width: 'min(960px, calc(100vw - 32px))', maxWidth: 'min(960px, calc(100vw - 32px))' }}
        data-testid="ai-settings-dialog"
      >
        <DialogBody>
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogContent>
            <SettingsTabs />
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose} data-testid="ai-settings-dialog-close">{t('ai.dialog.close')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Mounted once by the App, at every start-up stage. Moving to another route closes it; on the /settings screen the
 * same tabs are shown inline, so the dialog stays closed there. A bookmark of the former /ai-settings screen opens
 * the AI tab over Home.
 */
export function SettingsDialogHost() {
  const open = useSettingsDialog((s) => s.open);
  const path = useRoute().path;
  const redirected = useRef(false);
  useEffect(() => {
    if (path === '/ai-settings') {
      redirected.current = true;
      openSettings('ai');
      window.location.replace(hrefFor('/home'));
    } else if (redirected.current) redirected.current = false;
    else closeSettings();
  }, [path]);
  return <SettingsDialog open={open && path !== '/settings'} onClose={closeSettings} />;
}
