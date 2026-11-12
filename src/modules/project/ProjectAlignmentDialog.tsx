import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input,
  MessageBar, MessageBarBody, Select, Textarea,
} from '@fluentui/react-components';
import { AiLiveError, aiLive, preflight } from '../../ai/client.ts';
import { PER_USE_LIMITS } from '../../ai/policy.ts';
import { anchorFreshness } from '../../data/companyAnchor.ts';
import { loadImportedPack } from '../../data/packStore.ts';
import { CustomerPack } from '../../data/schema.ts';
import { useI18n } from '../../i18n/index.ts';
import { latestCompanyAnchor } from '../../state/companyAnchors.ts';
import { useProjects, type Company, type Project } from '../../state/projects.ts';
import { useSettings } from '../../state/settings.ts';
import { D4Warning, yenFine } from '../ai/AiCommon.tsx';
import { liveReady, useAiSettings } from '../ai/settingsStore.ts';
import '../ai/liveTransport.ts';
import { ALIGNMENT_KINDS, alignmentPrompt, assessAlignment, emptyAlignment, orderedCompanyObjectives, parseAlignmentProposal, projectEvidenceSources, type Alignment, type ProjectEvidenceSource } from './companyAlignment.ts';

type MeasureValue = NonNullable<Alignment['effect']>;

export function ProjectAlignmentButton({ company, project }: { company: Company; project: Project }) {
  const { t } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [open, setOpen] = useState(false);
  if (audience === 'external') return null;
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)} data-testid={`project-alignment-${project.id}`}>
        {t('proj.align.open')}
      </Button>
      {open && <ProjectAlignmentDialog company={company} project={project} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProjectAlignmentDialog({ company, project, onClose }: { company: Company; project: Project; onClose: () => void }) {
  const { t, lang, fmt } = useI18n();
  const ai = useAiSettings();
  const loaded = useMemo(() => {
    try { return { value: latestCompanyAnchor(company.id), error: false }; }
    catch { return { value: null, error: true }; }
  }, [company.id, company.anchorRef?.version]);
  const version = loaded.value;
  const purpose = project.brief?.purpose ?? '';
  const [draft, setDraft] = useState<Alignment>(() => project.alignments?.[0] ?? emptyAlignment(version?.version));
  const [packSources, setPackSources] = useState<ProjectEvidenceSource[]>([]);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [aiApproved, setAiApproved] = useState(false);
  const [aiCostOk, setAiCostOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const projectSourceIds = packSources.map((source) => source.id);
  const assessment = assessAlignment(purpose, version, draft, projectSourceIds);
  const proposal = version ? alignmentPrompt(version.anchor, purpose, {
    projectKpi: draft.projectKpi, sources: packSources.filter((source) => draft.sourceIds.includes(source.id)),
  }, lang) : '';
  const freshness = version ? anchorFreshness(version.anchor, new Date()) : null;
  const estimate = proposal ? preflight({
    use: 'alignmentProposal', lang, prompt: proposal, userConfirmed: true, personConfirmed: true,
    maxOutputTokens: PER_USE_LIMITS.alignmentProposal?.maxOutputTokens,
  }) : null;

  useEffect(() => {
    let active = true;
    void loadImportedPack(project.id).then((pack) => {
      if (!active || !pack) return;
      const parsed = CustomerPack.safeParse(pack);
      if (!parsed.success) throw new Error(t('proj.align.packInvalid'));
      setPackSources(projectEvidenceSources(parsed.data, lang));
    }).catch((error: unknown) => {
      if (active) setMessage({ error: true, text: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; abort.current?.abort(); };
  }, [project.id, lang, t]);

  useEffect(() => { setAiApproved(false); setAiCostOk(false); }, [proposal, ai.provider]);

  const edit = (patch: Partial<Alignment>) => {
    setDraft((current) => ({ ...current, ...patch, status: 'draft', confirmedBy: '', confirmedAt: '' }));
    setMessage(null);
  };
  const save = () => {
    const saved: Alignment = draft.status === 'draft'
      ? { ...draft, assessedPurpose: purpose, ...(version ? { anchorVersion: version.version } : {}) }
      : draft;
    const checked = assessAlignment(purpose, version, saved, projectSourceIds);
    if (saved.status === 'confirmed' && (checked.issues.length || checked.outdated)) {
      setMessage({ error: true, text: t('proj.align.confirmError') });
      return;
    }
    try {
      const entries = project.alignments ?? [];
      const exists = entries.some((entry) => entry.id === saved.id);
      const result = useProjects.getState().setProjectAlignments(project.id, exists ? entries.map((entry) => entry.id === saved.id ? saved : entry) : [...entries, saved]);
      if (!result.ok) throw new Error(result.reason);
      setDraft(saved);
      setMessage({ error: false, text: t('proj.align.saved') });
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : String(error) });
    }
  };
  const remove = () => {
    const result = useProjects.getState().setProjectAlignments(project.id, (project.alignments ?? []).filter((entry) => entry.id !== draft.id));
    if (!result.ok) { setMessage({ error: true, text: t('proj.err.notFound') }); return; }
    setDraft(emptyAlignment(version?.version));
    setMessage({ error: false, text: t('proj.align.removed') });
  };
  const suggest = async () => {
    if (!version || !aiApproved || !aiCostOk || !estimate?.allowed || proposal.length > 32_000) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setMessage(null);
    try {
      const result = await aiLive({
        use: 'alignmentProposal', lang, prompt: proposal, userConfirmed: true, personConfirmed: true,
        maxOutputTokens: PER_USE_LIMITS.alignmentProposal?.maxOutputTokens, scope: project.id,
      }, controller.signal);
      const next = parseAlignmentProposal(result.text, version);
      setDraft({ ...next, id: draft.id, assessedPurpose: purpose });
      setMessage({ error: false, text: t('proj.align.aiDraft') });
    } catch (error) {
      const detail = error instanceof AiLiveError ? error.reasons.join(', ') : error instanceof Error ? error.message : String(error);
      setMessage({ error: true, text: `${t('proj.align.aiError')} ${detail}` });
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };
  const toggle = (field: 'objectiveIds' | 'sourceIds', id: string, checked: boolean) => {
    edit({ [field]: checked ? [...new Set([...draft[field], id])] : draft[field].filter((value) => value !== id) });
  };
  const choices = [
    ...(version?.anchor.sources.map((source) => ({ id: source.id, title: source.title })) ?? []),
    ...packSources.filter((source) => !version?.anchor.sources.some((item) => item.id === source.id)),
  ];

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) onClose(); }} modalType={busy ? 'alert' : 'modal'}>
      <DialogSurface className="gen-dialog" data-testid="alignment-dialog">
        <DialogBody>
          <DialogTitle>{t('proj.align.title', { project: project.name })}</DialogTitle>
          <DialogContent>
            <p className="muted">{t('proj.align.lead')}</p>
            {loaded.error && <MessageBar intent="error"><MessageBarBody>{t('proj.anchor.storageError')}</MessageBarBody></MessageBar>}
            {!version && <MessageBar intent="warning"><MessageBarBody>{t('proj.align.noAnchor')}</MessageBarBody></MessageBar>}
            {(freshness?.stale || freshness?.future) && <MessageBar intent="warning"><MessageBarBody>{t('proj.anchor.stale')}</MessageBarBody></MessageBar>}
            {!purpose.trim() && <MessageBar intent="warning"><MessageBarBody>{t('proj.align.issue.purpose')}</MessageBarBody></MessageBar>}
            {message && <MessageBar intent={message.error ? 'error' : 'success'} role="status"><MessageBarBody>{message.text}</MessageBarBody></MessageBar>}
            <div className="proj-edit-form">
              {(project.alignments?.length ?? 0) > 0 && (
                <Field label={t('proj.align.existing')}>
                  <Select value={draft.id} onChange={(_, data) => {
                    const selected = project.alignments?.find((entry) => entry.id === data.value);
                    if (selected) setDraft(selected);
                  }} data-testid="alignment-existing">
                    {!project.alignments?.some((entry) => entry.id === draft.id) && <option value={draft.id}>{t('proj.align.new')}</option>}
                    {project.alignments?.map((entry) => <option key={entry.id} value={entry.id}>{`${t(`proj.align.kind.${entry.kind}`)} — ${t(`proj.align.status.${entry.status}`)}`}</option>)}
                  </Select>
                </Field>
              )}
              <Button onClick={() => { setDraft(emptyAlignment(version?.version)); setMessage(null); }} data-testid="alignment-new">{t('proj.align.new')}</Button>
              <Field label={t('proj.align.kind')}>
                <Select value={draft.kind} onChange={(_, data) => edit({ kind: data.value as Alignment['kind'] })} data-testid="alignment-kind">
                  {ALIGNMENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`proj.align.kind.${kind}`)}</option>)}
                </Select>
              </Field>
              {version && (
                <fieldset>
                  <legend>{t('proj.align.objectives')}</legend>
                  {orderedCompanyObjectives(version.anchor).map((objective) => (
                    <Checkbox key={objective.id} checked={draft.objectiveIds.includes(objective.id)}
                      onChange={(_, data) => toggle('objectiveIds', objective.id, data.checked === true)}
                      label={`${objective.id}: ${objective.text} (${t(`proj.anchor.scope.${objective.scope}`)})`} />
                  ))}
                </fieldset>
              )}
              <Field label={t('proj.align.companyKpi')}>
                <Select value={draft.companyKpiId} onChange={(_, data) => edit({ companyKpiId: data.value })}>
                  <option value="">{t('proj.company.unset')}</option>
                  {version?.anchor.companyKpis.map((kpi) => <option key={kpi.id} value={kpi.id}>{`${kpi.id}: ${kpi.name} (${kpi.scope}, ${kpi.period})`}</option>)}
                </Select>
              </Field>
              <Field label={t('proj.align.projectKpi')}><Input value={draft.projectKpi} onChange={(_, data) => edit({ projectKpi: data.value })} /></Field>
              <Field label={t('proj.align.pathway')}><Textarea value={draft.pathway} onChange={(_, data) => edit({ pathway: data.value })} rows={3} resize="vertical" /></Field>
              <fieldset>
                <legend>{t('proj.align.sources')}</legend>
                {choices.length ? choices.map((source) => (
                  <Checkbox key={source.id} checked={draft.sourceIds.includes(source.id)} onChange={(_, data) => toggle('sourceIds', source.id, data.checked === true)} label={`${source.id}: ${source.title}`} />
                )) : <p className="muted">{t('proj.align.noSources')}</p>}
              </fieldset>
              <Field label={t('proj.align.risk')}><Input value={draft.risk} onChange={(_, data) => edit({ risk: data.value })} /></Field>
              <Field label={t('proj.align.reason')}><Textarea value={draft.reason} onChange={(_, data) => edit({ reason: data.value })} rows={2} resize="vertical" data-testid="alignment-reason" /></Field>
              <Field label={t('proj.align.counter')} hint={t('proj.align.counterHint')}>
                <Textarea value={draft.counterArguments.join('\n')} onChange={(_, data) => edit({ counterArguments: data.value.split('\n') })} rows={3} resize="vertical" />
              </Field>
              <details>
                <summary>{t('proj.align.comparison')}</summary>
                <MeasureFields label={t('proj.align.effect')} value={draft.effect} onChange={(effect) => edit({ effect })} />
                <MeasureFields label={t('proj.align.denominator')} value={draft.denominator} onChange={(denominator) => edit({ denominator })} />
              </details>
              <MessageBar intent={assessment.kind === 'unaligned' || assessment.issues.length ? 'warning' : 'info'} data-testid="alignment-assessment">
                <MessageBarBody>
                  <Badge appearance="tint">{t(`proj.align.kind.${assessment.kind}`)}</Badge>
                  {` ${t(`proj.align.status.${draft.status}`)}`}
                  {assessment.issues.length > 0 && <ul>{assessment.issues.map((issue) => <li key={issue}>{t(`proj.align.issue.${issue}`)}</li>)}</ul>}
                  {assessment.parentUsed && <p>{t('proj.align.parentUsed')}</p>}
                  {assessment.outdated && <p>{t('proj.align.outdated')}</p>}
                  {assessment.kind === 'unaligned' && <p>{t('proj.align.question', { project: project.name })}</p>}
                </MessageBarBody>
              </MessageBar>
              <p className="muted">{t('proj.align.checkLimit')}</p>
              <Field label={t('proj.align.confirmedBy')}><Input value={draft.confirmedBy} onChange={(_, data) => setDraft((current) => ({ ...current, confirmedBy: data.value }))} /></Field>
              <Field label={t('proj.align.confirmedAt')}><Input type="date" value={draft.confirmedAt} onChange={(_, data) => setDraft((current) => ({ ...current, confirmedAt: data.value }))} /></Field>
              <Checkbox checked={draft.status === 'confirmed'} onChange={(_, data) => setDraft((current) => ({
                ...current, status: data.checked === true ? 'confirmed' : 'draft',
                ...(data.checked === true ? { assessedPurpose: purpose, anchorVersion: version?.version } : {}),
              }))} label={t('proj.align.confirm')} data-testid="alignment-confirm" />
              {version && (
                <details>
                  <summary>{t('proj.align.aiTitle')}</summary>
                  <p>{t('proj.align.aiNotice', { provider: t(`ai.provider.${ai.provider}`), cost: estimate?.estimatedCostJpy == null ? t('ai.cost.unknown') : yenFine(fmt.locale, estimate.estimatedCostJpy) })}</p>
                  <p className="muted">{t('proj.align.aiContents')}</p>
                  <pre className="proj-prewrap" data-testid="alignment-ai-preview">{proposal}</pre>
                  <D4Warning />
                  <Checkbox checked={aiApproved} onChange={(_, data) => setAiApproved(data.checked === true)} label={t('proj.align.aiApprove')} data-testid="alignment-ai-approve" />
                  <Checkbox checked={aiCostOk} onChange={(_, data) => setAiCostOk(data.checked === true)} label={t('proj.align.aiCost')} data-testid="alignment-ai-cost" />
                  {(!estimate?.allowed || proposal.length > 32_000) && <p className="muted">{t('proj.align.aiNotReady', { reason: proposal.length > 32_000 ? 'inputTooLarge' : estimate?.reasons.join(', ') ?? '' })}</p>}
                  <Button disabled={busy || !liveReady(ai) || !aiApproved || !aiCostOk || !estimate?.allowed || proposal.length > 32_000 || !purpose.trim()}
                    onClick={() => void suggest()} data-testid="alignment-ai-run">{t('proj.align.aiRun')}</Button>
                </details>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy || loaded.error} onClick={save} data-testid="alignment-save">{t('proj.save')}</Button>
            {project.alignments?.some((entry) => entry.id === draft.id) && <Button disabled={busy} onClick={remove}>{t('proj.delete')}</Button>}
            {busy ? <Button onClick={() => abort.current?.abort()}>{t('proj.cancel')}</Button> : <Button onClick={onClose}>{t('ai.dialog.close')}</Button>}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function MeasureFields({ label, value, onChange }: { label: string; value?: MeasureValue; onChange: (value: MeasureValue) => void }) {
  const { t } = useI18n();
  const current = value ?? { value: '', unit: '', period: '', scope: '' };
  return (
    <fieldset>
      <legend>{label}</legend>
      {(['value', 'unit', 'period', 'scope'] as const).map((field) => (
        <Field key={field} label={t(`proj.align.measure.${field}`)}>
          <Input value={current[field]} onChange={(_, data) => onChange({ ...current, [field]: data.value })} />
        </Field>
      ))}
    </fieldset>
  );
}
