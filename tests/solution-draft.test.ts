import { afterEach, describe, expect, it } from 'vitest';
import { setLiveTransport, setRuntimeSettingsProvider, writeLedger } from '../src/ai/client.ts';
import { loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import { demoAnalyses } from '../src/modules/project/analysis.ts';
import { instructionFiles, instructionReady, systemBundle } from '../src/modules/project/copilotInstruction.ts';
import { AI_PROMPT_SUFFIX } from '../src/ai/promptSuffix.ts';
import { demoDiscussion } from '../src/modules/project/discussion.ts';
import { emptyDeliverables, threadOf, type AppCheckContext } from '../src/modules/project/deliverables.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { attachmentCandidates, buildSolutionDoc, hasToFill } from '../src/modules/project/solutionDocs.ts';
import {
  applySolutionDraft, checkSolutionDraft, requestLiveSolutionDraft, solutionBaseline, solutionDraftContext, solutionDraftRequest, type SolutionDraft, type SolutionDraftInput,
} from '../src/modules/project/solutionDraft.ts';
import { emptyStrategy, normalizeStrategy, setSection, setSolutionApproach, setSolutionType, type StrategyData } from '../src/modules/project/strategy.ts';
import { crc32, zipFiles } from '../src/modules/project/zipFiles.ts';

const SOLUTION = 'sol-knowledge-copilot';

function context(strategy: StrategyData = emptyStrategy()): AppCheckContext {
  const pack = loadPack(samplePack);
  return {
    pack, discussion: demoDiscussion(), kpi: demoKpis(pack.pack), analysis: demoAnalyses(pack.pack), useCases: demoUseCases(),
    deliverables: emptyDeliverables(), strategy, objectives: [], projectObjectiveIds: [], today: '2026-11-20',
  };
}

const input = (ctx: AppCheckContext): SolutionDraftInput => ({ solutionId: SOLUTION, ctx, lang: 'ja', audience: 'internal' });
type Ctx = { types: Record<string, { open: string[] }>; attachments: { id: string }[] };

/** A complete answer for the given type, as a model following the prompt would give. */
function answer(ctx: AppCheckContext, type: string, extra: Partial<SolutionDraft> = {}): SolutionDraft {
  const c = solutionDraftContext(input(ctx)) as unknown as Ctx;
  return {
    type: type as SolutionDraft['type'], reason: '添付と手順で完結するため（仮説）',
    sections: Object.fromEntries(c.types[type]!.open.map((id) => [id, `${id} の下書き（仮説）`])), ...extra,
  };
}

afterEach(() => {
  setLiveTransport(null);
  setRuntimeSettingsProvider(() => ({ liveEnabled: false, configured: false }));
  writeLedger([]);
});

describe('solution type and whole-document draft (last phase of a Project pack)', () => {
  it('drafts every open section; approval completes the prompt spec and its Microsoft 365 Copilot instructions without overwriting a person', () => {
    const ctx = context();
    const raw = answer(ctx, 'prompt', { attachmentIds: ['kpis', 'issues', 'made-up'] });
    const { draft, missing } = checkSolutionDraft(input(ctx), raw);
    expect(missing).toEqual([]);
    expect(draft?.attachmentIds).toEqual(['kpis', 'issues']);
    expect(Object.keys(draft!.sections)).toContain('copilotPrompt');

    // A person writes a section after the draft was made: approval keeps it.
    const person = setSection(ctx.strategy, SOLUTION, 'scope', '担当者が書いた範囲', { by: '担当者', at: '2026-11-20' });
    const s = ctx.pack.byId.get(SOLUTION);
    if (s?.kind !== 'solution') throw new Error('fixture');
    const ts = threadOf(ctx).solutions.find((x) => x.id === SOLUTION)!;
    const candidates = attachmentCandidates(s, ts, ctx, 'ja');
    const approved = applySolutionDraft(person, SOLUTION, draft!, candidates, { by: 'レビュー者', at: '2026-11-20' });
    expect(approved.types[SOLUTION]?.type).toBe('prompt');
    expect(approved.sections[SOLUTION]?.scope).toBe('担当者が書いた範囲');

    const after = context(approved);
    const doc = buildSolutionDoc(s, threadOf(after).solutions.find((x) => x.id === SOLUTION)!, threadOf(after), after, 'ja');
    expect(doc.kind).toBe('promptSpec');
    expect(doc.sections.filter((x) => x.open).map((x) => x.id)).toEqual([]);
    expect(instructionReady(doc)).toBe(true);

    const files = instructionFiles(doc, '技能伝承', candidates, 'ja');
    const byName = Object.fromEntries(files.map((f) => [f.name, String(f.content)]));
    expect(byName['prompt.txt']).toBe(`copilotPrompt の下書き（仮説）\n\n${AI_PROMPT_SUFFIX}`);
    expect(Object.keys(byName).filter((n) => n.startsWith('attachments/')).sort()).toEqual(['attachments/issues.md', 'attachments/kpi.csv']);
    expect(byName['attachments/kpi.csv']!.startsWith('\uFEFFKPI,')).toBe(true);
    expect(byName['指示書.md']).toContain('attachments/kpi.csv');
    expect(byName['指示書.md']).toContain('状態: 全節が記入済み');
  });

  it('refuses a type a person did not leave open, an unfilled section or an incomplete live answer', async () => {
    const confirmed = context(setSolutionType(emptyStrategy(), SOLUTION, 'digital', '担当者', '2026-11-20'));
    expect(Object.keys((solutionDraftContext(input(confirmed)) as unknown as Ctx).types)).toEqual(['digital']);
    expect(checkSolutionDraft(input(confirmed), answer(context(), 'prompt'))).toMatchObject({ draft: null, missing: ['type'] });

    const full = answer(confirmed, 'digital');
    const [first, second] = Object.keys(full.sections);
    const partial = { ...full, sections: { ...full.sections, [second!]: '【要記入】 後で' } };
    delete partial.sections[first!];
    expect(checkSolutionDraft(input(confirmed), partial).missing).toEqual([first, second]);
    expect(hasToFill(JSON.stringify(checkSolutionDraft(input(confirmed), partial).draft))).toBe(false);

    setRuntimeSettingsProvider(() => ({ provider: 'foundry', liveEnabled: true, sendConsent: true, configured: true }));
    setLiveTransport(async () => ({ text: JSON.stringify(partial), inputTokens: 1, outputTokens: 1 }));
    await expect(requestLiveSolutionDraft(input(confirmed), solutionDraftRequest(input(confirmed))!)).rejects.toThrow(`必要な項目がありません: ${first}, ${second}`);

    // D-51: a repair that supplies exactly the missing sections completes the draft without redoing the accepted ones.
    const repairs: string[] = [];
    setLiveTransport(async (call) => {
      if (!call.prompt.includes('REPAIR:')) return { text: JSON.stringify(partial), inputTokens: 1, outputTokens: 1 };
      repairs.push(call.prompt);
      return { text: JSON.stringify({ ...full, sections: { [first!]: 'fixed 1', [second!]: 'fixed 2' } }), inputTokens: 1, outputTokens: 1 };
    });
    const repaired = await requestLiveSolutionDraft(input(confirmed), solutionDraftRequest(input(confirmed))!);
    expect(repairs).toHaveLength(1);
    expect(repaired.sections[first!]).toBe('fixed 1');
    expect(Object.keys(repaired.sections).sort()).toEqual(Object.keys(full.sections).sort());
  });

  it('FR-384: the chosen AI approach is stored defensively and reaches the draft context and baseline', () => {
    const first = setSolutionApproach(emptyStrategy(), SOLUTION, 'first', '担当者', '2026-11-27');
    const c = solutionDraftContext(input(context(first))) as { solution: { aiApproach: string | null } };
    expect(c.solution.aiApproach).toBe('first');
    expect((solutionDraftContext(input(context())) as typeof c).solution.aiApproach).toBeNull();
    expect(solutionBaseline(first, SOLUTION)).not.toBe(solutionBaseline(emptyStrategy(), SOLUTION));
    expect(solutionBaseline(emptyStrategy(), SOLUTION)).toBe(JSON.stringify({ type: null, sections: {} }));

    const stored = normalizeStrategy(JSON.parse(JSON.stringify({ ...first, approaches: { ...first.approaches, other: { approach: 'bpr', by: 'x', at: 'y' } } })));
    expect(stored.approaches).toEqual({ [SOLUTION]: { approach: 'first', by: '担当者', at: '2026-11-27' } });
    expect(setSolutionApproach(first, SOLUTION, null, '担当者', '2026-11-27')).toEqual(emptyStrategy());
  });

  it('bundles only software-solvable work and lists the rest as not included', () => {
    const ctx = context(setSolutionType(emptyStrategy(), 'sol-energy-twin', 'process', '担当者', '2026-11-20'));
    const thread = threadOf(ctx);
    const items = thread.solutions.map((ts) => {
      const s = ctx.pack.byId.get(ts.id);
      if (s?.kind !== 'solution') throw new Error('fixture');
      return { name: ts.id, doc: buildSolutionDoc(s, ts, thread, ctx, 'ja'), candidates: [], system: ts.type !== 'process' };
    });
    const names = systemBundle(items, '成果物', 'ja').map((e) => e.name);
    expect(names[0]).toBe('README.md');
    expect(names.some((n) => n.includes('sol-energy-twin'))).toBe(false);
    expect(String(systemBundle(items, '成果物', 'ja')[0]!.content)).toContain('| — | sol-energy-twin | ');
    expect(names.filter((n) => n.endsWith('/要求定義書.md'))).toHaveLength(4);
  });

  it('writes a ZIP that standard tools read (CRC-32, UTF-8 names, central directory)', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const bytes = zipFiles([{ name: 'a/指示書.md', content: 'あ' }, { name: 'b.txt', content: new Uint8Array([1, 2]) }], new Date(2026, 10, 20));
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const central = view.getUint32(end + 16, true);
    expect(view.getUint32(central, true)).toBe(0x02014b50);
    expect(new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + view.getUint16(central + 28, true)))).toBe('a/指示書.md');
    expect(() => zipFiles([{ name: 'x', content: '' }, { name: 'x', content: '' }])).toThrow('Duplicate');
  });
});
