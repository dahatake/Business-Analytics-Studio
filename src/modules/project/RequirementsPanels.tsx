import { useMemo, useRef, useState } from 'react';
import { Badge, Button, Field, Input, Select, Textarea } from '@fluentui/react-components';
import { ArrowDownload20Regular, Delete20Regular, DocumentArrowUp20Regular, Search20Regular } from '@fluentui/react-icons';
import { getEntity } from '../../data/pack.ts';
import { EVIDENCE_KINDS, RULE_KINDS, VOICE_KINDS, isVoiceKind, type EvidenceKind } from '../../data/extensionSchemas.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import type { WorkIqAspect } from '../ai/relayClient.ts';
import { downloadText, ScrollRegion, useTargetNames } from './common.tsx';
import { rankedIssues, threadOf, type AppCheckContext as CheckContext } from './deliverables.ts';
import { evidenceViews } from './docInputs.ts';
import { parseEvidenceFile, type EvidenceFileError } from './evidenceImport.ts';
import { changesCsv, ledgerCsv, ledgerReqIf, ledgerRows } from './requirementsExport.ts';
import {
  REQ_PRIORITIES, REQ_STATUSES, addChange, addEvidence, isHiddenGem, removeChange, removeEvidence, setLedgerEntry, setSignal,
  type ReqPriority, type ReqStatus,
} from './requirementsModel.ts';
import { buildSolutionDoc, kindKey, sectionKey, type SolutionDoc } from './solutionDocs.ts';
import { by, entityName, useStrategyWriter } from './StrategyPanels.tsx';
import { errorCodeOf, useWorkIqSearch, type WorkIqFinding } from './useWorkIqSearch.ts';

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ASPECTS: WorkIqAspect[] = ['rules', 'systems', 'voice'];
const KINDS_OF: Record<'rules' | 'systems' | 'voice', readonly EvidenceKind[]> = {
  rules: RULE_KINDS.filter((k) => k !== 'system'),
  systems: ['system', 'operations'],
  voice: VOICE_KINDS,
};
const DEFAULT_KIND: Record<'rules' | 'systems' | 'voice', EvidenceKind> = { rules: 'policy', systems: 'system', voice: 'feedback' };
const SUMMARY_MAX = 2000;

/** The specifications of every solution (system kinds carry the ledger). */
function useDocs(ctx: CheckContext): SolutionDoc[] {
  const { lang } = useI18n();
  const thread = threadOf(ctx);
  return useMemo(() => thread.solutions.flatMap((ts) => {
    const s = getEntity(ts.id);
    return s?.kind === 'solution' ? [buildSolutionDoc(s, ts, thread, ctx, lang)] : [];
  }), [thread, ctx, lang]);
}

/* ---------- Evidence: rules, current systems, user voices, evaluation data ---------- */

interface Candidate {
  finding: WorkIqFinding;
  kind: EvidenceKind;
  title: string;
}

export function EvidencePanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const write = useStrategyWriter();
  const wi = useWorkIqSearch();
  const views = useMemo(() => evidenceViews(ctx.pack, ctx.strategy, lang), [ctx.pack, ctx.strategy, lang]);
  const issues = useMemo(() => ctx.pack.pack.entities.filter((e) => e.kind === 'issue'), [ctx.pack]);
  const [busy, setBusy] = useState<WorkIqAspect | null>(null);
  const [candidates, setCandidates] = useState<{ aspect: WorkIqAspect; items: Candidate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<EvidenceKind>('policy');
  const [fileError, setFileError] = useState<EvidenceFileError | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState({ kind: 'policy' as EvidenceKind, title: '', summary: '', count: '', severity: '', issueId: '' });

  const search = async (aspect: WorkIqAspect) => {
    setBusy(aspect);
    setError(null);
    setCandidates(null);
    try {
      const found = await wi.search(aspect);
      const key = aspect as 'rules' | 'systems' | 'voice';
      setCandidates({ aspect, items: found.map((f, i) => ({ finding: f, kind: DEFAULT_KIND[key], title: `${t(`sol.ev.aspect.${key}`)} ${i + 1}` })) });
    } catch (e) {
      const code = errorCodeOf(e);
      setError(code === 'confidentialNotAllowed' ? t('workiq.confidentialNotAllowed') : t('sol.ev.error', { code }));
    } finally {
      setBusy(null);
    }
  };
  const adopt = (c: Candidate, index: number) => {
    write((d) => addEvidence(d, {
      id: uid('ev'), kind: c.kind, title: c.title.trim() || c.kind, summary: c.finding.answer.slice(0, SUMMARY_MAX), origin: 'workiq',
      note: c.finding.question, citations: c.finding.citations, at: now(), by: by(),
    }));
    setCandidates((s) => (s ? { ...s, items: s.items.filter((_, i) => i !== index) } : s));
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    const parsed = parseEvidenceFile(file.name, await file.text(), fileKind, file.size, lang);
    if (fileRef.current) fileRef.current.value = '';
    if (!parsed.ok) {
      setFileError(parsed.error);
      return;
    }
    write((d) => addEvidence(d, {
      id: uid('ev'), kind: fileKind, title: parsed.value.title, summary: parsed.value.summary, origin: 'file', note: file.name, citations: [],
      ...(parsed.value.count !== undefined ? { count: parsed.value.count } : {}), ...(parsed.value.data ? { data: parsed.value.data } : {}),
      at: now(), by: by(),
    }));
  };
  const addManual = () => {
    const title = manual.title.trim();
    if (!title) return;
    const count = Number.parseInt(manual.count, 10);
    const severity = Number.parseInt(manual.severity, 10);
    write((d) => addEvidence(d, {
      id: uid('ev'), kind: manual.kind, title, summary: manual.summary.trim(), origin: 'manual', citations: [],
      ...(Number.isFinite(count) && count >= 0 ? { count } : {}), ...(severity >= 1 && severity <= 5 ? { severity } : {}),
      ...(manual.issueId && isVoiceKind(manual.kind) ? { issueId: manual.issueId } : {}), at: now(), by: by(),
    }));
    setManual((m) => ({ ...m, title: '', summary: '', count: '', severity: '' }));
  };
  const kindOptions = (list: readonly EvidenceKind[]) => list.map((k) => <option key={k} value={k}>{t(`sol.ev.kind.${k}` as MessageKey)}</option>);

  return (
    <Panel title={t('sol.ev.title')} className="span-full" testId="sol-evidence" id="sol-evidence">
      <p className="muted">{t('sol.ev.intro')}</p>

      <div className="proj-row" role="group" aria-label={t('sol.ev.search')}>
        {ASPECTS.map((a) => (
          <Button key={a} icon={<Search20Regular />} disabled={!wi.ready || busy !== null} onClick={() => void search(a)} data-testid={`sol-ev-search-${a}`}>
            {busy === a ? t('sol.ev.searching') : `${t('sol.ev.search')}: ${t(`sol.ev.aspect.${a}` as MessageKey)}`}
          </Button>
        ))}
      </div>
      <p className="muted">{wi.ready ? t('sol.ev.dataNote') : t('sol.ev.notReady')}</p>
      {error && <p role="alert" data-testid="sol-ev-error">{error}</p>}

      {candidates && (
        <div data-testid="sol-ev-candidates">
          {candidates.items.length === 0 && <p className="muted">{t('sol.ev.foundNone')}</p>}
          {candidates.items.map((c, i) => {
            const key = candidates.aspect as 'rules' | 'systems' | 'voice';
            return (
              <div key={`${c.finding.question}-${i}`} className="sol-ev-candidate">
                <Field label={t('sol.ev.found', { kind: t(`sol.ev.aspect.${key}` as MessageKey) })}>
                  <pre className="dlv-form-draft-text">{c.finding.answer.slice(0, SUMMARY_MAX)}</pre>
                </Field>
                {c.finding.citations.length > 0 && <p className="muted">{t('sol.ev.citations')}: {c.finding.citations.map((x) => x.title).join(' / ')}</p>}
                <div className="proj-row">
                  <Field label={t('sol.ev.kind')}>
                    <Select value={c.kind} onChange={(_, d) => setCandidates((s) => (s ? { ...s, items: s.items.map((x, n) => (n === i ? { ...x, kind: d.value as EvidenceKind } : x)) } : s))}>
                      {kindOptions(KINDS_OF[key])}
                    </Select>
                  </Field>
                  <Field label={t('sol.ev.titleField')}>
                    <Input value={c.title} onChange={(_, d) => setCandidates((s) => (s ? { ...s, items: s.items.map((x, n) => (n === i ? { ...x, title: d.value } : x)) } : s))} />
                  </Field>
                  <Button appearance="primary" onClick={() => adopt(c, i)} data-testid={`sol-ev-adopt-${i}`}>{t('sol.ev.adopt')}</Button>
                  <Button appearance="subtle" onClick={() => setCandidates((s) => (s ? { ...s, items: s.items.filter((_, n) => n !== i) } : s))}>{t('sol.ev.discard')}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="sol-ev-file">
        <strong>{t('sol.ev.file')}</strong>
        <p className="muted">{t('sol.ev.fileHint')}</p>
        <div className="proj-row">
          <Field label={t('sol.ev.fileKind')}>
            <Select value={fileKind} onChange={(_, d) => setFileKind(d.value as EvidenceKind)} data-testid="sol-ev-file-kind">{kindOptions(EVIDENCE_KINDS)}</Select>
          </Field>
          <Field label={t('sol.ev.fileChoose')}>
            <input ref={fileRef} type="file" aria-label={t('sol.ev.fileChoose')} accept=".txt,.md,.csv,.tsv,.json,.jsonl,.ndjson,text/plain,text/csv,application/json" onChange={(e) => void importFile(e.target.files?.[0])} data-testid="sol-ev-file" />
          </Field>
        </div>
        {fileError && <p role="alert" data-testid="sol-ev-file-error"><DocumentArrowUp20Regular /> {t(`sol.ev.fileError.${fileError}` as MessageKey)}</p>}
      </div>

      <details className="sol-ev-manual">
        <summary>{t('sol.ev.manual')}</summary>
        <div className="proj-row">
          <Field label={t('sol.ev.kind')}>
            <Select value={manual.kind} onChange={(_, d) => setManual((m) => ({ ...m, kind: d.value as EvidenceKind }))} data-testid="sol-ev-manual-kind">{kindOptions(EVIDENCE_KINDS)}</Select>
          </Field>
          <Field label={t('sol.ev.titleField')}><Input value={manual.title} onChange={(_, d) => setManual((m) => ({ ...m, title: d.value }))} data-testid="sol-ev-manual-title" /></Field>
        </div>
        <Field label={t('sol.ev.summaryField')}><Textarea value={manual.summary} onChange={(_, d) => setManual((m) => ({ ...m, summary: d.value }))} data-testid="sol-ev-manual-summary" /></Field>
        {isVoiceKind(manual.kind) && (
          <div className="proj-row">
            <Field label={t('sol.ev.count')}><Input type="number" value={manual.count} onChange={(_, d) => setManual((m) => ({ ...m, count: d.value }))} /></Field>
            <Field label={t('sol.ev.severity')}><Input type="number" value={manual.severity} onChange={(_, d) => setManual((m) => ({ ...m, severity: d.value }))} /></Field>
            <Field label={t('sol.ev.issue')}>
              <Select value={manual.issueId} onChange={(_, d) => setManual((m) => ({ ...m, issueId: d.value }))}>
                <option value="">{t('sol.ev.issueNone')}</option>
                {issues.map((i) => <option key={i.id} value={i.id}>{loc(i.name, lang)}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <Button onClick={addManual} disabled={!manual.title.trim()} data-testid="sol-ev-manual-add">{t('sol.ev.add')}</Button>
      </details>

      <h3 className="proj-h3">{t('sol.ev.list')}</h3>
      {views.length === 0 && <p className="muted">{t('sol.ev.none')}</p>}
      <ul className="sol-ev-list" data-testid="sol-ev-list">
        {views.map((e) => (
          <li key={`${e.origin}-${e.id}`} data-testid={`sol-ev-item-${e.id}`}>
            <Badge size="small" appearance="filled" color="informative">{t(`sol.ev.kind.${e.kind}` as MessageKey)}</Badge>{' '}
            <Badge size="small" appearance="outline">{t(`sol.ev.origin.${e.origin}` as MessageKey)}</Badge>{' '}
            <strong>{e.title}</strong>
            {e.count !== undefined && <span className="muted"> {t('sol.ev.rows', { n: e.count })}</span>}
            {e.summary && <span className="muted"> — {e.summary.slice(0, 160)}</span>}
            {e.sources.length > 0 && <span className="muted"> ({t('sol.ev.citations')}: {e.sources.join(' / ')})</span>}
            {e.origin !== 'pack' && (
              <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('sol.ev.removeNamed', { name: e.title })} onClick={() => write((d) => removeEvidence(d, e.id))} data-testid={`sol-ev-remove-${e.id}`} />
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ---------- Requirement ledger ---------- */

export function RequirementLedgerPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const write = useStrategyWriter();
  const names = useTargetNames();
  const docs = useDocs(ctx).filter((d) => d.items.length > 0);
  const stamp = (id: string, solutionId: string) => {
    const e = ctx.strategy.ledger?.[solutionId]?.[id];
    return e ? `${e.by || '—'} ${e.at.slice(0, 10)}` : '—';
  };
  const file = (d: SolutionDoc, ext: string) => `${names.company}-${names.project}-${entityName(d.solutionId, lang)}-${d.kind}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
  const patch = (solutionId: string, id: string, p: Parameters<typeof setLedgerEntry>[3]) => write((s) => setLedgerEntry(s, solutionId, id, p, by(), now()));
  return (
    <Panel title={t('sol.led.title')} className="span-full" testId="sol-ledger" id="sol-ledger">
      <p className="muted">{t('sol.led.intro')}</p>
      {docs.length === 0 && <p className="muted">{t('sol.led.none')}</p>}
      {docs.map((d) => {
        const rows = ledgerRows(d, ctx.strategy, lang);
        return (
          <details key={d.solutionId} className="sol-doc" data-testid={`sol-ledger-${d.solutionId}`}>
            <summary>
              <strong>{entityName(d.solutionId, lang)}</strong>{' '}
              <Badge size="small" appearance="filled" color="informative">{t(kindKey(d.kind))}</Badge>{' '}
              <Badge size="small" appearance="outline">{rows.length}</Badge>
            </summary>
            <div className="proj-row">
              <Button icon={<ArrowDownload20Regular />} onClick={() => downloadText(file(d, 'csv'), ledgerCsv(rows, lang), 'text/csv')} data-testid={`sol-ledger-csv-${d.solutionId}`}>{t('sol.led.exportCsv')}</Button>
              <Button icon={<ArrowDownload20Regular />} onClick={() => downloadText(file(d, 'reqif'), ledgerReqIf(rows, `${entityName(d.solutionId, lang)} — ${t(kindKey(d.kind))}`, lang, new Date()), 'application/xml')} data-testid={`sol-ledger-reqif-${d.solutionId}`}>{t('sol.led.exportReqIf')}</Button>
            </div>
            <ScrollRegion label={t('sol.led.title')}>
              <table className="data-table compact">
                <caption className="visually-hidden">{t('sol.led.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('sol.led.id')}</th>
                    <th scope="col">{t('sol.led.section')}</th>
                    <th scope="col">{t('sol.led.text')}</th>
                    <th scope="col">{t('sol.led.source')}</th>
                    <th scope="col">{t('sol.led.priority')}</th>
                    <th scope="col">{t('sol.led.status')}</th>
                    <th scope="col">{t('sol.led.verification')}</th>
                    <th scope="col">{t('sol.led.stamp')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-testid={`sol-led-row-${d.solutionId}-${r.id}`}>
                      <th scope="row"><code>{r.id}</code></th>
                      <td>{r.section}</td>
                      <td>
                        {r.text.slice(0, 160)}
                        {r.warnings.map((w) => <Badge key={w} size="small" appearance="tint" color="warning">{t(`sol.led.warn.${w}` as MessageKey)}</Badge>)}
                      </td>
                      <td>{r.source}</td>
                      <td>
                        <Select value={r.priority} aria-label={t('sol.led.priorityFor', { id: r.id })} onChange={(_, o) => patch(d.solutionId, r.id, { priority: (o.value || undefined) as ReqPriority | undefined })} data-testid={`sol-led-priority-${r.id}`}>
                          <option value="">{t('sol.led.unset')}</option>
                          {REQ_PRIORITIES.map((p) => <option key={p} value={p}>{t(`sol.led.priority.${p}` as MessageKey)}</option>)}
                        </Select>
                      </td>
                      <td>
                        <Select value={r.status} aria-label={t('sol.led.statusFor', { id: r.id })} onChange={(_, o) => patch(d.solutionId, r.id, { status: o.value as ReqStatus })} data-testid={`sol-led-status-${r.id}`}>
                          {REQ_STATUSES.map((s) => <option key={s} value={s}>{t(`sol.led.status.${s}` as MessageKey)}</option>)}
                        </Select>
                      </td>
                      <td>
                        <Input key={`${r.id}-${r.verification}`} defaultValue={r.verification} aria-label={t('sol.led.verificationFor', { id: r.id })} onBlur={(e) => { if (e.target.value !== r.verification) patch(d.solutionId, r.id, { verification: e.target.value }); }} data-testid={`sol-led-verification-${r.id}`} />
                      </td>
                      <td>{stamp(r.id, d.solutionId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </details>
        );
      })}
    </Panel>
  );
}

/* ---------- Change records ---------- */

export function ChangeLogPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const write = useStrategyWriter();
  const names = useTargetNames();
  const docs = useDocs(ctx);
  const [form, setForm] = useState({ solutionId: '', subject: '', summary: '', reason: '', impact: '', approver: '' });
  const solutionId = form.solutionId || docs[0]?.solutionId || '';
  const changes = ctx.strategy.changes ?? [];
  const valid = !!solutionId && !!form.subject.trim() && !!form.summary.trim() && !!form.reason.trim();
  const sections = (id: string) => docs.find((d) => d.solutionId === id)?.sections.map((s) => s.id) ?? [];
  const record = () => {
    if (!valid) return;
    write((d) => addChange(d, { id: uid('chg'), solutionId, subject: form.subject.trim(), summary: form.summary.trim(), reason: form.reason.trim(), impact: form.impact.trim(), approver: form.approver.trim(), at: now(), by: by() }));
    setForm((f) => ({ ...f, subject: '', summary: '', reason: '', impact: '', approver: '' }));
  };
  return (
    <Panel title={t('sol.chg.title')} className="span-full" testId="sol-changes" id="sol-changes">
      <p className="muted">{t('sol.chg.intro')}</p>
      <div className="proj-row">
        <Field label={t('sol.chg.solution')}>
          <Select value={solutionId} onChange={(_, d) => setForm((f) => ({ ...f, solutionId: d.value }))} data-testid="sol-chg-solution">
            {docs.map((d) => <option key={d.solutionId} value={d.solutionId}>{entityName(d.solutionId, lang)}</option>)}
          </Select>
        </Field>
        <Field label={t('sol.chg.subject')}>
          <Input list="sol-chg-subjects" value={form.subject} onChange={(_, d) => setForm((f) => ({ ...f, subject: d.value }))} data-testid="sol-chg-subject" />
          <datalist id="sol-chg-subjects">
            {[...(docs.find((d) => d.solutionId === solutionId)?.items.map((i) => i.id) ?? []), ...sections(solutionId).map((s) => t(sectionKey(s) as MessageKey))].map((v) => <option key={v} value={v} />)}
          </datalist>
        </Field>
      </div>
      <Field label={t('sol.chg.summary')}><Textarea value={form.summary} onChange={(_, d) => setForm((f) => ({ ...f, summary: d.value }))} data-testid="sol-chg-summary" /></Field>
      <Field label={t('sol.chg.reason')}><Textarea value={form.reason} onChange={(_, d) => setForm((f) => ({ ...f, reason: d.value }))} data-testid="sol-chg-reason" /></Field>
      <Field label={t('sol.chg.impact')}><Textarea value={form.impact} onChange={(_, d) => setForm((f) => ({ ...f, impact: d.value }))} data-testid="sol-chg-impact" /></Field>
      <Field label={t('sol.chg.approver')}><Input value={form.approver} onChange={(_, d) => setForm((f) => ({ ...f, approver: d.value }))} data-testid="sol-chg-approver" /></Field>
      <div className="proj-row">
        <Button appearance="primary" disabled={!valid} onClick={record} data-testid="sol-chg-add">{t('sol.chg.add')}</Button>
        <Button icon={<ArrowDownload20Regular />} disabled={changes.length === 0} onClick={() => downloadText(`${names.company}-${names.project}-changes.csv`.replace(/[\\/:*?"<>|]/g, '_'), changesCsv(changes, lang), 'text/csv')} data-testid="sol-chg-csv">{t('sol.chg.export')}</Button>
      </div>
      {changes.length === 0 && <p className="muted">{t('sol.chg.none')}</p>}
      <ul className="sol-ev-list" data-testid="sol-chg-list">
        {changes.map((c) => (
          <li key={c.id} data-testid={`sol-chg-item-${c.id}`}>
            <code>{c.subject}</code> — <strong>{c.summary}</strong>
            <span className="muted"> ({c.reason}{c.impact ? ` / ${c.impact}` : ''}{c.approver ? ` / ${c.approver}` : ''} · {c.by || '—'} {c.at.slice(0, 10)})</span>
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('sol.chg.removeNamed', { name: c.summary })} onClick={() => write((d) => removeChange(d, c.id))} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ---------- Issue frequency and severity: rare but severe issues ("光る原石") ---------- */

export function IssueSignalsPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const write = useStrategyWriter();
  const issues = rankedIssues(ctx.pack);
  const voices = useMemo(() => evidenceViews(ctx.pack, ctx.strategy, lang).filter((e) => isVoiceKind(e.kind) && e.issueId), [ctx.pack, ctx.strategy, lang]);
  const signals = ctx.strategy.signals ?? {};
  // A record needs both numbers: the first one chosen waits here until the other is chosen too.
  const [pending, setPending] = useState<Record<string, { frequency?: number | undefined; severity?: number | undefined }>>({});
  const valueOf = (id: string, key: 'frequency' | 'severity') => String(pending[id]?.[key] ?? signals[id]?.[key] ?? '');
  const choose = (id: string, key: 'frequency' | 'severity', value: string) => {
    const n = Number.parseInt(value, 10);
    if (!(n >= 1 && n <= 5)) {
      setPending((p) => ({ ...p, [id]: {} }));
      write((d) => setSignal(d, id, null, by(), now()));
      return;
    }
    const cur = signals[id];
    const next = { frequency: cur?.frequency, severity: cur?.severity, ...pending[id], [key]: n };
    setPending((p) => ({ ...p, [id]: next }));
    if (next.frequency && next.severity) write((d) => setSignal(d, id, { frequency: next.frequency!, severity: next.severity! }, by(), now()));
  };
  const levels = [1, 2, 3, 4, 5];
  const gems = issues.filter((i) => signals[i.id] && isHiddenGem(signals[i.id]!));
  return (
    <Panel title={t('sol.sig.title')} className="span-full" testId="sol-signals" id="sol-signals">
      <p className="muted">{t('sol.sig.intro')}</p>
      {gems.length > 0 && <p data-testid="sol-sig-gems"><Badge appearance="filled" color="warning">{t('sol.sig.gem')}</Badge> {gems.map((i) => loc(i.name, lang)).join(' / ')} — {t('sol.sig.gemNote')}</p>}
      <ScrollRegion label={t('sol.sig.title')}>
        <table className="data-table compact">
          <caption className="visually-hidden">{t('sol.sig.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('sol.sig.issue')}</th>
              <th scope="col">{t('sol.sig.frequency')}</th>
              <th scope="col">{t('sol.sig.severity')}</th>
              <th scope="col">{t('sol.sig.voices')}</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((i) => {
              const s = signals[i.id];
              const name = loc(i.name, lang);
              const related = voices.filter((v) => v.issueId === i.id);
              return (
                <tr key={i.id} data-testid={`sol-sig-row-${i.id}`}>
                  <th scope="row">{name} {s && isHiddenGem(s) && <Badge size="small" appearance="filled" color="warning">{t('sol.sig.gem')}</Badge>}</th>
                  <td>
                    <Select value={valueOf(i.id, 'frequency')} aria-label={t('sol.sig.frequencyFor', { name })} onChange={(_, o) => choose(i.id, 'frequency', o.value)} data-testid={`sol-sig-frequency-${i.id}`}>
                      <option value="">{t('sol.sig.unset')}</option>
                      {levels.map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  </td>
                  <td>
                    <Select value={valueOf(i.id, 'severity')} aria-label={t('sol.sig.severityFor', { name })} onChange={(_, o) => choose(i.id, 'severity', o.value)} data-testid={`sol-sig-severity-${i.id}`}>
                      <option value="">{t('sol.sig.unset')}</option>
                      {levels.map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  </td>
                  <td>{related.length ? related.map((v) => `${v.title}${v.count !== undefined ? ` (${v.count})` : ''}`).join(' / ') : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
    </Panel>
  );
}
