import { describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { loadPack } from '../src/data/pack.ts';
import { verifyPack } from '../src/data/verify.ts';
import { parseCatalogFile } from '../src/modules/usecases/catalog.ts';
import { demoKpis } from '../src/modules/project/kpiOkr.ts';
import { demoUseCases } from '../src/modules/usecases/seed.ts';
import {
  DELIVERABLE_OF, emptyStrategy, isSystemType, normalizeStrategy, setSection, setSolutionType, strategyThread, upsertContribution,
  type SolutionType, type StrategyContext, type StrategyData,
} from '../src/modules/project/strategy.ts';
import { buildSolutionDoc, hasToFill, sectionGuide, SECTIONS } from '../src/modules/project/solutionDocs.ts';
import { emptyDeliverables, evaluateStep, setField, STEP_DEFS, type CheckContext, type DeliverableData } from '../src/modules/project/deliverables.ts';
import { checkRequirementText, hasBound } from '../src/modules/project/requirementQuality.ts';
import { addChange, addEvidence, isHiddenGem, reqId, removeEvidence, setLedgerEntry, setSignal } from '../src/modules/project/requirementsModel.ts';
import { changesCsv, ledgerCsv, ledgerReqIf, ledgerRows } from '../src/modules/project/requirementsExport.ts';
import { parseEvidenceFile } from '../src/modules/project/evidenceImport.ts';
import { formDraftPrompt } from '../src/modules/project/formDraft.ts';
import { parseWorkIqQuestion, workIqAspectKeywords, workIqAspectQuery, workIqPlan, WORKIQ_REQUIREMENT_ASPECTS } from '../server/workiq.ts';

const pack = loadPack(samplePack);
const solutions = pack.pack.entities.filter((e) => e.kind === 'solution');
const AT = '2026-11-19T00:00:00Z';

function docContext(strategy: StrategyData, over: { pack?: typeof pack; deliverables?: DeliverableData; useCases?: StrategyContext['useCases']; kpis?: ReturnType<typeof demoKpis>['kpis'] } = {}) {
  const kpi = demoKpis(pack.pack);
  return {
    pack: over.pack ?? pack, kpi: over.kpis ? { ...kpi, kpis: over.kpis } : kpi, useCases: over.useCases ?? demoUseCases(), strategy,
    objectives: [{ id: 'o1', text: 'Objective' }], projectObjectiveIds: ['o1'], deliverables: over.deliverables ?? emptyDeliverables(), today: '2026-11-19',
  };
}

function strategyFor(type: SolutionType): StrategyData {
  const kpi = demoKpis(pack.pack);
  let s = emptyStrategy();
  for (const sol of solutions) {
    s = setSolutionType(s, sol.id, type, 'Tester', AT);
    for (const k of kpi.kpis.slice(0, 2)) {
      s = upsertContribution(s, {
        id: `c-${sol.id}-${k.id}`, solutionId: sol.id, kpiId: k.id, lever: 'lever', leverUnit: 'u', amount: { low: 1, mode: 2, high: 3 },
        effectPerUnit: { low: 0.1, mode: 0.2, high: 0.3 }, rampStart: '2026-12-01', fullEffect: '2027-01-31', basis: 'measured', evidence: 'pilot',
      });
    }
  }
  return s;
}

function build(type: SolutionType, strategy = strategyFor(type), over: Parameters<typeof docContext>[1] = {}, lang: 'ja' | 'en' = 'ja') {
  const c = docContext(strategy, over);
  const t = strategyThread(c);
  const s = solutions[0]!;
  return buildSolutionDoc(s, t.solutions.find((x) => x.id === s.id)!, t, c, lang);
}

const withExt = (extensions: Record<string, unknown>) => loadPack({ ...samplePack, extensions: { ...(samplePack.extensions ?? {}), ...extensions } });

describe('requirement wording checks (29148: unambiguous, verifiable, singular)', () => {
  it('flags wording that cannot be verified unless a bound is given', () => {
    expect(checkRequirementText('- システムは使いやすいこと（2027年3月までに1回確認）', 'ja').map((i) => i.code)).toEqual(['vague']);
    expect(checkRequirementText('- FR-x: 画面は迅速に表示すること', 'ja')[0]).toMatchObject({ code: 'vague', term: '迅速' });
    expect(checkRequirementText('- 画面は 3 秒以内に表示すること', 'ja')).toEqual([]);
    expect(checkRequirementText('- The system shall be easy to use', 'en')[0]).toMatchObject({ code: 'vague', term: 'easy' });
    expect(checkRequirementText('- The page shall load quickly, within 3 seconds', 'en')).toEqual([]);
  });

  it('does not take a date for a bound, and flags several requirements in one sentence', () => {
    expect(hasBound('2027年3月までに')).toBe(false);
    expect(hasBound('99.9% 以上')).toBe(true);
    expect(hasBound('within 5 minutes')).toBe(true);
    expect(checkRequirementText('- 一覧を表示すること、かつ、CSV を出力すること', 'ja').map((i) => i.code)).toContain('compound');
    expect(checkRequirementText('- The system shall log in users and shall export CSV', 'en').map((i) => i.code)).toContain('compound');
  });

  it('skips nested lines, tables and to-fill lines', () => {
    expect(checkRequirementText('  1. 使いやすい手順\n| 迅速 |\n- 【要記入】 使いやすさ', 'ja')).toEqual([]);
  });

  it('the vague acceptance text no longer completes the step document', () => {
    let d = emptyDeliverables();
    for (const f of STEP_DEFS.solution.fields) d = setField(d, 'solution', f.id, { text: 'システムは使いやすいこと（2027年3月までに1回確認）', author: 'human', updatedAt: AT });
    const c = { pack, discussion: { themes: [], records: [] }, kpi: demoKpis(pack.pack), analysis: { analyses: [] }, useCases: demoUseCases(), deliverables: d, today: '2026-11-19' } as unknown as CheckContext;
    const r = evaluateStep('solution', c).find((x) => x.todo.id === 'uc-doc')!;
    expect(r.done).toBe(false);
    expect(r.outcome?.code).toBe('docVague');
    for (const f of STEP_DEFS.solution.fields) d = setField(d, 'solution', f.id, { text: f.id === 'acceptance' ? '画面は 3 秒以内に表示すること' : `${f.id}: 12 件`, author: 'human', updatedAt: AT });
    const ok = evaluateStep('solution', { ...c, deliverables: d }).find((x) => x.todo.id === 'uc-doc')!;
    expect(ok.done).toBe(true);
  });
});

describe('stable requirement ids', () => {
  it('follow the KPI, use case or evidence, not the position', () => {
    expect(reqId('BR', 'kpi-lead-time')).toBe('BR-lead-time');
    expect(reqId('FR', 'uc-abc')).toBe('FR-abc');
    const kpis = demoKpis(pack.pack).kpis;
    const a = build('digital');
    const ids = a.items.filter((i) => i.section === 'businessReq').map((i) => i.id);
    expect(ids.length).toBeGreaterThan(1);
    const dropped = kpis.find((k) => a.items.some((i) => i.id === reqId('BR', k.id)))!;
    const b = build('digital', undefined, { kpis: kpis.filter((k) => k.id !== dropped.id) });
    const after = b.items.filter((i) => i.section === 'businessReq').map((i) => i.id);
    expect(after).not.toContain(reqId('BR', dropped.id));
    for (const id of after) expect(ids).toContain(id);
    const text = (d: typeof a, id: string) => d.sections.find((s) => s.id === 'businessReq')!.text.split('\n').find((l) => l.includes(id));
    for (const id of after) expect(text(b, id)).toBe(text(a, id));
  });
});

describe('prompt and AI agent specifications', () => {
  it('a prompt, an agent and an app each get their own deliverable', () => {
    expect(isSystemType('prompt') && isSystemType('agent') && isSystemType('digital') && !isSystemType('process')).toBe(true);
    expect(DELIVERABLE_OF).toMatchObject({ digital: 'requirements', prompt: 'promptSpec', agent: 'agentSpec' });
    for (const type of ['prompt', 'agent'] as const) {
      const d = build(type);
      expect(d.sections.map((s) => s.id)).toEqual(SECTIONS[DELIVERABLE_OF[type]]);
    }
    const agent = build('agent', undefined, {}, 'en');
    for (const id of ['roleSplit', 'uncertainty', 'fallback', 'dataSupply', 'evaluation', 'monitoring', 'logging']) {
      expect(agent.sections.find((s) => s.id === id)?.open, id).toBe(true);
    }
    expect(agent.sections.find((s) => s.id === 'fallback')!.text).toContain('route to a person');
    expect(agent.sections.find((s) => s.id === 'stakeholders')!.text).toContain('who checks the AI output');
    expect(build('prompt').sections.find((s) => s.id === 'promptElements')!.text).toContain('【要記入】 役割');
  });

  it('a system type without use cases is a gap; a process is not', () => {
    for (const type of ['digital', 'prompt', 'agent'] as const) {
      const c = docContext(setSolutionType(emptyStrategy(), solutions[0]!.id, type, 'T', AT), { useCases: [] });
      expect(strategyThread(c).gaps.digitalWithoutUseCase).toContain(solutions[0]!.id);
    }
    const c = docContext(setSolutionType(emptyStrategy(), solutions[0]!.id, 'process', 'T', AT), { useCases: [] });
    expect(strategyThread(c).gaps.digitalWithoutUseCase).not.toContain(solutions[0]!.id);
  });

  it('section guides come from the handbook tables', () => {
    expect(sectionGuide('fallback', 'en')).toHaveLength(8);
    expect(sectionGuide('uncertainty', 'ja')).toHaveLength(7);
    expect(sectionGuide('promptElements', 'en')).toHaveLength(7);
    expect(sectionGuide('purpose', 'en')).toEqual([]);
  });

  it('the section draft prompt carries the guide and evidence', () => {
    const prompt = formDraftPrompt('section', { solution: 'S', document: 'D', section: 'X', current: '', facts: [], guide: ['Accuracy'], evidence: [{ text: 'SLA 99.9%', source: 'SLA.docx' }] }, 'en');
    expect(prompt).toContain('CONTEXT.guide');
    expect(prompt).toContain('SLA 99.9%');
    expect(prompt).toContain('SLA.docx');
  });
});

describe('data the project already holds reaches the requirements definition', () => {
  const ext = {
    architecture: { asIs: [{ layer: 'data', name: 'Legacy MES' }], toBe: [] },
    glossary: [{ term: { ja: '納期遵守率', en: 'On-time delivery' }, definition: { ja: '約束日までに出荷した割合', en: 'Share shipped by the promised date' } }],
    dataCatalog: { items: [{ name: '受注テーブル', description: '受注', owner: '営業部', provenance: 'ERP', license: '社内', personalData: 'なし', retention: '7 年', quality: '日次検査', updateFrequency: '日次' }] },
  };

  it('current systems, glossary and data dictionary fill constraints, non-functional, data and glossary sections', () => {
    const d = build('digital', undefined, { pack: withExt(ext) }, 'en');
    const sec = (id: string) => d.sections.find((s) => s.id === id)!.text;
    expect(sec('nonFunctionalReq')).toContain('Legacy MES');
    expect(sec('nonFunctionalReq')).not.toContain('Migration and integration requirements');
    expect(sec('dataReq')).toContain('IF-legacy-mes');
    expect(sec('glossary')).toContain('On-time delivery: Share shipped by the promised date');
    expect(d.items.some((i) => i.id === 'NFR-mig-legacy-mes' && i.section === 'nonFunctionalReq')).toBe(true);
  });

  it('data dictionary attributes appear for the datasets a solution names', () => {
    let deliverables = emptyDeliverables();
    deliverables = setField(deliverables, 'solution', 'dataNeeds', { text: '受注テーブルを使う', author: 'human', updatedAt: AT });
    const d = build('digital', undefined, { pack: withExt(ext), deliverables }, 'ja');
    expect(d.sections.find((s) => s.id === 'dataReq')!.text).toMatch(/受注テーブル.*所有者: 営業部.*出所: ERP|受注テーブル.*出所: ERP/);
    const agent = build('agent', undefined, { pack: withExt({ ...ext, dataCatalog: { items: [{ name: '受注テーブル', provenance: 'ERP' }] } }), deliverables }, 'ja');
    const supply = agent.sections.find((s) => s.id === 'dataSupply')!.text;
    expect(supply).toContain('受注テーブル: 出所: ERP');
    expect(supply).toContain('【要記入】 不足: 所有者');
  });

  it('an imported data dictionary wins over the pack\'s', () => {
    const c = docContext(strategyFor('digital'), { pack: withExt(ext) });
    const t = strategyThread(c);
    const s = solutions[0]!;
    const d = buildSolutionDoc(s, t.solutions.find((x) => x.id === s.id)!, t, { ...c, catalog: [{ name: '在庫テーブル', description: '在庫' }] }, 'ja');
    expect(d.sections.find((x) => x.id === 'dataReq')!.text).not.toContain('受注テーブル');
  });
});

describe('evidence from Work IQ, files and the pack', () => {
  const rule = (id: string, kind: string, summary: string) => ({ id, kind, title: { ja: id, en: id }, summary: { ja: summary, en: summary }, sourceIds: [samplePack.entities.find((e) => e.kind === 'source')!.id] });

  it('rules fill the non-functional categories; only what is uncovered stays to fill', () => {
    const none = build('digital', undefined, {}, 'en').sections.find((s) => s.id === 'nonFunctionalReq')!;
    expect(none.text).toContain('Performance, Availability, Security, Privacy, Operations, Migration and integration');
    const p = withExt({
      requirementEvidence: { items: [rule('ev-sla', 'sla', '99.9% availability, responses within 3 seconds'), rule('ev-sec', 'security', 'ISMS controls A.8'), rule('ev-priv', 'privacy', 'APPI consent'), rule('ev-ops', 'operations', 'Night batch window')] },
      architecture: { asIs: [{ layer: 'data', name: 'ERP' }] },
    });
    const filled = build('digital', undefined, { pack: p }, 'en').sections.find((s) => s.id === 'nonFunctionalReq')!;
    expect(filled.open).toBe(false);
    expect(filled.text).toContain('NFR-sla');
    expect(filled.text).toContain('[Performance/Availability]');
    expect(hasToFill(filled.text)).toBe(false);
    const noNumber = withExt({ requirementEvidence: { items: [rule('ev-sla', 'sla', 'fast and reliable')] } });
    expect(build('digital', undefined, { pack: noNumber }, 'en').sections.find((s) => s.id === 'nonFunctionalReq')!.text).toContain('Performance, Availability');
  });

  it('project evidence (Work IQ answer, file) counts like pack evidence, and voices become requirement candidates', () => {
    let s = strategyFor('digital');
    s = addEvidence(s, { id: 'ev-1', kind: 'complaint', title: '納期の遅れ', summary: '出荷が約束日に間に合わない', origin: 'workiq', note: 'q', citations: [{ title: 'クレーム管理表', url: 'https://example.com/x' }], count: 42, severity: 5, at: AT, by: 'T' });
    s = addEvidence(s, { id: 'ev-2', kind: 'policy', title: 'AI 利用規程', summary: '機密は入力しない', origin: 'file', citations: [], at: AT, by: 'T' });
    const d = build('digital', s, {}, 'ja');
    const fr = d.sections.find((x) => x.id === 'functionalReq')!.text;
    expect(fr).toContain('VC-1: クレーム「納期の遅れ」');
    expect(fr).toContain('42 件');
    expect(fr).toContain('重大度 5/5');
    expect(d.sections.find((x) => x.id === 'constraints')!.text).toContain('CN-2: 社内規程「AI 利用規程」に従う');
    expect(d.items.map((i) => i.id)).toEqual(expect.arrayContaining(['VC-1', 'CN-2']));
    expect(removeEvidence(s, 'ev-1').evidence?.map((e) => e.id)).toEqual(['ev-2']);
  });

  it('evaluation data feeds the evaluation section', () => {
    let s = strategyFor('agent');
    s = addEvidence(s, { id: 'ev-e', kind: 'evalData', title: 'sample-set', summary: '', origin: 'file', citations: [], at: AT, by: 'T', data: { rows: 200, columns: ['text', 'label'], labels: { 苦情: 120, 質問: 80 } } });
    const text = build('agent', s, {}, 'ja').sections.find((x) => x.id === 'evaluation')!.text;
    expect(text).toContain('評価データ「sample-set」: 200 件');
    expect(text).toContain('苦情 120');
  });

  it('the pack extension is validated: duplicate ids and dangling sources are errors', () => {
    const base = { ...samplePack };
    const ok = verifyPack({ ...base, extensions: { ...(base.extensions ?? {}), requirementEvidence: { items: [rule('ev-a', 'policy', 'x')] } } });
    expect(ok.problems.filter((p) => p.severity === 'error' && p.path.includes('requirementEvidence'))).toEqual([]);
    const bad = verifyPack({ ...base, extensions: { ...(base.extensions ?? {}), requirementEvidence: { items: [rule('ev-a', 'policy', 'x'), { ...rule('ev-a', 'policy', 'y'), sourceIds: ['src-missing'] }, { ...rule('ev-b', 'nonsense', 'z') }] } } });
    expect(bad.problems.filter((p) => p.severity === 'error' && p.path.startsWith('extensions.requirementEvidence')).length).toBeGreaterThan(0);
  });
});

describe('evidence files', () => {
  it('keeps counts, columns and the label distribution of an evaluation set, never the rows', () => {
    const csv = 'text,label\n"a, b",苦情\nc,苦情\nd,質問\n';
    const r = parseEvidenceFile('eval.csv', csv, 'evalData', csv.length, 'ja');
    expect(r).toMatchObject({ ok: true, value: { title: 'eval', count: 3, data: { rows: 3, columns: ['text', 'label'], labels: { 苦情: 2, 質問: 1 } } } });
    expect(JSON.stringify(r)).not.toContain('a, b');
  });

  it('counts the records of a complaint log and excerpts a policy text', () => {
    const log = parseEvidenceFile('claims.jsonl', '{"id":1,"body":"x"}\n{"id":2,"body":"y"}', 'complaint', 40, 'en');
    expect(log).toMatchObject({ ok: true, value: { count: 2, data: { rows: 2, columns: ['id', 'body'] } } });
    const text = parseEvidenceFile('policy.md', `# Rule\n${'a '.repeat(2000)}`, 'policy', 4000);
    expect(text.ok && text.value.summary.length).toBeLessThanOrEqual(800);
  });

  it('refuses large, empty and unreadable files', () => {
    expect(parseEvidenceFile('x.csv', 'a', 'evalData', 3_000_000)).toEqual({ ok: false, error: 'tooLarge' });
    expect(parseEvidenceFile('x.md', '  ', 'policy', 2)).toEqual({ ok: false, error: 'empty' });
    expect(parseEvidenceFile('x.txt', 'plain', 'evalData', 5)).toEqual({ ok: false, error: 'format' });
    expect(parseEvidenceFile('x.csv', 'a,b\n', 'evalData', 4)).toEqual({ ok: false, error: 'empty' });
  });
});

describe('requirement ledger, change records and exchange formats', () => {
  it('attributes are kept per requirement id, defaults apply until a person decides', () => {
    let s = strategyFor('digital');
    const sol = solutions[0]!.id;
    const doc = build('digital', s);
    const first = doc.items[0]!;
    expect(ledgerRows(doc, s, 'en')[0]).toMatchObject({ id: first.id, status: 'candidate', priority: '', verification: first.verification });
    s = setLedgerEntry(s, sol, first.id, { priority: 'must', status: 'approved', verification: '  レビューで確認  ' }, 'Reviewer', AT);
    const row = ledgerRows(build('digital', s), s, 'ja')[0]!;
    expect(row).toMatchObject({ priority: 'must', status: 'approved', verification: '  レビューで確認  '.trim() || '', author: 'Reviewer', updatedAt: AT });
    s = setLedgerEntry(s, sol, first.id, { priority: undefined, status: undefined, verification: '' }, 'Reviewer', AT);
    expect(s.ledger?.[sol]?.[first.id]).toBeUndefined();
  });

  it('a section records who wrote it and when; clearing it removes the stamp', () => {
    let s = setSection(emptyStrategy(), 's1', 'scope', '範囲は 12 拠点', { by: 'Ann', at: AT });
    expect(s.sectionMeta).toEqual({ s1: { scope: { by: 'Ann', at: AT } } });
    s = setSection(s, 's1', 'scope', null);
    expect(s.sectionMeta?.s1?.scope).toBeUndefined();
    expect(setSection(emptyStrategy(), 's1', 'scope', 'x').sectionMeta).toBeUndefined();
  });

  it('exports CSV and ReqIF with the ids, escaping what must be escaped', () => {
    const s = strategyFor('digital');
    const doc = build('digital', s, {}, 'en');
    const rows = ledgerRows({ ...doc, items: [{ id: 'BR-a&b', section: 'businessReq', text: 'Say "hi", <ok>', source: 'KPI "x"', verification: 'test' }] }, s, 'en');
    const csv = ledgerCsv(rows, 'en');
    expect(csv.startsWith('\uFEFFID,Section,Requirement')).toBe(true);
    expect(csv).toContain('"Say ""hi"", <ok>"');
    const xml = ledgerReqIf(rows, 'Spec <1>', 'en', new Date('2026-11-19T00:00:00Z'));
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(parsed.getElementsByTagName('SPEC-OBJECT')).toHaveLength(1);
    expect(parsed.getElementsByTagName('SPEC-OBJECT')[0]!.getAttribute('LONG-NAME')).toBe('BR-a&b');
    expect(parsed.getElementsByTagName('SPEC-OBJECT')[0]!.getAttribute('IDENTIFIER')).toMatch(/^so-[A-Za-z0-9_.-]+$/);
    expect(xml).toContain('Say &quot;hi&quot;, &lt;ok&gt;');
  });

  it('change records keep reason, impact and approver', () => {
    const s = addChange(emptyStrategy(), { id: 'chg-1', solutionId: 's1', subject: 'BR-x', summary: '目標値を 90 に', reason: '経営会議の決定', impact: 'AC-x と試験', approver: '部長', at: AT, by: 'T' });
    expect(changesCsv(s.changes!, 'ja')).toContain('経営会議の決定');
    expect(normalizeStrategy(JSON.parse(JSON.stringify(s))).changes).toHaveLength(1);
  });
});

describe('issue frequency and severity', () => {
  it('a rare but severe issue is a hidden gem; the signal needs both numbers', () => {
    expect(isHiddenGem({ frequency: 1, severity: 5 })).toBe(true);
    expect(isHiddenGem({ frequency: 2, severity: 4 })).toBe(true);
    expect(isHiddenGem({ frequency: 4, severity: 5 })).toBe(false);
    expect(isHiddenGem({ frequency: 1, severity: 3 })).toBe(false);
    const s = setSignal(emptyStrategy(), 'issue-a', { frequency: 1, severity: 5 }, 'T', AT);
    expect(s.signals?.['issue-a']).toMatchObject({ frequency: 1, severity: 5, by: 'T' });
    expect(setSignal(s, 'issue-a', null, 'T', AT).signals).toEqual({});
  });
});

describe('stored requirement data is read defensively', () => {
  it('keeps valid entries and drops broken ones; older data is unchanged', () => {
    expect(normalizeStrategy({ types: {}, contributions: [], sections: {} })).toEqual(emptyStrategy());
    const raw = {
      types: {}, contributions: [], sections: {},
      ledger: { s1: { 'BR-a': { priority: 'must', at: AT, by: 'T' }, 'BR-b': { priority: 'urgent', at: AT, by: 'T' } }, s2: 'broken' },
      sectionMeta: { s1: { scope: { at: AT, by: 'T' }, risks: 1 } },
      evidence: [{ id: 'e1', kind: 'policy', title: 'x', summary: '', origin: 'file', at: AT, by: 'T' }, { id: 'e2', kind: 'nope' }],
      signals: { a: { frequency: 2, severity: 5, at: AT, by: 'T' }, b: { frequency: 9, severity: 1, at: AT, by: 'T' } },
      changes: [{ id: 'c1' }],
    };
    const s = normalizeStrategy(raw);
    expect(Object.keys(s.ledger?.s1 ?? {})).toEqual(['BR-a']);
    expect(s.ledger?.s2).toBeUndefined();
    expect(Object.keys(s.sectionMeta?.s1 ?? {})).toEqual(['scope']);
    expect(s.evidence?.map((e) => e.id)).toEqual(['e1']);
    expect(Object.keys(s.signals ?? {})).toEqual(['a']);
    expect(s.changes).toBeUndefined();
  });
});

describe('data dictionary attributes (handbook table 29)', () => {
  it('are read from CSV headers in any case and kept from JSON', () => {
    const csv = parseCatalogFile('c.csv', 'name,Owner,PersonalData,updateFrequency,Retention\n受注,営業部,なし,日次,7 年\n', 80);
    expect(csv.ok && csv.catalog.items[0]).toMatchObject({ name: '受注', owner: '営業部', personalData: 'なし', updateFrequency: '日次', retention: '7 年' });
    const json = parseCatalogFile('c.json', JSON.stringify({ items: [{ name: 'T', provenance: 'ERP', license: '社内', quality: '日次検査' }] }), 100);
    expect(json.ok && json.catalog.items[0]).toMatchObject({ provenance: 'ERP', license: '社内', quality: '日次検査' });
  });
});

describe('Work IQ searches for requirements', () => {
  const q = { company: 'Contoso', project: 'Contoso 納期改善', purpose: 'p', focus: '', asOf: '2026-11-19', lang: 'ja' as const, timeZone: 'Asia/Tokyo', aspects: [...WORKIQ_REQUIREMENT_ASPECTS], topics: [], expand: false };

  it('asks about rules, current systems and user voices as short questions', () => {
    expect(workIqAspectQuery(q, 'rules')).toBe('Contoso 納期改善に適用される規程・ガイドライン・セキュリティ基準・SLAは何ですか?');
    expect(workIqAspectQuery({ ...q, lang: 'en' }, 'systems')).toBe('What are the current systems and operating procedures of Contoso 納期改善?');
    expect(workIqAspectQuery(q, 'voice')).toContain('問い合わせ・クレーム・障害・監査指摘');
    expect(workIqAspectKeywords(q, 'rules')).toContain('SLA');
  });

  it('accepts the new aspects, keeps them as sections of their own and never plans them as readiness ladders', () => {
    expect(parseWorkIqQuestion({ ...q })).not.toBeNull();
    const plan = workIqPlan({ ...q, expand: true });
    for (const a of WORKIQ_REQUIREMENT_ASPECTS) {
      expect(plan.find((p) => p.key === a)).toMatchObject({ kind: 'scoped', items: [] });
    }
  });
});
