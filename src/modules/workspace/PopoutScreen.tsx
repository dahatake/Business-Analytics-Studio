import { useEffect, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner,
} from '@fluentui/react-components';
import { ArrowExportLtr16Regular, Desktop16Regular, WindowNew16Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { navigate } from '../../state/router.ts';
import { COMPONENTS } from './hosts.tsx';
import type { ComponentId } from './personas.ts';
import { defaultPlacement, placementOn, screenOptions, type ScreenOption } from './popout.ts';
import { getScreenDetails, openPopout, screensAlreadyGranted, usePopoutGuest } from './popoutRuntime.ts';
import './workspace.css';

/** FR-298: one workspace component alone in its own window (`#/workspace/popout/<id>`). */
export function PopoutScreen({ id }: { id: ComponentId | null }) {
  const { t } = useI18n();
  usePopoutGuest(id);
  const c = id ? COMPONENTS[id] : undefined;

  const back = () => {
    window.close();
    // Opened directly (not by the workspace): the browser keeps the tab open, so go to the workspace instead.
    window.setTimeout(() => { if (!window.closed) navigate('#/workspace'); }, 150);
  };

  if (!c) {
    return (
      <div className="ws-popout" data-testid="ws-popout">
        <h1 className="ws-popout-title">{t('ws.popout.invalid')}</h1>
        <Button onClick={() => navigate('#/workspace')}>{t('ws.title')}</Button>
      </div>
    );
  }
  const View = c.View;
  return (
    <div className="ws-popout" data-testid="ws-popout" data-component={id ?? ''} style={{ borderTopColor: c.accent }}>
      <div className="ws-popout-header">
        <h1 className="ws-popout-title" id="ws-popout-title"><c.Icon aria-hidden />{t(c.label)}</h1>
        <Button size="small" icon={<ArrowExportLtr16Regular />} onClick={back} data-testid="ws-popout-return">{t('ws.popout.return')}</Button>
      </div>
      <p className="ws-help">{t('ws.popout.note')}</p>
      {/* Focusable so long content can be scrolled with the keyboard (WCAG 2.1.1). */}
      <div className="ws-popout-body" tabIndex={0} role="group" aria-labelledby="ws-popout-title">
        <View />
      </div>
    </div>
  );
}

export type PopoutOutcome = 'screen' | 'here' | 'denied' | 'blocked';

/** Display picker (Window Management API). Permission is requested only when the user asks to list displays. */
export function ScreenPicker({ id, onClose, onDone }: {
  id: ComponentId | null;
  onClose: () => void;
  onDone: (id: ComponentId, outcome: PopoutOutcome, screen?: string) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [screens, setScreens] = useState<ScreenOption[]>([]);
  const name = id ? t(COMPONENTS[id].label) : '';

  useEffect(() => {
    setStatus('idle');
    setScreens([]);
    if (!id) return;
    let alive = true;
    // Already granted: list the displays without any prompt.
    void screensAlreadyGranted().then(async (granted) => {
      if (!granted || !alive) return;
      try {
        const details = await getScreenDetails();
        if (alive) { setScreens(screenOptions(details)); setStatus('ready'); }
      } catch { /* keep the button */ }
    });
    return () => { alive = false; };
  }, [id]);

  if (!id) return null;

  const screenName = (s: ScreenOption) => s.label || t('ws.popout.screenFallback', { n: s.index + 1 });

  const detect = async () => {
    setStatus('loading');
    try {
      const details = await getScreenDetails();
      setScreens(screenOptions(details));
      setStatus('ready');
    } catch {
      // Denied or failed: open on the current screen and say so.
      const w = openPopout(id, defaultPlacement());
      onDone(id, w ? 'denied' : 'blocked');
    }
  };

  const openOn = (s: ScreenOption) => {
    const w = openPopout(id, placementOn(s.screen));
    onDone(id, w ? 'screen' : 'blocked', screenName(s));
  };

  const openHere = () => {
    const w = openPopout(id, defaultPlacement());
    onDone(id, w ? 'here' : 'blocked');
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface aria-describedby="ws-picker-help" data-testid="ws-screen-picker">
        <DialogBody>
          <DialogTitle>{t('ws.popout.pickTitle', { name })}</DialogTitle>
          <DialogContent className="ws-picker">
            <p id="ws-picker-help" className="ws-help">{t('ws.popout.pickHelp')}</p>
            {status === 'loading' && <Spinner size="tiny" label={t('ws.popout.loading')} />}
            {status === 'idle' && (
              <Button icon={<Desktop16Regular />} onClick={() => void detect()} data-testid="ws-screen-detect">{t('ws.popout.detect')}</Button>
            )}
            {status === 'ready' && (
              <ul className="ws-picker-list" aria-label={t('ws.popout.screensLabel')}>
                {screens.map((s) => {
                  const marks = [s.primary ? t('ws.popout.primary') : '', s.current ? t('ws.popout.currentMark') : ''].filter(Boolean).join(t('ws.popout.markSep'));
                  return (
                    <li key={s.index}>
                      <Button icon={<Desktop16Regular />} onClick={() => openOn(s)} data-testid={`ws-screen-${s.index}`}>
                        {t('ws.popout.screen', { label: screenName(s), width: s.width, height: s.height })}
                        {marks && <span className="ws-muted ws-picker-mark">{t('ws.popout.marks', { marks })}</span>}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" icon={<WindowNew16Regular />} onClick={openHere} data-testid="ws-screen-here">{t('ws.popout.here')}</Button>
            <Button onClick={onClose}>{t('ws.popout.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
