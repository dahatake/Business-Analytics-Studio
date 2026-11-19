import { z } from 'zod';
import { EVIDENCE_KINDS } from '../../data/extensionSchemas.ts';

/**
 * Requirement management data kept per project next to the strategy data (IPA requirements handbook table 9, 29, 54):
 * the attributes of each requirement (priority, status, verification), who wrote a section and when, the evidence a
 * requirement rests on (rules, voices, evaluation data), how often and how severely an issue occurs, and the change
 * records (reason, impact, approver). Every part is optional; a broken part falls back to empty.
 */

export const REQ_PRIORITIES = ['must', 'should', 'could'] as const;
export type ReqPriority = (typeof REQ_PRIORITIES)[number];
export const REQ_STATUSES = ['candidate', 'approved', 'implementing', 'verified'] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number];

const ByWhom = z.object({ at: z.string(), by: z.string() });

export const LedgerEntrySchema = z.object({
  priority: z.enum(REQ_PRIORITIES).optional(),
  status: z.enum(REQ_STATUSES).optional(),
  verification: z.string().optional(),
}).extend(ByWhom.shape);
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  title: z.string().trim().min(1),
  summary: z.string(),
  origin: z.enum(['workiq', 'file', 'manual']),
  /** The question asked or the file name, so the evidence can be traced back. */
  note: z.string().optional(),
  citations: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
  count: z.number().int().nonnegative().optional(),
  severity: z.number().int().min(1).max(5).optional(),
  /** Voices: the issue the voice is about. */
  issueId: z.string().optional(),
  /** Evaluation data: what the file holds (the rows themselves are never stored). */
  data: z.object({ rows: z.number().int().nonnegative(), columns: z.array(z.string()), labels: z.record(z.string(), z.number()).optional() }).optional(),
}).extend(ByWhom.shape);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SignalSchema = z.object({
  /** How often the issue occurs (1 rare … 5 constant). */
  frequency: z.number().int().min(1).max(5),
  /** How bad one occurrence is (1 minor … 5 severe). */
  severity: z.number().int().min(1).max(5),
}).extend(ByWhom.shape);
export type Signal = z.infer<typeof SignalSchema>;

export const ChangeRecordSchema = z.object({
  id: z.string().min(1),
  solutionId: z.string(),
  /** A requirement id or a section id; free text is allowed. */
  subject: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  impact: z.string(),
  approver: z.string(),
}).extend(ByWhom.shape);
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

export interface RequirementExtras {
  ledger?: Record<string, Record<string, LedgerEntry>>;
  sectionMeta?: Record<string, Record<string, { at: string; by: string }>>;
  evidence?: Evidence[];
  signals?: Record<string, Signal>;
  changes?: ChangeRecord[];
}

const rec = <T extends z.ZodType>(v: T) => z.record(z.string(), v);

/** Keeps every valid entry of a record of records, dropping only the broken ones. */
function lenientNested<T extends z.ZodType>(raw: unknown, item: T): Record<string, Record<string, z.infer<T>>> {
  const outer = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!outer.success) return {};
  const out: Record<string, Record<string, z.infer<T>>> = {};
  for (const [k, inner] of Object.entries(outer.data)) {
    const o = rec(z.unknown()).safeParse(inner);
    if (!o.success) continue;
    const kept = Object.fromEntries(Object.entries(o.data).flatMap(([id, v]) => {
      const p = item.safeParse(v);
      return p.success ? [[id, p.data]] : [];
    }));
    if (Object.keys(kept).length) out[k] = kept;
  }
  return out;
}

function lenientList<T extends z.ZodType>(raw: unknown, item: T): z.infer<T>[] {
  return Array.isArray(raw) ? raw.flatMap((v) => {
    const p = item.safeParse(v);
    return p.success ? [p.data] : [];
  }) : [];
}

/** Reads the requirement parts of stored strategy data; omitted when empty so the stored shape stays small. */
export function normalizeRequirementExtras(r: Record<string, unknown>): RequirementExtras {
  const ledger = lenientNested(r.ledger, LedgerEntrySchema);
  const sectionMeta = lenientNested(r.sectionMeta, ByWhom);
  const evidence = lenientList(r.evidence, EvidenceSchema);
  const changes = lenientList(r.changes, ChangeRecordSchema);
  const signals = Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).safeParse(r.signals).data ?? {}).flatMap(([id, v]) => {
    const p = SignalSchema.safeParse(v);
    return p.success ? [[id, p.data]] : [];
  }));
  return {
    ...(Object.keys(ledger).length ? { ledger } : {}),
    ...(Object.keys(sectionMeta).length ? { sectionMeta } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(Object.keys(signals).length ? { signals } : {}),
    ...(changes.length ? { changes } : {}),
  };
}

/* ---------- Stable requirement ids ---------- */

/** "BR-lead-time" from "kpi-lead-time": an id that follows the thing the requirement is about, never its position. */
export const reqId = (prefix: string, sourceId: string): string => `${prefix}-${sourceId.replace(/^(?:kpi|uc|ev|sol|issue)-/, '')}`;

export const REQ_ID = /^[A-Z]{2,4}-[\w.-]+$/;

/* ---------- Setters (pure) ---------- */

export function setLedgerEntry<T extends RequirementExtras>(
  data: T, solutionId: string, id: string,
  patch: { priority?: ReqPriority | undefined; status?: ReqStatus | undefined; verification?: string | undefined },
  by: string, at: string,
): T {
  const own = { ...(data.ledger?.[solutionId] ?? {}) };
  const next: LedgerEntry = { ...(own[id] ?? { at, by }), at, by };
  for (const key of ['priority', 'status', 'verification'] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === undefined || v === '') delete next[key];
    else (next as Record<string, unknown>)[key] = v;
  }
  if (!next.priority && !next.status && !next.verification?.trim()) delete own[id];
  else own[id] = next;
  return { ...data, ledger: { ...(data.ledger ?? {}), [solutionId]: own } };
}

export function stampSection<T extends RequirementExtras>(data: T, solutionId: string, sectionId: string, by: string, at: string): T {
  return { ...data, sectionMeta: { ...(data.sectionMeta ?? {}), [solutionId]: { ...(data.sectionMeta?.[solutionId] ?? {}), [sectionId]: { by, at } } } };
}

export function clearSectionStamp<T extends RequirementExtras>(data: T, solutionId: string, sectionId: string): T {
  const own = { ...(data.sectionMeta?.[solutionId] ?? {}) };
  delete own[sectionId];
  return { ...data, sectionMeta: { ...(data.sectionMeta ?? {}), [solutionId]: own } };
}

export const addEvidence = <T extends RequirementExtras>(data: T, e: Evidence): T => ({ ...data, evidence: [...(data.evidence ?? []).filter((x) => x.id !== e.id), e] });
export const removeEvidence = <T extends RequirementExtras>(data: T, id: string): T => ({ ...data, evidence: (data.evidence ?? []).filter((x) => x.id !== id) });

export function setSignal<T extends RequirementExtras>(data: T, issueId: string, value: { frequency: number; severity: number } | null, by: string, at: string): T {
  const signals = { ...(data.signals ?? {}) };
  if (value === null) delete signals[issueId];
  else signals[issueId] = { frequency: value.frequency, severity: value.severity, by, at };
  return { ...data, signals };
}

export const addChange = <T extends RequirementExtras>(data: T, c: ChangeRecord): T => ({ ...data, changes: [...(data.changes ?? []), c] });
export const removeChange = <T extends RequirementExtras>(data: T, id: string): T => ({ ...data, changes: (data.changes ?? []).filter((x) => x.id !== id) });

/**
 * A rare but severe issue (the handbook's "光る原石", 8.2): the mass of voices would rank it low by count, yet one
 * occurrence is serious. Shown beside the ranking so it is not lost; never changes the ranking itself.
 */
export const isHiddenGem = (s: Pick<Signal, 'frequency' | 'severity'>): boolean => s.frequency <= 2 && s.severity >= 4;
