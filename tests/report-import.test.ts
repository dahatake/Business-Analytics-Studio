import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { levelOf, looksLikeReport, parseDecisionReport, reportCoverage } from '../src/data/reportImport.ts';
import { analyzeImport } from '../src/data/packImport.ts';
import { verifyPack } from '../src/data/verify.ts';
import { verifyPack as cliVerifyPack } from '../scripts/lib/verify.ts';
import {
  autoChecks, emptyDecisionInputs, evidenceProfile, gapRows, linkedIssues, rankAcceptability, rankIssues, rankOptions,
  rankQuestions, reportGate, riskMatrix, simulateGate, type GateInputs,
} from '../src/modules/project/decisionSupport.ts';
import { buildReportRequirements, REQ_SECTIONS, reportRequirementsMarkdown } from '../src/modules/project/reportRequirements.ts';
import { buildDrafts, effectiveLinks, linkRecall, resolve } from '../src/modules/project/reportDrafts.ts';

/** A trimmed, synthetic Microsoft 365 Copilot business analysis report (FR-321). */
const REPORT = readFileSync('tests/fixtures/decision-report.md', 'utf8');

const parsed = () => parseDecisionReport('sales-report.md', REPORT, '2025-04-10')!;

describe('decision report import (FR-321)', () => {
  it('recognises a business analysis report by its section headings only', () => {
    expect(looksLikeReport(REPORT)).toBe(true);
    expect(looksLikeReport('# Notes\n\n## Summary\nplain text')).toBe(false);
    expect(parseDecisionReport('notes.md', '# Notes\n\nhello', '2025-04-10')).toBeNull();
    expect(levelOf('中〜高')).toBe(2.5);
    expect(levelOf('not stated')).toBeUndefined();
  });

  it('structures issues, gaps, options, KPIs, roadmap, risks and questions without inventing values', () => {
    const { report, company } = parsed();
    expect(report).toMatchObject({ lang: 'ja', asOf: '2025-04-01', title: '架空商事 営業業務分析レポート' });
    expect(report.issues.map((i) => [i.id, i.priority])).toEqual([['issue-1', 3], ['issue-2', 2]]);
    expect(report.issues[0]!.falsifier).toContain('反証条件');
    expect(report.issues[1]!.falsifier).toBeUndefined();
    expect(report.options.map((o) => [o.label, o.priority, o.difficulty, o.investment])).toEqual([['A', 3, 1, 1], ['B', 2, 3, 3]]);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({ area: '見積プロセス', priority: 3 });
    expect(report.kpis.map((k) => k.name)).toEqual(['見積リードタイム', '承認段数']);
    expect(report.roadmap).toHaveLength(1);
    expect(report.risks).toEqual([expect.objectContaining({ name: '現場の抵抗', mitigation: '説明会を開く' })]);
    expect(report.openQuestions.map((q) => q.text)).toEqual(['承認者は何名か', '顧客情報はどこにあるか']);
    expect(report.assumptions).toHaveLength(1);
    expect(company?.name.ja).toBe('架空商事株式会社');
  });

  it('labels claims by evidence, carries a lead label to the following sentence and skips the legend', () => {
    const { report } = parsed();
    expect(report.claims.some((c) => c.text.includes('根拠の種類'))).toBe(false);
    const summary = report.claims.filter((c) => c.text.startsWith('受注') || c.text.startsWith('新規開拓'));
    expect(summary.map((c) => c.evidence)).toEqual(['fact', 'fact']);
    expect(report.claims.find((c) => c.text.includes('承認経路'))?.evidence).toBe('hypothesis');
    expect(report.claims.every((c) => !c.text.includes('【'))).toBe(true);
  });

  it('keeps every paragraph verbatim and reports how much was structured', () => {
    const { report } = parsed();
    const cov = reportCoverage(report);
    expect(cov.paragraphs).toBe(report.paragraphs.length);
    expect(cov.structured).toBeGreaterThan(0);
    expect(cov.structured).toBeLessThanOrEqual(cov.paragraphs);
    expect(report.paragraphs.some((p) => p.text === '営業が当日中に見積を返せる。')).toBe(true);
  });

  it('imports a report on its own: verifiable pack, internal source, company fallback and notes', () => {
    const a = analyzeImport([{ name: 'sales-report.md', text: REPORT }], [], new Date('2025-04-10T00:00:00Z'));
    expect(a.canImport).toBe(true);
    expect(a.verify?.problems.filter((i) => i.severity === 'error')).toEqual([]);
    expect(a.notes.map((n) => n.code)).toEqual(expect.arrayContaining(['reportRead', 'industryNotStated']));
    expect(a.reports?.map((r) => r.name)).toEqual(['sales-report.md']);
    const pack = a.pack as { entities: { id: string; classification: string; accessedDate: string }[]; extensions: { okr: { kpis: unknown[] } } };
    const source = pack.entities.find((e) => e.id === a.reports![0]!.report.sourceId);
    expect(source).toMatchObject({ classification: 'internal', accessedDate: '2025-04-10' });
    expect(pack.extensions.okr.kpis).toHaveLength(2);
    expect(cliVerifyPack(a.pack).ok).toBe(true);
  });

  it('verify rejects a decision report that cites an unknown source', () => {
    const a = analyzeImport([{ name: 'sales-report.md', text: REPORT }], [], new Date('2025-04-10T00:00:00Z'));
    const pack = a.pack as { extensions: { decisionReport: Record<string, unknown> } };
    const broken = { ...pack, extensions: { ...pack.extensions, decisionReport: { ...pack.extensions.decisionReport, sourceId: 'source-missing' } } };
    const result = verifyPack(broken);
    expect(result.problems.some((i) => i.severity === 'error' && i.path.startsWith('extensions.decisionReport'))).toBe(true);
  });
});

describe('decision support model (FR-321)', () => {
  it('ranks issues from report priority and evidence; user ratings override and are marked', () => {
    const { report } = parsed();
    const base = rankIssues(report, emptyDecisionInputs());
    expect(base.map((i) => i.id)).toEqual(['issue-1', 'issue-2']);
    expect(base[0]!.ratings.confidence).toEqual({ value: 4, origin: 'report' });
    expect(base[1]).toMatchObject({ hypothesis: true, falsifier: false });
    const inputs = emptyDecisionInputs();
    inputs.issues['issue-2'] = { impact: 5, urgency: 5, confidence: 5 };
    const changed = rankIssues(report, inputs);
    expect(changed[0]!.id).toBe('issue-2');
    expect(changed[0]!.ratings.impact.origin).toBe('user');
  });

  it('links options to the issues they state and scores them', () => {
    const { report } = parsed();
    expect(linkedIssues(report, 'option-a')).toEqual(['issue-1']);
    expect(linkedIssues(report, 'option-b')).toEqual(['issue-1', 'issue-2']);
    const rows = rankOptions(report, emptyDecisionInputs());
    expect(rows[0]!.id).toBe('option-a');
    expect(rows[0]!.ratings.safety.origin).toBe('unrated');
  });

  it('SMAA rank acceptability is reproducible and sums to one', () => {
    const { report } = parsed();
    const inputs = emptyDecisionInputs();
    const rows = rankOptions(report, inputs);
    const a = rankAcceptability(rows, inputs.optionWeights, { runs: 500 });
    expect(rankAcceptability(rows, inputs.optionWeights, { runs: 500 })).toEqual(a);
    expect(a.reduce((s, x) => s + x.first, 0)).toBeCloseTo(1, 10);
    expect(a.find((x) => x.id === 'option-a')!.first).toBeGreaterThan(0.5);
  });

  it('simulates the trial gate: large effects pass, no effect fails, invalid input is rejected', () => {
    const { report } = parsed();
    expect(reportGate(report)).toBe(0.2);
    const g = (low: number, mode: number, high: number): GateInputs => ({ gate: 0.2, effect: { low, mode, high }, cv: 0.5, n: 40, overhead: 0 });
    expect(simulateGate(g(0.5, 0.55, 0.6), { runs: 400 })!.pass).toBeGreaterThan(0.95);
    expect(simulateGate(g(0, 0, 0), { runs: 400 })!.pass).toBeLessThan(0.1);
    const mixed = simulateGate(g(0, 0.2, 0.4), { runs: 400 })!;
    expect(mixed.falsePass).toBeGreaterThan(0);
    expect(mixed.curve.at(-1)!.correct).toBeGreaterThanOrEqual(mixed.curve[0]!.correct);
  expect(mixed.curve.find((c) => c.n === 40)!.correct).toBe(mixed.correct);
    expect(simulateGate({ ...g(0.3, 0.2, 0.1) })).toBeNull();
    expect(simulateGate({ ...g(0.1, 0.2, 0.3), n: 2 })).toBeNull();
  });

  it('orders questions, gaps and risks only from user ratings', () => {
    const { report } = parsed();
    const inputs = emptyDecisionInputs();
    expect(rankQuestions(report, inputs).every((q) => q.ratings.impact.origin === 'unrated')).toBe(true);
    inputs.questions[report.openQuestions[1]!.id] = { impact: 5, uncertainty: 5, effort: 1 };
    expect(rankQuestions(report, inputs)[0]!.id).toBe(report.openQuestions[1]!.id);
    expect(gapRows(report, inputs)[0]!.size).toBeUndefined();
    inputs.gaps[report.gaps[0]!.id] = { current: 2, target: 5 };
    expect(gapRows(report, inputs)[0]).toMatchObject({ size: 3 });
    expect(riskMatrix(report, inputs).unrated).toEqual([report.risks[0]!.id]);
    inputs.risks[report.risks[0]!.id] = { likelihood: 4, impact: 4 };
    const m = riskMatrix(report, inputs);
    expect(m.unrated).toEqual([]);
    expect(m.cells.find((c) => c.likelihood === 4 && c.impact === 4)!.ids).toEqual([report.risks[0]!.id]);
  });

  it('profiles evidence per step and computes the automatic checklist', () => {
    const { report } = parsed();
    const asis = evidenceProfile(report, 'asis');
    expect(asis.counts.fact).toBeGreaterThan(0);
    expect(asis.counts.hypothesis).toBeGreaterThan(0);
    expect(evidenceProfile(report, 'tobe').counts.fact).toBe(0);
    const checks = Object.fromEntries(autoChecks(report, emptyDecisionInputs()).map((c) => [c.id, c]));
    expect(checks.falsifiers).toMatchObject({ value: 1, total: 2, ok: false });
    expect(checks.mitigations).toMatchObject({ value: 1, total: 1, ok: true });
  });
});

describe('requirements definition drafted from the report alone (FR-321)', () => {
  it('builds every section from report text, cites lines and marks what the report leaves out', () => {
    const { report } = parsed();
    const draft = buildReportRequirements(report, emptyDecisionInputs(), 'ja');
    expect(draft.sections.map((s) => s.id)).toEqual([...REQ_SECTIONS]);
    expect(draft.requirements).toEqual([expect.objectContaining({ id: 'REQ-01', line: report.gaps[0]!.line })]);
    expect(draft.requirements[0]!.text.startsWith('見積プロセス: ')).toBe(true);
    const body = Object.fromEntries(draft.sections.map((s) => [s.id, s.body])) as Record<(typeof REQ_SECTIONS)[number], string>;
    expect(body.issues).toContain(`（L${report.issues[0]!.line}）`);
    expect(body.issues).toContain('反証条件: 【推定】 案件の記録を数えて「顧客情報が分散している」');
    expect(body.solution.startsWith('【推定】 A. ')).toBe(true);
    expect(body.acceptance).toContain('試行の合格基準: 20%');
    expect(body.acceptance).toContain('【要記入】 基準値（測り方: 【推定】 試行前の期間に新たに測る）');
    expect(body.open).toContain('【要記入】 承認者は何名か');
    expect(body.requirements).toContain('種類: 【推定】 業務の要求');
    expect(body.trace).toMatch(/\| REQ-01 \| 要求 \| .+ \| I1（推定） \| \d+ \|/);
    expect(body.trace).toMatch(/\| K1 \| KPI \| .+ \| REQ-01（推定） \| \d+ \|/);
    expect(body.trace).toMatch(/\| A \| 解決策 \| .+ \| I1 \| \d+ \|/);
    expect(body.decisions).toContain('【推定】 推奨を仮に採用（未確認）');
    expect(body.decisions).toContain('見直す条件: ');
    expect(draft.toFill).toBeGreaterThan(0);
    expect(draft.toConfirm).toBe(draft.decisions.length);
    const md = reportRequirementsMarkdown(draft);
    expect(md.startsWith(`# ${report.title} — ソフトウェア要求定義書（草案）`)).toBe(true);
    expect(md.split('【要記入】').length - 1).toBe(draft.toFill);
  });

  it('follows the user ratings and clears markers the user resolves', () => {
    const { report } = parsed();
    const base = buildReportRequirements(report, emptyDecisionInputs(), 'en');
    const inputs = emptyDecisionInputs();
    inputs.issues['issue-2'] = { impact: 5, urgency: 5, confidence: 5 };
    for (const k of report.kpis) inputs.kpiBaseline[k.id] = 'measured';
    inputs.gate = { effect: { low: 0.1, mode: 0.25, high: 0.4 } };
    const rated = buildReportRequirements(report, inputs, 'en');
    const issues = rated.sections.find((s) => s.id === 'issues')!.body;
    expect(issues.indexOf('Issue 2:')).toBeLessThan(issues.indexOf('Issue 1:'));
    expect(rated.sections.find((s) => s.id === 'acceptance')!.body).toContain('Decision accuracy (step 3 inputs)');
    expect(rated.toFill).toBeLessThan(base.toFill);
    expect(buildReportRequirements(report, inputs, 'en')).toEqual(rated);
  });
});

describe('decisions drafted at import with a recommendation and rationale (FR-322)', () => {
  const withReport = (edit: (md: string) => string) => parseDecisionReport('sales-report.md', edit(REPORT), '2025-04-10')!.report;

  it('drafts what the report leaves open, each with options, a recommendation, reasons and a revisit condition', () => {
    const { report } = parsed();
    const { decisions } = buildDrafts(report, emptyDecisionInputs(), 'ja');
    expect(decisions.map((d) => d.id)).toEqual([
      'falsifier:issue-2', 'solution', ...report.kpis.map((k) => `baseline:${k.id}`), 'sampleSize',
      `reqType:${report.gaps[0]!.id}`, `reqIssue:${report.gaps[0]!.id}`, ...report.kpis.map((k) => `kpiReq:${k.id}`),
    ]);
    for (const d of decisions) {
      expect(d.options.map((o) => o.id)).toContain(d.recommended);
      expect(d.reasons.length).toBeGreaterThanOrEqual(2);
      expect(d.flip).not.toBe('');
      expect(d.line).toBeGreaterThan(0);
    }
    expect(decisions.find((d) => d.id === `reqIssue:${report.gaps[0]!.id}`)).toMatchObject({ recommended: 'issue-1' });
    expect(buildDrafts(report, emptyDecisionInputs(), 'ja')).toEqual(buildDrafts(report, emptyDecisionInputs(), 'ja'));
  });

  it('recovers the option → issue links the report states when they are hidden', () => {
    expect(linkRecall(parsed().report)).toEqual({ checked: 2, hit: 2, stated: 3, found: 2 });
    const report = withReport((md) => md.replace('課題1に対応する。', ''));
    const { decisions, optionIssues } = buildDrafts(report, emptyDecisionInputs(), 'ja');
    const d = decisions.find((x) => x.id === 'optionIssue:option-a')!;
    expect(d.recommended).toBe('issue-1');
    expect(d.reasons.join(' ')).toContain('承認');
    const rows = rankOptions(report, emptyDecisionInputs(), undefined, effectiveLinks(optionIssues));
    expect(rows.find((o) => o.id === 'option-a')).toMatchObject({ issues: ['issue-1'], inferredIssues: true });
    expect(rows.find((o) => o.id === 'option-b')).toMatchObject({ issues: ['issue-1', 'issue-2'], inferredIssues: false });
  });

  it('stages two close, complementary options, cheaper and broader first', () => {
    const report = withReport((md) => md.replace('課題1・2に対応する。難易度は高。投資は高。', '課題2に対応する。難易度は低。投資は低。'));
    const inputs = emptyDecisionInputs();
    inputs.options = { 'option-a': { effect: 4 }, 'option-b': { effect: 4 } };
    const solution = buildDrafts(report, inputs, 'ja').decisions.find((d) => d.id === 'solution')!;
    expect(solution.recommended).toBe('option-a>option-b');
    expect(solution.options[0]!.label).toBe('A を先行し、B を次の段階で');
    expect(solution.reasons.join(' ')).toContain('補い合います');
    const body = buildReportRequirements(report, inputs, 'ja').sections.find((s) => s.id === 'solution')!.body;
    expect(body).toContain('【推定】 A. 承認ルールの見直し（第 1 段階）→ B. 顧客データ基盤（第 2 段階）');
    expect(body).toContain('対応する課題: 課題 1, 課題 2');
  });

  it('sizes the trial from the gate simulation and redesigns when no size reaches 80%', () => {
    const { report } = parsed();
    const size = (inputs = emptyDecisionInputs()) => buildDrafts(report, inputs, 'ja').decisions.find((d) => d.id === 'sampleSize')!;
    expect(size()).toMatchObject({ recommended: 'redesign', confidence: 'low' });
    const inputs = emptyDecisionInputs();
    inputs.gate = { effect: { low: 0.4, mode: 0.5, high: 0.6 }, cv: 0.3 };
    expect(size(inputs).recommended).toMatch(/^n-\d+$/);
    expect(size(inputs).confidence).toBe('medium');
  });

  it('uses the user choice over the recommendation and stops marking it as inferred', () => {
    const { report } = parsed();
    const gap = report.gaps[0]!.id;
    const base = buildReportRequirements(report, emptyDecisionInputs(), 'en');
    const inputs = emptyDecisionInputs();
    inputs.choices = { [`reqIssue:${gap}`]: 'none', [`reqType:${gap}`]: 'business', 'falsifier:issue-2': 'unknown-option' };
    const chosen = buildReportRequirements(report, inputs, 'en');
    const body = Object.fromEntries(chosen.sections.map((s) => [s.id, s.body]));
    expect(body.trace).toMatch(/\| REQ-01 \| Requirement \| .+ \| — \| \d+ \|/);
    expect(body.requirements).toContain('Type: Business requirement');
    expect(body.requirements).not.toContain('[INFERRED] Business requirement');
    expect(body.decisions).toContain('chose differently from the recommendation (Issue 1)');
    expect(body.decisions).toContain('recommendation confirmed');
    expect(chosen.toConfirm).toBe(base.toConfirm - 2);
    expect(resolve(chosen.decisions.find((d) => d.id === 'falsifier:issue-2')!, inputs).origin).toBe('inferred');
  });
});
