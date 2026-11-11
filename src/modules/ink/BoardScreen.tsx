import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { appStorage as localStorage } from '../../data/deviceStorage.ts';
import {
  Button, Field, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Select, Text, ToggleButton, Tooltip,
} from '@fluentui/react-components';
import {
  Add24Regular, ArrowDownload24Regular, ArrowRedo24Regular, ArrowUndo24Regular, CardUi24Regular, Delete24Regular, Eraser24Regular,
  EraserSegment24Regular, Highlight24Regular, Lasso24Regular, Link24Regular, NoteAdd24Regular, Pen24Regular, PenSparkle24Regular,
  Rename24Regular, Shapes24Regular, Wand24Regular, ZoomFit24Regular, ZoomIn24Regular, ZoomOut24Regular, Organization24Regular,
} from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useActiveProject, useCurrentScope } from '../../state/projects.ts';
import { useSettings } from '../../state/settings.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { loc } from '../../state/text.ts';
import { getEntity } from '../../data/pack.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import type { AiResponse } from '../../ai/client.ts';
import {
  EMPTY_CONTENT, NOTE_COLORS, initialContent, makeStroke, newId, pruneLinks, resizeItem, seedStrokes, contentBox,
  type BoardContent, type BoardMeta, type Stroke,
} from './model.ts';
import { applyErase, deleteSelection, eraseCircles, lassoSelect, moveSelection, selectionBox, strokesHitByPath, EMPTY_SELECTION, type Selection } from './geometry.ts';
import { recognizeShape, rectanglePoints, ellipsePoints, arrowPoints, type ShapeKind } from './shapes.ts';
import { BoardDoc } from './doc.ts';
import { inkStorage, journalKey } from './storage.ts';
import { useActiveBoard, useBoards } from './store.ts';
import { InkSurface, type Tool, type ToolState } from './surface.ts';
import { ERASER_RADIUS, HIGHLIGHTER_COLORS, HIGHLIGHTER_FACTOR, PEN_COLORS, WIDTHS, type WidthKey } from './palette.ts';
import { CardView, LinksLayer, NoteView, type ItemHandlers } from './Items.tsx';
import { ConfirmDialog, ConnectDialog, ExportDialog, PickerDialog, RecognizeDialog, RenameDialog, type ExportPreview } from './dialogs.tsx';
import { buildBoardMarkdown, buildPdf, buildSummaryPack, boardPngDataUri, download, safeFileName, textFns, type ExportBoard } from './exporters.ts';
import { recognizeHandwriting } from './handwriting.ts';
import { FacilitationPanel } from './Facilitation.tsx';
import './ink.css';

type DialogKind = null | 'rename' | 'delete' | 'export' | 'picker' | 'connect' | 'recognize';
type SaveState = 'saved' | 'dirty';

const TOOLS: { tool: Tool; Icon: typeof Pen24Regular; key: string }[] = [
  { tool: 'pen', Icon: Pen24Regular, key: 'P' },
  { tool: 'highlighter', Icon: Highlight24Regular, key: 'H' },
  { tool: 'eraser', Icon: Eraser24Regular, key: 'E' },
  { tool: 'eraserPartial', Icon: EraserSegment24Regular, key: 'Shift+E' },
  { tool: 'lasso', Icon: Lasso24Regular, key: 'S' },
  { tool: 'link', Icon: Link24Regular, key: 'K' },
];

const focusItem = (id: string) => requestAnimationFrame(() => (document.querySelector(`[data-ink-item="${id}"]`) as HTMLElement | null)?.focus());

export function BoardScreen() {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const reduced = useReducedMotion();
  const scope = useCurrentScope();
  const { project } = useActiveProject();
  const boards = useBoards((s) => s.value);
  const setBoards = useBoards((s) => s.set);
  const activeId = useActiveBoard((s) => s.value);
  const setActive = useActiveBoard((s) => s.set);
  const board: BoardMeta | undefined = boards.find((b) => b.id === activeId) ?? boards[0];
  const boardName = useCallback((b: BoardMeta | undefined) => (b ? b.name ?? t('ink.board.default', { n: boards.indexOf(b) + 1 }) : ''), [boards, t]);

  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<InkSurface | null>(null);
  const docRef = useRef<BoardDoc | null>(null);
  const contentRef = useRef<BoardContent>(EMPTY_CONTENT);
  const moveBaseRef = useRef<BoardContent | null>(null);
  const [content, setContent] = useState<BoardContent>(EMPTY_CONTENT);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [message, setMessage] = useState('');
  const [zoomPct, setZoomPct] = useState(100);

  const [tool, setToolState] = useState<Tool>('pen');
  const [color, setColor] = useState<string>('ink');
  const [hlColor, setHlColor] = useState<string>(HIGHLIGHTER_COLORS[0].value);
  const [widthKey, setWidthKey] = useState<WidthKey>('medium');
  const [beautify, setBeautify] = useState(false);
  const toolState: ToolState = { tool, color, width: WIDTHS[widthKey], highlighterColor: hlColor, highlighterWidth: WIDTHS[widthKey] * HIGHLIGHTER_FACTOR, eraserRadius: ERASER_RADIUS };
  const toolRef = useRef<ToolState>(toolState);
  toolRef.current = toolState;
  const beautifyRef = useRef(beautify);
  beautifyRef.current = beautify;

  const [sel, setSelState] = useState<Selection>(EMPTY_SELECTION);
  const selRef = useRef<Selection>(EMPTY_SELECTION);
  const setSel = useCallback((s: Selection) => {
    selRef.current = s;
    setSelState(s);
    surfaceRef.current?.refreshOverlay();
  }, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  editingRef.current = editingId;
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const linkFromRef = useRef<string | null>(null);
  linkFromRef.current = linkFrom;
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [hwResult, setHwResult] = useState<AiResponse | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const announce = useCallback((text: string) => setMessage(text), []);
  const commit = useCallback((fn: (c: BoardContent) => BoardContent) => {
    const doc = docRef.current;
    if (!doc) return;
    const next = fn(doc.content);
    if (next !== doc.content) doc.commit(next);
  }, []);

  // ---------- surface ----------
  useEffect(() => {
    const root = rootRef.current;
    const base = baseRef.current;
    const live = liveRef.current;
    if (!root || !base || !live) return;
    const surface = new InkSurface(root, base, live, {
      strokes: () => contentRef.current.strokes,
      tool: () => toolRef.current,
      commitStroke: (s: Stroke) => {
        let stroke = s;
        if (beautifyRef.current && s.tool === 'pen') {
          const shape = recognizeShape(s.points);
          if (shape) {
            stroke = makeStroke(s.tool, s.color, s.width, shape.points, s.id);
            setMessage(tRef.current('ink.shape.recognized', { shape: tRef.current(`ink.shape.${shape.kind}` as MessageKey) }));
          }
        }
        commit((c) => ({ ...c, strokes: [...c.strokes, stroke] }));
      },
      erase: (path, r, partial) => {
        if (partial) {
          commit((c) => applyErase(c, eraseCircles(c.strokes, path, r, (b, i) => `${b}.${i}${Math.random().toString(36).slice(2, 6)}`)));
          return;
        }
        const ids = new Set(strokesHitByPath(contentRef.current.strokes, path, r));
        if (ids.size) commit((c) => ({ ...c, strokes: c.strokes.filter((x) => !ids.has(x.id)) }));
      },
      lasso: (poly) => {
        const s = lassoSelect(contentRef.current, poly);
        setSel(s);
        setMessage(tRef.current('ink.lasso.selected', { strokes: s.strokes.length, items: s.items.length }));
      },
      selectionBox: () => selectionBox(contentRef.current, selRef.current),
      selectedStrokes: () => {
        const ids = new Set(selRef.current.strokes);
        return contentRef.current.strokes.filter((x) => ids.has(x.id));
      },
      moveSelection: (dx, dy, final) => {
        const doc = docRef.current;
        if (!doc) return;
        moveBaseRef.current ??= doc.content;
        const base = moveBaseRef.current;
        if (final || (dx === 0 && dy === 0)) {
          moveBaseRef.current = null;
          doc.cancelPreview();
          if (final) commit((c) => moveSelection(c, selRef.current, dx, dy));
          return;
        }
        // Strokes are previewed by the surface; notes and cards move in the DOM.
        doc.preview(moveSelection(base, { strokes: [], items: selRef.current.items }, dx, dy));
      },
      onView: (v) => {
        if (worldRef.current) worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
        setZoomPct(Math.round(v.zoom * 100));
      },
      onPointerDown: () => {
        if (toolRef.current.tool !== 'lasso' && (selRef.current.items.length || selRef.current.strokes.length)) setSel(EMPTY_SELECTION);
      },
    });
    surfaceRef.current = surface;
    return () => {
      surface.destroy();
      surfaceRef.current = null;
    };
  }, [commit, setSel]);

  // ---------- document per scope + board ----------
  const boardId = board?.id;
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    let unsub = () => {};
    const prev = docRef.current;
    docRef.current = null;
    setReady(false);
    setSel(EMPTY_SELECTION);
    setEditingId(null);
    setLinkFrom(null);
    void (async () => {
      await prev?.close();
      const { doc, recovered } = await BoardDoc.open(inkStorage(), scope, boardId, initialContent(scope, boardId));
      if (cancelled) {
        await doc.close();
        return;
      }
      docRef.current = doc;
      doc.onSaved = () => {
        if (docRef.current === doc && !doc.autosaver.pending) setSaveState('saved');
      };
      unsub = doc.subscribe((next, before) => {
        contentRef.current = next;
        setContent(next);
        const s = surfaceRef.current;
        if (s && next.strokes !== before.strokes) {
          const n = before.strokes.length;
          if (next.strokes.length === n + 1 && (n === 0 || next.strokes[n - 1] === before.strokes[n - 1])) s.appendStroke(next.strokes[n]!);
          else s.invalidate();
        }
        setSaveState('dirty');
      });
      contentRef.current = doc.content;
      setContent(doc.content);
      setSaveState(recovered ? 'dirty' : 'saved');
      if (recovered) setMessage(tRef.current('ink.recovered'));
      const surface = surfaceRef.current;
      if (surface) {
        surface.fit(contentBox(doc.content));
        surface.invalidate();
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
      unsub();
    };
  }, [scope, boardId, setSel]);

  // Flush on unmount and when the page is hidden (crash safety beyond the journal).
  useEffect(() => {
    const flush = () => void docRef.current?.autosaver.flush();
    const onVis = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
      void docRef.current?.close();
      docRef.current = null;
    };
  }, []);

  // ---------- diagnostics hook (E2E, NFR-PERF-004) ----------
  useEffect(() => {
    window.__basInk = {
      strokeCount: () => contentRef.current.strokes.length,
      noteCount: () => contentRef.current.notes.length,
      linkCount: () => contentRef.current.links.length,
      seed: async (n: number) => {
        const doc = docRef.current;
        const surface = surfaceRef.current;
        if (!doc || !surface) return 0;
        const { w, h } = surface.size;
        const a = surface.toWorld(0, 0);
        const b = surface.toWorld(w, h);
        doc.replace({ ...doc.content, strokes: [...doc.content.strokes, ...seedStrokes(n, { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y }, (Date.now() % 9973) + 1)] });
        await doc.autosaver.flush();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return doc.content.strokes.length;
      },
      frameStats: () => surfaceRef.current!.frameStats(),
      resetStats: () => surfaceRef.current?.resetStats(),
      flush: async () => docRef.current?.autosaver.flush(),
      lastCommitMs: () => docRef.current?.lastCommitMs ?? 0,
      ready: () => docRef.current !== null,
    };
    return () => {
      delete window.__basInk;
    };
  }, []);

  // ---------- actions ----------
  const setTool = (next: Tool) => {
    setToolState(next);
    setLinkFrom(null);
    if (next !== 'lasso') setSel(EMPTY_SELECTION);
  };
  const undo = () => {
    docRef.current?.undo();
    setSel(EMPTY_SELECTION);
    announce(t('ink.undone'));
  };
  const redo = () => {
    docRef.current?.redo();
    setSel(EMPTY_SELECTION);
    announce(t('ink.redone'));
  };
  const center = () => surfaceRef.current?.center() ?? { x: 200, y: 150 };

  const addNote = () => {
    const c = center();
    const id = newId('note');
    const offset = (contentRef.current.notes.length % 5) * 16;
    commit((cc) => ({ ...cc, notes: [...cc.notes, { id, x: c.x - 90 + offset, y: c.y - 55 + offset, w: 180, h: 110, text: '', color: 'yellow', votes: 0 }] }));
    setSel({ strokes: [], items: [id] });
    setEditingId(id);
    announce(t('ink.note.added'));
  };

  const addCard = (entityId: string) => {
    const c = center();
    const id = newId('card');
    commit((cc) => ({ ...cc, cards: [...cc.cards, { id, entityId, x: c.x - 100, y: c.y - 40, w: 200, h: 80 }] }));
    setDialog(null);
    setSel({ strokes: [], items: [id] });
    announce(t('ink.card.added'));
    focusItem(id);
  };

  const addShape = (kind: ShapeKind) => {
    const c = center();
    const p = 0.5;
    const pts = kind === 'rectangle' ? rectanglePoints(c.x - 80, c.y - 50, c.x + 80, c.y + 50, p)
      : kind === 'ellipse' ? ellipsePoints(c.x, c.y, 80, 50, p)
      : kind === 'line' ? [c.x - 80, c.y, p, c.x + 80, c.y, p]
      : arrowPoints({ x: c.x - 80, y: c.y }, { x: c.x + 80, y: c.y }, 20, p);
    const tsr = toolRef.current;
    const s = makeStroke('pen', tsr.color, tsr.width, pts);
    commit((cc) => ({ ...cc, strokes: [...cc.strokes, s] }));
    setToolState('lasso');
    setSel({ strokes: [s.id], items: [] });
    announce(t('ink.shape.added', { shape: t(`ink.shape.${kind}` as MessageKey) }));
    rootRef.current?.focus();
  };

  const connect = useCallback((from: string, to: string) => {
    if (from === to) return;
    const exists = contentRef.current.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from));
    if (!exists) commit((cc) => ({ ...cc, links: [...cc.links, { id: newId('link'), from, to }] }));
    setLinkFrom(null);
    setMessage(tRef.current(exists ? 'ink.link.exists' : 'ink.link.added'));
  }, [commit]);

  const deleteItems = useCallback((ids: string[]) => {
    commit((c) => pruneLinks(deleteSelection(c, { strokes: [], items: ids })));
    setSel(EMPTY_SELECTION);
    setMessage(tRef.current('ink.deleted'));
    rootRef.current?.focus();
  }, [commit, setSel]);

  const deleteSel = () => {
    const s = selRef.current;
    if (!s.items.length && !s.strokes.length) return;
    commit((c) => pruneLinks(deleteSelection(c, s)));
    setSel(EMPTY_SELECTION);
    announce(t('ink.deleted'));
  };

  const moveSel = (dx: number, dy: number) => {
    commit((c) => moveSelection(c, selRef.current, dx, dy));
    surfaceRef.current?.refreshOverlay();
  };

  const recognize = async () => {
    setHwResult(null);
    setDialog('recognize');
    const ids = new Set(selRef.current.strokes);
    const strokes = ids.size ? contentRef.current.strokes.filter((x) => ids.has(x.id)) : contentRef.current.strokes;
    setHwResult(await recognizeHandwriting(strokes, lang));
  };

  const addRecognizedNote = (text: string) => {
    const c = center();
    commit((cc) => ({ ...cc, notes: [...cc.notes, { id: newId('note'), x: c.x - 90, y: c.y - 55, w: 180, h: 110, text, color: 'marigold', votes: 0 }] }));
    setDialog(null);
    announce(t('ink.note.added'));
  };

  // ---------- boards ----------
  const createBoard = () => {
    const meta: BoardMeta = { id: newId('board'), name: null, createdAt: new Date().toISOString() };
    setBoards((b) => [...b, meta]);
    setActive(meta.id);
    announce(t('ink.board.created'));
  };
  const renameBoard = (name: string) => {
    if (!board) return;
    const v = name.trim();
    setBoards((list) => list.map((b) => (b.id === board.id ? { ...b, name: v || null } : b)));
    setDialog(null);
  };
  const deleteBoard = async () => {
    if (!board || boards.length <= 1) return;
    const id = board.id;
    const rest = boards.filter((b) => b.id !== id);
    const prev = docRef.current;
    docRef.current = null;
    await prev?.close();
    await inkStorage().remove(scope, id);
    localStorage.removeItem(journalKey(scope, id));
    setBoards(rest);
    setActive(rest[0]!.id);
    setDialog(null);
    announce(t('ink.board.deleted'));
  };

  // ---------- export ----------
  const loadAllBoards = async (): Promise<ExportBoard[]> => {
    const out: ExportBoard[] = [];
    for (const b of boards) {
      const c = b.id === board?.id && docRef.current ? docRef.current.content : (await inkStorage().load(scope, b.id)) ?? initialContent(scope, b.id);
      out.push({ name: boardName(b), content: c });
    }
    return out;
  };
  const projectName = project?.name ?? t('ink.demoProject');
  const openExport = async () => {
    setPreview(null);
    setDialog('export');
    await docRef.current?.autosaver.flush();
    const all = await loadAllBoards();
    const current: ExportBoard = { name: boardName(board), content: contentRef.current };
    const fns = textFns(lang, audience);
    const md = buildBoardMarkdown(current, lang, audience);
    const pdf = buildPdf(all, fns, projectName);
    setPreview({ imageDataUri: boardPngDataUri(current, fns), markdown: md, boards: all.length, pdfBytes: pdf.length });
  };
  const exportPdf = async () => {
    const all = await loadAllBoards();
    download(`${safeFileName(projectName)}-boards.pdf`, buildPdf(all, textFns(lang, audience), projectName), 'application/pdf');
    announce(t('ink.export.done'));
  };
  const exportMd = () => {
    download(`${safeFileName(boardName(board))}.md`, buildBoardMarkdown({ name: boardName(board), content: contentRef.current }, lang, audience), 'text/markdown');
    announce(t('ink.export.done'));
  };
  const exportPack = async () => {
    const all = await loadAllBoards();
    download(`${safeFileName(projectName)}-summary-pack.md`, buildSummaryPack(all, lang, audience, projectName), 'text/markdown');
    announce(t('ink.export.done'));
  };

  // ---------- item handlers ----------
  const itemHandlers: ItemHandlers = useMemo(() => ({
    onPointerDown: (e: RPointerEvent<HTMLElement>, id: string, mode: 'move' | 'resize') => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      if (mode === 'move' && target.closest('button, a, textarea, input, [data-entity-ref]')) return;
      e.stopPropagation();
      if (toolRef.current.tool === 'link') {
        const from = linkFromRef.current;
        if (from && from !== id) connect(from, id);
        else {
          setLinkFrom(id);
          setMessage(tRef.current('ink.link.pickTarget'));
        }
        return;
      }
      const doc = docRef.current;
      const surface = surfaceRef.current;
      if (!doc || !surface) return;
      const inSel = selRef.current.items.includes(id);
      const s: Selection = inSel ? selRef.current : { strokes: [], items: [id] };
      if (!inSel) setSel(s);
      const base = doc.content;
      const item = [...base.notes, ...base.cards].find((i) => i.id === id);
      const z = surface.view.zoom;
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
        moved = true;
        const dx = (ev.clientX - sx) / z;
        const dy = (ev.clientY - sy) / z;
        doc.preview(mode === 'move' ? moveSelection(base, s, dx, dy) : resizeItem(base, id, dx, dy, item));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (moved) doc.commit(doc.content);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>, id: string) => {
      if (e.target !== e.currentTarget) return;
      const step = e.shiftKey ? 50 : 10;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const mod = e.ctrlKey || e.metaKey;
      const a = arrows[e.key];
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (a) {
        stop();
        if (e.altKey) commit((c) => resizeItem(c, id, a[0], a[1]));
        else commit((c) => moveSelection(c, { strokes: [], items: [id] }, a[0], a[1]));
        return;
      }
      const k = e.key.toLowerCase();
      if (mod && (k === 'z' || k === 'y')) {
        stop();
        if (k === 'y' || e.shiftKey) docRef.current?.redo();
        else docRef.current?.undo();
        return;
      }
      if (mod) return;
      let handled = true;
      if (e.key === 'Enter' || e.key === 'F2') {
        if (contentRef.current.notes.some((n) => n.id === id)) setEditingId(id);
        else handled = false;
      } else if (e.key === 'Delete' || e.key === 'Backspace') deleteItems([id]);
      else if (k === 'l') {
        const from = linkFromRef.current;
        if (from && from !== id) connect(from, id);
        else {
          setLinkFrom(id);
          setMessage(tRef.current('ink.link.pickTarget'));
        }
      } else if (k === 'v') commit((c) => ({ ...c, notes: c.notes.map((n) => (n.id === id ? { ...n, votes: n.votes + 1 } : n)) }));
      else if (e.key === 'Escape') {
        setLinkFrom(null);
        setSel(EMPTY_SELECTION);
        rootRef.current?.focus();
      } else handled = false;
      if (handled) stop();
    },
    onFocusItem: (id: string) => {
      if (!selRef.current.items.includes(id)) setSel({ strokes: [], items: [id] });
    },
    onEdit: (id: string) => setEditingId(id),
    onSaveText: (id: string, text: string | null) => {
      if (editingRef.current !== id) return;
      editingRef.current = null;
      setEditingId(null);
      if (text !== null) {
        const n = contentRef.current.notes.find((x) => x.id === id);
        if (n && loc(n.text, useSettings.getState().lang) !== text) commit((c) => ({ ...c, notes: c.notes.map((x) => (x.id === id ? { ...x, text } : x)) }));
      }
      focusItem(id);
    },
    onVote: (id: string) => commit((c) => ({ ...c, notes: c.notes.map((n) => (n.id === id ? { ...n, votes: n.votes + 1 } : n)) })),
    onCycleColor: (id: string) => commit((c) => ({
      ...c,
      notes: c.notes.map((n) => (n.id === id ? { ...n, color: NOTE_COLORS[(NOTE_COLORS.indexOf(n.color) + 1) % NOTE_COLORS.length]! } : n)),
    })),
    onDelete: (id: string) => deleteItems([id]),
  }), [commit, connect, deleteItems, setSel]);

  // ---------- canvas keyboard ----------
  const onStageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const hasSel = selRef.current.items.length > 0 || selRef.current.strokes.length > 0;
    const step = e.shiftKey ? 50 : 10;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[e.key];
    let handled = true;
    if (mod && k === 'z') (e.shiftKey ? redo : undo)();
    else if (mod && k === 'y') redo();
    else if (mod || e.altKey) handled = false;
    else if (arrow) {
      if (hasSel) moveSel(arrow[0] * step, arrow[1] * step);
      else surface.panBy(-arrow[0] * step * 4, -arrow[1] * step * 4);
    } else if (e.key === '+' || e.key === '=') surface.zoomAt(1.25);
    else if (e.key === '-' || e.key === '_') surface.zoomAt(0.8);
    else if (e.key === '0') surface.fit(contentBox(contentRef.current));
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSel();
    else if (e.key === 'Escape') {
      setSel(EMPTY_SELECTION);
      setLinkFrom(null);
    } else if (k === 'n') addNote();
    else if (k === 'c') setDialog('picker');
    else if (k === 'p') setTool('pen');
    else if (k === 'h') setTool('highlighter');
    else if (k === 'e') setTool(e.shiftKey ? 'eraserPartial' : 'eraser');
    else if (k === 's') setTool('lasso');
    else if (k === 'k') setTool('link');
    else handled = false;
    if (handled) e.preventDefault();
  };

  const doc = docRef.current;
  const canUndo = ready && !!doc?.canUndo;
  const canRedo = ready && !!doc?.canRedo;
  const itemOptions = useMemo(() => [
    ...content.notes.map((n) => ({ id: n.id, label: `${t('ink.item.note')}: ${loc(n.text, lang) || t('ink.note.empty')}` })),
    ...content.cards.map((k) => {
      const e = getEntity(k.entityId);
      const name = !e ? k.entityId : isHidden(e, audience) ? t('card.restrictedName') : e.name[lang];
      return { id: k.id, label: `${t('ink.item.card')}: ${name}` };
    }),
  ], [content.notes, content.cards, lang, audience, t]);
  const labelOf = (id: string) => itemOptions.find((o) => o.id === id)?.label ?? id;
  const selectedIds = new Set(sel.items);
  const palette = tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const activeColor = tool === 'highlighter' ? hlColor : color;

  return (
    <div className="screen ink-screen" data-reduced={reduced ? 'true' : 'false'}>
      <PageHeader
        title={t('ink.title')}
        subtitle={t('ink.subtitle')}
        actions={<Button appearance="primary" icon={<ArrowDownload24Regular />} onClick={() => void openExport()} data-testid="ink-export">{t('ink.export.open')}</Button>}
      />

      <div className="ink-boardbar" role="group" aria-label={t('ink.board.group')}>
        <Field label={t('ink.board.label')} orientation="horizontal" className="ink-board-field">
          <Select value={board?.id ?? ''} onChange={(_, d) => setActive(d.value)} data-testid="ink-board-select">
            {boards.map((b) => <option key={b.id} value={b.id}>{boardName(b)}</option>)}
          </Select>
        </Field>
        <Button icon={<Add24Regular />} onClick={createBoard} data-testid="ink-board-new">{t('ink.board.new')}</Button>
        <Button icon={<Rename24Regular />} onClick={() => setDialog('rename')}>{t('ink.board.rename')}</Button>
        <Button icon={<Delete24Regular />} disabled={boards.length <= 1} onClick={() => setDialog('delete')}>{t('ink.board.delete')}</Button>
        <Text className="ink-save" data-testid="ink-save-state" data-state={saveState}>{t(`ink.saveState.${saveState}` as MessageKey)}</Text>
      </div>

      <section className="ink-stage-wrap" aria-label={t('ink.stage.label')}>
        <div className="ink-toolbar" role="toolbar" aria-label={t('ink.toolbar.label')}>
          <div className="ink-tool-group">
            {TOOLS.map(({ tool: id, Icon, key }) => (
              <Tooltip key={id} content={`${t(`ink.tool.${id}` as MessageKey)} (${key})`} relationship="label">
                <ToggleButton appearance="subtle" icon={<Icon />} checked={tool === id} onClick={() => setTool(id)} data-testid={`ink-tool-${id}`} />
              </Tooltip>
            ))}
          </div>
          {(tool === 'pen' || tool === 'highlighter') && (
            <div className="ink-tool-group" role="group" aria-label={t('ink.color.group')}>
              {palette.map((c) => (
                <Tooltip key={c.id} content={t(`ink.color.${c.id}` as MessageKey)} relationship="label">
                  <button
                    type="button"
                    className={`ink-swatch${c.value === 'ink' ? ' is-ink' : ''}`}
                    style={c.value === 'ink' ? undefined : { background: c.value }}
                    aria-pressed={activeColor === c.value}
                    onClick={() => (tool === 'highlighter' ? setHlColor(c.value) : setColor(c.value))}
                  />
                </Tooltip>
              ))}
              <Select size="small" value={widthKey} aria-label={t('ink.width.label')} onChange={(_, d) => setWidthKey(d.value as WidthKey)} className="ink-width">
                {(Object.keys(WIDTHS) as WidthKey[]).map((w) => <option key={w} value={w}>{t(`ink.width.${w}` as MessageKey)}</option>)}
              </Select>
            </div>
          )}
          <div className="ink-tool-group">
            <Tooltip content={t('ink.undo')} relationship="label">
              <Button appearance="subtle" icon={<ArrowUndo24Regular />} disabled={!canUndo} onClick={undo} data-testid="ink-undo" />
            </Tooltip>
            <Tooltip content={t('ink.redo')} relationship="label">
              <Button appearance="subtle" icon={<ArrowRedo24Regular />} disabled={!canRedo} onClick={redo} data-testid="ink-redo" />
            </Tooltip>
          </div>
          <div className="ink-tool-group">
            <Tooltip content={`${t('ink.note.add')} (N)`} relationship="label">
              <Button appearance="subtle" icon={<NoteAdd24Regular />} onClick={addNote} data-testid="ink-add-note" />
            </Tooltip>
            <Tooltip content={`${t('ink.card.add')} (C)`} relationship="label">
              <Button appearance="subtle" icon={<CardUi24Regular />} onClick={() => setDialog('picker')} data-testid="ink-add-card" />
            </Tooltip>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Tooltip content={t('ink.shape.add')} relationship="label">
                  <Button appearance="subtle" icon={<Shapes24Regular />} data-testid="ink-add-shape" />
                </Tooltip>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {(['rectangle', 'ellipse', 'line', 'arrow'] as ShapeKind[]).map((k) => (
                    <MenuItem key={k} onClick={() => addShape(k)}>{t(`ink.shape.${k}` as MessageKey)}</MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
            <Tooltip content={t('ink.connect.title')} relationship="label">
              <Button appearance="subtle" icon={<Organization24Regular />} disabled={itemOptions.length < 2} onClick={() => setDialog('connect')} data-testid="ink-connect" />
            </Tooltip>
          </div>
          <div className="ink-tool-group">
            <Tooltip content={t('ink.shape.beautify')} relationship="label">
              <ToggleButton appearance="subtle" icon={<Wand24Regular />} checked={beautify} onClick={() => setBeautify(!beautify)} data-testid="ink-beautify" />
            </Tooltip>
            <Tooltip content={t('ink.hw.action')} relationship="label">
              <Button appearance="subtle" icon={<PenSparkle24Regular />} disabled={!content.strokes.length} onClick={() => void recognize()} data-testid="ink-recognize" />
            </Tooltip>
          </div>
          <div className="ink-tool-group">
            <Tooltip content={t('ink.zoom.out')} relationship="label">
              <Button appearance="subtle" icon={<ZoomOut24Regular />} onClick={() => surfaceRef.current?.zoomAt(0.8)} />
            </Tooltip>
            <span className="ink-zoom">{t('ink.zoom.value', { pct: zoomPct })}</span>
            <Tooltip content={t('ink.zoom.in')} relationship="label">
              <Button appearance="subtle" icon={<ZoomIn24Regular />} onClick={() => surfaceRef.current?.zoomAt(1.25)} />
            </Tooltip>
            <Tooltip content={t('ink.zoom.fit')} relationship="label">
              <Button appearance="subtle" icon={<ZoomFit24Regular />} onClick={() => surfaceRef.current?.fit(contentBox(contentRef.current))} />
            </Tooltip>
          </div>
        </div>

        <div
          ref={rootRef}
          className={`ink-stage tool-${tool}`}
          role="application"
          tabIndex={0}
          aria-label={t('ink.canvas.label', { name: boardName(board) })}
          aria-describedby="ink-help"
          aria-busy={!ready}
          data-testid="ink-stage"
          data-stroke-count={content.strokes.length}
          data-note-count={content.notes.length}
          data-link-count={content.links.length}
          data-ready={ready ? 'true' : 'false'}
          onKeyDown={onStageKey}
        >
          <canvas ref={baseRef} className="ink-canvas" aria-hidden />
          <canvas ref={liveRef} className="ink-canvas" aria-hidden />
          <div ref={worldRef} className="ink-world">
            <LinksLayer content={content} />
            {content.notes.map((n) => (
              <NoteView key={n.id} note={n} selected={selectedIds.has(n.id)} editing={editingId === n.id} linkSource={linkFrom === n.id} h={itemHandlers} />
            ))}
            {content.cards.map((k) => (
              <CardView key={k.id} card={k} selected={selectedIds.has(k.id)} linkSource={linkFrom === k.id} h={itemHandlers} />
            ))}
          </div>
        </div>
        <div className="ink-statusbar">
          <Text size={200} data-testid="ink-count">{t('ink.status.count', { strokes: content.strokes.length, notes: content.notes.length, cards: content.cards.length })}</Text>
          <Text size={200} role="status" className="ink-message">{message}</Text>
        </div>
        <p id="ink-help" className="ink-help">{t('ink.canvas.help')}</p>
      </section>

      <Panel title={t('ink.items.title')} rationale="ink.items.rationale" className="ink-items-panel">
        <div className="ink-items">
          <div>
            <h3 className="ink-sub">{t('ink.items.links')}</h3>
            {content.links.length === 0 ? <Text size={200}>{t('ink.items.noLinks')}</Text> : (
              <ul className="ink-list" data-testid="ink-links">
                {content.links.map((l) => (
                  <li key={l.id}>
                    <span>{t('ink.items.linkText', { from: labelOf(l.from), to: labelOf(l.to) })}</span>
                    <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={() => commit((c) => ({ ...c, links: c.links.filter((x) => x.id !== l.id) }))}>
                      {t('ink.item.delete')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="ink-sub">{t('ink.items.cards')}</h3>
            {content.cards.length === 0 ? <Text size={200}>{t('ink.items.noCards')}</Text> : (
              <ul className="ink-list">
                {content.cards.map((k) => <li key={k.id}><EntityRef id={k.entityId} /></li>)}
              </ul>
            )}
          </div>
        </div>
        <FacilitationPanel
          notes={content.notes}
          onCluster={(notes) => commit((c) => ({ ...c, notes }))}
          onResetVotes={() => commit((c) => ({ ...c, notes: c.notes.map((n) => ({ ...n, votes: 0 })) }))}
          announce={announce}
        />
      </Panel>

      <RenameDialog open={dialog === 'rename'} initial={board?.name ?? ''} onClose={() => setDialog(null)} onSave={renameBoard} />
      <ConfirmDialog
        open={dialog === 'delete'}
        title={t('ink.board.delete')}
        body={t('ink.board.deleteConfirm', { name: boardName(board) })}
        confirm={t('ink.board.delete')}
        onClose={() => setDialog(null)}
        onConfirm={() => void deleteBoard()}
      />
      <PickerDialog open={dialog === 'picker'} onClose={() => setDialog(null)} onPick={addCard} />
      <ConnectDialog
        open={dialog === 'connect'}
        items={itemOptions}
        onClose={() => setDialog(null)}
        onConnect={(a, b) => {
          connect(a, b);
          setDialog(null);
        }}
      />
      <RecognizeDialog open={dialog === 'recognize'} result={hwResult} onClose={() => setDialog(null)} onAddNote={addRecognizedNote} />
      <ExportDialog
        open={dialog === 'export'}
        preview={preview}
        onClose={() => setDialog(null)}
        onPdf={() => void exportPdf()}
        onMarkdown={exportMd}
        onPack={() => void exportPack()}
      />
    </div>
  );
}
