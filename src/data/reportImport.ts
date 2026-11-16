import type { DecisionReport, ReportEvidence, ReportStep } from './extensionSchemas.ts';

/**
 * FR-321: read a Microsoft 365 Copilot business analysis report (Markdown) into `extensions.decisionReport`
 * deterministically: no AI, no translation, no scores or numbers that the report does not state.
 * Every paragraph is kept with its line number; structured lists (issues, gaps, options, roadmap, KPIs, risks,
 * open questions, assumptions, SWOT, evidence-labelled claims) are recognised from headings, bold lead-ins,
 * tables and the report's evidence labels, and point back to their lines.
 */

const LABEL_RE = /【(事実|外部|仮説|解釈|要確認|提案目標)】|\[(fact|external|hypothesis|interpretation|to confirm|needs confirmation|proposed target)\]/gi;
const LABELS: Record<string, ReportEvidence> = {
  事実: 'fact', 外部: 'external', 仮説: 'hypothesis', 解釈: 'interpretation', 要確認: 'toConfirm', 提案目標: 'proposedTarget',
  fact: 'fact', external: 'external', hypothesis: 'hypothesis', interpretation: 'interpretation',
  'to confirm': 'toConfirm', 'needs confirmation': 'toConfirm', 'proposed target': 'proposedTarget',
};

/** Section headings a Copilot business report uses; three or more make a document a report. */
const REPORT_HEADINGS = [
  /executive summary|エグゼクティブ/i, /as-?is|現状分析/i, /key issues|主要課題|^\d*\.?\s*課題/i, /to-?be|あるべき姿/i,
  /gap analysis|ギャップ/i, /strategic options|戦略オプション|^\d*\.?\s*オプション/i, /recommendation|推奨/i, /appendix|付録/i,
];

const STEP_RULES: [RegExp, ReportStep][] = [
  [/executive summary|エグゼクティブ|scope|methodology|分析範囲|分析手法|チェックリスト|checklist/i, 'overview'],
  [/appendix|付録/i, 'appendix'],
  [/to-?be|あるべき|gap|ギャップ/i, 'tobe'],
  [/as-?is|現状|business|operation|業務概要|key issues|課題/i, 'asis'],
  [/option|オプション|選択肢/i, 'solution'],
  [/\bkpi|指標/i, 'kpi'],
  [/recommend|推奨|roadmap|ロードマップ|実行計画/i, 'deliverable'],
];

export interface ReportImport {
  report: DecisionReport;
  /** The pack part: the report's source entity and the extensions it fills. */
  part: Record<string, unknown>;
  /** Company from the report's target line, used only when no other part names the company. */
  company: { name: { ja: string; en: string }; industry: { ja: string; en: string } } | null;
}

interface Block { line: number; raw: string; kind: 'text' | 'item' | 'row'; cells?: string[] }
interface Section { id: string; line: number; level: number; title: string; step: ReportStep; parent: Section | null; blocks: Block[]; tables: Block[][]; purpose?: string }

const clean = (s: string) => s.replace(/\*\*|__/g, '').replace(/(^|\s)\*(\S[^*]*\S|\S)\*(?=\s|$|[、。,.])/g, '$1$2').replace(/\s+/g, ' ').trim();
const stripLabels = (s: string) => s.replace(LABEL_RE, '').replace(/\s+/g, ' ').trim();
const labelsIn = (s: string): ReportEvidence[] => [...s.matchAll(LABEL_RE)].map((m) => LABELS[(m[1] ?? m[2] ?? '').toLowerCase()] ?? LABELS[m[1] ?? '']).filter((x): x is ReportEvidence => !!x);

/** Sentences of a paragraph (Japanese 。！？ or English . ! ? followed by a space). */
export function sentencesOf(text: string): string[] {
  const out = text.match(/[^。！？]+(?:[。！？]+|$)/g) ?? [];
  return out.flatMap((s) => (/[。！？]/.test(s) ? [s] : s.split(/(?<=[.!?])\s+(?=[A-Z【[])/))).map((s) => s.trim()).filter(Boolean);
}

const LEVEL: Record<string, number> = { 高: 3, 中: 2, 低: 1, high: 3, medium: 2, low: 1 };
/** "高" → 3, "中〜高" → 2.5, "low to medium" → 1.5; undefined when the text states no level. */
export function levelOf(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /(高|中|低|high|medium|low)(?:\s*(?:〜|～|~|-|–|to)\s*(高|中|低|high|medium|low))?/i.exec(text);
  if (!m) return undefined;
  const a = LEVEL[m[1]!.toLowerCase()] ?? LEVEL[m[1]!]!;
  const b = m[2] ? LEVEL[m[2].toLowerCase()] ?? LEVEL[m[2]]! : a;
  return (a + b) / 2;
}

/** FNV-1a: a short, stable id for the report file (not a security hash). */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function looksLikeReport(text: string): boolean {
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1]!);
  if (!headings.length) return false;
  return REPORT_HEADINGS.filter((re) => headings.some((h) => re.test(h))).length >= 3;
}

function stepOf(title: string, level: number, parent: Section | null): ReportStep {
  if (level === 1) return 'overview';
  if (level >= 3 && parent) return /\bkpi|主要指標/i.test(title) ? 'kpi' : parent.step;
  return STEP_RULES.find(([re]) => re.test(title))?.[1] ?? 'overview';
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => clean(c));
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  const stack: Section[] = [];
  let current: Section | null = null;
  let para: Block | null = null;
  let table: Block[] | null = null;
  const flush = () => {
    if (para && current) current.blocks.push(para);
    para = null;
  };
  const endTable = () => {
    if (table && current) current.tables.push(table);
    table = null;
  };
  lines.forEach((raw, i) => {
    const line = i + 1;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) {
      flush();
      endTable();
      const level = h[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      const parent = stack[stack.length - 1] ?? null;
      const title = clean(h[2]!);
      current = { id: `s-${line}`, line, level, title, step: stepOf(title, level, parent), parent, blocks: [], tables: [] };
      sections.push(current);
      stack.push(current);
      return;
    }
    if (!current) return;
    if (!raw.trim()) {
      flush();
      endTable();
      return;
    }
    if (/^\s*\|/.test(raw)) {
      flush();
      const cells = splitRow(raw);
      if (cells.every((c) => /^:?-+:?$/.test(c))) return;
      const row: Block = { line, raw: cells.join(' | '), kind: 'row', cells };
      (table ??= []).push(row);
      current.blocks.push(row);
      return;
    }
    endTable();
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (item) {
      flush();
      current.blocks.push({ line, raw: item[1]!, kind: 'item' });
      return;
    }
    if (para) para.raw += ` ${raw.trim()}`;
    else para = { line, raw: raw.trim(), kind: 'text' };
  });
  flush();
  endTable();
  return sections;
}

const within = (s: Section, re: RegExp): boolean => {
  for (let p: Section | null = s; p; p = p.parent) if (re.test(p.title)) return true;
  return false;
};
const textOf = (s: Section) => s.blocks.filter((b) => b.kind !== 'row').map((b) => clean(b.raw)).join(' ');
const pick = (sentences: string[], re: RegExp) => {
  const hit = sentences.filter((s) => re.test(stripLabels(s)));
  return hit.length ? hit.map(stripLabels).join(' ') : undefined;
};
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** `accessedDate` is the day the report was read into BAS (YYYY-MM-DD); the report's own 分析基準日 stays in `asOf`. */
export function parseDecisionReport(name: string, text: string, accessedDate: string = new Date().toISOString().slice(0, 10)): ReportImport | null {
  if (!looksLikeReport(text)) return null;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sections = parseSections(lines);
  const top = sections.find((s) => s.level === 1) ?? sections[0]!;
  const lang: 'ja' | 'en' = /[\u3040-\u30ff\u4e00-\u9fff]/.test(text) ? 'ja' : 'en';
  const sourceId = `source-report-${fnv(text)}`;

  const report: DecisionReport = {
    format: 'm365-copilot-report/1', title: top.title, lang, sourceId,
    sections: [], paragraphs: [], claims: [], issues: [], gaps: [], options: [], roadmap: [], kpis: [], risks: [], openQuestions: [], assumptions: [],
  };

  // Front matter: subtitle (italic line) and the "as of / target / positioning" line under the title.
  for (const b of top.blocks) {
    const t = clean(b.raw);
    if (!report.subtitle && /^\*[^*]/.test(b.raw.trim())) report.subtitle = t;
    const asOf = /(?:分析基準日|基準日|as of)\s*[：:]\s*(\d{4})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})/i.exec(t);
    if (asOf) report.asOf = `${asOf[1]}-${asOf[2]!.padStart(2, '0')}-${asOf[3]!.padStart(2, '0')}`;
    const target = /(?:対象|target)\s*[：:]\s*(.+?)(?=\s+(?:位置づけ|positioning|分析基準日|as of)\s*[：:]|$)/i.exec(t);
    if (target && !report.target) report.target = target[1]!.trim();
    const pos = /(?:位置づけ|positioning)\s*[：:]\s*(.+)$/i.exec(t);
    if (pos && !report.positioning) report.positioning = pos[1]!.trim();
  }

  const issueRe = /^(?:課題|issue)\s*(\d+)\s*[：:．.]\s*(.+?)\s*(?:[（(]\s*(?:優先度|priority)\s*[：:]\s*([^）)]+)[）)])?\s*$/i;
  const optionRe = /^(?:オプション|option)\s*([A-Z0-9]+)\s*[：:]\s*(.+?)\s*(?:[（(]\s*(?:優先度|priority)\s*[：:]\s*([^）)]+)[）)])?\s*$/i;
  const swotRe = /^\*\*\s*(strengths?|weaknesses?|opportunit(?:y|ies)|threats?)/i;

  for (const s of sections) {
    let sentenceCount = 0;
    for (const b of s.blocks) {
      const t = clean(b.raw);
      if (!t) continue;
      report.paragraphs.push({ line: b.line, sectionId: s.id, text: t });
      if (b.kind === 'row') continue;
      if (/^(?:実施目的|purpose)\s*[：:]/i.test(t)) {
        const purpose = /^(?:実施目的|purpose)\s*[：:]\s*(.+?)(?=\s+(?:使用する主なインプット|inputs?)\s*[：:]|$)/i.exec(t);
        if (purpose) s.purpose = purpose[1]!.trim();
        continue;
      }
      let run: ReportEvidence | null = null;
      sentencesOf(t).forEach((sentence, k) => {
        sentenceCount++;
        const found = labelsIn(sentence);
        // The legend that defines the labels ("【事実】【仮説】【要確認】は…") is not itself a claim.
        if (new Set(found).size >= 3) return;
        const lead = /^\s*(?:【[^】]+】|\[[^\]]+\])/.test(sentence);
        const evidence = found[0] ?? run;
        if (found.length && lead) run = found[0]!;
        const body = stripLabels(sentence);
        if (evidence && body) report.claims.push({ id: `c-${b.line}-${k + 1}`, line: b.line, sectionId: s.id, evidence, text: body });
      });
    }
    report.sections.push(compact({ id: s.id, line: s.line, level: s.level, title: s.title, step: s.step, purpose: s.purpose, sentences: sentenceCount }));

    const body = s.blocks.filter((b) => b.kind === 'text');
    const issue = s.level >= 3 ? issueRe.exec(s.title) : null;
    if (issue) {
      const text = textOf(s);
      const ss = sentencesOf(text);
      report.issues.push(compact({
        id: `issue-${issue[1]}`, line: s.line, title: issue[2]!.trim(), priority: levelOf(issue[3]),
        phenomenon: pick(ss, /^現象|phenomenon|symptom/i),
        rootCause: pick(ss, /根本原因|root cause/i),
        impact: pick(ss, /^影響は|^影響として|^(?:the )?impact/i),
        falsifier: pick(ss, /反証条件|falsif|would (?:disprove|refute)/i),
        evidence: [...new Set(labelsIn(text))],
        text: stripLabels(text),
      }));
    }
    const option = s.level >= 3 ? optionRe.exec(s.title) : null;
    if (option) {
      const text = textOf(s);
      const ss = sentencesOf(text);
      const after = (re: RegExp) => {
        const hit = ss.map(stripLabels).find((x) => re.test(x));
        if (!hit) return undefined;
        return levelOf(hit.slice(hit.search(re)).replace(/^[^は：:]*[は：:]/, '').slice(0, 12));
      };
      report.options.push(compact({
        id: `option-${option[1]!.toLowerCase()}`, line: s.line, label: option[1]!, title: option[2]!.trim(), priority: levelOf(option[3]),
        effect: pick(ss, /期待効果|expected (?:effect|benefit|impact)/i),
        difficulty: after(/難易度|difficulty/i),
        investment: after(/投資(?:は|が)|investment (?:is|are)/i) ?? after(/難易度と投資|difficulty and investment/i),
        risk: pick(ss, /^リスクは|リスクは|^(?:the )?risks? (?:is|are)/i),
        text: stripLabels(text),
      }));
    }
    if (s.level >= 4 && within(s, /roadmap|ロードマップ/i)) {
      const ss = sentencesOf(textOf(s));
      report.roadmap.push(compact({
        id: `phase-${s.line}`, line: s.line, title: s.title,
        actions: pick(ss, /^実行施策|^actions?\b/i), purpose: pick(ss, /^目的は|^(?:the )?purpose/i),
        owners: pick(ss, /^主担当|^owners?\b/i), deliverables: pick(ss, /^成果物|^deliverables?\b/i), kpis: pick(ss, /^KPIは|^KPIs?\b/i),
      }));
    }
    if (within(s, /gap analysis|ギャップ|^\d*\.?\s*gap\b/i)) {
      for (const b of body) {
        const lead = /^\*\*(.+?)[。.:：]?\*\*\s*(.*)$/.exec(b.raw.trim());
        if (!lead) continue;
        const ss = sentencesOf(clean(lead[2]!));
        const pr = pick(ss, /^優先度|^priority/i);
        report.gaps.push(compact({
          id: `gap-${b.line}`, line: b.line, area: clean(lead[1]!).replace(/[。.]$/, ''),
          asIs: pick(ss, /^as-?is/i), toBe: pick(ss, /^to-?be/i), gap: pick(ss, /^gapは|^gap\b|^the gap/i),
          action: pick(ss, /打ち手|^actions?\b|^(?:the )?remedy/i), priority: levelOf(pr?.replace(/^[^は：:]*[は：:]/, '')),
        }));
      }
    }
    for (const b of body) {
      const m = swotRe.exec(b.raw.trim());
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const bucket = key.startsWith('s') ? 'strengths' : key.startsWith('w') ? 'weaknesses' : key.startsWith('o') ? 'opportunities' : 'threats';
      report.swot ??= { strengths: [], weaknesses: [], opportunities: [], threats: [] };
      const rest = clean(b.raw.trim().replace(/^\*\*.+?\*\*/, ''));
      report.swot[bucket].push(...sentencesOf(rest).map(stripLabels).filter(Boolean));
    }
    for (const table of s.tables) {
      const [head, ...rows] = table;
      const cols = head!.cells!;
      const col = (re: RegExp) => cols.findIndex((c) => re.test(c));
      const kpiCol = col(/^kpi/i);
      if (kpiCol >= 0 && !/時間軸|horizon|phase/i.test(cols[0] ?? '')) {
        const cat = col(/区分|category|area/i);
        const def = col(/定義|definition/i);
        for (const r of rows) {
          const names = (r.cells![kpiCol] ?? '').split(/[、,;；]\s*/).map((x) => x.trim()).filter(Boolean);
          names.forEach((n, k) => report.kpis.push(compact({
            id: `kpi-${r.line}-${k + 1}`, line: r.line, name: n,
            category: cat >= 0 ? r.cells![cat] || undefined : undefined, definition: def >= 0 ? r.cells![def] || undefined : undefined,
          })));
        }
      }
      if (/リスク|risk/i.test(cols[0] ?? '')) {
        const desc = col(/内容|description|detail/i);
        const mit = col(/対応|mitigation|response|対策/i);
        for (const r of rows) {
          if (!r.cells![0]) continue;
          report.risks.push(compact({
            id: `risk-${r.line}`, line: r.line, name: r.cells![0],
            description: desc >= 0 ? r.cells![desc] || undefined : undefined, mitigation: mit >= 0 ? r.cells![mit] || undefined : undefined,
          }));
        }
      }
    }
    if (/追加確認|確認が必要|要確認|open questions?|questions to (?:confirm|verify)/i.test(s.title)) {
      for (const b of s.blocks.filter((x) => x.kind === 'item')) report.openQuestions.push({ id: `q-${b.line}`, line: b.line, text: stripLabels(clean(b.raw)) });
    }
    if (/前提|assumptions?/i.test(s.title)) {
      for (const b of s.blocks.filter((x) => x.kind !== 'row')) {
        sentencesOf(clean(b.raw)).forEach((x, k) => report.assumptions.push({ id: `a-${b.line}-${k + 1}`, line: b.line, text: stripLabels(x) }));
      }
    }
  }

  const company = report.target
    ? (() => {
      const name = report.target.split(/[／/（(]|\s{2,}|　/)[0]!.trim();
      return name ? { name: { ja: name, en: name }, industry: { ja: '未記載', en: 'Not stated' } } : null;
    })()
    : null;

  const source = {
    kind: 'source', id: sourceId, world: 'digital', type: 'data',
    name: { ja: report.title, en: report.title },
    description: { ja: report.subtitle ?? report.title, en: report.subtitle ?? report.title },
    publisher: { ja: 'Microsoft 365 Copilot', en: 'Microsoft 365 Copilot' },
    locator: name,
    accessedDate,
    origin: 'm365',
    classification: 'internal', author: 'ai', sourceIds: [],
  };
  const okrKpis = report.kpis.map((k) => compact({
    id: `report-${k.id}`, name: k.name, definition: k.definition, sourceIds: [sourceId],
  }));
  const extensions: Record<string, unknown> = { decisionReport: report };
  if (okrKpis.length) extensions.okr = { kpis: okrKpis, checkedSources: [name] };
  return { report, part: { entities: [source], extensions }, company };
}

/** Lines of the report that became structured items (the rest is kept as narrative paragraphs). */
export function reportCoverage(r: DecisionReport): { paragraphs: number; structured: number; bySection: { id: string; title: string; step: ReportStep; paragraphs: number; structured: number }[] } {
  const structured = new Set<number>([
    ...r.claims, ...r.gaps, ...r.kpis, ...r.risks, ...r.openQuestions, ...r.assumptions,
  ].map((x) => x.line));
  const issueSections = new Set([...r.issues, ...r.options, ...r.roadmap].map((x) => `s-${x.line}`));
  const swot = new Set((r.swot ? Object.values(r.swot).flat() : []).map((x) => x.slice(0, 20)));
  const isStructured = (p: DecisionReport['paragraphs'][number]) =>
    structured.has(p.line) || issueSections.has(p.sectionId) || [...swot].some((x) => p.text.includes(x));
  const bySection = r.sections.map((s) => {
    const ps = r.paragraphs.filter((p) => p.sectionId === s.id);
    return { id: s.id, title: s.title, step: s.step, paragraphs: ps.length, structured: ps.filter(isStructured).length };
  });
  return { paragraphs: r.paragraphs.length, structured: r.paragraphs.filter(isStructured).length, bySection };
}
