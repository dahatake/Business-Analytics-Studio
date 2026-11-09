import { createScopedStore } from '../../state/projects.ts';
import type { Localizable } from '../../state/text.ts';
import { both } from './bitext.ts';
import type { DataEntity } from './catalogModel.ts';
import type { UseCase } from './store.ts';

/** FR-160: explicit entity × use case links the user adds (derived links are computed, never stored). */
export interface ExplicitLink {
  entityId: string;
  useCaseId: string;
}
export const useCatalogLinks = createScopedStore<ExplicitLink[]>('catalog.links', () => []);

export function toggleLink(links: ExplicitLink[], entityId: string, useCaseId: string): ExplicitLink[] {
  const has = links.some((x) => x.entityId === entityId && x.useCaseId === useCaseId);
  return has ? links.filter((x) => !(x.entityId === entityId && x.useCaseId === useCaseId)) : [...links, { entityId, useCaseId }];
}

/** A ToDo (glossary: a task of the plan). Catalog ToDos name the data entity and its related use cases (FR-162). */
export interface Todo {
  id: string;
  /** Idempotency key: `catalog:<entityId>`. */
  key: string;
  name: Localizable;
  description: Localizable;
  entityId: string;
  useCaseIds: string[];
  done: boolean;
  createdAt: string;
}
export const useTodos = createScopedStore<Todo[]>('todos', () => []);

export const todoKey = (entityId: string) => `catalog:${entityId}`;

/** FR-162: add catalog-missing ("BAS only") entities to ToDos in bulk. Repeating it adds nothing twice. */
export function addMissingToTodos(
  existing: Todo[],
  missing: { entity: DataEntity; useCases: UseCase[] }[],
  now = new Date(),
): { next: Todo[]; added: number } {
  const have = new Set(existing.map((t) => t.key));
  const added: Todo[] = [];
  for (const { entity, useCases } of missing) {
    const key = todoKey(entity.id);
    if (have.has(key)) continue;
    have.add(key);
    const names = useCases.map((u) => u.name);
    const ucList: Localizable =
      names.length === 0
        ? both('uc.todo.noUseCase')
        : { ja: names.map((n) => (typeof n === 'string' ? n : n.ja)).join('、'), en: names.map((n) => (typeof n === 'string' ? n : n.en)).join(', ') };
    added.push({
      id: `todo-${now.getTime().toString(36)}-${added.length}`,
      key,
      name: both('uc.todo.name', { entity: entity.name }),
      description: both('uc.todo.description', { entity: entity.name, usecases: ucList }),
      entityId: entity.id,
      useCaseIds: useCases.map((u) => u.id),
      done: false,
      createdAt: now.toISOString(),
    });
  }
  return { next: [...existing, ...added], added: added.length };
}
