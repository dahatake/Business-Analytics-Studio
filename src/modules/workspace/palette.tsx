import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, Text } from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { create } from 'zustand';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { personaLabel } from '../../state/personas.ts';
import { hrefFor, navigate } from '../../state/router.ts';
import { SCREENS } from '../../app/modules.ts';
import { WS_PERSONAS } from './personas.ts';
import { resetLayout, switchPersona } from './store.ts';
import { filterCommands, type Command } from './commands.ts';

/** `returnTo` is captured before the dialog takes focus, so closing can give it back (FR-111). */
export const usePalette = create<{ open: boolean; returnTo: HTMLElement | null; setOpen: (open: boolean) => void }>()((set, get) => ({
  open: false,
  returnTo: null,
  setOpen: (open) => {
    if (open && !get().open) set({ open, returnTo: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    else set({ open });
  },
}));

/** Ctrl+K (Windows) / Cmd+K (macOS) opens the palette from anywhere (FR-111, FR-299). */
export function usePaletteShortcut() {
  const setOpen = usePalette((s) => s.setOpen);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}

export function CommandPalette() {
  const { t, lang } = useI18n();
  const { open, setOpen } = usePalette();
  const { setLang, setMotion, muted, setMuted } = useSettings();
  const reduced = useReducedMotion();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  usePaletteShortcut();

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => [
    ...SCREENS.filter((s) => !s.hiddenFromNav).map((s) => ({ id: `nav:${s.path}`, label: t('ws.cmd.goto', { name: t(s.label) }), run: () => navigate(hrefFor(s.path)) })),
    ...WS_PERSONAS.map((p) => ({
      id: `persona:${p}`,
      label: t('ws.cmd.persona', { name: t(personaLabel(p)) }),
      run: () => {
        switchPersona(p);
        navigate(hrefFor('/workspace'));
      },
    })),
    { id: 'reset', label: t('ws.cmd.reset'), run: () => resetLayout() },
    { id: 'lang', label: t('ws.cmd.lang'), run: () => setLang(lang === 'ja' ? 'en' : 'ja') },
    { id: 'motion', label: t(reduced ? 'ws.cmd.motionOff' : 'ws.cmd.motionOn'), run: () => setMotion(reduced ? 'full' : 'reduce') },
    { id: 'sound', label: t(muted ? 'ws.cmd.soundOn' : 'ws.cmd.soundOff'), run: () => setMuted(!muted) },
  ], [t, lang, reduced, muted, setLang, setMotion, setMuted]);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));

  const restoreTimers = useRef<number[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback((navigated: boolean) => {
    setOpen(false);
    const target = usePalette.getState().returnTo;
    // Focus returns to where it was; after a navigation that element is gone, so focus the new screen.
    // Retried briefly because the dialog's own focus handling runs while it unmounts.
    const restoreFocus = () => {
      const desired = !navigated && target?.isConnected ? target : document.getElementById('main');
      if (desired && document.activeElement !== desired) desired.focus();
    };
    restoreTimers.current = [0, 50, 150, 300].map((ms) => window.setTimeout(restoreFocus, ms));
  }, [setOpen]);

  // Reopening within those retries must not let them pull focus away from the new search box.
  useEffect(() => {
    if (!open) return;
    restoreTimers.current.forEach((id) => window.clearTimeout(id));
    restoreTimers.current = [];
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    const before = window.location.hash;
    c.run();
    close(window.location.hash !== before);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((current + 1) % Math.max(1, results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((current - 1 + results.length) % Math.max(1, results.length));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[current]);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => {
    if (open) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) close(false); }}>
      <DialogSurface className="ws-palette" aria-label={t('ws.cmd.title')} data-testid="ws-palette">
        <DialogBody>
          <DialogTitle>{t('ws.cmd.title')}</DialogTitle>
          <DialogContent>
            <Input
              autoFocus
              ref={inputRef}
              className="ws-palette-input"
              contentBefore={<Search20Regular aria-hidden />}
              value={query}
              onChange={(_, d) => { setQuery(d.value); setActive(0); }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-label={t('ws.cmd.search')}
              aria-expanded={results.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={results.length ? optionId(current) : undefined}
              placeholder={t('ws.cmd.search')}
              data-testid="ws-palette-input"
            />
            <Text size={200} className="ws-palette-hint">{t('ws.cmd.hint')}</Text>
            {results.length ? (
              <ul id={listId} role="listbox" aria-label={t('ws.cmd.title')} className="ws-palette-list">
                {results.map((c, i) => (
                  <li
                    key={c.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === current}
                    className={`ws-palette-item${i === current ? ' is-active' : ''}`}
                    data-command={c.id}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(c)}
                  >
                    {c.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p id={listId} className="ws-palette-empty" role="status">{t('ws.cmd.empty')}</p>
            )}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

