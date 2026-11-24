import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { solutionMoney } from '../src/data/schema.ts';
import { makeFormatters } from '../src/i18n/core.ts';
import { translate, type MessageKey } from '../src/i18n/core.ts';
import { IMPROVEMENT_STEPS } from '../src/state/projects.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { emptyDeliverables, evaluateStep, paybackYears, type CheckContext } from '../src/modules/project/deliverables.ts';
import { buildDraft } from '../src/modules/project/deliverableDraft.ts';
import { stepDashboard } from '../src/modules/project/stepDashboard.ts';
import { pruneInvalid, unconfirmedTopics } from '../src/modules/project/packGenerate.ts';
import { buildChapters } from '../src/modules/show/model.ts';

// A pack as a public-source-only run produces it: the facts public sources cannot state are left out, not guessed.
const raw = structuredClone(samplePack) as unknown as { entities: Record<string, unknown>[] };
for (const e of raw.entities) {
  if (e.kind === 'solution') { delete e.costJpy; delete e.annualBenefitJpy; }
  if (e.kind === 'kpi') { delete e.ownerId; e.ownerRole = { ja: '物流部長', en: 'Head of logistics' }; }
  if (e.kind === 'initiative') { delete e.ownerId; }
  if (e.kind === 'site') { delete e.lat; delete e.lon; delete e.capacityTPerMonth; }
  if (e.kind === 'person') delete e.siteId;
  if (e.kind === 'product') { delete e.siteId; delete e.unitPriceJpy; }
}
const pack = loadPack(raw);
const ctx = (): CheckContext => ({
  pack, discussion: { themes: [], records: [] }, kpi: demoKpis(pack.pack), analysis: { analyses: [], activeId: null },
  useCases: [], deliverables: emptyDeliverables(), today: '2026-11-09',
});

describe('values public sources cannot state stay unknown, never zero', () => {
  it('the pack still loads and keeps every entity', () => {
    expect(pack.issues).toEqual([]);
    expect(pack.pack.entities.length).toBe(samplePack.entities.length);
  });


  it('solutionMoney is null until both amounts are stated; a dash is shown instead of 0', () => {
    expect(solutionMoney({ costJpy: 10 })).toBeNull();
    expect(solutionMoney({ costJpy: 10, annualBenefitJpy: 30 })).toEqual({ cost: 10, benefit: 30 });
    expect(makeFormatters('ja').yenCompact(undefined)).toBe('—');
    expect(makeFormatters('en').yen(undefined)).toBe('—');
  });

  it('payback is unknown (not infinite or zero) and the criterion says why', () => {
    const solutions = pack.pack.entities.filter((e) => e.kind === 'solution');
    expect(solutions.length).toBeGreaterThan(0);
    for (const s of solutions) expect(paybackYears(s as never, [])).toBeNull();
    const payback = evaluateStep('deliverable', ctx()).find((r) => r.todo.id === 'plan-payback')!;
    expect(payback.outcome?.code).toBe('paybackUnknown');
    for (const lang of ['ja', 'en'] as const) {
      expect(translate(lang, 'dlv.r.paybackUnknown' as MessageKey, { n: 1 })).not.toBe('dlv.r.paybackUnknown');
    }
  });

  it('a role name counts as an owner, and the drafts never print an unknown amount as a number', () => {
    const owner = evaluateStep('deliverable', ctx()).find((r) => r.todo.id === 'plan-owner')!;
    expect(owner.outcome?.code).toBe('initiativesWithoutOwner');
    const withRole = structuredClone(raw);
    for (const e of withRole.entities) if (e.kind === 'initiative') e.ownerRole = { ja: '推進責任者', en: 'Programme lead' };
    const rolePack = loadPack(withRole);
    expect(evaluateStep('deliverable', { ...ctx(), pack: rolePack }).find((r) => r.todo.id === 'plan-owner')!.outcome?.code).toBe('allInitiativesOwned');
    for (const step of IMPROVEMENT_STEPS) {
      const draft = buildDraft({ step, ctx: ctx(), lang: 'en', audience: 'internal' });
      for (const text of Object.values(draft)) expect(text).not.toMatch(/NaN|Infinity|undefined/);
    }
    expect(buildDraft({ step: 'kpi', ctx: ctx(), lang: 'en', audience: 'internal' }).owner).toContain('Head of logistics');
  });

  it('the dashboards and the show chapters render without the missing amounts', () => {
    for (const step of IMPROVEMENT_STEPS) expect(() => stepDashboard(step, ctx())).not.toThrow();
    const roi = buildChapters('internal', pack).find((c) => c.id === 'roi');
    expect(roi && roi.id === 'roi' ? roi.empty : false).toBe(true);
  });

  it('the follow-up search still asks for the missing cost, owner and location', () => {
    const topics = unconfirmedTopics(pack.pack as never, ['engagements', 'kpi', 'locations'], 'en');
    expect(topics.some((t) => /cost \(JPY\)/.test(t))).toBe(true);
    expect(topics.some((t) => /location/.test(t))).toBe(true);
  });

  it('a dangling optional single reference is dropped, the entity is kept', () => {
    const p = structuredClone(samplePack) as unknown as { entities: Record<string, unknown>[] };
    const person = p.entities.find((e) => e.kind === 'person')!;
    person.siteId = 'site-does-not-exist';
    const r = pruneInvalid(p as never, new Date('2026-11-25'));
    const kept = (r.pack.entities as Record<string, unknown>[]).find((e) => e.id === person.id);
    expect(kept).toBeDefined();
    expect(kept!.siteId).toBeUndefined();
    expect(r.removed).toContainEqual(expect.objectContaining({ path: `entities.${String(person.id)}.siteId` }));
    expect(r.removed.some((x) => x.path === `entities.${String(person.id)}`)).toBe(false);
  });
});
