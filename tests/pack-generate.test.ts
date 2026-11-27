// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CopilotError, CopilotService, sessionLimits, type CopilotSdk, type SdkSession } from '../server/copilot.ts';
import { decodeHtml, factLinks, fetchSitePages, htmlToText, isPublicAddress, parseSiteUrl, purposeLinks, SITE_MAX_PAGES, SITE_PURPOSE_PAGES, SiteError } from '../server/site.ts';
import { CollectionReport } from '../src/data/collection.ts';
import { verifyPack } from '../src/data/verify.ts';
import {
  applyFix, fieldTopics, gapTopics, generatePack, missingRequired, newsOnPurpose, numbersIn, packSpec, PackGenError, prefillFromPack, pruneInvalid, purposeTerms, repairExtensions, roundTopics, runPlan, stageAPrompt, stepSpans, unconfirmedTopics, MAX_GAP_TOPICS, WORKIQ_GEN_ASPECTS, type GenDeps, type PackGenInput, type ProgressEvent, type WorkIqQuery,
} from '../src/modules/project/packGenerate.ts';
import { summarizeTokens } from '../src/ai/tokenUsage.ts';
import { readiness, REQUIREMENTS } from '../src/modules/project/analysisReadiness.ts';
import { METHOD_CATEGORIES } from '../src/modules/project/analysis.ts';
import { EngagementsExtension } from '../src/data/extensionSchemas.ts';
import { estimateTokens } from '../src/ai/budget.ts';
import { PACK_BUILD_MAX_PROMPT_CHARS, PER_USE_LIMITS } from '../src/ai/policy.ts';
import { CompanyAnchorVersionSchema } from '../src/data/companyAnchor.ts';
import { AiLiveError } from '../src/ai/client.ts';
import { RelayError } from '../src/modules/ai/relayClient.ts';
import { RATING_ANCHORS } from '../src/modules/project/issueTriage.ts';
import { workflowAnswer } from './fixtures/workflow.ts';

const NOW = new Date('2026-11-10T03:00:00Z');
const lt = (s: string) => ({ ja: s, en: s });
const base = (id: string, kind: string, world: string, type: string, sourceIds: string[], extra: Record<string, unknown> = {}) => ({
  id, kind, name: lt(id), description: lt(`${id} desc`), world, type, classification: 'shareable', author: 'ai', sourceIds, ...extra,
});

const input = (extra: Partial<PackGenInput> = {}): PackGenInput => ({
  companyName: 'Contoso 製作所', projectName: '納期改善', purpose: '納期遅延を減らす', asOf: '2026-11-10', lang: 'ja',
  industry: '製造', officialUrl: 'https://www.contoso.example', focus: '', researchNote: '',
  materials: [{ name: 'kpi.csv', text: '納期遵守率 baseline 92 current 94 target 98 (%), 2026年度' }],
  useNews: true, useWorkIq: false, ...extra,
});
const analysisAnswer = () => ({
  analyses: Object.entries(METHOD_CATEGORIES).map(([method, categories]) => ({
    method,
    items: categories.map((category) => ({ category, text: lt(`${method} ${category}`), score: 3 })),
  })),
});

const stageA = {
  packId: 'contoso-mfg', company: { name: { ja: 'Contoso 製作所', en: 'Contoso Manufacturing' }, industry: lt('製造') }, isSample: false,
  regions: [{ id: 'region-kanto', name: lt('関東') }],
  entities: [
    base('site-tokyo', 'site', 'real', 'site', ['source-web-1'], { role: 'hq', lat: 35.68, lon: 139.76, capacityTPerMonth: 0 }),
    base('product-gear', 'product', 'real', 'thing', ['source-web-1'], { category: lt('部品'), siteId: 'site-tokyo', unitPriceJpy: 12000 }),
    base('person-ceo', 'person', 'real', 'person', ['source-web-1'], { role: lt('社長'), siteId: 'site-tokyo' }),
    // Invented by the model: must be dropped, and what relies on it removed.
    base('source-fake', 'source', 'digital', 'data', [], { publisher: lt('x'), url: 'https://invented.example/', accessedDate: '2026-11-10', origin: 'web' }),
    base('product-ghost', 'product', 'real', 'thing', ['source-fake'], { category: lt('部品'), siteId: 'site-tokyo', unitPriceJpy: 999 }),
  ],
  extensions: { glossary: [{ term: lt('納期'), definition: lt('約束した引き渡し日') }], collection: { bogus: true } },
};
const stageB = {
  entities: [
    base('kpi-otd', 'kpi', 'digital', 'metric', ['source-doc-1'], {
      unit: lt('%'), baseline: 92, current: 94, target: 98, direction: 'increase', scale: 'ratio', period: lt('2026年度'), ownerId: 'person-ceo',
    }),
    base('cause-plan', 'cause', 'real', 'event', ['source-doc-1']),
    base('issue-delay', 'issue', 'real', 'event', ['source-doc-1'], { impact: 4, feasibility: 3, causeIds: ['cause-plan', 'cause-missing'], kpiIds: ['kpi-otd'] }),
    base('initiative-bad', 'initiative', 'real', 'operation', ['source-doc-1'], {
      solutionId: 'solution-missing', start: '2026-12-01', end: '2027-03-31', progress: 0, dependsOn: [], ownerId: 'person-ceo',
    }),
  ],
  gaps: [{ section: 'deal', missing: ['受注台帳'], nextAction: '受注台帳を添付する' }],
};

const sitePage = {
  url: 'https://www.contoso.example/', title: 'Contoso 製作所', description: '精密部品メーカー', themeColor: '#0F6CBD',
  text: '主力製品 ギア 単価 12,000円', fetchedAt: '2026-11-10T02:59:00.000Z',
};

const companyAnchor = CompanyAnchorVersionSchema.parse({
  version: 1, savedAt: '2026-11-09T00:00:00.000Z',
  anchor: {
    asOf: '2026-11-09',
    entityScope: { legalEntity: 'Contoso 製作所', figuresScope: ['legal entity'] },
    statedObjectives: [{ id: 'O1', text: 'Reduce delivery delays', horizon: '2026', basis: 'published', sourceIds: ['S1'] }],
    companyKpis: [{ id: 'K1', name: 'On-time delivery', target: '95', unit: '%', period: '2026', scope: 'legal entity', objectiveIds: ['O1'], sourceIds: ['S1'] }],
    segments: [], structuralIssues: [],
    analystHypotheses: [{ text: 'Private hypothesis not approved for generation', type: 'strategy' }],
    sources: [
      { id: 'S1', title: 'Annual plan', type: 'public', url: 'https://example.com/plan', accessedDate: '2026-11-09', locator: 'p. 2', excerpt: 'On-time delivery 95 % 2026 legal entity' },
      { id: 'S2', title: 'Internal meeting', type: 'internal', accessedDate: '2026-11-09', locator: 'meeting' },
    ],
  },
});

function deps(answers: unknown[], extra: Partial<GenDeps> = {}): GenDeps & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const configured: GenDeps & { prompts: string[] } = {
    prompts,
    provider: 'foundry',
    model: 'gpt-test',
    now: () => NOW,
    retryDelayMs: 0,
    complete: async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('# 検査済みProjectパック') || prompt.includes('# Verified Project pack')) {
        return { text: JSON.stringify(analysisAnswer()), inputTokens: 1000, outputTokens: 500 };
      }
      const a = answers[Math.min(i++, answers.length - 1)];
      return { text: typeof a === 'string' ? a : JSON.stringify(a), inputTokens: 1000, outputTokens: 500 };
    },
    fetchSite: async () => ({ pages: [sitePage], failed: [{ url: 'https://www.contoso.example/ir/', error: 'siteTimeout' }] }),
    fetchNews: async () => ({ provider: 'Google News RSS', fetchedAt: '2026-11-10T02:59:30.000Z', articles: [{ title: 'Contoso が新工場', url: 'https://news.example/a', source: '日刊', publishedAt: '2026-10-01T00:00:00Z' }] }),
    ...extra,
  };
  return {
    ...configured,
    complete: async (prompt, signal, stage) => {
      if (stage === 'workflow') {
        prompts.push(prompt);
        return { text: JSON.stringify(workflowAnswer(prompt)), inputTokens: 1000, outputTokens: 500 };
      }
      return configured.complete(prompt, signal, stage);
    },
  };
}

describe('FR-311 pack generation (D-12)', () => {
  it('lists missing required fields', () => {
    expect(missingRequired({ companyName: ' ', projectName: 'p', purpose: '', asOf: '2026-13-45x' })).toEqual(['companyName', 'purpose', 'asOf']);
    expect(missingRequired({ companyName: 'a', projectName: 'p', purpose: 'x', asOf: '2026-11-10' })).toEqual([]);
  });

  it('reuses the field specification of the Microsoft 365 prompt and lists only app-made source ids', () => {
    expect(packSpec('ja')).toContain('# パック全体');
    expect(packSpec('ja')).not.toContain('# 届け方');
    expect(packSpec('en')).toContain('# Pack');
    const p = stageAPrompt(input(), []);
    expect(p).toContain('source エンティティと extensions.collection は作らない');
    expect(p).toContain('納期遅延を減らす');
  });

  it('FR-383: the rules define the impact and feasibility ratings and ask for a stated time of impact', () => {
    const p = stageAPrompt(input(), []);
    expect(p).toContain(`impact: 5 = ${RATING_ANCHORS.impact[5].ja}`);
    expect(p).toContain(`feasibility: 5 = ${RATING_ANCHORS.feasibility[5].ja}`);
    expect(p).toContain(`1 = ${RATING_ANCHORS.feasibility[1].ja}`);
    expect(p).toContain('impactMonths?:{low,mode,high}');
    const en = stageAPrompt(input({ lang: 'en' }), []);
    expect(en).toContain(`impact: 5 = ${RATING_ANCHORS.impact[5].en}`);
    expect(en).toContain('impactMonths?:{low,mode,high}');
  });

  it('generates, drops invented sources, fixes only failing items, prunes the rest, and the result verifies', async () => {
    const events: ProgressEvent[] = [];
    const d = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }]);
    const r = await generatePack(input(), d, (e) => events.push(e), new AbortController().signal);

    expect(verifyPack(r.pack).ok).toBe(true);
    const ids = (r.pack.entities as { id: string; kind: string }[]).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['source-web-1', 'source-news-1', 'source-doc-1', 'site-tokyo', 'product-gear', 'kpi-otd', 'issue-delay']));
    expect(ids).not.toContain('source-fake');
    expect(ids).not.toContain('product-ghost');
    expect(ids).not.toContain('initiative-bad');
    const issue = (r.pack.entities as Record<string, unknown>[]).find((e) => e.id === 'issue-delay')!;
    expect(issue.causeIds).toEqual(['cause-plan']); // the dangling id is taken out; the valid issue stays
    const web = (r.pack.entities as Record<string, unknown>[]).find((e) => e.id === 'source-web-1')!;
    expect(web).toMatchObject({ url: 'https://www.contoso.example/', accessedDate: '2026-11-10', origin: 'web' });

    expect(r.report.droppedSources).toEqual(['source-fake']);
    expect(r.report.removed.map((x) => x.path)).toContain('entities.product-ghost');
    expect(r.report.fixRounds).toBe(3);
    expect(r.report.calls.map((c) => c.stage)).toEqual(['foundation', 'business', 'workflow', 'fix-1', 'fix-2', 'fix-3', 'analysis']);
    expect(r.report.retrievalErrors).toEqual([{ what: 'site', url: 'https://www.contoso.example/ir/', error: 'siteTimeout' }]);
    expect(r.report.ungrounded).toEqual([]); // 12,000 is on the page, 92/94/98 in kpi.csv
    expect(r.report.inputs.materials[0]).toMatchObject({ name: 'kpi.csv', text: expect.stringContaining('納期遵守率') });

    const ext = r.pack.extensions as Record<string, unknown>;
    const collection = CollectionReport.parse(ext.collection);
    expect(collection.webSearch).toBe('searched');
    expect(collection.sections).toHaveLength(25);
    expect(collection.sections.every((s) => s.status !== 'complete')).toBe(true);
    expect(collection.sections.find((s) => s.key === 'deal')).toMatchObject({ status: 'unavailable', missingFields: ['受注台帳'], nextAction: '受注台帳を添付する' });
    // No account from the model: the verifier's required sourced fields are listed instead.
    expect(collection.sections.find((s) => s.key === 'invoice')).toMatchObject({ status: 'unavailable', missingFields: ['amountJpy', 'deliverableId'], nextAction: expect.stringContaining('amountJpy・deliverableId') });
    expect((ext.generation as { provider: string }).provider).toBe('foundry');
    expect(r.pack.isSample).toBe(false);

    expect(d.prompts[0]).toContain('source-web-1');
    expect(d.prompts[0]).toContain('主力製品 ギア 単価 12,000円');
    expect(d.prompts[1]).toContain('site-tokyo'); // stage B sees the foundation ids
    expect(d.prompts[3]).toContain('initiative-bad');
    expect(r.analysis.analyses.map((a) => a.method)).toEqual(Object.keys(METHOD_CATEGORIES));
    expect(r.analysis.analyses.every((a) => a.items.length > 0 && a.items.every((i) => i.author === 'ai' && i.mock === false))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ step: 'analysis', status: 'done' }));
    expect(events.at(-1)).toMatchObject({ step: 'finalize', status: 'done', ratio: 1 });
    expect(events.map((e) => e.ratio)).toEqual([...events.map((e) => e.ratio)].sort((a, b) => a - b));
  });

  it('stops after the stages when the pack already verifies (no fix call)', async () => {
    const clean = { ...stageA, entities: stageA.entities.filter((e) => !['source-fake', 'product-ghost'].includes(e.id)) };
    const d = deps([clean, { entities: [stageB.entities[0], stageB.entities[1]] }]);
    const r = await generatePack(input(), d, () => {}, new AbortController().signal);
    expect(r.report.fixRounds).toBe(0);
    expect(d.prompts).toHaveLength(4);
    expect(r.report.removed).toEqual([]);
  });

  it('requires a valid result for all five methods and includes that send in the estimate', async () => {
    const clean = { ...stageA, entities: stageA.entities.filter((e) => !['source-fake', 'product-ghost'].includes(e.id)) };
    const d = deps([clean, { entities: [] }]);
    const complete = d.complete;
    d.complete = async (prompt, signal, stage) => {
      if (stage === 'analysis') {
        d.prompts.push(prompt);
        const answer = analysisAnswer();
        return { text: JSON.stringify({ ...answer, analyses: answer.analyses.slice(0, 4) }), inputTokens: 1000, outputTokens: 500 };
      }
      return complete(prompt, signal, stage);
    };
    await expect(generatePack(input({ officialUrl: '', useNews: false }), d, () => {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalidAnalysis' });
    expect(runPlan(input({ useWorkIq: false }))).toMatchObject({ minCalls: 4, maxCalls: 9 });
  });

  it('preserves unknown call tokens in the saved report and progress instead of reporting zero', async () => {
    const d = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }]);
    const complete = d.complete;
    let calls = 0;
    d.complete = async (...args) => ({ ...await complete(...args), ...(++calls === 1 ? { inputTokens: null, outputTokens: null } : {}) });
    const events: ProgressEvent[] = [];
    const r = await generatePack(input(), d, (event) => events.push(event), new AbortController().signal);
    expect(r.report.calls[0]).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(r.report.calls[1]!.inputTokens).toEqual(expect.any(Number));
    expect(events.at(-1)!.tokens).toBeNull();
    expect((r.pack.extensions as { generation: object }).generation).not.toHaveProperty('costJpy');
  });

  it('reports numbers the cited text does not contain', async () => {
    const odd = { ...stageA, entities: [stageA.entities[0], { ...stageA.entities[1], unitPriceJpy: 34567 }] };
    const r = await generatePack(input(), deps([odd, { entities: [] }]), () => {}, new AbortController().signal);
    expect(r.report.ungrounded).toEqual([{ id: 'product-gear', field: 'unitPriceJpy', value: 34567 }]);
  });

  it('works without public material and records that no web material was requested', async () => {
    const d = deps([{ ...stageA, entities: [base('cause-a', 'cause', 'real', 'event', ['source-doc-1'])] }, { entities: [] }]);
    const r = await generatePack(input({ officialUrl: '', useNews: false }), d, () => {}, new AbortController().signal);
    expect(CollectionReport.parse((r.pack.extensions as Record<string, unknown>).collection).webSearch).toBe('notRequested');
    expect((r.pack.entities as { id: string }[]).map((e) => e.id)).    toEqual(['source-doc-1', 'source-brief-1', 'cause-a']);
  });

      it('keeps an issue that cites only the purpose the user typed', async () => {
        const issue = base('issue-effort', 'issue', 'real', 'event', ['source-brief-1'], { impact: 4, feasibility: 3, causeIds: [], kpiIds: [] });
        const r = await generatePack(input({ officialUrl: '', useNews: false }), deps([{ ...stageA, entities: [] }, { entities: [issue] }]), () => {}, new AbortController().signal);
        expect((r.pack.entities as { id: string }[]).map((e) => e.id)).toContain('issue-effort');
      });
  it('uses a versioned company summary separately from project retrieval and preserves an immutable snapshot', async () => {
    const queries: WorkIqQuery[] = [];
    const anchor = structuredClone(companyAnchor);
    const foundation = { ...stageA, entities: [base('cause-anchor', 'cause', 'real', 'event', ['source-anchor-2'])] };
    const d = deps([foundation, { entities: [] }], {
      fetchWorkIq: async (q) => { queries.push(q); return []; },
    });
    const r = await generatePack(input({
      officialUrl: '', useNews: false, useWorkIq: true, workIqRounds: 1, companyAnchor: anchor,
    }), d, () => {}, new AbortController().signal);
    expect(verifyPack(r.pack).ok).toBe(true);
    expect(queries[0]).toMatchObject({ company: 'Contoso 製作所', project: '納期改善', purpose: '納期遅延を減らす' });
    expect(JSON.stringify(queries)).not.toContain('Reduce delivery delays');
    expect(d.prompts[0]).toContain('Reduce delivery delays');
    expect(d.prompts[0]).toContain('source-anchor-1');
    expect(d.prompts[0]).not.toContain('Private hypothesis not approved for generation');
    expect((r.pack.entities as { id: string; classification: string }[]).find((entity) => entity.id === 'cause-anchor')?.classification).toBe('internal');
    expect(r.pack.extensions).toMatchObject({
      companyAnchor: anchor,
      companyAlignment: { projectPurpose: '納期遅延を減らす', alignments: [{ kind: 'unaligned', status: 'draft' }] },
    });
    expect(r.verify.problems).toContainEqual(expect.objectContaining({ severity: 'warning', path: 'extensions.companyAlignment.alignments[0]' }));
    anchor.anchor.statedObjectives[0]!.text = 'Changed after generation';
    expect(JSON.stringify(r.pack.extensions)).toContain('Reduce delivery delays');
  });

  it('reads the site and the news at the same time', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const base = deps([{ ...stageA, entities: [] }, { entities: [] }]);
    const d = deps([{ ...stageA, entities: [] }, { entities: [] }], {
      fetchSite: async (...a) => { await wait(300); return base.fetchSite!(...a); },
      fetchNews: async (...a) => { await wait(300); return base.fetchNews!(...a); },
    });
    const t0 = Date.now();
    await generatePack(input(), d, () => {}, new AbortController().signal).catch(() => undefined);
    expect(Date.now() - t0).toBeLessThan(550);
  });

  it('never sends a project web topic without confirmation and sends the confirmed topic separately', async () => {
    const searches: string[] = [];
    const d = deps([{ ...stageA, entities: [] }, { entities: [] }], {
      fetchNews: async (_company, _lang, _signal, topic) => {
        searches.push(topic ?? '');
        return { provider: 'Google News RSS', fetchedAt: NOW.toISOString(), articles: [] };
      },
    });
    const params = input({ officialUrl: '', publicWebTopic: '公開物流情報', useNews: true });
    await expect(generatePack(params, d, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'collectFailed' });
    expect(searches).toEqual([]);
    await generatePack({ ...params, webTopicConfirmed: true }, d, () => {}, new AbortController().signal);
    expect(searches).toEqual(['公開物流情報']);
  });

  it('D-14: uses the Work IQ answer as an internal Microsoft 365 source the model may cite, and records what was asked and cited', async () => {
    const queries: unknown[] = [];
    const workiq = {
      question: 'Q', answer: '受注残 3.5億円（2026年10月の営業会議）', sensitivity: 'Confidential', fetchedAt: '2026-11-10T02:59:45.000Z',
      citations: [{ title: '営業会議 2026-10', url: 'https://contoso.sharepoint.com/sales.docx' }],
    };
    const d = deps([{ ...stageA, entities: [base('cause-a', 'cause', 'real', 'event', ['source-workiq-1'])] }, { entities: [] }], {
      fetchWorkIq: async (q) => { queries.push(q); return workiq; },
    });
    const r = await generatePack(input({ officialUrl: '', useNews: false, focus: '関東', useWorkIq: true }), d, () => {}, new AbortController().signal);
    expect(queries[0]).toEqual({ company: 'Contoso 製作所', project: '納期改善', purpose: '納期遅延を減らす', focus: '関東', asOf: '2026-11-10', lang: 'ja', aspects: [...WORKIQ_GEN_ASPECTS], expand: true });
    const source = (r.pack.entities as Record<string, unknown>[]).find((e) => e.id === 'source-workiq-1')!;
    expect(source).toMatchObject({ kind: 'source', classification: 'internal', origin: 'm365', locator: 'Microsoft Work IQ', accessedDate: '2026-11-10' });
    expect((r.pack.entities as { id: string }[]).map((e) => e.id)).toContain('cause-a'); // the model cited it and it verified
    expect(d.prompts[0]).toContain('| source-workiq-1 | workiq |');
    expect(d.prompts[0]).toContain('受注残 3.5億円');
    expect(d.prompts[0]).toContain('https://contoso.sharepoint.com/sales.docx');
    expect(r.report.retrieved.find((x) => x.kind === 'workiq')).toMatchObject({ question: 'Q', citations: workiq.citations, sensitivity: 'Confidential' });
    expect(CollectionReport.parse((r.pack.extensions as Record<string, unknown>).collection).webSearchReason).toContain('Work IQ');
  });

  it('D-14: one source per Work IQ section; the model\'s gaps are asked first and a stage re-runs only for new Microsoft 365 items', async () => {
    const queries: WorkIqQuery[] = [];
    const ans = (key: string, answer: string, url: string) => ({
      key, question: `Q-${key}`, answer, sensitivity: 'General', fetchedAt: '2026-11-10T02:59:45.000Z', citations: [{ title: key, url }],
    });
    const office = base('site-hub-london', 'site', 'real', 'site', ['source-workiq-locations'], { role: 'office', city: 'London', country: 'UK', lat: 0, lon: 0, capacityTPerMonth: 0 });
    const a1 = { ...stageA, entities: [base('cause-a', 'cause', 'real', 'event', ['source-workiq-kpi'])], gaps: [{ section: 'kpi', missing: ['NSAT の目標値'] }] };
    const a2 = { ...stageA, entities: [base('cause-a', 'cause', 'real', 'event', ['source-workiq-a-topic-1']), office], gaps: [] };
    const b1 = { entities: [], gaps: [{ section: 'workflow', missing: ['次に引き継ぐチーム'] }] };
    const d = deps([a1, a2, b1], {
      fetchWorkIq: async (q) => {
        queries.push(q);
        if (q.aspects?.length) return [ans('kpi', 'Lead Engagement 50%', 'https://t.example/kpi'), ans('locations', 'London hub', 'https://t.example/hubs'), { key: 'data', error: 'workiqTimeout' }];
        // Stage A's follow-up brings a new file; stage B's only repeats a file already cited (no re-run).
        return queries.length === 2 ? [ans('topic-1', 'NSAT 目標 4.5', 'https://t.example/nsat')] : [ans('topic-1', '同じ資料', 'https://t.example/kpi')];
      },
    });
    const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true }), d, () => {}, new AbortController().signal);

    expect(queries[0]!.aspects).toHaveLength(9);
    expect(queries[0]!.aspects).toContain('kpiCompany');
    // Round 1 of stage A: the model's gap first, then the first wording for each item still missing (up to 8 searches).
    expect(queries[1]!.topics![0]).toBe('kpi: NSAT の目標値');
    expect(queries[1]!.topics!.length).toBeGreaterThan(4);
    expect(queries[1]!.topics!.length).toBeLessThanOrEqual(MAX_GAP_TOPICS);
    expect(queries.some((q) => q.topics?.[0] === 'workflow: 次に引き継ぐチーム')).toBe(true);
    // Later rounds bring nothing new (the same file), so no further re-run happens.
    expect(r.report.calls.map((c) => c.stage)).toEqual(['foundation', 'foundation-2', 'business', 'workflow', 'analysis']);
    expect(r.report.stopReasons).toEqual({ a: 'roundLimit', b: 'roundLimit' });
    const ids = (r.pack.entities as { id: string }[]).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['source-workiq-kpi', 'source-workiq-locations', 'source-workiq-a-topic-1', 'cause-a', 'site-hub-london']));
    expect(ids).not.toContain('source-workiq-b-topic-1');
    expect(d.prompts[1]).toContain('NSAT 目標 4.5');
    expect(r.report.retrievalErrors).toContainEqual({ what: 'workiq', error: 'data: workiqTimeout' });
    // The office named by city is placed on London, not where the model put it.
    expect((r.pack.entities as Record<string, unknown>[]).find((e) => e.id === 'site-hub-london')).toMatchObject({ role: 'office', lat: 51.51, lon: -0.13 });
    expect(verifyPack(r.pack).ok).toBe(true);
  });

  it('keeps long follow-up topics complete and distinguishes topics that share a long prefix', () => {
    const name = `${'長い項目名'.repeat(80)}末尾`;
    const pack = { entities: [base('solution-long', 'solution', 'real', 'operation', [], { name: lt(name) })] };
    const problems = [{ severity: 'error' as const, code: 'ENTITY_SCHEMA' as const, path: 'costJpy', entityId: 'solution-long', cause: 'costJpy: required', action: '' }];
    expect(fieldTopics(pack, problems, ['engagements'], 'ja')).toEqual([`${name}: 費用（円）`]);
    expect(unconfirmedTopics(pack, ['engagements'], 'ja')).toEqual([`${name}: 費用（円）・年間の効果額（円）`]);
    expect(gapTopics([{ section: 'kpi', missing: [name] }], 'ja')).toEqual([`kpi: ${name}`]);

    const first = `${name}: 最初`, second = `${name}: 次`;
    expect(roundTopics([], [], new Set([first]), 'ja', [first, second])).toEqual([second]);
  });

  describe('FR-341 company and business-unit KPI/OKR', () => {
    const unitAns = (unit: string) => [{ key: 'kpiUnit', question: `Q-${unit}`, answer: `${unit} の KPI: 出荷リードタイム 3 日`, sensitivity: 'General', fetchedAt: '2026-11-10T02:59:45.000Z', citations: [{ title: 'unit plan', url: 'https://t.example/unit' }] }];
    const okrOf = (r: { pack: Record<string, unknown> }) => (r.pack.extensions as { okr: { orgUnits: Record<string, unknown>[]; kpis: Record<string, unknown>[] } }).okr;

    it('AC-944: a typed unit is searched with the company-wide KPI/OKR in the first fan-out, and both organisations are written', async () => {
      const queries: WorkIqQuery[] = [];
      const d = deps([stageA, stageB], { fetchWorkIq: async (q) => { queries.push(q); return unitAns(q.unit ?? '-'); } });
      const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true, orgUnit: '物流事業部' }), d, () => {}, new AbortController().signal);
      expect(queries[0]).toMatchObject({ aspects: [...WORKIQ_GEN_ASPECTS, 'kpiUnit'], unit: '物流事業部', expand: true });
      expect(queries[0]!.aspects).toContain('kpiCompany');
      expect(queries.filter((q) => q.unit)).toHaveLength(1); // no second search for a typed unit
      expect(d.prompts[0]).toContain('- 対象の事業部: 物流事業部\n');
      expect(d.prompts[0]).not.toContain('orgEstimate:');
      expect(okrOf(r).orgUnits).toEqual([
        { id: 'org-company', level: 'legalEntity', name: 'Contoso 製作所', basis: 'userInput' },
        { id: 'org-unit', level: 'business', name: '物流事業部', basis: 'userInput' },
      ]);
    });

    it('keeps a long typed business-unit name in the search, prompt and saved organisation', async () => {
      const unit = `${'事業部'.repeat(110)}末尾`;
      const queries: WorkIqQuery[] = [];
      const d = deps([stageA, stageB], { fetchWorkIq: async (q) => { queries.push(q); return unitAns(q.unit ?? '-'); } });
      const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true, orgUnit: unit }), d, () => {}, new AbortController().signal);
      expect(queries[0]).toMatchObject({ unit, aspects: [...WORKIQ_GEN_ASPECTS, 'kpiUnit'] });
      expect(d.prompts[0]).toContain(unit);
      expect(okrOf(r).orgUnits).toContainEqual(expect.objectContaining({ id: 'org-unit', name: unit, basis: 'userInput' }));
    });

    it('uses a long inferred unit when it has a source', async () => {
      const unit = `${'事業部'.repeat(110)}末尾`;
      const queries: WorkIqQuery[] = [];
      const a = { ...stageA, orgEstimate: { level: 'business', name: unit, sourceIds: ['source-doc-1'] } };
      const d = deps([a, stageB], { fetchWorkIq: async (q) => { queries.push(q); return q.unit ? unitAns(q.unit) : []; } });
      const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true }), d, () => {}, new AbortController().signal);
      expect(queries).toContainEqual(expect.objectContaining({ aspects: ['kpiUnit'], unit }));
      expect(okrOf(r).orgUnits).toContainEqual(expect.objectContaining({ id: 'org-unit', name: unit, basis: 'inferred' }));
    });

    it('AC-945: without a unit, the estimate that cites this run\'s material triggers the unit\'s own Work IQ search and is marked inferred', async () => {
      const queries: WorkIqQuery[] = [];
      const a = { ...stageA, orgEstimate: { level: 'business', name: '物流事業部', reason: '目的の「納期」と kpi.csv', sourceIds: ['source-doc-1'] } };
      const d = deps([a, stageB], { fetchWorkIq: async (q) => { queries.push(q); return q.aspects?.includes('kpiUnit') && q.unit ? unitAns(q.unit) : []; } });
      const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true }), d, () => {}, new AbortController().signal);
      expect(queries[0]!.aspects).not.toContain('kpiUnit');
      expect(queries[0]!.unit).toBeUndefined();
      expect(d.prompts[0]).toContain('orgEstimate:');
      expect(queries).toContainEqual(expect.objectContaining({ aspects: ['kpiUnit'], unit: '物流事業部' }));
      // The unit's answer reaches stage B as material, and the scope row says the unit was estimated.
      expect(d.prompts[1]).toContain('物流事業部 の KPI: 出荷リードタイム 3 日');
      expect(d.prompts[1]).toContain('| source-workiq-kpi-unit |');
      expect(d.prompts[1]).toContain('- 対象の事業部: 物流事業部（推定。根拠: source-doc-1）');
      expect(okrOf(r).orgUnits).toContainEqual(expect.objectContaining({ id: 'org-unit', name: '物流事業部', basis: 'inferred', sourceIds: ['source-doc-1'] }));
      expect(r.pack).not.toHaveProperty('orgEstimate');
    });

    it('AC-946: an estimate without known sources, or named as the company itself, is not used and no unit search runs', async () => {
      for (const orgEstimate of [
        { level: 'business', name: '物流事業部', sourceIds: ['source-invented'] },
        { level: 'business', name: 'Contoso 製作所', sourceIds: ['source-doc-1'] },
        { level: 'board', name: '取締役会', sourceIds: ['source-doc-1'] },
      ]) {
        const queries: WorkIqQuery[] = [];
        const d = deps([{ ...stageA, orgEstimate }, stageB], { fetchWorkIq: async (q) => { queries.push(q); return []; } });
        const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true }), d, () => {}, new AbortController().signal);
        expect(queries.some((q) => q.unit)).toBe(false);
        expect(okrOf(r).orgUnits.map((u) => u.id)).toEqual(['org-company']);
      }
    });
  });

  it('D-14: repeats Work IQ with the next wording until the analysis has what it needs, keeps no regressing re-run, and stops at the chosen rounds', async () => {
    const queries: WorkIqQuery[] = [];
    let topicCalls = 0;
    const ans = (key: string, answer: string, url: string) => ({
      key, question: `Q-${key}`, answer, sensitivity: 'General', fetchedAt: '2026-11-10T02:59:45.000Z', citations: [{ title: key, url }],
    });
    const src = ['source-workiq-kpi'];
    const aFull = {
      ...stageA,
      entities: [
        base('site-tokyo', 'site', 'real', 'site', src, { role: 'office', city: 'Tokyo', country: 'Japan', lat: 0, lon: 0, capacityTPerMonth: 0 }),
        base('person-lead', 'person', 'real', 'person', src, { role: lt('責任者'), siteId: 'site-tokyo' }),
        base('person-mgr', 'person', 'real', 'person', src, { role: lt('マネージャー'), siteId: 'site-tokyo' }),
        base('customer-x', 'customer', 'real', 'organization', src, { industry: lt('小売'), regionId: 'region-kanto' }),
      ],
      extensions: {
        workflow: { stages: [
          { id: 'st-in', name: '受付', team: '営業', next: ['st-prep'] },
          { id: 'st-prep', name: '準備', team: '営業', next: ['st-run'] },
          { id: 'st-run', name: '実施', team: '営業', handoffTo: ['アカウントチーム'] },
        ] },
        dataCatalog: { items: [{ name: 'Pipeline' }, { name: 'NSAT' }, { name: 'Events' }] },
      },
    };
    // Stage A's answer cites the Work IQ section (this run fetched no web page), so its office and people survive.
    const aCited = { ...stageA, entities: stageA.entities.map((e) => (e.sourceIds.includes('source-web-1') ? { ...e, sourceIds: src } : e)) };
    const byStage: Record<string, unknown> = {
      foundation: aCited, 'foundation-2': { ...stageA, entities: [] }, 'foundation-3': aFull, business: { entities: [] },
    };
    const d = deps([], {
      complete: async (prompt, _signal, stage) => {
        d.prompts.push(prompt);
        if (stage === 'analysis') return { text: JSON.stringify(analysisAnswer()), inputTokens: 1000, outputTokens: 500 };
        return { text: JSON.stringify(byStage[stage ?? ''] ?? { replace: [] }), inputTokens: 1000, outputTokens: 500 };
      },
      fetchWorkIq: async (q) => {
        queries.push(q);
        if (q.aspects?.length) return [ans('kpi', 'Lead Engagement 50%', 'https://t.example/kpi')];
        topicCalls++;
        // Stage A's two rounds each bring a new file; stage B's only repeat a file already cited.
        return topicCalls <= 2 ? [ans('topic-1', `回答 ${topicCalls}`, `https://t.example/f${topicCalls}`)] : [ans('topic-1', '同じ資料', 'https://t.example/kpi')];
      },
    });
    const events: ProgressEvent[] = [];
    const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true, workIqRounds: 2 }), d, (e) => events.push(e), new AbortController().signal);

    const topics = queries.slice(1).map((q) => q.topics);
    expect(topics).toEqual([
      ['主要な関係者の氏名と役職、組織図', '主要な顧客・顧客セグメントと業種', '依頼の受付から成果物の引き渡しまでの業務手順と、次に引き継ぐチーム', 'チームが管理・利用するデータ、レポート、ダッシュボード、システム'],
      ['チームのメンバー一覧と役割分担（責任者・マネージャー・担当者）', '最近対応した顧客の名前と業種', '案件・エンゲージメントのライフサイクル（受付・準備・実施・フォローアップ）と各段階の担当', 'Power BI レポート、Excel のトラッカー、SharePoint リスト、CRM（Dynamics 365・Salesforce）の利用'],
      ['KPI・OKR の定義と目標値・実績値', '案件・提案・エンゲージメントの一覧と進捗', '課題・その原因・改善施策'],
      ['スコアカード、QBR、ビジネスレビュー資料にある指標と達成率', '実施したワークショップ・ブリーフィング・PoC の事例と件数', '振り返り（レトロスペクティブ）やリスク管理表で挙がった問題点'],
    ]);
    expect(r.report.calls.map((c) => c.stage).filter((s) => !s.startsWith('fix-'))).toEqual(['foundation', 'foundation-2', 'foundation-3', 'business', 'workflow', 'analysis']);
    expect(r.report.collectionRounds!.map((x) => [x.stage, x.round, x.rerun, x.adopted, x.newSources])).toEqual([
      ['a', 1, true, false, ['source-workiq-a-topic-1']], // the re-run lost everything: not kept
      ['a', 2, true, true, ['source-workiq-a2-topic-1']],
      ['b', 1, false, false, []],
      ['b', 2, false, false, []],
    ]);
    expect(r.report.stopReasons).toEqual({ a: 'satisfied', b: 'roundLimit' });
    // Every answer found so far goes into the next re-run.
    const third = d.prompts[2]!;
    expect(third).toContain('回答 1');
    expect(third).toContain('回答 2');
    expect(events.filter((e) => e.collectRound).map((e) => [e.step, e.collectRound, e.unmet?.length])).toEqual([
      ['foundation', 1, 4], ['foundation', 2, 4], ['business', 1, 3], ['business', 2, 3],
    ]);
    expect(r.report.readiness!.map((x) => x.key)).toEqual(['org', 'locations', 'customers', 'workflow', 'dataCatalog', 'kpi', 'engagements', 'issues']);
    expect(r.report.readiness!.find((x) => x.key === 'workflow')).toMatchObject({ have: 3, met: true });
    expect(verifyPack(r.pack).ok).toBe(true);
    // Re-runs count under their stage's step in the token table.
    expect(summarizeTokens(r.report.calls.map((c) => ({ at: NOW.toISOString(), use: 'packBuild', stage: c.stage, inputTokens: 1, outputTokens: 1 }))).lines.map((l) => l.step))
      .toEqual(expect.arrayContaining(['foundation', 'business']));
    expect(summarizeTokens(r.report.calls.map((c) => ({ at: NOW.toISOString(), use: 'packBuild', stage: c.stage, inputTokens: 1, outputTokens: 1 }))).lines.map((l) => l.step))
      .not.toContain('foundation-3');
    // A later re-fetch starts from what this run used.
    expect(prefillFromPack(r.pack)).toMatchObject({ purpose: '納期遅延を減らす', useWorkIq: true, workIqRounds: 2, materials: [{ name: 'kpi.csv', text: expect.stringContaining('納期遵守率') }] });
    expect(prefillFromPack({ extensions: {} })).toBeNull();
  });

  it('D-14 planned fan-out: wordings the relay already searched are not asked again, and rounds stop after two re-runs in a row add nothing', async () => {
    const queries: WorkIqQuery[] = [];
    const fetchedAt = '2026-11-10T02:59:45.000Z';
    // The relay's merged sections, one per readiness item, each listing the ladder wordings it searched.
    const merged = REQUIREMENTS.map((r) => ({ key: r.key, question: `Q-${r.key}`, answer: `${r.key} の事実`, sensitivity: null, fetchedAt, citations: [{ title: r.key, url: `https://t.example/${r.key}` }], searches: r.ladder.ja, ...(r.key === 'workflow' ? { deepRead: { files: 2 } } : {}) }));
    // Every answer names a new gap, so only the progress rule can end the rounds.
    let n = 0;
    const d = deps([], {
      complete: async (prompt, _signal, stage) => {
        d.prompts.push(prompt);
        n++;
        const answer = stage === 'analysis' ? analysisAnswer()
          : stage.startsWith('foundation') ? { ...stageA, gaps: [{ section: 'kpi', missing: [`NSAT の目標値 ${n}`] }] }
            : stage.startsWith('business') ? { entities: [], gaps: [{ section: 'issue', missing: [`遅延の原因 ${n}`] }] } : { replace: [] };
        return { text: JSON.stringify(answer), inputTokens: 1000, outputTokens: 500 };
      },
      fetchWorkIq: async (q) => {
        queries.push(q);
        if (q.expand) return merged;
        return [{ key: 'topic-1', question: 'Q', answer: `回答 ${queries.length}`, sensitivity: null, fetchedAt, citations: [{ title: 't', url: `https://t.example/new-${queries.length}` }] }];
      },
    });
    const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true, workIqRounds: 4 }), d, () => {}, new AbortController().signal);

    expect(queries[0]).toMatchObject({ aspects: [...WORKIQ_GEN_ASPECTS], expand: true });
    const ladder = new Set(REQUIREMENTS.flatMap((x) => x.ladder.ja));
    expect(queries.slice(1).flatMap((q) => q.topics ?? []).filter((t) => ladder.has(t))).toEqual([]);
    expect(queries.slice(1).map((q) => q.topics![0])).toEqual(['kpi: NSAT の目標値 1', 'kpi: NSAT の目標値 2', 'issue: 遅延の原因 4', 'issue: 遅延の原因 5']);
    // Two re-runs in a row that did not raise the readiness count end each stage before its limit of 4.
    expect(r.report.calls.map((c) => c.stage).filter((s) => !s.startsWith('fix-'))).toEqual(['foundation', 'foundation-2', 'foundation-3', 'business', 'business-2', 'business-3', 'workflow', 'analysis']);
    expect(r.report.stopReasons).toEqual({ a: 'noProgress', b: 'noProgress' });
    expect((r.pack.entities as { id: string }[]).map((e) => e.id)).toEqual(expect.arrayContaining(['source-workiq-customers', 'source-workiq-workflow', 'source-workiq-data-catalog']));
    expect(r.report.retrieved.find((x) => x.sourceId === 'source-workiq-workflow')!.title).toContain('業務の流れ');
    // Which items Work IQ read in full is in the report.
    expect(r.report.retrieved.find((x) => x.sourceId === 'source-workiq-workflow')!.deepRead).toEqual({ files: 2 });
    expect(r.report.retrieved.find((x) => x.sourceId === 'source-workiq-data-catalog')!.deepRead).toBeUndefined();
    expect(r.report.retrieved.find((x) => x.sourceId === 'source-workiq-data-catalog')!.title).toContain('データ資産');
  });

  it('D-15: OKR and workflow items survive mechanical slips, a fix answer cannot delete them, and only the failing item is pruned', () => {
    const src = base('source-workiq-kpi', 'source', 'digital', 'data', [], { publisher: lt('Microsoft 365 (Work IQ)'), locator: 'Microsoft Work IQ', accessedDate: '2026-11-10', origin: 'm365' });
    const pack = {
      packId: 'contoso-x', company: { name: lt('Contoso'), industry: lt('製造') }, isSample: false, regions: [], flows: [], entities: [src],
      extensions: {
        // As the model wrote them on 2026-11-12: KPI without id, a single `next` as a string, a stage without id.
        okr: { kpis: [{ name: lt('NSAT'), target: '4.5', sourceIds: ['source-workiq-kpi'] }, { id: 'kpi-wins', name: lt('Wins'), sourceIds: ['source-gone'] }, { id: 'kpi-broken' }], objectives: [] },
        workflow: { stages: [{ id: 'st-in', name: lt('受付'), next: 'stage-2' }, { name: lt('実施') }] },
        graph: { layers: [] },
      },
    };
    const kept = applyFix(pack, { sections: { extensions: { okr: null, workflow: null, graph: null } } }, new Set());
    expect(Object.keys(kept.extensions as object).sort()).toEqual(['okr', 'workflow']);

    const pruned = pruneInvalid(kept, NOW);
    expect(pruned.verify.ok).toBe(true);
    const ext = pruned.pack.extensions as { okr: { kpis: { id: string; sourceIds: string[] }[] }; workflow: { stages: { id: string; next: string[] }[] } };
    expect(ext.okr.kpis.map((k) => [k.id, k.sourceIds])).toEqual([['okr-kpi-1', ['source-workiq-kpi']], ['kpi-wins', []]]);
    expect(ext.workflow.stages.map((s) => [s.id, s.next])).toEqual([['st-in', ['stage-2']], ['stage-2', undefined]]);
    expect(pruned.removed).toEqual([{ path: 'extensions.okr.kpis[2]', reason: expect.any(String) }]);
  });

  it('D-16: keeps sourced records without money or progress, fixes references item by item and rejects unsupported records', () => {
    const source = base('source-workiq-engagements', 'source', 'digital', 'data', [], { publisher: lt('Work IQ'), locator: 'Work IQ', accessedDate: '2026-11-10', origin: 'm365' });
    const good = { id: 'engagement-good', name: 'Customer briefing', status: 'Delivered', count: '20 participants', sourceIds: [source.id] };
    const raw = {
      packId: 'engagements', company: { name: lt('Contoso'), industry: lt('Services') }, regions: [], flows: [], entities: [source, base('engagement-2', 'cause', 'real', 'event', [source.id])],
      extensions: { engagements: { items: [
        good,
        { name: 'Pilot', period: 'FY27', customer: 'Contoso', customerId: source.id, sourceIds: [source.id, 'missing'] },
        { id: good.id, name: 'Duplicate id', status: 'Delivered', sourceIds: [source.id] },
        { id: 'engagement-no-source', name: 'Unsupported', status: 'Delivered', sourceIds: ['missing'] },
        { id: 'engagement-no-context', name: 'Only a name', sourceIds: [source.id] },
        { id: 'engagement-no-name', status: 'Delivered', sourceIds: [source.id] },
      ] } },
    };
    expect(verifyPack(raw).ok).toBe(false);
    const kept = applyFix(raw, { sections: { extensions: { engagements: null } } }, new Set());
    const fixed = applyFix(kept, { sections: { extensions: { engagements: { items: [] } } } }, new Set());
    expect(fixed.extensions).toEqual(raw.extensions);
    const result = pruneInvalid(fixed, NOW);
    expect(result.verify.ok).toBe(true);
    const ext = EngagementsExtension.parse((result.pack.extensions as Record<string, unknown>).engagements);
    expect(ext.items).toEqual([good, { id: 'engagement-3', name: 'Pilot', period: 'FY27', customer: 'Contoso', sourceIds: [source.id] }, { id: 'engagement-good-2', name: 'Duplicate id', status: 'Delivered', sourceIds: [source.id] }]);
    // A different piece of work that reuses an id keeps its content under a free id; only an exact copy is dropped.
    expect(result.removed.map((p) => p.path)).toEqual(expect.arrayContaining([
      'extensions.engagements.items[1].customerId',
      'extensions.engagements.items[3]', 'extensions.engagements.items[4]', 'extensions.engagements.items[5]',
    ]));
    expect(readiness(result.pack).find((r) => r.key === 'engagements')).toMatchObject({ have: 3, need: 1, met: true });
    const correction = { ...good, outcome: 'Follow-up agreed' };
    const corrected = applyFix(result.pack, { sections: { extensions: { engagements: { items: [correction] } } } }, new Set());
    expect(EngagementsExtension.parse((corrected.extensions as Record<string, unknown>).engagements).items).toEqual([correction, ext.items[1], ext.items[2]]);
  });

  it.each(['ja', 'en'] as const)('D-16: one generation action retains all eight readiness items through fixes (%s)', async (lang) => {
    const src = ['source-workiq-engagements'];
    const a = {
      ...stageA,
      entities: [
        base('site-office', 'site', 'real', 'site', src, { role: 'office', city: 'Tokyo', country: 'Japan', capacityTPerMonth: 0, lat: 35.68, lon: 139.76 }),
        base('person-lead', 'person', 'real', 'person', src, { role: lt('Lead'), siteId: 'site-office' }),
        base('person-owner', 'person', 'real', 'person', src, { role: lt('Owner'), siteId: 'site-office' }),
        base('customer-test', 'customer', 'real', 'organization', src, { industry: lt('Retail'), regionId: 'region-kanto' }),
      ],
      extensions: {
        workflow: { stages: [
          { id: 'in', name: 'Intake', next: ['prepare'], sourceIds: src },
          { id: 'prepare', name: 'Prepare', next: ['deliver'], sourceIds: src },
          { id: 'deliver', name: 'Deliver', handoffTo: ['Account team'], sourceIds: src },
        ] },
        dataCatalog: { items: [{ name: 'Pipeline' }, { name: 'Feedback' }, { name: 'Events' }] },
      },
    };
    const b = {
      entities: [base('issue-test', 'issue', 'real', 'event', src, { impact: 4, feasibility: 3, causeIds: [], kpiIds: [] })],
      extensions: {
        okr: { kpis: [{ id: 'okr-nsat', name: 'NSAT', sourceIds: src }, { id: 'okr-reach', name: 'Reach', sourceIds: src }] },
        engagements: { items: [
          { name: 'Workshop', type: 'workshop', status: 'Delivered', customerId: 'customer-test', sourceIds: src },
          { id: 'broken', status: 'Delivered', sourceIds: src },
        ] },
      },
    };
    const d = deps([], {
      complete: async (prompt, _signal, stage) => {
        d.prompts.push(prompt);
        return { text: JSON.stringify(stage === 'analysis' ? analysisAnswer() : stage.startsWith('foundation') ? a : stage.startsWith('business') ? b : { sections: { extensions: { engagements: null } } }), costJpy: 1, inputTokens: 100, outputTokens: 100 };
      },
      fetchWorkIq: async () => REQUIREMENTS.map((r) => ({
        key: r.key, question: r.key, answer: 'Workshop delivered; customer and workflow documented.',
        sensitivity: null, fetchedAt: NOW.toISOString(), citations: [{ title: r.key, url: `https://example.com/${r.key}` }], searches: r.ladder[lang],
      })),
    });
    const result = await generatePack(input({ lang, useWorkIq: true, useNews: false, officialUrl: '', materials: [] }), d, () => {}, new AbortController().signal);
    expect(result.report.readiness).toHaveLength(8);
    expect(result.report.readiness!.every((r) => r.met)).toBe(true);
    expect(result.verify.ok).toBe(true);
    expect(result.report.ungrounded).toEqual([]);
    const ext = EngagementsExtension.parse((result.pack.extensions as Record<string, unknown>).engagements);
    expect(ext.items).toHaveLength(1);
    expect(ext.items[0]).toMatchObject({ name: 'Workshop', status: 'Delivered', sourceIds: src });
    expect(ext.items[0]).not.toHaveProperty('progress');
    expect(ext.items[0]).not.toHaveProperty('valueJpy');
    expect(d.prompts[1]).toContain('"engagements":{"items":[...]}');
    expect(d.prompts[1]).toContain(lang === 'ja' ? '金額・進捗・日付を補わない' : 'Never fill in amounts, progress or dates');
  });

  it('D-15: an item the model built without a required fact sends that fact to Work IQ, and the stage is not "satisfied" by items that would be pruned', async () => {
    const queries: WorkIqQuery[] = [];
    const fetchedAt = '2026-11-10T02:59:45.000Z';
    const src = ['source-workiq-engagements'];
    const ans = (key: string) => ({ key, question: `Q-${key}`, answer: `${key} の事実`, sensitivity: null, fetchedAt, citations: [{ title: key, url: `https://t.example/${key}` }], searches: [] });
    const b1 = {
      entities: [
        base('issue-reach', 'issue', 'real', 'event', src, { impact: 4, feasibility: 3, causeIds: [], kpiIds: [] }),
        base('solution-hub', 'solution', 'real', 'operation', src, { name: lt('Hub の拡大'), issueIds: ['issue-reach'], kpiIds: [], msProducts: [] }),
        base('initiative-hub', 'initiative', 'real', 'operation', src, { name: lt('Hub 拡大の実行'), solutionId: 'solution-hub', start: '2026-12-01', end: '2027-03-31', dependsOn: [], ownerId: 'person-ceo' }),
      ],
    };
    const d = deps([], {
      complete: async (prompt, _signal, stage) => {
        d.prompts.push(prompt);
        const answer = stage === 'analysis' ? analysisAnswer()
          : stage.startsWith('foundation') ? { ...stageA, entities: stageA.entities.map((e) => ({ ...e, sourceIds: src })) }
            : stage.startsWith('business') ? b1 : { replace: [] };
        return { text: JSON.stringify(answer), inputTokens: 1000, outputTokens: 500 };
      },
      fetchWorkIq: async (q) => {
        queries.push(q);
        return q.expand ? REQUIREMENTS.map((r) => ans(r.key)) : [];
      },
    });
    const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true, workIqRounds: 1 }), d, () => {}, new AbortController().signal);

    const asked = queries.filter((q) => !q.expand).flatMap((q) => q.topics ?? []);
    expect(asked).toEqual(expect.arrayContaining(['Hub 拡大の実行: 進捗率（%）', 'Hub の拡大: 費用（円）・年間の効果額（円）']));
    expect(r.report.collectionRounds!.find((x) => x.stage === 'b')!.unmet).toContain('engagements');
    expect(r.report.stopReasons!.b).not.toBe('satisfied');
    expect(fieldTopics(b1, [], ['engagements'], 'ja')).toEqual([]);
  });

  it('D-15: every prompt fits the relay character limit and the app\'s token estimate; material is shortened only when needed', async () => {
    const fetchedAt = '2026-11-10T02:59:45.000Z';
    for (const filler of ['x', '経']) {
      const big = REQUIREMENTS.map((r) => ({ key: r.key, question: 'Q', answer: filler.repeat(30_000), sensitivity: null, fetchedAt, citations: [{ title: r.key, url: `https://t.example/${r.key}` }], searches: [] }));
      const d = deps([stageA, stageB, { replace: [] }], { fetchWorkIq: async (q) => (q.expand ? big : []) });
      const r = await generatePack(input({ officialUrl: '', useNews: false, useWorkIq: true, workIqRounds: 1 }), d, () => {}, new AbortController().signal);
      for (const prompt of d.prompts) {
        expect(prompt.length).toBeLessThanOrEqual(PACK_BUILD_MAX_PROMPT_CHARS);
        expect(estimateTokens(prompt)).toBeLessThanOrEqual(PER_USE_LIMITS.packBuild!.maxInputTokens!);
      }
      expect(r.report.calls[0]!.trimmedChars).toBeGreaterThan(0);
    }
    const small = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }]);
    const r = await generatePack(input(), small, () => {}, new AbortController().signal);
    expect(r.report.calls.every((c) => c.trimmedChars === undefined)).toBe(true);
  });

  it('D-15: a failed or unreadable model answer is asked again (twice per run at most); a refusal by the app\'s own gate is not', async () => {
    let n = 0;
    const flaky = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }]);
    const answer = flaky.complete;
    flaky.complete = async (prompt, signal, stage) => {
      n++;
      if (n === 1) throw new Error('relay 502');
      if (n === 2) return { text: 'すみません', inputTokens: 1, outputTokens: 1 };
      return answer(prompt, signal, stage);
    };
    const r = await generatePack(input(), flaky, () => {}, new AbortController().signal);
    expect(r.report.calls[0]).toMatchObject({ stage: 'foundation', retried: true });
    expect(r.report.calls[1]).toMatchObject({ stage: 'foundation', retried: true });
    expect(verifyPack(r.pack).ok).toBe(true);

    let blockedCalls = 0;
    const blocked = deps([stageA], { complete: async () => { blockedCalls++; throw Object.assign(new Error('blocked: dailyLimit'), { reasons: ['dailyLimit'] }); } });
    await expect(generatePack(input(), blocked, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'callFailed' });
    expect(blockedCalls).toBe(1);
  });

  it('waits for the provider retry delay before retrying a throttled stage', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const d = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }]);
      const answer = d.complete;
      d.complete = async (...args) => {
        if (++n === 1) throw new AiLiveError(['liveFailed'], 'relay 502 providerBusy', undefined, new RelayError(502, 'providerBusy', 20_000));
        return answer(...args);
      };
      const pending = generatePack(input(), d, () => {}, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.report.calls[0]).toMatchObject({ stage: 'foundation', retried: true });
      expect(verifyPack(result.pack).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a long provider wait rather than retrying early, and permits cancellation while waiting', async () => {
    let n = 0;
    const long = deps([stageA], { complete: async () => {
      n++;
      throw new AiLiveError(['liveFailed'], 'relay 502 providerBusy', undefined, new RelayError(502, 'providerBusy', 120_000));
    } });
    await expect(generatePack(input(), long, () => {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'callFailed', providerBusy: true, retryAfterMs: 120_000 });
    expect(n).toBe(1);

    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = deps([stageA], { complete: async () => {
        throw new RelayError(502, 'providerBusy', 30_000);
      } });
      const pending = generatePack(input(), waiting, () => {}, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off twice when a busy provider supplies no delay, then reports the failure', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const d = deps([stageA], { retryDelayMs: undefined, complete: async () => {
        n++;
        throw new RelayError(502, 'providerBusy');
      } });
      const pending = generatePack(input(), d, () => {}, new AbortController().signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'callFailed', providerBusy: true });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(n).toBe(2);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(n).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(n).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FR-311: the collect step moves only when a read ends, Work IQ weighs most, and the bar follows the measured shares', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: ProgressEvent[] = [];
    const d = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], {
      fetchWorkIq: async (q) => { if (q.expand) await gate; return []; },
    });
    const run = generatePack(input({ useWorkIq: true }), d, (e) => events.push(e), new AbortController().signal);
    await vi.waitFor(() => expect(events.at(-1)?.sources).toEqual({ site: 'done', news: 'done', workiq: 'running' }));
    const spans = stepSpans({ useWorkIq: true });
    const [a, b] = spans.collect;
    expect(events[0]).toMatchObject({ step: 'collect', status: 'running', ratio: 0, sources: { site: 'running', news: 'running', workiq: 'running' } });
    // While Work IQ is still out, only the site and news reads (2 of 10 weight) have moved the bar.
    expect(Math.max(...events.map((e) => e.ratio))).toBeCloseTo(a + (b - a) * 0.2);
    release();
    await run;
    expect(events.find((e) => e.step === 'collect' && e.status === 'done')).toMatchObject({ ratio: b, sources: { workiq: 'done' } });
    expect(events.map((e) => e.ratio)).toEqual([...events.map((e) => e.ratio)].sort((x, y) => x - y));

    // logs/workiq-bench: collecting with Work IQ took 18〜53% of a run; without it the public reads take seconds.
    expect(b - a).toBeGreaterThanOrEqual(0.35);
    expect(stepSpans({ useWorkIq: false }).collect[1]).toBeLessThan(0.1);
    expect(spans.finalize[1]).toBe(1);
  });

  it('D-14: a Work IQ failure is recorded and the run continues; without the opt-in Work IQ is never asked', async () => {
    let asked = 0;
    const failEvents: ProgressEvent[] = [];
    const failing = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], {
      fetchWorkIq: async () => { asked++; throw Object.assign(new Error('relay 401'), { code: 'notSignedIn' }); },
    });
    const r = await generatePack(input({ useWorkIq: true }), failing, (e) => failEvents.push(e), new AbortController().signal);
    expect(failEvents.find((e) => e.step === 'collect' && e.status === 'done')?.sources).toEqual({ site: 'done', news: 'done', workiq: 'failed' });
    expect(r.report.retrievalErrors).toContainEqual({ what: 'workiq', error: 'notSignedIn' });
    expect(r.report.retrieved.some((x) => x.kind === 'workiq')).toBe(false);
    expect(r.report.stopReasons).toEqual({ a: 'workIqUnavailable', b: 'workIqUnavailable' });
    expect(verifyPack(r.pack).ok).toBe(true);

    const off = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], { fetchWorkIq: async () => { asked++; throw new Error('must not be asked'); } });
    await generatePack(input({ useWorkIq: false }), off, () => {}, new AbortController().signal);
    expect(asked).toBe(1);
  });

  it('records a Foundry model limit for the user without retrying the same oversized search', async () => {
    let asked = 0;
    const failing = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], {
      fetchWorkIq: async () => { asked++; throw new RelayError(502, 'workiqModelLimit'); },
    });
    const r = await generatePack(input({ useWorkIq: true }), failing, () => {}, new AbortController().signal);
    expect(r.report.retrievalErrors).toContainEqual({ what: 'workiq', error: 'workiqModelLimit' });
    expect(asked).toBe(1);
  });

  it('D-14: a transient fan-out failure is tried again with a fresh process, the purpose section is labelled, and rounds still run when both tries fail', async () => {
    const queries: WorkIqQuery[] = [];
    let fails = 1;
    const purposeSection = { key: 'purpose', question: 'q', answer: 'Hubらじお 視聴者 12 名（2026年10月）', citations: [{ title: 'Viva Engage', url: 'https://engage.cloud.microsoft/x' }], sensitivity: null, fetchedAt: NOW.toISOString() };
    const flaky = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], {
      fetchWorkIq: async (q) => {
        queries.push(q);
        if (q.expand && fails-- > 0) throw Object.assign(new Error('relay 503'), { code: 'workiqUnavailable' });
        return q.expand ? [purposeSection] : [];
      },
    });
    const r = await generatePack(input({ useWorkIq: true }), flaky, () => {}, new AbortController().signal);
    expect(queries.filter((q) => q.expand)).toHaveLength(2);
    expect(r.report.retrievalErrors).toContainEqual({ what: 'workiq', error: 'workiqUnavailable' });
    expect(r.report.retrieved.some((x) => x.kind === 'workiq')).toBe(true);
    expect(flaky.prompts.some((p) => p.includes('Project の目的に関する社内情報'))).toBe(true);

    queries.length = 0;
    const down = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], {
      fetchWorkIq: async (q) => { queries.push(q); if (q.expand) throw Object.assign(new Error('relay 503'), { code: 'workiqUnavailable' }); return []; },
    });
    const r2 = await generatePack(input({ useWorkIq: true }), down, () => {}, new AbortController().signal);
    expect(r2.report.retrievalErrors).toEqual(expect.arrayContaining([{ what: 'workiq', error: 'workiqUnavailable' }, { what: 'workiq', error: 'retry-1: workiqUnavailable' }]));
    // Work IQ may be back for the follow-up searches: they are still asked.
    expect(queries.some((q) => !q.expand)).toBe(true);
    expect(Object.values(r2.report.stopReasons ?? {})).not.toContain('workIqUnavailable');
  });

  it('news searched by company name only: headlines on the purpose come first, a few others stay as background, the rest is reported', async () => {
    const titles = ['Contoso の株価が下落', '納期遅延の削減へ Contoso が新システム', 'Contoso で大規模障害', 'Contoso 社長交代', 'Contoso 決算', 'Contoso が新工場'];
    expect(newsOnPurpose(titles.map((title) => ({ title })), input()).kept.map((a) => a.title)).toEqual(['納期遅延の削減へ Contoso が新システム']);
    expect(newsOnPurpose([{ title: 'Contoso 決算' }], input({ purpose: 'x', projectName: 'y' })).dropped).toEqual([]);
    const d = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], {
      fetchNews: async () => ({ provider: 'Google News RSS', fetchedAt: NOW.toISOString(), articles: titles.map((title, i) => ({ title, url: `https://news.example/${i}`, source: '日刊', publishedAt: '2026-10-01T00:00:00Z' })) }),
    });
    const r = await generatePack(input(), d, () => {}, new AbortController().signal);
    const sent = r.report.retrieved.filter((x) => x.kind === 'news').map((x) => x.title);
    expect(sent[0]).toBe('納期遅延の削減へ Contoso が新システム');
    expect(sent).toHaveLength(4);
    expect(r.report.offPurposeNews?.map((a) => a.title)).toEqual(['Contoso 決算', 'Contoso が新工場']);
  });

  it('the official-site reader gets the purpose terms; pages read for them are labelled for the model and in the report', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const d = deps([stageA, stageB, { remove: ['initiative-bad'] }, { replace: [] }, { replace: [] }], {
      fetchSite: async (_u, _s, terms) => {
        seen.push(terms);
        return { pages: [sitePage, { ...sitePage, url: 'https://www.contoso.example/topics/delivery.html', title: '納期遅延ゼロへの取り組み', purposeTerms: ['納期遅延'] }], failed: [] };
      },
    });
    const r = await generatePack(input(), d, () => {}, new AbortController().signal);
    expect(seen[0]).toEqual(purposeTerms(input()));
    expect(r.report.retrieved.find((x) => x.sourceId === 'source-web-2')).toMatchObject({ purposeTerms: ['納期遅延'] });
    expect(r.report.retrieved.find((x) => x.sourceId === 'source-web-1')?.purposeTerms).toBeUndefined();
    expect(d.prompts[0]).toContain('Project の目的に関わる公式ページ（リンクの語: 納期遅延）');
  });

  it('fails without saving anything when the model gives no JSON, a call fails, or the user cancels', async () => {
    await expect(generatePack(input(), deps(['すみません、作れません']), () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'noAnswer' });
    const failing = deps([stageA], { complete: async () => { throw new Error('relay 503 notSignedIn'); } });
    await expect(generatePack(input(), failing, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'callFailed', detail: 'relay 503 notSignedIn' });
    const ac = new AbortController();
    const slow = deps([stageA], { complete: async () => { ac.abort(); throw new Error('aborted'); } });
    await expect(generatePack(input(), slow, () => {}, ac.signal)).rejects.toBeInstanceOf(PackGenError);
    await expect(generatePack(input(), slow, () => {}, ac.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a fix answer cannot replace app-made sources or the collection report', () => {
    const pack = { entities: [base('source-web-1', 'source', 'digital', 'data', []), base('cause-a', 'cause', 'real', 'event', [])], extensions: { glossary: [] } };
    const next = applyFix(pack, {
      replace: [{ ...base('source-web-1', 'source', 'digital', 'data', []), url: 'https://evil.example' }],
      remove: ['source-web-1', 'cause-a'],
      sections: { extensions: { collection: { x: 1 }, glossary: null }, entities: [] },
    }, new Set(['source-web-1']));
    expect((next.entities as { id: string; url?: string }[])).toEqual([expect.objectContaining({ id: 'source-web-1' })]);
    expect((next.entities as { url?: string }[])[0]!.url).toBeUndefined();
    expect(next.extensions).toEqual({});
  });

  it('prune removes an entity whose required reference is gone, and drops only an optional reference that points nowhere', () => {
    const pack = {
      packId: 'p', company: { name: lt('c'), industry: lt('i') }, isSample: false, regions: [], flows: [],
      entities: [
        base('source-doc-1', 'source', 'digital', 'data', [], { publisher: lt('c') }),
        base('person-a', 'person', 'real', 'person', ['source-doc-1'], { role: lt('r'), siteId: 'site-missing' }),
        base('kpi-a', 'kpi', 'digital', 'metric', ['source-doc-1'], { unit: lt('%'), baseline: 1, current: 2, target: 3, direction: 'increase', scale: 'ratio', period: lt('y'), ownerId: 'person-a' }),
        base('init-a', 'initiative', 'real', 'event', ['source-doc-1'], { solutionId: 'solution-missing', start: '2026-01-01', end: '2026-06-30', progress: 0.2, ownerId: 'person-a' }),
        base('cause-a', 'cause', 'real', 'event', ['source-doc-1']),
      ],
    };
    const r = pruneInvalid(pack, NOW);
    expect(r.verify.ok).toBe(true);
    expect((r.pack.entities as { id: string; siteId?: string }[]).map((e) => e.id)).toEqual(['source-doc-1', 'person-a', 'kpi-a', 'cause-a']);
    expect((r.pack.entities as { id: string; siteId?: string }[])[1]!.siteId).toBeUndefined();
    expect(r.removed.map((x) => x.path).sort()).toEqual(['entities.init-a', 'entities.person-a.siteId']);
  });

  it('prune keeps the first of two entities sharing an id and removes only the repeat', () => {
    const pack = {
      packId: 'p', company: { name: lt('c'), industry: lt('i') }, isSample: false, regions: [], flows: [],
      entities: [
        base('source-doc-1', 'source', 'digital', 'data', [], { publisher: lt('c') }),
        base('cause-a', 'cause', 'real', 'event', ['source-doc-1'], { name: lt('first') }),
        base('cause-a', 'cause', 'real', 'event', ['source-doc-1'], { name: lt('second') }),
      ],
    };
    const r = pruneInvalid(pack, NOW);
    expect(r.verify.ok).toBe(true);
    const kept = (r.pack.entities as { id: string; name?: { ja: string } }[]).filter((e) => e.id === 'cause-a');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.name?.ja).toBe('first');
  });

  it('a missing link list means no known link: the issue and solution stay (no KPI was stated)', () => {
    const pack = {
      packId: 'p', company: { name: lt('c'), industry: lt('i') }, isSample: false, regions: [], flows: [],
      entities: [
        base('source-doc-1', 'source', 'digital', 'data', [], { publisher: lt('c') }),
        base('issue-a', 'issue', 'real', 'event', ['source-doc-1'], { impact: 3, feasibility: 3 }),
        base('solution-a', 'solution', 'real', 'operation', ['source-doc-1'], { issueIds: ['issue-a'] }),
      ],
    };
    const r = pruneInvalid(repairExtensions(pack), NOW);
    expect(r.verify.ok).toBe(true);
    expect((r.pack.entities as { id: string }[]).map((e) => e.id)).toEqual(['source-doc-1', 'issue-a', 'solution-a']);
  });

  it('reads numbers in Japanese and English notation', () => {
    expect(numbersIn('売上 3.5億円、従業員 1,200 名、12万トン')).toEqual(expect.arrayContaining([350_000_000, 1200, 120_000]));
    expect(numbersIn('revenue 2.4B')).toEqual(expect.arrayContaining([2_400_000_000]));
  });
});

describe('official-site reader guards (server/site.ts)', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const html = (body: string, extra = '') => `<html><head><title>Contoso</title><meta name="description" content="部品 &amp; 装置"><meta name="theme-color" content="#0f6cbd">${extra}</head><body><nav>menu</nav><script>evil()</script>${body}</body></html>`;
  const page = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

  it('accepts https on 443 only, never credentials, IP literals or other ports', () => {
    expect(parseSiteUrl('contoso.example').toString()).toBe('https://contoso.example/');
    for (const bad of ['http://contoso.example', 'https://user:pw@contoso.example', 'https://10.0.0.1/', 'https://contoso.example:8443/', 'file:///etc/passwd', 'https://localhost/']) {
      expect(() => parseSiteUrl(bad), bad).toThrow(SiteError);
    }
  });

  it('classifies private, loopback, link-local and mapped addresses as not public', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });

  it('refuses a host resolving to a private address before any request', async () => {
    let fetched = 0;
    await expect(fetchSitePages('https://intranet.contoso.example', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
      fetch: (async () => { fetched++; return page(''); }) as typeof fetch,
    })).rejects.toMatchObject({ code: 'privateAddress' });
    expect(fetched).toBe(0);
  });

  it('follows same-site redirects only and reads linked company pages', async () => {
    const urls: string[] = [];
    const doFetch = (async (u: URL | string) => {
      const url = String(u);
      urls.push(url);
      if (url === 'https://contoso.example/') return new Response(null, { status: 301, headers: { location: 'https://www.contoso.example/' } });
      if (url === 'https://www.contoso.example/') return page(html('<p>トップ</p><a href="/company/">会社概要</a><a href="https://other.example/about">外部</a><a href="/ir/report.pdf">PDF</a><a href="/news/">ニュース</a>'));
      if (url === 'https://www.contoso.example/company/') return page(html('<h1>会社概要</h1><p>資本金 3.5億円</p>'));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await fetchSitePages('https://contoso.example', { fetch: doFetch, lookup: publicLookup, now: () => NOW.getTime() });
    expect(r.pages.map((p) => p.url)).toEqual(['https://www.contoso.example/', 'https://www.contoso.example/company/']);
    expect(r.pages[0]).toMatchObject({ title: 'Contoso', description: '部品 & 装置', themeColor: '#0F6CBD' });
    expect(r.pages[0]!.text).not.toContain('evil');
    expect(r.pages[0]!.text).not.toContain('menu');
    expect(r.pages[1]!.text).toContain('資本金 3.5億円');
    expect(urls.some((u) => u.includes('other.example') || u.endsWith('.pdf') || u.includes('/news/'))).toBe(false);

    const offSite = (async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } })) as unknown as typeof fetch;
    await expect(fetchSitePages('https://contoso.example', { fetch: offSite, lookup: publicLookup })).rejects.toMatchObject({ code: 'redirectNotAllowed' });
    const notHtml = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(fetchSitePages('https://contoso.example', { fetch: notHtml, lookup: publicLookup })).rejects.toMatchObject({ code: 'notHtml' });
  });

  it('the entry page may move to another public host (domain change); linked pages may not leave it; private targets stay blocked', async () => {
    const lookup = async (h: string) => [{ address: h === 'internal.contoso.example' ? '10.0.0.8' : '93.184.216.34', family: 4 }];
    const moved = (async (u: URL | string) => {
      const url = String(u);
      if (url === 'https://www.contoso.co.example/') return new Response(null, { status: 302, headers: { location: 'https://www.contoso.example/ja/' } });
      if (url === 'https://www.contoso.example/ja/') return page(html('<a href="/ja/company/profile/">概要</a>'));
      if (url === 'https://www.contoso.example/ja/company/profile/') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await fetchSitePages('https://www.contoso.co.example/', { fetch: moved, lookup });
    expect(r.pages.map((p) => p.url)).toEqual(['https://www.contoso.example/ja/']);
    expect(r.failed[0]).toEqual({ url: 'https://www.contoso.example/ja/company/profile/', error: 'redirectNotAllowed' });
    const toInternal = (async () => new Response(null, { status: 302, headers: { location: 'https://internal.contoso.example/' } })) as unknown as typeof fetch;
    await expect(fetchSitePages('https://www.contoso.co.example/', { fetch: toInternal, lookup })).rejects.toMatchObject({ code: 'privateAddress' });
    await expect(fetchSitePages('https://www.contoso.co.example/', { fetch: moved, lookup, outboundHosts: ['www.contoso.co.example'] })).rejects.toMatchObject({ code: 'outboundNotAllowed' });
  });

  it('ranks profile and IR pages first, tries well-known paths when the menu is not in the HTML, and drops tracking parameters', async () => {
    expect(factLinks('<a href="/sustainability/?padid=1">s</a><a href="/ir/">ir</a><a href="/company/profile/?utm_source=x">p</a><a href="/brand-guidelines/">b</a>', new URL('https://contoso.example/'), 5))
      .toEqual(['https://contoso.example/brand-guidelines/', 'https://contoso.example/company/profile/', 'https://contoso.example/ir/', 'https://contoso.example/sustainability/']);
    const urls: string[] = [];
    const jsMenu = (async (u: URL | string) => {
      urls.push(String(u));
      if (String(u) === 'https://contoso.example/jp/') return page(html('<div id="menu"></div>'));
      if (String(u) === 'https://contoso.example/jp/company/profile/') return page(html('<p>本社 東京都</p>'));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await fetchSitePages('https://contoso.example/jp/', { fetch: jsMenu, lookup: publicLookup });
    expect(r.pages.map((p) => p.url)).toEqual(['https://contoso.example/jp/', 'https://contoso.example/jp/company/profile/']);
    expect(urls.length).toBeLessThanOrEqual(1 + 10);
  });

  it('reads detail pages found on hubs, sites before officers, and spreads the pages over sections', async () => {
    const site: Record<string, string> = {
      'https://contoso.example/': '<a href="/company/">c</a><a href="/sustainability/">s</a>',
      'https://contoso.example/company/': '<a href="/company/facilities/">f</a><a href="/company/executives/a.html">a</a><a href="/company/executives/b.html">b</a><a href="/company/executives/c.html">c</a>',
      'https://contoso.example/company/facilities/': '<p>本社 東京 工場 名古屋</p>',
    };
    const doFetch = (async (u: URL | string) => (site[String(u)] !== undefined ? page(html(site[String(u)]!)) : page(html('<p>x</p>')))) as typeof fetch;
    const r = await fetchSitePages('https://contoso.example/', { fetch: doFetch, lookup: publicLookup });
    const read = r.pages.map((p) => p.url);
    expect(read.indexOf('https://contoso.example/company/facilities/')).toBeGreaterThan(0);
    expect(read.indexOf('https://contoso.example/company/facilities/')).toBeLessThan(read.findIndex((u) => u.includes('/executives/')) >>> 0);
    expect(read.filter((u) => u.includes('/executives/')).length).toBeLessThanOrEqual(2);
    expect(read).toHaveLength(6);
  });

  it('extracts text and fact links deterministically', () => {
    expect(htmlToText('<title>A &amp; B</title><style>x{}</style><p>こんにちは&#x3002;</p>')).toMatchObject({ title: 'A & B', text: 'こんにちは。' });
    expect(factLinks('<a href="/about">a</a><a href="/about/history/">h</a><a href="mailto:x@y">m</a>', new URL('https://contoso.example/'), 4))
      .toEqual(['https://contoso.example/about', 'https://contoso.example/about/history/']);
  });

  it('finds purpose links by anchor text, title, image alt and path words; Latin terms match whole words only', () => {
    const links = '<a href="/solutions/viva-engage/">社内SNS</a><a href="/p/1"><img alt="情報共有の事例"></a><a href="/p/2" title="Hub ラジオ">x</a><a href="/mail/">メール</a><a href="/company/">会社</a>';
    expect(purposeLinks(links, new URL('https://contoso.example/'), ['Viva', 'engage', '情報共有', 'hub', 'ai'], 10))
      .toEqual(['https://contoso.example/solutions/viva-engage/', 'https://contoso.example/p/1', 'https://contoso.example/p/2']);
  });

  it('reads up to SITE_PURPOSE_PAGES purpose pages within the same 6-page cap; without terms the reading is unchanged', async () => {
    const top = '<a href="/company/">c</a><a href="/company/profile/">p</a><a href="/ir/">i</a><a href="/business/">b</a><a href="/sustainability/">s</a><a href="/history/">h</a>'
      + '<a href="/topics/2026/dx.html">社内情報共有と Viva Engage の活用</a><a href="/topics/2026/hub.html">Hubらじお 配信開始</a><a href="/topics/2026/other.html">情報共有</a>';
    const doFetch = (async (u: URL | string) => page(html(String(u) === 'https://contoso.example/' ? top : '<p>x</p>'))) as typeof fetch;
    const plain = await fetchSitePages('https://contoso.example/', { fetch: doFetch, lookup: publicLookup });
    expect(plain.pages.some((p) => p.url.includes('/topics/'))).toBe(false);

    const r = await fetchSitePages('https://contoso.example/', { fetch: doFetch, lookup: publicLookup }, ['Viva', 'engage', '情報共有', 'Hubらじお']);
    expect(r.pages).toHaveLength(SITE_MAX_PAGES);
    const onPurpose = r.pages.filter((p) => p.purposeTerms);
    expect(onPurpose).toHaveLength(SITE_PURPOSE_PAGES);
    expect(onPurpose[0]).toMatchObject({ url: 'https://contoso.example/topics/2026/dx.html', purposeTerms: ['viva', 'engage', '情報共有'] });
    expect(onPurpose[1]!.url).toBe('https://contoso.example/topics/2026/hub.html');
    expect(r.pages.filter((p) => !p.purposeTerms).length).toBe(SITE_MAX_PAGES - SITE_PURPOSE_PAGES);
    expect(r.pages.some((p) => p.url.endsWith('/company/profile/'))).toBe(true);
  });
});

describe('GitHub Copilot adapter (server/copilot.ts)', () => {
  function fakeSdk(opts: { signedIn?: boolean; answer?: string; usage?: Record<string, unknown>[]; hang?: boolean } = {}) {
    const created: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    let aborted = 0;
    class Client {
      constructor(public options: Record<string, unknown>) {}
      async start() {}
      async stop() { return []; }
      async getAuthStatus() { return { isAuthenticated: opts.signedIn ?? true, login: 'octocat' }; }
      async listModels() { return [{ id: 'gpt-5', name: 'GPT-5', billing: { multiplier: 1 } }, { id: 'claude-opus', name: 'Opus', billing: { multiplier: 10 } }]; }
      async createSession(config: Record<string, unknown>): Promise<SdkSession> {
        created.push(config);
        const handlers: ((e: { data: Record<string, unknown> }) => void)[] = [];
        return {
          sessionId: `s${created.length}`,
          on: (_t, h) => { handlers.push(h); return () => {}; },
          sendAndWait: async () => {
            if (opts.hang) await new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 10ms')), 10));
            for (const u of opts.usage ?? []) handlers.forEach((h) => h({ data: u }));
            return { data: { content: opts.answer ?? '{"ok":true}' } };
          },
          abort: async () => { aborted++; },
          disconnect: async () => {},
        };
      }
      async deleteSession(id: string) { deleted.push(id); }
      rpc = { mcp: { discover: async () => ({ servers: [{ name: 'workiq', source: 'user' }, { name: 'azure', source: 'plugin' }] }) } };
    }
    return { sdk: { CopilotClient: Client } as unknown as CopilotSdk, created, deleted, get aborted() { return aborted; } };
  }

  it('reports sign-in and models', async () => {
    const f = fakeSdk();
    expect(await new CopilotService(async () => f.sdk).status()).toEqual({
      available: true, authenticated: true, login: 'octocat', models: [{ id: 'gpt-5', name: 'GPT-5', multiplier: 1 }, { id: 'claude-opus', name: 'Opus', multiplier: 10 }],
    });
    expect(await new CopilotService(async () => { throw new Error('no module'); }).status()).toMatchObject({ available: false, error: 'sdkUnavailable' });
    expect(await new CopilotService(async () => fakeSdk({ signedIn: false }).sdk).status()).toMatchObject({ authenticated: false, error: 'notSignedIn' });
  });

  it('runs a tool-less session with the given system prompt, returns the reported tokens and deletes the session', async () => {
    const f = fakeSdk({ usage: [{ inputTokens: 100, outputTokens: 50, cost: 10 }] });
    const r = await new CopilotService(async () => f.sdk).complete({ model: 'claude-opus', system: 'SYS', prompt: 'P', timeoutMs: 1000 });
    expect(r).toEqual({ text: '{"ok":true}', inputTokens: 100, outputTokens: 50 });
    expect(f.created[0]).toMatchObject({ model: 'claude-opus', availableTools: [], systemMessage: { mode: 'replace', content: 'SYS' }, enableSessionStore: false });
    // The user's Copilot MCP servers and plugins (e.g. a Work IQ plugin) and the built-in GitHub one are not started.
    expect(f.created[0]!.disabledMcpServers).toEqual(['workiq', 'azure', 'github-mcp-server']);
    const permission = (f.created[0]!.onPermissionRequest as () => { kind: string })();
    expect(permission.kind).toBe('reject');
    expect(f.deleted).toEqual(['s1']);
  });

  it('sums SDK usage events and distinguishes absent or incomplete usage from zero', async () => {
    const complete = async (usage: Record<string, unknown>[]) => new CopilotService(async () => fakeSdk({ usage }).sdk)
      .complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000 });
    expect(await complete([{ inputTokens: 100, outputTokens: 50 }, { inputTokens: 20, outputTokens: 0 }]))
      .toMatchObject({ inputTokens: 120, outputTokens: 50 });
    expect(await complete([])).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(await complete([{ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3 }]))
      .toMatchObject({ inputTokens: null, outputTokens: null });
    expect(await complete([{ inputTokens: 0, outputTokens: 0 }])).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('maps failures', async () => {
    await expect(new CopilotService(async () => fakeSdk({ signedIn: false }).sdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000 }))
      .rejects.toEqual(new CopilotError('notSignedIn'));
    await expect(new CopilotService(async () => fakeSdk().sdk).complete({ model: 'nope', system: 'S', prompt: 'P', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'unknownModel' });
    const slow = fakeSdk({ hang: true });
    await expect(new CopilotService(async () => slow.sdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    expect(slow.aborted).toBe(1);
    expect(slow.deleted).toEqual(['s1']);
    await expect(new CopilotService(async () => fakeSdk({ answer: ' ' }).sdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'emptyAnswer' });
  });

  it('D-44: passes the output cap (never above the model\'s own) and the reasoning effort only where the model supports it', async () => {
    const reasoning = { capabilities: { supports: { reasoningEffort: true }, limits: { max_output_tokens: 16_000 } }, supportedReasoningEfforts: ['low', 'medium', 'high'] };
    expect(sessionLimits(reasoning, { maxOutputTokens: 32_000, reasoningEffort: 'medium' }))
      .toEqual({ reasoningEffort: 'medium', modelCapabilities: { limits: { max_output_tokens: 16_000 } } });
    expect(sessionLimits({ ...reasoning, supportedReasoningEfforts: ['high'] }, { maxOutputTokens: 8000, reasoningEffort: 'medium' }))
      .toEqual({ modelCapabilities: { limits: { max_output_tokens: 8000 } } });
    expect(sessionLimits({ capabilities: { supports: { reasoningEffort: false } } }, { maxOutputTokens: 8000, reasoningEffort: 'medium' }))
      .toEqual({ modelCapabilities: { limits: { max_output_tokens: 8000 } } });
    expect(sessionLimits(undefined, {})).toEqual({});
    const f = fakeSdk();
    await new CopilotService(async () => f.sdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000, maxOutputTokens: 4000, reasoningEffort: 'medium' });
    expect(f.created[0]).toMatchObject({ modelCapabilities: { limits: { max_output_tokens: 4000 } } });
    expect(f.created[0]).not.toHaveProperty('reasoningEffort');
  });
});

describe('D-12 review fixes', () => {
  const NOW2 = new Date('2026-11-10T03:00:00Z');
  const l = (s: string) => ({ ja: s, en: s });
  const ent = (id: string, kind: string, world: string, type: string, sourceIds: string[], extra: Record<string, unknown> = {}) => ({
    id, kind, name: l(id), description: l(id), world, type, classification: 'shareable', author: 'ai', sourceIds, ...extra,
  });
  const shell = (entities: unknown[]) => ({ packId: 'p', company: { name: l('c'), industry: l('i') }, isSample: false, regions: [], flows: [], entities });

  it('prune removes every bad reference of one list at once and keeps the valid ones (no index shift)', () => {
    const src = ent('source-web-1', 'source', 'digital', 'data', [], { publisher: l('p') });
    for (const order of [['source-web-1', 'x', 'y'], ['x', 'y', 'source-web-1'], ['x', 'source-web-1', 'y']]) {
      const r = pruneInvalid(shell([src, ent('cause-a', 'cause', 'real', 'event', order)]), NOW2);
      expect(r.verify.ok, order.join(',')).toBe(true);
      expect((r.pack.entities as { id: string; sourceIds: string[] }[]).find((e) => e.id === 'cause-a')?.sourceIds).toEqual(['source-web-1']);
    }
  });

  it('Copilot: a cancel while the session is being created sends nothing', async () => {
    const ac = new AbortController();
    let sent = 0;
    let deleted = 0;
    class Client {
      async start() {}
      async stop() { return []; }
      async getAuthStatus() { return { isAuthenticated: true }; }
      async listModels() { return [{ id: 'gpt-5', name: 'GPT-5' }]; }
      async createSession(): Promise<SdkSession> {
        ac.abort();
        return { sessionId: 's1', on: () => () => {}, sendAndWait: async () => { sent++; return { data: { content: '{}' } }; }, abort: async () => {}, disconnect: async () => {} };
      }
      async deleteSession() { deleted++; }
    }
    await expect(new CopilotService(async () => ({ CopilotClient: Client }) as unknown as CopilotSdk).complete({ model: 'gpt-5', system: 'S', prompt: 'P', timeoutMs: 1000, signal: ac.signal }))
      .rejects.toMatchObject({ code: 'aborted' });
    expect(sent).toBe(0);
    expect(deleted).toBe(1);
  });

  it('site: links to other ports or with credentials are never followed; Shift_JIS pages are decoded', async () => {
    expect(factLinks('<a href="https://contoso.example:8443/company/">p</a><a href="https://u:p@contoso.example/about/">c</a><a href="/ir/">ir</a>', new URL('https://contoso.example/'), 5))
      .toEqual(['https://contoso.example/ir/']);
    const sjis = new Uint8Array([0x89, 0xef, 0x8e, 0xd0, 0x8a, 0x54, 0x97, 0x76]); // 会社概要
    expect(decodeHtml(sjis, 'text/html; charset=Shift_JIS')).toBe('会社概要');
    const meta = Buffer.concat([Buffer.from('<meta charset="shift_jis"><p>'), Buffer.from(sjis)]);
    expect(decodeHtml(meta, 'text/html')).toContain('会社概要');
    expect(decodeHtml(Buffer.from('日本'), 'text/html; charset=bogus-label')).toBe('日本');
  });
});
