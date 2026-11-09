import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Textarea,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular, ArrowUpload20Regular, Copy20Regular, Delete20Regular, Dismiss16Regular, DocumentCheckmark20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { basePack, loaded, packOrigin } from '../../data/pack.ts';
import type { EntityKind } from '../../data/schema.ts';
import {
  analyzeImport, buildFixPrompt, isReadableFile, MAX_PACK_FILE_BYTES, type FileReport, type ImportAnalysis, type InputDoc,
} from '../../data/packImport.ts';
import { deleteImportedPack, importedPackMeta, saveImportedPack } from '../../data/packStore.ts';
import { useI18n } from '../../i18n/index.ts';
import { MAX_PROJECTS_PER_COMPANY, useActiveProject, useProjects } from '../../state/projects.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { BackToHome, ConfirmDialog, downloadText, ScrollRegion } from './common.tsx';
import { copilotPrompt, PROMPT_DOC } from './packPrompt.ts';
import { yyyymmdd } from './exportFormat.ts';
import './project.css';

/** Shown once after the reload that activates a newly imported pack. */
const JUST_IMPORTED_KEY = 'bas.pack.justImported';
const KIND_ORDER: EntityKind[] = ['source', 'site', 'person', 'customer', 'product', 'deal', 'deliverable', 'invoice', 'issue', 'cause', 'solution', 'kpi', 'initiative', 'supplier'];
const MAX_PROBLEM_ROWS = 200;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Data management (FR-302〜FR-304): the customer pack each project works on. Shows the active pack, offers the
 * Microsoft 365 Copilot prompt that turns customer files into a pack, and imports Copilot's answer into the
 * current project after the same checks as `bas verify` and a human check. Import is all or nothing.
 */
export function PackDataScreen() {
  const { t } = useI18n();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem(JUST_IMPORTED_KEY);
    if (!raw) return;
    sessionStorage.removeItem(JUST_IMPORTED_KEY);
    setNotice(raw);
  }, []);

  return (
    <div className="screen proj-screen pack-screen">
      <PageHeader title={t('proj.pack.title')} subtitle={t('proj.pack.subtitle')} actions={<BackToHome />} />
      {notice && (
        <MessageBar intent="success" className="span-full" role="status" data-testid="pack-imported-notice">
          <MessageBarBody>{t('proj.pack.importedNotice', { name: notice })}</MessageBarBody>
        </MessageBar>
      )}
      <CurrentPackPanel />
      <PromptPanel />
      <ImportPanel />
    </div>
  );
}

function CurrentPackPanel() {
  const { t, tx, fmt } = useI18n();
  const target = useProjects((s) => s.target);
  const { project, company } = useActiveProject();
  const [confirm, setConfirm] = useState(false);
  const meta = packOrigin.kind === 'imported' ? importedPackMeta(packOrigin.projectId) : null;
  const counts = useMemo(() => {
    const c = new Map<EntityKind, number>();
    for (const e of loaded.pack.entities) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
    return KIND_ORDER.filter((k) => c.has(k)).map((k) => [k, c.get(k)!] as const);
  }, []);
  const targetName = target.kind === 'demo' || !project ? t('proj.pack.demoTarget') : `${company?.name ?? ''}-${project.name}`;
  const origin = packOrigin.kind === 'imported'
    ? t('proj.pack.origin.imported', { date: meta ? fmt.date(meta.importedAt.slice(0, 10)) : '—', files: meta?.files.join(', ') || '—' })
    : t(packOrigin.kind === 'file' ? 'proj.pack.origin.file' : 'proj.pack.origin.sample');

  const onExport = () => {
    downloadText(`${loaded.pack.packId}-pack-${yyyymmdd(new Date())}.json`.replace(/[\\/:*?"<>|\s]+/g, '_'), JSON.stringify(loaded.pack, null, 2), 'application/json');
  };
  const onDelete = async () => {
    if (packOrigin.kind !== 'imported') return;
    await deleteImportedPack(packOrigin.projectId);
    window.location.reload();
  };

  return (
    <Panel
      title={t('proj.pack.current')}
      className="span-full"
      testId="pack-current"
      actions={(
        <>
          <Button size="small" icon={<ArrowDownload20Regular />} onClick={onExport} data-testid="pack-export">{t('proj.pack.export')}</Button>
          {packOrigin.kind === 'imported' && (
            <Button size="small" icon={<Delete20Regular />} onClick={() => setConfirm(true)} data-testid="pack-delete">{t('proj.pack.delete')}</Button>
          )}
        </>
      )}
    >
      <dl className="meta-list pack-meta">
        <div><dt>{t('proj.pack.target')}</dt><dd data-testid="pack-target">{targetName}</dd></div>
        <div><dt>{t('proj.pack.origin')}</dt><dd data-testid="pack-origin">{origin}</dd></div>
        <div>
          <dt>{t('proj.pack.company')}</dt>
          <dd>
            {tx(loaded.pack.company.name)}
            {loaded.pack.isSample && <Badge appearance="tint" color="informative" className="proj-inline-badge">{t('badge.samplePack')}</Badge>}
          </dd>
        </div>
        <div>
          <dt>{t('proj.pack.items')}</dt>
          <dd data-testid="pack-counts">
            {counts.map(([k, n]) => t('proj.pack.kindCount', { kind: t(`proj.pack.kind.${k}`), count: fmt.integer(n) })).join(' · ')}
          </dd>
        </div>
        {loaded.issues.length > 0 && (
          <div><dt>{t('proj.pack.disabled')}</dt><dd>{t('proj.pack.disabledBody', { count: loaded.issues.length })}</dd></div>
        )}
      </dl>
      {target.kind === 'demo' && <p className="muted">{t('proj.pack.demoNote')}</p>}
      <ConfirmDialog
        open={confirm}
        title={t('proj.pack.deleteTitle')}
        body={t('proj.pack.deleteBody', { name: targetName })}
        confirmLabel={t('proj.delete')}
        onConfirm={() => { setConfirm(false); void onDelete(); }}
        onCancel={() => setConfirm(false)}
        testId="pack-delete-confirm"
      />
    </Panel>
  );
}

function PromptPanel() {
  const { t, lang } = useI18n();
  const prompt = copilotPrompt(lang);
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <Panel title={t('proj.pack.promptTitle')} className="span-full" testId="pack-prompt">
      <p>{t('proj.pack.promptBody')}</p>
      <ol className="pack-steps">
        <li>{t('proj.pack.promptStep1')}</li>
        <li>{t('proj.pack.promptStep2')}</li>
        <li>{t('proj.pack.promptStep3')}</li>
        <li>{t('proj.pack.promptStep4')}</li>
      </ol>
      <div className="proj-row">
        <Button appearance="primary" icon={<Copy20Regular />} onClick={() => { void copyText(prompt).then(setCopied); }} data-testid="pack-prompt-copy">{t('proj.pack.promptCopy')}</Button>
        <Button icon={<ArrowDownload20Regular />} onClick={() => downloadText('copilot-customer-pack-prompt.md', PROMPT_DOC, 'text/markdown')} data-testid="pack-prompt-download">{t('proj.pack.promptDownload')}</Button>
        <span role="status" className="muted">{copied === true ? t('proj.pack.copied') : copied === false ? t('proj.pack.copyFailed') : ''}</span>
      </div>
      <details className="pack-details">
        <summary>{t('proj.pack.promptShow')}</summary>
        <Textarea readOnly value={prompt} resize="vertical" rows={14} aria-label={t('proj.pack.promptTitle')} className="pack-textarea" data-testid="pack-prompt-text" />
      </details>
      <p className="muted">{t('proj.pack.promptPrivacy')}</p>
    </Panel>
  );
}

interface Picked {
  file: File;
  key: string;
}

function ImportPanel() {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const next = [...picked];
    for (const file of Array.from(list)) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (!next.some((p) => p.key === key)) next.push({ file, key });
    }
    setPicked(next);
    setAnalysis(null);
  };

  const check = async () => {
    setBusy(true);
    const docs: InputDoc[] = [];
    const rejected: FileReport[] = [];
    for (const { file } of picked) {
      if (file.size > MAX_PACK_FILE_BYTES) rejected.push({ name: file.name, status: 'tooLarge', fragments: 0 });
      else if (!isReadableFile(file.name, file.type)) rejected.push({ name: file.name, status: 'unsupported', fragments: 0 });
      else docs.push({ name: file.name, text: await file.text() });
    }
    if (paste.trim()) docs.push({ name: t('proj.pack.pastedName'), text: paste });
    setAnalysis(analyzeImport(docs, rejected));
    setBusy(false);
    requestAnimationFrame(() => resultRef.current?.focus());
  };

  const clear = () => {
    setPicked([]);
    setPaste('');
    setAnalysis(null);
  };

  return (
    <Panel title={t('proj.pack.importTitle')} className="span-full" testId="pack-import">
      <p>{t('proj.pack.importBody', { mb: MAX_PACK_FILE_BYTES / 1024 / 1024 })}</p>
      <div
        className={`pack-drop${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
        data-testid="pack-drop"
      >
        <ArrowUpload20Regular aria-hidden />
        <span>{t('proj.pack.dropHint')}</span>
        <Button onClick={() => fileRef.current?.click()}>{t('proj.pack.chooseFiles')}</Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".json,.txt,.md,application/json,text/plain,text/markdown"
          className="visually-hidden"
          tabIndex={-1}
          aria-label={t('proj.pack.chooseFiles')}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          data-testid="pack-file-input"
        />
      </div>
      {picked.length > 0 && (
        <ul className="pack-picked" aria-label={t('proj.pack.pickedLabel')}>
          {picked.map((p) => (
            <li key={p.key}>
              <span>{p.file.name}</span>
              <Button
                size="small"
                appearance="subtle"
                icon={<Dismiss16Regular />}
                aria-label={t('proj.pack.removeFile', { name: p.file.name })}
                onClick={() => { setPicked(picked.filter((x) => x.key !== p.key)); setAnalysis(null); }}
              />
            </li>
          ))}
        </ul>
      )}
      <Field label={t('proj.pack.pasteLabel')} hint={t('proj.pack.pasteHint')}>
        <Textarea value={paste} onChange={(_, d) => { setPaste(d.value); setAnalysis(null); }} resize="vertical" rows={6} className="pack-textarea" data-testid="pack-paste" />
      </Field>
      <div className="proj-row">
        <Button appearance="primary" icon={<DocumentCheckmark20Regular />} disabled={busy || (!picked.length && !paste.trim())} onClick={() => { void check(); }} data-testid="pack-check">
          {t('proj.pack.check')}
        </Button>
        <Button onClick={clear} disabled={busy}>{t('proj.pack.clear')}</Button>
      </div>
      {analysis && (
        <div ref={resultRef} tabIndex={-1} className="pack-result" aria-label={t('proj.pack.resultTitle')} data-testid="pack-result">
          <ResultView analysis={analysis} />
        </div>
      )}
    </Panel>
  );
}

function ResultView({ analysis }: { analysis: ImportAnalysis }) {
  const { t, tx, fmt, lang } = useI18n();
  const { verify, summary } = analysis;
  const errors = verify?.problems.filter((p) => p.severity === 'error') ?? [];
  const warnings = verify?.problems.filter((p) => p.severity === 'warning') ?? [];
  const fixPrompt = useMemo(() => (verify ? buildFixPrompt(verify.problems, lang) : ''), [verify, lang]);
  const [copied, setCopied] = useState<boolean | null>(null);

  return (
    <>
      <h3 className="proj-h2">{t('proj.pack.resultTitle')}</h3>
      <ScrollRegion label={t('proj.pack.filesCaption')}>
        <table className="data-table compact" data-testid="pack-files">
          <caption>{t('proj.pack.filesCaption')}</caption>
          <thead><tr><th scope="col">{t('proj.pack.col.file')}</th><th scope="col">{t('proj.pack.col.status')}</th><th scope="col" className="num">{t('proj.pack.col.parts')}</th></tr></thead>
          <tbody>
            {analysis.files.map((f, i) => (
              <tr key={`${f.name}-${i}`}>
                <th scope="row">{f.name}</th>
                <td>
                  {t(`proj.pack.file.${f.status}`)}
                  {f.detail && <div className="muted pack-tech" lang="en">{f.detail}</div>}
                </td>
                <td className="num">{f.fragments}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>

      {!analysis.pack && (
        <MessageBar intent="error" role="alert" data-testid="pack-verdict"><MessageBarBody>{t('proj.pack.nothingFound')}</MessageBarBody></MessageBar>
      )}

      {summary && (
        <dl className="meta-list pack-meta" data-testid="pack-summary">
          <div><dt>{t('proj.pack.company')}</dt><dd>{summary.company.name ? tx(summary.company.name) : '—'}{summary.company.industry ? ` · ${tx(summary.company.industry)}` : ''}</dd></div>
          <div>
            <dt>{t('proj.pack.items')}</dt>
            <dd>{KIND_ORDER.filter((k) => summary.byKind[k]).map((k) => t('proj.pack.kindCount', { kind: t(`proj.pack.kind.${k}`), count: fmt.integer(summary.byKind[k]!) })).join(' · ') || '—'}</dd>
          </div>
          <div><dt>{t('proj.pack.extras')}</dt><dd>{t('proj.pack.extrasValue', { regions: summary.regions, flows: summary.flows, optimization: t(summary.hasOptimization ? 'proj.pack.yes' : 'proj.pack.no') })}</dd></div>
        </dl>
      )}

      {analysis.notes.length > 0 && (
        <section aria-labelledby="pack-notes-title" className="pack-notes" data-testid="pack-notes">
          <h4 id="pack-notes-title" className="proj-h2">{t('proj.pack.notesTitle')}</h4>
          <ul>
            {analysis.notes.map((n) => (
              <li key={n.code}>
                {t(`proj.pack.note.${n.code}`, { count: n.count })}
                {n.detail && <span className="muted pack-tech" lang="en"> ({n.detail})</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {verify && (
        <MessageBar intent={verify.ok ? 'success' : 'error'} role={verify.ok ? 'status' : 'alert'} data-testid="pack-verdict">
          <MessageBarBody>
            {verify.ok
              ? t('proj.pack.pass', { warnings: warnings.length, valid: verify.stats.validEntities, total: verify.stats.entities })
              : t('proj.pack.fail', { errors: errors.length, warnings: warnings.length })}
          </MessageBarBody>
        </MessageBar>
      )}

      {verify && verify.problems.length > 0 && (
        <ScrollRegion label={t('proj.pack.problemsCaption')}>
          <table className="data-table compact pack-problems" data-testid="pack-problems">
            <caption>{t('proj.pack.problemsCaption')}</caption>
            <thead><tr>
              <th scope="col">{t('proj.pack.col.severity')}</th><th scope="col">{t('proj.pack.col.code')}</th><th scope="col">{t('proj.pack.col.where')}</th>
              <th scope="col">{t('proj.pack.col.cause')}</th><th scope="col">{t('proj.pack.col.action')}</th>
            </tr></thead>
            <tbody>
              {verify.problems.slice(0, MAX_PROBLEM_ROWS).map((p, i) => (
                <tr key={`${p.path}-${p.code}-${i}`}>
                  <td><Badge appearance="tint" color={p.severity === 'error' ? 'danger' : 'warning'}>{t(`proj.pack.sev.${p.severity}`)}</Badge></td>
                  <td>{t(`proj.pack.code.${p.code}`)}</td>
                  <td lang="en" className="pack-tech">{p.path}{p.entityId ? ` (${p.entityId})` : ''}</td>
                  <td lang="en">{p.cause}</td>
                  <td lang="en">{p.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {verify.problems.length > MAX_PROBLEM_ROWS && <p className="muted">{t('proj.pack.moreProblems', { count: verify.problems.length - MAX_PROBLEM_ROWS })}</p>}
        </ScrollRegion>
      )}

      {verify && !verify.ok && (
        <section aria-labelledby="pack-fix-title" className="pack-fix" data-testid="pack-fix">
          <h4 id="pack-fix-title" className="proj-h2">{t('proj.pack.fixTitle')}</h4>
          <p>{t('proj.pack.fixBody')}</p>
          <div className="proj-row">
            <Button appearance="primary" icon={<Copy20Regular />} onClick={() => { void copyText(fixPrompt).then(setCopied); }} data-testid="pack-fix-copy">{t('proj.pack.fixCopy')}</Button>
            <span role="status" className="muted">{copied === true ? t('proj.pack.copied') : copied === false ? t('proj.pack.copyFailed') : ''}</span>
          </div>
          <Textarea readOnly value={fixPrompt} resize="vertical" rows={8} aria-label={t('proj.pack.fixTitle')} className="pack-textarea" data-testid="pack-fix-text" />
        </section>
      )}

      {analysis.canImport && analysis.pack && summary && <ConfirmAndImport analysis={analysis} />}
    </>
  );
}

function ConfirmAndImport({ analysis }: { analysis: ImportAnalysis }) {
  const { t, lang } = useI18n();
  const summary = analysis.summary!;
  const target = useProjects((s) => s.target);
  const { project, company } = useActiveProject();
  const toDemo = target.kind === 'demo' || !project;
  const [approved, setApproved] = useState(false);
  const [classified, setClassified] = useState(false);
  const [people, setPeople] = useState(summary.people === 0);
  const [logo, setLogo] = useState(!summary.hasLogo);
  const [companyName, setCompanyName] = useState(summary.company.name?.[lang] ?? '');
  const [projectName, setProjectName] = useState(() => t('proj.pack.defaultProject', { date: new Date().toISOString().slice(0, 10) }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const replacing = !toDemo && project ? importedPackMeta(project.id) !== null : false;
  const ready = approved && classified && people && logo && (!toDemo || (companyName.trim() && projectName.trim()));

  const resolveProject = (): string | null => {
    if (!toDemo && project) return project.id;
    const { addCompany, addProject } = useProjects.getState();
    const name = companyName.trim();
    let companyId = useProjects.getState().companies.find((c) => c.name === name)?.id;
    if (!companyId) {
      const r = addCompany(name);
      if (!r.ok) { setError(t('proj.err.duplicateCompany')); return null; }
      companyId = r.id;
    }
    const r = addProject(companyId, projectName);
    if (!r.ok) {
      setError(t(r.reason === 'limit' ? 'proj.err.limit' : r.reason === 'duplicate' ? 'proj.err.duplicateProject' : 'proj.err.required', { max: MAX_PROJECTS_PER_COMPANY }));
      return null;
    }
    return r.id;
  };

  const onImport = async () => {
    setSaving(true);
    setError(null);
    const projectId = resolveProject();
    if (!projectId) { setSaving(false); return; }
    const pack = analysis.pack!;
    try {
      await saveImportedPack({
        projectId,
        packId: String(pack.packId),
        company: { name: summary.company.name ?? { ja: '—', en: '—' }, industry: summary.company.industry ?? { ja: '—', en: '—' } },
        isSample: summary.isSample,
        entities: summary.entities,
        importedAt: new Date().toISOString(),
        files: analysis.files.filter((f) => f.status === 'used').map((f) => f.name),
      }, pack);
    } catch (err) {
      setError(t('proj.pack.saveFailed', { message: (err as Error).message }));
      setSaving(false);
      return;
    }
    const p = useProjects.getState().projects.find((x) => x.id === projectId);
    const c = useProjects.getState().companies.find((x) => x.id === p?.companyId);
    sessionStorage.setItem(JUST_IMPORTED_KEY, `${c?.name ?? ''}-${p?.name ?? ''}`);
    // Switching the target reloads with the new pack (main.tsx); re-importing into the same project needs an explicit reload.
    useProjects.getState().setTarget({ kind: 'project', projectId });
    window.location.reload();
  };

  return (
    <section aria-labelledby="pack-confirm-title" className="pack-confirm" data-testid="pack-confirm">
      <h4 id="pack-confirm-title" className="proj-h2">{t('proj.pack.confirmTitle')}</h4>
      <p>{t('proj.pack.confirmBody')}</p>
      <div className="pack-checks">
        <Checkbox checked={approved} onChange={(_, d) => setApproved(d.checked === true)} label={t('proj.pack.checkApproved')} data-testid="pack-check-approved" />
        <Checkbox checked={classified} onChange={(_, d) => setClassified(d.checked === true)} label={t('proj.pack.checkClassified', { internal: summary.internal, shareable: summary.shareable })} data-testid="pack-check-classified" />
        {summary.people > 0 && (
          <Checkbox checked={people} onChange={(_, d) => setPeople(d.checked === true)} label={t('proj.pack.checkPeople', { count: summary.people })} data-testid="pack-check-people" />
        )}
        {summary.hasLogo && (
          <Checkbox checked={logo} onChange={(_, d) => setLogo(d.checked === true)} label={t('proj.pack.checkLogo')} data-testid="pack-check-logo" />
        )}
      </div>
      {summary.isSample && <MessageBar intent="info"><MessageBarBody>{t('proj.pack.isSampleNote')}</MessageBarBody></MessageBar>}
      <h5 className="proj-h2">{t('proj.pack.destination')}</h5>
      {toDemo ? (
        <>
          <p>{t('proj.pack.destinationNew')}</p>
          <div className="proj-form-row">
            <Field label={t('proj.projects.companyName')}><Input value={companyName} onChange={(_, d) => setCompanyName(d.value)} data-testid="pack-dest-company" /></Field>
            <Field label={t('proj.projects.newProject')}><Input value={projectName} onChange={(_, d) => setProjectName(d.value)} data-testid="pack-dest-project" /></Field>
          </div>
        </>
      ) : (
        <p data-testid="pack-destination">
          {t('proj.pack.destinationProject', { name: `${company?.name ?? ''}-${project?.name ?? ''}` })}
          {replacing && <> {t('proj.pack.replacing')}</>}
        </p>
      )}
      {error && <MessageBar intent="error" role="alert"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      <Button appearance="primary" icon={<Open20Regular />} disabled={!ready || saving} onClick={() => { void onImport(); }} data-testid="pack-import-apply">
        {t('proj.pack.apply')}
      </Button>
      {basePack.isSample && toDemo && <p className="muted">{t('proj.pack.demoStays')}</p>}
    </section>
  );
}
