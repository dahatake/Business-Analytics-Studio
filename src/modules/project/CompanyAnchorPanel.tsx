import { useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Field, MessageBar, MessageBarBody, Select, Textarea } from '@fluentui/react-components';
import { ArrowUpload20Regular } from '@fluentui/react-icons';
import { anchorEvidenceChecks, anchorFreshness, companyAnchorPrompt, missingAnchorSections, parseCompanyAnchor } from '../../data/companyAnchor.ts';
import { useI18n } from '../../i18n/index.ts';
import { readCompanyAnchorDocument } from '../../state/companyAnchors.ts';
import { useProjects, type Company } from '../../state/projects.ts';
import { useSettings } from '../../state/settings.ts';

export function CompanyAnchorPanel({ company }: { company: Company }) {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const loaded = useMemo(() => {
    try { return { document: readCompanyAnchorDocument(company.id), error: false }; }
    catch { return { document: null, error: true }; }
  }, [company.id, company.anchorRef?.version]);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const versions = loaded.document?.versions ?? [];
  const viewed = versions.find((version) => version.version === viewVersion) ?? versions.at(-1);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [identityOk, setIdentityOk] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => editing ? parseCompanyAnchor(text) : null, [editing, text]);
  const differs = parsed?.ok && parsed.anchor.entityScope.legalEntity.normalize('NFKC').trim() !== company.name.normalize('NFKC').trim();
  const evidence = viewed ? anchorEvidenceChecks(viewed.anchor).filter((entry) => entry.missing.length) : [];
  const missing = viewed ? missingAnchorSections(viewed.anchor) : [];
  const freshness = viewed ? anchorFreshness(viewed.anchor, new Date()) : null;
  const prompt = companyAnchorPrompt(company.name, lang);

  if (audience === 'external') return null;

  const edit = () => {
    setText(viewed ? JSON.stringify(viewed.anchor, null, 2) : '');
    setIdentityOk(false);
    setMessage(null);
    setEditing(true);
  };
  const save = () => {
    if (!parsed?.ok || (differs && !identityOk)) return;
    try {
      const result = useProjects.getState().setCompanyAnchor(company.id, parsed.anchor);
      if (!result.ok) throw new Error(result.reason);
      setViewVersion(null);
      setEditing(false);
      setMessage({ error: false, text: t('proj.anchor.saved', { version: result.version }) });
    } catch (error) {
      setMessage({ error: true, text: `${t('proj.anchor.storageError')} ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const readFile = async (file: File) => {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error(t('proj.anchor.fileTooLarge'));
      setText(await file.text());
      setIdentityOk(false);
      setEditing(true);
      setMessage(null);
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : String(error) });
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setMessage({ error: false, text: t('proj.anchor.copied') });
    } catch (error) {
      setMessage({ error: true, text: `${t('proj.anchor.copyFailed')} ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  return (
    <section className="proj-company-info" data-testid={`company-anchor-${company.id}`}>
      <h3 className="proj-h2">{t('proj.anchor.title')}</h3>
      <p className="muted">{t('proj.anchor.lead')}</p>
      {loaded.error && <MessageBar intent="error"><MessageBarBody>{t('proj.anchor.storageError')}</MessageBarBody></MessageBar>}
      {message && <MessageBar intent={message.error ? 'error' : 'success'} role="status"><MessageBarBody>{message.text}</MessageBarBody></MessageBar>}
      {viewed ? (
        <div data-testid="company-anchor-summary">
          {versions.length > 1 && (
            <Field label={t('proj.anchor.history')} hint={t('proj.anchor.historyHint')}>
              <Select value={String(viewed.version)} disabled={editing} onChange={(_, data) => setViewVersion(Number(data.value))} data-testid="company-anchor-version">
                {versions.map((version) => <option key={version.version} value={version.version}>{t('proj.anchor.historyOption', { version: version.version, date: version.anchor.asOf })}</option>)}
              </Select>
            </Field>
          )}
          <p>{t('proj.anchor.summary', { version: viewed.version, date: viewed.anchor.asOf, objectives: viewed.anchor.statedObjectives.length, kpis: viewed.anchor.companyKpis.length })}</p>
          {(freshness?.stale || freshness?.future) && <MessageBar intent="warning"><MessageBarBody>{t('proj.anchor.stale')}</MessageBarBody></MessageBar>}
          {evidence.length > 0 && <MessageBar intent="warning"><MessageBarBody>{t('proj.anchor.unverified', { count: evidence.length })}</MessageBarBody></MessageBar>}
          {missing.length > 0 && <MessageBar intent="warning"><MessageBarBody>{t('proj.anchor.missingSections', { sections: missing.map((section) => t(`proj.anchor.section.${section}`)).join(t('ai.listSep')) })}</MessageBarBody></MessageBar>}
          <p className="muted">{t('proj.anchor.verifySources')}</p>
          <p className="muted">{t('proj.anchor.exportWarning')}</p>
          <ul>{viewed.anchor.statedObjectives.map((objective) => (
            <li key={objective.id}>{`${objective.id}: ${objective.text} (${t(`proj.anchor.scope.${objective.scope}`)}; ${t(`proj.anchor.basis.${objective.basis}`)})`}</li>
          ))}</ul>
        </div>
      ) : <p className="muted">{t('proj.anchor.empty')}</p>}
      <div className="proj-row">
        <Button onClick={edit} data-testid="company-anchor-edit">{t('proj.anchor.edit')}</Button>
        <Button icon={<ArrowUpload20Regular />} onClick={() => fileRef.current?.click()}>{t('proj.anchor.import')}</Button>
        <input ref={fileRef} type="file" accept=".json,.md,.txt,application/json,text/plain,text/markdown" className="visually-hidden" tabIndex={-1}
          aria-label={t('proj.anchor.import')} data-testid="company-anchor-file"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ''; }} />
      </div>
      <details>
        <summary>{t('proj.anchor.prompt')}</summary>
        <p className="muted">{t('proj.anchor.promptHint')}</p>
        <Button onClick={() => void copy()}>{t('proj.anchor.copy')}</Button>
        <pre className="proj-prewrap">{prompt}</pre>
      </details>
      {editing && (
        <div className="proj-edit-form">
          <Field label={t('proj.anchor.json')} hint={t('proj.anchor.jsonHint')} validationState={parsed && !parsed.ok ? 'error' : 'none'}>
            <Textarea value={text} onChange={(_, data) => { setText(data.value); setIdentityOk(false); }} rows={14} resize="vertical" data-testid="company-anchor-json" />
          </Field>
          {parsed && !parsed.ok && <MessageBar intent="error" data-testid="company-anchor-errors"><MessageBarBody><ul>{parsed.errors.slice(0, 20).map((error) => <li key={error} lang="en">{error}</li>)}</ul></MessageBarBody></MessageBar>}
          {differs && <Checkbox checked={identityOk} onChange={(_, data) => setIdentityOk(data.checked === true)} label={t('proj.anchor.identity', { actual: parsed?.ok ? parsed.anchor.entityScope.legalEntity : '', company: company.name })} data-testid="company-anchor-identity" />}
          {parsed?.ok && (
            <>
              <p className="muted">{t('proj.anchor.importReview', { count: anchorEvidenceChecks(parsed.anchor).filter((entry) => entry.missing.length).length })}</p>
              {missingAnchorSections(parsed.anchor).length > 0 && <p className="muted">{t('proj.anchor.missingSections', { sections: missingAnchorSections(parsed.anchor).map((section) => t(`proj.anchor.section.${section}`)).join(t('ai.listSep')) })}</p>}
            </>
          )}
          <div className="proj-row">
            <Button appearance="primary" disabled={!parsed?.ok || (!!differs && !identityOk) || loaded.error} onClick={save} data-testid="company-anchor-save">{t('proj.save')}</Button>
            <Button onClick={() => setEditing(false)}>{t('proj.cancel')}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
