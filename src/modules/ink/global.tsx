import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ToggleButton, Tooltip } from '@fluentui/react-components';
import { ArrowUndo24Regular, Delete24Regular, Dismiss24Regular, Eraser24Regular, Highlight24Regular, InkStroke24Regular, Pen24Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useRoute } from '../../state/router.ts';
import { UndoStack } from '../../state/history.ts';
import { strokesHitByPath } from './geometry.ts';
import type { Stroke } from './model.ts';
import { HIGHLIGHTER_COLORS, PEN_COLORS, WIDTHS, HIGHLIGHTER_FACTOR, ERASER_RADIUS } from './palette.ts';
import { SCREEN_INK_MAX, useInkOverlay, useScreenInk } from './store.ts';
import { InkSurface, type Tool, type ToolState } from './surface.ts';
import './ink.css';
// Registers the project-deletion purge for stored boards even if /board was never opened this session.
import './storage.ts';

/** FR-091 shortcut: Alt+Shift+I (Ctrl+Shift+I also works where the browser does not reserve it for developer tools). */
export function isOverlayShortcut(e: KeyboardEvent): boolean {
  return e.code === 'KeyI' && e.shiftKey && (e.altKey || e.ctrlKey || e.metaKey);
}

export function TopBarSlot() {
  const { t } = useI18n();
  const active = useInkOverlay((s) => s.active);
  const setActive = useInkOverlay((s) => s.setActive);
  return (
    <Tooltip content={`${t('ink.overlay.toggle')} (Alt+Shift+I)`} relationship="label">
      <ToggleButton
        appearance="subtle"
        icon={<InkStroke24Regular />}
        checked={active}
        aria-keyshortcuts="Alt+Shift+I Control+Shift+I"
        onClick={() => setActive(!active)}
        data-testid="ink-overlay-toggle"
      />
    </Tooltip>
  );
}

type OverlayTool = Extract<Tool, 'pen' | 'highlighter' | 'eraser'>;
const OVERLAY_COLORS = [PEN_COLORS[1], PEN_COLORS[2], PEN_COLORS[3], HIGHLIGHTER_COLORS[0]];
const OVERLAY_TOOLS: { id: OverlayTool; Icon: typeof Pen24Regular }[] = [
  { id: 'pen', Icon: Pen24Regular },
  { id: 'highlighter', Icon: Highlight24Regular },
  { id: 'eraser', Icon: Eraser24Regular },
];

/** FR-091: "ink on screen" annotation layer over any screen; strokes are kept per route. */
export function Overlay() {
  const active = useInkOverlay((s) => s.active);
  const setActive = useInkOverlay((s) => s.setActive);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isOverlayShortcut(e)) {
        e.preventDefault();
        setActive(!useInkOverlay.getState().active);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActive]);
  return active ? <ScreenInk onExit={() => setActive(false)} /> : null;
}

function ScreenInk({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const route = useRoute();
  const routeKey = route.path;
  const all = useScreenInk((s) => s.value);
  const setAll = useScreenInk((s) => s.set);
  const strokes = all[routeKey] ?? [];
  const strokesRef = useRef<Stroke[]>(strokes);
  strokesRef.current = strokes;
  const [tool, setTool] = useState<OverlayTool>('pen');
  const [color, setColor] = useState<string>(PEN_COLORS[1].value);
  const toolState: ToolState = {
    tool,
    color,
    width: WIDTHS.medium,
    highlighterColor: color,
    highlighterWidth: WIDTHS.medium * HIGHLIGHTER_FACTOR,
    eraserRadius: ERASER_RADIUS,
  };
  const toolRef = useRef<ToolState>(toolState);
  toolRef.current = toolState;
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<InkSurface | null>(null);
  const stacks = useRef(new Map<string, UndoStack<Stroke[]>>());
  const [, force] = useState(0);

  const stack = useCallback((key: string) => {
    let s = stacks.current.get(key);
    if (!s) {
      s = new UndoStack<Stroke[]>(useScreenInk.getState().value[key] ?? []);
      stacks.current.set(key, s);
    }
    return s;
  }, []);

  const write = useCallback((next: Stroke[], record: boolean) => {
    const capped = next.length > SCREEN_INK_MAX ? next.slice(next.length - SCREEN_INK_MAX) : next;
    if (record) stack(routeKey).push(capped);
    setAll((prev) => ({ ...prev, [routeKey]: capped }));
    force((n) => n + 1);
  }, [routeKey, setAll, stack]);
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    const root = rootRef.current;
    const base = baseRef.current;
    const live = liveRef.current;
    if (!root || !base || !live) return;
    const surface = new InkSurface(root, base, live, {
      strokes: () => strokesRef.current,
      tool: () => toolRef.current,
      commitStroke: (s) => writeRef.current([...strokesRef.current, s], true),
      erase: (path, r) => {
        const ids = new Set(strokesHitByPath(strokesRef.current, path, r));
        if (ids.size) writeRef.current(strokesRef.current.filter((x) => !ids.has(x.id)), true);
      },
      lasso: () => {},
      selectionBox: () => null,
      selectedStrokes: () => [],
      moveSelection: () => {},
    }, { fixedView: true });
    surfaceRef.current = surface;
    const returnFocus = document.activeElement as HTMLElement | null;
    root.focus({ preventScroll: true });
    return () => {
      surface.destroy();
      surfaceRef.current = null;
      returnFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    surfaceRef.current?.invalidate();
  }, [strokes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const undo = () => {
    const s = stack(routeKey);
    if (s.canUndo) write(s.undo(), false);
  };

  return (
    <div className="ink-overlay" data-testid="ink-overlay">
      <div
        ref={rootRef}
        className="ink-overlay-stage"
        role="application"
        tabIndex={-1}
        aria-label={t('ink.overlay.label')}
        data-stroke-count={strokes.length}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            undo();
          }
        }}
      >
        <canvas ref={baseRef} className="ink-canvas" aria-hidden />
        <canvas ref={liveRef} className="ink-canvas" aria-hidden />
      </div>
      <div className="ink-overlay-toolbar" role="toolbar" aria-label={t('ink.overlay.toolbar')}>
        {OVERLAY_TOOLS.map(({ id, Icon }) => (
          <Tooltip key={id} content={t(`ink.tool.${id}` as MessageKey)} relationship="label">
            <ToggleButton appearance="subtle" icon={<Icon />} checked={tool === id} onClick={() => setTool(id)} />
          </Tooltip>
        ))}
        {OVERLAY_COLORS.map((c) => (
          <Tooltip key={c.value} content={t(`ink.color.${c.id}` as MessageKey)} relationship="label">
            <button
              type="button"
              className="ink-swatch"
              style={{ background: c.value }}
              aria-pressed={color === c.value && tool !== 'eraser'}
              onClick={() => {
                setColor(c.value);
                setTool(c.value === HIGHLIGHTER_COLORS[0].value ? 'highlighter' : 'pen');
              }}
            />
          </Tooltip>
        ))}
        <Tooltip content={t('ink.undo')} relationship="label">
          <Button appearance="subtle" icon={<ArrowUndo24Regular />} disabled={!stack(routeKey).canUndo} onClick={undo} />
        </Tooltip>
        <Tooltip content={t('ink.overlay.clear')} relationship="label">
          <Button appearance="subtle" icon={<Delete24Regular />} disabled={!strokes.length} onClick={() => write([], true)} />
        </Tooltip>
        <Button appearance="primary" icon={<Dismiss24Regular />} onClick={onExit} data-testid="ink-overlay-exit">{t('ink.overlay.exit')}</Button>
      </div>
    </div>
  );
}

