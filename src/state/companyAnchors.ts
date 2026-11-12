import { appStorage } from '../data/deviceStorage.ts';
import {
  CompanyAnchorDocumentSchema, CompanyAnchorSchema, type CompanyAnchor, type CompanyAnchorDocument, type CompanyAnchorVersion,
} from '../data/companyAnchor.ts';

export const companyAnchorKey = (companyId: string) => `bas.scope.${companyId}.company-anchor`;

export function readCompanyAnchorDocument(companyId: string): CompanyAnchorDocument | null {
  const raw = appStorage.getItem(companyAnchorKey(companyId));
  if (raw === null) return null;
  const result = CompanyAnchorDocumentSchema.safeParse(JSON.parse(raw) as unknown);
  if (!result.success || result.data.companyId !== companyId) throw new Error('Invalid company anchor document');
  return result.data;
}

export function latestCompanyAnchor(companyId: string): CompanyAnchorVersion | null {
  const document = readCompanyAnchorDocument(companyId);
  return document?.versions.at(-1) ?? null;
}

export function saveCompanyAnchor(companyId: string, input: CompanyAnchor, now = new Date()): CompanyAnchorVersion {
  const anchor = CompanyAnchorSchema.parse(input);
  const previous = readCompanyAnchorDocument(companyId);
  const version = { version: (previous?.versions.length ?? 0) + 1, savedAt: now.toISOString(), anchor };
  const document: CompanyAnchorDocument = {
    format: 'bas-company-anchor', schemaVersion: 1, companyId, versions: [...(previous?.versions ?? []), version],
  };
  appStorage.setItem(companyAnchorKey(companyId), JSON.stringify(document));
  return version;
}

export function restoreCompanyAnchorDocument(document: CompanyAnchorDocument): void {
  const parsed = CompanyAnchorDocumentSchema.parse(document);
  appStorage.setItem(companyAnchorKey(parsed.companyId), JSON.stringify(parsed));
}

export function deleteCompanyAnchor(companyId: string): void {
  appStorage.removeItem(companyAnchorKey(companyId));
}
