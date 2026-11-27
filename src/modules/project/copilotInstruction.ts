import { translate, type Lang } from '../../i18n/core.ts';
import { appendAiPromptSuffix } from '../../ai/promptSuffix.ts';
import { chosenAttachments, kindKey, sectionKey, solutionDocMarkdown, TO_FILL, type AttachmentCandidate, type SolutionDoc } from './solutionDocs.ts';
import type { ZipEntry } from './zipFiles.ts';

/**
 * The hand-off for software-solvable work. A prompt solution becomes an instruction sheet for Microsoft 365 Copilot: the
 * prompt to paste, the files to attach (built from project data), and how to check the answer. Applications and AI agents
 * become their requirements definition / specification. The shared instruction is appended to the approved prompt.
 */

type Bi = { ja: string; en: string };
const BOM = '\uFEFF';
export const safeName = (text: string) => text.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 80) || 'untitled';

const sectionText = (doc: SolutionDoc, id: string) => doc.sections.find((s) => s.id === id)?.text.trim() ?? '';

/** The prompt section is written (no "to fill" left) — the sheet can be used. */
export const instructionReady = (doc: SolutionDoc) => doc.kind === 'promptSpec' && !!sectionText(doc, 'copilotPrompt') && !sectionText(doc, 'copilotPrompt').includes(TO_FILL.ja) && !sectionText(doc, 'copilotPrompt').includes(TO_FILL.en);

export function instructionFiles(doc: SolutionDoc, title: string, candidates: AttachmentCandidate[], lang: Lang, folder = ''): ZipEntry[] {
  const L = (b: Bi) => b[lang];
  const sec = (id: string) => translate(lang, sectionKey(id));
  const prompt = appendAiPromptSuffix(sectionText(doc, 'copilotPrompt'));
  const files = chosenAttachments(sectionText(doc, 'copilotAttachments'), candidates);
  const open = doc.sections.filter((s) => s.open).length;
  const at = (name: string) => `${folder}${name}`;
  const readme = [
    `# ${title} — ${L({ ja: 'Microsoft 365 Copilot 指示書', en: 'Microsoft 365 Copilot instructions' })}`,
    '',
    open
      ? L({ ja: `状態: 未完成（【要記入】が ${open} 節に残っています。使う前に仕様書を確認してください）`, en: `Status: incomplete ([TO FILL] remains in ${open} sections; review the specification before use)` })
      : L({ ja: '状態: 全節が記入済み', en: 'Status: every section is filled' }),
    '',
    `## ${L({ ja: '手順', en: 'Steps' })}`,
    '',
    L({ ja: '1. Microsoft 365 Copilot（Copilot Chat）を職場アカウントで開く。', en: '1. Open Microsoft 365 Copilot (Copilot Chat) with your work account.' }),
    files.length
      ? L({ ja: `2. attachments フォルダーの ${files.length} ファイルを添付する。`, en: `2. Attach the ${files.length} files in the attachments folder.` })
      : L({ ja: '2. 添付ファイルはありません。', en: '2. There are no attachments.' }),
    L({ ja: '3. prompt.txt の全文を貼り付けて送信する。', en: '3. Paste the whole of prompt.txt and send it.' }),
    L({ ja: '4. 下の「確認の手順」と「評価」に従って出力を確かめる。添付にない数値・社名・出典が出たら採用しない。', en: '4. Check the output with the review procedure and evaluation below. Do not use numbers, names or sources that are not in the attachments.' }),
    L({ ja: '5. 結果と、使ったプロンプトの版を記録する（版と承認の節）。', en: '5. Record the result and the prompt version used (see the version section).' }),
    '',
    `## ${sec('copilotPrompt')}`,
    '',
    '```text',
    prompt,
    '```',
    '',
    `## ${sec('copilotAttachments')}`,
    '',
    files.length ? files.map((f) => `- attachments/${f.file} — ${f.description}`).join('\n') : '—',
    '',
    ...['reviewProcedure', 'promptEval', 'acceptance', 'promptVersion'].flatMap((id) => [`## ${sec(id)}`, '', sectionText(doc, id) || '—', '']),
  ].join('\n');
  return [
    { name: at(L({ ja: '指示書.md', en: 'instructions.md' })), content: readme },
    { name: at('prompt.txt'), content: prompt },
    ...files.map((f) => ({ name: at(`attachments/${f.file}`), content: f.file.endsWith('.csv') ? BOM + f.content : f.content })),
    { name: at(`${safeName(title)}.md`), content: solutionDocMarkdown(doc, title, lang) },
  ];
}

export interface BundleItem {
  name: string;
  doc: SolutionDoc;
  candidates: AttachmentCandidate[];
  system: boolean;
}

/**
 * All software-solvable work in one archive: per solution a folder with its requirements definition (application),
 * specification (AI agent) or Microsoft 365 Copilot instruction sheet (prompt), and an index of what is included and
 * what is not (business changes without software, documents still open).
 */
export function systemBundle(items: BundleItem[], heading: string, lang: Lang): ZipEntry[] {
  const L = (b: Bi) => b[lang];
  const entries: ZipEntry[] = [];
  const rows: string[] = [];
  let n = 0;
  for (const item of items) {
    const kind = translate(lang, kindKey(item.doc.kind));
    const open = item.doc.sections.filter((s) => s.open).length;
    const state = open ? L({ ja: `【要記入】${open} 節`, en: `${open} sections to fill` }) : L({ ja: '記入済み', en: 'filled' });
    if (!item.system) {
      rows.push(`| — | ${item.name} | ${kind} | ${L({ ja: 'ソフトウェア以外の変更のため対象外', en: 'not software; not included' })} |`);
      continue;
    }
    n += 1;
    const folder = `${String(n).padStart(2, '0')}-${safeName(item.name)}/`;
    const title = `${item.name} — ${kind}`;
    if (item.doc.kind === 'promptSpec') entries.push(...instructionFiles(item.doc, title, item.candidates, lang, folder));
    else entries.push({ name: `${folder}${safeName(kind)}.md`, content: solutionDocMarkdown(item.doc, title, lang) });
    rows.push(`| ${folder} | ${item.name} | ${kind} | ${state} |`);
  }
  const index = [
    `# ${heading}`,
    '',
    L({ ja: 'ソフトウェアで解決する部分の成果物です。アプリは要求定義書、AI エージェントは仕様書、プロンプトは Microsoft 365 Copilot の指示書（プロンプト・添付データ・確認の手順）を含みます。', en: 'Deliverables for the software-solvable work: a requirements definition for applications, a specification for AI agents, and a Microsoft 365 Copilot instruction sheet (prompt, attachments, review) for prompts.' }),
    '',
    L({ ja: '| フォルダー | 解決策 | 成果物 | 状態 |', en: '| Folder | Solution | Deliverable | Status |' }),
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
  return [{ name: 'README.md', content: index }, ...entries];
}
