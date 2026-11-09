import { z } from 'zod';
import { CustomerPack } from '../../src/data/schema.ts';

/** FR-118: JSON Schema of the customer pack, generated from the zod schema (the single source of truth). */
export function packJsonSchema(version: string): Record<string, unknown> {
  const schema = z.toJSONSchema(CustomerPack) as Record<string, unknown>;
  return {
    ...schema,
    $id: 'https://business-analytics-studio.local/pack.schema.json',
    title: 'Business Analytics Studio customer pack',
    description: `Generated from src/data/schema.ts by \`node scripts/bas.ts schema\` (template ${version}). Do not edit by hand. Layout: public/data/pack.json (this file), public/brand/ (logo and brand files referenced by extensions.brand), assets/ (other media).`,
  };
}

type S = Record<string, unknown>;

/**
 * A small JSON Schema validator covering the keywords zod emits for CustomerPack. Used by tests to prove the exported
 * schema accepts and rejects the same packs as zod; not a general-purpose validator.
 */
export function validateJsonSchema(schema: S, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  const fail = (m: string) => errors.push(`${path}: ${m}`);
  if ('const' in schema && value !== schema.const) fail(`expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail(`not in enum`);
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as S[]).filter((s) => validateJsonSchema(s, value, path).length === 0).length;
    if (matches !== 1) fail(`matches ${matches} of oneOf`);
  }
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as S[]).some((s) => validateJsonSchema(s, value, path).length === 0)) fail('matches none of anyOf');
  const type = schema.type as string | undefined;
  if (type) {
    const ok =
      type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
      : type === 'array' ? Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : type === 'null' ? value === null
      : typeof value === type;
    if (!ok) { fail(`expected ${type}`); return errors; }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail('too short');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) fail(`does not match ${schema.pattern}`);
    if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('not a date');
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail('below minimum');
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail('above maximum');
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail('not above exclusiveMinimum');
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail('too few items');
    if (schema.items && typeof schema.items === 'object') value.forEach((v, i) => errors.push(...validateJsonSchema(schema.items as S, v, `${path}[${i}]`)));
  }
  if (type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in obj)) fail(`missing ${r}`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validateJsonSchema(props[k]!, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) fail(`unexpected property ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validateJsonSchema(schema.additionalProperties as S, v, `${path}.${k}`));
    }
  }
  return errors;
}
