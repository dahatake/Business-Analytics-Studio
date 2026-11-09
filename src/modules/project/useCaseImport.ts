import { UndoStack } from '../../state/history.ts';
import type { UseCase } from '../usecases/store.ts';

/**
 * I-1 (option ②): restoring a discussion export never overwrites use cases. Each use case in the file becomes a
 * candidate; the user chooses what to take, and a changed one is replaced only after an explicit per-item choice.
 */
export type CandidateStatus = 'new' | 'changed' | 'identical';

export const COMPARED_FIELDS = ['name', 'summary', 'persona', 'steps', 'effect', 'relatedIds', 'origin', 'derivedFrom'] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

export interface UseCaseCandidate {
  incoming: UseCase;
  current: UseCase | null;
  status: CandidateStatus;
  /** Fields that differ from the current use case (empty unless status is 'changed'). */
  changedFields: ComparedField[];
}

/** 'add' / 'skip' for new candidates, 'replace' / 'keep' for changed ones. Identical candidates are always skipped. */
export type UseCaseChoice = 'add' | 'skip' | 'replace' | 'keep';
export type UseCaseChoices = Record<string, UseCaseChoice | undefined>;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function classifyUseCases(incoming: UseCase[], current: UseCase[]): UseCaseCandidate[] {
  const byId = new Map(current.map((u) => [u.id, u] as const));
  const seen = new Set<string>();
  const out: UseCaseCandidate[] = [];
  for (const inc of incoming) {
    if (seen.has(inc.id)) continue;
    seen.add(inc.id);
    const cur = byId.get(inc.id) ?? null;
    if (!cur) {
      out.push({ incoming: inc, current: null, status: 'new', changedFields: [] });
      continue;
    }
    const changedFields = COMPARED_FIELDS.filter((f) => canonical(inc[f]) !== canonical(cur[f]));
    out.push({ incoming: inc, current: cur, status: changedFields.length ? 'changed' : 'identical', changedFields });
  }
  return out;
}

/** New candidates are proposed for import; changed ones have no default so the user must choose. */
export function defaultChoices(candidates: UseCaseCandidate[]): UseCaseChoices {
  const out: UseCaseChoices = {};
  for (const c of candidates) out[c.incoming.id] = c.status === 'new' ? 'add' : c.status === 'identical' ? 'skip' : undefined;
  return out;
}

/** Changed candidates still waiting for "replace" or "keep current". */
export function unresolvedIds(candidates: UseCaseCandidate[], choices: UseCaseChoices): string[] {
  return candidates.filter((c) => c.status === 'changed' && choices[c.incoming.id] !== 'replace' && choices[c.incoming.id] !== 'keep').map((c) => c.incoming.id);
}

export interface ApplyResult {
  next: UseCase[];
  added: number;
  replaced: number;
  kept: number;
  skipped: number;
}

export function applyUseCaseSelection(current: UseCase[], candidates: UseCaseCandidate[], choices: UseCaseChoices, now: Date): ApplyResult {
  const replace = new Map<string, UseCase>();
  const add: UseCase[] = [];
  let kept = 0;
  let skipped = 0;
  for (const c of candidates) {
    const choice = choices[c.incoming.id];
    if (c.status === 'new' && choice === 'add') add.push(c.incoming);
    else if (c.status === 'changed' && choice === 'replace') replace.set(c.incoming.id, { ...c.incoming, updatedAt: now.toISOString() });
    else if (c.status === 'changed') kept++;
    else skipped++;
  }
  if (!replace.size && !add.length) return { next: current, added: 0, replaced: 0, kept, skipped };
  const next = [...current.map((u) => replace.get(u.id) ?? u), ...add];
  return { next, added: add.length, replaced: replace.size, kept, skipped };
}

/** Undo for use-case imports (PARAM-024 via UndoStack). Only offered while the list is still what the import left. */
export class UseCaseImportUndo {
  private stack: UndoStack<UseCase[]> | null = null;
  private scope = '';

  commit(scope: string, current: UseCase[], next: UseCase[]): UseCase[] {
    if (!this.stack || this.scope !== scope || this.stack.value !== current) {
      this.stack = new UndoStack(current);
      this.scope = scope;
    }
    return this.stack.push(next);
  }

  canUndo(scope: string, current: UseCase[]): boolean {
    return !!this.stack && this.scope === scope && this.stack.value === current && this.stack.canUndo;
  }

  /** The previous list, or null when undo is not possible. */
  undo(scope: string, current: UseCase[]): UseCase[] | null {
    if (!this.canUndo(scope, current)) return null;
    return this.stack!.undo();
  }
}
