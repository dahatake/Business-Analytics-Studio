import { describe, expect, it } from 'vitest';
import { DelayCostExtension } from '../src/data/extensionSchemas.ts';
import { samplePack } from '../src/data/sample.ts';
import { rankIssues } from '../src/domain/priority.ts';
import { emptyDecisionInputs, rankIssues as rankReportIssues } from '../src/modules/project/decisionSupport.ts';
import { DelayEstimateSchema, type DelayEstimate } from '../src/modules/project/deliverables.ts';
import {
  analyzeTriage, ANSOFF_TABLE, combineGrowth, dispositionOf, IMPACT_LEVELS, impactLevel, isProvisionalRating, kpiTrend, URGENCY_LEVELS, urgencyLevel,
  type TriageEntity,
} from '../src/modules/project/issueTriage.ts';
import { analyzePackPriority, PRIORITY_WEIGHTS } from '../src/modules/project/priorityAnalysis.ts';
import { evidenceLevel } from '../src/modules/project/priorityRobustness.ts';

const entities = samplePack.entities as unknown as TriageEntity[];
const est = (e: Partial<DelayEstimate>): DelayEstimate => ({ note: 'test', at: '2026-11-27T00:00:00Z', by: 'test', ...e });
const r3 = (low: number, mode: number, high: number) => ({ low, mode, high });

describe('FR-383 Ansoff disposition table', () => {
  it('reproduces Ansoff (1980) Table 5 cell by cell; double cells take the more attentive response', () => {
    // Urgency (rows) × impact (columns) as printed: Low / Significant / Major impact.
    const printed: Record<string, [string, string, string]> = {
      low: ['Drop from list', 'Periodic review', 'Monitor continuously'],
      significant: ['Drop or periodic review', 'Periodic review or monitoring', 'Plan delayed response'],
      pressing: ['Monitor', 'Monitor continuously', 'Respond immediately'],
    };
    const resolve: Record<string, string> = {
      'Drop from list': 'drop', 'Periodic review': 'review', 'Monitor continuously': 'monitor', Monitor: 'monitor',
      'Drop or periodic review': 'review', 'Periodic review or monitoring': 'monitor', 'Plan delayed response': 'plan', 'Respond immediately': 'act',
    };
    for (const u of URGENCY_LEVELS) IMPACT_LEVELS.forEach((l, k) => expect(ANSOFF_TABLE[u][l], `${u} × ${l}`).toBe(resolve[printed[u]![k]!]));
  });

  it('never acts on a low-impact issue, whatever its urgency, and only a major issue gets a response', () => {
    for (const u of [...URGENCY_LEVELS, null]) {
      expect(['act', 'plan']).not.toContain(dispositionOf('low', u));
      expect(['act', 'plan']).not.toContain(dispositionOf('significant', u));
    }
    expect(dispositionOf('low', null)).toBe('review');
    expect(dispositionOf('significant', null)).toBe('unassessed');
    expect(dispositionOf('major', null)).toBe('unassessed');
  });

  it('levels: impact 4–5 major, 3 significant, 1–2 low; slack ≤ 0 pressing, ≤ 12 months significant, more low', () => {
    expect([1, 2, 3, 4, 5].map(impactLevel)).toEqual(['low', 'low', 'significant', 'major', 'major']);
    expect([-3, 0, 0.1, 12, 12.1].map((s) => urgencyLevel(s))).toEqual(['pressing', 'pressing', 'significant', 'significant', 'low']);
  });
});

describe('FR-383 triage of the sample', () => {
  it('without any stated time, keeps every issue as a candidate in today\'s impact × feasibility order', () => {
    const t = analyzeTriage(entities);
    const today = rankIssues(samplePack.entities.filter((e) => e.kind === 'issue') as never, PRIORITY_WEIGHTS).map((r) => r.issue.id);
    expect(t.issues.map((i) => i.id)).toEqual(today);
    expect(t.issues.every((i) => i.disposition === 'unassessed' && i.urgency === null && i.need !== null)).toBe(true);
    // The sample's initiatives give the time to respond; only the time of impact is missing.
    expect(t.issues.filter((i) => i.response !== null).every((i) => i.need === 'impact')).toBe(true);
    expect(t.gated).toEqual([]);
    expect(t.timed).toBe(0);
    // All sample KPIs moved toward their targets.
    expect(t.issues.every((i) => i.growth === 'improving')).toBe(true);
    expect(t.next?.id).toBe('issue-lead-time');
  });

  it('leaves the stored robustness and Cost of Delay results of the sample unchanged', () => {
    const a = analyzePackPriority(entities, samplePack.extensions as never);
    expect(a.robustness?.pick).toBe('issue-lead-time');
    expect(a.robustness?.pickShare).toBe(0.688);
    expect(a.costOfDelay?.pick).toBe('issue-cash');
    expect(a.costOfDelay?.saving).toBe(16508485);
    expect(a.triage?.counts.unassessed).toBe(5);
    expect(a.methods).toContain('triage');
    expect(a.sourceIds).toEqual(expect.arrayContaining(['ansoff1980', 'duttonDuncan1987', 'kepnerTregoe']));
  });

  it('moves the skills issue first once its impact arrives before a response can finish', () => {
    // First retirements within about a year; transferring tacit knowledge takes two to four years.
    const estimates = { 'issue-skills': est({ impactMonths: r3(6, 12, 24), durationMonths: r3(24, 36, 48) }) };
    const t = analyzeTriage(entities, { estimates });
    const skills = t.issues.find((i) => i.id === 'issue-skills')!;
    expect(skills.urgency).toBe('pressing');
    expect(skills.disposition).toBe('act');
    expect(skills.order).toBe(1);
    expect(skills.slack).toBe(-22);
    expect(skills.pLate).toBeGreaterThan(0.95);
    expect(skills.impactOrigin).toBe('human');
    expect(skills.responseOrigin).toBe('human');
    expect(t.action[0]).toBe('issue-skills');
  });

  it('a time of impact stated in the material is used, and a person\'s estimate overrides it', () => {
    const extension = { items: [{ issueId: 'issue-energy', impactMonths: r3(30, 30, 30), durationMonths: r3(6, 6, 6), quote: '30 か月後に電力契約が更新', sourceIds: ['src-dx-survey'] }] };
    const stated = analyzeTriage(entities, { extension }).issues.find((i) => i.id === 'issue-energy')!;
    expect([stated.impactOrigin, stated.slack, stated.urgency, stated.disposition]).toEqual(['pack', 24, 'low', 'review']);
    const human = analyzeTriage(entities, { extension, estimates: { 'issue-energy': est({ impactMonths: r3(3, 3, 3) }) } }).issues.find((i) => i.id === 'issue-energy')!;
    expect([human.impactOrigin, human.responseOrigin, human.urgency, human.disposition]).toEqual(['human', 'pack', 'pressing', 'monitor']);
  });

  it('the chance of being late matches the closed form: a fixed impact at the mode of a symmetric response range is late half the time', () => {
    const t = analyzeTriage(entities, { estimates: { 'issue-quality': est({ impactMonths: r3(10, 10, 10), durationMonths: r3(5, 10, 15) }) } });
    const q = t.issues.find((i) => i.id === 'issue-quality')!;
    expect(q.slack).toBe(0);
    expect(q.urgency).toBe('pressing');
    expect(Math.abs(q.pLate! - 0.5)).toBeLessThan(0.03);
  });

  it('a low-impact issue leaves the order of action, the rank acceptability and the Cost of Delay order', () => {
    const low = { ...entities.find((e) => e.id === 'issue-cash')!, id: 'issue-low', impact: 1, feasibility: 5 };
    // Stated so that, without the gate, it would be the Cost of Delay pick by far.
    const delayCost = { items: [{ issueId: 'issue-low', valuePerMonthJpy: r3(1e9, 1e9, 1e9), durationMonths: r3(0.1, 0.1, 0.1), quote: 'q', sourceIds: ['src-interview'] }] };
    const extensions = { ...(samplePack.extensions ?? {}), delayCost };
    const a = analyzePackPriority([...entities, low] as never, extensions as never);
    expect(a.triage?.gated).toEqual(['issue-low']);
    expect(a.readiness?.find((r) => r.method === 'robustness')?.have).toBe(5);
    expect(a.costOfDelay?.pick).toBe('issue-cash');
    expect(a.costOfDelay?.top.map((x) => x.id)).not.toContain('issue-low');
    // Today's additive score ties it with an impact 3 / feasibility 2 issue.
    expect(rankIssues([low, { ...low, id: 'issue-mid', impact: 3, feasibility: 2 }] as never, PRIORITY_WEIGHTS).map((r) => r.score)).toEqual([40, 40]);
  });

  it('a seed per issue: adding an issue does not move another issue\'s chance of being late', () => {
    const estimates = { 'issue-quality': est({ impactMonths: r3(4, 8, 20), durationMonths: r3(3, 9, 12) }) };
    const before = analyzeTriage(entities, { estimates }).issues.find((i) => i.id === 'issue-quality')!.pLate;
    const extra = { ...entities.find((e) => e.id === 'issue-cash')!, id: 'issue-extra' };
    const after = analyzeTriage([...entities, extra], { estimates }).issues.find((i) => i.id === 'issue-quality')!.pLate;
    expect(after).toBe(before);
  });
});

describe('FR-383 growth, provisional ratings and stored times', () => {
  it('growth follows the KPI direction; any worsening KPI makes the issue worsening', () => {
    expect(kpiTrend({ baseline: 68, current: 61, direction: 'decrease' })).toBe('improving');
    expect(kpiTrend({ baseline: 82, current: 80, direction: 'increase' })).toBe('worsening');
    expect(kpiTrend({ baseline: 5, current: 5, direction: 'increase' })).toBe('flat');
    expect(kpiTrend({ baseline: 5, direction: 'increase' })).toBe('unknown');
    expect(combineGrowth(['improving', 'worsening'])).toBe('worsening');
    expect(combineGrowth(['improving', 'unknown'])).toBe('improving');
    expect(combineGrowth([])).toBe('unknown');
    const worse = entities.map((e) => (e.id === 'kpi-otd' ? { ...e, current: 80 } : e));
    const t = analyzeTriage(worse);
    expect(t.issues.find((i) => i.id === 'issue-lead-time')).toMatchObject({ growth: 'worsening', worseningKpis: ['kpi-otd'] });
    expect(t.worsening).toBe(1);
  });

  it('the next issue to time prefers a worsening one over a higher-ranked one', () => {
    const worse = entities.map((e) => (e.id === 'kpi-defect' ? { ...e, current: 900 } : e));
    expect(analyzeTriage(worse).next?.id).toBe('issue-quality');
  });

  it('a provisional rating counts as unevidenced, even when the issue cites a source and a KPI', () => {
    expect(isProvisionalRating({ ja: '【仮評価】手間がかかる', en: '[Provisional rating] Too much effort' })).toBe(true);
    expect(isProvisionalRating('Too much effort')).toBe(false);
    expect(evidenceLevel({ sourced: true, measured: true, provisional: true })).toBe('none');
    expect(evidenceLevel({ sourced: true, measured: true })).toBe('strong');
    const prov = entities.map((e) => (e.id === 'issue-lead-time' ? { ...e, description: { ja: '【仮評価】', en: '[Provisional rating]' } } : e));
    const a = analyzePackPriority(prov as never, samplePack.extensions as never);
    expect(a.stats.unproven).toBe(1);
    expect(a.robustness!.pickShare).toBeLessThan(0.688);
  });

  it('a time of impact may be 0 (already arrived) and may be the only number given; negatives are refused', () => {
    expect(DelayEstimateSchema.safeParse(est({ impactMonths: r3(0, 0, 0) })).success).toBe(true);
    expect(DelayEstimateSchema.safeParse(est({ impactMonths: r3(-1, 0, 0) })).success).toBe(false);
    expect(DelayEstimateSchema.safeParse(est({})).success).toBe(false);
    expect(DelayCostExtension.safeParse({ items: [{ issueId: 'issue-a', impactMonths: r3(12, 12, 12), quote: 'q', sourceIds: ['s'] }] }).success).toBe(true);
    expect(DelayCostExtension.safeParse({ items: [{ issueId: 'issue-a', durationMonths: r3(0, 0, 0), quote: 'q', sourceIds: ['s'] }] }).success).toBe(false);
  });
});

describe('FR-383 decision report urgency (audit G1)', () => {
  it('urgency is not a copy of the report\'s priority: it stays unrated until a person rates it', () => {
    const report = { issues: [
      { id: 'issue-1', title: 'A', priority: 3, evidence: ['fact'], text: '' },
      { id: 'issue-2', title: 'B', priority: 1, evidence: ['fact'], text: '' },
    ] };
    const rows = rankReportIssues(report as never, emptyDecisionInputs());
    expect(rows.map((r) => r.ratings.urgency)).toEqual([{ value: 3, origin: 'unrated' }, { value: 3, origin: 'unrated' }]);
    expect(rows.map((r) => r.id)).toEqual(['issue-1', 'issue-2']);
    expect(rows.map((r) => Math.round(r.score * 1000) / 1000)).toEqual([4.167, 2.167]);
    const inputs = emptyDecisionInputs();
    inputs.issues['issue-2'] = { urgency: 5 };
    expect(rankReportIssues(report as never, inputs).find((r) => r.id === 'issue-2')!.ratings.urgency).toEqual({ value: 5, origin: 'user' });
  });
});
