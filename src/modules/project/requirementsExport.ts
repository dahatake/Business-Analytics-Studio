import type { Lang } from '../../i18n/core.ts';
import { translate } from '../../i18n/core.ts';
import { sectionKey, type SolutionDoc } from './solutionDocs.ts';
import { REQ_PRIORITIES, REQ_STATUSES, type ChangeRecord, type LedgerEntry, type RequirementExtras } from './requirementsModel.ts';
import { checkRequirementLine } from './requirementQuality.ts';

/**
 * The requirement ledger of one solution (IPA requirements handbook table 9) as rows, and its exchange formats: CSV for
 * spreadsheets and ReqIF for requirements tools (handbook 11.6). The text of a requirement comes from the document;
 * priority, status and verification come from the ledger, where a person's entry wins over the default.
 */

export interface LedgerRow {
  id: string;
  section: string;
  text: string;
  source: string;
  priority: string;
  status: string;
  verification: string;
  author: string;
  updatedAt: string;
  warnings: string[];
}

export function ledgerRows(doc: SolutionDoc, data: Pick<RequirementExtras, 'ledger'>, lang: Lang): LedgerRow[] {
  const entries: Record<string, LedgerEntry> = data.ledger?.[doc.solutionId] ?? {};
  return doc.items.map((item) => {
    const e = entries[item.id];
    const issues = checkRequirementLine(item.text, lang);
    return {
      id: item.id,
      section: translate(lang, sectionKey(item.section)),
      text: item.text,
      source: item.source,
      priority: e?.priority ?? '',
      status: e?.status ?? 'candidate',
      verification: e?.verification?.trim() || item.verification,
      author: e?.by ?? '',
      updatedAt: e?.at ?? '',
      warnings: issues.map((i) => i.code),
    };
  });
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvLine = (cells: string[]) => cells.map(csvCell).join(',');

export function ledgerCsv(rows: LedgerRow[], lang: Lang): string {
  const head = lang === 'ja'
    ? ['要求ID', '節', '要求文', '発生源', '優先度', '状態', '検証方法', '更新者', '更新日時', '品質の指摘']
    : ['ID', 'Section', 'Requirement', 'Source', 'Priority', 'Status', 'Verification', 'Updated by', 'Updated at', 'Quality warnings'];
  return `\uFEFF${[head, ...rows.map((r) => [r.id, r.section, r.text, r.source, r.priority, r.status, r.verification, r.author, r.updatedAt, r.warnings.join(' ')])].map(csvLine).join('\r\n')}\r\n`;
}

export function changesCsv(changes: ChangeRecord[], lang: Lang): string {
  const head = lang === 'ja'
    ? ['日時', '対象', '変更内容', '理由', '影響', '承認者', '記録者']
    : ['At', 'Subject', 'Change', 'Reason', 'Impact', 'Approver', 'Recorded by'];
  return `\uFEFF${[head, ...changes.map((c) => [c.at, c.subject, c.summary, c.reason, c.impact, c.approver, c.by])].map(csvLine).join('\r\n')}\r\n`;
}

const xml = (v: string) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** XML names cannot hold every character of a requirement id; the id itself is kept in LONG-NAME. */
const nc = (prefix: string, id: string) => `${prefix}-${id.replace(/[^A-Za-z0-9_.-]/g, (ch) => `_${ch.codePointAt(0)!.toString(16)}_`)}`;

const ATTRS = [
  { id: 'text', name: 'ReqIF.Text', pick: (r: LedgerRow) => r.text },
  { id: 'section', name: 'Section', pick: (r: LedgerRow) => r.section },
  { id: 'source', name: 'Source', pick: (r: LedgerRow) => r.source },
  { id: 'priority', name: 'Priority', pick: (r: LedgerRow) => r.priority },
  { id: 'status', name: 'Status', pick: (r: LedgerRow) => r.status },
  { id: 'verification', name: 'Verification', pick: (r: LedgerRow) => r.verification },
] as const;

/** ReqIF 1.2 (OMG): one specification of the solution, one spec object per requirement. */
export function ledgerReqIf(rows: LedgerRow[], title: string, lang: Lang, now: Date): string {
  const at = now.toISOString();
  const types = `<SPEC-OBJECT-TYPE IDENTIFIER="sot-requirement" LAST-CHANGE="${at}" LONG-NAME="Requirement"><SPEC-ATTRIBUTES>${ATTRS.map((a) => `<ATTRIBUTE-DEFINITION-STRING IDENTIFIER="ad-${a.id}" LAST-CHANGE="${at}" LONG-NAME="${a.name}"><TYPE><DATATYPE-DEFINITION-STRING-REF>dt-string</DATATYPE-DEFINITION-STRING-REF></TYPE></ATTRIBUTE-DEFINITION-STRING>`).join('')}</SPEC-ATTRIBUTES></SPEC-OBJECT-TYPE>`;
  const objects = rows.map((r) => `<SPEC-OBJECT IDENTIFIER="${nc('so', r.id)}" LAST-CHANGE="${r.updatedAt || at}" LONG-NAME="${xml(r.id)}"><TYPE><SPEC-OBJECT-TYPE-REF>sot-requirement</SPEC-OBJECT-TYPE-REF></TYPE><VALUES>${ATTRS.map((a) => `<ATTRIBUTE-VALUE-STRING THE-VALUE="${xml(a.pick(r))}"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>ad-${a.id}</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION></ATTRIBUTE-VALUE-STRING>`).join('')}</VALUES></SPEC-OBJECT>`).join('');
  const children = rows.map((r) => `<SPEC-HIERARCHY IDENTIFIER="${nc('sh', r.id)}" LAST-CHANGE="${at}"><OBJECT><SPEC-OBJECT-REF>${nc('so', r.id)}</SPEC-OBJECT-REF></OBJECT></SPEC-HIERARCHY>`).join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<REQ-IF xmlns="http://www.omg.org/spec/ReqIF/20110401/reqif.xsd" xml:lang="${lang}">`,
    `<THE-HEADER><REQ-IF-HEADER IDENTIFIER="header"><CREATION-TIME>${at}</CREATION-TIME><REQ-IF-TOOL-ID>Business Analytics Studio</REQ-IF-TOOL-ID><REQ-IF-VERSION>1.0</REQ-IF-VERSION><SOURCE-TOOL-ID>Business Analytics Studio</SOURCE-TOOL-ID><TITLE>${xml(title)}</TITLE></REQ-IF-HEADER></THE-HEADER>`,
    `<CORE-CONTENT><REQ-IF-CONTENT><DATATYPES><DATATYPE-DEFINITION-STRING IDENTIFIER="dt-string" LAST-CHANGE="${at}" LONG-NAME="String" MAX-LENGTH="32000"/></DATATYPES>`,
    `<SPEC-TYPES>${types}<SPECIFICATION-TYPE IDENTIFIER="st-document" LAST-CHANGE="${at}" LONG-NAME="Document"/></SPEC-TYPES>`,
    `<SPEC-OBJECTS>${objects}</SPEC-OBJECTS>`,
    `<SPECIFICATIONS><SPECIFICATION IDENTIFIER="specification" LAST-CHANGE="${at}" LONG-NAME="${xml(title)}"><TYPE><SPECIFICATION-TYPE-REF>st-document</SPECIFICATION-TYPE-REF></TYPE><CHILDREN>${children}</CHILDREN></SPECIFICATION></SPECIFICATIONS>`,
    '</REQ-IF-CONTENT></CORE-CONTENT>',
    '</REQ-IF>',
  ].join('\n');
}

export { REQ_PRIORITIES, REQ_STATUSES };
