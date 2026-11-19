const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * FR-313: every generated pack states whether the customer already has a KPI/OKR definition, so the app knows whether
 * to use it or to define one. The model's statement is kept unless the pack contradicts it (claims a definition but
 * holds none); a missing statement is inferred from the content. Nothing found = notRetrieved, never undefined:
 * absence of evidence is not evidence that the customer has none.
 */
export function stampKpiDefinition(okr: unknown, kpiEntities: number, checked: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = isRecord(okr) ? { ...okr } : {};
  const kpis = (Array.isArray(o.kpis) ? o.kpis.length : 0) + kpiEntities;
  const objectives = Array.isArray(o.objectives) ? o.objectives.filter((x) => isRecord(x) && Array.isArray(x.keyResults) && x.keyResults.length > 0).length : 0;
  const found = objectives > 0 ? 'defined' : kpis > 0 ? 'partial' : 'notRetrieved';
  const stated = o.definitionStatus;
  const valid = stated === 'defined' || stated === 'partial' || stated === 'undefined' || stated === 'notRetrieved';
  const contradicted = (stated === 'defined' || stated === 'partial') && kpis + objectives === 0;
  o.definitionStatus = valid && !contradicted ? stated : found;
  const listed = Array.isArray(o.checkedSources) ? o.checkedSources.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  o.checkedSources = listed.length ? listed : [...new Set(checked.filter((x) => x.trim() !== ''))];
  if (!Array.isArray(o.kpis)) o.kpis = [];
  if (!Array.isArray(o.objectives)) o.objectives = [];
  return o;
}

const ORG_LEVEL_SET = new Set(['group', 'legalEntity', 'business', 'department']);
export const ORG_COMPANY_ID = 'org-company';
export const ORG_UNIT_ID = 'org-unit';

export interface OrgUnitStamp {
  level: string;
  name: string;
  basis: 'userInput' | 'stated' | 'inferred';
  reason?: string;
  sourceIds?: string[];
}

/**
 * FR-341: the organisations of extensions.okr. The app writes the company (org-company) and the business unit
 * (org-unit, typed or estimated with sources) itself; other organisations the model added stay only when complete and
 * sourced (basis stated). An orgUnitId that names no listed organisation is removed rather than guessed.
 */
export function stampOrgUnits(okr: Record<string, unknown>, company: string, unit: OrgUnitStamp | null): Record<string, unknown> {
  const o = { ...okr };
  const own: Record<string, unknown>[] = [
    { id: ORG_COMPANY_ID, level: 'legalEntity', name: company.trim(), basis: 'userInput' },
    ...(unit ? [{ id: ORG_UNIT_ID, ...unit }] : []),
  ];
  const stated = (Array.isArray(o.orgUnits) ? o.orgUnits : []).filter((u): u is Record<string, unknown> => isRecord(u)
    && typeof u.id === 'string' && u.id.trim() !== '' && u.id !== ORG_COMPANY_ID && u.id !== ORG_UNIT_ID
    && typeof u.level === 'string' && ORG_LEVEL_SET.has(u.level) && typeof u.name === 'string' && u.name.trim() !== ''
    && Array.isArray(u.sourceIds) && u.sourceIds.some((s) => typeof s === 'string' && s.trim() !== ''))
    .map((u) => ({ ...u, basis: 'stated' }));
  o.orgUnits = [...own, ...stated];
  const ids = new Set((o.orgUnits as Record<string, unknown>[]).map((u) => u.id));
  const clean = (list: unknown) => (Array.isArray(list) ? list.map((x) => {
    if (!isRecord(x) || x.orgUnitId === undefined || ids.has(x.orgUnitId as string)) return x;
    const { orgUnitId: _drop, ...rest } = x;
    return rest;
  }) : list);
  o.kpis = clean(o.kpis);
  o.objectives = clean(o.objectives);
  return o;
}
