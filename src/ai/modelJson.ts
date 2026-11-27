import type { z } from 'zod';

/**
 * D-57: the one boundary for JSON written by a generative model (Copilot, Foundry, Microsoft 365 Copilot answers).
 * Models write `null` for "unknown" even when told to omit the field, while the app's schemas mark such fields
 * `.optional()` (absent, never null). Measured 2026-11-27: a 25-minute Project pack run was discarded because the
 * business process answer had `"laborCostPerHourJpy": null`. Here a `null` the schema rejects is treated as the field
 * being absent; a `null` the schema accepts (`.nullable()`) is kept, and a `null` in a required field still fails.
 */

type Path = (string | number)[];
type Issue = { path: PropertyKey[]; code?: string; errors?: Issue[][] };

const MAX_PASSES = 8;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const containsNull = (v: unknown): boolean => v === null
  || (Array.isArray(v) ? v.some(containsNull) : isRecord(v) && Object.values(v).some(containsNull));

function valueAt(root: unknown, path: Path): unknown {
  let value = root;
  for (const key of path) {
    if (Array.isArray(value) && typeof key === 'number') value = value[key];
    else if (isRecord(value) && typeof key === 'string' && Object.hasOwn(value, key)) value = value[key];
    else return undefined;
  }
  return value;
}

function collect(issues: readonly Issue[], base: Path, root: unknown, out: Map<string, Path>) {
  for (const issue of issues) {
    if (issue.path.some((k) => typeof k !== 'string' && typeof k !== 'number')) continue;
    const path = [...base, ...(issue.path as Path)];
    if (path.length && valueAt(root, path) === null) out.set(JSON.stringify(path), path);
    // A union reports its members' issues relative to the union's own position.
    for (const branch of issue.errors ?? []) collect(branch, path, root, out);
  }
}

function remove(root: unknown, paths: Path[]) {
  // Object keys first (they shift nothing), then list items deepest and last first so earlier paths stay valid.
  const keyed = paths.filter((p) => typeof p.at(-1) === 'string');
  const items = paths.filter((p) => typeof p.at(-1) === 'number')
    .sort((a, b) => b.length - a.length || (b.at(-1) as number) - (a.at(-1) as number));
  for (const path of [...keyed, ...items]) {
    const parent = valueAt(root, path.slice(0, -1));
    const key = path.at(-1)!;
    if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
    else if (isRecord(parent) && typeof key === 'string') delete parent[key];
  }
}

/** Removes every `null` the schema rejects (an optional field, a list item) and returns the removed JSON paths. The input is never changed; it is returned as is when nothing is removed. */
export function dropRejectedNulls(schema: z.ZodType, value: unknown): { value: unknown; dropped: Path[] } {
  if (value === null || typeof value !== 'object' || !containsNull(value)) return { value, dropped: [] };
  const copy: unknown = structuredClone(value);
  const dropped: Path[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const parsed = schema.safeParse(copy);
    if (parsed.success) break;
    const found = new Map<string, Path>();
    collect(parsed.error.issues as unknown as Issue[], [], copy, found);
    if (!found.size) break;
    remove(copy, [...found.values()]);
    dropped.push(...found.values());
  }
  return { value: copy, dropped };
}

/** `schema.safeParse` for model output: a rejected `null` means the field was left out. */
export function parseModelOutput<S extends z.ZodType>(schema: S, value: unknown): z.ZodSafeParseResult<z.output<S>> {
  return schema.safeParse(dropRejectedNulls(schema, value).value) as z.ZodSafeParseResult<z.output<S>>;
}

/** `schema.parse` for model output (throws the schema's error, like `parse`). */
export function parseModelOutputOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = parseModelOutput(schema, value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/** Reads a model's JSON answer, with or without a surrounding ```json fence. Throws SyntaxError when it is not JSON. */
export function parseModelJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
