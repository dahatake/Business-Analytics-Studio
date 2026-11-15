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
