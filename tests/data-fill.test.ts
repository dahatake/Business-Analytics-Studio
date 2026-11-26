import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import {
  emptyDeliverables, evaluateStep, normalizeDeliverables, type CheckContext, type DeliverableData,
} from '../src/modules/project/deliverables.ts';
import { buildDraft, draftPrompt } from '../src/modules/project/deliverableDraft.ts';
import {
  fillChanges, fillRequest, findGaps, MAX_FILL_RETRIES, mergeFills, parseFill, previewFillContext, requestFill, reviewFill, savedProposals, tonneAmounts, yenAmounts, type FillProposal,
} from '../src/modules/project/dataFill.ts';
import { setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';
import type { Entity } from '../src/data/schema.ts';
import type { PackChange } from '../src/state/packEdits.ts';

// A pack as a public-source-only run leaves it: no amounts and no initiative owners. One source states one cost.
const raw = structuredClone(samplePack) as unknown as { entities: Record<string, unknown>[] };
for (const e of raw.entities) {
  if (e.kind === 'solution') { delete e.costJpy; delete e.annualBenefitJpy; }
  if (e.kind === 'initiative') delete e.ownerId;
}
const sol = raw.entities.find((e) => e.kind === 'solution')!;
const src = raw.entities.find((e) => e.kind === 'source' && e.classification === 'internal') ?? raw.entities.find((e) => e.kind === 'source')!;
(src.description as { ja: string }).ja += ' 導入費用は1億2000万円を見込む。';
const pack = loadPack(raw);
const SOL = sol.id as string;
const SRC = src.id as string;
const AT = '2026-11-09T00:00:00.000Z';

const ctxWith = (p = pack, deliverables: DeliverableData = emptyDeliverables()): CheckContext => ({
  pack: p, discussion: { themes: [], records: [] }, kpi: demoKpis(p.pack), analysis: { analyses: [], activeId: null },
  useCases: [], deliverables, today: '2026-11-09',
});

/** Applies pack changes the way commitPackChanges does (upsert by id), for checking the results without storage. */
const applied = (ctx: CheckContext, changes: PackChange[]) => {
  const byId = new Map(changes.flatMap((c) => (c.op === 'upsert' ? [[c.entity.id, c.entity] as const] : [])));
  return loadPack({ ...ctx.pack.pack, entities: ctx.pack.pack.entities.map((e) => byId.get(e.id) ?? e) });
};
const answer = (items: unknown[]) => `\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``;
const code = (ctx: CheckContext, id: string) => evaluateStep('deliverable', ctx).find((r) => r.todo.id === id)!.outcome?.code;

describe('missing-data fill: labels decided by the app, reviewed one by one', () => {
  it('reads yen amounts written in Japanese and English', () => {
    expect(yenAmounts('導入費用は1億2000万円を見込む')).toEqual([120_000_000]);
    expect(yenAmounts('年間 4,800万円、保守 300円')).toEqual([48_000_000, 300]);
    expect(yenAmounts('about ¥48 million or JPY 1.2 billion; 5,000 yen')).toEqual([48_000_000, 1_200_000_000, 5_000]);
  });

  it('finds the empty cost, benefit and owner fields only', () => {
    const gaps = findGaps(ctxWith(), 'internal').map((g) => g.id);
    expect(gaps).toContain(`${SOL}:costJpy`);
    expect(gaps).toContain(`${SOL}:annualBenefitJpy`);
    expect(gaps.some((g) => g.endsWith(':ownerRole') && g.startsWith('init-'))).toBe(true);
    // KPI owners are known people in the sample: not a gap.
    expect(gaps.some((g) => g.startsWith('kpi-'))).toBe(false);
    expect(findGaps(ctxWith(loadPack(samplePack)), 'internal')).toEqual([]);
  });

  it('asks for one item per gap and never sends a person or the company name', () => {
    const ctx = ctxWith();
    const gaps = findGaps(ctx, 'internal');
    const req = fillRequest(ctx, 'ja', 'internal', gaps);
    expect(req.prompt.startsWith('[bas-proj:fill]')).toBe(true);
    for (const g of gaps) expect(req.prompt).toContain(g.id);
    expect(req.entities!.some((e) => e.kind === 'person')).toBe(false);
    expect(req.prompt).not.toContain(samplePack.company.name.ja);
  });

  it('keeps evidence only when the cited source contains the quote and the quote states the value', () => {
    const ctx = ctxWith();
    const gaps = findGaps(ctx, 'internal').filter((g) => g.entityId === SOL);
    const note = { ja: 'n', en: 'n' };
    const [cost, benefit] = parseFill(answer([
      { gapId: `${SOL}:costJpy`, basis: 'evidence', value: 120_000_000, quote: '導入費用は1億2000万円', sourceIds: [SRC], note },
      // Claims evidence, but the quote is not in the source: an estimate, flagged.
      { gapId: `${SOL}:annualBenefitJpy`, basis: 'evidence', value: 50_000_000, quote: '年間効果は5000万円', sourceIds: [SRC], note },
    ]), gaps, ctx, 'internal');
    expect(cost).toMatchObject({ basis: 'evidence', value: 120_000_000, sourceIds: [SRC] });
    expect(benefit).toMatchObject({ basis: 'estimate', value: 50_000_000, downgraded: true });
    // The right quote with the wrong amount is not evidence either.
    const [wrong] = parseFill(answer([{ gapId: `${SOL}:costJpy`, basis: 'evidence', value: 99_000_000, quote: '導入費用は1億2000万円', sourceIds: [SRC], note }]), gaps.slice(0, 1), ctx, 'internal');
    expect(wrong).toMatchObject({ basis: 'estimate', downgraded: true });
  });

  it('an unanswered, broken or valueless item is "unacquired", never a guess', () => {
    const ctx = ctxWith();
    const gaps = findGaps(ctx, 'internal').slice(0, 3);
    const out = parseFill(answer([
      { gapId: gaps[0]!.id, basis: 'estimate', value: -5, note: { ja: 'x', en: 'x' } },
      { gapId: gaps[1]!.id, basis: 'unacquired', value: null, note: { ja: '経理部の見積書', en: 'Finance estimate' } },
    ]), gaps, ctx, 'internal');
    expect(out.map((p) => p.basis)).toEqual(['unacquired', 'unacquired', 'unacquired']);
    expect(out.every((p) => p.value === undefined)).toBe(true);
    expect(out[1]!.note.ja).toBe('経理部の見積書');
    expect(() => parseFill('no json here', gaps, ctx, 'internal')).toThrow();
  });

  it('D-49: asks again only for the gaps an answer left without a value, and keeps earlier values if the retry fails', async () => {
    const ctx = ctxWith();
    const gaps = findGaps(ctx, 'internal').slice(0, 3);
    const note = { ja: '推定の理由', en: 'Why' };
    const prompts: string[] = [];
    const replies = [
      answer([{ gapId: gaps[0]!.id, basis: 'estimate', value: 10_000_000, note }]),
      answer([{ gapId: gaps[1]!.id, basis: 'estimate', value: 20_000_000, note }]),
      'broken',
    ];
    setRuntimeSettingsProvider(() => ({ liveEnabled: true, sendConsent: true, configured: true, provider: 'copilotSdk' }));
    setLiveTransport(async (request) => {
      prompts.push(request.prompt);
      return { text: replies.shift()!, inputTokens: 1, outputTokens: 1 };
    });
    try {
      writeLedger([]);
      const request = fillRequest(ctx, 'ja', 'internal', gaps);
      expect(request.prompt).toContain('Never answer "unacquired"');
      const out = await requestFill(request, gaps, ctx, 'internal');
      expect(prompts).toHaveLength(1 + MAX_FILL_RETRIES);
      expect(prompts[1]).toContain('Retry:');
      expect(prompts[1]).not.toContain(`"gapId":"${gaps[0]!.id}"`);
      expect(prompts[1]).toContain(`"gapId":"${gaps[2]!.id}"`);
      expect(prompts[2]).not.toContain(`"gapId":"${gaps[1]!.id}"`);
      expect(out.map((p) => p.basis)).toEqual(['estimate', 'estimate', 'unacquired']);
    } finally {
      setLiveTransport(null);
      setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
      writeLedger([]);
    }
  });

  it('applies values as pending, does not count unreviewed estimates as done, and labels them in the deliverable', () => {
    const ctx = ctxWith();
    const gaps = findGaps(ctx, 'internal');
    const proposals: FillProposal[] = gaps.map((g) => g.field === 'ownerRole'
      ? { gapId: g.id, entityId: g.entityId, field: g.field, basis: 'estimate', value: { ja: '物流部長', en: 'Head of logistics' }, note: { ja: '推定', en: 'est' }, sourceIds: [] }
      : { gapId: g.id, entityId: g.entityId, field: g.field, basis: 'estimate', value: g.field === 'costJpy' ? 30_000_000 : 60_000_000, note: { ja: '推定', en: 'est' }, sourceIds: [] });
    const plan = fillChanges(ctx, proposals, AT);
    expect(Object.values(plan.fills).every((f) => f.status === 'pending')).toBe(true);
    const after = ctxWith(applied(ctx, plan.changes), mergeFills(emptyDeliverables(), plan.fills));
    expect(after.pack.issues).toEqual([]);
    expect(findGaps(after, 'internal')).toEqual([]);
    expect(code(after, 'plan-payback')).toBe('paybackUnreviewed');
    expect(code(after, 'plan-owner')).toBe('ownersUnreviewed');
    const draft = buildDraft({ step: 'deliverable', ctx: after, lang: 'ja', audience: 'internal' });
    expect(draft.businessCase).toContain('Copilot 推定・レビュー待ち');
    expect(draft.raci).toContain('物流部長（Copilot 推定・レビュー待ち）');
    expect(draftPrompt({ step: 'deliverable', ctx: after, lang: 'en', audience: 'internal' })).toContain('valueLabels');
    // The text draft is written from the same preview.
    expect(previewFillContext(ctx, proposals, AT).pack.byId.get(SOL)).toMatchObject({ costJpy: 30_000_000 });

    // Approving every item makes the criteria pass on the values themselves.
    let data = after.deliverables;
    for (const key of Object.keys(plan.fills)) data = reviewFill(ctxWith(after.pack, data), key, { kind: 'approve' }, 'Reviewer', AT).data;
    const approved = ctxWith(after.pack, data);
    expect(Object.values(data.fills!).every((f) => f.status === 'approved' && f.reviewed?.by === 'Reviewer')).toBe(true);
    expect(code(approved, 'plan-payback')).not.toBe('paybackUnreviewed');
    expect(code(approved, 'plan-owner')).toBe('allInitiativesOwned');
    expect(buildDraft({ step: 'deliverable', ctx: approved, lang: 'en', audience: 'internal' }).businessCase).toContain('(Copilot estimate, approved)');
  });

  it('rejecting empties the field again; entering a value labels it as a person\'s', () => {
    const ctx = ctxWith();
    const gap = findGaps(ctx, 'internal').find((g) => g.id === `${SOL}:costJpy`)!;
    const plan = fillChanges(ctx, [{ gapId: gap.id, entityId: SOL, field: 'costJpy', basis: 'estimate', value: 30_000_000, note: { ja: 'n', en: 'n' }, sourceIds: [] }], AT);
    const after = ctxWith(applied(ctx, plan.changes), mergeFills(emptyDeliverables(), plan.fills));

    const rejected = reviewFill(after, gap.id, { kind: 'reject' }, 'R', AT);
    expect(rejected.data.fills![gap.id]!.status).toBe('rejected');
    const emptied = applied(after, [rejected.change!]);
    expect((emptied.byId.get(SOL) as Entity & { costJpy?: number }).costJpy).toBeUndefined();

    const set = reviewFill(ctxWith(emptied, rejected.data), gap.id, { kind: 'set', value: '45,000,000' }, 'R', AT);
    expect(set.data.fills![gap.id]).toMatchObject({ basis: 'human', status: 'approved', value: 45_000_000 });
    expect((applied(after, [set.change!]).byId.get(SOL) as Entity & { costJpy?: number }).costJpy).toBe(45_000_000);
    expect(() => reviewFill(ctxWith(emptied, rejected.data), gap.id, { kind: 'set', value: 'abc' }, 'R', AT)).toThrow();
  });

  it('never overwrites a value entered meanwhile, and a label stops applying once the value changes', () => {
    const ctx = ctxWith();
    const proposal: FillProposal = { gapId: `${SOL}:costJpy`, entityId: SOL, field: 'costJpy', basis: 'estimate', value: 30_000_000, note: { ja: 'n', en: 'n' }, sourceIds: [] };
    const plan = fillChanges(ctx, [proposal], AT);
    const filled = ctxWith(applied(ctx, plan.changes), mergeFills(emptyDeliverables(), plan.fills));
    expect(fillChanges(filled, [proposal], AT)).toMatchObject({ changes: [], skipped: [proposal.gapId] });
    const edited = applied(filled, [{ op: 'upsert', entity: { ...filled.pack.byId.get(SOL)!, costJpy: 1 } as Entity }]);
    expect(buildDraft({ step: 'solution', ctx: ctxWith(edited, filled.deliverables), lang: 'ja', audience: 'internal' }).options).not.toContain('Copilot 推定');
    expect(() => reviewFill(ctxWith(edited, filled.deliverables), proposal.gapId, { kind: 'approve' }, 'R', AT)).toThrow();
  });

  it('drops a broken stored label or proposal alone', () => {
    const good = { entityId: SOL, field: 'costJpy', basis: 'estimate', value: 1, note: { ja: 'n', en: 'n' }, sourceIds: [], status: 'pending', at: AT };
    const data = normalizeDeliverables({
      docs: {}, signOffs: {},
      fills: {
        [`${SOL}:costJpy`]: good,
        [`${SOL}:annualBenefitJpy`]: { ...good, field: 'annualBenefitJpy', basis: 'unacquired' }, // value without "unacquired" contract
        'wrong-key': good,
        [`${SOL}:ownerRole`]: { ...good, field: 'ownerRole' }, // a number for a role
      },
    });
    expect(Object.keys(data.fills ?? {})).toEqual([`${SOL}:costJpy`]);
    expect(savedProposals([{ ...good, gapId: 'x' }, { gapId: 'y' }, null])).toHaveLength(1);
  });

  it('also fills site capacity and coordinates and product unit price and site, with the same checks', () => {
    const r2 = structuredClone(samplePack) as unknown as { entities: Record<string, unknown>[] };
    const plant = r2.entities.find((e) => e.id === 'site-nagoya')!;
    delete plant.lat; delete plant.lon; delete plant.capacityTPerMonth;
    const prod = r2.entities.find((e) => e.id === 'prod-servo')!;
    delete prod.unitPriceJpy; delete prod.siteId;
    const office: Record<string, unknown> = { ...r2.entities.find((e) => e.id === 'site-osaka-dc')!, id: 'site-office', role: 'office' };
    delete office.capacityTPerMonth;
    r2.entities.push(office);
    const s2 = r2.entities.find((e) => e.kind === 'source' && e.classification === 'shareable')!;
    (s2.description as { ja: string }).ja += ' 名古屋工場の月間能力は1.2万トン。';
    const ctx = ctxWith(loadPack(r2));
    const gaps = findGaps(ctx, 'internal').map((g) => g.id);
    expect(gaps).toEqual(expect.arrayContaining([
      'site-nagoya:lat', 'site-nagoya:lon', 'site-nagoya:capacityTPerMonth', 'prod-servo:unitPriceJpy', 'prod-servo:siteId',
    ]));
    // An office has no production capacity by definition: never a gap.
    expect(gaps).not.toContain('site-office:capacityTPerMonth');
    const req = fillRequest(ctx, 'ja', 'internal', findGaps(ctx, 'internal'));
    expect(req.entities!.some((e) => e.id === 'site-nagoya')).toBe(true);
    expect(req.entities!.some((e) => e.kind === 'person')).toBe(false);

    const want = findGaps(ctx, 'internal').filter((g) => g.entityId === 'site-nagoya' || g.entityId === 'prod-servo');
    const note = { ja: 'n', en: 'n' };
    const out = parseFill(answer([
      { gapId: 'site-nagoya:capacityTPerMonth', basis: 'evidence', value: 12_000, quote: '名古屋工場の月間能力は1.2万トン', sourceIds: [s2.id], note },
      { gapId: 'site-nagoya:lat', basis: 'evidence', value: 35.18, quote: '名古屋工場の月間能力は1.2万トン', sourceIds: [s2.id], note },
      { gapId: 'site-nagoya:lon', basis: 'estimate', value: 400, note },
      { gapId: 'prod-servo:unitPriceJpy', basis: 'estimate', value: 180_000, note },
      { gapId: 'prod-servo:siteId', basis: 'estimate', value: 'site-unknown', note },
    ]), want, ctx, 'internal');
    const by = Object.fromEntries(out.map((p) => [p.gapId, p]));
    expect(by['site-nagoya:capacityTPerMonth']).toMatchObject({ basis: 'evidence', value: 12_000 });
    // The quote is in the source but does not state the coordinate: an estimate.
    expect(by['site-nagoya:lat']).toMatchObject({ basis: 'estimate', downgraded: true, value: 35.18 });
    expect(by['site-nagoya:lon']).toMatchObject({ basis: 'unacquired' });
    expect(by['prod-servo:unitPriceJpy']).toMatchObject({ basis: 'estimate', value: 180_000 });
    // Only a site of the pack can be referenced.
    expect(by['prod-servo:siteId']).toMatchObject({ basis: 'unacquired' });

    const plan = fillChanges(ctx, [...out, { ...by['prod-servo:siteId']!, basis: 'estimate', value: 'site-nagoya' }], AT);
    const after = ctxWith(applied(ctx, plan.changes), mergeFills(emptyDeliverables(), plan.fills));
    expect(after.pack.issues).toEqual([]);
    expect(after.pack.byId.get('site-nagoya')).toMatchObject({ lat: 35.18, capacityTPerMonth: 12_000 });
    expect(after.pack.byId.get('prod-servo')).toMatchObject({ siteId: 'site-nagoya', unitPriceJpy: 180_000 });
    expect(findGaps(after, 'internal').map((g) => g.id)).toEqual(['site-nagoya:lon']);

    // A person's input in review is checked for its form.
    const lon = reviewFill(after, 'site-nagoya:lon', { kind: 'set', value: '136.9' }, 'R', AT);
    expect(lon.data.fills!['site-nagoya:lon']).toMatchObject({ basis: 'human', value: 136.9 });
    expect(() => reviewFill(after, 'site-nagoya:lon', { kind: 'set', value: '200' }, 'R', AT)).toThrow(/longitude/);
    const site = reviewFill(after, 'prod-servo:siteId', { kind: 'set', value: 'site-sendai' }, 'R', AT);
    expect(applied(after, [site.change!]).byId.get('prod-servo')).toMatchObject({ siteId: 'site-sendai' });
    expect(() => reviewFill(after, 'prod-servo:siteId', { kind: 'set', value: 'prod-arm' }, 'R', AT)).toThrow(/site/);
  });

  it('reads tonne quantities', () => {
    expect(tonneAmounts('月間能力は1.2万トン、倉庫は3,500 t')).toEqual([12_000, 3_500]);
    expect(tonneAmounts('about 800 tonnes per month')).toEqual([800]);
  });
});
