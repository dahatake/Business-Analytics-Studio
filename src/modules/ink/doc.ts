/** One open board: content, undo/redo (PARAM-024), crash journal and autosave (PARAM-025). Framework-free. */
import { UndoStack } from '../../state/history.ts';
import type { BoardContent } from './model.ts';
import { applyJournal, Autosaver, makeJournal, readJournal, writeJournal, type InkStorage, type Timers } from './storage.ts';

export type DocListener = (content: BoardContent, prev: BoardContent) => void;

export class BoardDoc {
  private undoStack: UndoStack<BoardContent>;
  private saved: BoardContent;
  private savedIds: Set<string>;
  private listeners = new Set<DocListener>();
  readonly autosaver: Autosaver;
  content: BoardContent;
  /** Last commit's cost in ms (journal diff included), for diagnostics. */
  lastCommitMs = 0;
  disposed = false;
  /** Called after each successful save. */
  onSaved: (() => void) | null = null;

  constructor(
    private readonly storage: InkStorage,
    readonly scope: string,
    readonly boardId: string,
    saved: BoardContent,
    current: BoardContent = saved,
    opts: { interval?: number; timers?: Timers; journal?: boolean } = {},
  ) {
    this.saved = saved;
    this.savedIds = new Set(saved.strokes.map((s) => s.id));
    this.content = current;
    this.undoStack = new UndoStack(current);
    this.journalEnabled = opts.journal ?? true;
    this.autosaver = new Autosaver(() => this.save(), opts.interval, opts.timers);
    if (current !== saved) this.autosaver.markDirty();
  }

  private readonly journalEnabled: boolean;

  /** Load saved content and apply a crash journal if one exists. */
  static async open(storage: InkStorage, scope: string, boardId: string, initial: BoardContent, opts: { interval?: number; timers?: Timers; journal?: boolean } = {}): Promise<{ doc: BoardDoc; recovered: boolean }> {
    const saved = (await storage.load(scope, boardId)) ?? initial;
    const j = opts.journal === false ? null : readJournal(scope, boardId);
    const current = j ? applyJournal(saved, j) : saved;
    return { doc: new BoardDoc(storage, scope, boardId, saved, current, opts), recovered: j !== null };
  }

  get canUndo() {
    return this.undoStack.canUndo;
  }
  get canRedo() {
    return this.undoStack.canRedo;
  }

  subscribe(fn: DocListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: BoardContent) {
    const prev = this.content;
    if (next === prev) return;
    this.content = next;
    for (const l of this.listeners) l(next, prev);
  }

  private changed() {
    if (this.journalEnabled) {
      const ok = writeJournal(this.scope, this.boardId, makeJournal(this.saved, this.savedIds, this.content));
      if (!ok) {
        this.autosaver.markDirty();
        void this.autosaver.flush();
        return;
      }
    }
    this.autosaver.markDirty();
  }

  /** Record a new state (undoable). */
  commit(next: BoardContent): void {
    const t0 = performance.now();
    if (next === this.undoStack.value && next === this.content) return;
    this.undoStack.push(next);
    this.set(next);
    this.changed();
    this.lastCommitMs = performance.now() - t0;
  }

  /** Show an intermediate state (dragging) without recording history; finish with commit(). */
  preview(next: BoardContent): void {
    this.set(next);
  }

  /** Drop a preview and return to the last committed state. */
  cancelPreview(): void {
    this.set(this.undoStack.value);
  }

  undo(): void {
    if (!this.undoStack.canUndo) return;
    this.set(this.undoStack.undo());
    this.changed();
  }

  redo(): void {
    if (!this.undoStack.canRedo) return;
    this.set(this.undoStack.redo());
    this.changed();
  }

  /** Replace everything without history (diagnostics seeding). */
  replace(next: BoardContent): void {
    this.undoStack.reset(next);
    this.set(next);
    this.changed();
  }

  async save(): Promise<void> {
    const snapshot = this.content;
    await this.storage.save(this.scope, this.boardId, snapshot);
    this.saved = snapshot;
    this.savedIds = new Set(snapshot.strokes.map((s) => s.id));
    if (this.journalEnabled && !this.disposed) writeJournal(this.scope, this.boardId, makeJournal(this.saved, this.savedIds, this.content));
    this.onSaved?.();
  }

  async close(): Promise<void> {
    await this.autosaver.flush();
    this.autosaver.dispose();
    this.disposed = true;
    this.listeners.clear();
  }
}
