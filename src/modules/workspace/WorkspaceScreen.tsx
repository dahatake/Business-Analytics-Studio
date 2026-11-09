import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Button, Menu, MenuDivider, MenuGroup, MenuGroupHeader, MenuItem, MenuItemCheckbox, MenuItemRadio, MenuList, MenuPopover,
  MenuTrigger, ToggleButton, type MenuProps,
} from '@fluentui/react-components';
import {
  Pin16Regular, PinOff16Regular, ArrowMaximize16Regular, ArrowMinimize16Regular, Subtract16Regular, Maximize16Regular,
  SquareMultiple16Regular, EyeOff16Regular, LayoutCellFour16Regular, ArrowReset20Regular, LayoutCellFour20Regular,
  Grid20Regular, Options20Regular, History16Regular, WindowNew16Regular, ArrowImport16Regular,
} from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { personaLabel } from '../../state/personas.ts';
import { useRoute } from '../../state/router.ts';
import { PageHeader } from '../../ui/Panel.tsx';
import {
  WS_PARAMS, TEMPLATES, TEMPLATE_IDS, applySnap, applyTemplate, arrangeByImportance, displayRect, enlargedRect,
  fitToArea, hide, maximize, maximizedId, minimize, moveWin, nudge, resizeBy, restore, snapPreview, snapTargetAt,
  templateDwell, toggleExpand, togglePin, touch, type Area, type ExpandPosition, type Layout, type Rect, type SnapTarget,
  type TemplateId, type Win, type WinState,
} from './layout.ts';
import { COMPONENT_IDS, WS_PERSONAS, type ComponentId, type WsPersona } from './personas.ts';
import { COMPONENTS } from './hosts.tsx';
import {
  collapseAllExpanded, layoutOf, resetLayout, setLayout, setOptions, switchClock, switchPersona, useLayout, useOptions,
  usePersona, useRecent, useWorkspace,
} from './store.ts';
import { defaultPlacement, isPoppedOut, popoutRoute } from './popout.ts';
import { bringBack, hasWindowManagement, openPopout, usePopoutHost, usePopouts } from './popoutRuntime.ts';
import { PopoutScreen, ScreenPicker, type PopoutOutcome } from './PopoutScreen.tsx';
import './workspace.css';

const STATE_KEY: Record<WinState | 'expanded' | 'popped', MessageKey> = {
  normal: 'ws.state.normal',
  maximized: 'ws.state.maximized',
  minimized: 'ws.state.minimized',
  hidden: 'ws.state.hidden',
  back: 'ws.state.back',
  expanded: 'ws.state.expanded',
  popped: 'ws.state.popped',
};

const OUTCOME_KEY: Record<PopoutOutcome | 'unsupported', MessageKey> = {
  screen: 'ws.popout.openedOn',
  here: 'ws.popout.openedHere',
  unsupported: 'ws.popout.unsupported',
  denied: 'ws.popout.denied',
  blocked: 'ws.popout.blocked',
};

const TEMPLATE_KEY: Record<TemplateId, MessageKey> = {
  halves: 'ws.template.halves',
  mainSide: 'ws.template.mainSide',
  mainStack: 'ws.template.mainStack',
  zones: 'ws.template.zones',
  quarters: 'ws.template.quarters',
};

const SNAP_ITEMS: { target: SnapTarget; label: MessageKey }[] = [
  { target: 'left', label: 'ws.snap.left' },
  { target: 'right', label: 'ws.snap.right' },
  { target: 'top', label: 'ws.snap.top' },
  { target: 'bottom', label: 'ws.snap.bottom' },
  { target: 'top-left', label: 'ws.snap.topLeft' },
  { target: 'top-right', label: 'ws.snap.topRight' },
  { target: 'bottom-left', label: 'ws.snap.bottomLeft' },
  { target: 'bottom-right', label: 'ws.snap.bottomRight' },
  { target: 'maximize', label: 'ws.snap.maximize' },
];

const EXPAND_KEY: Record<ExpandPosition, MessageKey> = {
  top: 'ws.expand.top',
  left: 'ws.expand.left',
  right: 'ws.expand.right',
  bottom: 'ws.expand.bottom',
};

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const rectStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
const focusLater = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

type Slot = { template: TemplateId; slot: number };

interface DragData {
  id: string;
  sx: number;
  sy: number;
  rect: Rect;
  base: Layout;
  moved: boolean;
  next: Rect;
  target: SnapTarget | null;
  dwell: number | null;
  timer: number;
  templates: boolean;
  slot: Slot | null;
}

interface DragView {
  id: string;
  preview: Layout;
  target: SnapTarget | null;
  templates: boolean;
  slot: Slot | null;
}

/** The workspace; `#/workspace/popout/<id>` shows one component alone in its own window (FR-298). */
export function WorkspaceScreen() {
  const route = useRoute();
  const popout = popoutRoute(route.segments);
  return popout ? <PopoutScreen id={popout.id} /> : <WorkspaceMain />;
}

/** The free-layout workspace whose components are existing app views. */
function WorkspaceMain() {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const persona = usePersona();
  const layout = useLayout();
  const recent = useRecent();
  const { expand, enlarge } = useOptions();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Area>({ width: 0, height: 0 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [switchMs, setSwitchMs] = useState<number | null>(null);
  const drag = useRef<DragData | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  const areaRef = useRef(area);
  areaRef.current = area;

  const name = useCallback((id: string) => t(COMPONENTS[id as ComponentId]?.label ?? 'ws.title'), [t]);
  const announce = useCallback((key: MessageKey, id: string) => setLive(t(key, { name: name(id) })), [t, name]);
  const apply = useCallback((f: (l: Layout, a: Area) => Layout) => setLayout((l) => f(l, areaRef.current)), []);

  // ---------- FR-298: components in their own window (any display) ----------
  const popped = usePopouts((s) => s.ids);
  const [picker, setPicker] = useState<ComponentId | null>(null);
  const [notice, setNotice] = useState('');
  usePopoutHost((id) => {
    announce('ws.live.returned', id);
    setNotice('');
  });

  const reportPopout = (id: ComponentId, outcome: PopoutOutcome | 'unsupported', screen?: string) => {
    const msg = t(OUTCOME_KEY[outcome], { name: name(id), screen: screen ?? '' });
    setNotice(msg);
    setLive(msg);
  };
  const doPopout = (id: string) => {
    const cid = id as ComponentId;
    if (!COMPONENTS[cid]) return;
    if (hasWindowManagement()) {
      setPicker(cid);
      return;
    }
    const w = openPopout(cid, defaultPlacement());
    reportPopout(cid, w ? 'unsupported' : 'blocked');
  };
  const doBringBack = (id: string) => {
    bringBack(id as ComponentId);
    announce('ws.live.returned', id);
    setNotice('');
    focusLater(`ws-handle-${id}`);
  };

  useEffect(() => collapseAllExpanded(), []);

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setArea((a) => (a.width === r.width && a.height === r.height ? a : { width: r.width, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the layout readable on this area (min size, max visible); pinned components keep their ratios (FR-216).
  // An area smaller than one minimum window is a transient state (first paint, collapsed panel): never refit to it.
  useEffect(() => {
    if (area.width < WS_PARAMS.minWidthPx || area.height < WS_PARAMS.minHeightPx) return;
    const current = layoutOf(useWorkspace.getState().value);
    const fitted = fitToArea(current, area);
    if (JSON.stringify(fitted) !== JSON.stringify(current)) setLayout(() => fitted);
  }, [area, persona]);

  // PARAM-139: time of the persona (mode) switch, measured once the new layout is painted.
  useEffect(() => {
    if (!switchClock.startedAt) return;
    const raf = requestAnimationFrame(() => {
      setSwitchMs(Math.round(performance.now() - switchClock.startedAt));
      switchClock.startedAt = 0;
    });
    return () => cancelAnimationFrame(raf);
  }, [persona]);

  const shownLayout = dragView?.preview ?? layout;
  const maxId = maximizedId(shownLayout);

  // ---------- Pointer drag (FR-183 handle, FR-184 push-aside, FR-152 snap, FR-305 templates) ----------
  const updateView = (d: DragData) => setDragView({ id: d.id, preview: moveWin(d.base, d.id, d.next, areaRef.current), target: d.target, templates: d.templates, slot: d.slot });

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLElement>, w: Win) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect = displayRect(w);
    drag.current = { id: w.id, sx: e.clientX, sy: e.clientY, rect, base: layoutOf(useWorkspace.getState().value), moved: false, next: rect, target: null, dwell: null, timer: 0, templates: false, slot: null };
  };

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    const box = canvasRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const a = areaRef.current;
    d.next = { ...d.rect, x: d.rect.x + dx / a.width, y: d.rect.y + dy / a.height };
    const px = e.clientX - box.left, py = e.clientY - box.top;
    d.target = snapTargetAt(px, py, a);
    const dwell = templateDwell(d.dwell, d.target === 'template', performance.now());
    d.dwell = dwell.since;
    if (dwell.open) d.templates = true;
    if (d.target === 'template' && !d.templates && !d.timer) {
      d.timer = window.setTimeout(() => {
        if (drag.current === d && d.dwell !== null) {
          d.templates = true;
          updateView(d);
        }
      }, WS_PARAMS.templateDwellMs);
    }
    if (d.target !== 'template') {
      window.clearTimeout(d.timer);
      d.timer = 0;
    }
    if (d.templates) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-ws-slot]');
      d.slot = el ? { template: el.dataset.wsTemplate as TemplateId, slot: Number(el.dataset.wsSlot) } : null;
      if (d.slot) d.target = null;
      // Leaving the popup downwards closes it.
      else if (py > 200) d.templates = false;
    }
    updateView(d);
  };

  const endDrag = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragView(null);
    if (!d) return;
    window.clearTimeout(d.timer);
    if (!commit || !d.moved) return;
    if (d.templates && d.slot) {
      const { template, slot } = d.slot;
      apply((l, a) => applyTemplate(l, template, slot, d.id, a));
      announce('ws.live.template', d.id);
    } else if (d.target && d.target !== 'template') {
      const target = d.target;
      apply((l, a) => applySnap(l, d.id, target, a));
      announce(target === 'maximize' ? 'ws.live.maximized' : 'ws.live.snapped', d.id);
    } else {
      apply((l, a) => moveWin(l, d.id, d.next, a));
      announce('ws.live.moved', d.id);
    }
  };

  // ---------- Commands shared by buttons, menus and keys ----------
  const doMinimize = (id: string) => {
    apply((l) => minimize(l, id));
    announce('ws.live.minimized', id);
    focusLater(`ws-dock-${id}`);
  };
  const doHide = (id: string) => {
    apply((l) => hide(l, id));
    announce('ws.live.hidden', id);
    focusLater(`ws-dock-${id}`);
  };
  const doRestore = (id: string) => {
    apply((l, a) => restore(l, id, a));
    announce('ws.live.restored', id);
    focusLater(`ws-handle-${id}`);
  };
  const doMaximize = (id: string) => {
    apply((l) => maximize(l, id));
    announce('ws.live.maximized', id);
  };
  const doExpand = (id: string) => {
    apply((l) => toggleExpand(l, id, expand));
    announce('ws.live.expanded', id);
  };
  const doPin = (id: string, pinned: boolean) => {
    apply((l) => togglePin(l, id));
    announce(pinned ? 'ws.live.unpinned' : 'ws.live.pinned', id);
  };
  const doSnap = (id: string, target: SnapTarget) => {
    apply((l, a) => applySnap(l, id, target, a));
    announce(target === 'maximize' ? 'ws.live.maximized' : 'ws.live.snapped', id);
  };
  const doTemplate = (id: string, template: TemplateId, slot: number) => {
    apply((l, a) => applyTemplate(l, template, slot, id, a));
    announce('ws.live.template', id);
  };

  // NFR-A11Y-004 / FR-299: every drag has a key alternative; Ctrl (Windows) / Cmd (macOS) + arrows snap like the OS.
  const onHandleKeyDown = (e: KeyboardEvent<HTMLElement>, w: Win) => {
    const step = WS_PARAMS.keyStep;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const arrow = arrows[e.key];
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (arrow && mod) {
      if (e.key === 'ArrowLeft') doSnap(w.id, 'left');
      else if (e.key === 'ArrowRight') doSnap(w.id, 'right');
      else if (e.key === 'ArrowUp') doMaximize(w.id);
      else if (w.state === 'maximized') doRestore(w.id);
      else doMinimize(w.id);
    } else if (arrow && e.shiftKey) {
      apply((l, a) => resizeBy(l, w.id, arrow[0], arrow[1], a));
      announce('ws.live.resized', w.id);
    } else if (arrow) {
      apply((l, a) => nudge(l, w.id, arrow[0], arrow[1], a));
      announce('ws.live.moved', w.id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      doExpand(w.id);
    } else if (e.key.toLowerCase() === 'f' && e.shiftKey && !mod) {
      doMaximize(w.id);
    } else if (e.key === 'Escape' && (w.state === 'maximized' || w.expandedFrom)) {
      if (w.state === 'maximized') doRestore(w.id);
      else doExpand(w.id);
    } else if (e.key.toLowerCase() === 'h' && !mod && !e.shiftKey && !e.altKey) {
      doHide(w.id);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const activate = (id: string) => {
    setActiveId(id);
    const l = layoutOf(useWorkspace.getState().value);
    const w = l.wins.find((x) => x.id === id);
    if (w && w.z < l.seq) setLayout((cur) => touch(cur, id));
  };

  const frontId = useMemo(() => [...layout.wins].filter((w) => w.state === 'normal' || w.state === 'maximized').sort((a, b) => b.z - a.z)[0]?.id ?? null, [layout]);
  const minimized = layout.wins.filter((w) => w.state === 'minimized');
  const ordered = COMPONENT_IDS.map((id) => shownLayout.wins.find((w) => w.id === id)).filter((w): w is Win => !!w);
  const preview = dragView?.target ? snapPreview(dragView.target) : null;

  const onPersona = (p: WsPersona) => {
    if (p === persona) return;
    switchPersona(p);
    setActiveId(null);
    setLive(t('ws.live.persona', { name: t(personaLabel(p)) }));
  };

  const onOptions: MenuProps['onCheckedValueChange'] = (_, data) => {
    if (data.name === 'expand') setOptions({ expand: data.checkedItems[0] as ExpandPosition });
    if (data.name === 'enlarge') setOptions({ enlarge: data.checkedItems.includes('on') });
  };

  return (
    <div className="screen ws-screen" data-testid="workspace">
      <PageHeader
        title={t('ws.title')}
        subtitle={t('ws.subtitle')}
        actions={(
          <div className="ws-actions">
            <div role="group" aria-label={t('ws.persona.label')} className="ws-personas" data-testid="ws-personas">
              {WS_PERSONAS.map((p) => (
                <ToggleButton key={p} size="small" checked={p === persona} onClick={() => onPersona(p)} data-persona={p}>
                  {t(personaLabel(p))}
                </ToggleButton>
              ))}
            </div>
            <Button size="small" icon={<ArrowReset20Regular />} onClick={() => { resetLayout(); setLive(t('ws.live.reset')); }} data-testid="ws-reset">
              {t('ws.reset')}
            </Button>
            <Button size="small" icon={<Grid20Regular />} disabled={!frontId} onClick={() => frontId && apply((l, a) => arrangeByImportance(l, activeId ?? frontId, a))}>
              {t('ws.arrange')}
            </Button>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button size="small" icon={<LayoutCellFour20Regular />} disabled={!frontId}>{t('ws.templatesMenu')}</Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {TEMPLATE_IDS.map((tid) => (
                    <MenuItem key={tid} onClick={() => frontId && doTemplate(activeId ?? frontId, tid, 0)}>{t(TEMPLATE_KEY[tid])}</MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
            <Menu checkedValues={{ expand: [expand], enlarge: enlarge ? ['on'] : [] }} onCheckedValueChange={onOptions}>
              <MenuTrigger disableButtonEnhancement>
                <Button size="small" icon={<Options20Regular />}>{t('ws.options')}</Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuGroup>
                    <MenuGroupHeader>{t('ws.options.expand')}</MenuGroupHeader>
                    {(Object.keys(EXPAND_KEY) as ExpandPosition[]).map((p) => (
                      <MenuItemRadio key={p} name="expand" value={p}>{t(EXPAND_KEY[p])}</MenuItemRadio>
                    ))}
                  </MenuGroup>
                  <MenuDivider />
                  <MenuItemCheckbox name="enlarge" value="on">{t('ws.options.enlarge')}</MenuItemCheckbox>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        )}
      />

      <div className="ws-recent" data-testid="ws-recent">
        <h2 className="ws-small-title" id="ws-recent-title"><History16Regular aria-hidden />{t('ws.recent')}</h2>
        {recent.length === 0 ? <span className="ws-muted">{t('ws.recentEmpty')}</span> : (
          <ul aria-labelledby="ws-recent-title">
            {recent.slice(0, WS_PARAMS.recentMax).map((r) => (
              <li key={r.persona}>
                <Button size="small" appearance="subtle" onClick={() => onPersona(r.persona)} aria-current={r.persona === persona ? 'true' : undefined}>
                  {t(personaLabel(r.persona))}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p id="ws-help" className="ws-help">{t('ws.help')}</p>
      {notice && <p className="ws-notice" data-testid="ws-notice">{notice}</p>}
      <ScreenPicker
        id={picker}
        onClose={() => setPicker(null)}
        onDone={(id, outcome, screen) => {
          setPicker(null);
          reportPopout(id, outcome, screen);
        }}
      />

      <div className="ws-body">
        <nav className="ws-minibar" aria-label={t('ws.minibar')} data-testid="ws-minibar">
          <ul>
            {minimized.map((w) => {
              const c = COMPONENTS[w.id as ComponentId];
              if (!c) return null;
              return (
                <li key={w.id}>
                  <Button
                    appearance="subtle"
                    icon={<c.Icon />}
                    aria-label={t('ws.minibar.restore', { name: name(w.id) })}
                    title={t('ws.minibar.restore', { name: name(w.id) })}
                    onClick={() => doRestore(w.id)}
                    className="ws-mini-btn"
                    style={{ borderLeftColor: c.accent }}
                    data-mini={w.id}
                  />
                </li>
              );
            })}
          </ul>
        </nav>

        <div
          ref={canvasRef}
          className={`ws-canvas${maxId ? ' ws-immersive' : ''}`}
          data-testid="ws-canvas"
          data-persona={persona}
          data-switch-ms={switchMs ?? undefined}
          role="region"
          aria-label={t('ws.canvas')}
        >
          {preview && <div className="ws-snap-preview" data-testid="ws-snap-preview" data-target={dragView?.target ?? ''} style={rectStyle(preview)} aria-hidden />}
          {dragView?.templates && (
            <div className="ws-templates" data-testid="ws-templates" aria-hidden>
              {TEMPLATE_IDS.map((tid) => (
                <div key={tid} className="ws-template" data-template={tid}>
                  {TEMPLATES[tid].map((r, i) => (
                    <div
                      key={i}
                      className={`ws-template-slot${dragView.slot?.template === tid && dragView.slot.slot === i ? ' is-hot' : ''}`}
                      data-ws-template={tid}
                      data-ws-slot={i}
                      style={rectStyle(r)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
          {ordered.map((w) => (
            <WsWindow
              key={w.id}
              win={w}
              layout={shownLayout}
              dragging={dragView?.id === w.id}
              reduced={reduced}
              active={activeId === w.id}
              enlarge={enlarge && !dragView}
              onActivate={activate}
              onPointerDown={onHandlePointerDown}
              onPointerMove={onHandlePointerMove}
              onPointerUp={() => endDrag(true)}
              onPointerCancel={() => endDrag(false)}
              onKeyDown={onHandleKeyDown}
              onExpand={doExpand}
              onPin={doPin}
              onMinimize={doMinimize}
              onMaximize={doMaximize}
              onRestore={doRestore}
              onHide={doHide}
              onSnap={doSnap}
              onTemplate={doTemplate}
              popped={isPoppedOut(popped, w.id)}
              onPopout={doPopout}
              onBringBack={doBringBack}
            />
          ))}
        </div>
      </div>

      <section className="ws-dock" aria-labelledby="ws-dock-title" data-testid="ws-dock">
        <h2 className="ws-small-title" id="ws-dock-title">{t('ws.dock')}</h2>
        <ul>
          {layout.wins.map((w) => {
            const c = COMPONENTS[w.id as ComponentId];
            if (!c) return null;
            const isPopped = isPoppedOut(popped, w.id);
            const state = isPopped ? 'popped' : w.expandedFrom ? 'expanded' : w.state;
            return (
              <li key={w.id}>
                <Button
                  id={`ws-dock-${w.id}`}
                  size="small"
                  appearance={w.id === frontId ? 'primary' : 'secondary'}
                  icon={<c.Icon />}
                  onClick={() => (isPopped ? doBringBack(w.id) : doRestore(w.id))}
                  data-state={state}
                  data-dock={w.id}
                >
                  {t('ws.dock.item', { name: name(w.id), state: t(STATE_KEY[state]) })}
                </Button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="visually-hidden" aria-live="polite" data-testid="ws-live">{live}</div>
    </div>
  );
}

interface WsWindowProps {
  win: Win;
  layout: Layout;
  dragging: boolean;
  reduced: boolean;
  active: boolean;
  enlarge: boolean;
  onActivate: (id: string) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, w: Win) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, w: Win) => void;
  onExpand: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onMinimize: (id: string) => void;
  onMaximize: (id: string) => void;
  onRestore: (id: string) => void;
  onHide: (id: string) => void;
  onSnap: (id: string, target: SnapTarget) => void;
  onTemplate: (id: string, template: TemplateId, slot: number) => void;
  popped: boolean;
  onPopout: (id: string) => void;
  onBringBack: (id: string) => void;
}

function WsWindow(p: WsWindowProps) {
  const { t } = useI18n();
  const { win: w } = p;
  const c = COMPONENTS[w.id as ComponentId];
  if (!c) return null;
  const shown = w.state === 'normal' || w.state === 'maximized';
  // FR-297: the components sent back by a maximize stay visible behind it, dimmed (immersive view).
  const dimmed = w.state === 'back' && w.backReason === 'max';
  const rect = shown && p.active && p.enlarge ? enlargedRect(p.layout, w.id) ?? w.rect : w.rect;
  const style: CSSProperties = {
    ...(w.state === 'maximized' ? { left: '1.5%', top: '1.5%', width: '97%', height: '97%' } : rectStyle(rect)),
    zIndex: w.state === 'maximized' ? 1000 : dimmed ? 1 : w.z + 10,
    borderTopColor: c.accent,
    ...(p.reduced || p.dragging ? { transition: 'none' } : {}),
  };
  const title = t(c.label);
  const titleId = `ws-title-${w.id}`;
  const View = c.View;
  const label = (key: MessageKey) => t(key, { name: title });
  return (
    <section
      className={`ws-win${p.active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}${p.dragging ? ' is-dragging' : ''}${w.pinned ? ' is-pinned' : ''}`}
      data-ws-win={w.id}
      data-state={w.expandedFrom ? 'expanded' : w.state}
      data-pinned={w.pinned ? 'true' : 'false'}
      data-popped={p.popped ? 'true' : 'false'}
      data-x={w.rect.x}
      data-y={w.rect.y}
      data-w={w.rect.w}
      data-h={w.rect.h}
      aria-labelledby={titleId}
      hidden={!shown && !dimmed}
      inert={dimmed || undefined}
      aria-hidden={dimmed || undefined}
      style={style}
      onFocus={() => p.onActivate(w.id)}
      onPointerDown={() => p.onActivate(w.id)}
    >
      <div className="ws-win-header">
        <h2 className="ws-win-title" id={titleId}>
          <span
            role="button"
            tabIndex={0}
            id={`ws-handle-${w.id}`}
            className="ws-handle"
            aria-describedby="ws-help"
            data-testid={`ws-handle-${w.id}`}
            onPointerDown={(e) => p.onPointerDown(e, w)}
            onPointerMove={p.onPointerMove}
            onPointerUp={p.onPointerUp}
            onPointerCancel={p.onPointerCancel}
            onDoubleClick={() => p.onExpand(w.id)}
            onKeyDown={(e) => p.onKeyDown(e, w)}
          >
            <c.Icon aria-hidden />
            <span>{title}</span>
          </span>
        </h2>
        {/* PARAM-073: at most 6 always-visible header buttons (FR-150). */}
        <div className="ws-win-actions">
          <Button size="small" appearance="subtle" icon={w.pinned ? <PinOff16Regular /> : <Pin16Regular />} aria-pressed={w.pinned} aria-label={label('ws.act.pin')} title={label('ws.act.pin')} onClick={() => p.onPin(w.id, w.pinned)} data-testid={`ws-pin-${w.id}`} />
          <Button size="small" appearance="subtle" icon={w.expandedFrom ? <ArrowMinimize16Regular /> : <ArrowMaximize16Regular />} aria-pressed={!!w.expandedFrom} aria-label={label('ws.act.expand')} title={label('ws.act.expand')} onClick={() => p.onExpand(w.id)} />
          <Button size="small" appearance="subtle" icon={<Subtract16Regular />} aria-label={label('ws.act.minimize')} title={label('ws.act.minimize')} onClick={() => p.onMinimize(w.id)} data-testid={`ws-min-${w.id}`} />
          {w.state === 'maximized'
            ? <Button size="small" appearance="subtle" icon={<SquareMultiple16Regular />} aria-label={label('ws.act.restore')} title={label('ws.act.restore')} onClick={() => p.onRestore(w.id)} />
            : <Button size="small" appearance="subtle" icon={<Maximize16Regular />} aria-label={label('ws.act.maximize')} title={label('ws.act.maximize')} onClick={() => p.onMaximize(w.id)} data-testid={`ws-max-${w.id}`} />}
          <Button size="small" appearance="subtle" icon={<EyeOff16Regular />} aria-label={label('ws.act.hide')} title={label('ws.act.hide')} onClick={() => p.onHide(w.id)} />
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<LayoutCellFour16Regular />} aria-label={label('ws.act.snap')} title={label('ws.act.snap')} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuGroup>
                  <MenuGroupHeader>{t('ws.snap.group')}</MenuGroupHeader>
                  {SNAP_ITEMS.map((s) => <MenuItem key={s.target} onClick={() => p.onSnap(w.id, s.target)}>{t(s.label)}</MenuItem>)}
                </MenuGroup>
                <MenuDivider />
                <MenuGroup>
                  <MenuGroupHeader>{t('ws.template.group')}</MenuGroupHeader>
                  {TEMPLATE_IDS.flatMap((tid) => TEMPLATES[tid].map((_, i) => (
                    <MenuItem key={`${tid}-${i}`} onClick={() => p.onTemplate(w.id, tid, i)}>
                      {t('ws.template.slot', { template: t(TEMPLATE_KEY[tid]), slot: i + 1 })}
                    </MenuItem>
                  )))}
                </MenuGroup>
                <MenuDivider />
                <MenuGroup>
                  <MenuGroupHeader>{t('ws.popout.group')}</MenuGroupHeader>
                  {p.popped
                    ? <MenuItem icon={<ArrowImport16Regular />} onClick={() => p.onBringBack(w.id)} data-testid={`ws-menu-bringback-${w.id}`}>{t('ws.popout.bringBack')}</MenuItem>
                    : <MenuItem icon={<WindowNew16Regular />} onClick={() => p.onPopout(w.id)} data-testid={`ws-popout-${w.id}`}>{t('ws.popout.open')}</MenuItem>}
                </MenuGroup>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </div>
      {p.popped ? (
        <div className="ws-win-body ws-popped" data-testid={`ws-popped-${w.id}`}>
          <WindowNew16Regular aria-hidden />
          <p>{t('ws.popout.placeholder', { name: title })}</p>
          <Button size="small" appearance="primary" icon={<ArrowImport16Regular />} aria-label={label('ws.popout.bringBackName')} onClick={() => p.onBringBack(w.id)} data-testid={`ws-bringback-${w.id}`}>
            {t('ws.popout.bringBack')}
          </Button>
        </div>
      ) : (
        /* Focusable so long content can be scrolled with the keyboard (WCAG 2.1.1). */
        <div className="ws-win-body" tabIndex={0} role="group" aria-labelledby={titleId}>
          <View />
        </div>
      )}
    </section>
  );
}
