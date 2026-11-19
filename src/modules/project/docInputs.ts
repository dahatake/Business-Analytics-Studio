import type { LoadedPack } from '../../data/pack.ts';
import { ArchitectureExtension, GlossarySchema, RequirementEvidenceExtension, type EvidenceKind } from '../../data/extensionSchemas.ts';
import type { Lang } from '../../i18n/core.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { PackCatalog, type CatalogItem } from '../usecases/catalogSchema.ts';
import type { StrategyData } from './strategy.ts';

/**
 * What a requirements definition reads from data the project already holds, so nobody types it again: the current
 * systems (architecture.asIs), the data dictionary, the glossary, and the evidence (rules, user voices, evaluation data)
 * from the pack and from the project (Work IQ answers, imported files, notes).
 */

export interface EvidenceView {
  id: string;
  kind: EvidenceKind;
  title: string;
  summary: string;
  count?: number;
  severity?: number;
  issueId?: string;
  data?: { rows: number; columns: string[]; labels?: Record<string, number> };
  /** Where it comes from: source names, citation titles or a file name. */
  sources: string[];
  origin: 'pack' | 'workiq' | 'file' | 'manual';
}

const ext = (pack: LoadedPack, key: string): unknown => pack.pack.extensions?.[key];

export function systemsOf(pack: LoadedPack): string[] {
  const r = ArchitectureExtension.safeParse(ext(pack, 'architecture'));
  return r.success ? [...new Set((r.data.asIs ?? []).map((s) => s.name.trim()).filter(Boolean))] : [];
}

export function catalogOf(pack: LoadedPack): CatalogItem[] {
  const r = PackCatalog.safeParse(ext(pack, 'dataCatalog'));
  return r.success ? r.data.items : [];
}

export function glossaryOf(pack: LoadedPack, lang: Lang): { term: string; definition: string }[] {
  const r = GlossarySchema.safeParse(ext(pack, 'glossary'));
  return r.success ? r.data.map((g) => ({ term: loc(g.term as Localizable, lang), definition: loc(g.definition as Localizable, lang) })) : [];
}

export function evidenceViews(pack: LoadedPack, strategy: Pick<StrategyData, 'evidence'>, lang: Lang): EvidenceView[] {
  const fromPack = RequirementEvidenceExtension.safeParse(ext(pack, 'requirementEvidence'));
  const sourceName = (id: string) => {
    const e = pack.byId.get(id);
    return e && 'name' in e ? loc(e.name as Localizable, lang) : id;
  };
  const packItems: EvidenceView[] = fromPack.success ? fromPack.data.items.map((i) => ({
    id: i.id, kind: i.kind, title: loc(i.title as Localizable, lang), summary: loc(i.summary as Localizable, lang),
    ...(i.count !== undefined ? { count: i.count } : {}), ...(i.severity !== undefined ? { severity: i.severity } : {}),
    sources: i.sourceIds.map(sourceName), origin: 'pack' as const,
  })) : [];
  const own: EvidenceView[] = (strategy.evidence ?? []).map((e) => ({
    id: e.id, kind: e.kind, title: e.title, summary: e.summary,
    ...(e.count !== undefined ? { count: e.count } : {}), ...(e.severity !== undefined ? { severity: e.severity } : {}),
    ...(e.issueId ? { issueId: e.issueId } : {}), ...(e.data ? { data: e.data } : {}),
    sources: e.citations.length ? e.citations.map((c) => c.title) : e.note ? [e.note] : [], origin: e.origin,
  }));
  return [...packItems, ...own];
}
