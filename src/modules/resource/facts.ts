import { registerMock, type AiRequest } from '../../ai/client.ts';
import type { MessageKey, Vars } from '../../i18n/index.ts';
import type { Archetype } from '../../domain/resourceIndustry.ts';
import type { DemandKind, Provenance, Scenario } from '../../domain/resourceModel.ts';

/**
 * FR-326: the explanation above the visual. Every sentence is computed from the scenario, so the text is correct without
 * AI; the AI commentary may only rephrase these facts (the prompt forbids new numbers).
 */
export interface Fact {
  id: string;
  key: MessageKey;
  vars: Vars;
  provenance: Provenance[];
  tone?: 'warning' | 'success';
}

export interface FactFormat {
  integer: (v: number) => string;
  number: (v: number) => string;
  percent: (v: number) => string;
  unit: string;
  name: (poolId: string) => string;
}

export interface FactContext {
  archetype: Archetype;
  /** People lens: the assumed hours, ceiling and effort base. */
  hoursPerPerson?: number;
  maxUtilization?: number;
  effortBase?: number;
  simulatedChanges: number;
}

const provOf = (list: { provenance: Provenance }[]): Provenance[] => [...new Set(list.map((v) => v.provenance))];

export function buildFacts(s: Scenario, ctx: FactContext, f: FactFormat): Fact[] {
  const { model, beforeMetrics: b, afterMetrics: a } = s;
  const activePools = model.pools.filter((p) => !p.off);
  const activeDemands = model.demands.filter((d) => !d.off);
  if (!activePools.length || !activeDemands.length) return [{ id: 'empty', key: 'res.fact.empty', vars: {}, provenance: ['pack'], tone: 'warning' }];
  const capacity = activePools.reduce((sum, p) => sum + Math.round(p.capacity.value), 0);
  const facts: Fact[] = [];
  const poolProv = provOf(activePools.map((p) => p.capacity));
  const needProv = provOf(activeDemands.map((d) => d.need));

  if (model.lens === 'people') {
    const count = (k: DemandKind) => activeDemands.filter((d) => d.kind === k).length;
    facts.push({
      id: 'supply', key: 'res.fact.people.supply', provenance: poolProv,
      vars: { pools: activePools.length, hours: f.integer(ctx.hoursPerPerson ?? 0), util: f.percent(ctx.maxUtilization ?? 0), capacity: f.integer(capacity) },
    });
    facts.push({
      id: 'demand', key: 'res.fact.people.demand', provenance: needProv,
      vars: {
        count: activeDemands.length, need: f.integer(b.need), issues: count('issue'), deals: count('deal'), initiatives: count('initiative'),
        engagements: count('engagement'), objectives: count('objective'),
      },
    });
    const owned = activeDemands.filter((d) => d.owners.length).length;
    facts.push({
      id: 'before', key: 'res.fact.people.owned', provenance: [...new Set<Provenance>(['pack', ...needProv])],
      tone: b.overloaded || owned < activeDemands.length ? 'warning' : undefined,
      vars: { owned, count: activeDemands.length, served: f.integer(b.served), pct: f.percent(b.servedPct), over: b.overloaded },
    });
    facts.push({
      id: 'after', key: 'res.fact.people.after', provenance: ['derived'], tone: a.weightedPct > b.weightedPct ? 'success' : undefined,
      vars: { served: f.integer(a.served), pct: f.percent(a.servedPct), before: f.percent(b.weightedPct), after: f.percent(a.weightedPct) },
    });
  } else {
    facts.push({ id: 'supply', key: 'res.fact.network.supply', provenance: poolProv, vars: { pools: activePools.length, capacity: f.integer(capacity) } });
    facts.push({ id: 'demand', key: 'res.fact.network.demand', provenance: needProv, vars: { count: activeDemands.length, need: f.integer(b.need) } });
    facts.push({
      id: 'before', key: 'res.fact.network.before', provenance: ['pack'], tone: b.overloaded ? 'warning' : undefined,
      vars: { cost: f.number((b.costJpy ?? 0) / 1e6), co2: f.integer(b.co2T ?? 0), lead: f.number(b.avgLeadDays ?? 0), over: b.overloaded },
    });
    facts.push({
      id: 'after', key: 'res.fact.network.after', provenance: ['derived'], tone: (a.costJpy ?? 0) < (b.costJpy ?? 0) ? 'success' : undefined,
      vars: { cost: f.number((a.costJpy ?? 0) / 1e6), co2: f.integer(a.co2T ?? 0), lead: f.number(a.avgLeadDays ?? 0), pct: f.percent(a.servedPct) },
    });
  }

  if (a.served < a.need) {
    facts.push({ id: 'unmet', key: 'res.fact.unmet', provenance: ['derived'], tone: 'warning', vars: { need: f.integer(a.need), unmet: f.integer(a.need - a.served), unit: f.unit } });
  }
  const top = s.marginals[0];
  if (top) {
    const served = top.servedPerUnit * top.delta;
    facts.push(served > 1e-9
      ? { id: 'bottleneck', key: 'res.fact.bottleneckServed', provenance: ['derived'], tone: 'warning', vars: { name: f.name(top.poolId), delta: f.integer(top.delta), unit: f.unit, served: f.integer(served) } }
      : {
        id: 'bottleneck', key: model.lens === 'network' ? 'res.fact.bottleneckCost' : 'res.fact.bottleneckHandover', provenance: ['derived'], tone: 'warning',
        vars: { name: f.name(top.poolId), delta: f.integer(top.delta), unit: f.unit, value: f.number(top.objectivePerUnit) },
      });
  } else {
    const slack = activePools.reduce((sum, p) => sum + Math.max(0, Math.round(p.capacity.value) - (a.load[p.id] ?? 0)), 0);
    facts.push({ id: 'bottleneck', key: 'res.fact.noBottleneck', provenance: ['derived'], vars: { slack: f.integer(slack), unit: f.unit } });
  }

  if (model.lens === 'people') {
    const history = model.pools.reduce((sum, p) => sum + (p.history ?? 0), 0);
    if (history) facts.push({ id: 'history', key: 'res.fact.history', provenance: ['pack'], vars: { count: history } });
    const unowned = activeDemands.filter((d) => !d.owners.length).length;
    if (unowned) facts.push({ id: 'gapOwners', key: 'res.fact.gap.owners', provenance: ['pack'], tone: 'warning', vars: { count: unowned } });
    if (activeDemands.some((d) => d.need.provenance === 'assumption')) {
      facts.push({ id: 'gapEffort', key: 'res.fact.gap.effort', provenance: ['assumption'], vars: { base: f.integer(ctx.effortBase ?? 0) } });
    }
  }
  if (ctx.simulatedChanges) facts.push({ id: 'simulated', key: 'res.fact.simulated', provenance: ['simulation'], vars: { count: ctx.simulatedChanges } });
  return facts;
}

export const RESOURCE_STAGE = 'resourceOptimization';
export const FACTS_MARKER = '### FACTS';

/** The prompt: instructions, then the facts as bullet lines (the mock reads them back). */
export function narrativePrompt(instructions: string, lines: string[]): string {
  return `${instructions}\n\n${FACTS_MARKER}\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** Offline answer: the facts themselves, in order, so a mock never adds anything the screen does not already show. */
export function narrativeMock(req: AiRequest): string {
  const at = req.prompt.indexOf(FACTS_MARKER);
  if (at < 0) return '';
  return req.prompt.slice(at + FACTS_MARKER.length).split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean).join(req.lang === 'ja' ? '' : ' ');
}

registerMock('explain', narrativeMock, (req) => req.stage === RESOURCE_STAGE);
