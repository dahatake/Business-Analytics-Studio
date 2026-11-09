/** PARAM-024: undo history limit. */
export const UNDO_LIMIT = 100;

/**
 * Snapshot-based undo/redo (FR-046). Pure and framework-free so every editor (discussion, use cases,
 * analysis parameters, ink) shares one tested implementation.
 */
export class UndoStack<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private present: T, private readonly limit = UNDO_LIMIT) {}

  get value(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): number {
    return this.past.length;
  }

  /** Record a new state. Clears the redo branch. */
  push(next: T): T {
    if (Object.is(next, this.present)) return this.present;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.present = next;
    return next;
  }

  undo(): T {
    const prev = this.past.pop();
    if (prev === undefined) return this.present;
    this.future.push(this.present);
    this.present = prev;
    return prev;
  }

  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.present;
    this.past.push(this.present);
    this.present = next;
    return next;
  }

  /** Replace the baseline without history (e.g. after loading another project's data). */
  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.present = value;
  }
}
