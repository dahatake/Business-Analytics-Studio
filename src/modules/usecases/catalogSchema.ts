import { z } from 'zod';

export const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
export const MAX_CATALOG_ITEMS = 5000;
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), text(max).optional());

/** URLs record sources; they are never fetched by BAS. */
export const CatalogItem = z.object({
  id: optionalText(200),
  name: text(200).min(1),
  description: optionalText(2000),
  columns: z.preprocess(
    (v) => (Array.isArray(v) ? v.map((c) => (c && typeof c === 'object' && 'name' in c ? c.name : c)) : v),
    z.array(text(200).min(1)).max(1000).optional(),
  ),
  domain: optionalText(200),
  url: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v), z.url({ protocol: /^https?$/ }).max(2000).optional()),
});
export type CatalogItem = z.infer<typeof CatalogItem>;
export const PackCatalog = z.union([
  z.array(CatalogItem).max(MAX_CATALOG_ITEMS),
  z.object({ items: z.array(CatalogItem).max(MAX_CATALOG_ITEMS) }),
]).transform((v) => (Array.isArray(v) ? { items: v } : v));
