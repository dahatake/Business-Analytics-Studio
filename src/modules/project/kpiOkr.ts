import type { CustomerPack, EntityOf } from '../../data/schema.ts';
import { OkrExtension } from '../../data/extensionSchemas.ts';
import type { KpiData, KpiDef, Okr } from './model.ts';

/** PARAM-044: achievement (%) at or above which a KPI reads 「達成」. */
export const ACHIEVED_MIN_PCT = 100;
/** PARAM-045: achievement (%) at or below which a KPI reads 「未着手」. */
export const NOT_STARTED_MAX_PCT = 0;

export type KpiStatusText = 'achieved' | 'inProgress' | 'notStarted' | 'unmeasurable';

/** Achievement in %: 0 at the baseline, 100 at the target. null when baseline = target (no gap to measure). */
export function achievementPct(k: Pick<KpiDef, 'baseline' | 'current' | 'target'>): number | null {
  const gap = k.target - k.baseline;
  if (gap === 0 || !Number.isFinite(gap) || !Number.isFinite(k.current)) return null;
  return ((k.current - k.baseline) / gap) * 100;
}

export function statusForPct(pct: number | null): KpiStatusText {
  if (pct === null) return 'unmeasurable';
  if (pct >= ACHIEVED_MIN_PCT) return 'achieved';
  if (pct <= NOT_STARTED_MAX_PCT) return 'notStarted';
  return 'inProgress';
}

export const kpiStatusText = (k: Pick<KpiDef, 'baseline' | 'current' | 'target'>) => statusForPct(achievementPct(k));

/** OKR progress = mean of its key results' KPI achievements, each clamped to 0–100 %. */
export function okrPct(okr: Okr, kpis: KpiDef[]): number | null {
  const values = okr.keyResults
    .map((kr) => kpis.find((k) => k.id === kr.kpiId))
    .map((k) => (k ? achievementPct(k) : null))
    .filter((p): p is number => p !== null)
    .map((p) => Math.max(0, Math.min(100, p)));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export type KpiField = 'name' | 'unit' | 'baseline' | 'current' | 'target' | 'deadline';

/** FR-153 validation. Returns the invalid fields. */
export function validateKpi(k: { name: string; unit: string; baseline: string; current: string; target: string; deadline: string }): KpiField[] {
  const bad: KpiField[] = [];
  if (!k.name.trim()) bad.push('name');
  if (!k.unit.trim()) bad.push('unit');
  for (const f of ['baseline', 'current', 'target'] as const) if (k[f].trim() === '' || !Number.isFinite(Number(k[f]))) bad.push(f);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k.deadline) || Number.isNaN(Date.parse(k.deadline))) bad.push('deadline');
  return bad;
}

/**
 * KPIs of a generated (imported) pack: numeric kpi entities become editable KpiDefs, and the internal
 * OKRs (extensions.okr) become OKRs where their key results point at those KPIs. Text-only KPIs stay in
 * extensions.okr and are shown read-only, since they lack the numbers a KpiDef needs.
 */
export function packKpis(pack: CustomerPack, today = new Date()): KpiData {
  const next = new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate()));
  const deadline = next.toISOString().slice(0, 10);
  const kpis: KpiDef[] = pack.entities
    .filter((e): e is EntityOf<'kpi'> => e.kind === 'kpi')
    .map((k) => ({ id: k.id, name: k.name, unit: k.unit, baseline: k.baseline, current: k.current, target: k.target, deadline, origin: 'customerDefined' as const, sourceIds: k.sourceIds }));
  const ids = new Set(kpis.map((k) => k.id));
  const ext = OkrExtension.safeParse(pack.extensions?.okr);
  const okrs: Okr[] = (ext.success ? ext.data.objectives : []).flatMap((o) => {
    const keyResults = o.keyResults
      .map((kr, i) => ({ id: `${o.id}-kr-${i + 1}`, text: kr.text, kpiId: kr.kpiId ?? '' }))
      .filter((kr) => ids.has(kr.kpiId));
    const companyObjectiveIds = companyObjectiveIdsOf(o);
    return keyResults.length ? [{ id: o.id, objective: o.objective, keyResults, origin: 'customerDefined' as const, ...(companyObjectiveIds.length ? { companyObjectiveIds } : {}) }] : [];
  });
  return { kpis, okrs };
}

/** Demo KPIs come from the pack's KPIs; the OKRs link them. New projects start empty. */
export function demoKpis(pack: CustomerPack): KpiData {
  const kpis: KpiDef[] = pack.entities
    .filter((e): e is EntityOf<'kpi'> => e.kind === 'kpi')
    .map((k) => ({ id: k.id, name: k.name, unit: k.unit, baseline: k.baseline, current: k.current, target: k.target, deadline: '2027-03-31', origin: 'customerDefined' as const, sourceIds: k.sourceIds }));
  const has = (id: string) => kpis.some((k) => k.id === id);
  const kr = (id: string, kpiId: string, ja: string, en: string) => ({ id, kpiId, text: { ja, en } });
  const okrs: Okr[] = [
    {
      id: 'okr-demo-delivery',
      objective: { ja: '納期と品質で選ばれる工場になる', en: 'Become the plant customers choose for delivery and quality' },
      keyResults: [
        kr('kr-demo-1', 'kpi-lead-time', 'リードタイムを目標値まで短くする', 'Bring lead time down to target'),
        kr('kr-demo-2', 'kpi-otd', '納期遵守率を目標値に上げる', 'Raise on-time delivery to target'),
        kr('kr-demo-3', 'kpi-defect', '不良率を目標値に下げる', 'Cut the defect rate to target'),
      ].filter((k) => has(k.kpiId)),
    },
    {
      id: 'okr-demo-foundation',
      objective: { ja: '資金と人材の基盤を強くする', en: 'Strengthen the cash and people foundation' },
      keyResults: [
        kr('kr-demo-4', 'kpi-dso', '売掛金の回収日数を短くする', 'Shorten days sales outstanding'),
        kr('kr-demo-5', 'kpi-engagement', '従業員エンゲージメントを高める', 'Raise employee engagement'),
      ].filter((k) => has(k.kpiId)),
    },
  ].filter((o) => o.keyResults.length > 0).map((o) => ({ ...o, origin: 'customerDefined' as const }));
  return { kpis, okrs };
}

/** Company-anchor objective ids an OKR objective of the pack says it serves (passthrough field). */
export function companyObjectiveIdsOf(o: unknown): string[] {
  const ids = (o as { companyObjectiveIds?: unknown }).companyObjectiveIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

export const DEFINITION_STATUSES = ['defined', 'partial', 'undefined', 'notRetrieved'] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

export interface KpiDefinitionState {
  status: DefinitionStatus;
  /** true when the pack stated the status; false when it was inferred from what the pack contains. */
  stated: boolean;
  checkedSources: string[];
  /** KPIs/objectives the customer defined (pack kpi entities + extensions.okr). */
  kpis: number;
  objectives: number;
}

/**
 * FR-313: does the customer already have a KPI/OKR definition? The pack generator records it in extensions.okr; for
 * older packs it is inferred: objectives with key results = defined, KPIs only = partial, nothing = not retrieved
 * (absence of evidence is not evidence that the customer has none).
 */
export function kpiDefinitionState(pack: CustomerPack): KpiDefinitionState {
  const ext = OkrExtension.safeParse(pack.extensions?.okr);
  const data = ext.success ? ext.data : null;
  const kpis = pack.entities.filter((e) => e.kind === 'kpi').length + (data?.kpis.length ?? 0);
  const objectives = data?.objectives.filter((o) => o.keyResults.length > 0).length ?? 0;
  const checkedSources = data?.checkedSources ?? [];
  if (data?.definitionStatus) return { status: data.definitionStatus, stated: true, checkedSources, kpis, objectives };
  const status: DefinitionStatus = objectives > 0 ? 'defined' : kpis > 0 ? 'partial' : 'notRetrieved';
  return { status, stated: false, checkedSources, kpis, objectives };
}

export interface ProposalInput {
  pack: CustomerPack;
  current: KpiData;
  /** Company-anchor objectives (published or customer-stated) the proposal may serve. */
  objectives: { id: string; text: string }[];
  /** YYYY-MM-DD: the default deadline of proposed KPIs. */
  deadline: string;
  lang: 'ja' | 'en';
}

/**
 * Proposes a KPI/OKR definition when the customer has none (or it could not be retrieved): one objective per company
 * objective (else one per top issue), key results on the KPIs the issues are measured by. Everything is marked
 * `proposed`; nothing the project already has is changed. The sponsor must agree before it counts (kpi-measure).
 */
export function proposeKpiDefinition({ pack, current, objectives, deadline, lang }: ProposalInput): KpiData {
  const byId = new Map(pack.entities.map((e) => [e.id, e]));
  const kpis = [...current.kpis];
  const has = (id: string) => kpis.some((k) => k.id === id);
  const issues = pack.entities.filter((e): e is EntityOf<'issue'> => e.kind === 'issue');
  const issueKpiIds = issues.map((i) => i.kpiIds.filter((id) => byId.get(id)?.kind === 'kpi'));
  for (const id of issueKpiIds.flat()) {
    const k = byId.get(id);
    if (k?.kind !== 'kpi' || has(id)) continue;
    kpis.push({ id: k.id, name: k.name, unit: k.unit, baseline: k.baseline, current: k.current, target: k.target, deadline, origin: 'proposed', sourceIds: k.sourceIds });
  }
  const used = new Set(current.okrs.flatMap((o) => o.keyResults.map((kr) => kr.kpiId)));
  const free = [...new Set(issueKpiIds.flat())].filter((id) => has(id) && !used.has(id));
  if (free.length === 0) return { kpis, okrs: current.okrs };
  const kpiName = (id: string) => {
    const k = kpis.find((x) => x.id === id)!;
    return typeof k.name === 'string' ? k.name : k.name[lang];
  };
  const kr = (oid: string, ids: string[]) => ids.map((id, i) => ({ id: `${oid}-kr-${i + 1}`, kpiId: id, text: lang === 'ja' ? `${kpiName(id)}を目標値にする` : `Bring ${kpiName(id)} to target` }));
  const stamp = Date.now().toString(36);
  const okrs: Okr[] = objectives.length
    ? [{ id: `okr-prop-${stamp}`, objective: objectives[0]!.text, keyResults: kr(`okr-prop-${stamp}`, free), origin: 'proposed', companyObjectiveIds: objectives.map((o) => o.id) }]
    : issues.filter((i) => i.kpiIds.some((id) => free.includes(id))).slice(0, 3).map((i, n) => {
      const oid = `okr-prop-${stamp}-${n + 1}`;
      return { id: oid, objective: lang === 'ja' ? `「${i.name.ja}」を解決する` : `Solve "${i.name.en}"`, keyResults: kr(oid, i.kpiIds.filter((id) => free.includes(id))), origin: 'proposed' as const };
    });
  return { kpis, okrs: [...current.okrs, ...okrs.filter((o) => o.keyResults.length > 0)] };
}
